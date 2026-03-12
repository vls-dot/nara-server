const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS: permite peticiones desde tu web ───
// Cambia el origin por tu dominio real en producción
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── DATOS DE RESERVA (se usan si el scraping falla) ───
// Actualiza estos datos manualmente si el scraper deja de funcionar
const FALLBACK_DATA = {
  lastMatch: {
    homeTeam: "UD Narahío",
    awayTeam: "G Mugardos B",
    homeGoals: 1,
    awayGoals: 0,
    date: "Domingo, 1 de Marzo de 2026",
    competition: "2ª FUTGAL Ferrol 25/26",
    jornada: "Jornada 21"
  },
  nextMatch: {
    homeTeam: "Rápido de Neda",
    awayTeam: "UD Narahío",
    date: "Domingo, 15 de Marzo de 2026",
    competition: "2ª FUTGAL Ferrol 25/26",
    jornada: "Jornada 23"
  },
  source: "fallback"
};

// ─── CACHE en memoria (evita scrapear en cada petición) ───
let cache = {
  data: null,
  updatedAt: null
};

const CACHE_MINUTES = 30; // Actualiza cada 30 min

// ─── FUNCIÓN DE SCRAPING ───
async function scrapePartidos() {
  console.log(`[${new Date().toISOString()}] Scrapeando siguetuliga.com...`);

  const { data: html } = await axios.get('https://www.siguetuliga.com/equipo/ud-narahio', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    timeout: 10000
  });

  const $ = cheerio.load(html);

  const jornadas = [];

  // Cada jornada es un bloque con su fecha y su partido
  $('h4, h3').each((_, el) => {
    const headerText = $(el).text().trim();
    if (!headerText.toLowerCase().includes('jornada')) return;

    // Número de jornada
    const jornadaMatch = headerText.match(/jornada\s*(\d+)/i);
    const jornadaNum = jornadaMatch ? parseInt(jornadaMatch[1]) : null;

    // Buscar el bloque siguiente con el partido
    let sibling = $(el).next();
    let dateText = null;
    let partidoEl = null;

    // Buscar fecha y partido dentro de los siguientes elementos
    while (sibling.length && !partidoEl) {
      const text = sibling.text().trim();

      // Detectar fecha (ej: "Domingo, 1 de Marzo de 2026")
      if (/lunes|martes|miércoles|jueves|viernes|sábado|domingo/i.test(text)) {
        dateText = text;
      }

      // Detectar el bloque del partido (contiene equipos y resultado)
      const partidoLink = sibling.find('a[href*="/partido/"]');
      if (partidoLink.length) {
        partidoEl = sibling;
      }

      sibling = sibling.next();
    }

    if (!partidoEl) return;

    // Extraer texto completo del partido
    const partidoText = partidoEl.text().replace(/\s+/g, ' ').trim();

    // Ejemplo texto: "UD Narahío 1 · 2 SCD A Capela" o "Rápido de Neda - UD Narahío"
    // Detectar si tiene resultado (número · número) o es pendiente (-)
    const resultRegex = /^(.+?)\s+(\d+)\s*[·\-:]\s*(\d+)\s+(.+?)(?:\s*Rellenar acta|\s*Enviar resultado)?$/;
    const pendingRegex = /^(.+?)\s+-\s+(.+?)(?:\s*Enviar resultado|\s*Cambiar hora)?$/;

    const resultMatch = partidoText.match(resultRegex);
    const pendingMatch = !resultMatch ? partidoText.match(pendingRegex) : null;

    if (resultMatch) {
      jornadas.push({
        jornada: jornadaNum,
        date: dateText,
        homeTeam: resultMatch[1].trim(),
        awayTeam: resultMatch[4].trim(),
        homeGoals: parseInt(resultMatch[2]),
        awayGoals: parseInt(resultMatch[3]),
        played: true
      });
    } else if (pendingMatch) {
      jornadas.push({
        jornada: jornadaNum,
        date: dateText,
        homeTeam: pendingMatch[1].trim(),
        awayTeam: pendingMatch[2].trim(),
        played: false
      });
    }
  });

  console.log(`  → ${jornadas.length} jornadas encontradas`);
  jornadas.forEach(j => console.log(`    J${j.jornada}: ${j.homeTeam} vs ${j.awayTeam} | jugado: ${j.played}`));

  // Último partido jugado = último con played=true
  const jugados = jornadas.filter(j => j.played);
  const pendientes = jornadas.filter(j => !j.played);

  const lastMatch = jugados.length > 0 ? jugados[jugados.length - 1] : null;
  const nextMatch = pendientes.length > 0 ? pendientes[0] : null;

  const competition = '2ª FUTGAL Ferrol 25/26';

  const result = {
    lastMatch: lastMatch ? {
      homeTeam: lastMatch.homeTeam,
      awayTeam: lastMatch.awayTeam,
      homeGoals: lastMatch.homeGoals,
      awayGoals: lastMatch.awayGoals,
      date: lastMatch.date,
      competition,
      jornada: `Jornada ${lastMatch.jornada}`
    } : null,
    nextMatch: nextMatch ? {
      homeTeam: nextMatch.homeTeam,
      awayTeam: nextMatch.awayTeam,
      date: nextMatch.date,
      competition,
      jornada: `Jornada ${nextMatch.jornada}`
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'siguetuliga.com'
  };

  console.log(`  → Último: ${lastMatch?.homeTeam} ${lastMatch?.homeGoals}-${lastMatch?.awayGoals} ${lastMatch?.awayTeam}`);
  console.log(`  → Próximo: ${nextMatch?.homeTeam} vs ${nextMatch?.awayTeam}`);

  return result;
}

// ─── ACTUALIZAR CACHE ───
async function refreshCache() {
  try {
    cache.data = await scrapePartidos();
    cache.updatedAt = new Date();
    console.log('✅ Cache actualizado desde siguetuliga.com');
  } catch (err) {
    console.error('❌ Error scrapeando:', err.message);
    if (!cache.data) {
      cache.data = { ...FALLBACK_DATA, scrapedAt: new Date().toISOString() };
      cache.updatedAt = new Date();
      console.log('⚠️  Usando datos de reserva (FALLBACK_DATA)');
    }
  }
}

// ─── ENDPOINT PRINCIPAL ───
app.get('/api/partidos', async (req, res) => {
  try {
    // Si no hay cache o tiene más de CACHE_MINUTES minutos, actualizar
    const cacheExpired = !cache.updatedAt ||
      (new Date() - cache.updatedAt) > CACHE_MINUTES * 60 * 1000;

    if (cacheExpired || !cache.data) {
      await refreshCache();
    }

    if (!cache.data) {
      return res.status(503).json({ error: 'No se pudo obtener información de partidos' });
    }

    res.json({
      ...cache.data,
      cacheAge: cache.updatedAt ? Math.round((new Date() - cache.updatedAt) / 1000) + 's' : null
    });

  } catch (err) {
    console.error('Error en /api/partidos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─── HEALTHCHECK ───
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheUpdatedAt: cache.updatedAt,
    hasData: !!cache.data
  });
});

// ─── CRON: scrapear automáticamente los lunes y jueves a las 9:00 ───
// (los partidos suelen ser el domingo, resultados disponibles el lunes)
cron.schedule('0 9 * * 1,4', () => {
  console.log('⏰ Cron ejecutando scraping automático...');
  refreshCache();
}, { timezone: 'Europe/Madrid' });

// ─── ARRANCAR SERVIDOR ───
app.listen(PORT, async () => {
  console.log(`\n🚀 Servidor UD Narahío escuchando en http://localhost:${PORT}`);
  console.log(`📡 API disponible en http://localhost:${PORT}/api/partidos\n`);
  // Scrapear al arrancar
  await refreshCache();
});

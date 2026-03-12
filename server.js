const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Datos de reserva — actualiza manualmente si el scraping falla
const FALLBACK_DATA = {
  lastMatch: {
    homeTeam: "UD Narahío", awayTeam: "G Mugardos B",
    homeGoals: 1, awayGoals: 0,
    date: "01/03/2026",
    competition: "2ª FUTGAL Ferrol 25/26", jornada: "Jornada 21"
  },
  nextMatch: {
    homeTeam: "Rápido de Neda", awayTeam: "UD Narahío",
    date: "15/03/2026",
    competition: "2ª FUTGAL Ferrol 25/26", jornada: "Jornada 23"
  },
  source: "fallback"
};

let cache = { data: null, updatedAt: null };
const CACHE_MINUTES = 30;

// ─── SCRAPING lapreferente.com ───
async function scrapePartidos() {
  console.log(`[${new Date().toISOString()}] Scrapeando lapreferente.com...`);

  const { data: html } = await axios.get(
    'https://www.lapreferente.com/E13336C22825-13/ud-y-cultural-narahio',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Referer': 'https://www.lapreferente.com/',
        'Cache-Control': 'no-cache',
      },
      timeout: 15000
    }
  );

  const $ = cheerio.load(html);
  const competition = '2ª FUTGAL Ferrol 25/26';

  const jugados    = [];
  const pendientes = [];

  // lapreferente muestra los partidos en filas de tabla o en bloques div
  // Buscamos cualquier elemento que contenga un marcador tipo "X - Y" o "X : Y"
  // y los nombres de dos equipos

  // Intento 1: filas de tabla con resultados
  $('tr, .partido, .match, .resultado, .fixture').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Resultado jugado: dos equipos con goles numéricos
    // Patrones: "Equipo A 2 - 1 Equipo B" / "Equipo A 2:1 Equipo B" / "2-1"
    const scorePattern = /([A-Za-záéíóúüñÁÉÍÓÚÜÑ\s\.]+?)\s+(\d+)\s*[-:]\s*(\d+)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ\s\.]+)/;
    const pendingPattern = /([A-Za-záéíóúüñÁÉÍÓÚÜÑ\s\.]+?)\s*[-–vs\.]+\s*([A-Za-záéíóúüñÁÉÍÓÚÜÑ\s\.]+)/i;

    const datePattern = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})|(\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?)/i;

    const scoreMatch   = text.match(scorePattern);
    const dateMatch    = text.match(datePattern);
    const jornadaMatch = text.match(/[Jj]ornada\s*(\d+)/);

    if (scoreMatch) {
      const home = scoreMatch[1].trim();
      const away = scoreMatch[4].trim();
      // Filtrar filas que no son partidos reales
      if (home.length < 2 || away.length < 2) return;
      if (/local|visitante|equipo|jornada|fecha/i.test(home)) return;

      jugados.push({
        homeTeam:  home,
        awayTeam:  away,
        homeGoals: parseInt(scoreMatch[2]),
        awayGoals: parseInt(scoreMatch[3]),
        date:      dateMatch ? dateMatch[0] : '',
        jornada:   jornadaMatch ? parseInt(jornadaMatch[1]) : null
      });
    }
  });

  // Intento 2: si no hay filas de tabla, buscar en cualquier elemento
  if (jugados.length === 0 && pendientes.length === 0) {
    $('*').each((_, el) => {
      // Solo nodos hoja con texto relevante
      if ($(el).children().length > 3) return;
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length < 5 || text.length > 200) return;

      const scoreMatch = text.match(/^(.+?)\s+(\d+)\s*[-:]\s*(\d+)\s+(.+)$/);
      if (scoreMatch) {
        const home = scoreMatch[1].trim();
        const away = scoreMatch[4].trim();
        if (home.length > 2 && away.length > 2 &&
            !/local|visitante|equipo/i.test(home)) {
          jugados.push({
            homeTeam: home, awayTeam: away,
            homeGoals: parseInt(scoreMatch[2]),
            awayGoals: parseInt(scoreMatch[3]),
            date: '', jornada: null
          });
        }
      }

      // Partido pendiente con fecha futura
      const pendingMatch = text.match(/^(.+?)\s*[-–]\s*(.+)$/) ;
      const hasDate = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(text);
      if (pendingMatch && hasDate) {
        const home = pendingMatch[1].trim();
        const away = pendingMatch[2].trim();
        if (home.length > 2 && away.length > 2) {
          pendientes.push({
            homeTeam: home, awayTeam: away,
            date: text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/)?.[0] || '',
            jornada: null
          });
        }
      }
    });
  }

  // Ordenar: jugados por jornada desc, pendientes por jornada asc
  jugados.sort((a, b) => (b.jornada || 0) - (a.jornada || 0));
  pendientes.sort((a, b) => (a.jornada || 999) - (b.jornada || 999));

  console.log(`  → ${jugados.length} jugados, ${pendientes.length} pendientes encontrados`);
  jugados.slice(0, 3).forEach(j =>
    console.log(`    JUGADO: ${j.homeTeam} ${j.homeGoals}-${j.awayGoals} ${j.awayTeam}`)
  );
  pendientes.slice(0, 2).forEach(j =>
    console.log(`    PENDIENTE: ${j.homeTeam} vs ${j.awayTeam} (${j.date})`)
  );

  const lastMatch  = jugados[0]    || null;
  const nextMatch  = pendientes[0] || null;

  return {
    lastMatch: lastMatch ? {
      homeTeam:  lastMatch.homeTeam,
      awayTeam:  lastMatch.awayTeam,
      homeGoals: lastMatch.homeGoals,
      awayGoals: lastMatch.awayGoals,
      date:      lastMatch.date,
      competition,
      jornada:   lastMatch.jornada ? `Jornada ${lastMatch.jornada}` : ''
    } : null,
    nextMatch: nextMatch ? {
      homeTeam:  nextMatch.homeTeam,
      awayTeam:  nextMatch.awayTeam,
      date:      nextMatch.date,
      competition,
      jornada:   nextMatch.jornada ? `Jornada ${nextMatch.jornada}` : ''
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'lapreferente.com'
  };
}

async function refreshCache() {
  try {
    const result = await scrapePartidos();
    if (!result.lastMatch && !result.nextMatch) throw new Error('Datos vacíos');
    cache.data = result;
    cache.updatedAt = new Date();
    console.log('✅ Cache actualizado desde lapreferente.com');
  } catch (err) {
    console.error('❌ Error scrapeando:', err.message);
    if (!cache.data) {
      cache.data = { ...FALLBACK_DATA, scrapedAt: new Date().toISOString() };
      cache.updatedAt = new Date();
      console.log('⚠️  Usando datos de reserva');
    }
  }
}

app.get('/api/partidos', async (req, res) => {
  try {
    const expired = !cache.updatedAt ||
      (new Date() - cache.updatedAt) > CACHE_MINUTES * 60 * 1000;
    if (expired || !cache.data) await refreshCache();
    if (!cache.data) return res.status(503).json({ error: 'Sin datos disponibles' });
    res.json({
      ...cache.data,
      cacheAge: Math.round((new Date() - cache.updatedAt) / 1000) + 's'
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Endpoint de debug: muestra el HTML crudo que recibe el servidor
app.get('/api/debug', async (req, res) => {
  try {
    const { data: html } = await axios.get(
      'https://www.lapreferente.com/E13336C22825-13/ud-y-cultural-narahio',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9',
          'Referer': 'https://www.lapreferente.com/',
        },
        timeout: 15000
      }
    );
    res.set('Content-Type', 'text/plain');
    res.send(html.substring(0, 8000));
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/health', (_, res) =>
  res.json({ status: 'ok', hasData: !!cache.data, updatedAt: cache.updatedAt })
);

cron.schedule('0 9 * * 1,4', () => refreshCache(), { timezone: 'Europe/Madrid' });

app.listen(PORT, async () => {
  console.log(`\n🚀 Servidor UD Narahío en puerto ${PORT}`);
  await refreshCache();
});

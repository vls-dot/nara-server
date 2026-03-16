const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── CONFIGURACIÓN FUTGAL ───
const FUTGAL_BASE = 'https://www.futgal.es/pnfg/NPcd/NFG_VisCalendario_Vis';
const FUTGAL_PARAMS = {
  cod_primaria:    '1000120',
  codgrupo:        '24730792',
  codcompeticion:  '24123267',
  codtemporada:    '21',
  cod_agrupacion:  '',
  CDetalle:        '1'
};
const JORNADA_INICIO = 1;
const JORNADA_FIN    = 30; // máximo de jornadas a explorar

// Datos de reserva
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
const CACHE_MINUTES = 60;

// ─── FETCH una jornada de futgal ───
async function fetchJornada(jornada) {
  const params = new URLSearchParams({ ...FUTGAL_PARAMS, CodJornada: jornada });
  const { data: html } = await axios.get(`${FUTGAL_BASE}?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Referer': 'https://www.futgal.es/',
    },
    timeout: 15000
  });
  return html;
}

// ─── PARSEAR HTML de una jornada ───
function parseJornada(html, jornadaNum) {
  const $ = cheerio.load(html);
  const partidos = [];

  // futgal usa tablas para mostrar los partidos
  // Buscar filas que contengan equipos y resultado
  $('table tr, .partido, .match').each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 5) return;

    // Buscar celdas individuales
    const cells = $el.find('td').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();

    if (cells.length >= 3) {
      // Buscar celda con resultado tipo "2 - 1" o "2:1"
      let homeGoals = null, awayGoals = null, homeTeam = '', awayTeam = '', date = '';

      for (let i = 0; i < cells.length; i++) {
        const scoreMatch = cells[i].match(/^(\d+)\s*[-:]\s*(\d+)$/);
        if (scoreMatch) {
          homeGoals = parseInt(scoreMatch[1]);
          awayGoals = parseInt(scoreMatch[2]);
          // El equipo local suele estar antes del marcador y el visitante después
          homeTeam = cells[i - 1] || '';
          awayTeam = cells[i + 1] || '';
          break;
        }

        // Resultado pendiente: celda con solo "-" o vacía entre dos equipos
        if (cells[i] === '-' || cells[i] === 'vs' || cells[i] === '') {
          if (i > 0 && i < cells.length - 1 && cells[i-1].length > 2 && cells[i+1].length > 2) {
            homeTeam = cells[i - 1];
            awayTeam = cells[i + 1];
          }
        }
      }

      // Buscar fecha en el texto de la fila
      const dateMatch = text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/);
      if (dateMatch) date = dateMatch[0];

      // Limpiar nombres de equipos
      homeTeam = homeTeam.replace(/^\d+\s*/, '').trim();
      awayTeam = awayTeam.replace(/^\d+\s*/, '').trim();

      if (homeTeam.length > 2 && awayTeam.length > 2 &&
          !/^(local|visitante|equipo|jornada|fecha|resultado|goles)$/i.test(homeTeam)) {
        partidos.push({
          jornada: jornadaNum,
          homeTeam, awayTeam,
          homeGoals, awayGoals,
          date,
          played: homeGoals !== null && awayGoals !== null
        });
      }
    }
  });

  // Si no encontró nada en tablas, buscar en el texto completo
  if (partidos.length === 0) {
    const fullText = $.root().text().replace(/\s+/g, ' ');

    // Buscar patrón "Equipo A N-N Equipo B" o "Equipo A - Equipo B"
    const scoreRegex = /([A-Za-záéíóúüñÁÉÍÓÚÜÑ][A-Za-záéíóúüñÁÉÍÓÚÜÑ\s\.]{2,30}?)\s+(\d+)\s*[-:]\s*(\d+)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ][A-Za-záéíóúüñÁÉÍÓÚÜÑ\s\.]{2,30})/g;
    let m;
    while ((m = scoreRegex.exec(fullText)) !== null) {
      const homeTeam = m[1].trim();
      const awayTeam = m[4].trim();
      if (homeTeam.length > 2 && awayTeam.length > 2) {
        partidos.push({
          jornada: jornadaNum,
          homeTeam, awayTeam,
          homeGoals: parseInt(m[2]),
          awayGoals: parseInt(m[3]),
          date: '', played: true
        });
      }
    }
  }

  return partidos;
}

// ─── SCRAPING PRINCIPAL ───
async function scrapePartidos() {
  console.log(`[${new Date().toISOString()}] Scrapeando futgal.es...`);

  const competition = '2ª FUTGAL Ferrol 25/26';
  const NARAHIO = /narah[ií]o/i;

  let lastMatch = null;
  let nextMatch = null;

  // Explorar jornadas de mayor a menor para encontrar el último partido jugado
  // y de menor a mayor para el próximo
  const todasJornadas = [];

  for (let j = JORNADA_INICIO; j <= JORNADA_FIN; j++) {
    try {
      const html = await fetchJornada(j);
      const partidos = parseJornada(html, j);

      // Filtrar solo partidos del Narahío
      const delNarahio = partidos.filter(p =>
        NARAHIO.test(p.homeTeam) || NARAHIO.test(p.awayTeam)
      );

      todasJornadas.push(...delNarahio);

      // Pequeña pausa para no saturar el servidor
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`  → Jornada ${j}: error (${err.message})`);
    }
  }

  console.log(`  → ${todasJornadas.length} partidos del Narahío encontrados`);
  todasJornadas.forEach(p =>
    console.log(`    J${p.jornada}: ${p.homeTeam} ${p.played ? p.homeGoals+'-'+p.awayGoals : 'vs'} ${p.awayTeam}`)
  );

  const jugados    = todasJornadas.filter(p => p.played).sort((a,b) => b.jornada - a.jornada);
  const pendientes = todasJornadas.filter(p => !p.played).sort((a,b) => a.jornada - b.jornada);

  lastMatch = jugados[0]    || null;
  nextMatch = pendientes[0] || null;

  return {
    lastMatch: lastMatch ? {
      homeTeam: lastMatch.homeTeam, awayTeam: lastMatch.awayTeam,
      homeGoals: lastMatch.homeGoals, awayGoals: lastMatch.awayGoals,
      date: lastMatch.date, competition,
      jornada: `Jornada ${lastMatch.jornada}`
    } : null,
    nextMatch: nextMatch ? {
      homeTeam: nextMatch.homeTeam, awayTeam: nextMatch.awayTeam,
      date: nextMatch.date, competition,
      jornada: `Jornada ${nextMatch.jornada}`
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'futgal.es'
  };
}

// ─── CACHE ───
async function refreshCache() {
  try {
    const result = await scrapePartidos();
    if (!result.lastMatch && !result.nextMatch) throw new Error('Datos vacíos');
    cache.data = result;
    cache.updatedAt = new Date();
    console.log('✅ Cache actualizado desde futgal.es');
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (!cache.data) {
      cache.data = { ...FALLBACK_DATA, scrapedAt: new Date().toISOString() };
      cache.updatedAt = new Date();
      console.log('⚠️  Usando datos de reserva');
    }
  }
}

// ─── ENDPOINTS ───
app.get('/api/partidos', async (req, res) => {
  try {
    const expired = !cache.updatedAt ||
      (new Date() - cache.updatedAt) > CACHE_MINUTES * 60 * 1000;
    if (expired || !cache.data) await refreshCache();
    if (!cache.data) return res.status(503).json({ error: 'Sin datos' });
    res.json({ ...cache.data, cacheAge: Math.round((new Date() - cache.updatedAt) / 1000) + 's' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Debug: muestra el HTML de una jornada concreta
// Uso: /api/debug?jornada=22
app.get('/api/debug', async (req, res) => {
  try {
    const j = req.query.jornada || 22;
    const html = await fetchJornada(j);
    res.set('Content-Type', 'text/plain');
    res.send(`=== JORNADA ${j} (${html.length} chars) ===\n\n` + html.substring(0, 10000));
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/health', (_, res) =>
  res.json({ status: 'ok', hasData: !!cache.data, updatedAt: cache.updatedAt })
);

// Actualizar lunes y jueves a las 9:00 (Madrid)
cron.schedule('0 9 * * 1,4', () => refreshCache(), { timezone: 'Europe/Madrid' });

app.listen(PORT, async () => {
  console.log(`\n🚀 Servidor UD Narahío en puerto ${PORT}`);
  await refreshCache();
});

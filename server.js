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
const FUTGAL_BASE   = 'https://www.futgal.es/pnfg/NPcd/NFG_VisCalendario_Vis';
const FUTGAL_HOME   = 'https://www.futgal.es';
const FUTGAL_PARAMS = {
  cod_primaria:   '1000120',
  codgrupo:       '24730792',
  codcompeticion: '24123267',
  codtemporada:   '21',
  cod_agrupacion: '',
  CDetalle:       '1'
};
const JORNADA_FIN = 30;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

// Datos de reserva
const FALLBACK_DATA = {
  lastMatch: {
    homeTeam: "UD Narahío", awayTeam: "G Mugardos B",
    homeGoals: 1, awayGoals: 0, date: "01/03/2026",
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

// ─── OBTENER COOKIES de futgal.es ───
async function getCookies() {
  return 'cookies_accepted=1; cookie_consent=1; PHPSESSID=accepted';
}

  // Recoger todas las cookies de la respuesta
  const rawCookies = res.headers['set-cookie'] || [];
  const cookieStr = rawCookies
    .map(c => c.split(';')[0])
    .join('; ');

  console.log(`  → Cookies obtenidas: ${cookieStr || '(ninguna)'}`);
  return cookieStr;
}

// ─── FETCH de una jornada con cookies ───
async function fetchJornada(jornada, cookieStr) {
  const params = new URLSearchParams({ ...FUTGAL_PARAMS, CodJornada: jornada });
  const url = `${FUTGAL_BASE}?${params}`;

  const { data: html } = await axios.get(url, {
    headers: {
      ...HEADERS,
      'Referer':        `${FUTGAL_HOME}/`,
      'Cookie': 'cookies_accepted=1; cookie_consent=1; PHPSESSID=accepted',
      'Cache-Control':  'no-cache',
    },
    timeout: 15000,
    maxRedirects: 5
  });

  return html;
}

// ─── PARSEAR HTML de una jornada ───
function parseJornada(html, jornadaNum) {
  const $ = cheerio.load(html);
  const partidos = [];

  // futgal usa <tr> con las celdas: fecha | local | resultado | visitante
  $('tr').each((_, el) => {
    const cells = $(el).find('td')
      .map((_, c) => $(c).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(t => t.length > 0);

    if (cells.length < 3) return;

    // Buscar celda con marcador "N-N" o "N:N"
    for (let i = 0; i < cells.length; i++) {
      const scoreMatch = cells[i].match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (scoreMatch) {
        // local está antes, visitante después
        const homeTeam = (cells[i - 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const awayTeam = (cells[i + 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const date     = cells.find(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(c)) || '';

        if (homeTeam.length > 2 && awayTeam.length > 2) {
          partidos.push({
            jornada: jornadaNum, homeTeam, awayTeam,
            homeGoals: parseInt(scoreMatch[1]),
            awayGoals: parseInt(scoreMatch[2]),
            date, played: true
          });
        }
        return;
      }

      // Partido sin resultado: celda "-" o "- : -" entre dos equipos
      if (/^-+$|^-\s*:\s*-$/.test(cells[i]) || cells[i] === '') {
        const homeTeam = (cells[i - 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const awayTeam = (cells[i + 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const date     = cells.find(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(c)) || '';

        if (homeTeam.length > 2 && awayTeam.length > 2 &&
            !/local|visitante|equipo|jornada/i.test(homeTeam)) {
          partidos.push({
            jornada: jornadaNum, homeTeam, awayTeam,
            homeGoals: null, awayGoals: null,
            date, played: false
          });
        }
      }
    }
  });

  return partidos;
}

// ─── SCRAPING PRINCIPAL ───
async function scrapePartidos() {
  console.log(`[${new Date().toISOString()}] Scrapeando futgal.es...`);

  const competition = '2ª FUTGAL Ferrol 25/26';
  const NARAHIO     = /narah[ií]o/i;

  // Paso 1: obtener cookies
  const cookieStr = await getCookies();

  // Paso 2: recorrer jornadas
  const todasJornadas = [];

  for (let j = 1; j <= JORNADA_FIN; j++) {
    try {
      const html     = await fetchJornada(j, cookieStr);
      const partidos = parseJornada(html, j);
      const delNarahio = partidos.filter(p =>
        NARAHIO.test(p.homeTeam) || NARAHIO.test(p.awayTeam)
      );

      if (delNarahio.length > 0) {
        todasJornadas.push(...delNarahio);
        console.log(`  → J${j}: ${delNarahio[0].homeTeam} vs ${delNarahio[0].awayTeam} | jugado: ${delNarahio[0].played}`);
      }

      // Pausa para no saturar el servidor
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.log(`  → J${j}: error (${err.message})`);
    }
  }

  console.log(`  → Total partidos Narahío: ${todasJornadas.length}`);

  const jugados    = todasJornadas.filter(p => p.played).sort((a, b) => b.jornada - a.jornada);
  const pendientes = todasJornadas.filter(p => !p.played).sort((a, b) => a.jornada - b.jornada);

  const lastMatch = jugados[0]    || null;
  const nextMatch = pendientes[0] || null;

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

// Debug: muestra HTML de una jornada
// Uso: /api/debug?jornada=22
app.get('/api/debug', async (req, res) => {
  try {
    const j = req.query.jornada || 22;
    const cookieStr = await getCookies();
    const html = await fetchJornada(j, cookieStr);
    res.set('Content-Type', 'text/plain');
    res.send(`=== JORNADA ${j} (${html.length} chars) ===\n\nCOOKIES: ${cookieStr}\n\n` + html.substring(0, 10000));
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

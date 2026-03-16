const express = require('express');
const axios   = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const cors    = require('cors');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const FUTGAL_BASE   = 'https://www.futgal.es/pnfg/NPcd/NFG_VisCalendario_Vis';
const FUTGAL_HOME   = 'https://www.futgal.es';
const FUTGAL_PARAMS = {
  cod_primaria: '1000120', codgrupo: '24730792',
  codcompeticion: '24123267', codtemporada: '21',
  cod_agrupacion: '', CDetalle: '1'
};
const JORNADA_FIN = 30;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

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

// ─── Crear cliente axios con cookie jar ───
function createClient() {
  const jar    = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));
  return client;
}

// ─── Fetch de una jornada con cookie jar ───
async function fetchJornada(jornada) {
  const client = createClient();

  // Paso 1: visitar la home para obtener session_id
  await client.get(FUTGAL_HOME, {
    headers: HEADERS,
    timeout: 15000,
    maxRedirects: 5
  });

  // Pequeña pausa
  await new Promise(r => setTimeout(r, 500));

  // Paso 2: pedir la jornada con las cookies del jar
  const params = new URLSearchParams({ ...FUTGAL_PARAMS, CodJornada: jornada });
  const { data: html } = await client.get(`${FUTGAL_BASE}?${params}`, {
    headers: { ...HEADERS, Referer: `${FUTGAL_HOME}/` },
    timeout: 15000,
    maxRedirects: 5
  });

  return html || '';
}

// ─── Parsear HTML de futgal.es ───
function parseJornada(html, jornadaNum) {
  const $ = cheerio.load(html);
  const partidos = [];

  // futgal.es estructura: tabla con filas de partidos
  // Cada fila tiene: fecha | hora | local | resultado | visitante | ...
  $('tr').each((_, el) => {
    const $row = $(el);
    const cells = $row.find('td')
      .map((_, c) => $(c).text().replace(/\s+/g, ' ').trim())
      .get();

    if (cells.length < 3) return;

    const rowText = cells.join(' | ');

    // Buscar celda con resultado "N - N" o "N:N" o "- : -"
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];

      // Resultado jugado
      const scoreMatch = cell.match(/^(\d+)\s*[-:]\s*(\d+)$/) ||
                         cell.match(/^(\d+)\s*-\s*(\d+)$/);
      if (scoreMatch) {
        // Buscar equipos: normalmente 1-2 celdas antes y después
        let homeTeam = '';
        let awayTeam = '';
        for (let back = i - 1; back >= 0; back--) {
          if (cells[back].length > 2 && !/^\d+$/.test(cells[back]) &&
              !/^(\d{1,2}[\/\-]\d{1,2})/.test(cells[back])) {
            homeTeam = cells[back];
            break;
          }
        }
        for (let fwd = i + 1; fwd < cells.length; fwd++) {
          if (cells[fwd].length > 2 && !/^\d+$/.test(cells[fwd]) &&
              !/^(\d{1,2}[\/\-]\d{1,2})/.test(cells[fwd])) {
            awayTeam = cells[fwd];
            break;
          }
        }
        const date = cells.find(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(c)) || '';
        if (homeTeam.length > 2 && awayTeam.length > 2 &&
            !/^(fecha|hora|jornada|local|visitante|resultado)$/i.test(homeTeam)) {
          partidos.push({
            jornada: jornadaNum, homeTeam, awayTeam,
            homeGoals: parseInt(scoreMatch[1]),
            awayGoals: parseInt(scoreMatch[2]),
            date, played: true
          });
          return; // siguiente fila
        }
      }

      // Partido pendiente: "- : -" o "-:-" o solo "-"
      if (/^-\s*:\s*-$|^-$/.test(cell)) {
        let homeTeam = '';
        let awayTeam = '';
        for (let back = i - 1; back >= 0; back--) {
          if (cells[back].length > 2 && !/^\d+$/.test(cells[back]) &&
              !/^(\d{1,2}[\/\-]\d{1,2})/.test(cells[back])) {
            homeTeam = cells[back];
            break;
          }
        }
        for (let fwd = i + 1; fwd < cells.length; fwd++) {
          if (cells[fwd].length > 2 && !/^\d+$/.test(cells[fwd]) &&
              !/^(\d{1,2}[\/\-]\d{1,2})/.test(cells[fwd])) {
            awayTeam = cells[fwd];
            break;
          }
        }
        const date = cells.find(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(c)) || '';
        if (homeTeam.length > 2 && awayTeam.length > 2 &&
            !/^(fecha|hora|jornada|local|visitante|resultado)$/i.test(homeTeam)) {
          partidos.push({
            jornada: jornadaNum, homeTeam, awayTeam,
            homeGoals: null, awayGoals: null,
            date, played: false
          });
          return;
        }
      }
    }
  });

  return partidos;
}

// ─── Scraping principal ───
async function scrapePartidos() {
  console.log(`[${new Date().toISOString()}] Scrapeando futgal.es...`);
  const competition = '2ª FUTGAL Ferrol 25/26';
  const NARAHIO     = /narah[ií]o/i;
  const todasJornadas = [];

  for (let j = 1; j <= JORNADA_FIN; j++) {
    try {
      const html       = await fetchJornada(j);
      console.log(`  → J${j}: ${html.length} chars`);
      if (html.length < 200) continue;

      const partidos   = parseJornada(html, j);
      const delNarahio = partidos.filter(p =>
        NARAHIO.test(p.homeTeam) || NARAHIO.test(p.awayTeam)
      );
      if (delNarahio.length > 0) {
        todasJornadas.push(...delNarahio);
        console.log(`    ✓ ${delNarahio[0].homeTeam} vs ${delNarahio[0].awayTeam} | jugado: ${delNarahio[0].played}`);
      }
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      console.log(`  → J${j}: error (${err.message})`);
    }
  }

  const jugados    = todasJornadas.filter(p => p.played).sort((a,b) => b.jornada - a.jornada);
  const pendientes = todasJornadas.filter(p => !p.played).sort((a,b) => a.jornada - b.jornada);
  const lastMatch  = jugados[0]    || null;
  const nextMatch  = pendientes[0] || null;

  return {
    lastMatch: lastMatch ? {
      homeTeam: lastMatch.homeTeam, awayTeam: lastMatch.awayTeam,
      homeGoals: lastMatch.homeGoals, awayGoals: lastMatch.awayGoals,
      date: lastMatch.date, competition, jornada: `Jornada ${lastMatch.jornada}`
    } : null,
    nextMatch: nextMatch ? {
      homeTeam: nextMatch.homeTeam, awayTeam: nextMatch.awayTeam,
      date: nextMatch.date, competition, jornada: `Jornada ${nextMatch.jornada}`
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'futgal.es'
  };
}

// ─── Cache ───
async function refreshCache() {
  try {
    const result = await scrapePartidos();
    if (!result.lastMatch && !result.nextMatch) throw new Error('Datos vacíos');
    cache.data = result;
    cache.updatedAt = new Date();
    console.log('✅ Cache actualizado');
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (!cache.data) {
      cache.data = { ...FALLBACK_DATA, scrapedAt: new Date().toISOString() };
      cache.updatedAt = new Date();
      console.log('⚠️  Usando datos de reserva');
    }
  }
}

// ─── Endpoints ───
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

// Debug: muestra el HTML raw de una jornada
app.get('/api/debug', async (req, res) => {
  const j      = parseInt(req.query.jornada) || 22;
  const offset = parseInt(req.query.offset)  || 0;
  try {
    const html     = await fetchJornada(j);
    const narahIdx = html.toLowerCase().indexOf('narah');
    const info     = `=== JORNADA ${j} | Total: ${html.length} chars | Narahío pos: ${narahIdx} ===\n\n`;
    res.set('Content-Type', 'text/plain');
    res.send(info + html.substring(offset, offset + 10000));
  } catch (err) {
    res.set('Content-Type', 'text/plain');
    res.send(`ERROR en jornada ${j}: ${err.message}\n${err.stack}`);
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

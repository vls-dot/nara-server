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

  // Paso 1: visitar la home para que futgal establezca la session_id
  await client.get(FUTGAL_HOME, { headers: HEADERS, timeout: 15000 });

  // Paso 2: pedir la jornada con las cookies ya guardadas en el jar
  const params = new URLSearchParams({ ...FUTGAL_PARAMS, CodJornada: jornada });
  const { data: html } = await client.get(`${FUTGAL_BASE}?${params}`, {
    headers: { ...HEADERS, Referer: `${FUTGAL_HOME}/` },
    timeout: 15000
  });

  return html;
}

// ─── Parsear HTML de una jornada ───
function parseJornada(html, jornadaNum) {
  const $ = cheerio.load(html);
  const partidos = [];

  $('tr').each((_, el) => {
    const cells = $(el).find('td')
      .map((_, c) => $(c).text().replace(/\s+/g, ' ').trim())
      .get().filter(t => t.length > 0);

    if (cells.length < 3) return;

    for (let i = 0; i < cells.length; i++) {
      // Partido jugado: celda con "N-N" o "N:N"
      const scoreMatch = cells[i].match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (scoreMatch) {
        const homeTeam = (cells[i - 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const awayTeam = (cells[i + 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const date     = cells.find(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(c)) || '';
        if (homeTeam.length > 2 && awayTeam.length > 2) {
          partidos.push({ jornada: jornadaNum, homeTeam, awayTeam,
            homeGoals: parseInt(scoreMatch[1]), awayGoals: parseInt(scoreMatch[2]),
            date, played: true });
        }
        return;
      }

      // Partido pendiente: celda "-" o "- : -"
      if (/^-+$|^-\s*:\s*-$/.test(cells[i])) {
        const homeTeam = (cells[i - 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const awayTeam = (cells[i + 1] || '').replace(/^\d+\.?\s*/, '').trim();
        const date     = cells.find(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(c)) || '';
        if (homeTeam.length > 2 && awayTeam.length > 2 &&
            !/local|visitante|equipo|jornada/i.test(homeTeam)) {
          partidos.push({ jornada: jornadaNum, homeTeam, awayTeam,
            homeGoals: null, awayGoals: null, date, played: false });
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
      const partidos   = parseJornada(html, j);
      const delNarahio = partidos.filter(p =>
        NARAHIO.test(p.homeTeam) || NARAHIO.test(p.awayTeam)
      );
      if (delNarahio.length > 0) {
        todasJornadas.push(...delNarahio);
        console.log(`  → J${j}: ${delNarahio[0].homeTeam} vs ${delNarahio[0].awayTeam} | jugado: ${delNarahio[0].played}`);
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`  → J${j}: error (${err.message})`);
    }
  }

  const jugados    = todasJornadas.filter(p => p.played).sort((a,b) => b.jornada - a.jornada);
  const pendientes = todasJornadas.filter(p => !p.played).sort((a,b) => a.jornada - b.jornada);
  const lastMatch  = jugados[0]    || null;
  const nextMatch  = pendientes[0] || null;

  console.log(`  → Último: ${lastMatch?.homeTeam} ${lastMatch?.homeGoals}-${lastMatch?.awayGoals} ${lastMatch?.awayTeam}`);
  console.log(`  → Próximo: ${nextMatch?.homeTeam} vs ${nextMatch?.awayTeam}`);

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

app.get('/api/debug', async (req, res) => {
  try {
    const j    = req.query.jornada || 22;
    const html = await fetchJornada(j);
    res.set('Content-Type', 'text/plain');
    const offset = parseInt(req.query.offset) || 0;
    const narahioIdx = html.toLowerCase().indexOf('narah');
    res.send(`=== JORNADA ${j} | Total: ${html.length} chars | Narahío en posición: ${narahioIdx} ===\n\n` + html.substring(offset, offset + 10000));
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

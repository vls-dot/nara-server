const express  = require('express');
const axios    = require('axios');
const { wrapper }   = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio  = require('cheerio');
const cors     = require('cors');
const cron     = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const FUTGAL_URL  = 'https://www.futgal.es/pnfg/NPcd/NFG_VisCalendario_Vis' +
  '?cod_primaria=1000120&codgrupo=24730792&codcompeticion=24123267' +
  '&codtemporada=21&CodJornada=22&cod_agrupacion=&CDetalle=1';
const FUTGAL_HOME = 'https://www.futgal.es';

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

// ─── Fetch con cookie jar ───
async function fetchPage() {
  const jar    = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));
  await client.get(FUTGAL_HOME, { headers: HEADERS, timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));
  const { data: html } = await client.get(FUTGAL_URL, {
    headers: { ...HEADERS, Referer: `${FUTGAL_HOME}/` },
    timeout: 20000
  });
  return html || '';
}

// ─── Extraer gol del bloque HTML de un <strong><i class=fa-solid>...</i></strong> ───
// futgal usa 4 técnicas de obfuscación, las manejamos todas:
function extractGoal(blockHtml) {
  // Técnica 1: CSS :before con content:"\003N" (sin display:none) → gol real
  // Ejemplo: <style>#id:before{content:"\0032"}</style>
  const beforeMatch = blockHtml.match(/:before\{content:"\\003(\d)"(?!.*display\s*:\s*none)/);
  if (beforeMatch) return parseInt(beforeMatch[1]);

  // Técnica 2: <span id=X>N<span style="display:none;">SEÑUELO</span></span>
  // El primer texto directo del span (antes del hijo oculto) es el gol real
  const spanMatch = blockHtml.match(/<span[^>]*id=[^>]*>(\d)(?:<span[^>]*display\s*:\s*none[^>]*>|$)/);
  if (spanMatch) return parseInt(spanMatch[1]);

  // Técnica 3: <span id=X>N</span> texto directo sin hijos
  const simpleSpan = blockHtml.match(/<span[^>]*id=[^>]*>(\d)<\/span>/);
  if (simpleSpan) return parseInt(simpleSpan[1]);

  // Técnica 4: class=fa-N en <i> interior (cuando las anteriores fallan)
  const faClass = blockHtml.match(/class=fa-(\d)\b/);
  if (faClass) return parseInt(faClass[1]);

  // Técnica 5: número directo en <i class=fa-solid>N</i>
  const directI = blockHtml.match(/<i[^>]*fa-solid[^>]*>\s*(\d)\s*<\/i>/);
  if (directI) return parseInt(directI[1]);

  return null;
}

// ─── Parser del calendario completo ───
function parseCalendar(html) {
  const $ = cheerio.load(html);
  const NARAHIO     = /narah[ií]o/i;
  const competition = '2ª FUTGAL Ferrol 25/26';
  const partidos    = [];

  $('.panel.panel-primary').each((_, panel) => {
    const $panel = $(panel);

    // Número y fecha de la jornada desde el heading
    const headingText = $panel.find('.panel-title').text();
    const jornadaM    = headingText.match(/Jornada\s*(\d+)/i);
    const jornadaNum  = jornadaM ? parseInt(jornadaM[1]) : null;
    const fechaM      = headingText.match(/\((\d{2}-\d{2}-\d{4})\)/);
    const fechaJornada = fechaM ? fechaM[1] : '';

    // Cada fila exterior = un partido
    $panel.find('> .panel-body > table > tbody > tr, > .panel-body > table > tr').each((_, row) => {
      // La fila exterior tiene una inner table con los equipos
      const $innerTable = $(row).find('table').first();
      if (!$innerTable.length) return;

      const $tds = $innerTable.find('tr').first().find('td');
      if ($tds.length < 3) return;

      const homeTeam = $($tds[0]).find('.font_responsive').text().trim();
      const awayTeam = $($tds[2]).find('.font_responsive').text().trim();
      if (!homeTeam || !awayTeam) return;
      if (!NARAHIO.test(homeTeam) && !NARAHIO.test(awayTeam)) return;

      // Fecha específica del partido
      let dateStr = fechaJornada;
      const clockDiv = $(row).find('.fa-clock-o').closest('div, td');
      const clockText = clockDiv.text().trim();
      const dateMatch = clockText.match(/(\d{2}-\d{2}-\d{4})/);
      if (dateMatch) dateStr = dateMatch[1];

      // Celda del marcador (td.ntype con align=center)
      const $ntypeTd = $($tds[1]);
      const ntypeHtml = $ntypeTd.html() || '';

      // Dividir por el separador fa-minus entre gol local y visitante
      const separatorIdx = ntypeHtml.indexOf('fa-minus');
      if (separatorIdx === -1) {
        // Sin resultado — partido pendiente
        partidos.push({ jornada: jornadaNum, homeTeam, awayTeam,
          homeGoals: null, awayGoals: null, date: dateStr, played: false });
        return;
      }

      const homePart = ntypeHtml.substring(0, separatorIdx);
      const awayPart = ntypeHtml.substring(separatorIdx);

      const homeGoal = extractGoal(homePart);
      const awayGoal = extractGoal(awayPart);
      const played   = homeGoal !== null && awayGoal !== null;

      console.log(`  J${jornadaNum}: ${homeTeam} ${played ? homeGoal+'-'+awayGoal : 'vs'} ${awayTeam} (${dateStr})`);

      partidos.push({ jornada: jornadaNum, homeTeam, awayTeam,
        homeGoals: homeGoal, awayGoals: awayGoal, date: dateStr, played });
    });
  });

  const jugados    = partidos.filter(p => p.played).sort((a,b) => b.jornada - a.jornada);
  const pendientes = partidos.filter(p => !p.played).sort((a,b) => a.jornada - b.jornada);

  return {
    lastMatch: jugados[0] ? {
      homeTeam:  jugados[0].homeTeam,  awayTeam:  jugados[0].awayTeam,
      homeGoals: jugados[0].homeGoals, awayGoals: jugados[0].awayGoals,
      date: jugados[0].date, competition, jornada: `Jornada ${jugados[0].jornada}`
    } : null,
    nextMatch: pendientes[0] ? {
      homeTeam: pendientes[0].homeTeam, awayTeam: pendientes[0].awayTeam,
      date: pendientes[0].date, competition, jornada: `Jornada ${pendientes[0].jornada}`
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'futgal.es'
  };
}

// ─── Cache ───
async function refreshCache() {
  try {
    console.log(`[${new Date().toISOString()}] Scrapeando futgal.es...`);
    const html = await fetchPage();
    console.log(`  → HTML: ${html.length} chars`);
    if (html.length < 1000) throw new Error('HTML demasiado corto');

    const result = parseCalendar(html);
    if (!result.lastMatch && !result.nextMatch) throw new Error('No se encontraron partidos del Narahío');

    cache.data      = result;
    cache.updatedAt = new Date();
    console.log(`✅ Último:  ${result.lastMatch?.homeTeam} ${result.lastMatch?.homeGoals}-${result.lastMatch?.awayGoals} ${result.lastMatch?.awayTeam}`);
    console.log(`   Próximo: ${result.nextMatch?.homeTeam} vs ${result.nextMatch?.awayTeam}`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (!cache.data) {
      cache.data      = { ...FALLBACK_DATA, scrapedAt: new Date().toISOString() };
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
  const offset = parseInt(req.query.offset) || 0;
  try {
    const html     = await fetchPage();
    const narahIdx = html.toLowerCase().indexOf('narah');
    res.set('Content-Type', 'text/plain');
    res.send(`Total: ${html.length} | Narahío pos: ${narahIdx}\n\n` +
             html.substring(offset, offset + 10000));
  } catch (err) {
    res.set('Content-Type', 'text/plain');
    res.send('ERROR: ' + err.message);
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

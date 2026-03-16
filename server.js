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

// ─── La página muestra TODA la temporada — solo necesitamos un fetch ───
const FUTGAL_URL = 'https://www.futgal.es/pnfg/NPcd/NFG_VisCalendario_Vis' +
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

  // Paso 1: home para obtener session_id
  await client.get(FUTGAL_HOME, { headers: HEADERS, timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));

  // Paso 2: página del calendario completo
  const { data: html } = await client.get(FUTGAL_URL, {
    headers: { ...HEADERS, Referer: `${FUTGAL_HOME}/` },
    timeout: 20000
  });
  return html || '';
}

// ─── Extraer número de gol del HTML del td.ntype ───
// futgal oculta los goles con JS/CSS, pero siempre deja el número
// en algún sitio accesible: display:none span, texto directo, o clase fa-N
function extractGoal(ntypeHtml) {
  // 1. Buscar <span style="display:none;">N</span>
  const hiddenSpan = ntypeHtml.match(/<span[^>]*display\s*:\s*none[^>]*>(\d+)<\/span>/i);
  if (hiddenSpan) return parseInt(hiddenSpan[1]);

  // 2. Buscar texto directo en <i class=fa-solid>N</i> (sin hijos)
  const directText = ntypeHtml.match(/<i[^>]*fa-solid[^>]*>\s*(\d+)\s*<\/i>/i);
  if (directText) return parseInt(directText[1]);

  // 3. Buscar clase fa-N (fa-0 a fa-9)
  const faClass = ntypeHtml.match(/class=['""]?fa-(\d)\b/i);
  if (faClass) return parseInt(faClass[1]);

  return null;
}

// ─── Parser principal ───
function parseCalendar(html) {
  const $ = cheerio.load(html);
  const NARAHIO = /narah[ií]o/i;
  const competition = '2ª FUTGAL Ferrol 25/26';
  const partidos = [];

  // Recorrer cada panel de jornada
  // Estructura: <div class="panel panel-primary"> > <h3>Jornada N ...</h3> > <table> > <tr> (partidos)
  $('.panel.panel-primary').each((_, panel) => {
    const $panel = $(panel);

    // Número de jornada
    const heading   = $panel.find('.panel-title').text();
    const jornadaM  = heading.match(/Jornada\s*(\d+)/i);
    const jornadaNum = jornadaM ? parseInt(jornadaM[1]) : null;

    // Fecha de la jornada desde el heading: "(DD-MM-YYYY)"
    const fechaJM  = heading.match(/\((\d{2}-\d{2}-\d{4})\)/);
    const fechaJornada = fechaJM ? fechaJM[1] : '';

    // Cada fila es un partido — contiene una inner table con 4 tds
    $panel.find('tr').each((_, row) => {
      const $row = $(row);

      // Inner table con los equipos y el resultado
      const $innerTable = $row.find('table');
      if (!$innerTable.length) return;

      // Celdas de la inner table
      const $tds = $innerTable.find('td');
      if ($tds.length < 3) return;

      // td[0] = equipo local (align=right), td[1] = ntype (marcador), td[2] = equipo visitante
      const homeTeam = $($tds[0]).find('span.font_responsive').text().trim();
      const awayTeam = $($tds[2]).find('span.font_responsive').text().trim();
      const $ntypeTd = $tds.filter((_, td) => $(td).hasClass('ntype'));

      if (!homeTeam || !awayTeam) return;
      if (!NARAHIO.test(homeTeam) && !NARAHIO.test(awayTeam)) return;

      // Extraer fecha del div con fa-clock-o
      let dateStr = fechaJornada;
      const clockText = $row.find('.fa-clock-o').parent().text().trim();
      const dateMatch = clockText.match(/(\d{2}-\d{2}-\d{4})/);
      if (dateMatch) dateStr = dateMatch[1];

      // Extraer goles
      const ntypeHtml = $ntypeTd.html() || '';
      
      // Separar goles: el marcador es "gol_local - gol_visitante"
      // El html tiene: [strong con gol1] [fa-minus] [strong con gol2]
      const parts = ntypeHtml.split(/<i[^>]*fa-minus[^>]*>/i);
      const homeGoal = parts[0] ? extractGoal(parts[0]) : null;
      const awayGoal = parts[1] ? extractGoal(parts[1]) : null;

      const played = homeGoal !== null && awayGoal !== null;

      console.log(`  J${jornadaNum}: ${homeTeam} ${played ? homeGoal+'-'+awayGoal : 'vs'} ${awayTeam} (${dateStr})`);

      partidos.push({
        jornada: jornadaNum,
        homeTeam, awayTeam,
        homeGoals: homeGoal,
        awayGoals: awayGoal,
        date: dateStr,
        played
      });
    });
  });

  const jugados    = partidos.filter(p => p.played).sort((a,b) => b.jornada - a.jornada);
  const pendientes = partidos.filter(p => !p.played).sort((a,b) => a.jornada - b.jornada);

  return {
    lastMatch: jugados[0] ? {
      homeTeam:  jugados[0].homeTeam,
      awayTeam:  jugados[0].awayTeam,
      homeGoals: jugados[0].homeGoals,
      awayGoals: jugados[0].awayGoals,
      date:      jugados[0].date,
      competition,
      jornada:   `Jornada ${jugados[0].jornada}`
    } : null,
    nextMatch: pendientes[0] ? {
      homeTeam:  pendientes[0].homeTeam,
      awayTeam:  pendientes[0].awayTeam,
      date:      pendientes[0].date,
      competition,
      jornada:   `Jornada ${pendientes[0].jornada}`
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'futgal.es'
  };
}

// ─── Cache ───
async function refreshCache() {
  try {
    console.log(`[${new Date().toISOString()}] Scrapeando futgal.es...`);
    const html   = await fetchPage();
    console.log(`  → HTML: ${html.length} chars`);
    if (html.length < 1000) throw new Error('HTML demasiado corto');

    const result = parseCalendar(html);
    if (!result.lastMatch && !result.nextMatch) throw new Error('No se encontraron partidos del Narahío');

    cache.data = result;
    cache.updatedAt = new Date();
    console.log(`✅ Cache actualizado — último: ${result.lastMatch?.homeTeam} ${result.lastMatch?.homeGoals}-${result.lastMatch?.awayGoals} ${result.lastMatch?.awayTeam}`);
    console.log(`   próximo: ${result.nextMatch?.homeTeam} vs ${result.nextMatch?.awayTeam}`);
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

// Debug: muestra el HTML en el offset indicado
app.get('/api/debug', async (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  try {
    const html     = await fetchPage();
    const narahIdx = html.toLowerCase().indexOf('narah');
    res.set('Content-Type', 'text/plain');
    res.send(`Total: ${html.length} chars | Narahío pos: ${narahIdx}\n\n` +
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

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
    homeTeam: "AD Miño B", awayTeam: "UD Narahío",
    homeGoals: 0, awayGoals: 2, date: "15-03-2026",
    competition: "2ª FUTGAL Ferrol 25/26", jornada: "Jornada 22"
  },
  nextMatch: {
    homeTeam: "UD Narahío", awayTeam: "A.D.R. Numancia de Ares",
    date: "22-03-2026",
    competition: "2ª FUTGAL Ferrol 25/26", jornada: "Jornada 23"
  },
  source: "fallback"
};

let cache = { data: null, updatedAt: null };
const CACHE_MINUTES = 60;

// ─── Crear sesión con cookie jar ───
async function createSession() {
  const jar    = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));
  await client.get(FUTGAL_HOME, { headers: HEADERS, timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));
  return client;
}

// ─── Fetch del calendario ───
async function fetchPage(client) {
  const { data: html } = await client.get(FUTGAL_URL, {
    headers: { ...HEADERS, Referer: `${FUTGAL_HOME}/` },
    timeout: 20000,
    responseEncoding: 'latin1'
  });
  return html || '';
}

// ─── Extraer gol de un bloque HTML ───
// Estrategia por orden de fiabilidad:
// 1. Texto directo en <i class="fa-solid">N</i> (sin hijos)
// 2. Primer texto visible en <span id=idh...> antes de cualquier hijo oculto
// 3. Número en clase fa-N del <i> interior
// 4. CSS :before con content:"\003N" (sin display:none)
function extractGoal(blockHtml) {
  // 1. Texto directo en fa-solid sin hijos: <i class="fa-solid">2</i>
  const directMatch = blockHtml.match(/<i[^>]*fa-solid[^>]*>\s*(\d)\s*<\/i>/);
  if (directMatch) return parseInt(directMatch[1]);

  // 2. Span con texto visible ANTES de hijo oculto: <span id=idh...>2<span hidden>...
  //    o span con texto y sin hijos: <span id=idh...>2</span>
  const spanMatch = blockHtml.match(/<span[^>]*id=["']?idh[^>]*>\s*(\d)/);
  if (spanMatch) {
    // Verificar que ese dígito no está dentro de un display:none
    const afterDigit = blockHtml.substring(blockHtml.indexOf(spanMatch[1]));
    if (!afterDigit.startsWith(spanMatch[1] + '<span')) {
      return parseInt(spanMatch[1]);
    }
  }

  // 3. Clase fa-N en el <i> interior
  const faMatch = blockHtml.match(/class=["']?fa-(\d)\b/);
  if (faMatch) return parseInt(faMatch[1]);

  // 4. CSS :before con contenido numérico real (sin display:none)
  const beforeMatch = blockHtml.match(/:before\{content:"\\003(\d)"(?!\s*;?\s*display)/);
  if (beforeMatch) return parseInt(beforeMatch[1]);

  // 5. CSS :before sin unicode: content:"N"
  const beforePlain = blockHtml.match(/:before\{content:"(\d)"(?!\s*;?\s*display)/);
  if (beforePlain) return parseInt(beforePlain[1]);

  return null;
}

// ─── Normalizar nombre del equipo ───
function normalizeName(raw) {
  return raw
    .replace(/NARAHIO U\.?D\.?/i,        'UD Narahío')
    .replace(/RAPIDO DE NEDA/i,           'Rápido de Neda')
    .replace(/ASOCIACION DEPORTIVA/i,     'AD')
    .replace(/GALICIA MUGARDOS "B"/i,     'Galicia Mugardos B')
    .replace(/S\.D\.C\.\s*/i,             'SDC ')
    .replace(/A\.D\.R\.\s*/i,             'ADR ')
    .replace(/A\.D\.C\.\s*/i,             'ADC ')
    .replace(/C\.C\.R\.Y D\.\s*/i,        'CCRD ')
    .replace(/C\.F\.\s*/i,                'CF ')
    .replace(/C\.D\.\s*/i,                'CD ')
    .replace(/S\.D\.\s*/i,                'SD ')
    .replace(/U\.D\.\s*/i,                'UD ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Parsear el calendario completo ───
function parseCalendar(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const NARAHIO     = /narah[ií]o/i;
  const competition = '2ª FUTGAL Ferrol 25/26';
  const partidos    = [];
  const today       = new Date(); today.setHours(0,0,0,0);

  $('.panel.panel-primary').each((_, panel) => {
    const $panel = $(panel);

    // Número y fecha de la jornada
    const headingText  = $panel.find('.panel-title').text();
    const jornadaM     = headingText.match(/Jornada\s*(\d+)/i);
    const jornadaNum   = jornadaM ? parseInt(jornadaM[1]) : null;
    const fechaM       = headingText.match(/\((\d{2}-\d{2}-\d{4})\)/);
    const fechaJornada = fechaM ? fechaM[1] : '';

    // Cada fila exterior = un partido
    $panel.find('> .panel-body > table > tbody > tr, > .panel-body > table > tr').each((_, row) => {
      const $innerTable = $(row).find('table').first();
      if (!$innerTable.length) return;

      const $tds = $innerTable.find('tr').first().find('td');
      if ($tds.length < 3) return;

      const homeTeamRaw = $($tds[0]).find('.font_responsive').text().trim();
      const awayTeamRaw = $($tds[2]).find('.font_responsive').text().trim();
      if (!homeTeamRaw || !awayTeamRaw) return;
      if (!NARAHIO.test(homeTeamRaw) && !NARAHIO.test(awayTeamRaw)) return;

      const homeTeam = normalizeName(homeTeamRaw);
      const awayTeam = normalizeName(awayTeamRaw);

      // Fecha del partido
      let dateStr = fechaJornada;
      const clockText = $(row).find('.fa-clock-o').parent().text().trim();
      const dateMatch = clockText.match(/(\d{2}-\d{2}-\d{4})/);
      if (dateMatch) dateStr = dateMatch[1];

      // Convertir fecha a objeto Date
      let matchDate = null;
      const dm = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
      if (dm) matchDate = new Date(`${dm[3]}-${dm[2]}-${dm[1]}`);

      // Enlace del acta → partido jugado
      const hasActa = $(row).find('a[href*="NFG_CmpPartido"]').length > 0;

      // Si no tiene acta y la fecha ya pasó → ignorar (partido sin resultado registrado)
      if (!hasActa && matchDate && matchDate < today) return;

      const played = hasActa;

      // Extraer goles del td central (ntype)
      let homeGoals = null, awayGoals = null;
      if (played) {
        const $ntypeTd  = $($tds[1]);
        const ntypeHtml = $ntypeTd.html() || '';
        const sepIdx    = ntypeHtml.indexOf('fa-minus');
        if (sepIdx !== -1) {
          homeGoals = extractGoal(ntypeHtml.substring(0, sepIdx));
          awayGoals = extractGoal(ntypeHtml.substring(sepIdx));
        }
      }

      console.log(`  J${jornadaNum}: ${homeTeam} ${played ? (homeGoals??'?')+'-'+(awayGoals??'?') : 'vs'} ${awayTeam} (${dateStr})`);

      partidos.push({ jornada: jornadaNum, homeTeam, awayTeam,
        homeGoals, awayGoals, date: dateStr, matchDate, played });
    });
  });

  const jugados    = partidos.filter(p => p.played).sort((a,b) => b.jornada - a.jornada);
  const pendientes = partidos.filter(p => !p.played && p.matchDate && p.matchDate >= today)
                             .sort((a,b) => a.jornada - b.jornada);

  return {
    lastMatch: jugados[0] ? {
      homeTeam:  jugados[0].homeTeam,  awayTeam:  jugados[0].awayTeam,
      homeGoals: jugados[0].homeGoals, awayGoals: jugados[0].awayGoals,
      date:      jugados[0].date,      competition,
      jornada:   `Jornada ${jugados[0].jornada}`
    } : null,
    nextMatch: pendientes[0] ? {
      homeTeam: pendientes[0].homeTeam, awayTeam: pendientes[0].awayTeam,
      date:     pendientes[0].date,     competition,
      jornada:  `Jornada ${pendientes[0].jornada}`
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'futgal.es'
  };
}

// ─── Cache ───
async function refreshCache() {
  try {
    console.log(`[${new Date().toISOString()}] Scrapeando futgal.es...`);
    const client = await createSession();
    const html   = await fetchPage(client);
    console.log(`  → HTML: ${html.length} chars`);
    if (html.length < 1000) throw new Error('HTML demasiado corto');

    const result = parseCalendar(html);
    if (!result.lastMatch && !result.nextMatch) throw new Error('No se encontraron partidos');

    cache.data      = result;
    cache.updatedAt = new Date();
    console.log(`✅ Último:  ${result.lastMatch?.homeTeam} ${result.lastMatch?.homeGoals}-${result.lastMatch?.awayGoals} ${result.lastMatch?.awayTeam}`);
    console.log(`   Próximo: ${result.nextMatch?.homeTeam} vs ${result.nextMatch?.awayTeam} (${result.nextMatch?.date})`);
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

// Forzar actualización manual
app.get('/api/refresh', async (req, res) => {
  await refreshCache();
  res.json({ ok: true, data: cache.data });
});

// Debug: HTML del calendario
app.get('/api/debug', async (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  try {
    const client = await createSession();
    const html   = await fetchPage(client);
    res.set('Content-Type', 'text/plain');
    res.send(`Total: ${html.length} | Narahío pos: ${html.toLowerCase().indexOf('narah')}\n\n` +
             html.substring(offset, offset + 10000));
  } catch (err) {
    res.set('Content-Type', 'text/plain');
    res.send('ERROR: ' + err.message);
  }
});

// Debug: partidos del Narahío con HTML del marcador
app.get('/api/narahio-html', async (req, res) => {
  try {
    const client = await createSession();
    const html   = await fetchPage(client);
    const $      = cheerio.load(html, { decodeEntities: false });
    const results = [];
    $('.panel.panel-primary').each((_, panel) => {
      $(panel).find('table tr').each((_, row) => {
        if (/narah/i.test($(row).text())) {
          results.push({
            jornada:   $(panel).find('.panel-title').text().trim(),
            innerHtml: $(row).find('table').first().html()
          });
        }
      });
    });
    res.json(results);
  } catch (err) {
    res.status(500).send('ERROR: ' + err.message);
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

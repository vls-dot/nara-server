const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── CONFIGURACIÓN ───
// Consigue tu API key gratis en https://scraperapi.com (1000 peticiones/mes gratis)
const SCRAPER_KEY = process.env.SCRAPER_KEY || 'TU_API_KEY_AQUI';
const TARGET_URL  = 'https://www.lapreferente.com/E13336C22825-13/ud-y-cultural-narahio';

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

// ─── FETCH con ScraperAPI ───
async function fetchPage() {
  const url = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(TARGET_URL)}&render=true`;
  const { data: html } = await axios.get(url, { timeout: 30000 });
  return html;
}

// ─── SCRAPING lapreferente.com ───
async function scrapePartidos() {
  console.log(`[${new Date().toISOString()}] Scrapeando lapreferente.com via ScraperAPI...`);

  const html = await fetchPage();
  const $ = cheerio.load(html);
  const competition = '2ª FUTGAL Ferrol 25/26';

  console.log(`  → HTML recibido: ${html.length} caracteres`);

  const jugados    = [];
  const pendientes = [];

  // Buscar filas de tabla con partidos
  $('tr').each((_, el) => {
    const cells = $(el).find('td');
    if (cells.length < 3) return;

    const text = $(el).text().replace(/\s+/g, ' ').trim();

    // Partido jugado: contiene resultado numérico
    const scoreMatch = text.match(/(.+?)\s+(\d+)\s*[-:]\s*(\d+)\s+(.+)/);
    if (scoreMatch) {
      const home = scoreMatch[1].trim();
      const away = scoreMatch[4].replace(/ver|ficha|editar/gi, '').trim();
      if (home.length > 2 && away.length > 2 &&
          !/^(local|visitante|equipo|jornada|fecha|resultado)$/i.test(home)) {
        jugados.push({
          homeTeam: home, awayTeam: away,
          homeGoals: parseInt(scoreMatch[2]),
          awayGoals: parseInt(scoreMatch[3]),
          date: extractDate(text), jornada: extractJornada(text)
        });
        return;
      }
    }

    // Partido pendiente: sin resultado pero con dos equipos
    const parts = cells.map((_, c) => $(c).text().trim()).get().filter(t => t.length > 1);
    if (parts.length >= 2) {
      const hasDate = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(text);
      const noScore = !/\d\s*[-:]\s*\d/.test(text);
      if (hasDate && noScore) {
        pendientes.push({
          homeTeam: parts[0], awayTeam: parts[parts.length - 1],
          date: extractDate(text), jornada: extractJornada(text)
        });
      }
    }
  });

  // Si no encontramos nada en tablas, buscar en divs
  if (jugados.length === 0 && pendientes.length === 0) {
    console.log('  → No se encontraron tablas, buscando en divs...');

    $('[class*="match"], [class*="partido"], [class*="result"], [class*="fixture"], [class*="game"]').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 300) return;

      const scoreMatch = text.match(/(.+?)\s+(\d+)\s*[-:]\s*(\d+)\s+(.+)/);
      if (scoreMatch) {
        jugados.push({
          homeTeam: scoreMatch[1].trim(),
          awayTeam: scoreMatch[4].replace(/ver|ficha/gi, '').trim(),
          homeGoals: parseInt(scoreMatch[2]),
          awayGoals: parseInt(scoreMatch[3]),
          date: extractDate(text), jornada: extractJornada(text)
        });
      }
    });
  }

  // Ordenar
  jugados.sort((a, b) => (b.jornada || 0) - (a.jornada || 0));
  pendientes.sort((a, b) => (a.jornada || 999) - (b.jornada || 999));

  console.log(`  → ${jugados.length} jugados, ${pendientes.length} pendientes`);
  jugados.slice(0, 3).forEach(j =>
    console.log(`    JUGADO: ${j.homeTeam} ${j.homeGoals}-${j.awayGoals} ${j.awayTeam} | J${j.jornada}`)
  );
  pendientes.slice(0, 2).forEach(j =>
    console.log(`    PRÓXIMO: ${j.homeTeam} vs ${j.awayTeam} | ${j.date}`)
  );

  const lastMatch = jugados[0]    || null;
  const nextMatch = pendientes[0] || null;

  return {
    lastMatch: lastMatch ? {
      homeTeam: lastMatch.homeTeam, awayTeam: lastMatch.awayTeam,
      homeGoals: lastMatch.homeGoals, awayGoals: lastMatch.awayGoals,
      date: lastMatch.date, competition,
      jornada: lastMatch.jornada ? `Jornada ${lastMatch.jornada}` : ''
    } : null,
    nextMatch: nextMatch ? {
      homeTeam: nextMatch.homeTeam, awayTeam: nextMatch.awayTeam,
      date: nextMatch.date, competition,
      jornada: nextMatch.jornada ? `Jornada ${nextMatch.jornada}` : ''
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'lapreferente.com'
  };
}

function extractDate(text) {
  const m = text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/);
  return m ? m[0] : '';
}

function extractJornada(text) {
  const m = text.match(/[Jj]ornada\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// ─── CACHE ───
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

// Debug: muestra el HTML recibido para ajustar selectores si hace falta
app.get('/api/debug', async (req, res) => {
  try {
    const html = await fetchPage();
    res.set('Content-Type', 'text/plain');
    res.send(html.substring(0, 10000));
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
  if (SCRAPER_KEY === 'TU_API_KEY_AQUI') {
    console.log('⚠️  AVISO: No has configurado la SCRAPER_KEY. Añádela en las variables de entorno de Render.');
  }
  await refreshCache();
});

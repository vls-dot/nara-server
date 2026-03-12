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
    date: "Domingo, 1 de Marzo de 2026",
    competition: "2ª FUTGAL Ferrol 25/26", jornada: "Jornada 21"
  },
  nextMatch: {
    homeTeam: "Rápido de Neda", awayTeam: "UD Narahío",
    date: "Domingo, 15 de Marzo de 2026",
    competition: "2ª FUTGAL Ferrol 25/26", jornada: "Jornada 23"
  },
  source: "fallback"
};

let cache = { data: null, updatedAt: null };
const CACHE_MINUTES = 30;

async function scrapePartidos() {
  console.log(`[${new Date().toISOString()}] Scrapeando siguetuliga.com...`);

  const { data: html } = await axios.get('https://www.siguetuliga.com/equipo/ud-narahio', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Cache-Control': 'max-age=0'
    },
    timeout: 15000
  });

  const $ = cheerio.load(html);
  const competition = '2ª FUTGAL Ferrol 25/26';
  const jornadas = [];

  $('a[href*="/partido/"]').each((_, el) => {
    const $el = $(el);
    const linkText = $el.text().replace(/\s+/g, ' ').trim();
    if (!linkText) return;

    // Subir en el DOM buscando jornada y fecha
    let jornadaNum = null;
    let dateText = null;
    let $parent = $el.parent();

    for (let i = 0; i < 8; i++) {
      const fullText = $parent.text();
      if (!jornadaNum) {
        const m = fullText.match(/[Jj]ornada\s*(\d+)/);
        if (m) jornadaNum = parseInt(m[1]);
      }
      if (!dateText) {
        const d = fullText.match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)[^,]*,\s*\d{1,2}\s+de\s+\w+\s+de\s+\d{4}/i);
        if (d) dateText = d[0];
      }
      $parent = $parent.parent();
    }

    // Partido con resultado: "Equipo A 2 · 1 Equipo B"
    const withScore = linkText.match(/^(.+?)\s+(\d+)\s*[·•]\s*(\d+)\s+(.+)$/);
    // Partido pendiente: "Equipo A - Equipo B"
    const withDash = linkText.match(/^(.+?)\s+[-–]\s+(.+)$/);

    const clean = (s) => s.replace(/rellenar acta|enviar resultado|cambiar hora/gi, '').trim();

    if (withScore) {
      jornadas.push({
        jornada: jornadaNum, date: dateText,
        homeTeam: clean(withScore[1]), awayTeam: clean(withScore[4]),
        homeGoals: parseInt(withScore[2]), awayGoals: parseInt(withScore[3]),
        played: true
      });
    } else if (withDash) {
      jornadas.push({
        jornada: jornadaNum, date: dateText,
        homeTeam: clean(withDash[1]), awayTeam: clean(withDash[2]),
        played: false
      });
    }
  });

  console.log(`  → ${jornadas.length} partidos encontrados`);
  jornadas.forEach(j => console.log(`    J${j.jornada}: ${j.homeTeam} vs ${j.awayTeam} | jugado: ${j.played}`));

  const jugados    = jornadas.filter(j => j.played);
  const pendientes = jornadas.filter(j => !j.played);
  const lastMatch  = jugados.length    > 0 ? jugados[jugados.length - 1] : null;
  const nextMatch  = pendientes.length > 0 ? pendientes[0]               : null;

  return {
    lastMatch: lastMatch ? {
      homeTeam: lastMatch.homeTeam, awayTeam: lastMatch.awayTeam,
      homeGoals: lastMatch.homeGoals, awayGoals: lastMatch.awayGoals,
      date: lastMatch.date || '', competition, jornada: `Jornada ${lastMatch.jornada}`
    } : null,
    nextMatch: nextMatch ? {
      homeTeam: nextMatch.homeTeam, awayTeam: nextMatch.awayTeam,
      date: nextMatch.date || '', competition, jornada: `Jornada ${nextMatch.jornada}`
    } : null,
    scrapedAt: new Date().toISOString(),
    source: 'siguetuliga.com'
  };
}

async function refreshCache() {
  try {
    const result = await scrapePartidos();
    if (!result.lastMatch && !result.nextMatch) throw new Error('Datos vacíos');
    cache.data = result;
    cache.updatedAt = new Date();
    console.log('✅ Cache actualizado');
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
    const expired = !cache.updatedAt || (new Date() - cache.updatedAt) > CACHE_MINUTES * 60 * 1000;
    if (expired || !cache.data) await refreshCache();
    if (!cache.data) return res.status(503).json({ error: 'Sin datos disponibles' });
    res.json({ ...cache.data, cacheAge: Math.round((new Date() - cache.updatedAt) / 1000) + 's' });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', hasData: !!cache.data, updatedAt: cache.updatedAt }));

cron.schedule('0 9 * * 1,4', () => refreshCache(), { timezone: 'Europe/Madrid' });

app.listen(PORT, async () => {
  console.log(`\n🚀 Servidor UD Narahío en puerto ${PORT}`);
  await refreshCache();
});

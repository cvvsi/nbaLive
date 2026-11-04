/* Every team's remaining regular-season games -> data/schedule.json, for the Proj tab's
 * season (games left) and week (games this week / next) views.
 *
 * Usage:  node build-schedule.js
 * Writes: data/schedule.json  { built, from, dates: { "YYYY-MM-DD": [[away, home], ...] } }
 * Team codes are ESPN's (same as the box scores). Dates are ESPN's calendar (US Eastern).
 * Cached in .cache/schedule.json: dates more than 10 days out are refetched weekly, nearer
 * ones every run (postponements, makeups).
 */
const fs = require('fs');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const CACHE = '.cache/schedule.json', OUT = 'data/schedule.json';
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const shift = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const J = async u => {
  for (let i = 0; ; i++) {
    try { const r = await fetch(u); if (!r.ok) throw new Error(r.status + ' ' + u); return await r.json(); }
    catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
};

(async () => {
  const today = etToday(), near = shift(today, 10), now = Date.now();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) {}
  const sb = await J(`${API}/scoreboard?dates=${today.replace(/-/g, '')}`);
  const dates = [...new Set((sb.leagues[0].calendar || []).map(d => d.slice(0, 10)))].filter(d => d >= today).sort();
  const out = {};
  let fetched = 0;
  for (const d of dates) {
    const c = cache[d];
    if (!c || d <= near || now - c.at > 7 * 864e5) {
      const day = await J(`${API}/scoreboard?dates=${d.replace(/-/g, '')}`);
      const g = [];
      for (const e of day.events || []) {
        if ((e.season && e.season.slug) !== 'regular-season') continue;
        const t = e.competitions[0].competitors, a = t.find(x => x.homeAway === 'away'), h = t.find(x => x.homeAway === 'home');
        if (a && h) g.push([a.team.abbreviation, h.team.abbreviation]);
      }
      cache[d] = { at: now, g }; fetched++;
    }
    if (cache[d].g.length) out[d] = cache[d].g;
  }
  fs.mkdirSync('.cache', { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache));
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), from: today, dates: out }));
  const n = Object.values(out).reduce((a, g) => a + g.length, 0);
  console.log(`${OUT}: ${Object.keys(out).length} game days, ${n} games from ${today} (${fetched} days fetched)`);
  if (!n && dates.length) throw new Error('No regular-season games found');
})().catch(e => { console.error(e.message); process.exit(1); });

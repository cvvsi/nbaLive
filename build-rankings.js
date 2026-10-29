/* Season / last-30 / last-14 / last-7 day 9-cat rankings -> data/rankings.json (committed;
 * index.html reads it to show each player's ranks beside tonight's line).
 *
 * Per-game averages over each window, z-scored against a top-156 pool (12 teams x 13),
 * iterated so the pool settles on the players who'd actually be rostered. FG%/FT% use the
 * same volume-weighted impact as the box score: makes - poolPct * attempts, per game.
 * The page re-ranks from the stored z-scores, so punts apply to these ranks too.
 *
 * Usage:  node build-rankings.js            through yesterday (US Eastern)
 *         node build-rankings.js 20261028   through that date
 * Finished box scores are cached in .cache/games.json (the nightly Action keeps it
 * between runs), so a rebuild only fetches games it hasn't seen.
 */
const fs = require('fs');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const CATS = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to'];
const WINDOWS = { season: 0, d30: 30, d14: 14, d7: 7 };
const POOL = 156, ITER = 4;
const CACHE = '.cache/games.json', OUT = 'data/rankings.json';

const J = async u => {
  for (let i = 0; ; i++) {
    try { const r = await fetch(u); if (!r.ok) throw new Error(r.status + ' ' + u); return await r.json(); }
    catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
};
const split = s => { const [m, a] = String(s || '0-0').split('-').map(Number); return [m || 0, a || 0]; };
const sum = (a, k) => a.reduce((s, p) => s + p[k], 0);
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const shift = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const r2 = v => Math.round(v * 100) / 100;

// Only what the rankings need, as a compact row per player-game.
function parseBox(j) {
  const out = [];
  for (const t of (j.boxscore && j.boxscore.players) || []) {
    const st = t.statistics[0]; if (!st) continue;
    const ix = n => st.keys.indexOf(n);
    const I = {
      min: ix('minutes'), pts: ix('points'), fg: ix('fieldGoalsMade-fieldGoalsAttempted'),
      tp: ix('threePointFieldGoalsMade-threePointFieldGoalsAttempted'),
      ft: ix('freeThrowsMade-freeThrowsAttempted'), reb: ix('rebounds'), ast: ix('assists'),
      to: ix('turnovers'), stl: ix('steals'), blk: ix('blocks'),
    };
    for (const a of st.athletes) {
      if (a.didNotPlay || !a.stats || !a.stats.length || !a.athlete.id) continue;
      const s = a.stats, min = parseFloat(s[I.min]) || 0; if (min <= 0) continue;
      const [fgm, fga] = split(s[I.fg]), [tpm] = split(s[I.tp]), [ftm, fta] = split(s[I.ft]);
      out.push({
        id: String(a.athlete.id), name: a.athlete.displayName, team: t.team.abbreviation, min,
        pts: +s[I.pts] || 0, reb: +s[I.reb] || 0, ast: +s[I.ast] || 0, stl: +s[I.stl] || 0,
        blk: +s[I.blk] || 0, to: +s[I.to] || 0, fgm, fga, tpm, ftm, fta,
      });
    }
  }
  return out;
}

async function loadGames(through) {
  // days[d] = true once every game on d is final (or it's a preseason date); games[eventId] = rows.
  let cache = { days: {}, games: {} };
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) {}
  const sb = await J(`${API}/scoreboard?dates=${through.replace(/-/g, '')}`);
  const dates = (sb.leagues[0].calendar || []).map(d => d.slice(0, 10)).filter(d => d <= through);
  const games = [];
  for (const d of dates) {
    if (cache.days[d]) { games.push(...Object.values(cache.games).filter(g => g.date === d)); continue; }
    const day = await J(`${API}/scoreboard?dates=${d.replace(/-/g, '')}`);
    let settled = true;
    for (const e of day.events || []) {
      if ((e.season && e.season.slug) !== 'regular-season') continue;
      if (e.status.type.state !== 'post') { settled = false; continue; }   // pick it up next run
      const g = cache.games[e.id] || (cache.games[e.id] =
        { date: d, rows: parseBox(await J(`${API}/summary?event=${e.id}`)) });
      games.push(g);
    }
    if (settled) cache.days[d] = true;
    process.stderr.write(`${d}: ${(day.events || []).length} games${settled ? '' : ' (some not final)'}\n`);
  }
  fs.mkdirSync('.cache', { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return games;
}

function rankWindow(games) {
  const by = {};
  for (const g of games) for (const r of g.rows) {
    const p = by[r.id] || (by[r.id] = { id: r.id, gp: 0, min: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, fgm: 0, fga: 0, tpm: 0, ftm: 0, fta: 0 });
    p.gp++; for (const k of ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'fgm', 'fga', 'tpm', 'ftm', 'fta']) p[k] += r[k];
  }
  const P = Object.values(by);
  for (const p of P) for (const k of ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'fgm', 'fga', 'tpm', 'ftm', 'fta']) p[k] /= p.gp;
  // A pool member must have played at least half as many games as the busiest player in the
  // window, so a single 40-minute blowout doesn't stretch the pool's spread.
  const maxGP = Math.max(...P.map(p => p.gp)), elig = P.filter(p => p.gp >= Math.ceil(maxGP / 2));
  let pool = [...elig].sort((a, b) => b.min * b.gp - a.min * a.gp).slice(0, POOL);
  const src = { pts: 'pts', tpm: 'tpm', reb: 'reb', ast: 'ast', stl: 'stl', blk: 'blk', fg: 'fgi', ft: 'fti', to: 'to' };
  for (let it = 0; it < ITER; it++) {
    const lgFG = sum(pool, 'fgm') / Math.max(1, sum(pool, 'fga')), lgFT = sum(pool, 'ftm') / Math.max(1, sum(pool, 'fta'));
    for (const p of P) { p.fgi = p.fgm - lgFG * p.fga; p.fti = p.ftm - lgFT * p.fta; }
    for (const c of CATS) {
      const k = src[c], m = sum(pool, k) / pool.length;
      const sd = Math.sqrt(pool.reduce((a, p) => a + (p[k] - m) ** 2, 0) / pool.length) || 1;
      for (const p of P) (p.z || (p.z = {}))[c] = (c === 'to' ? -1 : 1) * (p[k] - m) / sd;
    }
    for (const p of P) p.value = CATS.reduce((a, c) => a + p.z[c], 0) / 9;
    pool = [...elig].sort((a, b) => b.value - a.value).slice(0, POOL);
  }
  return P;
}

(async () => {
  const arg = process.argv[2];
  const through = arg ? `${arg.slice(0, 4)}-${arg.slice(4, 6)}-${arg.slice(6, 8)}` : shift(etToday(), -1);
  const games = await loadGames(through);
  if (!games.length) { console.log('No finished regular-season games through', through); return; }

  const asOf = games.reduce((m, g) => g.date > m ? g.date : m, '');
  const players = {}, windows = {};
  // Latest game wins for name/team, so traded players show their current team.
  for (const g of [...games].sort((a, b) => a.date < b.date ? -1 : 1))
    for (const r of g.rows) players[r.id] = { n: r.name, t: r.team, w: {} };
  for (const [w, days] of Object.entries(WINDOWS)) {
    const from = days ? shift(asOf, 1 - days) : games.reduce((m, g) => g.date < m ? g.date : m, asOf);
    const inW = games.filter(g => g.date >= from);
    windows[w] = { from, to: asOf, games: inW.length };
    for (const p of rankWindow(inW))
      players[p.id].w[w] = [p.gp, Math.round(p.min * 10) / 10, ...CATS.map(c => r2(p.z[c]))];
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ asOf, cats: CATS, fields: ['gp', 'mpg', ...CATS], windows, players }));
  console.log(`${OUT}: ${Object.keys(players).length} players through ${asOf}`, JSON.stringify(windows));
})();

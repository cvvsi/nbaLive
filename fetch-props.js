/* Player props from The Odds API (https://the-odds-api.com) -> data/props.json, for the Proj
 * tab's Today view. Needs the ODDS_API_KEY repo secret; never put the key in the repo (public).
 *
 * Usage:  node fetch-props.js          tonight's slate (US Eastern). Games already priced in
 *                                      today's file are skipped, so a second run only fills in
 *                                      games whose props weren't posted yet.
 *         node fetch-props.js force    refetch every game tonight
 *         node fetch-props.js probe    list games (free) + ONE game's props, printing the cost
 *
 * Credits: listing events is free; one game costs 1 credit per market that comes back (markets
 * with no lines are free). The x-requests-* headers are printed on every call.
 *
 * What's stored is ours, not raw odds: per player and stat, the market's implied average (mu),
 * the median line and how many books priced it. Per book: the over/under pair's vig is removed
 * (each side's implied probability divided by their sum), then mu is solved so that
 * P(stat > line) equals the fair over probability. Points, rebounds and assists use a normal
 * curve with variance PHI x mu; threes, steals, blocks and turnovers use a Poisson. mu is the
 * median across books.
 * A copy goes to data/props/YYYY-MM-DD.json, to score the market against Proj and the results.
 */
const fs = require('fs');
const KEY = process.env.ODDS_API_KEY;
const BASE = 'https://api.the-odds-api.com/v4/sports/basketball_nba';
const MODE = process.argv[2] || 'run';
const MK = { player_points: 'pts', player_rebounds: 'reb', player_assists: 'ast', player_threes: 'tpm',
  player_steals: 'stl', player_blocks: 'blk', player_turnovers: 'to', player_points_rebounds_assists: 'pra' };
const MARKETS = (process.env.PROPS_MARKETS || 'player_points,player_rebounds,player_assists,player_threes,player_steals,player_blocks,player_turnovers').split(',').map(s => s.trim()).filter(Boolean);
const MIN_LEFT = 15;   // stop before the plan runs dry
const OUT = 'data/props.json';
// ESPN's team codes, so the page can tell which teams' games have props.
const TEAM = { 'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
  'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
  'Detroit Pistons': 'DET', 'Golden State Warriors': 'GS', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA',
  'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NO', 'New York Knicks': 'NY',
  'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SA', 'Toronto Raptors': 'TOR',
  'Utah Jazz': 'UTAH', 'Washington Wizards': 'WSH' };

const etDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(t ? new Date(t) : new Date());
const scrub = s => String(s).replace(/apiKey=[^&\s]+/g, 'apiKey=***');
let credits = {};
async function get(path, q = {}) {
  const u = `${BASE}${path}?` + new URLSearchParams({ apiKey: KEY, ...q });
  const r = await fetch(u);
  credits = { used: +r.headers.get('x-requests-used'), left: +r.headers.get('x-requests-remaining'), last: +r.headers.get('x-requests-last') };
  const body = await r.text();
  console.log(`GET ${path.slice(0, 48)} -> ${r.status} | credits used=${credits.used} left=${credits.left} last=${credits.last}`);
  if (!r.ok) throw new Error(`${r.status}: ${scrub(body).slice(0, 300)}`);
  return JSON.parse(body);
}

// ---- odds -> implied average
const PHI = { pts: 2.2, reb: 1.3, ast: 1.4, pra: 3.0 };   // variance = PHI x mean (normal stats)
const prob = a => a < 0 ? -a / (-a + 100) : 100 / (a + 100);   // American odds -> implied probability
const erf = x => { const t = 1 / (1 + .3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const ncdf = z => .5 * (1 + erf(z / Math.SQRT2));
function pOver(k, line, mu) {
  if (PHI[k]) return 1 - ncdf((line - mu) / Math.sqrt(PHI[k] * mu));
  let c = 0, term = Math.exp(-mu);                         // Poisson: P(X > line) = 1 - P(X <= floor(line))
  for (let i = 0; i <= Math.floor(line); i++) { c += term; term *= mu / (i + 1); }
  return 1 - c;
}
function solveMu(k, line, p) {
  let lo = 0.01, hi = Math.max(5, line * 3 + 10);
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (pOver(k, line, m) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const r2 = v => Math.round(v * 100) / 100;

// One game's odds -> { player: { pts: [mu, line, books], ... } }
function implied(j) {
  const acc = {};
  for (const b of j.bookmakers || []) for (const m of b.markets || []) {
    const k = MK[m.key]; if (!k) continue;
    const pairs = {};
    for (const o of m.outcomes) {
      const key = o.description + '|' + o.point, p = pairs[key] || (pairs[key] = { name: o.description, line: o.point });
      p[o.name === 'Over' ? 'o' : 'u'] = o.price;
    }
    for (const p of Object.values(pairs)) {
      if (p.o == null || p.u == null || p.line == null) continue;
      const po = prob(p.o), pu = prob(p.u), fair = po / (po + pu);
      const a = ((acc[p.name] || (acc[p.name] = {}))[k] || (acc[p.name][k] = { mu: [], line: [], books: new Set() }));
      a.mu.push(solveMu(k, p.line, fair)); a.line.push(p.line); a.books.add(b.key);
    }
  }
  const out = {};
  for (const [n, ks] of Object.entries(acc)) {
    out[n] = {};
    for (const [k, a] of Object.entries(ks)) out[n][k] = [r2(median(a.mu)), median(a.line), a.books.size];
  }
  return out;
}

(async () => {
  if (!KEY) { console.log('ODDS_API_KEY not set; skipping.'); return; }
  const today = etDate();
  const events = await get('/events', { dateFormat: 'iso' });
  const tonight = events.filter(e => etDate(e.commence_time) === today);
  console.log(`${tonight.length} games tonight (${today}), ${events.length} listed`);

  if (MODE === 'probe') {
    const ev = tonight[0] || events[0]; if (!ev) return;
    const j = await get(`/events/${ev.id}/odds`, { regions: 'us', markets: MARKETS.join(','), oddsFormat: 'american' });
    for (const b of j.bookmakers || []) console.log(`  ${b.key}: ${b.markets.map(m => `${m.key} (${new Set(m.outcomes.map(o => o.description)).size})`).join(', ')}`);
    const im = implied(j);
    for (const [n, ks] of Object.entries(im).slice(0, 8)) console.log(`  ${n}: ${Object.entries(ks).map(([k, v]) => `${k} ${v[0]} (line ${v[1]}, ${v[2]} books)`).join(' · ')}`);
    return;
  }

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const keep = prev && prev.date === today && MODE !== 'force' ? prev : null;
  const games = [], players = keep ? { ...keep.players } : {};
  for (const e of tonight) {
    const a = TEAM[e.away_team] || e.away_team, h = TEAM[e.home_team] || e.home_team;
    const had = keep && keep.games.find(g => g.id === e.id && g.n > 0);
    if (had) { games.push(had); continue; }
    if (credits.left != null && credits.left < MIN_LEFT) { console.log(`Only ${credits.left} credits left; stopping.`); games.push({ id: e.id, a, h, t: e.commence_time, n: 0 }); continue; }
    const j = await get(`/events/${e.id}/odds`, { regions: 'us', markets: MARKETS.join(','), oddsFormat: 'american' });
    const im = implied(j);
    for (const [n, ks] of Object.entries(im)) players[n] = { g: e.id, ...ks };
    games.push({ id: e.id, a, h, t: e.commence_time, n: Object.keys(im).length });
    console.log(`  ${a} @ ${h}: ${Object.keys(im).length} players`);
  }
  const doc = { date: today, built: new Date().toISOString(), credits, markets: MARKETS.map(m => MK[m] || m),
    note: "Implied averages from player props (median across US books, vig removed). players[name][stat] = [mu, median line, books].",
    games, players };
  fs.mkdirSync('data/props', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc));
  fs.writeFileSync(`data/props/${today}.json`, JSON.stringify(doc));
  console.log(`${OUT}: ${games.length} games, ${Object.keys(players).length} players; ${credits.left} credits left`);
})().catch(e => { console.error(scrub(e.message)); process.exit(1); });

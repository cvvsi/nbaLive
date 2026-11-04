/* Player props from The Odds API (https://the-odds-api.com), for the daily projections.
 * Needs the ODDS_API_KEY repo secret; never put the key in the repo (it's public).
 *
 * Usage:  node fetch-props.js probe     list tonight's games (free) and fetch ONE game's props,
 *                                       printing what the plan returns and what it cost
 *
 * Credits (free plan: 500 a month): listing events is free; one game's props cost
 * (markets returned) x (regions). Every run prints the x-requests-* headers.
 */
const KEY = process.env.ODDS_API_KEY;
const BASE = 'https://api.the-odds-api.com/v4/sports/basketball_nba';
const MODE = process.argv[2] || 'probe';
const MARKETS = (process.env.PROPS_MARKETS || 'player_points,player_points_rebounds_assists').split(',');

const scrub = s => String(s).replace(/apiKey=[^&\s]+/g, 'apiKey=***');
async function get(path, q = {}) {
  const u = `${BASE}${path}?` + new URLSearchParams({ apiKey: KEY, ...q });
  const r = await fetch(u);
  const used = ['x-requests-used', 'x-requests-remaining', 'x-requests-last'].map(h => `${h.slice(11)}=${r.headers.get(h)}`).join(' ');
  const body = await r.text();
  console.log(`GET ${path} -> ${r.status} | credits ${used}`);
  if (!r.ok) throw new Error(`${r.status}: ${scrub(body).slice(0, 300)}`);
  return JSON.parse(body);
}

(async () => {
  if (!KEY) { console.log('ODDS_API_KEY not set; skipping.'); return; }
  const events = await get('/events', { dateFormat: 'iso' });
  const soon = events.filter(e => new Date(e.commence_time) - Date.now() < 36 * 3600e3);
  console.log(`${events.length} upcoming NBA events, ${soon.length} in the next 36 h:`);
  for (const e of soon) console.log(`  ${e.commence_time}  ${e.away_team} @ ${e.home_team}  (${e.id})`);
  if (MODE !== 'probe') throw new Error('Only probe mode exists so far.');
  const ev = soon[0] || events[0];
  if (!ev) { console.log('No events to probe.'); return; }
  const j = await get(`/events/${ev.id}/odds`, { regions: 'us', markets: MARKETS.join(','), oddsFormat: 'american' });
  const books = j.bookmakers || [];
  console.log(`\nProbe ${ev.away_team} @ ${ev.home_team}: ${books.length} bookmakers`);
  for (const b of books) {
    const ms = b.markets.map(m => `${m.key} (${new Set(m.outcomes.map(o => o.description)).size} players)`);
    console.log(`  ${b.key}: ${ms.join(', ') || 'no markets'}`);
  }
  const b = books.find(b => b.markets.length);
  if (b) for (const m of b.markets) {
    console.log(`\n  sample ${b.key} ${m.key}:`);
    for (const o of m.outcomes.slice(0, 6)) console.log(`    ${o.description}  ${o.name} ${o.point} @ ${o.price}`);
  }
})().catch(e => { console.error(scrub(e.message)); process.exit(1); });

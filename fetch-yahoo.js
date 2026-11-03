/* Pull my Yahoo league into data/yahoo.json: who is rostered by whom, the best free agents,
 * yesterday's league transactions, and Yahoo-wide percent-owned movement (most added / dropped).
 *
 * Runs in the nightly Action after build-rankings.js. Needs repo secrets YAHOO_CLIENT_ID and
 *   YAHOO_CLIENT_SECRET, plus a refresh token: data/yahoo-token.enc from the Yahoo login workflow
 *   (or a YAHOO_REFRESH_TOKEN secret)
 *   YAHOO_LEAGUE_ID (optional; without it, the first NBA league on the account is used)
 * Without the secrets it logs a note and exits 0, so rankings still publish.
 *
 * Usage:  node fetch-yahoo.js
 * Writes: data/yahoo.json, data/yahoo-owned.json (percent-owned history, last 15 days)
 */
const fs = require('fs');

const store = require('./yahoo-token.js');
const { YAHOO_CLIENT_ID: ID, YAHOO_CLIENT_SECRET: SECRET, YAHOO_LEAGUE_ID: LEAGUE_ID } = process.env;
// The refresh token comes from the secret if set, else from the encrypted file the
// "Yahoo login" workflow writes (see yahoo-auth.js).
const FROM_FILE = !process.env.YAHOO_REFRESH_TOKEN;
let REFRESH = process.env.YAHOO_REFRESH_TOKEN || (SECRET ? store.load(SECRET) : null);
const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const OUT = 'data/yahoo.json', OWNED = 'data/yahoo-owned.json';
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

// ---- Yahoo's JSON: collections are {"0": {...}, "1": {...}, count: n}, and an entity's
// attributes come as an array of one-key objects (sometimes nested one level).
const list = (c, key) => {
  if (!c) return [];
  const n = c.count != null ? +c.count : Object.keys(c).filter(k => /^\d+$/.test(k)).length;
  const out = [];
  for (let i = 0; i < n; i++) if (c[i] && c[i][key] !== undefined) out.push(c[i][key]);
  return out;
};
const flat = a => {
  const o = {};
  const walk = x => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.assign(o, x);
  };
  walk(a);
  return o;
};
// An entity is [attrs, sub1, sub2...]; merge it all into one object.
const entity = e => (Array.isArray(e) ? e.reduce((o, part) => Object.assign(o, flat(part)), {}) : e || {});

function player(p) {
  const o = entity(p);
  const po = o.percent_owned ? flat(o.percent_owned) : null;
  return {
    key: o.player_key, id: o.player_id,
    name: o.name && (o.name.full || o.name.ascii_first + ' ' + o.name.ascii_last),
    team: o.editorial_team_abbr, pos: o.display_position || (o.eligible_positions && '') || '',
    status: o.status || '', injury: o.injury_note || '',
    pct: po && po.value != null ? +po.value : null,
    pctDelta: po && po.delta != null ? +String(po.delta).replace('+', '') : null,
  };
}

async function token() {
  const r = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH, redirect_uri: process.env.YAHOO_REDIRECT_URI || 'https://localhost:8080' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Yahoo token refresh failed: ' + (j.error_description || j.error || r.status));
  // Yahoo can hand back a new refresh token; keep the stored one current.
  if (FROM_FILE && j.refresh_token && j.refresh_token !== REFRESH) { REFRESH = j.refresh_token; store.save(REFRESH, SECRET); }
  return j.access_token;
}

let AT;
async function Y(path) {
  const r = await fetch(API + path + (path.includes('?') ? '&' : '?') + 'format=json',
    { headers: { Authorization: 'Bearer ' + AT } });
  if (!r.ok) throw new Error(r.status + ' ' + path + ' ' + (await r.text()).slice(0, 200));
  return (await r.json()).fantasy_content;
}

// Paged player lists (Yahoo caps a page at 25).
async function players(base, max) {
  const out = [];
  for (let start = 0; start < max; start += 25) {
    const fc = await Y(`${base};start=${start};count=25/percent_owned`);
    const coll = entity(fc.league || fc.game).players;
    const page = list(coll, 'player').map(player);
    out.push(...page);
    if (page.length < 25) break;
  }
  return out;
}

async function main() {
  if (!ID || !SECRET || !REFRESH) {
    console.log('Yahoo not connected (needs YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET secrets, then the Yahoo login workflow); skipping.');
    return;
  }
  AT = await token();

  // Find the league: the account's NBA leagues for the current season.
  const fcL = await Y('/users;use_login=1/games;game_keys=nba/leagues');
  const user = entity(list(fcL.users, 'user')[0]);
  const game = entity(list(user.games, 'game')[0]);
  const leagues = list(game.leagues, 'league').map(entity);
  if (!leagues.length) throw new Error('No NBA leagues on this Yahoo account for the current season');
  const lg = (LEAGUE_ID && leagues.find(l => String(l.league_id) === String(LEAGUE_ID))) || leagues[0];
  const LK = lg.league_key;
  console.log(`League ${lg.name} (${LK}), ${lg.num_teams} teams`);

  // Every roster, and which team is mine.
  const fcT = await Y(`/league/${LK}/teams/roster`);
  const teams = list(entity(fcT.league).teams, 'team').map(t => {
    const o = entity(t);
    const roster = o.roster ? list(o.roster[0] ? o.roster[0].players : o.roster.players, 'player').map(player) : [];
    return { key: o.team_key, name: o.name, mine: o.is_owned_by_current_login == 1,
      manager: o.managers ? (entity(list(o.managers, 'manager')[0]).nickname || '') : '',
      roster: roster.map(p => ({ name: p.name, team: p.team, pos: p.pos, status: p.status, injury: p.injury, key: p.key })) };
  });
  const rostered = new Set(teams.flatMap(t => t.roster.map(p => p.key)));

  // Best available: season rank and last-week rank (the second catches role changes).
  const faSeason = await players(`/league/${LK}/players;status=A;sort=AR;sort_type=season`, 150);
  const faWeek = await players(`/league/${LK}/players;status=A;sort=AR;sort_type=lastweek`, 100);
  const strip = (arr) => arr.map((p, i) => ({ rank: i + 1, name: p.name, team: p.team, pos: p.pos,
    status: p.status, injury: p.injury, pct: p.pct, key: p.key }));

  // Recent league moves (adds, drops, trades).
  let moves = [];
  try {
    const fcX = await Y(`/league/${LK}/transactions;types=add,drop,trade;count=40`);
    moves = list(entity(fcX.league).transactions, 'transaction').map(t => {
      const o = entity(t);
      return { type: o.type, time: new Date(+o.timestamp * 1000).toISOString(),
        players: list(o.players, 'player').map(p => {
          const e = entity(p), d = flat(e.transaction_data);
          return { name: e.name && e.name.full, team: e.editorial_team_abbr, action: d.type,
            to: d.destination_team_name || '', from: d.source_team_name || '' };
        }) };
    });
  } catch (e) { console.log('Transactions skipped: ' + e.message); }

  // Yahoo-wide ownership movement. Snapshot percent owned across rostered players, the top 300
  // overall and the free agents above, then diff against earlier snapshots we kept.
  const top = await players(`/game/${game.game_key}/players;sort=AR;sort_type=lastweek`, 300).catch(e => {
    console.log('Game-wide players skipped: ' + e.message); return [];
  });
  const rosterPct = [];
  const keys = [...rostered];
  for (let i = 0; i < keys.length; i += 25) {
    const fc = await Y(`/league/${LK}/players;player_keys=${keys.slice(i, i + 25).join(',')}/percent_owned`);
    rosterPct.push(...list(entity(fc.league).players, 'player').map(player));
  }
  const all = new Map();
  for (const p of [...top, ...rosterPct, ...faSeason, ...faWeek]) if (p.key && p.pct != null) all.set(p.key, p);

  const today = etToday();
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(OWNED, 'utf8')); } catch (e) {}
  hist[today] = Object.fromEntries([...all.values()].map(p => [p.key, p.pct]));
  const days = Object.keys(hist).sort();
  for (const d of days.slice(0, -15)) delete hist[d];
  const prev = days.filter(d => d < today);
  const d1 = prev.length ? hist[prev[prev.length - 1]] : null;
  const d7 = prev.length ? hist[prev.find(d => d >= shift(today, -7)) || prev[0]] : null;

  const moversAll = [...all.values()].map(p => ({
    name: p.name, team: p.team, pos: p.pos, status: p.status, injury: p.injury, pct: p.pct,
    d1: d1 && d1[p.key] != null ? +(p.pct - d1[p.key]).toFixed(1) : p.pctDelta,
    d7: d7 && d7[p.key] != null ? +(p.pct - d7[p.key]).toFixed(1) : null,
    available: !rostered.has(p.key),
  })).filter(p => p.d1 != null);
  const added = moversAll.filter(p => p.d1 > 0).sort((a, b) => b.d1 - a.d1).slice(0, 25);
  const dropped = moversAll.filter(p => p.d1 < 0).sort((a, b) => a.d1 - b.d1).slice(0, 25);

  fs.writeFileSync(OWNED, JSON.stringify(hist));
  fs.writeFileSync(OUT, JSON.stringify({
    asOf: today, built: new Date().toISOString(),
    league: { key: LK, name: lg.name, teams: +lg.num_teams, week: lg.current_week, scoring: lg.scoring_type },
    note: 'pct = Yahoo-wide percent owned. d1/d7 = change over 1 and 7 days, from our own snapshots (Yahoo\'s delta when no snapshot exists yet). available = not on any roster in this league.',
    myTeam: teams.find(t => t.mine) || null,
    teams: teams.map(t => ({ name: t.name, manager: t.manager, mine: t.mine, roster: t.roster.map(p => p.name) })),
    freeAgents: { season: strip(faSeason), lastWeek: strip(faWeek) },
    trending: { added, dropped },
    leagueMoves: moves,
  }, null, 1));
  console.log(`${OUT}: ${teams.length} teams, ${faSeason.length}+${faWeek.length} free agents, ${all.size} ownership rows, ${added.length} risers / ${dropped.length} fallers`);
}

function shift(d, n) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

module.exports = { list, flat, entity, player };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

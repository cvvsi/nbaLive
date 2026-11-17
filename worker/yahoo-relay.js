/* Sixth Man's private Yahoo relay: a Cloudflare Worker that reads your Yahoo league with your own
 * login and hands it to your browser. The site can't call Yahoo itself: the app secret can't live
 * in a public repo, and Yahoo's API doesn't answer cross-site requests from a browser.
 *
 * Stores nothing. Yahoo's agreement (personal use) forbids storing or sharing league data, so every
 * request reads Yahoo live and the answer goes only to the caller. The only things it keeps are
 * credentials, as Worker secrets: YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH (the refresh
 * token) and RELAY_KEY (your passphrase; every request must carry it in X-Relay-Key). The access
 * token is cached in memory for its hour. Optional: YAHOO_LEAGUE_ID (else your first NBA league).
 *
 * GET /sync  -> the same bundle league.html's bookmark builds ({v:1, lid, at, me, teams, p, act, mu,
 *               sched}, read by index.html), plus what the bookmark can't read: src:"api", exact
 *               FGM/FGA and FTM/FTA so far (mu.rows[].x), adds used this week (adds), league
 *               settings (cfg), each player's eligible positions and status (p[i][5], p[i][6]),
 *               and both matchup teams' lineups for every day of the week (lu: team -> date ->
 *               {yahoo player id: [slot, played]}; played is 1 / 0 for days already played, from
 *               Yahoo's own stats for that day, null for days to come), and the best 150
 *               available players with their eligible positions and status tags (fa).
 *
 * GET /minutes, POST /minutes {id, m, until, n, t} (m null = clear) -> your minutes overrides, the one
 *               thing the relay stores (Cloudflare KV, binding OV): your own numbers, not Yahoo's
 *               data. {espn id: {m, until, at, n, t}}; expired ones are dropped. /sync carries them
 *               too (ov), and the analyst applies them.
 * POST /mcp/<RELAY_KEY> (or /mcp with an "X-Relay-Key: <RELAY_KEY>" or "Authorization: Bearer" header) -> the fantasy analyst, an
 *               MCP server with read-only tools over the same data (worker/analyst.js).
 *
 * Deployed by .github/workflows/relay.yml (Actions -> Yahoo relay). */

import { mcp } from './analyst.js';

const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const SPOT_OFF = /^(BN|IL\+?|IR\+?|NA)$/i;
let tok = null, lkey = null; // access token {at, exp}; league key, both per isolate

class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function token(env) {
  if (tok && tok.exp > Date.now() + 60e3) return tok.at;
  const r = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.YAHOO_CLIENT_ID + ':' + env.YAHOO_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.YAHOO_REFRESH, redirect_uri: 'https://localhost:8080' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new HttpErr(502, 'Yahoo login failed: ' + (j.error_description || j.error || r.status) + '. Log in again (Actions -> Yahoo login), then redeploy the relay.');
  tok = { at: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.at;
}

async function yf(env, path, retry = true) {
  const r = await fetch(API + path + (path.includes('?') ? '&' : '?') + 'format=json',
    { headers: { Authorization: 'Bearer ' + await token(env) } });
  if (r.status === 401 && retry) { tok = null; return yf(env, path, false); }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const d = (t.match(/"description"\s*:\s*"([^"]*)"/) || [])[1];
    throw new HttpErr(502, `Yahoo answered ${r.status}${d ? ': ' + d : ''} (${path.split('?')[0]})`);
  }
  return (await r.json()).fantasy_content;
}

// Yahoo's JSON: collections are objects keyed "0", "1", ... plus "count"; a resource is an array
// whose first element is an array of one-key objects (its fields) and whose later elements each hold
// a sub-resource. items() lists a collection, flat() merges field arrays, pick() finds a sub-resource.
const items = o => Array.isArray(o) ? o : o ? Object.keys(o).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b).map(k => o[k]) : [];
function flat(a, out = {}) {
  if (Array.isArray(a)) for (const x of a) flat(x, out);
  else if (a && typeof a === 'object') Object.assign(out, a);
  return out;
}
function pick(a, key) {
  if (!Array.isArray(a)) return a && a[key];
  for (const x of a) {
    if (Array.isArray(x)) { const v = pick(x, key); if (v !== undefined) return v; }
    else if (x && typeof x === 'object' && x[key] !== undefined) return x[key];
  }
  return undefined;
}

async function leagueKey(env) {
  if (lkey) return lkey;
  const fc = await yf(env, '/users;use_login=1/games;game_keys=nba/leagues');
  const user = items(fc.users)[0].user, game = items(pick(user, 'games'))[0].game;
  const ls = items(pick(game, 'leagues')).map(x => flat(x.league));
  if (!ls.length) throw new HttpErr(404, 'No NBA league found on this Yahoo account this season.');
  const want = env.YAHOO_LEAGUE_ID && ls.find(l => String(l.league_id) === String(env.YAHOO_LEAGUE_ID));
  return lkey = (want || ls[0]).league_key;
}

const days = (a, b) => { const o = []; for (let d = new Date(a + 'T12:00:00Z'); d <= new Date(b + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) o.push(d.toISOString().slice(0, 10)); return o; };
const statList = t => items((pick(t, 'team_stats') || {}).stats).map(s => s.stat);
const teamIds = m => items((m['0'] || {}).teams).map(t => t.team);

async function buildSync(env) {
  const lk = await leagueKey(env);
  const [st, ro, sb] = await Promise.all([
    yf(env, `/league/${lk}/settings`),
    yf(env, `/league/${lk}/teams/roster`),
    yf(env, `/league/${lk}/scoreboard`),
  ]);

  // settings: active lineup spots, the categories in Yahoo's order, add limits
  const meta = flat(st.league[0]), s = flat(pick(st.league, 'settings'));
  const pos = {}; for (const x of s.roster_positions || []) { const r = x.roster_position || x; pos[r.position] = +r.count || 0; }
  const spots = Object.entries(pos).filter(([p]) => !SPOT_OFF.test(p)).reduce((a, [, n]) => a + n, 0) || null;
  const cats = items((s.stat_categories || {}).stats).map(x => x.stat).filter(Boolean);
  const scored = cats.filter(c => +c.enabled !== 0 && +c.is_only_display_stat !== 1);
  const cfg = { name: meta.name, season: meta.season, teams: +meta.num_teams || null, week: +meta.current_week || null,
    endWeek: +meta.end_week || null, maxAdds: +s.max_weekly_adds || null, maxSeasonAdds: +s.max_adds || null,
    pos, cats: scored.map(c => c.display_name), playoffStart: +s.playoff_start_week || null };

  // teams and rosters (today's lineup slots)
  const teams = {}, act = {}, adds = {}, p = [];
  let me = null;
  for (const t of items(pick(ro.league, 'teams'))) {
    const tm = flat(t.team[0]), id = String(tm.team_id);
    teams[id] = tm.name; act[id] = spots;
    if (+tm.is_owned_by_current_login === 1) me = id;
    if (tm.roster_adds && tm.roster_adds.value != null) adds[id] = +tm.roster_adds.value;
    const roster = pick(t.team, 'roster') || {};
    for (const x of items((roster['0'] || {}).players)) {
      const pm = flat(x.player[0]), sp = flat(pick(x.player, 'selected_position'));
      const el = (pm.eligible_positions || []).map(e => e.position).filter(Boolean);
      p.push([String(pm.player_id), (pm.name && pm.name.full) || '', String(pm.editorial_team_abbr || '').toUpperCase(),
        id, sp.position || '', el.join(','), pm.status || '']);
    }
  }
  if (!p.length) throw new HttpErr(502, 'Yahoo returned no rosters.');

  // this week's matchup: Yahoo's totals so far per category, plus the made/attempted counts behind FG% / FT%
  const sbo = pick(sb.league, 'scoreboard') || {};
  let mu = null;
  for (const mx of items((sbo['0'] || {}).matchups)) {
    const m = mx.matchup, ts = teamIds(m);
    if (!ts.some(t => String(flat(t[0]).team_id) === me)) continue;
    const rows = ts.map(t => {
      const byId = {}; for (const x of statList(t)) byId[x.stat_id] = x.value;
      const ma = id => { const v = String(byId[id] || ''); const k = v.match(/^(\d+)\/(\d+)$/); return k ? [+k[1], +k[2]] : null; };
      const fg = ma(9004003), ft = ma(9007006);
      return { id: String(flat(t[0]).team_id), v: scored.map(c => byId[c.stat_id] == null ? '' : String(byId[c.stat_id])),
        x: fg || ft ? { fgm: fg && fg[0], fga: fg && fg[1], ftm: ft && ft[0], fta: ft && ft[1] } : null };
    });
    mu = { week: +m.week || cfg.week, dates: m.week_start && m.week_end ? days(m.week_start, m.week_end) : [],
      lab: scored.map(c => c.display_name), rows };
  }

  // your opponent every week of the season
  const sched = {};
  if (me) {
    const tk = `${lk}.t.${me}`, ms = await yf(env, `/team/${tk}/matchups`);
    for (const mx of items(pick(ms.team, 'matchups'))) {
      const m = mx.matchup, o = teamIds(m).map(t => String(flat(t[0]).team_id)).find(x => x !== me);
      if (m.week && o) sched[m.week] = o;
    }
  }

  // Both matchup teams' lineups, every day of the week: the slot each player is in that day as set
  // on Yahoo (days to come carry today's lineup unless you've changed them), and for days already
  // played whether he played (any stat recorded; Yahoo shows "-" when he didn't).
  const lu = {};
  if (mu && mu.dates.length) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const jobs = [];
    for (const r of mu.rows) for (const d of mu.dates) jobs.push(dayLineup(env, `${lk}.t.${r.id}`, d, d <= today).then(v => {
      (lu[r.id] || (lu[r.id] = {}))[d] = v;
    }));
    await Promise.all(jobs);
  }

  // The best 150 available players (free agents and waivers) by Yahoo's season rank, with their
  // eligible positions and status tags, for pickups in the IL+ optimizer: [id, name, team, positions, tag].
  const fa = [];
  const pages = await Promise.all([0, 25, 50, 75, 100, 125].map(st =>
    yf(env, `/league/${lk}/players;status=A;sort=AR;start=${st};count=25`).catch(() => null)));
  for (const fc of pages) {
    if (!fc) continue;
    for (const x of items(pick(fc.league, 'players'))) {
      const pm = flat(x.player[0]);
      fa.push([String(pm.player_id), (pm.name && pm.name.full) || '', String(pm.editorial_team_abbr || '').toUpperCase(),
        (pm.eligible_positions || []).map(e => e.position).filter(Boolean).join(','), pm.status || '']);
    }
  }

  return { v: 1, src: 'api', lid: String(meta.league_id), at: new Date().toISOString(), me, teams, p, act, mu, sched, adds, cfg, lu, fa, ov: await ovGet(env) };
}

// One team's lineup on one day: {player id: [slot, played]}. With stats (days already played) it
// asks for the roster with each player's stats for that day; if Yahoo refuses that combination it
// falls back to the roster alone (played unknown, null).
async function dayLineup(env, tk, d, withStats) {
  let fc = null, stats = false;
  if (withStats) {
    try { fc = await yf(env, `/team/${tk}/roster;date=${d}/players/stats;type=date;date=${d}`); stats = true; } catch (e) { fc = null; }
  }
  if (!fc) fc = await yf(env, `/team/${tk}/roster;date=${d}`);
  const roster = pick(fc.team, 'roster') || {}, out = {};
  for (const x of items((roster['0'] || {}).players)) {
    const pm = flat(x.player[0]), sp = flat(pick(x.player, 'selected_position'));
    let played = null;
    if (stats) {
      const ps = pick(x.player, 'player_stats');
      // Yahoo's games-played stat (id 0) when it's there; otherwise any non-zero stat that day
      const st = ps ? items(ps.stats).map(s => s.stat || {}) : [];
      const gp = st.find(s => String(s.stat_id) === '0');
      played = gp ? (+gp.value > 0 ? 1 : 0) : st.length ? (st.some(s => /[1-9]/.test(String(s.value))) ? 1 : 0) : null;
    }
    out[String(pm.player_id)] = [sp.position || '', played];
  }
  return out;
}

// Minutes overrides (KV key "ov"): {espn id: {m, until, at, n, t}}, expired entries dropped on read.
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
async function ovGet(env) {
  if (!env.OV) return {};
  const o = (await env.OV.get('ov', 'json')) || {}, t = etToday();
  for (const id of Object.keys(o)) if (o[id].until && o[id].until < t) delete o[id];
  return o;
}
async function ovSet(env, b) {
  if (!env.OV) throw new HttpErr(500, 'No storage for overrides (the OV KV binding): re-run Actions -> Yahoo relay.');
  const id = String(b && b.id || '').replace(/[^0-9]/g, '');
  if (!id) throw new HttpErr(400, 'Missing player id.');
  const o = await ovGet(env);
  if (b.m == null || b.m === '') delete o[id];
  else {
    const m = Math.round(+b.m * 10) / 10;
    if (!(m >= 0 && m <= 48)) throw new HttpErr(400, 'Minutes must be 0-48.');
    const until = /^\d{4}-\d{2}-\d{2}$/.test(b.until || '') ? b.until : null;
    o[id] = { m, until, at: new Date().toISOString(), n: String(b.n || '').slice(0, 60), t: String(b.t || '').slice(0, 5) };
  }
  if (Object.keys(o).length > 300) throw new HttpErr(400, 'Too many overrides.');
  await env.OV.put('ov', JSON.stringify(o));
  return o;
}

// Constant-time compare, so the key can't be guessed a character at a time.
function keyOk(a, b) {
  if (!a || !b || b.length < 16) return false;
  let d = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) d |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allow = String(env.ALLOW_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
    const cors = allow.includes(origin) ? { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'X-Relay-Key, Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : {};
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname === '/') return json({ ok: true, relay: 'sixthman-yahoo' });
    // The analyst (MCP): the key in the path, for a claude.ai custom connector (a URL only), or as a Bearer token.
    const mp = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (mp) {
      const k = mp[1] ? decodeURIComponent(mp[1]) : req.headers.get('X-Relay-Key') || (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!keyOk(k, env.RELAY_KEY || '')) return json({ error: 'Wrong or missing relay key.' }, 401);
      try { return await mcp(req, env, { buildSync, leagueKey, yf, items, flat, pick, ovGet }); }
      catch (e) { return json({ error: e.message || String(e) }, 500); }
    }
    if (!keyOk(req.headers.get('X-Relay-Key') || '', env.RELAY_KEY || '')) return json({ error: 'Wrong or missing relay key.' }, 401);
    try {
      if (url.pathname === '/sync' && req.method === 'GET') return json(await buildSync(env));
      if (url.pathname === '/minutes' && req.method === 'GET') return json(await ovGet(env));
      if (url.pathname === '/minutes' && req.method === 'POST') return json(await ovSet(env, await req.json().catch(() => null)));
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },
};

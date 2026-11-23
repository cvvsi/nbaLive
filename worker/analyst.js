/* Fantasy analyst: an MCP server on the relay (POST /mcp/<RELAY_KEY>), so Claude (claude.ai custom
 * connector, the Claude app, Claude Code) can answer questions about your team with your league
 * read live from Yahoo and Sixth Man's model. Read-only tools; nothing is stored (Yahoo's agreement).
 *
 * Data: the league through buildSync() (the same bundle the site syncs, cached 90 s in memory so a
 * run of tool calls costs one read), Yahoo standings and transactions on demand, and the site's
 * public files: data/analyst.json (each player's Proj line and ranks, compact for the free plan's
 * 10 ms CPU), schedule.json, injuries.json and news.json (cached 10 minutes).
 *
 * Transport: MCP Streamable HTTP, stateless; every POST is one JSON-RPC message (or a batch) and
 * gets one JSON answer. No SSE. */

const SITE = 'https://sixthmanhoops.app/data/';
const CATS = [['FG%', 'fg'], ['FT%', 'ft'], ['3PTM', 'tpm'], ['PTS', 'pts'], ['REB', 'reb'], ['AST', 'ast'], ['ST', 'stl'], ['BLK', 'blk'], ['TO', 'to']];
const MUPHI = { pts: 3.8, reb: 1.65, ast: 1.6, tpm: 1.35, stl: 1.2, blk: 1.15, to: 1.1 }, MUPCT = { fg: 1, ft: 1.1 };
const YT = { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', PHO: 'PHX', UTA: 'UTAH', WAS: 'WSH', BRK: 'BKN', CHO: 'CHA' };
const ACT = sl => !!sl && !/^(BN|IL|IR|NA)/i.test(sl);

let site = null, sync = null; // {at, A, SC, IJ, N, ix} / {at, d}

const etDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const etHour = () => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date());
const dPlus = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monday = d => dPlus(d, -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7));
const week = (off = 0) => { const m = dPlus(monday(etDay()), 7 * off); return [0, 1, 2, 3, 4, 5, 6].map(i => dPlus(m, i)); };
const key = n => String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const r1 = v => v == null ? null : Math.round(v * 10) / 10, r3 = v => v == null ? null : Math.round(v * 1000) / 1000;
const phi = x => { const t = 1 / (1 + .2316419 * Math.abs(x)), d = .3989423 * Math.exp(-x * x / 2), p = d * t * (.3193815 + t * (-.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };

async function getSite() {
  if (site && Date.now() - site.at < 600e3) return site;
  const get = f => fetch(SITE + f, { cf: { cacheTtl: 300 } }).then(r => r.ok ? r.json() : null).catch(() => null);
  const [A, SC, IJ, N] = await Promise.all([get('analyst.json'), get('schedule.json'), get('injuries.json'), get('news.json')]);
  if (!A) throw new Error('Could not read the site\'s data/analyst.json.');
  const full = {}, tlf = {};
  for (const [id, q] of Object.entries(A.p)) {
    const k = key(q.n), w = k.split(' ');
    (full[k] || (full[k] = [])).push(id); (tlf[`${q.t}|${w[w.length - 1]}|${w[0][0]}`] || (tlf[`${q.t}|${w[w.length - 1]}|${w[0][0]}`] = [])).push(id);
  }
  return site = { at: Date.now(), A, SC, IJ, N, full, tlf };
}
async function getSync(deps, env) {
  if (sync && Date.now() - sync.at < 90e3) return sync.d;
  const d = await deps.buildSync(env);
  sync = { at: Date.now(), d };
  return d;
}

// Yahoo player -> ESPN id (our data): full name, then team + last name + first initial.
function espnId(S, name, yt) {
  const t = YT[yt] || yt, k = key(name), w = k.split(' ');
  let c = S.full[k] || [];
  if (c.length !== 1) c = c.filter(id => S.A.p[id].t === t);
  if (!c.length) c = S.tlf[`${t}|${w[w.length - 1]}|${w[0][0]}`] || [];
  return c[0] || null;
}
const plays = (S, t, d) => !!(S.SC && (S.SC.dates[d] || []).some(([a, h]) => a === t || h === t));
const inj = (S, id) => S.IJ && S.IJ.players && S.IJ.players[id];
function out(S, id, d) { const i = inj(S, id); if (!i) return false; if (i[6] && i[6].includes(d)) return true; return /out|suspen/i.test(i[0]) && !(i[1] && d >= i[1]); }
const games = (S, id, t, ds) => ds.filter(d => plays(S, t, d) && !out(S, id, d));
function injTxt(S, id) {
  const i = inj(S, id); if (!i) return null;
  return [i[0], i[1] ? 'back ~' + i[1] : null, i[2] ? String(i[2]).slice(0, 160) : null].filter(Boolean).join(' · ');
}
// His Proj line as an object; with a minutes override of yours (L.ov, set on the site), at your
// minutes: per-minute rates stay the model's, counts scale.
function xpObj(S, L, id) {
  const q = S.A.p[id]; if (!q || !q.xp) return null;
  const o = {}; S.A.xpf.forEach((f, i) => o[f] = q.xp[i]);
  const ov = L && L.ov && L.ov[id];
  if (ov && o.min > 0) { const f = ov.m / o.min; for (const k in o) o[k] = k === 'min' ? ov.m : o[k] * f; }
  return o;
}
function projLine(S, id, L) {
  const o = xpObj(S, L, id); if (!o) return null;
  return { min: o.min, pts: o.pts, reb: o.reb, ast: o.ast, stl: o.stl, blk: o.blk, '3pm': o.tpm, to: o.to,
    'fg%': o.fga ? r3(o.fgm / o.fga) : null, fga: o.fga, 'ft%': o.fta ? r3(o.ftm / o.fta) : null, fta: o.fta };
}
// One player's card for any tool: who, Yahoo slot / positions / tag, our ranks and line, games ahead.
function card(S, L, row, opts = {}) {
  const [yp, name, yt, team, slot, el, tag] = row, id = espnId(S, name, yt), q = id && S.A.p[id];
  const tw = week(0).filter(d => d >= etDay()), nw = week(1);
  const o = { name, nba: yt, owner: team ? (team === L.me ? 'you' : L.teams[team] || team) : 'free agent', slot: slot || undefined,
    positions: el || undefined, yahoo_tag: tag || undefined };
  if (!team) Object.assign(o, wire(L, yp));
  if (!q) return { ...o, note: 'not in Sixth Man\'s player data (no recent minutes)' };
  Object.assign(o, { proj_rank: q.pr, season_rank: q.sr, rank_14d: q.r14, rank_7d: q.r7, gp: q.gp, mpg: q.mpg,
    mpg_last3: q.m3 != null ? q.m3 : undefined, min_change_last3: q.dm3 != null ? q.dm3 : undefined, injury: injTxt(S, id) || undefined,
    games_left_this_week: games(S, id, q.t, tw).map(d => d.slice(5)), games_next_week: games(S, id, q.t, nw).length });
  const ov = L.ov && L.ov[id];
  if (ov) o.minutes_override = { yours: ov.m, model: q.xp ? q.xp[0] : null, until: ov.until || 'until cleared', note: 'set by you on Sixth Man; the Proj line below uses it, proj_rank is still the model\'s' };
  if (opts.line !== false) o.proj_per_game = projLine(S, id, L);
  return o;
}

// Free agent or waivers, from the relay's wire read (fa rows: [..., 'W' | 'FA' | '', waiver date]).
// A waiver player can only be claimed until his date; claims run in waiver order that morning.
function wire(L, yp) {
  const f = yp != null && (L.fa || []).find(x => x[0] === String(yp)), today = etDay();
  if (f && f[5] === 'W' && !(f[6] && f[6] < today)) {
    const me = L.wt && L.wt[L.me];
    return { owner: 'on waivers', waivers: { clears: f[6] || 'unknown', how_to_get_him: 'put in a waiver claim before he clears (claims run in waiver order that morning' +
      (me && me[0] != null ? `; you are #${me[0]}` : '') + '), or wait and add him as a free agent after he clears, but any team that claimed him, even behind you in the order, gets him first' } };
  }
  return f && f[5] === 'FA' || (L.wvOk && (!f || f[5] !== 'W')) ? { owner: 'free agent (add any time, first come)' } : {};
}

// ---- tools
const TOOLS = [
  { name: 'get_my_team', description: 'Your roster: each player\'s Yahoo slot today, eligible positions and injury tag, Sixth Man\'s ranks (Proj = rest-of-season per-game 9-cat rank among all NBA players; season, 14-day, 7-day), minutes trend, injury report, Proj per-game line, and games left this week / next week. Also adds used this week and roster limits.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_matchup', description: 'This week\'s head-to-head: both teams\' category totals so far (with FG/FT made-attempted), games played so far, each team\'s Yahoo lineup with games for every day left, and a projection of the finals with a win chance per category and for the week (Proj per-game lines over the games left, as the lineups are set on Yahoo).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_free_agents', description: 'Available players (Yahoo\'s best 150 by its season rank, plus everyone on waivers), each marked free agent (add any time) or on waivers (claim only, until the date he clears), with Sixth Man ranks, Proj line, injury, eligible positions and games left this week / next week. Filter by position; sort by proj (rest of season), week (games left this week, then proj), last14 or season.',
    inputSchema: { type: 'object', properties: { position: { type: 'string', description: 'PG, SG, G, SF, PF, F or C' }, sort: { type: 'string', enum: ['proj', 'week', 'last14', 'season'] }, limit: { type: 'number', description: 'default 25, max 60' }, include_injured: { type: 'boolean', description: 'include players out on the injury report (default false)' }, availability: { type: 'string', enum: ['all', 'free_agents', 'waivers'], description: 'default all' } } } },
  { name: 'get_player', description: 'Everything on one player by name: who rosters him in your league, Yahoo positions and tag, Sixth Man ranks and Proj line, minutes trend, injury report, games this week and next, and his news from the last 3 days.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_team', description: 'Any team in your league by name (or part of it) or id: its roster with the same player details as get_my_team (lines left out to keep it short).',
    inputSchema: { type: 'object', properties: { team: { type: 'string' } }, required: ['team'] } },
  { name: 'get_standings', description: 'League standings from Yahoo: rank, record, team names.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_transactions', description: 'Recent league transactions from Yahoo (adds, drops, trades), newest first.',
    inputSchema: { type: 'object', properties: { count: { type: 'number', description: 'default 20, max 40' } } } },
  { name: 'get_schedule', description: 'NBA schedule for a week (Mon-Sun): games per NBA team and per day, light and heavy nights, and which of your players play each day.',
    inputSchema: { type: 'object', properties: { week_offset: { type: 'number', description: '0 = this week (default), 1 = next week, 2 = the week after' } } } },
  { name: 'get_news', description: 'Recent player news (RotoWire, Rotoworld, Basketball Monster alerts) with the status each item set.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['mine', 'matchup', 'all'], description: 'default mine' }, hours: { type: 'number', description: 'default 48' }, limit: { type: 'number', description: 'default 30' } } } },
  { name: 'get_il_plus', description: 'For the IL+ trick: your roster (Yahoo slots, injury tags, who can be parked in IL right now), roster limits, and every player\'s game days for the next N days, so you can find tagged players whose games don\'t overlap and rotate them through IL.',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'default 14, max 21' } } } },
].map(t => ({ ...t, annotations: { readOnlyHint: true } }));

async function call(name, a, deps, env) {
  const S = await getSite(), L = await getSync(deps, env), today = etDay();
  const mine = L.p.filter(r => r[3] === L.me);
  const limits = () => { const pos = (L.cfg && L.cfg.pos) || {}; return { active: Object.entries(pos).filter(([k]) => ACT(k)).reduce((s, [, n]) => s + n, 0), bench: pos.BN || 0, il_in_settings: Object.entries(pos).filter(([k]) => /^(IL|IR)/i.test(k)).reduce((s, [, n]) => s + n, 0), il_this_league: 3, roster_max: 16 }; };

  if (name === 'get_my_team') {
    const wp = L.wt && L.wt[L.me];
    return { team: L.teams[L.me], week: L.mu && L.mu.week, adds_used_this_week: L.adds && L.adds[L.me], max_weekly_adds: L.cfg && L.cfg.maxAdds,
      waiver_priority: wp && wp[0] != null ? `#${wp[0]} of ${Object.values(L.wt).filter(v => v[0] != null).length}` : undefined, waiver_settings: L.cfg && L.cfg.wv,
      roster_size: mine.length, limits: limits(), roster: mine.map(r => card(S, L, r)).sort((x, y) => (x.proj_rank || 999) - (y.proj_rank || 999)) };
  }
  if (name === 'get_team') {
    const q = String(a.team || '').toLowerCase(), tid = Object.keys(L.teams).find(t => t === q || L.teams[t].toLowerCase() === q) || Object.keys(L.teams).find(t => L.teams[t].toLowerCase().includes(q));
    if (!tid) return { error: 'No team matches. Teams: ' + Object.values(L.teams).join(', ') };
    return { team: L.teams[tid], roster: L.p.filter(r => r[3] === tid).map(r => card(S, L, r, { line: false })).sort((x, y) => (x.proj_rank || 999) - (y.proj_rank || 999)) };
  }
  if (name === 'get_player') {
    const k = key(a.name || ''); if (!k) return { error: 'Give a name.' };
    const lg = [...L.p, ...(L.fa || []).map(f => [f[0], f[1], f[2], null, '', f[3], f[4]])];
    let row = lg.find(r => key(r[1]) === k) || lg.find(r => key(r[1]).includes(k));
    if (!row) { const id = Object.keys(S.A.p).find(i => key(S.A.p[i].n) === k) || Object.keys(S.A.p).find(i => key(S.A.p[i].n).includes(k));
      if (!id) return { error: 'No player matches "' + a.name + '".' };
      row = [null, S.A.p[id].n, S.A.p[id].t, null, '', '', '']; }
    const o = card(S, L, row), id = espnId(S, row[1], row[2]);
    if (row[3] == null && !(L.fa || []).some(f => f[1] === row[1])) o.owner = L.wvOk ? 'free agent (add any time, first come)' : 'free agent or outside Yahoo\'s best 150 available';
    o.news = id ? ((S.N && S.N.items) || []).filter(n => n.id === id).slice(0, 6).map(n => ({ when: n.t, headline: n.h, detail: n.d, source: { rw: 'RotoWire', rtw: 'Rotoworld', bbm: 'Basketball Monster' }[n.src] || n.src })) : [];
    return o;
  }
  if (name === 'get_free_agents') {
    const pos = a.position ? String(a.position).toUpperCase() : null, lim = Math.min(60, a.limit || 25);
    let rows = (L.fa || []).filter(f => !pos || String(f[3]).split(',').includes(pos)).map(f => card(S, L, [f[0], f[1], f[2], null, '', f[3], f[4]]));
    if (a.availability === 'waivers') rows = rows.filter(o => o.waivers);
    else if (a.availability === 'free_agents') rows = rows.filter(o => !o.waivers);
    if (!a.include_injured) rows = rows.filter(o => !(o.injury && /^out/i.test(o.injury)));
    const by = { proj: o => o.proj_rank || 999, last14: o => o.rank_14d || 999, season: o => o.season_rank || 999 }[a.sort] ;
    rows.sort(a.sort === 'week' ? (x, y) => (y.games_left_this_week || []).length - (x.games_left_this_week || []).length || (x.proj_rank || 999) - (y.proj_rank || 999) : (x, y) => (by || (o => o.proj_rank || 999))(x) - (by || (o => o.proj_rank || 999))(y));
    return { count: rows.length, players: rows.slice(0, lim) };
  }
  if (name === 'get_matchup') return matchup(S, L, today);
  if (name === 'get_standings') {
    const lk = await deps.leagueKey(env), fc = await deps.yf(env, `/league/${lk}/standings`);
    const ts = deps.items(deps.pick(deps.pick(fc.league, 'standings'), 'teams') || (deps.pick(fc.league, 'standings') || [])[0]?.teams);
    return { standings: ts.map(t => { const m = deps.flat(t.team[0]), st = deps.pick(t.team, 'team_standings') || {}, o = st.outcome_totals || {};
      return { rank: +st.rank || null, team: m.name, you: String(m.team_id) === L.me || undefined, wins: +o.wins, losses: +o.losses, ties: +o.ties, pct: o.percentage, games_back: st.games_back }; }).sort((x, y) => (x.rank || 99) - (y.rank || 99)) };
  }
  if (name === 'get_transactions') {
    const lk = await deps.leagueKey(env), n = Math.min(40, a.count || 20), fc = await deps.yf(env, `/league/${lk}/transactions;count=${n}`);
    const tx = deps.items(deps.pick(fc.league, 'transactions'));
    return { transactions: tx.map(x => { const m = deps.flat(x.transaction[0]), ps = deps.items((x.transaction[1] || {}).players);
      return { when: m.timestamp ? new Date(+m.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null, type: m.type,
        moves: ps.map(p => { const pm = deps.flat(p.player[0]), td = deps.flat(deps.pick(p.player, 'transaction_data'));
          return { player: pm.name && pm.name.full, nba: pm.editorial_team_abbr, move: td.type, to: td.destination_team_name, from: td.source_team_name }; }) }; }) };
  }
  if (name === 'get_schedule') {
    const ds = week(Math.max(0, Math.min(2, a.week_offset || 0))), per = {}, night = {};
    for (const d of ds) { const g = (S.SC && S.SC.dates[d]) || []; night[d] = g.length; for (const [x, y] of g) { per[x] = (per[x] || 0) + 1; per[y] = (per[y] || 0) + 1; } }
    const myDays = {}; for (const d of ds) myDays[d] = mine.map(r => ({ r, id: espnId(S, r[1], r[2]) })).filter(o => o.id && plays(S, S.A.p[o.id].t, d) && !out(S, o.id, d)).map(o => o.r[1]);
    return { dates: ds, games_per_night: night, games_per_team: Object.fromEntries(Object.entries(per).sort((x, y) => y[1] - x[1])), your_players_by_day: myDays };
  }
  if (name === 'get_news') {
    const hrs = a.hours || 48, lim = Math.min(80, a.limit || 30), since = Date.now() - hrs * 36e5, scope = a.scope || 'mine';
    const opp = L.mu && (L.mu.rows.find(r => r.id !== L.me) || {}).id;
    const want = new Set(L.p.filter(r => scope === 'all' || r[3] === L.me || (scope === 'matchup' && r[3] === opp)).map(r => espnId(S, r[1], r[2])).filter(Boolean));
    const items = ((S.N && S.N.items) || []).filter(n => new Date(n.t) >= since && (scope === 'all' || want.has(n.id)) && !n.x);
    return { items: items.slice(0, lim).map(n => ({ when: n.t, player: n.n, headline: n.h, detail: n.d, status_set: n.p && n.p.s ? [n.p.s, n.p.dt, n.p.ret && 'return ' + n.p.ret].filter(Boolean).join(' ') : undefined })) };
  }
  if (name === 'get_il_plus') {
    const n = Math.min(21, a.days || 14), start = etHour() < 19 ? today : dPlus(today, 1), ds = Array.from({ length: n }, (_, i) => dPlus(start, i));
    return { rule: 'A player can be moved into an IL slot while he has a Yahoo injury tag (Q, P, D, O, INJ, GTD), checked when you make the move; lineups can be preset days or weeks ahead and the swaps hold, even after he is healthy, as long as you make no adds or drops. Once a parked player loses his tag, Yahoo blocks adds and drops until he leaves IL. Each day, the 3 IL slots should hold tagged players who do NOT play that day.',
      limits: limits(), roster_size: mine.length, dates: ds,
      players: mine.map(r => { const id = espnId(S, r[1], r[2]), q = id && S.A.p[id];
        return { name: r[1], slot_today: r[4], positions: r[5], yahoo_tag: r[6] || undefined, can_park_now: !!r[6] && !/^(NA|SUSP)/i.test(r[6]), proj_rank: q ? q.pr : null, injury: id ? injTxt(S, id) || undefined : undefined,
          game_days: q ? ds.filter(d => plays(S, q.t, d)).map(d => d.slice(5) + (out(S, id, d) ? ' (out)' : '')) : [] }; }) };
  }
  return { error: 'Unknown tool ' + name };
}

// This week's matchup: Yahoo's totals so far plus Proj per-game lines over the days left, each team's
// players counted on the days they sit in an active slot on Yahoo, have a game and aren't ruled out.
function matchup(S, L, today) {
  const mu = L.mu; if (!mu || !mu.rows || mu.rows.length !== 2) return { error: 'No matchup this week.' };
  const me = L.me, A = mu.rows.find(r => r.id === me) || mu.rows[0], B = mu.rows.find(r => r !== A);
  const rest = mu.dates.filter(d => d > today || (d === today && etHour() < 19)), past = mu.dates.filter(d => !rest.includes(d));
  const side = row => {
    const cur = {}; mu.lab.forEach((l, i) => { const c = CATS.find(([y]) => String(l).toUpperCase().replace(/[^A-Z0-9%]/g, '').endsWith(y)); if (c) cur[c[1]] = parseFloat(String(row.v[i]).replace(/^\./, '0.')) || 0; });
    const x = row.x || {}, lu = (L.lu || {})[row.id] || {}, roster = L.p.filter(r => r[3] === row.id);
    const yid = Object.fromEntries(roster.map(r => [r[0], r]));
    let playedSoFar = 0, known = true; for (const d of past) { const D = lu[d]; if (!D) { known = false; continue; } for (const v of Object.values(D)) if (ACT(v[0])) { if (v[1] == null) known = false; else playedSoFar += v[1]; } }
    const add = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, to: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 }, days = {};
    for (const d of rest) {
      const D = lu[d] || Object.fromEntries(roster.map(r => [r[0], [r[4]]])), on = [];
      for (const [yp, v] of Object.entries(D)) { if (!ACT(v[0])) continue; const r = yid[yp]; if (!r) continue; const id = espnId(S, r[1], r[2]), q = id && S.A.p[id];
        if (!q || !q.xp || !plays(S, q.t, d) || out(S, id, d)) continue; on.push(r[1]);
        const o = xpObj(S, L, id); for (const k in add) add[k] += o[k] || 0; }
      days[d] = on;
    }
    return { team: L.teams[row.id], so_far: cur, made_attempted_so_far: { fg: [x.fgm, x.fga], ft: [x.ftm, x.fta] }, games_played_so_far: known ? playedSoFar : undefined,
      games_left_counting: Object.values(days).reduce((s, v) => s + v.length, 0), lineup_by_day_left: days, add };
  };
  const a = side(A), b = side(B), cats = [];
  for (const [lab, k] of CATS) {
    let fa, fb, p;
    if (k === 'fg' || k === 'ft') {
      const am = (a.made_attempted_so_far[k][0] || 0) + a.add[k + 'm'], aa = (a.made_attempted_so_far[k][1] || 0) + a.add[k + 'a'];
      const bm = (b.made_attempted_so_far[k][0] || 0) + b.add[k + 'm'], ba = (b.made_attempted_so_far[k][1] || 0) + b.add[k + 'a'];
      fa = aa ? am / aa : a.so_far[k]; fb = ba ? bm / ba : b.so_far[k];
      const va = aa ? fa * (1 - fa) * a.add[k + 'a'] / aa ** 2 : 0, vb = ba ? fb * (1 - fb) * b.add[k + 'a'] / ba ** 2 : 0, sd = Math.sqrt(MUPCT[k] * (va + vb));
      p = sd > 0 ? phi((fa - fb) / sd) : fa > fb ? 1 : fa < fb ? 0 : .5; fa = r3(fa); fb = r3(fb);
    } else {
      fa = (a.so_far[k] || 0) + a.add[k]; fb = (b.so_far[k] || 0) + b.add[k];
      const sd = Math.sqrt(MUPHI[k] * (a.add[k] + b.add[k])), d = (fa - fb) * (k === 'to' ? -1 : 1);
      p = sd > 0 ? phi(d / sd) : d > 0 ? 1 : d < 0 ? 0 : .5; fa = r1(fa); fb = r1(fb);
    }
    cats.push({ cat: lab, you_now: a.so_far[k], them_now: b.so_far[k], you_final: fa, them_final: fb, your_win_chance: Math.round(p * 100) + '%', _p: p });
  }
  let dist = [1]; for (const c of cats) { const n = Array(dist.length + 1).fill(0); dist.forEach((x, i) => { n[i] += x * (1 - c._p); n[i + 1] += x * c._p; }); dist = n; }
  const win = dist.reduce((s, x, i) => s + (i >= 5 ? x : 0), 0), exp = cats.reduce((s, c) => s + c._p, 0);
  for (const c of cats) delete c._p; delete a.add; delete b.add;
  return { week: mu.week, dates: mu.dates, days_left: rest, you: a, opponent: b, categories: cats, expected_categories_won: r1(exp), chance_to_win_week: Math.round(win * 100) + '%',
    method: 'Yahoo totals so far + Sixth Man Proj per-game lines for each game left, counting only players in an active slot on Yahoo that day who have a game and are not ruled out on the injury report. Simpler than the site\'s Matchup page (no matchup ease or next-man-up minutes).' };
}

const INSTRUCTIONS = `You are a fantasy basketball analyst for the user's own Yahoo league, with their league read live from Yahoo and Sixth Man's projections.
League: 10 teams, head-to-head, 9 categories (FG%, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO; fewer turnovers wins). Weekly matchups Mon-Sun, 4 adds a week.
Free agents vs waivers: a free agent can be added any time (first come). A player on waivers (just dropped) can only be claimed until the date he clears; claims run in waiver order that morning and a claim that lands sends that team to the back of the order. Skipping the claim to keep priority means waiting until he clears and then racing to add him, and any team's claim (even one behind in the order) gets him first. When you recommend a pickup, say which it is, and for a waiver player whether he's worth the claim. Lineup: PG, SG, G, SF, PF, F, C, C, Util, Util (10 active), 3 bench; this league allows 3 IL players (13 + 3 = 16 at most).
Sixth Man ranks are plain 9-cat per-game ranks among all NBA players: proj_rank = rest of season (the best guide for adds and drops), season_rank, rank_14d, rank_7d. Inside 100 = a starter in a 10-team league, 101-130 = bench/streamer, beyond 130 = waiver level. Weekly value = games x per-game quality: a 4-game streamer can beat a better 2-game player for one week.
Minutes overrides: the user can set a player's minutes by hand on Sixth Man (minutes_override on a player); the Proj line and the matchup projection use them, proj_rank stays the model's. When you think the model's minutes are off (an injury-shortened game, a restriction ending, a starter returning), say so and suggest an override.
IL+ trick (the user uses it): a player with a Yahoo injury tag (Q, P, D, O, INJ, GTD) can be moved to IL; lineups can be preset days or weeks ahead and hold even after he's healthy, as long as there are no adds or drops. Each day the IL slots should hold tagged players who don't play that day; tagged players whose games overlap block each other. Any add or drop can reset preset lineups, and once a parked player loses his tag adds/drops are blocked. Use get_il_plus for this.
Use the tools before answering; cite the numbers (ranks, games, win chances) and be decisive: give a recommendation, then the why. Start with get_my_team and get_matchup for most questions. Fantasy data provided by Yahoo Fantasy.`;

export async function mcp(req, env, deps) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (req.method !== 'POST') return new Response('Use POST (MCP Streamable HTTP).', { status: 405, headers: { Allow: 'POST' } });
  let body; try { body = await req.json(); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const msgs = Array.isArray(body) ? body : [body], res = [];
  for (const m of msgs) {
    if (!m || m.id === undefined) continue; // notifications get no answer
    const ok = result => res.push({ jsonrpc: '2.0', id: m.id, result }), err = (code, message) => res.push({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    try {
      if (m.method === 'initialize') {
        const want = m.params && m.params.protocolVersion, sup = ['2025-06-18', '2025-03-26', '2024-11-05'];
        ok({ protocolVersion: sup.includes(want) ? want : sup[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sixth-man-analyst', version: '1.0.0' }, instructions: INSTRUCTIONS });
      } else if (m.method === 'ping') ok({});
      else if (m.method === 'tools/list') ok({ tools: TOOLS });
      else if (m.method === 'resources/list') ok({ resources: [] });
      else if (m.method === 'prompts/list') ok({ prompts: [] });
      else if (m.method === 'tools/call') {
        const p = m.params || {};
        if (!TOOLS.some(t => t.name === p.name)) { err(-32602, 'Unknown tool: ' + p.name); continue; }
        try { const r = await call(p.name, p.arguments || {}, deps, env); ok({ content: [{ type: 'text', text: JSON.stringify(r) }], isError: !!(r && r.error) }); }
        catch (e) { ok({ content: [{ type: 'text', text: 'Error: ' + (e.message || e) }], isError: true }); }
      } else err(-32601, 'Method not found: ' + m.method);
    } catch (e) { err(-32603, e.message || String(e)); }
  }
  if (!res.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? res : res[0]);
}

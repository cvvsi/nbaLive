/* Season / last-30 / last-14 / last-7 day / last-3-team-games 9-cat rankings -> data/rankings.json
 * (committed; index.html reads it to show each player's ranks beside tonight's line).
 *
 * Per-game averages over each window, z-scored against a top-156 pool (12 teams x 13),
 * iterated so the pool settles on the players who'd actually be rostered. FG%/FT% use the
 * same volume-weighted impact as the box score: makes - poolPct * attempts, per game.
 * The page re-ranks from the stored z-scores, so punts apply to these ranks too.
 *
 * Also writes data/regression.json for the Buy/Sell tab: each player's per-minute rates now
 * vs. data/history.json (last season, from build-history.js), and an "expected" rank from
 * current minutes x rates regressed toward that baseline. See expectedLine().
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
const POOL = 156, ITER = 4, G3 = 3;
const CACHE = '.cache/games.json', OUT = 'data/rankings.json', REG = 'data/regression.json', HIST = 'data/history.json';
const CACHE_V = 3;   // bump when parseBox's row shape changes, so stale cached rows are refetched

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
      to: ix('turnovers'), stl: ix('steals'), blk: ix('blocks'), pf: ix('fouls'),
    };
    for (const a of st.athletes) {
      if (a.didNotPlay || !a.stats || !a.stats.length || !a.athlete.id) continue;
      const s = a.stats, min = parseFloat(s[I.min]) || 0; if (min <= 0) continue;
      const [fgm, fga] = split(s[I.fg]), [tpm, tpa] = split(s[I.tp]), [ftm, fta] = split(s[I.ft]);
      out.push({
        id: String(a.athlete.id), name: a.athlete.displayName, team: t.team.abbreviation, min,
        pts: +s[I.pts] || 0, reb: +s[I.reb] || 0, ast: +s[I.ast] || 0, stl: +s[I.stl] || 0,
        blk: +s[I.blk] || 0, to: +s[I.to] || 0, pf: +s[I.pf] || 0, fgm, fga, tpm, tpa, ftm, fta,
      });
    }
  }
  return out;
}

async function loadGames(through, file = CACHE) {
  // days[d] = true once every game on d is final (or it's a preseason date); games[eventId] = rows.
  let cache = { v: CACHE_V, days: {}, games: {} };
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.v === CACHE_V) cache = c; } catch (e) {}
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
  fs.writeFileSync(file, JSON.stringify(cache));
  return games;
}

// teamGames (team -> games in the window) switches to per-TEAM-game averages: a game the
// player missed counts as a zero night, so resting or hurt players can't look hot.
// Per-player totals over some games. use/tpos are usage's numerator and denominator
// (possessions used, and team possessions while on the floor), with team totals summed
// from the box score, so usage over any span is 100 * use / tpos.
const STATS = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta'];
function totals(games) {
  const by = {};
  for (const g of games) {
    const T = {};
    for (const r of g.rows) { const t = T[r.team] || (T[r.team] = { min: 0, poss: 0 });
      t.min += r.min; t.poss += r.fga + .44 * r.fta + r.to; }
    for (const r of g.rows) {
      const p = by[r.id] || (by[r.id] = { id: r.id, gp: 0, use: 0, tpos: 0, ...Object.fromEntries(STATS.map(k => [k, 0])) });
      p.team = r.team; p.name = r.name;
      p.gp++; for (const k of STATS) p[k] += r[k];
      const t = T[r.team]; p.use += r.fga + .44 * r.fta + r.to; p.tpos += r.min * t.poss / (t.min / 5);
    }
  }
  return by;
}

function rankWindow(games, teamGames) {
  const P = Object.values(totals(games));
  for (const p of P) { const n = teamGames ? teamGames[p.team] : p.gp; for (const k of STATS) p[k] /= n; }
  return score(P);
}

// z-scores and Value for per-game lines (p.min, p.pts, ... p.fta per game, p.gp for eligibility).
// P.pool keeps the final pool's averages and spreads, so a hypothetical line can be scored
// against the same pool afterwards (zOf).
function score(P) {
  // A pool member must have played at least half as many games as the busiest player in the
  // window, so a single 40-minute blowout doesn't stretch the pool's spread.
  const maxGP = Math.max(...P.map(p => p.gp)), elig = P.filter(p => p.gp >= Math.ceil(maxGP / 2));
  let pool = [...elig].sort((a, b) => b.min * b.gp - a.min * a.gp).slice(0, POOL);
  const src = { pts: 'pts', tpm: 'tpm', reb: 'reb', ast: 'ast', stl: 'stl', blk: 'blk', fg: 'fgi', ft: 'fti', to: 'to' }, st = {};
  for (let it = 0; it < ITER; it++) {
    const lgFG = sum(pool, 'fgm') / Math.max(1, sum(pool, 'fga')), lgFT = sum(pool, 'ftm') / Math.max(1, sum(pool, 'fta'));
    for (const p of P) { p.fgi = p.fgm - lgFG * p.fga; p.fti = p.ftm - lgFT * p.fta; }
    for (const c of CATS) {
      const k = src[c], m = sum(pool, k) / pool.length;
      const sd = Math.sqrt(pool.reduce((a, p) => a + (p[k] - m) ** 2, 0) / pool.length) || 1;
      for (const p of P) (p.z || (p.z = {}))[c] = (c === 'to' ? -1 : 1) * (p[k] - m) / sd;
      st[c] = { k, m, sd };
    }
    P.pool = { lgFG, lgFT, st };
    for (const p of P) p.value = CATS.reduce((a, c) => a + p.z[c], 0) / 9;
    pool = [...elig].sort((a, b) => b.value - a.value).slice(0, POOL);
  }
  return P;
}
function zOf(l, { lgFG, lgFT, st }) {
  const v = { ...l, fgi: l.fgm - lgFG * l.fga, fti: l.ftm - lgFT * l.fta };
  return Object.fromEntries(CATS.map(c => [c, (c === 'to' ? -1 : 1) * (v[st[c].k] - st[c].m) / st[c].sd]));
}

// ---- regression: is the start real?
// A season-to-date rank mixes role (minutes, usage), which tends to stick, with per-minute
// production and shooting, which are noisy over a few games. The expected line keeps this
// season's minutes and blends each per-minute rate and shooting % with last season's:
//   rate = (this season's count + baseline rate * K) / (this season's minutes or attempts + K)
// so K is how many minutes (or attempts) of this season it takes to count as much as the
// baseline. Fast-settling rates (shot volume, boards) have a small K; steals, blocks and 3P%
// a large one. The baseline never counts for more than it actually saw.
const PRIOR = { fga: 150, tpa: 200, fta: 250, reb: 200, ast: 250, to: 300, stl: 600, blk: 500,  // minutes
  fg: 250, tp: 500, ft: 200 };                                                                  // attempts
const PRIOR_GP = 3;          // minutes: this season's mpg, nudged by 3 games of last season's
const BASE_MIN = 500;        // under this many minutes last season, add the season before it
const UP_MIN = 30, UP_BELOW = 26;   // role upside: the same rates at 30 min, for anyone under 26 now
const BLOWOUT = 20;                  // final margin that counts as a blowout
const PG = ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to'];
const RATES = ['mpg', 'usg', 'fg', 'ft', 'tp', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'fga', 'fta', 'tpa'];
const r1 = v => Math.round(v * 10) / 10;

// Per-36 counting rates, shooting % and usage from a totals object.
function rates(t) {
  const m = t.min || 1, per = k => r1(t[k] * 36 / m), pc = (a, b) => b ? r1(100 * a / b) : null;
  return [r1(t.min / t.gp), t.tpos ? r1(100 * t.use / t.tpos) : 0, pc(t.fgm, t.fga), pc(t.ftm, t.fta), pc(t.tpm, t.tpa),
    per('tpm'), per('pts'), per('reb'), per('ast'), per('stl'), per('blk'), per('to'), per('fga'), per('fta'), per('tpa')];
}

// Baseline totals for a player: last season, plus the one before when last season was short
// (injury, rookie year cut short). Totals add, so the blend is weighted by minutes played.
function baseline(h) {
  if (!h) return null;
  const [ly, prev] = h.seasons, s = h.s;
  const pick = s[ly] && s[ly].min >= BASE_MIN ? [ly] : [ly, prev].filter(k => s[k]);
  if (!pick.length) return null;
  const t = { gp: 0, use: 0, tpos: 0, ...Object.fromEntries(STATS.map(k => [k, 0])) };
  for (const k of pick) for (const f in t) t[f] += s[k][f] || 0;
  return t.min >= 200 ? { t, src: pick.join('+') } : null;
}

// Per-game expected line from season totals s and baseline totals b (see the note above).
// mpgAt replaces the minutes, for the role-upside line. With no baseline, b is all zeros
// and every rate is just this season's.
const NOBASE = { gp: 1, ...Object.fromEntries(STATS.map(k => [k, 0])) };
function expectedLine(s, b, mpgAt) {
  const w = (k, n) => Math.min(PRIOR[k], n);
  const rate = (k, cur, curN, base, baseN) => baseN ? (cur + base / baseN * w(k, baseN)) / (curN + w(k, baseN)) : cur / Math.max(1, curN);
  const mpg = mpgAt || (s.min + (b.min / b.gp) * PRIOR_GP) / (s.gp + PRIOR_GP);
  const per = k => rate(k, s[k], s.min, b[k], b.min) * mpg;
  const fga = per('fga'), tpa = per('tpa'), fta = per('fta');
  const fgm = fga * rate('fg', s.fgm, s.fga, b.fgm, b.fga);
  const tpm = tpa * rate('tp', s.tpm, s.tpa, b.tpm, b.tpa);
  const ftm = fta * rate('ft', s.ftm, s.fta, b.ftm, b.fta);
  return { min: mpg, fga, fgm, tpa, tpm, fta, ftm, pts: 2 * fgm + tpm + ftm,   // a 3 is a 2 plus one
    reb: per('reb'), ast: per('ast'), stl: per('stl'), blk: per('blk'), to: per('to') };
}

// Game context for the note: blowouts and foul trouble cut minutes without saying anything
// about the role. Margins come from summing each team's points in the box score.
// cx = [blowout games, mpg in them, other games, mpg in them, games with 5+ fouls]
function context(games) {
  const by = {};
  for (const g of games) {
    const pts = {};
    for (const r of g.rows) pts[r.team] = (pts[r.team] || 0) + r.pts;
    const tot = Object.values(pts).reduce((a, v) => a + v, 0);
    for (const r of g.rows) {
      const c = by[r.id] || (by[r.id] = [0, 0, 0, 0, 0]), blow = Math.abs(2 * pts[r.team] - tot) >= BLOWOUT;
      if (blow) { c[0]++; c[1] += r.min; } else { c[2]++; c[3] += r.min; }
      if (r.pf >= 5) c[4]++;
    }
  }
  for (const c of Object.values(by)) { c[1] = c[0] ? r1(c[1] / c[0]) : 0; c[3] = c[2] ? r1(c[3] / c[2]) : 0; }
  return by;
}

function buildRegression(games, asOf, rankings) {
  let H = null;
  try { H = JSON.parse(fs.readFileSync(HIST, 'utf8')); }
  catch (e) { console.log(`${HIST} missing: run node build-history.js once. Skipping ${REG}.`); return; }
  const tot = totals(games), lines = [];
  for (const s of Object.values(tot)) {
    const h = H.players[s.id], b = baseline(h && { seasons: H.seasons, s: h.s });
    // No baseline (rookies, long absences): the expected line is just the actual one.
    const x = b ? expectedLine(s, b.t) : expectedLine(s, NOBASE, s.min / s.gp);
    lines.push({ id: s.id, gp: s.gp, ...x, s, b });
  }
  const out = {}, cx = context(games), scored = score(lines);
  for (const p of scored) {
    out[p.id] = { n: p.s.name, t: p.s.team,
      now: rankings[p.id].w.season,
      x: [p.gp, r1(p.min), ...CATS.map(c => r2(p.z[c]))],
      r: rates(p.s),
      // for the page's analyst note: exact per-game averages, and shot attempts behind each %
      pg: PG.map(k => r1(p.s[k] / p.s.gp)), att: [p.s.fga, p.s.tpa, p.s.fta], cx: cx[p.id] };
    // Role upside: what the same (blended) per-minute numbers are worth at 30 minutes.
    if (p.s.min / p.s.gp < UP_BELOW && p.gp >= 3) {
      const z = zOf(expectedLine(p.s, p.b ? p.b.t : NOBASE, UP_MIN), scored.pool);
      out[p.id].up = [p.gp, UP_MIN, ...CATS.map(c => r2(z[c]))];
    }
    if (p.b) Object.assign(out[p.id], { b: rates(p.b.t), bs: p.b.src, bgp: p.b.t.gp });
  }
  // Last season's z-scores for everyone who qualified, not just this season's players, so
  // the page's LY rank is the real final rank (retired players still hold their spots).
  const ly = {};
  for (const [id, h] of Object.entries(H.players)) if (h.ly) ly[id] = h.ly;
  fs.writeFileSync(REG, JSON.stringify({ asOf, cats: CATS, fields: ['gp', 'mpg', ...CATS], rates: RATES, pgf: PG,
    seasons: H.seasons, prior: PRIOR, priorGp: PRIOR_GP, baseMin: BASE_MIN, players: out, ly }));
  console.log(`${REG}: ${lines.filter(l => l.b).length}/${lines.length} players with a baseline`);
}

async function main() {
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
  // g3: each team's last 3 games, per team game. Calendar windows hold 2-4 games depending
  // on the schedule; this is the "3 straight decent games" read, with DNPs as zeros.
  const byTeam = {};
  for (const g of games) for (const t of new Set(g.rows.map(r => r.team))) (byTeam[t] || (byTeam[t] = [])).push(g);
  const last = {}, teamGames = {};
  for (const [t, gs] of Object.entries(byTeam)) {
    gs.sort((a, b) => a.date < b.date ? -1 : 1);
    last[t] = new Set(gs.slice(-G3)); teamGames[t] = Math.min(G3, gs.length);
  }
  const g3 = games.map(g => ({ rows: g.rows.filter(r => last[r.team] && last[r.team].has(g)) }));
  windows.g3 = { games: G3, perTeamGame: true, to: asOf };
  for (const p of rankWindow(g3, teamGames))
    players[p.id].w.g3 = [p.gp, Math.round(p.min * 10) / 10, ...CATS.map(c => r2(p.z[c]))];
  // pm: minutes per game played BEFORE those 3, the baseline for the role-change flag.
  // (Comparing against the season would dilute the jump with the very games that show it.)
  const before = {};
  for (const g of games) for (const r of g.rows) if (!last[r.team].has(g)) {
    const b = before[r.id] || (before[r.id] = { gp: 0, min: 0 }); b.gp++; b.min += r.min;
  }
  for (const [id, b] of Object.entries(before)) players[id].pm = Math.round(b.min / b.gp * 10) / 10;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ asOf, cats: CATS, fields: ['gp', 'mpg', ...CATS], windows, players }));
  console.log(`${OUT}: ${Object.keys(players).length} players through ${asOf}`, JSON.stringify(windows));
  buildRegression(games, asOf, players);
}

module.exports = { loadGames, totals, rankWindow, STATS, CATS, r2 };
if (require.main === module) main();

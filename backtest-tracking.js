/* Backtest: do NBA.com tracking stats make Proj faster and more accurate?
 *
 * Usage:  node backtest-tracking.js     reads data/tracking-history.json (fetch-tracking.py, run on
 *                                       a home PC), writes data/backtest-tracking.json
 *
 * Each test season (2023-24, 2024-25, 2025-26) is split at Nov 20: the opening weeks (about 12-16
 * games) are "this season so far", the rest of the season is the truth. Baseline = the season
 * before (one season, the same for every model, so they compare like for like). Players need 500+
 * baseline minutes, 150+ opening minutes and 300+ rest-of-season minutes.
 *
 * AST   today:    rate = (opening AST + baseline rate x K) / (opening minutes + K), K = 250
 *       tracking: AST = potential assists x conversion (share of potential assists that became
 *                 assists, mostly teammates' shooting). Each part blended toward the player's own
 *                 baseline with its own weight: potential assists per minute (Kp minutes) and
 *                 conversion (Kc potential assists).
 * REB   today:    the same blend, K = 450
 *       tracking: REB = rebound chances x grab rate, each blended (Kp minutes, Kc chances).
 *                 Rebounds and minutes from the Rebounding table (it misses some games).
 * Weights are fitted on two seasons and scored on the third, each in turn (out of sample). Error =
 * per-36 gap to the rest-of-season rate, weighted by rest-of-season minutes. "refit" refits
 * today's single K, so a gain isn't just a better K.
 */
const fs = require('fs');
const D = JSON.parse(fs.readFileSync('data/tracking-history.json', 'utf8'));
const tab = (season, from, measure) => {
  const w = D.windows.find(x => x.season === season && x.from === from && x.measure === measure);
  const out = {}; for (const r of w.rows) out[r[0]] = Object.fromEntries(w.headers.map((h, i) => [h, r[i]])); return out;
};
const SEASONS = { '2023-24': ['10/01/2023', '11/21/2023'], '2024-25': ['10/01/2024', '11/21/2024'], '2025-26': ['10/01/2025', '11/21/2025'] };
const PREV = { '2023-24': '2022-23', '2024-25': '2023-24', '2025-26': '2024-25' };
const sum = (a, b) => { if (!a) return b; if (!b) return a; const o = { ...a }; for (const k in b) if (typeof b[k] === 'number' && !/PCT|AVG|PER|_ID|^W$|^L$/.test(k)) o[k] = (a[k] || 0) + b[k]; return o; };
function full(season, measure) {          // whole season: the one window, or opening + rest
  if (season === '2022-23') return tab(season, '', measure);
  const [a, b] = SEASONS[season], A = tab(season, a, measure), B = tab(season, b, measure), o = {};
  for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) o[id] = sum(A[id], B[id]);
  return o;
}
// stat: [table, count, minutes, chance column]
const STATS = { ast: ['Passing', 'AST', 'MIN', 'POTENTIAL_AST'], reb: ['Rebounding', 'REB', 'MIN', 'REB_CHANCES'] };
const CUR = { ast: 250, reb: 450 };
const KS = [25, 50, 100, 150, 200, 250, 300, 450, 600, 900, 1200, 1800, 2500, 4000, 1e9];
const TESTS = Object.keys(SEASONS);

const S = {};
for (const [k, [T, C, M, X]] of Object.entries(STATS)) {
  S[k] = {};
  for (const y of TESTS) {
    const B = full(PREV[y], T), E = tab(y, SEASONS[y][0], T), R = tab(y, SEASONS[y][1], T); S[k][y] = [];
    for (const id in E) {
      const b = B[id], e = E[id], r = R[id];
      if (!b || !r || b[M] < 500 || e[M] < 150 || r[M] < 300 || !b[X]) continue;
      S[k][y].push({ id, name: e.PLAYER_NAME, b: { c: b[C], m: b[M], x: b[X] }, e: { c: e[C], m: e[M], x: e[X] }, truth: r[C] / r[M], wt: r[M], restMpg: r[M] / r.GP });
    }
  }
}
const bl = (cnt, n, base, K, cap) => { const w = Math.min(K, cap); return (cnt + base * w) / (n + w); };
const predToday = (s, K) => bl(s.e.c, s.e.m, s.b.c / s.b.m, K, s.b.m);
const predTrack = (s, p) => bl(s.e.x, s.e.m, s.b.x / s.b.m, p.Kp, s.b.m) * bl(s.e.c, s.e.x, s.b.c / s.b.x, p.Kc, s.b.x);
function err(k, ys, f, filt) { let se = 0, wt = 0; for (const y of ys) for (const s of S[k][y]) { if (filt && !filt(s)) continue; se += s.wt * (f(s) - s.truth) ** 2; wt += s.wt; } return { se, wt }; }
const rm = e => Math.sqrt(e.se / e.wt) * 36;
const big = s => Math.abs(s.e.c / s.e.m - s.b.c / s.b.m) >= .3 * s.b.c / s.b.m;
const up50 = s => s.e.c / s.e.m >= 1.5 * s.b.c / s.b.m;

const out = { note: 'RMSE per 36 minutes, out of sample (fit on two seasons, scored on the third); gain = % less error than today', tests: TESTS, stats: {}, examples: {} };
for (const k of Object.keys(STATS)) {
  const M = { today: [], refit: [], tracking: [] }, folds = [];
  const acc = () => ({ all: { se: 0, wt: 0 }, big: { se: 0, wt: 0 }, up: { se: 0, wt: 0 } });
  const A = { today: acc(), refit: acc(), tracking: acc() };
  for (const y of TESTS) {
    const train = TESTS.filter(t => t !== y);
    let bk = null; for (const K of KS) { const e = err(k, train, s => predToday(s, K)).se; if (!bk || e < bk.e) bk = { K, e }; }
    let bp = null; for (const Kp of KS) for (const Kc of KS) { const e = err(k, train, s => predTrack(s, { Kp, Kc })).se; if (!bp || e < bp.e) bp = { p: { Kp, Kc }, e }; }
    folds.push({ test: y, refitK: bk.K, Kp: bp.p.Kp, Kc: bp.p.Kc });
    const F = { today: s => predToday(s, CUR[k]), refit: s => predToday(s, bk.K), tracking: s => predTrack(s, bp.p) };
    for (const [m, f] of Object.entries(F)) for (const [g, filt] of [['all', null], ['big', big], ['up', up50]]) { const e = err(k, [y], f, filt); A[m][g].se += e.se; A[m][g].wt += e.wt; }
    if (y === TESTS[TESTS.length - 1]) out.examples[k] = S[k][y].filter(up50).map(s => ({ name: s.name, perGame: 'at rest-of-season minutes', baseline: +(s.b.c / s.b.m * s.restMpg).toFixed(1), opening: +(s.e.c / s.e.m * s.restMpg).toFixed(1), rest: +(s.truth * s.restMpg).toFixed(1), projToday: +(F.today(s) * s.restMpg).toFixed(1), projTracking: +(F.tracking(s) * s.restMpg).toFixed(1),
      chanceChangePct: Math.round((s.e.x / s.e.m / (s.b.x / s.b.m) - 1) * 100), conversion: [+(s.b.c / s.b.x * 100).toFixed(0), +(s.e.c / s.e.x * 100).toFixed(0)] })).sort((a, b) => b.opening - b.baseline - (a.opening - a.baseline));
  }
  const n = g => A.today[g].wt ? Object.fromEntries(Object.entries(A).map(([m, v]) => [m, +rm(v[g]).toFixed(3)])) : null;
  const gain = (g, m) => +((1 - rm(A[m][g]) / rm(A.today[g])) * 100).toFixed(1);
  out.stats[k] = { players: TESTS.map(y => S[k][y].length), error: n('all'), gainPct: { refit: gain('all', 'refit'), tracking: gain('all', 'tracking') },
    bigChanges: { players: TESTS.reduce((a, y) => a + S[k][y].filter(big).length, 0), error: n('big'), gainPct: { refit: gain('big', 'refit'), tracking: gain('big', 'tracking') } },
    up50: { players: TESTS.reduce((a, y) => a + S[k][y].filter(up50).length, 0), error: n('up'), gainPct: { refit: gain('up', 'refit'), tracking: gain('up', 'tracking') } }, folds };
  const st = out.stats[k];
  console.log(`\n== ${k.toUpperCase()} (players per season: ${st.players.join(' / ')})`);
  console.log(`  all players:      today ${st.error.today}  refit ${st.error.refit} (${st.gainPct.refit}%)  tracking ${st.error.tracking} (${st.gainPct.tracking}%)`);
  console.log(`  change 30%+ (${st.bigChanges.players}): today ${st.bigChanges.error.today}  refit ${st.bigChanges.error.refit} (${st.bigChanges.gainPct.refit}%)  tracking ${st.bigChanges.error.tracking} (${st.bigChanges.gainPct.tracking}%)`);
  console.log(`  up 50%+ (${st.up50.players}):     today ${st.up50.error.today}  refit ${st.up50.error.refit} (${st.up50.gainPct.refit}%)  tracking ${st.up50.error.tracking} (${st.up50.gainPct.tracking}%)`);
  console.log(`  fitted per fold: ${folds.map(f => `${f.test}: K ${f.refitK}, Kp ${f.Kp}, Kc ${f.Kc}`).join(' | ')}`);
  console.log(`  2025-26 players up 50%+ (per game): name, baseline -> opening -> rest | Proj today vs tracking | chances change, conversion before -> opening`);
  for (const e of out.examples[k].slice(0, 15)) console.log(`    ${e.name.padEnd(24)} ${e.baseline} -> ${e.opening} -> ${e.rest} | ${e.projToday} vs ${e.projTracking} | ${e.chanceChangePct >= 0 ? '+' : ''}${e.chanceChangePct}%, ${e.conversion[0]}% -> ${e.conversion[1]}%`);
}
fs.writeFileSync('data/backtest-tracking.json', JSON.stringify(out, null, 1));
console.log('\ndata/backtest-tracking.json written');

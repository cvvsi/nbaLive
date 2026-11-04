/* Backtest for Proj's blend constants over several finished seasons: how much should the
 * first N games of a season count against the player's baseline?
 *
 * Usage:  node backtest.js [seasons]     default 3 test seasons, ending with the last completed one
 * Fetches: each test season plus the two before it from ESPN (box scores cached in .cache/).
 * Writes:  data/backtest.json (summary); prints the tables.
 *
 * Method (per test season Y): players with 500+ min in Y-1 and at least N + 20 games in Y. The
 * first N games are "this season so far", the rest of Y is the truth. Baseline = Y-1 totals +
 * PREV_W x Y-2 totals (Y-2 in full when Y-1 was short), as build-rankings.js does.
 * Predicted per-minute rate = (first-N count + baseline rate x w) / (first-N minutes + w),
 * w = min(K, baseline minutes). Error = squared gap to the rest-of-season rate, weighted by
 * rest-of-season minutes (attempts for shooting %). RMSE per 36 (% points for shooting).
 *
 * Reported: best K per season (is it stable?), best K pooled, and a rotating out-of-sample
 * check (fit on the other seasons, score on the held-out one) against today's K. The role
 * adjustment (baseline shots / FTs / assists / TOs scaled by the change in usage) is scored at
 * the SAME K, so its effect isn't mixed up with a K change.
 */
const fs = require('fs');
const { loadGames } = require('./build-rankings.js');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NSEAS = +process.argv[2] || 3;
const NS = [5, 8, 12, 20], REST_MIN = 20, BASE_MIN = 500, PREV_W = .5;
const KS = [0, 25, 50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800, 2500, 4000, 1e9];
const RATE = ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fga', 'fta', 'tpa'];
const PCT = { fg: ['fgm', 'fga'], ft: ['ftm', 'fta'], tp: ['tpm', 'tpa'] };
const STATS = [...RATE, ...Object.keys(PCT)];
// Today's K (build-rankings.js, fitted Nov 2026).
const CUR = { fga: 150, tpa: 200, fta: 450, reb: 450, ast: 250, to: 600, stl: 1200, blk: 500, fg: 450, tp: 500, ft: 200 };
const ROLE = ['fga', 'fta', 'ast', 'to', 'pts'];   // usage-driven (3PA left out: it hurt last time)
const KU = 150;                                     // minutes of baseline usage in the usage blend
const F = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpa', 'use', 'tpos'];
const label = y => `${y - 1}-${String(y).slice(2)}`;

const zero = () => Object.fromEntries(F.map(k => [k, 0]));
const add = (a, r, w = 1) => { for (const k of F) a[k] += (r[k] || 0) * w; return a; };
function rowsByPlayer(games) {
  const by = {};
  for (const g of [...games].sort((a, b) => a.date < b.date ? -1 : 1)) {
    const T = {};
    for (const r of g.rows) { const t = T[r.team] || (T[r.team] = { min: 0, poss: 0 }); t.min += r.min; t.poss += r.fga + .44 * r.fta + r.to; }
    for (const r of g.rows) { const t = T[r.team]; (by[r.id] || (by[r.id] = [])).push({ ...r, use: r.fga + .44 * r.fta + r.to, tpos: r.min * t.poss / (t.min / 5) }); }
  }
  return by;
}
const totalsOf = games => Object.fromEntries(Object.entries(rowsByPlayer(games)).map(([id, rs]) => [id, { ...rs.reduce((a, r) => add(a, r), zero()), gp: rs.length }]));
const usg = t => t.tpos ? t.use / t.tpos : 0;
const kTxt = K => K >= 1e9 ? 'base' : K === 0 ? 'cur' : String(K);

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const last = cur - 1, tests = [...Array(NSEAS)].map((_, i) => last - i).reverse();   // e.g. 2024, 2025, 2026
  const need = [...new Set(tests.flatMap(y => [y, y - 1, y - 2]))].sort();
  const G = {};
  for (const y of need) { G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
  const TOT = Object.fromEntries(need.map(y => [y, totalsOf(G[y])]));

  // Samples per test season and checkpoint.
  const S = {};
  for (const y of tests) {
    const rows = rowsByPlayer(G[y]); S[y] = {};
    for (const N of NS) S[y][N] = [];
    for (const [id, rs] of Object.entries(rows)) {
      const b1 = TOT[y - 1][id]; if (!b1 || b1.min < BASE_MIN) continue;
      const b = add(zero(), b1); const b2 = TOT[y - 2][id]; if (b2) add(b, b2, PREV_W);
      for (const N of NS) {
        if (rs.length < N + REST_MIN) continue;
        const e = rs.slice(0, N).reduce((a, r) => add(a, r), zero()), r = rs.slice(N).reduce((a, r) => add(a, r), zero());
        S[y][N].push({ id, e, r, b, b1, b2: b2 || null, gp: N, restGp: rs.length - N, lmpg: b1.min / b1.gp });
      }
    }
    console.log(`${label(y)} samples: ${NS.map(N => `N=${N}:${S[y][N].length}`).join(' ')}`);
  }

  // Sum of weighted squared error and weight for one stat, set of seasons, checkpoint, K.
  function sse(ys, N, k, K, role = false) {
    let se = 0, wt = 0;
    for (const y of ys) for (const s of S[y][N]) {
      const { b, e, r } = s;
      if (PCT[k]) {
        const [m, a] = PCT[k]; if (!r[a] || !b[a]) continue;
        const w = Math.min(K, b[a]); if (e[a] + w <= 0) continue;
        const pred = (e[m] + b[m] / b[a] * w) / (e[a] + w);
        se += r[a] * (pred - r[m] / r[a]) ** 2; wt += r[a];
      } else {
        if (!r.min || !b.min) continue;
        let br = b[k] / b.min;
        if (role && ROLE.includes(k) && usg(b) > 0) { const wu = Math.min(KU, b.min), up = (usg(e) * e.min + usg(b) * wu) / (e.min + wu); br *= up / usg(b); }
        const w = Math.min(K, b.min), pred = (e[k] + br * w) / (e.min + w);
        se += r.min * (pred - r[k] / r.min) ** 2; wt += r.min;
      }
    }
    return { se, wt };
  }
  const rmse = (ys, N, k, K, role) => { const { se, wt } = sse(ys, N, k, K, role); return Math.sqrt(se / wt) * (PCT[k] ? 100 : 36); };
  const best = (ys, N, k, role) => { let b = null; for (const K of KS) { const e = rmse(ys, N, k, K, role); if (Number.isFinite(e) && (!b || e < b.e)) b = { K, e }; } return b; };

  const out = { tests: tests.map(label), ns: NS, perSeason: {}, pooled: {}, loso: {}, role: {}, minutes: {} };
  console.log(`\n== Best K per season (stable = trustworthy) and pooled; today's K in brackets`);
  console.log('stat   ' + NS.map(N => `N=${N}: ${tests.map(y => label(y).slice(2)).join(' / ')} | pooled`.padEnd(34)).join(''));
  for (const k of STATS) {
    out.perSeason[k] = {}; out.pooled[k] = {};
    const cells = NS.map(N => {
      const per = tests.map(y => best([y], N, k).K), pool = best(tests, N, k);
      out.perSeason[k][N] = per; out.pooled[k][N] = pool.K;
      return `${per.map(kTxt).join(' / ')} | ${kTxt(pool.K)}`.padEnd(34);
    });
    console.log(`${(k + ' (' + (CUR[k] ?? '-') + ')').padEnd(11)}` + cells.join(''));
  }

  // Rotating out-of-sample: fit K on the other seasons, score the held-out one.
  console.log(`\n== Out of sample: fit on the other seasons, scored on the held-out one (sum over held-out seasons)`);
  console.log('stat   N   today K err   fitted err  (gain)   base-only   cur-only   fitted K per fold');
  for (const k of STATS) {
    out.loso[k] = {};
    for (const N of NS) {
      let sc = 0, sf = 0, sb = 0, so = 0, w = 0; const ks = [];
      for (const y of tests) {
        const train = tests.filter(t => t !== y), K = best(train, N, k).K; ks.push(K);
        const a = sse([y], N, k, CUR[k] ?? 1e9), f = sse([y], N, k, K), bo = sse([y], N, k, 1e9), co = sse([y], N, k, 0);
        sc += a.se; sf += f.se; sb += bo.se; so += Number.isFinite(co.se) ? co.se : NaN; w += a.wt;
      }
      const sc_ = x => Math.sqrt(x / w) * (PCT[k] ? 100 : 36), gain = (1 - Math.sqrt(sf / sc)) * 100;
      out.loso[k][N] = { today: +sc_(sc).toFixed(3), fitted: +sc_(sf).toFixed(3), gainPct: +gain.toFixed(1), baseOnly: +sc_(sb).toFixed(3), curOnly: +sc_(so).toFixed(3), folds: ks };
      if (N === 8 || N === 20) console.log(`${k.padEnd(6)} ${String(N).padEnd(3)} ${sc_(sc).toFixed(3).padStart(9)}   ${sc_(sf).toFixed(3).padStart(9)}  (${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%)  ${sc_(sb).toFixed(3).padStart(9)}  ${sc_(so).toFixed(3).padStart(9)}   ${ks.map(kTxt).join(', ')}`);
    }
  }

  // Role adjustment at the SAME K (pooled best plain K), per season and out of sample.
  console.log(`\n== Role adjustment alone (same K): error change per season; negative = better`);
  for (const N of NS) {
    const row = [];
    out.role[N] = {};
    for (const k of ROLE) {
      const K = out.pooled[k][N], per = tests.map(y => (rmse([y], N, k, K, true) / rmse([y], N, k, K) - 1) * 100);
      out.role[N][k] = per.map(v => +v.toFixed(1));
      row.push(`${k} ${per.map(v => (v >= 0 ? '+' : '') + v.toFixed(1)).join('/')}%`);
    }
    console.log(`  N=${N}: ${row.join('   ')}`);
  }

  // Minutes nudge.
  console.log(`\n== Minutes nudge G (games of last season's mpg mixed in): RMSE of rest-of-season mpg, pooled`);
  for (const N of NS) {
    const row = []; out.minutes[N] = {};
    for (const G_ of [0, 1, 3, 5, 10, 20]) {
      let se = 0, n = 0;
      for (const y of tests) for (const s of S[y][N]) { const pred = (s.e.min + s.lmpg * G_) / (N + G_), t = s.r.min / s.restGp; se += (pred - t) ** 2; n++; }
      const e = Math.sqrt(se / n); out.minutes[N][G_] = +e.toFixed(3); row.push(`G=${G_}:${e.toFixed(2)}`);
    }
    console.log(`  N=${N}: ${row.join('  ')}`);
  }
  // Breakout rule: when last season's usage moved T+ points from the season before, the season
  // before counts at W instead of PREV_W (risers only, or both directions). Scored at today's K,
  // per season, as the change in total error across all stats (minutes-weighted, per stat
  // normalized by its baseline error so every stat counts the same).
  console.log(`\n== Breakout rule: season-before-last weight when usage moved; % change in error vs today (negative = better)`);
  const setB = (rule) => { let n = 0, m = 0; for (const y of tests) for (const N of NS) for (const s of S[y][N]) {
    const d = s.b2 ? usg(s.b1) - usg(s.b2) : 0, hit = s.b2 && rule && (rule.both ? Math.abs(d) : d) >= rule.T;
    const w = hit ? rule.W : PREV_W; s.b = add(add(zero(), s.b1), s.b2 || zero(), s.b2 ? w : 0); if (N === 8) { m++; if (hit) n++; } } return [n, m]; };
  const errAll = y => { const o = {}; for (const N of NS) for (const k of STATS) o[N + k] = sse([y], N, k, CUR[k] ?? 1e9); return o; };
  setB(null); const base = Object.fromEntries(tests.map(y => [y, errAll(y)]));
  out.breakout = [];
  for (const both of [false, true]) for (const T of [.02, .03, .04]) for (const W of [.25, 0]) {
    const [n, m] = setB({ T, W, both }), per = tests.map(y => {
      const e = errAll(y), ks = Object.keys(e).filter(k => e[k].wt > 0 && base[y][k].se > 0);
      return ks.reduce((a, k) => a + e[k].se / base[y][k].se, 0) / ks.length * 100 - 100; });
    const byStat = {};
    for (const k of STATS) { let a = 0, b = 0; for (const y of tests) { const e = sse([y], 8, k, CUR[k] ?? 1e9); a += e.se; b += base[y]['8' + k].se; } byStat[k] = +((Math.sqrt(a / b) - 1) * 100).toFixed(1); }
    out.breakout.push({ both, T, W, players: `${n}/${m}`, perSeason: per.map(v => +v.toFixed(2)), atN8: byStat });
    console.log(`  ${both ? 'risers+fallers' : 'risers only   '} usage ${both ? '±' : '+'}${T * 100} pts -> w2 ${W}: ${n}/${m} players at N=8 | per season ${per.map(v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%').join(' / ')} | N=8 by stat: ${Object.entries(byStat).map(([k, v]) => k + ' ' + (v >= 0 ? '+' : '') + v).join(' ')}`);
  }
  setB(null);
  fs.writeFileSync('data/backtest.json', JSON.stringify(out, null, 1));
  console.log('\ndata/backtest.json written');
})().catch(e => { console.error(e); process.exit(1); });

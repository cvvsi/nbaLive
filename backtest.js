/* Backtest for Proj's blend constants: how much should the first N games of a season count
 * against the player's baseline? Fits each K in PRIOR (and the minutes nudge, the weight of
 * the season before last, and a usage-based role adjustment) on a finished season.
 *
 * Usage:  node backtest.js          target = last completed season (2025-26 in Nov 2026)
 * Needs:  data/history.json (for the season before the target), and fetches the target
 *         season and the one two back from ESPN (~2,500 box scores, cached in .cache/).
 * Prints: per stat and checkpoint, the error of each K, the best K, and the current K's
 *         error, plus the role-adjusted variant. Writes data/backtest.json with the summary.
 *
 * Method: for each player with a baseline (500+ min the season before) and at least N + 20
 * games, the first N games are "this season so far" and the rest of the season is the truth.
 * Predicted per-minute rate = (first-N count + baseline rate x w) / (first-N minutes + w),
 * w = min(K, baseline minutes), exactly as build-rankings.js does. Error = squared gap to the
 * rest-of-season rate, weighted by rest-of-season minutes (attempts for shooting %), so
 * regulars count more than 10-minute guys. Reported as RMSE per 36 (per 100 attempts for %).
 */
const fs = require('fs');
const { loadGames } = require('./build-rankings.js');

const H = JSON.parse(fs.readFileSync('data/history.json', 'utf8'));
const [LYL, L2L] = H.seasons;                      // e.g. "2025-26", "2024-25"
const yr = l => +l.slice(0, 4) + 1;                 // "2025-26" -> 2026
const TARGET = yr(LYL), PREV = yr(L2L), PREV2 = PREV - 1;
const NS = [5, 8, 12, 20], REST_MIN = 20;
const KS = [0, 25, 50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800, 2500, 4000, 1e9];
const RATE = ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fga', 'fta', 'tpa'];
const PCT = { fg: ['fgm', 'fga'], ft: ['ftm', 'fta'], tp: ['tpm', 'tpa'] };
const CUR = { fga: 150, tpa: 200, fta: 250, reb: 200, ast: 250, to: 300, stl: 600, blk: 500, fg: 250, tp: 500, ft: 200, pts: null };
const USG_STATS = ['pts', 'fga', 'fta', 'tpa', 'ast', 'to'];
const F = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpa', 'use', 'tpos'];

const zero = () => Object.fromEntries(F.map(k => [k, 0]));
// Per-game rows with usage parts (team possessions while on the floor), like totals() in build-rankings.
function rowsByPlayer(games) {
  const by = {};
  for (const g of [...games].sort((a, b) => a.date < b.date ? -1 : 1)) {
    const T = {};
    for (const r of g.rows) { const t = T[r.team] || (T[r.team] = { min: 0, poss: 0 }); t.min += r.min; t.poss += r.fga + .44 * r.fta + r.to; }
    for (const r of g.rows) {
      const t = T[r.team];
      (by[r.id] || (by[r.id] = [])).push({ ...r, use: r.fga + .44 * r.fta + r.to, tpos: r.min * t.poss / (t.min / 5) });
    }
  }
  return by;
}
const add = (a, r, w = 1) => { for (const k of F) a[k] += (r[k] || 0) * w; return a; };
const sumRows = rows => rows.reduce((a, r) => add(a, r), zero());

(async () => {
  console.log(`Target ${LYL}; baseline ${L2L} (+ ${PREV2 - 1}-${String(PREV2).slice(2)} at w2)`);
  const tg = await loadGames(`${TARGET}-05-01`, `.cache/season-${TARGET}.json`);
  const g2 = await loadGames(`${PREV2}-05-01`, `.cache/season-${PREV2}.json`);
  console.log(`${tg.length} target games, ${g2.length} games two seasons back`);
  const T = rowsByPlayer(tg), P2 = Object.fromEntries(Object.entries(rowsByPlayer(g2)).map(([id, r]) => [id, sumRows(r)]));
  const base1 = id => { const s = H.players[id] && H.players[id].s[L2L]; return s && s.min >= 500 ? s : null; };

  // Samples: per player and checkpoint, first-N totals, rest totals, baseline parts.
  const S = {};
  for (const N of NS) S[N] = [];
  for (const [id, rows] of Object.entries(T)) {
    const b1 = base1(id); if (!b1) continue;
    const b2 = P2[id] || null;
    for (const N of NS) {
      if (rows.length < N + REST_MIN) continue;
      S[N].push({ id, n: rows[0].name, early: sumRows(rows.slice(0, N)), rest: sumRows(rows.slice(N)), gp: N, restGp: rows.length - N, b1, b2 });
    }
  }
  for (const N of NS) console.log(`N=${N}: ${S[N].length} players`);

  const baseOf = (s, w2) => { const b = add(zero(), s.b1); if (s.b2 && w2) add(b, s.b2, w2); return b; };
  const usgOf = t => t.tpos ? t.use / t.tpos : 0;
  // Error of one stat for one K, optional role adjustment (baseline scaled by usage change).
  function err(N, k, K, { w2 = .5, role = false, Ku = 150 } = {}) {
    let se = 0, wt = 0;
    for (const s of S[N]) {
      const b = baseOf(s, w2), e = s.early, r = s.rest;
      if (PCT[k]) {
        const [m, a] = PCT[k]; if (!r[a] || !b[a]) continue;
        const w = Math.min(K, b[a]), pred = (e[m] + b[m] / b[a] * w) / (e[a] + w), truth = r[m] / r[a];
        se += r[a] * (pred - truth) ** 2; wt += r[a];
      } else {
        if (!r.min || !b.min) continue;
        let br = b[k] / b.min;
        if (role && USG_STATS.includes(k)) {
          const ub = usgOf(b), ue = usgOf(e);
          if (ub > 0) { const wu = Math.min(Ku, b.min), up = (ue * e.min + ub * wu) / (e.min + wu); br *= up / ub; }
        }
        const w = Math.min(K, b.min), pred = (e[k] + br * w) / (e.min + w), truth = r[k] / r.min;
        se += r.min * (pred - truth) ** 2; wt += r.min;
      }
    }
    const scale = PCT[k] ? 100 : 36;
    return Math.sqrt(se / wt) * scale;
  }
  const fit = (N, k, opt) => { let best = null; for (const K of KS) { const e = err(N, k, K, opt); if (!best || e < best.e) best = { K, e }; } return best; };
  const kTxt = K => K >= 1e9 ? 'base only' : K === 0 ? 'cur only' : String(K);

  const out = { target: LYL, ns: NS, stats: {}, minutes: {}, w2: {}, role: {} };
  console.log('\nRMSE of the rest-of-season rate (per 36; % points for shooting). best K | current K');
  console.log('stat  ' + NS.map(N => `N=${N}`.padEnd(30)).join(''));
  for (const k of [...RATE, ...Object.keys(PCT)]) {
    const cells = [];
    out.stats[k] = {};
    for (const N of NS) {
      const b = fit(N, k), cur = CUR[k] != null ? err(N, k, CUR[k]) : null, bo = err(N, k, 1e9), co = err(N, k, 0);
      out.stats[k][N] = { bestK: b.K, best: +b.e.toFixed(3), current: cur && +cur.toFixed(3), baseOnly: +bo.toFixed(3), curOnly: +co.toFixed(3) };
      cells.push(`${kTxt(b.K).padStart(9)} ${b.e.toFixed(3)} | ${cur != null ? cur.toFixed(3) : '  -  '}`.padEnd(30));
    }
    console.log(k.padEnd(6) + cells.join(''));
  }

  // Weight of the season before last (w2), at the fitted K per stat.
  console.log('\nSeason-before-last weight (avg RMSE ratio vs w2=0.5, fitted K per stat):');
  for (const w2 of [0, .25, .5, .75, 1]) {
    const rs = [];
    for (const N of NS) for (const k of [...RATE, ...Object.keys(PCT)]) { const K = out.stats[k][N].bestK; rs.push(err(N, k, K, { w2 }) / err(N, k, K, { w2: .5 })); }
    const m = rs.reduce((a, v) => a + v, 0) / rs.length; out.w2[w2] = +m.toFixed(4);
    console.log(`  w2=${w2}: ${m.toFixed(4)}`);
  }

  // Minutes: (first-N minutes + G x baseline mpg) / (N + G), vs rest-of-season mpg.
  console.log('\nMinutes nudge G (games of last season\'s mpg added): RMSE of rest-of-season mpg');
  for (const N of NS) {
    const row = [];
    for (const G of [0, 1, 3, 5, 10, 20, 1e9]) {
      let se = 0, n = 0;
      for (const s of S[N]) { const lm = s.b1.min / s.b1.gp, pred = G >= 1e9 ? lm : (s.early.min + lm * G) / (N + G), truth = s.rest.min / s.restGp; se += (pred - truth) ** 2; n++; }
      const e = Math.sqrt(se / n); row.push(`G=${G >= 1e9 ? 'LY' : G}:${e.toFixed(2)}`); (out.minutes[N] || (out.minutes[N] = {}))[G >= 1e9 ? 'LY' : G] = +e.toFixed(3);
    }
    console.log(`  N=${N}: ${row.join('  ')}`);
  }

  // Role adjustment: scale baseline usage-driven rates by the change in usage.
  console.log('\nRole adjustment (baseline x usage change), fitted K; all players / usage moved 3+ pts:');
  for (const N of NS) {
    const row = [];
    for (const k of USG_STATS) {
      const K = out.stats[k][N].bestK, plain = err(N, k, K), role = fit(N, k, { role: true });
      row.push(`${k} ${plain.toFixed(3)}→${role.e.toFixed(3)}(K ${kTxt(role.K)})`);
      (out.role[N] || (out.role[N] = {}))[k] = { plain: +plain.toFixed(3), role: +role.e.toFixed(3), K: role.K };
    }
    console.log(`  N=${N}: ${row.join('  ')}`);
    const keep = S[N]; S[N] = keep.filter(s => Math.abs(usgOf(s.early) - usgOf(baseOf(s, .5))) >= .03);
    const sub = USG_STATS.map(k => { const K = out.stats[k][N].bestK; return `${k} ${err(N, k, K).toFixed(3)}→${fit(N, k, { role: true }).e.toFixed(3)}`; });
    console.log(`        usage moved (${S[N].length}): ${sub.join('  ')}`);
    S[N] = keep;
  }
  fs.writeFileSync('data/backtest.json', JSON.stringify(out, null, 1));
  console.log('\ndata/backtest.json written');
})().catch(e => { console.error(e); process.exit(1); });

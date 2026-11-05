/* Backtest: a stand-in baseline for players with none (rookies, and anyone under 200 minutes
 * over the two seasons before). Today their Proj is just their own numbers so far.
 *
 * Usage:  node backtest-rookie.js [seasons]   default 3 test seasons, ending with the last completed one
 * Writes: data/backtest-rookie.json (summary and the fitted priors); prints the tables.
 * Box scores come from .cache/season-YYYY.json (the same cache as backtest.js).
 *
 * Sample (per test season Y): players with under 200 minutes in Y-1 and Y-2 together and at least
 * N + 20 games in Y. The first N games are "this season so far", the rest of Y is the truth.
 * Prior = the pooled per-minute rates and shooting % of the same kind of player in the OTHER test
 * seasons (leave one season out, so a season never helps predict itself), by:
 *   POS    position group (G / F / C)
 *   POSMIN position group x role in his first N games (25+ mpg = featured, under 25 = bench)
 * Predicted rate = (first-N count + prior rate x K) / (first-N minutes or attempts + K), K fitted
 * on the other seasons and scored on the held-out one. RAW = K 0, today's Proj for these players.
 * Error = squared gap to the rest-of-season rate, weighted by rest-of-season minutes (attempts for
 * shooting %); RMSE per 36 (% points for shooting).
 * Minutes: rest-of-season mpg predicted by first-N mpg (today) vs first-N mpg x a drift factor
 * fitted on the other seasons (rookies' roles tend to grow), overall and by role.
 */
const fs = require('fs');
const { loadGames } = require('./build-rankings.js');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NSEAS = +process.argv[2] || 3;
const NS = [5, 8, 12, 20], REST_MIN = 20, NOBASE = 200, FEAT = 25;
const KS = [0, 25, 50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800, 2500, 4000];
const RATE = ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fga', 'fta', 'tpa'];
const PCT = { fg: ['fgm', 'fga'], ft: ['ftm', 'fta'], tp: ['tpm', 'tpa'] };
const STATS = [...RATE, ...Object.keys(PCT)];
const F = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpa'];
const label = y => `${y - 1}-${String(y).slice(2)}`;
const grp = p => /C/.test(p) ? 'C' : /F/.test(p) ? 'F' : /G/.test(p) ? 'G' : 'F';
const zero = () => Object.fromEntries(F.map(k => [k, 0]));
const add = (a, r, w = 1) => { for (const k of F) a[k] += (r[k] || 0) * w; return a; };
const byPlayer = games => { const by = {}; for (const g of [...games].sort((a, b) => a.date < b.date ? -1 : 1)) for (const r of g.rows) (by[r.id] || (by[r.id] = [])).push(r); return by; };

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const last = cur - 1, tests = [...Array(NSEAS)].map((_, i) => last - i).reverse();
  const need = [...new Set(tests.flatMap(y => [y, y - 1, y - 2]))].sort();
  const P = {};
  for (const y of need) { P[y] = byPlayer(await loadGames(`${y}-05-01`, `.cache/season-${y}.json`)); console.log(`${label(y)}: ${Object.keys(P[y]).length} players`); }
  const minOf = (y, id) => (P[y] && P[y][id] || []).reduce((a, r) => a + r.min, 0);

  // Samples: S[y][N] = [{ id, pos, e (first N), r (rest), feat, restGp }]
  const S = {}, all = {};
  for (const y of tests) {
    S[y] = {}; all[y] = [];
    for (const N of NS) S[y][N] = [];
    for (const [id, rs] of Object.entries(P[y])) {
      if (minOf(y - 1, id) + minOf(y - 2, id) >= NOBASE) continue;
      const pos = grp(rs.map(r => r.pos).filter(Boolean).pop() || '');
      all[y].push({ id, pos, t: rs.reduce((a, r) => add(a, r), zero()), gp: rs.length });
      for (const N of NS) {
        if (rs.length < N + REST_MIN) continue;
        const e = rs.slice(0, N).reduce((a, r) => add(a, r), zero()), r = rs.slice(N).reduce((a, r) => add(a, r), zero());
        S[y][N].push({ id, pos, e, r, feat: e.min / N >= FEAT ? 'feat' : 'bench', restGp: rs.length - N, N });
      }
    }
    console.log(`${label(y)}: ${all[y].length} players without a baseline; samples ${NS.map(N => `N=${N}:${S[y][N].length}`).join(' ')}`);
  }

  // Priors from the given seasons' no-baseline players: pooled totals by key. Full seasons (all
  // their games), only players with 300+ minutes so cameo garbage time doesn't set the rates.
  // POSMIN's role comes from each player's season mpg (25+ = featured).
  function prior(ys, kind) {
    const T = {};
    for (const y of ys) for (const p of all[y]) {
      if (p.t.min < 300) continue;
      const key = kind === 'POS' ? p.pos : `${p.pos}|${p.t.min / p.gp >= FEAT ? 'feat' : 'bench'}`;
      add(T[key] || (T[key] = zero()), p.t);
    }
    return T;
  }
  const keyOf = (s, kind) => kind === 'POS' ? s.pos : `${s.pos}|${s.feat}`;
  function sse(ys, N, k, K, kind, PR) {
    let se = 0, wt = 0;
    for (const y of ys) for (const s of S[y][N]) {
      const { e, r } = s, b = PR && (PR[keyOf(s, kind)] || PR[s.pos]);
      if (PCT[k]) {
        const [m, a] = PCT[k]; if (!r[a]) continue;
        const pr = b && b[a] ? b[m] / b[a] : 0, w = b && b[a] ? K : 0;
        if (e[a] + w <= 0) continue;
        se += r[a] * ((e[m] + pr * w) / (e[a] + w) - r[m] / r[a]) ** 2; wt += r[a];
      } else {
        if (!r.min) continue;
        const pr = b && b.min ? b[k] / b.min : 0, w = b && b.min ? K : 0;
        se += r.min * ((e[k] + pr * w) / (e.min + w) - r[k] / r.min) ** 2; wt += r.min;
      }
    }
    return { se, wt };
  }
  const scale = k => PCT[k] ? 100 : 36;

  const out = { tests: tests.map(label), ns: NS, samples: {}, loso: {}, pooledK: {}, priors: {}, minutes: {} };
  for (const N of NS) out.samples[N] = tests.map(y => S[y][N].length);
  console.log('\n== Out of sample (fit K on the other seasons, score the held-out one): RMSE, % vs RAW (negative = better)');
  console.log('stat   N    RAW        POS              POSMIN           fitted K per fold (POS | POSMIN)');
  for (const k of STATS) {
    out.loso[k] = {};
    for (const N of NS) {
      const acc = { RAW: [0, 0], POS: [0, 0], POSMIN: [0, 0] }, ks = { POS: [], POSMIN: [] };
      for (const y of tests) {
        const train = tests.filter(t => t !== y);
        const raw = sse([y], N, k, 0, 'POS', null); acc.RAW[0] += raw.se; acc.RAW[1] += raw.wt;
        for (const kind of ['POS', 'POSMIN']) {
          const PR = prior(train, kind);
          // fit K on the training seasons, with priors built without the season being scored
          let best = null;
          for (const K of KS) {
            let se = 0, wt = 0;
            for (const t of train) { const PRt = prior(tests.filter(x => x !== t && x !== y), kind); const v = sse([t], N, k, K, kind, PRt); se += v.se; wt += v.wt; }
            const e = se / wt; if (Number.isFinite(e) && (!best || e < best.e)) best = { K, e };
          }
          ks[kind].push(best.K);
          const v = sse([y], N, k, best.K, kind, PR); acc[kind][0] += v.se; acc[kind][1] += v.wt;
        }
      }
      const r = x => Math.sqrt(x[0] / x[1]) * scale(k), base = r(acc.RAW);
      out.loso[k][N] = { RAW: +base.toFixed(3) };
      for (const kind of ['POS', 'POSMIN']) out.loso[k][N][kind] = { rmse: +r(acc[kind]).toFixed(3), vsRaw: +((r(acc[kind]) / base - 1) * 100).toFixed(1), folds: ks[kind] };
      if (N === 8 || N === 20) console.log(`${k.padEnd(6)} ${String(N).padEnd(3)} ${base.toFixed(3).padStart(7)}   ` + ['POS', 'POSMIN'].map(kind => { const o = out.loso[k][N][kind]; return `${o.rmse.toFixed(3)} (${o.vsRaw >= 0 ? '+' : ''}${o.vsRaw}%)`.padEnd(17); }).join('') + `${ks.POS.join(',')} | ${ks.POSMIN.join(',')}`);
    }
    // K for the build: pooled over all test seasons, priors leave-one-out, per N
    out.pooledK[k] = {};
    for (const kind of ['POS', 'POSMIN']) {
      out.pooledK[k][kind] = {};
      for (const N of NS) {
        let best = null;
        for (const K of KS) { let se = 0, wt = 0; for (const t of tests) { const v = sse([t], N, k, K, kind, prior(tests.filter(x => x !== t), kind)); se += v.se; wt += v.wt; } const e = se / wt; if (!best || e < best.e) best = { K, e }; }
        out.pooledK[k][kind][N] = best.K;
      }
    }
  }
  // The priors themselves (all test seasons), per 36 and shooting %, for the build and for reading.
  for (const kind of ['POS', 'POSMIN']) {
    const PR = prior(tests, kind); out.priors[kind] = {};
    for (const [key, t] of Object.entries(PR)) {
      out.priors[kind][key] = { min: Math.round(t.min), ...Object.fromEntries(RATE.map(k => [k, +(t[k] * 36 / t.min).toFixed(2)])),
        fg: +(100 * t.fgm / t.fga).toFixed(1), ft: +(100 * t.ftm / t.fta).toFixed(1), tp: +(100 * t.tpm / t.tpa).toFixed(1) };
    }
  }
  console.log('\n== Priors (per 36; shooting %), from all test seasons:');
  for (const [key, p] of Object.entries(out.priors.POSMIN)) console.log(`  ${key.padEnd(8)} ${p.min} min  ` + RATE.map(k => `${k} ${p[k]}`).join(' ') + `  fg ${p.fg} ft ${p.ft} 3p ${p.tp}`);

  // Minutes: does a rookie's role grow after his first N games?
  console.log('\n== Minutes: rest-of-season mpg from first-N mpg; RMSE (mpg), today vs a fitted drift factor (out of sample)');
  for (const N of NS) {
    out.minutes[N] = {};
    for (const role of ['all', 'feat', 'bench']) {
      let s0 = 0, s1 = 0, n = 0; const fs_ = [];
      for (const y of tests) {
        const pick = ys => ys.flatMap(t => S[t][N]).filter(s => role === 'all' || s.feat === role);
        const tr = pick(tests.filter(t => t !== y)), te = pick([y]);
        const f = tr.reduce((a, s) => a + s.r.min / s.restGp, 0) / Math.max(1e-9, tr.reduce((a, s) => a + s.e.min / N, 0)); fs_.push(+f.toFixed(3));
        for (const s of te) { const m0 = s.e.min / N, t = s.r.min / s.restGp; s0 += (m0 - t) ** 2; s1 += (m0 * f - t) ** 2; n++; }
      }
      const e0 = Math.sqrt(s0 / n), e1 = Math.sqrt(s1 / n);
      out.minutes[N][role] = { n, today: +e0.toFixed(2), drift: +e1.toFixed(2), vsToday: +((e1 / e0 - 1) * 100).toFixed(1), factor: fs_ };
      console.log(`  N=${String(N).padEnd(3)} ${role.padEnd(6)} n=${String(n).padEnd(4)} today ${e0.toFixed(2)}  drift ${e1.toFixed(2)} (${e1 <= e0 ? '' : '+'}${((e1 / e0 - 1) * 100).toFixed(1)}%)  factor per fold ${fs_.join(', ')}`);
    }
  }
  fs.writeFileSync('data/backtest-rookie.json', JSON.stringify(out, null, 1));
  console.log('\ndata/backtest-rookie.json written');
})().catch(e => { console.error(e); process.exit(1); });

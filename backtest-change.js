/* Backtest: when is a change in a player's numbers real? ("same player or changed player")
 *
 * Usage:  node backtest-change.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-change.js --mock   synthetic seasons, to check the script runs
 * Writes: data/backtest-change.json; prints the tables.
 *
 * Today Proj blends every rate toward the baseline with a fixed weight K (build-rankings.js
 * PRIOR): rate = (this season's count + baseline rate x K) / (this season's minutes + K). The
 * pull-back is the same share whether the change is small or huge, steady or streaky.
 *
 * Models scored here, per stat (the 11 rates Proj blends), at checkpoints of 5 to 40 games:
 *   today   fixed K as in build-rankings.js
 *   refit   fixed K refitted here (so a gain below isn't just a better K)
 *   mix     two explanations: "same player" (true rate near the baseline, weight Ks) or
 *           "changed player" (true rate free to move, small weight Kc). Prior odds pi of a
 *           change. The early numbers update the odds (how far from the baseline, given how much
 *           we've seen), and Proj = the odds-weighted mix of the two blends. A small change
 *           stays "same" (pulled back like today); a big one flips to "changed".
 *           With pi = 0 this is exactly today's formula, so it can only win by finding changes.
 *   steady  mix, with night-to-night steadiness: a player who beats his old rate nearly every
 *           game counts as stronger evidence than one with a couple of huge nights and the rest
 *           normal (his game-to-game spread vs the typical player's). Counting stats only:
 *           shooting % is makes vs attempts either way.
 *   cause   steady, with separate prior odds when his role moved (minutes 4+ a game off last
 *           season, or usage 3+ points): a new coach or role makes a real change likelier.
 * Fitted on two seasons and scored on the third, each in turn (out of sample), pooled over all
 * checkpoints, so one set of numbers has to work at any point in the season. Error = squared gap
 * to the rest-of-season rate, weighted by rest-of-season minutes (attempts for shooting %).
 *
 * "Confirmed" check: a change is Confirmed when the model puts its odds of being real at 80%+
 * and it is meaningful (15%+ of the baseline rate, or 3+ points of FG%/FT%/3P%). Held = the rest
 * of the season kept at least half of the early change, in the same direction. Compared with
 * changes just as big that the model did NOT confirm (odds under 50%).
 */
const fs = require('fs');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NS = [5, 8, 12, 20, 30, 40], REST_MIN = 20, BASE_MIN = 500, PREV_W = .5;
const CUR = { fga: 150, tpa: 200, fta: 450, reb: 450, ast: 250, to: 600, stl: 1200, blk: 500, fg: 450, tp: 500, ft: 200 };
const RATE = ['fga', 'tpa', 'fta', 'reb', 'ast', 'stl', 'blk', 'to'];
const PCT = { fg: ['fgm', 'fga'], ft: ['ftm', 'fta'], tp: ['tpm', 'tpa'] };
const STATS = [...RATE, ...Object.keys(PCT)];
const NAME = { fga: 'FGA', tpa: '3PA', fta: 'FTA', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO', fg: 'FG%', ft: 'FT%', tp: '3P%' };
const F = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpa', 'use', 'tpos'];
const KS_MULT = [.5, 1, 1.5, 2, 3, 5];          // "same player" weight, x today's K
const KC_MULT = [.03, .07, .15, .3];             // "changed player" weight, x today's K
const PIS = [.02, .05, .1, .2, .35, .5];         // prior odds of a real change
const KS_FIT = [25, 50, 100, 150, 200, 300, 450, 600, 900, 1200, 1800, 2500, 4000];
const CONF = .8, N0 = 6;                         // Confirmed at 80%+; steadiness shrunk with 6 games
const label = y => `${y - 1}-${String(y).slice(2)}`;
const zero = () => Object.fromEntries(F.map(k => [k, 0]));
const add = (a, r, w = 1) => { for (const k of F) a[k] += (r[k] || 0) * w; return a; };
const usg = t => t.tpos ? t.use / t.tpos : 0;

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

function analyze(G, tests) {
  const TOT = Object.fromEntries(Object.keys(G).map(y => [y, totalsOf(G[y])]));
  // League-average per-minute rates (variance floor, so a guard with ~0 blocks doesn't divide by 0).
  const lg = {};
  for (const k of RATE) { let c = 0, m = 0; for (const y of tests) for (const t of Object.values(TOT[y])) { c += t[k]; m += t.min; } lg[k] = c / m; }

  // One sample per player, season and checkpoint, with everything each model needs per stat.
  const S = {};
  for (const y of tests) {
    S[y] = [];
    for (const [id, rs] of Object.entries(rowsByPlayer(G[y]))) {
      const b1 = TOT[y - 1] && TOT[y - 1][id]; if (!b1 || b1.min < BASE_MIN) continue;
      const b = add(zero(), b1); const b2 = TOT[y - 2] && TOT[y - 2][id]; if (b2) add(b, b2, PREV_W);
      for (const N of NS) {
        if (rs.length < N + REST_MIN) continue;
        const eg = rs.slice(0, N), e = eg.reduce((a, r) => add(a, r), zero()), r = rs.slice(N).reduce((a, r) => add(a, r), zero());
        const dm = e.min / N - b1.min / b1.gp, du = usg(e) - usg(b);
        const s = { y, id, name: rs[rs.length - 1].name, N, cause: Math.abs(dm) >= 4 || Math.abs(du) >= .03, restMpg: r.min / (rs.length - N), st: {} };
        for (const k of RATE) {
          if (!r.min || !b.min || !e.min) continue;
          const br = b[k] / b.min, x = e[k] / e.min, m = e.min, fl = Math.max(br, .1 * lg[k]);
          // Night-to-night spread of his rate (ratio estimator), relative to a Poisson at his own rate.
          let ve = 0; for (const g of eg) ve += (g[k] - x * g.min) ** 2; ve = ve / m ** 2 * N / (N - 1);
          s.st[k] = { br, x, m, cap: b.min, fl, d: ve / (Math.max(x, .1 * lg[k]) / m), truth: r[k] / r.min, wt: r.min };
        }
        for (const [k, [mk, ak]] of Object.entries(PCT)) {
          if (!r[ak] || !b[ak]) continue;
          const br = b[mk] / b[ak], x = e[ak] ? e[mk] / e[ak] : br;
          s.st[k] = { br, x, m: e[ak], cap: b[ak], fl: Math.min(Math.max(br, .05), .95), pct: 1, truth: r[mk] / r[ak], wt: r[ak] };
        }
        S[y].push(s);
      }
    }
  }
  // Typical night-to-night spread per stat (training seasons), to judge each player's steadiness.
  const dbar = (ys, k) => { let a = 0, n = 0; for (const y of ys) for (const s of S[y]) { const t = s.st[k]; if (t && !t.pct && Number.isFinite(t.d)) { a += t.d; n++; } } return n ? a / n : 1; };

  // Proj for one stat under parameters p = { Ks, Kc, pi, piC, steady, db }. Returns [proj, odds of change].
  function pred(t, s, p) {
    const ks = Math.min(p.Ks, t.cap);
    if (!p.pi && !p.piC) return [(t.x * t.m + t.br * ks) / (t.m + ks), 0];
    if (!t.m) return [t.br, 0];
    const kc = Math.min(p.Kc, t.cap), unit = t.pct ? t.fl * (1 - t.fl) : t.fl;
    let D = 1;
    if (p.steady && !t.pct && Number.isFinite(t.d) && s.N > 1) D = ((s.N - 1) * t.d / p.db + N0) / (s.N - 1 + N0);
    const v = unit / t.m * D, ts = unit / ks, tc = unit / kc, dx = t.x - t.br;
    const ls = -.5 * Math.log(ts + v) - dx * dx / (2 * (ts + v)), lc = -.5 * Math.log(tc + v) - dx * dx / (2 * (tc + v));
    const pi = s.cause && p.piC != null ? p.piC : p.pi;
    const P = 1 / (1 + (1 - pi) / pi * Math.exp(ls - lc));
    const ms = t.br + ts / (ts + v) * dx, mc = t.br + tc / (tc + v) * dx;
    return [(1 - P) * ms + P * mc, P];
  }
  function sse(ys, k, p, filt) {
    let se = 0, wt = 0;
    for (const y of ys) for (const s of S[y]) { const t = s.st[k]; if (!t || (filt && !filt(s, t))) continue; se += t.wt * (pred(t, s, p)[0] - t.truth) ** 2; wt += t.wt; }
    return { se, wt };
  }
  const grid = (k, kind, db) => {
    const out = [];
    if (kind === 'refit') for (const K of KS_FIT) out.push({ Ks: K });
    else for (const a of KS_MULT) for (const c of KC_MULT) for (const pi of PIS) {
      if (kind === 'cause') for (const piC of PIS) out.push({ Ks: CUR[k] * a, Kc: CUR[k] * c, pi, piC, steady: !PCT[k], db });
      else out.push({ Ks: CUR[k] * a, Kc: CUR[k] * c, pi, steady: kind === 'steady' && !PCT[k], db });
    }
    return out;
  };
  const fit = (ys, k, kind) => { const db = dbar(ys, k); let best = null; for (const p of grid(k, kind, db)) { const e = sse(ys, k, p).se; if (!best || e < best.e) best = { p, e }; } return best.p; };

  const KINDS = ['today', 'refit', 'mix', 'steady', 'cause'];
  const big = (s, t) => Math.abs(t.x - t.br) >= (t.pct ? .03 : .15 * t.br);
  const scale = k => PCT[k] ? 100 : 36;
  const out = { tests: tests.map(label), checkpoints: NS, note: 'RMSE per 36 minutes (percentage points for shooting); gain = % less error than today, out of sample', stats: {}, confirmed: {}, examples: [] };
  console.log('\n== Out of sample, all checkpoints pooled: error (per 36; % pts for shooting), and % less error than today');
  console.log('stat   today    refit          mix            steady         cause          | big changes only: today -> best');
  const params = {};   // [stat][kind][test season] = fitted parameters
  for (const k of STATS) {
    params[k] = {}; const tot = {}, bigT = {}, byN = {};
    for (const kind of KINDS) {
      params[k][kind] = {}; let se = 0, wt = 0, bs = 0, bw = 0; byN[kind] = {};
      for (const y of tests) {
        const train = tests.filter(t => t !== y);
        const p = kind === 'today' ? { Ks: CUR[k] } : fit(train, k, kind); params[k][kind][y] = p;
        const a = sse([y], k, p), bg = sse([y], k, p, big); se += a.se; wt += a.wt; bs += bg.se; bw += bg.wt;
        for (const N of NS) { const n = sse([y], k, p, s => s.N === N), o = byN[kind][N] || (byN[kind][N] = { se: 0, wt: 0 }); o.se += n.se; o.wt += n.wt; }
      }
      tot[kind] = Math.sqrt(se / wt) * scale(k); bigT[kind] = Math.sqrt(bs / bw) * scale(k);
      for (const N of NS) byN[kind][N] = Math.sqrt(byN[kind][N].se / byN[kind][N].wt) * scale(k);
    }
    const g = kind => (1 - tot[kind] / tot.today) * 100, gb = kind => (1 - bigT[kind] / bigT.today) * 100;
    const bestK = KINDS.slice(1).reduce((a, b) => tot[b] < tot[a] ? b : a);
    out.stats[k] = {
      error: Object.fromEntries(KINDS.map(c => [c, +tot[c].toFixed(3)])), gainPct: Object.fromEntries(KINDS.slice(1).map(c => [c, +g(c).toFixed(1)])),
      bigChanges: { error: Object.fromEntries(KINDS.map(c => [c, +bigT[c].toFixed(3)])), gainPct: Object.fromEntries(KINDS.slice(1).map(c => [c, +gb(c).toFixed(1)])) },
      byCheckpoint: Object.fromEntries(NS.map(N => [N, Object.fromEntries(KINDS.map(c => [c, +byN[c][N].toFixed(3)]))])),
      best: bestK, folds: Object.fromEntries(KINDS.slice(2).map(c => [c, tests.map(y => { const p = params[k][c][y]; return { Ks: p.Ks, Kc: p.Kc, pi: p.pi, piCause: p.piC }; })])),
    };
    const f = (kind) => `${tot[kind].toFixed(3)} (${g(kind) >= 0 ? '+' : ''}${g(kind).toFixed(1)}%)`.padEnd(15);
    console.log(`${NAME[k].padEnd(6)} ${tot.today.toFixed(3).padEnd(8)} ${f('refit')}${f('mix')}${f('steady')}${f('cause')}| ${bigT.today.toFixed(3)} -> ${bigT[bestK].toFixed(3)} (${gb(bestK) >= 0 ? '+' : ''}${gb(bestK).toFixed(1)}%, ${bestK})`);
  }
  console.log('\n== By checkpoint: % less error than today for the best model per stat (5 / 8 / 12 / 20 / 30 / 40 games)');
  for (const k of STATS) { const b = out.stats[k].best, c = out.stats[k].byCheckpoint; console.log(`${NAME[k].padEnd(6)} ${b.padEnd(7)} ${NS.map(N => ((1 - c[N][b] / c[N].today) * 100).toFixed(1).padStart(6)).join(' ')}`); }

  // Confirmed check, with each held-out season's own fitted parameters (the "cause" model, the
  // fullest one; the odds it gives are what a Confirmed tag would show).
  console.log(`\n== "Confirmed" (odds ${CONF * 100}%+ and a meaningful change): how often the rest of the season kept half the change`);
  console.log('stat   confirmed: n  held   | big, not confirmed: n  held   | confirmed by checkpoint (5-8 / 12-20 / 30-40): held');
  const bucket = N => N <= 8 ? 0 : N <= 20 ? 1 : 2;
  for (const k of STATS) {
    const c = { n: 0, h: 0, b: [[0, 0], [0, 0], [0, 0]], up: [0, 0], dn: [0, 0] }, u = { n: 0, h: 0 };
    for (const y of tests) for (const s of S[y]) {
      const t = s.st[k]; if (!t || !big(s, t)) continue;
      const [proj, P] = pred(t, s, params[k].cause[y]), dx = t.x - t.br, held = Math.sign(t.truth - t.br) === Math.sign(dx) && Math.abs(t.truth - t.br) >= .5 * Math.abs(dx);
      if (P >= CONF) {
        c.n++; c.h += held; c.b[bucket(s.N)][0]++; c.b[bucket(s.N)][1] += held; const d = dx > 0 ? c.up : c.dn; d[0]++; d[1] += held;
        if (y === tests[tests.length - 1] && s.N === 12) out.examples.push({ name: s.name, stat: NAME[k], odds: +P.toFixed(2), held,
          ...(PCT[k] ? { unit: '%', baseline: +(t.br * 100).toFixed(1), first12: +(t.x * 100).toFixed(1), restOfSeason: +(t.truth * 100).toFixed(1), projToday: +(((t.x * t.m + t.br * Math.min(CUR[k], t.cap)) / (t.m + Math.min(CUR[k], t.cap))) * 100).toFixed(1), projNew: +(proj * 100).toFixed(1) }
            : { unit: 'per game at his rest-of-season minutes', baseline: +(t.br * s.restMpg).toFixed(1), first12: +(t.x * s.restMpg).toFixed(1), restOfSeason: +(t.truth * s.restMpg).toFixed(1), projToday: +(((t.x * t.m + t.br * Math.min(CUR[k], t.cap)) / (t.m + Math.min(CUR[k], t.cap))) * s.restMpg).toFixed(1), projNew: +(proj * s.restMpg).toFixed(1) }) });
      } else if (P < .5) { u.n++; u.h += held; }
    }
    const pc = (h, n) => n ? `${Math.round(h / n * 100)}%` : '-';
    out.confirmed[k] = { confirmed: c.n, heldPct: c.n ? +(c.h / c.n * 100).toFixed(1) : null, up: { n: c.up[0], heldPct: c.up[0] ? +(c.up[1] / c.up[0] * 100).toFixed(1) : null }, down: { n: c.dn[0], heldPct: c.dn[0] ? +(c.dn[1] / c.dn[0] * 100).toFixed(1) : null },
      byCheckpoint: c.b.map(([n, h]) => ({ n, heldPct: n ? +(h / n * 100).toFixed(1) : null })), notConfirmed: u.n, notConfirmedHeldPct: u.n ? +(u.h / u.n * 100).toFixed(1) : null };
    console.log(`${NAME[k].padEnd(6)} ${String(c.n).padStart(12)}  ${pc(c.h, c.n).padStart(4)}   | ${String(u.n).padStart(21)}  ${pc(u.h, u.n).padStart(4)}   | ${c.b.map(([n, h]) => `${pc(h, n)} (${n})`).join(' / ')}`);
  }
  out.examples.sort((a, b) => b.odds - a.odds); out.examples = out.examples.slice(0, 40);
  console.log(`\n== Examples, ${label(tests[tests.length - 1])} after 12 games (Confirmed, highest odds first)`);
  for (const e of out.examples.slice(0, 20)) console.log(`  ${e.name.padEnd(24)} ${e.stat.padEnd(4)} odds ${e.odds.toFixed(2)}  base ${e.baseline}  first 12 ${e.first12}  rest ${e.restOfSeason}  Proj today ${e.projToday} -> new ${e.projNew}  ${e.held ? 'held' : 'faded'}`);
  return out;
}

// Synthetic seasons for --mock: 300 players, some with a real change, some on a hot streak.
function mockSeasons(years) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pois = l => { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const bin = (n, p) => { let c = 0; for (let i = 0; i < n; i++) c += rnd() < p; return c; };
  const P = [...Array(300)].map((_, i) => ({ id: String(i), name: `Player ${i}`, team: `T${i % 30}`, base: { reb: .1 + rnd() * .25, ast: .05 + rnd() * .25, stl: .02 + rnd() * .03, blk: .01 + rnd() * .05, to: .04 + rnd() * .06, fga: .3 + rnd() * .3, tpa: .05 + rnd() * .25, fta: .05 + rnd() * .2, fg: .42 + rnd() * .12, tp: .3 + rnd() * .1, ft: .65 + rnd() * .25 }, mpg: 18 + rnd() * 18 }));
  const G = {};
  for (const y of years) {
    const games = [];
    for (const p of P) { p.r = { ...p.base }; if (rnd() < .15) for (const k of ['ast', 'reb', 'fga']) p.r[k] *= .6 + rnd() * .9; }
    for (let g = 0; g < 70; g++) {
      const rows = P.map(p => {
        const min = Math.max(4, Math.round(p.mpg + (rnd() - .5) * 10)), c = k => pois(p.r[k] * min);
        const fga = c('fga'), tpa = Math.min(fga, c('tpa')), fta = c('fta'), tpm = bin(tpa, p.r.tp), fgm = tpm + bin(fga - tpa, p.r.fg), ftm = bin(fta, p.r.ft);
        return { id: p.id, name: p.name, team: p.team, min, reb: c('reb'), ast: c('ast'), stl: c('stl'), blk: c('blk'), to: c('to'), fga, fgm, tpa, tpm, fta, ftm, pts: 2 * fgm + tpm + ftm };
      });
      games.push({ date: `${y}-01-${String(g).padStart(3, '0')}`, rows });
    }
    G[y] = games;
  }
  return G;
}

(async () => {
  let G, tests;
  if (MOCK) { const ys = [2021, 2022, 2023, 2024, 2025]; G = mockSeasons(ys); tests = [2023, 2024, 2025]; }
  else {
    const { loadGames } = require('./build-rankings.js');
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
    const last = cur - 1; tests = [last - 2, last - 1, last]; G = {};
    for (const y of [last - 4, last - 3, ...tests]) { G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
  }
  const out = analyze(G, tests);
  if (!MOCK) { fs.writeFileSync('data/backtest-change.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-change.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

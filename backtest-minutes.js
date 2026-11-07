/* Backtest: how should Proj's minutes weigh recent games?
 *
 * Usage:  node backtest-minutes.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-minutes.js --mock   synthetic seasons, to check the script runs
 * Writes: data/backtest-minutes.json; prints the tables.
 *
 * Today: minutes = (this season's minutes + last season's mpg x 5) / (games + 5), every game this
 * season counting the same. Scored here against:
 *   season   this season only (no last season)
 *   rollN    the last N games only (3, 5, 8, 10, 15), optionally nudged by G games of last season
 *   fade     every game this season, recent ones weighted more: a game h games back counts half as
 *            much (h = 3, 5, 8, 12, 20), nudged by G games of last season (0, 1, 2, 3, 5)
 *   role     today's, but with last season counting only g games (0, 1, 2) once this season's mpg
 *            is 5+ off last season's (a role change)
 *   fade+role  both
 * Players: 500+ minutes last season. Checkpoints after 5, 8, 12, 20, 30 and 45 games played.
 * Truth: minutes per game played over (a) the next 10 games and (b) the rest of the season (10+
 * games needed). Each model's settings are fitted on two seasons and scored on the third, each in
 * turn (out of sample). Also scored on role changers alone (this season 5+ off last season).
 */
const fs = require('fs');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NS = [5, 8, 12, 20, 30, 45], AHEAD = 10, BASE_MIN = 500, ROLE = 5;
const label = y => `${y - 1}-${String(y).slice(2)}`;

function byPlayer(games) {
  const by = {};
  for (const g of [...games].sort((a, b) => a.date < b.date ? -1 : 1)) for (const r of g.rows) (by[r.id] || (by[r.id] = [])).push(r.min);
  return by;
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// Model families: each is a list of settings; pred(mins so far, last mpg, settings) -> mpg.
const FAM = {
  today: [{}],
  season: [{}],
  roll: [3, 5, 8, 10, 15].flatMap(n => [0, 1, 3, 5].map(G => ({ n, G }))),
  fade: [3, 5, 8, 12, 20].flatMap(h => [0, 1, 2, 3, 5].map(G => ({ h, G }))),
  role: [0, 1, 2].map(g => ({ g })),
  fadeRole: [3, 5, 8, 12, 20].flatMap(h => [1, 2, 3, 5].flatMap(G => [0, 1].map(g => ({ h, G, g })))),
};
function pred(fam, m, l, p) {
  const N = m.length, s = mean(m);
  if (fam === 'today') return (s * N + 5 * l) / (N + 5);
  if (fam === 'season') return s;
  if (fam === 'roll') { const w = m.slice(-p.n); return (mean(w) * w.length + p.G * l) / (w.length + p.G); }
  if (fam === 'role') { const G = Math.abs(s - l) >= ROLE ? p.g : 5; return (s * N + G * l) / (N + G); }
  // fade / fadeRole: weights 0.5^(age/h); the nudge is G games of last season on the same scale.
  let a = 0, w = 0; for (let i = 0; i < N; i++) { const wi = Math.pow(.5, (N - 1 - i) / p.h); a += wi * m[i]; w += wi; }
  const G = fam === 'fadeRole' && Math.abs(s - l) >= ROLE ? p.g : p.G;
  return (a + G * l) / (w + G);
}

function analyze(G, tests) {
  const S = {};
  for (const y of tests) {
    S[y] = [];
    const prev = byPlayer(G[y - 1]), cur = byPlayer(G[y]);
    for (const [id, m] of Object.entries(cur)) {
      const pm = prev[id]; if (!pm) continue;
      const tot = pm.reduce((a, b) => a + b, 0); if (tot < BASE_MIN) continue;
      const l = tot / pm.length;
      for (const N of NS) {
        if (m.length < N + 10) continue;
        const so = m.slice(0, N);
        S[y].push({ N, so, l, next: mean(m.slice(N, N + AHEAD)), rest: mean(m.slice(N)), role: Math.abs(mean(so) - l) >= ROLE });
      }
    }
  }
  const err = (ys, fam, p, tgt, filt) => { let se = 0, n = 0; for (const y of ys) for (const s of S[y]) { if (filt && !filt(s)) continue; se += (pred(fam, s.so, s.l, p) - s[tgt]) ** 2; n++; } return { se, n }; };
  const out = { tests: tests.map(label), note: 'RMSE in minutes per game, out of sample (fit on two seasons, scored on the third); gain = % less error than today', samples: tests.map(y => S[y].length), targets: {} };
  for (const tgt of ['next', 'rest']) {
    const T = out.targets[tgt] = {};
    console.log(`\n== Target: minutes over the ${tgt === 'next' ? 'next 10 games' : 'rest of the season'} (RMSE, minutes; gain vs today)`);
    console.log('model      all      role changers   by checkpoint (5 / 8 / 12 / 20 / 30 / 45)        settings per fold');
    const base = {};
    for (const fam of Object.keys(FAM)) {
      const acc = { all: [0, 0], role: [0, 0] }, byN = Object.fromEntries(NS.map(N => [N, [0, 0]])), folds = [];
      for (const y of tests) {
        const train = tests.filter(t => t !== y);
        let best = null; for (const p of FAM[fam]) { const e = err(train, fam, p, tgt).se; if (!best || e < best.e) best = { p, e }; }
        folds.push(best.p);
        for (const [g, f] of [['all', null], ['role', s => s.role]]) { const e = err([y], fam, best.p, tgt, f); acc[g][0] += e.se; acc[g][1] += e.n; }
        for (const N of NS) { const e = err([y], fam, best.p, tgt, s => s.N === N); byN[N][0] += e.se; byN[N][1] += e.n; }
      }
      const r = ([se, n]) => Math.sqrt(se / n);
      const row = { all: +r(acc.all).toFixed(3), role: +r(acc.role).toFixed(3), roleSamples: acc.role[1], byCheckpoint: Object.fromEntries(NS.map(N => [N, +r(byN[N]).toFixed(3)])), folds };
      if (fam === 'today') Object.assign(base, row);
      row.gainPct = +((1 - row.all / base.all) * 100).toFixed(1); row.roleGainPct = +((1 - row.role / base.role) * 100).toFixed(1);
      T[fam] = row;
      const g = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
      console.log(`${fam.padEnd(10)} ${row.all.toFixed(2)} ${g(row.gainPct).padStart(7)}  ${row.role.toFixed(2)} ${g(row.roleGainPct).padStart(7)}   ${NS.map(N => row.byCheckpoint[N].toFixed(2)).join(' / ')}   ${folds.map(p => JSON.stringify(p)).join(' ')}`);
    }
    console.log(`  role changers: ${T.today.roleSamples} of ${out.samples.reduce((a, b) => a + b, 0)} checkpoints`);
  }
  return out;
}

function mockSeasons(years) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const P = [...Array(250)].map((_, i) => ({ id: String(i), m: 14 + rnd() * 20 }));
  const G = {};
  for (const y of years) {
    for (const p of P) { if (rnd() < .2) p.m = Math.max(8, Math.min(38, p.m + (rnd() - .5) * 16)); p.shift = rnd() < .15 ? 20 + Math.floor(rnd() * 30) : 0; p.to = p.m + (rnd() - .5) * 12; }
    G[y] = [...Array(70)].map((_, g) => ({ date: `${y}-${String(g).padStart(3, '0')}`, rows: P.map(p => ({ id: p.id, min: Math.max(2, Math.round((p.shift && g >= p.shift ? p.to : p.m) + (rnd() - .5) * 10 - (rnd() < .08 ? 12 : 0))) })) }));
  }
  return G;
}

(async () => {
  let G, tests;
  if (MOCK) { G = mockSeasons([2022, 2023, 2024, 2025]); tests = [2023, 2024, 2025]; }
  else {
    const { loadGames } = require('./build-rankings.js');
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
    const last = cur - 1; tests = [last - 2, last - 1, last]; G = {};
    for (const y of [last - 3, ...tests]) { G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
  }
  const out = analyze(G, tests);
  if (!MOCK) { fs.writeFileSync('data/backtest-minutes.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-minutes.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

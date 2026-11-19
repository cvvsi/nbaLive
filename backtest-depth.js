/* Backtest: rotation depth. Should games a player sat out (coach's decision, rest) count as zeros
 * in his projected minutes, and should last season weigh less when he barely plays this season?
 *
 * Usage:  node backtest-depth.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-depth.js --mock   synthetic seasons, to check the script runs
 * Writes: data/backtest-depth.json; prints the tables.
 *
 * Why (Nov 2026): against EFB's daily projections our biggest minutes gaps were deep-bench players
 * whose projection last season's minutes hold up: Gary Trent Jr. (6 of 14 games, 11.5 mpg, Proj 16.2,
 * EFB 8), Pete Nance (1 game, 4 min, Proj 13.3, EFB 8), O-Max Prosper (8 mpg, Proj 12.8, EFB 8).
 * Proj's minutes (fadeMpg in build-rankings.js) average only the games he played, so a game the
 * coach sat him adds nothing, and 2 games of last season's mpg outweigh a season of few games.
 *
 * The box scores keep only players who played, so a missed game is a team game without him (from
 * his first game for that team; a trade ends the sequence). A run of 1-2 missed games in a row is
 * read as a coach's decision or rest (counted as 0 minutes); 3+ as an absence (injury), left out,
 * as the injury report would leave it out. At a checkpoint a run still going counts only once it's
 * known: 3+ = absence, shorter = left out of the history until it ends.
 *
 * Models (pred from his team games so far and last season's mpg l):
 *   proj     today's Proj: games played only, a game h = 5 back counting half, + 2 games of l
 *   zeros    the same with each short miss as a 0-minute game counting zw as much (fit h, G, zw)
 *   zeros1   zeros fixed at h = 5, G = 2, zw = 1 (the simplest change)
 *   shareG   proj, with last season's G games scaled by his share of available games played
 *   both     zeros + shareG
 * Targets: (a) "avail": minutes per available team game over his team's next 10 (short misses = 0,
 * absences left out; 6+ available games needed), which is what Week, Today and Matchup use the
 * minutes for (they count every game he isn't ruled out of); (b) "played": minutes per game played
 * over the next 10 games (what backtest-minutes.js scores). Checkpoints: after 5, 8, 12, 20, 30 and
 * 45 team games, 3+ games played so far. Settings fitted on two seasons, scored on the third.
 * Groups: all, bench (Proj under 20 minutes), sitters (a short miss in his last 10 team games).
 * Players: 100+ minutes last season (no rookies: they have their own path).
 */
const fs = require('fs');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const TS = [5, 8, 12, 20, 30, 45], AHEAD = 10, LY_MIN = 100, SHORT = 2;
const label = y => `${y - 1}-${String(y).slice(2)}`;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// per player: his team's games in order from his first appearance, each {m: minutes} or {miss}
function sequences(games) {
  const sorted = [...games].sort((a, b) => a.date < b.date ? -1 : 1), teamG = {};
  sorted.forEach((g, gi) => { const ts = new Set(g.rows.map(r => r.team)); for (const t of ts) (teamG[t] || (teamG[t] = [])).push(gi); });
  const played = {}; sorted.forEach((g, gi) => { for (const r of g.rows) (played[r.id] || (played[r.id] = new Map())).set(gi, r); });
  const out = {};
  for (const [id, mp] of Object.entries(played)) {
    const first = [...mp.keys()][0], team = mp.get(first).team, L = teamG[team], k0 = L.indexOf(first), seq = [];
    for (let k = k0; k < L.length; k++) { const r = mp.get(L[k]); if (r && r.team !== team) break; seq.push(r ? { m: r.min } : { miss: 1 }); }
    // run length of each miss over the whole sequence (truth side) and as known so far (pred side)
    for (let i = 0; i < seq.length; i++) if (seq[i].miss) { let j = i; while (j < seq.length && seq[j].miss) j++; for (let q = i; q < j; q++) { seq[q].run = j - i; seq[q].start = i; } i = j - 1; }
    out[id] = { seq, k0 };
  }
  return out;
}
// what's known at index T: played games, and misses whose run is short and over, or already 3+ long
function past(seq, T) {
  const h = [];
  for (let i = 0; i < T; i++) { const e = seq[i];
    if (!e.miss) { h.push({ m: e.m }); continue; }
    const end = e.start + e.run, known = Math.min(end, T) - e.start;
    if (known > SHORT) continue;                 // an absence (3+ in a row): left out
    if (end > T) continue;                       // still going and short so far: not known yet
    h.push({ m: 0, z: 1 });                      // a short miss: a coach's decision or rest
  }
  return h;
}
const FAM = {
  proj: [{ h: 5, G: 2, zw: 0 }],
  zeros: [3, 5, 8].flatMap(h => [0, 1, 2, 3].flatMap(G => [.25, .5, .75, 1].map(zw => ({ h, G, zw })))),
  zeros1: [{ h: 5, G: 2, zw: 1 }],
  shareG: [3, 5, 8].flatMap(h => [2, 3, 5].map(G => ({ h, G, zw: 0, sg: 1 }))),
  both: [3, 5, 8].flatMap(h => [1, 2, 3, 5].flatMap(G => [.5, .75, 1].map(zw => ({ h, G, zw, sg: 1 })))),
};
function pred(h, l, p) {
  let a = 0, w = 0, pl = 0, av = 0; const N = h.length;
  for (let i = 0; i < N; i++) { const k = Math.pow(.5, (N - 1 - i) / p.h), e = h[i];
    av += k; if (!e.z) pl += k;
    const wi = e.z ? k * p.zw : k; a += wi * e.m; w += wi; }
  const G = p.sg ? p.G * (av ? pl / av : 1) : p.G;
  return w + G ? (a + G * l) / (w + G) : l;
}

function analyze(G, tests) {
  const S = {};
  for (const y of tests) {
    S[y] = [];
    const prev = sequences(G[y - 1]), cur = sequences(G[y]);
    for (const [id, { seq, k0 }] of Object.entries(cur)) {
      const ps = prev[id]; if (!ps) continue;
      const pm = ps.seq.filter(e => !e.miss).map(e => e.m), tot = pm.reduce((a, b) => a + b, 0); if (tot < LY_MIN) continue;
      const l = tot / pm.length;
      for (const T0 of TS) {
        const T = T0 - k0; if (T < 3 || T + AHEAD > seq.length) continue;
        const h = past(seq, T); if (h.filter(e => !e.z).length < 3) continue;
        const nx = seq.slice(T, T + AHEAD), av = nx.filter(e => !e.miss || e.run <= SHORT), pl = nx.filter(e => !e.miss);
        if (av.length < 6 || !pl.length) continue;
        const proj = pred(h, l, FAM.proj[0]);
        S[y].push({ T: T0, h, l, avail: mean(av.map(e => e.miss ? 0 : e.m)), played: mean(pl.map(e => e.m)), bench: proj < 20, sit: h.slice(-10).some(e => e.z) });
      }
    }
  }
  const err = (ys, p, tgt, f) => { let se = 0, n = 0, b = 0; for (const y of ys) for (const s of S[y]) { if (f && !f(s)) continue; const d = pred(s.h, s.l, p) - s[tgt]; se += d * d; b += d; n++; } return { se, n, b }; };
  const out = { tests: tests.map(label), note: 'RMSE in minutes, out of sample (fit on two seasons, scored on the third); gain = % less error than proj (today); bias = mean (pred - actual)', samples: tests.map(y => S[y].length), targets: {} };
  const groups = [['all', null], ['bench', s => s.bench], ['sitters', s => s.sit]];
  for (const tgt of ['avail', 'played']) {
    const T = out.targets[tgt] = {};
    console.log(`\n== Target: minutes per ${tgt === 'avail' ? 'available team game (sat-out games = 0)' : 'game played'}, next 10 (RMSE · gain vs proj · bias)`);
    console.log('model     all                     bench (Proj < 20)       sitters                 settings per fold');
    for (const fam of Object.keys(FAM)) {
      const acc = Object.fromEntries(groups.map(([g]) => [g, [0, 0, 0]])), folds = [];
      for (const y of tests) {
        const train = tests.filter(t => t !== y);
        let best = null; for (const p of FAM[fam]) { const e = err(train, p, tgt).se; if (!best || e < best.e) best = { p, e }; }
        folds.push(best.p);
        for (const [g, f] of groups) { const e = err([y], best.p, tgt, f); acc[g][0] += e.se; acc[g][1] += e.n; acc[g][2] += e.b; }
      }
      const row = { folds };
      for (const [g] of groups) { const [se, n, b] = acc[g]; row[g] = { rmse: +Math.sqrt(se / n).toFixed(3), bias: +(b / n).toFixed(2), n }; }
      for (const [g] of groups) row[g].gainPct = T.proj ? +((1 - row[g].rmse / T.proj[g].rmse) * 100).toFixed(1) : 0;
      T[fam] = row;
      const c = g => `${row[g].rmse.toFixed(2)} ${((row[g].gainPct >= 0 ? '+' : '') + row[g].gainPct.toFixed(1) + '%').padStart(6)} ${(row[g].bias >= 0 ? '+' : '') + row[g].bias.toFixed(2)}`.padEnd(24);
      console.log(`${fam.padEnd(9)} ${c('all')}${c('bench')}${c('sitters')}${folds.map(p => JSON.stringify(p)).join(' ')}`);
    }
    console.log(`  checkpoints: ${T.proj.all.n}, bench ${T.proj.bench.n}, sitters ${T.proj.sitters.n}`);
  }
  return out;
}

function mockSeasons(years) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const P = [...Array(300)].map((_, i) => ({ id: String(i), team: 'T' + (i % 10), m: 6 + rnd() * 30 }));
  const G = {};
  for (const y of years) {
    for (const p of P) { if (rnd() < .25) p.m = Math.max(3, Math.min(38, p.m + (rnd() - .5) * 16)); p.sit = p.m < 16 ? .35 : .04; }
    const out = {}; for (const p of P) out[p.id] = 0;
    G[y] = [...Array(80)].map((_, g) => ({ date: `${y}-${String(g).padStart(3, '0')}`, rows: P.filter(p => {
      if (out[p.id] > 0) { out[p.id]--; return false; } if (rnd() < .01) { out[p.id] = 5; return false; } return rnd() > p.sit; })
      .map(p => ({ id: p.id, team: p.team, min: Math.max(1, Math.round(p.m + (rnd() - .5) * 10)) })) }));
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
  if (!MOCK) { fs.writeFileSync('data/backtest-depth.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-depth.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

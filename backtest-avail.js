/* Backtest: how many of his team's remaining games does a healthy player go on to play?
 *
 * Usage:  node backtest-avail.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-avail.js --mock   synthetic seasons, to check the script runs
 * Writes: data/backtest-avail.json; prints the tables.
 *
 * Today the rest-of-season totals (Proj > Season > Total, Build's Rest of season) count every game
 * left for anyone not on the injury report. Nobody plays them all: stars rest, injuries come, and
 * some players miss time every year.
 *
 * Samples: 2023-24 to 2025-26, at each team's 10th, 20th, ... 60th game, every rotation player
 * (15+ minutes a game, 5+ games) who played in one of the team's last 2 games (healthy now).
 * Truth: the share of the team's remaining games he played.
 * Models:
 *   all      1.0, today
 *   mean     the average share at that checkpoint
 *   own      his own record pulled toward that average:
 *            (games played this season + b x last season's games + K x mean)
 *            / (team games this season + b x last season's team games + K)
 *            b and K fitted on two seasons, scored on the third. Last season counts only for
 *            players who were in the league (10+ games).
 * Also the average share by last season's games played, and by minutes (do heavy-minute players
 * miss more?).
 */
const fs = require('fs');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const CPS = [10, 20, 30, 40, 50, 60], MPG = 15, MINGP = 5, BS = [0, .25, .5, 1], KSS = [5, 10, 20, 40, 80, 160];
const label = y => `${y - 1}-${String(y).slice(2)}`;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

function teamGames(games) {
  const by = {};
  for (const g of [...games].sort((a, b) => a.date < b.date ? -1 : 1)) for (const t of new Set(g.rows.map(r => r.team))) (by[t] || (by[t] = [])).push(new Map(g.rows.filter(r => r.team === t).map(r => [r.id, r.min])));
  return by;
}
function samples(games, prev) {
  const by = teamGames(games), lastGp = {}, lastTg = {};
  const pb = teamGames(prev); let ptg = 0;
  for (const gs of Object.values(pb)) { ptg = Math.max(ptg, gs.length); for (const g of gs) for (const id of g.keys()) lastGp[id] = (lastGp[id] || 0) + 1; }
  const S = [];
  for (const [t, gs] of Object.entries(by)) for (const cp of CPS) {
    if (gs.length < cp + 10) continue;
    const gp = {}, mn = {};
    for (const g of gs.slice(0, cp)) for (const [id, m] of g) { gp[id] = (gp[id] || 0) + 1; mn[id] = (mn[id] || 0) + m; }
    const rest = gs.slice(cp), recent = new Set([...gs[cp - 1].keys(), ...gs[cp - 2].keys()]);
    for (const id of recent) {
      if (gp[id] < MINGP || mn[id] / gp[id] < MPG) continue;
      // a player traded away later would look hurt: keep only those who appear again for this team, or never again anywhere
      const played = rest.filter(g => g.has(id)).length;
      S.push({ cp, gp: gp[id], tg: cp, mpg: mn[id] / gp[id], lg: lastGp[id] >= 10 ? lastGp[id] : null, ltg: ptg, y: played / rest.length, n: rest.length });
    }
  }
  return S;
}
const pred = (s, mu, b, K) => { const B = s.lg != null ? b : 0; return (s.gp + B * (s.lg || 0) + K * mu) / (s.tg + B * s.ltg + K); };

function mockSeasons(years) {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const P = []; for (let t = 0; t < 12; t++) for (let i = 0; i < 11; i++) P.push({ id: `${t}_${i}`, team: 'T' + t, m: 34 - i * 2.5, frag: .03 + rnd() * .25 });
  const G = {};
  for (const y of years) { G[y] = []; const hurt = {};
    for (let d = 0; d < 164; d++) { const dt = new Date(Date.UTC(y - 1, 9, 22 + d)).toISOString().slice(0, 10);
      for (let t = 0; t < 12; t += 2) { if (rnd() < .5) continue; const rows = [];
        for (const p of P) { if (p.team !== 'T' + t && p.team !== 'T' + (t + 1)) continue;
          if (hurt[p.id] > 0) { hurt[p.id]--; continue; } if (rnd() < p.frag * .12) { hurt[p.id] = Math.floor(rnd() * 14); continue; }
          rows.push({ id: p.id, name: p.id, team: p.team, min: Math.max(1, Math.round(p.m + (rnd() - .5) * 6)), pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, pf: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, st: 0, pos: 'G' }); }
        G[y].push({ date: dt, rows }); } } }
  return G;
}

(async () => {
  let G, tests;
  if (MOCK) { tests = [2024, 2025, 2026]; G = mockSeasons([2023, ...tests]); }
  else {
    const { loadGames } = require('./build-rankings.js');
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
    const last = cur - 1; tests = [last - 2, last - 1, last]; G = {};
    for (const y of [last - 3, ...tests]) { G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
  }
  const S = Object.fromEntries(tests.map(y => [y, samples(G[y], G[y - 1])]));
  const mu = ys => Object.fromEntries(CPS.map(cp => [cp, mean(ys.flatMap(y => S[y].filter(s => s.cp === cp).map(s => s.y)))]));
  const sse = (ys, f) => { let se = 0, n = 0; for (const y of ys) for (const s of S[y]) { se += (f(s) - s.y) ** 2; n++; } return { se, n }; };
  const acc = { all: { se: 0, n: 0 }, mean: { se: 0, n: 0 }, own: { se: 0, n: 0 } }, folds = [];
  for (const y of tests) {
    const tr = tests.filter(t => t !== y), M = mu(tr);
    let best = null; for (const b of BS) for (const K of KSS) { const e = sse(tr, s => pred(s, M[s.cp], b, K)).se; if (!best || e < best.e) best = { b, K, e }; }
    folds.push({ b: best.b, K: best.K });
    for (const [k, f] of [['all', () => 1], ['mean', s => M[s.cp]], ['own', s => pred(s, M[s.cp], best.b, best.K)]]) { const e = sse([y], f); acc[k].se += e.se; acc[k].n += e.n; }
  }
  const rm = e => Math.sqrt(e.se / e.n), M = mu(tests), allS = tests.flatMap(y => S[y]);
  console.log(`\n== Share of the team's remaining games played by a healthy rotation player (${allS.length} samples)`);
  console.log('after game   ' + CPS.map(c => String(c).padStart(6)).join(''));
  console.log('avg share    ' + CPS.map(c => M[c].toFixed(3).padStart(6)).join(''));
  console.log(`\nRMSE of the share: all games (today) ${rm(acc.all).toFixed(3)}, checkpoint average ${rm(acc.mean).toFixed(3)}, own record ${rm(acc.own).toFixed(3)}   fit per fold: ${folds.map(f => `b=${f.b} K=${f.K}`).join(' / ')}`);
  const bucket = (name, key, edges) => { console.log(`\nby ${name}:`); const o = {};
    for (let i = 0; i < edges.length - 1; i++) { const a = allS.filter(s => s[key] != null && s[key] >= edges[i] && s[key] < edges[i + 1]); if (!a.length) continue; o[`${edges[i]}-${edges[i + 1]}`] = { n: a.length, share: +mean(a.map(s => s.y)).toFixed(3) }; console.log(`  ${String(edges[i]).padStart(3)}-${String(edges[i + 1]).padEnd(3)} ${String(a.length).padStart(5)}  ${mean(a.map(s => s.y)).toFixed(3)}`); }
    return o; };
  const byLast = bucket("last season's games", 'lg', [10, 40, 55, 65, 75, 83]);
  const rook = allS.filter(s => s.lg == null); console.log(`  not in the league last season: ${rook.length}  ${mean(rook.map(s => s.y)).toFixed(3)}`);
  const byMin = bucket('minutes a game', 'mpg', [15, 20, 25, 30, 34, 48]);
  const out = { seasons: tests.map(label), samples: allS.length, note: 'Share of the team\'s remaining games played by a rotation player (15+ min, 5+ games) who played in one of its last 2 games. RMSE out of sample.',
    mean: Object.fromEntries(CPS.map(c => [c, +M[c].toFixed(3)])), rmse: { all: +rm(acc.all).toFixed(3), mean: +rm(acc.mean).toFixed(3), own: +rm(acc.own).toFixed(3) }, fit: folds, byLast, newToLeague: { n: rook.length, share: +mean(rook.map(s => s.y)).toFixed(3) }, byMin };
  if (!MOCK) { fs.writeFileSync('data/backtest-avail.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-avail.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

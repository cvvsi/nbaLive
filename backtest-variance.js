/* Backtest: how noisy is each category from week to week, and what does that do to Value?
 *
 * Usage:  node backtest-variance.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-variance.js --mock   synthetic seasons, to check the script runs
 * Writes: data/backtest-variance.json; prints the tables.
 *
 * Two sources (Nov 2026):
 *   Rosenof, "Static quantification of player value for fantasy basketball" (arXiv 2307.02188):
 *     a z-score divides by how much players differ (sigma). For a weekly head-to-head it should
 *     also count how much one player swings week to week (tau): G = (x - mean) / sqrt(sigma^2 +
 *     kappa * tau^2), kappa = 2N / (2N - 1) for N roster spots. So each z-score is worth
 *     w = sigma / sqrt(sigma^2 + kappa * tau^2) of itself: steals least, assists most.
 *   McElreath, "Statistical Rethinking", 11.3: counts with more spread than a Poisson or a
 *     binomial allows are over-dispersed (something that moves them is left out: minutes, the
 *     opponent, a hot night), and a model that ignores it is too sure of itself.
 *
 * Three tables, each per season (2023-24 to 2025-26) and averaged, for the top-130 pool (10 teams
 * x 13; the same pool as the rankings, by the season's 9-cat value):
 *
 * 1 G weights. Weeks run Mon-Sun; a player's week counts when he played in it (the paper leaves
 *   out injured weeks). sigma^2 = spread across players of the average week, tau^2 = the average
 *   spread of one player's weeks. FG% / FT% use the week's impact (makes - league % x attempts),
 *   which is the paper's volume-weighted form up to a constant. `w` is what the page would
 *   multiply each z-score by; `paper` is the paper's own 2022-23, 12-team number.
 *
 * 2 Game-to-game dispersion (PHI): variance / mean of a player's games, pooled. The Matchup tool,
 *   Build and the props conversion take 2.2 / 1.3 / 1.4 for points / rebounds / assists and 1
 *   (Poisson) for the rest; for FG% / FT% the ratio is against a binomial at his own percentage.
 *
 * 3 Week noise (TBNOISE): a player's week total against his games that week x his per-game
 *   average in every other week, squared, over what today's model expects (games x PHI x mean, or
 *   the binomial), allowing for the average itself being an estimate. 1 = the per-game model
 *   already explains a week; Build uses 1.6 for every category and the Matchup tool 1. This is
 *   noise given the games he played: games missed without notice come on top (`played` = the share
 *   of his team's games he played in the weeks he played at all).
 */
const fs = require('fs');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const CATS = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'to', 'fg', 'ft'];
const POOL = 130, ROSTER = 13, KAPPA = 2 * ROSTER / (2 * ROSTER - 1), MINWK = 8;
const PHI = { pts: 2.2, reb: 1.3, ast: 1.4 };
const PAPER = { pts: .65, reb: .69, ast: .75, tpm: .72, stl: .44, blk: .68, to: .62, fg: .56, ft: .58 };
const label = y => `${y - 1}-${String(y).slice(2)}`;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const vari = a => { const m = mean(a); return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length; };
// Monday of the date's week, as a sortable key. Dates are YYYY-MM-DD or YYYYMMDD.
function weekOf(d) {
  const s = String(d).replace(/-/g, ''), t = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); return t.toISOString().slice(0, 10);
}

function season(games, pool) {
  // lgFG / lgFT over the pool's season, for impact.
  const inPool = new Set(pool), T = { fgm: 0, fga: 0, ftm: 0, fta: 0 };
  for (const g of games) for (const r of g.rows) if (inPool.has(r.id)) for (const k in T) T[k] += r[k];
  const lg = { fg: T.fgm / T.fga, ft: T.ftm / T.fta };
  const val = (r, c) => c === 'fg' ? r.fgm - lg.fg * r.fga : c === 'ft' ? r.ftm - lg.ft * r.fta : r[c];
  // Per player: his games, and per week his rows and his team's game count.
  const P = {}, teamWk = {};
  for (const g of games) {
    const w = weekOf(g.date), teams = new Set(g.rows.map(r => r.team));
    for (const t of teams) teamWk[t + w] = (teamWk[t + w] || 0) + 1;
    for (const r of g.rows) { if (!inPool.has(r.id)) continue;
      const p = P[r.id] || (P[r.id] = { wk: {} }); (p.wk[w] || (p.wk[w] = { rows: [], team: r.team })).rows.push(r); }
  }
  const out = { g: {}, phi: {}, wk: {} };
  let sched = 0, played = 0;
  const players = Object.values(P).map(p => ({ weeks: Object.entries(p.wk).map(([w, o]) => ({ rows: o.rows, n: teamWk[o.team + w] || o.rows.length })) })).filter(p => p.weeks.length >= MINWK);
  for (const p of players) for (const w of p.weeks) { sched += Math.max(w.n, w.rows.length); played += w.rows.length; }
  for (const c of CATS) {
    // 1 G weights
    const mus = [], taus = [];
    for (const p of players) { const tot = p.weeks.map(w => w.rows.reduce((s, r) => s + val(r, c), 0)); mus.push(mean(tot)); taus.push(vari(tot) * tot.length / (tot.length - 1)); }
    const s2 = vari(mus), t2 = mean(taus);
    out.g[c] = { s2, t2, w: Math.sqrt(s2 / (s2 + KAPPA * t2)) };
    // 2 per-game dispersion and 3 week noise
    let vg = 0, mg = 0, se = 0, ex = 0;
    for (const p of players) {
      const rows = p.weeks.flatMap(w => w.rows), n = rows.length;
      const made = c === 'fg' ? 'fgm' : 'ftm', att = c === 'fg' ? 'fga' : 'fta', pct = c === 'fg' || c === 'ft';
      if (pct) {
        const M = rows.reduce((s, r) => s + r[made], 0), A = rows.reduce((s, r) => s + r[att], 0); if (A < 20) continue;
        const q = M / A;
        for (const r of rows) { vg += (r[made] - q * r[att]) ** 2; mg += r[att] * q * (1 - q); }
        for (const w of p.weeks) { const m = w.rows.reduce((s, r) => s + r[made], 0), a = w.rows.reduce((s, r) => s + r[att], 0); if (A - a < 10 || !a) continue;
          const qo = (M - m) / (A - a), v = qo * (1 - qo); se += (m - qo * a) ** 2; ex += v * a * (1 + a / (A - a)); }
      } else {
        const x = rows.map(r => r[c]), m = mean(x), S = m * n; vg += vari(x) * n / (n - 1) * n; mg += S;
        for (const w of p.weeks) { const g = w.rows.length, t = w.rows.reduce((s, r) => s + r[c], 0); if (n - g < 3) continue;
          const mo = (S - t) / (n - g), v = (PHI[c] || 1) * mo; se += (t - g * mo) ** 2; ex += v * g * (1 + g / (n - g)); }
      }
    }
    out.phi[c] = vg / mg; out.wk[c] = se / ex;
  }
  out.players = players.length; out.played = played / sched;
  return out;
}

function mockSeasons(years) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pois = l => { let k = 0, p = Math.exp(-l), s = p, u = rnd(); while (u > s && k < 80) { k++; p *= l / k; s += p; } return k; };
  const P = [...Array(200)].map((_, i) => ({ id: String(i), team: 'T' + (i % 20), a: .4 + rnd() * 1.6, q: .4 + rnd() * .15, f: .65 + rnd() * .25 }));
  const G = {};
  for (const y of years) {
    G[y] = [];
    for (let d = 0; d < 160; d++) {
      const dt = new Date(Date.UTC(y - 1, 9, 22 + d)).toISOString().slice(0, 10);
      for (let t = 0; t < 20; t += 2) { if (rnd() < .5) continue;
        const rows = P.filter(p => (p.team === 'T' + t || p.team === 'T' + (t + 1)) && rnd() > .1).map(p => {
          const hot = .6 + rnd() * .8, fga = pois(10 * p.a * hot), fta = pois(3 * p.a * hot); let fgm = 0, ftm = 0;
          for (let i = 0; i < fga; i++) if (rnd() < p.q) fgm++; for (let i = 0; i < fta; i++) if (rnd() < p.f) ftm++;
          const tpm = Math.min(fgm, pois(1.5 * p.a));
          return { id: p.id, name: 'P' + p.id, team: p.team, min: 28, pts: 2 * fgm + tpm + ftm, reb: pois(5 * p.a * hot), ast: pois(3 * p.a * hot), stl: pois(.9 * p.a), blk: pois(.6 * p.a), to: pois(1.8 * p.a), pf: 2, fgm, fga, tpm, tpa: tpm * 3, ftm, fta, st: 1, pos: 'G' };
        });
        G[y].push({ date: dt, rows });
      }
    }
  }
  return G;
}

(async () => {
  const { loadGames, rankWindow } = require('./build-rankings.js');
  let G, tests;
  if (MOCK) { tests = [2024, 2025, 2026]; G = mockSeasons(tests); }
  else {
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
    const last = cur - 1; tests = [last - 2, last - 1, last]; G = {};
    for (const y of tests) { G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
  }
  const R = {};
  for (const y of tests) {
    const pool = rankWindow(G[y]).sort((a, b) => b.value - a.value).slice(0, POOL).map(p => p.id);
    R[y] = season(G[y], pool);
  }
  const avg = (t, c, k) => mean(tests.map(y => k ? R[y][t][c][k] : R[y][t][c]));
  const f = (v, d = 2) => v.toFixed(d).padStart(6);
  console.log(`\n== 1 G weights: what each z-score is worth in a weekly head-to-head (top ${POOL}, ${ROSTER} roster spots)`);
  console.log(`cat   ${tests.map(y => label(y).padStart(8)).join('')}     avg   paper   sigma^2    tau^2`);
  for (const c of CATS) console.log(`${c.padEnd(5)} ${tests.map(y => f(R[y].g[c].w).padStart(8)).join('')}  ${f(avg('g', c, 'w'))}  ${f(PAPER[c])}  ${f(avg('g', c, 's2'), 3).padStart(8)} ${f(avg('g', c, 't2'), 3).padStart(8)}`);
  console.log('\n== 2 Game-to-game dispersion: variance / mean (FG, FT: against a binomial at his own %)');
  console.log(`cat   ${tests.map(y => label(y).padStart(8)).join('')}     avg   today`);
  for (const c of CATS) console.log(`${c.padEnd(5)} ${tests.map(y => f(R[y].phi[c]).padStart(8)).join('')}  ${f(avg('phi', c))}  ${f(PHI[c] || 1, 1)}`);
  console.log('\n== 3 Week noise: a week against games x his average elsewhere, over what today\'s per-game model expects');
  console.log(`cat   ${tests.map(y => label(y).padStart(8)).join('')}     avg   (Build 1.6, Matchup 1)`);
  for (const c of CATS) console.log(`${c.padEnd(5)} ${tests.map(y => f(R[y].wk[c]).padStart(8)).join('')}  ${f(avg('wk', c))}`);
  console.log(`\nplayers: ${tests.map(y => R[y].players).join(' / ')}; share of team games played in weeks played: ${tests.map(y => (R[y].played * 100).toFixed(1) + '%').join(' / ')}`);
  const r3 = v => +v.toFixed(3);
  const out = {
    seasons: tests.map(label), pool: POOL, roster: ROSTER, kappa: r3(KAPPA),
    note: 'g: each z-score x w = G-score (weekly head-to-head). phi: per-game variance / mean. wk: weekly squared error over today\'s per-game model (1 = explained). Averages of the three seasons; bySeason has each.',
    g: Object.fromEntries(CATS.map(c => [c, r3(avg('g', c, 'w'))])),
    phi: Object.fromEntries(CATS.map(c => [c, r3(avg('phi', c))])),
    wk: Object.fromEntries(CATS.map(c => [c, r3(avg('wk', c))])),
    paper: PAPER, today: { phi: { ...Object.fromEntries(CATS.map(c => [c, PHI[c] || 1])) }, tbnoise: 1.6 },
    bySeason: Object.fromEntries(tests.map(y => [label(y), { players: R[y].players, played: r3(R[y].played),
      g: Object.fromEntries(CATS.map(c => [c, { w: r3(R[y].g[c].w), s2: r3(R[y].g[c].s2), t2: r3(R[y].g[c].t2) }])),
      phi: Object.fromEntries(CATS.map(c => [c, r3(R[y].phi[c])])), wk: Object.fromEntries(CATS.map(c => [c, r3(R[y].wk[c])])) }])),
  };
  if (!MOCK) { fs.writeFileSync('data/backtest-variance.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-variance.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

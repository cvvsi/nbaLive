/* Matchup ease: how much more (or less) opposing players produce against each team than they do
 * against everyone else, per category. Shared by build-rankings.js (nightly, this season's table
 * into regression.json) and backtest-ease.js (how much of it to believe, fitted on past seasons).
 *
 * For every player-game against team T: what he'd be expected to do at those minutes from his
 * per-minute rates in his games against everyone else, against what he did. Summed over every
 * opponent's player-games against T, act / exp - 1 is T's effect for that category (+ = easier).
 * Per minute, so blowouts and foul trouble don't count as defense; pace counts (more possessions
 * a minute = more of everything). FG is makes against his FG% elsewhere at the same attempts, so
 * it reads as a change in FG%. FTA is volume: a defense changes how often you get to the line,
 * not how well you shoot once there, so FT% isn't touched.
 *
 * Early on it's a handful of games, so the page doesn't take it at face value: each category's
 * effect is pulled toward zero by K games, factor = 1 + a * pct * g / (g + K), with K and a
 * fitted by backtest-ease.js (data/backtest-ease.json). Defaults until that has run: EASE_K.
 */
const EK = ['pts', 'tpm', 'reb', 'ast', 'stl', 'blk', 'to', 'fta', 'fg'];
const CNT = ['pts', 'tpm', 'reb', 'ast', 'stl', 'blk', 'to', 'fta'];
const MIN_EX = 100, FGA_EX = 40;   // a player needs this much against everyone else to count
// Provisional (before the backtest): about half believed after 20-40 games, the noisy ones slower.
const EASE_K = { pts: { K: 20, a: 1 }, tpm: { K: 40, a: 1 }, reb: { K: 30, a: 1 }, ast: { K: 30, a: 1 },
  stl: { K: 60, a: 1 }, blk: { K: 60, a: 1 }, to: { K: 40, a: 1 }, fta: { K: 40, a: 1 }, fg: { K: 40, a: 1 } };

const ADD = ['min', ...CNT, 'fgm', 'fga'];
function add(m, k, r) { const o = m[k] || (m[k] = Object.fromEntries(ADD.map(x => [x, 0]))); for (const x of ADD) o[x] += r[x] || 0; }

// games: [{date, rows: [{id, team, min, pts, tpm, reb, ast, stl, blk, to, fta, fgm, fga}]}]
// -> { team: { g, pct: {cat: act/exp - 1} } }
function easeTable(games) {
  const P = {}, PO = {}, GS = [];
  for (const g of games) {
    const ts = [...new Set(g.rows.map(r => r.team))]; if (ts.length !== 2) continue;
    GS.push([g, ts]);
    for (const r of g.rows) { const o = r.team === ts[0] ? ts[1] : ts[0]; add(P, r.id, r); add(PO, r.id + '|' + o, r); }
  }
  const T = {};
  for (const [g, ts] of GS) for (const o of ts) { const t = T[o] || (T[o] = { g: 0, act: {}, exp: {} }); t.g++; }
  for (const [g, ts] of GS) for (const r of g.rows) {
    const o = r.team === ts[0] ? ts[1] : ts[0], a = P[r.id], b = PO[r.id + '|' + o], mEx = a.min - b.min;
    if (mEx < MIN_EX || !(r.min > 0)) continue;
    const t = T[o];
    for (const k of CNT) { t.exp[k] = (t.exp[k] || 0) + (a[k] - b[k]) / mEx * r.min; t.act[k] = (t.act[k] || 0) + (r[k] || 0); }
    const fgaEx = a.fga - b.fga;
    if (fgaEx >= FGA_EX && r.fga > 0) { t.exp.fg = (t.exp.fg || 0) + r.fga * (a.fgm - b.fgm) / fgaEx; t.act.fg = (t.act.fg || 0) + r.fgm; }
  }
  const out = {};
  for (const [o, t] of Object.entries(T)) out[o] = { g: t.g, pct: Object.fromEntries(EK.map(k => [k, t.exp[k] > 0 ? t.act[k] / t.exp[k] - 1 : 0])) };
  return out;
}

// The multiplier for a player facing a team with effect pct over g games.
const easeFactor = (pct, g, s) => 1 + s.a * pct * g / (g + s.K);

module.exports = { EK, CNT, EASE_K, easeTable, easeFactor };

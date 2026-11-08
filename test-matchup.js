/* Tests for the Matchup tool's math, run on every push by .github/workflows/tests.yml (and by hand:
 * `node test-matchup.js`). It pulls the real functions out of index.html (muKey, muPast, muOdds and
 * what they use), so it tests the code the site runs, not a copy.
 *
 * Why it exists: in Nov 2026 the FG% / FT% projection ignored Yahoo's percentages so far (the
 * attempts behind them came out as 0), so a .848 vs .888 FT% with one day left showed as a 52%
 * coin flip. These cases make sure a wrong starting point can't slip through again.
 */
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8');

// A top-level declaration: from its first line to just before the next line that starts at column 0.
function grab(start) {
  const i = src.indexOf(start); if (i < 0) throw new Error('not found in index.html: ' + start);
  const rest = src.slice(i), m = rest.slice(1).search(/\n(?=[^\s}])/);
  return m < 0 ? rest : rest.slice(0, m + 1);
}
const code = [
  'const CATS=[', 'const MUKS=', 'function muKey(', 'const MUPHI=', 'const muPhi=', 'function muPast(', 'function muOdds(',
].map(grab).join('\n');
const M = new Function(code + '\nreturn {CATS,muKey,muPast,muOdds,muPhi};')();
const { muKey, muPast, muOdds } = M;

let n = 0; const t = (name, f) => { f(); n++; console.log('ok', name); };
const zero = () => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, to: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const now = o => Object.assign({ fg: 0, ft: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, to: 0 }, o);
// the rest of the week for one team: per-game line x games, with the variance muSim would add
function rest(games, line) {
  const tot = zero(), vr = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, to: 0 }, PHI = { pts: 2.2, reb: 1.3, ast: 1.4 };
  for (const k in tot) tot[k] = (line[k] || 0) * games;
  for (const k in vr) vr[k] = (PHI[k] || 1) * tot[k];
  return { tot, vr };
}
const LINE = { pts: 15, reb: 5, ast: 3, stl: .8, blk: .5, tpm: 1.5, to: 1.5, fgm: 5.5, fga: 12, ftm: 2.4, fta: 3 };
const row = (O, k) => O.rows.find(r => r.k === k);

t('Yahoo headers map to categories, including a merged "Team FG%"', () => {
  assert.strictEqual(muKey('Team FG%'), 'fg');
  assert.strictEqual(muKey('FT%'), 'ft');
  assert.strictEqual(muKey('3PTM'), 'tpm');
  assert.strictEqual(muKey('AST'), 'ast');
  assert.strictEqual(muKey('ST'), 'stl');
  assert.strictEqual(muKey('TO'), 'to');
  assert.strictEqual(muKey('Score'), null);
});

t('attempts and games so far come out of the points so far', () => {
  const p = muPast([LINE, LINE, LINE], now({ pts: 674 }));
  assert(p.fta > 100 && p.fga > 400, 'attempts so far must be real: ' + JSON.stringify(p));
  assert(p.g > 40 && p.g < 50, 'games so far ~45: ' + p.g);
});

t('one day left, .848 vs .888 FT%: you are a big underdog (the Nov 2026 bug said 52%)', () => {
  const cA = now({ ft: .848, fg: .484, pts: 674 }), cB = now({ ft: .888, fg: .435, pts: 623 });
  const pA = muPast(Array(10).fill(LINE), cA), pB = muPast(Array(10).fill(LINE), cB);
  const O = muOdds(cA, cB, pA, pB, rest(5, LINE), rest(7, LINE), new Set());
  const ft = row(O, 'ft'), fg = row(O, 'fg');
  assert(Math.abs(ft.a - .848) < .02 && Math.abs(ft.b - .888) < .02, 'finals stay near Yahoo: ' + ft.a + ' ' + ft.b);
  assert(typeof ft.p === 'number' && ft.p < .05, 'FT% win chance should be tiny, got ' + ft.p);
  assert(typeof fg.p === 'number' && fg.p > .95, 'FG% win chance should be near certain, got ' + fg.p);
});

t('no games left: the result is just who leads now', () => {
  const cA = now({ ft: .848, pts: 674, reb: 182 }), cB = now({ ft: .888, pts: 623, reb: 190 });
  const O = muOdds(cA, cB, muPast([LINE], cA), muPast([LINE], cB), rest(0, LINE), rest(0, LINE), new Set());
  assert.strictEqual(row(O, 'ft').p, 0); assert.strictEqual(row(O, 'pts').p, 1); assert.strictEqual(row(O, 'reb').p, 0);
});

t('a fresh week (nothing played): sensible chances, nothing flagged', () => {
  const O = muOdds(now({}), now({}), { fga: 0, fta: 0 }, { fga: 0, fta: 0 }, rest(30, LINE), rest(26, LINE), new Set());
  for (const r of O.rows) { assert(!r.bad, r.k + ' flagged'); assert(r.p >= 0 && r.p <= 1, r.k + ' p ' + r.p); }
  assert(row(O, 'pts').p > .5, 'more games should favour you in points');
});

t('a % so far with no attempts behind it gets no win % (instead of a wrong one)', () => {
  const O = muOdds(now({ ft: .848 }), now({ ft: .888 }), { fga: 0, fta: 0 }, { fga: 0, fta: 0 }, rest(5, LINE), rest(7, LINE), new Set());
  assert.strictEqual(row(O, 'ft').bad, true); assert.strictEqual(row(O, 'ft').p, null);
  assert(O.won + O.lost < 9, 'a "?" category counts for neither side');
});

t('counting stats never project below the total so far', () => {
  const cA = now({ pts: 674, reb: 182, ast: 130, stl: 50, blk: 19, tpm: 70, to: 79 });
  const O = muOdds(cA, cA, muPast([LINE], cA), muPast([LINE], cA), rest(5, LINE), rest(7, LINE), new Set());
  for (const r of O.rows) if (r.k !== 'fg' && r.k !== 'ft') assert(r.a >= r.na && r.b >= r.nb, r.k);
});

console.log(`\nAll ${n} matchup tests passed.`);

/* Scorecard: how close is Proj to the next game, and do team totals make it closer?
 *
 * Usage:  node backtest-daily.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-daily.js --mock   synthetic seasons, to check the script runs
 * Writes: data/backtest-daily.json; prints the tables.
 *
 * Replays 2023-24 to 2025-26 one date at a time. Before each date the model sees only earlier
 * games (and the two seasons before, as in build-rankings.js: baseline(), expectedLine(),
 * fadeMpg(), nextMan() refreshed every date), then predicts every player who played that night.
 * Who plays is taken as known, like the page on game day with the injury report in. Rookies with
 * no baseline use their raw line (no rookie prior here).
 *
 * Minutes, each scored against the minutes he played:
 *   proj      Proj minutes (recent games count more, nudged by last season)
 *   nm        + next man up: a regular who sits moves teammates by his dOut, else dWith (the page
 *             today, without the 6-game ramp after a return)
 *   proj240 / nm240   the same, scaled so the players who played total 240 (needs to know the
 *             coach's whole rotation in advance: an upper bound, not something the page can do)
 *   team / nmteam   scaled toward 240 over the team as the page can know it: everyone seen in the
 *             team's last 10 games, a fringe player counted at the share of them he played, and a
 *             regular (80%+ of them) who sits tonight left out, as the injury report would have
 *             him. x (1 + a (240 / sum - 1)), a fitted on two seasons and scored on the third
 * Categories (points, rebounds, assists, threes, steals, blocks, turnovers, FGA, FTA):
 *   season / last   benchmarks: his average so far this season; last season's average
 *   proj      Proj's per-minute rates at Proj minutes
 *   nm        ... at next-man-up minutes (the page today, before matchup ease)
 *   min       ... at the `team` minutes
 *   team      ... then scaled toward the team's own average so far: x (1 + g (team avg / sum of
 *             its players' lines - 1)), g per category fitted out of sample, the sum over the
 *             same known team as the minutes. nmin / nteam: the same two from next-man-up minutes. When a scorer sits
 *             the team still takes its shots, so the others' rates rise; today only minutes move.
 *   rates     Proj's rates at the minutes he actually played: the error left if minutes were
 *             perfect (the rate model alone)
 * Scored on players Proj has at 12+ minutes, from each team's 5th game, RMSE per game. `out` =
 * the same on nights a regular (Proj 24+ minutes) of his team sat.
 *
 * Books: on dates with a saved props file (data/props/), the sportsbooks' implied average against
 * ours and what happened, on the stats they priced, this season.
 */
const fs = require('fs');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const KS = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'to', 'fga', 'fta'];
const AL = [0, .25, .5, .75, 1], GA = [0, .25, .5, .75, 1], MINSC = 12, TG0 = 4, REG = 24, CAPM = 42, NMDAYS = 1, LASTN = 10, SURE = .8;
const label = y => `${y - 1}-${String(y).slice(2)}`;
const B = require('./build-rankings.js');
const zeroS = () => ({ gp: 0, use: 0, tpos: 0, ...Object.fromEntries(B.STATS.map(k => [k, 0])) });
const dayN = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;

// Walk one season; returns team-game groups with each player's lines and what he did.
function walk(games, t1, t2, seasons) {
  games = [...games].sort((a, b) => a.date < b.date ? -1 : 1);
  const cur = {}, mins = {}, team = {}, tt = {}, base = {}, groups = [], lastG = {};
  const baseOf = id => id in base ? base[id] : (base[id] = B.baseline({ seasons, s: { [seasons[0]]: t1[id], [seasons[1]]: t2[id] } }));
  const lineOf = id => {
    const s = cur[id], b = baseOf(id);
    if (b) return { l: B.expectedLine(s || zeroS(), b.t, s ? B.fadeMpg(mins[id], b.t.mpg) : b.t.mpg), b };
    if (s && s.gp) return { l: B.expectedLine(s, { ...zeroS(), gp: 1 }, s.min / s.gp), b: null };
    return null;
  };
  let nm = {}, nmAt = -1e9, i = 0;
  while (i < games.length) {
    const d = games[i].date; let j = i; while (j < games.length && games[j].date === d) j++;
    if (dayN(d) - nmAt >= NMDAYS && i) {
      const scored = [], rk = {};
      for (const id in cur) { const x = lineOf(id); scored.push({ id, min: x.l.min, b: x.b, s: cur[id] }); rk[id] = { t: team[id] }; }
      nm = {}; for (const [R, e] of Object.entries(B.nextMan(games.slice(0, i), scored, rk))) (nm[e.t] || (nm[e.t] = [])).push([R, e]);
      nmAt = dayN(d);
    }
    for (const g of games.slice(i, j)) for (const t of new Set(g.rows.map(r => r.team))) {
      const rows = g.rows.filter(r => r.team === t), here = new Set(rows.map(r => r.id)), T = tt[t];
      let regOut = false; for (const [R] of nm[t] || []) if (!here.has(R) && team[R] === t) regOut = true;
      const P = rows.map(r => {
        const x = lineOf(r.id), s = cur[r.id];
        if (!x) return { a: r, m0: 10, m1: 10 };
        let up = 0, dn = 0;
        for (const [R, e] of nm[t] || []) { if (R === r.id) continue; const v = e.m[r.id]; if (!v) continue; const k = here.has(R) ? v[0] : v[1]; if (k > up) up = k; if (k < dn) dn = k; }
        const m0 = x.l.min, m1 = Math.max(0, Math.min(CAPM, m0 + up + dn));
        return { a: r, m0, m1, rate: m0 > 0 ? Object.fromEntries([...KS, 'fgm', 'ftm'].map(k => [k, x.l[k] / m0])) : null,
          sa: s && s.gp >= 3 ? Object.fromEntries(KS.map(k => [k, s[k] / s.gp])) : null,
          la: t1[r.id] && t1[r.id].gp >= 10 ? Object.fromEntries(KS.map(k => [k, t1[r.id][k] / t1[r.id].gp])) : null,
          sc: m0 >= MINSC && !!(x.b || (s && s.gp >= 3)) };
      });
      // the team as the page can know it: sums of minutes x the share of recent games he played
      const L = lastG[t] || [], cnt = {}; for (const set of L) for (const id of set) cnt[id] = (cnt[id] || 0) + 1;
      const wOf = id => { const c = cnt[id]; if (!c || !L.length) return 1; const r = c / L.length; return r >= SURE ? 1 : r; };
      let s0 = 0, s1 = 0; const C = [];
      for (const p of P) { const w = wOf(p.a.id); s0 += w * p.m0; s1 += w * p.m1; if (p.rate) C.push({ w, m0: p.m0, m1: p.m1, rate: p.rate }); }
      for (const id in cnt) { if (here.has(id) || team[id] !== t) continue; const w = wOf(id); if (w >= 1) continue;   // a regular who sits: known out
        const x = lineOf(id); if (x && x.l.min > 0) { s0 += w * x.l.min; s1 += w * x.l.min; C.push({ w, m0: x.l.min, m1: x.l.min, rate: Object.fromEntries(KS.map(k => [k, x.l[k] / x.l.min])) }); } }
      groups.push({ d, t, s0, s1, C, ok: !!T && T.n >= TG0, regOut, tg: T ? Object.fromEntries(KS.map(k => [k, T[k] / T.n])) : null, P });
    }
    for (const g of games.slice(i, j)) {
      const teams = new Set(g.rows.map(r => r.team)), poss = {};
      for (const r of g.rows) { const p = poss[r.team] || (poss[r.team] = { min: 0, poss: 0 }); p.min += r.min; p.poss += r.fga + .44 * r.fta + r.to; }
      for (const t of teams) { const T = tt[t] || (tt[t] = { n: 0, ...Object.fromEntries(KS.map(k => [k, 0])) }); T.n++;
        const L = lastG[t] || (lastG[t] = []); L.push(new Set(g.rows.filter(r => r.team === t).map(r => r.id))); if (L.length > LASTN) L.shift(); }
      for (const r of g.rows) {
        const s = cur[r.id] || (cur[r.id] = { id: r.id, ...zeroS() }); s.team = r.team; s.name = r.name; team[r.id] = r.team;
        s.gp++; for (const k of B.STATS) s[k] += r[k];
        const p = poss[r.team]; s.use += r.fga + .44 * r.fta + r.to; s.tpos += r.min * p.poss / (p.min / 5);
        (mins[r.id] || (mins[r.id] = [])).push(r.min);
        for (const k of KS) tt[r.team][k] += r[k];
      }
    }
    i = j;
  }
  return groups;
}

const sumOf = (P, f) => P.reduce((a, p) => a + f(p), 0);
const scale = (m, sum, a) => Math.min(CAPM, m * (1 + a * (240 / sum - 1)));
// Minutes for a model in group g: returns a function of the player.
function minF(g, model, a) {
  if (model === 'proj') return p => p.m0;
  if (model === 'nm') return p => p.m1;
  const k = model === 'proj240' || model === 'team' ? 'm0' : 'm1';
  if (model === 'team' || model === 'nmteam') { const sum = (k === 'm0' ? g.s0 : g.s1) || 240; return p => scale(p[k], sum, a); }
  const sum = sumOf(g.P, p => p[k]) || 240;
  return p => scale(p[k], sum, 1);
}
function minErr(G, ys, model, a, sub) {
  let se = 0, n = 0, b = 0;
  for (const y of ys) for (const g of G[y]) { if (!g.ok || (sub && !g.regOut)) continue; const f = minF(g, model, a);
    for (const p of g.P) if (p.sc) { se += (f(p) - p.a.min) ** 2; b += f(p) - p.a.min; n++; } }
  return { se, n, b };
}
// Category error. model: season | last | proj | nm | min | team | nmin | nteam | rates. a = [a for
// proj minutes, a for next-man-up minutes].
function catErr(G, ys, k, model, a, ga, sub) {
  let se = 0, n = 0, b = 0;
  for (const y of ys) for (const g of G[y]) {
    if (!g.ok || (sub && !g.regOut)) continue;
    const N = model[0] === 'n' && model !== 'nm';
    const f = model === 'proj' ? p => p.m0 : model === 'nm' ? p => p.m1 : model === 'rates' ? p => p.a.min : minF(g, N ? 'nmteam' : 'team', a[N ? 1 : 0]);
    let mult = 1;
    if (/team/.test(model) && ga) { const S = sumOf(g.C, c => c.w * c.rate[k] * f(c)); if (S > 0) mult = 1 + ga * (Math.max(.7, Math.min(1.4, g.tg[k] / S)) - 1); }
    for (const p of g.P) { if (!p.sc || !p.sa) continue;
      const v = model === 'season' ? p.sa[k] : model === 'last' ? (p.la ? p.la[k] : p.sa[k]) : p.rate[k] * f(p) * mult;
      se += (v - p.a[k]) ** 2; b += v - p.a[k]; n++; }
  }
  return { se, n, b };
}
const rm = e => e.n ? Math.sqrt(e.se / e.n) : 0;
const addE = (a, b) => ({ se: a.se + b.se, n: a.n + b.n, b: a.b + b.b });

function analyze(G, tests) {
  const out = { tests: tests.map(label), note: 'RMSE per game, out of sample (settings fitted on two seasons, scored on the third). out = nights a regular (Proj 24+ min) of the team sat.', minutes: {}, cats: {}, fit: {} };
  const Z = { se: 0, n: 0, b: 0 };
  // minutes
  const MM = ['proj', 'nm', 'proj240', 'nm240', 'team', 'nmteam'], aFold = {}, aNm = {};
  for (const y of tests) { const tr = tests.filter(t => t !== y); for (const [m, o] of [['team', aFold], ['nmteam', aNm]]) { let b = null; for (const a of AL) { const e = minErr(G, tr, m, a).se; if (!b || e < b.e) b = { a, e }; } o[y] = b.a; } }
  out.fit.minutes = tests.map(y => aFold[y]); out.fit.minutesNm = tests.map(y => aNm[y]);
  console.log('\n== Minutes (RMSE per game)        all    regular out    bias (predicted - played)');
  for (const m of MM) {
    const A = m === 'nmteam' ? aNm : aFold;
    let all = Z, sub = Z; for (const y of tests) { all = addE(all, minErr(G, [y], m, A[y])); sub = addE(sub, minErr(G, [y], m, A[y], true)); }
    out.minutes[m] = { all: +rm(all).toFixed(3), out: +rm(sub).toFixed(3), bias: +(all.b / all.n).toFixed(3), n: all.n, nOut: sub.n };
    console.log(`${m.padEnd(10)} ${rm(all).toFixed(2).padStart(26)} ${rm(sub).toFixed(2).padStart(10)} ${(all.b / all.n).toFixed(2).padStart(10)}${/team/.test(m) ? '   a per fold: ' + tests.map(y => A[y]).join(' / ') : ''}`);
  }
  console.log(`  player-games: ${out.minutes.proj.n} (${out.minutes.proj.nOut} with a regular out)`);
  // categories
  const CM = ['season', 'last', 'proj', 'nm', 'min', 'team', 'nmin', 'nteam', 'rates'];
  out.fit.team = {}; out.fit.teamNm = {};
  console.log('\n== Categories (RMSE per game)\ncat   ' + CM.map(m => m.padStart(8)).join('') + '   | regular out:      nm    team   nteam   g per fold (team; nteam)');
  for (const k of KS) {
    const gFold = {}, gNm = {}, A = y => [aFold[y], aNm[y]];
    for (const y of tests) { const tr = tests.filter(t => t !== y);
      for (const [m, o] of [['team', gFold], ['nteam', gNm]]) { let b = null; for (const ga of GA) { let e = Z; for (const t of tr) e = addE(e, catErr(G, [t], k, m, A(y), ga)); if (!b || e.se < b.e) b = { ga, e: e.se }; } o[y] = b.ga; } }
    out.fit.team[k] = tests.map(y => gFold[y]); out.fit.teamNm[k] = tests.map(y => gNm[y]);
    const row = {}, sub = {}, bias = {};
    for (const m of CM) { let a = Z, s = Z; for (const y of tests) { const ga = m === 'nteam' ? gNm[y] : gFold[y]; a = addE(a, catErr(G, [y], k, m, A(y), ga)); s = addE(s, catErr(G, [y], k, m, A(y), ga, true)); } row[m] = +rm(a).toFixed(3); sub[m] = +rm(s).toFixed(3); bias[m] = +(a.b / a.n).toFixed(3); }
    out.cats[k] = { all: row, out: sub, bias };
    console.log(`${k.padEnd(5)} ${CM.map(m => row[m].toFixed(2).padStart(8)).join('')}   |              ${['nm', 'team', 'nteam'].map(m => sub[m].toFixed(2).padStart(7)).join(' ')}   ${tests.map(y => gFold[y]).join(' / ')}; ${tests.map(y => gNm[y]).join(' / ')}`);
  }
  return out;
}

// Calibration: how wide should the win % be? Per player-week (Mon-Sun, the games he played), the
// week's total against the sum of that week's lines (next-man-up minutes), squared, over the sum
// of the lines: the variance-to-mean ratio a week really has, projection error included. FG / FT:
// makes against his projected % at the attempts he took, over the binomial variance. `game` is the
// same per single game.
function calib(G, tests) {
  const CK = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'to', 'fg', 'ft'], res = {};
  const wk = d => { const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); return t.toISOString().slice(0, 10); };
  for (const y of tests) {
    const W = {}, r = res[y] = { week: {}, game: {} }, acc = Object.fromEntries(CK.map(k => [k, [0, 0, 0, 0]]));
    for (const g of G[y]) { if (!g.ok) continue; for (const p of g.P) { if (!p.sc) continue;
      const key = p.a.id + wk(g.d), w = W[key] || (W[key] = Object.fromEntries(CK.map(k => [k, [0, 0]])));
      for (const k of CK) {
        let e, v;
        if (k === 'fg' || k === 'ft') { const q = p.rate[k + 'a'] > 0 ? p.rate[k + 'm'] / p.rate[k + 'a'] : 0, att = p.a[k + 'a']; e = p.a[k + 'm'] - q * att; v = att * q * (1 - q); }
        else { v = p.rate[k] * p.m1; e = p.a[k] - v; }
        w[k][0] += e; w[k][1] += v; acc[k][2] += e * e; acc[k][3] += v;
      } } }
    for (const w of Object.values(W)) for (const k of CK) { acc[k][0] += w[k][0] ** 2; acc[k][1] += w[k][1]; }
    for (const k of CK) { r.week[k] = +(acc[k][0] / acc[k][1]).toFixed(3); r.game[k] = +(acc[k][2] / acc[k][3]).toFixed(3); }
  }
  const avg = (t, k) => +(tests.reduce((a, y) => a + res[y][t][k], 0) / tests.length).toFixed(3);
  const out = { week: Object.fromEntries(CK.map(k => [k, avg('week', k)])), game: Object.fromEntries(CK.map(k => [k, avg('game', k)])), bySeason: Object.fromEntries(tests.map(y => [label(y), res[y]])) };
  console.log('\n== Calibration: variance / mean of a week (and a game) around our lines; today 2.2 / 1.3 / 1.4 pts / reb / ast, 1 the rest (Build x 1.6)');
  console.log('cat     week  ' + tests.map(y => label(y).padStart(8)).join('') + '    game');
  for (const k of CK) console.log(`${k.padEnd(5)} ${out.week[k].toFixed(2).padStart(6)}  ${tests.map(y => res[y].week[k].toFixed(2).padStart(8)).join('')}  ${out.game[k].toFixed(2).padStart(6)}`);
  return out;
}

// This season: ours (the page today: next-man-up minutes) against the sportsbooks' implied averages.
function books(groups, a) {
  const dir = 'data/props', res = {}; let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)); } catch (e) { return null; }
  const byDate = {}; for (const g of groups) (byDate[g.d] || (byDate[g.d] = [])).push(g);
  for (const f of files) {
    const d = f.slice(0, 10), pr = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')).players || {};
    for (const g of byDate[d] || []) for (const p of g.P) {
      const m = pr[p.a.name]; if (!m || !p.rate) continue;
      for (const k of Object.keys(m)) { if (!KS.includes(k) || !Array.isArray(m[k])) continue;
        const r = res[k] || (res[k] = { n: 0, ours: 0, book: 0, bias: 0, bbias: 0, t: 0, tb: 0 }), o = p.rate[k] * p.m1, o2 = p.rate[k] * scale(p.m0, g.s0 || 240, a), v = p.a[k];
        r.n++; r.ours += (o - v) ** 2; r.book += (m[k][0] - v) ** 2; r.bias += o - v; r.bbias += m[k][0] - v; r.t += (o2 - v) ** 2; r.tb += o2 - v; }
    }
  }
  const out = { dates: files.length, stats: {} };
  console.log(`\n== Books vs ours, this season (${files.length} dates with props; RMSE per game, bias = predicted - actual)`);
  console.log('stat      n    ours   books   ours bias  books bias | at team minutes: ours   bias');
  for (const [k, r] of Object.entries(res)) {
    out.stats[k] = { n: r.n, ours: +Math.sqrt(r.ours / r.n).toFixed(3), books: +Math.sqrt(r.book / r.n).toFixed(3), oursBias: +(r.bias / r.n).toFixed(3), booksBias: +(r.bbias / r.n).toFixed(3), team: +Math.sqrt(r.t / r.n).toFixed(3), teamBias: +(r.tb / r.n).toFixed(3) };
    const s = out.stats[k]; console.log(`${k.padEnd(5)} ${String(r.n).padStart(5)} ${s.ours.toFixed(2).padStart(7)} ${s.books.toFixed(2).padStart(7)} ${s.oursBias.toFixed(2).padStart(10)} ${s.booksBias.toFixed(2).padStart(10)} | ${s.team.toFixed(2).padStart(21)} ${s.teamBias.toFixed(2).padStart(6)}`);
  }
  return out;
}

function mockSeasons(years) {
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pois = l => { let k = 0, p = Math.exp(-l), s = p, u = rnd(); while (u > s && k < 90) { k++; p *= l / k; s += p; } return k; };
  const P = []; for (let t = 0; t < 10; t++) for (let i = 0; i < 12; i++) P.push({ id: `${t}_${i}`, team: 'T' + t, m: [36, 34, 32, 30, 28, 22, 18, 14, 10, 8, 5, 3][i], a: .6 + rnd() * .8, pos: 'GGFFC'[i % 5] });
  const G = {};
  for (const y of years) {
    G[y] = [];
    for (let d = 0; d < 150; d++) {
      const dt = new Date(Date.UTC(y - 1, 9, 22 + d)).toISOString().slice(0, 10);
      for (let t = 0; t < 10; t += 2) { if (rnd() < .5) continue; const rows = [];
        for (const tm of [t, t + 1]) { const act = P.filter(p => p.team === 'T' + tm && rnd() > (p.m > 25 ? .15 : .1)), sum = act.reduce((a, p) => a + p.m, 0);
          for (const p of act) { const min = Math.max(1, Math.round(p.m * 240 / sum + (rnd() - .5) * 6)), u = p.a * min / 30 * (sum < 220 ? 1.1 : 1), fga = pois(11 * u), fta = pois(3 * u); let fgm = 0, ftm = 0;
            for (let q = 0; q < fga; q++) if (rnd() < .47) fgm++; for (let q = 0; q < fta; q++) if (rnd() < .78) ftm++; const tpm = Math.min(fgm, pois(1.4 * u));
            rows.push({ id: p.id, name: 'P' + p.id, team: p.team, min, pts: 2 * fgm + tpm + ftm, reb: pois(5 * u), ast: pois(3 * u), stl: pois(.9 * u), blk: pois(.6 * u), to: pois(1.7 * u), pf: 2, fgm, fga, tpm, tpa: tpm * 3, ftm, fta, st: p.m > 27 ? 1 : 0, pos: p.pos }); } }
        G[y].push({ date: dt, rows }); }
    }
  }
  return G;
}

(async () => {
  let G, tests, cur = null;
  if (MOCK) { tests = [2024, 2025, 2026]; G = mockSeasons([2022, 2023, ...tests]); }
  else {
    const now = new Date().toISOString().slice(0, 10);
    const yr = (await (await fetch(`${API}/scoreboard?dates=${now.replace(/-/g, '')}`)).json()).leagues[0].season.year;
    const last = yr - 1; tests = [last - 2, last - 1, last]; G = {};
    for (const y of [last - 4, last - 3, ...tests]) { G[y] = await B.loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
    cur = await B.loadGames(now, '.cache/season-now.json'); console.log(`this season: ${cur.length} games`);
  }
  const W = {};
  for (const y of tests) W[y] = walk(G[y], B.totals(G[y - 1]), B.totals(G[y - 2]), [y - 1, y - 2]);
  const out = analyze(W, tests);
  out.calib = calib(W, tests);
  if (cur && cur.length) { const y = tests[2] + 1; out.books = books(walk(cur, B.totals(G[y - 1]), B.totals(G[y - 2]), [y - 1, y - 2]), Math.max(...out.fit.minutes)); }
  if (!MOCK) { fs.writeFileSync('data/backtest-daily.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-daily.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

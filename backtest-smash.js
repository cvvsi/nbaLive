/* Backtest: Smash spots. When a regular sits, how well can we call his teammates' night, and how
 * often does a flagged "Smash" / "Good" spot actually come through?
 *
 * Usage:  node backtest-smash.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-smash.js --mock   synthetic seasons, to check the script runs
 * Writes: data/backtest-smash.json; prints the tables.
 *
 * Replays each season a game at a time, the model seeing only earlier games. A regular = 24+
 * minutes a game (recent games weighted like Proj's minutes, 5+ games) for that team. For every
 * team game a regular missed, each teammate who played (3+ games so far) is predicted from what was
 * known before it, who plays taken as known (like backtest-daily.js):
 *   usual   his usual minutes (fade average) x his per-minute rates (this season blended toward last
 *           season's at K = 300 minutes)
 *   nm      + half the regular's minutes shared by the teammates of his position group who played,
 *           by their minutes (next man up's fixed rule)
 *   woK     nm blended with his own line in the games that regular already missed this season, by
 *           g / (g + K): minutes, and per-minute rates (so a usage bump shows), K = 1 .. 16
 * Scored on the 9-cat value of the line (z-scores against the season's player-games of 15+ min,
 * FG% / FT% as impact), and on minutes, points, rebounds, assists, threes. K fitted on two seasons,
 * scored on the third. Then the page's tags on the best model: "plays like #n" = where the value
 * would rank among the season's per-game values (players with 20+ games); Smash = like a top-60
 * player, Good = top-100, his usual line outside the top 75. Reported: how many came through
 * (actual value at a top-100 / top-60 level) against every fill-in outside the top 75, by tier
 * and by how many games without that regular he had. The current season so far is scored the same
 * way as a check (no fitting).
 */
const fs = require('fs');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const REG = 24, REG_GP = 5, MIN_GP = 3, KR = 300, HALF = 5, PRIOR_GP = 2, KS = [1, 2, 4, 8, 16];
const ST = ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta'];
const label = y => `${y - 1}-${String(y).slice(2)}`;
const grp = p => /C/.test(p || '') ? 'C' : /F/.test(p || '') ? 'F' : 'G';
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

function fade(ms, ly) { let a = 0, w = 0; for (let i = 0; i < ms.length; i++) { const k = Math.pow(.5, (ms.length - 1 - i) / HALF); a += k * ms[i]; w += k; }
  const G = ly == null ? 0 : PRIOR_GP; return w + G ? (a + G * (ly || 0)) / (w + G) : 0; }

// season scale: per-game z for each category over player-games of 15+ minutes
function scale(games) {
  const rows = games.flatMap(g => g.rows).filter(r => r.min >= 15), lgFG = rows.reduce((a, r) => a + r.fgm, 0) / rows.reduce((a, r) => a + r.fga, 0), lgFT = rows.reduce((a, r) => a + r.ftm, 0) / rows.reduce((a, r) => a + r.fta, 0);
  const f = { pts: r => r.pts, reb: r => r.reb, ast: r => r.ast, stl: r => r.stl, blk: r => r.blk, tpm: r => r.tpm, to: r => r.to, fg: r => r.fgm - lgFG * r.fga, ft: r => r.ftm - lgFT * r.fta };
  const S = {}; for (const [k, fn] of Object.entries(f)) { const v = rows.map(fn), m = mean(v); S[k] = [m, Math.sqrt(mean(v.map(x => (x - m) ** 2))) || 1]; }
  const val = l => { let s = 0; for (const [k, fn] of Object.entries(f)) s += (k === 'to' ? -1 : 1) * (fn(l) - S[k][0]) / S[k][1]; return s / 9; };
  return { val };
}

function replay(games, prevGames) {
  const SC = scale(games), sorted = [...games].sort((a, b) => a.date < b.date ? -1 : 1);
  // last season's per-minute rates and mpg
  const P = {}; for (const g of prevGames || []) for (const r of g.rows) { const o = P[r.id] || (P[r.id] = { min: 0, gp: 0, ...Object.fromEntries(ST.map(k => [k, 0])) }); o.min += r.min; o.gp++; for (const k of ST) o[k] += r[k]; }
  const st = {}, wo = {}, out = [];
  for (const g of sorted) {
    const byT = {}; for (const r of g.rows) (byT[r.team] || (byT[r.team] = [])).push(r);
    for (const [t, rows] of Object.entries(byT)) {
      const here = new Set(rows.map(r => r.id)), seen = Object.entries(st).filter(([, o]) => o.team === t);
      const regs = seen.filter(([, o]) => o.ms.length >= REG_GP && o.mp >= REG), miss = regs.filter(([id]) => !here.has(id));
      if (miss.length) {
        const [R, Ro] = miss.sort((a, b) => b[1].mp - a[1].mp)[0];
        const gs = {}; for (const r of rows) { const o = st[r.id]; if (o && o.team === t) gs[grp(o.pos)] = (gs[grp(o.pos)] || 0) + o.mp; }
        for (const r of rows) {
          const o = st[r.id]; if (!o || o.team !== t || o.ms.length < MIN_GP) continue;
          const p = P[r.id], rate = Object.fromEntries(ST.map(k => [k, (o[k] + (p && p.min ? p[k] / p.min : o[k] / o.min) * KR) / (o.min + KR)]));
          const m0 = o.mp, G0 = grp(o.pos), mNM = m0 + (grp(Ro.pos) === G0 && gs[G0] ? .5 * Ro.mp * m0 / gs[G0] : 0);
          const line = (m, rt) => ({ min: m, ...Object.fromEntries(ST.map(k => [k, rt[k] * m])) });
          const w = wo[R + '|' + r.id], pred = { usual: line(m0, rate), nm: line(mNM, rate) };
          for (const K of KS) {
            if (!w || !w.g || !w.min) { pred['wo' + K] = pred.nm; continue; }
            const a = w.g / (w.g + K), m = (1 - a) * mNM + a * w.min / w.g;
            pred['wo' + K] = line(m, Object.fromEntries(ST.map(k => [k, (1 - a) * rate[k] + a * w[k] / w.min])));
          }
          out.push({ pred, act: r, wg: w ? w.g : 0, nMiss: miss.length, val: SC.val });
        }
      }
      // what each regular's absence did, for later games: teammates' lines without and with him
      for (const [R] of regs) if (!here.has(R)) for (const r of rows) { if (r.id === R) continue; const k = R + '|' + r.id, o = wo[k] || (wo[k] = { g: 0, min: 0, ...Object.fromEntries(ST.map(s => [s, 0])) }); o.g++; o.min += r.min; for (const s of ST) o[s] += r[s]; }
    }
    for (const r of g.rows) {
      let o = st[r.id]; if (!o || o.team !== r.team) { const p = P[r.id]; o = st[r.id] = { team: r.team, pos: r.pos, ms: [], min: 0, ly: p ? p.min / p.gp : null, ...Object.fromEntries(ST.map(k => [k, 0])) }; }
      o.ms.push(r.min); o.min += r.min; for (const k of ST) o[k] += r[k]; if (r.pos) o.pos = r.pos; o.mp = fade(o.ms, o.ly);
    }
  }
  // per-game value of every player with 20+ games, for "plays like #n"
  const tot = {}; for (const g of games) for (const r of g.rows) { const o = tot[r.id] || (tot[r.id] = { gp: 0, min: 0, ...Object.fromEntries(ST.map(k => [k, 0])) }); o.gp++; o.min += r.min; for (const k of ST) o[k] += r[k]; }
  const pv = Object.values(tot).filter(o => o.gp >= 20).map(o => SC.val(Object.fromEntries(['min', ...ST].map(k => [k, o[k] / o.gp])))).sort((a, b) => b - a);
  const T = n => pv[Math.min(n, pv.length) - 1];
  return { S: out, T60: T(60), T75: T(75), T100: T(100) };
}

function analyze(R, tests, cur) {
  const MODELS = ['usual', 'nm', ...KS.map(K => 'wo' + K)];
  const err = (ys, m, f) => { let se = 0, n = 0, d = { min: 0, pts: 0, reb: 0, ast: 0, tpm: 0 }; for (const y of ys) for (const s of R[y].S) { if (f && !f(s)) continue; const p = s.pred[m], e = s.val(p) - s.val(s.act); se += e * e; n++; for (const k in d) d[k] += (p[k] - s.act[k]) ** 2; }
    return { rmse: Math.sqrt(se / n), n, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.sqrt(v / n)])) }; };
  const out = { tests: tests.map(label), samples: tests.map(y => R[y].S.length), note: 'RMSE of the 9-cat value of a fill-in\'s line the night a regular sat (z per game against the season\'s 15+ minute player-games), out of sample; gain = % less error than usual', models: {}, groups: {} };
  console.log('\n== A fill-in\'s night when a regular sits (RMSE, out of sample: value · min · pts · reb · ast · 3pm)');
  const base = err(tests, 'usual');
  for (const m of MODELS) { const e = err(tests, m); out.models[m] = { ...Object.fromEntries(Object.entries(e).map(([k, v]) => [k, +(+v).toFixed(3)])), gainPct: +((1 - e.rmse / base.rmse) * 100).toFixed(1) };
    console.log(`${m.padEnd(7)} ${e.rmse.toFixed(3)} ${((out.models[m].gainPct >= 0 ? '+' : '') + out.models[m].gainPct + '%').padStart(7)}  ${['min', 'pts', 'reb', 'ast', 'tpm'].map(k => e[k].toFixed(2)).join(' · ')}`); }
  // K fitted on two seasons, scored on the third
  let se = 0, n = 0; const folds = [];
  for (const y of tests) { const tr = tests.filter(t => t !== y); let best = null; for (const K of KS) { const e = err(tr, 'wo' + K); if (!best || e.rmse < best.e) best = { K, e: e.rmse }; }
    folds.push(best.K); const e = err([y], 'wo' + best.K); se += e.rmse ** 2 * e.n; n += e.n; }
  out.fit = { folds, rmse: +Math.sqrt(se / n).toFixed(3), gainPct: +((1 - Math.sqrt(se / n) / base.rmse) * 100).toFixed(1) };
  console.log(`fitted K per fold ${folds.join(' / ')}: ${out.fit.rmse} (${out.fit.gainPct}% vs usual)`);
  const Kb = [...folds].sort((a, b) => folds.filter(v => v === a).length - folds.filter(v => v === b).length).pop(), mb = 'wo' + Kb;
  // by games without that regular so far
  console.log(`\n== By games he already had without that regular (${mb} vs nm vs usual)`);
  for (const [lab, f] of [['0', s => !s.wg], ['1-2', s => s.wg >= 1 && s.wg <= 2], ['3-5', s => s.wg >= 3 && s.wg <= 5], ['6+', s => s.wg >= 6]]) {
    const a = err(tests, mb, f), b = err(tests, 'nm', f), c = err(tests, 'usual', f); out.groups[lab] = { n: a.n, best: +a.rmse.toFixed(3), nm: +b.rmse.toFixed(3), usual: +c.rmse.toFixed(3) };
    console.log(`  ${lab.padEnd(4)} n ${String(a.n).padStart(6)}  ${a.rmse.toFixed(3)} / ${b.rmse.toFixed(3)} / ${c.rmse.toFixed(3)}`); }
  // the page's tags, on the best model
  const tags = ys => { const o = { smash: [], good: [], all: [] };
    for (const y of ys) { const { S, T60, T75, T100 } = R[y]; for (const s of S) { const v = s.val(s.pred[mb]), u = s.val(s.pred.usual), a = s.val(s.act); if (u >= T75) continue;
      const hit = { a, h100: a >= T100, h60: a >= T60, wg: s.wg }; o.all.push(hit); if (v >= T60) o.smash.push(hit); else if (v >= T100) o.good.push(hit); } }
    const sum = L => ({ n: L.length, meanValue: +mean(L.map(h => h.a)).toFixed(3), top100Pct: +(100 * mean(L.map(h => +h.h100))).toFixed(1), top60Pct: +(100 * mean(L.map(h => +h.h60))).toFixed(1) });
    return { smash: sum(o.smash), good: sum(o.good), allFillIns: sum(o.all), smashBy: Object.fromEntries([['0', h => !h.wg], ['1-2', h => h.wg >= 1 && h.wg <= 2], ['3+', h => h.wg >= 3]].map(([k, f]) => [k, sum(o.smash.filter(f))])) }; };
  out.tags = { model: mb, past: tags(tests), ...(cur ? { thisSeason: tags([cur]) } : {}) };
  for (const [k, v] of Object.entries(out.tags)) if (k !== 'model') {
    console.log(`\n== Tags (${k === 'past' ? 'three past seasons' : 'this season so far'}, ${mb}): n · mean value · came through at top-100 / top-60 level`);
    for (const t of ['smash', 'good', 'allFillIns']) console.log(`  ${t.padEnd(10)} ${String(v[t].n).padStart(6)}  ${v[t].meanValue.toFixed(2).padStart(6)}  ${v[t].top100Pct}% / ${v[t].top60Pct}%`);
    console.log(`  smash by games without him so far: ${Object.entries(v.smashBy).map(([g, s]) => `${g}: ${s.top60Pct}% top-60 (${s.n})`).join(' · ')}`);
  }
  return out;
}

function mock(years) {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const G = {};
  for (const y of years) {
    const P = [...Array(150)].map((_, i) => ({ id: String(i), team: 'T' + (i % 10), pos: ['G', 'F', 'C'][i % 3], m: i % 15 < 5 ? 32 : 8 + rnd() * 18, u: .5 + rnd() }));
    G[y] = [...Array(80)].map((_, k) => ({ date: `${y}-${String(k).padStart(3, '0')}`, rows: P.filter(p => rnd() > (p.m > 30 ? .12 : .05)).map(p => {
      const starOut = P.filter(q => q.team === p.team && q.m > 30).length, m = Math.max(2, p.m + (rnd() - .5) * 8), f = m / 36;
      return { id: p.id, team: p.team, pos: p.pos, min: Math.round(m), pts: Math.round(f * 16 * p.u * (1 + rnd() * .5)), reb: Math.round(f * 6 * rnd() * 2), ast: Math.round(f * 4 * p.u * rnd() * 2), stl: Math.round(rnd() * 2), blk: Math.round(rnd()), tpm: Math.round(rnd() * 3), to: Math.round(rnd() * 3), fgm: 4, fga: 9, ftm: 2, fta: 3 }; }) }));
  }
  return G;
}

(async () => {
  let G, tests, cur = null;
  if (MOCK) { G = mock([2022, 2023, 2024, 2025]); tests = [2023, 2024, 2025]; }
  else {
    const { loadGames } = require('./build-rankings.js');
    const now = new Date().toISOString().slice(0, 10);
    cur = (await (await fetch(`${API}/scoreboard?dates=${now.replace(/-/g, '')}`)).json()).leagues[0].season.year;
    const last = cur - 1; tests = [last - 2, last - 1, last]; G = {};
    for (const y of [last - 3, ...tests]) { G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
    G[cur] = await loadGames(now, '.cache/games.json'); console.log(`${label(cur)} so far: ${G[cur].length} games`);
  }
  const R = {}; for (const y of [...tests, ...(cur ? [cur] : [])]) R[y] = replay(G[y], G[y - 1]);
  const out = analyze(R, tests, cur);
  if (!MOCK) { fs.writeFileSync('data/backtest-smash.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-smash.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

/* Backtest: when a regular comes back from a long absence, how fast do his minutes return, and
 * how fast do the fill-ins' extra minutes go away? For the Proj tab's "next man up" ramp-up.
 *
 * Usage:  node backtest-return.js [seasons]    default 3, ending with the last completed season
 * Writes: data/backtest-return.json; prints the tables. Box scores come from .cache/season-YYYY.json.
 *
 * Absence = a regular (24+ min per team game over the 10 team games before it, 6+ played) misses
 * 5+ team games in a row and then plays again in the same season. Lengths are bucketed 5-9,
 * 10-19 and 20+ games. For return games 1..6:
 *   returner  minutes / his pre-absence mpg (per game played). A game he misses again counts 0.
 *   gainers   teammates whose minutes per team game during the absence rose 4+ over the 10 games
 *             before it. Kept = (minutes now - before) / (during - before): 1 = still has all of
 *             the extra minutes, 0 = back to his old role. A missed game counts 0 minutes.
 * Then a leave-one-season-out check (curve fitted on the other seasons, scored on the held-out
 * one, RMSE of minutes): returner FULL (his old minutes at once) vs CURVE; gainers BACK (old
 * minutes at once), STAY (keep the absence minutes) and CURVE.
 */
const fs = require('fs');
const { loadGames } = require('./build-rankings.js');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NSEAS = +process.argv[2] || 3, LOOK = 10, REG = 24, MINLEN = 5, NR = 6, GAIN = 4;
const label = y => `${y - 1}-${String(y).slice(2)}`;
const bucket = len => len < 10 ? '5-9' : len < 20 ? '10-19' : '20+';
const BKS = ['5-9', '10-19', '20+'];
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const years = [...Array(NSEAS)].map((_, i) => cur - 1 - i).reverse();
  const recs = [];   // {y, b, n, kind: 'ret'|'gain', pre, truth, g}
  let absences = 0;
  for (const y of years) {
    const games = (await loadGames(`${y}-05-01`, `.cache/season-${y}.json`)).sort((a, b) => a.date < b.date ? -1 : 1);
    const byTeam = {};
    for (const g of games) for (const t of new Set(g.rows.map(r => r.team))) (byTeam[t] || (byTeam[t] = [])).push(g);
    let here = 0;
    for (const [t, gs] of Object.entries(byTeam)) {
      const rows = gs.map(g => Object.fromEntries(g.rows.filter(r => r.team === t).map(r => [r.id, r])));
      const ids = [...new Set(rows.flatMap(rs => Object.keys(rs)))];
      const perTeamGame = (id, from, to) => { let s = 0; for (let k = from; k < to; k++) s += rows[k][id] ? rows[k][id].min : 0; return s / (to - from); };
      for (const R of ids) {
        let i = LOOK;
        while (i < gs.length) {
          if (rows[i][R]) { i++; continue; }
          const pre = rows.slice(i - LOOK, i), played = pre.filter(rs => rs[R]);
          const rPerTeam = perTeamGame(R, i - LOOK, i);
          let j = i; while (j < gs.length && !rows[j][R]) j++;
          const len = j - i;
          // j < gs.length: he came back this season (rows[j][R] is his first game back)
          if (played.length >= 6 && rPerTeam >= REG && len >= MINLEN && j < gs.length) {
            absences++; here++;
            const b = bucket(len), rMpg = mean(played.map(rs => rs[R].min));
            const nRet = Math.min(NR, gs.length - j);
            for (let n = 0; n < nRet; n++) {
              const rs = rows[j + n];
              recs.push({ y, b, n: n + 1, kind: 'ret', pre: rMpg, truth: rs[R] ? rs[R].min : 0, played: !!rs[R] });
            }
            for (const id of ids) if (id !== R) {
              const A = perTeamGame(id, i - LOOK, i), D = perTeamGame(id, i, j), g = D - A;
              if (g < GAIN) continue;
              const steady = pre.filter(rs => rs[id]).length >= 8;   // was in the rotation before, not hurt himself
              for (let n = 0; n < nRet; n++) {
                const rs = rows[j + n];
                recs.push({ y, b, n: n + 1, kind: 'gain', pre: A, g, truth: rs[id] ? rs[id].min : 0, steady, rPlayed: !!rs[R] });
              }
            }
          }
          i = j;
        }
      }
    }
    console.log(`${label(y)}: ${games.length} games; ${here} absences of ${MINLEN}+ games with a return`);
  }

  // Curves: returner ratio and gainers' kept share, by length bucket (and 'all') and return game.
  const curve = (rs, kind, b, n) => {
    const sel = rs.filter(r => r.kind === kind && r.n === n && (b === 'all' || r.b === b));
    const v = sel.map(r => kind === 'ret' ? r.truth / r.pre : clip((r.truth - r.pre) / r.g, -1, 2));
    return { mean: mean(v), med: med(v), n: sel.length };
  };
  const out = { seasons: years.map(label), absences, returner: {}, gainers: {}, bySeason: {}, check: {} };
  const fmt = x => isNaN(x) ? '  -  ' : x.toFixed(2).padStart(5);
  for (const kind of ['ret', 'gain']) {
    const key = kind === 'ret' ? 'returner' : 'gainers';
    console.log(`\n${kind === 'ret' ? 'Returner: minutes / his old mpg' : 'Gainers: share of the extra minutes kept'}  (mean, by return game)`);
    console.log('length   ' + [...Array(NR)].map((_, n) => `g${n + 1}`.padStart(6)).join('') + '   n (game 1)');
    for (const b of [...BKS, 'all']) {
      out[key][b] = [...Array(NR)].map((_, n) => { const c = curve(recs, kind, b, n + 1); return { mean: +c.mean.toFixed(3), med: +c.med.toFixed(3), n: c.n }; });
      console.log(b.padEnd(9) + out[key][b].map(c => ' ' + fmt(c.mean)).join('') + `   ${out[key][b][0].n}`);
    }
    out.bySeason[key] = {};
    console.log('by season (all lengths):');
    for (const y of years) {
      const rs = recs.filter(r => r.y === y);
      out.bySeason[key][label(y)] = [...Array(NR)].map((_, n) => +curve(rs, kind, 'all', n + 1).mean.toFixed(3));
      console.log(label(y).padEnd(9) + out.bySeason[key][label(y)].map(v => ' ' + fmt(v)).join(''));
    }
  }
  // Splits: returner's games he actually played; gainers who were steady before, on nights the
  // returner played vs sat again.
  const split = (name, rs, kind) => {
    out[name] = [...Array(NR)].map((_, n) => { const c = curve(rs, kind, 'all', n + 1); return { mean: +c.mean.toFixed(3), med: +c.med.toFixed(3), n: c.n }; });
    console.log(name.padEnd(26) + out[name].map(c => ' ' + fmt(c.mean)).join('') + `   n ${out[name][0].n}`);
  };
  console.log('\nSplits (mean, return games 1-6):');
  split('returner, games he played', recs.filter(r => r.kind === 'ret' && r.played), 'ret');
  const G = recs.filter(r => r.kind === 'gain');
  split('gainers, all', G, 'gain');
  split('gainers, steady before', G.filter(r => r.steady), 'gain');
  split('steady, returner played', G.filter(r => r.steady && r.rPlayed), 'gain');
  split('steady, returner sat', G.filter(r => r.steady && !r.rPlayed), 'gain');
  const ret = recs.filter(r => r.kind === 'ret');
  out.returnerMissedAgain = [...Array(NR)].map((_, n) => +(1 - mean(ret.filter(r => r.n === n + 1).map(r => r.played ? 1 : 0))).toFixed(3));
  console.log('\nReturner misses the game again: ' + out.returnerMissedAgain.map((v, n) => `g${n + 1} ${(v * 100).toFixed(0)}%`).join(', '));

  // Leave one season out: fit the curve (mean by bucket and game) on the other seasons, score here.
  const acc = {}, add = (k, e) => { const a = acc[k] || (acc[k] = [0, 0]); a[0] += e * e; a[1]++; };
  for (const y of years) {
    const train = recs.filter(r => r.y !== y), test = recs.filter(r => r.y === y);
    const cache = {};
    const c = (kind, b, n) => { const k = kind + b + n; if (!(k in cache)) { const v = curve(train, kind, b, n); cache[k] = v.n >= 20 ? v.mean : curve(train, kind, 'all', n).mean; } return cache[k]; };
    for (const r of test) {
      const t = `g${Math.min(r.n, 4)}${r.n >= 4 ? '+' : ''}`;
      if (r.kind === 'ret') {
        const p = { FULL: r.pre, CURVE: r.pre * c('ret', r.b, r.n) };
        for (const [m, v] of Object.entries(p)) { add(`ret ${m} all`, v - r.truth); add(`ret ${m} ${t}`, v - r.truth); }
      } else {
        const p = { BACK: r.pre, STAY: r.pre + r.g, CURVE: r.pre + r.g * c('gain', r.b, r.n) };
        for (const [m, v] of Object.entries(p)) { add(`gain ${m} all`, v - r.truth); add(`gain ${m} ${t}`, v - r.truth); }
      }
    }
  }
  const cols = ['all', 'g1', 'g2', 'g3', 'g4+'];
  console.log('\nOut-of-sample RMSE of minutes (lower = better), % vs the first rule\n' + 'rule'.padEnd(14) + cols.map(c => c.padEnd(14)).join(''));
  for (const [kind, ms] of [['ret', ['FULL', 'CURVE']], ['gain', ['BACK', 'STAY', 'CURVE']]]) {
    for (const m of ms) {
      out.check[`${kind} ${m}`] = {};
      console.log(`${kind} ${m}`.padEnd(14) + cols.map(col => {
        const [se, n] = acc[`${kind} ${m} ${col}`] || [0, 1], e = Math.sqrt(se / n);
        const [sb, nb] = acc[`${kind} ${ms[0]} ${col}`] || [0, 1], base = Math.sqrt(sb / nb);
        out.check[`${kind} ${m}`][col] = { rmse: +e.toFixed(3), vsFirst: +((e / base - 1) * 100).toFixed(1), n };
        return `${e.toFixed(2)}${m === ms[0] ? '' : ` (${((e / base - 1) * 100).toFixed(0)}%)`}`.padEnd(14);
      }).join(''));
    }
  }
  fs.writeFileSync('data/backtest-return.json', JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

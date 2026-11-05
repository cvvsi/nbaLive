/* Backtest: during a long absence, does what the team did in the games already missed predict
 * the rest of the absence better than a fixed rule? For the Proj tab's "next man up" minutes.
 *
 * Usage:  node backtest-absence.js [seasons]    default 3, ending with the last completed season
 * Writes: data/backtest-absence.json; prints the tables. Box scores come from .cache/season-YYYY.json.
 *
 * Absence = a regular (24+ min per team game over the 10 team games before it, 6+ played) misses
 * 3+ team games in a row. For game k of the absence (k >= 2), every teammate who played it, or
 * was expected to play 10+ minutes, is predicted by:
 *   A     no adjustment: his minutes per team game in the 10 games before the absence
 *   E50   A + half the missing player's minutes, shared by the same position group by A
 *   SEEN  his average minutes in games 1..k-1 of this absence (the team's own pattern)
 *   MIX1/MIX2  SEEN blended with E50 as if E50 were 1 / 2 extra games: (n*SEEN + w*E50)/(n + w)
 * Error = RMSE of predicted vs actual minutes (0 if he didn't play). Reported for everyone, for
 * the promoted starter (started game k-1 of the absence but under half the games before it), and
 * for the teammate whose minutes rose most in the games already missed.
 */
const fs = require('fs');
const { loadGames } = require('./build-rankings.js');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NSEAS = +process.argv[2] || 3, LOOK = 10, REG = 24, MINLEN = 3;
const grp = p => /C/.test(p) ? 'C' : /F/.test(p) ? 'F' : /G/.test(p) ? 'G' : '?';
const label = y => `${y - 1}-${String(y).slice(2)}`;
const RULES = ['A', 'E50', 'SEEN', 'MIX1', 'MIX2'];

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const years = [...Array(NSEAS)].map((_, i) => cur - 1 - i).reverse();
  const acc = {}, add = (k, c, e) => { const a = ((acc[k] || (acc[k] = {}))[c]) || (acc[k][c] = [0, 0]); a[0] += e * e; a[1]++; };
  let stretches = 0, lens = [];
  for (const y of years) {
    const games = (await loadGames(`${y}-05-01`, `.cache/season-${y}.json`)).sort((a, b) => a.date < b.date ? -1 : 1);
    const byTeam = {};
    for (const g of games) for (const t of new Set(g.rows.map(r => r.team))) (byTeam[t] || (byTeam[t] = [])).push(g);
    for (const [t, gs] of Object.entries(byTeam)) {
      const rows = gs.map(g => Object.fromEntries(g.rows.filter(r => r.team === t).map(r => [r.id, r])));
      const pos = {}; for (const rs of rows) for (const r of Object.values(rs)) if (r.pos) pos[r.id] = r.pos;
      const ids = [...new Set(rows.flatMap(rs => Object.keys(rs)))];
      for (const R of ids) {
        let i = LOOK;
        while (i < gs.length) {
          if (rows[i][R]) { i++; continue; }
          const pre = rows.slice(i - LOOK, i), played = pre.filter(rs => rs[R]).length;
          const rMin = pre.reduce((a, rs) => a + (rs[R] ? rs[R].min : 0), 0) / LOOK;
          let j = i; while (j < gs.length && !rows[j][R]) j++;
          const len = j - i;
          if (played >= 6 && rMin >= REG && len >= MINLEN) {
            stretches++; lens.push(len);
            const A = {}, st = {};
            for (const id of ids) if (id !== R) {
              A[id] = pre.reduce((a, rs) => a + (rs[id] ? rs[id].min : 0), 0) / LOOK;
              st[id] = pre.filter(rs => rs[id] && rs[id].st).length;
            }
            const same = Object.keys(A).filter(id => grp(pos[id] || '') === grp(pos[R] || '') && A[id] > 0);
            const tot = same.reduce((a, id) => a + A[id], 0) || 1;
            const E = Object.fromEntries(Object.keys(A).map(id => [id, A[id] + (same.includes(id) ? rMin * .5 * A[id] / tot : 0)]));
            for (let k = i + 1; k < j; k++) {
              const seenG = rows.slice(i, k), n = seenG.length;
              const seen = id => seenG.reduce((a, rs) => a + (rs[id] ? rs[id].min : 0), 0) / n;
              const prevStarter = rows[k - 1];
              const promoted = Object.keys(A).filter(id => prevStarter[id] && prevStarter[id].st && st[id] < LOOK / 2);
              const gainer = Object.keys(A).sort((a, b) => (seen(b) - A[b]) - (seen(a) - A[a]))[0];
              for (const id of Object.keys(A)) {
                const truth = rows[k][id] ? rows[k][id].min : 0;
                if (!rows[k][id] && A[id] < 10 && seen(id) < 10) continue;
                const sv = seen(id), pr = { A: A[id], E50: E[id], SEEN: sv, MIX1: (n * sv + E[id]) / (n + 1), MIX2: (n * sv + 2 * E[id]) / (n + 2) };
                for (const r of RULES) {
                  const e = Math.min(42, pr[r]) - truth;
                  add(r, 'all', e); add(r, `k${Math.min(k - i + 1, 5)}`, e);
                  if (promoted.includes(id)) add(r, 'promoted', e);
                  if (id === gainer) add(r, 'gainer', e);
                }
              }
            }
          }
          i = j;
        }
      }
    }
    console.log(`${label(y)}: ${games.length} games; ${stretches} absences of ${MINLEN}+ games so far`);
  }
  lens.sort((a, b) => a - b);
  console.log(`\nAbsences: ${stretches}, median length ${lens[lens.length >> 1]} games`);
  const cols = ['all', 'k2', 'k3', 'k4', 'k5', 'promoted', 'gainer'];
  const head = { all: 'all', k2: 'game 2', k3: 'game 3', k4: 'game 4', k5: 'game 5+', promoted: 'new starter', gainer: 'top gainer' };
  console.log('\nRMSE of minutes (lower = better), % vs A\nrule  ' + cols.map(c => head[c].padEnd(16)).join(''));
  const out = { seasons: years.map(label), absences: stretches, rules: {} };
  for (const r of RULES) {
    out.rules[r] = {};
    console.log(r.padEnd(6) + cols.map(c => { const [se, n] = acc[r][c] || [0, 1], e = Math.sqrt(se / n), [sa, na] = acc.A[c] || [0, 1], a = Math.sqrt(sa / na);
      out.rules[r][c] = { rmse: +e.toFixed(3), vsA: +((e / a - 1) * 100).toFixed(1), n };
      return `${e.toFixed(2)} ${r === 'A' ? '' : '(' + ((e / a - 1) * 100).toFixed(0) + '%)'}`.padEnd(16); }).join(''));
  }
  console.log('n per column: ' + cols.map(c => `${head[c]} ${(acc.A[c] || [0, 0])[1]}`).join(', '));
  fs.writeFileSync('data/backtest-absence.json', JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

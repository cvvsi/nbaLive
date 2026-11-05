/* Backtest: when a regular misses a game, where do his minutes go? Tests rules for shifting a
 * missing player's minutes to healthy teammates, for the Proj tab's "next man up" adjustment.
 *
 * Usage:  node backtest-injury.js [seasons]    default 3, ending with the last completed season
 * Fetches each season's box scores from ESPN (cached in .cache/season-YYYY.json).
 * Writes:  data/backtest-injury.json; prints the tables.
 *
 * For every team game after the team's 10th, a "regular" is a player averaging 24+ minutes in
 * the team's previous 10 games (6+ of them played). If a regular is missing from the box score
 * (didn't play), each healthy teammate's minutes are predicted by:
 *   A  no adjustment: his average over his last 10 games played (what Proj does today)
 *   B  same position group (G / F / C) shares the missing minutes, by current minutes
 *   C  the whole team shares them, by current minutes
 *   D  handcuff: the top same-group bench player gets HC of them, the rest of the group shares
 *      the remainder
 *   E  partial: only a fraction of the missing minutes moves (same group), the rest vanishes
 * Every rule caps a player at 40 minutes. Error = RMSE of predicted vs actual minutes for the
 * teammates who played; also reported for same-group teammates only, and for the handcuff.
 */
const fs = require('fs');
const { loadGames } = require('./build-rankings.js');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NSEAS = +process.argv[2] || 3, LOOK = 10, REG_MIN = 24, CAP = 40;
const grp = p => /C/.test(p) ? 'C' : /F/.test(p) ? 'F' : /G/.test(p) ? 'G' : '?';   // FC -> C, GF/SF/PF -> F
const label = y => `${y - 1}-${String(y).slice(2)}`;

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const years = [...Array(NSEAS)].map((_, i) => cur - 1 - i).reverse();
  const out = { seasons: years.map(label), rules: {} };
  const acc = {}; const add = (rule, key, e) => { const a = (acc[rule] || (acc[rule] = {}))[key] || (acc[rule][key] = [0, 0]); a[0] += e * e; a[1]++; };
  let events = 0, posMiss = 0, posAll = 0;
  for (const y of years) {
    const games = (await loadGames(`${y}-05-01`, `.cache/season-${y}.json`)).sort((a, b) => a.date < b.date ? -1 : 1);
    const byTeam = {};
    for (const g of games) for (const t of new Set(g.rows.map(r => r.team))) (byTeam[t] || (byTeam[t] = [])).push(g);
    for (const [t, gs] of Object.entries(byTeam)) {
      const pos = {};
      for (let i = LOOK; i < gs.length; i++) {
        const prev = gs.slice(i - LOOK, i), cur = gs[i].rows.filter(r => r.team === t);
        const hist = {};   // id -> { mins:[...], st, pos }
        for (const g of prev) for (const r of g.rows) if (r.team === t) {
          const h = hist[r.id] || (hist[r.id] = { mins: [], st: 0 }); h.mins.push(r.min); h.st += r.st || 0; if (r.pos) pos[r.id] = r.pos;
        }
        for (const r of cur) if (r.pos) pos[r.id] = r.pos;
        const avg = id => { const m = hist[id].mins; return m.reduce((a, v) => a + v, 0) / m.length; };
        const played = new Set(cur.map(r => r.id));
        const regs = Object.keys(hist).filter(id => hist[id].mins.length >= 6 && hist[id].mins.reduce((a, v) => a + v, 0) / LOOK >= REG_MIN);
        const missing = regs.filter(id => !played.has(id));
        if (!missing.length) continue;
        events++;
        const mates = cur.filter(r => hist[r.id] && hist[r.id].mins.length >= 3);   // healthy teammates with a recent role
        for (const r of mates) { posAll++; if (grp(pos[r.id] || '') === '?') posMiss++; }
        const base = Object.fromEntries(mates.map(r => [r.id, avg(r.id)]));
        const share = (ids, mins) => { const tot = ids.reduce((a, id) => a + base[id], 0) || 1; const o = {}; for (const id of ids) o[id] = mins * base[id] / tot; return o; };
        const preds = { A: { ...base }, B: { ...base }, C: { ...base }, D: { ...base }, E50: { ...base }, E75: { ...base }, D70: { ...base } };
        const isSame = {}, isCuff = {};
        for (const m of missing) {
          const gm = grp(pos[m] || ''), mm = avg(m);
          const same = mates.filter(r => grp(pos[r.id] || '') === gm).map(r => r.id);
          const all = mates.map(r => r.id);
          const tgt = same.length ? same : all;
          for (const [id, v] of Object.entries(share(tgt, mm))) preds.B[id] += v;
          for (const [id, v] of Object.entries(share(all, mm))) preds.C[id] += v;
          for (const [f, k] of [[.5, 'E50'], [.75, 'E75']]) for (const [id, v] of Object.entries(share(tgt, mm * f))) preds[k][id] += v;
          // handcuff: the same-group player with the most minutes who mostly came off the bench
          const bench = tgt.filter(id => hist[id].st <= hist[id].mins.length / 2).sort((a, b) => base[b] - base[a]);
          const cuff = bench[0];
          for (const [hc, k] of [[.5, 'D'], [.7, 'D70']]) {
            if (cuff) { preds[k][cuff] += mm * hc; const rest = tgt.filter(id => id !== cuff); for (const [id, v] of Object.entries(share(rest.length ? rest : [cuff], mm * (1 - hc)))) preds[k][id] += v; }
            else for (const [id, v] of Object.entries(share(tgt, mm))) preds[k][id] += v;
          }
          for (const id of same) isSame[id] = 1; if (cuff) isCuff[cuff] = 1;
        }
        for (const r of mates) for (const [k, p] of Object.entries(preds)) {
          const e = Math.min(CAP, p[r.id]) - r.min;
          add(k, 'all', e); if (isSame[r.id]) add(k, 'same', e); if (isCuff[r.id]) add(k, 'cuff', e);
        }
      }
    }
    console.log(`${label(y)}: ${games.length} games, ${events} team-games with a regular out so far`);
  }
  console.log(`\nTeammates with no position: ${posMiss}/${posAll}`);
  console.log('\nRMSE of predicted minutes (lower = better); change vs A (no adjustment)');
  console.log('rule  all teammates        same position        the handcuff');
  const names = { A: 'none', B: 'same group', C: 'whole team', D: 'handcuff 50%', D70: 'handcuff 70%', E50: 'same group, 50% moves', E75: 'same group, 75% moves' };
  const A = acc.A;
  for (const k of ['A', 'B', 'C', 'E50', 'E75', 'D', 'D70']) {
    const cells = ['all', 'same', 'cuff'].map(c => { const [se, n] = acc[k][c] || [0, 1], e = Math.sqrt(se / n), a = Math.sqrt(A[c][0] / A[c][1]);
      return `${e.toFixed(2)} (${k === 'A' ? '   —  ' : ((e / a - 1) * 100).toFixed(1).padStart(5) + '%'}) n=${n}`.padEnd(21); });
    out.rules[k] = { name: names[k], ...Object.fromEntries(['all', 'same', 'cuff'].map(c => [c, +Math.sqrt((acc[k][c] || [0, 1])[0] / (acc[k][c] || [0, 1])[1]).toFixed(3)])) };
    console.log(`${k.padEnd(4)}  ${cells.join('')}  ${names[k]}`);
  }
  out.events = events;
  fs.writeFileSync('data/backtest-injury.json', JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });

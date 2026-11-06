/* Breakout study: find EVERY breakout over the cached seasons, then measure how often each
 * possible early sign was present in breakouts vs everyone else (its hit rate).
 *
 * Usage:  node study-signs.js
 * Writes: data/study-signs.json; prints the tables. Box scores: .cache/season-YYYY.json (the
 * Backtest workflow's cache, last five completed seasons).
 *
 * Two kinds of "before -> after":
 *   season    one season -> the next (4 pairs over 5 seasons); before needs 20+ games, after 30+
 *   inseason  a season's games before Dec 1 -> the rest of it (5 seasons); before 8+, after 25+
 * Rank = per-game 9-cat value in that window, scored against the window's top-130 pool (as on the
 * site). Breakout = after rank inside 130, at least 40% better than before and 20+ spots (the site's
 * MOVE rule), so 80 -> 40 counts as much as 250 -> 120. Every jump's size is kept too.
 *
 * Signs, all from the BEFORE window only (what you could have seen at the time):
 *   up30      his per-minute line at 30 minutes ranks inside 100 (inside 60 = up30top)
 *   lowmin    under 24 mpg
 *   minup     minutes rising: last 10 games' mpg 4+ above the window's (season: after the All-Star break)
 *   startup   started 5+ of his last 10 games but under half before them
 *   lowusg    usage under 19% with FG% at or above the league's (efficient, low usage)
 *   hiusgev   earlier evidence of usage: a season before this one at 23%+ usage (season pairs only)
 *   stl/blk/tpm  sticky category: 1.6+ steals, 1.5+ blocks or 2.8+ threes per 36
 *   coldfg    FG% 4+ points under his own other seasons' (or 42% or lower for a first-year player)
 *   newteam   on a different team in the after window (season pairs) or traded mid-window
 *   yr1-2 / yr3-4   seasons in the league, only for players who arrived after our first cached
 *             season (a checklist item, never a filter); yr5+ can't be told apart from unknown
 * Each sign: how many had it, how many of those broke out, the hit rate vs the base rate (lift).
 */
const fs = require('fs');
const { loadGames, rankWindow, CATS } = require('./build-rankings.js');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ROST = 130, MOVE = .6, MIN_JUMP = 20;
const label = y => `${y - 1}-${String(y).slice(2)}`;
const ALLSTAR = new Set(['STARS', 'WORLD', 'USA', 'STRIPES', 'EAST', 'WEST', 'LEBRON', 'GIANNIS', 'DURANT', 'CANDACE', 'CHUCK', 'KENNY', 'SHAQ']);
const SIGNS = ['up30', 'up30top', 'lowmin', 'minup', 'startup', 'lowusg', 'hiusgev', 'stl', 'blk', 'tpm', 'coldfg', 'newteam', 'yr1-2', 'yr3-4', 'yr5+'];

// Per-player rows (with usage terms) for a list of games, All-Star games left out.
function rowsOf(games) {
  const by = {};
  for (const g of [...games].sort((a, b) => a.date < b.date ? -1 : 1)) {
    if (g.rows.some(r => ALLSTAR.has(r.team))) continue;
    const T = {};
    for (const r of g.rows) { const t = T[r.team] || (T[r.team] = { min: 0, poss: 0 }); t.min += r.min; t.poss += r.fga + .44 * r.fta + r.to; }
    for (const r of g.rows) { const t = T[r.team]; (by[r.id] || (by[r.id] = [])).push({ ...r, date: g.date, use: r.fga + .44 * r.fta + r.to, tpos: r.min * t.poss / (t.min / 5) }); }
  }
  return by;
}
const KS = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpa', 'use', 'tpos', 'st'];
const sumRows = rs => { const t = Object.fromEntries(KS.map(k => [k, 0])); for (const r of rs) for (const k of KS) t[k] += r[k] || 0; t.gp = rs.length; return t; };
// Ranks for one window: per-game value on the window's own top-130 pool; minGp to be ranked.
function ranked(games, minGp) {
  const P = rankWindow(games.filter(g => !g.rows.some(r => ALLSTAR.has(r.team)))), pool = P.pool;
  const order = P.filter(p => p.gp >= minGp).sort((a, b) => b.value - a.value);
  return { pool, rank: Object.fromEntries(order.map((p, i) => [p.id, i + 1])), n: order.length };
}
// Value of a per-game line on a pool (all 9 cats).
const valOf = (l, pool) => CATS.reduce((a, c) => { const s = pool.st[c], v = { ...l, fgi: l.fgm - pool.lgFG * l.fga, fti: l.ftm - pool.lgFT * l.fta }; return a + (c === 'to' ? -1 : 1) * (v[s.k] - s.m) / s.sd; }, 0) / 9;

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const years = [cur - 5, cur - 4, cur - 3, cur - 2, cur - 1];
  const G = {}, ROWS = {}, TOT = {};
  for (const y of years) {
    G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`);
    ROWS[y] = rowsOf(G[y]);
    TOT[y] = Object.fromEntries(Object.entries(ROWS[y]).map(([id, rs]) => [id, sumRows(rs)]));
    console.error(`${label(y)}: ${G[y].length} games`);
  }
  const firstSeen = {};
  for (const y of years) for (const id in ROWS[y]) if (!(id in firstSeen)) firstSeen[id] = y;
  const lgFG = y => { let m = 0, a = 0; for (const t of Object.values(TOT[y])) { m += t.fgm; a += t.fga; } return m / a; };

  // Build the cases: one per player per before -> after pair.
  const cases = [];
  function addCases(kind, y, beforeGames, afterGames, beforeRowsOf, afterRowsOf, minB, minA, asb) {
    const B = ranked(beforeGames, minB), A = ranked(afterGames, minA), lg = lgFG(y);
    // the 30-minute line's rank: on the before pool, against everyone's actual before value
    const vals = Object.values(rankWindow(beforeGames.filter(g => !g.rows.some(r => ALLSTAR.has(r.team))))).filter(p => p.gp >= minB).map(p => p.value).sort((a, b) => b - a);
    const rankOfVal = v => 1 + vals.filter(x => x > v).length;
    for (const [id, rs] of Object.entries(beforeRowsOf)) {
      if (rs.length < minB || !B.rank[id]) continue;
      const ar = afterRowsOf[id]; if (!ar || ar.length < minA || !A.rank[id]) continue;
      const t = sumRows(rs), mpg = t.min / t.gp, per = k => t[k] / t.min;
      const l30 = Object.fromEntries(['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta'].map(k => [k, per(k) * 30]));
      const up = rankOfVal(valOf(l30, B.pool));
      const last = rs.slice(-10), lt = sumRows(last), early = rs.slice(0, -10);
      const minTrend = asb ? (() => { const pre = rs.filter(r => r.date < asb), post = rs.filter(r => r.date >= asb);
        return pre.length >= 5 && post.length >= 5 ? sumRows(post).min / post.length - sumRows(pre).min / pre.length : 0; })()
        : lt.min / lt.gp - mpg;
      const usg = t.tpos ? t.use / t.tpos : 0, fg = t.fga ? t.fgm / t.fga : 0;
      const p36 = k => per(k) * 36;
      // his FG% in his other cached seasons (not the after window)
      let om = 0, oa = 0; for (const yy of years) if (yy !== y && !(kind === 'season' && yy === y + 1)) { const o = TOT[yy][id]; if (o) { om += o.fgm; oa += o.fga; } }
      const seasons = y - firstSeen[id] + 1, known = firstSeen[id] > years[0];
      const teamsB = new Set(rs.map(r => r.team)), teamA = ar[ar.length - 1].team;
      let hiUsgEv = false; for (const yy of years) if (yy < y) { const o = TOT[yy][id]; if (o && o.gp >= 15 && o.tpos && o.use / o.tpos >= .23) hiUsgEv = true; }
      const br = B.rank[id], arank = A.rank[id], jump = br - arank;
      const s = {
        up30: up <= 100, up30top: up <= 60, lowmin: mpg < 24, minup: minTrend >= 4,
        startup: last.filter(r => r.st).length >= 5 && early.length >= 5 && early.filter(r => r.st).length < early.length / 2,
        lowusg: usg < .19 && fg >= lg, hiusgev: kind === 'season' && hiUsgEv,
        stl: p36('stl') >= 1.6, blk: p36('blk') >= 1.5, tpm: p36('tpm') >= 2.8,
        coldfg: oa >= 150 ? fg * 100 <= 100 * om / oa - 4 : seasons === 1 && fg <= .42,
        newteam: kind === 'season' ? !teamsB.has(teamA) || teamsB.size > 1 : teamsB.size > 1 || !teamsB.has(teamA),
        // seasons in the league, counted from our first cached season: unknown for anyone already
        // playing in it (he could be a rookie or a 10-year vet), so no year sign at all for them
        'yr1-2': known && seasons <= 2, 'yr3-4': known && seasons >= 3 && seasons <= 4, 'yr5+': known && seasons >= 5,
      };
      cases.push({ kind, y: label(y), id, n: ar[ar.length - 1].name, before: br, after: arank, jump, mpg: +mpg.toFixed(1), usg: +(100 * usg).toFixed(1), up30: up,
        breakout: arank <= ROST && arank <= br * MOVE && jump >= MIN_JUMP, signs: SIGNS.filter(k => s[k]) });
    }
  }
  for (let i = 0; i + 1 < years.length; i++) {
    const y = years[i], y2 = years[i + 1];
    addCases('season', y, G[y], G[y2], ROWS[y], ROWS[y2], 20, 30, `${y}-02-15`);
  }
  for (const y of years) {
    const cut = `${y - 1}-12-01`, early = G[y].filter(g => g.date < cut), late = G[y].filter(g => g.date >= cut);
    const er = {}, lr = {};
    for (const [id, rs] of Object.entries(ROWS[y])) { er[id] = rs.filter(r => r.date < cut); lr[id] = rs.filter(r => r.date >= cut); }
    addCases('inseason', y, early, late, er, lr, 8, 25, null);
  }

  // Hit rates.
  const out = { definition: `after rank <= ${ROST}, <= ${MOVE} x before, and ${MIN_JUMP}+ spots`, kinds: {}, breakouts: {} };
  for (const kind of ['season', 'inseason']) {
    const C = cases.filter(c => c.kind === kind), bo = C.filter(c => c.breakout), base = bo.length / C.length;
    out.breakouts[kind] = bo.sort((a, b) => b.jump - a.jump).map(c => ({ n: c.n, y: c.y, before: c.before, after: c.after, mpg: c.mpg, usg: c.usg, up30: c.up30, signs: c.signs }));
    const rows = SIGNS.map(k => { const w = C.filter(c => c.signs.includes(k)), wb = w.filter(c => c.breakout);
      return { sign: k, have: w.length, breakouts: wb.length, rate: w.length ? wb.length / w.length : 0, lift: w.length ? wb.length / w.length / base : 0, shareOfBreakouts: bo.length ? wb.length / bo.length : 0 }; });
    // the strongest pairs of signs
    const pairs = [];
    for (let i = 0; i < SIGNS.length; i++) for (let j = i + 1; j < SIGNS.length; j++) {
      const w = C.filter(c => c.signs.includes(SIGNS[i]) && c.signs.includes(SIGNS[j])); if (w.length < 25) continue;
      const wb = w.filter(c => c.breakout).length; pairs.push({ signs: `${SIGNS[i]} + ${SIGNS[j]}`, have: w.length, breakouts: wb, rate: wb / w.length, lift: wb / w.length / base });
    }
    pairs.sort((a, b) => b.lift - a.lift);
    // how many signs at once
    const bycount = [0, 1, 2, 3, 4, 5].map(nn => { const w = C.filter(c => Math.min(5, c.signs.filter(s => !s.startsWith('yr')).length) === nn), wb = w.filter(c => c.breakout).length; return { signs: nn === 5 ? '5+' : nn, have: w.length, breakouts: wb, rate: w.length ? wb / w.length : 0 }; });
    out.kinds[kind] = { cases: C.length, breakouts: bo.length, baseRate: base, signs: rows, topPairs: pairs.slice(0, 12), bySignCount: bycount };
    const pct = v => (100 * v).toFixed(1) + '%';
    console.log(`\n==== ${kind === 'season' ? 'Season to season' : 'In season (before Dec 1 -> rest)'}: ${C.length} player cases, ${bo.length} breakouts (base rate ${pct(base)})`);
    console.log('sign       have  breakouts  hit rate  lift   share of all breakouts');
    for (const r of rows.sort((a, b) => b.lift - a.lift)) console.log(`${r.sign.padEnd(10)} ${String(r.have).padStart(5)} ${String(r.breakouts).padStart(9)}   ${pct(r.rate).padStart(7)}  ${r.lift.toFixed(2).padStart(5)}  ${pct(r.shareOfBreakouts).padStart(7)}`);
    console.log('best pairs (25+ cases):'); for (const p of pairs.slice(0, 12)) console.log(`  ${p.signs.padEnd(22)} ${String(p.have).padStart(4)} cases, ${p.breakouts} breakouts, ${pct(p.rate)} (lift ${p.lift.toFixed(2)})`);
    console.log('number of signs (not counting years):'); for (const b of bycount) console.log(`  ${String(b.signs).padEnd(3)} ${String(b.have).padStart(5)} cases, ${b.breakouts} breakouts, ${pct(b.rate)}`);
    console.log(`breakouts found (${bo.length}):`); for (const c of out.breakouts[kind]) console.log(`  ${c.y} ${c.n}: #${c.before} -> #${c.after} | ${c.mpg} mpg, ${c.usg} usg, 30-min #${c.up30} | ${c.signs.join(', ')}`);
  }
  fs.writeFileSync('data/study-signs.json', JSON.stringify(out, null, 1));
  console.log('\ndata/study-signs.json written');
})().catch(e => { console.error(e); process.exit(1); });

/* Breakout study, v2: find every TRUE breakout over the cached seasons, and measure how often each
 * early sign was present in breakouts vs everyone else (its hit rate), comparing like with like.
 *
 * Usage:  node study-signs.js
 * Writes: data/study-signs.json; prints the tables. Box scores: .cache/season-YYYY.json (the
 * Backtest workflow's cache, last five completed seasons).
 *
 * 1. Season to season (4 pairs over 5 seasons; before 20+ games, after 30+).
 *    Rank = per-game 9-cat value, scored on that season's top-130 pool (as on the site).
 *    Breakout = after rank inside 130, 40%+ better than before and 20+ spots (the site's MOVE rule).
 *    TRUE breakout = also better than his best rank in EVERY earlier cached season, so comebacks
 *    from injury or a down year (Giannis, Lillard) don't count. Signs are measured within starting
 *    tiers (deep: outside 130, fringe: 81-130), since a #250 and a #90 face different odds.
 * 2. In season, at the role change itself. A trigger fires when, after 10+ games, his last 3 games
 *    average 6+ more minutes than the up-to-10 before them (and 22+), or he started the last 2 after
 *    starting under 30% before. Success = his next 20 games (10+ needed) rank inside 130 on the
 *    season's scale (inside 80 = big). One trigger per player per 20 games. Signs are read from
 *    the season so far at the trigger, so it's what the tracker could have seen then.
 *
 * Signs: up30 / up30top (his line at 30 minutes ranks inside 100 / 60), lowmin (under 24 mpg),
 * minup (season pairs: minutes up 4+ after the All-Star break), startup (season pairs: started 5+
 * of the last 10 after under half before), lowusg (usage under 19% with league-average FG% or
 * better), hiusgev (an earlier season at 23%+ usage), stl / blk / tpm (1.6 / 1.5 / 2.8 per 36),
 * coldfg (FG% 4+ points under his other seasons, or 42% or less as a first-year player), newteam,
 * opening (in season: a regular teammate, 24+ min, missed 2 of the last 3 games), bigjump (in
 * season: 10+ more minutes), started (in season: the trigger was moving into the starting five),
 * yr1-2 / yr3-4 (seasons in the league, only for players who arrived after our first season; a
 * checklist item, never a filter).
 */
const fs = require('fs');
const { loadGames, rankWindow, CATS } = require('./build-rankings.js');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ROST = 130, MOVE = .6, MIN_JUMP = 20;
const label = y => `${y - 1}-${String(y).slice(2)}`;
const ALLSTAR = new Set(['STARS', 'WORLD', 'USA', 'STRIPES', 'EAST', 'WEST', 'LEBRON', 'GIANNIS', 'DURANT', 'CANDACE', 'CHUCK', 'KENNY', 'SHAQ']);
const S_SEASON = ['up30', 'up30top', 'lowmin', 'minup', 'startup', 'lowusg', 'hiusgev', 'stl', 'blk', 'tpm', 'coldfg', 'newteam', 'yr1-2', 'yr3-4'];
const S_TRIG = ['up30', 'up30top', 'lowmin', 'lowusg', 'hiusgev', 'stl', 'blk', 'tpm', 'coldfg', 'newteam', 'opening', 'bigjump', 'started', 'yr1-2', 'yr3-4'];
const CHECK = ['Josh Hart', 'Cameron Johnson', 'Jalen Williams', 'Ivica Zubac', 'John Collins', 'Jordan Poole', 'Franz Wagner', 'Christian Braun',
  'Dennis Schroder', 'Scotty Pippen Jr.', 'Kevin Porter Jr.', 'Jalen Johnson', 'Ryan Rollins', 'Dyson Daniels', 'Nickeil Alexander-Walker',
  'Austin Reaves', 'Mikal Bridges', 'Jalen Duren', 'Alex Sarr', 'Norman Powell', 'Kyshawn George', 'Ty Jerome'];
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const CHECKN = new Set(CHECK.map(norm));

const notAS = g => !g.rows.some(r => ALLSTAR.has(r.team));
function rowsOf(games) {
  const by = {};
  for (const g of [...games].filter(notAS).sort((a, b) => a.date < b.date ? -1 : 1)) {
    const T = {};
    for (const r of g.rows) { const t = T[r.team] || (T[r.team] = { min: 0, poss: 0 }); t.min += r.min; t.poss += r.fga + .44 * r.fta + r.to; }
    for (const r of g.rows) { const t = T[r.team]; (by[r.id] || (by[r.id] = [])).push({ ...r, date: g.date, use: r.fga + .44 * r.fta + r.to, tpos: r.min * t.poss / (t.min / 5) }); }
  }
  return by;
}
const KS = ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpa', 'use', 'tpos', 'st'];
const sumRows = rs => { const t = Object.fromEntries(KS.map(k => [k, 0])); for (const r of rs) for (const k of KS) t[k] += r[k] || 0; t.gp = rs.length; return t; };
const valOf = (l, pool) => CATS.reduce((a, c) => { const s = pool.st[c], v = { ...l, fgi: l.fgm - pool.lgFG * l.fga, fti: l.ftm - pool.lgFT * l.fta }; return a + (c === 'to' ? -1 : 1) * (v[s.k] - s.m) / s.sd; }, 0) / 9;
const LINE = ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta'];
const perGame = t => Object.fromEntries(LINE.map(k => [k, t[k] / t.gp]));
const at30 = t => Object.fromEntries(LINE.map(k => [k, t[k] / t.min * 30]));
const pct = v => (100 * v).toFixed(1) + '%';

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const years = [cur - 5, cur - 4, cur - 3, cur - 2, cur - 1];
  const G = {}, ROWS = {}, TOT = {}, SR = {}, SV = {};
  for (const y of years) {
    G[y] = (await loadGames(`${y}-05-01`, `.cache/season-${y}.json`)).filter(notAS);
    ROWS[y] = rowsOf(G[y]);
    TOT[y] = Object.fromEntries(Object.entries(ROWS[y]).map(([id, rs]) => [id, sumRows(rs)]));
    const P = rankWindow(G[y]), order = P.filter(p => p.gp >= 20).sort((a, b) => b.value - a.value);
    SR[y] = Object.fromEntries(order.map((p, i) => [p.id, i + 1]));
    SV[y] = { pool: P.pool, vals: order.map(p => p.value) };   // season scale: rank any per-game line on it
    console.error(`${label(y)}: ${G[y].length} games`);
  }
  const rankOn = (y, v) => 1 + SV[y].vals.filter(x => x > v).length;
  const firstSeen = {}; for (const y of years) for (const id in ROWS[y]) if (!(id in firstSeen)) firstSeen[id] = y;
  const lgFG = y => { let m = 0, a = 0; for (const t of Object.values(TOT[y])) { m += t.fgm; a += t.fga; } return m / a; };
  const nameOf = id => { for (const y of [...years].reverse()) if (ROWS[y][id]) { const rs = ROWS[y][id]; return rs[rs.length - 1].name; } return id; };
  // common per-player signs from a set of his rows in season y (season so far or a whole season)
  function baseSigns(id, y, rs, excludeYears) {
    const t = sumRows(rs), mpg = t.min / t.gp, usg = t.tpos ? t.use / t.tpos : 0, fg = t.fga ? t.fgm / t.fga : 0;
    const p36 = k => t[k] / t.min * 36, up = rankOn(y, valOf(at30(t), SV[y].pool));
    let om = 0, oa = 0; for (const yy of years) if (!excludeYears.includes(yy)) { const o = TOT[yy][id]; if (o) { om += o.fgm; oa += o.fga; } }
    const seasons = y - firstSeen[id] + 1, known = firstSeen[id] > years[0];
    let hiUsgEv = false; for (const yy of years) if (yy < y) { const o = TOT[yy][id]; if (o && o.gp >= 15 && o.tpos && o.use / o.tpos >= .23) hiUsgEv = true; }
    return { t, mpg, usg, up, s: {
      up30: up <= 100, up30top: up <= 60, lowmin: mpg < 24, lowusg: usg < .19 && fg >= lgFG(y), hiusgev: hiUsgEv,
      stl: p36('stl') >= 1.6, blk: p36('blk') >= 1.5, tpm: p36('tpm') >= 2.8,
      coldfg: oa >= 150 ? fg * 100 <= 100 * om / oa - 4 : seasons === 1 && fg <= .42,
      'yr1-2': known && seasons <= 2, 'yr3-4': known && seasons >= 3 && seasons <= 4 } };
  }
  const out = { definition: `breakout: rank inside ${ROST}, ${Math.round((1 - MOVE) * 100)}%+ better and ${MIN_JUMP}+ spots; true = also a new best vs every earlier cached season`, season: {}, trigger: {}, check: {} };

  // ---- 1. Season to season
  const SC = [];
  for (let i = 0; i + 1 < years.length; i++) {
    const y = years[i], y2 = years[i + 1], asb = `${y}-02-15`;
    for (const [id, rs] of Object.entries(ROWS[y])) {
      const br = SR[y][id], ar = SR[y2][id]; if (!br || !ar) continue;
      const b = baseSigns(id, y, rs, [y, y2]);
      const pre = rs.filter(r => r.date < asb), post = rs.filter(r => r.date >= asb);
      const last = rs.slice(-10), early = rs.slice(0, -10);
      const teamsB = new Set(rs.map(r => r.team)), after = ROWS[y2][id], teamA = after[after.length - 1].team;
      const best = Math.min(...years.filter(yy => yy <= y && SR[yy][id]).map(yy => SR[yy][id]));
      const s = { ...b.s,
        minup: pre.length >= 5 && post.length >= 5 && sumRows(post).min / post.length - sumRows(pre).min / pre.length >= 4,
        startup: last.filter(r => r.st).length >= 5 && early.length >= 5 && early.filter(r => r.st).length < early.length / 2,
        newteam: !teamsB.has(teamA) || teamsB.size > 1 };
      const bo = ar <= ROST && ar <= br * MOVE && br - ar >= MIN_JUMP;
      SC.push({ y: label(y), id, n: nameOf(id), before: br, after: ar, best, mpg: +b.mpg.toFixed(1), usg: +(100 * b.usg).toFixed(1), up30: b.up,
        breakout: bo, trueBo: bo && ar < best, comeback: bo && ar >= best, tier: br > ROST ? 'deep' : br > 80 ? 'fringe' : 'top80', signs: S_SEASON.filter(k => s[k]) });
    }
  }
  function table(C, signs, ok, minPair) {
    const base = C.filter(ok).length / C.length;
    const rows = signs.map(k => { const w = C.filter(c => c.signs.includes(k)), wb = w.filter(ok);
      return { sign: k, have: w.length, hits: wb.length, rate: w.length ? wb.length / w.length : 0, lift: w.length && base ? wb.length / w.length / base : 0 }; }).sort((a, b) => b.lift - a.lift);
    const pairs = [];
    for (let i = 0; i < signs.length; i++) for (let j = i + 1; j < signs.length; j++) {
      const w = C.filter(c => c.signs.includes(signs[i]) && c.signs.includes(signs[j])); if (w.length < minPair) continue;
      const wb = w.filter(ok).length; pairs.push({ signs: `${signs[i]} + ${signs[j]}`, have: w.length, hits: wb, rate: wb / w.length, lift: base ? wb / w.length / base : 0 });
    }
    pairs.sort((a, b) => b.lift - a.lift);
    return { cases: C.length, hits: C.filter(ok).length, base, signs: rows, pairs: pairs.slice(0, 15) };
  }
  function print(title, T) {
    console.log(`\n==== ${title}: ${T.cases} cases, ${T.hits} hits (base rate ${pct(T.base)})`);
    console.log('sign       have   hits  hit rate  lift');
    for (const r of T.signs) if (r.have) console.log(`${r.sign.padEnd(10)} ${String(r.have).padStart(5)} ${String(r.hits).padStart(5)}   ${pct(r.rate).padStart(7)}  ${r.lift.toFixed(2)}`);
    console.log('best pairs:'); for (const p of T.pairs) console.log(`  ${p.signs.padEnd(22)} ${String(p.have).padStart(4)} cases, ${p.hits} hits, ${pct(p.rate)} (lift ${p.lift.toFixed(2)})`);
  }
  for (const tier of ['deep', 'fringe']) {
    const T = table(SC.filter(c => c.tier === tier), S_SEASON, c => c.trueBo, tier === 'deep' ? 20 : 12);
    out.season[tier] = T; print(`Season to season, true breakouts, starting ${tier === 'deep' ? 'outside 130' : '81-130'}`, T);
  }
  out.season.trueBreakouts = SC.filter(c => c.trueBo).sort((a, b) => (b.before - b.after) - (a.before - a.after));
  out.season.comebacks = SC.filter(c => c.comeback).map(c => `${c.y} ${c.n} #${c.before}->#${c.after} (best before #${c.best})`);
  console.log(`\nTrue breakouts (${out.season.trueBreakouts.length}):`);
  for (const c of out.season.trueBreakouts) console.log(`  ${c.y} ${c.n}: #${c.before} -> #${c.after} | ${c.mpg} mpg, ${c.usg} usg, 30-min #${c.up30} | ${c.signs.join(', ')}`);
  console.log(`Comebacks left out (${out.season.comebacks.length}): ${out.season.comebacks.join('; ')}`);

  // ---- 2. In season, at the trigger
  const TC = [];
  for (const y of years) {
    // each team's games by date, with who played, and each player's minutes, for "a regular was out"
    const teamGames = {};
    for (const g of [...G[y]].sort((a, b) => a.date < b.date ? -1 : 1)) for (const t of new Set(g.rows.map(r => r.team)))
      (teamGames[t] || (teamGames[t] = [])).push({ date: g.date, mins: Object.fromEntries(g.rows.filter(r => r.team === t).map(r => [r.id, r.min])) });
    const opening = (team, dates, self) => {
      const tg = teamGames[team]; if (!tg) return false;
      const k = tg.findIndex(g => g.date === dates[0]); if (k < 10) return false;
      const prior = tg.slice(k - 10, k), recent = tg.slice(k, k + dates.length);
      const ids = new Set(prior.flatMap(g => Object.keys(g.mins)));
      for (const id of ids) { if (id === self) continue;
        const played = prior.filter(g => g.mins[id]).length, m = prior.reduce((a, g) => a + (g.mins[id] || 0), 0) / 10;
        if (played >= 6 && m >= 24 && recent.filter(g => !g.mins[id]).length >= 2) return true; }
      return false;
    };
    for (const [id, rs] of Object.entries(ROWS[y])) {
      for (let i = 13; i + 10 <= rs.length; i++) {
        const last3 = rs.slice(i - 3, i), prior = rs.slice(Math.max(0, i - 13), i - 3);
        const m3 = last3.reduce((a, r) => a + r.min, 0) / 3, mp = prior.reduce((a, r) => a + r.min, 0) / prior.length;
        const minT = m3 >= mp + 6 && m3 >= 22, stT = last3.slice(-2).every(r => r.st) && prior.filter(r => r.st).length < .3 * prior.length;
        if (!minT && !stT) continue;
        const soFar = rs.slice(0, i), next = rs.slice(i, i + 20);
        const b = baseSigns(id, y, soFar, [y]), before = rankOn(y, valOf(perGame(b.t), SV[y].pool));
        const after = rankOn(y, valOf(perGame(sumRows(next)), SV[y].pool));
        const prevTeam = (ROWS[y - 1] && ROWS[y - 1][id]) ? ROWS[y - 1][id][ROWS[y - 1][id].length - 1].team : null;
        const s = { ...b.s, newteam: (prevTeam && prevTeam !== rs[i - 1].team) || new Set(soFar.map(r => r.team)).size > 1,
          opening: opening(rs[i - 1].team, last3.map(r => r.date), id), bigjump: m3 >= mp + 10, started: stT };
        TC.push({ y: label(y), id, n: nameOf(id), date: rs[i - 1].date, gp: i, before, after, m3: +m3.toFixed(1), mp: +mp.toFixed(1),
          rostered: before <= ROST, hit: after <= ROST, big: after <= 80, signs: S_TRIG.filter(k => s[k]) });
        i += 19;   // one trigger per 20 games
      }
    }
  }
  const W = TC.filter(c => !c.rostered);   // waiver-wire triggers: the ones a tracker is for
  for (const [k, ok] of [['hit', c => c.hit], ['big', c => c.big]]) {
    const T = table(W, S_TRIG, ok, 25); out.trigger[k] = T;
    print(`In season, triggers for players outside 130 at the time: next 20 games ${k === 'hit' ? 'inside 130' : 'inside 80'}`, T);
  }
  const bySigns = [0, 1, 2, 3, 4].map(nn => { const w = W.filter(c => Math.min(4, c.signs.filter(s => !s.startsWith('yr') && s !== 'lowmin').length) === nn), wb = w.filter(c => c.hit).length;
    return { signs: nn === 4 ? '4+' : nn, have: w.length, hits: wb, rate: w.length ? wb / w.length : 0 }; });
  out.trigger.bySignCount = bySigns;
  console.log('number of setup signs at the trigger (not counting years or low minutes):'); for (const b of bySigns) console.log(`  ${String(b.signs).padEnd(3)} ${String(b.have).padStart(5)} triggers, ${b.hits} inside 130 next 20, ${pct(b.rate)}`);
  out.trigger.hits = W.filter(c => c.big).sort((a, b) => a.after - b.after).slice(0, 80);
  console.log('\nTriggers that turned into top-80 runs (best 80):');
  for (const c of out.trigger.hits) console.log(`  ${c.y} ${c.n} after game ${c.gp} (${c.date}): ${c.mp} -> ${c.m3} min, #${c.before} -> next 20 #${c.after} | ${c.signs.join(', ')}`);

  // ---- 3. The players you named
  console.log('\n==== Your players');
  for (const nm of CHECK) {
    const sc = SC.filter(c => norm(c.n) === norm(nm)), tc = TC.filter(c => norm(c.n) === norm(nm));
    out.check[nm] = { seasons: sc, triggers: tc };
    console.log(`${nm}:`);
    if (!sc.length && !tc.length) { console.log('  not found under this name'); continue; }
    for (const c of sc) console.log(`  ${c.y} -> next: #${c.before} -> #${c.after}${c.trueBo ? '  TRUE BREAKOUT' : c.comeback ? '  (comeback)' : ''} | best before #${c.best} | ${c.mpg} mpg ${c.usg} usg | ${c.signs.join(', ')}`);
    for (const c of tc) console.log(`  trigger ${c.y} game ${c.gp} (${c.date}): ${c.mp} -> ${c.m3} min, #${c.before} -> next 20 #${c.after}${c.big ? ' BIG' : c.hit ? ' hit' : ''} | ${c.signs.join(', ')}`);
  }
  fs.writeFileSync('data/study-signs.json', JSON.stringify(out, null, 1));
  console.log('\ndata/study-signs.json written');
})().catch(e => { console.error(e); process.exit(1); });

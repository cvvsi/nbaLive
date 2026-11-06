/* Case study: what did breakout players look like in the seasons before they broke out?
 * Season-by-season (and team-by-team, for players who moved) lines for a list of players:
 * games, starts, minutes (and before / after the All-Star break), usage, per-36 counting stats,
 * shooting, and the 9-cat per-game rank that season (top-130 pool, as on the site).
 *
 * Usage:  node study-breakout.js            the player list below
 * Writes: data/study-breakout.json; prints a table per player.
 * Box scores: .cache/season-YYYY.json for the last five completed seasons (the Backtest
 * workflow's cache) and .cache/games.json for this season.
 */
const fs = require('fs');
const { loadGames, rankWindow, totals, CATS } = require('./build-rankings.js');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NAMES = ['Nickeil Alexander-Walker', 'Dyson Daniels', 'Jalen Johnson', 'Austin Reaves', 'Mikal Bridges', 'Jalen Duren',
  'Alex Sarr', 'Norman Powell', 'Ryan Rollins', 'Kyshawn George', 'Ty Jerome'];
const label = y => `${y - 1}-${String(y).slice(2)}`;
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const r1 = v => Math.round(v * 10) / 10;

// One stint's line: per game, per 36, shooting, usage, starts, minutes before/after the break.
function line(rows, asb, pool) {
  const t = { gp: rows.length, st: 0, min: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, to: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpa: 0, use: 0, tpos: 0 };
  let preM = 0, preG = 0, postM = 0, postG = 0;
  for (const r of rows) {
    for (const k of ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta', 'tpa']) t[k] += r[k];
    t.st += r.st || 0; t.use += r.use; t.tpos += r.tpos;
    if (r.date < asb) { preM += r.min; preG++; } else { postM += r.min; postG++; }
  }
  const p36 = k => r1(t[k] * 36 / t.min), pc = (m, a) => a ? r1(100 * m / a) : null;
  const pg = Object.fromEntries(['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to', 'fgm', 'fga', 'ftm', 'fta'].map(k => [k, t[k] / t.gp]));
  // per-game 9-cat value of this stint on the season's pool
  const v = { ...pg, fgi: pg.fgm - pool.lgFG * pg.fga, fti: pg.ftm - pool.lgFT * pg.fta };
  const val = CATS.reduce((a, c) => { const s = pool.st[c]; return a + (c === 'to' ? -1 : 1) * (v[s.k] - s.m) / s.sd; }, 0) / 9;
  return { gp: t.gp, gs: t.st, mpg: r1(t.min / t.gp), preMpg: preG ? r1(preM / preG) : null, postMpg: postG ? r1(postM / postG) : null,
    usg: t.tpos ? r1(100 * t.use / t.tpos) : null,
    p36: { pts: p36('pts'), reb: p36('reb'), ast: p36('ast'), stl: p36('stl'), blk: p36('blk'), tpm: p36('tpm'), to: p36('to') },
    fg: pc(t.fgm, t.fga), ft: pc(t.ftm, t.fta), tp: pc(t.tpm, t.tpa), fta36: p36('fta'), tpa36: p36('tpa'), val: +val.toFixed(2) };
}

(async () => {
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const years = [cur - 5, cur - 4, cur - 3, cur - 2, cur - 1, cur];
  const want = new Set(NAMES.map(norm)), out = { players: {} };
  for (const y of years) {
    const games = y === cur
      ? await loadGames(new Date(Date.now() - 864e5).toISOString().slice(0, 10))
      : await loadGames(`${y}-05-01`, `.cache/season-${y}.json`);
    // season rank: per-game value, top-130 pool, like the site's season rank
    const scored = rankWindow(games), pool = scored.pool;
    const order = [...scored].filter(p => p.gp >= Math.min(20, Math.ceil(Math.max(...scored.map(q => q.gp)) / 3))).sort((a, b) => b.value - a.value);
    const rank = Object.fromEntries(order.map((p, i) => [p.id, i + 1]));
    // usage per row: possessions used vs team possessions while on the floor (as totals() does)
    const rowsBy = {};
    for (const g of games) {
      const T = {};
      for (const r of g.rows) { const t = T[r.team] || (T[r.team] = { min: 0, poss: 0 }); t.min += r.min; t.poss += r.fga + .44 * r.fta + r.to; }
      for (const r of g.rows) if (want.has(norm(r.name))) {
        const t = T[r.team];
        (rowsBy[norm(r.name)] || (rowsBy[norm(r.name)] = [])).push({ ...r, date: g.date, use: r.fga + .44 * r.fta + r.to, tpos: r.min * t.poss / (t.min / 5) });
      }
    }
    const asb = `${y}-02-15`;
    for (const [k, rows] of Object.entries(rowsBy)) {
      rows.sort((a, b) => a.date < b.date ? -1 : 1);
      const nm = rows[rows.length - 1].name, id = rows[0].id, P = out.players[nm] || (out.players[nm] = []);
      const teams = [...new Set(rows.map(r => r.team))];
      const season = { season: label(y), rank: rank[id] || null, ...line(rows, asb, pool) };
      if (teams.length > 1) season.stints = teams.map(t => ({ team: t, ...line(rows.filter(r => r.team === t), asb, pool) }));
      else season.team = teams[0];
      P.push(season);
    }
    console.error(`${label(y)}: ${games.length} games`);
  }
  for (const [nm, ss] of Object.entries(out.players)) {
    console.log(`\n== ${nm}`);
    console.log('season     team     rank  gp  gs  mpg (pre/post ASB)  usg  | per36: pts reb ast stl blk 3pm to | fg%  ft%  3p%  | val');
    const row = (s, team, sub) => console.log(`${(sub ? '  ' : '') + s.season}`.padEnd(11) + `${team}`.padEnd(9) + `${sub ? '' : (s.rank || '-')}`.toString().padStart(4) +
      ` ${String(s.gp).padStart(3)} ${String(s.gs).padStart(3)}  ${String(s.mpg).padStart(4)} (${s.preMpg ?? '-'}/${s.postMpg ?? '-'})`.padEnd(26) + ` ${String(s.usg).padStart(4)} |        ` +
      ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to'].map(k => String(s.p36[k]).padStart(4)).join('') + ` | ${s.fg} ${s.ft} ${s.tp} | ${s.val}`);
    for (const s of ss) {
      row(s, s.team || 'multi', false);
      for (const st of s.stints || []) row({ ...st, season: s.season }, st.team, true);
    }
  }
  fs.writeFileSync('data/study-breakout.json', JSON.stringify(out, null, 1));
  console.log('\ndata/study-breakout.json written');
})().catch(e => { console.error(e); process.exit(1); });

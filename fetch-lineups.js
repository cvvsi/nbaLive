/* Today's starting lineups from NBA.com (the data behind nba.com/players/todays-lineups):
 * each team's five (with PG/SG/SF/PF/C), marked Expected until the team announces and Confirmed
 * after (about 30 minutes before tip), plus the bench and inactive players.
 *   -> data/lineups.json { date, built, src, teams: { ESPN abbr: { status, five: [[name, pos]],
 *      bench: [name], inactive: [name] } } }
 * The Injuries tab uses it in place of the "last game's starters" guess whenever a team is listed.
 *
 * Usage:  node fetch-lineups.js [YYYYMMDD]   (default: today, US Eastern)
 * If NBA.com changes the file, the step fails and the page keeps its own projection.
 */
const fs = require('fs');
const OUT = 'data/lineups.json';
// NBA abbreviations -> the ESPN ones used everywhere else
const AB = { WAS: 'WSH', NOP: 'NO', UTA: 'UTAH', SAS: 'SA', NYK: 'NY', GSW: 'GS', PHO: 'PHX', BRK: 'BKN' };
const etYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()).replace(/-/g, '');
const HEAD = { 'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com', 'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (compatible; 9-cat-box lineups)' };

// Walk any JSON shape: a team object is one with a team abbreviation and a list of players that carry
// a lineup status. Keeps the code working if NBA.com nests things differently.
function teams(j) {
  const out = {};
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const ab = o.teamAbbreviation || o.teamTricode || o.teamAbbr, ps = o.players || o.roster;
    if (ab && Array.isArray(ps) && ps.some(p => p && (p.lineupStatus || p.rosterStatus))) {
      const t = AB[ab] || ab, name = p => p.playerName || [p.firstName, p.lastName].filter(Boolean).join(' ');
      const starters = ps.filter(p => p.position && String(p.position).trim()), rest = ps.filter(p => !starters.includes(p));
      const st = starters.map(p => p.lineupStatus).filter(Boolean);
      out[t] = { status: st.length && st.every(s => /confirm/i.test(s)) ? 'Confirmed' : 'Expected',
        five: starters.map(p => [name(p), p.position]),
        bench: rest.filter(p => !/inactive/i.test(p.rosterStatus || '')).map(name),
        inactive: ps.filter(p => /inactive/i.test(p.rosterStatus || '')).map(name) };
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(j);
  return out;
}

(async () => {
  const d = process.argv[2] || etYmd();
  const urls = [`https://stats.nba.com/js/data/leaders/00_daily_lineups_${d}.json`];
  let j = null, src = null;
  for (const u of urls) {
    try { const r = await fetch(u, { headers: HEAD }); console.log(u, r.status);
      if (r.ok) { const txt = await r.text(); try { j = JSON.parse(txt); src = u; break; } catch (e) { console.log('not JSON:', txt.slice(0, 200)); } } }
    catch (e) { console.log(u, e.message); }
  }
  if (!j) throw new Error('No lineup data');
  const T = teams(j);
  if (!Object.keys(T).length) { console.log('Shape:', JSON.stringify(j).slice(0, 600)); throw new Error('No teams parsed'); }
  fs.writeFileSync(OUT, JSON.stringify({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, built: new Date().toISOString(), src, teams: T }));
  console.log(`${OUT}: ${Object.keys(T).length} teams,`, Object.entries(T).map(([t, v]) => `${t} ${v.status[0]} ${v.five.length}`).join(', '));
})().catch(e => { console.error(e.message); process.exit(1); });

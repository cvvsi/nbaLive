/* The NBA's official injury report -> merged into data/injuries.json (ESPN's report, from
 * build-schedule.js). The league posts a PDF every 15 minutes on game days at
 *   https://ak-static.cms.nba.com/referee/injury/Injury-Report_YYYY-MM-DD_HH_MM{AM|PM}.pdf
 * (ET, 12-hour clock), listing each team's players for today's and tomorrow's games as Out,
 * Doubtful, Questionable, Probable or Available, with the reason. It's official and fresher than
 * ESPN's, but has no return dates, so it only overrides game-day status:
 *   Out / Doubtful      out for that game (ESPN's longer absence and return date kept if it has one)
 *   Questionable / Probable   plays, flagged (overrides an ESPN "Out" for that game: he's close)
 *   Available           cleared: an ESPN "Out" becomes Available
 * G League assignments are skipped. Writes data/nba-injuries.json (the parsed report) too.
 *
 * Usage:  node fetch-nba-injuries.js            the latest report (tries the last 3 hours)
 *         node fetch-nba-injuries.js file.pdf   a local PDF (testing)
 * Needs pdftotext (poppler-utils).
 */
const fs = require('fs'), { execFileSync } = require('child_process');
const INJ = 'data/injuries.json', OUT = 'data/nba-injuries.json', RANK = 'data/rankings.json';
const BASE = 'https://ak-static.cms.nba.com/referee/injury/Injury-Report_';
// The report's full team names -> the ESPN abbreviations used everywhere else.
const TEAMS = { 'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI',
  'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET', 'Golden State Warriors': 'GS',
  'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND', 'LA Clippers': 'LAC', 'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL',
  'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NO',
  'New York Knicks': 'NY', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SA', 'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTAH',
  'Washington Wizards': 'WSH' };
const STATUS = /\s{2,}(Out|Doubtful|Questionable|Probable|Available)(?:\s{2,}(.*))?$/;
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const etNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nextDay = s => { const t = new Date(s + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

// "Cenac Jr., Christopher" -> "Christopher Cenac Jr."
function flip(n) { const i = n.indexOf(','); if (i < 0) return n.trim(); const last = n.slice(0, i).trim(), first = n.slice(i + 1).trim();
  const m = last.match(/^(.*?)\s+(Jr\.|Sr\.|II|III|IV|V)$/); return m ? `${first} ${m[1]} ${m[2]}` : `${first} ${last}`; }

function parse(text) {
  const rows = []; let date = null, game = null, team = null, stamp = null, time = null;
  for (const line of text.split('\n')) {
    const st = line.match(/Injury Report:\s*(\S+\s+\S+\s*[AP]M)/); if (st) { stamp = st[1]; continue; }
    const d = line.match(/(\d{2})\/(\d{2})\/(\d{4})/); if (d) date = `${d[3]}-${d[1]}-${d[2]}`;
    const tm = line.match(/(\d{2}):(\d{2}) \(ET\)/); if (tm) time = `${+tm[1]}:${tm[2]}`;
    const g = line.match(/\b([A-Z]{2,3})@([A-Z]{2,3})\b/); if (g) game = g[0];
    for (const [full, ab] of Object.entries(TEAMS)) if (line.includes(full)) team = ab;
    if (/NOT YET SUBMITTED/i.test(line)) { rows.push({ date, time, game, team, name: null, status: 'Not yet submitted' }); continue; }
    const s = line.match(STATUS); if (!s || !team) continue;
    const before = line.slice(0, s.index).split(/\s{2,}/).filter(Boolean), raw = before[before.length - 1] || '';
    if (!raw.includes(',')) continue;
    rows.push({ date, time, game, team, name: flip(raw), status: s[1], reason: (s[2] || '').trim() });
  }
  return { stamp, rows };
}

async function latest() {
  const now = etNow();
  now.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
  for (let i = 0; i < 13; i++) {
    const t = new Date(now.getTime() - i * 15 * 60000), h = t.getHours() % 12 || 12;
    const url = `${BASE}${ymd(t)}_${String(h).padStart(2, '0')}_${String(t.getMinutes()).padStart(2, '0')}${t.getHours() < 12 ? 'AM' : 'PM'}.pdf`;
    const r = await fetch(url);
    if (r.ok) return { url, buf: Buffer.from(await r.arrayBuffer()) };
  }
  throw new Error('No NBA injury report in the last 3 hours');
}

(async () => {
  let pdf = process.argv[2], src = pdf;
  if (!pdf) { const { url, buf } = await latest(); pdf = '.cache/nba-injury.pdf'; fs.mkdirSync('.cache', { recursive: true }); fs.writeFileSync(pdf, buf); src = url; }
  const { stamp, rows } = parse(execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }));
  if (!rows.length) throw new Error('No rows parsed: the report layout may have changed');
  // Match names to ESPN ids: rankings' players and ESPN's injury list, by name + team, then name alone.
  const inj = JSON.parse(fs.readFileSync(INJ, 'utf8')), R = JSON.parse(fs.readFileSync(RANK, 'utf8')).players;
  const byNT = {}, byN = {};
  const add = (id, n, t) => { byNT[norm(n) + '|' + t] = id; (byN[norm(n)] || (byN[norm(n)] = new Set())).add(id); };
  for (const [id, p] of Object.entries(R)) add(id, p.n, p.t);
  for (const [id, v] of Object.entries(inj.players)) add(id, v[3], v[4]);
  const today = ymd(etNow()), seen = {}, unmatched = [];
  let changed = 0;
  for (const r of rows) {
    if (!r.name || !r.date || r.date < today || /^G League/i.test(r.reason || '')) continue;
    const id = byNT[norm(r.name) + '|' + r.team] || (byN[norm(r.name)] && byN[norm(r.name)].size === 1 ? [...byN[norm(r.name)]][0] : null);
    if (!id) { unmatched.push(`${r.name} (${r.team})`); continue; }
    if (seen[id] && seen[id] <= r.date) continue;   // the player's next game decides
    seen[id] = r.date;
    const e = inj.players[id], md = r.date.slice(5).replace('-', '/'), why = r.reason ? ` (${r.reason.replace(/^Injury\/Illness - /, '')})` : '';
    const note = `NBA report ${stamp || ''}: ${r.status} for ${md}${r.game ? ' ' + r.game : ''}${why}.`;
    const espnOut = e && /out|suspen/i.test(e[0]);
    let v;
    if (r.status === 'Out' || r.status === 'Doubtful') v = espnOut && e[1] && e[1] > r.date ? [e[0], e[1], `${note} ${e[2]}`, e[3], e[4]] : ['Out', nextDay(r.date), e ? `${note} ${e[2]}` : note, r.name, r.team];
    else if (r.status === 'Available') v = e ? ['Available', '', `${note} ${e[2]}`, e[3], e[4]] : null;
    else v = [r.status, e ? e[1] : '', e ? `${note} ${e[2]}` : note, e ? e[3] : r.name, e ? e[4] : r.team];
    if (v) { inj.players[id] = v; changed++; }
  }
  inj.nba = { stamp, src: String(src).replace(/^.*\//, ''), merged: changed };
  fs.writeFileSync(INJ, JSON.stringify(inj));
  // The day's history, for Schedule > Tonight's "changed since this morning": each player's status in
  // every report today, in order (only when it changes), and the first report's time.
  let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const day = prev && prev.day && prev.day.date === today ? prev.day : { date: today, first: stamp, hist: {} };
  for (const r of rows) if (r.name && r.date === today && !/^G League/i.test(r.reason || '')) {
    const k = `${r.team}|${r.name}`, h = day.hist[k] || (day.hist[k] = []);
    if (!h.length || h[h.length - 1][1] !== r.status) h.push([stamp, r.status]);
  }
  day.last = stamp;
  fs.writeFileSync(OUT, JSON.stringify({ stamp, src: String(src).replace(/^.*\//, ''), rows, day }));
  console.log(`NBA report ${stamp}: ${rows.length} rows, ${changed} merged into ${INJ}; unmatched: ${unmatched.length ? unmatched.join(', ') : 'none'}`);
})().catch(e => { console.error(e.message); process.exit(1); });

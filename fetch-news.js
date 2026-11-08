/* RotoWire's public NBA news RSS: https://www.rotowire.com/rss/news.php?sport=NBA
 * Each item is one player update: headline ("Jarrett Allen: Might return Monday"), the first
 * sentence of the blurb (often with the source: "..., Will Gotlieb of CHGO reports"), a link to the
 * player's RotoWire page and a time. The feed only holds the newest few items (5 when checked), so
 * this runs every 15 minutes and keeps every item it has seen for 3 days.
 *
 * Usage:  node fetch-news.js           fetch the feed, then apply it to data/injuries.json
 *         node fetch-news.js --apply   only apply the saved items (after ESPN's / the NBA's report
 *                                      rewrote injuries.json, in the other jobs)
 * Writes: data/news.json  { built, items: [ { g: guid, id: espnId|null, n: name, h: headline,
 *                           d: sentence, u: link, t: ISO time, p: parsed | null } ] }  newest first
 *
 * Every item is also read as a status, so the news moves everything that reads injuries.json
 * (availability by date, next-man-up minutes, Week / Today / Matchup / Schedule): p = { s: Out |
 * Doubtful | Questionable | Probable | Available | null, dt: the game it's about (YYYY-MM-DD: the
 * weekday or "tonight" in the text, else the team's next game), ret: return date for "out N weeks"
 * / "re-evaluated in N weeks" / "out for the season", mx: a minutes cap ("limited to 16-20
 * minutes" -> 20) }. Applied like the NBA's report: Out / Doubtful = out that game (or until ret),
 * Questionable / Probable = plays, flagged, Available = cleared; a minutes cap goes in field 5
 * ({ date: cap }), and an absence for a game past his next one in field 6 ([dates out]), so the games
 * before it still count. An item older than the NBA report already merged for that player is skipped
 * (the official report is newer), and items for past games are ignored.
 * Names are matched to ESPN ids from data/rankings.json + data/regression.json (+ injuries.json): full name, then
 * last name + first initial when that's unique. RotoWire's text is shown credited, with a link back.
 */
const fs = require('fs');

const URL = 'https://www.rotowire.com/rss/news.php?sport=NBA', OUT = 'data/news.json', INJ = 'data/injuries.json', KEEP_H = 72;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const dec = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
    : (ENT[e] ?? m))
  .replace(/\s+/g, ' ').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? dec(m[1]) : ''; };

// "Sun, 08 Nov 2026 2:16:00 PM PST" -> ISO (Pacific time, PST -8 / PDT -7)
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function when(s) {
  const m = s.match(/(\d{1,2}) (\w{3}) (\d{4}) (\d{1,2}):(\d\d)(?::(\d\d))? ?(AM|PM)? ?([A-Z]{3})?/i);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(); }
  let h = +m[4] % 12; if ((m[7] || '').toUpperCase() === 'PM') h += 12; else if (!m[7]) h = +m[4];
  const off = { PST: 8, PDT: 7, EST: 5, EDT: 4, UTC: 0, GMT: 0 }[(m[8] || 'PST').toUpperCase()] ?? 8;
  return new Date(Date.UTC(+m[3], MON[m[2].slice(0, 3)] ?? 0, +m[1], h + off, +m[5], +(m[6] || 0))).toISOString();
}

const key = n => String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
function index() {
  const full = {}, lf = {};
  for (const f of ['data/rankings.json', 'data/regression.json']) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    for (const [id, q] of Object.entries(j.players || {})) {
      if (!q || !q.n) continue; const k = key(q.n), w = k.split(' ');
      (full[k] || (full[k] = new Set())).add(id);
      const l = `${w[w.length - 1]}|${w[0][0]}`; (lf[l] || (lf[l] = new Set())).add(id);
    }
  }
  // players with no games yet (out since the start of the season) are only on the injury report
  try { const j = JSON.parse(fs.readFileSync('data/injuries.json', 'utf8'));
    for (const [id, r] of Object.entries(j.players || {})) { if (!r || !r[3]) continue; const k = key(r[3]), w = k.split(' ');
      if (!full[k]) full[k] = new Set([id]); const l = `${w[w.length - 1]}|${w[0][0]}`; if (!lf[l]) lf[l] = new Set([id]); } } catch (e) {}
  return name => { const k = key(name), w = k.split(' '); let c = full[k];
    if (!c || c.size !== 1) c = lf[`${w[w.length - 1]}|${(w[0] || ' ')[0]}`];
    return c && c.size === 1 ? [...c][0] : null; };
}


// ---- reading an item as a status
const ET = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const addDays = (s, n) => { const t = new Date(s + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const num = w => NUM[w] ?? +w;
function parse(h, d, t, team, sched) {
  const x = `${h}. ${d}`, lx = x.toLowerCase(), day0 = ET(new Date(t));
  let s = null;
  if (/won't be available|will not be available|unavailable|ruled out|won't play|will not play|will miss|is out\b|listed as out|out for|remain(s)? out|sidelined|won't suit up|will sit|not playing|inactive|out indefinitely|season-ending|undergo(es|ing)? surgery/.test(lx)) s = 'Out';
  else if (/doubtful/.test(lx)) s = 'Doubtful';
  else if (/questionable|game-time decision|uncertain|day-to-day/.test(lx)) s = 'Questionable';
  else if (/probable/.test(lx)) s = 'Probable';
  else if (/available|will play|cleared to (play|return)|upgraded|will return|returning|good to go|will start|starting|in the starting lineup|active for/.test(lx)) s = 'Available';
  // the game: "tonight", a weekday ("Monday's game", "on Tuesday"), else the team's next game
  const plays = dt => !team || ((sched[dt] || []).some(g => g.includes(team)));
  let dt = null;
  if (/\btonight\b|\btoday\b/.test(lx)) dt = day0;
  else { const m = lx.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (m) { const w = DAYS.indexOf(m[1]), w0 = new Date(day0 + 'T12:00:00Z').getUTCDay(); dt = addDays(day0, (w - w0 + 7) % 7); } }
  if (!dt) for (let i = 0; i < 10; i++) { const c = addDays(day0, i); if (plays(c) && (sched[c] || []).length) { dt = c; break; } }
  // how long: "out at least two weeks", "will miss 2-4 weeks", "re-evaluated in three weeks", season
  let ret = null;
  if (/for the (rest of the )?season|season-ending|out for the year/.test(lx)) ret = '2027-07-01';
  else { const m = lx.match(/(?:out|miss|sidelined|re-?evaluated|reevaluated)[^.]*?\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)(?:\s*(?:to|-|–)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve))?\s+(day|week|month)s?\b/);
    if (m) { const n = num(m[1]), k = m[3] === 'day' ? 1 : m[3] === 'week' ? 7 : 30; if (n > 0) { ret = addDays(day0, n * k); if (!s) s = 'Out'; } } }
  // a minutes cap: "limited to 16-20 minutes", "around 20 minutes", "minutes restriction"
  let mx = null; const mm = lx.match(/(?:limited to|restricted to|cap(?:ped)? (?:at|of)|around|roughly|about|no more than|up to)\s+(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s+minutes/);
  if (mm) mx = +(mm[2] || mm[1]); else if (/minutes (restriction|limit)/.test(lx)) mx = 20;
  return s || ret || mx ? { s, dt, ret, mx } : null;
}
// "11/08/26 05:30 PM" (ET) -> ms
const stampMs = st => { const m = String(st || '').match(/(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)\s*(AM|PM)/); if (!m) return 0;
  let h = +m[4] % 12; if (m[6] === 'PM') h += 12; return Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], h + 5, +m[5]); };
function apply(items, TEAM = {}, sched = {}) {
  let inj; try { inj = JSON.parse(fs.readFileSync(INJ, 'utf8')); } catch (e) { return 0; }
  const today = ET(new Date()), nextDay = s => addDays(s, 1);
  let n = 0;
  // oldest first, so the newest item for a player wins
  for (const i of [...items].reverse()) {
    if (!i.id || !i.p) continue; const p = i.p, e = inj.players[i.id], when = Date.parse(i.t);
    if (p.dt && p.dt < today && !(p.ret && p.ret > today)) continue;   // about a game already played
    const nbaT = e && /^NBA report /.test(e[2] || '') ? stampMs((e[2].match(/^NBA report ([^:]+:\d\d [AP]M)/) || [])[1]) : 0;
    const tm = new Date(when).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
    const note = `RotoWire ${tm}: ${i.d}`, name = e ? e[3] : i.n, team = (e && e[4]) || TEAM[i.id] || '';
    // his next game from today: an absence for that game is "out until the day after"; a later game
    // alone goes in field 6 (dates out), so the games before it still count
    let next = null; for (let k = 0; k < 14 && team; k++) { const c = addDays(today, k); if ((sched[c] || []).some(g => g.includes(team))) { next = c; break; } }
    let v = e ? e.slice() : null;
    if (p.s && when > nbaT) {
      const espnOut = e && /out|suspen/i.test(e[0]);
      if (p.s === 'Out' || p.s === 'Doubtful') {
        const back = p.ret || (p.dt ? nextDay(p.dt) : null);
        if (!p.ret && p.dt && next && p.dt > next && !espnOut) { v = e ? e.slice() : ['Available', '', note, name, team]; if (e) v[2] = `${note} ${e[2]}`;
          while (v.length < 6) v.push(null); v[6] = [...new Set([...(v[6] || []), p.dt])].sort(); }
        else if (back) v = espnOut && e[1] && e[1] > back ? [e[0], e[1], `${note} ${e[2]}`, name, team] : ['Out', back, e ? `${note} ${e[2]}` : note, name, team];
      } else if (p.s === 'Available') v = e ? ['Available', '', `${note} ${e[2]}`, name, team] : null;
      else v = [p.s, e && !/out|suspen/i.test(e[0]) ? e[1] : '', e ? `${note} ${e[2]}` : note, name, team];
    }
    if (p.mx && p.dt && p.dt >= today) { v = v || ['Available', '', note, name, team]; const cap = Object.assign({}, v[5] || {}); cap[p.dt] = p.mx; v[5] = cap; }
    if (v && e) for (const k of [5, 6]) if (v[k] === undefined && e[k]) v[k] = e[k];   // keep a cap / dates set earlier
    if (v && JSON.stringify(v) !== JSON.stringify(e)) { inj.players[i.id] = v; n++; }
  }
  inj.news = { applied: n, at: new Date().toISOString() };
  if (n) fs.writeFileSync(INJ, JSON.stringify(inj));
  return n;
}
function teamOf() { const o = {};
  for (const f of ['data/regression.json', 'data/rankings.json']) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); for (const [id, q] of Object.entries(j.players || {})) if (q && q.t && !o[id]) o[id] = q.t; } catch (e) {} }
  try { const j = JSON.parse(fs.readFileSync(INJ, 'utf8')); for (const [id, r] of Object.entries(j.players || {})) if (r && r[4] && !o[id]) o[id] = r[4]; } catch (e) {}
  return o; }

(async () => {
  let sched = {}; try { sched = JSON.parse(fs.readFileSync('data/schedule.json', 'utf8')).dates || {}; } catch (e) {}
  const TEAM = teamOf();
  if (process.argv[2] === '--apply') { let j = { items: [] }; try { j = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
    for (const i of j.items || []) if (i.p === undefined) i.p = parse(i.h, i.d, i.t, i.id && TEAM[i.id], sched);
    console.log(`Applied ${apply(j.items || [], TEAM, sched)} news statuses to ${INJ}`); return; }
  const r = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SixthMan news reader)', Accept: 'application/rss+xml, text/xml, */*' } });
  if (!r.ok) throw new Error('RotoWire answered ' + r.status);
  const xml = await r.text(), items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  if (!items.length) throw new Error('No items in the feed (first bytes: ' + xml.slice(0, 120).replace(/\s+/g, ' ') + ')');
  const find = index();
  let old = { items: [] }; try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const have = new Map((old.items || []).map(i => [i.g, i]));
  let added = 0;
  for (const it of items) {
    const g = tag(it, 'guid') || tag(it, 'link'), h = tag(it, 'title');
    if (!g || !h) continue;
    const n = h.split(':')[0].trim();
    const d = tag(it, 'description').replace(/\s*Visit RotoWire\.com for more analysis on this update\.?\s*$/i, '').trim();
    const u = tag(it, 'link').replace(/([^:])\/\/+/g, '$1/');
    const t = when(tag(it, 'pubDate'));
    const prev = have.get(g);
    if (!prev) added++;
    const id = find(n), hh = h.slice(n.length + 1).trim() || h;
    have.set(g, { g, id, n, h: hh, d, u, t, p: parse(hh, d, t, id && TEAM[id], sched) });
  }
  for (const i of have.values()) if (i.p === undefined) i.p = parse(i.h, i.d, i.t, i.id && TEAM[i.id], sched);   // saved before parsing existed
  const cut = Date.now() - KEEP_H * 3600e3;
  const out = [...have.values()].filter(i => Date.parse(i.t) >= cut).sort((a, b) => b.t < a.t ? -1 : b.t > a.t ? 1 : 0);
  // Only rewrite the file (and so commit) when there's something new; `built` alone would churn.
  if (added || out.length !== (old.items || []).length) fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), items: out }));
  else console.log(`No new items (${items.length} in feed)`);
  console.log(`Applied ${apply(out, TEAM, sched)} news statuses to ${INJ}`);
  if (!added) return;
  console.log(`${added} new, ${out.length} kept, ${out.filter(i => !i.id).length} unmatched`);
})().catch(e => { console.error(e.message); process.exit(1); });

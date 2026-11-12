/* NBA player news from three sources, merged into one list (data/news.json):
 *  - RotoWire's public NBA news RSS: https://www.rotowire.com/rss/news.php?sport=NBA. Each item is
 *    one player update: headline ("Jarrett Allen: Might return Monday"), the first sentence of the
 *    blurb (often with the source: "..., Will Gotlieb of CHGO reports"), a link and a time. The feed
 *    only holds the newest few items (5 when checked), so this runs every 15 minutes.
 *  - Rotoworld (NBC Sports) on Bluesky, @rotoworld-hoops.bsky.social (~35 posts a day): a headline
 *    ("Tyler Herro (knee) a game-time decision Wednesday") with a link card carrying one sentence,
 *    the same shape as RotoWire's. Starting-lineup posts ("BOS starts ...") are skipped (NBA.com's
 *    lineups cover them), and posts that match no NBA player are dropped (it cross-posts other sports).
 *  - Basketball Monster's alerts on Bluesky, @bbmalerts.bsky.social (~100 a day), one fixed format:
 *    "! Brandon Miller SF CHA - Out - Thursday at PHO (right hip strain)". Read exactly, not by
 *    keywords: Out / Inactive / Doubtful / Questionable / Probable / Playing / Starting / Off the Bench
 *    / Off Injury Report, plus in-game alerts (Injured, In the Locker Room, Will not return) that set
 *    no status. Status-only lines (Probable, Playing, Off Injury Report ...) are marked q (quiet): they
 *    move the projections but stay off the page's news list, which would otherwise be flooded.
 *  Bluesky's public API (public.api.bsky.app, no key or login) pages back through older posts, so a
 *  run never misses items between checks the way the RSS can. Each source can fail alone; the run
 *  only fails when all three do. Every item is kept for 3 days.
 *
 * Usage:  node fetch-news.js           fetch the sources, then apply them to data/injuries.json
 *         node fetch-news.js --apply   only apply the saved items (after ESPN's / the NBA's report
 *                                      rewrote injuries.json, in the other jobs)
 * Writes: data/news.json  { built, items: [ { g: guid, src: rw | rtw | bbm, id: espnId|null, n: name,
 *                           h: headline, d: sentence, u: link, t: ISO time, p: parsed | null,
 *                           q: 1 = keep off the list, x: 1 = the same news as an item from a source
 *                           listed earlier (RotoWire, then Rotoworld, then BBM) within an hour } ] }
 *                           newest first. Items saved before sources existed have no src (= rw).
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
 * (the official report is newer), and items for past games are ignored. Newest item wins, whatever
 * the source.
 * Names are matched to ESPN ids from data/rankings.json + data/regression.json (+ injuries.json): full name, then
 * last name + first initial when that's unique. Each source's text is shown credited, with a link back.
 */
const fs = require('fs');

const URL = 'https://www.rotowire.com/rss/news.php?sport=NBA', BSKY = 'https://public.api.bsky.app/xrpc/', OUT = 'data/news.json', INJ = 'data/injuries.json', KEEP_H = 72;
const SRC = { rw: 'RotoWire', rtw: 'Rotoworld', bbm: 'BBM' }, RANK = { rw: 0, rtw: 1, bbm: 2 };
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; SixthMan news reader)' };

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
  const sur = {}; for (const [k, ids] of Object.entries(full)) { const w = k.split(' '), l = w[w.length - 1];
    (sur[l] || (sur[l] = new Set())); for (const id of ids) sur[l].add(id); }
  // one word ("Markkanen (wrist) ...") is matched by surname, only when no other player has it
  const TM = teamOf();
  // a name the lookups miss ("Cam Johnson" for Cameron) is matched by surname + team when a source gives the team
  const NM = {}; for (const f of ['data/rankings.json', 'data/regression.json']) { try { for (const [id, q] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).players || {})) if (q && q.n && !NM[id]) NM[id] = q.n; } catch (e) {} }
  const find = (name, team) => { const r = look(name); if (r || !team) return r;
    const w = key(name).split(' '), c = [...(sur[w[w.length - 1]] || [])].filter(id => TM[id] === team);
    return c.length === 1 ? c[0] : null; };
  find.fullName = id => NM[id] || null;   // his full name, for a match made on "Haliburton" alone
  return find;
  function look(name) { const k = key(name), w = k.split(' '); if (!k) return null;
    if (w.length === 1) { const c = sur[k]; return c && c.size === 1 ? [...c][0] : null; }
    let c = full[k];
    if (!c || c.size !== 1) c = lf[`${w[w.length - 1]}|${(w[0] || ' ')[0]}`];
    return c && c.size === 1 ? [...c][0] : null; }
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
  // Each item's note, built the same way every run. The note already in an entry has every known one
  // taken out before the newest is added, so re-applying the same items changes nothing (it used to
  // prepend them again on every run: the notes grew and injuries.json was committed every 15 minutes).
  const tmOf = i => new Date(Date.parse(i.t)).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const noteOf = i => `${SRC[i.src || 'rw']} ${tmOf(i)}: ${i.src === 'bbm' ? i.h + (i.d ? ` (${i.d})` : '') : i.d || i.h}`;
  const known = [...new Set(items.filter(i => i.id && i.p).map(noteOf))].sort((a, b) => b.length - a.length);
  const strip = x => { let y = String(x || ''); for (const k of known) if (y.includes(k)) y = y.split(k).join(' ');
    return y.replace(/\s+/g, ' ').trim(); };
  const join = (a, b) => (b ? `${a} ${b}` : a);
  const was = JSON.parse(JSON.stringify(inj.players)), touched = new Set();
  // oldest first, so the newest item for a player wins
  for (const i of [...items].reverse()) {
    if (!i.id || !i.p) continue; const p = i.p, e = inj.players[i.id], when = Date.parse(i.t);
    if (p.dt && p.dt < today && !(p.ret && p.ret > today)) continue;   // about a game already played
    const note = noteOf(i), base = e ? strip(e[2]) : '';
    // the NBA report's time, read under any news note already in front of it
    const nbaT = /^NBA report /.test(base) ? stampMs((base.match(/^NBA report ([^:]+:\d\d [AP]M)/) || [])[1]) : 0;
    const name = e ? e[3] : i.n, team = (e && e[4]) || TEAM[i.id] || '';
    // his next game from today: an absence for that game is "out until the day after"; a later game
    // alone goes in field 6 (dates out), so the games before it still count
    let next = null; for (let k = 0; k < 14 && team; k++) { const c = addDays(today, k); if ((sched[c] || []).some(g => g.includes(team))) { next = c; break; } }
    let v = e ? e.slice() : null;
    if (p.s && when > nbaT) {
      const espnOut = e && /out|suspen/i.test(e[0]);
      if (p.s === 'Out' || p.s === 'Doubtful') {
        const back = p.ret || (p.dt ? nextDay(p.dt) : null);
        if (!p.ret && p.dt && next && p.dt > next && !espnOut) { v = e ? e.slice() : ['Available', '', note, name, team]; if (e) v[2] = join(note, base);
          while (v.length < 6) v.push(null); v[6] = [...new Set([...(v[6] || []), p.dt])].sort(); }
        else if (back) v = espnOut && e[1] && e[1] > back ? [e[0], e[1], join(note, base), name, team] : ['Out', back, e ? join(note, base) : note, name, team];
      } else if (p.s === 'Available') v = e ? ['Available', '', join(note, base), name, team] : null;
      else v = [p.s, e && !/out|suspen/i.test(e[0]) ? e[1] : '', e ? join(note, base) : note, name, team];
    }
    if (p.mx && p.dt && p.dt >= today) { v = v || ['Available', '', note, name, team]; const cap = Object.assign({}, v[5] || {}); cap[p.dt] = p.mx; v[5] = cap; }
    if (v && e) for (const k of [5, 6]) if (v[k] === undefined && e[k]) v[k] = e[k];   // keep a cap / dates set earlier
    if (v && JSON.stringify(v) !== JSON.stringify(e)) { inj.players[i.id] = v; touched.add(i.id); }
  }
  // a player with several items is rewritten once per item; count only entries that end up different
  for (const id of touched) if (JSON.stringify(inj.players[id]) !== JSON.stringify(was[id])) n++;
  inj.news = { applied: n, at: new Date().toISOString() };
  if (n) fs.writeFileSync(INJ, JSON.stringify(inj));
  return n;
}
function teamOf() { const o = {};
  for (const f of ['data/regression.json', 'data/rankings.json']) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); for (const [id, q] of Object.entries(j.players || {})) if (q && q.t && !o[id]) o[id] = q.t; } catch (e) {} }
  try { const j = JSON.parse(fs.readFileSync(INJ, 'utf8')); for (const [id, r] of Object.entries(j.players || {})) if (r && r[4] && !o[id]) o[id] = r[4]; } catch (e) {}
  return o; }


// ---- sources
async function rotowire(find) {
  const r = await fetch(URL, { headers: Object.assign({ Accept: 'application/rss+xml, text/xml, */*' }, UA) });
  if (!r.ok) throw new Error('RotoWire answered ' + r.status);
  const xml = await r.text(), items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  if (!items.length) throw new Error('No items in the feed (first bytes: ' + xml.slice(0, 120).replace(/\s+/g, ' ') + ')');
  const out = [];
  for (const it of items) {
    const g = tag(it, 'guid') || tag(it, 'link'), h = tag(it, 'title');
    if (!g || !h) continue;
    const n = h.split(':')[0].trim();
    const d = tag(it, 'description').replace(/\s*Visit RotoWire\.com for more analysis on this update\.?\s*$/i, '').trim();
    const u = tag(it, 'link').replace(/([^:])\/\/+/g, '$1/');
    out.push({ g, id: find(n), n, h: h.slice(n.length + 1).trim() || h, d, u, t: when(tag(it, 'pubDate')) });
  }
  return out;
}
// An account's own posts (no replies, no reposts), newest first, paging back until a page reaches
// posts already saved or older than the 3 days kept (at most 5 pages of 100).
async function bskyFeed(actor, have, cut) {
  const out = []; let cursor = null;
  for (let pg = 0; pg < 5; pg++) {
    const q = new URLSearchParams({ actor, limit: '100', filter: 'posts_no_replies' }); if (cursor) q.set('cursor', cursor);
    const r = await fetch(BSKY + 'app.bsky.feed.getAuthorFeed?' + q, { headers: UA });
    if (!r.ok) throw new Error(`Bluesky answered ${r.status} for ${actor}`);
    const j = await r.json(), feed = j.feed || [];
    let stop = !feed.length || !j.cursor;
    for (const f of feed) {
      const p = f.post; if (!p || f.reason || !p.author || p.author.handle !== actor) continue;
      const t = new Date(Math.min(Date.parse(p.record.createdAt) || Date.now(), Date.now())).toISOString();
      if (Date.parse(t) < cut || have.has(p.uri)) { stop = true; continue; }
      out.push({ p, t });
    }
    if (stop) break; cursor = j.cursor;
  }
  return out;
}
const postUrl = p => `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`;
// "Shai Gilgeous-Alexander scores 26 points" -> "Shai Gilgeous-Alexander": the leading run of capitalized words
const nameRun = s => { const m = String(s).match(/^((?:[A-Z\u00C0-\u024F][\w\u00C0-\u024F.'’-]*|Jr\.?|Sr\.?|I{2,3}|IV)(?:\s+(?:[A-Z\u00C0-\u024F][\w\u00C0-\u024F.'’-]*|Jr\.?|Sr\.?|I{2,3}|IV|de|da|van|von|di))*)/); return m ? m[1].trim() : ''; };
async function rotoworld(find, have, cut) {
  const out = [];
  for (const { p, t } of await bskyFeed('rotoworld-hoops.bsky.social', have, cut)) {
    const ex = p.embed && p.embed.external, h = String((ex && ex.title) || p.record.text || '').trim(), d = String((ex && ex.description) || '').trim();
    if (!h || /^\S+(?: \S+)? starts? /.test(h)) continue;   // starting lineups
    // "Carlisle: Haliburton (hamstring) 'doing better'": drop who's quoted; the player is before "("
    const body = h.replace(/^[A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+)?:\s+/, ''), paren = body.indexOf(' (');
    const cand = [paren > 0 ? body.slice(0, paren) : nameRun(body), nameRun(d)].filter(Boolean);
    let id = null, n = ''; for (const c of cand) { id = find(c); if (id) { n = c; break; } }
    if (!id) continue;   // no NBA player in it (the account cross-posts other sports)
    out.push({ g: p.uri, id, n: find.fullName(id) || n, h, d, u: (ex && ex.uri) || postUrl(p), t });
  }
  return out;
}
// "! Brandon Miller SF CHA - Out - Thursday at PHO (right hip strain)"
const BBMS = { 'Out': 'Out', 'Inactive': 'Out', 'Doubtful': 'Doubtful', 'Questionable': 'Questionable', 'Probable': 'Probable',
  'Playing': 'Available', 'Starting': 'Available', 'Off the Bench': 'Available', 'Off Injury Report': 'Available' };
// BBM's team codes where ESPN's differ
const BBMT = { NOR: 'NO', PHO: 'PHX', GSW: 'GS', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', BRK: 'BKN', CHO: 'CHA' };
const BBMLOUD = /^(Out|Inactive|Doubtful|Injured|In the Locker Room|Will not return|Doubtful to return|To Bench with Injury)$/;
async function bbm(find, have, cut, sched) {
  const out = [];
  for (const { p, t } of await bskyFeed('bbmalerts.bsky.social', have, cut)) {
    const m = String(p.record.text || '').trim().match(/^(!+\s*)?(.+?) ([A-Z]{1,2}(?:\/[A-Z]{1,2})?) ([A-Z]{2,4}) - (.+?)(?: - ([\s\S]*))?$/);
    if (!m) continue;   // team starting lineups ("Indiana Pacers - Starting - ...") and anything else
    const [, , n, , tm, st, rest = ''] = m, id = find(n, BBMT[tm] || tm);
    // "Wednesday vs BOS (left groin strain) Coach Rajakovic said Barnes is day-to-day."
    const pi = rest.indexOf('('), game = (pi >= 0 ? rest.slice(0, pi) : rest).trim();
    const why = pi >= 0 ? (rest.slice(pi + 1).match(/^[^)]*/) || [''])[0].trim() : '';
    const more = pi >= 0 ? rest.slice(pi).replace(/^\([^)]*\)?/, '').trim() : '';
    const s = BBMS[st] || null; let dt = null;
    const wd = game.toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (wd) { const day0 = ET(new Date(t)), w = DAYS.indexOf(wd[1]), w0 = new Date(day0 + 'T12:00:00Z').getUTCDay(); dt = addDays(day0, (w - w0 + 7) % 7); }
    // the note can carry a timeline or a cap ("will be sidelined for at least one month"): taken from
    // the keyword reader, but the status stays BBM's own
    const pp = more ? parse('', more, t, null, sched) : null, ret = pp && pp.ret, mx = pp && pp.mx;
    const ps = s || (ret ? 'Out' : null);
    const cap = x => x ? x[0].toUpperCase() + x.slice(1) : '';
    const it = { g: p.uri, id, n, h: `${st}${game ? ' · ' + game : ''}`, d: [cap(why), cap(more)].filter(Boolean).join('. '), u: postUrl(p), t,
      p: ps || mx ? { s: ps, dt: dt || (pp && pp.dt) || null, ret: ret || null, mx: mx || null } : null };
    if (!BBMLOUD.test(st)) it.q = 1;
    out.push(it);
  }
  return out;
}
// The same news from two sources (same player, same status, within an hour): keep the first source
// listed (RotoWire, Rotoworld, BBM) on the list; the other is still applied.
function dedupe(items) {
  const by = {}; for (const i of items) if (i.id) (by[i.id] || (by[i.id] = [])).push(i);
  for (const i of items) { delete i.x; if (!i.id) continue; const r = RANK[i.src || 'rw'], s = (i.p && i.p.s) || null, t = Date.parse(i.t);
    if (by[i.id].some(j => j !== i && RANK[j.src || 'rw'] < r && ((j.p && j.p.s) || null) === s && Math.abs(Date.parse(j.t) - t) <= 3600e3)) i.x = 1; }
}

(async () => {
  let sched = {}; try { sched = JSON.parse(fs.readFileSync('data/schedule.json', 'utf8')).dates || {}; } catch (e) {}
  const TEAM = teamOf();
  if (process.argv[2] === '--apply') { let j = { items: [] }; try { j = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
    for (const i of j.items || []) if (i.p === undefined) i.p = parse(i.h, i.d, i.t, i.id && TEAM[i.id], sched);
    console.log(`Applied ${apply(j.items || [], TEAM, sched)} news statuses to ${INJ}`); return; }
  const find = index();
  let old = { items: [] }; try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const have = new Map((old.items || []).map(i => [i.g, i]));
  const cut = Date.now() - KEEP_H * 3600e3;
  let added = 0; const errs = [], counts = {};
  const put = it => { if (!it || !it.g || Date.parse(it.t) < cut) return; if (!have.has(it.g)) { added++; counts[it.src] = (counts[it.src] || 0) + 1; }
    const prev = have.get(it.g);
    if (it.p === undefined) it.p = it.id ? parse(it.h, it.d, it.t, TEAM[it.id], sched) : parse(it.h, it.d, it.t, null, sched);
    have.set(it.g, Object.assign({}, prev, it)); };
  for (const [src, get] of [['rw', () => rotowire(find)], ['rtw', () => rotoworld(find, have, cut)], ['bbm', () => bbm(find, have, cut, sched)]]) {
    try { const its = await get(); for (const it of its) put(Object.assign({ src }, it)); console.log(`${SRC[src]}: ${its.length} items`); }
    catch (e) { errs.push(`${SRC[src]}: ${e.message}`); console.error(`${SRC[src]} failed: ${e.message}`); }
  }
  if (errs.length === 3) throw new Error('Every source failed. ' + errs.join(' | '));
  for (const i of have.values()) if (i.p === undefined) i.p = parse(i.h, i.d, i.t, i.id && TEAM[i.id], sched);   // saved before parsing existed
  const out = [...have.values()].filter(i => Date.parse(i.t) >= cut).sort((a, b) => b.t < a.t ? -1 : b.t > a.t ? 1 : 0);
  dedupe(out);
  // Only rewrite the file (and so commit) when there's something new; `built` alone would churn.
  const was = JSON.stringify((old.items || []).map(i => [i.g, i.x || 0]));
  if (added || was !== JSON.stringify(out.map(i => [i.g, i.x || 0]))) fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), items: out }));
  else console.log('No new items');
  console.log(`Applied ${apply(out, TEAM, sched)} news statuses to ${INJ}`);
  if (!added) return;
  console.log(`${added} new (${Object.entries(counts).map(([k, v]) => `${SRC[k]} ${v}`).join(', ')}), ${out.length} kept, ${out.filter(i => !i.id).length} unmatched, ${out.filter(i => i.x).length} duplicates`);
})().catch(e => { console.error(e.message); process.exit(1); });

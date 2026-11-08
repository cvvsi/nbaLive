/* RotoWire's public NBA news RSS: https://www.rotowire.com/rss/news.php?sport=NBA
 * Each item is one player update: headline ("Jarrett Allen: Might return Monday"), the first
 * sentence of the blurb (often with the source: "..., Will Gotlieb of CHGO reports"), a link to the
 * player's RotoWire page and a time. The feed only holds the newest few items (5 when checked), so
 * this runs every 15 minutes and keeps every item it has seen for 3 days.
 *
 * Usage:  node fetch-news.js
 * Writes: data/news.json  { built, items: [ { g: guid, id: espnId|null, n: name, h: headline,
 *                           d: sentence, u: link, t: ISO time } ] }  newest first
 * Names are matched to ESPN ids from data/rankings.json + data/regression.json (+ injuries.json): full name, then
 * last name + first initial when that's unique. RotoWire's text is shown credited, with a link back.
 */
const fs = require('fs');

const URL = 'https://www.rotowire.com/rss/news.php?sport=NBA', OUT = 'data/news.json', KEEP_H = 72;

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

(async () => {
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
    have.set(g, { g, id: find(n), n, h: h.slice(n.length + 1).trim() || h, d, u, t });
  }
  const cut = Date.now() - KEEP_H * 3600e3;
  const out = [...have.values()].filter(i => Date.parse(i.t) >= cut).sort((a, b) => b.t < a.t ? -1 : b.t > a.t ? 1 : 0);
  // Only rewrite the file (and so commit) when there's something new; `built` alone would churn.
  if (!added && out.length === (old.items || []).length) { console.log(`No new items (${items.length} in feed)`); return; }
  fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), items: out }));
  console.log(`${added} new, ${out.length} kept, ${out.filter(i => !i.id).length} unmatched`);
})().catch(e => { console.error(e.message); process.exit(1); });

/* Yahoo's public Buzz Index (no login): most added and most dropped players for a day.
 * https://basketball.fantasysports.yahoo.com/nba/buzzindex
 *
 * Usage:  node fetch-buzz.js              yesterday (US Eastern, final) plus today so far
 *         node fetch-buzz.js 2026-11-02   one day only
 * Writes: data/buzz.json  { date, pageDate, built, added: [...], dropped: [...],
 *                           today: { date, added, dropped } | null }
 * The top level stays yesterday (the morning report reads it); `today` is a partial day and
 * is null when Yahoo has nothing for it yet or just serves yesterday's page again.
 * Run every 3 hours by .github/workflows/buzz.yml.
 * Each row: name, team, pos, ros (% rostered), start (% started), drops, adds, trades, total.
 */
const fs = require('fs');

const BASE = 'https://basketball.fantasysports.yahoo.com/nba/buzzindex';
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const shift = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const ONE = process.argv[2];
const DATE = ONE || shift(etToday(), -1), TODAY = etToday();

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const text = h => h.replace(/<[^>]+>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
    : (ENT[e] ?? m))
  .replace(/\s+/g, ' ').trim();

function parse(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(text);
    if (cells.length < 6) continue;
    const nums = cells.filter(c => /^\d+$/.test(c)).map(Number);
    const pcts = cells.filter(c => /^\d+%$/.test(c)).map(c => parseInt(c));
    if (nums.length < 4) continue;
    const [drops, adds, trades, total] = nums.slice(-4);
    // The player cell holds the name and "TEAM - POS"; the name is the first linked text.
    const row = text(tr);
    const tp = row.match(/\b([A-Z]{2,4}) - ([A-Z]{1,4}(?:,[A-Z]{1,4})*)\b/);
    const nameA = tr.match(/<a[^>]*\/nba\/players\/\d+[^>]*>([\s\S]*?)<\/a>/i)
      || tr.match(/<a[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    let name = nameA ? text(nameA[1]) : '';
    if (!name && tp) name = row.slice(0, row.indexOf(tp[0])).replace(/^(?:No new player Notes|Player Note|New Player Note|\W)+/i, '').trim();
    if (!name) continue;
    rows.push({ name, team: tp ? tp[1] : '', pos: tp ? tp[2] : '',
      ros: pcts[0] ?? null, start: pcts[1] ?? null, drops, adds, trades, total });
  }
  return rows;
}

async function page(sort, date) {
  const u = `${BASE}?date=${date}&pos=ALL&src=combined&bimtab=ALL&trendtab=O&sort=${sort}&sdir=1`;
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (9-Cat Box nightly; personal use)', 'Accept-Language': 'en-US' } });
  if (!r.ok) throw new Error(r.status + ' ' + u);
  const html = await r.text();
  // The date the page actually shows (Yahoo may ignore ?date= for days it has no data for).
  const shown = (html.match(/date=(\d{4}-\d{2}-\d{2})[^"]*"[^>]*class="[^"]*(?:selected|Selected|active)/) || [])[1]
    || (html.match(/class="[^"]*(?:selected|active)[^"]*"[^>]*href="[^"]*date=(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  return { rows: parse(html), shown, bytes: html.length };
}

async function day(date) {
  const a = await page('BI_A', date), d = await page('BI_D', date);
  const added = a.rows.sort((x, y) => y.adds - x.adds).slice(0, 40);
  const dropped = d.rows.sort((x, y) => y.drops - x.drops).slice(0, 40);
  console.log(`buzz ${date}: page shows ${a.shown || '?'}; ${added.length} added rows, ${dropped.length} dropped rows (${a.bytes} bytes)`);
  console.log('  top adds:', added.slice(0, 5).map(p => `${p.name} ${p.team} +${p.adds}`).join(' | '));
  console.log('  top drops:', dropped.slice(0, 5).map(p => `${p.name} ${p.team} -${p.drops}`).join(' | '));
  return { date, pageDate: a.shown, added, dropped };
}
const sig = r => r.added.slice(0, 10).map(p => p.name + p.adds).join();

(async () => {
  const y = await day(DATE);
  if (!y.added.length) throw new Error('No rows parsed; the page layout may have changed');
  let today = null;
  if (!ONE) {
    try {
      const t = await day(TODAY);
      if (!t.added.length) console.log('  today: no rows yet');
      else if ((t.pageDate && t.pageDate !== TODAY) || sig(t) === sig(y)) console.log("  today: Yahoo served another day's page, skipped");
      else today = { date: TODAY, added: t.added, dropped: t.dropped };
    } catch (e) { console.log('  today failed:', e.message); }
  }
  fs.writeFileSync('data/buzz.json', JSON.stringify({
    date: DATE, pageDate: y.pageDate, built: new Date().toISOString(),
    note: "Yahoo Buzz Index: adds/drops/trades across Yahoo leagues that day. ros/start = % rostered / % started. today = partial day so far.",
    added: y.added, dropped: y.dropped, today,
  }, null, 1));
})().catch(e => { console.error(e.message); process.exit(1); });

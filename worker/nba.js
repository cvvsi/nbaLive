/* Play clips from NBA.com for the player page (Nov 2026, prototype). NBA.com keeps a video for nearly
 * every play-by-play event, looked up by its game id + action number. The page can't call NBA.com
 * itself (stats.nba.com refuses other sites' browsers), so the relay does the lookups. Every route
 * needs the relay key, like the rest of the relay. Nothing is stored or re-hosted: a clip either
 * plays straight from NBA.com, or streams through here when NBA.com won't serve another site.
 *
 * GET /nba/games?d=YYYY-MM-DD -> [{gid, away, home}] (NBA tricodes) for that date
 * GET /nba/pbp?gid=00226...   -> NBA.com's live play-by-play JSON for the game, passed through as is
 * GET /nba/clip?gid=&ev=      -> {mp4, th, dur, px}: the play's MP4 on NBA.com, its thumbnail, and px,
 *                                a signed relay address (valid 6 h) that streams the same file
 * GET /nba/v?u=&e=&s=         -> that stream (no key needed: the signature is the lock; only
 *                                videos.nba.com files, Range requests passed through for seeking)
 * GET /nba/probe              -> status codes of each NBA.com endpoint, for the deploy's smoke test */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const NBAH = { 'User-Agent': UA, Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com', Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true' };

class NbaErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function nbaGet(u, ms = 12000) {
  const r = await fetch(u, { headers: NBAH, signal: AbortSignal.timeout(ms) }).catch(e => { throw new NbaErr(504, 'NBA.com did not answer: ' + (e.message || e)); });
  if (!r.ok) throw new NbaErr(502, 'NBA.com answered ' + r.status + ' for ' + new URL(u).pathname);
  return r;
}

// Game ids for a date: the stats scoreboard (any date), else today's live scoreboard on the CDN.
async function games(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) throw new NbaErr(400, 'd must be YYYY-MM-DD.');
  try {
    const j = await (await nbaGet('https://stats.nba.com/stats/scoreboardv3?LeagueID=00&GameDate=' + d)).json();
    const g = ((j.scoreboard || {}).games || []).map(x => ({ gid: x.gameId, away: x.awayTeam && x.awayTeam.teamTricode, home: x.homeTeam && x.homeTeam.teamTricode }));
    if (g.length) return g;
  } catch (e) { /* fall through to the CDN */ }
  const j = await (await nbaGet('https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json')).json();
  const sb = j.scoreboard || {};
  if (sb.gameDate !== d) return [];
  return (sb.games || []).map(x => ({ gid: x.gameId, away: x.awayTeam.teamTricode, home: x.homeTeam.teamTricode }));
}

async function clip(gid, ev, env, base) {
  if (!/^\d{10}$/.test(gid || '') || !/^\d{1,4}$/.test(ev || '')) throw new NbaErr(400, 'gid (10 digits) and ev (action number) needed.');
  const j = await (await nbaGet(`https://stats.nba.com/stats/videoeventsasset?GameID=${gid}&GameEventID=${ev}`)).json();
  const v = (((j.resultSets || {}).Meta || {}).videoUrls || [])[0] || {};
  const mp4 = v.lurl || v.murl || v.surl || null;
  if (!mp4) return { mp4: null };
  const e = Math.floor(Date.now() / 1000) + 6 * 3600;
  return { mp4, th: v.lth || v.mth || v.sth || null, dur: v.ldur || v.mdur || v.sdur || null,
    px: `${base}/nba/v?u=${encodeURIComponent(mp4)}&e=${e}&s=${await sign(env, mp4 + '|' + e)}` };
}

async function sign(env, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('clip|' + (env.RELAY_KEY || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function stream(req, url, env) {
  const u = url.searchParams.get('u') || '', e = +url.searchParams.get('e') || 0, s = url.searchParams.get('s') || '';
  let host = ''; try { host = new URL(u).hostname; } catch (x) { /* bad url */ }
  if (!/(^|\.)nba\.com$/.test(host) || e < Date.now() / 1000 || s !== await sign(env, u + '|' + e)) return new Response('Expired or bad link.', { status: 403 });
  const h = { 'User-Agent': UA, Referer: 'https://www.nba.com/' }, rg = req.headers.get('Range');
  if (rg) h.Range = rg;
  const r = await fetch(u, { headers: h });
  const out = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) { const v = r.headers.get(k); if (v) out.set(k, v); }
  out.set('Cache-Control', 'private, max-age=21600');
  return new Response(r.body, { status: r.status, headers: out });
}

// One request to each endpoint, statuses only (the smoke test prints them in the public Action log).
async function probe(env, base) {
  const out = {}, t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'ERR ' + (e.message || e).slice(0, 120); } };
  let gid = null;
  await t('scoreboard', async () => { const d = new Date(Date.now() - 864e5 * 1.3).toISOString().slice(0, 10), g = await games(d); gid = g[0] && g[0].gid; return g.length + ' games on ' + d; });
  await t('pbp', async () => { if (!gid) return 'skipped'; const j = await (await nbaGet(`https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gid}.json`)).json(); return ((j.game || {}).actions || []).length + ' actions'; });
  let c = null;
  await t('clip', async () => { if (!gid) return 'skipped'; c = await clip(gid, '10', env, base); return c.mp4 ? 'mp4 on ' + new URL(c.mp4).hostname : 'no video'; });
  await t('video', async () => { if (!c || !c.mp4) return 'skipped'; const r = await fetch(c.mp4, { headers: { 'User-Agent': UA, Range: 'bytes=0-1023' } }); return r.status + ' ' + (r.headers.get('content-type') || '') + ' acao=' + (r.headers.get('access-control-allow-origin') || '-'); });
  await t('video_other_site', async () => { if (!c || !c.mp4) return 'skipped'; const r = await fetch(c.mp4, { headers: { 'User-Agent': UA, Range: 'bytes=0-1023', Referer: 'https://cvvsi.github.io/' } }); return String(r.status); });
  return out;
}

// Routes. Returns a Response, or null when the path isn't one of ours.
export async function nbaRoute(req, url, env, json, keyed) {
  if (!url.pathname.startsWith('/nba/')) return null;
  const base = url.origin;
  try {
    if (url.pathname === '/nba/v') return await stream(req, url, env);
    if (!keyed) return json({ error: 'Wrong or missing relay key.' }, 401);
    if (url.pathname === '/nba/games') return json(await games(url.searchParams.get('d')));
    if (url.pathname === '/nba/clip') return json(await clip(url.searchParams.get('gid'), url.searchParams.get('ev'), env, base));
    if (url.pathname === '/nba/probe') return json(await probe(env, base));
    if (url.pathname === '/nba/pbp') {
      const gid = url.searchParams.get('gid') || '';
      if (!/^\d{10}$/.test(gid)) return json({ error: 'gid (10 digits) needed.' }, 400);
      const r = await nbaGet(`https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gid}.json`);
      const res = json(null); const h = new Headers(res.headers);
      h.set('Cache-Control', 'private, max-age=30');
      return new Response(r.body, { status: 200, headers: h });
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message || String(e) }, e.status || 500);
  }
}

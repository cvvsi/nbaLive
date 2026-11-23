/* Scheduled pickups: moves you line up on the Waivers page that the relay makes on Yahoo for you,
 * from Cloudflare's once-a-minute timer (wrangler.toml [triggers]). Needs the Yahoo app's Fantasy
 * Sports permission set to Read/Write and a login with scope fspt-w.
 *
 * Two kinds:
 *  - clear: a player on waivers you don't want to spend a claim on. Checked every 15 minutes before
 *    his waiver date and every minute from midnight ET on it; the moment Yahoo lists him as a free
 *    agent, the add (with your drop) goes in. A claim another team put in still gets him first: then
 *    the move is marked missed with who got him.
 *  - time: an add (with your drop) at a time you pick, or right away. A player still on waivers at
 *    that time becomes a waiver claim, as on Yahoo.
 *
 * Stored in KV (binding OV, key "sched"): only your own instructions ({id, kind, add, drop, at, wd,
 * state, res}), with the player's Yahoo id and name; nothing read from Yahoo is kept. Finished moves
 * are dropped after 3 days. */

const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const KEY = 'sched', KEEP = 3 * 864e5, MAXJOBS = 20;
const etDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const xesc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export async function schedGet(env) {
  if (!env.OV) return [];
  const a = (await env.OV.get(KEY, 'json')) || [], now = Date.now();
  return a.filter(j => j.state === 'pending' || j.state === 'running' || now - new Date(j.done || j.made) < KEEP);
}
const schedPut = (env, a) => env.OV.put(KEY, JSON.stringify(a));

const pid = v => String(v || '').replace(/[^0-9]/g, '');
// POST /sched {kind, add: {id, n}, drop: {id, n} | null, at, wd} -> the list. A time move that's due
// runs right away.
export async function schedAdd(env, b, deps) {
  if (!env.OV) throw new deps.HttpErr(500, 'No storage (the OV KV binding): re-run Actions -> Yahoo relay.');
  const kind = b && b.kind, add = b && b.add && pid(b.add.id), drop = b && b.drop && pid(b.drop.id);
  if (kind !== 'clear' && kind !== 'time') throw new deps.HttpErr(400, 'kind must be clear or time.');
  if (!add) throw new deps.HttpErr(400, 'Missing the player to add.');
  const at = kind === 'time' ? new Date(b.at || Date.now()) : null;
  if (at && isNaN(at)) throw new deps.HttpErr(400, 'Bad time.');
  const wd = /^\d{4}-\d{2}-\d{2}$/.test(b.wd || '') ? b.wd : null;
  const a = await schedGet(env);
  if (a.filter(j => j.state === 'pending').length >= MAXJOBS) throw new deps.HttpErr(400, 'Too many scheduled moves.');
  if (a.some(j => j.state === 'pending' && j.add.id === add)) throw new deps.HttpErr(400, 'He already has a scheduled move. Cancel it first.');
  const j = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, made: new Date().toISOString(),
    add: { id: add, n: String(b.add.n || '').slice(0, 60), t: String(b.add.t || '').slice(0, 5) },
    drop: drop ? { id: drop, n: String(b.drop.n || '').slice(0, 60) } : null,
    at: at ? at.toISOString() : null, wd, state: 'pending', res: null };
  a.push(j); await schedPut(env, a);
  if (kind === 'time' && at <= Date.now() + 30e3) return runDue(env, deps, true);
  return a;
}
export async function schedCancel(env, id) {
  const a = await schedGet(env), j = a.find(x => x.id === id);
  if (j && j.state === 'pending') { j.state = 'cancelled'; j.done = new Date().toISOString(); await schedPut(env, a); }
  return a;
}

// The add / drop on Yahoo (POST /league/{key}/transactions, XML). Yahoo answers 201 on success, or
// an error with its reason (no adds left, roster full, player not available...).
async function transact(env, deps, lk, me, j) {
  const g = lk.split('.l.')[0], tk = `${lk}.t.${me}`, pk = id => `${g}.p.${id}`;
  const pl = (id, ty) => `<player><player_key>${xesc(pk(id))}</player_key><transaction_data><type>${ty}</type>` +
    (ty === 'add' ? `<destination_team_key>${xesc(tk)}</destination_team_key>` : `<source_team_key>${xesc(tk)}</source_team_key>`) + `</transaction_data></player>`;
  const body = `<?xml version="1.0"?><fantasy_content><transaction><type>${j.drop ? 'add/drop' : 'add'}</type>` +
    (j.drop ? `<players>${pl(j.add.id, 'add')}${pl(j.drop.id, 'drop')}</players>` : pl(j.add.id, 'add')) +
    `</transaction></fantasy_content>`;
  const r = await fetch(`${API}/league/${lk}/transactions`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + await deps.token(env), 'Content-Type': 'application/xml' }, body });
  const t = await r.text().catch(() => '');
  if (r.ok) return { ok: true, claim: /waiver/i.test(t) };
  const d = (t.match(/<description>([^<]*)<\/description>/) || t.match(/"description"\s*:\s*"([^"]*)"/) || [])[1];
  return { ok: false, msg: `Yahoo said ${r.status}${d ? ': ' + d : ''}` + (r.status === 403 || /scope|permission/i.test(d || '') ? ' (is the Yahoo app set to Read/Write, with a fresh login?)' : '') };
}

// Where a player stands now: freeagents / waivers (with date) / team (with its name).
async function ownership(env, deps, lk, id) {
  const g = lk.split('.l.')[0], fc = await deps.yf(env, `/league/${lk}/players;player_keys=${g}.p.${id}/ownership`);
  const x = deps.items(deps.pick(fc.league, 'players'))[0];
  return x ? deps.flat(deps.pick(x.player, 'ownership')) : {};
}

// One pass over the pending moves (the cron, every minute; or right after a "now" move is saved).
export async function runDue(env, deps, force) {
  if (!env.OV) return [];
  let a = await schedGet(env);
  const pend = a.filter(j => j.state === 'pending');
  if (!pend.length) return a;
  const now = new Date(), today = etDay(now), min = now.getUTCMinutes();
  const due = pend.filter(j => j.kind === 'time' ? new Date(j.at) <= now
    : (j.wd && today >= j.wd) || min % 15 === 0 || force);  // clear: every minute on his day, else every 15
  if (!due.length) return a;
  const lk = await deps.leagueKey(env), me = await deps.myTeam(env, lk);
  let changed = false;
  for (const j of due) {
    try {
      if (j.kind === 'clear') {
        const o = await ownership(env, deps, lk, j.add.id);
        if (o.ownership_type === 'team') {
          Object.assign(j, { state: 'missed', res: String(o.owner_team_key || '').endsWith('.t.' + me) ? 'Already on your team.' : `Claimed by ${o.owner_team_name || 'another team'} before he cleared.`, done: new Date().toISOString() });
          changed = true; continue;
        }
        if (o.ownership_type === 'waivers') {
          if (o.waiver_date && o.waiver_date !== j.wd) { j.wd = o.waiver_date; changed = true; }
          // still on waivers two days after his date: something's off, stop polling
          if (j.wd && new Date(j.wd + 'T12:00:00Z') < new Date(Date.now() - 2 * 864e5)) { Object.assign(j, { state: 'failed', res: 'Still on waivers two days after his date; stopped.', done: new Date().toISOString() }); changed = true; }
          continue;
        }
        if (o.ownership_type !== 'freeagents') continue;
      }
      const r = await transact(env, deps, lk, me, j);
      Object.assign(j, r.ok ? { state: 'done', res: r.claim ? 'Waiver claim put in.' : 'Added.' } : { state: 'failed', res: r.msg });
    } catch (e) { j.tries = (j.tries || 0) + 1; j.res = String(e.message || e).slice(0, 200); if (j.tries >= 10) j.state = 'failed'; }
    if (j.state !== 'pending') j.done = new Date().toISOString();
    changed = true;
  }
  if (changed) {
    // re-read and merge, so a move added or cancelled meanwhile isn't lost
    const cur = await schedGet(env), byId = Object.fromEntries(due.map(j => [j.id, j]));
    a = cur.map(j => byId[j.id] && j.state === 'pending' ? byId[j.id] : j);
    for (const j of due) if (!cur.some(x => x.id === j.id)) a.push(j);  // a stale read mustn't lose a result
    await schedPut(env, a);
  }
  return a;
}

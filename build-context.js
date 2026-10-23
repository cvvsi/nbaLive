/* Assemble the per-slate analysis context: box score + Value + two-season baselines
 * + league injury feed with return dates. This is the exact payload an LLM would be
 * handed. No model is called here - the point is to see whether the inputs are good
 * enough to write analysis from before paying for tokens.
 *
 * Usage:  node build-context.js [YYYYMMDD]   (defaults to the latest finished slate)
 * Writes: data/context-<date>.json  and prints a readable digest.
 */
const fs = require('fs');
const path = require('path');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const CATS = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'to'];
const J = async u => { const r = await fetch(u); if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); };
const split = s => { const [m, a] = String(s || '0-0').split('-').map(Number); return [m || 0, a || 0]; };
const sum = (a, k) => a.reduce((s, p) => s + p[k], 0);

// ---- name matching between ESPN and the EFB baselines (same rules as build-mock.py)
const ALIAS = {
  'Bub Carrington': 'Carlton Carrington', 'Ace Bailey': 'Airious Bailey',
  'Alex Sarr': 'Alexandre Sarr', 'Yang Hansen': 'Hansen Yang',
};
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '');

function parseBox(ev, j) {
  const out = [];
  for (const t of (j.boxscore && j.boxscore.players) || []) {
    const abbr = t.team.abbreviation, opp = abbr === ev.home ? ev.away : ev.home;
    const st = t.statistics[0]; if (!st) continue;
    const ix = n => st.keys.indexOf(n);
    const I = {
      min: ix('minutes'), pts: ix('points'), fg: ix('fieldGoalsMade-fieldGoalsAttempted'),
      tp: ix('threePointFieldGoalsMade-threePointFieldGoalsAttempted'),
      ft: ix('freeThrowsMade-freeThrowsAttempted'), reb: ix('rebounds'), ast: ix('assists'),
      to: ix('turnovers'), stl: ix('steals'), blk: ix('blocks'), pf: ix('fouls'), pm: ix('plusMinus'),
    };
    const rows = [], dnp = [];
    for (const a of st.athletes) {
      const nm = a.athlete.displayName;
      if (a.didNotPlay || !a.stats || !a.stats.length) { dnp.push(nm); continue; }
      const s = a.stats, min = parseFloat(s[I.min]) || 0;
      if (min <= 0) { dnp.push(nm); continue; }
      const [fgm, fga] = split(s[I.fg]), [tpm, tpa] = split(s[I.tp]), [ftm, fta] = split(s[I.ft]);
      rows.push({
        id: String(a.athlete.id || nm), name: nm,
        pos: (a.athlete.position || {}).abbreviation || '', team: abbr, opp,
        home: abbr === ev.home, game: ev.id, starter: !!a.starter, min,
        pts: +s[I.pts] || 0, reb: +s[I.reb] || 0, ast: +s[I.ast] || 0, stl: +s[I.stl] || 0,
        blk: +s[I.blk] || 0, to: +s[I.to] || 0, pf: +s[I.pf] || 0, pm: parseInt(s[I.pm]) || 0,
        fgm, fga, tpm, tpa, ftm, fta,
      });
    }
    const T = rows.reduce((o, r) => (o.min += r.min, o.fga += r.fga, o.fta += r.fta, o.to += r.to, o),
      { min: 0, fga: 0, fta: 0, to: 0 });
    for (const r of rows) {
      const tp = T.fga + .44 * T.fta + T.to;
      r.usg = tp && r.min ? 100 * ((r.fga + .44 * r.fta + r.to) * (T.min / 5)) / (r.min * tp) : 0;
      r.teamDnp = dnp;
    }
    out.push(...rows);
  }
  return out;
}

// Same math as index.html: z against the night's 10+ minute pool.
function compute(P, pool = 10) {
  const q = P.filter(p => p.min >= pool), base = q.length >= 10 ? q : P;
  const lgFG = sum(base, 'fgm') / Math.max(1, sum(base, 'fga'));
  const lgFT = sum(base, 'ftm') / Math.max(1, sum(base, 'fta'));
  for (const p of P) { p.fgi = p.fgm - lgFG * p.fga; p.fti = p.ftm - lgFT * p.fta; }
  const src = { pts: 'pts', tpm: 'tpm', reb: 'reb', ast: 'ast', stl: 'stl', blk: 'blk', fg: 'fgi', ft: 'fti', to: 'to' };
  for (const c of CATS) {
    const k = src[c], m = sum(base, k) / base.length;
    const sd = Math.sqrt(base.reduce((a, p) => a + (p[k] - m) ** 2, 0) / base.length) || 1;
    for (const p of P) (p.z || (p.z = {}))[c] = (c === 'to' ? -1 : 1) * (p[k] - m) / sd;
  }
  for (const p of P) p.value = CATS.reduce((a, c) => a + p.z[c], 0) / 9;
  [...P].sort((a, b) => b.value - a.value).forEach((p, i) => p.rank = i + 1);
  return P;
}

(async () => {
  // ---- which slate
  let date = process.argv[2];
  if (!date) {
    for (let i = 0; i < 8 && !date; i++) {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
      const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
      const sb = await J(`${API}/scoreboard?dates=${ds}`);
      if ((sb.events || []).some(e => e.status.type.state === 'post')) date = ds;
    }
  }
  if (!date) { console.error('no finished slate found'); process.exit(1); }

  const sb = await J(`${API}/scoreboard?dates=${date}`);
  const evs = (sb.events || [])
    .filter(e => (e.season && e.season.slug) === 'regular-season' && e.status.type.state === 'post')
    .map(e => {
      const c = e.competitions[0];
      const h = c.competitors.find(x => x.homeAway === 'home');
      const a = c.competitors.find(x => x.homeAway === 'away');
      return {
        id: e.id, home: h.team.abbreviation, away: a.team.abbreviation,
        hs: +h.score || 0, as: +a.score || 0, name: e.name,
      };
    });
  if (!evs.length) { console.error('no final regular-season games on ' + date); process.exit(1); }

  // ---- box scores, plus ESPN's own written recap per game
  const P = [], games = [];
  for (const ev of evs) {
    const j = await J(`${API}/summary?event=${ev.id}`);
    P.push(...parseBox(ev, j));
    const art = j.article || {};
    games.push({
      id: ev.id, away: ev.away, home: ev.home, score: `${ev.as}-${ev.hs}`,
      margin: Math.abs(ev.hs - ev.as), blowout: Math.abs(ev.hs - ev.as) >= 20,
      espnHeadline: art.headline || '',
      espnRecap: (art.story || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  }
  compute(P);

  // ---- baselines + league injury feed
  const B = JSON.parse(fs.readFileSync(path.join('data', 'baselines.json'), 'utf8')).players;
  const bidx = {}; for (const n of Object.keys(B)) bidx[norm(n)] = n;
  const inj = await J(`${API}/injuries`);
  const injured = [];
  for (const t of inj.injuries || []) {
    for (const i of t.injuries || []) {
      const a = i.athlete || {}, d = i.details || {};
      injured.push({
        name: a.displayName || '', team: (a.team || {}).abbreviation || '',
        pos: (a.position || {}).abbreviation || '',
        status: i.status || '', returnDate: d.returnDate || null,
        injury: [d.type, d.detail, d.side].filter(Boolean).join(' ') || null,
        fantasy: (d.fantasyStatus || {}).abbreviation || null,
        note: (i.shortComment || '').trim() || null,
      });
    }
  }
  const injByTeam = {};
  for (const i of injured) (injByTeam[i.team] || (injByTeam[i.team] = [])).push(i);

  // ---- per-player context
  const players = P.map(p => {
    const bn = B[p.name] ? p.name : (ALIAS[p.name] || bidx[norm(p.name)]);
    const b = bn ? B[bn] : null;
    const bmpg = b ? b.prior_mpg : null;
    const busg = b && b.base2y ? b.base2y.usg : null;
    return {
      name: p.name, team: p.team, opp: p.opp, pos: p.pos, starter: p.starter,
      rank: p.rank, value: +p.value.toFixed(2),
      min: Math.round(p.min), usg: +p.usg.toFixed(1),
      pts: p.pts, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, to: p.to,
      fg: `${p.fgm}/${p.fga}`, ft: `${p.ftm}/${p.fta}`, tp: `${p.tpm}/${p.tpa}`,
      pm: p.pm, pf: p.pf,
      base: b ? {
        mpg: bmpg, usg: busg, gp: b.prior_gp,
        dMin: bmpg != null ? +(p.min - bmpg).toFixed(1) : null,
        dUsg: busg != null ? +(p.usg - busg).toFixed(1) : null,
        pts36: b.base2y.pts36, reb36: b.base2y.reb36, ast36: b.base2y.ast36,
        stl36: b.base2y.stl36, blk36: b.base2y.blk36,
        fgPct: b.base2y.fg_pct, ftPct: b.base2y.ft_pct,
      } : null,
      z: Object.fromEntries(CATS.map(c => [c, +p.z[c].toFixed(2)])),
    };
  });

  // ---- the shortlist a recap would actually discuss
  // Rank thresholds have to scale with the slate: RK25 of 45 players on a 2-game
  // night is most of the rotation, while RK25 of 300 is genuinely elite.
  const ROSTER = 130;                       // 10 teams x 13 = your league's depth
  const N = players.length;
  const eliteRank = Math.max(5, Math.round(N * 0.08));   // top 8% of the slate
  const reasons = p => {
    const r = [], b = p.base, d = b && b.dMin;
    if (d != null && d >= 6) r.push('minutes +' + d + ' vs ' + b.mpg + ' baseline');
    if (p.rank <= eliteRank) r.push('top-' + eliteRank + ' night on this slate');
    if (b && b.gp < 30 && p.min >= 20) r.push('only ' + b.gp + ' prior games, played ' + p.min);
    if (d != null && d <= -8 && b.mpg >= 24) r.push('minutes ' + d + ' vs ' + b.mpg + ' baseline');
    if (!b && p.min >= 24) r.push('no baseline exported for this player');
    return r;
  };
  const notable = players.map(p => Object.assign({}, p, { why: reasons(p) }))
    .filter(p => p.why.length)
    .sort((a, b) => a.rank - b.rank);

  const teamsInvolved = [...new Set(P.map(p => p.team))];
  const relevantInjuries = teamsInvolved.flatMap(t => injByTeam[t] || []);
  // The saved EFB export only covers teams that had already played when it was taken,
  // so some teams have no baselines at all. Say so, rather than letting a reader take
  // a missing baseline for "no established role".
  const teamsNoBase = teamsInvolved.filter(t => !players.some(p => p.team === t && p.base));

  const ctx = {
    meta: {
      date, games: games.length, players: players.length,
      matchedToBaseline: players.filter(p => p.base).length,
      teamsWithoutBaselines: teamsNoBase,
      eliteRankCutoff: eliteRank,
      league: { teams: 10, roster: 13, rosteredDepth: ROSTER },
      note: 'Value = mean of 9 category z-scores vs this slate\'s 10+ minute pool. '
          + 'base = two-season GP-weighted baseline from the EFB regression dashboard. '
          + 'dMin/dUsg = this game minus that baseline. A null base means no prior-season '
          + 'row was exported for that player; it does NOT mean he has no established role.',
    },
    games, notable, injuries: relevantInjuries, allPlayers: players,
  };

  fs.mkdirSync('data', { recursive: true });
  const out = path.join('data', `context-${date}.json`);
  fs.writeFileSync(out, JSON.stringify(ctx, null, 1));

  // ---- digest
  const kb = n => (n / 1024).toFixed(1) + 'KB';
  console.log(`slate ${date} - ${games.length} game(s), ${players.length} players, `
    + `${ctx.meta.matchedToBaseline} matched to a baseline`);
  console.log('');
  for (const g of games) {
    console.log(`  ${g.away} @ ${g.home}  ${g.score}${g.blowout ? '  [blowout]' : ''}`);
    console.log(`    ESPN: ${g.espnHeadline.slice(0, 96)}`);
  }
  console.log('');
  if (teamsNoBase.length) {
    console.log(`WARNING: no baselines for ${teamsNoBase.join(', ')} - those teams had not `
      + `played when the EFB dashboard was exported. Re-export to cover them.`);
    console.log('');
  }
  console.log(`NOTABLE (${notable.length} of ${players.length}, elite cutoff RK${eliteRank}):`);
  for (const p of notable) {
    const b = p.base;
    const d = b && b.dMin != null ? (b.dMin > 0 ? '+' : '') + b.dMin : ' n/a';
    console.log(`  RK${String(p.rank).padStart(3)}  ${p.name.slice(0, 21).padEnd(21)} ${p.team.padEnd(4)}`
      + ` val ${(p.value > 0 ? '+' : '') + p.value.toFixed(2)}  ${String(p.min).padStart(2)}m`
      + ` ${String(d).padStart(5)}  usg ${String(p.usg.toFixed(0)).padStart(2)}%`
      + ` ${p.starter ? 'ST' : '  '}  ${p.why.join('; ')}`);
  }
  console.log('');
  console.log(`INJURY CONTEXT for teams that played (${relevantInjuries.length}):`);
  for (const i of relevantInjuries) {
    console.log(`  ${i.team.padEnd(4)} ${i.name.slice(0, 22).padEnd(22)} ${(i.status || '').padEnd(11)}`
      + ` back ${i.returnDate || '?'}   ${i.injury || ''}`);
  }
  console.log('');
  const full = JSON.stringify(ctx).length, trim = JSON.stringify({ ...ctx, allPlayers: undefined }).length;
  console.log(`payload: full ${kb(full)} | without allPlayers ${kb(trim)}`);
  console.log(`         ~${Math.round(trim / 4)} tokens trimmed, ~${Math.round(full / 4)} full`);
  console.log(`wrote ${out}`);
})();

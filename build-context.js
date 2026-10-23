/* Assemble the per-slate analysis context: box score + Value + two-season baselines
 * + league injury feed with return dates. This is the exact payload an LLM would be
 * handed. No model is called here - the point is to see whether the inputs are good
 * enough to write analysis from before paying for tokens.
 *
 * Usage:  node build-context.js                    latest finished slate
 *         node build-context.js 20261021          one slate
 *         node build-context.js 20261020-20261022 a date range, pooled
 * Writes: data/context-<label>.json  and prints a readable digest.
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
        id: String(a.athlete.id || nm), name: nm, date: ev.date,
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
  // ---- which slate(s)
  const step = (ds, n) => { const t = new Date(ds.slice(0,4)+'-'+ds.slice(4,6)+'-'+ds.slice(6)+'T12:00:00Z');
    t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0,10).replace(/-/g,''); };
  const arg = process.argv[2];
  let dates = [];
  if (arg && arg.includes('-')) {
    const [a, b] = arg.split('-');
    for (let d = a; d <= b; d = step(d, 1)) dates.push(d);
  } else if (arg) dates = [arg];
  else {
    for (let i = 0; i < 8 && !dates.length; i++) {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
      const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
      const sb = await J(`${API}/scoreboard?dates=${ds}`);
      if ((sb.events || []).some(e => e.status.type.state === 'post')) dates = [ds];
    }
  }
  if (!dates.length) { console.error('no finished slate found'); process.exit(1); }

  // Each date is ranked against its OWN pool - that's what Value means on the nightly
  // page - then the slates are pooled for the shortlist. Pooling the z-scores instead
  // would let a 2-game Thursday dilute an 11-game Wednesday.
  const evs = [];
  for (const date of dates) {
    const sb = await J(`${API}/scoreboard?dates=${date}`);
    for (const e of sb.events || []) {
      if ((e.season && e.season.slug) !== 'regular-season') continue;
      if (e.status.type.state !== 'post') continue;
      const c = e.competitions[0];
      const h = c.competitors.find(x => x.homeAway === 'home');
      const a = c.competitors.find(x => x.homeAway === 'away');
      evs.push({
        id: e.id, date, home: h.team.abbreviation, away: a.team.abbreviation,
        hs: +h.score || 0, as: +a.score || 0, name: e.name,
      });
    }
  }
  if (!evs.length) { console.error('no final regular-season games in ' + arg); process.exit(1); }
  const label = dates.length > 1 ? dates[0] + '-' + dates[dates.length - 1] : dates[0];

  // ---- box scores, plus ESPN's own written recap per game
  const P = [], games = [];
  for (const ev of evs) {
    const j = await J(`${API}/summary?event=${ev.id}`);
    P.push(...parseBox(ev, j));
    games.push({
      id: ev.id, date: ev.date, away: ev.away, home: ev.home, score: `${ev.as}-${ev.hs}`,
      margin: Math.abs(ev.hs - ev.as), blowout: Math.abs(ev.hs - ev.as) >= 20,
    });
  }
  // z and rank per date, against that night's own pool
  const slates = {};
  for (const p of P) (slates[p.date] || (slates[p.date] = [])).push(p);
  for (const d of Object.keys(slates)) {
    compute(slates[d]);
    for (const p of slates[d]) { p.slateSize = slates[d].length; p.slateGames = games.filter(g => g.date === d).length; }
  }

  // ---- Yahoo ownership (primary). Yahoo's read-only public API needs no auth and
  // is the right source because the league is on Yahoo: ESPN's valuations differ enough
  // to be misleading - Day'Ron Sharpe reads 19% on ESPN and 85% on Yahoo.
  // percent_owned also carries a weekly delta, which is the ownership-trend number.
  const own = {}, ownDelta = {};
  const YB = 'https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2';
  const ynorm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/(jr|sr|ii|iii|iv|v)/g, '').replace(/[^a-z]/g, '');
  try {
    for (let st = 0; st < 800; st += 100) {
      const r = await fetch(`${YB}/game/nba/players;start=${st};count=100/percent_owned?format=json`);
      if (!r.ok) break;
      const pl = (await r.json()).fantasy_content.game[1].players;
      let got = 0;
      for (const k of Object.keys(pl)) {
        if (k === 'count') continue;
        const a = pl[k].player; got++;
        const f = {}; for (const o of a[0]) Object.assign(f, o);
        let v = null, d = null;
        for (const o of (a[1] && a[1].percent_owned) || []) {
          if ('value' in o) v = o.value;
          if ('delta' in o) d = o.delta;
        }
        const nm = f.name && (f.name.ascii_first ? f.name.ascii_first + ' ' + f.name.ascii_last : f.name.full);
        if (!nm) continue;
        // Players past the owned tail have no percent_owned at all: that's <1%, not unknown.
        own[ynorm(nm)] = v == null ? 0 : +v;
        if (d != null) ownDelta[ynorm(nm)] = +d;
      }
      if (!got) break;
    }
  } catch (e) { console.error('yahoo ownership failed: ' + e.message); }
  console.error(`yahoo ownership: ${Object.keys(own).length} players`);

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
      name: p.name, date: p.date, team: p.team, opp: p.opp, pos: p.pos, starter: p.starter,
      rank: p.rank, slateSize: p.slateSize, slateGames: p.slateGames, value: +p.value.toFixed(2),
      min: Math.round(p.min), usg: +p.usg.toFixed(1),
      pts: p.pts, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, to: p.to,
      fg: `${p.fgm}/${p.fga}`, ft: `${p.ftm}/${p.fta}`, tp: `${p.tpm}/${p.tpa}`,
      pm: p.pm, pf: p.pf,
      owned: own[ynorm(p.name)] != null ? own[ynorm(p.name)] : null,
      ownDelta: ownDelta[ynorm(p.name)] != null ? ownDelta[ynorm(p.name)] : null,
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
  // 8% of the player's OWN slate, so a thin night can't manufacture elite finishes
  const eliteOf = p => Math.max(5, Math.round((p.slateSize || players.length) * 0.08));
  const reasons = p => {
    const r = [], b = p.base, d = b && b.dMin;
    if (d != null && d >= 6) r.push('minutes +' + d + ' vs ' + b.mpg + ' baseline');
    const cut = eliteOf(p);
    if (p.rank <= cut) r.push('top-' + cut + ' of ' + p.slateSize + ' that night');
    if (b && b.gp < 30 && p.min >= 20) r.push('only ' + b.gp + ' prior games, played ' + p.min);
    if (d != null && d <= -8 && b.mpg >= 24) r.push('minutes ' + d + ' vs ' + b.mpg + ' baseline');
    if (!b && p.min >= 24) r.push('no baseline exported for this player');
    if (p.owned != null && p.owned <= 40 && d != null && d >= 4)
      r.push('only ' + p.owned + '% owned');
    return r;
  };
  const flagged = players.map(p => Object.assign({}, p, { why: reasons(p) })).filter(p => p.why.length);

  // Group by player: a repeated pattern over several nights is the real signal, and
  // a single outlier night is the thing most likely to be noise.
  const byPlayer = {};
  for (const p of players) (byPlayer[p.name] || (byPlayer[p.name] = [])).push(p);
  const med = a => { const s = [...a].sort((x, y) => x - y), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const notable = Object.entries(byPlayer)
    .filter(([n]) => flagged.some(f => f.name === n))
    .map(([name, gs]) => {
      const b = gs[0].base;
      return {
        name, team: gs[0].team, pos: gs[0].pos, games: gs.length,
        owned: gs[0].owned, ownDelta: gs[0].ownDelta, base: b,
        avgMin: +(gs.reduce((a, g) => a + g.min, 0) / gs.length).toFixed(1),
        avgUsg: +(gs.reduce((a, g) => a + g.usg, 0) / gs.length).toFixed(1),
        avgValue: +(gs.reduce((a, g) => a + g.value, 0) / gs.length).toFixed(2),
        bestRank: Math.min(...gs.map(g => g.rank)),
        medValue: +med(gs.map(g => g.value)).toFixed(2),
        starts: gs.filter(g => g.starter).length,
        dMinAvg: b && b.mpg != null ? +(gs.reduce((a, g) => a + g.min, 0) / gs.length - b.mpg).toFixed(1) : null,
        why: [...new Set(flagged.filter(f => f.name === name).flatMap(f => f.why))],
        log: gs.map(g => ({ date: g.date, opp: g.opp, rank: g.rank, of: g.slateSize,
          value: g.value, min: g.min, usg: g.usg, starter: g.starter })),
      };
    })
    .sort((a, b) => (b.dMinAvg ?? -99) - (a.dMinAvg ?? -99));

  const teamsInvolved = [...new Set(P.map(p => p.team))];
  const relevantInjuries = teamsInvolved.flatMap(t => injByTeam[t] || []);
  // The saved EFB export only covers teams that had already played when it was taken,
  // so some teams have no baselines at all. Say so, rather than letting a reader take
  // a missing baseline for "no established role".
  const teamsNoBase = teamsInvolved.filter(t => !players.some(p => p.team === t && p.base));

  const ctx = {
    meta: {
      label, games: games.length, players: players.length,
      playerGames: players.length,
      matchedToBaseline: players.filter(p => p.base).length,
      dates,
      teamsWithoutBaselines: teamsNoBase,
      league: { teams: 10, roster: 13, rosteredDepth: ROSTER },
      note: 'Value = mean of 9 category z-scores vs this slate\'s 10+ minute pool. '
          + 'base = two-season GP-weighted baseline from the EFB regression dashboard. '
          + 'dMin/dUsg = this game minus that baseline. A null base means no prior-season '
          + 'row was exported for that player; it does NOT mean he has no established role.',
    },
    games, notable, injuries: relevantInjuries, allPlayers: players,
  };

  fs.mkdirSync('data', { recursive: true });
  const out = path.join('data', `context-${label}.json`);
  fs.writeFileSync(out, JSON.stringify(ctx, null, 1));

  // ---- digest
  const kb = n => (n / 1024).toFixed(1) + 'KB';
  console.log(`${label}  ${dates.length} date(s), ${games.length} games, `
    + `${players.length} player-games, ${new Set(players.map(p => p.name)).size} distinct players`);
  console.log(`baselines matched: ${ctx.meta.matchedToBaseline}/${players.length}`
    + (teamsNoBase.length ? `  (no baselines: ${teamsNoBase.join(', ')})` : '  (all teams covered)'));
  console.log('');
  for (const d of dates) {
    const gs = games.filter(g => g.date === d);
    if (!gs.length) continue;
    console.log(`  ${d}  ${gs.length} game(s), ${(slates[d] || []).length} players`);
  }
  console.log('');
  console.log(`NOTABLE: ${notable.length} players`);
  console.log('  g = games in window, dMin = avg minutes vs own two-season baseline');
  console.log('');
  for (const p of notable) {
    const b = p.base;
    const d = p.dMinAvg == null ? ' n/a' : (p.dMinAvg > 0 ? '+' : '') + p.dMinAvg;
    console.log(`  ${p.name.slice(0, 21).padEnd(21)} ${p.team.padEnd(4)} ${p.games}g  `
      + `min ${String(p.avgMin.toFixed(0)).padStart(2)} (${String(d).padStart(5)} vs `
      + `${b && b.mpg != null ? String(b.mpg.toFixed(1)).padStart(4) : ' ?  '})  `
      + `val ${(p.avgValue > 0 ? '+' : '') + p.avgValue.toFixed(2)}  `
      + `best RK${String(p.bestRank).padStart(3)}  ${p.starts}/${p.games} st`);
    console.log(`      ${p.why.join(' | ')}`);
    console.log(`      ` + p.log.map(g => `${g.date.slice(4)} ${g.opp} RK${g.rank}/${g.of} `
      + `${g.min}m ${g.usg.toFixed(0)}%${g.starter ? ' ST' : ''}`).join('  ·  '));
  }
  console.log('');
  console.log(`INJURY CONTEXT (${relevantInjuries.length} players on the teams involved):`);
  for (const i of relevantInjuries.slice(0, 14)) {
    console.log(`  ${i.team.padEnd(4)} ${i.name.slice(0, 21).padEnd(21)} ${(i.status || '').padEnd(11)}`
      + ` back ${i.returnDate || '?'}  ${i.injury || ''}`);
  }
  if (relevantInjuries.length > 14) console.log(`  ... and ${relevantInjuries.length - 14} more`);
  console.log('');
  const full = JSON.stringify(ctx).length;
  const trim = JSON.stringify(Object.assign({}, ctx, { allPlayers: undefined })).length;
  console.log(`payload: full ${kb(full)} (~${Math.round(full / 4)} tok) | `
    + `shortlist only ${kb(trim)} (~${Math.round(trim / 4)} tok)`);
  console.log(`wrote ${out}`);
})();

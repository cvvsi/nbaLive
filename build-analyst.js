/* Compact player file for the fantasy analyst (the relay's MCP tools, worker/yahoo-relay.js):
 * data/analyst.json. The relay runs on Cloudflare's free plan, 10 ms of CPU per request, and parsing
 * rankings.json + regression.json takes ~12 ms, so it reads this instead (~1 ms).
 *
 * Per player (ESPN id): name, team, position, and plain 9-cat ranks, each the mean of the 9
 * z-scores (no punts, no weekly weights): Proj (rest of season, regression.json's x), Season, 14 and
 * 7 days (rankings.json's windows), plus games, minutes, the last 3 games' minutes against the games
 * before them, and the Proj per-game line.
 * Ranks are among everyone in each list, so they can sit a few spots off the site's (whose pool and
 * punts are the reader's). Run after build-rankings.js (Rankings job). */
const fs = require('fs');
const R = JSON.parse(fs.readFileSync('data/rankings.json', 'utf8'));
const G = JSON.parse(fs.readFileSync('data/regression.json', 'utf8'));
const mean = z => z.reduce((a, b) => a + b, 0) / z.length;
const rankBy = (ids, val) => { const o = {}; ids.filter(id => val(id) != null).sort((a, b) => val(b) - val(a)).forEach((id, i) => o[id] = i + 1); return o; };
const win = (id, w) => { const v = R.players[id] && R.players[id].w && R.players[id].w[w]; return v && v[0] > 0 ? mean(v.slice(2)) : null; };
const ids = [...new Set([...Object.keys(R.players), ...Object.keys(G.players)])];
const pr = rankBy(ids, id => { const x = G.players[id] && G.players[id].x; return x ? mean(x.slice(2)) : null; });
const sr = rankBy(ids, id => win(id, 'season')), r14 = rankBy(ids, id => win(id, 'd14')), r7 = rankBy(ids, id => win(id, 'd7'));
const r1 = v => Math.round(v * 10) / 10, out = {};
// Minutes over the team's last 3 games, per game he played (the window counts a missed game as 0),
// and the change from his minutes per game before them (pm: the site's role-change baseline).
const last3 = a => { const g = a.w && a.w.g3; if (!g || !g[0]) return {}; const m = g[1] * 3 / g[0];
  return { m3: r1(m), g3: g[0], dm3: a.pm != null ? r1(m - a.pm) : null }; };
for (const id of ids) {
  const a = R.players[id] || {}, g = G.players[id] || {}, s = a.w && a.w.season;
  out[id] = { n: a.n || g.n, t: a.t || g.t, p: a.p || '', pr: pr[id] || null, sr: sr[id] || null, r14: r14[id] || null, r7: r7[id] || null,
    gp: s ? s[0] : 0, mpg: s ? r1(s[1]) : null, ...last3(a), xp: g.xp ? g.xp.map(r1) : null };
}
fs.writeFileSync('data/analyst.json', JSON.stringify({ asOf: R.asOf, xpf: G.xpf, p: out }));
console.log('analyst.json:', ids.length, 'players');

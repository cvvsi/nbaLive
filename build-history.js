/* Last two completed regular seasons -> data/history.json (committed), the baseline the
 * Buy/Sell tab compares this season against. build-rankings.js reads it every night.
 *
 * Per player and season: raw totals (games, minutes, counting stats, makes/attempts, and
 * usage's numerator/denominator), so the nightly build can blend seasons by simply adding.
 * ly = last season's per-game 9-cat z-scores (same pool rules as the rankings) for anyone
 * with LY_GP+ games, so the page can show where he finished.
 *
 * Usage:  node build-history.js     (once a season, after the regular season ends)
 * Takes a few minutes the first time: ~1,230 box scores a season, cached in .cache/.
 */
const fs = require('fs');
const { loadGames, totals, rankWindow, STATS, CATS, r2 } = require('./build-rankings.js');

const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const OUT = 'data/history.json', LY_GP = 20;
const label = y => `${y - 1}-${String(y).slice(2)}`;   // 2026 -> "2025-26"

(async () => {
  // The season in progress (or just finished) per ESPN; the two before it are the baseline.
  const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
  const years = [cur - 1, cur - 2], seasons = years.map(label);
  const players = {};
  for (const [i, y] of years.entries()) {
    // May 1 is in the playoffs, so the calendar is that season's and every regular-season date is before it.
    const games = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`);
    for (const t of Object.values(totals(games))) {
      const p = players[t.id] || (players[t.id] = { n: t.name, t: t.team, s: {} });
      p.s[seasons[i]] = Object.fromEntries(['gp', 'use', 'tpos', ...STATS].map(k => [k, Math.round(t[k] * 10) / 10]));
    }
    if (i === 0) for (const p of rankWindow(games)) if (p.gp >= LY_GP)
      players[p.id].ly = [p.gp, Math.round(p.min * 10) / 10, ...CATS.map(c => r2(p.z[c]))];
    console.log(`${seasons[i]}: ${games.length} games`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ seasons, built: new Date().toISOString().slice(0, 10), players }));
  console.log(`${OUT}: ${Object.keys(players).length} players`);
})();

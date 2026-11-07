/* Can a GitHub runner read NBA.com's tracking stats (stats.nba.com)? One-off check.
 * Usage: node check-nba-tracking.js   Prints status and row counts; writes nothing.
 * Asks for one day of Passing (2024-25, Nov 15 2024, totals) and a full season of Touches.
 */
const BASE = 'https://stats.nba.com/stats/leaguedashptstats';
const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com',
};
const q = o => new URLSearchParams({
  College: '', Conference: '', Country: '', DateFrom: '', DateTo: '', Division: '', DraftPick: '', DraftYear: '',
  GameScope: '', Height: '', LastNGames: '0', LeagueID: '00', Location: '', Month: '0', OpponentTeamID: '0',
  Outcome: '', PORound: '0', PerMode: 'Totals', PlayerExperience: '', PlayerOrTeam: 'Player', PlayerPosition: '',
  SeasonSegment: '', SeasonType: 'Regular Season', StarterBench: '', TeamID: '0', VsConference: '', VsDivision: '', Weight: '', ...o,
}).toString();
const tests = [
  { name: 'Passing, one day (2024-11-15)', p: { PtMeasureType: 'Passing', Season: '2024-25', DateFrom: '11/15/2024', DateTo: '11/15/2024' } },
  { name: 'Touches, 2024-25 season', p: { PtMeasureType: 'Possessions', Season: '2024-25' } },
  { name: 'Rebounding, 2022-23 season', p: { PtMeasureType: 'Rebounding', Season: '2022-23' } },
  { name: 'Drives, this season', p: { PtMeasureType: 'Drives', Season: '2026-27' } },
];
(async () => {
  let ok = 0;
  for (const t of tests) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}?${q(t.p)}`, { headers: H, signal: AbortSignal.timeout(45000) });
      const txt = await r.text(); let rows = '-', cols = '';
      try { const j = JSON.parse(txt), rs = j.resultSets[0]; rows = rs.rowSet.length; cols = rs.headers.join(','); } catch (e) { cols = txt.slice(0, 120).replace(/\s+/g, ' '); }
      console.log(`${t.name}: HTTP ${r.status}, ${rows} rows, ${Date.now() - t0} ms\n  ${cols}`);
      if (r.ok && rows !== '-' && rows > 0) ok++;
    } catch (e) { console.log(`${t.name}: FAILED after ${Date.now() - t0} ms: ${e.name} ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`\n${ok}/${tests.length} answered with data`);
})();

/* Backtest: does the opponent's matchup ease (ease.js) make next-game projections better, and how
 * much of it should we believe?
 *
 * Usage:  node backtest-ease.js          real seasons (ESPN, cached in .cache/season-YYYY.json)
 *         node backtest-ease.js --mock   synthetic seasons with known team effects, to check the script
 * Writes: data/backtest-ease.json (pick = the K and a per category build-rankings.js uses); prints tables.
 *
 * Every 7 days from mid-November on, using only the games before that date:
 *   - the ease table (each team's effect per category, ease.js)
 *   - each player's per-minute rates this season (150+ minutes; FG% on 40+ attempts)
 * then for every player-game in the next 7 days, at the minutes he actually played (so only the
 * opponent is being tested, not minutes):
 *   base  = his rate x minutes (FG: his FG% x attempts, scored on makes)
 *   adj   = base x (1 + a x pct x g / (g + K)), the opponent's effect pulled toward zero by K games
 * scored by squared error against what he did. K in 0..320 and a in .25..1 are fitted per category
 * on two seasons and scored on the third, each in turn (out of sample); "gain" is the % less error
 * than base. pick = the setting that does best over all three seasons.
 */
const fs = require('fs');
const { EK, CNT, easeTable } = require('./ease.js');
const MOCK = process.argv.includes('--mock');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const KS = [0, 5, 10, 20, 40, 80, 160, 320], AS = [.25, .5, .75, 1], STEP = 7, FROM_G = 8, MIN_R = 150, FGA_R = 40;
const label = y => `${y - 1}-${String(y).slice(2)}`;
const SET = KS.flatMap(K => AS.map(a => ({ K, a })));

// One season -> SSE[cat][setting index] and the no-adjustment SSE[cat], plus counts.
function season(games) {
  games = [...games].sort((a, b) => a.date < b.date ? -1 : 1);
  const dates = [...new Set(games.map(g => g.date))];
  const E = Object.fromEntries(EK.map(k => [k, { base: 0, n: 0, s: SET.map(() => 0) }]));
  // start once the average team has FROM_G games
  const tg = {}; let start = null;
  for (const g of games) { for (const t of new Set(g.rows.map(r => r.team))) tg[t] = (tg[t] || 0) + 1;
    const v = Object.values(tg); if (!start && v.length >= 20 && v.reduce((a, b) => a + b, 0) / v.length >= FROM_G) start = g.date; }
  if (!start) return E;
  for (let i = dates.indexOf(start); i < dates.length; i += STEP) {
    const D = dates[i], end = dates[Math.min(dates.length, i + STEP)] || '9999';
    const prior = games.filter(g => g.date < D), next = games.filter(g => g.date >= D && g.date < end);
    const T = easeTable(prior), R = {};
    for (const g of prior) for (const r of g.rows) { const o = R[r.id] || (R[r.id] = { min: 0, fgm: 0, fga: 0 }); o.min += r.min; o.fgm += r.fgm || 0; o.fga += r.fga || 0; for (const k of CNT) o[k] = (o[k] || 0) + (r[k] || 0); }
    for (const g of next) {
      const ts = [...new Set(g.rows.map(r => r.team))]; if (ts.length !== 2) continue;
      for (const r of g.rows) {
        const o = r.team === ts[0] ? ts[1] : ts[0], t = T[o], p = R[r.id]; if (!t || !p || p.min < MIN_R || !(r.min > 0)) continue;
        for (const k of EK) {
          let base, act;
          if (k === 'fg') { if (p.fga < FGA_R || !(r.fga > 0)) continue; base = r.fga * p.fgm / p.fga; act = r.fgm; }
          else { base = (p[k] || 0) / p.min * r.min; act = r[k] || 0; }
          const e = E[k]; e.n++; e.base += (base - act) ** 2;
          SET.forEach((s, j) => { const pr = base * (1 + s.a * t.pct[k] * t.g / (t.g + s.K)); e.s[j] += (pr - act) ** 2; });
        }
      }
    }
  }
  return E;
}

function analyze(G, tests) {
  const per = Object.fromEntries(tests.map(y => [y, season(G[y])]));
  const out = { seasons: tests.map(label), grid: { K: KS, a: AS }, step: STEP, fromGames: FROM_G, cats: {}, pick: {} };
  console.log('\nGain over no adjustment (% less squared error), fit on the other two seasons, scored on each:');
  for (const k of EK) {
    const oos = tests.map(y => {
      const fitOn = tests.filter(x => x !== y), sse = SET.map((_, j) => fitOn.reduce((a, x) => a + per[x][k].s[j], 0));
      const j = sse.indexOf(Math.min(...sse)), e = per[y][k];
      return { season: label(y), K: SET[j].K, a: SET[j].a, gain: e.base ? Math.round(1e4 * (1 - e.s[j] / e.base)) / 100 : 0, n: e.n };
    });
    const all = SET.map((_, j) => tests.reduce((a, y) => a + per[y][k].s[j], 0)), base = tests.reduce((a, y) => a + per[y][k].base, 0);
    const j = all.indexOf(Math.min(...all)), gain = Math.round(1e4 * (1 - all[j] / base)) / 100;
    // only use it where it helps out of sample in every season; otherwise a = 0 (off)
    const ok = oos.every(o => o.gain > 0);
    out.cats[k] = { oos, all: { K: SET[j].K, a: SET[j].a, gain }, raw: Math.round(1e4 * (1 - all[SET.findIndex(s => s.K === 0 && s.a === 1)] / base)) / 100, used: ok };
    out.pick[k] = ok ? { K: SET[j].K, a: SET[j].a } : { K: SET[j].K, a: 0 };
    console.log(`${k.padEnd(4)} ${oos.map(o => `${o.season} ${o.gain >= 0 ? '+' : ''}${o.gain}% (K ${o.K}, a ${o.a})`).join(' · ')} | all three: K ${SET[j].K} a ${SET[j].a} ${gain >= 0 ? '+' : ''}${gain}% · raw (no shrink) ${out.cats[k].raw}%${ok ? '' : ' -> OFF'}`);
  }
  return out;
}

// Synthetic: 30 teams, real effects per category (+-8% pts .. +-15% blk), 250 players with steady
// per-minute rates and Poisson nights. The fit should find gains and a K that isn't 0.
function mockSeasons(years) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pois = l => { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const SD = { pts: .05, tpm: .08, reb: .05, ast: .06, stl: .07, blk: .12, to: .07, fta: .1, fg: .03 };
  const G = {};
  for (const y of years) {
    const eff = {}; for (let t = 0; t < 30; t++) eff['T' + t] = Object.fromEntries(EK.map(k => [k, (rnd() - .5) * 2 * SD[k] * 1.7]));
    const P = [...Array(300)].map((_, i) => ({ id: y + '_' + i, team: 'T' + (i % 30), m: 12 + rnd() * 22, r: { pts: .3 + rnd() * .5, tpm: rnd() * .1, reb: .1 + rnd() * .3, ast: .05 + rnd() * .2, stl: .02 + rnd() * .03, blk: rnd() * .05, to: .03 + rnd() * .05, fta: .05 + rnd() * .15, fga: .3 + rnd() * .3 }, fg: .42 + rnd() * .14 }));
    const games = [];
    for (let d = 0; d < 165; d++) {
      const order = [...Array(30).keys()].sort(() => rnd() - .5).slice(0, 14);
      for (let i = 0; i < order.length; i += 2) {
        const A = 'T' + order[i], B = 'T' + order[i + 1], rows = [];
        for (const p of P) if (p.team === A || p.team === B) {
          const o = p.team === A ? B : A, e = eff[o], min = Math.max(4, Math.round(p.m + (rnd() - .5) * 8)), row = { id: p.id, team: p.team, min };
          for (const k of CNT) row[k] = pois(p.r[k] * min * (1 + e[k]));
          row.fga = pois(p.r.fga * min); let m = 0; for (let s = 0; s < row.fga; s++) if (rnd() < p.fg * (1 + e.fg)) m++; row.fgm = m;
          rows.push(row);
        }
        games.push({ date: `${y}-${String(d).padStart(3, '0')}`, rows });
      }
    }
    G[y] = games;
  }
  return G;
}

(async () => {
  let G, tests;
  if (MOCK) { tests = [2023, 2024, 2025]; G = mockSeasons(tests); }
  else {
    const { loadGames } = require('./build-rankings.js');
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cur = (await (await fetch(`${API}/scoreboard?dates=${now}`)).json()).leagues[0].season.year;
    const last = cur - 1; tests = [last - 2, last - 1, last]; G = {};
    for (const y of tests) { G[y] = await loadGames(`${y}-05-01`, `.cache/season-${y}.json`); console.log(`${label(y)}: ${G[y].length} games`); }
  }
  const out = analyze(G, tests);
  if (!MOCK) { fs.writeFileSync('data/backtest-ease.json', JSON.stringify(out, null, 1)); console.log('\ndata/backtest-ease.json written'); }
})().catch(e => { console.error(e); process.exit(1); });

# 9-Cat Box

A phone-first NBA box score viewer for **9-category fantasy basketball**. It ranks every player who played on a given night by how much they helped across the 9 cats, in the spirit of Basketball Monster's box scores, so a 30-point night on 9-for-25 shooting with 6 turnovers doesn't look better than it was.

**Live site:** https://cvvsi.github.io/nbaLive/ (added to the phone home screen)

---

## What it does

- Loads every game for a date (US Eastern) and ranks all players who played by **Value**.
- **Buzz tab:** Yahoo's most added and dropped players, today so far and yesterday (Today / Yday switch), refreshed after the ~3am waivers and through the afternoon, next to your Szn / 3G / Proj ranks and minutes trend, with a Follow / Fade (adds) or Panic / Agree (drops) read built from those numbers. Linkable at `#buzz`.
- **Tabs** sit in a bottom bar (Box · Ranks · Proj · Schedule · Buy/Sell · Buzz), a raised strip with the active view as a filled pill; the top bar keeps the date, search and Punt. Both bars slide away while scrolling down and come back on any scroll up.
- **List / Cards** (button beside search, on Ranks and Proj; remembered per phone, List by default): List is the card without the photo, so about 9 players fit a screen instead of 7, every number still labeled.
- **Ranks tab** (`#ranks`): what actually happened, ranked. Windows: Season / 14D / 7D / L3 (each team's last 3 games, a missed game counting as zero). **Per g** ranks how well a player has played; **Total** = per-game value × games played, so missed games count (L3 has no Total: it already counts them). Cards show the window's per-game line (`l[window]` in `rankings.json`, fields `lf`), games played and any injury note. Same pool and punts as the rank ladder.
- **Totals count from zero.** Week value, Season "Total" and Ranks "Total" multiply games by a player's value measured against an empty roster spot (each z-score plus its category's pool mean ÷ spread; FG%/FT% impact stays centered on the league average), not against the top-130 average. Otherwise a below-average player (most streamers) would rank *worse* the more games he plays. Per-game ranks are unchanged. Ranks reads each window's pool from `windows[w].zp` in `rankings.json`; Proj uses `zp` in `regression.json`.
- **Proj tab** (`#proj`): projections in three views. **Season**: Proj's per-game line with games left (Per g ranks quality; Total = per-game value × games left, so injuries count). **Week**: any week from this one to the season's last (‹ › picker, this week by default; this week counts only the games left), Mon–Sun. value = games × per-game value, so a 4-game player can beat a better 2-game one; the name line shows games, a back-to-back and ▲/▼ against the per-game season rank; stats per game, or week totals with the Totals switch. **Today**: tonight's slate, with sportsbook props swapped in for Proj where they exist, plus "Out tonight" and "No line posted" sections. All three use your punts, skip games ESPN's injury report says a player will miss, and shift minutes while a teammate is out (see *Next man up* below). See *Projections, props and injuries* below.
- **Schedule tab** (`#schedule`): any week from this one to the season's last (‹ › picker, this week by default). A teams × days grid with each opponent (@ = away), the number of games each night (5 or fewer tinted: the easiest nights to start a streamer), back-to-backs underlined, and tap-to-open rotations. Tap a team for its week: everyone projected for 10+ minutes as Starters (the official starting five from the team's last game, `ls` in `rankings.json`; anyone now out is replaced by the next player by projected minutes), Rotation and Out this week, each as one line: a rank badge (week rank; green inside 100, plain to 130, outlined beyond), the name, and the categories he helps (green tags, strongest first, up to five: per-game Proj z ≥ 0.25 against everyone projected for 15+ minutes, a streamer-level bar; turnovers left out, punts skipped). Tap a game for both teams that night, ranked for that night instead (the header gives the pool size, e.g. "of 58" on a 2-game night, and the badge color is the player's season per-game tier, so a light night doesn't turn everyone green; a small "wk #" beside each name keeps his week rank in view for planning the week's moves): our per-game Proj ranked among everyone playing that night (no props, no opponent adjustment).
- **Buy/Sell tab:** is a hot or cold start real? This season's per-minute numbers against last season's, with a projected rank (see below).
- **Cards, one per player.** Fixed stat order everywhere: PTS · REB · AST as big numbers, then 3PM · STL · BLK · TO · FG · FT, then the role (MIN, USG). Every number carries its label. Green marks a big line by plain fantasy thresholds (25+ pts, 8+ reb or ast, 4+ threes, 3+ stl or blk, FG% 60+ on 10+ shots, FT% 90+ on 4+); red marks what hurt (4+ TO, FG% ≤35 on 12+ shots, FT% under 60 on 4+); Value is colored only at ±1. Each Box card also has the rank ladder (Szn / 14D / 7D / L3; white numbers, shaded green or red only for risers and fallers) and hashtag flags (#MinutesUp, #Riser, #Faller, #BuyLow, #PickUp, #SellHigh). On wide screens the cards flow into a grid.
- **Player page:** tap any card on any tab. Tonight's line with z-scores, the season line, rank tiles (Season / 14 / 7 / Last 3, Now / Projected / Last season), the last 5 games as compact lines (from ESPN's game log, with each game's Value, punts applied), the written read split into labeled parts, the 30-minute upside, and this season vs. last. Full screen on a phone, a side panel on desktop; back closes it.
- **Player search:** the magnifier in the top bar (or `/` on a keyboard) finds anyone in the season ranks or tonight's box score, by any part of the name (accents and Jr./III ignored) or by team (`bos`). Results show team, season rank and tonight's line; tap one for the player page, and back returns to the results.
- **Live:** in-progress games refresh every 60 s, and again whenever the page comes back into view.
- On first load, if no game has tipped off today, it shows the previous night.
- **Punt** any categories (Value is recomputed without them). Choose the comparison pool (everyone / 10+ / 15+ / 20+ minutes).
- Sort by Value, minutes, usage, or any single category's z-score (tap the category label).
- Light and dark themes follow the phone's setting.

## How Value is calculated

For one date (or one game, when filtered), relative to the **pool** = players at or above the minutes threshold who played that day. If fewer than 10 players qualify, everyone who played is used.

1. **Counting cats** (PTS, 3PM, REB, AST, STL, BLK, TO): `z = (player − pool mean) / pool std dev`. TO is negated, so fewer turnovers = positive.
2. **Percentage cats** use *impact*, which weights by volume:
   - `FG impact = FGM − poolFG% × FGA` (same for FT)
   - Then z-score the impact like a counting stat.
   - So 10/12 FG is worth far more than 2/2.
3. **Value** = average of the z-scores for the categories that aren't punted.
4. **Rank** = order by Value across all players that day.

**Usage %** (standard formula, from team totals summed from the box score):
`USG = 100 × (FGA + 0.44·FTA + TOV) × (TeamMin / 5) / (Min × (TeamFGA + 0.44·TeamFTA + TeamTOV))`

Checked against Basketball Monster: the mean of the 9 z-scores reproduces its Value column (e.g. 0.21 for Nickeil Alexander-Walker, ATL @ ORL, Oct 21 2026). Absolute numbers can differ slightly because their pool definition isn't public.

## Season / 14 / 7 / 3G ranks and movers

**League size: 10 teams.** 100 starting spots (`TOP` in `index.html`, green ranks, the "starter" tier), and 130 roster spots (`ROST`, the cutoff for movers, Buy/Sell and the "streamer" tier). The z-score pool is the top 130 (`POOL` in `build-rankings.js`). To switch league size, change all three, then rerun `build-history.js` and `build-rankings.js`.

Each row shows the player's 9-cat rank over the season, the last 14 and 7 days, and **3G**: the team's last 3 games, where a game the player missed counts as a zero night so resting or injured players can't look hot. A big night from someone outside the top 100 stands out as a possible pickup. Ranks 1–100 are green (starters in a 10-team league), 101–130 plain (bench), and anything lower dimmed. Tapping the row shows the games behind each rank. The JSON also carries a 30-day window that the page doesn't show.

**Movers** (logic in `rankWindows()`, constants `MOVE` and `MINUP`):
- Green 3G pill (riser): 3G rank inside 130 and at least 40% better than season rank, and 20+ spots.
- Red 3G pill (faller): the mirror case, for anyone inside 130 on the season.
- **▲n** after minutes: n more minutes a game over the last 3 than in the games before them (`pm` in the JSON), at least +6 and landing at 24+. It's the earliest sign of a role change.
- The **Movers** sort shows only flagged players, with the biggest jumps first.

- **Built nightly** by `build-rankings.js`, run by `.github/workflows/rankings.yml` at 2:23 and 4:23am ET (see *Scheduling* below). The script commits `data/rankings.json`, and that push redeploys Pages. Run it by hand from the Actions tab (*Rankings → Run workflow*) or locally with `node build-rankings.js`.
- **Math:** per-game averages over the window, z-scored against a top-130 pool (10 teams × 13). The pool is iterated so it settles on rosterable players, and only players with at least half the window's max games are eligible for it. FG%/FT% use the same impact formula as the box score. Regular season only.
- The JSON stores per-window z-scores, not ranks, so the page re-ranks with your punts applied.
- Finished box scores are cached in `.cache/games.json` (git-ignored; the Action keeps it with `actions/cache`), so each run only fetches new games.

## Buy/Sell tab (regression)

Early-season ranks are noisy. Five games of hot or cold shooting, a couple of blowouts or some foul trouble can move a rank by 100 spots. The tab asks whether a start is real by comparing this season's **per-minute** numbers with last season's. The heuristic: role (minutes, usage) tends to stick, while per-minute production and shooting over a few games mostly don't.

Each row: **Now** (season rank), **Proj**, **LY** (last season's final per-game rank), then this season's MIN, USG, FG%, FT% and counting stats, each colored by how far it sits from last season. A **Per 36 / Per game** switch above the strip (remembered per phone) sets the units for 3PM through TO; per 36 is the default because it's the rate Proj is built from, and opening a row shows the other unit in words. Tapping a row shows last season's number under each cell, plus the shooting volume behind the percentages.

- **Proj** = the rank of a *projected line*: this season's minutes (nudged by 5 games of last season's mpg) × per-minute rates and shooting % blended toward the baseline (below):
  `rate = (this season's count + baseline rate × K) / (this season's minutes or attempts + K)`.
  K (`PRIOR` in `build-rankings.js`) is how much of this season it takes to count as much as the baseline. It is small for fast-settling rates (FGA 150 min, 3PA 200 min) and large for noisy ones (STL 1200 min, TO 600 min, 3P% 500 attempts). The values are **fitted** by `backtest.js` (*Actions → Backtest*) on 2023-24 to 2025-26: each season's first 5/8/12/20 games predict the rest of it, fit on two seasons and scored on the third. A K was changed only where the fitted value was steady across seasons and beat the old one out of sample (REB 200→450, TO 300→600, STL 600→1200, FTA 250→450, FG% 250→450, minutes nudge 3→5 games). A usage-based role adjustment was tested and left out: it helped free throws but made shot volume worse. The baseline never weighs more than it actually observed. Points are rebuilt from the blended makes (`2·FGM + 3PM + FTM`), so a shooting slump flows through to PTS and 3PM.
- **Buy**: Proj inside 130, at least 40% better than Now and 20+ spots. **Sell**: the mirror case for anyone inside 130 now. Needs 3+ games and a baseline. The same `MOVE` threshold as the movers.
- **Baseline** = last season plus the season before at half weight (`PREV_W`; totals add, so it's minutes-weighted). Two seasons steady the rates, shooting % most of all. If the player logged under 500 minutes last season, the season before counts in full. Minutes aren't affected: the 5-game nudge and everything the page labels "last season" stay last season alone.
  - *Why half weight:* checked against an analyst's daily projections (Nov 2026), whose rates weight the season before at 0.3–0.6. Adding it moved Proj closer to his on every category, most on FT% (avg gap 2.3 → 1.7 pts) and FG% (1.5 → 1.3). We kept our own minutes, since his are set by hand, and our own shooting weights, since raising them barely changed anything.
- **Rookies** (under 200 minutes over the two seasons before, so no baseline): the average rookie at his position (G/F/C) from the last three rookie classes stands in for the baseline, with K fitted for rookies (`ROOKIE_K` in `build-rankings.js`: FGA/3PA/AST 50, FT% 50, REB/BLK 100, FTA/TO/FG% 150, 3P% 200, STL 600; minutes stay his own). `backtest-rookie.js` (*Actions → Backtest*; priors and results in `data/backtest-rookie.json`) fit it on two seasons and scored the third: after 8 games it beat the raw line by 13–20% on points, rebounds and assists, 26–47% on blocks and steals, and 43–63% on FG%, FT% and 3P%; by 20 games the gain is smaller and gone on blocks. Splitting rookies by early role (25+ mpg) didn't add anything reliable, and a minutes growth factor was left out (it mostly reflects which rookies kept playing). Every rookie Proj is tagged **Rookie est.** (Proj·R on the Box chip, R in the Schedule panel): newer and less tested than the veteran model.
- Punts re-rank Now, Proj and LY, like everything else.

**Analyst note.** Tapping a player on either tab opens a written read (`analyst()` in `index.html`), followed by a labeled grid of the numbers behind it. It's templated from the data, with no AI and no outside info: tonight's game (Box tab), the season line, role vs. last season (and that season's finish), blowouts and foul trouble (`cx` in the JSON: blowout games and their mpg, other games and their mpg, games with 5+ fouls), shooting luck with attempts, per-36 changes, the role-upside line (`up`: the same blended rates at 30 min, for anyone under 26 mpg), the Proj gap, the trend, category profile and punt fit. It opens with the call for a 10-team league (verdict first, then the why), says which numbers are role (sticks) and which are luck (fades). Tags: Buy low / Pick up / Sell high / Ride it / Hold / Streamer / Watch / Drop / Pass; Drop means outside 10-team value but probably rostered (top 130 last season or 40%+ rostered on Yahoo). The ⓘ on the Buy/Sell tab explains all of it in the app.

**Data:** `build-history.js` pulls the last two completed regular seasons from the same ESPN endpoints (~1,230 box scores a season, cached in `.cache/season-YYYY.json`) and writes `data/history.json`: per-player season totals plus last season's z-scores. **Run it once a season** (after the regular season ends) and commit the output. The nightly `build-rankings.js` reads it and writes `data/regression.json`. Without `history.json` it skips that step.

## Projections, props and injuries

- **Proj line** (`xp` in `regression.json`, fields `xpf`): the per-game line behind the Proj rank, plus `zp`, the pool it's scored against (league FG%/FT%, each category's mean and spread), so the page can score any line on the same scale.
- **Schedule** (`build-schedule.js` → `data/schedule.json`): every team's remaining regular-season dates from ESPN's scoreboard, cached in `.cache/schedule.json` (dates over 10 days out are refetched weekly). Runs in the nightly Rankings job and before each props pull.
- **Injuries** (same script → `data/injuries.json`): ESPN's league-wide injury report, `[status, estimated return, note, name, team]` by player id. Out with a return date: the player misses games before it. Out with none: Week counts no games and Season shows "?". Day-to-day still plays, flagged.
- **Props** (`fetch-props.js` → `data/props.json`, plus a dated copy in `data/props/` to score later): player props from [The Odds API](https://the-odds-api.com), in the `.github/workflows/props.yml` job at 4:13 and 6:13pm ET; the second run only fetches games the first found unpriced. Needs the `ODDS_API_KEY` repo secret (never commit the key: the repo is public). Credits: listing games is free, and each game costs 1 credit per market that comes back (about 6 a game for points, rebounds, assists, threes, steals and blocks; turnovers aren't offered). The free plan's 500 a month covers about a week of full slates.
  - **Odds → average:** per book, the over/under's vig is removed (each side's implied probability ÷ their sum), then the mean is solved so P(stat > line) equals the fair over probability. Points, rebounds and assists use a normal curve with variance PHI × mean (2.2, 1.3, 1.4); threes, steals, blocks and turnovers a Poisson. The median across books is kept. Only these implied averages are stored, not raw odds.
  - **Tonight's line:** the market's average for each stat it priced and Proj for the rest. Shot attempts (and turnovers, if not priced) scale with the market's points, so FG%/FT% stay Proj's but carry the role the market expects. Market names are matched to ESPN's exactly, then by team + last name + first initial ("Herb" Jones).
  - **No line:** a regular (18+ projected minutes) whose teammates have props but who has none is often out; if ESPN's report doesn't list him, he goes under "No line posted".

## Yahoo Buzz Index

`fetch-buzz.js` runs in its own Action (`.github/workflows/buzz.yml`) at 4:37, 5:37 and 6:37am ET (after Yahoo's ~3am waivers), 12:37 and 3:37pm, games or not, and also inside the Rankings and Props jobs. It writes `data/buzz.json`: yesterday's (final) and today's (so far, under `today`) most added and most dropped players across all Yahoo leagues, from the public [Buzz Index](https://basketball.fantasysports.yahoo.com/nba/buzzindex) page (no login). Each row has adds, drops, trades and % rostered / started. The page is parsed from HTML, so if Yahoo changes its layout the run fails with "No rows parsed" and the rankings are unaffected. Run it by hand from *Actions → Buzz → Run workflow*. The morning report judges each move as Follow or Fade.

## Scheduling (cron-job.org)

GitHub's own scheduled runs proved unreliable here (Rankings 8+ hours late, or skipped; hourly Buzz ran 3 times in two days), and a paid plan doesn't change that. Manual *Run workflow* starts within seconds, so a free [cron-job.org](https://cron-job.org) account calls that API on time. Account timezone: America/New_York.

| Job | Crontab (ET) | URL (POST) | Body |
|---|---|---|---|
| Rankings | `23 2,4 * * *` | `https://api.github.com/repos/cvvsi/nbaLive/actions/workflows/rankings.yml/dispatches` | `{"ref":"main"}` |
| Buzz | `37 4,5,6,12,15 * * *` | `.../workflows/buzz.yml/dispatches` | `{"ref":"main"}` |
| Props | `13 16,18 * * *` | `.../workflows/props.yml/dispatches` | `{"ref":"main","inputs":{"mode":"run"}}` |

Headers on each: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`. Success is `204 No Content`; failures email the account.

- **Token:** a fine-grained GitHub token limited to this repo with *Actions: Read and write* only, stored only in cron-job.org. **It expires 2027-04-01**, before the regular season ends: regenerate it in late March and paste `Bearer <new token>` into all three jobs.
- **401** = bad or missing token (the value must start with `Bearer `), **403** = token lacks Actions write, **404** = wrong URL or repo.
- The same times stay in the workflow files as a backup (UTC). A double run is harmless: each job commits only if something changed. If a schedule changes, change it in both places.

## Yahoo league data

**Paused:** since July 2026 Yahoo's Fantasy API answers 403 until the developer account is approved (apply at sports.yahoo.com/developer/access/). Sign-in works; data calls don't.


`fetch-yahoo.js` runs in the same Action and writes `data/yahoo.json`: every team's roster (mine flagged), the best free agents by season rank and by last week's rank, recent league adds/drops/trades, and Yahoo-wide **most added / most dropped** (change in percent owned over 1 and 7 days, from snapshots kept in `data/yahoo-owned.json`). The morning report reads it. The page doesn't use it yet.

It needs two repo secrets (Settings → Secrets and variables → Actions), `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET`, plus optionally `YAHOO_LEAGUE_ID` (otherwise the account's first NBA league). The refresh token lives in `data/yahoo-token.enc`, encrypted with a key derived from the client secret, so it's safe in a public repo; a `YAHOO_REFRESH_TOKEN` secret overrides it. Without these the step skips itself.

**One-time setup:** create an app at https://developer.yahoo.com/apps/create/ (Confidential Client, Fantasy Sports: Read, redirect URI `https://localhost:8080`) and add the two secrets. Run `node yahoo-auth.js <client_id>` (or build the URL by hand) to get the login link, open it, click Agree, and copy the `code=` value from the address bar of the localhost error page. Then run **Actions → Yahoo login → Run workflow** with that code within a few minutes. It saves the token and pulls the league once. Since the repo is public, `yahoo.json` (league rosters) is public too.

## Data source

ESPN's public site API. It's free, needs no key, updates live during games, and is readable directly from the browser, so there's no server.

| Use | Endpoint |
|---|---|
| Games for a date | `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD` |
| Box score for a game | `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}` |

Fields used:
- Scoreboard `events[]`: `id`, `status.type.state` (`pre` / `in` / `post`), `status.type.shortDetail`, `competitions[0].competitors[]` (`homeAway`, `team.abbreviation`, `score`).
- Summary `boxscore.players[]`: per team, `statistics[0].keys` and `athletes[]` (`athlete.displayName`, `athlete.position.abbreviation`, `starter`, `didNotPlay`, `stats[]`). Each stat is looked up by key name, never by array position. Keys: `minutes`, `points`, `fieldGoalsMade-fieldGoalsAttempted`, `threePointFieldGoalsMade-threePointFieldGoalsAttempted`, `freeThrowsMade-freeThrowsAttempted`, `rebounds`, `assists`, `turnovers`, `steals`, `blocks`, `fouls`, `plusMinus`.

**Caveats**
- The API is unofficial and undocumented. If ESPN changes it, only `loadDate()` and `parseBox()` need updating.
- Minutes come back as whole numbers.
- Mid-slate, players from early games have more minutes than players in games still going, so the all-games ranking is only fair once games finish. The single-game filter is fair at any time.

**Alternatives considered:** NBA.com stats (via `swar/nba_api` or `bttmly/nba`) is official and richer, with exact minutes, official usage and multi-day logs. But it blocks requests made straight from a browser, so it needs a server or scheduled job. See the roadmap.

## Project layout

Everything lives in one file: **`index.html`**. There is no build step and no dependencies besides two Google Fonts.

Inside `index.html`, in order:

| Section | What it holds |
|---|---|
| `<style>` `:root` | Design tokens: colors (light, then dark under `prefers-color-scheme`), fonts, `--bar` height |
| Markup | Top bar (date nav, Punt button) → settings sheet → game tiles → sticky category ruler → `#list` |
| `CATS` | The 9 categories (`k` = key, `l` = label). Order here sets the order everywhere. |
| `S` | App state: date, events, players, selected game, punts, pool, sort, expanded rows |
| `store` | `localStorage` wrapper (punts and pool are remembered per phone) |
| `loadDate(d, auto)` | Fetches scoreboard + box scores, schedules the live refresh |
| `parseBox(ev, json)` | ESPN box score → player objects, including usage |
| `compute()` / `scoreValue()` | z-scores and Value (see the math above) |
| `renderGames()`, `renderCats()`, `render()`, `cell()` | UI |
| Controls block | Event handlers |

Player object fields: `id, name, pos, team, opp, home, game, starter, min, pts, reb, ast, stl, blk, to, pf, pm, fgm, fga, tpm, tpa, ftm, fta, usg, fgi, fti, z{pts..to}, value, rank`.

## Working on it

**Run locally**
```powershell
cd C:\Users\saacc\Documents\Projects\FantasyBoxScores
git pull
python -m http.server 8000
```
Then open http://localhost:8000. To check it on your phone over Wi-Fi, use `http://<your-PC-IP>:8000`. The VS Code "Live Server" extension also works.

To test the phone layout on desktop, use Chrome DevTools → device toolbar → iPhone width (~390 px).

**Deploy:** push to `main`. GitHub Pages serves the repo root, and the live site updates in about a minute. If the home-screen app still shows the old version, close and reopen it.

## Conventions

- **Keep it one file with no build step.** It must keep working when opened from GitHub Pages as-is.
- **Phone first.** It must fit 390 px wide with no sideways page scroll, and the 9-cell strip must stay on one line.
- **Every color is a token in `:root`,** with a matching dark value. Don't hard-code colors in rules or JS (the heat colors use `color-mix` on `--pos` / `--neg` / `--cell`).
- **One accent color** (`--ball`, orange). Green and red are reserved for good and bad stats.
- **Numbers use `--num`** (IBM Plex Mono, tabular digits). Names and labels use `--name` (Archivo Narrow).
- **Read ESPN stats by key name, not array index.**
- Anything stored in `localStorage` is wrapped in try/catch (private browsing can throw).

## Next man up: injury minutes

When a regular is out, his teammates' minutes rise until he's back, then ease back down. Week, Schedule, Today, Season Total and Season per-game (the average over the games left) all use these minutes; only minutes move, per-minute rates stay Proj's.

- **Build** (`nextMan()` in `build-rankings.js` → `nm` in `regression.json`): for every regular (Proj 24+ min), each teammate's minutes as a change from his Proj minutes, `[dWith, dOut]`:
  - **dWith**, with the regular playing: minutes per game played in those games, nudged by 5 games of last season's mpg like Proj (so with only 2 games together, mostly last season). Fixes a fill-in's Proj running high once the regular is back.
  - **dOut**, while he's out: half the regular's minutes shared by his position group (G/F/C) by minutes (the fixed rule), blended with the teammate's minutes in the games already missed, the rule counting as 1 game. A teammate needs 3+ games played during the absence for his own pattern; otherwise the rule alone.
  - `n` = games missed in a row at the end of the data, `bk` = games since coming back from a 5+ game absence.
- **Page** (`minAt()` in `index.html`): on a date ESPN's injury report has the regular out, teammates take dOut; otherwise dWith. With several regulars out, the biggest gain and the biggest cut apply, not the sum (each one's dOut already includes games the others missed).
- **Ramp-up** after a 5+ game absence, measured by `backtest-return.js` (215 returns, 2023-24 to 2025-26; `data/backtest-return.json`):

  | Game back | 1 | 2 | 3 | 4 | 5 | 6 |
  |---|---|---|---|---|---|---|
  | Returner's share of his minutes (`NMRET`) | 80% | 84% | 92% | 90% | 94% | 92% |
  | Fill-in keeps of his extra minutes (`NMKEEP`) | 48% | 44% | 36% | 34% | 35% | 26% |

  Fill-ins are those who were regulars before the absence, on nights the returner plays. Out of sample the curve beat both "back to old minutes at once" (17% less error for the returner, 32% in game 1) and "fill-in keeps the role". The returner also sits about 1 game in 5 over those 6; that's left to the injury report.
- Cards say why: "Minutes 27 (Proj 22): J. Duren out", or "back ~Nov 9" when the rest of the season pulls them down. In the Schedule panel, a regular back from injury takes his starting spot back from the player who gained the most.
- Backtests behind it: `backtest-injury.js` (fixed rules don't work), `backtest-absence.js` (the team's own pattern cuts error 26%), `backtest-return.js` (the ramp). Every "Proj" rank (Proj tab, Buy/Sell, the Box card's rank ladder, the player page and Buzz) is this same season number, so a fill-in whose role ends when the starter returns shows up as a Sell.

## Roadmap ideas

1. **Last 7 / 14 / 30 days view.** Average Value, minutes and usage per player across a range, which is what you'd want for waiver decisions. Two ways to get the data:
   - In the browser: loop over the dates' ESPN box scores. Simple, but slow for 30 days (~200+ requests). Cache finished games in `localStorage`.
   - With a scheduled GitHub Action: run Python + `nba_api` (or the ESPN endpoints) nightly and commit a `data/*.json` file the page reads. Fast and official, but NBA.com may throttle GitHub's servers.
2. **My team / watchlist:** star players (saved in `localStorage`), highlight them, filter to "my guys", and show a summary of your roster's night.
3. **Free-agent focus:** hide players you mark as rostered in your league.
4. **Season context:** compare tonight's line to the player's season average (ESPN athlete endpoints).
5. **Injury / DNP list** per game: ESPN's `didNotPlay` and `reason` fields are already in the box score data.
6. **Web app manifest + icon** so the home-screen app gets a proper icon and opens without browser chrome.
7. **Pull-to-refresh** and an "updated X min ago" indicator.

# 9-Cat Box

A phone-first NBA box score viewer for **9-category fantasy basketball**. It ranks every player who played on a given night by how much they helped across the 9 cats, in the spirit of Basketball Monster's box scores, so a 30-point night on 9-for-25 shooting with 6 turnovers doesn't look better than it was.

**Live site:** https://cvvsi.github.io/nbaLive/ (added to the phone home screen)

---

## What it does

- Loads every game for a date (US Eastern) and ranks all players who played by **Value**.
- **Buy/Sell tab:** is a hot or cold start real? This season's per-minute numbers against last season's, with an expected rank (see below).
- Shows each player's 9 categories as a heat-colored strip (green = helped, red = hurt), plus minutes, usage %, starter flag and matchup.
- **Live:** in-progress games refresh every 60 s, and again whenever the page comes back into view.
- On first load, if no game has tipped off today, it shows the previous night.
- **Punt** any categories (Value is recomputed without them). Choose the comparison pool (everyone / 10+ / 15+ / 20+ minutes).
- Sort by Value, minutes, usage, or any single category's z-score (tap the category label).
- Tap a player row to see each category's z-score, plus +/-, fouls and shot attempts.
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

- **Built nightly** by `build-rankings.js`, run by `.github/workflows/rankings.yml` at 06:23, 07:41 and 08:53 UTC (three tries on odd minutes, because GitHub runs top-of-the-hour schedules hours late). The script commits `data/rankings.json`, and that push redeploys Pages. Run it by hand from the Actions tab (*Rankings → Run workflow*) or locally with `node build-rankings.js`.
- **Math:** per-game averages over the window, z-scored against a top-130 pool (10 teams × 13). The pool is iterated so it settles on rosterable players, and only players with at least half the window's max games are eligible for it. FG%/FT% use the same impact formula as the box score. Regular season only.
- The JSON stores per-window z-scores, not ranks, so the page re-ranks with your punts applied.
- Finished box scores are cached in `.cache/games.json` (git-ignored; the Action keeps it with `actions/cache`), so each run only fetches new games.

## Buy/Sell tab (regression)

Early-season ranks are noisy. Five games of hot or cold shooting, a couple of blowouts or some foul trouble can move a rank by 100 spots. The tab asks whether a start is real by comparing this season's **per-minute** numbers with last season's. The heuristic: role (minutes, usage) tends to stick, while per-minute production and shooting over a few games mostly don't.

Each row: **Now** (season rank), **Exp**, **LY** (last season's final per-game rank), then this season's MIN, USG, FG%, FT% and per-36 counting stats, each colored by how far it sits from last season. Tapping a row shows last season's number under each cell, plus the shooting volume behind the percentages.

- **Exp** = the rank of an *expected line*: this season's minutes (nudged by 3 games of last season's mpg) × per-minute rates and shooting % blended toward last season's:
  `rate = (this season's count + baseline rate × K) / (this season's minutes or attempts + K)`.
  K (`PRIOR` in `build-rankings.js`) is how much of this season it takes to count as much as the baseline. It is small for fast-settling rates (FGA 150 min, REB 200 min) and large for noisy ones (STL 600 min, 3P% 500 attempts). The baseline never weighs more than it actually observed. Points are rebuilt from the blended makes (`2·FGM + 3PM + FTM`), so a shooting slump flows through to PTS and 3PM.
- **Buy**: Exp inside 130, at least 40% better than Now and 20+ spots. **Sell**: the mirror case for anyone inside 130 now. Needs 3+ games and a baseline. The same `MOVE` threshold as the movers.
- **Baseline** = last season. If the player logged under 500 minutes last season, the season before is added (totals add, so it's minutes-weighted). Players with no baseline (rookies) show Exp as "–" and never get flagged, but still hold their rank slot.
- Punts re-rank Now, Exp and LY, like everything else.

**Analyst note.** Tapping a player on either tab opens a written read (`analyst()` in `index.html`), followed by a labeled grid of the numbers behind it. It's templated from the data, with no AI and no outside info: tonight's game (Box tab), the season line, role vs. last season (and that season's finish), blowouts and foul trouble (`cx` in the JSON: blowout games and their mpg, other games and their mpg, games with 5+ fouls), shooting luck with attempts, per-36 changes, the role-upside line (`up`: the same blended rates at 30 min, for anyone under 26 mpg), the Exp gap, the trend, category profile and punt fit. It ends with a tag: Buy low / Pick up / Sell high / Ride it / Hold / Streamer / Watch / Pass. The ⓘ on the Buy/Sell tab explains all of it in the app.

**Data:** `build-history.js` pulls the last two completed regular seasons from the same ESPN endpoints (~1,230 box scores a season, cached in `.cache/season-YYYY.json`) and writes `data/history.json`: per-player season totals plus last season's z-scores. **Run it once a season** (after the regular season ends) and commit the output. The nightly `build-rankings.js` reads it and writes `data/regression.json`. Without `history.json` it skips that step.

## Yahoo Buzz Index

`fetch-buzz.js` runs in the nightly Action and writes `data/buzz.json`: yesterday's most added and most dropped players across all Yahoo leagues, from the public [Buzz Index](https://basketball.fantasysports.yahoo.com/nba/buzzindex) page (no login). Each row has adds, drops, trades and % rostered / started. The page is parsed from HTML, so if Yahoo changes its layout the step logs "No rows parsed" and the rankings still publish. The morning report judges each move as Follow or Fade.

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

## Roadmap ideas

1. **Last 7 / 14 / 30 days view.** Average Value, minutes and usage per player across a range, which is what you'd want for waiver decisions. Two ways to get the data:
   - In the browser: loop over the dates' ESPN box scores. Simple, but slow for 30 days (~200+ requests). Cache finished games in `localStorage`.
   - With a scheduled GitHub Action: run Python + `nba_api` (or the ESPN endpoints) nightly and commit a `data/*.json` file the page reads. Fast and official, but NBA.com may throttle GitHub's servers.
2. **My team / watchlist:** star players (saved in `localStorage`), highlight them, filter to "my guys", and show a summary of your roster's night.
3. **Player search** box.
4. **Free-agent focus:** hide players you mark as rostered in your league.
5. **Season context:** compare tonight's line to the player's season average (ESPN athlete endpoints).
6. **Injury / DNP list** per game: ESPN's `didNotPlay` and `reason` fields are already in the box score data.
7. **Web app manifest + icon** so the home-screen app gets a proper icon and opens without browser chrome.
8. **Pull-to-refresh** and an "updated X min ago" indicator.

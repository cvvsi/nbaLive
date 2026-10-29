# 9-Cat Box

A phone-first NBA box score viewer for **9-category fantasy basketball**. It ranks every player who played on a given night by how much they helped across the 9 cats, in the spirit of Basketball Monster's box scores, so a 30-point night on 9-for-25 shooting with 6 turnovers doesn't look better than it was.

**Live site:** https://cvvsi.github.io/nbaLive/ (added to the phone home screen)

---

## What it does

- Loads every game for a date (US Eastern) and ranks all players who played by **Value**.
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

## Season / 30 / 14 / 7-day ranks

Each row shows the player's 9-cat rank over the season and the last 30, 14 and 7 days, so a big night from someone outside the top 100 stands out as a possible pickup. Ranks 1–100 are green, 101–150 plain, and anything lower dimmed. Tapping the row shows the games and minutes behind each rank.

- **Built nightly** by `build-rankings.js`, run by `.github/workflows/rankings.yml` at 10:00 UTC. The script commits `data/rankings.json`, and that push redeploys Pages. Run it by hand from the Actions tab (*Rankings → Run workflow*) or locally with `node build-rankings.js`.
- **Math:** per-game averages over the window, z-scored against a top-156 pool (12 teams × 13). The pool is iterated so it settles on rosterable players, and only players with at least half the window's max games are eligible for it. FG%/FT% use the same impact formula as the box score. Regular season only.
- The JSON stores per-window z-scores, not ranks, so the page re-ranks with your punts applied.
- Finished box scores are cached in `.cache/games.json` (git-ignored; the Action keeps it with `actions/cache`), so each run only fetches new games.

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

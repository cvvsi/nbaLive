"""Find NBA.com's video for every fantasy play of a night, for the player page's play clips. Run on your
own PC: NBA.com answers home connections, not GitHub's or Cloudflare's servers (tested Nov 19, 2026).

    pip install nba_api
    python fetch-clips.py                 yesterday (US Eastern)
    python fetch-clips.py 2026-11-18      one date
    python fetch-clips.py --days 3        the last 3 dates
    then: git add data/clips && git commit -m "Clips" && git push

Writes data/clips/YYYY-MM-DD.json. Only play details and NBA.com's own video addresses, no video:
the page streams each clip from videos.nba.com (which plays on our site; NBA.com's play-by-play and
video lookup don't answer other sites, which is why this runs here).

    {"d": date, "built": time, "g": {"MIL@MIA": {"gid": "0022600260",
       "a": [[action number, period, clock seconds, team, "B. Adebayo", type, "assist by", video], ...]}}}

type is NBA.com's actionType (2pt, 3pt, freethrow, rebound, turnover, steal, block). video drops the
https://videos.nba.com/nba/pbp/media/ prefix when it has it. Plays NBA.com has no clip for are left out.
About 350 lookups a game, 6 at a time: a few minutes for a full night. Re-running a date only looks up
the plays still missing a clip (clips appear on NBA.com a few hours after a game).
"""
import json, os, re, sys, time, datetime
from concurrent.futures import ThreadPoolExecutor
import requests
from nba_api.stats.endpoints import scoreboardv2
from nba_api.live.nba.endpoints import playbyplay
from nba_api.stats.library.http import STATS_HEADERS

TYPES = {'2pt', '3pt', 'freethrow', 'rebound', 'turnover', 'steal', 'block'}
PFX = 'https://videos.nba.com/nba/pbp/media/'
OUT = 'data/clips'


def et_today():
    # US Eastern without a tz library: UTC-5 (good enough to pick "yesterday" outside DST edge hours)
    return (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).date()


def games(d):
    for attempt in range(4):
        try:
            gh = scoreboardv2.ScoreboardV2(game_date=d, timeout=60).get_dict()['resultSets'][0]
            ix = {h: i for i, h in enumerate(gh['headers'])}
            out = []
            for r in gh['rowSet']:
                code = r[ix['GAMECODE']]  # "20261118/MILMIA"
                m = re.match(r'\d{8}/([A-Z]{3})([A-Z]{3})', code or '')
                if m:
                    out.append((r[ix['GAME_ID']], m.group(1), m.group(2)))
            return out
        except Exception as e:
            print(f'  scoreboard retry {attempt + 1}: {type(e).__name__} {e}')
            time.sleep(5 * (attempt + 1))
    raise SystemExit('Gave up on the scoreboard for ' + d)


def clock(c):
    m = re.match(r'PT(\d+)M([\d.]+)S', c or '')
    return round(int(m.group(1)) * 60 + float(m.group(2)), 1) if m else None


S = requests.Session()
S.headers.update(STATS_HEADERS)


def video(gid, ev):
    u = f'https://stats.nba.com/stats/videoeventsasset?GameID={gid}&GameEventID={ev}'
    for attempt in range(4):
        try:
            r = S.get(u, timeout=30)
            if r.status_code == 200:
                v = ((r.json().get('resultSets') or {}).get('Meta') or {}).get('videoUrls') or [{}]
                url = v[0].get('lurl') or v[0].get('murl') or v[0].get('surl')
                if not url or 'missing.mp4' in url:
                    return None
                return url[len(PFX):] if url.startswith(PFX) else url
        except Exception:
            pass
        time.sleep(2 * (attempt + 1))
    return None


def night(d):
    path = f'{OUT}/{d}.json'
    old = {}
    if os.path.exists(path):
        with open(path) as f:
            old = json.load(f).get('g', {})
    out = {'d': d, 'built': datetime.datetime.now().isoformat(timespec='minutes'), 'g': {}}
    gs = games(d)
    print(f'{d}: {len(gs)} games')
    for gid, away, home in gs:
        key = f'{away}@{home}'
        try:
            acts = playbyplay.PlayByPlay(gid).get_dict()['game']['actions']
        except Exception as e:
            print(f'  {key}: no play-by-play yet ({type(e).__name__})')
            continue
        had = {a[0]: a[7] for a in (old.get(key) or {}).get('a', [])}
        rows = []
        for a in acts:
            ty = str(a.get('actionType') or '').lower()
            if ty not in TYPES or not a.get('personId') or not a.get('playerNameI'):
                continue
            rows.append([a['actionNumber'], a.get('period'), clock(a.get('clock')), a.get('teamTricode') or '',
                         a['playerNameI'], ty, a.get('assistPlayerNameInitial') or '', had.get(a['actionNumber'])])
        todo = [r for r in rows if not r[7]]
        t = time.time()
        with ThreadPoolExecutor(6) as ex:
            for r, v in zip(todo, ex.map(lambda r: video(gid, r[0]), todo)):
                r[7] = v
        keep = [r for r in rows if r[7]]
        print(f'  {key} {gid}: {len(keep)} of {len(rows)} plays have a clip ({len(todo)} looked up, {time.time() - t:.0f} s)')
        if keep:
            out['g'][key] = {'gid': gid, 'a': keep}
    if out['g']:
        os.makedirs(OUT, exist_ok=True)
        with open(path, 'w') as f:
            json.dump(out, f, separators=(',', ':'))
        print(f'  wrote {path}')


def main():
    args = sys.argv[1:]
    if '--days' in args:
        n = int(args[args.index('--days') + 1])
        dates = [(et_today() - datetime.timedelta(days=i)).isoformat() for i in range(n, 0, -1)]
    elif args and re.match(r'\d{4}-\d{2}-\d{2}$', args[0]):
        dates = [args[0]]
    else:
        dates = [(et_today() - datetime.timedelta(days=1)).isoformat()]
    for d in dates:
        night(d)


if __name__ == '__main__':
    main()

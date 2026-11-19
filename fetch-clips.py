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
from nba_api.stats.endpoints import scoreboardv3, playbyplayv3
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
            sb = scoreboardv3.ScoreboardV3(game_date=d, league_id='00', timeout=60).get_dict()
            gs = (sb.get('scoreboard') or {}).get('games') or []
            return [(g['gameId'], g['awayTeam']['teamTricode'], g['homeTeam']['teamTricode']) for g in gs]
        except Exception as e:
            print(f'  scoreboard retry {attempt + 1}: {type(e).__name__} {e}')
            time.sleep(5 * (attempt + 1))
    raise SystemExit('Gave up on the scoreboard for ' + d)


def plays_live(gid):
    """cdn.nba.com's live feed: steals and blocks are their own actions, assists named on the shot."""
    out = []
    for a in playbyplay.PlayByPlay(gid).get_dict()['game']['actions']:
        ty = str(a.get('actionType') or '').lower()
        if ty in TYPES and a.get('personId') and a.get('playerNameI'):
            out.append([a['actionNumber'], a.get('period'), clock(a.get('clock')), a.get('teamTricode') or '',
                        a['playerNameI'], ty, a.get('assistPlayerNameInitial') or '', None])
    return out


def plays_v3(gid):
    """stats.nba.com's play-by-play (same action numbers as the live feed). Its action types are words
    ("Made Shot", "Free Throw"...); steals and blocks are read from the description; the assist comes
    only as a last name ("(Herro 2 AST)"), turned back into "T. Herro" from his team's other plays."""
    acts = []
    for attempt in range(4):
        try:
            acts = playbyplayv3.PlayByPlayV3(game_id=gid, start_period=0, end_period=0, timeout=60).get_dict()['game']['actions']
            break
        except Exception as e:
            print(f'    v3 retry {attempt + 1}: {type(e).__name__} {e}')
            time.sleep(5 * (attempt + 1))
    names = {}
    for a in acts:
        if a.get('playerNameI') and a.get('playerName'):
            names[(a.get('teamTricode'), a['playerName'])] = a['playerNameI']
    out = []
    for a in acts:
        at, desc = str(a.get('actionType') or ''), str(a.get('description') or '')
        if not a.get('personId') or not a.get('playerNameI') or a.get('videoAvailable') == 0:
            continue
        if at in ('Made Shot', 'Missed Shot'):
            ty = '3pt' if a.get('shotValue') == 3 or '3PT' in desc else '2pt'
        elif at == 'Free Throw':
            ty = 'freethrow'
        elif at == 'Rebound':
            ty = 'rebound'
        elif at == 'Turnover':
            ty = 'turnover'
        elif re.search(r'\bSTEAL\b', desc):
            ty = 'steal'
        elif re.search(r'\bBLOCK\b', desc):
            ty = 'block'
        else:
            continue
        ast = ''
        m = re.search(r"\(([A-Za-z.'\- ]+?) \d+ AST\)", desc)
        if ty in ('2pt', '3pt') and m:
            ast = names.get((a.get('teamTricode'), m.group(1).strip()), '')
        out.append([a['actionNumber'], a.get('period'), clock(a.get('clock')), a.get('teamTricode') or '',
                    a['playerNameI'], ty, ast, None])
    return out


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
        rows, src = [], ''
        try:
            rows, src = plays_live(gid), 'live feed'
        except Exception as e:
            live_err = f'{type(e).__name__}'
        if not rows:
            rows, src = plays_v3(gid), 'stats play-by-play'
        if not rows:
            print(f'  {key}: no play-by-play yet')
            continue
        had = {a[0]: a[7] for a in (old.get(key) or {}).get('a', [])}
        for r in rows:
            r[7] = had.get(r[0])
        kinds = {}
        for r in rows:
            kinds[r[5]] = kinds.get(r[5], 0) + 1
        print(f'  {key}: {len(rows)} plays from the {src} ' + ' '.join(f'{k}:{v}' for k, v in sorted(kinds.items())))
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

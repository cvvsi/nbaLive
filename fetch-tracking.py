"""Pull NBA.com player tracking stats for the tracking backtest. Run on your own PC (NBA.com
doesn't answer GitHub's servers).

    pip install nba_api
    python fetch-tracking.py            history (3 test seasons + a baseline) and this season so far
    python fetch-tracking.py --current  this season so far only (refresh)

Writes data/tracking-history.json (or data/tracking-current.json with --current).

Per season: the opening weeks (through Nov 20) and the rest, as totals, so the backtest can ask
whether the opening weeks' tracking numbers (potential assists, touches, rebound chances,
drives) predict the rest of the season better than the box score alone. 2022-23 is the full
season, as the baseline for 2023-24. About 45 requests, 1.5 s apart: 2 to 3 minutes.
"""
import json, sys, time, datetime
from nba_api.stats.endpoints import leaguedashptstats

MEASURES = ['Passing', 'Possessions', 'Rebounding', 'Drives', 'CatchShoot', 'PullUpShot']
HIST = [
    ('2022-23', '', ''),
    ('2023-24', '10/01/2023', '11/20/2023'), ('2023-24', '11/21/2023', '04/30/2024'),
    ('2024-25', '10/01/2024', '11/20/2024'), ('2024-25', '11/21/2024', '04/30/2025'),
    ('2025-26', '10/01/2025', '11/20/2025'), ('2025-26', '11/21/2025', '04/30/2026'),
]
CURRENT = [('2026-27', '', '')]


def pull(season, d_from, d_to, measure):
    for attempt in range(4):
        try:
            ep = leaguedashptstats.LeagueDashPtStats(
                season=season, season_type_all_star='Regular Season', per_mode_simple='Totals',
                player_or_team='Player', pt_measure_type=measure,
                date_from_nullable=d_from, date_to_nullable=d_to, timeout=60)
            rs = ep.get_dict()['resultSets'][0]
            return {'headers': rs['headers'], 'rows': rs['rowSet']}
        except Exception as e:
            print(f'    retry {attempt + 1}: {type(e).__name__} {e}')
            time.sleep(5 * (attempt + 1))
    raise SystemExit(f'Gave up on {season} {d_from}-{d_to} {measure}')


def main():
    current = '--current' in sys.argv
    windows = CURRENT if current else HIST + CURRENT
    out = {'pulled': datetime.datetime.now().isoformat(timespec='minutes'), 'windows': []}
    n = len(windows) * len(MEASURES)
    i = 0
    for season, d_from, d_to in windows:
        for m in MEASURES:
            i += 1
            label = f'{season} {d_from or "start"} to {d_to or "end"} {m}'
            print(f'[{i}/{n}] {label}')
            t = pull(season, d_from, d_to, m)
            print(f'    {len(t["rows"])} players')
            out['windows'].append({'season': season, 'from': d_from, 'to': d_to, 'measure': m, **t})
            time.sleep(1.5)
    path = 'data/tracking-current.json' if current else 'data/tracking-history.json'
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'\nWrote {path}')


if __name__ == '__main__':
    main()

"""regression-raw.json -> data/baselines.json  (committed; the app reads it, never the site).

Column layout of the saved dashboards: 6 flat columns (Rk, Player, Team, Value, GP, MPG)
then 16 stat groups of 3 (prior, current, diff) = 54 cells.
"""
import datetime, glob, io, json, os, re

GROUPS = ['usg', 'fg_pct', 'fga36', 'p2_pct', 'p3_pct', 'p3ar', 'ft_pct', 'ftar',
          'fta36', 'pts36', 'p3_36', 'reb36', 'ast36', 'stl36', 'blk36', 'to36']
FLAT = ['rk', 'name', 'team', 'value', 'gp', 'mpg']
num = lambda t: None if t in ('', '-', '--') else float(t.replace('+', '').lstrip('.') and t.replace('+', '')) if re.match(r'^[+-]?\.?\d', t.replace('+', '')) else None


def f(t):
    """'+3.9' -> 3.9, '.465' -> 0.465, '' -> None"""
    t = (t or '').strip().replace('+', '').replace('−', '-')
    if t in ('', '-', '--', 'NaN'):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def rows_of(entry):
    out = {}
    for r in entry['rows']:
        c = r['cells']
        if len(c) < len(FLAT) + 3:
            continue
        rec = {
            'name': r['name'],
            'team': c[2],
            'cur_value': f(c[3]),      # current-season Value (what EFB computes)
            'cur_gp': int(f(c[4]) or 0),
            'cur_mpg': f(c[5]),
            'small': r['small'],
        }
        for i, g in enumerate(GROUPS):
            base = len(FLAT) + i * 3
            if base + 2 < len(c):
                rec['base_' + g] = f(c[base])
                rec['cur_' + g] = f(c[base + 1])
        # per-season GP/MPG straight from the tooltips
        seas = {}
        for k, v in r['seasons'].items():
            seas[k] = {kk: vv for kk, vv in v.items()}
        rec['seasons'] = seas
        out[r['name']] = rec
    return out


raw = json.load(io.open('regression-raw.json', encoding='utf-8'))
one = rows_of(raw['1y'])
two = rows_of(raw['2y'])

# Union of both exports. The two files are taken at different times, so one may
# cover teams the other misses - a team that hadn't yet played when an export was
# made simply isn't in that table. Prefer the 2-season blend where it exists and
# fall back to the single season, recording which was used per player.
players = {}
for name in sorted(set(two) | set(one)):
    r = two.get(name) or one[name]
    o = one.get(name, {})
    seasons = r.get('seasons', {}) or o.get('seasons', {})
    prior = {k: v for k, v in seasons.items() if k != '2026-27'}
    gp_total = sum(v.get('gp', 0) for v in prior.values())
    mpg_w = (sum(v.get('gp', 0) * v.get('mpg', 0) for v in prior.values()) / gp_total
             if gp_total else None)
    b2 = {g: (two.get(name) or {}).get('base_' + g) for g in GROUPS}
    b1 = {g: o.get('base_' + g) for g in GROUPS}
    players[name] = {
        'name': name,
        'team': r['team'],
        'prior_seasons': prior,
        'prior_gp': gp_total,
        'prior_mpg': round(mpg_w, 1) if mpg_w is not None else None,
        # 2-season GP-weighted (EFB's own blend) where available, else last season
        'base2y': b2 if any(v is not None for v in b2.values()) else b1,
        'base1y': b1,
        'baseSource': '2y' if any(v is not None for v in b2.values()) else '1y',
        'cur': {g: r.get('cur_' + g) for g in GROUPS},
        'cur_gp': r['cur_gp'],
        'cur_mpg': r['cur_mpg'],
        'cur_value': r['cur_value'],
        'small': r['small'],
    }

meta = {
    'source': 'Elite Fantasy Basketball regression dashboards (saved export)',
    # newest saved dashboard, so the file says when the data was actually taken
    'exported': max((datetime.date.fromtimestamp(os.path.getmtime(f)).isoformat()
                     for f in glob.glob(os.path.join('*_files', 'regression_dashboard*.htm'))),
                    default='unknown'),
    'players': len(players),
    'groups': GROUPS,
    'note': 'Baselines only. Nightly stats come from ESPN at runtime.',
    'teams': sorted({p['team'] for p in players.values()}),
}
io.open('data/baselines.json', 'w', encoding='utf-8').write(
    json.dumps({'meta': meta, 'players': players}, ensure_ascii=False, separators=(',', ':')))

print('players:', len(players))
src = {}
for p in players.values():
    src[p['baseSource']] = src.get(p['baseSource'], 0) + 1
print('baseline source:', src)
teams = sorted({p['team'] for p in players.values()})
print('teams:', len(teams), '->', ' '.join(teams))
mt = [n for n, p in players.items() if not p['prior_gp']]
print('no prior season (rookies):', len(mt))
print('median prior GP:', sorted(p['prior_gp'] for p in players.values())[len(players) // 2])
print('wrote data/baselines.json')

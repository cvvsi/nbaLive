"""regression-raw.json -> data/baselines.json  (committed; the app reads it, never the site).

Column layout of the saved dashboards: 6 flat columns (Rk, Player, Team, Value, GP, MPG)
then 16 stat groups of 3 (prior, current, diff) = 54 cells.
"""
import io, json, re

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

players = {}
for name, r in two.items():
    o = one.get(name, {})
    seasons = r.get('seasons', {})
    prior = {k: v for k, v in seasons.items() if k != '2026-27'}
    gp_total = sum(v.get('gp', 0) for v in prior.values())
    mpg_w = (sum(v.get('gp', 0) * v.get('mpg', 0) for v in prior.values()) / gp_total
             if gp_total else None)
    players[name] = {
        'name': name,
        'team': r['team'],
        'prior_seasons': prior,
        'prior_gp': gp_total,
        'prior_mpg': round(mpg_w, 1) if mpg_w is not None else None,
        # baseline per-36 / rate profile, 2-season GP-weighted (EFB's own blend)
        'base2y': {g: r.get('base_' + g) for g in GROUPS},
        # single prior season, for when last year is the more relevant context
        'base1y': {g: o.get('base_' + g) for g in GROUPS},
        'cur': {g: r.get('cur_' + g) for g in GROUPS},
        'cur_gp': r['cur_gp'],
        'cur_mpg': r['cur_mpg'],
        'cur_value': r['cur_value'],
        'small': r['small'],
    }

meta = {
    'source': 'Elite Fantasy Basketball regression dashboards (saved export)',
    'exported': '2026-10-22',
    'players': len(players),
    'groups': GROUPS,
    'note': 'Baselines only. Nightly stats come from ESPN at runtime.',
}
io.open('data/baselines.json', 'w', encoding='utf-8').write(
    json.dumps({'meta': meta, 'players': players}, ensure_ascii=False, separators=(',', ':')))

print('players:', len(players))
mt = [n for n, p in players.items() if not p['prior_gp']]
print('no prior GP:', len(mt), mt[:6])
print('median prior GP:', sorted(p['prior_gp'] for p in players.values())[len(players) // 2])
print('wrote data/baselines.json')

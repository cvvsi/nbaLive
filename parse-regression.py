"""Parse the saved Elite Fantasy Basketball regression dashboards into baselines.json.

The dashboards render a table whose title= attributes carry each season's GP and MPG,
which is what makes a GP-weighted baseline possible. Run once per saved export; the
output is committed so the app never has to touch elitefantasybasketball.com.
"""
import io, json, os, re, sys

# Saved filenames vary between exports ("Save Page As" adds a random suffix to the
# iframe, and the page titles themselves change), so discover the dashboards by
# content rather than by name: find every saved regression_dashboard iframe, then
# tell 1-season from 2-season apart by the header its table actually uses.
def discover():
    """Newest export wins: several saves of the same dashboard may be lying around."""
    import glob as g
    cands = []
    for d in g.glob('*_files'):
        for f in g.glob(os.path.join(d, 'regression_dashboard*.htm')):
            cands.append((os.path.getmtime(f), f))
    found = {}
    for _, f in sorted(cands, reverse=True):          # newest first
        head = io.open(f, encoding='utf-8', errors='replace').read(400000)
        kind = '2y' if '2-Yr' in head else ('1y' if re.search(r'>\s*2[45]-2[56]\s*<', head) else None)
        if kind:
            found.setdefault(kind, f)
    return found


SRC = discover()

strip = lambda h: re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', h)).strip()
unesc = lambda t: (t.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
                   .replace('&quot;', '"').replace('&#039;', "'").replace('&nbsp;', ' '))


def headers(s):
    th = re.search(r'<thead>(.*?)</thead>', s, re.S)
    if not th:
        return []
    out = []
    for r in re.findall(r'<tr[^>]*>(.*?)</tr>', th.group(1), re.S):
        out.append([strip(c) for c in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', r, re.S)])
    return out


def cells(tr):
    """Return (text, title, classes) per cell."""
    out = []
    for m in re.finditer(r'<t[hd]([^>]*)>(.*?)</t[hd]>', tr, re.S):
        attr, body = m.group(1), m.group(2)
        t = re.search(r'title="([^"]*)"', attr)
        c = re.search(r'class="([^"]*)"', attr)
        out.append((strip(body), unesc(t.group(1)) if t else '', c.group(1) if c else ''))
    return out


# "2025-26: 70 G, 31.9 MPG"  /  "2025-26: 693/1457 FG in 64 G"
RE_GMP = re.compile(r'([\d-]{4,7}):\s*(\d+)\s*G,\s*([\d.]+)\s*MPG')
RE_SHOT = re.compile(r'([\d-]{4,7}):\s*(\d+)/(\d+)\s*(FG|FT)\s*in\s*(\d+)\s*G')


def parse(path):
    s = io.open(path, encoding='utf-8', errors='replace').read()
    hs = headers(s)
    tb = re.search(r'<tbody>(.*?)</tbody>', s, re.S)
    if not tb:
        return hs, []
    rows = []
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', tb.group(1), re.S):
        cs = cells(tr)
        if len(cs) < 6:
            continue
        name = None
        a = re.search(r'player=([^"&]+)', tr)
        if a:
            from urllib.parse import unquote
            name = unquote(a.group(1))
        if not name:
            for txt, _, cl in cs:
                if 'c-player' in cl:
                    name = txt
                    break
        if not name:
            continue
        # seasons + GP/MPG from any title attribute on the row
        seasons = {}
        for _, ttl, _ in cs:
            for season, gp, mpg in RE_GMP.findall(ttl):
                seasons.setdefault(season, {})['gp'] = int(gp)
                seasons[season]['mpg'] = float(mpg)
            for season, m, a_, kind, gp in RE_SHOT.findall(ttl):
                d = seasons.setdefault(season, {})
                d['gp'] = int(gp)
                d[kind.lower() + 'm'] = int(m)
                d[kind.lower() + 'a'] = int(a_)
        small = any('Small sample' in t for _, t, _ in cs)
        rows.append({
            'name': name,
            'cells': [t for t, _, _ in cs],
            'classes': [c for _, _, c in cs],
            'seasons': seasons,
            'small': small,
        })
    return hs, rows


if __name__ == '__main__':
    out = {}
    missing = [k for k, v in SRC.items() if not v]
    if missing:
        print('ERROR: no saved dashboard found for: ' + ', '.join(missing))
        print('Save both Regression Dashboard pages into this folder and re-run.')
        raise SystemExit(1)
    for key, path in SRC.items():
        hs, rows = parse(path)
        print('=' * 72)
        print(key, path.split('/')[-1], '->', len(rows), 'rows')
        for h in hs:
            print('  hdr(%d): %s' % (len(h), h))
        if rows:
            r = rows[0]
            print('  row0 name :', r['name'])
            print('  row0 cells:', r['cells'])
            print('  row0 seas :', json.dumps(r['seasons']))
        out[key] = {'headers': hs, 'rows': rows}
    io.open('regression-raw.json', 'w', encoding='utf-8').write(
        json.dumps(out, indent=1, ensure_ascii=False))
    print('\nwrote regression-raw.json')

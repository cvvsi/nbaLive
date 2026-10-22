"""Build players-mock.html: tonight's regular-season Value vs each player's own baseline.

Why this shape and not a distribution view: as of Oct 22 2026 only two regular-season
slates have finished (Oct 20, Oct 21) and they share no teams, so every player has
played exactly ONE game. Median/best/spread and the sparkline all need several games
per player, so they'd be theater right now. What IS meaningful at 1 GP is the
comparison against a two-season baseline, which is what this shows.

Regenerate with:  node gather-rs.js && python build-mock.py
"""
import io, json, re, unicodedata

# ESPN name -> baseline name, for cases normalizing can't reach (nicknames).
ALIAS = {
    'Bub Carrington': 'Carlton Carrington',
    'Ace Bailey': 'Airious Bailey',
    'Alex Sarr': 'Alexandre Sarr',
    'Yang Hansen': 'Hansen Yang',
}


def norm(s):
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn').lower()
    s = re.sub(r'\b(jr|sr|ii|iii|iv|v)\b', '', s)
    return re.sub(r'[^a-z]', '', s)


games = json.load(io.open('rs-games.json', encoding='utf-8'))
base = json.load(io.open('data/baselines.json', encoding='utf-8'))
B = base['players']
bidx = {norm(n): n for n in B}

rows = []
for p in games['byPlayer'].values():
    g = p['g'][0]
    bname = p['name'] if p['name'] in B else ALIAS.get(p['name']) or bidx.get(norm(p['name']))
    b = B.get(bname) if bname else None
    prior_mpg = (b or {}).get('prior_mpg')
    busg = ((b or {}).get('base2y') or {}).get('usg')
    rows.append({
        'name': p['name'], 'team': p['team'], 'pos': p['pos'],
        'd': g['d'], 'opp': g['opp'], 'rank': g['rank'], 'slate': g['slate'],
        'value': g['value'], 'min': g['min'], 'usg': g['usg'], 'st': g['st'],
        # baseline: two-season GP-weighted, from the saved regression dashboard
        'bmpg': prior_mpg,
        'bgp': (b or {}).get('prior_gp') or 0,
        'busg': busg,
        'dmin': round(g['min'] - prior_mpg, 1) if prior_mpg else None,
        'dusg': round(g['usg'] - busg, 1) if busg else None,
        'matched': bool(b),
    })

# Minutes vs baseline MPG is the role signal, so that's the default sort.
rows.sort(key=lambda r: (r['dmin'] is None, -(r['dmin'] or 0)))

meta = {
    'slates': games['slates'],
    'exported': base['meta']['exported'],
    'players': len(rows),
    'matched': sum(1 for r in rows if r['matched']),
}

TPL = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f4f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121311" media="(prefers-color-scheme: dark)">
<title>Minutes Against Baseline</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
/* Tokens copied from index.html so this reads as the same product. --mid is the one
   addition: a baseline reference is neither good nor bad, so it must not take --pos/--neg. */
:root{
  --bg:#f4f5f2; --panel:#ffffff; --ink:#141613; --dim:#6b7069; --rule:#dfe2dc; --cell:#eceee9;
  --ball:#d9530f; --pos:#178a4c; --neg:#c9372c; --mid:#8a7f55;
  --name:"Archivo Narrow","Arial Narrow","Roboto Condensed",system-ui,sans-serif;
  --num:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --bar:48px; color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#121311; --panel:#1a1c19; --ink:#e9ebe6; --dim:#8a9087; --rule:#2a2d28; --cell:#232621;
  --ball:#f07a36; --pos:#3cc77d; --neg:#f2675b; --mid:#c0b183; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#121311; --panel:#1a1c19; --ink:#e9ebe6; --dim:#8a9087; --rule:#2a2d28; --cell:#232621;
  --ball:#f07a36; --pos:#3cc77d; --neg:#f2675b; --mid:#c0b183; color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:500 15px/1.35 var(--name);
  -webkit-text-size-adjust:100%;padding-bottom:env(safe-area-inset-bottom,0px)}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
:focus-visible{outline:2px solid var(--ball);outline-offset:2px}
.gut{padding-left:max(14px,env(safe-area-inset-left,0px));padding-right:max(14px,env(safe-area-inset-right,0px))}

.bar{position:sticky;top:0;z-index:10;height:var(--bar);background:var(--panel);
  border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:8px}
.mark{font:700 15px/1 var(--name);letter-spacing:.04em;text-transform:uppercase;
  display:flex;align-items:center;gap:6px}
.mark i{width:10px;height:10px;border-radius:50%;background:var(--ball);display:block}
.mark em{font-style:normal;color:var(--dim);font-weight:500}

.note{background:var(--panel);border-bottom:1px solid var(--rule);padding-block:10px 12px}
.note p{margin:0;font-size:12.5px;line-height:1.45;color:var(--dim);max-width:62ch}
.note p+p{margin-top:6px}
.note b{color:var(--ink)}

.ruler{position:sticky;top:var(--bar);z-index:9;background:var(--bg);
  border-bottom:1px solid var(--rule);padding-block:7px}
.rulerin{display:flex;align-items:center;gap:8px;font:500 11px/1 var(--num);color:var(--dim);
  text-transform:uppercase;letter-spacing:.04em}
.sorts{margin-left:auto;display:flex;gap:2px}
.sorts button{font:600 12px/1 var(--name);letter-spacing:.05em;padding:6px 7px;border-radius:4px;color:var(--dim)}
.sorts button[aria-pressed="true"]{color:var(--ink);background:var(--cell)}

/* row: minutes-vs-baseline bar | identity | value */
.p{border-bottom:1px solid var(--rule);padding-block:9px 10px;display:grid;
  grid-template-columns:62px 1fr auto;column-gap:10px;align-items:center}

/* Diverging bar read from a center line: right = more minutes than his own baseline. */
.delta{width:62px}
.dbar{height:30px;display:block;overflow:visible}
.dbar .axis{stroke:var(--rule);stroke-width:1}
.dbar .up{fill:var(--pos)}
.dbar .dn{fill:var(--neg)}
.dbar .na{fill:var(--dim);opacity:.3}
.dnum{font:600 11px/1 var(--num);text-align:center;display:block;margin-top:1px;font-variant-numeric:tabular-nums}
.dnum.up{color:var(--pos)}
.dnum.dn{color:var(--neg)}
.dnum.na{color:var(--dim);font-family:var(--name);font-size:10px}

.id{min-width:0;display:flex;flex-direction:column;gap:2px}
.id b{font:600 15.5px/1.15 var(--name);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.id .sub{font:500 11.5px/1.25 var(--name);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.id .sub .s{color:var(--ink);font-weight:700}
.base{font:500 11px/1.25 var(--num);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.base u{text-decoration:none;font-family:var(--name);letter-spacing:.04em}

.val{text-align:right;min-width:52px}
.val .v{font:600 17px/1 var(--num);display:block;font-variant-numeric:tabular-nums}
.val .r{font:500 10px/1.3 var(--name);color:var(--dim);display:block;margin-top:2px;
  text-transform:uppercase;letter-spacing:.07em}

.foot{padding-block:16px 28px;font:500 12px/1.5 var(--name);color:var(--dim);max-width:62ch}
@media (min-width:720px){main,.inner{max-width:760px;margin-inline:auto}}
</style>
</head>
<body>
<div class="bar gut"><div class="mark"><i></i>9-Cat <em>/ vs Baseline</em></div></div>

<div class="note gut"><div class="inner">
<p><b>Opening week, 1 game each.</b> Only two regular-season slates have finished &mdash; Oct 20 and Oct 21 &mdash; and they share no teams, so <b>every player below has played exactly one game</b>. Median, ceiling and spread need several games each, so they aren&rsquo;t here yet. This is what one game honestly supports.</p>
<p>The bar is <b>minutes against that player&rsquo;s own two-season baseline</b> &mdash; right of the line means he played more than his history says. That&rsquo;s the role signal: a career 18-minute player who just played 31 is worth a look whatever his Value was. Baselines come from your saved regression dashboard, read from a committed file.</p>
</div></div>

<div class="ruler gut"><div class="inner"><div class="rulerin"><span id="count"></span>
  <div class="sorts">
    <button data-k="dmin" aria-pressed="true">&Delta;Min</button><button data-k="value" aria-pressed="false">Value</button><button data-k="min" aria-pressed="false">Min</button><button data-k="dusg" aria-pressed="false">&Delta;Usg</button>
  </div></div></div></div>

<main class="gut" id="list"></main>
<div class="foot gut"><div class="inner" id="foot"></div></div>

<script>
var ROWS=__ROWS__, META=__META__;
var MINUS="−";
function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function sgn(v,d){return (v>0?"+":v<0?MINUS:"")+Math.abs(v).toFixed(d)}

/* Fixed +/-20 min scale so bars are comparable between rows; beyond that clamps. */
function dbar(dm){
  var W=62,H=30,cx=W/2,SC=20,h=11,y=(H-h)/2;
  var s='<svg class="dbar" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">';
  if(dm===null){
    s+='<rect class="na" x="'+(cx-7)+'" y="'+(y+4)+'" width="14" height="3" rx="1.5"/>';
    s+='<line class="axis" x1="'+cx+'" y1="3" x2="'+cx+'" y2="'+(H-3)+'"/>';
    return s+'</svg>';
  }
  var w=Math.min(Math.abs(dm)/SC,1)*(W/2-2);
  if(w<1.2)w=1.2;
  s+='<rect class="'+(dm>=0?"up":"dn")+'" x="'+(dm>=0?cx:cx-w).toFixed(1)+'" y="'+y
     +'" width="'+w.toFixed(1)+'" height="'+h+'" rx="1.5"/>';
  s+='<line class="axis" x1="'+cx+'" y1="3" x2="'+cx+'" y2="'+(H-3)+'"/>';
  return s+'</svg>';
}

function row(r){
  var cls=r.dmin===null?"na":(r.dmin>=0?"up":"dn");
  var dtxt=r.dmin===null?"no base":sgn(r.dmin,0)+"m";
  var basetxt=r.bmpg===null
    ? '<u>no prior season</u>'
    : '<u>base</u> '+r.bmpg.toFixed(1)+'m'+(r.busg!==null?' · '+r.busg.toFixed(0)+'% usg':'')
      +' <u>over</u> '+r.bgp+'g';
  return '<article class="p">'
    +'<div class="delta">'+dbar(r.dmin)+'<span class="dnum '+cls+'">'+dtxt+'</span></div>'
    +'<div class="id"><b>'+esc(r.name)+'</b>'
      +'<span class="sub">'+r.team+' vs '+r.opp+' · '+esc(r.pos)+' · '+r.min+'m · '
        +r.usg.toFixed(0)+'% usg'+(r.st?' · <span class="s">S</span>':'')+'</span>'
      +'<span class="base">'+basetxt+'</span>'
    +'</div>'
    +'<div class="val"><span class="v" style="color:'
      +(Math.abs(r.value)<0.5?'var(--ink)':(r.value>0?'var(--pos)':'var(--neg)'))+'">'
      +sgn(r.value,2)+'</span><span class="r">RK'+r.rank+'</span></div>'
  +'</article>';
}

var sortK="dmin";
function draw(){
  var rs=ROWS.slice().sort(function(a,b){
    var x=a[sortK],y=b[sortK];
    if(x===null&&y===null)return 0;
    if(x===null)return 1;
    if(y===null)return -1;
    return y-x});
  document.getElementById("list").innerHTML=rs.map(row).join("");
  document.getElementById("count").textContent=rs.length+" players · 1 game each";
}
document.getElementById("foot").textContent=
  META.players+' players across '+META.slates.length+' slates ('
  +META.slates.map(function(s){return s.games+'g'}).join(' + ')+'). '
  +META.matched+' matched to a baseline; the rest are rookies or had no prior season. '
  +'Baselines exported '+META.exported+'. Value and rank are computed per night against '
  +'that night’s pool, so the two dates are ranked separately.';
Array.prototype.forEach.call(document.querySelectorAll(".sorts button"),function(b){
  b.onclick=function(){
    Array.prototype.forEach.call(b.parentNode.children,function(x){x.setAttribute("aria-pressed","false")});
    b.setAttribute("aria-pressed","true");sortK=b.dataset.k;draw()}});
draw();
</script>
</body>
</html>
'''

out = (TPL.replace('__ROWS__', json.dumps(rows, separators=(',', ':')))
          .replace('__META__', json.dumps(meta, separators=(',', ':'))))
io.open('players-mock.html', 'w', encoding='utf-8', newline='\n').write(out)
print('wrote players-mock.html', len(out), 'bytes')
print('rows', len(rows), '| matched', meta['matched'])
print('\ntop minutes gains vs own baseline:')
for r in [x for x in rows if x['dmin'] is not None][:10]:
    print('  %-22s %+6.1f  (played %2d vs base %4.1f over %3dg)  val %+0.2f  RK%d' % (
        r['name'], r['dmin'], r['min'], r['bmpg'], r['bgp'], r['value'], r['rank']))

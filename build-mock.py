"""One-off: build players-mock.html with the real 13-slate sample embedded."""
import io, json

data = json.load(io.open('mockdata.json', encoding='utf-8'))

TPL = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f4f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121311" media="(prefers-color-scheme: dark)">
<title>9-Cat Players Mock</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
/* MOCK of a Players (range) view. Tokens copied from index.html so this reads as the
   same product. --mid is the one addition: the RK130 roster threshold is neither good
   nor bad, so it must not borrow --pos/--neg. */
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
body{background:var(--bg);color:var(--ink);font:500 15px/1.35 var(--name);-webkit-text-size-adjust:100%;
  padding-bottom:env(safe-area-inset-bottom,0px)}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
:focus-visible{outline:2px solid var(--ball);outline-offset:2px}
.gut{padding-left:max(14px,env(safe-area-inset-left,0px));padding-right:max(14px,env(safe-area-inset-right,0px))}

.bar{position:sticky;top:0;z-index:10;height:var(--bar);background:var(--panel);
  border-bottom:1px solid var(--rule);display:flex;align-items:center;gap:8px}
.mark{font:700 15px/1 var(--name);letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;gap:6px}
.mark i{width:10px;height:10px;border-radius:50%;background:var(--ball);display:block}
.mark em{font-style:normal;color:var(--dim);font-weight:500}
.seg{margin-left:auto;display:inline-flex;border:1px solid var(--rule);border-radius:6px;overflow:hidden}
.seg button{font:600 12px/1 var(--name);padding:8px 10px}
.seg button+button{border-left:1px solid var(--rule)}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--panel)}

.note{background:var(--panel);border-bottom:1px solid var(--rule);padding-block:10px 12px}
.note p{margin:0;font-size:13px;color:var(--dim);max-width:62ch}
.note b{color:var(--ink)}

.ruler{position:sticky;top:var(--bar);z-index:9;background:var(--bg);border-bottom:1px solid var(--rule);padding-block:7px}
.rulerin{display:flex;align-items:center;gap:8px;font:500 11px/1 var(--num);color:var(--dim);
  text-transform:uppercase;letter-spacing:.04em}
.sorts{margin-left:auto;display:flex;gap:2px}
.sorts button{font:600 12px/1 var(--name);letter-spacing:.05em;padding:6px 7px;border-radius:4px;color:var(--dim)}
.sorts button[aria-pressed="true"]{color:var(--ink);background:var(--cell)}

/* player row: sparkline | identity + figures | what the ceiling game looked like */
.p{border-bottom:1px solid var(--rule);padding-block:10px 11px;cursor:pointer;display:grid;
  grid-template-columns:54px 1fr auto;column-gap:10px;align-items:start}
.p:active{opacity:.85}

.spark{width:54px;height:40px;display:block;overflow:visible}
.spark .thr{stroke:var(--mid);stroke-width:1;stroke-dasharray:2 2;opacity:.85}
.spark .ln{fill:none;stroke:var(--dim);stroke-width:1.25;opacity:.85}
.spark .dot{fill:var(--dim);opacity:.7}
.spark .dot.hi{fill:var(--ball);opacity:1}
.spark .dot.last{fill:var(--ink);opacity:1}

.id{min-width:0}
.id b{font:600 16px/1.15 var(--name);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.id .sub{font:500 12px/1.3 var(--name);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.figs{display:flex;align-items:baseline;gap:12px;margin-top:5px}
.fig{display:flex;flex-direction:column;gap:1px}
.fig .k{font:600 9px/1 var(--name);text-transform:uppercase;letter-spacing:.09em;color:var(--dim)}
.fig .v{font:600 15px/1 var(--num);font-variant-numeric:tabular-nums}
.fig .v small{font:500 10px/1 var(--num);color:var(--dim);margin-left:2px}
.fig.best .v{color:var(--ball)}
.hits{font:500 11px/1.2 var(--num);color:var(--dim);margin-top:5px}
.hits b{color:var(--ink);font-weight:600}

.flash{text-align:right;min-width:60px}
.flash .k{font:600 9px/1 var(--name);text-transform:uppercase;letter-spacing:.09em;color:var(--dim);display:block}
.flash .m{font:600 15px/1.1 var(--num);display:block;margin-top:3px;font-variant-numeric:tabular-nums}
.flash .r{font:500 10px/1.3 var(--name);display:block;margin-top:1px;color:var(--dim)}
.flash .r.start{color:var(--pos);font-weight:600}

.log{display:none;grid-column:1/-1;margin-top:10px;border-top:1px solid var(--rule);padding-top:9px;overflow-x:auto}
.p.open .log{display:block}
.log table{width:100%;border-collapse:collapse;font:500 12px/1 var(--num)}
.log th{font:600 9px/1 var(--name);text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
  text-align:right;padding:0 0 6px;white-space:nowrap}
.log th:first-child,.log td:first-child{text-align:left}
.log td{padding:5px 0;border-top:1px solid var(--rule);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.log td small{color:var(--dim)}
.log tr.hi td{color:var(--ball)}
.log tr.hi td small{color:var(--ball);opacity:.7}
.log .st{color:var(--pos);font-weight:600}
.log .cap{margin:7px 0 0;font:500 11px/1.4 var(--name);color:var(--dim);max-width:52ch}

@media (min-width:720px){main,.inner{max-width:760px;margin-inline:auto}}
</style>
</head>
<body>
<div class="bar gut"><div class="mark"><i></i>9-Cat <em>/ Players</em></div>
  <div class="seg"><button aria-pressed="false">L7</button><button aria-pressed="true">L14</button><button aria-pressed="false">Season</button></div>
</div>

<div class="note gut"><div class="inner"><p><b>Mock, real data.</b> 13 slates, Oct 6&ndash;21 2026 &mdash; 312 players with 4+ games, 12 shown. Median and best are kept apart on purpose: an average hides the flash. The sparkline plots each night as a percentile of that night&rsquo;s slate, newest at right, so a 2-game Thursday can&rsquo;t fake a top-10 finish. Dotted line is roster depth (RK130 in a 10&times;13).</p></div></div>

<div class="ruler gut"><div class="inner"><div class="rulerin"><span>12 of 312</span>
  <div class="sorts">
    <button aria-pressed="true">Best</button><button aria-pressed="false">Median</button><button aria-pressed="false">T50</button><button aria-pressed="false">Min</button>
  </div></div></div></div>

<main class="gut" id="list"></main>

<script>
var DATA=__DATA__;
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var MINUS="−", DASH="–";

/* A night's finish as a share of that night's slate: RK4 of 138 beats RK4 of 341. */
function pctOf(g){return g.rank/g.slate}

function spark(p){
  var W=54,H=40,n=p.g.length;
  /* y=0 is the top (RK1), bottom is last in the slate. Full scale, so no night gets
     flattened against the floor and the RK130 line lands mid-box where it belongs. */
  var MAXP=1;
  var y=function(v){return Math.min(H-3,Math.max(3,(Math.min(v,MAXP)/MAXP)*(H-6)+3))};
  var x=function(i){return n===1?W/2:3+(i*(W-6))/(n-1)};
  var pts=p.g.map(function(g,i){return [x(i),y(pctOf(g))]});
  var bi=0;
  p.g.forEach(function(g,i){if(pctOf(g)<pctOf(p.g[bi]))bi=i});
  var thrY=y(130/250);
  var s='<svg class="spark" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">';
  s+='<line class="thr" x1="0" y1="'+thrY.toFixed(1)+'" x2="'+W+'" y2="'+thrY.toFixed(1)+'"/>';
  s+='<polyline class="ln" points="'+pts.map(function(q){return q[0].toFixed(1)+","+q[1].toFixed(1)}).join(" ")+'"/>';
  pts.forEach(function(q,i){
    var cls=i===bi?"dot hi":(i===n-1?"dot last":"dot");
    s+='<circle class="'+cls+'" cx="'+q[0].toFixed(1)+'" cy="'+q[1].toFixed(1)+'" r="'+(i===bi?2.3:1.6)+'"/>'});
  return s+'</svg>';
}

function sgn(v,d){return (v>0?"+":v<0?MINUS:"")+Math.abs(v).toFixed(d)}

function row(p){
  var best=p.g.reduce(function(a,b){return b.rank<a.rank?b:a});
  var log=p.g.slice().reverse().map(function(g){
    return '<tr class="'+(g.rank===best.rank?"hi":"")+'">'
      +'<td>'+g.d.slice(0,2)+'/'+g.d.slice(2)+'</td>'
      +'<td>RK'+g.rank+'<small>/'+g.slate+'</small></td>'
      +'<td>'+sgn(g.value,2)+'</td>'
      +'<td>'+g.min+'</td><td>'+g.usg.toFixed(0)+'%</td>'
      +'<td>'+(g.st?'<span class="st">S</span>':DASH)+'</td></tr>'}).join("");
  return '<article class="p">'
    +spark(p)
    +'<div class="id">'
      +'<b>'+esc(p.name)+'</b>'
      +'<span class="sub">'+p.team+' &middot; '+esc(p.pos)+' &middot; '+p.n+' g &middot; '
        +p.starts+'/'+p.n+' start'+(p.starts===1?"":"s")+'</span>'
      +'<div class="figs">'
        +'<span class="fig"><span class="k">median</span><span class="v">RK'+p.medR
          +'<small>'+sgn(p.medV,2)+'</small></span></span>'
        +'<span class="fig best"><span class="k">best</span><span class="v">RK'+p.bestR
          +'<small>'+sgn(p.bestV,2)+'</small></span></span>'
      +'</div>'
      +'<div class="hits"><b>'+p.top50+'</b>/'+p.n+' top-50 &middot; <b>'+p.top130+'</b>/'+p.n+' top-130</div>'
    +'</div>'
    +'<div class="flash"><span class="k">at best</span>'
      +'<span class="m">'+best.min+'m</span>'
      +'<span class="r '+(best.st?"start":"")+'">'+(best.st?"started":"bench")+'</span>'
      +'<span class="r">'+best.usg.toFixed(0)+'% usg</span>'
    +'</div>'
    +'<div class="log"><table><thead><tr><th>date</th><th>rank</th><th>value</th><th>min</th><th>usg</th><th>st</th></tr></thead>'
      +'<tbody>'+log+'</tbody></table>'
      +'<p class="cap">Newest first. Ceiling night in orange &mdash; check its minutes and start before trusting the flash.</p>'
    +'</div>'
  +'</article>';
}

var list=document.getElementById("list");
list.innerHTML=DATA.map(row).join("");
list.onclick=function(e){var a=e.target.closest(".p");if(a)a.classList.toggle("open")};
Array.prototype.forEach.call(document.querySelectorAll(".seg button,.sorts button"),function(b){
  b.onclick=function(){
    Array.prototype.forEach.call(b.parentNode.children,function(x){x.setAttribute("aria-pressed","false")});
    b.setAttribute("aria-pressed","true")}});
</script>
</body>
</html>
'''

out = TPL.replace('__DATA__', json.dumps(data, separators=(',', ':')))
io.open('players-mock.html', 'w', encoding='utf-8', newline='\n').write(out)
print('wrote players-mock.html', len(out), 'bytes')

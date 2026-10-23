"""Build recap.html - the slate context as a page, so the filter can be judged by eye.

The point is the threshold slider: I don't know where the cutoff belongs, and the
whole question is which setting produces a list worth reading. Everything shown here
is computed, no LLM.
"""
import io, json

data = json.load(io.open('recap-data.json', encoding='utf-8'))

TPL = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f4f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121311" media="(prefers-color-scheme: dark)">
<title>Slate Recap Review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
/* Tokens from index.html so this reads as the same product. */
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
body{background:var(--bg);color:var(--ink);font:500 15px/1.4 var(--name);
  -webkit-text-size-adjust:100%;padding-bottom:env(safe-area-inset-bottom,0px)}
button,a{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
:focus-visible{outline:2px solid var(--ball);outline-offset:2px}
.gut{padding-left:max(14px,env(safe-area-inset-left,0px));padding-right:max(14px,env(safe-area-inset-right,0px))}
.inner{max-width:780px;margin-inline:auto}

.bar{position:sticky;top:0;z-index:10;background:var(--panel);border-bottom:1px solid var(--rule);
  height:var(--bar);display:flex;align-items:center;gap:8px}
.mark{font:700 15px/1 var(--name);letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;gap:6px}
.mark i{width:10px;height:10px;border-radius:50%;background:var(--ball);display:block}
.mark em{font-style:normal;color:var(--dim);font-weight:500}

h2{font:700 12px/1 var(--name);text-transform:uppercase;letter-spacing:.1em;color:var(--dim);
  margin:0 0 10px}
.note{background:var(--panel);border-bottom:1px solid var(--rule);padding-block:11px 13px}
.note p{margin:0;font-size:13px;color:var(--dim);max-width:66ch}
.note p+p{margin-top:7px}
.note b{color:var(--ink)}

/* threshold control - the actual question this page asks */
.ctl{background:var(--panel);border-bottom:1px solid var(--rule);padding-block:13px 15px}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.row label{font:600 10px/1 var(--name);text-transform:uppercase;letter-spacing:.09em;color:var(--dim)}
input[type=range]{flex:1;min-width:150px;accent-color:var(--ball)}
.val{font:600 17px/1 var(--num);min-width:52px;font-variant-numeric:tabular-nums}
.count{font:500 13px/1.3 var(--num);color:var(--dim);margin-top:9px}
.count b{color:var(--ink);font-weight:600;font-size:15px}
.chk{display:inline-flex;align-items:center;gap:6px;font:500 13px/1 var(--name);color:var(--ink)}
.preset{display:inline-flex;border:1px solid var(--rule);border-radius:6px;overflow:hidden;margin-top:10px}
.preset button{font:600 12px/1 var(--name);padding:7px 10px}
.preset button+button{border-left:1px solid var(--rule)}
.preset button[aria-pressed="true"]{background:var(--ink);color:var(--panel)}

section{padding-block:16px}
section+section{border-top:1px solid var(--rule)}

/* a notable player */
.p{border-bottom:1px solid var(--rule);padding-block:11px 12px}
.ph{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ph b{font:600 16px/1.15 var(--name)}
.ph .tm{font:500 11.5px/1 var(--num);color:var(--dim)}
.ph .dm{font:600 13px/1 var(--num);margin-left:auto;font-variant-numeric:tabular-nums}
.ph .dm.up{color:var(--pos)}
.ph .dm.dn{color:var(--neg)}
.facts{display:flex;gap:11px;flex-wrap:wrap;margin-top:6px;font:500 12px/1.35 var(--num);color:var(--dim)}
.facts b{color:var(--ink);font-weight:600}
.why{margin-top:6px;font:500 12px/1.4 var(--name);color:var(--mid)}
.log{margin-top:7px;display:flex;flex-direction:column;gap:3px}
.lg{font:500 11.5px/1.3 var(--num);color:var(--dim);display:flex;gap:8px;flex-wrap:wrap}
.lg .d{color:var(--ink);font-weight:600;min-width:38px}
.lg .st{color:var(--pos);font-weight:600}
.inj{margin-top:7px;font:500 12px/1.4 var(--name);color:var(--ink);
  background:color-mix(in oklab,var(--ball) 9%,var(--panel));border-radius:4px;padding:6px 8px}
.inj u{text-decoration:none;color:var(--dim);font-size:10px;text-transform:uppercase;
  letter-spacing:.08em;display:block;margin-bottom:2px}

/* games */
.g{border-bottom:1px solid var(--rule);padding-block:10px 11px}
.gh{display:flex;align-items:baseline;gap:8px;font:500 12.5px/1.2 var(--num)}
.gh .t{font-family:var(--name);font-weight:600;font-size:14px}
.gh .sc{color:var(--dim)}
.gh .bo{font:600 9px/1 var(--name);text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
  border:1px solid var(--rule);border-radius:3px;padding:3px 4px}
.gh .dt{margin-left:auto;color:var(--dim);font-size:11px}
.hl{margin-top:5px;font:600 13.5px/1.35 var(--name)}
.rc{margin-top:5px;font:500 12.5px/1.5 var(--name);color:var(--dim);max-width:70ch}
.rc.clip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.more{font:600 11px/1 var(--name);text-transform:uppercase;letter-spacing:.07em;color:var(--ball);margin-top:5px}
.foot{padding-block:18px 34px;font:500 11.5px/1.55 var(--name);color:var(--dim);max-width:68ch}
</style>
</head>
<body>
<div class="bar gut"><div class="mark"><i></i>9-Cat <em>/ Recap Review</em></div></div>

<div class="note gut"><div class="inner">
<p><b>No AI here.</b> Everything below is computed from the box scores, your two-season baselines, and ESPN's injury feed &mdash; this is the raw material a written recap would be built from. The question is whether it's good enough to be worth generating one.</p>
<p><b>Move the slider.</b> I don't know where the cutoff belongs. At the loose end you get 85 players, which is unreadable; tight gives about 10. For reference, the analyst you follow picked <b>3</b> players out of the Oct 21 slate &mdash; Moussa Diabate, Dennis Schroder, and Grayson Allen.</p>
</div></div>

<div class="ctl gut"><div class="inner">
  <div class="row">
    <label for="th">Min. minutes above baseline</label>
    <input type="range" id="th" min="0" max="14" step="0.5" value="8">
    <span class="val" id="thv">+8</span>
  </div>
  <div class="row" style="margin-top:10px">
    <span class="chk"><input type="checkbox" id="pos" checked> Only players who also produced (Value &gt; 0)</span>
  </div>
  <div class="preset" id="preset">
    <button data-t="8" data-p="1">Tight</button><button data-t="6" data-p="1">Medium</button><button data-t="6" data-p="0">Loose</button><button data-t="0" data-p="0">Everything</button>
  </div>
  <div class="count" id="count"></div>
</div></div>

<main>
<section class="gut"><div class="inner">
  <h2>Role changes &mdash; the shortlist</h2>
  <div id="list"></div>
</div></section>

<section class="gut"><div class="inner">
  <h2>Games &mdash; with ESPN's own recap</h2>
  <div id="games"></div>
</div></section>

<div class="gut"><div class="inner foot" id="foot"></div></div>
</main>

<script>
var D=__DATA__;
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var MINUS="−";
function sgn(v,d){return (v>0?"+":v<0?MINUS:"")+Math.abs(v).toFixed(d)}
function fdate(s){return s.slice(4,6).replace(/^0/,"")+"/"+s.slice(6)}

/* injuries on a player's own team, so "when X comes back" is visible next to him */
var injByTeam={};
D.injuries.forEach(function(i){(injByTeam[i.team]||(injByTeam[i.team]=[])).push(i)});

function playerCard(p){
  var cls=p.dMinAvg==null?"":(p.dMinAvg>=0?"up":"dn");
  var dm=p.dMinAvg==null?"n/a":sgn(p.dMinAvg,1)+"m";
  var b=p.base||{};
  var mates=(injByTeam[p.team]||[]).filter(function(i){return i.status!=="Day-To-Day"||i.returnDate});
  var inj=mates.length
    ? '<div class="inj"><u>'+esc(p.team)+' players out &mdash; his minutes may not hold</u>'
      +mates.slice(0,4).map(function(i){
        return esc(i.name)+' ('+esc(i.status)+(i.returnDate?', back '+i.returnDate:'')+')';
      }).join(' &middot; ')+'</div>'
    : '';
  return '<div class="p">'
    +'<div class="ph"><b>'+esc(p.name)+'</b>'
      +'<span class="tm">'+esc(p.team)+(p.pos?' &middot; '+esc(p.pos):'')+' &middot; '+p.games+'g</span>'
      +'<span class="dm '+cls+'">'+dm+' vs base</span></div>'
    +'<div class="facts">'
      +'<span><b>'+p.avgMin.toFixed(0)+'</b> min/g <span style="opacity:.7">(base '
        +(b.mpg!=null?b.mpg.toFixed(1):"?")+' over '+(b.gp||0)+'g)</span></span>'
      +'<span><b>'+sgn(p.avgValue,2)+'</b> value/g</span>'
      +'<span>best <b>RK'+p.bestRank+'</b></span>'
      +'<span><b>'+p.avgUsg.toFixed(0)+'%</b> usg</span>'
      +'<span>'+p.starts+'/'+p.games+' starts</span>'
    +'</div>'
    +'<div class="why">'+esc(p.why.join(' · '))+'</div>'
    +'<div class="log">'+p.log.map(function(g){
        return '<span class="lg"><span class="d">'+fdate(g.date)+'</span>'
          +'<span>'+(g.starter?'vs':'vs')+' '+esc(g.opp)+'</span>'
          +'<span>RK'+g.rank+'/'+g.of+'</span>'
          +'<span>'+g.min+'m</span>'
          +'<span>'+g.usg.toFixed(0)+'% usg</span>'
          +'<span>'+sgn(g.value,2)+'</span>'
          +(g.starter?'<span class="st">START</span>':'')+'</span>';
      }).join('')+'</div>'
    +inj
  +'</div>';
}

function draw(){
  var th=+document.getElementById("th").value;
  var onlyPos=document.getElementById("pos").checked;
  document.getElementById("thv").textContent=(th>0?"+":"")+th;
  var rows=D.notable.filter(function(p){
    if(p.dMinAvg==null)return th<=0;
    if(p.dMinAvg<th)return false;
    if(onlyPos&&p.avgValue<=0)return false;
    return true;
  });
  document.getElementById("count").innerHTML=
    '<b>'+rows.length+'</b> of '+D.notable.length+' flagged players shown'
    +' &middot; '+D.meta.games+' games, '+D.meta.players+' player-games'
    +' &middot; analyst picked 3';
  document.getElementById("list").innerHTML=rows.length
    ? rows.map(playerCard).join("")
    : '<p style="color:var(--dim);font-size:13px">Nothing at this threshold.</p>';
  Array.prototype.forEach.call(document.querySelectorAll("#preset button"),function(b){
    b.setAttribute("aria-pressed", +b.dataset.t===th && (b.dataset.p==="1")===onlyPos);
  });
}

document.getElementById("games").innerHTML=D.games.map(function(g){
  return '<div class="g">'
    +'<div class="gh"><span class="t">'+esc(g.away)+' @ '+esc(g.home)+'</span>'
      +'<span class="sc">'+esc(g.score)+'</span>'
      +(g.blowout?'<span class="bo">blowout</span>':'')
      +'<span class="dt">'+fdate(g.date)+'</span></div>'
    +(g.espnHeadline?'<div class="hl">'+esc(g.espnHeadline)+'</div>':'')
    +(g.espnRecap?'<div class="rc clip" data-full="1">'+esc(g.espnRecap)+'</div>'
      +'<div class="more">Read more</div>':'')
  +'</div>';
}).join("");
document.getElementById("games").onclick=function(e){
  var m=e.target.closest(".more"); if(!m)return;
  var rc=m.previousElementSibling;
  var clipped=rc.classList.toggle("clip");
  m.textContent=clipped?"Read more":"Show less";
};

document.getElementById("foot").innerHTML=
  'Baselines: '+D.meta.matchedToBaseline+'/'+D.meta.players+' player-games matched, exported '
  +D.meta.exported+'. Value is the mean of 9 category z-scores against that night\'s 10+ minute '
  +'pool, so each date is ranked against its own slate. '
  +'<b>What this can\'t see:</b> the analyst\'s third pick, Grayson Allen, is absent at every '
  +'threshold — he played 29 minutes against a 26.2 baseline and finished RK41, so nothing '
  +'about his line is unusual. He was a pick-up because guards who help in points, assists and '
  +'FT% are scarce on waivers, which needs league ownership data this tool doesn\'t have.';

document.getElementById("th").oninput=draw;
document.getElementById("pos").onchange=draw;
Array.prototype.forEach.call(document.querySelectorAll("#preset button"),function(b){
  b.onclick=function(){
    document.getElementById("th").value=b.dataset.t;
    document.getElementById("pos").checked=b.dataset.p==="1";
    draw();
  };
});
draw();
</script>
</body>
</html>
'''

out = TPL.replace('__DATA__', json.dumps(data, separators=(',', ':')))
io.open('recap.html', 'w', encoding='utf-8', newline='\n').write(out)
print('wrote recap.html', round(len(out) / 1024, 1), 'KB')
print('notable:', len(data['notable']), '| games:', len(data['games']), '| injuries:', len(data['injuries']))

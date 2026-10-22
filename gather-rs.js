const API="https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const CATS=["pts","tpm","reb","ast","stl","blk","fg","ft","to"];
const split=s=>{const[m,a]=String(s||"0-0").split("-").map(Number);return[m||0,a||0]};
const sum=(a,k)=>a.reduce((s,p)=>s+p[k],0);
const J=async u=>(await fetch(u)).json();
function parse(ev,j){
  const out=[];
  for(const t of (j.boxscore&&j.boxscore.players)||[]){
    const abbr=t.team.abbreviation,opp=abbr===ev.home?ev.away:ev.home;
    const st=t.statistics[0];if(!st)continue;
    const ix=n=>st.keys.indexOf(n);
    const I={min:ix("minutes"),pts:ix("points"),fg:ix("fieldGoalsMade-fieldGoalsAttempted"),
      tp:ix("threePointFieldGoalsMade-threePointFieldGoalsAttempted"),ft:ix("freeThrowsMade-freeThrowsAttempted"),
      reb:ix("rebounds"),ast:ix("assists"),to:ix("turnovers"),stl:ix("steals"),blk:ix("blocks")};
    const rows=[];
    for(const a of st.athletes){
      if(a.didNotPlay||!a.stats||!a.stats.length)continue;
      const s=a.stats,min=parseFloat(s[I.min])||0;if(min<=0)continue;
      const[fgm,fga]=split(s[I.fg]),[tpm]=split(s[I.tp]),[ftm,fta]=split(s[I.ft]);
      rows.push({id:String(a.athlete.id||a.athlete.displayName),name:a.athlete.displayName,
        pos:(a.athlete.position||{}).abbreviation||"",team:abbr,opp,starter:!!a.starter,min,
        pts:+s[I.pts]||0,reb:+s[I.reb]||0,ast:+s[I.ast]||0,stl:+s[I.stl]||0,blk:+s[I.blk]||0,
        to:+s[I.to]||0,fgm,fga,tpm,ftm,fta});
    }
    const T=rows.reduce((o,r)=>(o.min+=r.min,o.fga+=r.fga,o.fta+=r.fta,o.to+=r.to,o),{min:0,fga:0,fta:0,to:0});
    for(const r of rows){const tp=T.fga+.44*T.fta+T.to;
      r.usg=tp&&r.min?100*((r.fga+.44*r.fta+r.to)*(T.min/5))/(r.min*tp):0}
    out.push(...rows);
  }
  return out;
}
function computeDay(P){
  const pool=P.filter(p=>p.min>=10),base=pool.length>=10?pool:P;
  const lgFG=sum(base,"fgm")/Math.max(1,sum(base,"fga")),lgFT=sum(base,"ftm")/Math.max(1,sum(base,"fta"));
  for(const p of P){p.fgi=p.fgm-lgFG*p.fga;p.fti=p.ftm-lgFT*p.fta}
  const src={pts:"pts",tpm:"tpm",reb:"reb",ast:"ast",stl:"stl",blk:"blk",fg:"fgi",ft:"fti",to:"to"};
  for(const c of CATS){const k=src[c],m=sum(base,k)/base.length;
    const sd=Math.sqrt(base.reduce((a,p)=>a+(p[k]-m)**2,0)/base.length)||1;
    for(const p of P)(p.z||(p.z={}))[c]=(c==="to"?-1:1)*(p[k]-m)/sd}
  for(const p of P)p.value=CATS.reduce((a,c)=>a+p.z[c],0)/9;
  [...P].sort((a,b)=>b.value-a.value).forEach((p,i)=>p.rank=i+1);
  return P;
}
(async()=>{
  const byPlayer={},slates=[];
  for(const d of ['20261020','20261021']){
    const sb=await J(`${API}/scoreboard?dates=${d}`);
    const evs=(sb.events||[]).filter(e=>(e.season&&e.season.slug)==='regular-season'
      && e.status.type.state==='post').map(e=>{const c=e.competitions[0],
      h=c.competitors.find(x=>x.homeAway==="home"),a=c.competitors.find(x=>x.homeAway==="away");
      return{id:e.id,home:h.team.abbreviation,away:a.team.abbreviation}});
    const P=[];
    for(const ev of evs){P.push(...parse(ev,await J(`${API}/summary?event=${ev.id}`)))}
    computeDay(P);
    slates.push({date:d,games:evs.length,players:P.length});
    for(const p of P){(byPlayer[p.id]||(byPlayer[p.id]={name:p.name,team:p.team,pos:p.pos,g:[]}))
      .g.push({d:d.slice(4),rank:p.rank,slate:P.length,games:evs.length,value:+p.value.toFixed(3),
        min:Math.round(p.min),usg:+p.usg.toFixed(1),st:p.starter,opp:p.opp})}
    process.stderr.write(`${d}: ${evs.length}g ${P.length}p\n`);
  }
  require('fs').writeFileSync('rs-games.json',JSON.stringify({slates,byPlayer}));
  const n=Object.keys(byPlayer).length;
  const two=Object.values(byPlayer).filter(p=>p.g.length>1).length;
  console.log('players:',n,'| played both nights:',two);
})();

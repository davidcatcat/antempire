/**
 * Read-only experiment viewer; never imports the formal ecology/day engine.
 * All poses and events come from the Node-generated native physics replay.
 */
import { Application, Graphics, Container, Text } from 'pixi.js';
const $=id=>document.getElementById(id);
const data=await fetch(import.meta.env.BASE_URL+'replays/compare.json').then(r=>{if(!r.ok)throw Error('先執行 npm run verify');return r.json()});
if(data.official!==false || data.schema!=='antempire.experimental.rapier-pixi-witness.v1')throw Error('拒絕不明實驗資料');
const sel=$('scenario'),time=$('time'),clock=$('clock'),play=$('play'),speed=$('speed'),stats=$('stats'),events=$('events'),status=$('status');
for(const sc of data.scenarios){const o=document.createElement('option');o.value=sc.id;o.textContent=sc.label;sel.appendChild(o)}
const app=new Application();
await app.init({width:960,height:360,backgroundColor:0x223831,antialias:true,preference:'webgl'});
$('stage').appendChild(app.canvas);
const world=new Container();world.position.set(48,190);world.scale.set(8.4);app.stage.addChild(world);
let sc=null,avatars=new Map(),playing=true,t=0;
function at(ivs,x) {
 const i=ivs.find(q=>x>=q.t_start_s-1e-10&&x<q.t_end_s-1e-10)??(x<ivs[0].t_start_s?ivs[0]:ivs.at(-1));
 const d=i.t_end_s-i.t_start_s, f=d>0?Math.max(0,Math.min(1,(x-i.t_start_s)/d)):1;
 return i.s_start_mm+(i.s_end_mm-i.s_start_mm)*f;
}
function addWall(poly) {const g=new Graphics();g.poly(poly.flatMap(p=>p));g.fill({color:0x61736d,alpha:0.95});g.stroke({color:0xa6b8a2,width:.12});world.addChild(g)}
function open(sc1){
 sc=sc1;t=0;time.value='0';world.removeChildren();avatars.clear();
 world.addChild(new Graphics().rect(0,-2,100,4).fill(0x475447));
 for(const o of sc.geometry.obstacles){if(o.shape.type==='polygon')addWall(o.shape.points_mm)}
 for(const ant of sc.agents){
  const group=new Container();
  const c=ant.id==='W1'?0xf0b878:0x91dadd;
  group.addChild(new Graphics().ellipse(0,0,ant.body.length_mm/2,ant.body.width_mm/2).fill(c));
  const dot=new Graphics().circle(ant.dir*ant.body.length_mm*.32,0,.14).fill(0x1a2023);group.addChild(dot);
  const a=new Text({text:ant.id,style:{fontFamily:'system-ui',fontSize:1.35,fill:0xf3f9eb}});
  a.anchor.set(.5);a.position.set(0,-2.5);group.addChild(a);
  world.addChild(group);avatars.set(ant.id,group);
 }
 const comp=sc.comparison;
 stats.textContent='AntEmpire vs Rapier 2D\n'+
  'AntEmpire 接觸事件：'+sc.events.filter(e=>e.kind==='contact_start').length+'；原生排斥檢查錯誤：'+comp.native_exclusion_violations+'\n'+
  'Rapier 觸角可及區域重疊取樣：'+comp.rapier.antenna_proximity_frames+' 格\n'+
  'Rapier 身體重疊取樣：'+comp.rapier.body_overlap_frames+' 格；身體／牆重疊：'+comp.rapier.wall_overlap_pairs+' 格\n'+
  '取樣間隔：'+comp.rapier.sample_dt_s.toFixed(6)+' 秒；兩側不等價（Rapier 只是 2D 感測器，非完整替代求解器）。';
 status.textContent='實驗來源：'+sc.geometry.world_id+'。速度沿用本種實驗候選值；接觸、讓路以非本種文獻與假設區分。';
 paint();
}
function paint(){
 for(const [id,g] of avatars)g.position.set(at(sc.intervals[id],t),0);
 clock.textContent=t.toFixed(2)+' 秒';
 const recent=sc.events.filter(e=>e.t_s<=t).slice(-7).map(e=>e.t_s.toFixed(3)+'s | '+e.kind+' | '+e.agent+(e.other?' / '+e.other:''));
 events.textContent='已發生的原生物理事件（不會創造新事件）：\n'+(recent.join('\n')||'尚無事件');
}
sel.onchange=()=>open(data.scenarios.find(s=>s.id===sel.value));
time.oninput=()=>{t=Number(time.value);paint()};
play.onclick=()=>{playing=!playing;play.textContent=playing?'暫停':'播放'};
app.ticker.add(ticker=>{
 if(!playing)return;
 t+=ticker.deltaMS*Number(speed.value)/1000;
 if(t>sc.horizon_s)t=0;
 time.value=String(t);paint();
});
open(data.scenarios[0]);

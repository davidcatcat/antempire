'use strict';
/** No-God-mode regression. Diagnostic only: never writes main/world saves. */
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {simulateDay}=require('./day_engine.cjs');
const load=n=>JSON.parse(fs.readFileSync(`${__dirname}/${n}`,'utf8'));
const initial=load('day14-projection.json'),p=load('params.json');
const clone=structuredClone;
let checks=0;
const ok=(condition,why)=>{assert.ok(condition,why);checks++};
const denied=fn=>{assert.throws(fn,/NO_GOD_MODE/);checks++};
const supportedTypes=new Set(['new_food_source','source_batch_consumed','food_delivered','insect_immigration','insect_natural_death','physical_scout_visit','discovery','scouted_empty','nest_local_route_learning','local_recruitment','hatch','pupation','eclosion','egg_laid','worker_death','brood_death','injury_recovery','queen_death']);
const withOverride=clone(initial);withOverride.force_food={site:'N00',sugar:100};denied(()=>simulateDay(withOverride,p));
const withDrama=clone(initial);withDrama.make_sure_queen_survives=true;denied(()=>simulateDay(withDrama,p));
const withForcedDeath=clone(initial);withForcedDeath.target_worker_death='W007';denied(()=>simulateDay(withForcedDeath,p));
const injectEvents=clone(initial);injectEvents.events=[{type:'meteor_revival'}];denied(()=>simulateDay(injectEvents,p));
denied(()=>simulateDay(initial,p,{giveFood:true}));
const sameButStarving=clone(initial);sameButStarving.colony.sugar=0;sameButStarving.colony.protein=0;
const x=simulateDay(initial,p),y=simulateDay(sameButStarving,p);
ok(JSON.stringify(x.summary.tasks)===JSON.stringify(y.summary.tasks),'same prior feeding encounters and RNG must choose same tasks, even when hidden global stock is different');
ok(JSON.stringify(initial)===JSON.stringify(load('day14-projection.json')),'no state input mutation');
ok(JSON.stringify(x)===JSON.stringify(simulateDay(initial,p)),'fixed-seed replay exact');
// A physically empty source population cannot produce a carcass from thin air.
const voidState=clone(initial);for(const loc of ['F07','F11']){voidState.ecology.insects_by_site[loc].living=0;voidState.sources[loc].batches=[];voidState.sources[loc].protein=0;}
const noMigration=clone(p);noMigration.sources.insect_background_immigration_probability.value=0;voidState.ecology.adjacent_garden_living_insects=0;
const z=simulateDay(voidState,noMigration);
ok(z.events.every(e=>e.type!=='new_food_source'&&e.type!=='insect_natural_death'),'zero living insects and zero immigration => no new carcass');
let state=initial,insectDeaths=0,carcasses=0,workerDeaths=0,scouts=0;
for(let i=0;i<30;i++){
 const before=state,out=simulateDay(state,p);const after=out.state;
 const immigrants=out.events.filter(e=>e.type==='insect_immigration').reduce((n,e)=>n+e.individuals,0);
 ok(before.ecology.adjacent_garden_living_insects-immigrants===after.ecology.adjacent_garden_living_insects,'finite adjacent garden living insect reserve must decrease on immigration');
 ok(out.events.every(e=>supportedTypes.has(e.type)),'no supernatural or unspecified event types Day'+out.day);
 for(const loc of ['F07','F11']){
  const arrivals=out.events.filter(e=>e.type==='insect_immigration'&&e.site===loc).reduce((n,e)=>n+e.individuals,0);
  const deaths=out.events.filter(e=>e.type==='insect_natural_death'&&e.site===loc);
  const pre=before.ecology.insects_by_site[loc],post=after.ecology.insects_by_site[loc];
  ok(pre.living+arrivals-deaths.length===post.living,'local insect population conservation '+loc+' Day'+out.day);
  for(const d of deaths){
   const body=out.events.find(e=>e.type==='new_food_source'&&e.id===d.event_id&&e.site===loc);
   ok(body&&body.caused_by_event_id===d.event_id,'each carcass has causal insect death '+d.event_id);
   ok(after.sources[loc].batches.some(b=>b.event_id===d.event_id),'each corpse in persistent source inventory '+d.event_id);
  }
  insectDeaths+=deaths.length;
 }
 const created=out.events.filter(e=>e.type==='new_food_source');
 carcasses+=created.length;
 ok(created.length===out.events.filter(e=>e.type==='insect_natural_death').length,'no unconditional new food Day'+out.day);
 for(const d of out.events.filter(e=>e.type==='worker_death'))ok(before.population.workers.some(w=>w.id===d.id),'only previously alive ants can die');
 for(const v of out.events.filter(e=>e.type==='physical_scout_visit')){
  scouts++;ok(typeof v.via==='string'&&v.via.length>0,'a scout must physically traverse a known neighbor');
 }
 workerDeaths+=out.summary.worker_deaths;
 state=after;
}
// Isolated scout reachability proof: the targeted ant is NOT told where hidden food is.
// A high search rate is used only inside this QA fixture, never in the actual game.
const scoutFixture=clone(initial),searchSettings=clone(p);
for(const worker of scoutFixture.population.workers){worker.known_sources=[];worker.age_days=20;}
scoutFixture.population.workers[0].known_sources=['U01'];
searchSettings.workers.scout_discovery_probability.value=1;
searchSettings.workers.forage_baseline_probability.value=1000;
const forcedSearchTrial=simulateDay(scoutFixture,searchSettings);
const found=forcedSearchTrial.events.filter(e=>e.type==='physical_scout_visit');
ok(found.every(e=>e.site==='F10'&&e.via==='U01'),'scouting can visit ONLY locally reachable F10 via U01, not remote F04/F05');
ok(found.length>=1,'scout must actually traverse known neighbor under the high-search QA fixture');
ok(insectDeaths===carcasses,'background food originates from distinct natural deaths');
console.log(JSON.stringify({passed:checks,days:30,events_natural_only:true,seeded_replay:true,no_direct_interventions:true,insectDeaths,carcasses,workerDeaths,physicalScoutingEvents:scouts,canonical_save_changed:false},null,2));

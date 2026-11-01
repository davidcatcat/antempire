"use strict";
/** AntEmpire v2 proposal, effective Day15. All numeric knobs in params.json are GAME ASSUMPTIONS.
 * No GitHub/clock access; deterministic pure one-day transition. Node 18+. No dependencies. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const ENGINE_VERSION = 'antempire.v2-review.2-naturalism';
const clone=x=>structuredClone(x), round=x=>Math.round((x+Number.EPSILON)*1e6)/1e6;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
function P(p,path){let v=p;for(const segment of path.split('.')){v=v?.[segment]}if(!v||v.assumption!==true||typeof v.value!=='number'||!Number.isFinite(v.value))throw Error('Missing/untagged assumption parameter '+path);return v.value;}
function hash32(text){const h=crypto.createHash('sha256').update(text).digest();return h.readUInt32LE(0);}
function rng(seed){let x=seed>>>0;return()=>{x=(x+0x6d2b79f5)|0;let t=Math.imul(x^(x>>>15),1|x);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};}
function dice(s,tag){return rng(hash32(`${s.seed}|${s.sim_day+1}|${tag}`));}
function normal(g){return Math.sqrt(-2*Math.log(Math.max(1e-12,g())))*Math.cos(2*Math.PI*g());}
function gamma(shape,scale,g){let d=shape-1/3,c=1/Math.sqrt(9*d);for(let k=0;k<10000;k++){let x=normal(g),v=1+c*x;if(v<=0)continue;v=v*v*v;let u=g();if(u<1-.0331*x**4||Math.log(u)<.5*x*x+d*(1-v+Math.log(v)))return d*v*scale;}throw Error('Gamma sampling failed');}
function monthDays(y,m){return new Date(Date.UTC(y,m,0)).getUTCDate();}
function monthInterp(rows,y,m,day,key){let a,b,n;if(day>=15){a=rows[m-1][key];b=rows[m%12][key];n=(day-15)/monthDays(y,m);}else{const prev=m===1?12:m-1;a=rows[prev-1][key];b=rows[m-1][key];n=(monthDays(m===1?y-1:y,prev)-15+day)/monthDays(m===1?y-1:y,prev);}return a+(b-a)*n;}
function rainPriors(s,p){const rows=s.climate.monthly;let weights=rows.map((x,i)=>Math.pow(x.mean_monthly_precipitation_mm/monthDays(2025,i+1),.6));let lo=0,hi=100;for(let i=0;i<70;i++){let mid=(lo+hi)/2,n=weights.reduce((sum,w,i)=>sum+monthDays(2025,i+1)*Math.min(.85,mid*w),0);if(n<P(p,'climate.annual_rain_days'))lo=mid;else hi=mid;}return weights.map(w=>Math.min(.85,(lo+hi)/2*w));}
function calcWeather(s,p,date){let [y,m,day]=date.split('-').map(Number),rows=s.climate.monthly;let prior=rainPriors(s,p),rainProb=monthInterp(rows.map((x,i)=>({...x,prior:prior[i]})),y,m,day,'prior');let cw=P(p,'climate.wet_persistence');let pWet=s.climate.prior_wet?rainProb+cw*(1-rainProb):rainProb*(1-cw);const g=dice(s,'weather');let wet=g()<pWet;
 let tempMean=monthInterp(rows,y,m,day,'mean_air_temperature_c');let anomaly=round(P(p,'climate.temperature_ar')*s.climate.temp_anomaly_c+P(p,'climate.temperature_daily_sigma_c')*normal(g));let airTemp=round(tempMean+anomaly-.8*(Number(wet)-rainProb));let rh=round(clamp(monthInterp(rows,y,m,day,'mean_relative_humidity_percent')+(wet?5:-2)+.45*anomaly,0,100));let rainMean=monthInterp(rows,y,m,day,'mean_monthly_precipitation_mm')/monthDays(y,m)/Math.max(.001,rainProb);let rain=wet?round(gamma(P(p,'climate.rainfall_gamma_shape'),rainMean/P(p,'climate.rainfall_gamma_shape'),g)):0;
 let soil=round(clamp(s.climate.soil_index*P(p,'climate.soil_persistence')+rain*P(p,'climate.soil_rain_gain_per_mm')-P(p,'climate.soil_daily_loss'),0,1));let shade=round(clamp(s.climate.shade_index*P(p,'climate.soil_shade_persistence')+rain*P(p,'climate.soil_shade_rain_gain_per_mm')-P(p,'climate.soil_shade_daily_loss'),0,1));
 let nestTemp=round((s.climate.prior_nest_temp_c??s.climate.prior_air_temp_c)*P(p,'climate.nest_temp_memory')+airTemp*(1-P(p,'climate.nest_temp_memory')));
 return {day:s.sim_day+1,date,kind:'synthetic_climatology_game_assumption_not_real_weather',wet,air_temp_c:airTemp,nest_temp_model_c:nestTemp,relative_humidity_model_percent:rh,rain_mm:rain,soil_index:soil,shade_index:shade,temperature_anomaly_c:anomaly,rain_probability_model:round(pWet)};
}
function sourceSum(src){if(src.type==='carcass')return round(src.batches.reduce((t,x)=>t+x.protein,0));return src.sugar;}
function syncSource(src){if(src.type==='carcass'){src.protein=sourceSum(src);}else src.protein=0;src.sugar=round(src.sugar||0);}
function growSources(s,p,weather,events){
 let g=dice(s,'ecology');
 for(const [id,src] of Object.entries(s.sources)){
  if(src.type==='carcass'){
   let frac=clamp(P(p,'sources.carcass_daily_decay_fraction')+weather.rain_mm*P(p,'sources.carcass_rain_decay_bonus'),0,.95);
   for(const batch of src.batches){batch.age_days=(s.sim_day+1)-batch.original_day;batch.protein=batch.age_days>P(p,'sources.carcass_max_lifetime_days')?0:round(batch.protein*(1-frac));}
   // Preserve provenance/history in snapshot even if edible protein nearly zero.
   syncSource(src);
  }else{
   const flowering=src.type!=='nectar'||src.bloom_days_left>0;
   let washoff=weather.rain_mm*P(p,src.type==='nectar'?'sources.nectar_washoff_per_rain_mm':'sources.honeydew_washoff_per_rain_mm');
   if(!flowering||src.host_alive===false){src.sugar=round(src.sugar*(1-clamp(.4+washoff,0,1)));}
   else src.sugar=round(clamp(src.sugar*(1-clamp(washoff,0,.9))+(src.production_per_day||0),0,src.capacity));
   if(src.type==='nectar')src.bloom_days_left=Math.max(0,src.bloom_days_left-1);
   syncSource(src);
  }
 }
 // No omnipotent food drops. A corpse exists ONLY if a previously tracked living insect dies.
 // New living insects can enter through the garden boundary, but that immigration is its own
 // provenance event, independent of the ants' hunger or desired storyline.
 for(const site of Object.keys(s.ecology.insects_by_site).sort()){
  const pop=s.ecology.insects_by_site[site];
  if(s.ecology.adjacent_garden_living_insects>0 && g()<P(p,'sources.insect_background_immigration_probability') && pop.living<P(p,'sources.insect_local_carrying_capacity')){
   s.ecology.adjacent_garden_living_insects-=1;pop.living+=1;events.push({type:'insect_immigration',site,from:'adjacent_garden_habitat',individuals:1,adjacent_population_after:s.ecology.adjacent_garden_living_insects,causal_basis:'physical transfer from an already counted neighboring population; assumed probability',assumption:true});
  }
  if(pop.living>0 && g()<P(p,'sources.insect_local_daily_mortality_probability')){
   const before=pop.living;pop.living-=1;pop.cumulative_deaths+=1;
   const quantity=round(P(p,'sources.carcass_new_protein_min')+g()*(P(p,'sources.carcass_new_protein_max')-P(p,'sources.carcass_new_protein_min')));
   const id=`NAT-D${s.sim_day+1}-${site}-${pop.cumulative_deaths}`;
   s.sources[site].batches.push({event_id:id,original_day:s.sim_day+1,protein:quantity,age_days:0,origin:'tracked local insect mortality; game unit conversion assumption',insect_population_before:before,insect_population_after:pop.living});
   syncSource(s.sources[site]);
   events.push({type:'insect_natural_death',site,event_id:id,insect_count_before:before,insect_count_after:pop.living,causal_basis:'background insect mortality from already-present local population; simulated'});
   events.push({type:'new_food_source',id,site,protein_portions:quantity,caused_by_event_id:id,causal_basis:'physical insect body after natural mortality',assumption:true});
  }
 }
}
function selectTask(worker,s,p,nurseDemand,shortage,weather){
 let g=dice(s,'task:'+worker.id),age=worker.age_days;
 let injured=worker.injured?.75:1,young=age<P(p,'workers.newborn_nurse_days');
 const forageBias=P(p,'workers.forage_baseline_probability')*(1+.9*shortage)*injured*(young?.08:1)*clamp(1-weather.rain_mm*P(p,'workers.rain_suppression_fraction'),P(p,'workers.min_rain_activity_multiplier'),1);
 const care=P(p,'workers.nurse_baseline_probability')*(1+nurseDemand/10)*(young?3:1),rest=P(p,'workers.rest_baseline_probability')*(worker.injured?1.5:1),repair=P(p,'workers.maintenance_baseline_probability')*(1+.8*weather.soil_index),guard=P(p,'workers.defence_baseline_probability');
 let entries=[['forage',forageBias],['nurse',care],['rest',rest],['repair',repair],['guard',guard]],total=entries.reduce((x,a)=>x+a[1],0),roll=g()*total;
 for(const [task,weight] of entries){roll-=weight;if(roll<=0)return task;}return 'rest';
}
function discover(worker,s,p,events){let g=dice(s,'scout:'+worker.id);let choices=Object.values(s.sources).filter(x=>x.presence==='potential'&&!worker.known_sources.includes(x.id)&&Array.isArray(x.access_from)&&x.access_from.some(node=>worker.known_sources.includes(node))); // locally reachable, no distant-target omniscience
 if(choices.length===0)return null;
 const target=choices[Math.floor(g()*choices.length)];if(g()>=P(p,'workers.scout_discovery_probability'))return null;
 // No entire-world omniscience: discovering a potential site can reveal it is empty.
 worker.known_sources.push(target.id);if(!target.known_by.includes(worker.id))target.known_by.push(worker.id);events.push({type:'physical_scout_visit',worker:worker.id,site:target.id,via:target.access_from.find(node=>worker.known_sources.includes(node)),causal_basis:'walk along personally known neighboring route'});
 if(target.host_alive===true){target.presence='confirmed_game_scenario';events.push({type:'discovery',worker:worker.id,site:target.id,food_kind:target.type,assumption:true});}else{target.presence='scouted_empty';events.push({type:'scouted_empty',worker:worker.id,site:target.id,assumption:true});}
 return target.id;
}
function collect(source,worker,s,p,weather,events,summary){
 let g=dice(s,`collect:${worker.id}:${source.id}`);let rainMult=clamp(1-weather.rain_mm*P(p,'workers.rain_suppression_fraction'),P(p,'workers.min_rain_activity_multiplier'),1);
 if(source.presence==='scouted_empty'||source.presence==='potential'||sourceSum(source)<=1e-5||g()>rainMult*(source.type==='carcass'?P(p,'sources.carcass_access_probability'):.85))return 0;
 const macro=source.type==='carcass'?'protein':'sugar',min=P(p,`sources.crop_load_${macro}_min`),max=P(p,`sources.crop_load_${macro}_max`),load=round(Math.min(sourceSum(source),min+(max-min)*g()));if(load<=0)return 0;
 if(macro==='sugar')source.sugar=round(source.sugar-load);
 else{
   let needed=load;for(const batch of source.batches){let take=Math.min(batch.protein,needed);batch.protein=round(batch.protein-take);needed=round(needed-take);if(take>0)events.push({type:'source_batch_consumed',source_event_id:batch.event_id,location:source.id,worker:worker.id,quantity_portions:round(take)});if(needed<=1e-6)break;}syncSource(source);
 }
 summary.income[macro]=round(summary.income[macro]+load);summary.foraging_successes++;events.push({type:'food_delivered',site:source.id,worker:worker.id,macro,portions:load,unique_receipt_id:`D${s.sim_day+1}-${worker.id}-${summary.foraging_successes}`});
 s.colony[macro]=round(s.colony[macro]+load);return load;
}
function forage(s,p,weather,events,summary){
 const shortage=1-Math.min(s.colony.local_cues.last_sugar_feeding_fraction,s.colony.local_cues.last_protein_feeding_fraction); // lagged feeding encounters only; no exact stock access
 const nurses=s.population.brood.filter(b=>b.stage==='larva').length;
 // Knowledge travels through actual colony-local contacts, not world-global knowledge.
 // Each old worker starts the day in N00; one receiver/teacher pair can exchange one known route.
 const knowers=s.population.workers.filter(w=>w.known_sources.length>0);
 for(const receiver of s.population.workers){let g=dice(s,'nest_contact:'+receiver.id);
  if(g()<P(p,'workers.nest_contact_route_learning_probability')&&knowers.length){
   const teacher=knowers[Math.floor(g()*knowers.length)];if(teacher.id===receiver.id)continue;
   let teacherSites=teacher.known_sources.filter(id=>s.sources[id]&&!receiver.known_sources.includes(id));if(teacherSites.length){
    const id=teacherSites[Math.floor(g()*teacherSites.length)];receiver.known_sources.push(id);if(!s.sources[id].known_by.includes(receiver.id))s.sources[id].known_by.push(receiver.id);
    events.push({type:'nest_local_route_learning',from:teacher.id,to:receiver.id,site:id,assumption:true});
   }
  }
 }
 let foragers=[];for(const w of s.population.workers){w.task=selectTask(w,s,p,nurses,shortage,weather);w.age_days+=1;summary.tasks[w.task]=(summary.tasks[w.task]||0)+1;if(w.task==='forage')foragers.push(w);}
 const recruited=[];
 for(let j=0;j<foragers.length;j++){
  const worker=foragers[j];let g=dice(s,'target:'+worker.id);let known=worker.known_sources.map(x=>s.sources[x]).filter(x=>x&&x.presence!=='scouted_empty');
  if(known.length===0){const scouted=discover(worker,s,p,events);if(scouted)known=worker.known_sources.map(x=>s.sources[x]).filter(x=>x&&x.presence!=='scouted_empty');}
  if(known.length===0){summary.scouts++;continue;}
  // Local knowledge and nutritional need influence source selection.
  let proteinNeed=s.colony.local_cues.last_protein_feeding_fraction<.95 || nurses>3; // locally perceived brood requests / feeding encounters
  let rank=known.map(x=>({source:x,score:((worker.site_memory?.[x.id]?.last_success_portions??.25)+.12)*(proteinNeed?(x.type==='carcass'?P(p,'workers.protein_source_choice_bias'):.3):(x.type==='carcass'?.6:1.5))})).sort((a,b)=>b.score-a.score); // no inspection of distant source actual stock
  let site=rank[Math.floor(g()*Math.min(rank.length,2))].source;summary.foraging_trips++;summary.extra_sugar_cost=round(summary.extra_sugar_cost+P(p,'workers.foraging_trip_sugar_cost'));
  const delivered=collect(site,worker,s,p,weather,events,summary);
  worker.site_memory??={};worker.site_memory[site.id]={last_success_portions:delivered,last_visit_day:s.sim_day+1};
  if(delivered>0&&g()<P(p,'workers.recruitment_probability')){
   // Workers must share nest-local contact; the receiver must be there and not already on today's forage team.
   let available=s.population.workers.filter(w=>w.id!==worker.id&&w.task!=='forage'&&!w.recruited_today&&w.task!=='guard'&&w.age_days>=P(p,'workers.newborn_nurse_days'));
   const maxFollowers=Math.min(P(p,'workers.recruitment_max_followers'),available.length);
   const followCount=maxFollowers?1+Math.floor(g()*maxFollowers):0;
   for(let k=0;k<followCount;k++){
    let index=Math.floor(g()*available.length),follower=available.splice(index,1)[0];follower.recruited_today=true;follower.known_sources=[...new Set([...follower.known_sources,site.id])];if(!site.known_by.includes(follower.id))site.known_by.push(follower.id);
    summary.tasks[follower.task]-=1;follower.task='forage';summary.tasks.forage+=1;summary.recruited++;summary.foraging_trips++;summary.extra_sugar_cost=round(summary.extra_sugar_cost+P(p,'workers.foraging_trip_sugar_cost'));
    events.push({type:'local_recruitment',by:worker.id,to:follower.id,site:site.id,assumption:true});collect(site,follower,s,p,weather,events,summary);
   }
  }
 }
 for(const w of s.population.workers)delete w.recruited_today;
}
function consume(s,p,summary){
 const workers=s.population.workers.length,larvae=s.population.brood.filter(b=>b.stage==='larva').length;
 const demandS=round(workers*P(p,'nutrition.worker_sugar_daily')+(s.population.queen_alive?P(p,'nutrition.queen_sugar_daily'):0)+larvae*P(p,'nutrition.larva_sugar_daily')+summary.extra_sugar_cost);
 const demandP=round(workers*P(p,'nutrition.worker_protein_daily')+(s.population.queen_alive?P(p,'nutrition.queen_protein_daily'):0)+larvae*P(p,'nutrition.larva_protein_daily'));
 const gotS=round(Math.min(s.colony.sugar,demandS)),gotP=round(Math.min(s.colony.protein,demandP));s.colony.sugar=round(Math.max(0,s.colony.sugar-gotS));s.colony.protein=round(Math.max(0,s.colony.protein-gotP));
 const sFraction=demandS>0?gotS/demandS:1,pFraction=demandP>0?gotP/demandP:1;
 s.colony.sugar_gap_days=sFraction<.995?s.colony.sugar_gap_days+1:0;
 s.colony.protein_gap_days=pFraction<.995?s.colony.protein_gap_days+1:0;
 s.colony.stress_days=Math.max(s.colony.sugar_gap_days,s.colony.protein_gap_days);
 summary.demand={sugar:demandS,protein:demandP};summary.consumed={sugar:gotS,protein:gotP};summary.ratios={sugar:round(sFraction),protein:round(pFraction)};
 // Today's local feeding experience affects tomorrow's worker choices. Not an AI broadcast.
 s.colony.local_cues={last_sugar_feeding_fraction:round(sFraction),last_protein_feeding_fraction:round(pFraction),origin:'same-nest food-sharing and brood-care encounters (one-day delayed proxy; game assumption)'};
 return {sFraction,pFraction};
}
function developmentalDay(s,p,weather,ratios,events,summary){
 const factor=clamp(Math.pow(P(p,'development.q10'),(weather.nest_temp_model_c-P(p,'development.reference_c'))/10),P(p,'development.min_temp_factor'),P(p,'development.max_temp_factor'));
 let survived=[];
 for(const b of s.population.brood){
  if(!b.alive && b.alive!==undefined)continue;
  b.progress=round((b.progress||0)+factor/P(p,`development.${b.stage}_days`)*(b.stage==='larva'?Math.max(.1,Math.min(ratios.pFraction,ratios.sFraction)):1));
  b.age_days=typeof b.age_days==='number'?b.age_days+1:null;
  if(b.stage==='larva'&&s.colony.protein_gap_days>=P(p,'starvation.larva_mortality_starts_days')){
   let g=dice(s,'brood_survival:'+b.id),risk=clamp(P(p,'starvation.larva_daily_hazard_base')+(s.colony.protein_gap_days-P(p,'starvation.larva_mortality_starts_days'))*P(p,'starvation.larva_daily_hazard_slope'),0,.75);
   if(g()<risk){events.push({type:'brood_death',id:b.id,stage:b.stage,reason:'chronic_protein_shortage_game_scenario',probability_assumption:round(risk)});summary.brood_deaths++;continue;}
  }
  if(b.progress>=1){const old=b.stage;b.progress=round(Math.max(0,b.progress-1));
   if(old==='egg'){b.stage='larva';b.age_days=0;events.push({type:'hatch',id:b.id});summary.hatchings++;}
   else if(old==='larva'){b.stage='pupa';b.age_days=0;events.push({type:'pupation',id:b.id});summary.pupations++;}
   else if(old==='pupa'){
    const newId=`W${String(s.next_worker_number++).padStart(3,'0')}`;
    s.population.workers.push({id:newId,alive:true,age_days:P(p,'workers.newborn_initial_age_days'),age_origin:'born_after_v2_migration',injured:false,task:'nurse',known_sources:[],last_location:'N00'});
    summary.eclosions++;events.push({type:'eclosion',source_brood_id:b.id,new_worker_id:newId,caste:'minor_worker_scenario_unverified'});continue;
   }
  }
  survived.push(b);
 }
 s.population.brood=survived;summary.development_factor=round(factor);
}
function deathAndQueen(s,p,ratios,events,summary){
 let alive=[];
 for(const w of s.population.workers){let g=dice(s,'adult_survival:'+w.id),natural=P(p,'starvation.worker_natural_daily_base_hazard');
  natural+=Math.max(0,w.age_days-P(p,'starvation.worker_age_risk_from_days'))*P(p,'starvation.worker_age_hazard_slope');
  if(w.injured)natural*=P(p,'starvation.injury_mortality_multiplier');
  let starvation=0;if(s.colony.sugar_gap_days>=P(p,'starvation.worker_mortality_starts_days'))starvation=clamp(P(p,'starvation.worker_daily_hazard_base')+(s.colony.sugar_gap_days-P(p,'starvation.worker_mortality_starts_days'))*P(p,'starvation.worker_daily_hazard_slope'),0,.95);
  const risk=clamp(1-(1-natural)*(1-starvation),0,.98);
  if(g()<risk){summary.worker_deaths++;events.push({type:'worker_death',id:w.id,reason:starvation>0?'starvation_or_natural_competing_hazards_scenario':'natural_or_injury_assumed',risk_assumption:round(risk)});}
  else{if(w.injured&&w.task==='rest'&&s.colony.stress_days===0&&g()<P(p,'workers.injury_repair_probability')){w.injured=false;events.push({type:'injury_recovery',id:w.id});}alive.push(w);}
 }
 s.population.workers=alive;
 if(s.population.queen_alive&&s.colony.stress_days>=P(p,'starvation.queen_hazard_after_days')&&dice(s,'queen_survival')()<P(p,'starvation.queen_daily_hazard')){s.population.queen_alive=false;events.push({type:'queen_death',id:'Q001',reason:'prolonged_energy_or_protein_deficit_scenario'});}
 // Egg production after maintenance, conditional on both nutrition and available reserves for producing the egg.
 const broodCount=s.population.brood.length;const enough=ratios.sFraction>=P(p,'queen.adequate_nutrition_threshold')&&ratios.pFraction>=P(p,'queen.adequate_nutrition_threshold')&&s.colony.sugar>=P(p,'nutrition.egg_laying_sugar_cost')&&s.colony.protein>=P(p,'nutrition.egg_laying_protein_cost');
 const pause=s.colony.sugar_gap_days>=P(p,'starvation.queen_egg_pause_days')||s.colony.protein_gap_days>=P(p,'starvation.queen_egg_pause_days');
 const probability=clamp(P(p,'queen.base_laying_probability')*(s.colony.queen_laid_yesterday?P(p,'queen.previous_laying_penalty'):1)*(1-P(p,'queen.existing_brood_pressure')*broodCount),0,.9);
 const laid=s.population.queen_alive&&enough&&!pause&&dice(s,'oviposition')()<probability?1:0;
 if(laid){s.colony.sugar=round(s.colony.sugar-P(p,'nutrition.egg_laying_sugar_cost'));s.colony.protein=round(s.colony.protein-P(p,'nutrition.egg_laying_protein_cost'));let id=`E${String(s.next_egg_number++).padStart(3,'0')}`;
 s.population.brood.push({id,stage:'egg',laid_on_day:s.sim_day+1,age_days:0,progress:0,origin:'v2_scenario_laying'});events.push({type:'egg_laid',id,queen:'Q001',sugar_cost_portions:P(p,'nutrition.egg_laying_sugar_cost'),protein_cost_portions:P(p,'nutrition.egg_laying_protein_cost')});summary.eggs_laid++;
 }
 s.colony.queen_laid_yesterday=Boolean(laid);
 summary.queen_laying_probability_applied=s.population.queen_alive&&enough&&!pause?round(probability):0;
}
function validateState(s){if(!Number.isInteger(s.sim_day)||s.sim_day<14||!s.population?.workers||!s.population?.brood||!s.sources||!s.colony)throw Error('invalid engine v2 state');
 if(!s.ecology?.insects_by_site || !s.colony.local_cues||!Number.isInteger(s.ecology.adjacent_garden_living_insects)||s.ecology.adjacent_garden_living_insects<0)throw Error('NO_GOD_MODE: missing causal ecology/local cues or finite neighbor insect population');
 for(const [site,pop] of Object.entries(s.ecology.insects_by_site)){if(!s.sources[site]||s.sources[site].type!=='carcass'||!Number.isInteger(pop.living)||pop.living<0||!Number.isInteger(pop.cumulative_deaths)||pop.cumulative_deaths<0)throw Error('invalid local insect ecological population');}
 for(const key of ['last_sugar_feeding_fraction','last_protein_feeding_fraction'])if(!Number.isFinite(s.colony.local_cues[key])||s.colony.local_cues[key]<0||s.colony.local_cues[key]>1)throw Error('invalid local feeding cue');for(const k of ['sugar','protein']){if(!Number.isFinite(s.colony[k])||s.colony[k]<0)throw Error('invalid '+k+' store');}let ids=[...s.population.workers.map(x=>x.id),...s.population.brood.map(x=>x.id)];if(new Set(ids).size!==ids.length)throw Error('duplicate IDs');for(const src of Object.values(s.sources)){if(src.type==='carcass'&&Math.abs(src.protein-src.batches.reduce((a,b)=>a+b.protein,0))>1e-4)throw Error('nonconserved carcass source '+src.id);if((src.sugar||0)<0||(src.protein||0)<0)throw Error('negative source');}}
const ACCEPTED_INPUT_KEYS=new Set(['schema','sim_day','calendar_date','seed','next_worker_number','next_egg_number','next_larva_number','next_pupa_number','population','colony','climate','sources','ecology','active_signals','migration_log','rules_fingerprint','last_report','last_events']);
function simulateDay(input,params){
 if(arguments.length!==2)throw Error('NO_GOD_MODE: no overrides, directives or interventions');
 if(input.schema!=='antempire.engine-v2')throw Error('Expected migrated Day14-or-later engine state');
 for(const key of Object.keys(input))if(!ACCEPTED_INPUT_KEYS.has(key))throw Error('NO_GOD_MODE: unauthorized input '+key);
 validateState(input);
 const s=clone(input),events=[],initial={sugar:s.colony.sugar,protein:s.colony.protein},date=new Date(s.calendar_date+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+1);const dayDate=date.toISOString().slice(0,10);
 const weather=calcWeather(s,params,dayDate);const summary={day:s.sim_day+1,date:dayDate,weather,workers_before:s.population.workers.length,brood_before:s.population.brood.length,queen_alive_before:s.population.queen_alive,income:{sugar:0,protein:0},tasks:{forage:0,nurse:0,repair:0,rest:0,guard:0},foraging_trips:0,foraging_successes:0,scouts:0,recruited:0,extra_sugar_cost:0,worker_deaths:0,brood_deaths:0,hatchings:0,pupations:0,eclosions:0,eggs_laid:0};
 growSources(s,params,weather,events);
 for(const e of events.filter(x=>x.type==='new_food_source')){
  if(!events.some(x=>x.type==='insect_natural_death'&&x.event_id===e.id&&x.site===e.site))throw Error('NO_GOD_MODE: food has no physical source death');
 }
 forage(s,params,weather,events,summary);
 // Other colonymates carrying liquid do not duplicate colony external income.
 const storeOverflow={sugar:round(Math.max(0,s.colony.sugar-(P(params,'nutrition.max_sugar_store')+Math.max(0,s.population.workers.length-14)*.4))),protein:round(Math.max(0,s.colony.protein-(P(params,'nutrition.max_protein_store')+Math.max(0,s.population.workers.length-14)*.3)))};s.colony.sugar=round(s.colony.sugar-storeOverflow.sugar);s.colony.protein=round(s.colony.protein-storeOverflow.protein);
 const ratios=consume(s,params,summary);developmentalDay(s,params,weather,ratios,events,summary);deathAndQueen(s,params,ratios,events,summary);
 summary.population={queen:s.population.queen_alive?1:0,workers:s.population.workers.length,eggs:s.population.brood.filter(b=>b.stage==='egg').length,larvae:s.population.brood.filter(b=>b.stage==='larva').length,pupae:s.population.brood.filter(b=>b.stage==='pupa').length};
 summary.stock={sugar:round(s.colony.sugar),protein:round(s.colony.protein)};summary.starvation={sugar_gap_days:s.colony.sugar_gap_days,protein_gap_days:s.colony.protein_gap_days,stress_days:s.colony.stress_days};
 summary.mass_ledger={unit:'game_portions_NOT_mg',start:initial,foraged:summary.income,metabolized:summary.consumed,egg_laying:{sugar:round(summary.eggs_laid*P(params,'nutrition.egg_laying_sugar_cost')),protein:round(summary.eggs_laid*P(params,'nutrition.egg_laying_protein_cost'))},storage_overflow_not_retained:storeOverflow,note:'Nest mass conservation exact within 1e-5 game portions; source decomposition/replenishment separate'};
 for(const x of ['sugar','protein']){let rhs=round(initial[x]+summary.income[x]-summary.consumed[x]-summary.mass_ledger.egg_laying[x]-summary.mass_ledger.storage_overflow_not_retained[x]);if(Math.abs(rhs-summary.stock[x])>2e-5)throw Error('Nutrient balance not closed: '+x+' '+rhs+' vs '+summary.stock[x]);}
 const NATURAL_EVENT_TYPES=new Set(['new_food_source','source_batch_consumed','food_delivered','insect_immigration','insect_natural_death','physical_scout_visit','discovery','scouted_empty','nest_local_route_learning','local_recruitment','hatch','pupation','eclosion','egg_laid','worker_death','brood_death','injury_recovery','queen_death']);
 for(const event of events)if(!NATURAL_EVENT_TYPES.has(event.type))throw Error('NO_GOD_MODE: impossible or unregistered event type '+event.type);
 s.climate={...s.climate,prior_wet:weather.wet,prior_air_temp_c:weather.air_temp_c,prior_nest_temp_model_c:weather.nest_temp_model_c,temp_anomaly_c:weather.temperature_anomaly_c,soil_index:weather.soil_index,shade_index:weather.shade_index};
 s.sim_day+=1;s.calendar_date=dayDate;s.last_report=summary;s.last_events=events;
 validateState(s);if(summary.population.workers+summary.worker_deaths!==summary.workers_before+summary.eclosions)throw Error('worker conservation violated');
 // Exact brood count balance across stages and deaths, egg lays, eclosions.
 if(s.population.brood.length+summary.brood_deaths+summary.eclosions!==summary.brood_before+summary.eggs_laid)throw Error('brood conservation violated');
 return {engine_version:ENGINE_VERSION,params_schema:params.schema,day:s.sim_day,summary,events,state:s};
}
module.exports={simulateDay,P,ENGINE_VERSION};
if(require.main===module){const [stateFile,paramsFile]=process.argv.slice(2);if(!stateFile||!paramsFile){process.stderr.write('Usage: node sim/day_engine.cjs <engine-state.json> <params.json>\n');process.exit(2);}const out=simulateDay(JSON.parse(fs.readFileSync(stateFile)),JSON.parse(fs.readFileSync(paramsFile)));process.stdout.write(JSON.stringify(out,null,2)+'\n');}

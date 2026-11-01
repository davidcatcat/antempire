"use strict";
/** AntEmpire v2 proposal, effective Day15. All numeric knobs in params.json are GAME ASSUMPTIONS.
 * No GitHub/clock access; deterministic pure one-day transition. Node 18+. No dependencies. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const physics = require('./foraging_physics.cjs');
const ENGINE_VERSION = 'antempire.v2-review.6-physical-foraging-pheromone-trophallaxis';
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
 let tempMean=monthInterp(rows,y,m,day,'mean_air_temperature_c');let anomaly=round(P(p,'climate.temperature_ar')*s.climate.temp_anomaly_c+P(p,'climate.temperature_daily_sigma_c')*normal(g));let airTemp=round(tempMean+anomaly-.8*(Number(wet)-rainProb));const highNormal=monthInterp(rows,y,m,day,'mean_daily_maximum_air_temperature_c'),lowNormal=monthInterp(rows,y,m,day,'mean_daily_minimum_air_temperature_c');const maxAirTemp=round(Math.max(airTemp,highNormal+anomaly-.8*(Number(wet)-rainProb))),minAirTemp=round(Math.min(airTemp,lowNormal+anomaly-.8*(Number(wet)-rainProb)));let rh=round(clamp(monthInterp(rows,y,m,day,'mean_relative_humidity_percent')+(wet?5:-2)+.45*anomaly,0,100));let rainMean=monthInterp(rows,y,m,day,'mean_monthly_precipitation_mm')/monthDays(y,m)/Math.max(.001,rainProb);let rain=wet?round(gamma(P(p,'climate.rainfall_gamma_shape'),rainMean/P(p,'climate.rainfall_gamma_shape'),g)):0;
 let soil=round(clamp(s.climate.soil_index*P(p,'climate.soil_persistence')+rain*P(p,'climate.soil_rain_gain_per_mm')-P(p,'climate.soil_daily_loss'),0,1));let shade=round(clamp(s.climate.shade_index*P(p,'climate.soil_shade_persistence')+rain*P(p,'climate.soil_shade_rain_gain_per_mm')-P(p,'climate.soil_shade_daily_loss'),0,1));
 let nestTemp=round((s.climate.prior_nest_temp_c??s.climate.prior_air_temp_c)*P(p,'climate.nest_temp_memory')+airTemp*(1-P(p,'climate.nest_temp_memory')));
 return {day:s.sim_day+1,date,kind:'synthetic_climatology_game_assumption_not_real_weather',wet,air_temp_c:airTemp,daytime_air_temp_c:maxAirTemp,daily_max_air_temp_c:maxAirTemp,daily_min_air_temp_c:minAirTemp,daytime_proxy_basis:'synthetic_daily_air_maximum_NOT_measured_ground_surface',nest_temp_model_c:nestTemp,relative_humidity_model_percent:rh,rain_mm:rain,soil_index:soil,shade_index:shade,temperature_anomaly_c:anomaly,rain_probability_model:round(pWet)};
}
function sourceSum(src){if(src.type==='carcass')return round(src.batches.reduce((t,x)=>t+x.protein,0));return src.sugar;}
function syncSource(src){if(src.type==='carcass'){src.protein=sourceSum(src);}else src.protein=0;src.sugar=round(src.sugar||0);}
function foragingTemperatureFactor(p,airC){
 const minC=P(p,'workers.foraging_cold_limit_c'),fullC=P(p,'workers.foraging_full_activity_c'),floor=P(p,'workers.foraging_cold_min_multiplier');
 return round(clamp(floor+(1-floor)*clamp((airC-minC)/(fullC-minC),0,1),floor,1));
}
function insectBirthFactor(p,weather){
 return clamp(1+(weather.air_temp_c-P(p,'sources.insect_reproduction_reference_c'))*P(p,'sources.insect_reproduction_per_degree_c'),P(p,'sources.insect_reproduction_min_multiplier'),P(p,'sources.insect_reproduction_max_multiplier'));
}
function logisticBirths(s,p,weather,events,site,living,capacity,rate,g){
 const prob=clamp(rate*insectBirthFactor(p,weather)*(1-living/Math.max(1,capacity)),0,1);
 let births=0;for(let i=0;i<living&&births<Math.max(0,capacity-living);i++)if(g()<prob)births++;
 if(births)events.push({type:'insect_population_birth',site,individuals:births,population_before:living,population_after:living+births,local_capacity:capacity,temperature_c:weather.air_temp_c,causal_basis:'natural density-limited reproduction independent of ant diet',assumption:true});
 return births;
}
function growSources(s,p,weather,events){
 let g=dice(s,'ecology');
 for(const [id,src] of Object.entries(s.sources)){
  if(src.type==='carcass'){
   const frac=clamp(P(p,'sources.carcass_daily_decay_fraction')+weather.rain_mm*P(p,'sources.carcass_rain_decay_bonus'),0,.95);
   for(const batch of src.batches){batch.age_days=s.sim_day+1-batch.original_day;batch.protein=batch.age_days>P(p,'sources.carcass_max_lifetime_days')?0:round(batch.protein*(1-frac));}
   syncSource(src);continue;
  }
  if(src.type==='honeydew'){
   // ALL production is environmental. No colony count, ant demand, or sugar balance is consulted.
   src.host_plants??=0;src.hemipteran_colonies??=0;
   if(src.host_plants>0&&src.host_alive&&g()<P(p,'sources.host_plant_daily_death_probability')){
    src.host_plants--;events.push({type:'host_plant_death',site:id,hosts_remaining:src.host_plants,causal_basis:'natural garden host mortality assumption'});
   }
   src.host_alive=src.host_plants>0&&src.host_alive!==false;
   if(src.host_alive){
    if(src.hemipteran_colonies>0&&g()<P(p,'sources.hemipteran_colony_daily_collapse_probability')){src.hemipteran_colonies--;events.push({type:'hemipteran_colony_change',site:id,delta:-1,remaining:src.hemipteran_colonies,causal_basis:'background insect colony collapse'});}
    if(src.hemipteran_colonies<src.host_plants*P(p,'sources.max_hemipteran_colonies_per_host')&&g()<P(p,'sources.hemipteran_colony_daily_growth_probability')){src.hemipteran_colonies++;events.push({type:'hemipteran_colony_change',site:id,delta:1,remaining:src.hemipteran_colonies,causal_basis:'reproduction within living host plant carrying capacity'});}
   }else src.hemipteran_colonies=0;
   const groupRate=P(p,src.hemipteran_kind==='scale'?'sources.honeydew_per_scale_colony_per_day':'sources.honeydew_per_aphid_colony_per_day');
   const rainFactor=clamp(1-weather.rain_mm*P(p,'sources.rain_honeydew_secretion_suppression_per_mm'),.05,1);
   const gross=src.host_alive?src.hemipteran_colonies*groupRate*P(p,'sources.honeydew_productivity_multiplier')*rainFactor:0;
   const rivals=id==='F04'?P(p,'sources.rival_honeydew_harvest_fraction_F04'):0;
   const net=gross*(1-rivals);
   const wash=clamp(weather.rain_mm*P(p,'sources.honeydew_washoff_per_rain_mm'),0,.9);
   const before=src.sugar;src.sugar=round(clamp(src.sugar*(1-wash)+net,0,src.capacity));
   src.production_last_day=round(net);src.production_per_day=round(net);
   src.ecological_record={host_plants:src.host_plants,hemipteran_kind:src.hemipteran_kind,hemipteran_colonies:src.hemipteran_colonies,gross_portions:round(gross),rival_share_portions:round(gross*rivals),rain_mm:weather.rain_mm,net_portions:round(net),stock_before:before,stock_after:src.sugar};
   syncSource(src);continue;
  }
  // Nectar has flowering lifecycle, not a user-inserted sugar supply.
  const blooming=src.bloom_days_left>0, wash=clamp(weather.rain_mm*P(p,'sources.nectar_washoff_per_rain_mm'),0,.9);
  const before=src.sugar,production=blooming&&src.host_alive!==false?src.production_per_day:0;
  src.sugar=round(clamp(src.sugar*(1-wash)+production,0,src.capacity));
  src.bloom_days_left=Math.max(0,src.bloom_days_left-1);
  src.production_last_day=round(production);src.ecological_record={bloom_days_left:src.bloom_days_left,rain_mm:weather.rain_mm,production_portions:production,stock_before:before,stock_after:src.sugar};syncSource(src);
 }
 // Track living populations in F07, F11 AND the adjacent habitat. No colony data are consulted.
 const neighborSite='adjacent_garden_habitat',gn=dice(s,'insect_demography:'+neighborSite);
 const neighborK=P(p,'sources.insect_boundary_carrying_capacity');
 let neighbor=s.ecology.adjacent_garden_living_insects,neighborDeaths=0;
 for(let i=0,n=neighbor;i<n;i++)if(gn()<P(p,'sources.insect_boundary_per_capita_daily_death_probability'))neighborDeaths++;
 neighbor-=neighborDeaths;
 if(neighborDeaths)events.push({type:'insect_background_death',site:neighborSite,individuals:neighborDeaths,population_after:neighbor,causal_basis:'natural death outside harvested garden',assumption:true});
 neighbor+=logisticBirths(s,p,weather,events,neighborSite,neighbor,neighborK,P(p,'sources.insect_boundary_logistic_daily_birth_rate'),gn);
 s.ecology.adjacent_garden_living_insects=neighbor;
 for(const site of Object.keys(s.ecology.insects_by_site).sort()){
  const pop=s.ecology.insects_by_site[site],g=dice(s,'insect_demography:'+site);
  const localK=pop.carrying_capacity??P(p,'sources.insect_local_carrying_capacity');
  const mortality=1-Math.pow(1-P(p,'sources.insect_local_daily_mortality_probability'),pop.living/Math.max(1,P(p,'sources.insect_local_death_reference_population')));
  if(pop.living>0&&g()<mortality){
   const before=pop.living;pop.living--;pop.cumulative_deaths++;
   const quantity=round(P(p,'sources.carcass_new_protein_min')+g()*(P(p,'sources.carcass_new_protein_max')-P(p,'sources.carcass_new_protein_min')));
   const id='NAT-D'+(s.sim_day+1)+'-'+site+'-'+pop.cumulative_deaths;
   s.sources[site].batches.push({event_id:id,original_day:s.sim_day+1,protein:quantity,age_days:0,origin:'tracked local mortality and portion estimate',insect_population_before:before,insect_population_after:pop.living});syncSource(s.sources[site]);
   events.push({type:'insect_natural_death',site,event_id:id,insect_count_before:before,insect_count_after:pop.living,causal_basis:'natural death of existing tracked insect'});
   events.push({type:'new_food_source',id,site,protein_portions:quantity,caused_by_event_id:id,causal_basis:'physical remains after recorded natural insect death',assumption:true});
  }
  pop.living+=logisticBirths(s,p,weather,events,site,pop.living,localK,P(p,'sources.insect_site_logistic_daily_birth_rate'),g);
  if(s.ecology.adjacent_garden_living_insects>0&&pop.living<localK&&g()<P(p,'sources.insect_background_immigration_probability')){
   s.ecology.adjacent_garden_living_insects--;pop.living++;
   events.push({type:'insect_immigration',site,from:neighborSite,individuals:1,adjacent_population_after:s.ecology.adjacent_garden_living_insects,causal_basis:'physical transfer from tracked neighboring habitat',assumption:true});
  }
 }
}
function localSignals(worker){
 const c=worker.local_sensory||{};
 return {sugarSatiety:clamp(c.own_crop_sugar_fill??.55,0,1),peerSugarHunger:clamp(c.peer_sugar_hunger??.4,0,1),broodBegging:clamp(c.direct_brood_begging??0,0,1),proteinFeedback:clamp(c.peer_protein_request??.25,0,1)};
}
function selectTask(worker,s,p,weather){
 const g=dice(s,'task:'+worker.id),age=worker.age_days,v=localSignals(worker);
 const injured=worker.injured?.75:1,young=age<P(p,'workers.newborn_nurse_days');
 const hunger=clamp((1-v.sugarSatiety)*.7+v.peerSugarHunger*.3,0,1);
 const forageBias=P(p,'workers.forage_baseline_probability')*(1+.9*hunger)*injured*(young?.08:1)*clamp(1-weather.rain_mm*P(p,'workers.rain_suppression_fraction'),P(p,'workers.min_rain_activity_multiplier'),1);
 const care=P(p,'workers.nurse_baseline_probability')*(1+.65*v.broodBegging)*(young?3:1),rest=P(p,'workers.rest_baseline_probability')*(worker.injured?1.5:1),repair=P(p,'workers.maintenance_baseline_probability')*(1+.8*weather.soil_index),guard=P(p,'workers.defence_baseline_probability');
 const entries=[['forage',forageBias],['nurse',care],['rest',rest],['repair',repair],['guard',guard]],total=entries.reduce((x,a)=>x+a[1],0);let roll=g()*total;
 for(const [task,weight] of entries){roll-=weight;if(roll<=0)return task==='forage'&&g()>=foragingTemperatureFactor(p,weather.daytime_air_temp_c)?'rest':task;}return 'rest';
}
function discover(worker,s,p,events){
 const g=dice(s,'scout:'+worker.id);
 const options=Object.values(s.sources).filter(src=>src.presence==='potential'&&!worker.known_sources.includes(src.id)&&Array.isArray(src.access_from)&&src.access_from.some(id=>worker.known_sources.includes(id)));
 if(!options.length||g()>=P(p,'workers.scout_discovery_probability'))return null;
 const site=options[Math.floor(g()*options.length)],route=physics.routeTo(site.id);if(!route)return null;
 const trip=physics.travel(s,p,P,worker,route,events,'scout');if(!trip)return null;
 events.push({type:'physical_scout_visit',worker:worker.id,site:site.id,via:site.access_from.find(id=>worker.known_sources.includes(id)),route,arrival_minute:trip.arrive,assumption:true});
 physics.goHome(s,p,P,worker,route,events,'scout_return',trip.arrive);
 worker.known_sources.push(site.id);site.known_by.push(worker.id);
 if(site.host_alive===true){site.presence='confirmed_game_scenario';events.push({type:'discovery',worker:worker.id,site:site.id,food_kind:site.type,assumption:true});}
 else{site.presence='scouted_empty';events.push({type:'scouted_empty',worker:worker.id,site:site.id,assumption:true});}
 return site.id;
}
function collect(source,worker,s,p,weather,events,summary,onsite){
 const g=dice(s,'collect:'+worker.id+':'+source.id);
 const rain=clamp(1-weather.rain_mm*P(p,'workers.rain_suppression_fraction'),P(p,'workers.min_rain_activity_multiplier'),1);
 if(source.type==='carcass'&&sourceSum(source)<=1e-5)physics.prey(s,p,P,source,worker,onsite,g,events);
 if(source.presence==='scouted_empty'||source.presence==='potential'||sourceSum(source)<=1e-5||g()>rain*(source.type==='carcass'?P(p,'sources.carcass_access_probability'):.85))return null;
 const macro=source.type==='carcass'?'protein':'sugar',min=P(p,'sources.crop_load_'+macro+'_min'),max=P(p,'sources.crop_load_'+macro+'_max');
 const load=round(Math.min(sourceSum(source),min+(max-min)*g()));if(load<=0)return null;
 if(macro==='sugar')source.sugar=round(source.sugar-load);
 else{let needed=load;for(const batch of source.batches){const take=Math.min(batch.protein,needed);batch.protein=round(batch.protein-take);needed=round(needed-take);if(take>0)events.push({type:'source_batch_consumed',source_event_id:batch.event_id,location:source.id,worker:worker.id,quantity_portions:round(take)});if(needed<=1e-6)break;}syncSource(source);}
 events.push({type:'food_collected',worker:worker.id,site:source.id,macro,portions:load,location:source.id,assumption:true});return {macro,load};
}
function forage(s,p,weather,events,summary){
 physics.decay(s,p,P,events);
 // Read only personally contacted nestmates, never whole-colony sugar/protein stocks.
 for(const worker of s.population.workers){const g=dice(s,'nest_contact:'+worker.id);
  const peers=worker.last_location==='N00'?s.population.workers.filter(w=>w.id!==worker.id&&w.last_location==='N00'):[];
  if(peers.length&&g()<P(p,'workers.local_peer_contact_probability')){
   const peer=peers[Math.floor(g()*peers.length)],mem=worker.local_sensory??={},ret=P(p,'workers.local_signal_smoothing');
   mem.peer_sugar_hunger=round(ret*(mem.peer_sugar_hunger??.4)+(1-ret)*(1-localSignals(peer).sugarSatiety));
   mem.peer_protein_request=round(ret*(mem.peer_protein_request??.25)+(1-ret)*(peer.local_sensory?.direct_brood_begging||0));
   events.push({type:'local_contact_cue',worker:worker.id,peer:peer.id,peer_crop_fill:round(localSignals(peer).sugarSatiety),assumption:true});
  }
 }
 const foragers=[];
 for(const worker of s.population.workers){
  worker.task=selectTask(worker,s,p,weather);worker.age_days++;summary.tasks[worker.task]=(summary.tasks[worker.task]||0)+1;
  if(worker.task==='nurse'){const larvae=s.population.brood.filter(b=>b.stage==='larva'),g=dice(s,'nurse_contact:'+worker.id);
   if(larvae.length&&g()<.75){const brood=larvae[Math.floor(g()*larvae.length)];worker.local_sensory??={};worker.local_sensory.direct_brood_begging=round(brood.begging_signal??.2);events.push({type:'local_brood_begging_contact',worker:worker.id,larva:brood.id,signal:brood.begging_signal??.2});}
  }
  if(worker.task==='forage'&&worker.last_location==='N00')foragers.push(worker);
 }
 // Plan first departures, then physically move all foragers to their sites before any group capture.
 // This allows prey teams ONLY when independent workers actually reach the same node.
 const plans=[];
 for(const worker of foragers){const g=dice(s,'target:'+worker.id);worker.site_memory??={};
  let known=worker.known_sources.map(id=>s.sources[id]).filter(src=>src&&src.presence!=='scouted_empty');
  const best=Math.max(0,...known.map(src=>worker.site_memory[src.id]?.last_success_portions??0));
  if(!known.length||(best<.1&&g()<P(p,'workers.scout_search_when_route_unproductive_probability'))){
   discover(worker,s,p,events);known=worker.known_sources.map(id=>s.sources[id]).filter(src=>src&&src.presence!=='scouted_empty');
  }
  let chosen=null;
  if(known.length){const cues=localSignals(worker),need=clamp((1-cues.sugarSatiety)*.6+cues.peerSugarHunger*.4,0,1);
   const ranks=known.map(site=>{const macro=site.type==='carcass'?'protein':'sugar',prior=worker.site_memory[site.id]?.last_success_portions??.15;
    const age=worker.site_memory[site.id]?.last_visit_day??(s.sim_day-2),penalty=prior===0&&s.sim_day-age<4?.35:1;
    const unload=worker.local_sensory?.unload_feedback?.[macro]??.5;
    const bias=macro==='sugar'?1+P(p,'workers.sugar_hunger_priority_weight')*need:1+P(p,'workers.protein_begging_priority_weight')*clamp(cues.broodBegging*.75+cues.proteinFeedback*.25,0,1);
    return {site,score:(.15+prior)*penalty*bias*(.65+P(p,'workers.unloading_success_memory_weight')*unload)};
   }).sort((a,b)=>b.score-a.score);
   chosen={source:ranks[g()<.77?0:Math.min(1,ranks.length-1)].site};
  }else chosen=physics.followLocalTrail(s,p,P,worker,g,events);
  if(!chosen){summary.scouts++;continue;}
  const route=chosen.route||physics.routeTo(chosen.source.id);if(!route){summary.scouts++;continue;}
  const trip=physics.travel(s,p,P,worker,route,events,'foraging_depart');if(!trip){events.push({type:'route_timeout',worker:worker.id,site:chosen.source.id,assumption:true});continue;}
  if(!worker.known_sources.includes(chosen.source.id))worker.known_sources.push(chosen.source.id);
  if(!chosen.source.known_by.includes(worker.id))chosen.source.known_by.push(worker.id);
  plans.push({worker,source:chosen.source,route,trip,g});
 }
 function unload(worker,source,route,found,g){const transfer=physics.handoff(s,p,P,worker,found.macro,found.load,events,g,source.id);
  summary.income[found.macro]=round(summary.income[found.macro]+found.load);summary.foraging_successes++;
  worker.local_sensory??={};worker.local_sensory.unload_feedback??={sugar:.5,protein:.5};
  const ease=clamp(.15+.8*(transfer.count/Math.max(1,P(p,'foraging_physics.max_trophallaxis_contacts'))),0,1);
  worker.local_sensory.unload_feedback[found.macro]=round(.5*worker.local_sensory.unload_feedback[found.macro]+.5*ease);
  worker.local_sensory.last_food_kind=found.macro;worker.local_sensory.last_unloading_ease=round(ease);
  events.push({type:'local_unloading_feedback',worker:worker.id,site:source.id,macro:found.macro,encountered_nestmates:transfer.count,ease:round(ease),assumption:true});
  physics.deposit(s,p,P,route,worker,events);
 }
 for(const plan of plans){const {worker,source,route,trip,g}=plan;if(worker.last_location!==source.id)continue;
  const nearby=plans.filter(q=>q.source.id===source.id&&q.worker.last_location===source.id).map(q=>q.worker);
  summary.foraging_trips++;summary.extra_sugar_cost=round(summary.extra_sugar_cost+P(p,'workers.foraging_trip_sugar_cost'));
  const found=collect(source,worker,s,p,weather,events,summary,nearby);
  summary.foraging_workers_by_macro[source.type==='carcass'?'protein':'sugar'].add(worker.id);
  worker.site_memory[source.id]={last_success_portions:found?.load||0,last_visit_day:s.sim_day+1};
  physics.goHome(s,p,P,worker,route,events,'foraging_return',trip.arrive);
  if(!found)continue;
  unload(worker,source,route,found,g);
  // Optional repeated trip with explicit travel time, never free instantaneous collection.
  if(g()<.5&&P(p,'workers.max_trips_per_forager')>=2){
   const again=physics.travel(s,p,P,worker,route,events,'repeat_depart',trip.back);
   if(again){summary.foraging_trips++;summary.extra_sugar_cost=round(summary.extra_sugar_cost+P(p,'workers.foraging_trip_sugar_cost'));
    const more=collect(source,worker,s,p,weather,events,summary,[worker]);worker.site_memory[source.id]={last_success_portions:more?.load||0,last_visit_day:s.sim_day+1};
    physics.goHome(s,p,P,worker,route,events,'repeat_return',again.arrive);if(more)unload(worker,source,route,more,g);
   }
  }
  if(g()<P(p,'workers.recruitment_probability')&&physics.fullTrail(s,p,P,route)){
   const possible=s.population.workers.filter(w=>w.id!==worker.id&&w.last_location==='N00'&&w.task!=='forage'&&w.task!=='guard'&&!w.recruited_today&&w.age_days>=P(p,'workers.newborn_nurse_days'));
   const n=possible.length?1+Math.floor(g()*Math.min(possible.length,P(p,'workers.recruitment_max_followers'))):0;
   for(let i=0;i<n;i++){const follower=possible.splice(Math.floor(g()*possible.length),1)[0];if(!follower)break;
    const follow=physics.travel(s,p,P,follower,route,events,'recruit_follow_trail',trip.back);
    if(!follow)continue;
    follower.recruited_today=true;summary.tasks[follower.task]--;follower.task='forage';summary.tasks.forage++;summary.recruited++;summary.foraging_trips++;
    summary.extra_sugar_cost=round(summary.extra_sugar_cost+P(p,'workers.foraging_trip_sugar_cost'));
    events.push({type:'local_recruitment',by:worker.id,to:follower.id,site:source.id,physical_route:route,signal_dependent:true,assumption:true});
    if(!follower.known_sources.includes(source.id))follower.known_sources.push(source.id);if(!source.known_by.includes(follower.id))source.known_by.push(follower.id);
    const cargo=collect(source,follower,s,p,weather,events,summary,[follower]);
    summary.foraging_workers_by_macro[source.type==='carcass'?'protein':'sugar'].add(follower.id);
    follower.site_memory??={};follower.site_memory[source.id]={last_success_portions:cargo?.load||0,last_visit_day:s.sim_day+1};
    physics.goHome(s,p,P,follower,route,events,'recruit_return',follow.arrive);
    if(cargo)unload(follower,source,route,cargo,g);
   }
  }
 }
 for(const w of s.population.workers)delete w.recruited_today;
}
function consume(s,p,summary,weather){
 const workers=s.population.workers.length, larvae=s.population.brood.filter(b=>b.stage==='larva');
 // Ectotherm Q10=2 at 25C is explicit game assumption, NOT P. megacephala measurement.
 const metabolicFactor=round(Math.pow(P(p,'nutrition.metabolic_q10'),(weather.nest_temp_model_c-P(p,'nutrition.metabolic_reference_c'))/10));
 const servedQueen=s.population.queen_alive&&workers>0?1:0,servedLarvae=workers>0?larvae.length:0;
 const demandS=round((workers*P(p,'nutrition.worker_sugar_daily')+servedQueen*P(p,'nutrition.queen_sugar_daily')+servedLarvae*P(p,'nutrition.larva_sugar_daily'))*metabolicFactor+summary.extra_sugar_cost);
 const demandP=round((workers*P(p,'nutrition.worker_protein_daily')+servedQueen*P(p,'nutrition.queen_protein_daily')+servedLarvae*P(p,'nutrition.larva_protein_daily'))*metabolicFactor);
 summary.metabolic_factor=metabolicFactor;summary.nurse_available=workers>0;
 const gotS=round(Math.min(s.colony.sugar,demandS)),gotP=round(Math.min(s.colony.protein,demandP));s.colony.sugar=round(Math.max(0,s.colony.sugar-gotS));physics.settleCrops(s,gotS);s.colony.protein=round(Math.max(0,s.colony.protein-gotP));
 const unattendedQueen=s.population.queen_alive&&workers===0;const sFraction=unattendedQueen?0:(demandS>0?gotS/demandS:1),pFraction=unattendedQueen?0:(demandP>0?gotP/demandP:1);
 s.colony.sugar_gap_days=sFraction<.995?s.colony.sugar_gap_days+1:0;s.colony.protein_gap_days=pFraction<.995?s.colony.protein_gap_days+1:0;s.colony.stress_days=Math.max(s.colony.sugar_gap_days,s.colony.protein_gap_days);
 summary.demand={sugar:demandS,protein:demandP};summary.consumed={sugar:gotS,protein:gotP};summary.ratios={sugar:round(sFraction),protein:round(pFraction)};
 // Physical rationing occurs in the nest; each worker only learns what it ate.
 // Do NOT broadcast sFraction/pFraction (or s.colony.sugar/protein) to the behavioral functions.
 let budget=Math.max(0,gotS-(servedQueen*P(p,'nutrition.queen_sugar_daily')+servedLarvae*P(p,'nutrition.larva_sugar_daily'))*metabolicFactor-summary.extra_sugar_cost);
 const order=[...s.population.workers];const g=dice(s,'nest_sugar_feeding_allocation');for(let k=order.length-1;k>0;k--){const j=Math.floor(g()*(k+1));[order[k],order[j]]=[order[j],order[k]];}
 for(const w of order){const need=P(p,'nutrition.worker_sugar_daily')*metabolicFactor,got=clamp(Math.min(need,budget),0,need);budget=Math.max(0,budget-got);w.local_sensory??={};const ls=w.local_sensory;
  const full=need>0?got/need:1;ls.own_crop_sugar_fill=round(.3*(ls.own_crop_sugar_fill??.6)+.7*full);ls.own_feeding_fraction=round(full);
 }
 // Larval begging signal requires a real local nurse encounter to reach any worker.
 for(const b of larvae){b.begging_signal=round(clamp(.3*(b.begging_signal??.3)+.7*(1-pFraction),0,1));}
 return {sFraction,pFraction};
}
function developmentalDay(s,p,weather,ratios,events,summary){
 const factor=clamp(Math.pow(P(p,'development.q10'),(weather.nest_temp_model_c-P(p,'development.reference_c'))/10),P(p,'development.min_temp_factor'),P(p,'development.max_temp_factor'));
 let survived=[];
 for(const b of s.population.brood){
  if(!b.alive && b.alive!==undefined)continue;
  // Orphan brood care dependency is basic biology; exact day limits are GAME assumptions.
  b.no_caretaker_days=s.population.workers.length===0?(b.no_caretaker_days||0)+1:0;
  const orphanLimit=b.stage==='larva'?P(p,'starvation.unattended_larva_max_days'):b.stage==='egg'?P(p,'starvation.unattended_egg_max_days'):P(p,'starvation.unattended_pupa_max_days');
  if(b.no_caretaker_days>=orphanLimit){events.push({type:'brood_death',id:b.id,stage:b.stage,reason:'unattended_brood_no_worker_care_game_assumption',max_unattended_days_assumption:orphanLimit});summary.brood_deaths++;continue;}
  if(s.population.workers.length===0&&b.stage==='larva'){b.age_days=typeof b.age_days==='number'?b.age_days+1:null;survived.push(b);continue;}
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
function deathAndQueen(s,p,ratios,events,summary,weather){
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
 s.colony.no_worker_days=s.population.workers.length===0?(s.colony.no_worker_days||0)+1:0;const zeroWorkers=s.colony.no_worker_days>=P(p,'starvation.queen_zero_worker_hazard_after_days');
 const queenRisk=zeroWorkers?Math.max(P(p,'starvation.queen_daily_hazard'),P(p,'starvation.queen_zero_worker_starved_daily_hazard')):P(p,'starvation.queen_daily_hazard');
 if(s.population.queen_alive&&((s.colony.stress_days>=P(p,'starvation.queen_hazard_after_days'))||zeroWorkers)&&dice(s,'queen_survival')()<queenRisk){s.population.queen_alive=false;events.push({type:'queen_death',id:'Q001',reason:'prolonged_energy_or_protein_deficit_scenario'});}
 // Egg production after maintenance, conditional on both nutrition and available reserves for producing the egg.
 const broodCount=s.population.brood.length;const enough=ratios.sFraction>=P(p,'queen.adequate_nutrition_threshold')&&ratios.pFraction>=P(p,'queen.adequate_nutrition_threshold')&&s.colony.sugar>=P(p,'nutrition.egg_laying_sugar_cost')&&s.colony.protein>=P(p,'nutrition.egg_laying_protein_cost');
 const pause=s.colony.sugar_gap_days>=P(p,'starvation.queen_egg_pause_days')||s.colony.protein_gap_days>=P(p,'starvation.queen_egg_pause_days');
 const layingTemp=round(clamp(Math.pow(P(p,'queen.laying_temperature_q10'),(weather.nest_temp_model_c-P(p,'queen.laying_reference_c'))/10),0,1));
 summary.queen_laying_temperature_factor=layingTemp;
 const probability=clamp(P(p,'queen.base_laying_probability')*layingTemp*(s.colony.queen_laid_yesterday?P(p,'queen.previous_laying_penalty'):1)*(1-P(p,'queen.existing_brood_pressure')*broodCount),0,.9);
 const eggDice=dice(s,'oviposition');let laid=s.population.queen_alive&&s.population.workers.length>0&&enough&&!pause&&eggDice()<probability?1:0;
 // Max two eggs/day, secondary conditional egg probability is a game assumption.
 if(laid&&P(p,'queen.max_eggs_per_day')>=2&&eggDice()<P(p,'queen.second_egg_given_laying_probability')&&s.colony.sugar>=2*P(p,'nutrition.egg_laying_sugar_cost')&&s.colony.protein>=2*P(p,'nutrition.egg_laying_protein_cost'))laid=2;
 for(let i=0;i<laid;i++){s.colony.sugar=round(s.colony.sugar-P(p,'nutrition.egg_laying_sugar_cost'));s.colony.protein=round(s.colony.protein-P(p,'nutrition.egg_laying_protein_cost'));let id=`E${String(s.next_egg_number++).padStart(3,'0')}`;
 s.population.brood.push({id,stage:'egg',laid_on_day:s.sim_day+1,age_days:0,progress:0,origin:'v2_scenario_laying'});events.push({type:'egg_laid',id,queen:'Q001',sugar_cost_portions:P(p,'nutrition.egg_laying_sugar_cost'),protein_cost_portions:P(p,'nutrition.egg_laying_protein_cost')});summary.eggs_laid++;
 }
 s.colony.queen_laid_yesterday=Boolean(laid);
 summary.queen_laying_probability_applied=s.population.queen_alive&&s.population.workers.length>0&&enough&&!pause?round(probability):0;
}
function validateState(s){if(!Number.isInteger(s.sim_day)||s.sim_day<14||!s.population?.workers||!s.population?.brood||!s.sources||!s.colony)throw Error('invalid engine v2 state');
 if(!s.ecology?.insects_by_site || !Number.isInteger(s.ecology.adjacent_garden_living_insects)||s.ecology.adjacent_garden_living_insects<0)throw Error('NO_GOD_MODE: missing causal ecology/local cues or finite neighbor insect population');
 for(const [site,pop] of Object.entries(s.ecology.insects_by_site)){if(!s.sources[site]||s.sources[site].type!=='carcass'||!Number.isInteger(pop.living)||pop.living<0||!Number.isInteger(pop.cumulative_deaths)||pop.cumulative_deaths<0)throw Error('invalid local insect ecological population');}
 for(const k of ['sugar','protein']){if(!Number.isFinite(s.colony[k])||s.colony[k]<0)throw Error('invalid '+k+' store');}let ids=[...s.population.workers.map(x=>x.id),...s.population.brood.map(x=>x.id)];if(new Set(ids).size!==ids.length)throw Error('duplicate IDs');for(const src of Object.values(s.sources)){if(src.type==='carcass'&&Math.abs(src.protein-src.batches.reduce((a,b)=>a+b.protein,0))>1e-4)throw Error('nonconserved carcass source '+src.id);if((src.sugar||0)<0||(src.protein||0)<0)throw Error('negative source');}}
const ACCEPTED_INPUT_KEYS=new Set(['schema','sim_day','calendar_date','seed','next_worker_number','next_egg_number','next_larva_number','next_pupa_number','population','colony','climate','sources','ecology','active_signals','migration_log','rules_fingerprint','last_report','last_events']);
function simulateDay(input,params){
 if(arguments.length!==2)throw Error('NO_GOD_MODE: no overrides, directives or interventions');
 if(input.schema!=='antempire.engine-v2')throw Error('Expected migrated Day14-or-later engine state');
 for(const key of Object.keys(input))if(!ACCEPTED_INPUT_KEYS.has(key))throw Error('NO_GOD_MODE: unauthorized input '+key);
 validateState(input);
 const s=clone(input),events=[],initial={sugar:s.colony.sugar,protein:s.colony.protein},date=new Date(s.calendar_date+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+1);const dayDate=date.toISOString().slice(0,10);
 const weather=calcWeather(s,params,dayDate);const summary={day:s.sim_day+1,date:dayDate,weather,workers_before:s.population.workers.length,brood_before:s.population.brood.length,queen_alive_before:s.population.queen_alive,income:{sugar:0,protein:0},tasks:{forage:0,nurse:0,repair:0,rest:0,guard:0},foraging_trips:0,foraging_successes:0,scouts:0,recruited:0,extra_sugar_cost:0,foraging_workers_by_macro:{sugar:new Set(),protein:new Set()},worker_deaths:0,brood_deaths:0,hatchings:0,pupations:0,eclosions:0,eggs_laid:0};
 growSources(s,params,weather,events);
 for(const e of events.filter(x=>x.type==='new_food_source')){
  if(!events.some(x=>(x.type==='insect_natural_death'||x.type==='insect_predation')&&x.event_id===e.id&&x.site===e.site))throw Error('NO_GOD_MODE: food has no physical source death');
 }
 forage(s,params,weather,events,summary);for(const e of events.filter(x=>x.type==='new_food_source')){if(!events.some(x=>(x.type==='insect_natural_death'||x.type==='insect_predation')&&x.event_id===e.id&&x.site===e.site))throw Error('NO_GOD_MODE: food without tracked dead insect');}summary.foraging_workers_by_macro={sugar:summary.foraging_workers_by_macro.sugar.size,protein:summary.foraging_workers_by_macro.protein.size};
 // Other colonymates carrying liquid do not duplicate colony external income.
 const storeOverflow={sugar:round(Math.max(0,s.colony.sugar-(P(params,'nutrition.max_sugar_store')+Math.max(0,s.population.workers.length-14)*.4))),protein:round(Math.max(0,s.colony.protein-(P(params,'nutrition.max_protein_store')+Math.max(0,s.population.workers.length-14)*.3)))};s.colony.sugar=round(s.colony.sugar-storeOverflow.sugar);physics.settleCrops(s,storeOverflow.sugar);s.colony.protein=round(s.colony.protein-storeOverflow.protein);
 const ratios=consume(s,params,summary,weather);developmentalDay(s,params,weather,ratios,events,summary);deathAndQueen(s,params,ratios,events,summary,weather);
 summary.population={queen:s.population.queen_alive?1:0,workers:s.population.workers.length,eggs:s.population.brood.filter(b=>b.stage==='egg').length,larvae:s.population.brood.filter(b=>b.stage==='larva').length,pupae:s.population.brood.filter(b=>b.stage==='pupa').length};
 summary.stock={sugar:round(s.colony.sugar),protein:round(s.colony.protein)};summary.starvation={sugar_gap_days:s.colony.sugar_gap_days,protein_gap_days:s.colony.protein_gap_days,stress_days:s.colony.stress_days};
 summary.mass_ledger={unit:'game_portions_NOT_mg',start:initial,foraged:summary.income,metabolized:summary.consumed,egg_laying:{sugar:round(summary.eggs_laid*P(params,'nutrition.egg_laying_sugar_cost')),protein:round(summary.eggs_laid*P(params,'nutrition.egg_laying_protein_cost'))},storage_overflow_not_retained:storeOverflow,note:'Nest mass conservation exact within 1e-5 game portions; source decomposition/replenishment separate'};
 for(const x of ['sugar','protein']){let rhs=round(initial[x]+summary.income[x]-summary.consumed[x]-summary.mass_ledger.egg_laying[x]-summary.mass_ledger.storage_overflow_not_retained[x]);if(Math.abs(rhs-summary.stock[x])>2e-5)throw Error('Nutrient balance not closed: '+x+' '+rhs+' vs '+summary.stock[x]);}
 const NATURAL_EVENT_TYPES=new Set(['new_food_source','source_batch_consumed','food_delivered','insect_immigration','insect_natural_death','insect_population_birth','insect_background_death','physical_scout_visit','discovery','scouted_empty','nest_local_route_learning','local_contact_cue','local_brood_begging_contact','local_unloading_feedback','host_plant_death','hemipteran_colony_change','local_recruitment','route_step','route_timeout','trail_decay','trail_deposited','local_trail_choice','food_collected','trophallaxis','protein_cached_at_nest','live_prey_encounter','prey_escaped','local_alarm_signal','insect_predation','hatch','pupation','eclosion','egg_laid','worker_death','brood_death','injury_recovery','queen_death']);
 for(const event of events)if(!NATURAL_EVENT_TYPES.has(event.type))throw Error('NO_GOD_MODE: impossible or unregistered event type '+event.type);
 s.climate={...s.climate,prior_wet:weather.wet,prior_air_temp_c:weather.air_temp_c,prior_nest_temp_model_c:weather.nest_temp_model_c,temp_anomaly_c:weather.temperature_anomaly_c,soil_index:weather.soil_index,shade_index:weather.shade_index};
 s.sim_day+=1;s.calendar_date=dayDate;s.last_report=summary;s.last_events=events;
 validateState(s);if(summary.population.workers+summary.worker_deaths!==summary.workers_before+summary.eclosions)throw Error('worker conservation violated');
 // Exact brood count balance across stages and deaths, egg lays, eclosions.
 if(s.population.brood.length+summary.brood_deaths+summary.eclosions!==summary.brood_before+summary.eggs_laid)throw Error('brood conservation violated');
 return {engine_version:ENGINE_VERSION,params_schema:params.schema,day:s.sim_day,summary,events,state:s};
}
module.exports={simulateDay,P,ENGINE_VERSION,foragingTemperatureFactor};
if(require.main===module){const [stateFile,paramsFile]=process.argv.slice(2);if(!stateFile||!paramsFile){process.stderr.write('Usage: node sim/day_engine.cjs <engine-state.json> <params.json>\n');process.exit(2);}const out=simulateDay(JSON.parse(fs.readFileSync(stateFile)),JSON.parse(fs.readFileSync(paramsFile)));process.stdout.write(JSON.stringify(out,null,2)+'\n');}

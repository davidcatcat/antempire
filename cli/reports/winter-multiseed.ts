/**
 * Port of sim/test_winter_multiseed.cjs: isolated 20-seed Day15–134 winter diagnostic (v6 physical foraging).
 * Writes ONLY to the given output directory; never touches saves/ or journal/.
 * Output files are tagged with the rules version (reports/day15-134-<tag>-20seeds-*); the golden test
 * requires the committed files of the CURRENT tag to be byte-identical. Older tags (v6) are history.
 */
// @ts-nocheck -- verbatim port of an untyped report script; typed engine API is checked elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ENGINE_VERSION, simulateDay, num, resolveSpecies, foragingTemperatureFactor as ftf, legacyColonyMeta } from '../../engine/index.ts';
import { loadBundle, readJson, REPO_ROOT } from '../lib/load.ts';

/** Report file tag of the current rules version (v8 = v2-review.8). Files of earlier tags in reports/ are history. */
export const RULES_TAG = 'v22';

export function generateWinterMultiseed(outDir, bundle = loadBundle(), initial = readJson('tests/fixtures/day14-projection.json'), tag = RULES_TAG) {
const MAIN_SPECIES=legacyColonyMeta(bundle.world.scenario_colonies).species_id;
const sp=resolveSpecies(bundle.species[MAIN_SPECIES]);
const foragingTemperatureFactor=ftf;
const seeds=Array.from({length:20},(_,i)=>15032026+i);
const round=x=>Math.round(x*1e4)/1e4;
const sum=(rows,k)=>rows.reduce((t,row)=>t+(row[k]||0),0);
const avg=(rows,k)=>rows.length?round(sum(rows,k)/rows.length):null;
const csv=rows=>Object.keys(rows[0]).join(',')+'\n'+rows.map(r=>Object.keys(rows[0]).map(k=>r[k]??'').join(',')).join('\n')+'\n';
const stat=arr=>{if(!arr.length)return null;arr=[...arr].sort((a,b)=>a-b);return {min:arr[0],median:(arr[Math.floor((arr.length-1)/2)]+arr[Math.floor(arr.length/2)])/2,max:arr.at(-1)};};
const daysInMonth=(y,m)=>new Date(Date.UTC(y,m,0)).getUTCDate();
function normalAt(date,key){
 const [y,m,d]=date.split('-').map(Number),rows=initial.climate.monthly;
 if(d>=15)return rows[m-1][key]+(rows[m%12][key]-rows[m-1][key])*(d-15)/daysInMonth(y,m);
 const previous=m===1?12:m-1,py=m===1?y-1:y,frac=(daysInMonth(py,previous)-15+d)/daysInMonth(py,previous);
 return rows[previous-1][key]+(rows[m-1][key]-rows[previous-1][key])*frac;
}
assert.equal(initial.sim_day,14);
assert.ok(initial.climate.monthly.every(m=>m.mean_daily_maximum_air_temperature_c>m.mean_air_temperature_c&&m.mean_daily_minimum_air_temperature_c<m.mean_air_temperature_c));
assert.equal(num(bundle.species[MAIN_SPECIES],'metabolism.q10'),2);
assert.ok(foragingTemperatureFactor(sp,15)<foragingTemperatureFactor(sp,25));
const noFood=structuredClone(initial);noFood.colony.sugar=0;noFood.colony.protein=0;
assert.deepEqual(simulateDay(initial,bundle).state.ecology,simulateDay(noFood,bundle).state.ecology,'natural insects independent of ant food balances');
const orphan=structuredClone(initial);orphan.population.workers=[];orphan.population.queen_alive=false;orphan.population.brood=orphan.population.brood.filter(b=>b.stage==='larva');orphan.colony.sugar=8;orphan.colony.protein=6;
let unattended=orphan;
for(let i=0;i<num(bundle.species[MAIN_SPECIES],'brood_care.unattended_larva_max_days');i++){
 const o=simulateDay(unattended,bundle);
 assert.equal(o.summary.consumed.sugar,0);
 assert.equal(o.summary.consumed.protein,0);
 assert.equal(o.state.colony.sugar,8);
 assert.equal(o.state.colony.protein,6);
 unattended=o.state;
}
assert.equal(unattended.population.brood.filter(b=>b.stage==='larva').length,0,'ghost brood');
const daily=[],weekly=[],seedResults=[],neighbor365=[];
for(const seed of seeds){
 let state=structuredClone(initial);state.seed=seed;
 const records=[];let totalInsectBirths=0,totalInsectDeaths=0,firstExtinct=null;
 let prevInsects=state.ecology.adjacent_garden_living_insects+Object.values(state.ecology.insects_by_site).reduce((t,x)=>t+x.living,0);
 for(let k=0;k<120;k++){
  const o=simulateDay(state,bundle),x=o.summary,z=o.state;
  if(k===0||k===119)assert.deepEqual(o,simulateDay(state,bundle),'replay endpoints per seed');
  const births=o.events.filter(e=>e.type==='insect_population_birth').reduce((t,e)=>t+e.individuals,0);const antPreyKills=o.events.filter(e=>e.type==='insect_predation').length;
  const deaths=o.events.filter(e=>e.type==='insect_background_death').reduce((t,e)=>t+e.individuals,0)+o.events.filter(e=>e.type==='insect_natural_death').length+o.events.filter(e=>e.type==='insect_predation').length;
  const now=z.ecology.adjacent_garden_living_insects+Object.values(z.ecology.insects_by_site).reduce((t,p)=>t+p.living,0);
  assert.equal(now,prevInsects+births-deaths,'insect births/deaths balance');
  assert.ok(z.ecology.adjacent_garden_living_insects<=num(bundle.world,'insects.insect_boundary_carrying_capacity'));
  for(const loc of Object.values(z.ecology.insects_by_site))assert.ok(loc.living<=loc.carrying_capacity);
  prevInsects=now;totalInsectBirths+=births;totalInsectDeaths+=deaths;
  assert.equal(x.metabolic_factor,Math.round(Math.pow(2,(x.weather.nest_temp_model_c-25)/10)*1e6)/1e6);
  assert.ok(Number.isFinite(x.ratios.sugar)&&x.ratios.sugar>=0&&x.ratios.sugar<=1,'valid sugar satisfied ratio');
  assert.ok(Number.isFinite(x.ratios.protein)&&x.ratios.protein>=0&&x.ratios.protein<=1,'valid protein satisfied ratio');
  assert.ok(x.weather.daily_min_air_temp_c<=x.weather.air_temp_c&&x.weather.air_temp_c<=x.weather.daily_max_air_temp_c);
  const d={seed,day:o.day,date:x.date,month:x.date.slice(0,7),queen:x.population.queen,workers:x.population.workers,eggs:x.population.eggs,larvae:x.population.larvae,pupae:x.population.pupae,
   air_mean_c:x.weather.air_temp_c,daytime_max_air_c:x.weather.daytime_air_temp_c,air_min_c:x.weather.daily_min_air_temp_c,nest_temp_c:x.weather.nest_temp_model_c,
   expected_air_normal_c:round(normalAt(x.date,'mean_air_temperature_c')),temperature_residual_c:round(x.weather.air_temp_c-normalAt(x.date,'mean_air_temperature_c')),
   foraging_factor:foragingTemperatureFactor(sp,x.weather.daytime_air_temp_c),metabolic_factor:x.metabolic_factor,laying_temp_factor:x.queen_laying_temperature_factor,
   route_steps:o.events.filter(e=>e.type==='route_step').length,trail_deposits:o.events.filter(e=>e.type==='trail_deposited').length,trail_decays:o.events.filter(e=>e.type==='trail_decay').length,active_trail_edges:Object.keys(z.ecology.trail_by_edge||{}).length,trophallaxis_events:o.events.filter(e=>e.type==='trophallaxis').length,trophallaxis_portions:round(o.events.filter(e=>e.type==='trophallaxis').reduce((a,e)=>a+e.portions,0)),live_prey_encounters:o.events.filter(e=>e.type==='live_prey_encounter').length,live_prey_kills:antPreyKills,local_recruits:o.events.filter(e=>e.type==='local_recruitment').length,foragers:x.tasks.forage,foraging_fraction_per_available_worker:round(x.workers_before>0?x.tasks.forage/x.workers_before:0),queen_laying_probability:x.queen_laying_probability_applied,foragers_sugar:x.foraging_workers_by_macro.sugar,foragers_protein:x.foraging_workers_by_macro.protein,
   sugar_income:x.income.sugar,sugar_consumed:x.consumed.sugar,sugar_demand:x.demand.sugar,sugar_fraction:round(x.ratios.sugar),sugar_store:x.stock.sugar,
   protein_income:x.income.protein,protein_consumed:x.consumed.protein,protein_demand:x.demand.protein,protein_fraction:round(x.ratios.protein),protein_store:x.stock.protein,
   eggs_laid:x.eggs_laid,worker_deaths:x.worker_deaths,starvation_linked_worker_deaths:o.events.filter(e=>e.type==='worker_death'&&e.reason.includes('starvation')).length,
   queen_death_event:o.events.filter(e=>e.type==='queen_death').length,brood_deaths:x.brood_deaths,sugar_gap_days:x.starvation.sugar_gap_days,protein_gap_days:x.starvation.protein_gap_days,
   insects_F07:z.ecology.insects_by_site.F07.living,insects_F11:z.ecology.insects_by_site.F11.living,insects_adjacent:z.ecology.adjacent_garden_living_insects,insect_births:births,insect_deaths:deaths};
  if(!firstExtinct&&d.queen===0&&d.workers===0)firstExtinct={day:d.day,date:d.date};
  records.push(d);daily.push(d);state=z;
 }
 for(let start=0;start<records.length;start+=7){
  const a=records.slice(start,start+7),last=a.at(-1);
  weekly.push({seed,week:Math.floor(start/7)+1,start_day:a[0].day,end_day:last.day,from:a[0].date,to:last.date,queen:last.queen,workers:last.workers,eggs:last.eggs,larvae:last.larvae,pupae:last.pupae,
   mean_daytime_max_air_c:avg(a,'daytime_max_air_c'),route_steps:sum(a,'route_steps'),trail_deposits:sum(a,'trail_deposits'),trophallaxis_events:sum(a,'trophallaxis_events'),trophallaxis_portions:round(sum(a,'trophallaxis_portions')),live_prey_encounters:sum(a,'live_prey_encounters'),live_prey_kills:sum(a,'live_prey_kills'),local_recruits:sum(a,'local_recruits'),active_trail_edges:last.active_trail_edges,mean_air_temperature_c:avg(a,'air_mean_c'),mean_nest_temperature_c:avg(a,'nest_temp_c'),mean_metabolic_factor:avg(a,'metabolic_factor'),
   mean_daily_foragers:avg(a,'foragers'),mean_worker_foraging_fraction:avg(a,'foraging_fraction_per_available_worker'),mean_queen_laying_probability:avg(a,'queen_laying_probability'),foraging_worker_days:sum(a,'foragers'),eggs_laid:sum(a,'eggs_laid'),
   sugar_income:round(sum(a,'sugar_income')),sugar_consumed:round(sum(a,'sugar_consumed')),mean_daily_sugar_consumed:avg(a,'sugar_consumed'),sugar_balance:round(sum(a,'sugar_income')-sum(a,'sugar_consumed')),sugar_store:last.sugar_store,
   protein_income:round(sum(a,'protein_income')),protein_consumed:round(sum(a,'protein_consumed')),mean_daily_protein_consumed:avg(a,'protein_consumed'),protein_balance:round(sum(a,'protein_income')-sum(a,'protein_consumed')),protein_store:last.protein_store,
   insects_F07:last.insects_F07,insects_F11:last.insects_F11,insects_adjacent:last.insects_adjacent,insect_births:sum(a,'insect_births'),insect_deaths:sum(a,'insect_deaths')});
 }
 const extinctIndex=firstExtinct?firstExtinct.day-15:-1;
 const window=extinctIndex>=0?records.slice(Math.max(0,extinctIndex-13),extinctIndex+1):records.slice(-14);
 const sugarShort=window.filter(r=>r.sugar_fraction<.99).length,proteinShort=window.filter(r=>r.protein_fraction<.99).length;
 const naturalDeaths=sum(window,'worker_deaths')-sum(window,'starvation_linked_worker_deaths');
 const populationLow=window.filter(r=>r.workers<=3).length;
 const candidates=[['缺糖',sugarShort],['缺蛋白',proteinShort],['自然死亡',naturalDeaths],['人口過少',populationLow]];
 const mainMechanism=firstExtinct?candidates.sort((a,b)=>b[1]-a[1])[0][0]:'未全滅';
 seedResults.push({seed,first_extinct_day:firstExtinct?.day??null,first_extinct_date:firstExtinct?.date??null,
  winter_extinct:Boolean(firstExtinct&&firstExtinct.date>='2026-12-01'&&firstExtinct.date<='2027-02-28'),
  main_mechanism_heuristic:mainMechanism,prev14_sugar_short_days:sugarShort,prev14_protein_short_days:proteinShort,prev14_natural_worker_deaths:naturalDeaths,prev14_low_population_days:populationLow,
  queen_Day74:records[59].queen,workers_Day74:records[59].workers,queen_Day134:records.at(-1).queen,workers_Day134:records.at(-1).workers,
  sugar_income:round(sum(records,'sugar_income')),sugar_consumed:round(sum(records,'sugar_consumed')),protein_income:round(sum(records,'protein_income')),protein_consumed:round(sum(records,'protein_consumed')),trophallaxis_events:sum(records,'trophallaxis_events'),trail_deposits:sum(records,'trail_deposits'),live_prey_kills:sum(records,'live_prey_kills'),
  insect_births:totalInsectBirths,insect_deaths:totalInsectDeaths,adjacent_start:initial.ecology.adjacent_garden_living_insects,adjacent_Day134:records.at(-1).insects_adjacent});
 // Independent ecological persistence check through Day365, NOT official game progress.
 if(neighbor365.length<8){
  let low=state.ecology.adjacent_garden_living_insects,min=low,max=low,births=0,deaths=0;
  while(state.sim_day<365){const o=simulateDay(state,bundle);state=o.state;const n=state.ecology.adjacent_garden_living_insects;min=Math.min(min,n);max=Math.max(max,n);
   births+=o.events.filter(e=>e.type==='insect_population_birth'&&e.site==='adjacent_garden_habitat').reduce((a,e)=>a+e.individuals,0);
   deaths+=o.events.filter(e=>e.type==='insect_background_death'&&e.site==='adjacent_garden_habitat').reduce((a,e)=>a+e.individuals,0);}
  neighbor365.push({seed,adjacent_Day134:low,adjacent_Day365:state.ecology.adjacent_garden_living_insects,adjacent_min_Day135_365:min,adjacent_max_Day135_365:max,births_Day135_365:births,deaths_Day135_365:deaths});
 }
}
const winter=seedResults.filter(x=>x.winter_extinct),allExtinct=seedResults.filter(x=>x.first_extinct_day!==null);
const monthly=[];for(const month of [...new Set(daily.map(d=>d.month))].sort()){const rows=daily.filter(d=>d.month===month),alive=rows.filter(d=>d.queen>0);monthly.push({month,mean_air_c:avg(rows,'air_mean_c'),mean_daytime_air_c:avg(rows,'daytime_max_air_c'),mean_normal_c:avg(rows,'expected_air_normal_c'),mean_residual_c:avg(rows,'temperature_residual_c'),mean_daily_foragers_all_seeds:avg(rows,'foragers'),mean_daily_foragers_colonies_queen_alive:avg(alive,'foragers'),mean_per_worker_foraging_fraction:avg(alive,'foraging_fraction_per_available_worker'),mean_laying_probability:avg(alive,'queen_laying_probability'),mean_daily_eggs_all_seeds:avg(rows,'eggs_laid'),mean_daily_eggs_queen_alive:avg(alive,'eggs_laid'),queen_alive_day_count:alive.length});}
const report={schema:`antempire.winter.${tag}.physical_foraging.multiseed`,engine_version:ENGINE_VERSION,range:'Day15-134 2026-11-14 through 2027-03-13',official_day14_advanced:false,pr_merged:false,seeds,seed_count:seeds.length,
 assumptions:true,evidence_policy:'Q10=2.0 physiology reference is assumption; CWA normals measured station means; synthetic daily max air is proxy, NOT surface measurement; queen Q10 and unattended days are game assumptions.',
 winter_extinct_count:winter.length,winter_extinct_ratio:round(winter.length/seeds.length),extinct_by_Day134_count:allExtinct.length,
 day74_workers:stat(seedResults.map(x=>x.workers_Day74)),day134_workers:stat(seedResults.map(x=>x.workers_Day134)),
 day134_queens_alive:seedResults.filter(x=>x.queen_Day134>0).length,
 mean_temperature_residual_across_all_seed_days_c:avg(daily,'temperature_residual_c'),
 monthly,seed_results:seedResults,adjacent_insect_long_run_8_fixed_seeds:neighbor365,
 classifications:'Main mechanism is an explicitly heuristic largest 14-day preceding indicator; not verified causal attribution. Sugar/protein: days with fractional ration <0.99; natural deaths: count minus starvation-tagged deaths; population low: days <=3 workers; ties unresolved. Missing protein intake alone is not malnutrition if stored protein feeds colony.',
 validations:{days_per_seed:120,deterministic_first_last_per_seed:true,insect_balance_checked_each_day:true,capacity_checked_each_day:true,ecology_independent_of_colony_stock:true,orphan_larvae_die_within_four_assumed_days:true,unattended_stores_not_consumed:true},
 no_rescue_tuning:true,workforce_recovery_not_guaranteed:true,limitations:['One proxy daily maximum air temperature, not hour-by-hour ground-surface temperatures.','20 seeds share identical hypothetical Day14 garden and legacy ages.','Nectar flowering recurrence remains unmodeled. Live prey hunting now uses only existing insects at F07/F11; size and capture odds are assumed.','Minor worker natural lifespan differs from R94 ~26.25 days; current assumed untreated natural expectancy ~64.3 days, unchanged.','Garden route lengths are hypothetical and time is simplified into per-trip minutes, not observed trajectory.','Larval protein deliveries remain pooled nursing approximations.','No calibrated major/minor prey role differentiation.','This is a game scenario and cannot estimate real Taichung colony winter extinction probabilities.']};
fs.mkdirSync(outDir,{recursive:true});
fs.writeFileSync(path.join(outDir,`day15-134-${tag}-20seeds-daily.csv`),csv(daily));
fs.writeFileSync(path.join(outDir,`day15-134-${tag}-20seeds-weekly.csv`),csv(weekly));
fs.writeFileSync(path.join(outDir,`day15-134-${tag}-20seeds-analysis.json`),JSON.stringify(report,null,2)+'\n');
return {report,summary:{seeds:seeds.length,winter_extinct:report.winter_extinct_count,by134:report.extinct_by_Day134_count,day74:report.day74_workers,day134:report.day134_workers,months:monthly,neighbors:neighbor365}};
}

if (import.meta.main) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, 'reports');
  console.log(JSON.stringify(generateWinterMultiseed(outDir).summary, null, 2));
}

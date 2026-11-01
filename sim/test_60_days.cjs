'use strict';
/** Isolated 60-day diagnostic. Does not write save files, GitHub or main. */
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=__dirname,dir=path.resolve(root,'../reports');fs.mkdirSync(dir,{recursive:true});
const initial=JSON.parse(fs.readFileSync(path.join(root,'day14-projection.json'))),base=JSON.parse(fs.readFileSync(path.join(root,'params.json')));
const {simulateDay}=require('./day_engine.cjs');
function run(name,settings){let s=structuredClone(initial),p=structuredClone(base);
 if(name==='sugar-only-1.5x'){p.sources.honeydew_productivity_multiplier.value=1.5;}
 if(name==='no-food'){
  s.colony.sugar=0;s.colony.protein=0;
  for(const site of Object.values(s.sources)){site.sugar=0;site.protein=0;if(site.batches)site.batches=[];if(site.type==='honeydew'){site.host_plants=0;site.hemipteran_colonies=0;site.host_alive=false;}if(site.type==='nectar'){site.host_alive=false;site.bloom_days_left=0;site.production_per_day=0;}}
  s.ecology.adjacent_garden_living_insects=0;for(const pop of Object.values(s.ecology.insects_by_site))pop.living=0;
  p.sources.insect_background_immigration_probability.value=0;
  // Physically empty garden counterfactual, not a mortality override or live-world instruction.
 }
 let prev=s,total={income_sugar:0,income_protein:0,consume_sugar:0,consume_protein:0,egg_sugar:0,egg_protein:0,worker_deaths:0,brood_deaths:0,eggs_laid:0,hatchings:0,pupations:0,eclosions:0},rows=[],allEvents=[],firstEggs=new Set(['E001','E002','E003','E004','E005']),newEggIDs=new Set(),eclosedNewEggs=new Set(),stageOriginal={L001:{},L002:{}};
 for(let i=0;i<60;i++){
  const out=simulateDay(s,p),replay=simulateDay(s,p);assert.equal(JSON.stringify(out),JSON.stringify(replay),'deterministic replay');
  const x=out.summary,remains=out.state.population.brood;for(const e of out.events){if(e.type==='egg_laid')newEggIDs.add(e.id);if(e.type==='eclosion'&&newEggIDs.has(e.source_brood_id))eclosedNewEggs.add(e.source_brood_id);if(e.type==='pupation'&&(e.id==='L001'||e.id==='L002'))stageOriginal[e.id].pupa_day=out.day;if(e.type==='eclosion'&&(e.source_brood_id==='L001'||e.source_brood_id==='L002'))stageOriginal[e.source_brood_id].eclosion_day=out.day;}
  const ec=Object.values(out.state.sources).filter(z=>z.type==='honeydew');let ecoProduced=ec.reduce((sum,z)=>sum+(z.production_last_day||0),0),activeEcoSources=ec.filter(z=>z.host_alive&&z.hemipteran_colonies>0).length;
  const row={day:out.day,date:x.date,queen:x.population.queen,workers:x.population.workers,eggs:x.population.eggs,larvae:x.population.larvae,pupae:x.population.pupae,
   sugar_store:x.stock.sugar,protein_store:x.stock.protein,sugar_income:x.income.sugar,protein_income:x.income.protein,sugar_consumed:x.consumed.sugar,protein_consumed:x.consumed.protein,
   sugar_demand:x.demand.sugar,protein_demand:x.demand.protein,egg_sugar_cost:x.mass_ledger.egg_laying.sugar,egg_protein_cost:x.mass_ledger.egg_laying.protein,
   foraging_sugar_workers:x.foraging_workers_by_macro.sugar,foraging_protein_workers:x.foraging_workers_by_macro.protein,foraging_trips:x.foraging_trips,foraging_successes:x.foraging_successes,
   honeydew_ecosystem_net_production:Math.round(ecoProduced*1e5)/1e5,active_hemipteran_sites:activeEcoSources,rain_mm:x.weather.rain_mm,temperature_c:x.weather.air_temp_c,
   sugar_gap_days:x.starvation.sugar_gap_days,protein_gap_days:x.starvation.protein_gap_days,eggs_laid:x.eggs_laid,hatched:x.hatchings,pupated:x.pupations,eclosed:x.eclosions,worker_deaths:x.worker_deaths,brood_deaths:x.brood_deaths};
  rows.push(row);for(const key of Object.keys(total)){if(key.startsWith('income_'))total[key]+=x.income[key.split('_')[1]];else if(key.startsWith('consume_'))total[key]+=x.consumed[key.split('_')[1]];else if(key.startsWith('egg_')&&key.endsWith('_cost'))total[key]=0;else if(key==='egg_sugar')total[key]+=x.mass_ledger.egg_laying.sugar;else if(key==='egg_protein')total[key]+=x.mass_ledger.egg_laying.protein;else total[key]+=x[key]??0;}
  allEvents.push(...out.events.map(e=>({...e,day:out.day})));
  assert.ok(x.stock.sugar>=0&&x.stock.protein>=0,'stores nonnegative');assert.equal(Object.values(x.tasks).reduce((a,b)=>a+b,0),x.workers_before,'all workers assigned');
  s=out.state;
 }
 const sums=key=>rows.reduce((t,r)=>t+r[key],0),num=n=>Math.round(n*1e4)/1e4;
 const baselineCriteria={workers_at_least_70_percent:s.population.workers.length>=Math.ceil(14*.7),L001_pupated_and_eclosed:!!stageOriginal.L001.pupa_day&&!!stageOriginal.L001.eclosion_day,L002_pupated_and_eclosed:!!stageOriginal.L002.pupa_day&&!!stageOriginal.L002.eclosion_day,queen_laid_by_Day30:rows.some(r=>r.day<=30&&r.eggs_laid>0),new_v2_egg_completed_cycle:eclosedNewEggs.size>0};
 const criteria=name==='no-food'?{all_colony_extinct:!s.population.queen_alive&&s.population.workers.length===0&&s.population.brood.length===0,no_external_supply:rows.every(r=>r.sugar_income===0&&r.protein_income===0),no_new_eggs:sums('eggs_laid')===0}:{...baselineCriteria};
 const analysis={scenario:name,days:60,range:'Day15-Day74',authoritative_simulation_advanced:false,base_day14_source:'sim/day14-projection.json (read-only projection)',all_numbers_game_assumptions:true,single_changed_variable:name==='sugar-only-1.5x'?'sources.honeydew_productivity_multiplier 1.0 -> 1.5':name==='no-food'?'counterfactual zero existing life/food and disable immigration (not a single-variable test)':'none',
  final:rows.at(-1),total:{sugar_income:num(sums('sugar_income')),protein_income:num(sums('protein_income')),sugar_consumption:num(sums('sugar_consumed')),protein_consumption:num(sums('protein_consumed')),sugar_demand:num(sums('sugar_demand')),protein_demand:num(sums('protein_demand')),foraging_sugar_worker_days:sums('foraging_sugar_workers'),foraging_protein_worker_days:sums('foraging_protein_workers'),worker_deaths:sums('worker_deaths'),brood_deaths:sums('brood_deaths'),eggs_laid:sums('eggs_laid'),hatchings:sums('hatched'),pupations:sums('pupated'),eclosions:sums('eclosed')},
  ecosystem:{initial_honeydew_sources:Object.entries(initial.sources).filter(([id,site])=>site.type==='honeydew').map(([id,z])=>({id,host_plants:z.host_plants,hemipteran_colonies:z.hemipteran_colonies,hemipteran_kind:z.hemipteran_kind,host_alive:z.host_alive})),average_daily_produced_honeydew:num(sums('honeydew_ecosystem_net_production')/60),average_daily_sugar_demand:num(sums('sugar_demand')/60),gross_production_to_demand_ratio:num(sums('honeydew_ecosystem_net_production')/sums('sugar_demand')),average_daily_delivered_sugar:num(sums('sugar_income')/60),delivered_sugar_to_demand_ratio:num(sums('sugar_income')/sums('sugar_demand'))},
  initial_L_stage:stageOriginal,new_eggs_completed_life_cycle:[...eclosedNewEggs],max_sugar_gap:Math.max(...rows.map(r=>r.sugar_gap_days)),max_protein_gap:Math.max(...rows.map(r=>r.protein_gap_days)),criteria,passed:Object.values(criteria).every(Boolean),replay_exact:true};
 const target=path.join(dir,`${name}-day15-74`);fs.writeFileSync(target+'.json',JSON.stringify({analysis,rows,events:allEvents},null,2)+'\n');const cols=Object.keys(rows[0]);fs.writeFileSync(target+'.csv',[cols.join(','),...rows.map(r=>cols.map(k=>r[k]).join(','))].join('\n')+'\n');fs.writeFileSync(target+'-analysis.json',JSON.stringify(analysis,null,2)+'\n');return analysis;
}
const scenarios=['baseline','sugar-only-1.5x','no-food'];const reports=scenarios.map(s=>run(s));console.log(JSON.stringify(reports,null,2));

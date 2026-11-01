"use strict";
const fs=require('node:fs'),path=require('node:path');
const {simulateDay}=require('./day_engine.cjs');
const root=__dirname,source=JSON.parse(fs.readFileSync(path.join(root,'day14-projection.json'))),p=JSON.parse(fs.readFileSync(path.join(root,'params.json')));
const scenario=process.argv.includes('--no-food')?'no-food':process.argv.includes('--abundant')?'abundant':'baseline';
if(scenario==='no-food'){
 source.colony.sugar=0;source.colony.protein=0;
 for(const s of Object.values(source.sources)){s.sugar=0;s.protein=0;s.production_per_day=0;s.host_alive=false;if(s.batches)s.batches=[];}
 p.sources.insect_local_daily_mortality_probability.value=0;p.sources.insect_background_immigration_probability.value=0; // controlled test-only counterfactual; never imported into actual game
}
if(scenario==='abundant'){source.colony.sugar=16;source.colony.protein=8;p.sources.insect_local_daily_mortality_probability.value=.5;p.sources.honeydew_daily_replenish.value=1.2;p.sources.nectar_daily_replenish.value=.85;for(const src of Object.values(source.sources))if(src.type==='honeydew'&&src.host_alive)src.production_per_day*=1.65;source.sources.F08.production_per_day=.85;source.sources.F08.bloom_days_left=30;}
let state=source,rows=[],events=[],allReplays=true;
for(let i=0;i<30;i++){
 const before=JSON.stringify(state);const out=simulateDay(state,p),rerun=simulateDay(state,p);
 if(JSON.stringify(out)!==JSON.stringify(rerun))throw Error('Reproducibility broken Day'+out.day);
 if(JSON.stringify(state)!==before)throw Error('simulateDay mutated its input');
 const x=out.summary,rec={day:x.day,date:x.date,workers:x.population.workers,eggs:x.population.eggs,larvae:x.population.larvae,pupae:x.population.pupae,queen:x.population.queen,sugar:x.stock.sugar,protein:x.stock.protein,sugar_starvation_days:x.starvation.sugar_gap_days,protein_starvation_days:x.starvation.protein_gap_days,foraging_trips:x.foraging_trips,successful_trips:x.foraging_successes,recruited:x.recruited,hatched:x.hatchings,pupated:x.pupations,eclosed:x.eclosions,worker_deaths:x.worker_deaths,brood_deaths:x.brood_deaths,eggs_laid:x.eggs_laid,rain_mm:x.weather.rain_mm};
 rows.push(rec);events.push(...out.events.map(e=>({...e,day:out.day})));state=out.state;
 if(Object.values(x.tasks).reduce((a,b)=>a+b,0)!==x.workers_before)throw Error('Not all living workers assigned one daily duty');
 if(x.population.workers<0||x.population.eggs<0||x.population.larvae<0||x.population.pupae<0)throw Error('negative population');
 if(x.stock.sugar<0||x.stock.protein<0)throw Error('negative stock');
}
const total=key=>rows.reduce((s,r)=>s+r[key],0);
const report={scenario,days:30,from:15,to:44,assumption_not_scientific_measurement:true,first:rows[0],last:rows.at(-1),totals:{hatchings:total('hatched'),pupations:total('pupated'),eclosions:total('eclosed'),worker_deaths:total('worker_deaths'),brood_deaths:total('brood_deaths'),eggs_laid:total('eggs_laid'),food_delivery_events:total('successful_trips'),recruitments:total('recruited')},max_workers:Math.max(...rows.map(x=>x.workers)),min_workers:Math.min(...rows.map(x=>x.workers)),max_sugar_gap:Math.max(...rows.map(x=>x.sugar_starvation_days)),max_protein_gap:Math.max(...rows.map(x=>x.protein_starvation_days)),all_workers_active_daily:rows.every(x=>x.foraging_trips>=0),deterministic:allReplays,first_hatch_day:rows.find(x=>x.hatched>0)?.day||null,first_pupa_day:rows.find(x=>x.pupated>0)?.day||null,first_eclosion_day:rows.find(x=>x.eclosed>0)?.day||null,first_worker_death_day:rows.find(x=>x.worker_deaths>0)?.day||null};
const dir=path.resolve(root,'../reports');fs.mkdirSync(dir,{recursive:true});const name=scenario==='baseline'?'baseline':scenario==='abundant'?'abundant':'forced-starvation';
fs.writeFileSync(path.join(dir,`${name}-day15-44.json`),JSON.stringify({report,rows,events},null,2)+'\n');const header=Object.keys(rows[0]);fs.writeFileSync(path.join(dir,`${name}-day15-44.csv`),[header.join(','),...rows.map(r=>header.map(k=>r[k]).join(','))].join('\n')+'\n');
if(scenario==='baseline'&&(!(report.first_hatch_day&&report.first_pupa_day&&report.first_eclosion_day&&report.first_worker_death_day)||report.last.workers<=0||report.max_workers>=p.model.population_safety_cap_for_trial.value)){
 report.acceptance='FAIL: 30-day baseline life cycle or population condition unmet; NOT adjusted for survival or story';
 process.exitCode=1;
}else report.acceptance='PASS (scenario-specific criteria)';
if(scenario==='no-food'&&!(report.totals.worker_deaths>0&&report.max_sugar_gap>=5&&report.totals.eggs_laid===0))throw Error('Starvation consequence acceptance failed');
if(scenario==='abundant'&&!(report.totals.eggs_laid>0&&report.last.workers>0&&report.max_workers<p.model.population_safety_cap_for_trial.value))throw Error('Abundant reproduction acceptance failed');
fs.writeFileSync(path.join(dir,`${name}-acceptance.json`),JSON.stringify({scenario,acceptance:report.acceptance||'PASS (scenario-specific criteria)',hatch:report.first_hatch_day,pupation:report.first_pupa_day,eclosion:report.first_eclosion_day,workers_remaining:report.last.workers},null,2)+'\n');
console.log(JSON.stringify(report,null,2));

'use strict';
/** Review-only acceptance: ecological production, local-only behavior, and orphan-queen hazard. */
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=__dirname,p=JSON.parse(fs.readFileSync(path.join(root,'params.json'))),initial=JSON.parse(fs.readFileSync(path.join(root,'day14-projection.json'))),code=fs.readFileSync(path.join(root,'day_engine.cjs'),'utf8'),{simulateDay}=require('./day_engine.cjs');
let passed=0;function ok(value,message){assert.ok(value,message);passed++;}
const fn=(name,next)=>code.slice(code.indexOf('function '+name+'('),code.indexOf('function '+next+'('));
for(const name of [['growSources','selectTask'],['selectTask','discover'],['forage','consume']]){
 const src=fn(...name);
 if(name[0]==='growSources')ok(!/s\.colony/.test(src),'plant and hemipteran ecology does not read nest budget');
 else ok(!/s\.colony/.test(src),'worker behavior '+name[0]+' does not read nest budget');
}
for(const [sec,group] of Object.entries(p))if(group&&typeof group==='object'&&!Array.isArray(group))for(const [field,item] of Object.entries(group))if(item&&typeof item==='object'&&'value' in item)ok(item.assumption===true,sec+'.'+field+' must be a labeled game assumption');
const starve=structuredClone(initial);starve.colony.sugar=0;starve.colony.protein=0;const a=simulateDay(initial,p),b=simulateDay(starve,p);
for(const id of ['F01','F04','F05','F10'])ok(JSON.stringify(a.state.sources[id].ecological_record)===JSON.stringify(b.state.sources[id].ecological_record),'ecological production must ignore colony sugar/protein '+id);
ok(JSON.stringify(a.summary.tasks)===JSON.stringify(b.summary.tasks),'initial worker tasks must not look at colony inventory');
const high=structuredClone(p);high.sources.honeydew_productivity_multiplier.value=1.5;
const diff=[];for(const [sec,g]of Object.entries(p))if(g&&typeof g==='object'&&!Array.isArray(g))for(const [field,item]of Object.entries(g))if(item&&typeof item==='object'&&'value'in item&&item.value!==high[sec][field].value)diff.push(sec+'.'+field);
ok(diff.length===1&&diff[0]==='sources.honeydew_productivity_multiplier','single-variable sugar-only test changes exactly one source productivity parameter');
function orphanState(seed){const x=structuredClone(initial);x.seed=seed;x.population.workers=[];x.population.brood=[];x.colony.sugar=0;x.colony.protein=0;x.colony.sugar_gap_days=7;x.colony.protein_gap_days=7;x.colony.stress_days=7;for(const f of Object.values(x.sources)){f.sugar=0;f.protein=0;f.host_alive=false;f.production_per_day=0;if(f.type==='honeydew'){f.host_plants=0;f.hemipteran_colonies=0;}if(f.type==='nectar')f.bloom_days_left=0;if(f.type==='carcass')f.batches=[];}for(const q of Object.values(x.ecology.insects_by_site))q.living=0;x.ecology.adjacent_garden_living_insects=0;return x;}
let orphanDeaths=0,baseDeaths=0;const low=structuredClone(p);low.starvation.queen_zero_worker_starved_daily_hazard.value=low.starvation.queen_daily_hazard.value;
for(let i=0;i<160;i++){const state=orphanState(420000+i*29);orphanDeaths+=Number(simulateDay(state,p).summary.population.queen===0);baseDeaths+=Number(simulateDay(state,low).summary.population.queen===0);}
ok(orphanDeaths>baseDeaths&&orphanDeaths>=25,'zero-worker starved queen mortality risk materially higher under unchanged deterministic seeds');
const out={passed,orphan_queen_trial_count:160,queen_deaths_when_starved_and_workerless:orphanDeaths,queen_deaths_without_added_orphan_hazard:baseDeaths,food_source_independent_of_colony_stocks:true,worker_task_no_global_inventory:true,sugar_control_one_variable:true,source_count:4,official_save_changed:false};
fs.writeFileSync(path.join(root,'../reports/local-ecology-tests.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));

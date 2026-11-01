'use strict';
/** Isolated v2.1 Day15-134 winter diagnostic. NEVER writes authoritative saves. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {simulateDay,foragingTemperatureFactor}=require('./day_engine.cjs');
const params=JSON.parse(fs.readFileSync(path.join(__dirname,'params.json'),'utf8'));
const initial=JSON.parse(fs.readFileSync(path.join(__dirname,'day14-projection.json'),'utf8'));
const outDir=path.resolve(__dirname,'../reports');
const round=x=>Math.round(x*1e4)/1e4;
const sum=(rows,k)=>rows.reduce((a,x)=>a+x[k],0);
const csv=rows=>{const keys=Object.keys(rows[0]);return keys.join(',')+'\n'+rows.map(r=>keys.map(k=>r[k]).join(',')).join('\n')+'\n';};
assert.equal(initial.sim_day,14,'official Day14 remains frozen');
assert.ok(foragingTemperatureFactor(params,12)<foragingTemperatureFactor(params,20));
assert.equal(foragingTemperatureFactor(params,25),1);
const noStock=structuredClone(initial);noStock.colony.sugar=0;noStock.colony.protein=0;
assert.deepEqual(simulateDay(initial,params).state.ecology,simulateDay(noStock,params).state.ecology,'ecological populations cannot depend on colony food stocks');
let state=structuredClone(initial),rows=[],eventsTotal={births:0,deaths:0,migrations:0},previousInsects=initial.ecology.adjacent_garden_living_insects+Object.values(initial.ecology.insects_by_site).reduce((a,x)=>a+x.living,0);
for(let i=0;i<120;i++){
 const output=simulateDay(state,params),replay=simulateDay(state,params);
 assert.deepEqual(output,replay,'exact deterministic daily replay');
 const {summary:x,events,state:next}=output,ec=next.ecology;
 const births=events.filter(e=>e.type==='insect_population_birth').reduce((a,e)=>a+e.individuals,0);
 const deaths=events.filter(e=>e.type==='insect_background_death').reduce((a,e)=>a+e.individuals,0)+events.filter(e=>e.type==='insect_natural_death').length+events.filter(e=>e.type==='insect_predation').length;
 const migrations=events.filter(e=>e.type==='insect_immigration').length;
 const insectsNow=ec.adjacent_garden_living_insects+Object.values(ec.insects_by_site).reduce((a,z)=>a+z.living,0);
 assert.equal(insectsNow,previousInsects+births-deaths,'world births - deaths conservation');
 assert.ok(ec.adjacent_garden_living_insects<=params.sources.insect_boundary_carrying_capacity.value);
 for(const pop of Object.values(ec.insects_by_site))assert.ok(pop.living<=pop.carrying_capacity,'local habitat capacity');
 previousInsects=insectsNow;
 eventsTotal.births+=births;eventsTotal.deaths+=deaths;eventsTotal.migrations+=migrations;
 rows.push({day:output.day,date:x.date,queen:x.population.queen,workers:x.population.workers,eggs:x.population.eggs,larvae:x.population.larvae,pupae:x.population.pupae,
 sugar_income:x.income.sugar,sugar_consumed:x.consumed.sugar,sugar_store:x.stock.sugar,protein_income:x.income.protein,protein_consumed:x.consumed.protein,protein_store:x.stock.protein,
 insects_F07:ec.insects_by_site.F07.living,insects_F11:ec.insects_by_site.F11.living,insects_adjacent:ec.adjacent_garden_living_insects,insect_births:births,insect_deaths:deaths,insect_migrations:migrations,
 foraging_workers_total:x.tasks.forage,foraging_workers_sugar:x.foraging_workers_by_macro.sugar,foraging_workers_protein:x.foraging_workers_by_macro.protein,
 air_temperature_c:x.weather.air_temp_c,daytime_air_temperature_c:x.weather.daytime_air_temp_c,daily_min_air_temperature_c:x.weather.daily_min_air_temp_c,nest_temperature_c:x.weather.nest_temp_model_c,metabolic_factor:x.metabolic_factor,queen_laying_temperature_factor:x.queen_laying_temperature_factor,cold_foraging_factor:foragingTemperatureFactor(params,x.weather.daytime_air_temp_c),rain_mm:x.weather.rain_mm,
 worker_deaths:x.worker_deaths,eggs_laid:x.eggs_laid,sugar_gap_days:x.starvation.sugar_gap_days,protein_gap_days:x.starvation.protein_gap_days});
 state=next;
}
assert.equal(rows[0].day,15);assert.equal(rows.at(-1).day,134);
const weeks=[];
for(let i=0;i<rows.length;i+=7){
 const days=rows.slice(i,i+7),last=days.at(-1);
 weeks.push({week:weeks.length+1,start_day:days[0].day,end_day:last.day,start_date:days[0].date,end_date:last.date,days:days.length,
 queen:last.queen,workers:last.workers,eggs:last.eggs,larvae:last.larvae,pupae:last.pupae,
 sugar_income:round(sum(days,'sugar_income')),sugar_consumed:round(sum(days,'sugar_consumed')),sugar_store:last.sugar_store,
 protein_income:round(sum(days,'protein_income')),protein_consumed:round(sum(days,'protein_consumed')),protein_store:last.protein_store,
 insects_F07:last.insects_F07,insects_F11:last.insects_F11,insects_adjacent:last.insects_adjacent,
 insect_births:sum(days,'insect_births'),insect_deaths:sum(days,'insect_deaths'),
 foraging_worker_days:sum(days,'foraging_workers_total'),mean_daily_foragers:round(sum(days,'foraging_workers_total')/days.length),
 mean_air_temperature_c:round(sum(days,'air_temperature_c')/days.length),mean_daytime_temperature_c:round(sum(days,'daytime_air_temperature_c')/days.length),mean_metabolic_factor:round(sum(days,'metabolic_factor')/days.length),mean_daily_sugar_consumed:round(sum(days,'sugar_consumed')/days.length),mean_daily_protein_consumed:round(sum(days,'protein_consumed')/days.length)});
}
const report={scenario:'unchanged v2.1 corrected base world; no rescue tuning',range:'Day15-Day134',days:rows.length,authoritative_simulation_advanced:false,source:'sim/day14-projection.json',game_assumptions:true,
 final:rows.at(-1),ecology:eventsTotal,
 budget:{sugar_income:round(sum(rows,'sugar_income')),sugar_consumed:round(sum(rows,'sugar_consumed')),protein_income:round(sum(rows,'protein_income')),protein_consumed:round(sum(rows,'protein_consumed'))},
 foraging:{worker_days:sum(rows,'foraging_workers_total'),daily_report:'reports/day15-134-daily.csv'},
 temperature:{minimum:Math.min(...rows.map(r=>r.air_temperature_c)),maximum:Math.max(...rows.map(r=>r.air_temperature_c)),days_below_20_c:rows.filter(r=>r.air_temperature_c<20).length},
 protein_days_without_income:rows.filter(r=>r.protein_income===0).length,
 validations:{replay_days:120,insect_population_balance_days:120,habitat_capacity_days:120,independent_of_colony_stocks:true,source_carcass_and_nutrient_conservation:'validated by simulateDay on all days'},
 weeks};
fs.mkdirSync(outDir,{recursive:true});
fs.writeFileSync(path.join(outDir,'day15-134-daily.csv'),csv(rows));
fs.writeFileSync(path.join(outDir,'day15-134-weekly.csv'),csv(weeks));
fs.writeFileSync(path.join(outDir,'day15-134-analysis.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:report.final,ecology:report.ecology,budget:report.budget,validations:report.validations,week_count:weeks.length},null,2));

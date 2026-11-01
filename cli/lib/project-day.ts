/**
 * Port of sim/run_day.cjs projectDaily(): maps ONE engine day onto the two authoritative save documents
 * (saves/main.json, saves/world-state.json) and drafts the day's journal. Pure function of its inputs
 * (the clock value `now` is injected); writing files is done by cli/advance.ts, never here.
 *
 * Differences from v6, all metadata only: engine/params reference strings (refs) and the rules
 * fingerprint now point at the TypeScript engine and the split species/world parameter files.
 */
// @ts-nocheck -- verbatim port of an untyped save-mapping script; the engine API it calls is typed.
import { simulateDay, migrationState, metadataPreview } from '../../engine/index.ts';

export interface SaveRefs { engine_ref: string; rules_ref: string; params_ref: string }
export const DEFAULT_REFS: SaveRefs = { engine_ref: 'engine/index.ts', rules_ref: 'docs/gm-rules.md', params_ref: 'species/pheidole-megacephala.json + world/xitun-garden.json' };
const clone = (x) => structuredClone(x);

export function projectDaily(main, world, climatology, bundle, fingerprint, refs = DEFAULT_REFS, now = new Date().toISOString()) {
 const engineHash = fingerprint.engine, paramsHash = fingerprint.params;
 if(main.simulation.latest_completed_day!==world.time.scientific_clock.day)throw Error('main/world day mismatch');
 const m=clone(main),w=clone(world);
 let s=w.sim_engine_v2;
 if(!s){if(m.simulation.latest_completed_day!==14)throw Error('Day15 migration only allowed from Day14');s=migrationState(m,w,climatology,bundle);
  const mm=metadataPreview(m,{engine_ref:refs.engine_ref,rules_ref:refs.rules_ref,params_ref:refs.params_ref},now);m.continuity=mm.continuity;m.simulation=mm.simulation;m.migration_log=mm.migration_log;
  s.rules_fingerprint={engine:engineHash,params:paramsHash,activated_from_day:15};
 }else if(s.rules_fingerprint.engine!==engineHash||s.rules_fingerprint.params!==paramsHash)throw Error('RULES FROZEN: engine/params modified. Use separate rules-update review, not a daily tick.');
 const report=simulateDay(s,bundle),r=report.summary,beforeDay=m.simulation.latest_completed_day;
 if(report.day!==beforeDay+1||beforeDay+1!==w.time.scientific_clock.day+1)throw Error('exactly one day required');
 w.sim_engine_v2=report.state;w.sim_engine_v2.rules_fingerprint=s.rules_fingerprint;
 m.updated_at=now;m.simulation.latest_completed_day=report.day;m.simulation.elapsed_sim_hours=24*report.day;m.simulation.status='day_'+report.day+'_completed_waiting_day_'+(report.day+1);
 m.simulation.latest_journal='journal/v2-day-'+String(report.day).padStart(4,'0')+'.md';
 m.simulation.calendar_anchor.next_day=report.day+1;const d=new Date(r.date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);m.simulation.calendar_anchor.next_calendar_date=d.toISOString().slice(0,10);
 m.simulation.latest_day_summary={worker_births:r.eclosions,worker_deaths:r.worker_deaths,brood_deaths:r.brood_deaths,eggs_laid:r.eggs_laid,eggs:r.population.eggs,larvae:r.population.larvae,pupae:r.population.pupae,food_game_portions:r.stock,food_inflow_game_portions:r.income,starvation:r.starvation,nutrition_unit:'game_portions_not_mg',engine_ref:refs.engine_ref,params_ref:refs.params_ref};
 m.simulation.nutrition_engine_status='v2_operational_game_portion_balance_not_scientific_mg';
 m.colony.queen.count=r.population.queen;m.colony.queen.status=r.population.queen?'健康':'dead';
 m.colony.workers.current_alive=r.population.workers;
 const originals=new Map(m.colony.workers.individuals.map(x=>[x.id,x]));
 for(const wc of report.events.filter(x=>x.type==='worker_death')){let a=originals.get(wc.id);if(a){a.status='dead';a.death_sim_day=report.day;a.v2_death_reason=wc.reason;}}
 for(const ant of report.state.population.workers){let original=originals.get(ant.id);if(!original){original={id:ant.id,status:'alive'};m.colony.workers.individuals.push(original);originals.set(ant.id,original);}
  original.status='alive';original.v2_engine={age_days:ant.age_days,age_source:ant.age_origin,known_sources:ant.known_sources,task:ant.task,injured:ant.injured,last_sim_day:report.day};}
 m.colony.brood.individuals=report.state.population.brood.map(x=>({id:x.id,stage:x.stage,living:true,laid_on_sim_day:x.laid_on_day??null,stage_elapsed_v2_days:x.age_days,developmental_progress_game_assumption:x.progress,origin:x.origin,individual_nutritional_intake_mg:null}));
 m.colony.brood.eggs=r.population.eggs;m.colony.brood.larvae=r.population.larvae;m.colony.brood.pupae=r.population.pupae;m.colony.brood.total=r.population.eggs+r.population.larvae+r.population.pupae;
 m.colony.brood.v2_latest={day:report.day,new_eggs:r.eggs_laid,stage_transitions:r.hatchings+r.pupations+r.eclosions,deaths:r.brood_deaths,eggs:r.population.eggs,larvae:r.population.larvae,pupae:r.population.pupae,notes:'v2 game assumed temperature-dependent stage rate; not a measured microclimate'};
 m.colony.population_demography.last_completed_day=report.day;
 m.colony.population_demography.stage_ledger={day:report.day,queen_alive:r.population.queen,workers_before:r.workers_before,worker_eclosions:r.eclosions,worker_deaths:r.worker_deaths,workers_after:r.population.workers,brood_before:r.brood_before,brood_after:{eggs:r.population.eggs,larvae:r.population.larvae,pupae:r.population.pupae},flux:{eggs_laid:r.eggs_laid,eggs_hatcing:r.hatchings,larvae_to_pupae:r.pupations,pupae_eclosed:r.eclosions,brood_deaths:r.brood_deaths}};
 m.colony.population_demography.explicit_worker_ids=report.state.population.workers.map(x=>x.id);
 w.ant_population.workers_alive=r.population.workers;w.ant_population.brood={eggs:r.population.eggs,larvae:r.population.larvae,pupae:r.population.pupae};
 w.foraging_economy.day_v2_latest={day:report.day,receipts:report.events.filter(x=>x.type==='food_delivered'),source_world_provenance:report.events.filter(x=>['new_food_source','source_batch_consumed'].includes(x.type)),source_persistent_state_ref:'saves/world-state.json#/sim_engine_v2/sources',food_ledger:r.mass_ledger,starvation:r.starvation};
 w.foraging_economy.nutrition_engine.status='v2_game_portions_operational_not_empirical_mg';w.foraging_economy.nutrition_engine.last_accounted_day=report.day;w.foraging_economy.nutrition_engine.last_completed_sim_day=report.day;w.foraging_economy.nutrition_engine.game_portion_ledger=r.mass_ledger;w.foraging_economy.nutrition_engine.game_portion_store=r.stock;w.foraging_economy.nutrition_engine.game_portion_starvation=r.starvation;
 const ledger={day:report.day,game_portions:{stock:r.stock,income:r.income,consumed:r.consumed,oviposition_cost:r.mass_ledger.egg_laying,overflow:r.mass_ledger.storage_overflow_not_retained,starvation:r.starvation},evidence:'v2 explicit game scenario assumptions, NOT grams/mg or actual field observations'};
 w.resources.v2_latest_ledger=ledger;m.colony.food.v2_latest_ledger=clone(ledger);
 w.time.scientific_clock.day=report.day;w.time.scientific_clock.elapsed_sim_hours=24*report.day;w.time.scientific_clock.calendar_date=r.date;
 w.weather.active_date=r.date;w.weather.last_weather_driven_sim_day=report.day;w.weather.weather_data_kind='synthetic_climatology';w.weather.latest_external_reference=null;w.weather.latest_daily_weather={date:r.date,weather_kind:'synthetic_climatology',model_weather:r.weather,actual_observations:{rainfall_mm:null,air_temperature_c:null,relative_humidity_percent:null}};
 w.weather.rainfall_mm_per_day=null;w.weather.air_temp_c=null;w.weather.relative_humidity_percent=null;
 w.climate_engine.last_generated_synthetic_day=report.day;w.climate_engine.last_generated_synthetic_date=r.date;w.climate_engine.generated_day_count=report.day-8;w.climate_engine.last_synthetic_condition={wet_or_dry:r.weather.wet?'wet':'dry',synthetic_temp_anomaly_c:r.weather.temperature_anomaly_c,model_surface_wetness_index:r.weather.soil_index,model_shaded_soil_memory_index:r.weather.shade_index};
 w.day_log_latest={day:report.day,calendar_date:r.date,elapsed_hours_start:24*(report.day-1),elapsed_hours_end:24*report.day,model:'v2_executable_portion_engine',weather:r.weather,food:r.mass_ledger,demography:r.population,events:report.events,rules_frozen_sha256:s.rules_fingerprint};
 w.time.last_transition={from_day:beforeDay,to_day:report.day,advance_hours:24,journal:m.simulation.latest_journal,program_ref:refs.engine_ref,params_ref:refs.params_ref};
 const md=`# 🐜《螞蟻帝國》Day ${report.day}｜${r.date}\n\n**遊戲假設引擎 v2**，不是實際野外觀測。Day ${report.day-1}→Day ${report.day}，24模擬小時；天氣由臺中歷史月氣候生成。所有「份」都是遊戲單位，不是mg或生物學精確需求。\n\n## 天氣與蟻群\n\n模型雨量${r.weather.rain_mm} mm，模型外氣${r.weather.air_temp_c.toFixed(2)}°C、模型巢溫${r.weather.nest_temp_model_c.toFixed(2)}°C；土表濕潤記憶${r.weather.soil_index}（非實測土壤含水率）。\n\n| 群體 | Day${report.day}數量 |\n|---|---:|\n| 蟻后 | ${r.population.queen} |\n| 工蟻 | ${r.population.workers}（羽化+${r.eclosions}，死亡-${r.worker_deaths}） |\n| 卵 | ${r.population.eggs} |\n| 幼蟲 | ${r.population.larvae} |\n| 蛹 | ${r.population.pupae} |\n\n## 食物份數（非科學實測）\n\n| 營養維度 | 成功採入 | 消耗 | 結餘 |\n|---|---:|---:|---:|\n| 糖 | ${r.income.sugar} | ${r.consumed.sugar} | ${r.stock.sugar} |\n| 蛋白 | ${r.income.protein} | ${r.consumed.protein} | ${r.stock.protein} |\n\n累計糖缺口${r.starvation.sugar_gap_days}日、蛋白缺口${r.starvation.protein_gap_days}日。當日卵孵化${r.hatchings}、化蛹${r.pupations}、羽化${r.eclosions}、產卵${r.eggs_laid}、工蟻死亡${r.worker_deaths}、幼體死亡${r.brood_deaths}。\n\n## 事件紀錄\n\n${report.events.map(e=>'- '+JSON.stringify(e)).join('\n')||'今日無獨立特殊事件。'}\n\n*引擎規則/參數凍結sha256：${s.rules_fingerprint.engine.slice(0,12)} / ${s.rules_fingerprint.params.slice(0,12)}。舊Day1–14歷史沒有改寫。*\n`;
 if(w.time.scientific_clock.day!==m.simulation.latest_completed_day||m.colony.workers.current_alive!==report.state.population.workers.length)throw Error('save sync failed');
 return {main:m,world:w,journal:md,report};
}

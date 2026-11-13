# 花園供給 vs 蟻群消耗：單位、時間尺度與守恆稽核（自動產生）

> 由 `node cli/reports/garden-supply-demand-audit.ts --write` 產生；只讀參數檔與 `data/garden-supply-demand-anchors.json`，不執行引擎、不讀寫 saves/ 或 journal/。
> **診斷，不是目標**：本報告任何數字都不得用來反推花園資源或讓蟻群存活（CLAUDE.md §7；#202 Owner 裁示第 8 項）。「份」（game portion）是遊戲單位，**不是 mg**；mg 欄位只是用明列的候選換算做量級比較。

## 1. 參數單位登錄（每個供給／需求參數）

| 檔案 | 參數 | 值 | 角色 | 食物 | 單位 | 時間尺度 | 來源類型 | 依據 | 旗標 | 備註 |
|---|---|---:|---|---|---|---|---|---|---|---|
| world/xitun-garden.json | `hemipterans.honeydew_per_colony_per_day.aphid` | 0.32 | supply | sugar | game_portion sugar / hemipteran "colony" / day | day | ecological_process | 遊戲假設 | UNITLESS_PORTION | "colony" has no individual count, so the rate cannot be checked against per-insect honeydew data |
| world/xitun-garden.json | `hemipterans.honeydew_per_colony_per_day.scale` | 0.4 | supply | sugar | game_portion sugar / hemipteran "colony" / day | day | ecological_process | 遊戲假設 | UNITLESS_PORTION | same as aphid |
| world/xitun-garden.json | `hemipterans.honeydew_productivity_multiplier` | 1 | supply_driver | sugar | dimensionless multiplier | - | ecological_driver | 遊戲假設 | — | sensitivity handle only |
| world/xitun-garden.json | `hemipterans.hemipteran_colony_daily_growth_probability` | 0.012 | supply_driver | none | 1/day (probability of +1 colony) | day | ecological_driver | 遊戲假設 | — | temperature- and season-independent (defect D5) |
| world/xitun-garden.json | `hemipterans.hemipteran_colony_daily_collapse_probability` | 0.006 | supply_driver | none | 1/day (probability of -1 colony) | day | ecological_driver | 遊戲假設 | — | temperature- and season-independent (defect D5) |
| world/xitun-garden.json | `hemipterans.max_hemipteran_colonies_per_host` | 4 | supply_driver | none | colonies / host plant | state | ecological_driver | 遊戲假設 | — | host plant size not modelled |
| world/xitun-garden.json | `hemipterans.rain_honeydew_secretion_suppression_per_mm` | 0.018 | supply_driver | sugar | fraction / mm rain | day | ecological_driver | 遊戲假設 | — | mechanism direction R183 |
| world/xitun-garden.json | `hemipterans.honeydew_rain_secretion_min_multiplier` | 0.05 | supply_driver | sugar | dimensionless floor | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `plants.host_plant_daily_death_probability` | 0.0007 | supply_driver | none | 1/day per host plant | day | ecological_driver | 遊戲假設 | — | mean host lifetime = 1/p days |
| world/xitun-garden.json | `plants.new_plant_event_probability` | 0.035 | supply_driver | none | 1/day | day | ecological_driver | 遊戲假設 | NOT_READ_BY_ENGINE | declared but not implemented (not read by engine/params.ts) |
| world/xitun-garden.json | `honeydew.honeydew_max` | 5.2 | stock_cap | sugar | game_portion sugar (standing crop cap per site) | state | fixed_game_portion | 遊戲假設 | UNITLESS_PORTION | same cap for every honeydew site regardless of colonies |
| world/xitun-garden.json | `honeydew.honeydew_daily_replenish` | 0.65 | supply | sugar | game_portion sugar / day | day | fixed_game_portion | 遊戲假設 | UNITLESS_PORTION NOT_READ_BY_ENGINE DEAD | DEAD: not read by engine/*.ts (production comes from colonies × rate); referenced only by the legacy v1 sim/ and a legacy-path override in tests/lib/scenarios.ts |
| world/xitun-garden.json | `honeydew.honeydew_initial` | 0.55 | initial_stock | sugar | game_portion sugar | state | scenario_initial | 遊戲假設 | UNITLESS_PORTION | Day15 migration only |
| world/xitun-garden.json | `honeydew.honeydew_washoff_per_rain_mm` | 0.012 | loss | sugar | fraction / mm rain | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `honeydew.honeydew_washoff_max_fraction` | 0.9 | loss | sugar | fraction / day | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `nectar.nectar_max` | 2.4 | stock_cap | sugar | game_portion sugar (standing crop cap) | state | fixed_game_portion | 遊戲假設 | UNITLESS_PORTION | — |
| world/xitun-garden.json | `nectar.nectar_daily_replenish` | 0.35 | supply | sugar | game_portion sugar / site / day while blooming | day | fixed_game_portion | 遊戲假設 | UNITLESS_PORTION | not per flower; no flower count, no temperature response (R186 direction unused), single bloom countdown (D4) |
| world/xitun-garden.json | `nectar.nectar_initial` | 0.18 | initial_stock | sugar | game_portion sugar | state | scenario_initial | 遊戲假設 | UNITLESS_PORTION | Day15 migration only |
| world/xitun-garden.json | `nectar.nectar_bloom_days_remaining` | 12 | supply_driver | sugar | days | day | ecological_driver | 遊戲假設 | — | one countdown, never re-blooms (D4) |
| world/xitun-garden.json | `nectar.nectar_washoff_per_rain_mm` | 0.035 | loss | sugar | fraction / mm rain | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `nectar.nectar_washoff_max_fraction` | 0.9 | loss | sugar | fraction / day | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `carcasses.carcass_new_protein_min` | 1.45 | supply | protein | game_portion protein / natural insect death | event | ecological_process | 遊戲假設 | UNITLESS_PORTION | insects have no body mass in the model; yield independent of insect size |
| world/xitun-garden.json | `carcasses.carcass_new_protein_max` | 2.6 | supply | protein | game_portion protein / natural insect death | event | ecological_process | 遊戲假設 | UNITLESS_PORTION | see min |
| world/xitun-garden.json | `carcasses.carcass_daily_decay_fraction` | 0.14 | loss | protein | fraction / day | day | ecological_driver | 遊戲假設 | — | temperature-independent |
| world/xitun-garden.json | `carcasses.carcass_rain_decay_bonus` | 0.004 | loss | protein | fraction / mm rain | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `carcasses.carcass_max_lifetime_days` | 9 | loss | protein | days | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `carcasses.carcass_decay_max_daily_fraction` | 0.95 | loss | protein | fraction / day | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_local_carrying_capacity` | 18 | supply_driver | protein | insects / site | state | ecological_driver | 遊戲假設 | — | no area, no biomass |
| world/xitun-garden.json | `insects.insect_background_immigration_probability` | 0.08 | supply_driver | protein | 1/day (one insect) | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_local_daily_mortality_probability` | 0.22 | supply_driver | protein | 1/day (at most one death per site per day) | day | ecological_driver | 遊戲假設 | — | caps natural carcass generation at 1 per site per day |
| world/xitun-garden.json | `insects.insect_site_logistic_daily_birth_rate` | 0.065 | supply_driver | protein | 1/day per capita | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_boundary_logistic_daily_birth_rate` | 0.055 | supply_driver | protein | 1/day per capita | day | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_boundary_carrying_capacity` | 80 | supply_driver | protein | insects | state | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_boundary_per_capita_daily_death_probability` | 0.02 | supply_driver | protein | 1/day per capita | day | ecological_driver | 遊戲假設 | — | boundary deaths leave no food |
| world/xitun-garden.json | `insects.insect_reproduction_reference_c` | 25 | supply_driver | protein | °C | - | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_reproduction_per_degree_c` | 0.035 | supply_driver | protein | 1/°C | - | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_reproduction_min_multiplier` | 0.15 | supply_driver | protein | dimensionless | - | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_reproduction_max_multiplier` | 1.25 | supply_driver | protein | dimensionless | - | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `insects.insect_local_death_reference_population` | 12 | supply_driver | protein | insects | - | ecological_driver | 遊戲假設 | — | — |
| world/xitun-garden.json | `prey.small_prey_protein` | 0.55 | supply | protein | game_portion protein / killed small insect | event | fixed_game_portion | 遊戲假設 | UNITLESS_PORTION | same tracked insect yields carcass_new_protein_* when it dies naturally (inconsistent per-insect yield) |
| world/xitun-garden.json | `prey.large_prey_protein` | 1.5 | supply | protein | game_portion protein / killed large insect | event | fixed_game_portion | 遊戲假設 | UNITLESS_PORTION | see small_prey_protein |
| world/xitun-garden.json | `prey.large_prey_fraction` | 0.25 | supply_driver | protein | fraction of encounters | event | fixed_game_portion | 遊戲假設 | — | insects have no size attribute |
| world/xitun-garden.json | `background_colonies.F04_rival.honeydew_harvest_fraction` | 0.22 | loss | sugar | fraction of F04 gross production | day | ecological_driver | 遊戲假設 | — | fixed share, not a simulated colony |
| species/pheidole-megacephala.json | `nutrition.worker_sugar_daily` | 0.1 | demand | sugar | game_portion sugar / worker / day at metabolism.reference_c | day | colony_internal | 遊戲假設 | UNITLESS_PORTION | scaled by Q10 of nest model temperature |
| species/pheidole-megacephala.json | `nutrition.worker_protein_daily` | 0.008 | demand | protein | game_portion protein / worker / day at reference_c | day | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `nutrition.queen_sugar_daily` | 0.22 | demand | sugar | game_portion sugar / queen / day at reference_c | day | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `nutrition.queen_protein_daily` | 0.045 | demand | protein | game_portion protein / queen / day at reference_c | day | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `nutrition.larva_sugar_daily` | 0.025 | demand | sugar | game_portion sugar / larva / day at reference_c | day | colony_internal | 遊戲假設 | UNITLESS_PORTION | not instar-dependent |
| species/pheidole-megacephala.json | `nutrition.larva_protein_daily` | 0.08 | demand | protein | game_portion protein / larva / day at reference_c | day | colony_internal | 遊戲假設 | UNITLESS_PORTION | not instar-dependent; no growth-efficiency link to adult mass |
| species/pheidole-megacephala.json | `nutrition.egg_laying_protein_cost` | 0.14 | demand | protein | game_portion protein / egg | event | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `nutrition.egg_laying_sugar_cost` | 0.08 | demand | sugar | game_portion sugar / egg | event | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `nutrition.brood_protein_min_fraction` | 0.45 | demand | protein | fraction of larva_protein_daily | day | colony_internal | 遊戲假設 | NOT_READ_BY_ENGINE | not read by engine/*.ts (no reference by name); the legacy brood rule does not use it |
| species/pheidole-megacephala.json | `nutrition.max_sugar_store` | 24 | stock_cap | sugar | game_portion sugar (nest store cap at baseline) | state | colony_internal | 遊戲假設 | UNITLESS_PORTION | overflow is destroyed (storage_overflow loss) |
| species/pheidole-megacephala.json | `nutrition.max_protein_store` | 12 | stock_cap | protein | game_portion protein (nest store cap at baseline) | state | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `nutrition.store_capacity_baseline_workers` | 14 | stock_cap | sugar+protein | workers | state | colony_internal | 遊戲假設 | — | — |
| species/pheidole-megacephala.json | `nutrition.sugar_store_per_extra_worker` | 0.4 | stock_cap | sugar | game_portion sugar / extra worker | state | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `nutrition.protein_store_per_extra_worker` | 0.3 | stock_cap | protein | game_portion protein / extra worker | state | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `metabolism.q10` | 2 | demand | sugar+protein | dimensionless (per 10 °C) | - | colony_internal | 一般生理學 | — | general physiology, applied to protein too |
| species/pheidole-megacephala.json | `metabolism.reference_c` | 25 | demand | sugar+protein | °C | - | colony_internal | 一般生理學 | — | — |
| species/pheidole-megacephala.json | `foraging_trips.foraging_trip_sugar_cost` | 0.012 | demand | sugar | game_portion sugar / trip | trip | colony_internal | 遊戲假設 | UNITLESS_PORTION | independent of distance |
| species/pheidole-megacephala.json | `foraging_trips.max_trips_per_forager` | 2 | handling_limit | sugar+protein | trips / forager / day | day | colony_internal | 遊戲假設 | — | time-scale cap on income (D2) |
| species/pheidole-megacephala.json | `activity.active_minute_sugar_cost` | 0.00024 | demand | sugar | game_portion sugar / minute outside | minute | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `food_handling.crop_load_sugar_min` | 0.28 | handling_limit | sugar | game_portion sugar / trip | trip | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `food_handling.crop_load_sugar_max` | 0.62 | handling_limit | sugar | game_portion sugar / trip | trip | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `food_handling.crop_load_protein_min` | 0.3 | handling_limit | protein | game_portion protein / trip | trip | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `food_handling.crop_load_protein_max` | 0.64 | handling_limit | protein | game_portion protein / trip | trip | colony_internal | 遊戲假設 | UNITLESS_PORTION | R107: a minor carries whole prey ≥9× its mass; per-trip piece cap is a game assumption |
| species/pheidole-megacephala.json | `food_handling.liquid_collection_probability` | 0.85 | handling_limit | sugar | probability / arrival | trip | colony_internal | 遊戲假設 | — | — |
| species/pheidole-megacephala.json | `food_handling.carcass_access_probability` | 0.7 | handling_limit | protein | probability / arrival | trip | colony_internal | 遊戲假設 | — | — |
| species/pheidole-megacephala.json | `trophallaxis.crop_capacity` | 0.8 | handling_limit | sugar+protein | game_portion per worker crop | state | colony_internal | 遊戲假設 | UNITLESS_PORTION | R132: minor load 0.08 mg honey (a load, not the maximum) |
| species/pheidole-megacephala.json | `trophallaxis.transfer_max_portions` | 0.28 | handling_limit | sugar | game_portion sugar / trophallaxis | contact | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `queen_feeding.take_from_cache_max_portions` | 0.28 | handling_limit | protein | game_portion protein / nest round | contact | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `queen_feeding.feed_max_portions_per_contact` | 0.28 | handling_limit | sugar+protein | game_portion per contact | contact | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `queen_feeding.self_feed_max_portions` | 0.045 | handling_limit | protein | game_portion protein / round | contact | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `queen_feeding.queen_satiation_days_of_need` | 3 | handling_limit | sugar+protein | days of own need | day | colony_internal | 遊戲假設 | — | — |
| species/pheidole-megacephala.json | `queen_feeding.day0_initial_reserve_days_of_need` | 0 | initial_stock | sugar+protein | days of own need | state | scenario_initial | 遊戲假設 | — | — |
| species/pheidole-megacephala.json | `larval_feeding.feed_bolus_sugar_portions` | 0.025 | handling_limit | sugar | game_portion sugar / contact | contact | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `larval_feeding.feed_bolus_protein_portions` | 0.08 | handling_limit | protein | game_portion protein / contact | contact | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `scouting.unproductive_route_threshold_portions` | 0.1 | perception | sugar+protein | game_portion remembered harvest | trip | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| species/pheidole-megacephala.json | `site_choice.default_prior_success_portions` | 0.15 | perception | sugar+protein | game_portion remembered harvest | trip | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| scenarios/day0/garden.json | `honeydew_sites.F01.host_plants` | 2 | supply_driver | sugar | host plants / site | state | scenario_initial | 遊戲假設 | — | no plant size / species |
| scenarios/day0/garden.json | `honeydew_sites.F04.host_plants` | 2 | supply_driver | sugar | host plants / site | state | scenario_initial | 遊戲假設 | — | no plant size / species |
| scenarios/day0/garden.json | `honeydew_sites.F05.host_plants` | 1 | supply_driver | sugar | host plants / site | state | scenario_initial | 遊戲假設 | — | no plant size / species |
| scenarios/day0/garden.json | `honeydew_sites.F10.host_plants` | 1 | supply_driver | sugar | host plants / site | state | scenario_initial | 遊戲假設 | — | no plant size / species |
| scenarios/day0/garden.json | `honeydew_sites.F01.hemipteran_colonies` | 4 | supply_driver | sugar | hemipteran "colonies" / site | state | scenario_initial | 遊戲假設 | — | no individuals per colony |
| scenarios/day0/garden.json | `honeydew_sites.F04.hemipteran_colonies` | 3 | supply_driver | sugar | hemipteran "colonies" / site | state | scenario_initial | 遊戲假設 | — | no individuals per colony |
| scenarios/day0/garden.json | `honeydew_sites.F05.hemipteran_colonies` | 2 | supply_driver | sugar | hemipteran "colonies" / site | state | scenario_initial | 遊戲假設 | — | no individuals per colony |
| scenarios/day0/garden.json | `honeydew_sites.F10.hemipteran_colonies` | 1 | supply_driver | sugar | hemipteran "colonies" / site | state | scenario_initial | 遊戲假設 | — | no individuals per colony |
| scenarios/day0/garden.json | `honeydew_sites.F01.exists_probability` | 1 | supply_driver | sugar | probability / world seed | state | scenario_initial | 遊戲假設 | — | — |
| scenarios/day0/garden.json | `honeydew_sites.F04.exists_probability` | 0.65 | supply_driver | sugar | probability / world seed | state | scenario_initial | 遊戲假設 | — | — |
| scenarios/day0/garden.json | `honeydew_sites.F05.exists_probability` | 0.8 | supply_driver | sugar | probability / world seed | state | scenario_initial | 遊戲假設 | — | — |
| scenarios/day0/garden.json | `honeydew_sites.F10.exists_probability` | 0.7 | supply_driver | sugar | probability / world seed | state | scenario_initial | 遊戲假設 | — | — |
| scenarios/day0/garden.json | `nectar_sites.F08.bloom_days_at_start_of_warmup` | 12 | supply_driver | sugar | days | day | scenario_initial | 遊戲假設 | — | shorter than warmup_days: bloom ends before Day0 |
| scenarios/day0/garden.json | `nectar_sites.F08.initial_sugar` | 0 | initial_stock | sugar | game_portion sugar | state | scenario_initial | 遊戲假設 | UNITLESS_PORTION | — |
| scenarios/day0/garden.json | `carcass_sites.F07.initial_living_insects` | 12 | supply_driver | protein | insects / site | state | scenario_initial | 遊戲假設 | — | — |
| scenarios/day0/garden.json | `carcass_sites.F11.initial_living_insects` | 9 | supply_driver | protein | insects / site | state | scenario_initial | 遊戲假設 | — | — |
| scenarios/day0/garden.json | `carcass_sites.F07.initial_carcass_protein` | 0 | initial_stock | protein | game_portion protein | state | scenario_initial | 遊戲假設 | UNITLESS_PORTION | — |
| scenarios/day0/garden.json | `carcass_sites.F11.initial_carcass_protein` | 0 | initial_stock | protein | game_portion protein | state | scenario_initial | 遊戲假設 | UNITLESS_PORTION | — |
| scenarios/day0/garden.json | `boundary_insects` | 40 | supply_driver | protein | insects | state | scenario_initial | 遊戲假設 | — | — |
| scenarios/day0/garden.json | `warmup_days` | 30 | supply_driver | sugar+protein | days | day | scenario_initial | 遊戲假設 | — | — |
| prototypes/p0a2-24h/params.json | `parameters.honeydew_amount_portions` | 0.05 | supply | sugar | game_portion sugar / production event | event (every honeydew_interval_s) | fixed_game_portion | 遊戲假設 | UNITLESS_PORTION | no hemipteran, plant, temperature or rain driver: a fixed scenario drip (synthetic) |
| prototypes/p0a2-24h/params.json | `parameters.honeydew_interval_s` | 900 | supply_driver | sugar | s | event | fixed_game_portion | 遊戲假設 | — | — |
| prototypes/p0a2-24h/params.json | `parameters.worker_sugar_daily_portions` | 0.1 | demand | sugar | game_portion sugar / worker / day, constant rate | continuous | colony_internal | 遊戲假設 | UNITLESS_PORTION | no Q10 (nest temperature not simulated) |
| prototypes/p0a2-24h/params.json | `parameters.larva_sugar_daily_portions` | 0.025 | demand | sugar | game_portion sugar / larva / day | continuous | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| prototypes/p0a2-24h/params.json | `parameters.crop_capacity_portions` | 0.8 | handling_limit | sugar | game_portion per worker crop | state | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| prototypes/p0a2-24h/params.json | `parameters.larva_gut_capacity_portions` | 0.025 | handling_limit | sugar | game_portion per larva gut | state | colony_internal | 遊戲假設 | UNITLESS_PORTION | — |
| prototypes/p0a2-24h/params.json | `parameters.feed_bolus_portions` | 0.025 | handling_limit | sugar | game_portion sugar / contact | contact | colony_internal | 遊戲假設（機制：文獻支持，非本種） | UNITLESS_PORTION | — |
| prototypes/p0a2-24h/params.json | `parameters.transfer_max_portions` | 0.28 | handling_limit | sugar | game_portion sugar / trophallaxis | contact | colony_internal | 遊戲假設（機制：文獻支持，非本種） | UNITLESS_PORTION | — |
| prototypes/p0a2-24h/params.json | `parameters.initial_crop_fill_max` | 1 | initial_stock | sugar | fraction of crop | state | scenario_initial | 遊戲假設 | — | — |
| prototypes/p0a2-24h/params.json | `parameters.initial_larva_gut_fill_max` | 1 | initial_stock | sugar | fraction of gut | state | scenario_initial | 遊戲假設 | — | — |
| prototypes/p0a2-24h/params.json | `parameters.colony_workers` | 30 | demand | sugar | workers | state | scenario_initial | 遊戲假設 | — | — |
| prototypes/p0a2-24h/params.json | `parameters.colony_larvae` | 8 | demand | sugar | larvae | state | scenario_initial | 遊戲假設 | — | — |

共 111 項；其中 49 項以「份」計（UNITLESS_PORTION：沒有質量單位）。未分類的食物相關參數：0（全部已登錄或已列為非食物量）。

## 2. 舊日程引擎：花園生產上限（份／日，世界過程的平均場計算）

| 地點 | 種類 | 存在機率 | 寄主 | 群數（Day0 盤點／平穩平均／上限） | 每群份／日 | 背景競爭者取走 | 淨產量 份／日（盤點／平穩／上限） |
|---|---|---:|---:|---|---:|---:|---|
| F01 | aphid | 1 | 2 | 4／6.338／8 | 0.32 | 0 | 1.28／2.028／2.56 |
| F04 | scale | 0.65 | 2 | 3／6.338／8 | 0.4 | 0.22 | 0.936／1.977／2.496 |
| F05 | aphid | 0.8 | 1 | 2／3.169／4 | 0.32 | 0 | 0.64／1.014／1.28 |
| F10 | scale | 0.7 | 1 | 1／3.169／4 | 0.4 | 0 | 0.4／1.268／1.6 |

蜜露合計（四地點都存在）：盤點 3.256、平穩 6.287、上限 7.936 份／日；依存在機率平均（平穩）5.011 份／日。未扣雨天抑制與沖刷（晴天上限）。

- 花蜜 F08：開花時 0.35 份／日；暖機開始剩 12 日、暖機 30 日 → Day0 之後 **0 份／日** BLOOM_ENDS_BEFORE_DAY0 (D4: no re-bloom)

| 屍體地點 | 生育倍率 1：平衡昆蟲數／自然死亡（隻／日）／蛋白 份／日 | 生育倍率下限 | 生育倍率上限 |
|---|---|---|---|
| F07 | 14.57／0.2604／0.5274 | 6.144／0.1195／0.2419 | 15.23／0.2705／0.5477 |
| F11 | 14.57／0.2604／0.5274 | 6.144／0.1195／0.2419 | 15.23／0.2705／0.5477 |

自然屍體蛋白合計（生育倍率 1）：1.055 份／日（未扣腐敗；捕食只是把同一批昆蟲提早變成食物，不增加昆蟲周轉）。
**每隻昆蟲的蛋白不一致**：自然死亡平均 2.025（1.45～2.6）份；被獵殺平均 0.7875（小 0.55／大 1.5）份；比值 0.3889。同一隻被追蹤的昆蟲，死法不同、蛋白量不同，而昆蟲本身沒有體重。

## 3. 舊日程引擎：蟻群需求（份／日；Q10 依巢溫模型）

| 工蟻 | 幼蟲 | 蟻后 | 15°C 糖／蛋白 | 20°C 糖／蛋白 | 25°C 糖／蛋白 | 30°C 糖／蛋白 |
|---:|---:|---:|---|---|---|---|
| 10 | 2 | 1 | 0.635／0.1425 | 0.898／0.2015 | 1.27／0.285 | 1.796／0.4031 |
| 30 | 5 | 1 | 1.673／0.3425 | 2.365／0.4844 | 3.345／0.685 | 4.731／0.9687 |
| 158 | 24 | 1 | 8.31／1.615 | 11.75／2.283 | 16.62／3.229 | 23.5／4.566 |
| 500 | 75 | 1 | 26.05／5.022 | 36.84／7.103 | 52.09／10.04 | 73.67／14.21 |
| 2000 | 300 | 1 | 103.9／20.02 | 146.9／28.32 | 207.7／40.05 | 293.8／56.63 |

幼蟲數＝工蟻 × 候選 `larvae_per_minor` 中點；不含趟次活動耗糖（每趟約 0.0252 份）與產卵成本。

**診斷（不是目標）**：在模型自己的單位下，「維生糖需求＝花園蜜露平穩產量」的工蟻數，以及「維生蛋白需求＝自然屍體蛋白產量」的工蟻數：

| 巢溫 | 糖：四地點都存在 | 糖：依存在機率平均 | 蛋白：自然屍體 |
|---:|---:|---:|---:|
| 15°C | 126 | 100 | 264 |
| 20°C | 88.9 | 70.9 | 186 |
| 25°C | 62.9 | 50.1 | 132 |
| 30°C | 44.5 | 35.4 | 93.2 |

時間尺度上限：每隻覓食工蟻每日最多 2 趟 × 0.62 份 × 採到機率 0.85 ＝ 1.054 份糖／日（D2）。

## 4. P0-A2 24 小時原型

供給 4.8 份／日（fixed scenario drip (no ecological driver)）；需求 3.2 份／日；供需比 1.5。供給不來自任何生態過程（沒有半翅目、植物、溫度或雨），是固定情境滴量。

## 5. 文獻錨定的量級比較（換算全部明列；非本種外推）

| 量 | 值 | 換算／來源 |
|---|---|---|
| 候選換算：1 份糖 ＝ ? mg 糖 | 載量法 0.08；代謝法 0.0162～0.08812；聯集 0.0162～0.08812 | 載量法：R132 0.08 mg 蜂蜜 × 0.8 糖分（假設）÷ crop_capacity；代謝法：R951（**非本種**）靜止耗氧外推到 R107／R346 體重，× 20.1 J/mL O2 ÷ 16.5 J/mg，對應 worker_sugar_daily |
| 小工蟻靜止耗糖（外推） | 0.00162～0.008812 mg／隻／日 | R951 兩式 × 體重 0.35～0.541 mg（R107、R346）；野外活動代謝更高（未量化） |
| 一隻蚜蟲的蜜露糖 | 0.0276～5.28 mg／隻／日 | R950、R952：46～880 µg 蜜露／隻／h；× 分泌時數 12～24 h（假設）× 糖分 5～25%（假設） |
| 遊戲一個「蚜蟲群」 | 0.005184～0.0282 mg 糖／日 | aphid 每群份／日 × 換算聯集 |
| 遊戲一個「蚜蟲群」相當幾隻蚜蟲 | 0.0009818～1.022 隻 | 上兩列相除（取極端組合） |
| 遊戲全花園蜜露平穩產量 | 0.1018～0.554 mg 糖／日 | 平穩產量 × 換算聯集 |

解讀限制：換算本身是候選；蚜蟲數據來自歐洲溫帶寄主與 *Lasius niger*；臺中花園半翅目的種類、每群隻數、晝夜節律與糖濃度都未知。這些量級比較**只**說明「群」這個單位缺少個體數維度，不支持任何特定的花園供給數值。


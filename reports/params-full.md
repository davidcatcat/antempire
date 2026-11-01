# v2.1 完整遊戲假設參數表

> 以下全部參數均設 `assumption: true`，表示遊戲假設，不是 Pheidole megacephala 物種實測。

| 子系統 | 參數 | 值 | assumption | 說明 |
|---|---|---:|:---:|---|
| development | `reference_c` | 25 | true |  |
| development | `egg_days` | 10 | true |  |
| development | `larva_days` | 12 | true |  |
| development | `pupa_days` | 10 | true |  |
| development | `q10` | 1.55 | true |  |
| development | `min_temp_factor` | 0.48 | true |  |
| development | `max_temp_factor` | 1.9 | true |  |
| development | `nest_buffer_fraction` | 0.55 | true |  |
| nutrition | `starting_sugar` | 7.6 | true |  |
| nutrition | `starting_protein` | 2.3 | true |  |
| nutrition | `worker_sugar_daily` | 0.1 | true |  |
| nutrition | `worker_protein_daily` | 0.008 | true |  |
| nutrition | `queen_sugar_daily` | 0.22 | true |  |
| nutrition | `queen_protein_daily` | 0.045 | true |  |
| nutrition | `larva_sugar_daily` | 0.025 | true |  |
| nutrition | `larva_protein_daily` | 0.08 | true | game assumption 0.08 portions per larva per day; no mg conversion; replaces 0.2 |
| nutrition | `egg_laying_protein_cost` | 0.14 | true |  |
| nutrition | `egg_laying_sugar_cost` | 0.08 | true |  |
| nutrition | `brood_protein_min_fraction` | 0.45 | true |  |
| nutrition | `max_sugar_store` | 24 | true |  |
| nutrition | `max_protein_store` | 12 | true |  |
| starvation | `queen_egg_pause_days` | 2 | true |  |
| starvation | `worker_mortality_starts_days` | 4 | true |  |
| starvation | `larva_mortality_starts_days` | 5 | true |  |
| starvation | `worker_daily_hazard_base` | 0.015 | true |  |
| starvation | `worker_daily_hazard_slope` | 0.012 | true |  |
| starvation | `larva_daily_hazard_base` | 0.05 | true |  |
| starvation | `larva_daily_hazard_slope` | 0.055 | true |  |
| starvation | `queen_hazard_after_days` | 12 | true |  |
| starvation | `queen_daily_hazard` | 0.008 | true |  |
| starvation | `worker_natural_daily_base_hazard` | 0.003 | true |  |
| starvation | `worker_age_risk_from_days` | 28 | true |  |
| starvation | `worker_age_hazard_slope` | 0.00075 | true |  |
| starvation | `injury_mortality_multiplier` | 1.4 | true |  |
| starvation | `queen_zero_worker_hazard_after_days` | 3 | true | after losing all caretakers queen hazard rises especially when energy deficient |
| starvation | `queen_zero_worker_starved_daily_hazard` | 0.24 | true | no workers plus prolonged food deficit elevates death risk; game assumption |
| queen | `base_laying_probability` | 0.38 | true |  |
| queen | `max_eggs_per_day` | 2 | true |  |
| queen | `existing_brood_pressure` | 0.011 | true |  |
| queen | `previous_laying_penalty` | 0.6 | true |  |
| queen | `adequate_nutrition_threshold` | 0.84 | true |  |
| workers | `newborn_initial_age_days` | 0 | true |  |
| workers | `legacy_unknown_age_initial_days` | 7 | true |  |
| workers | `rest_baseline_probability` | 0.22 | true |  |
| workers | `nurse_baseline_probability` | 0.25 | true |  |
| workers | `maintenance_baseline_probability` | 0.12 | true |  |
| workers | `forage_baseline_probability` | 0.36 | true |  |
| workers | `defence_baseline_probability` | 0.05 | true |  |
| workers | `injury_foraging_multiplier` | 0.45 | true |  |
| workers | `injury_repair_probability` | 0.05 | true |  |
| workers | `newborn_nurse_days` | 4 | true |  |
| workers | `recruitment_probability` | 0.55 | true |  |
| workers | `recruitment_max_followers` | 3 | true |  |
| workers | `scout_discovery_probability` | 0.25 | true |  |
| workers | `max_trips_per_forager` | 2 | true |  |
| workers | `foraging_trip_sugar_cost` | 0.012 | true |  |
| workers | `rain_suppression_fraction` | 0.035 | true |  |
| workers | `min_rain_activity_multiplier` | 0.35 | true |  |
| workers | `local_communication_retention_days` | 3 | true |  |
| workers | `nest_contact_route_learning_probability` | 0.28 | true |  |
| workers | `local_peer_contact_probability` | 0.58 | true | local in-nest encounter likelihood, no global visibility |
| workers | `local_signal_smoothing` | 0.5 | true | fraction retained from own prior local encounters |
| workers | `sugar_hunger_priority_weight` | 4.5 | true | worker chooses sugar more often when own crop/encountered nestmates signal hunger |
| workers | `protein_begging_priority_weight` | 1.8 | true | only locally encountered hungry larvae or nurses can elevate protein foraging |
| workers | `unloading_success_memory_weight` | 1.4 | true | fast unloading reinforces same kind of forage; slow unloading suppresses it |
| workers | `scout_search_when_route_unproductive_probability` | 0.18 | true | local search triggered by own failed route, does not reveal distant sugar source |
| sources | `honeydew_max` | 5.2 | true |  |
| sources | `honeydew_daily_replenish` | 0.65 | true |  |
| sources | `honeydew_initial` | 0.55 | true |  |
| sources | `nectar_max` | 2.4 | true |  |
| sources | `nectar_daily_replenish` | 0.35 | true |  |
| sources | `nectar_initial` | 0.18 | true |  |
| sources | `nectar_bloom_days_remaining` | 12 | true |  |
| sources | `honeydew_washoff_per_rain_mm` | 0.012 | true |  |
| sources | `nectar_washoff_per_rain_mm` | 0.035 | true |  |
| sources | `carcass_initial_F07` | 0.6 | true |  |
| sources | `carcass_initial_F11` | 0.07 | true |  |
| sources | `carcass_initial_F07_older` | 0.05 | true |  |
| sources | `carcass_daily_decay_fraction` | 0.14 | true |  |
| sources | `carcass_rain_decay_bonus` | 0.004 | true |  |
| sources | `carcass_new_protein_min` | 1.45 | true |  |
| sources | `carcass_new_protein_max` | 2.6 | true |  |
| sources | `carcass_access_probability` | 0.7 | true |  |
| sources | `carcass_max_lifetime_days` | 9 | true |  |
| sources | `crop_load_sugar_min` | 0.28 | true |  |
| sources | `crop_load_sugar_max` | 0.62 | true |  |
| sources | `crop_load_protein_min` | 0.3 | true |  |
| sources | `crop_load_protein_max` | 0.64 | true |  |
| sources | `new_plant_event_probability` | 0.035 | true |  |
| sources | `insect_initial_living_F07` | 12 | true |  |
| sources | `insect_initial_living_F11` | 9 | true |  |
| sources | `insect_local_carrying_capacity` | 18 | true |  |
| sources | `insect_background_immigration_probability` | 0.08 | true |  |
| sources | `insect_local_daily_mortality_probability` | 0.22 | true |  |
| sources | `insect_initial_boundary_reservoir` | 40 | true |  |
| sources | `honeydew_per_aphid_colony_per_day` | 0.32 | true | ecological production per aphid colony with living host plants, independent of ant population |
| sources | `honeydew_per_scale_colony_per_day` | 0.4 | true | ecological production per scale-insect colony with living host plants, independent of ant population |
| sources | `honeydew_productivity_multiplier` | 1.0 | true | baseline physical productivity; single-variable sugar sensitivity test changes ONLY this input |
| sources | `hemipteran_colony_daily_growth_probability` | 0.012 | true | natural hemipteran colony reproduction game assumption; depends on living host |
| sources | `hemipteran_colony_daily_collapse_probability` | 0.006 | true | natural daily mortality/reproductive collapse of a colony, independent of ant demand |
| sources | `host_plant_daily_death_probability` | 0.0007 | true | garden host plant mortality; not reactive to colony demand |
| sources | `max_hemipteran_colonies_per_host` | 4 | true | physical carrying capacity per host plant, distinct from honeydew stored capacity |
| sources | `rain_honeydew_secretion_suppression_per_mm` | 0.018 | true | rain suppresses feeding/secretion production as ecological assumption |
| sources | `rival_honeydew_harvest_fraction_F04` | 0.22 | true | F04 background rival ants consume a fixed ecological share; independent of main colony shortage |
| climate | `annual_rain_days` | 113.7 | true |  |
| climate | `wet_persistence` | 0.45 | true |  |
| climate | `temperature_ar` | 0.65 | true |  |
| climate | `temperature_daily_sigma_c` | 1.8 | true |  |
| climate | `rainfall_gamma_shape` | 1.6 | true |  |
| climate | `nest_temp_memory` | 0.6 | true |  |
| climate | `soil_daily_loss` | 0.025 | true |  |
| climate | `soil_rain_gain_per_mm` | 0.045 | true |  |
| climate | `soil_persistence` | 0.93 | true |  |
| climate | `soil_shade_daily_loss` | 0.013 | true |  |
| climate | `soil_shade_persistence` | 0.96 | true |  |
| climate | `soil_shade_rain_gain_per_mm` | 0.025 | true |  |
| model | `scenario_seed` | 15032026 | true |  |
| model | `unit_precision` | 6 | true |  |
| model | `population_safety_cap_for_trial` | 200 | true |  |
| model | `min_workers_alive_for_trial` | 1 | true |  |

總計 **120 個數值假設參數**。糖源不由巢內需求倒推；工蟻決策不讀取全巢庫存。

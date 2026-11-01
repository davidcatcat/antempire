# v6 所有參數（從 sim/params.json 即時生成）

**共 157 組數值參數，全數 `assumption: true`；即使有機制的文獻來源也不是數值已實測。** 額外 `foraging_route_topology` 非數值情境拓樸亦標示 `assumption: true`。正式 Day14／336h 未推進。完整物理行為參見 `docs/foraging-physical-behavior-v6.md`。

| 子系統 | 參數 | 值 | assumption | 理由 |
|---|---|---:|:---:|---|
| development | `reference_c` | 25 | true | 以25°C為相對發育速率基準 |
| development | `egg_days` | 10 | true | 25°C卵期標準長度，遊戲假設 |
| development | `larva_days` | 12 | true | 25°C幼蟲期標準長度，遊戲假設，不等於實際野外幼蟲期 |
| development | `pupa_days` | 10 | true | 25°C蛹期標準長度，遊戲假設 |
| development | `q10` | 1.55 | true | 溫度每提高10°C之發育速度倍數，遊戲假設 |
| development | `min_temp_factor` | 0.48 | true | 環境低溫時發育減緩下限，遊戲假設 |
| development | `max_temp_factor` | 1.9 | true | 環境高溫時發育加速上限，遊戲假設 |
| development | `nest_buffer_fraction` | 0.55 | true | 巢內溫度相對外界均溫的緩衝權重，非實測 |
| nutrition | `starting_sugar` | 7.6 | true | Day14既有存糧不可測；作為Day15獨立情境起始糖儲備，約四天工蟻+蟻后基礎需求 |
| nutrition | `starting_protein` | 2.3 | true | Day14曾有兩次昆蟲來源帶回，作為Day15獨立情境的蛋白儲備假設，非由事件數換算 |
| nutrition | `worker_sugar_daily` | 0.1 | true | 每工蟻日糖消耗，單位份 |
| nutrition | `worker_protein_daily` | 0.008 | true | 每工蟻維生蛋白日耗，單位份 |
| nutrition | `queen_sugar_daily` | 0.22 | true | 蟻后日糖消耗，單位份 |
| nutrition | `queen_protein_daily` | 0.045 | true | 蟻后維生蛋白日耗，單位份 |
| nutrition | `larva_sugar_daily` | 0.025 | true | 每幼蟲日糖日耗，單位份 |
| nutrition | `larva_protein_daily` | 0.08 | true | game assumption 0.08 portions per larva per day; no mg conversion; replaces 0.2 |
| nutrition | `egg_laying_protein_cost` | 0.14 | true | 每一顆卵的營養成本，單位份 |
| nutrition | `egg_laying_sugar_cost` | 0.08 | true | 每一顆卵的營養成本，單位份 |
| nutrition | `brood_protein_min_fraction` | 0.45 | true | 幼蟲吃到至少此比率的蛋白才可有效發育 |
| nutrition | `max_sugar_store` | 24 | true | 巢群本階段可存/嗉囊攜帶之糖份上限，會隨規模擴張 |
| nutrition | `max_protein_store` | 12 | true | 巢群本階段可存/處理之蛋白份上限，會隨規模擴張 |
| nutrition | `metabolic_reference_c` | 25 | true | 一般生理學 + 遊戲假設: 巢溫代謝基準25°C；非P. megacephala實測 |
| nutrition | `metabolic_q10` | 2 | true | 一般生理學 + 遊戲假設: Q10=2.0 是研究標準化假設，非本物種實測 |
| starvation | `queen_egg_pause_days` | 2 | true | 任一營養缺口累計2天停止產卵 |
| starvation | `worker_mortality_starts_days` | 4 | true | 連續糖缺口到4天開始額外死亡風險 |
| starvation | `larva_mortality_starts_days` | 5 | true | 連續蛋白缺口到5天開始幼蟲死亡風險 |
| starvation | `worker_daily_hazard_base` | 0.015 | true | 飢餓門檻後每日每蟻額外基礎死亡機率 |
| starvation | `worker_daily_hazard_slope` | 0.012 | true | 缺口每延長一天死亡機率增幅 |
| starvation | `larva_daily_hazard_base` | 0.05 | true | 幼蟲營養不足的基礎死亡率 |
| starvation | `larva_daily_hazard_slope` | 0.055 | true | 幼蟲缺蛋白每延長一天之機率增幅 |
| starvation | `queen_hazard_after_days` | 12 | true | 極端連續飢餓後蟻后也受風險 |
| starvation | `queen_daily_hazard` | 0.008 | true | 極端營養不足後蟻后每日額外死亡機率 |
| starvation | `worker_natural_daily_base_hazard` | 0.003 | true | 假定日自然死亡基礎機率，非本種精確死亡率 |
| starvation | `worker_age_risk_from_days` | 28 | true | 超過假設成蟻年齡後死亡風險逐日增加 |
| starvation | `worker_age_hazard_slope` | 0.00075 | true | 假設老化危險率每日增加量 |
| starvation | `injury_mortality_multiplier` | 1.4 | true | 有舊傷者自然死亡額外風險倍率 |
| starvation | `queen_zero_worker_hazard_after_days` | 3 | true | after losing all caretakers queen hazard rises especially when energy deficient |
| starvation | `queen_zero_worker_starved_daily_hazard` | 0.24 | true | no workers plus prolonged food deficit elevates death risk; game assumption |
| starvation | `unattended_larva_max_days` | 4 | true | 一般生理學 + 遊戲假設: 無工蟻照護及餵食幼蟲最多4日，不是量測 |
| starvation | `unattended_egg_max_days` | 10 | true | 遊戲假設: 缺工蟻照護卵最多10日，非實測 |
| starvation | `unattended_pupa_max_days` | 10 | true | 遊戲假設: 缺工蟻照護蛹最多10日，非實測 |
| queen | `base_laying_probability` | 0.38 | true | 遊戲假設: 25°C、營養充足時每日發生產卵基礎機率，不等於每日必生一卵 |
| queen | `max_eggs_per_day` | 2 | true | 單日最大產卵數；本階段獨立情境人口控制 |
| queen | `existing_brood_pressure` | 0.011 | true | 每一隻既有幼體增加的繁殖抑制因子 |
| queen | `previous_laying_penalty` | 0.6 | true | 昨日有產卵時今日產卵機率倍率 |
| queen | `adequate_nutrition_threshold` | 0.84 | true | 若當日資源滿足比例低於此則產卵暫停 |
| queen | `laying_reference_c` | 25 | true | 遊戲假設: 產卵參考巢溫25°C，非本物種實測 |
| queen | `laying_temperature_q10` | 2.5 | true | 遊戲假設: 低溫降低產卵機率的Q10形狀，非本物種實測 |
| queen | `second_egg_given_laying_probability` | 0.2 | true | 遊戲假設: 當日發生產卵後，追加第二顆卵之機率；不保證兩卵 |
| workers | `newborn_initial_age_days` | 0 | true | 新羽化成蟻年齡從零開始 |
| workers | `legacy_unknown_age_initial_days` | 7 | true | Day14舊工蟻真實成年年齡未知，Day15採遊戲假設7天 |
| workers | `rest_baseline_probability` | 0.22 | true | 基礎休息比例，依飢餓狀態變動 |
| workers | `nurse_baseline_probability` | 0.25 | true | 基礎育幼偏好 |
| workers | `maintenance_baseline_probability` | 0.12 | true | 巢口維護基礎偏好 |
| workers | `forage_baseline_probability` | 0.36 | true | 基礎覓食偏好，營養缺乏與招募將提高 |
| workers | `defence_baseline_probability` | 0.05 | true | 巢口警戒偏好 |
| workers | `injury_foraging_multiplier` | 0.45 | true | 受傷個體覓食意願下降倍率 |
| workers | `injury_repair_probability` | 0.05 | true | 舊傷個體每日復原機率（需食物與休息） |
| workers | `newborn_nurse_days` | 4 | true | 新羽化頭幾日優先巢內工作，遊戲假設 |
| workers | `recruitment_probability` | 0.55 | true | 成功覓食者在巢內接觸其他工蟻之招募機率 |
| workers | `recruitment_max_followers` | 3 | true | 每筆成功食物資訊最多影響三隻同巢工蟻 |
| workers | `scout_discovery_probability` | 0.25 | true | 無既知食源時探索新地點成功機率 |
| workers | `max_trips_per_forager` | 2 | true | 每覓食工蟻單日最大外勤次數 |
| workers | `foraging_trip_sugar_cost` | 0.012 | true | 覓食路線附加糖耗份數 |
| workers | `rain_suppression_fraction` | 0.035 | true | 每mm雨對出勤/採集倍率的減損，上限截斷 |
| workers | `min_rain_activity_multiplier` | 0.35 | true | 暴雨仍可能有部分微氣候遮蔽路線 |
| workers | `local_communication_retention_days` | 3 | true | 招募訊號只保持短期局部記憶 |
| workers | `nest_contact_route_learning_probability` | 0.28 | true | 每日同巢局部接觸，借由另一隻熟悉路線工蟻學到某已知食源路線的機率（非全知） |
| workers | `local_peer_contact_probability` | 0.58 | true | local in-nest encounter likelihood, no global visibility |
| workers | `local_signal_smoothing` | 0.5 | true | fraction retained from own prior local encounters |
| workers | `sugar_hunger_priority_weight` | 4.5 | true | worker chooses sugar more often when own crop/encountered nestmates signal hunger |
| workers | `protein_begging_priority_weight` | 1.8 | true | only locally encountered hungry larvae or nurses can elevate protein foraging |
| workers | `unloading_success_memory_weight` | 1.4 | true | fast unloading reinforces same kind of forage; slow unloading suppresses it |
| workers | `scout_search_when_route_unproductive_probability` | 0.18 | true | local search triggered by own failed route, does not reveal distant sugar source |
| workers | `foraging_cold_limit_c` | 10 | true | 遊戲假設: 白天最高氣溫10°C時活動權重下限，非本種實測 |
| workers | `foraging_full_activity_c` | 25 | true | 遊戲假設: 白天最高氣溫25°C時冷抑制解除，非地表最佳覓食溫度實測 |
| workers | `foraging_cold_min_multiplier` | 0.12 | true | 文獻支持方向+遊戲假設: 低溫係數只作用於白天覓食出勤權重一次，不再影響採集和招募 |
| sources | `honeydew_max` | 5.2 | true | 蜜露F01總可及糖份上限 |
| sources | `honeydew_daily_replenish` | 0.65 | true | 寄主與蚜蟲仍活著時每日補充糖份 |
| sources | `honeydew_initial` | 0.55 | true | Day14 F01有蚜蟲但無可採蜜露；Day15起始少量保守情境 |
| sources | `nectar_max` | 2.4 | true | F08花蜜份數上限 |
| sources | `nectar_daily_replenish` | 0.35 | true | 花仍在開放期時日補充量 |
| sources | `nectar_initial` | 0.18 | true | Day14無可確認花蜜之情境假設 |
| sources | `nectar_bloom_days_remaining` | 12 | true | Day15起餘下開花期假設 |
| sources | `honeydew_washoff_per_rain_mm` | 0.012 | true | 每mm雨使蜜露減少的比例 |
| sources | `nectar_washoff_per_rain_mm` | 0.035 | true | 每mm雨造成花蜜沖刷比例 |
| sources | `carcass_initial_F07` | 0.6 | true | 保留Day11 F07 V2D11-E04屍體可能剩餘的蛋白份數；高不確定性 |
| sources | `carcass_initial_F11` | 0.07 | true | 保留Day9 F11舊屍剩餘蛋白份數；已採部分且腐敗更久 |
| sources | `carcass_initial_F07_older` | 0.05 | true | 保留Day10 F07舊殘骸少量假設 |
| sources | `carcass_daily_decay_fraction` | 0.14 | true | 未採集殘骸每一日可食份數減少比例 |
| sources | `carcass_rain_decay_bonus` | 0.004 | true | 每mm雨額外可食減少比例 |
| sources | `carcass_new_protein_min` | 1.45 | true | 新屍體蛋白份數下界 |
| sources | `carcass_new_protein_max` | 2.6 | true | 新屍體蛋白份數上界 |
| sources | `carcass_access_probability` | 0.7 | true | 到達且食物剩餘時遇到/可採的機率 |
| sources | `carcass_max_lifetime_days` | 9 | true | 殘骸來源最長保留9天；只刪除已腐化且無可食量來源 |
| sources | `crop_load_sugar_min` | 0.28 | true | 每趟成功糖運輸下界份數 |
| sources | `crop_load_sugar_max` | 0.62 | true | 每趟成功糖運輸上界份數 |
| sources | `crop_load_protein_min` | 0.3 | true | 每趟成功昆蟲蛋白運輸下界份數 |
| sources | `crop_load_protein_max` | 0.64 | true | 每趟成功昆蟲蛋白運輸上界份數 |
| sources | `new_plant_event_probability` | 0.035 | true | 新花期或落果事件，用於後續世界擴充，未當前模型全實作 |
| sources | `insect_initial_living_F07` | 12 | true | 在F07的獨立小型昆蟲局部初始存活數，過渡假設，不是新食物 |
| sources | `insect_initial_living_F11` | 9 | true | 在F11的獨立小型昆蟲局部初始存活數，過渡假設，不是新食物 |
| sources | `insect_local_carrying_capacity` | 18 | true | 局部昆蟲最大可容納數，依棲地而定的遊戲近似 |
| sources | `insect_background_immigration_probability` | 0.08 | true | 每日從相鄰花園棲地遷入1隻已存在昆蟲的情境機率，記錄來源事件 |
| sources | `insect_local_daily_mortality_probability` | 0.22 | true | 每處已有存活昆蟲每日產生一次自然死亡的場址近似機率，絕非直接生成食物 |
| sources | `insect_initial_boundary_reservoir` | 40 | true | 相鄰庭園初始已有40隻活昆蟲的有限情境族群；遷入F07/F11須從此扣減，沒有上帝視角無限出現 |
| sources | `honeydew_per_aphid_colony_per_day` | 0.32 | true | ecological production per aphid colony with living host plants, independent of ant population |
| sources | `honeydew_per_scale_colony_per_day` | 0.4 | true | ecological production per scale-insect colony with living host plants, independent of ant population |
| sources | `honeydew_productivity_multiplier` | 1 | true | baseline physical productivity; single-variable sugar sensitivity test changes ONLY this input |
| sources | `hemipteran_colony_daily_growth_probability` | 0.012 | true | natural hemipteran colony reproduction game assumption; depends on living host |
| sources | `hemipteran_colony_daily_collapse_probability` | 0.006 | true | natural daily mortality/reproductive collapse of a colony, independent of ant demand |
| sources | `host_plant_daily_death_probability` | 0.0007 | true | garden host plant mortality; not reactive to colony demand |
| sources | `max_hemipteran_colonies_per_host` | 4 | true | physical carrying capacity per host plant, distinct from honeydew stored capacity |
| sources | `rain_honeydew_secretion_suppression_per_mm` | 0.018 | true | rain suppresses feeding/secretion production as ecological assumption |
| sources | `rival_honeydew_harvest_fraction_F04` | 0.22 | true | F04 background rival ants consume a fixed ecological share; independent of main colony shortage |
| sources | `insect_site_logistic_daily_birth_rate` | 0.065 | true | per-capita daily local insect birth chance scaled by available habitat capacity; assumption, not empirical rate |
| sources | `insect_boundary_logistic_daily_birth_rate` | 0.055 | true | self-renewal in the adjacent habitat, independent of colony demands |
| sources | `insect_boundary_carrying_capacity` | 80 | true | fixed ecological carrying capacity of neighboring habitat |
| sources | `insect_boundary_per_capita_daily_death_probability` | 0.02 | true | natural per-capita mortality of neighboring insects, no recoverable local carcass |
| sources | `insect_reproduction_reference_c` | 25 | true | synthetic mean air temperature reference for insect reproduction |
| sources | `insect_reproduction_per_degree_c` | 0.035 | true | game temperature sensitivity of insect reproduction per degree from reference |
| sources | `insect_reproduction_min_multiplier` | 0.15 | true | cold suppression floor for insect reproduction |
| sources | `insect_reproduction_max_multiplier` | 1.25 | true | warm ceiling for insect reproduction |
| sources | `insect_local_death_reference_population` | 12 | true | abundance used to scale existing 0.22 site mortality to current insect abundance |
| climate | `annual_rain_days` | 113.7 | true | 基準資料引用，但在模型中用於雨日prior，非特定日期實測 |
| climate | `wet_persistence` | 0.45 | true | 延續前日雨天的Markov額外持續係數 |
| climate | `temperature_ar` | 0.65 | true | 溫度距平日相關係數 |
| climate | `temperature_daily_sigma_c` | 1.8 | true | 日溫距平創新標準差，假設 |
| climate | `rainfall_gamma_shape` | 1.6 | true | 降雨Gamma形狀係數，假設 |
| climate | `nest_temp_memory` | 0.6 | true | 巢內緩衝溫度，不當真實巢溫 |
| climate | `soil_daily_loss` | 0.025 | true | 土壤日淨乾燥扣減，降低舊程式固定0.1 |
| climate | `soil_rain_gain_per_mm` | 0.045 | true | 每mm雨增加的無量綱土壤記憶 |
| climate | `soil_persistence` | 0.93 | true | 前日土壤記憶保留倍率 |
| climate | `soil_shade_daily_loss` | 0.013 | true | 遮蔽土每日扣減 |
| climate | `soil_shade_persistence` | 0.96 | true | 遮蔽土記憶保留倍率 |
| climate | `soil_shade_rain_gain_per_mm` | 0.025 | true | 遮蔽土每mm雨額外記憶 |
| model | `scenario_seed` | 15032026 | true | 不受Git SHA影響的固定遊戲情境種子 |
| model | `unit_precision` | 6 | true | 食物計算與存檔保留小數位數 |
| model | `population_safety_cap_for_trial` | 200 | true | 僅驗收用的膨脹上限；正式模擬不直接使用此限制 |
| model | `min_workers_alive_for_trial` | 1 | true | 30日驗收禁止無原因全巢滅亡；非遊戲免死設定 |
| foraging_physics | `route_edge_minutes` | 25 | true | 路線圖每條邊單程步行分鐘，拓樸與距離皆遊戲假設；非實際花園量測 |
| foraging_physics | `daily_window_minutes` | 360 | true | 假設單日可用覓食時段360分鐘，不是個體實測 |
| foraging_physics | `trail_daily_retention` | 0.55 | true | 單一費洛蒙路徑每日殘留比例，數值假設；文獻僅支持揮發與強化方向 |
| foraging_physics | `trail_deposit_per_success` | 0.35 | true | 每次成功運回食物的路段費洛蒙增加量，數值假設 |
| foraging_physics | `trail_min_detectable` | 0.08 | true | 局部工蟻可察覺路段費洛蒙下限，數值假設 |
| foraging_physics | `trail_max_strength` | 3 | true | 路段訊號飽和上限，數值假設 |
| foraging_physics | `crop_capacity` | 0.8 | true | 小工蟻嗉囊可持有之遊戲份數上限，非物種實測 |
| foraging_physics | `max_trophallaxis_contacts` | 3 | true | 回巢每次最多交哺接觸同伴數，數值假設 |
| foraging_physics | `transfer_max_portions` | 0.28 | true | 每次交哺最多交付的遊戲糖份，數值假設 |
| foraging_physics | `live_prey_encounter_probability` | 0.06 | true | 單次抵達F07/F11活昆蟲遇見率，遊戲假設 |
| foraging_physics | `large_prey_fraction` | 0.25 | true | 遇見昆蟲屬大型獵物之假設比例，非實測 |
| foraging_physics | `large_prey_min_team` | 2 | true | 大型獵物需同位置至少兩隻工蟻，遊戲假設 |
| foraging_physics | `live_prey_capture_probability` | 0.48 | true | 符合條件後捕獲活昆蟲機率，遊戲假設 |
| foraging_physics | `small_prey_protein` | 0.55 | true | 小型獵物蛋白遊戲份，非實測質量 |
| foraging_physics | `large_prey_protein` | 1.5 | true | 大型獵物蛋白遊戲份，非實測質量 |
| foraging_physics | `follow_intermediate_source_probability` | 0.55 | true | 工蟻抵達有食物的路線交叉點時，若仍嗅到前方費洛蒙，繼續追蹤的機率；遊戲假設，非實測 |
| foraging_physics | `repeat_trip_probability` | 0.5 | true | 成功首趟後在時間允許時再試第二趟機率；遊戲假設，不是物種實測 |

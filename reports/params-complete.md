# 《螞蟻帝國》v2 完整遊戲假設參數表

**所有 104 項均是 `assumption:true`、非科學實測。單位「份」是抽象遊戲單位，不是 mg。**

| 參數路徑 | 值 | 說明 |
|---|---:|---|
| `development.reference_c` | 25 | 以25°C為相對發育速率基準；機制參考 R94 |
| `development.egg_days` | 10 | 25°C卵期標準長度，遊戲假設；機制參考 R94 |
| `development.larva_days` | 12 | 25°C幼蟲期標準長度，遊戲假設，不等於實際野外幼蟲期；機制參考 R94 |
| `development.pupa_days` | 10 | 25°C蛹期標準長度，遊戲假設；機制參考 R94 |
| `development.q10` | 1.55 | 溫度每提高10°C之發育速度倍數，遊戲假設 |
| `development.min_temp_factor` | 0.48 | 環境低溫時發育減緩下限，遊戲假設 |
| `development.max_temp_factor` | 1.9 | 環境高溫時發育加速上限，遊戲假設 |
| `development.nest_buffer_fraction` | 0.55 | 巢內溫度相對外界均溫的緩衝權重，非實測 |
| `nutrition.starting_sugar` | 7.6 | Day14既有存糧不可測；作為Day15獨立情境起始糖儲備，約四天工蟻+蟻后基礎需求 |
| `nutrition.starting_protein` | 2.3 | Day14曾有兩次昆蟲來源帶回，作為Day15獨立情境的蛋白儲備假設，非由事件數換算 |
| `nutrition.worker_sugar_daily` | 0.1 | 每工蟻日糖消耗，單位份 |
| `nutrition.worker_protein_daily` | 0.008 | 每工蟻維生蛋白日耗，單位份 |
| `nutrition.queen_sugar_daily` | 0.22 | 蟻后日糖消耗，單位份 |
| `nutrition.queen_protein_daily` | 0.045 | 蟻后維生蛋白日耗，單位份 |
| `nutrition.larva_sugar_daily` | 0.025 | 每幼蟲日糖日耗，單位份 |
| `nutrition.larva_protein_daily` | 0.2 | 每幼蟲日蛋白耗，單位份 |
| `nutrition.egg_laying_protein_cost` | 0.14 | 每一顆卵的營養成本，單位份 |
| `nutrition.egg_laying_sugar_cost` | 0.08 | 每一顆卵的營養成本，單位份 |
| `nutrition.brood_protein_min_fraction` | 0.45 | 幼蟲吃到至少此比率的蛋白才可有效發育 |
| `nutrition.max_sugar_store` | 24 | 巢群本階段可存/嗉囊攜帶之糖份上限，會隨規模擴張 |
| `nutrition.max_protein_store` | 12 | 巢群本階段可存/處理之蛋白份上限，會隨規模擴張 |
| `starvation.queen_egg_pause_days` | 2 | 任一營養缺口累計2天停止產卵 |
| `starvation.worker_mortality_starts_days` | 4 | 連續糖缺口到4天開始額外死亡風險 |
| `starvation.larva_mortality_starts_days` | 5 | 連續蛋白缺口到5天開始幼蟲死亡風險 |
| `starvation.worker_daily_hazard_base` | 0.015 | 飢餓門檻後每日每蟻額外基礎死亡機率 |
| `starvation.worker_daily_hazard_slope` | 0.012 | 缺口每延長一天死亡機率增幅 |
| `starvation.larva_daily_hazard_base` | 0.05 | 幼蟲營養不足的基礎死亡率 |
| `starvation.larva_daily_hazard_slope` | 0.055 | 幼蟲缺蛋白每延長一天之機率增幅 |
| `starvation.queen_hazard_after_days` | 12 | 極端連續飢餓後蟻后也受風險 |
| `starvation.queen_daily_hazard` | 0.008 | 極端營養不足後蟻后每日額外死亡機率 |
| `starvation.worker_natural_daily_base_hazard` | 0.003 | 假定日自然死亡基礎機率，非本種精確死亡率；機制參考 R94 |
| `starvation.worker_age_risk_from_days` | 28 | 超過假設成蟻年齡後死亡風險逐日增加；機制參考 R94 |
| `starvation.worker_age_hazard_slope` | 0.00075 | 假設老化危險率每日增加量 |
| `starvation.injury_mortality_multiplier` | 1.4 | 有舊傷者自然死亡額外風險倍率 |
| `queen.base_laying_probability` | 0.38 | 無飢餓、卵數不太多時每日一卵機率，遊戲假設 |
| `queen.max_eggs_per_day` | 2 | 單日最大產卵數；本階段獨立情境人口控制 |
| `queen.existing_brood_pressure` | 0.011 | 每一隻既有幼體增加的繁殖抑制因子 |
| `queen.previous_laying_penalty` | 0.6 | 昨日有產卵時今日產卵機率倍率 |
| `queen.adequate_nutrition_threshold` | 0.84 | 若當日資源滿足比例低於此則產卵暫停 |
| `workers.newborn_initial_age_days` | 0 | 新羽化成蟻年齡從零開始 |
| `workers.legacy_unknown_age_initial_days` | 7 | Day14舊工蟻真實成年年齡未知，Day15採遊戲假設7天 |
| `workers.rest_baseline_probability` | 0.22 | 基礎休息比例，依飢餓狀態變動 |
| `workers.nurse_baseline_probability` | 0.25 | 基礎育幼偏好 |
| `workers.maintenance_baseline_probability` | 0.12 | 巢口維護基礎偏好 |
| `workers.forage_baseline_probability` | 0.36 | 基礎覓食偏好，營養缺乏與招募將提高 |
| `workers.defence_baseline_probability` | 0.05 | 巢口警戒偏好 |
| `workers.injury_foraging_multiplier` | 0.45 | 受傷個體覓食意願下降倍率 |
| `workers.injury_repair_probability` | 0.05 | 舊傷個體每日復原機率（需食物與休息） |
| `workers.newborn_nurse_days` | 4 | 新羽化頭幾日優先巢內工作，遊戲假設 |
| `workers.recruitment_probability` | 0.55 | 成功覓食者在巢內接觸其他工蟻之招募機率 |
| `workers.recruitment_max_followers` | 3 | 每筆成功食物資訊最多影響三隻同巢工蟻 |
| `workers.scout_discovery_probability` | 0.25 | 無既知食源時探索新地點成功機率 |
| `workers.max_trips_per_forager` | 2 | 每覓食工蟻單日最大外勤次數 |
| `workers.foraging_trip_sugar_cost` | 0.012 | 覓食路線附加糖耗份數 |
| `workers.rain_suppression_fraction` | 0.035 | 每mm雨對出勤/採集倍率的減損，上限截斷 |
| `workers.min_rain_activity_multiplier` | 0.35 | 暴雨仍可能有部分微氣候遮蔽路線 |
| `workers.local_communication_retention_days` | 3 | 招募訊號只保持短期局部記憶 |
| `workers.nest_contact_route_learning_probability` | 0.28 | 每日同巢局部接觸，借由另一隻熟悉路線工蟻學到某已知食源路線的機率（非全知）；機制參考 R95; R116 |
| `workers.protein_source_choice_bias` | 4.5 | 蛋白庫不足3日需求時，同時熟悉多處工蟻選已知蛋白來源的相對偏好；機制參考 R112 |
| `sources.honeydew_max` | 5.2 | 蜜露F01總可及糖份上限 |
| `sources.honeydew_daily_replenish` | 0.65 | 寄主與蚜蟲仍活著時每日補充糖份 |
| `sources.honeydew_initial` | 0.55 | Day14 F01有蚜蟲但無可採蜜露；Day15起始少量保守情境 |
| `sources.nectar_max` | 2.4 | F08花蜜份數上限 |
| `sources.nectar_daily_replenish` | 0.35 | 花仍在開放期時日補充量 |
| `sources.nectar_initial` | 0.18 | Day14無可確認花蜜之情境假設 |
| `sources.nectar_bloom_days_remaining` | 12 | Day15起餘下開花期假設 |
| `sources.honeydew_washoff_per_rain_mm` | 0.012 | 每mm雨使蜜露減少的比例 |
| `sources.nectar_washoff_per_rain_mm` | 0.035 | 每mm雨造成花蜜沖刷比例 |
| `sources.carcass_initial_F07` | 0.6 | 保留Day11 F07 V2D11-E04屍體可能剩餘的蛋白份數；高不確定性 |
| `sources.carcass_initial_F11` | 0.07 | 保留Day9 F11舊屍剩餘蛋白份數；已採部分且腐敗更久 |
| `sources.carcass_initial_F07_older` | 0.05 | 保留Day10 F07舊殘骸少量假設 |
| `sources.carcass_daily_decay_fraction` | 0.14 | 未採集殘骸每一日可食份數減少比例 |
| `sources.carcass_rain_decay_bonus` | 0.004 | 每mm雨額外可食減少比例 |
| `sources.carcass_new_protein_min` | 1.45 | 新屍體蛋白份數下界 |
| `sources.carcass_new_protein_max` | 2.6 | 新屍體蛋白份數上界 |
| `sources.carcass_access_probability` | 0.7 | 到達且食物剩餘時遇到/可採的機率 |
| `sources.carcass_max_lifetime_days` | 9 | 殘骸來源最長保留9天；只刪除已腐化且無可食量來源 |
| `sources.crop_load_sugar_min` | 0.28 | 每趟成功糖運輸下界份數 |
| `sources.crop_load_sugar_max` | 0.62 | 每趟成功糖運輸上界份數 |
| `sources.crop_load_protein_min` | 0.3 | 每趟成功昆蟲蛋白運輸下界份數 |
| `sources.crop_load_protein_max` | 0.64 | 每趟成功昆蟲蛋白運輸上界份數 |
| `sources.new_plant_event_probability` | 0.035 | 新花期或落果事件，用於後續世界擴充，未當前模型全實作 |
| `sources.insect_initial_living_F07` | 12 | 在F07的獨立小型昆蟲局部初始存活數，過渡假設，不是新食物；機制參考 R95; R98 |
| `sources.insect_initial_living_F11` | 9 | 在F11的獨立小型昆蟲局部初始存活數，過渡假設，不是新食物；機制參考 R95; R98 |
| `sources.insect_local_carrying_capacity` | 18 | 局部昆蟲最大可容納數，依棲地而定的遊戲近似；機制參考 R95; R98 |
| `sources.insect_background_immigration_probability` | 0.08 | 每日從相鄰花園棲地遷入1隻已存在昆蟲的情境機率，記錄來源事件；機制參考 R95; R98 |
| `sources.insect_local_daily_mortality_probability` | 0.22 | 每處已有存活昆蟲每日產生一次自然死亡的場址近似機率，絕非直接生成食物；機制參考 R95; R98 |
| `sources.insect_initial_boundary_reservoir` | 40 | 相鄰庭園初始已有40隻活昆蟲的有限情境族群；遷入F07/F11須從此扣減，沒有上帝視角無限出現；機制參考 R95 |
| `climate.annual_rain_days` | 113.7 | 基準資料引用，但在模型中用於雨日prior，非特定日期實測；機制參考 CWA 1991-2020 |
| `climate.wet_persistence` | 0.45 | 延續前日雨天的Markov額外持續係數 |
| `climate.temperature_ar` | 0.65 | 溫度距平日相關係數 |
| `climate.temperature_daily_sigma_c` | 1.8 | 日溫距平創新標準差，假設 |
| `climate.rainfall_gamma_shape` | 1.6 | 降雨Gamma形狀係數，假設 |
| `climate.nest_temp_memory` | 0.6 | 巢內緩衝溫度，不當真實巢溫 |
| `climate.soil_daily_loss` | 0.025 | 土壤日淨乾燥扣減，降低舊程式固定0.1 |
| `climate.soil_rain_gain_per_mm` | 0.045 | 每mm雨增加的無量綱土壤記憶 |
| `climate.soil_persistence` | 0.93 | 前日土壤記憶保留倍率 |
| `climate.soil_shade_daily_loss` | 0.013 | 遮蔽土每日扣減 |
| `climate.soil_shade_persistence` | 0.96 | 遮蔽土記憶保留倍率 |
| `climate.soil_shade_rain_gain_per_mm` | 0.025 | 遮蔽土每mm雨額外記憶 |
| `model.scenario_seed` | 15032026 | 不受Git SHA影響的固定遊戲情境種子 |
| `model.unit_precision` | 6 | 食物計算與存檔保留小數位數 |
| `model.population_safety_cap_for_trial` | 200 | 僅驗收用的膨脹上限；正式模擬不直接使用此限制 |
| `model.min_workers_alive_for_trial` | 1 | 30日驗收禁止無原因全巢滅亡；非遊戲免死設定 |

# 《螞蟻帝國》模擬引擎 ODD 描述（ODD protocol, Grimm et al. 2006／2010／2020）

- **描述對象**：目前的引擎，行為版本 `antempire.v2-review.19-evaluation-corrections`（`engine/day.ts:39`），實作版本 `antempire.engine-ts.1`（`engine/day.ts:41`）。
- **依據**：`engine/*.ts`、`species/pheidole-megacephala.json`、`world/xitun-garden.json`、`scenarios/day0/*.json`、`cli/lib/day0.ts`，以及 `CLAUDE.md`、`docs/gm-rules.md`、`docs/engine-architecture.md`、`docs/species-pheidole-megacephala.md`、`docs/references.md` 等文件。
- **性質**：本文件只描述現況，不改任何程式、參數或存檔，也不推進遊戲日。所有定量數值都是遊戲模型，不是野外實測（`CLAUDE.md` §0、§3）。
- **檔案行號**：寫成 `檔案:行`，以撰寫時的 HEAD（分支 `claude/ant-empire-engine-refactor-i45q93-vision-roadmap`，commit `5990d48`）為準。
- **撰寫與核對**：2026-11-02 由程式碼整理而成。已抽查的結論：F08 的 12 日花期在 30 日暖機內結束（`scenarios/day0/garden.json`、`engine/ecology.ts:80-85`），所以 Day0 世界在 Day0 之後 F08 沒有花蜜；出發前會檢查整趟能否在時窗內完成（`engine/activity.ts:115-116`）。其他行號引用若與程式不符，以程式為準並請指出。
- **規則更新時同步修訂本文件**（統一需求 §6.2）。
- **2026-11-03 更新**：D3 已由 Owner 決定（蟻后、工蟻、幼蟲都依個體實際生理與局部訊號運作），下文標「Owner 待決」的偏離 G1～G9 因此都是**待修缺陷**，由工作包 C 處理；Issue #43 另指出本文件漏列 F02～F05（已由 #44 修正，待審）。
- **參數標註**：參數的分類（文獻支持／一般生理學／遊戲假設）一律照抄參數檔的 `basis` 欄位。標註看起來不一致的地方，在 §7.0 與各子模型中另外標出「⚠ 標註疑點」。

---

## 1. 目的與模式（Purpose and patterns）

### 1.1 目的
模型以熱帶大頭家蟻（*Pheidole megacephala*）為主角，是一個**科學啟發式**的個體導向模型（agent-based model）。舞台是臺中市西屯區一座虛構獨棟別墅花園。模型要回答的是：

1. 一個小型蟻群（目前 10～20 隻工蟻的規模）在給定的花園生態與合成天氣下，工蟻**只靠局部訊號**（自己的嗉囊、實際碰到的同伴與幼蟲、自己走過的路、局部費洛蒙）做決策時，會湧現出什麼樣的覓食、營養、發育與存亡動態。
2. 在不同的創巢情境（Day0 A1～A5）與四季開始日下，這些動態的分布是什麼。
3. 作為遊戲的正式推進引擎：每次推進一個生態日，結果可重播、可稽核，不受 GM 干預（`CLAUDE.md` §2.3、§5）。

模型**不是**預測工具。驗收指標（例如 60 日工蟻比例、羽化）只是診斷，不是目標（`CLAUDE.md` §7、`docs/gm-rules.md` §4）。

### 1.2 用來檢核模型的模式（pattern-oriented modelling）
以下是文件與文獻中可用來檢核模型結構的觀察模式，以及目前的檢核狀態。

- 「已檢核」表示有報告或測試直接比較。
- 「依建構相容」表示參數本來就是為了落在該範圍而選的，所以**不構成獨立驗證**。

| # | 模式（觀察） | 來源 | 層級 | 目前狀態 | 出處 |
|---|---|---|---|---|---|
| P1 | 卵→成蟲發育時間隨溫度變化：28°C 約 28.7 日；20～22°C 66～78 日 | R94 Yuan 2026；R166 Fluker 1969；R167 Phillips 1933；R136 Chang 1985 | 個體 | **部分已檢核，結果不符**：28°C 引擎給 28.1 日（相符）；21°C 只給 38.1 日（觀察 66～78 日） | `docs/research-design-2026-11.md` §3.2 |
| P2 | 小工蟻壽命：28°C、食物無限，中位 28 日、平均 26.25 日 | R94 | 個體 | **已檢核（解析），結果不符**：引擎無飢餓時中位約 64 日，且與溫度無關 | `docs/research-design-2026-11.md` §4；本文 §8 D2 |
| P3 | 沒有工蟻的蟻后在 2～3 週內死亡 | R136 | 個體 | **依建構相容**：無工蟻第 14 日起每日 0.24，中位約第 16 日。兩個數值都是遊戲假設（v19 更正） | `species/...json` `starvation.queen_zero_worker_*`；`docs/gm-rules.md` v19 段 |
| P4 | 創巢對照：蟻后＋10 蛹 6/6 成長；蟻后＋10 野外工蟻很弱（7 週內 2/6 蟻后死亡） | R136（實驗室 26～27°C、人工餵食） | 群體 | **已做定性比較**：A5（新羽化工蟻）＞A1（混齡工蟻），方向一致；A4（蟻后＋10 蛹）反而最差，條件不同（花園無人工餵食） | `reports/day0-final-report-2026-11.md` §5 |
| P5 | 單后 31 日產卵 97～292 粒，成批產卵、批間暫停 | R136；R94（定性） | 個體 | **未檢核，結構上無法達成**：引擎每日最多 2 粒（31 日上限 62 粒）；25°C 無幼體時穩態約 0.4 粒／日 | `docs/research-design-2026-11.md` §2；未合併分支 phase3 E4 |
| P6 | 招募流量約 20 分鐘達高峰；兩種費洛蒙半衰期約 10／17 分鐘 | R152＝R21／R96 Dussutour 2009（本種，大群） | 群體 | **未檢核**：費洛蒙是逐日衰減，沒有分鐘尺度 | `docs/references.md` R152 |
| P7 | 多數覓食者一天少趟、少數多趟；回巢者調節出巢率 | R150 Gordon 2011 等（非本種） | 群體 | **定性觀察相符**：A1 秋，平均 2.558 趟／出巢工蟻日，趟數分布右偏 | `reports/day0-final-report-2026-11.md` §4 |
| P8 | 臺中都市樣點白天活動較高、夜間較低但仍有活動；森林日夜相近 | R145 Chen & Neoh 2023 | 群體 | **無法檢核**：引擎沒有一天中的時刻，只有固定 360 分鐘時窗 | 未合併分支 phase2 `reports/phase2-behaviour-review.md` §7 |
| P9 | 冬季地表活動下降 | Harada et al. 2021（`docs/gm-rules.md` v2-review.5 段） | 群體 | **未定量檢核**：只有逐月出勤率報告，沒有和觀察資料比對 | `docs/gm-rules.md` v2-review.5 段 |
| P10 | 兵蟻比例：野外 0.06～0.25；28°C 新羽化 11.86%；100 隻以下的巢只產小工蟻 | R97；R94；R167 | 群體 | **無法檢核**：沒有 major | `docs/research-design-2026-11.md` §5 |
| P11 | 大型獵物由 2～10 隻工蟻共同壓制與搬運 | R98／R107 Dejean 2007 | 個體／小群 | **由參數強制**（`large_prey_min_team` 2、`large_prey_max_team` 10），不是湧現結果；`tests/hunting.test.ts` 檢的是規則 | `species/...json` predation |
| P12 | 臺中都市族群營養階較高（偏肉食） | R177 Peng et al. 2023 | 群體 | **未檢核**，只能事後比對、不得調參 | `docs/research-design-2026-11.md` §6.1 |
| P13 | 臺灣蚜蟲族群成長與溫度、季節相關 | R179、R180 | 世界 | **未建模**：半翅目與溫度、季節無關 | `docs/day0-initialization.md` §9 D5 |
| P14 | 內部一致性：糖／蛋白質量守恆、工蟻與幼體人數守恆、每份屍體都有死亡來源、事件型別登錄 | 模型規則 | 全模型 | **每日強制檢查**，任何失敗都會拋錯 | `engine/day.ts:97-137` |

---

## 2. 實體、狀態變數與尺度（Entities, state variables, and scales）

食物單位一律是「**份**」（game portions，`unit: 'game_portions_NOT_mg'`，`engine/day.ts:119`），不是毫克。數值存檔精度為 6 位小數（`engine/math.ts:6-9`；`world.model.unit_precision` 必須等於 6，`engine/params.ts:181-182`）。

### 2.1 世界（`WorldState`，`engine/types.ts:159`）
| 變數 | 型別／單位 | 說明 |
|---|---|---|
| `schema` | `'antempire.world-state.v3'` | 狀態格式 |
| `sim_day` | 整數，日 | 已完成的模擬日（Day0 世界從 0 起；正式世界目前 14） |
| `calendar_date` | YYYY-MM-DD | 曆日 |
| `seed` | 整數 | 世界種子，所有亂數串流的根（§4.9） |
| `climate` | `ClimateState` | 氣候記憶（§2.2） |
| `sources` | `Record<id, Source>` | 實體食源（§2.3） |
| `ecology` | `WorldEcology` | 被追蹤的昆蟲族群（§2.3） |
| `colonies` | `ColonyState[]` | 蟻群（§2.5）；目前只模擬一個 |
| `migration_log`、`rules_fingerprint`、`active_signals`、`last_world_events` | — | 出處與觀察紀錄；`simulateWorldDay` 只接受這一組鍵（`engine/day.ts:141,150`） |

正式存檔目前是 v2 單蟻群格式（`antempire.engine-v2`），由 `engine/legacy.ts` 轉成同一個世界視圖執行（`engine/legacy.ts:54-62`）。

### 2.2 天氣與氣候
**氣候記憶 `ClimateState`**（`engine/types.ts:124`）：

| 變數 | 單位 | 說明 |
|---|---|---|
| `monthly[12]` | °C、%、mm | 月平均氣溫、月平均日最高／最低、相對濕度、月雨量（CWA 1991～2020 平年值） |
| `prior_wet` | 布林 | 昨日是否下雨（Markov 持續性） |
| `temp_anomaly_c` | °C | 昨日氣溫距平（AR(1)） |
| `prior_air_temp_c` | °C | 昨日日均氣溫 |
| `prior_nest_temp_model_c` | °C | 昨日模型巢溫（v2-review.7 起作為巢溫記憶） |
| `soil_index` | 0～1，無因次 | 地表濕度指標 |
| `shade_index` | 0～1，無因次 | 遮蔭土壤濕度指標 |
| `rain_days_per_year` | 日 | 由氣候檔複製而來，但**引擎不讀**（雨日先驗用的是世界參數 `climate.annual_rain_days`；v19 E5 的發現，`reports/rules-update-v19-review.md` §2） |

**每日天氣 `Weather`**（`engine/weather.ts:68-74`）包含：

- `air_temp_c`（日均）、`daily_max_air_temp_c`、`daily_min_air_temp_c`；
- `daytime_air_temp_c`：等於合成日最高溫，作為「白天」代理，不是實測地表溫；
- `nest_temp_model_c`、`relative_humidity_model_percent`、`rain_mm`、`wet`；
- `soil_index`、`shade_index`、`temperature_anomaly_c`、`rain_probability_model`；
- `kind: 'synthetic_climatology_game_assumption_not_real_weather'`。

### 2.3 食源、植物、半翅目、昆蟲、屍體
**食源 `Source`**（`engine/types.ts:80`）位於圖上的節點，種類有三種：

| 種類 | 狀態變數（單位） |
|---|---|
| `honeydew`（蜜露） | `sugar`（份）、`capacity`（份）、`host_alive`、`host_plants`（株）、`hemipteran_kind`（`aphid`／`scale`）、`hemipteran_colonies`（群）、`production_per_day`／`production_last_day`（份／日）、`access_from`、`ecological_record` |
| `nectar`（花蜜） | `sugar`、`capacity`、`production_per_day`、`bloom_days_left`（日）、`host_alive` |
| `carcass`（屍體） | `protein`（份，等於各批次的總和）、`batches[]`：`{event_id, original_day, protein, age_days, origin}`，每一批都有死亡來源 ID |

**昆蟲族群 `WorldEcology`**：

- `adjacent_garden_living_insects`：鄰接花園邊界的活昆蟲數（隻），另有容納量；
- `insects_by_site[site]`：只在屍體地點（F07、F11），欄位為 `{living, carrying_capacity, cumulative_deaths}`。

**背景蟻群**：不是個體，只是世界參數。F04 蜜露被取走固定比例 0.22（`world.background_colonies.F04_rival`）；F03 沒有數值作用。

### 2.4 空間：地點與路線（**是圖，不是連續空間**）
- **空間結構**：一個無向圖。
  - 節點有：`N00`（主巢）、`F01`、`F04`、`F05`、`F07`、`F08`、`F10`、`F11`、`U00`、`U01`。
  - 共 10 條邊：`N00–F01`、`N00–F08`、`N00–F07`、`N00–F11`、`N00–U00`、`N00–U01`、`F01–F04`、`F04–F05`、`F08–F05`、`U01–F10`（`world/xitun-garden.json` `routes.topology.edges`；標為遊戲假設，「不是庭園地理量測」）。
- **沒有座標**：`docs/ecosystem-world.md` §1 明訂座標為 `null`，只保留「方位詞＋約距離」：
  - F01「東北葉背」約 48 cm；F04「北側石牆縫」約 92 cm；F05「東南矮草」約 73 cm；F07「東側石塊底」約 31 cm；
  - F08「西北小白花」約 83 cm；F10「南側雜草根際」約 42 cm；F11「南側腐葉堆」約 35 cm。
  - 方位詞只是敘事描述，**引擎完全不使用方位**。
- **路段長度**：只有 4 條邊有記錄長度（`routes.edge_length_cm`）：N00–F01 48 cm、N00–F07 31 cm、N00–F08 83 cm、N00–F11 35 cm。
  - 這 4 個值都標為遊戲假設，是直線「約距離」，作為路徑長度的下限。
  - `path_tortuosity` = 1。
- **長度未知的邊**：其餘 6 條邊沒有長度，每條固定用 `route_edge_minutes` = 25 分鐘（`engine/activity.ts:60-66`）。
  - 注意：F04、F05、F10 在世界文件中有「到主巢的約距離」，但在圖上必須經過中間節點，而中間路段長度未知，所以這些距離沒有被使用。
- **位置的表示**：工蟻只能位於某個節點，或在時間軸中處於「`transit:A>B`」標籤（`engine/activity.ts:109`）。沒有連續座標，也沒有地點內部的空間。
- **蟻巢**：只是一個節點 `N00`，**沒有巢室、容量或內部空間**。

### 2.5 蟻群（`ColonyState`，`engine/types.ts:137`）
| 變數 | 單位 | 說明 |
|---|---|---|
| `id`、`species_id`、`nest_node`、`queen_id` | — | 識別；物種決定使用哪一份參數檔 |
| `rng_namespace`、ID 前綴、`next_worker_number`、`next_egg_number` | — | 亂數命名空間與編號 |
| `stores.sugar`、`stores.protein` | 份 | 巢內食物總帳。**糖帳包含所有工蟻嗉囊中的糖**（嗉囊是糖帳的子集合，`engine/nutrition.ts:1-6`） |
| `stores.sugar_gap_days`、`protein_gap_days` | 日 | 連續「滿足率 < 0.995」的日數 |
| `stores.stress_days` | 日 | 上述兩者的較大值 |
| `stores.queen_laid_yesterday` | 布林 | 昨日是否產卵 |
| `stores.no_worker_days` | 日 | 連續沒有工蟻的日數 |
| `trail_by_edge` | 無因次，0.08～3 | 本蟻群在每條邊上的費洛蒙強度（單一訊號模型） |
| `source_knowledge[id]` | `{presence, known_by[]}` | **簿記用**：`potential`／`confirmed_game_scenario`／`scouted_empty`。v17 時間軸中，工蟻決策不讀它（只寫入） |
| `population` | — | `{queen_alive, workers[], brood[]}` |

### 2.6 蟻后
- 只用 `population.queen_alive`（布林）與 `queen_id` 表示，**每個蟻群只有一隻蟻后**。
- 沒有年齡、體儲備、卵巢狀態或位置。
- 蟻后的營養與產卵條件由蟻群帳決定（§7.11、§7.13）。

### 2.7 工蟻（`Worker`，`engine/types.ts:27`）
| 變數 | 單位 | 說明 |
|---|---|---|
| `id`、`alive` | — | 唯一 ID |
| `age_days` | 日 | 成蟲日齡（每日 +1，`engine/foraging.ts:425`） |
| `age_origin` | — | 年齡來源（例如 `born_after_v2_migration`、`founded_day0_*`） |
| `injured`、`injury_type`（`abrasion`／`appendage_damage`／`unknown`）、`injury_body_part`、`injury_record` | — | 傷勢；引擎**不產生新傷勢**，只來自存檔紀錄 |
| `task` | `forage`／`nurse`／`rest`／`repair`／`guard` | 當日任務（每日抽一次） |
| `known_sources[]` | — | 自己到過的食源 |
| `route_memory` | `{origin, edges{key:{acquired, first_day, last_day}}, empty_sites{site:day}}` | 自己走過的路段（v2-review.14） |
| `site_memory[site]` | `{last_success_portions（份）, last_visit_day（日）}` | 對每個地點的最近收穫記憶 |
| `local_sensory` | 0～1 | `own_crop_sugar_fill`（自己的飽足印象）、`peer_sugar_hunger`、`peer_protein_request`、`direct_brood_begging`、`unload_feedback{sugar,protein}`、`own_feeding_fraction`、`last_food_kind`、`last_unloading_ease` |
| `crop_cargo_sugar` | 份 | 嗉囊中實際攜帶的糖（上限 `crop_capacity` 0.8 份） |
| `last_location` | 節點 ID | 每日結束時必須在巢（`engine/activity.ts:429-431`） |

所有工蟻在型態上都是 minor：羽化標籤為 `minor_worker_scenario_unverified`；`castes.major_worker_production_enabled` 為 false，若設為 true 引擎會拒絕執行（`engine/params.ts:116-118`）。

### 2.8 幼體（`Brood`）
| 變數 | 單位 | 說明 |
|---|---|---|
| `id`、`stage` | `egg`／`larva`／`pupa` | — |
| `progress` | 0～1，無因次 | 本階段的發育進度，達到 1 就轉入下一階段 |
| `age_days`、`laid_on_day` | 日 | 可以是 null（年齡未知） |
| `begging_signal` | 0～1 | 幼蟲的求食訊號 |
| `no_caretaker_days` | 日 | 連續沒有工蟻照護的日數 |

卵與蛹不進食，只有幼蟲進入營養需求。

### 2.9 時間尺度
- **主步長**：1 個生態日（`runWorldDay`，`engine/day.ts:86-139`）。天氣、生態、代謝、發育、死亡、產卵都以日為單位。
- **日內時間軸**（v2-review.17，開關 `activity.individual_timeline` = true）：
  - 外出的工蟻在 0～`foraging_activity.daily_window_minutes` = **360 分鐘**的連續時鐘上，以事件佇列處理（`engine/activity.ts:68-437`）。
  - 時窗**不對應一天中的任何時刻**（沒有日出、日落、逐時溫度），所有覓食工蟻都在第 0 分鐘開始決策（`engine/activity.ts:412`）。
  - 天氣在時窗內不變。
- **舊模型**（開關關閉時，只供隔離證明使用）：每條邊 25 分鐘、每隻工蟻預定一趟、成功後以 0.5 機率再一趟（`engine/foraging.ts:437-629`）。
- **時間範圍**：
  - 正式世界：從 Day14 起每次推進一天，只在玩家明確要求時推進；
  - Day0 評估：365 日 × 四季 × 20 種子。

---

## 3. 過程概述與排程（Process overview and scheduling）

### 3.1 每日固定順序（`engine/day.ts:86-139`）
1. **天氣**：`calcWeather`（`engine/day.ts:93`；世界層級，不讀任何蟻群）。
2. **獨立生態**：`growEcology`（`engine/day.ts:96`）。
   - 依 `sources` 的鍵順序處理每個食源：屍體分解；蜜露的寄主死亡、半翅目群數變化、分泌、背景蟻群取食、雨水沖刷；花蜜的開花與沖刷。
   - 再處理昆蟲族群：邊界族群的死亡與出生；各屍體地點的自然死亡（產生屍體批次）、出生與遷入。
   - 之後檢查：每份新屍體都必須有對應的昆蟲死亡事件（`engine/day.ts:97`）。
3. **各蟻群覓食**（`forageDay`，`engine/day.ts:99`；蟻群依陣列順序處理），內部依序為：
   1. `ensureRouteMemory`：補上沒有路線記憶的工蟻（`engine/foraging.ts:420`）；
   2. `decayTrails`：費洛蒙每日衰減（`engine/foraging.ts:421`）；
   3. `nestContacts`：巢內接觸（`engine/foraging.ts:422`）；
   4. 依族群陣列順序，對每隻工蟻：`selectTask` → `age_days++` → 若任務是育幼則做 `nurseContact` → 若任務是覓食且在巢，就成為今天的覓食者（`engine/foraging.ts:424-429`）；
   5. `activityDay`：日內事件時鐘（`engine/foraging.ts:432-436`；§3.2）。
   - 再次檢查食物的因果來源（`engine/day.ts:100`）。
4. **各蟻群的巢內生理**（`engine/day.ts:106-126`），每個蟻群依序執行：
   1. `storageOverflow`：超過儲存上限的部分丟失；
   2. `consume`：代謝與分配；
   3. `developBrood`：發育、無照護死亡、幼蟲飢餓死亡、羽化；
   4. `workerSurvival`：工蟻死亡與傷勢復原；
   5. `queenSurvival`：蟻后死亡；
   6. `oviposition`：產卵；
   7. 結算人口與存量，並檢查質量帳（誤差容許 2e-5，`engine/day.ts:121-125`）。
5. **事件型別檢查**：所有事件必須屬於 `NATURAL_EVENT_TYPES`（`engine/day.ts:48,127`）。
6. **更新與驗證**：`nextClimate`（`engine/day.ts:129`）→ `sim_day += 1`、日期 +1（`:130`）→ `validateWorld`（`:131`）→ 工蟻與幼體人數守恆（`:132-137`）。

**排程的含意**：
- 覓食決策用的是**昨天**的飽足與求食訊號，因為當日代謝在覓食之後才計算。
- 儲存溢出在代謝前計算，使用的是死亡前的工蟻數。
- 產卵在死亡之後計算。
- 新羽化的工蟻當日加入族群，從次日才開始選任務。

### 3.2 日內事件時鐘（`engine/activity.ts`）
- **事件佇列**：依時間排序。同一時刻依事件種類排序（`home` < `arrive` < `resolve` < `searched` < `decide`），再依工蟻 ID（`engine/activity.ts:49-50,74-79`）。
- **作廢機制**：每隻工蟻有一個 `token`。被招募或加入獵物等待時 token 會改變，舊事件就作廢（`engine/activity.ts:417`）。
- **一趟的循環**（`engine/activity.ts:9-14`）：
  1. 在巢內決定；
  2. 走自己記得的路線，或沿費洛蒙／探索；
  3. 到達，搜尋 2 分鐘；
  4. 採集，或捕食／加入等待中的獵物；
  5. 沿原路走回巢；
  6. 卸貨（交給當時在巢內的同伴，2 分鐘）→ 留下費洛蒙 → 可能招募 → 決定是否再出發；
  7. 若再出發，先休息 5 分鐘再決定。
- **時間檢查**：任何行動若無法在時窗內完成，就取消並記錄（`fits`，`engine/activity.ts:116`）。
- **日終**：每隻工蟻都必須在巢內（`engine/activity.ts:429-431`）。
- **v2-review.20（#44，合併後才生效；本節其餘內容描述 v19）**：沿費洛蒙一次走一段、抵達時才感知（F02）；可中斷的搜尋（F03）；每段外出只結算一次能量（F05）；走完才學路線、卸貨結束時才招募（R11）。PR #44 補充審查另外改成：
  - 沒有搬運獵物的工蟻沿自己的路線回巢；共同搬運沿在場搬運者之一走過的路線（遊戲假設）；
  - 遠處節點的出口只讀工蟻自己站在該處時記下的觀察（`route_memory.perceived_exits`）；
  - 回巢招募的發現者走完每一段才在該段留下費洛蒙（事件 `trail` 在同一分鐘的其他事件之前處理）；
  - `fits` 不讀費洛蒙，一律以離開費洛蒙的速度估計（G8 的「完美預知」仍包含世界路段長度與時窗，屬時窗模型的遊戲假設）。
  - 步行在事件時鐘上逐段進行（佇列事件 `step`），每段速度依工蟻踏上該段時的費洛蒙；守住或加入等待中的獵物、沿費洛蒙繼續前進前，都先確認來得及沿自己的路線回巢（獨立審查後的修正）。

### 3.3 亂數具名串流（RNG named streams）
- **生成方式**：每個串流的種子是 `hash32(`${seed}|${sim_day+1}|${namespace+tag}`)`，取 SHA-256 前 4 位元組的 little-endian 整數；產生器是 mulberry32 式（`engine/rng.ts:11-30`）。
- **好處**：增減某一次抽籤，不會讓其他無關的決策跟著改變。
- **蟻群命名空間**：串流名稱前面加上 `rng_namespace`。正式主蟻群用空字串；Day0 蟻群用 `D0|`。

| 串流標籤 | 用途 | 位置 |
|---|---|---|
| `weather` | 雨日、氣溫距平（Box–Muller）、雨量（Marsaglia–Tsang Gamma） | `engine/weather.ts:48` |
| `ecology` | 寄主死亡、半翅目增減（所有蜜露點共用一條，依鍵順序抽） | `engine/ecology.ts:121` |
| `insect_demography:adjacent_garden_habitat`、`insect_demography:<site>` | 昆蟲死亡、出生、遷入 | `engine/ecology.ts:91,100` |
| `task:<worker>` | 任務抽籤與低溫出勤門檻 | `engine/workers.ts:44` |
| `nest_contact:<worker>` | 巢內接觸 | `engine/workers.ts:66` |
| `nurse_contact:<worker>` | 育幼接觸 | `engine/workers.ts:79` |
| `act:<worker>:<n>:<purpose>` | 時間軸中第 n 個行動，purpose 為 `decide`、`continue_after_failure`、`site`、`unload` | `engine/activity.ts:80-83` |
| `nest_sugar_feeding_allocation` | 巢內分糖時的工蟻順序洗牌 | `engine/nutrition.ts:82` |
| `brood_survival:<id>` | 幼蟲飢餓死亡 | `engine/brood.ts:27` |
| `adult_survival:<worker>` | 工蟻死亡與傷勢復原 | `engine/queen.ts:17` |
| `queen_survival` | 蟻后死亡 | `engine/queen.ts:51` |
| `oviposition` | 產卵（第一粒與第二粒） | `engine/queen.ts:78` |
| Day0：`day0_founder_ages:<founding>`（sim_day = −1）、`hash32(seed|day0_garden_host|<site>)` | 創巢工蟻年齡、不確定寄主是否存在 | `engine/initialization.ts:105,67` |
| 只在舊模型使用：`scout:`、`collect:`、`target:`、`explore:`、`hunt:`、`hunt-join:`、`hunt-unload:` | 開關關閉時的舊路徑 | `engine/foraging.ts` |

---

## 4. 設計概念（Design concepts）

### 4.1 基本原則（Basic principles）
1. **無上帝視角**（`CLAUDE.md` §2.1）：工蟻的決策只用局部訊號——
   - 自己的嗉囊與餵食經歷；
   - 實際接觸到的同伴與幼蟲；
   - 親身走過的路線與食源記憶；
   - 有局部來源的招募與費洛蒙。
2. **生態獨立**（§2.2）：`ecology.ts` 與 `weather.ts` 的輸入不含任何蟻群（`engine/ecology.ts:1-6,12`）；由 `tests/local-ecology.test.ts` 靜態檢查。
3. **GM 不干預**：
   - `simulateWorldDay` 只接受兩個參數（`engine/day.ts:148`）；
   - 拒絕未授權的輸入鍵（`:150`）；
   - 食物只能來自已追蹤昆蟲的死亡（`:76-80`）。
4. **營養以份計的雙營養帳**：糖與蛋白分開；儲存、代謝、產卵成本與溢出逐日結算（`engine/day.ts:119-125`）。
5. **溫度效應用 Q10 形式**：代謝 Q10 = 2（一般生理學）、發育 Q10 = 1.55、產卵 Q10 = 2.5（遊戲假設）。

### 4.2 湧現（Emergence）
以下是個體規則與環境互動的結果，不是直接指定的：

- 每隻工蟻每日的出巢趟數（v17 起）；
- 糖與蛋白收入；
- 費洛蒙路網；
- 工蟻路線記憶的分布；
- 合作捕獵的隊伍大小（受上下限約束）；
- 蟻群人口的成長或滅亡；
- 各季的存活分布。

以下**不是**湧現，而是直接抽籤或寫在規則中：

- 每日的任務比例（加權抽籤）；
- 產卵率（機率規則）；
- 死亡（風險率）。

### 4.3 適應（Adaptation）
工蟻的適應行為都是啟發式規則，沒有明確的最佳化：

- **任務選擇**：依自己的飢餓、同伴飢餓、幼蟲求食、年齡、傷勢、雨與溫度加權抽籤（§7.5）。
- **地點選擇**：依自己的記憶分數，以 0.77 的機率取最佳、否則取第二（§7.7）。
- **探索或回訪**：記得的地點都沒有收穫時去探索；只知道蛋白地點但自己糖需求高時，也可能去探索。
- **是否再出發**：糖依「自己嗉囊被同伴取走的比例」決定；蛋白依自己感知到的幼蟲需求；空手而回時以 0.5 的機率繼續。
- **是否招募**：只有裝載達到嗉囊的 0.5 才招募。

### 4.4 目標（Objectives）
- 沒有明確的適應度或效用函數。
- 地點評分（`score`）與再出發機率是經驗式的傾向，不是工蟻要最大化的目標。

### 4.5 學習（Learning）
- **路線記憶**（`engine/navigation.ts`）：
  - 只有實際走過的路段才會記住，並記錄取得方式（`walked`／`trail_followed`／`recruit_followed`／`explored`／`day14_history`）、首次與最近使用日；
  - 路段雙向可用，**沒有遺忘**，不記距離；
  - 規劃路線時，只在自己記得的路段中找邊數最少的路線（`knownRoute`，`engine/navigation.ts:64`）。
- **空地點記憶**：寄主已死的地點記為 `empty_sites`（`engine/navigation.ts:90`）。
- **地點記憶** `site_memory`：記錄最近一次的收穫量與造訪日。
- **指數平滑的印象**：
  - 卸貨回饋：前次權重 0.5、今日權重 0.5；
  - 自己的飽足：前次 0.3、今日 0.7；
  - 同伴飢餓與蛋白需求：保留 0.5。

### 4.6 預測（Prediction）
- 沒有明確的預測模型。
- **隱含的完美預知**：出發前，`fits()` 用世界的路段長度、目前的費洛蒙強度、固定的搜尋與最長處理時間，**精確計算**整趟是否能在時窗內完成（`engine/activity.ts:114-116`）。工蟻等於知道今天剩多少時間、整趟要多久。這是時間上的抽象；是否違反「無上帝視角」的精神，屬於 **Owner 待決問題**。

### 4.7 感知（Sensing）——局部規則與目前的偏離
**符合局部規則的部分**：

- 任務選擇與地點選擇只讀 `worker.local_sensory`、`site_memory`、`route_memory` 與當日天氣（`engine/workers.ts:26-60`；`engine/activity.ts:130-142`）。
- 工蟻只在親身抵達時才感知現場的食物、活昆蟲與寄主（`engine/activity.ts:191-222`）。
- 探索時只感知所在節點的出口（`unknownExits`，`engine/navigation.ts:86-88`）。
- 沿費洛蒙走時，只感知所在節點各出口的強度（`engine/trails.ts:40-61`）。
- 卸貨只交給當時在巢內的同伴（`engine/nutrition.ts:16`）。
- 招募只招募當時在巢內、沒在卸貨的同伴（`engine/activity.ts:386`）。

**目前程式中由全巢帳或全巢指標決定的地方**。CLAUDE.md §2.1 的字面只限制「工蟻」，以下多數影響的是蟻后、幼蟲或生理風險，而不是工蟻的決策；但依同一精神，每一項都列為「**Owner 待決問題（open question for the Owner）**」。未合併的 phase3 分支把前兩項列為 E8。

| # | 位置 | 讀取的全巢量 | 影響 |
|---|---|---|---|
| G1 | `engine/queen.ts:73-79` `oviposition` | `ratios.sFraction`／`pFraction`（全巢當日滿足率）、`stores.sugar`／`protein`、`sugar_gap_days`／`protein_gap_days`、`pop.brood.length`（全巢幼體數） | 蟻后能否產卵、產卵機率；**幼體數 × 0.011 是隱藏的人口上限**（§8 D7） |
| G2 | `engine/brood.ts:26-28` | `colony.stores.protein_gap_days` | 每隻幼蟲的飢餓死亡風險，與該幼蟲實際被餵多少無關 |
| G3 | `engine/brood.ts:24` | `min(ratios.pFraction, ratios.sFraction)`（全巢） | 所有幼蟲用同一個營養發育係數 |
| G4 | `engine/nutrition.ts:91` | 全巢 `pFraction` | 每隻幼蟲的求食訊號都由全巢蛋白滿足率更新，而不是由牠自己被餵到的量 |
| G5 | `engine/queen.ts:22` | `stores.sugar_gap_days`（全巢） | 每隻工蟻的飢餓死亡風險，與自己的嗉囊與餵食經歷無關 |
| G6 | `engine/queen.ts:47-51` | `stress_days`、`no_worker_days` | 蟻后死亡風險（「沒有工蟻」可以視為蟻后能感知的局部事實） |
| G7 | `engine/nutrition.ts:63-89` `consume` | 全巢帳分配 | 代謝是「巢內分配器」：先扣蟻后與幼蟲，剩餘的以隨機順序分給工蟻。**被扣除的糖用 `settleCrops` 依工蟻陣列順序從嗉囊扣，不一定是吃到的那隻**（`engine/nutrition.ts:37-44,73`）。這是質量一致性的抽象，不是個體間的交哺 |
| G8 | `engine/activity.ts:116` `fits` | 世界路段長度與時窗 | §4.6 的完美預知 |
| G9 | `engine/workers.ts:57` | `weather.daytime_air_temp_c`（合成日最高溫） | 這是環境量、可以合理感知；但它是全日單一值 |

另外，`source_knowledge` 與 `known_by` 是蟻群層級的簿記。v17 時間軸只寫入、不用於決策；但**舊模型**（開關關閉時）的 `collect`／`discover` 會讀 `presence`（`engine/foraging.ts:35,85-86`）。

### 4.8 互動（Interaction）
- **巢內接觸**：在巢內的工蟻以機率 0.58 碰到一隻隨機的巢內同伴，更新自己的同伴飢餓與蛋白需求印象（`engine/workers.ts:63-75`）。
- **育幼接觸**：育幼工蟻以機率 0.75 碰到一隻隨機幼蟲，取得該幼蟲的求食訊號（`engine/workers.ts:78-86`）。
- **交哺**：回巢者把糖放進自己的嗉囊，再分給最多 3 隻隨機的巢內同伴，每次最多 0.28 份、不超過對方剩餘的嗉囊空間；蛋白質則直接存入巢內（`engine/nutrition.ts:14-34`）。
- **間接互動（stigmergy）**：
  - 費洛蒙：成功回巢者沿路每段加 0.35，上限 3；
  - 每日保留 0.55；低於 0.08 就消失，且影響步行速度（`engine/activity.ts:63-64`）。
- **招募**：在巢內進行，只招募當時在巢、空閒的同伴，人數為 1 + ⌊U·min(人數, 3)⌋（`engine/activity.ts:384-399`）。
- **合作捕獵**：
  - 短距招募：同一地點正在搜尋的同伴加入；
  - 長距招募：發現者回巢沿路留跡、帶同伴回來；
  - 晚到者可以加入等待中的獵物；
  - 隊伍上限 10，獵物由隊伍均分搬回（`engine/activity.ts:261-354`）。
- **競爭**：
  - 透過共享的世界食源存量（先到先採）；
  - 背景蟻群以固定比例取走 F04 的蜜露；
  - 多蟻群依序處理，有順序偏差（#9，`docs/gm-rules.md` v17 段）。
- **共享資源池**：所有工蟻共用蟻群的糖／蛋白帳。這是平均場式的互動（§4.7 G7）。

### 4.9 隨機性（Stochasticity）
以下都由 §3.3 的具名串流決定：

- 天氣：雨日、距平、雨量；
- 生態：寄主死亡、半翅目增減、昆蟲死亡、出生、遷入、屍體大小；
- 任務抽籤與低溫門檻；
- 接觸對象；
- 地點選擇（0.77 取最佳）、探索方向、沿跡分支；
- 採集成功與載量；
- 捕獵的遭遇、大小、捕獲、逃脫；
- 招募人數與對象；
- 是否再出發；
- 分糖順序；
- 死亡與產卵；
- Day0 的寄主存在與工蟻年齡。

同一輸入＋同一參數＝同一輸出（`CLAUDE.md` §8）。不同種子之間的結果差異很大，所以評估一律報告 20 個種子的分布。

### 4.10 集體（Collectives）
- **蟻群**：擁有共同的食物帳、費洛蒙、食源簿記與人口。
- **捕獵隊伍**（`PreyHold`，`engine/activity.ts:53`）：在獵物結算前暫時存在的集體。
- **招募群**：一隻招募者與 1～3 隻跟隨者。
- 蟻群之間沒有其他集體結構（沒有多巢、超級群）。

### 4.11 觀察（Observation）
- **事件**：每一筆都在 `NATURAL_EVENT_TYPES` 中登錄（`engine/day.ts:48`）。主要包括：
  - 生態：`insect_natural_death`、`new_food_source`；
  - 行為：`route_step`、`worker_activity`（每段行動的開始、結束、地點、行動、結果）、`trophallaxis`、`local_recruitment`、`hunt_recruitment`；
  - 生命週期與死亡：`egg_laid`、`hatch`、`pupation`、`eclosion`、`worker_death`（附競合風險）、`queen_death`（附觸發條件與套用的風險）。
  - 大部分行為事件帶 `assumption: true`。
- **每日摘要 `ColonySummary`**：
  - 任務數、趟數、成功數、招募數、收入、需求／消耗／滿足率；
  - 發育係數、產卵機率、人口、存量、缺口日數；
  - `mass_ledger` 質量帳；
  - `activity`：每隻工蟻的外出、步行、搜尋、處理、卸貨分鐘數與停止原因（`engine/activity.ts:433-436`）。
- **正式世界**：`cli/lib/project-day.ts` 把當日所有事件寫進 `journal/v2-day-NNNN.md`。
- **Day0 評估**：`cli/reports/day0-evaluation.ts` 輸出到 `reports/day0-v19/`。

---

## 5. 初始化（Initialization）

### 5.1 正式世界：Day14 存檔（過渡性）
- **目前狀態**：正式世界停在 Day14／336 小時（`README.md`；`docs/status-audit-2026-11.md` §0）。
- **第一次推進時**：先執行一次性遷移 `engine/migration.ts`，從 `saves/main.json`、`saves/world-state.json` 建立 v2 引擎狀態：
  - 現存工蟻的成年日齡未知，一律假設 7 日；
  - 保留原有傷勢，並依紀錄分類；
  - 每隻工蟻的 `known_sources` 與 Day1～14 實際走過的路段證據，來自 `world.day15_migration.worker_route_evidence`（6 隻工蟻有紀錄，各附引用）；
  - 卵依產下日期換算 25°C 等效進度（上限 0.999）；L001／L002 假設完成幼蟲期 50%；
  - 存糧為糖 7.6、蛋白 2.3 份；
  - F07／F11 的屍體批次保留原始事件 ID，剩餘量為假設；
  - 昆蟲：F07 12 隻、F11 9 隻、邊界 40 隻；
  - F01 有 2 株寄主、4 群蚜蟲；
  - 隱藏蜜露點 F04／F05／F10 是否存在，依 `model.scenario_seed` = 15032026 雜湊抽樣。
  - 以上數值全部標為遊戲假設（`engine/migration.ts:14-73`；`docs/gm-rules.md` §4）。
- **誠實紀錄**：F04／F05 是在 v2 試跑失敗後才補做的花園盤點，已記錄在 `migration_log`（`engine/migration.ts:70`）。
- **Owner 的定位**：依 Owner 的說法（由委託方轉述），Day14 起點是**過渡性**的。核准切換後，將由新的、以科學方式初始化的**正式 Day0** 取代。
  - 目前 repo 文件仍寫「正式世界＝Day1～14 歷史及其延續」（`docs/product-vision.md` §4）；
  - `docs/day0-initialization.md` §10 的評估是「尚未準備好開始正式 Day0」，需要新的存檔空間、交易提交與日誌格式。

### 5.2 Day0 科學初始化（`engine/initialization.ts`；評估用）
- **只用於評估**：不寫入 `saves/`，也不讀 Day1～14 的任何蟻群紀錄（`migration_log.day14_history_used: false`，`engine/initialization.ts:132`）。

1. **輸入檢查**：
   - 情境檔的每個數值都必須是 `{value, assumption: true, basis ∈ 三類}`（`engine/initialization.ts:24-27`）；
   - `engine_supported !== true` 的情境拒絕執行（`FoundingNotSupported`，`:50`）；
   - 蟻后數 ≠ 1 也拒絕（`:99-100`）。
2. **氣候**：
   - 取自 `data/taichung-climatology-1991-2020.json` 的月平均；
   - 暖機起點的「前一日氣溫」取該日的氣候內插值（`:62`）；
   - 土壤濕度 0.3、遮蔭濕度 0.25、距平 0（`scenarios/day0/garden.json` `initial_climate`，皆為遊戲假設）。
3. **花園**（`scenarios/day0/garden.json`）：

   | 地點 | 內容 | 是否存在 |
   |---|---|---|
   | F01 | 蚜蟲，2 株、4 群 | 存在機率 1 |
   | F04 | 介殼蟲，2 株、3 群 | 機率 0.65 |
   | F05 | 蚜蟲，1 株、2 群 | 機率 0.8 |
   | F10 | 介殼蟲，1 株、1 群 | 機率 0.7 |
   | F08 | 花蜜：暖機開始時剩餘花期 12 日，初始存量 0 | — |
   | F07、F11 | 屍體地點，活昆蟲 12、9 隻；**初始屍體蛋白必須為 0**（`:75`） | — |
   | 邊界 | 活昆蟲 40 隻 | — |

   - 是否存在依 `hash32(seed|day0_garden_host|site)` 抽樣（`:67`）；
   - 蜜露上限一律用世界參數 `honeydew_max` = 5.2。
4. **生態暖機**：`warmup_days` = 30（遊戲假設）。
   - 花園單獨運行：天氣 → `growEcology` → `nextClimate`（`:82-94`）。
   - 每份新屍體都必須有死亡事件。
   - 同一種子的各創巢情境得到逐位元組相同的 Day0 花園。
   - **由程式推得的觀察**：F08 的剩餘花期 12 日 < 暖機 30 日，所以 Day0 時 F08 已經不再開花，只剩暖機中累積、沒被雨沖掉的存量。之後永遠不再開花（`engine/ecology.ts:79-86`；`docs/day0-initialization.md` §9 D4）。
5. **創巢群**（`founding-*.json`，`:97-130`）：

   | 情境 | 蟻后 | 工蟻（日齡） | 卵／幼蟲／蛹 | 工蟻嗉囊 | 蛋白存量 |
   |---|---|---|---|---|---|
   | A1 | 1 | 10（7～60 日均勻抽樣） | 0／0／0 | 0 | 0 |
   | A2 | 1 | 10（7～60） | 5／3／0（進度 0.5） | 0 | 0 |
   | A3 | 1 | 10（7～60） | 0／0／0 | 滿（每隻 0.8 份，全巢 8 份） | 0 |
   | A4 | 1 | 0 | 0／0／10（進度 0.5） | — | 0 |
   | A5 | 1 | 10（0 日，`callow`） | 0／0／0 | 0 | 0 |
   | B 獨立創巢 | 拒絕執行（缺：蟻后以自身儲備餵幼蟲、無工蟻時產卵等） | | | | |
   | C 多蟻后 | 拒絕執行（狀態只有一隻蟻后） | | | | |

   - 所有創巢數值都是遊戲假設；A4／A5 是依 R136（Chang 1985）設計的對照組。
   - 工蟻的起始狀態：沒有傷勢、在巢內、空的路線記憶（`origin: founded_day0`）、沒有已知食源；
   - 自身飽足＝自己實際帶的量；其他局部訊號用物種預設值；
   - 對所有地點的知識都是 `potential`；沒有費洛蒙；
   - 糖帳＝所有工蟻嗉囊糖的總和（`:126`）。
6. **季節與種子**：
   - 開始日（`scenarios/day0/seasons.json`）：春 2027-03-20、夏 2027-06-21、秋 2027-09-23、冬 2027-12-22；
   - 種子：20270001～20270020（`cli/reports/day0-evaluation.ts:19`）；
   - `cli/lib/day0.ts` 只負責讀檔，然後呼叫純函式 `initializeDay0`。

---

## 6. 輸入資料（Input data）
- **唯一的外部時間序列是「無」**：引擎**沒有讀取任何觀測的逐日或逐時天氣**。
- **每日天氣是合成的**：由 `data/taichung-climatology-1991-2020.json`（CWA 臺中地區 1991～2020 月平年值：月均溫、月均日最高／最低、相對濕度、月雨量）加上世界參數 `climate.annual_rain_days` = 113.7，以具名串流隨機合成（`engine/weather.ts:42-75`）。
  - 每筆天氣都標明 `kind: 'synthetic_climatology_game_assumption_not_real_weather'`；
  - 白天溫度代理標明 `daytime_proxy_basis: 'synthetic_daily_air_maximum_NOT_measured_ground_surface'`（`engine/weather.ts:69-71`）。
- **與歷史天氣的關係**：`docs/weather-data-policy.md` §6 規定 Day9 起長期模擬採歷史氣候合成；Day1～8 的觀測／預報只屬於舊敘事，不進入 v2 引擎。
- **測站平年值的定位**：是實測統計值，在模型中只當作先驗，並以 `assumption: true` 標註（`CLAUDE.md` §3）。
- **其他輸入**：世界參數檔與物種參數檔（§7）、Day0 情境檔（§5.2）、正式存檔（§5.1）。沒有其他外部驅動資料。

---

## 7. 子模型（Submodels）
- **欄位**：「分類」照抄參數檔的 `basis`；「機制」照抄 `mechanism_basis`，以及 `reference_for_mechanism_only` 或 `source`。
- **文獻代號換算**：參數檔中的文獻鍵換算成 `docs/references.md` 的 R 編號如下——
  - `Dussutour2009`＝R21／R96（另有 R152）；
  - `SaundFriedman2023`＝R102；
  - `Dejean2005`＝R132；
  - `Dejean2007`＝R98／R107。

### 7.0 參數檔標註一致性：疑點總表
| # | 參數 | 檔案寫的 | 疑點 |
|---|---|---|---|
| L1 | `brood_care.unattended_larva_max_days` = 4 | `basis: 一般生理學`，參考文獻為空 | 「4 日」這個具體數值不可能由一般生理學推得。描述寫「一般生理學 + 遊戲假設」；同類的卵、蛹上限 10 日都標遊戲假設；`docs/gm-rules.md` v2-review.5 段也稱之為「模擬上限而非本物種實測」。數值應屬遊戲假設，機制才是一般生理學 |
| L2 | `foraging_activity.foraging_cold_min_multiplier` = 0.12 | `mechanism_basis: 文獻支持`；`basis_note` 寫「見 reference_for_mechanism_only」 | 該欄位**不存在**。來源只寫在 `docs/gm-rules.md`（JCU、Harada 2021），沒有 R 編號 |
| L3 | `trophallaxis.crop_capacity`、`max_trophallaxis_contacts`、`transfer_max_portions`、`foraging_activity.daily_window_minutes`、`routes.route_edge_minutes`、`prey.*`、`predation.live_prey_encounter_probability`／`large_prey_min_team`／`live_prey_capture_probability`、`recruitment.trail_*` | 全部附上**同一組** `[Dussutour2009, SaundFriedman2023, Dejean2005, Dejean2007]`，並標 `mechanism_basis: 文獻支持` | 看起來是套用同一份樣板。例如 360 分鐘時窗、25 分鐘邊長、蛋白份數，與這四篇的關聯沒有逐項說明；而且引用鍵不是 R 編號 |
| L4 | `metabolism.q10` = 2、`metabolism.reference_c` = 25 | `一般生理學`，參考 `PMC11750369` | 這篇不在 `docs/references.md` 的 R 清單中（只出現在 `docs/gm-rules.md` v2-review.5 段） |
| L5 | `insects.insect_local_carrying_capacity`、`insect_background_immigration_probability`、`insect_local_daily_mortality_probability`；`day15_migration.insect_initial_*` | `mechanism_basis: 文獻支持`，參考 R95、R98 | R95 是 UF/IFAS 的物種介紹（食性），R98 是本種的捕食行為；兩者都不涉及昆蟲族群的容納量、遷入或死亡率 |
| L6 | `climate.annual_rain_days` = 113.7 | `文獻支持`，「CWA 1991-2020」 | 測站統計用「文獻支持」標示，可以接受（`CLAUDE.md` §3 要求標 `assumption: true` 並註明用途，檔案有做到）。但同一數值在狀態中另有一份 `rain_days_per_year`，引擎不讀（v19 E5） |
| L7 | `worker_lifespan.natural_daily_base_hazard`、`age_risk_from_days` | `遊戲假設`，機制參考 R94 | 標註本身一致，但**數值與所引的 R94 互相矛盾**：引擎的壽命約為 R94 的 2.3 倍（§8 D2） |
| L8 | `starvation.queen_zero_worker_hazard_after_days` = 14 | `遊戲假設`，`mechanism_basis` 文獻支持 R136 | 標註已在 v19 更正，現在一致。但 `reports/day0-final-report-2026-11.md` §3 仍寫「改為文獻支持（v18）」，該報告是以附加勘誤處理，正文未改 |
| L9 | 引擎沒有讀取的參數 | — | 有標註但引擎不讀：`nutrition.brood_protein_min_fraction`、`local_signals.nest_contact_route_learning_probability`（`docs/gm-rules.md` §3 的「接觸後可分享一條路線」**沒有實作**）、`recruitment.local_communication_retention_days`、世界的 `nest_microclimate.nest_buffer_fraction`、`plants.new_plant_event_probability`、`honeydew.honeydew_daily_replenish`、`model.population_safety_cap_for_trial`、`model.min_workers_alive_for_trial`。時間軸開啟時，`foraging_trips.*` 與 `predation.simultaneous_site_group_hunting` 也不再使用（`engine/params.ts:90-111,183-198`） |
| L10 | `docs/gm-rules.md` §5 末段 | 寫低溫係數「同時抑制出勤偏好、實際採集成功率、招募概率」 | 與程式不一致：程式只在任務抽籤後套用一次出勤門檻（`engine/workers.ts:57`）。`docs/gm-rules.md` 的 v2-review.5「二次審閱修正」段已更正，但 §5 原文未改 |

以下各節的參數，除非另外說明，皆為 `assumption: true`。

### 7.1 天氣（`engine/weather.ts`）
**雨日先驗**：
- 每月權重 w_m = (P_m / 月日數)^0.6；
- 用二分法求比例 s，使 Σ_m 月日數 × min(0.85, s·w_m) = 113.7（`:30-40`）；
- 每日先驗 p 由月中值線性內插（`:18-27`）。

**是否下雨**（Markov）：昨日雨 → pWet = p + 0.45(1−p)；否則 pWet = p(1−0.45)（`:47`）。

**氣溫**：
- 距平 a = 0.65·a_昨 + 1.8·N(0,1)；
- 日均 T = T̄ + a − 0.8(wet − p)；
- 日最高 = max(T, T̄max + a − 0.8(wet − p))，日最低同理（`:51-56`）。

**相對濕度**：RH = clamp(RH̄ + (雨日 +5／晴日 −2) + 0.45a, 0, 100)。

**雨量**：雨日時 rain ~ Gamma(形狀 1.6, 平均 = P_m / 日數 / p)（`:58-59`）。

**土壤與遮蔭濕度**：
- soil = clamp(0.93·soil + 0.045·rain − 0.025, 0, 1)；
- shade = clamp(0.96·shade + 0.025·rain − 0.013, 0, 1)（`:60-61`）。
- 由公式推得：日雨量小於約 0.56 mm 時土壤會變乾（v19 已記錄「連續小雨讓土壤變乾」）。

**巢溫**：T_nest = 0.6·T_nest,昨 + 0.4·T_air（日均）（`:66-67`）。

| 參數 | 值 | 分類 |
|---|---|---|
| `climate.annual_rain_days` | 113.7 | 文獻支持（CWA 1991～2020） |
| `wet_persistence` | 0.45 | 遊戲假設 |
| `temperature_ar` | 0.65 | 遊戲假設 |
| `temperature_daily_sigma_c` | 1.8 | 遊戲假設 |
| `rainfall_gamma_shape` | 1.6 | 遊戲假設 |
| `soil_persistence`／`soil_rain_gain_per_mm`／`soil_daily_loss` | 0.93／0.045／0.025 | 遊戲假設 |
| `soil_shade_persistence`／`soil_shade_rain_gain_per_mm`／`soil_shade_daily_loss` | 0.96／0.025／0.013 | 遊戲假設 |
| `wet_day_temperature_offset_c` | 0.8 | 遊戲假設 |
| `rh_wet_offset_percent`／`rh_dry_offset_percent`／`rh_anomaly_coefficient` | 5／−2／0.45 | 遊戲假設 |
| `rain_prior_month_weight_exponent`／`rain_probability_daily_cap` | 0.6／0.85 | 遊戲假設 |
| `nest_microclimate.nest_temp_memory` | 0.6 | 遊戲假設 |

### 7.2 寄主植物、半翅目與蜜露（`engine/ecology.ts:53-77`）
每個蜜露點每日依序：

1. **寄主死亡**：以 0.0007 的機率少一株。
2. **半翅目群數**：
   - 以 0.006 的機率崩潰一群；
   - 若群數 < 寄主數 × 4，以 0.012 的機率增加一群；
   - 寄主全死則群數歸 0。
3. **蜜露產量**：
   - 毛產量 = 群數 × 每群每日產量（蚜蟲 0.32、介殼蟲 0.4）× 1 × clamp(1 − 0.018·rain, 0.05, 1)；
   - 淨產量 = 毛產量 × (1 − 背景蟻群比例)，F04 的背景比例為 0.22。
4. **存量更新**：存量 = clamp(存量 × (1 − clamp(0.012·rain, 0, 0.9)) + 淨產量, 0, 上限)。

**沒有溫度或季節效應**（§8 D12）。

| 參數 | 值 | 分類 |
|---|---|---|
| `plants.host_plant_daily_death_probability` | 0.0007 | 遊戲假設 |
| `hemipterans.honeydew_per_colony_per_day.aphid`／`.scale` | 0.32／0.4 | 遊戲假設 |
| `honeydew_productivity_multiplier` | 1 | 遊戲假設 |
| `hemipteran_colony_daily_growth_probability`／`collapse_probability` | 0.012／0.006 | 遊戲假設 |
| `max_hemipteran_colonies_per_host` | 4 | 遊戲假設 |
| `rain_honeydew_secretion_suppression_per_mm`／`honeydew_rain_secretion_min_multiplier` | 0.018／0.05 | 遊戲假設 |
| `honeydew.honeydew_max` | 5.2 | 遊戲假設 |
| `honeydew_washoff_per_rain_mm`／`honeydew_washoff_max_fraction` | 0.012／0.9 | 遊戲假設 |
| `background_colonies.F04_rival.honeydew_harvest_fraction` | 0.22 | 遊戲假設 |

### 7.3 花蜜（`engine/ecology.ts:79-86`）
- 開花期間（`bloom_days_left` > 0），每日加 `production_per_day`。
  - Day0 世界：此值 = `nectar_daily_replenish` 0.35；
  - 正式遷移：同一參數。
- 雨水沖刷：比例 clamp(0.035·rain, 0, 0.9)。
- 存量上限 2.4。
- 花期每日減 1，**只有一次倒數**，不會重新開花。

| 參數 | 值 | 分類 |
|---|---|---|
| `nectar.nectar_max` | 2.4 | 遊戲假設 |
| `nectar_daily_replenish` | 0.35 | 遊戲假設 |
| `nectar_bloom_days_remaining` | 12 | 遊戲假設 |
| `nectar_washoff_per_rain_mm`／`nectar_washoff_max_fraction` | 0.035／0.9 | 遊戲假設 |

### 7.4 昆蟲族群與屍體（`engine/ecology.ts:24-51,89-117`）
**邊界族群**：
- 每隻每日以 0.02 的機率死亡（不產生可取得的屍體）；
- 出生：每隻以 clamp(0.055 × f(T) × (1 − N/80), 0, 1) 的機率生一隻；
- 溫度係數 f(T) = clamp(1 + 0.035(T_air − 25), 0.15, 1.25)。

**屍體地點**（F07、F11）：
- 自然死亡：每日最多一隻，機率 1 − (1 − 0.22)^(N/12)；
- 每隻死亡產生一批屍體，蛋白 U(1.45, 2.6) 份，事件 ID 為 `NAT-D…`；
- 出生：logistic，比率 0.065，K = 18；
- 遷入：若邊界族群 > 0 且 N < K，以 0.08 的機率從邊界遷入一隻（邊界同時減一）。

**屍體分解**：
- 每批每日的蛋白乘以 (1 − clamp(0.14 + 0.004·rain, 0, 0.95))；
- 存在超過 9 日的批次歸 0。

**捕食產生的屍體**：見 §7.9。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `insects.insect_local_carrying_capacity` | 18 | 遊戲假設（機制：文獻支持，R95、R98；⚠ L5） |
| `insect_background_immigration_probability` | 0.08 | 遊戲假設（同上，⚠ L5） |
| `insect_local_daily_mortality_probability` | 0.22 | 遊戲假設（同上，⚠ L5） |
| `insect_local_death_reference_population` | 12 | 遊戲假設 |
| `insect_site_logistic_daily_birth_rate`／`insect_boundary_logistic_daily_birth_rate` | 0.065／0.055 | 遊戲假設 |
| `insect_boundary_carrying_capacity`／`insect_boundary_per_capita_daily_death_probability` | 80／0.02 | 遊戲假設 |
| `insect_reproduction_reference_c`／`per_degree_c`／`min_multiplier`／`max_multiplier` | 25／0.035／0.15／1.25 | 遊戲假設 |
| `carcasses.carcass_daily_decay_fraction`／`carcass_rain_decay_bonus`／`carcass_decay_max_daily_fraction` | 0.14／0.004／0.95 | 遊戲假設 |
| `carcass_new_protein_min`／`max` | 1.45／2.6 | 遊戲假設 |
| `carcass_max_lifetime_days` | 9 | 遊戲假設 |

### 7.5 任務選擇與巢內接觸（`engine/workers.ts`）
**飢餓指標**：hunger = clamp(0.7(1 − 自身飽足) + 0.3·同伴飢餓, 0, 1)。

**各任務權重**：

| 任務 | 權重 |
|---|---|
| 覓食 | 0.36 × (1 + 0.9·hunger) × 傷勢倍率 1 × (日齡 < 4 時 0.08) × rainActivity |
| 育幼 | 0.25 × (1 + 0.65·幼蟲求食) × (日齡 < 4 時 3) |
| 休息 | 0.22 × 受傷倍率 1 |
| 修繕 | 0.12 × (1 + 0.8·soil) |
| 守衛 | 0.05 |

- **rainActivity** = clamp(1 − 0.035·rain, 0.35, 1)。
- **抽籤**：依權重抽出一個任務（`:42-56`）。
- **低溫出勤門檻**：若抽到覓食，再以溫度係數做一次 Bernoulli 判定，不通過就改為休息（`:57`）。溫度係數 = clamp(0.12 + 0.88·clamp((T_max − 10)/15, 0, 1), 0.12, 1)（`:19-22`）。
- **只抽一次**：任務每日抽一次，一整天固定（§8 D4）。
- **修繕與守衛**：只計數，沒有任何物理作用。
- **育幼**：觸發育幼接觸。

**巢內接觸**（`:63-75`）：
- 在巢的工蟻以 0.58 的機率碰到一隻隨機的巢內同伴；
- 自己的同伴飢餓印象 ← 0.5·舊值 + 0.5·(1 − 對方飽足)；
- 自己的蛋白需求印象 ← 0.5·舊值 + 0.5·對方的幼蟲求食印象。

**育幼接觸**（`:78-86`）：以 0.75 的機率碰到一隻隨機幼蟲，直接取得該幼蟲的求食訊號。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `task_allocation.forage_baseline_probability`／`nurse`／`rest`／`maintenance`／`defence` | 0.36／0.25／0.22／0.12／0.05 | 遊戲假設 |
| `newborn_nurse_days` | 4 | 遊戲假設 |
| `newborn_forage_multiplier`／`newborn_nurse_multiplier` | 0.08／3 | 遊戲假設 |
| `injured_task_forage_multiplier`／`injured_rest_multiplier` | 1／1 | 遊戲假設（機制：文獻支持 R121～R125，其他物種，取中性值） |
| `hunger_own_crop_weight`／`hunger_peer_weight`／`hunger_forage_boost` | 0.7／0.3／0.9 | 遊戲假設 |
| `brood_begging_nurse_boost` | 0.65 | 遊戲假設 |
| `soil_wetness_repair_boost` | 0.8 | 遊戲假設 |
| `foraging_activity.rain_suppression_fraction`／`min_rain_activity_multiplier` | 0.035／0.35 | 遊戲假設 |
| `foraging_cold_limit_c`／`foraging_full_activity_c` | 10／25 | 遊戲假設 |
| `foraging_cold_min_multiplier` | 0.12 | 遊戲假設（機制：文獻支持；⚠ L2） |
| `local_signals.local_peer_contact_probability`／`local_signal_smoothing` | 0.58／0.5 | 遊戲假設 |
| `nurse_larva_contact_probability` | 0.75 | 遊戲假設 |
| `default_own_crop_sugar_fill`／`default_peer_sugar_hunger`／`default_direct_brood_begging`／`default_peer_protein_request`／`default_larva_begging_contact_signal` | 0.55／0.4／0／0.25／0.2 | 遊戲假設 |

### 7.6 步行時間與路線記憶（`engine/activity.ts:60-66`；`engine/navigation.ts`）
**每段步行時間**：
- 有長度的路段：時間 = 長度(cm) × 10 × 彎曲度 ÷ 速度(mm/s) ÷ 60；
  - 若整段的費洛蒙 ≥ 0.08，速度 = 17 mm/s；
  - 否則 × 0.5，即 8.5 mm/s。
- 換算：N00–F01 為 0.47 分鐘（沿跡）或 0.94 分鐘（離跡）；N00–F08 為 0.81 或 1.63 分鐘。
- 長度未知的路段一律 25 分鐘。所以已知與未知路段之間相差約 25～50 倍。

**記憶的建立**：
- 學習：走過的路段都記住（`engine/navigation.ts:40-48`）；
- 每日開頭，沒有記憶的工蟻得到一份記憶：
  - Day14 舊工蟻：取自 `worker_route_evidence`，並附引用；
  - 模擬中羽化的工蟻：從空的開始（`engine/navigation.ts:98-110`）。

| 參數 | 值 | 分類 |
|---|---|---|
| `activity.trail_walking_speed_mm_s` | 17 | **文獻支持**（R133 Vázquez et al. 2020，本種，實驗室人工路徑；外推限制：野外地面與溫度不同） |
| `off_trail_speed_factor` | 0.5 | 遊戲假設 |
| `routes.edge_length_cm`（4 條） | 48／31／83／35 | 遊戲假設（來源：世界設定的「約距離」，直線，作為下限） |
| `routes.path_tortuosity` | 1 | 遊戲假設 |
| `routes.route_edge_minutes` | 25 | 遊戲假設（機制：文獻支持，四篇樣板；⚠ L3） |
| `navigation.individual_route_memory` | true | 模型開關 |

### 7.7 日內覓食循環（`engine/activity.ts`）
**決定**（`decide`，`:161-188`）：

1. 從自己記得的地點中找可用的：有記得的路線，且沒被記為空地點。
2. 判斷是否改去搜尋：
   - 沒有可用地點；或
   - 記得的地點收穫都低於 0.1 份，且（剛空手而回，或以 0.18 的機率）；或
   - 只知道蛋白地點，且以「自己糖需求 × 0.18」的機率。
3. 要搜尋時：
   - 若沒有可用地點，先嘗試在巢口沿可感知的費洛蒙逐段走（最多 6 段；遇到中間食源時以 0.55 的機率繼續往前，`engine/trails.ts:40-61`）；
   - 否則以 0.25 的機率探索：沿已知路線走到一個已知節點，走一條沒走過的出口，到了才知道那裡有什麼（`:144-160`）；
   - 沒有任何可用地點也沒有探索，就停止（`no_known_route_and_no_exploration`）。

**選擇地點**（`chooseSite`，`:131-142`）：
- 分數 = (0.15 + 上次收穫或預設 0.15) × 近期失敗懲罰 × 偏好 × (0.65 + 1.4·卸貨回饋)。
  - 近期失敗懲罰：上次收穫為 0，且距今 < 4 日時為 0.35，否則為 1。
  - 偏好：糖地點 = 1 + 4.5·need，其中 need = clamp(0.6(1 − 飽足) + 0.4·同伴飢餓, 0, 1)；蛋白地點 = 1 + 1.8·clamp(0.75·幼蟲求食 + 0.25·同伴蛋白需求, 0, 1)。
- 以 0.77 的機率選分數最高的，否則選第二高的。

**採集**（`:224-239`）：
- 成功機率 = rainActivity × (屍體 0.7／液體 0.85)；
- 載量 = min(存量, U(下限, 上限), 嗉囊剩餘空間)：糖 U(0.28, 0.62)，蛋白 U(0.3, 0.64)；
- 處理時間：糖為 3 分鐘 × 載量 / 0.8；蛋白為 3 分鐘；
- 失敗時，該地點的收穫記憶記為 0。

**回巢與卸貨**（`home`，`:357-409`）：
1. 外出耗糖 = 外出分鐘 × 0.00024，計入當日額外需求；
2. 交哺（§7.10）；
3. 卸貨回饋：ease = clamp(0.15 + 0.8·接觸數 / 3, 0, 1)；回饋 = 0.5·舊值 + 0.5·ease；
4. 留下費洛蒙；
5. **招募**：條件是糖載量 / 0.8 ≥ 0.5（蛋白不受此限）、以 0.55 的機率、整條路線的費洛蒙都可感知、而且不是獵物；
6. **是否再出發**：機率 p = clamp(0.3 + 驅力, 0, 1)。
   - 糖：驅力 = 0.6 × (1 − 自己嗉囊剩餘 / 0.8)；
   - 蛋白：驅力 = 0.4 × clamp(0.75·幼蟲求食 + 0.25·同伴蛋白需求, 0, 1)；
   - 再出發的話，先休息 5 分鐘。
7. **空手而回**：休息後以 0.5 的機率繼續（`:421-422`）。

**時間安全限制**：每隻工蟻每日最多 5000 個行動，超過就拋錯；這是計算限制，**不是生物學規則**。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `activity.search_minutes`／`liquid_fill_minutes_full_crop`／`protein_handling_minutes`／`unload_minutes`／`rest_between_trips_minutes` | 2／3／3／2／5 | 遊戲假設（本種與 Pheidole 都查無資料） |
| `continue_base` | 0.3 | 遊戲假設 |
| `continue_crop_emptied_weight` | 0.6 | 遊戲假設（機制：跨物種文獻 R147／R148 *Camponotus*） |
| `continue_brood_need_weight` | 0.4 | 遊戲假設 |
| `continue_after_failure_probability` | 0.5 | 遊戲假設（phase2 敏感度：主導結果） |
| `recruit_min_crop_fill_fraction` | 0.5 | 遊戲假設（機制：R149 *Lasius*；本種 Dejean 2005 R132） |
| `active_minute_sugar_cost` | 0.00024 | 遊戲假設（由舊每趟 0.012 ÷ 50 分鐘換算） |
| `safety_max_actions_per_worker_day` | 5000 | 遊戲假設（計算限制） |
| `foraging_activity.daily_window_minutes` | 360 | 遊戲假設（機制：文獻支持，樣板四篇；⚠ L3） |
| `scouting.scout_discovery_probability`／`scout_search_when_route_unproductive_probability`／`unproductive_route_threshold_portions` | 0.25／0.18／0.1 | 遊戲假設 |
| `site_choice.sugar_hunger_priority_weight`／`protein_begging_priority_weight`／`unloading_success_memory_weight` | 4.5／1.8／1.4 | 遊戲假設 |
| `site_choice.need_own_crop_weight`／`need_peer_weight`／`default_prior_success_portions`／`default_last_visit_days_ago`／`recent_failure_penalty`／`recent_failure_window_days`／`brood_begging_protein_weight`／`peer_protein_feedback_weight`／`score_base_offset`／`unloading_memory_base`／`best_site_choice_probability` | 0.6／0.4／0.15／2／0.35／4／0.75／0.25／0.15／0.65／0.77 | 遊戲假設 |
| `food_handling.carcass_access_probability`／`liquid_collection_probability` | 0.7／0.85 | 遊戲假設 |
| `crop_load_sugar_min`／`max`、`crop_load_protein_min`／`max` | 0.28／0.62、0.3／0.64 | 遊戲假設 |
| `local_signals.unload_feedback_default`／`unload_ease_base`／`unload_ease_contact_weight`／`unload_feedback_previous_weight`／`unload_feedback_today_weight` | 0.5／0.15／0.8／0.5／0.5 | 遊戲假設 |
| `recruitment.recruitment_probability`／`recruitment_max_followers` | 0.55／3 | 遊戲假設 |
| `recruitment.follow_intermediate_source_probability` | 0.55 | 遊戲假設（機制：R102） |
| `trail_follow_max_hops` | 6 | 遊戲假設 |

### 7.8 費洛蒙（`engine/trails.ts`）
- **每日衰減**：每日開頭，強度 × 0.55；低於 0.08 就刪除（`:12-19`）。
- **留跡**：成功回巢時，沿路每段 +0.35，上限 3（`:22-28`）。
- **影響**：費洛蒙強度決定招募是否可行（整條路線都要可感知）、沿跡選路（依強度加權），以及步行速度。
- **時間尺度**：沒有分鐘尺度的衰減（§1.2 P6）。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `recruitment.trail_daily_retention`／`trail_deposit_per_success`／`trail_min_detectable`／`trail_max_strength` | 0.55／0.35／0.08／3 | 遊戲假設（機制：文獻支持，四篇樣板；⚠ L3） |

### 7.9 捕食與合作搬運（`engine/activity.ts:241-354`）
**觸發條件**：屍體地點的蛋白已空，而且還有未被保留的活昆蟲。此時正在搜尋的工蟻以 0.06 的機率遭遇活獵物。

**獵物大小**：大型的機率為 0.25。
- 小型獵物：單獨捕捉，成功率 0.48；
- 大型獵物：先由同地點正在搜尋的同伴組隊（短距招募，最多 10 隻）：
  - 達到 2 隻就直接捕捉；
  - 不足 2 隻時，若時間足夠（t + 3·單程 + 3 分鐘 ≤ 360），發現者回巢沿路留跡，帶巢內空閒的同伴回來（長距招募）。
  - 獵物原地等待，晚到者可以加入。
  - 結算時先以 0.5 的機率判定獵物逃脫，再檢查隊伍是否 ≥ 2，最後以 0.48 判定捕捉成功。

**捕獲的結果**：
- 該地點活昆蟲 −1；
- 產生一批屍體，事件 ID 為 `HUNT-D…`；蛋白：小型 0.55 份、大型 1.5 份；
- 由隊伍均分搬回。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `predation.live_prey_encounter_probability` | 0.06 | 遊戲假設（機制：文獻支持，四篇樣板） |
| `large_prey_min_team`／`large_prey_max_team` | 2／10 | 遊戲假設（機制：R98／R107、R127） |
| `live_prey_capture_probability` | 0.48 | 遊戲假設（機制：樣板） |
| `large_prey_escape_while_recruiting_probability` | 0.5 | 遊戲假設（機制：R98／R107，取最大不確定值） |
| `prey.large_prey_fraction`／`small_prey_protein`／`large_prey_protein` | 0.25／0.55／1.5 | 遊戲假設（機制：樣板；⚠ L3） |
| `predation.late_arrivals_join_waiting_prey`、`simultaneous_site_group_hunting` | true／true | 模型開關 |

### 7.10 交哺與巢內食物帳（`engine/nutrition.ts`）
**卸貨**（`handoff`，`:14-34`）：
- 糖：先放進自己的嗉囊；再依序給最多 3 隻隨機的巢內同伴，每次的量 = min(自己的嗉囊糖, 對方剩餘空間, 0.28)；全部載量加入糖帳。
- 蛋白：直接加入蛋白帳。

**儲存溢出**（`:47-56`）：
- 上限：糖 24 + 0.4 × max(0, 工蟻數 − 14)；蛋白 12 + 0.3 × max(0, 工蟻數 − 14)；
- 超過的部分丟失，糖同時從嗉囊扣除。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `trophallaxis.crop_capacity`／`max_trophallaxis_contacts`／`transfer_max_portions` | 0.8／3／0.28 | 遊戲假設（機制：文獻支持，四篇樣板；⚠ L3） |
| `nutrition.max_sugar_store`／`max_protein_store` | 24／12 | 遊戲假設 |
| `store_capacity_baseline_workers`／`sugar_store_per_extra_worker`／`protein_store_per_extra_worker` | 14／0.4／0.3 | 遊戲假設 |

### 7.11 代謝與分配（`engine/nutrition.ts:63-93`）
**代謝係數**：mf = 2^((T_nest − 25)/10)。

**需求**：
- 糖需求 = (工蟻 × 0.1 + 受照顧的蟻后 × 0.22 + 受照顧的幼蟲 × 0.025) × mf + 當日外出耗糖；
- 蛋白需求 = (工蟻 × 0.008 + 蟻后 × 0.045 + 幼蟲 × 0.08) × mf。
- 「受照顧」的意思是：沒有工蟻時，蟻后與幼蟲都不進食。卵與蛹不進食。

**消耗與缺口**：
- 實際消耗 = min(存量, 需求)；
- 滿足率 < 0.995 時，缺口日數 +1，否則歸 0；
- 沒有工蟻但蟻后還活著時，滿足率記為 0。

**分配**：扣掉蟻后、幼蟲與外出耗糖後的剩餘糖，依隨機順序分給工蟻，更新各自的飽足印象（前次 0.3、今日 0.7）。

**幼蟲求食訊號**：0.3·舊值 + 0.7(1 − 全巢蛋白滿足率)（§4.7 G4）。

| 參數 | 值 | 分類 |
|---|---|---|
| `metabolism.q10`／`reference_c` | 2／25 | **一般生理學**（PMC11750369；⚠ L4） |
| `nutrition.worker_sugar_daily`／`worker_protein_daily` | 0.1／0.008 | 遊戲假設 |
| `queen_sugar_daily`／`queen_protein_daily` | 0.22／0.045 | 遊戲假設 |
| `larva_sugar_daily`／`larva_protein_daily` | 0.025／0.08 | 遊戲假設 |
| `ration_gap_threshold` | 0.995 | 遊戲假設 |
| `local_signals.crop_fill_previous_weight`／`crop_fill_today_weight`／`default_crop_fill_before_feeding` | 0.3／0.7／0.6 | 遊戲假設 |
| `larva_begging_previous_weight`／`larva_begging_shortfall_weight`／`default_larva_begging_prior` | 0.3／0.7／0.3 | 遊戲假設 |

### 7.12 幼體發育（`engine/brood.ts`）
**溫度係數**：F = clamp(1.55^((T_nest − 25)/10), 0.48, 1.9)。
- 下限要到 8.3°C 以下才生效；上限要到 39.6°C 以上。

**進度**：每日 progress += F / 階段日數（卵 10、幼蟲 12、蛹 10 日）。
- 幼蟲再乘以 max(0.1, min(全巢 pF, 全巢 sF))（`:24`）。

**換算的總發育時間**：25°C 32 日；28°C 28.1 日；21°C 38.1 日；18°C 43.5 日。

**每日最多前進一個階段**：超過 1 的部分保留到下一階段。

**無照護**：
- 沒有工蟻的日數達到上限就死亡：幼蟲 4 日，卵與蛹 10 日；
- 沒有工蟻時，幼蟲不發育（`:20-23`）。

**幼蟲飢餓死亡**（`:26-28`）：全巢蛋白缺口 ≥ 5 日時，每日風險 = clamp(0.05 + 0.055(缺口 − 5), 0, 0.75)。

**羽化**：蛹完成後成為新工蟻（日齡 0，任務先設為育幼）。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `development.reference_c`／`egg_days`／`larva_days`／`pupa_days` | 25／10／12／10 | 遊戲假設（機制：文獻支持 R94） |
| `development.q10`／`min_temp_factor`／`max_temp_factor` | 1.55／0.48／1.9 | 遊戲假設 |
| `larva_min_nutrition_growth_factor` | 0.1 | 遊戲假設 |
| `brood_care.unattended_larva_max_days` | 4 | **一般生理學**（⚠ L1：數值看起來是遊戲假設） |
| `unattended_egg_max_days`／`unattended_pupa_max_days` | 10／10 | 遊戲假設 |
| `starvation.larva_mortality_starts_days`／`larva_daily_hazard_base`／`larva_daily_hazard_slope`／`larva_daily_hazard_cap` | 5／0.05／0.055／0.75 | 遊戲假設 |

### 7.13 工蟻存活與傷勢（`engine/queen.ts:13-42`）
**自然風險**：0.003 + 0.00075 × max(0, 日齡 − 28)；受傷時 × 1.4。

**飢餓風險**：全巢糖缺口 ≥ 4 日時 = clamp(0.015 + 0.012(缺口 − 4), 0, 0.95)。

**總風險**：clamp(1 − (1 − 自然)(1 − 飢餓), 0, 0.98)，只抽一次。兩種風險是競合的，事件中兩項都記錄。

**由公式推得**：無飢餓時，從日齡 0 起算的中位壽命 64 日、平均約 65 日；第 28 日的存活率 0.92。**與溫度無關**。

**傷勢復原**：受傷、當日休息、而且全巢沒有缺口時，以 0.05 × 類型倍率的機率復原。倍率：擦傷 1、肢體缺損 0、未知 1。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `worker_lifespan.natural_daily_base_hazard`／`age_risk_from_days` | 0.003／28 | 遊戲假設（機制：R94；⚠ L7 數值與 R94 矛盾） |
| `age_hazard_slope`／`injury_mortality_multiplier` | 0.00075／1.4 | 遊戲假設 |
| `newborn_initial_age_days` | 0 | 遊戲假設 |
| `adult_total_daily_hazard_cap` | 0.98 | 遊戲假設 |
| `injury_repair_probability` | 0.05 | 遊戲假設 |
| `injury_repair_multiplier_abrasion` | 1 | 遊戲假設（機制：R129／R130，其他物種） |
| `injury_repair_multiplier_appendage_damage` | 0 | **一般生理學**（R128；R123、R125） |
| `injury_repair_multiplier_unknown` | 1 | 遊戲假設 |
| `starvation.worker_mortality_starts_days`／`worker_daily_hazard_base`／`worker_daily_hazard_slope`／`worker_starvation_hazard_cap` | 4／0.015／0.012／0.95 | 遊戲假設 |

### 7.14 蟻后存活（`engine/queen.ts:45-67`）
- **觸發條件**：
  - 連續無工蟻日數 ≥ 14 → 風險 max(0.008, 0.24) = 0.24；
  - 或 `stress_days` ≥ 12 → 風險 0.008。
- **抽樣**：取觸發條件中風險最大的一項，抽一次。
- **沒有自然或年齡死亡**：事件中記為 `natural_age: 'not_modelled'`（`:62`）。
- **由公式推得**：工蟻全滅後，蟻后的中位死亡日約為無工蟻第 16 日。

| 參數 | 值 | 分類（機制） |
|---|---|---|
| `starvation.queen_hazard_after_days`／`queen_daily_hazard` | 12／0.008 | 遊戲假設 |
| `queen_zero_worker_hazard_after_days` | 14 | 遊戲假設（機制：文獻支持 R136，「2～3 週」） |
| `queen_zero_worker_starved_daily_hazard` | 0.24 | 遊戲假設（沒有任何文獻；只是與 R136 的範圍相容） |

### 7.15 產卵（`engine/queen.ts:70-93`）
**產卵條件**：
- 蟻后活著，且有工蟻；
- 全巢當日 sF、pF 都 ≥ 0.84；
- 存量 ≥ 一粒卵的成本（糖 0.08、蛋白 0.14）；
- 糖缺口與蛋白缺口都 < 2 日。

**溫度係數**：clamp(2.5^((T_nest − 25)/10), 0, 1)。上限 1，所以高於 25°C 不會提高產卵；18°C 時為 0.53。

**機率**：p = clamp(0.38 × 溫度係數 × (昨日有產卵時 0.6) × (1 − 0.011 × 全巢幼體數), 0, 0.9)。
- 幼體達到 91 個時 p = 0（§8 D7）。

**第二粒**：以 0.2 的機率再產一粒，每日最多 2 粒。

**成本**：從存量扣除；糖同時從嗉囊扣除（v2-review.13）。

| 參數 | 值 | 分類 |
|---|---|---|
| `queen_laying.base_laying_probability` | 0.38 | 遊戲假設 |
| `max_eggs_per_day`／`second_egg_given_laying_probability` | 2／0.2 | 遊戲假設 |
| `existing_brood_pressure` | 0.011 | 遊戲假設 |
| `previous_laying_penalty` | 0.6 | 遊戲假設 |
| `adequate_nutrition_threshold` | 0.84 | 遊戲假設 |
| `laying_reference_c`／`laying_temperature_q10` | 25／2.5 | 遊戲假設 |
| `laying_probability_cap` | 0.9 | 遊戲假設 |
| `starvation.queen_egg_pause_days` | 2 | 遊戲假設 |
| `nutrition.egg_laying_sugar_cost`／`egg_laying_protein_cost` | 0.08／0.14 | 遊戲假設 |

---

### 7.16 設計中、尚未實作的子模型（Owner 決策 D4-A、D7-A，2026-11-03）
> 以下兩個子模型**已設計、未實作**，不是引擎現況。依 Grimm et al. 2020（R330）的建議，各自寫成巢狀 ODD，並在耦合處（hooks）說明交換的變數與同步方式。
- **開放式自然生態（D7-A）**：`docs/spec-open-ecology.md`。三層模型：
  - 花園內逐隻個體；
  - 周圍棲地斑塊（族群數量、齡期分布、資源存量與流量）；
  - 邊界事件（來源、去向、時間；個體升級與降級時保持 ID 與帳）。

  各區域的出生、死亡、移入、移出分開記帳；全部共用同一條世界事件時間軸。現況：main 只有單向流入花園的外部昆蟲池（K＝80，遊戲假設），外部死亡不留屍體，蟻群人口守恆式不允許螞蟻進出。
- **完整繁殖系統（D4-A）**：PR #53、#55（未合併）與 `docs/research-design-reproduction-d4a.md`。涵蓋：
  - 受精與性別決定（單雙倍體）；
  - 雄蟻與 gyne 的生命週期；
  - 多后的個別狀態；
  - 交配與接納（含殖群辨識候選模型）；
  - 婚飛、分巢、獨立創巢、巢間交換。

  所有個體以同一本帳與開放生態交換。正式 Day0 前要通過 Day0 完整性閘門（10 項全部啟用）。現況：一隻蟻后、所有卵視為工蟻卵，沒有雄蟻、gyne、婚飛或分巢。
- **耦合（hooks）**：
  - 食物以 `food_transfer` 跨越區室與邊界（工作包 C2 計畫由引擎記錄；C2 的 PR 待審，main 尚未包含）；
  - 個體以邊界事件跨越區域；
  - 時間以同一事件佇列同步；
  - 同時發生的爭用以標準鍵決定順序，不以陣列位置（Issue #56、A09）。

## 8. 已知結構缺陷與驗證狀態

### 8.1 已知結構缺陷（都沒有修正；修正一律是規則更新，需要另開 PR）
| # | 缺陷 | 程式證據 | 分析文件 |
|---|---|---|---|
| D1 | **低溫時發育太快**：單一 Q10 1.55，下限 0.48 要到 8.3°C 以下才生效。21°C 給 38.1 日，觀察值為 66～78 日（R166、R167） | `engine/brood.ts:15,24` | `docs/research-design-2026-11.md` §3（建議線性度日 T0 ≈ 16.4°C、K ≈ 335）；`docs/status-audit-2026-11.md` #2；未合併分支 phase3 `docs/research-design-phase3-lifecycle.md` E1 |
| D2 | **工蟻壽命約為 Yuan 的 2 倍，且與溫度無關**：引擎中位 64 日，R94 28°C 中位 28 日；沒有兵蟻的較長壽命 | `engine/queen.ts:18-20` | `docs/research-design-2026-11.md` §4；`docs/status-audit-2026-11.md` #4；phase3 E2 |
| D3 | **固定 360 分鐘時窗**：不對應一天中的時刻，沒有逐時溫度、日夜、夜間活動；所有覓食者都在第 0 分鐘開始；天氣在時窗內不變 | `engine/activity.ts:69,412`；`engine/weather.ts`（只有日尺度） | `docs/status-audit-2026-11.md` #5；未合併分支 phase2（PR #34）`reports/phase2-behaviour-review.md` §7「設計 A」 |
| D4 | **每日一次的任務抽籤**：任務一天固定；巢內工作沒有時間成本；修繕與守衛沒有物理作用；只有被招募時才會改成覓食 | `engine/workers.ts:42-60`；`engine/foraging.ts:424-429`；`engine/activity.ts:333,394` | phase2 `reports/phase2-behaviour-review.md` §7「設計 B」（局部門檻函數、每 30～60 分鐘重新評估）；`docs/worker-activity-memory-traffic.md` |
| D5 | **沒有 major（兵蟻）**：開關鎖死，設為 true 就拋錯 | `engine/params.ts:116-118` | `docs/research-design-2026-11.md` §5（#25）；`docs/day0-initialization.md` §9 D6 |
| D6 | **沒有巢的空間**：巢只是一個節點；沒有巢室容量、挖掘、排水、遷巢；修繕只是計數 | `engine/types.ts:140`（`nest_node: string`） | `docs/day0-initialization.md` §9 D8；`docs/nest-construction.md`（規格）；`docs/status-audit-2026-11.md` #10 |
| D7 | **隱藏的幼體壓力上限**：產卵機率 × (1 − 0.011 × 全巢幼體數)，在 91 個幼體時歸零。這是全巢人口控制，參數說明寫「本階段獨立情境人口控制」，沒有文獻 | `engine/queen.ts:77` | phase3 `docs/research-design-phase3-lifecycle.md` E5（建議以批次產卵狀態機取代） |
| D8 | **蟻后沒有自然死亡** | `engine/queen.ts:62`（`'not_modelled'`） | `docs/gm-rules.md` v2-review.16 段；phase3 E6 |
| D9 | **雨只影響活動**：雨只降低出勤權重與採集成功、提高修繕權重，並影響食源（沖刷、分泌、屍體分解）；沒有淹巢、雨中死亡或搬巢。連續小雨反而讓土壤變乾 | `engine/workers.ts:37-39,50`；`engine/weather.ts:60` | `docs/gm-rules.md` v2-review.19 段；`reports/rules-update-v19-review.md` §2；`docs/status-audit-2026-11.md` #11 |
| D10 | **長度未知的路段一律 25 分鐘**：6/10 條邊（U00、U01、F01–F04、F04–F05、F08–F05、U01–F10）。已知路段不到 2 分鐘，差 25～50 倍；基準情境每趟平均步行時間主要來自 U00／U01 的探索 | `engine/activity.ts:60-62` | `docs/gm-rules.md` v2-review.17 段；`reports/rules-update-v19-review.md` §1「限制」；`reports/rules-update-v17-review.md`（彎曲度比較） |
| D11 | 蟻后每日最多 2 粒，以機率逐日產；沒有批次、暫停或食卵（R136 為 97～292 粒／31 日） | `engine/queen.ts:77-81` | `docs/research-design-2026-11.md` §2；phase3 E4、E7 |
| D12 | 半翅目沒有溫度與季節效應；花蜜只開一次（Day0 世界在暖機期間就開完了） | `engine/ecology.ts:53-86` | `docs/day0-initialization.md` §9 D4、D5；`docs/research-design-2026-11.md` §6.2–6.3 |
| D13 | 分巢群與母巢沒有連結；蟻后沒有自身儲備；不支援獨立創巢與多蟻后 | `engine/initialization.ts:50,99-100` | `docs/day0-initialization.md` §3、§9 D1、D3；`docs/research-design-2026-11.md` §1 |
| D14 | 以全巢指標決定蟻后產卵、幼蟲死亡、幼蟲求食與工蟻飢餓（§4.7 G1～G7）——**Owner 待決** | 見 §4.7 | phase3 E8 |
| D15 | 路線記憶不會遺忘；接觸分享路線未實作（參數存在但沒有被讀取） | `engine/navigation.ts:1-15` 註解；⚠ L9 | `docs/status-audit-2026-11.md` #6 |
| D16 | 多蟻群依陣列順序處理，有順序偏差 | `engine/day.ts:99,106` | `docs/gm-rules.md` v17 段（#9）；`prototypes/multi-colony-timeline/` |
| D17 | 小群的命運主要由兩個沒有本種資料的參數決定：`continue_after_failure_probability`、`recruit_min_crop_fill_fraction` | — | phase2 `reports/phase2-behaviour-review.md` §6 |

### 8.2 驗證與檢查狀態
**執行期檢查**（每日都做，失敗就不產出結果；`engine/day.ts`）：
- 世界結構驗證；
- 食物因果：每份屍體都有死亡事件；
- 事件型別登錄；
- 糖與蛋白的質量帳（容許 2e-5）；
- 工蟻與幼體人數守恆；
- 日終所有工蟻都在巢（`engine/activity.ts:429-431`）；
- 時間軸事件不得排在過去的時刻（`:75`）。

**測試**（`docs/engine-architecture.md` §5）：

| 測試 | 內容 |
|---|---|
| `tests/golden.test.ts` | 逐位元組黃金測試 |
| `tests/rules-isolation.test.ts` | 每版規則撤回後，與前一版逐位元組相同（到 v19） |
| `tests/differential.test.ts` | 與舊 v6 引擎的差分 |
| `tests/activity.test.ts` | 個體時間稽核：數千個蟻群日 |
| `tests/navigation.test.ts` | 路線記憶只因親自走過而增加 |
| `tests/day0.test.ts` | Day0 初始化 |
| `tests/hunting.test.ts`、`tests/injury.test.ts`、`tests/crop-ledger.test.ts`、`tests/death-diagnostics.test.ts` | 各子模型規則 |
| `tests/local-ecology.test.ts` | 靜態檢查生態與工蟻模組不讀巢內帳 |
| `tests/platform-purity.test.ts` | 引擎不用 Node／DOM API，不寫死物種名稱 |
| `tests/multi-colony.test.ts` | 多蟻群路徑與單蟻群路徑一致 |

這些測試驗證的是**規則有被正確實作**（verification），**不是**模型與真實螞蟻相符（validation）。

**對外部模式的驗證**：見 §1.2。
- 只有 P1 的 28°C 點、P3（依建構）、P4（方向）與 P7（定性）有比較；
- P1 的低溫段與 P2 已確定不符；
- P5、P6、P8～P13 尚未檢核或無法檢核。

**敏感度**：
- phase2（未合併 PR #34）：兩個個體決策參數的 44 組 × 80 次敏感度分析；
- v17 審查有彎曲度與路段時間的比較；
- 其餘參數沒有系統性的敏感度分析。

**評估結果**：Day0 A1～A5 × 四季 × 20 種子 × 365 日（v18；v19 輸出逐位元組相同）。
- 蟻后存活到 Day365：A1 40/80、A2 52/80、A3 41/80、A4 24/80、A5 61/80（`reports/day0-final-report-2026-11.md` §5）。
- 依規則，這些只是診斷，不是目標；沒有為結果調整參數。

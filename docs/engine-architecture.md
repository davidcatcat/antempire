# TypeScript 引擎架構（engine-ts.1）

> 本文件說明 2026-11 的程式改寫。**行為完全不變**：引擎行為版本仍是 `antempire.v2-review.6-physical-foraging-pheromone-trophallaxis`，所有輸出與 `sim/day_engine.cjs` 逐位元組相同（見「驗證」）。沒有修改任何參數數值或生態規則，沒有推進遊戲日。

## 1. 目錄

| 位置 | 內容 |
|---|---|
| `engine/` | 純模擬核心（TypeScript）。不使用 DOM、Node API、檔案、時鐘或網路；可直接在瀏覽器載入。`engine/tsconfig.json` 不含 DOM 與 Node 型別，用到平台 API 就無法通過型別檢查。 |
| `species/<id>.json` | **物種參數**（目前只有 `pheidole-megacephala.json`）。 |
| `world/<id>.json` | **世界參數**（目前只有 `xitun-garden.json`），與物種無關。 |
| `cli/` | Node 專用工具：讀檔、規則指紋、存檔映射（`cli/lib/project-day.ts`）、報告產生器（`cli/reports/`）。 |
| `tests/` | 移植後的測試、黃金測試、與舊引擎的差分測試。 |
| `web/` | 預留給未來網頁版（只讀）。 |
| `sim/` | 舊 v6 JavaScript 引擎，**暫時保留**作為差分測試的對照；封存計畫見 §6。 |

## 2. 引擎模組（依職責拆分）

| 模組 | 職責 | 對應 v6 |
|---|---|---|
| `math.ts` | `round`（6 位小數）、`clamp`、日期 | `round`/`clamp`/`monthDays` |
| `sha256.ts` | 純 TS SHA-256（取代 `node:crypto`） | `crypto.createHash` |
| `rng.ts` | 具名隨機串流 `dice(seed|day|tag)`、常態與 Gamma 抽樣 | `hash32`/`rng`/`dice`/`normal`/`gamma` |
| `params.ts` | 讀取並驗證物種／世界參數，型別化 | `P()` |
| `weather.ts` | 歷史氣候合成天氣 | `calcWeather`/`rainPriors`/`monthInterp` |
| `ecology.ts` | 寄主、半翅目、蜜露、花蜜、殘骸、昆蟲族群（不讀任何蟻群） | `growSources` |
| `routes.ts` | 花園路線圖、步行時間 | `foraging_physics` 的 route/travel/goHome |
| `trails.ts` | 蟻群自己的費洛蒙路段 | `decay`/`deposit`/`fullTrail`/`followLocalTrail` |
| `workers.ts` | 局部訊號、任務選擇、巢內接觸、育幼接觸 | `localSignals`/`selectTask`/`forage()` 前段 |
| `foraging.ts` | 探索、選點、採集、捕食、回巢、招募 | `discover`/`collect`/`forage`/`prey` |
| `nutrition.ts` | 巢內食物帳、交哺卸貨、儲存上限、代謝 | `handoff`/`settleCrops`/`consume`/儲存溢出 |
| `brood.ts` | 卵→幼蟲→蛹→工蟻 | `developmentalDay` |
| `queen.ts` | 工蟻存活、蟻后存活、產卵 | `deathAndQueen` |
| `day.ts` | 一個世界日的固定順序、守恆與因果檢查 | `simulateDay` 主體 |
| `legacy.ts` | v2 單蟻群存檔格式轉接器（`simulateDay(state, bundle)`） | `simulateDay` 介面 |
| `migration.ts` | Day14→Day15 一次性遷移 | `sim/migrate_day15.cjs` |

## 3. 參數：物種 vs 世界

- 舊 `sim/params.json` 的 **157 個數值參數全部搬移**，每一項保留原欄位（value、assumption、description／rationale、reference_for_mechanism_only），並加上：
  - `basis`：`文獻支持`／`一般生理學`／`遊戲假設`（數值本身的根據）；
  - `mechanism_basis`：若機制方向有文獻支持而數值是假設；
  - `legacy_path`：原本在 `sim/params.json` 的位置。
- 原本**寫死在程式中的 88 個常數**（例如任務抽選的 0.75、0.08、0.7／0.3，食源評分的 0.77，儲存上限基準 14 隻工蟻，雨天相對濕度 +5／−2 …）全部搬到參數檔，數值原樣，`legacy_path: null` 並以 `moved_from_code` 註明原始位置。
- 純數值演算法常數（Box–Muller 的 1e-12、Gamma 抽樣的 0.0331、二分法 70 次、6 位小數）屬演算法本身，保留在程式中並命名說明；`world.model.unit_precision` 會被驗證必須等於引擎的 6 位小數。
- `tests/params-split.test.ts` 逐項驗證搬移無損。

物種檔另有 `traits`（階級雙態、創巢方式、食性、招募方式、交哺、覓食溫度、捕食、築巢），每項附文獻 ID 與 `engine_status`（目前引擎是否模擬）。只適用特定物種的機制用參數開關：例如 `castes.major_worker_production_enabled`（目前 `false`；設為 `true` 引擎會拒絕執行，因為尚未實作，而不是靜默忽略）。羽化個體的階級標籤 `castes.eclosion_caste_label` 也由物種檔提供。

## 4. 多蟻群結構

`engine/types.ts` 的 `WorldState`（schema `antempire.world-state.v3`）：

- 世界層：時鐘、種子、氣候記憶、食源（物理存量）、昆蟲族群。
- `colonies[]`：每個蟻群有 `species_id`（對應 `species/<id>.json`）、`nest_node`、`queen_id`、`rng_namespace`、ID 前綴、自己的 `population`、`stores`（巢內食物帳）、`trail_by_edge`（自己的費洛蒙）、`source_knowledge`（自己對每個食源的發現狀態）。
- 隨機串流標籤加上 `rng_namespace`；主蟻群為空字串，所以與 v6 完全相同。新蟻群必須用不同的非空 namespace 與 ID 前綴。
- 每日順序：天氣 → 世界生態 → 各蟻群覓食 → 各蟻群代謝／發育／死亡／產卵 → 檢查。

**正式存檔目前仍是 v2 單蟻群格式**（`saves/world-state.json#/sim_engine_v2`，Day15 才首次建立），由 `engine/legacy.ts` 轉接：它把 v2 物件直接當成主蟻群（MAIN）的資料視圖，執行同一個世界日，因此輸出與 v6 逐位元組相同。`legacyToWorldState()` 可轉成獨立的 v3 世界；`tests/multi-colony.test.ts` 驗證 v3 路徑與 v2 路徑 20 種子 × 60 日結果相同，並測試同一世界中兩個不同物種檔的蟻群可以共存運作。

F03、F04 的陌生蟻群目前在 `world/xitun-garden.json#background_colonies` 中只是背景生態（F04 以固定比例消耗蜜露；F03 沒有數值作用），物種 `null`。

## 5. 驗證

| 測試 | 內容 |
|---|---|
| `tests/golden.test.ts` | ① 以新引擎重新產生 `reports/day15-134-v6-20seeds-{daily,weekly}.csv`、`-analysis.json` 與單一種子 `day15-134-v6-*`，**逐位元組**比對；② 28 個情境（20 種子 × 120 日、斷糧、增糖、豐食、孤兒幼蟲、無工蟻蟻后、高探索、100／1000 工蟻）完整每日輸出（summary＋events＋state）的雜湊鏈，比對由舊引擎產生的 `tests/golden/v6-trace-sha256.json`。 |
| `tests/differential.test.ts` | 舊引擎仍在時，逐日直接比對 2618 個模擬日的完整 JSON；真實 Day14 存檔的遷移狀態逐位元組相同；Day15 存檔映射（main／world／日誌）在只正規化引擎參照字串、時間戳與規則指紋後逐位元組相同。 |
| `tests/naturalism.test.ts` | 214 項（與 v6 相同數量）。 |
| `tests/foraging-physics.test.ts` | 2149 項（與 v6 相同數量）。 |
| `tests/migration.test.ts` | 21／21。 |
| `tests/local-ecology.test.ts` | 靜態檢查生態與工蟻模組不讀巢內帳、參數標記、單變數對照；孤兒蟻后危險（fixture 已依玩家決定補上 `no_worker_days`，160 次 39 vs 1，與舊引擎及 `reports/local-ecology-tests.json` 相同）。 |
| `tests/scaling.test.ts` | 14／100／1000 工蟻，結果與 v6 參考相同。 |
| `tests/multi-colony.test.ts` | v3 多蟻群路徑＝v2 路徑；雙蟻群共存。 |
| `tests/platform-purity.test.ts` | engine/ 無 Node／DOM API、無物種名稱與世界節點 ID 寫死；純 SHA-256 與 node:crypto 一致。 |

執行：`npm ci && npm run typecheck && npm test`（Node ≥ 22.18，原生執行 TypeScript）。

## 6. 舊 `sim/` 的封存方式（待玩家決定）

新引擎通過所有測試後，建議另開 PR：

1. **保留不動**：`sim/results/day9*`～`day14*`（Day9～14 歷史輸出，存檔中有路徑引用）、`sim/day_engine_v1_day9_day14.cjs`（README 指定的 Day9～14 重播程式）。
2. **封存**：把 `sim/day_engine.cjs`、`foraging_physics.cjs`、`migrate_day15.cjs`、`run_day.cjs`、`params.json`、`day14-projection.json`、`prepare_review_projection.cjs`、`export_review.py`、`test_*.cjs` 以 `git mv` 移到 `sim/archive-v6/`（或直接刪除，git 歷史仍可取回）。
3. 封存後 `tests/differential.test.ts` 會自動略過；`tests/golden.test.ts`（含由舊引擎產生的完整輸出雜湊）與 `tests/golden/legacy-params-snapshot.json` 繼續鎖定行為。

# 規則更新 RU-1（v2-review.32）：食物參數宣告單位與 CE1 換算不變性

> 2026-11-13。依據：Owner 在 #219 的裁示（Q1：新核心以 mg／J 計，舊「份」只留在有版本的換算層；Q5：RU-1 → RU-2 → RU-6 → … 依序各自一個 PR）與 `docs/garden-supply-demand-audit.md` §4～§5 的 RU-1 定義。
> **規則更新，但只改中繼資料**：參數**數值一律不變**，引擎程式只改版本字串；所有輸出與 v2-review.31 逐位元組相同（`tests/golden.test.ts`：28 個 Day14 情境＋40 個 Day0 情境的完整輸出雜湊與 v31 相同；報表只差版本字串）。不推進遊戲時間；目前沒有正式世界。

## 1. 改了什麼

- `species/pheidole-megacephala.json` 37 個、`world/xitun-garden.json` 57 個參數新增 `unit` 欄位（放在 `value` 後面），內容與稽核登錄（`tools/garden-supply-demand-audit.ts` `REGISTRY`）的單位字串完全相同；稽核工具現在讀取參數檔的 `unit`，不一致或缺漏會標 `UNIT_MISMATCH`／`UNIT_NOT_DECLARED_IN_FILE`，測試要求兩者為 0。
- 單位字串的約定：
  - `game_portion …`：舊遊戲單位「份」（糖、蛋白或兩者），**不是 mg**，沒有質量或能量意義；後面寫明「每什麼、每多久」（例：`game_portion sugar / worker / day at metabolism.reference_c`）。
  - 其他：`fraction / mm rain`、`1/day`、`insects / site`、`°C`、`days`、`probability / arrival` 等，照字面。
  - 以 mg、µg、J 計的新核心量**不**用這些字串，而用 `engine/units/mass-energy.ts`（MEC-0，`docs/mass-energy-contract.md`）的整數型別；份↔mg 的係數只能在那裡的橋接層出現。
- 以份計的門檻也納入同一單位系統：`scouting.unproductive_route_threshold_portions`、`site_choice.default_prior_success_portions`，以及 CE1 找到的 `site_choice.score_base_offset`（見 §2）。
- Day15 遷移（已退役的舊歷史，#194）的初始存量也宣告單位（`starting_sugar`、`starting_protein`、`carcass_initial_*`、隱藏蜜露點的 `initial_sugar`／`capacity`／`listed_production`）。附帶發現：`hidden_honeydew_sites.*.listed_production` 引擎沒有讀取（描述本來就寫「舊程式列出但未使用」）；它不在 RU-2 的三個死參數之內，本 PR 不處理。
- 規則版本登錄：`rules/registry.json` 新增 v32（新的 v1 指紋：參數檔與 `engine/day.ts` 的版本字串改變）；`tests/golden/approved-rule-changes.json` 新增兩筆 `param_metadata`（`metadata_field_added: "unit"`、列出所有路徑、`day14_output_unchanged: true`）；`cli/lib/rules-version.ts` 的 `bundleAtVersion(…, { forHash: true })` 會為較早版本移除這個欄位，所以舊版本資料（例如第二階段敏感度資料）的參數雜湊仍能重建。

## 2. CE1 換算不變性（`tools/ce1-conversion-invariance.ts`、`reports/ce1-conversion-invariance/`、`tests/ce1-conversion-invariance.test.ts`）

**方法**：把每個宣告單位為 `game_portion` 的參數（54 個）乘上同一倍率 k，在 Day0 實驗世界（A1～A5 × 四季 × 兩個種子，各 90 日）與未縮放的同一世界逐日比較完整輸出 `[result, state]`。維度一致的模型應該讓所有以份計的輸出變成 k 倍、其他輸出（人數、時間、ID、決策、事件、亂數抽取）完全相同，只差捨入。比較時字串中的數字先遮罩再比文字；任何鍵、陣列長度、型別或文字不同，或數字既不接近 k 倍也不接近相等，就算「結構分歧」（發生了不同的決策或事件）。報告列出量測到的偏差，不以容忍度隱藏。

**結果（不是逐位元組相同；如實報告）**

| 實驗 | 無結構分歧（90 日） | 最早分歧日 | 份量最大偏差 \|S/k − B\| | 其他量最大偏差 \|S − B\| |
|---|---:|---:|---:|---:|
| 宣告的份量參數 × 2 | **40/40** | — | 5.25e-5 份 | 3.24e-4 |
| 宣告的份量參數 × 0.5 | 36/40 | 34 | 7.17e-4 份 | 6.84e-4 |
| 宣告的份量參數 × 10 | 35/40 | 7 | 7.02e-4 份 | 4.21e-4 |
| 稽核原本的份量集合（不含 `score_base_offset`）× 2 | **11/40** | 5 | — | — |

（偏差算到第一個分歧日為止；完整逐組結果見 `reports/ce1-conversion-invariance/ce1.md`。）

**發現 1（參數混用單位）**：`site_choice.score_base_offset`（0.15）在原本的稽核中沒有被當成份量，但引擎把它**加在以份計的收穫記憶上**：`score = (score_base_offset + prior) × …`（`engine/activity.ts`、`engine/foraging.ts`）。只縮放稽核原本的集合時，40 組中 29 組在 90 日內出現不同的覓食決策（最早第 5 日）；把它也當成份量後，k = 2 的 40 組全部沒有結構分歧。所以它其實是份量，已宣告為 `game_portion`。**它的數值沒有改**；它是否合理是另一個問題（RU-6 改用 mg 時必須一起換算，不能留成無因次常數）。

**發現 2（程式中的絕對份量常數）**：k = 0.5、10 仍有少數分歧，來自引擎程式碼中以份為單位的絕對值（不是參數，所以 CE1 無法縮放）：
- 感知門檻 `sourceSum(site) <= 1e-5`（`engine/activity.ts`、`engine/foraging.ts`）：已追查 k = 10 的 A1-summer-20270001 第 7 日——花期已結束的 F08 剩下 0.000002 份（基準）與 0.000019 份（× 10），只有基準把它當「空的」，同一隻工蟻一邊什麼都沒找到、一邊發現花蜜。
- 存量捨入到 1e-6 份（`engine/math.ts` `round()`）：已追查 k = 10 的 A5-winter-20270001 第 25 日——採集時間與捨入後的載量成正比，結束時刻差 1e-6 分鐘，使同一分鐘的兩個事件處理順序不同。
- 其餘 7 個分歧沒有逐一追查；k = 2（二進位精確乘法）沒有分歧，與「只剩捨入與絕對門檻」的解讀一致，但不是證明。
這些常數是行為的一部分，修改它們會改變輸出，屬於之後的規則更新（RU-6 改用 `engine/units/mass-energy.ts` 的整數質量時一起處理），本 PR 不改。

**限制**：CE1 只測舊日程引擎、Day0 情境、90 日、兩個種子；P0-A2 原型與 `scenarios/` 的檔案不在本 PR 範圍（其他工作正在修改）。CE1 證明的是「份」內部的一致性，**不**表示份已有質量意義；份↔mg 的對應仍是候選區間（0.0162～0.08812 mg 糖／份，稽核 §4.3），只能經由 MEC-0 的橋接層使用。

## 3. 驗證

- `npm run test:golden`：v32 的 28 個 Day14 情境與 40 個 Day0 情境雜湊與 v31 相同；`reports/day15-134-v32-*` 與 v31 只差 `schema`／`engine_version`／`physical_foraging_version` 字串。
- `tests/rules-isolation.test.ts`：新增 v32 一步，什麼都不復原就重現 v31。
- `tests/rules-registry.test.ts`：目前的指紋＝登錄檔最後一筆（v32）。
- `tests/params-split.test.ts`：所有舊參數的值與原有中繼資料不變（新增欄位不影響）。
- `tests/garden-supply-demand-audit.test.ts`：每個登錄的物種／世界食物參數都在檔內宣告相同單位；缺漏或不一致的負面樣本會被標出。
- `tests/ce1-conversion-invariance.test.ts`（阻擋型）：k = 2 的 10 組 90 日沒有結構分歧、偏差在捨入量級；留下 `score_base_offset` 不縮放時會分歧（負面對照，確保測試看得見單位混用）；已提交報告的對應列與重算完全相同。

## 4. 回滾

還原本 PR 即回到 v2-review.31（參數值從未改變；舊版本的參數雜湊由 `bundleAtVersion` 重建）。

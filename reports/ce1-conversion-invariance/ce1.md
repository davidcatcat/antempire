# CE1 換算不變性（自動產生）

> 由 `node tools/ce1-conversion-invariance.ts --write` 產生。**診斷，不是目標**；非正式 Day0 實驗世界；不改任何參數值（CLAUDE.md §7）。方法見工具檔頭與 `docs/ru1-param-units.md`。

設計：A1、A2、A3、A4、A5 × spring、summer、autumn、winter × 種子 20270001、20270002，每組 90 日；倍率 k ∈ {2, 0.5, 10}。被乘上 k 的參數（宣告單位為 game_portion）共 54 個。

| 實驗 | k | 說明 | 無結構分歧（90 日） | 分歧日（中位／最早） | 縮放量最大偏差 |S/k − B|（份） | 非縮放量最大偏差 |S − B| |
|---|---:|---|---:|---|---:|---:|
| declared_k2 | 2 | every parameter declared game_portion (RU-1) × 2 | 40/40 | — | 5.25e-5 | 3.24e-4 |
| declared_k0.5 | 0.5 | every parameter declared game_portion (RU-1) × 0.5 | 36/40 | 35／34 | 7.17e-4 | 6.84e-4 |
| declared_k10 | 10 | every parameter declared game_portion (RU-1) × 10 | 35/40 | 7／7 | 7.02e-4 | 4.21e-4 |
| audit_set_k2 | 2 | the audit's original portion set (#202 item 8 registry), i.e. without site_choice.score_base_offset, × 2 — reproduces the CE1 finding | 11/40 | 29／5 | 1.01e-3 | 6.08e-1 |

**發現**：`species:pheidole-megacephala#site_choice.score_base_offset`——added to a remembered harvest in portions: score = (score_base_offset + prior) × penalty × bias × (…) (engine/activity.ts, engine/foraging.ts); it is a portion quantity that was not declared as one。

## 不能用參數縮放的程式常數（以份為單位的絕對值）

- engine/math.ts round()：every stored food amount is rounded to 1e-6 份 (absolute, UNIT_DECIMALS = world model.unit_precision)
- engine/activity.ts, engine/foraging.ts sourceSum(site) <= 1e-5：a source with ≤ 1e-5 份 is treated as empty (perception threshold in portions)
- engine/ecology.ts, engine/foraging.ts needed <= 1e-6：loop stop in portions
- engine/ecology.ts TOL_FLOW = 1e-5, engine/day.ts carcass check 1e-4, engine/invariants.ts / queen-feeding.ts / larva-feeding.ts 1e-9：conservation / domain check tolerances in portions (checks only; they do not change outputs while they pass)

## 已追查原因的分歧（其餘未逐一追查）

- declared_k10 A1-summer-20270001 第 7 日：perception threshold in code: on day 7 the bloomed-out nectar site F08 holds 0.000002 份 (baseline) vs 0.000019 份 (×10); sourceSum(site) <= 1e-5 makes it "empty" only in the baseline, so W009 finds nothing there in one run and discovers nectar in the other
- declared_k10 A5-winter-20270001 第 25 日：rounding: the collect duration is proportional to the rounded load (0.187246 vs 1.872458 份), so the activity ends at minute 15.411765 vs 15.411764; two events at minute 15.882352/3 are then processed in a different order

## 各組結果

| 實驗 | 情境 | 種子 | 第一個結構分歧日 | 分歧樣本 | 縮放量最大偏差 | 非縮放量最大偏差 |
|---|---|---:|---:|---|---:|---:|
| declared_k2 | A1-spring | 20270001 | — | — | 0.000042 | 0.000262 |
| declared_k2 | A1-spring | 20270002 | — | — | 0.000028 | 0.000099 |
| declared_k2 | A1-summer | 20270001 | — | — | 0.0000085 | 0 |
| declared_k2 | A1-summer | 20270002 | — | — | 0.0000175 | 0.000125 |
| declared_k2 | A1-autumn | 20270001 | — | — | 0.000023 | 0.000219 |
| declared_k2 | A1-autumn | 20270002 | — | — | 0.0000405 | 0.000105 |
| declared_k2 | A1-winter | 20270001 | — | — | 0.0000245 | 0.000092 |
| declared_k2 | A1-winter | 20270002 | — | — | 0.0000435 | 0.000073 |
| declared_k2 | A2-spring | 20270001 | — | — | 0.0000455 | 0.000171 |
| declared_k2 | A2-spring | 20270002 | — | — | 0.0000195 | 0.000167 |
| declared_k2 | A2-summer | 20270001 | — | — | 0.000008 | 0.000002 |
| declared_k2 | A2-summer | 20270002 | — | — | 0.00001 | 0.000032 |
| declared_k2 | A2-autumn | 20270001 | — | — | 0.0000375 | 0.000135 |
| declared_k2 | A2-autumn | 20270002 | — | — | 0.0000225 | 0.000081 |
| declared_k2 | A2-winter | 20270001 | — | — | 0.000028 | 0.000105 |
| declared_k2 | A2-winter | 20270002 | — | — | 0.0000085 | 0.000072 |
| declared_k2 | A3-spring | 20270001 | — | — | 0.0000245 | 0.000324 |
| declared_k2 | A3-spring | 20270002 | — | — | 0.000015 | 0.000113 |
| declared_k2 | A3-summer | 20270001 | — | — | 0.000008 | 0.00003 |
| declared_k2 | A3-summer | 20270002 | — | — | 0.000005 | 0.000032 |
| declared_k2 | A3-autumn | 20270001 | — | — | 0.000042 | 0.000154 |
| declared_k2 | A3-autumn | 20270002 | — | — | 0.000009 | 0.000021 |
| declared_k2 | A3-winter | 20270001 | — | — | 0.0000525 | 0.000184 |
| declared_k2 | A3-winter | 20270002 | — | — | 0.0000325 | 0.000064 |
| declared_k2 | A4-spring | 20270001 | — | — | 0.000009 | 0.000054 |
| declared_k2 | A4-spring | 20270002 | — | — | 0.0000035 | 0 |
| declared_k2 | A4-summer | 20270001 | — | — | 0.0000025 | 0.000014 |
| declared_k2 | A4-summer | 20270002 | — | — | 0.0000055 | 0.000004 |
| declared_k2 | A4-autumn | 20270001 | — | — | 0.0000125 | 0.000047 |
| declared_k2 | A4-autumn | 20270002 | — | — | 0.000011 | 0.00005 |
| declared_k2 | A4-winter | 20270001 | — | — | 0.000003 | 0 |
| declared_k2 | A4-winter | 20270002 | — | — | 0.0000025 | 0 |
| declared_k2 | A5-spring | 20270001 | — | — | 0.0000205 | 0.000127 |
| declared_k2 | A5-spring | 20270002 | — | — | 0.000017 | 0.000064 |
| declared_k2 | A5-summer | 20270001 | — | — | 0.0000285 | 0.000189 |
| declared_k2 | A5-summer | 20270002 | — | — | 0.000016 | 0.00007 |
| declared_k2 | A5-autumn | 20270001 | — | — | 0.0000305 | 0.000115 |
| declared_k2 | A5-autumn | 20270002 | — | — | 0.0000165 | 0.000044 |
| declared_k2 | A5-winter | 20270001 | — | — | 0.000019 | 0.000034 |
| declared_k2 | A5-winter | 20270002 | — | — | 0.0000075 | 0.000154 |
| declared_k0.5 | A1-spring | 20270001 | — | — | 0.000082 | 0.000498 |
| declared_k0.5 | A1-spring | 20270002 | — | — | 0.000051 | 0.000187 |
| declared_k0.5 | A1-summer | 20270001 | — | — | 0.000017 | 0 |
| declared_k0.5 | A1-summer | 20270002 | — | — | 0.000038 | 0.00023 |
| declared_k0.5 | A1-autumn | 20270001 | 48 | `day48.0.colonies.0.events.163.worker#0: 3 vs 5`<br>`day48.0.colonies.0.events.164.worker#0: 3 vs 5`<br>`day48.0.colonies.0.events.165.worker#0: 5 vs 3` | 0.000048 | 0.000456 |
| declared_k0.5 | A1-autumn | 20270002 | — | — | 0.000075 | 0.000202 |
| declared_k0.5 | A1-winter | 20270001 | — | — | 0.000049 | 0.00018 |
| declared_k0.5 | A1-winter | 20270002 | — | — | 0.000084 | 0.000146 |
| declared_k0.5 | A2-spring | 20270001 | 34 | `day34.0.colonies.0.summary.income.sugar: 6.864255 vs 4.558266`<br>`day34.0.colonies.0.summary.tasks.forage: 6 vs 8`<br>`day34.0.colonies.0.summary.tasks.nurse: 5 vs 4` | 0.000081 | 0.000304 |
| declared_k0.5 | A2-spring | 20270002 | — | — | 0.000028 | 0.000259 |
| declared_k0.5 | A2-summer | 20270001 | — | — | 0.000016 | 0.000006 |
| declared_k0.5 | A2-summer | 20270002 | — | — | 0.000017 | 0.000075 |
| declared_k0.5 | A2-autumn | 20270001 | — | — | 0.000071 | 0.000248 |
| declared_k0.5 | A2-autumn | 20270002 | — | — | 0.000039 | 0.000142 |
| declared_k0.5 | A2-winter | 20270001 | — | — | 0.000059 | 0.000221 |
| declared_k0.5 | A2-winter | 20270002 | — | — | 0.000019 | 0.000216 |
| declared_k0.5 | A3-spring | 20270001 | — | — | 0.000052 | 0.000684 |
| declared_k0.5 | A3-spring | 20270002 | — | — | 0.000033 | 0.000213 |
| declared_k0.5 | A3-summer | 20270001 | — | — | 0.000016 | 0.000066 |
| declared_k0.5 | A3-summer | 20270002 | — | — | 0.000012 | 0.000064 |
| declared_k0.5 | A3-autumn | 20270001 | — | — | 0.000101 | 0.000338 |
| declared_k0.5 | A3-autumn | 20270002 | — | — | 0.000024 | 0.000045 |
| declared_k0.5 | A3-winter | 20270001 | — | — | 0.000108 | 0.00038 |
| declared_k0.5 | A3-winter | 20270002 | — | — | 0.000057 | 0.000167 |
| declared_k0.5 | A4-spring | 20270001 | — | — | 0.00001 | 0.00005 |
| declared_k0.5 | A4-spring | 20270002 | — | — | 0.000006 | 0 |
| declared_k0.5 | A4-summer | 20270001 | — | — | 0.000005 | 0.000021 |
| declared_k0.5 | A4-summer | 20270002 | — | — | 0.00001 | 0.000008 |
| declared_k0.5 | A4-autumn | 20270001 | — | — | 0.00002 | 0.000075 |
| declared_k0.5 | A4-autumn | 20270002 | — | — | 0.000017 | 0.000078 |
| declared_k0.5 | A4-winter | 20270001 | — | — | 0.000005 | 0 |
| declared_k0.5 | A4-winter | 20270002 | — | — | 0.000004 | 0 |
| declared_k0.5 | A5-spring | 20270001 | 35 | `day35.0.colonies.0.summary.foraging_trips: 32 vs 33`<br>`day35.0.colonies.0.summary.foraging_successes: 11 vs 10`<br>`day35.0.colonies.0.summary.activity.trips: 32 vs 33` | 0.000717 | 0.000116 |
| declared_k0.5 | A5-spring | 20270002 | — | — | 0.000032 | 0.000095 |
| declared_k0.5 | A5-summer | 20270001 | — | — | 0.000064 | 0.000398 |
| declared_k0.5 | A5-summer | 20270002 | — | — | 0.000043 | 0.000219 |
| declared_k0.5 | A5-autumn | 20270001 | 78 | `day78.0.colonies.0.summary.foraging_trips: 50 vs 49`<br>`day78.0.colonies.0.summary.foraging_successes: 20 vs 19`<br>`day78.0.colonies.0.summary.extra_sugar_cost: 0.234658 vs 0.098497` | 0.000068 | 0.000206 |
| declared_k0.5 | A5-autumn | 20270002 | — | — | 0.000037 | 0.000098 |
| declared_k0.5 | A5-winter | 20270001 | — | — | 0.000038 | 0.00006 |
| declared_k0.5 | A5-winter | 20270002 | — | — | 0.000012 | 0.00022 |
| declared_k10 | A1-spring | 20270001 | — | — | 0.0000351 | 0.000229 |
| declared_k10 | A1-spring | 20270002 | — | — | 0.0000229 | 0.00008 |
| declared_k10 | A1-summer | 20270001 | 7 | `day7.0.colonies.0.summary.foraging_trips: 16 vs 12`<br>`day7.0.colonies.0.summary.foraging_successes: 4 vs 5`<br>`day7.0.colonies.0.summary.extra_sugar_cost: 0.012856 vs 0.107529` | 0.0000048 | 0.000006 |
| declared_k10 | A1-summer | 20270002 | — | — | 0.0000151 | 0.000091 |
| declared_k10 | A1-autumn | 20270001 | — | — | 0.0000279 | 0.000175 |
| declared_k10 | A1-autumn | 20270002 | — | — | 0.0000348 | 0.000089 |
| declared_k10 | A1-winter | 20270001 | — | — | 0.0000184 | 0.000069 |
| declared_k10 | A1-winter | 20270002 | — | — | 0.0000314 | 0.000065 |
| declared_k10 | A2-spring | 20270001 | — | — | 0.0000436 | 0.000164 |
| declared_k10 | A2-spring | 20270002 | — | — | 0.0000407 | 0.000421 |
| declared_k10 | A2-summer | 20270001 | 7 | `day7.0.colonies.0.summary.foraging_successes: 5 vs 6`<br>`day7.0.colonies.0.summary.extra_sugar_cost: 0.012931 vs 0.136329`<br>`day7.0.colonies.0.summary.foraging_workers_by_macro.sugar: 0 vs 1` | 0.000702 | 0.000006 |
| declared_k10 | A2-summer | 20270002 | — | — | 0.000016 | 0.000093 |
| declared_k10 | A2-autumn | 20270001 | — | — | 0.0000447 | 0.000154 |
| declared_k10 | A2-autumn | 20270002 | — | — | 0.000023 | 0.000084 |
| declared_k10 | A2-winter | 20270001 | — | — | 0.0000242 | 0.000086 |
| declared_k10 | A2-winter | 20270002 | — | — | 0.0000114 | 0.000033 |
| declared_k10 | A3-spring | 20270001 | — | — | 0.0000162 | 0.000213 |
| declared_k10 | A3-spring | 20270002 | — | — | 0.0000115 | 0.000114 |
| declared_k10 | A3-summer | 20270001 | 7 | `day7.0.colonies.0.summary.foraging_successes: 5 vs 6`<br>`day7.0.colonies.0.summary.extra_sugar_cost: 0.012931 vs 0.136329`<br>`day7.0.colonies.0.summary.foraging_workers_by_macro.sugar: 0 vs 1` | 0.000702 | 0.000017 |
| declared_k10 | A3-summer | 20270002 | — | — | 0.0000099 | 0.00008 |
| declared_k10 | A3-autumn | 20270001 | — | — | 0.0000368 | 0.000121 |
| declared_k10 | A3-autumn | 20270002 | — | — | 0.0000147 | 0.000027 |
| declared_k10 | A3-winter | 20270001 | — | — | 0.0000342 | 0.00012 |
| declared_k10 | A3-winter | 20270002 | — | — | 0.0000262 | 0.000051 |
| declared_k10 | A4-spring | 20270001 | — | — | 0.0000136 | 0.000108 |
| declared_k10 | A4-spring | 20270002 | — | — | 0.0000026 | 0 |
| declared_k10 | A4-summer | 20270001 | — | — | 0.000002 | 0.000014 |
| declared_k10 | A4-summer | 20270002 | — | — | 0.0000034 | 0.000003 |
| declared_k10 | A4-autumn | 20270001 | — | — | 0.000011 | 0.000041 |
| declared_k10 | A4-autumn | 20270002 | — | — | 0.0000091 | 0.000028 |
| declared_k10 | A4-winter | 20270001 | — | — | 0.0000018 | 0 |
| declared_k10 | A4-winter | 20270002 | — | — | 0.0000019 | 0 |
| declared_k10 | A5-spring | 20270001 | — | — | 0.0000302 | 0.000227 |
| declared_k10 | A5-spring | 20270002 | — | — | 0.0000167 | 0.000063 |
| declared_k10 | A5-summer | 20270001 | — | — | 0.0000388 | 0.000266 |
| declared_k10 | A5-summer | 20270002 | — | — | 0.0000151 | 0.00007 |
| declared_k10 | A5-autumn | 20270001 | — | — | 0.0000334 | 0.000125 |
| declared_k10 | A5-autumn | 20270002 | — | — | 0.0000162 | 0.000061 |
| declared_k10 | A5-winter | 20270001 | 25 | `day25.0.colonies.0.events.54: keys`<br>`day25.0.colonies.0.events.55: keys`<br>`day25.0.colonies.0.events.56: keys` | 0.0000052 | 0.000011 |
| declared_k10 | A5-winter | 20270002 | 87 | `day87.0.colonies.0.summary.income.protein: 4.183998 vs 0`<br>`day87.0.colonies.0.summary.tasks.forage: 6 vs 1`<br>`day87.0.colonies.0.summary.tasks.nurse: 1 vs 3` | 0.0000074 | 0.000145 |
| audit_set_k2 | A1-spring | 20270001 | 34 | `day34.0.colonies.0.summary.income.sugar: 0.398261 vs 0.118767`<br>`day34.0.colonies.0.summary.income.protein: 0.921877 vs 3.038396`<br>`day34.0.colonies.0.summary.tasks.nurse: 3 vs 0` | 0.000042 | 0.000074 |
| audit_set_k2 | A1-spring | 20270002 | 14 | `day14.0.colonies.0.summary.foraging_workers_by_macro.sugar: 5 vs 4`<br>`day14.0.colonies.0.summary.foraging_workers_by_macro.protein: 0 vs 1`<br>`day14.0.colonies.0.summary.activity.outside_minutes: 736.433024 vs 735.413416` | 0.000247 | 0.000099 |
| audit_set_k2 | A1-summer | 20270001 | — | — | 0.0000085 | 0 |
| audit_set_k2 | A1-summer | 20270002 | 35 | `day35.0.colonies.0.summary.activity.outside_minutes: 598.475563 vs 597.534387`<br>`day35.0.colonies.0.summary.activity.travel_minutes: 570.08823 vs 569.147054`<br>`day35.0.colonies.0.summary.activity.workers.W009.outside_minutes: 113.62745 vs 112.686274` | 0.000229 | 0.000125 |
| audit_set_k2 | A1-autumn | 20270001 | 51 | `day51.0.colonies.0.summary.income.sugar: 2.138045 vs 2.160134`<br>`day51.0.colonies.0.summary.tasks.forage: 3 vs 1`<br>`day51.0.colonies.0.summary.tasks.repair: 0 vs 1` | 0.000023 | 0.000219 |
| audit_set_k2 | A1-autumn | 20270002 | 37 | `day37.0.colonies.0.summary.income.sugar: 0.761404 vs 0`<br>`day37.0.colonies.0.summary.income.protein: 1.515296 vs 0`<br>`day37.0.colonies.0.summary.tasks.forage: 4 vs 1` | 0.0000405 | 0.000105 |
| audit_set_k2 | A1-winter | 20270001 | 84 | `day84.0.colonies.0.summary.income.sugar: 0.408195 vs 2.694582`<br>`day84.0.colonies.0.summary.foraging_trips: 12 vs 16`<br>`day84.0.colonies.0.summary.foraging_successes: 4 vs 6` | 0.0000245 | 0.000092 |
| audit_set_k2 | A1-winter | 20270002 | — | — | 0.0000435 | 0.000073 |
| audit_set_k2 | A2-spring | 20270001 | 19 | `day19.0.colonies.0.summary.tasks.forage: 7 vs 5`<br>`day19.0.colonies.0.summary.tasks.repair: 0 vs 1`<br>`day19.0.colonies.0.summary.tasks.rest: 0 vs 1` | 0.00101 | 0.000007 |
| audit_set_k2 | A2-spring | 20270002 | 43 | `day43.0.colonies.0.summary.foraging_workers_by_macro.sugar: 7 vs 6`<br>`day43.0.colonies.0.summary.foraging_workers_by_macro.protein: 0 vs 1`<br>`day43.0.colonies.0.summary.activity.workers.W003.outside_minutes: 2.941176 vs 3.215686` | 0.0000665 | 0.275 |
| audit_set_k2 | A2-summer | 20270001 | — | — | 0.000008 | 0.000002 |
| audit_set_k2 | A2-summer | 20270002 | 5 | `day5.0.colonies.0.summary.income.sugar: 2.360781 vs 2.56`<br>`day5.0.colonies.0.summary.income.protein: 1.369577 vs 3.144175`<br>`day5.0.colonies.0.summary.tasks.nurse: 0 vs 1` | 0.000003 | 0.000009 |
| audit_set_k2 | A2-autumn | 20270001 | 27 | `day27.0.colonies.0.summary.activity.travel_minutes: 230.274512 vs 229.94118`<br>`day27.0.colonies.0.summary.activity.workers.W005.outside_minutes: 32.73999 vs 32.40665`<br>`day27.0.colonies.0.summary.activity.workers.W005.travel_minutes: 7.215686 vs 6.882354` | 0.000104 | 0.333 |
| audit_set_k2 | A2-autumn | 20270002 | 33 | `day33.0.colonies.0.summary.income.sugar: 0 vs 0.828797`<br>`day33.0.colonies.0.summary.foraging_trips: 7 vs 8`<br>`day33.0.colonies.0.summary.foraging_successes: 0 vs 1` | 0.0000215 | 0.000041 |
| audit_set_k2 | A2-winter | 20270001 | 88 | `day88.0.colonies.0.summary.income.sugar: 1.116951 vs 1.784476`<br>`day88.0.colonies.0.summary.foraging_trips: 7 vs 10`<br>`day88.0.colonies.0.summary.extra_sugar_cost: 0.005707 vs 0.014963` | 0.000028 | 0.000105 |
| audit_set_k2 | A2-winter | 20270002 | 47 | `day47.0.colonies.0.summary.income.sugar: 2.97785 vs 3.837288`<br>`day47.0.colonies.0.summary.foraging_trips: 22 vs 20`<br>`day47.0.colonies.0.summary.foraging_successes: 9 vs 7` | 0.000007 | 0.000009 |
| audit_set_k2 | A3-spring | 20270001 | 64 | `day64.0.colonies.0.summary.income.sugar: 0.324408 vs 0`<br>`day64.0.colonies.0.summary.tasks.forage: 3 vs 2`<br>`day64.0.colonies.0.summary.tasks.repair: 0 vs 1` | 0.0000245 | 0.000324 |
| audit_set_k2 | A3-spring | 20270002 | 18 | `day18.0.colonies.0.summary.income.sugar: 0 vs 1.568098`<br>`day18.0.colonies.0.summary.tasks.forage: 4 vs 5`<br>`day18.0.colonies.0.summary.tasks.repair: 1 vs 0` | 0.000012 | 0.000031 |
| audit_set_k2 | A3-summer | 20270001 | — | — | 0.000008 | 0.00003 |
| audit_set_k2 | A3-summer | 20270002 | 29 | `day29.0.colonies.0.events.234.to#0: 1 vs 7`<br>`day29.0.colonies.0.events.235.duration: 0.470588 vs 0.607843`<br>`day29.0.colonies.0.events.235.place#1: 1 vs 7` | 0.000004 | 0.137 |
| audit_set_k2 | A3-autumn | 20270001 | 22 | `day22.0.colonies.0.summary.income.sugar: 4.083835 vs 6.900599`<br>`day22.0.colonies.0.summary.foraging_trips: 36 vs 35`<br>`day22.0.colonies.0.summary.foraging_successes: 19 vs 18` | 0.000012 | 0.608 |
| audit_set_k2 | A3-autumn | 20270002 | 22 | `day22.0.colonies.0.summary.income.sugar: 3.375393 vs 7.195774`<br>`day22.0.colonies.0.summary.income.protein: 0.828549 vs 0.672954`<br>`day22.0.colonies.0.summary.foraging_trips: 20 vs 17` | 0.0000025 | 0.00001 |
| audit_set_k2 | A3-winter | 20270001 | 11 | `day11.0.colonies.0.summary.income.sugar: 2.793722 vs 0`<br>`day11.0.colonies.0.summary.tasks.forage: 8 vs 6`<br>`day11.0.colonies.0.summary.tasks.rest: 0 vs 1` | 0.000037 | 0.000821 |
| audit_set_k2 | A3-winter | 20270002 | — | — | 0.0000325 | 0.000064 |
| audit_set_k2 | A4-spring | 20270001 | 54 | `day54.0.colonies.0.summary.foraging_workers_by_macro.sugar: 1 vs 0`<br>`day54.0.colonies.0.summary.foraging_workers_by_macro.protein: 0 vs 1`<br>`day54.0.colonies.0.summary.activity.outside_minutes: 105.254902 vs 53.215686` | 0.000003 | 0.000283 |
| audit_set_k2 | A4-spring | 20270002 | — | — | 0.0000035 | 0 |
| audit_set_k2 | A4-summer | 20270001 | — | — | 0.0000025 | 0.000014 |
| audit_set_k2 | A4-summer | 20270002 | — | — | 0.0000055 | 0.000004 |
| audit_set_k2 | A4-autumn | 20270001 | 65 | `day65.0.colonies.0.summary.income.sugar: 2.114031 vs 2.122629`<br>`day65.0.colonies.0.summary.foraging_trips: 18 vs 17`<br>`day65.0.colonies.0.summary.foraging_successes: 13 vs 10` | 0.0000125 | 0.000047 |
| audit_set_k2 | A4-autumn | 20270002 | 28 | `day28.0.colonies.0.summary.income.sugar: 1.17266 vs 0`<br>`day28.0.colonies.0.summary.income.protein: 2.94727 vs 6.829198`<br>`day28.0.colonies.0.summary.foraging_trips: 13 vs 9` | 0.0000105 | 0.00003 |
| audit_set_k2 | A4-winter | 20270001 | — | — | 0.000003 | 0 |
| audit_set_k2 | A4-winter | 20270002 | — | — | 0.0000025 | 0 |
| audit_set_k2 | A5-spring | 20270001 | 52 | `day52.0.colonies.0.summary.extra_sugar_cost: 0.005959 vs 0.010808`<br>`day52.0.colonies.0.summary.activity.outside_minutes: 24.829565 vs 22.515837`<br>`day52.0.colonies.0.summary.activity.travel_minutes: 9 vs 6.686274` | 0.000555 | 0.0001 |
| audit_set_k2 | A5-spring | 20270002 | 19 | `day19.0.colonies.0.summary.income.protein: 2.07113 vs 1.089183`<br>`day19.0.colonies.0.summary.tasks.forage: 7 vs 5`<br>`day19.0.colonies.0.summary.tasks.nurse: 0 vs 1` | 0.0000145 | 0.000039 |
| audit_set_k2 | A5-summer | 20270001 | 17 | `day17.0.colonies.0.summary.foraging_trips: 17 vs 15`<br>`day17.0.colonies.0.summary.recruited: 5 vs 4`<br>`day17.0.colonies.0.summary.extra_sugar_cost: 0.013597 vs 0.024492` | 0.000008 | 0.000052 |
| audit_set_k2 | A5-summer | 20270002 | 11 | `day11.0.colonies.0.summary.activity.outside_minutes: 111.099233 vs 110.158057`<br>`day11.0.colonies.0.summary.activity.travel_minutes: 23.725476 vs 22.7843`<br>`day11.0.colonies.0.summary.activity.workers.W002.outside_minutes: 12.2549 vs 11.313724` | 0.000234 | 0.000023 |
| audit_set_k2 | A5-autumn | 20270001 | 24 | `day24.0.colonies.0.summary.income.protein: 4.584815 vs 2.130695`<br>`day24.0.colonies.0.summary.tasks.forage: 8 vs 7`<br>`day24.0.colonies.0.summary.tasks.rest: 0 vs 1` | 0.000027 | 0.000032 |
| audit_set_k2 | A5-autumn | 20270002 | 35 | `day35.0.colonies.0.summary.income.sugar: 1.592828 vs 1.516466`<br>`day35.0.colonies.0.summary.income.protein: 1.062582 vs 0`<br>`day35.0.colonies.0.summary.tasks.forage: 6 vs 4` | 0.0000165 | 0.000171 |
| audit_set_k2 | A5-winter | 20270001 | — | — | 0.000019 | 0.000034 |
| audit_set_k2 | A5-winter | 20270002 | 14 | `day14.0.colonies.0.summary.income.sugar: 0.76167 vs 0.403338`<br>`day14.0.colonies.0.summary.foraging_trips: 21 vs 20`<br>`day14.0.colonies.0.summary.foraging_successes: 11 vs 9` | 0.000005 | 0.000012 |

## 被縮放的參數

| 檔案 | 參數 | 值 | 宣告單位 |
|---|---|---:|---|
| world | `hemipterans.honeydew_per_colony_per_day.aphid` | 0.32 | game_portion sugar / hemipteran "colony" / day |
| world | `hemipterans.honeydew_per_colony_per_day.scale` | 0.4 | game_portion sugar / hemipteran "colony" / day |
| world | `honeydew.honeydew_max` | 5.2 | game_portion sugar (standing crop cap per site) |
| world | `honeydew.honeydew_daily_replenish` | 0.65 | game_portion sugar / day |
| world | `honeydew.honeydew_initial` | 0.55 | game_portion sugar |
| world | `nectar.nectar_max` | 2.4 | game_portion sugar (standing crop cap) |
| world | `nectar.nectar_daily_replenish` | 0.35 | game_portion sugar / site / day while blooming |
| world | `nectar.nectar_initial` | 0.18 | game_portion sugar |
| world | `carcasses.carcass_new_protein_min` | 1.45 | game_portion protein / natural insect death |
| world | `carcasses.carcass_new_protein_max` | 2.6 | game_portion protein / natural insect death |
| world | `prey.small_prey_protein` | 0.55 | game_portion protein / killed small insect |
| world | `prey.large_prey_protein` | 1.5 | game_portion protein / killed large insect |
| world | `day15_migration.hidden_honeydew_sites.F04.initial_sugar` | 0.75 | game_portion sugar |
| world | `day15_migration.hidden_honeydew_sites.F04.listed_production` | 0.75 | game_portion sugar / day (listed by the retired v1 code, not used) |
| world | `day15_migration.hidden_honeydew_sites.F04.capacity` | 3 | game_portion sugar (standing crop cap per site) |
| world | `day15_migration.hidden_honeydew_sites.F05.initial_sugar` | 0.4 | game_portion sugar |
| world | `day15_migration.hidden_honeydew_sites.F05.listed_production` | 0.55 | game_portion sugar / day (listed by the retired v1 code, not used) |
| world | `day15_migration.hidden_honeydew_sites.F05.capacity` | 2.8 | game_portion sugar (standing crop cap per site) |
| world | `day15_migration.hidden_honeydew_sites.F10.initial_sugar` | 0.4 | game_portion sugar |
| world | `day15_migration.hidden_honeydew_sites.F10.listed_production` | 0.5 | game_portion sugar / day (listed by the retired v1 code, not used) |
| world | `day15_migration.hidden_honeydew_sites.F10.capacity` | 2.8 | game_portion sugar (standing crop cap per site) |
| world | `day15_migration.starting_sugar` | 7.6 | game_portion sugar (nest store, one time) |
| world | `day15_migration.starting_protein` | 2.3 | game_portion protein (nest store, one time) |
| world | `day15_migration.carcass_initial_F07` | 0.6 | game_portion protein (carcass remains, one time) |
| world | `day15_migration.carcass_initial_F11` | 0.07 | game_portion protein (carcass remains, one time) |
| world | `day15_migration.carcass_initial_F07_older` | 0.05 | game_portion protein (carcass remains, one time) |
| species:pheidole-megacephala | `nutrition.worker_sugar_daily` | 0.1 | game_portion sugar / worker / day at metabolism.reference_c |
| species:pheidole-megacephala | `nutrition.worker_protein_daily` | 0.008 | game_portion protein / worker / day at reference_c |
| species:pheidole-megacephala | `nutrition.queen_sugar_daily` | 0.22 | game_portion sugar / queen / day at reference_c |
| species:pheidole-megacephala | `nutrition.queen_protein_daily` | 0.045 | game_portion protein / queen / day at reference_c |
| species:pheidole-megacephala | `nutrition.larva_sugar_daily` | 0.025 | game_portion sugar / larva / day at reference_c |
| species:pheidole-megacephala | `nutrition.larva_protein_daily` | 0.08 | game_portion protein / larva / day at reference_c |
| species:pheidole-megacephala | `nutrition.egg_laying_protein_cost` | 0.14 | game_portion protein / egg |
| species:pheidole-megacephala | `nutrition.egg_laying_sugar_cost` | 0.08 | game_portion sugar / egg |
| species:pheidole-megacephala | `nutrition.max_sugar_store` | 24 | game_portion sugar (nest store cap at baseline) |
| species:pheidole-megacephala | `nutrition.max_protein_store` | 12 | game_portion protein (nest store cap at baseline) |
| species:pheidole-megacephala | `nutrition.sugar_store_per_extra_worker` | 0.4 | game_portion sugar / extra worker |
| species:pheidole-megacephala | `nutrition.protein_store_per_extra_worker` | 0.3 | game_portion protein / extra worker |
| species:pheidole-megacephala | `foraging_trips.foraging_trip_sugar_cost` | 0.012 | game_portion sugar / trip |
| species:pheidole-megacephala | `scouting.unproductive_route_threshold_portions` | 0.1 | game_portion remembered harvest |
| species:pheidole-megacephala | `site_choice.default_prior_success_portions` | 0.15 | game_portion remembered harvest |
| species:pheidole-megacephala | `site_choice.score_base_offset` | 0.15 | game_portion sugar+protein (added to remembered harvest in site scores) |
| species:pheidole-megacephala | `food_handling.crop_load_sugar_min` | 0.28 | game_portion sugar / trip |
| species:pheidole-megacephala | `food_handling.crop_load_sugar_max` | 0.62 | game_portion sugar / trip |
| species:pheidole-megacephala | `food_handling.crop_load_protein_min` | 0.3 | game_portion protein / trip |
| species:pheidole-megacephala | `food_handling.crop_load_protein_max` | 0.64 | game_portion protein / trip |
| species:pheidole-megacephala | `trophallaxis.crop_capacity` | 0.8 | game_portion per worker crop |
| species:pheidole-megacephala | `trophallaxis.transfer_max_portions` | 0.28 | game_portion sugar / trophallaxis |
| species:pheidole-megacephala | `activity.active_minute_sugar_cost` | 0.00024 | game_portion sugar / minute outside |
| species:pheidole-megacephala | `queen_feeding.take_from_cache_max_portions` | 0.28 | game_portion protein / nest round |
| species:pheidole-megacephala | `queen_feeding.feed_max_portions_per_contact` | 0.28 | game_portion per contact |
| species:pheidole-megacephala | `queen_feeding.self_feed_max_portions` | 0.045 | game_portion protein / round |
| species:pheidole-megacephala | `larval_feeding.feed_bolus_sugar_portions` | 0.025 | game_portion sugar / contact |
| species:pheidole-megacephala | `larval_feeding.feed_bolus_protein_portions` | 0.08 | game_portion protein / contact |

# 雙工蟻窄道實驗 v2（Work C，局部讓路規則）— 實驗世界，非正式

> 由 `prototypes/physics/two-ant-corridor.ts` 產生；`tests/physics-two-ant.test.ts` 會重跑並比對本檔末的 JSON。
> - 合成場景，不是臺中西屯花園；不產生存檔、日誌或遊戲日。
> - **大頭家蟻屬沒有任何窄道交通或讓路研究**；以下規則都是非本種研究提出的候選機制（`scenarios/physics/pheidole-megacephala.interaction-candidates.json` 的 `encounter`）。

## 設定
- 通路長 100 mm、寬 20 mm；x=20～80 mm 兩側有牆，牆間可用寬度 1.0 mm。兩隻 0.8 mm 寬的工蟻在 [19.3755, 80.6245] mm 內只能單行。
- W1 從巢端（s=2）出發，速度 18.5 mm/s；W2 回巢，速度 15.5 mm/s（Vázquez 2020，本種）。體長 2.5 mm（Yuan 2026，本種）。
- 碰撞寬度 0.8 mm、觸角可及距離 1.0 mm：遊戲假設的候選值。
- 讓路的方式（R380、R381 都這樣描述）：讓路的那隻退出窄段，在寬處等對方通過，再繼續。以自己的速度退後，轉身時間 0（遊戲假設）。

## 1. 入口讓路（ENTRY）：有文獻依據的情境
W2 到達遠端入口時，W1 已經完全在牆間。依 Lasius niger 的觀察（R380：往橋中央走、即將進入 3 mm 中央段的那隻，在 202/211 次有接觸的相遇中讓路），尚未進入的 W2 讓路；兩隻先停 0.18 s（接觸持續時間，L. humile 實測，R108）。
- 與原文不同之處：原文的讓路者在瓶頸原地等待（R380 模型），這裡單行通道旁沒有空間，讓路者退到最近的寬處再等。
- 「身體尚未完全進入單行段」是幾何代理（單行段由兩隻寬度和決定）。

| 情境 | 接觸 | 阻擋（s） | 讓路者 | 規則 | 接觸停頓 s | 退後 mm | W1 抵達 s（比單獨多） | W2 抵達 s（比單獨多） | 互斥違反 | 重播／換順序相同 |
|---|---|---|---|---|---|---|---|---|---|---|
| ENTRY (L. niger rule, pause 0.18 s) | 4.079 s（確定） | 4.108 | W2 | entry yield | 0.18 | 1.37 | 5.384（+0.194） | 9.800（+0.628） | 0 | 是 |
| CONTROL (no walls) | 4.079 s（可能） | 無 | — | — | 0.00 | — | 5.189（+0.000） | 9.173（+0.000） | 0 | 是 |
| LADEN (Atta rule, W2 carries an item) | 4.079 s（確定） | 4.108 | W1 | laden priority | 0.18 | 59.87 | 12.791（+7.602） | 9.353（+0.180） | 0 | 是 |

- **400 個種子**（輕量模式：只記錄讓路者）：W2（尚未進入的那隻）讓路 387/400 = 0.968；文獻比例 202/211 = 0.957。模型只是重現了輸入的比例，這**不是**對本種的驗證。
- **帶食優先（LADEN）**：W2 帶著小物件，改用 Atta colombica 的規則（R381：294/300）。已在牆間的空手 W1 讓路 388/400 = 0.970。兩條規則在這個情境給出**相反**的讓路者：本種的答案取決於哪條規則適用，目前沒有資料可決定（預設用不依負重的 entry_yield）。
- **無牆對照**：只有一次「可能」的接觸，抵達時間與單獨行走相同（本版的接觸不觸發任何行為；C3–C5 尚未接上）。
- **解析解核對**：照規則手算（給定讓路者與停頓時間），W1 5.383569309 s、W2 9.800249493 s，引擎差 0.0e+0、0.0e+0 s。窄段端點用牆角幾何手算（80 + √(w² − 0.25)），不用引擎程式。

## 2. 兩隻都已在窄段內（INSIDE）：沒有任何研究
兩隻同時出發，在牆間迎面相遇。L. niger 與 Atta 的窄口都很短，沒有研究描述這種情況。模型的候選規則：每次接觸，兩隻**各自**以機率 p 決定回頭；剛好一隻回頭時那隻讓路，否則再接觸一次（每次都停 τ）。p 與 τ 都是候選值，以下是敏感度（每格 100 個種子）：

| p（每次接觸回頭的機率） | τ（每次接觸停頓 s） | W1 讓路次數 | 平均接觸次數 | W1 平均多花 s | W2 平均多花 s | 最多多花 s | 互斥違反（前 3 個種子完整檢查） |
|---|---|---|---|---|---|---|---|
| 0.1 | 0.18 | 61/100 | 6.47 | 3.983 | 2.604 | 11.790 | 0 |
| 0.1 | 0.43 | 61/100 | 6.47 | 5.600 | 4.221 | 23.040 | 0 |
| 0.1 | 0.8 | 61/100 | 6.47 | 7.994 | 6.615 | 39.690 | 0 |
| 0.5 | 0.18 | 61/100 | 2.17 | 3.209 | 1.830 | 6.243 | 0 |
| 0.5 | 0.43 | 61/100 | 2.17 | 3.751 | 2.372 | 8.743 | 0 |
| 0.5 | 0.8 | 61/100 | 2.17 | 4.554 | 3.175 | 12.490 | 0 |
| 0.9 | 0.18 | 60/100 | 5.87 | 3.833 | 2.532 | 8.370 | 0 |
| 0.9 | 0.43 | 60/100 | 5.87 | 5.301 | 4.000 | 14.870 | 0 |
| 0.9 | 0.8 | 60/100 | 5.87 | 7.473 | 6.172 | 24.490 | 0 |

- 誰讓路：規則對兩隻完全對稱，也不使用「誰離出口近」這類螞蟻不知道的資訊（v0 的規則已移除）；每格都用同一組 100 個種子，所以各格的讓路比例相同或幾乎相同，偏離一半屬抽樣誤差（測試以 2,000 個種子檢查接近 0.5）。
- p 越小，要接觸越多次才決定（期望 1/(2p(1−p)) 次），每次都付出 τ。**延遲主要取決於這兩個本種未量測的值。**
- 解析解核對（給定讓路者與停頓）：45 次，最大差 1.8e-15 s。

## 3. 碰撞寬度敏感度（ENTRY 情境）
| 情境 | 接觸 | 阻擋（s） | 讓路者 | 規則 | 接觸停頓 s | 退後 mm | W1 抵達 s（比單獨多） | W2 抵達 s（比單獨多） | 互斥違反 | 重播／換順序相同 |
|---|---|---|---|---|---|---|---|---|---|---|
| width 0.5 mm | 4.079 s（確定） | 無 | — | — | 0.00 | — | 5.189（+0.000） | 9.173（+0.000） | 0 | 是 |
| width 0.65 mm | 4.079 s（確定） | 4.108 | W2 | entry yield | 0.18 | 1.17 | 5.381（+0.192） | 9.773（+0.601） | 0 | 是 |
| width 0.8 mm | 4.079 s（確定） | 4.108 | W2 | entry yield | 0.18 | 1.37 | 5.384（+0.194） | 9.800（+0.628） | 0 | 是 |

寬度 0.5 mm 時兩隻以零間隙並排通過（臨界）；寬度大於 0.5 mm 就一定要讓路。

## 4. 時間解析度收斂（獨立的固定步長實作，同一個讓路決定）
速度 18.5／15.37 mm/s（不在格點上）、讓路者 W2、停頓 0.18 s：

| Δt (s) | W1 抵達誤差 (s) | W2 抵達誤差 (s) |
|---|---|---|
| 0.1 | -1.95e-1 | -5.99e-1 |
| 0.01 | 1.77e-3 | 2.19e-3 |
| 0.001 | 7.74e-4 | 1.19e-3 |
| 0.0001 | 5.39e-5 | 9.41e-5 |
| 0.00001 | 7.16e-7 | 4.07e-6 |

固定步長版本的誤差隨 Δt 縮小而收斂到事件驅動引擎（引擎沒有時間步，與手算解析解一致）。

## 5. 與科學觀察的比較與驗證限制
| 項目 | 本模型 | 文獻 | 可否驗證本種 |
|---|---|---|---|
| 誰讓路（入口） | 以 0.957 讓尚未進入者讓 | L. niger 202/211（R380） | 不可：非本種 |
| 帶食優先 | 選用規則，0.98 | Atta colombica 294/300（R381）；L. niger 沒有（R380） | 不可：兩種研究矛盾，本種未知 |
| 每次接觸損失的時間（模型算出，非輸入） | ENTRY：兩隻平均 0.411 s／次（停頓 0.18 s＋讓路） | L. humile 0.24（R108）、L. niger 0.43（R380）、Atta 0.80（R381）：都是回歸斜率，已含讓路 | 只能比較量級：非本種，且情境不同 |
| 接觸停頓 | 0.18 s（候選；0.43／0.80 只作上限，會重複計算） | L. humile 接觸持續 0.18 ± 0.14 s（R108） | 不可：本種未量測 |
| 兩隻都在窄段內 | 每次接觸各自回頭的機率 p | 沒有研究 | 不可 |
| 不超越 | 單行段不能超越（物理） | Atta：110 隻中只有 8 隻超越（R381） | 方向一致 |
| 自發迴轉 | 不模擬 | L. humile ≈1 %/次過橋（R108） | — |
| 群組（同向成群通過） | 會自然形成（讓路者等對方整群通過） | L. niger 窄橋平均 3.3 隻（R380） | 尚未量化比較 |

**結論**：本版的讓路規則只用螞蟻自己能感知的資訊，規則與比例都來自已核對的非本種研究，或明確標為遊戲假設。實驗證明這些機制在引擎中確實運作、可重播、可反駁；但**不能**宣稱它們重現了大頭家蟻的行為。

## 原始結果（JSON；測試比對用）
```json
{
 "sources": {
  "geometry": "scenarios/physics/narrow-corridor.geometry.json",
  "body": "scenarios/physics/pheidole-megacephala.body-candidates.json",
  "motion": "scenarios/physics/pheidole-megacephala.motion-candidates.json",
  "interaction": "scenarios/physics/pheidole-megacephala.interaction-candidates.json"
 },
 "entry": {
  "label": "ENTRY (L. niger rule, pause 0.18 s)",
  "width_mm": 0.8,
  "walls": true,
  "seed": 1,
  "contact_t_s": 4.078696343402226,
  "contact_certain": true,
  "obstruction_t_s": 4.108108108108108,
  "yielder": "W2",
  "rule": "entry yield",
  "contacts": 1,
  "hold_s": 0.18,
  "back_out_mm": 1.374501,
  "ants": {
   "W1": {
    "arrive_s": 5.38356930915264,
    "alone_s": 5.1891891891891895,
    "added_s": 0.1943801199634505,
    "path_mm": 96,
    "displacement_mm": 96,
    "waiting_s": 0.17999999999999972,
    "mean_moving_speed": 18.44887505027445,
    "trip_speed": 17.83203567878095
   },
   "W2": {
    "arrive_s": 9.800249492917434,
    "alone_s": 9.172624237140365,
    "added_s": 0.627625255777069,
    "path_mm": 98.74900159967967,
    "displacement_mm": 96,
    "waiting_s": 0.4502703138622497,
    "mean_moving_speed": 15.499999999999998,
    "trip_speed": 14.476834452505674
   }
  },
  "exclusion_violations": 0,
  "result_hash": "58751a558a0ec99e",
  "replay_identical": true,
  "order_identical": true
 },
 "control": {
  "label": "CONTROL (no walls)",
  "width_mm": 0.8,
  "walls": false,
  "seed": 1,
  "contact_t_s": 4.078696343402226,
  "contact_certain": false,
  "obstruction_t_s": null,
  "yielder": null,
  "rule": null,
  "contacts": 0,
  "hold_s": 0,
  "back_out_mm": null,
  "ants": {
   "W1": {
    "arrive_s": 5.1891891891891895,
    "alone_s": 5.1891891891891895,
    "added_s": 0,
    "path_mm": 96,
    "displacement_mm": 96,
    "waiting_s": 0,
    "mean_moving_speed": 18.5,
    "trip_speed": 18.5
   },
   "W2": {
    "arrive_s": 9.172624237140365,
    "alone_s": 9.172624237140365,
    "added_s": 0,
    "path_mm": 96,
    "displacement_mm": 96,
    "waiting_s": 0,
    "mean_moving_speed": 15.500000000000002,
    "trip_speed": 15.500000000000002
   }
  },
  "exclusion_violations": 0,
  "result_hash": "e661bac3aaf3620d",
  "replay_identical": true,
  "order_identical": true
 },
 "laden": {
  "label": "LADEN (Atta rule, W2 carries an item)",
  "width_mm": 0.8,
  "walls": true,
  "seed": 1,
  "contact_t_s": 4.078696343402226,
  "contact_certain": true,
  "obstruction_t_s": 4.108108108108108,
  "yielder": "W1",
  "rule": "laden priority",
  "contacts": 1,
  "hold_s": 0.18,
  "back_out_mm": 59.874501,
  "ants": {
   "W1": {
    "arrive_s": 12.79110042090516,
    "alone_s": 5.1891891891891895,
    "added_s": 7.60191123171597,
    "path_mm": 215.74900159967967,
    "displacement_mm": 96,
    "waiting_s": 1.1289922263278793,
    "mean_moving_speed": 18.5,
    "trip_speed": 16.86711811339311
   },
   "W2": {
    "arrive_s": 9.352624237140365,
    "alone_s": 9.172624237140365,
    "added_s": 0.17999999999999972,
    "path_mm": 96,
    "displacement_mm": 96,
    "waiting_s": 0.17999999999999972,
    "mean_moving_speed": 15.500000000000002,
    "trip_speed": 15.062253264500459
   }
  },
  "exclusion_violations": 0,
  "result_hash": "ffdddab707381529",
  "replay_identical": true,
  "order_identical": true
 },
 "entry_seeds": {
  "seeds": 400,
  "W2_gave_way": 387,
  "literature": 0.957346
 },
 "laden_seeds": {
  "seeds": 400,
  "unladen_gave_way": 388,
  "literature": 0.98
 },
 "inside": [
  {
   "p": 0.1,
   "tau_s": 0.18,
   "seeds": 100,
   "W1_gave_way": 61,
   "mean_contacts": 6.47,
   "mean_added_W1_s": 3.982853086798572,
   "mean_added_W2_s": 2.603528688462733,
   "max_added_s": 11.789560739648033,
   "violations": 0
  },
  {
   "p": 0.1,
   "tau_s": 0.43,
   "seeds": 100,
   "W1_gave_way": 61,
   "mean_contacts": 6.47,
   "mean_added_W1_s": 5.600353086798574,
   "mean_added_W2_s": 4.221028688462734,
   "max_added_s": 23.03956073964804,
   "violations": 0
  },
  {
   "p": 0.1,
   "tau_s": 0.8,
   "seeds": 100,
   "W1_gave_way": 61,
   "mean_contacts": 6.47,
   "mean_added_W1_s": 7.9942530867985715,
   "mean_added_W2_s": 6.614928688462735,
   "max_added_s": 39.68956073964804,
   "violations": 0
  },
  {
   "p": 0.5,
   "tau_s": 0.18,
   "seeds": 100,
   "W1_gave_way": 61,
   "mean_contacts": 2.17,
   "mean_added_W1_s": 3.208853086798571,
   "mean_added_W2_s": 1.8295286884627333,
   "max_added_s": 6.2428353816723785,
   "violations": 0
  },
  {
   "p": 0.5,
   "tau_s": 0.43,
   "seeds": 100,
   "W1_gave_way": 61,
   "mean_contacts": 2.17,
   "mean_added_W1_s": 3.7513530867985696,
   "mean_added_W2_s": 2.3720286884627333,
   "max_added_s": 8.742835381672379,
   "violations": 0
  },
  {
   "p": 0.5,
   "tau_s": 0.8,
   "seeds": 100,
   "W1_gave_way": 61,
   "mean_contacts": 2.17,
   "mean_added_W1_s": 4.55425308679857,
   "mean_added_W2_s": 3.1749286884627343,
   "max_added_s": 12.489560739648036,
   "violations": 0
  },
  {
   "p": 0.9,
   "tau_s": 0.18,
   "seeds": 100,
   "W1_gave_way": 60,
   "mean_contacts": 5.87,
   "mean_added_W1_s": 3.833197130519756,
   "mean_added_W2_s": 2.532424295859214,
   "max_added_s": 8.369560739648033,
   "violations": 0
  },
  {
   "p": 0.9,
   "tau_s": 0.43,
   "seeds": 100,
   "W1_gave_way": 60,
   "mean_contacts": 5.87,
   "mean_added_W1_s": 5.300697130519756,
   "mean_added_W2_s": 3.999924295859214,
   "max_added_s": 14.869560739648032,
   "violations": 0
  },
  {
   "p": 0.9,
   "tau_s": 0.8,
   "seeds": 100,
   "W1_gave_way": 60,
   "mean_contacts": 5.87,
   "mean_added_W1_s": 7.472597130519762,
   "mean_added_W2_s": 6.171824295859214,
   "max_added_s": 24.489560739648034,
   "violations": 0
  }
 ],
 "width_sensitivity": [
  {
   "label": "width 0.5 mm",
   "width_mm": 0.5,
   "walls": true,
   "seed": 1,
   "contact_t_s": 4.078696343402226,
   "contact_certain": true,
   "obstruction_t_s": null,
   "yielder": null,
   "rule": null,
   "contacts": 0,
   "hold_s": 0,
   "back_out_mm": null,
   "ants": {
    "W1": {
     "arrive_s": 5.1891891891891895,
     "alone_s": 5.1891891891891895,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "waiting_s": 0,
     "mean_moving_speed": 18.5,
     "trip_speed": 18.5
    },
    "W2": {
     "arrive_s": 9.172624237140365,
     "alone_s": 9.172624237140365,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "waiting_s": 0,
     "mean_moving_speed": 15.500000000000002,
     "trip_speed": 15.500000000000002
    }
   },
   "exclusion_violations": 0,
   "result_hash": "1cefa0bd950c8265",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "width 0.65 mm",
   "width_mm": 0.65,
   "walls": true,
   "seed": 1,
   "contact_t_s": 4.078696343402226,
   "contact_certain": true,
   "obstruction_t_s": 4.108108108108108,
   "yielder": "W2",
   "rule": "entry yield",
   "contacts": 1,
   "hold_s": 0.18,
   "back_out_mm": 1.165332,
   "ants": {
    "W1": {
     "arrive_s": 5.381380971506321,
     "alone_s": 5.1891891891891895,
     "added_s": 0.1921917823171313,
     "path_mm": 96,
     "displacement_mm": 96,
     "waiting_s": 0.17999999999999972,
     "mean_moving_speed": 18.456636905832795,
     "trip_speed": 17.839287073022135
    },
    "W2": {
     "arrive_s": 9.773259995279506,
     "alone_s": 9.172624237140365,
     "added_s": 0.6006357581391413,
     "path_mm": 98.3306643862918,
     "displacement_mm": 96,
     "waiting_s": 0.4502703138622497,
     "mean_moving_speed": 15.5,
     "trip_speed": 14.47276998743717
    }
   },
   "exclusion_violations": 0,
   "result_hash": "8c323c3ff3a3b3e4",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "width 0.8 mm",
   "width_mm": 0.8,
   "walls": true,
   "seed": 1,
   "contact_t_s": 4.078696343402226,
   "contact_certain": true,
   "obstruction_t_s": 4.108108108108108,
   "yielder": "W2",
   "rule": "entry yield",
   "contacts": 1,
   "hold_s": 0.18,
   "back_out_mm": 1.374501,
   "ants": {
    "W1": {
     "arrive_s": 5.38356930915264,
     "alone_s": 5.1891891891891895,
     "added_s": 0.1943801199634505,
     "path_mm": 96,
     "displacement_mm": 96,
     "waiting_s": 0.17999999999999972,
     "mean_moving_speed": 18.44887505027445,
     "trip_speed": 17.83203567878095
    },
    "W2": {
     "arrive_s": 9.800249492917434,
     "alone_s": 9.172624237140365,
     "added_s": 0.627625255777069,
     "path_mm": 98.74900159967967,
     "displacement_mm": 96,
     "waiting_s": 0.4502703138622497,
     "mean_moving_speed": 15.499999999999998,
     "trip_speed": 14.476834452505674
    }
   },
   "exclusion_violations": 0,
   "result_hash": "58751a558a0ec99e",
   "replay_identical": true,
   "order_identical": true
  }
 ],
 "analytic": {
  "entry": {
   "W1": 5.38356930915264,
   "W2": 9.800249492917434
  },
  "engine_minus_analytic_s": [
   0,
   0
  ],
  "inside_checked": 45,
  "inside_max_abs_diff_s": 1.7763568394002505e-15
 },
 "convergence": {
  "speeds_mm_s": [
   18.5,
   15.37
  ],
  "yielder": "W2",
  "hold_s": 0.18,
  "rows": [
   {
    "dt_s": 0.1,
    "W1_err_s": -0.19513015658266664,
    "W2_err_s": -0.5986517850993707
   },
   {
    "dt_s": 0.01,
    "W1_err_s": 0.0017738707395134057,
    "W2_err_s": 0.002194070452832264
   },
   {
    "dt_s": 0.001,
    "W1_err_s": 0.0007738707395228417,
    "W2_err_s": 0.0011940704529749269
   },
   {
    "dt_s": 0.0001,
    "W1_err_s": 0.00005387479136054196,
    "W2_err_s": 0.00009407044592713021
   },
   {
    "dt_s": 0.00001,
    "W1_err_s": 7.159858332883573e-7,
    "W2_err_s": 0.0000040702907320167014
   }
  ]
 }
}
```

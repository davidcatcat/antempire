# 雙工蟻窄道實驗（Work C）— 實驗世界，非正式

> 由 `prototypes/physics/two-ant-corridor.ts` 產生；`tests/physics-two-ant.test.ts` 會重跑並比對本檔末的 JSON。合成場景，不是臺中西屯花園，不產生任何存檔、日誌或遊戲日。所有回應規則是**候選規則**（見 `scenarios/physics/pheidole-megacephala.interaction-candidates.json`），不是本種實測行為。

## 設定
- 場景：`scenarios/physics/narrow-corridor.geometry.json`。通路長 100 mm、寬 20 mm；x=20～80 mm 兩側有牆，可用寬度 1.0 mm。牆角之外的可用寬度是 2·√(dx²+0.5²)，所以兩隻 0.8 mm 寬的工蟻要到 x = 80 + √(0.8²−0.5²) = 80.6245 mm 之外才能並排；單行段因此是 [19.3755, 80.6245] mm，比牆稍長。
- W1：從 s=2 mm（巢端）往外走，速度是 Vázquez 2020 的離巢速度 18.5 mm/s。W2：從 s=98 mm 回巢，速度是回巢速度 15.5 mm/s。兩隻同時出發。
- 身體：體長 2.5 mm（Yuan 2026，文獻支持）。碰撞寬度與觸角可及距離是候選範圍（遊戲假設），主實驗取寬度上限 0.8 mm、可及距離 1.0 mm，另做敏感度。
- 回應規則的假設（遊戲假設）：
  - 讓路的那隻以**自己的自由速度**退後，轉身時間為 0；這兩點決定了大部分延遲。
  - 「回頭路較短的那隻退」是兩隻成對的物理解法，不是任何一隻螞蟻能知道的資訊（CLAUDE.md §2.1）。
- 對照組：同一通路拿掉兩側的牆。

## 主實驗與對照
| 情境 | 接觸 | 阻擋（s） | 讓路者 | 退後（mm） | W1 抵達 s（比單獨多） | W2 抵達 s（比單獨多） | 互斥違反 | 重播／換順序相同 |
|---|---|---|---|---|---|---|---|---|
| main: walls, width high candidate | 2.721 s @ 54.08 mm (確定) | 2.750 | W2 | 26.50 | 5.466 (+0.277) | 9.883 (+3.690) | 0 | 是 |
| control: no walls | 2.721 s @ 54.08 mm (可能) | 無 | — | — | 5.189 (+0.000) | 6.194 (+0.000) | 0 | 是 |

| 情境 | 個體 | 路線長 mm | 位移 mm | 移動 s | 等待 s | 移動中速度 mm/s | 整趟速度 mm/s |
|---|---|---|---|---|---|---|---|
| main: walls, width high candidate | W1 | 96.00 | 96.00 | 5.466 | 0.000 | 17.56 | 17.56 |
| main: walls, width high candidate | W2 | 149.00 | 96.00 | 9.613 | 0.270 | 15.50 | 15.08 |
| control: no walls | W1 | 96.00 | 96.00 | 5.189 | 0.000 | 18.50 | 18.50 |
| control: no walls | W2 | 96.00 | 96.00 | 6.194 | 0.000 | 15.50 | 15.50 |

解讀（只限本模型）：
- 有牆時，兩隻在單行段迎面相碰。回頭路較短的 W2 退出窄段，在寬處等待；W1 跟在退後的 W2 後面，速度被限制為 W2 的速度，直到 W2 退出窄段。兩隻都比單獨行走晚到，讓路者晚得多。
- W2 的移動中速度不變（15.5 mm/s），整趟速度下降，因為它多走了退後與回來的路，還等了一下。
- W1 沒有停下，但有一段被限制在 W2 的速度，所以移動中平均速度降到 17.56 mm/s。
- 延遲都來自實際的讓路與跟隨，不是固定減速比例。
- **解析解核對**：照規則手算的抵達時間 W1 5.466428953 s、W2 9.883109137 s，引擎差 0.0e+0、0.0e+0 s。
- 沒有牆時只有一次「可能」的接觸，抵達時間與單獨行走相同。這只代表**本版的接觸不觸發任何行為**（C3–C5 尚未接上），不是生物學主張。
- 路線長 > 位移：讓路者多走了退後與回來的距離。

## 敏感度（碰撞寬度 × 觸角可及距離，均為遊戲假設的候選）
| 情境 | 接觸 | 阻擋（s） | 讓路者 | 退後（mm） | W1 抵達 s（比單獨多） | W2 抵達 s（比單獨多） | 互斥違反 | 重播／換順序相同 |
|---|---|---|---|---|---|---|---|---|
| w=0.5 r=0.5 | 2.735 s @ 54.10 mm (確定) | 無 | — | — | 5.189 (+0.000) | 6.194 (+0.000) | 0 | 是 |
| w=0.5 r=1 | 2.721 s @ 54.08 mm (確定) | 無 | — | — | 5.189 (+0.000) | 6.194 (+0.000) | 0 | 是 |
| w=0.5 r=1.5 | 2.706 s @ 54.06 mm (確定) | 無 | — | — | 5.189 (+0.000) | 6.194 (+0.000) | 0 | 是 |
| w=0.65 r=0.5 | 2.735 s @ 54.10 mm (確定) | 2.750 | W2 | 26.29 | 5.464 (+0.275) | 9.856 (+3.663) | 0 | 是 |
| w=0.65 r=1 | 2.721 s @ 54.08 mm (確定) | 2.750 | W2 | 26.29 | 5.464 (+0.275) | 9.856 (+3.663) | 0 | 是 |
| w=0.65 r=1.5 | 2.706 s @ 54.06 mm (確定) | 2.750 | W2 | 26.29 | 5.464 (+0.275) | 9.856 (+3.663) | 0 | 是 |
| w=0.8 r=0.5 | 2.735 s @ 54.10 mm (確定) | 2.750 | W2 | 26.50 | 5.466 (+0.277) | 9.883 (+3.690) | 0 | 是 |
| w=0.8 r=1 | 2.721 s @ 54.08 mm (確定) | 2.750 | W2 | 26.50 | 5.466 (+0.277) | 9.883 (+3.690) | 0 | 是 |
| w=0.8 r=1.5 | 2.706 s @ 54.06 mm (確定) | 2.750 | W2 | 26.50 | 5.466 (+0.277) | 9.883 (+3.690) | 0 | 是 |

- 寬度 0.5 mm 正好在臨界點上：2×0.5 = 1.0 不小於可用寬度 1.0，所以兩隻以零間隙並排通過。只要寬度大於 0.5 mm 就一定要讓路（本表的 0.65 與 0.8 都是）。**結果取決於本種沒有量測的碰撞寬度。**
- 觸角可及距離只改變接觸發生的時刻，不改變阻擋與抵達。

## 平手（兩隻同速 17.0 mm/s、位置對稱，40 個種子）
讓路者次數：W2 20、W1 20。平手由命名亂數流 `physics.yield` 決定，與輸入順序無關。

## 時間解析度收斂（獨立的固定步長參考實作，同一套規則）
主實驗的速度（18.5／15.5 mm/s）：
| Δt (s) | W1 抵達誤差 (s) | W2 抵達誤差 (s) | 讓路者 |
|---|---|---|---|
| 0.1 | -1.56e-3 | 7.01e-2 | W2 |
| 0.01 | 5.75e-5 | 8.45e-5 | W2 |
| 0.001 | 5.75e-5 | 8.45e-5 | W2 |
| 0.0001 | -7.33e-6 | 8.45e-5 | W2 |
| 0.00001 | 7.76e-7 | 4.46e-6 | W2 |

不在格點上的速度（18.5／15.37 mm/s）：
| Δt (s) | W1 抵達誤差 (s) | W2 抵達誤差 (s) | 讓路者 |
|---|---|---|---|
| 0.1 | -1.93e-3 | 5.78e-2 | W2 |
| 0.01 | -2.37e-4 | 7.77e-3 | W2 |
| 0.001 | -6.78e-5 | 7.74e-4 | W2 |
| 0.0001 | -1.55e-7 | 7.37e-5 | W2 |
| 0.00001 | -1.56e-7 | 3.69e-6 | W2 |

- 固定步長參考實作把「退到定點」與「恢復前進」都延到下一個格點，沒有內插。
  - 主實驗的距離與速度都是十進位整齊的數字，所以每一級 Δt 的殘差剛好相同：W2 停在 Δt = 0.01～0.0001 的平台。這是參考實作的離散化造成的，不是格點對齊的問題，也不是引擎的誤差。
  - 換成不在格點上的速度，誤差就隨 Δt 一階下降（約每級 1/10）。
- 事件驅動引擎本身沒有時間步，與手算解析解一致（差 0）。

## 與科學觀察的比較（Owner 指定項目）與驗證限制
| 項目 | 本模型 | 本種資料 | 可否驗證 |
|---|---|---|---|
| 步行速度 | 18.5／15.5／17 mm/s | Vázquez 2020：實驗室人工路線（R133） | 只能對照輸入值；野外速度未知 |
| 速度分布 | 個體差異 CV = null（不加入） | 只有平均與 95% CI，沒有個體分布 | 不可 |
| 接觸頻率 | 本實驗 1 次／相遇 | 沒有本種窄道接觸頻率資料 | 不可 |
| 通過時間 | 見主實驗 | 沒有 | 不可 |
| 交通（雙向） | 多隻雙向單行交通常卡住（見 #73 壓力測試） | 沒有 | 不可；顯示本版缺少整列退讓 |
| 搬運成功 | 3 mm 獵物無法通過 1.6 mm 巢口 | 本種有搬運與合作搬運的文獻（Dejean 2007 等），但沒有巢口尺寸對照 | 只驗證幾何邏輯 |
| 障礙效果 | 有牆：讓路與延遲；沒牆：無延遲 | 沒有 | 不可 |

**結論**：這是可重播、可反駁的工程實驗。它證明空間、速度與碰撞機制真的在運作，而且會改變抵達時間與先後；但它**不是**對本種行為的驗證。窄道相遇時誰讓路、等多久，都需要本種觀察資料。

## 原始結果（JSON；測試比對用）
```json
{
 "sources": {
  "geometry": "scenarios/physics/narrow-corridor.geometry.json",
  "body": "scenarios/physics/pheidole-megacephala.body-candidates.json",
  "motion": "scenarios/physics/pheidole-megacephala.motion-candidates.json",
  "interaction": "scenarios/physics/pheidole-megacephala.interaction-candidates.json"
 },
 "main": {
  "label": "main: walls, width high candidate",
  "width_mm": 0.8,
  "reach_mm": 1,
  "walls": true,
  "contact": {
   "t_s": 2.7205882352941178,
   "s_mm": 54.080882352941174,
   "certain": true
  },
  "obstruction_t_s": 2.75,
  "yielder": "W2",
  "back_out_mm": 26.499501,
  "ants": {
   "W1": {
    "arrive_s": 5.46642895344209,
    "alone_s": 5.1891891891891895,
    "added_s": 0.27723976425290076,
    "path_mm": 96,
    "displacement_mm": 96,
    "moving_s": 5.46642895344209,
    "waiting_s": 0,
    "mean_moving_speed": 17.561739266646995,
    "trip_speed": 17.561739266646995
   },
   "W2": {
    "arrive_s": 9.883109137206883,
    "alone_s": 6.193548387096774,
    "added_s": 3.6895607501101093,
    "path_mm": 148.99900159967967,
    "displacement_mm": 96,
    "moving_s": 9.612838812882558,
    "waiting_s": 0.27027032432432474,
    "mean_moving_speed": 15.500000000000004,
    "trip_speed": 15.076126301058844
   }
  },
  "exclusion_violations": 0,
  "result_hash": "afd78b9d4f24a2fe",
  "replay_identical": true,
  "order_identical": true
 },
 "control": {
  "label": "control: no walls",
  "width_mm": 0.8,
  "reach_mm": 1,
  "walls": false,
  "contact": {
   "t_s": 2.7205882352941178,
   "s_mm": 54.080882352941174,
   "certain": false
  },
  "obstruction_t_s": null,
  "yielder": null,
  "back_out_mm": null,
  "ants": {
   "W1": {
    "arrive_s": 5.1891891891891895,
    "alone_s": 5.1891891891891895,
    "added_s": 0,
    "path_mm": 96,
    "displacement_mm": 96,
    "moving_s": 5.1891891891891895,
    "waiting_s": 0,
    "mean_moving_speed": 18.5,
    "trip_speed": 18.5
   },
   "W2": {
    "arrive_s": 6.193548387096774,
    "alone_s": 6.193548387096774,
    "added_s": 0,
    "path_mm": 96,
    "displacement_mm": 96,
    "moving_s": 6.193548387096774,
    "waiting_s": 0,
    "mean_moving_speed": 15.5,
    "trip_speed": 15.5
   }
  },
  "exclusion_violations": 0,
  "result_hash": "d5673d7d3008cec7",
  "replay_identical": true,
  "order_identical": true
 },
 "analytic": {
  "W1": 5.46642895344209,
  "W2": 9.883109137206883,
  "touch_s": 2.75,
  "section_end_mm": 80.62449979983984,
  "engine_minus_analytic_s": [
   0,
   0
  ]
 },
 "convergence_offgrid": {
  "speeds_mm_s": [
   18.5,
   15.37
  ],
  "rows": [
   {
    "dt_s": 0.1,
    "W1_err_s": -0.0019289122467638364,
    "W2_err_s": 0.05777369316728098,
    "yielder": "W2"
   },
   {
    "dt_s": 0.01,
    "W1_err_s": -0.00023702035496597773,
    "W2_err_s": 0.00777369316711507,
    "yielder": "W2"
   },
   {
    "dt_s": 0.001,
    "W1_err_s": -0.00006783116596675853,
    "W2_err_s": 0.0007736931672077674,
    "yielder": "W2"
   },
   {
    "dt_s": 0.0001,
    "W1_err_s": -1.554897650635212e-7,
    "W2_err_s": 0.00007369315999206094,
    "yielder": "W2"
   },
   {
    "dt_s": 0.00001,
    "W1_err_s": -1.555285562560016e-7,
    "W2_err_s": 0.0000036930014424285673,
    "yielder": "W2"
   }
  ]
 },
 "sensitivity": [
  {
   "label": "w=0.5 r=0.5",
   "width_mm": 0.5,
   "reach_mm": 0.5,
   "walls": true,
   "contact": {
    "t_s": 2.735294117647059,
    "s_mm": 54.10294117647059,
    "certain": true
   },
   "obstruction_t_s": null,
   "yielder": null,
   "back_out_mm": null,
   "ants": {
    "W1": {
     "arrive_s": 5.1891891891891895,
     "alone_s": 5.1891891891891895,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.1891891891891895,
     "waiting_s": 0,
     "mean_moving_speed": 18.5,
     "trip_speed": 18.5
    },
    "W2": {
     "arrive_s": 6.193548387096774,
     "alone_s": 6.193548387096774,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 6.193548387096774,
     "waiting_s": 0,
     "mean_moving_speed": 15.5,
     "trip_speed": 15.5
    }
   },
   "exclusion_violations": 0,
   "result_hash": "7805e7e3aed5b2fb",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.5 r=1",
   "width_mm": 0.5,
   "reach_mm": 1,
   "walls": true,
   "contact": {
    "t_s": 2.7205882352941178,
    "s_mm": 54.080882352941174,
    "certain": true
   },
   "obstruction_t_s": null,
   "yielder": null,
   "back_out_mm": null,
   "ants": {
    "W1": {
     "arrive_s": 5.1891891891891895,
     "alone_s": 5.1891891891891895,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.1891891891891895,
     "waiting_s": 0,
     "mean_moving_speed": 18.5,
     "trip_speed": 18.5
    },
    "W2": {
     "arrive_s": 6.193548387096774,
     "alone_s": 6.193548387096774,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 6.193548387096774,
     "waiting_s": 0,
     "mean_moving_speed": 15.5,
     "trip_speed": 15.5
    }
   },
   "exclusion_violations": 0,
   "result_hash": "cdc02fe2529ae4d8",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.5 r=1.5",
   "width_mm": 0.5,
   "reach_mm": 1.5,
   "walls": true,
   "contact": {
    "t_s": 2.7058823529411766,
    "s_mm": 54.05882352941177,
    "certain": true
   },
   "obstruction_t_s": null,
   "yielder": null,
   "back_out_mm": null,
   "ants": {
    "W1": {
     "arrive_s": 5.1891891891891895,
     "alone_s": 5.1891891891891895,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.1891891891891895,
     "waiting_s": 0,
     "mean_moving_speed": 18.5,
     "trip_speed": 18.5
    },
    "W2": {
     "arrive_s": 6.193548387096774,
     "alone_s": 6.193548387096774,
     "added_s": 0,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 6.193548387096774,
     "waiting_s": 0,
     "mean_moving_speed": 15.5,
     "trip_speed": 15.5
    }
   },
   "exclusion_violations": 0,
   "result_hash": "6ec28076241eace9",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.65 r=0.5",
   "width_mm": 0.65,
   "reach_mm": 0.5,
   "walls": true,
   "contact": {
    "t_s": 2.735294117647059,
    "s_mm": 54.10294117647059,
    "certain": true
   },
   "obstruction_t_s": 2.75,
   "yielder": "W2",
   "back_out_mm": 26.290332,
   "ants": {
    "W1": {
     "arrive_s": 5.464240615795772,
     "alone_s": 5.1891891891891895,
     "added_s": 0.27505142660658244,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.464240615795772,
     "waiting_s": 0,
     "mean_moving_speed": 17.5687724516537,
     "trip_speed": 17.5687724516537
    },
    "W2": {
     "arrive_s": 9.856119639568956,
     "alone_s": 6.193548387096774,
     "added_s": 3.6625712524721816,
     "path_mm": 148.5806643862918,
     "displacement_mm": 96,
     "moving_s": 9.58584931524463,
     "waiting_s": 0.27027032432432474,
     "mean_moving_speed": 15.500000000000004,
     "trip_speed": 15.074965586841211
    }
   },
   "exclusion_violations": 0,
   "result_hash": "9d63f7007420e7e5",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.65 r=1",
   "width_mm": 0.65,
   "reach_mm": 1,
   "walls": true,
   "contact": {
    "t_s": 2.7205882352941178,
    "s_mm": 54.080882352941174,
    "certain": true
   },
   "obstruction_t_s": 2.75,
   "yielder": "W2",
   "back_out_mm": 26.290332,
   "ants": {
    "W1": {
     "arrive_s": 5.464240615795772,
     "alone_s": 5.1891891891891895,
     "added_s": 0.27505142660658244,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.464240615795772,
     "waiting_s": 0,
     "mean_moving_speed": 17.5687724516537,
     "trip_speed": 17.5687724516537
    },
    "W2": {
     "arrive_s": 9.856119639568956,
     "alone_s": 6.193548387096774,
     "added_s": 3.6625712524721816,
     "path_mm": 148.5806643862918,
     "displacement_mm": 96,
     "moving_s": 9.58584931524463,
     "waiting_s": 0.27027032432432474,
     "mean_moving_speed": 15.500000000000004,
     "trip_speed": 15.074965586841211
    }
   },
   "exclusion_violations": 0,
   "result_hash": "35ec2208425c61ac",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.65 r=1.5",
   "width_mm": 0.65,
   "reach_mm": 1.5,
   "walls": true,
   "contact": {
    "t_s": 2.7058823529411766,
    "s_mm": 54.05882352941177,
    "certain": true
   },
   "obstruction_t_s": 2.75,
   "yielder": "W2",
   "back_out_mm": 26.290332,
   "ants": {
    "W1": {
     "arrive_s": 5.464240615795772,
     "alone_s": 5.1891891891891895,
     "added_s": 0.27505142660658244,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.464240615795772,
     "waiting_s": 0,
     "mean_moving_speed": 17.5687724516537,
     "trip_speed": 17.5687724516537
    },
    "W2": {
     "arrive_s": 9.856119639568956,
     "alone_s": 6.193548387096774,
     "added_s": 3.6625712524721816,
     "path_mm": 148.5806643862918,
     "displacement_mm": 96,
     "moving_s": 9.58584931524463,
     "waiting_s": 0.27027032432432474,
     "mean_moving_speed": 15.500000000000004,
     "trip_speed": 15.074965586841211
    }
   },
   "exclusion_violations": 0,
   "result_hash": "c8a637607aa6e70c",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.8 r=0.5",
   "width_mm": 0.8,
   "reach_mm": 0.5,
   "walls": true,
   "contact": {
    "t_s": 2.735294117647059,
    "s_mm": 54.10294117647059,
    "certain": true
   },
   "obstruction_t_s": 2.75,
   "yielder": "W2",
   "back_out_mm": 26.499501,
   "ants": {
    "W1": {
     "arrive_s": 5.46642895344209,
     "alone_s": 5.1891891891891895,
     "added_s": 0.27723976425290076,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.46642895344209,
     "waiting_s": 0,
     "mean_moving_speed": 17.561739266646995,
     "trip_speed": 17.561739266646995
    },
    "W2": {
     "arrive_s": 9.883109137206883,
     "alone_s": 6.193548387096774,
     "added_s": 3.6895607501101093,
     "path_mm": 148.99900159967967,
     "displacement_mm": 96,
     "moving_s": 9.612838812882558,
     "waiting_s": 0.27027032432432474,
     "mean_moving_speed": 15.500000000000004,
     "trip_speed": 15.076126301058844
    }
   },
   "exclusion_violations": 0,
   "result_hash": "c6339768795f2824",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.8 r=1",
   "width_mm": 0.8,
   "reach_mm": 1,
   "walls": true,
   "contact": {
    "t_s": 2.7205882352941178,
    "s_mm": 54.080882352941174,
    "certain": true
   },
   "obstruction_t_s": 2.75,
   "yielder": "W2",
   "back_out_mm": 26.499501,
   "ants": {
    "W1": {
     "arrive_s": 5.46642895344209,
     "alone_s": 5.1891891891891895,
     "added_s": 0.27723976425290076,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.46642895344209,
     "waiting_s": 0,
     "mean_moving_speed": 17.561739266646995,
     "trip_speed": 17.561739266646995
    },
    "W2": {
     "arrive_s": 9.883109137206883,
     "alone_s": 6.193548387096774,
     "added_s": 3.6895607501101093,
     "path_mm": 148.99900159967967,
     "displacement_mm": 96,
     "moving_s": 9.612838812882558,
     "waiting_s": 0.27027032432432474,
     "mean_moving_speed": 15.500000000000004,
     "trip_speed": 15.076126301058844
    }
   },
   "exclusion_violations": 0,
   "result_hash": "afd78b9d4f24a2fe",
   "replay_identical": true,
   "order_identical": true
  },
  {
   "label": "w=0.8 r=1.5",
   "width_mm": 0.8,
   "reach_mm": 1.5,
   "walls": true,
   "contact": {
    "t_s": 2.7058823529411766,
    "s_mm": 54.05882352941177,
    "certain": true
   },
   "obstruction_t_s": 2.75,
   "yielder": "W2",
   "back_out_mm": 26.499501,
   "ants": {
    "W1": {
     "arrive_s": 5.466428953442089,
     "alone_s": 5.1891891891891895,
     "added_s": 0.27723976425289987,
     "path_mm": 96,
     "displacement_mm": 96,
     "moving_s": 5.466428953442089,
     "waiting_s": 0,
     "mean_moving_speed": 17.561739266647,
     "trip_speed": 17.561739266647
    },
    "W2": {
     "arrive_s": 9.883109137206883,
     "alone_s": 6.193548387096774,
     "added_s": 3.6895607501101093,
     "path_mm": 148.99900159967967,
     "displacement_mm": 96,
     "moving_s": 9.612838812882558,
     "waiting_s": 0.27027032432432474,
     "mean_moving_speed": 15.500000000000004,
     "trip_speed": 15.076126301058844
    }
   },
   "exclusion_violations": 0,
   "result_hash": "a8cf446b2e6efea5",
   "replay_identical": true,
   "order_identical": true
  }
 ],
 "tie": {
  "seeds": 40,
  "yielder_counts": {
   "W2": 20,
   "W1": 20
  },
  "same_speed_mm_s": 17
 },
 "convergence": [
  {
   "dt_s": 0.1,
   "W1_err_s": -0.001564088577224787,
   "W2_err_s": 0.07008446278276992,
   "yielder": "W2"
  },
  {
   "dt_s": 0.01,
   "W1_err_s": 0.000057533044293123226,
   "W2_err_s": 0.00008446278258844586,
   "yielder": "W2"
  },
  {
   "dt_s": 0.001,
   "W1_err_s": 0.00005753304395916814,
   "W2_err_s": 0.00008446278218698922,
   "yielder": "W2"
  },
  {
   "dt_s": 0.0001,
   "W1_err_s": -0.0000073318189084403684,
   "W2_err_s": 0.00008446277370310895,
   "yielder": "W2"
  },
  {
   "dt_s": 0.00001,
   "W1_err_s": 7.762024800683776e-7,
   "W2_err_s": 0.00000446254100161525,
   "yielder": "W2"
  }
 ]
}
```

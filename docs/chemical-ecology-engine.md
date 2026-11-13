# 化學生態引擎（CHEM）：ODD 描述、跨引擎契約與不變量

> **地位**：CHEM-0（#131）的設計與契約。**隔離**：正式每日模擬（`engine/day.ts` 等頂層 `engine/*.ts`）、`cli/`、`web/src` 都不匯入 `engine/chemistry/`（`tests/chemistry-isolation.test.ts`）；不在規則指紋內；不改任何物種參數、存檔或日誌；不推進遊戲日；不啟動正式 Day0。
> **上游規格**：[`research-pheromone-models-2026-11.md`](research-pheromone-models-2026-11.md)（M1／M2、D1／D2a、X、C、O1～O6、P-1～P-6）。本文件**不另造**一套候選模型，只規定化學層的資料結構、時間空間契約與測試。
> **程式**：`engine/chemistry/contract.ts`（公開型別與純函式驗證器）；CHEM-1 的核心 `engine/chemistry/core.ts` 見 §14。**測試**：`tests/chem0-contract.test.ts`、`tests/chemistry-isolation.test.ts`（阻擋性）。
> **證據分級**（沿用上游）：A＝本種直接觀察；B＝他種或一般昆蟲；C＝競爭的數學模型；D＝未驗證假設。**機制與數值分開標示**。

## 1. 目的（ODD：Purpose）
提供一個**可重播、事件驅動、只有局部讀取**的化學訊號層，讓之後的實驗（CHEM-2～CHEM-4）能在相同觀察算子下比較 M1／M2 與 λ＝0 基準，以及分開處理短距警戒與 CHC 接觸辨識。它不是「另一個螞蟻大腦」：化學層只保存訊號、計算衰退、回答局部取樣，**不做任何行為決策**。

## 2. 實體、狀態變數與尺度（ODD：Entities, state variables, scales）
| 實體 | 狀態 | 單位 |
|---|---|---|
| 訊號頻道 `ChannelSpec` | 見 §3 綱要 | — |
| 沉積事件 `DepositEvent` | 誰、何時、何處、多少、為何（§3.2） | mm、s、頻道量單位 |
| 欄位格（edge bin 或 2D 格） | 量 A 與參考時刻 t_ref；`C(t)=A·exp(−λ(t−t_ref))` | 頻道量單位 |
| 時間地平線 horizon | 已關閉的 `(t_s, round)`：之前的沉積都已收齊 | s |
| 收支帳 | 已沉積、目前存量、已衰退、拒收（重複、出界、遲到） | 頻道量單位 |

- **空間**：mm。`surface_edge`：每條邊沿長度切成 `bin_mm` 的格；`sparse_2d`：平面上 `cell_mm` 的稀疏格，只存有過沉積的格。
- **時間**：化學時鐘上的秒 `t_s`，加上整數 `round`（同一精確時刻內的因果輪次）。對應分層時間契約見 §6。
- **層**：每個沉積與取樣都屬於一個 `layer`（例如 `surface`、`underground`）；不同層之間**沒有**任何讀取。

## 3. 訊號頻道綱要
### 3.1 頻道（`ChannelSpec`）
| 欄位 | 規則 |
|---|---|
| `signal_id` | 唯一 |
| `mechanism` | `trail_recruitment`／`short_range_alarm`／`chc_recognition`，三者**分開**，見 §4 |
| `model_variant`、`variant_role` | `M1`；`M2` 時 `variant_role` 為 `E`（探索）或 `F`（取食）；警戒、CHC 為候選；`synthetic` 只用於測試 |
| `chemical_identity` | **`null`**。只有本種有化學鑑定（A 級、附來源）時才可填；本種目前**沒有**（Dussutour 2009 作者自述未鑑定化學物質） |
| `units` | `{quantity, length:'mm', time:'s'}`；`quantity` 為 `normalized_activity`（無因次）或真實量 `mass_ng`／`molecules`；真實量**必須**有化學身分 |
| `backend` | `surface_edge`／`sparse_2d`（路徑）、`point_exposure`（警戒）、`contact`（CHC，沒有欄位） |
| `spatial_support` | 與 `backend` 同型；`sparse_2d` 必須寫明 `isotropic_diffusion: false`（不預設地表服從各向同性擴散） |
| `perception_rule` | `on_support`（只讀站立的邊）、`bounded_radius`（2D 圓盤）、`antennal_contact`（只在 PH-3b 接觸時）；`max_radius_mm` 必須有限（CHC 為 `null`）；`same_layer_only: true`；`threshold` 附來源 |
| `time_rule` | CHEM-1：`analytic_exponential`，`lambda_per_s` 附來源，**λ＝0 為必備基準**；CHC 為 `none`；同時刻規則固定為 `visible_if_round_not_later` |
| `evidence_level`、`assumption`、`sources`、`note` | 頻道整體的機制等級；數值的等級另在各 `ParamProvenance` |

每個數值是 `ParamProvenance {value, assumption, basis, evidence_level, sources, note}`；未知為 `null`。`assumption: false` 只允許「A 級＋有來源＋文獻支持」；模型擬合值（C）永遠是假設。

### 3.2 沉積事件（`DepositEvent`）
`deposit_id`、`signal_id`、`origin_agent`（沉積者）、`source_worker_id`（真實工蟻時＝`origin_agent`，合成個體為 `null`）、`origin_event_id`（上游 PH-3b 路段事件或活動事件）、`time {clock, unit:'s', t_s, round}`、`layer`、`substrate`（未知為 `null`）、`where`（`edge_point`／`edge_segment`／`point2d`／`segment2d`，座標 mm）、`amount`（>0）、`cause`（標籤，例如 `laden_return`；不得是蟻群層級的量）、`units`。

**名稱對照**：#131 的 `source_event_id` ＝ 本契約的 `origin_event_id`；`source_worker_id` 同名；`x_mm, y_mm` 在 `where` 中；`t_s`／`minute` 見 §6。

### 3.3 局部取樣（`SampleQuery`）
`{signal_id, agent_id, layer, time, phase, sensor}`（`time`＝個體的**感測時刻**；只能讀**最新已提交狀態**，結果另記 `state_commit`，§14.7）；`sensor` 為 `{kind:'edge', edge_id, s_mm, radius_mm}` 或 `{kind:'disc', x_mm, y_mm, radius_mm}`。**沒有**不帶位置的查詢形式；`radius_mm` 必須有限且不超過頻道上限。觀察器可另取全圖快照（標示 `observer_only`），它**永遠不得**成為個體的輸入（CLAUDE.md §2.4）。

## 4. 三種機制分開（不可互相替代）
| 機制 | 後端 | 感知 | 本種證據 | 不可宣稱 |
|---|---|---|---|---|
| 路徑招募 | `surface_edge`（優先，事件來源於實際走過的路段）、`sparse_2d`（需要連續幾何時） | 站立處沿邊、或有界圓盤；同層 | 行為 A（Dussutour 2009、Dejean 2007）；訊號數目、化學、衰退率：模型相依推論或未知 | 雙費洛蒙已被證實；半衰期 10.06／17.46 分是化學量測；野外持久度 |
| 短距警戒 | `point_exposure`：由實際威脅／獵物、個體位置產生的**局部暴露事件** | 有界半徑；同層 | 行為 A（Dejean 2007：發現者旁 ≥10 cm 的短距招募，第二隻多半先觸角碰觸第一隻的腹部末端）；分子、釋放量、擴散：**未鑑定** | 「看見大獵物就全巢警報」；任何半徑或擴散係數數值 |
| CHC 辨識 | `contact`：**沒有欄位**，只在 PH-3b `physical_contact` 事件中比較兩個個體的 profile 類型 | 觸角接觸（`near_contact_mm` 預設 `null`，候選上限 1 mm） | 本種 A：族群層級的化學相似與攻擊性（Fournier 2009 澳洲、2012 喀麥隆）；接觸機制 B（Gellert 2022 形態學，他種） | 47 個 GC-MS 峰是本地族群的已知數值；不同巢＝攻擊；長距離 CHC 擴散 |

CHEM-1 只實作路徑招募的兩個欄位後端；警戒與 CHC 留給 CHEM-4（契約已固定其型別與驗證）。

## 5. API 契約
| 呼叫 | 輸入 | 規則 |
|---|---|---|
| `deposit(store, ev)` | 一個 `DepositEvent` | 通過 `validateDeposit`；時刻必須**晚於**已關閉的 horizon（不得倒填）；`deposit_id` 不得重複；同一 `(signal_id, origin_agent, origin_event_id)` 只能記入一次（重複沉積偵測）；出界拒收並記帳 |
| `advance(store, to)` | `ChemTime` | 只能往前；把 `(t, round) ≤ to` 的待處理沉積依**正準順序**併入欄位，關閉 horizon；回傳 `snapshot`（觀察用） |
| `sampleLocal(store, q)` | `SampleQuery` | **即時**讀取：`q.time` 必須**等於**最新提交（不能讀未來，也不重讀過去）；只讀同層、半徑內；平面為精確面積加權（§14.6）；結果標示 `agent_local`、`read_kind: realtime_latest_committed`，並分開記錄 `sensing_time` 與 `state_commit {seq, time}` |
| `store.realtimeReader()` | — | 給即時行為決策的**唯一**化學能力：只有 `latestCommitted()` 與 `sampleLocal()`（凍結物件；沒有歷史讀取、快照、帳、溯源、沉積、advance） |
| `store.sampleHistorical(cap, hq)` | `ChemDiagnosticCapability`＋`HistoricalSampleQuery` | **只供重播／診斷／重建**：讀過去任一已提交時刻（≤ horizon）的狀態；需要 `createDiagnosticCapability()` 發出的不可偽造能力；結果標示 `diagnostic_history`、`decision_use: forbidden`；不得作為個體輸入（§14.7） |
| 多頻道 | 每頻道一個欄位 | 頻道之間互不讀取；M2 是兩個頻道（E、F），合成方式屬 CHEM-2 的選擇函數 C 軸 |

正準順序：`(t_s, round, layer, 位置鍵, amount, deposit_id)`。輸入陣列的順序與工蟻編號**不影響**結果（§7）。

## 6. 時間：與 P0-A0／P0-A1 分層時間的對應
- 化學時鐘是**物理時鐘**（`ChemClock {name, anchor:{day, minute}}`，秒）。換成世界精確時刻：`engine/clock/time-frames.ts` 的 `physicsNative(name, anchor, t_s)` → `exactOf`（無誤差，#117）。分鐘只是顯示視圖（`minutesOfDay`），不用於排序。
- `round` 對應排程器 `layered` 契約的輪次：同一精確時刻的子事件進入下一輪。
- **同時刻政策 `visible_if_round_not_later`**：沉積 `(t_d, r_d)` 對取樣 `(t_q, r_q)` 可見，若且唯若 `(t_d, r_d) ≤ (t_q, r_q)`，且 horizon 已關閉到 `(t_q, r_q)`。這與正式引擎 v2-review.20 的「同一分鐘先沉積、再走進路段」方向一致（`activity.ts` KIND_ORDER），但以輪次而不是事件種類決定。因為可見性是集合條件，**同一時刻、同一輪的多筆沉積的提交順序不影響任何取樣**。
- **分層時間契約（Owner 裁示，2026-11-08）**：每一個時間點 `(t_s, round)` 內依序為 ①該時刻的物理與來源事件完成（沉積「送出」，進 `pending`）→ ②所有合法沉積**一起提交**（正準順序，不依陣列順序）→ ③更新化學狀態（解析衰退到該時刻）→ ④個體局部感測 → ⑤後續行為決策。契約以 `CHEM_PHASES`（`physics_and_sources`、`chemistry_commit`、`chemistry_update`、`local_sensing`、`behaviour_decision`）明列；store 對應：`deposit()`＝①的送出、`advance(to)`＝`to` 的②＋③、`sampleLocal()`＝④（`SampleQuery.phase` 必須是 `local_sensing`；宣告在①～③為 `SAMPLE_BEFORE_COMMIT`，在⑤為 `SAMPLE_OUTSIDE_SENSING_PHASE`；該時刻尚未提交則 `FUTURE_SAMPLE`）。同一時刻②提交的沉積，④中**有效感測範圍內**的個體可讀到；`visible_if_round_not_later` 就是這個契約在 `(t_s, round)` 上的表述。
- 禁止：全域瞬間傳播（只讀有界半徑內的欄位；平面以精確面積加權，與圓盤交集面積為 0 的格權重恰為 0，§14.6）、未來事件提前可見、結果依陣列順序、事後修改已完成事件（已提交時刻的沉積為 `LATE_DEPOSIT`，重用 `deposit_id`／來源事件為重複，store 只保存副本、不提供修改 API）。
- 由取樣導致的沉積（④感知→⑤決策→沉積）必須在**較晚的時刻或下一輪**；同一輪不能讀到自己因這次讀取而做的沉積。
- 舊引擎以「分鐘」為路段時間單位（`edgeMinutes`）、以 mm/s 為步行速度；化學層只收 mm 與 s。分鐘、邊長分數、或「每分鐘的 λ」一律拒收（單位混淆反例）。

## 7. 不變量
1. **非負**：所有欄位值 ≥ 0；`amount > 0`；λ ≥ 0。
2. **無憑空訊號**：欄位中任一格的量 = 該格所有已併入沉積的解析衰退和；沒有沉積的格不存在。
3. **先沉積後感知**：§6 政策；取樣時刻 ≠ horizon 拒絕（未來與過去都拒絕）。
4. **順序／ID 排列不變**：打亂輸入順序 → 逐位元相同；改名工蟻 ID → 數值在浮點容許內相同（正準順序只在 amount 等完全相同時才以 ID 決定先後，和不變）。
5. **步長／時窗收斂**：解析衰退下，`advance` 的切分方式不影響任何值（逐位元相同；欄位只在沉積時更新參考時刻，取樣時才乘 `exp`）。
6. **收支**：`已沉積 = 目前存量 + 已衰退`（normalized activity 只稱為「活性帳」，**不稱化學質量守恆**）；拒收（重複、出界、遲到）分項記錄，不進欄位。真實量單位時，吸附、揮發、降解、沖刷每一項都要有獨立的帳。
7. **只讀局部**：取樣只回傳同層、半徑內的格（平面：與圓盤交集面積 > 0 的格，依精確面積加權；權重和＝圓盤在定義域內的面積比例，內部圓盤＝1）；不得從 `colony.trail_by_edge` 或任何全圖值把遠處資訊給個體。
8. **不讀蟻群需求**：化學層沒有任何蟻群庫存、缺口、幼體數、嗉囊或飢餓的輸入；沉積量由呼叫者以**該個體自己的**狀態決定（D 軸，CHEM-3），化學層只記錄。

## 8. 明確失敗案例（每一項都要有測試讓它失敗）
| 反例 | 期望 |
|---|---|
| 感知超過 horizon（未來）或過去時刻 | 拒絕 `FUTURE_SAMPLE`／`STALE_SAMPLE` |
| 在化學提交之前（①～③）或行為階段（⑤）取樣 | 拒絕 `SAMPLE_BEFORE_COMMIT`／`SAMPLE_OUTSIDE_SENSING_PHASE` |
| 倒填（沉積時刻 ≤ horizon） | 拒絕並記帳 `LATE_DEPOSIT` |
| 跨層感知、跨層沉積 | 拒絕 |
| 全圖讀取（無限／過大半徑、沒有位置） | 拒絕 |
| 同一來源事件重複記入、`deposit_id` 重複 | 拒絕並記帳 |
| 任意順序重播不等價 | 測試以多種子打亂比較逐位元 |
| 負值、零沉積、NaN | 拒絕 |
| 訊號憑空出現 | 欄位總量必須等於沉積的解析衰退和 |
| edge（分鐘、邊長分數）與 mm/s 單位混淆 | 拒絕 `BAD_UNITS`／`OUT_OF_BOUNDS:s_mm` |
| 無證據的化學身分；沒有化學身分卻用真實質量 | 拒絕 `IDENTITY_WITHOUT_EVIDENCE`／`TRUE_AMOUNT_WITHOUT_IDENTITY` |
| CHC 以距離或欄位感知；警戒併入路徑欄位 | 拒絕 `CHC_NOT_CONTACT`／`MECHANISM_BACKEND_MISMATCH` |
| 以陣列順序決定同時刻 | 契約不允許（`BAD:same_instant`） |
| 即時決策讀較早的已提交狀態、或讀尚未提交的狀態 | 拒絕 `STALE_SAMPLE`／`FUTURE_SAMPLE`（§14.7） |
| 歷史讀取沒有診斷能力、偽造能力、用途不符、帶著個體與階段（把感測查詢送進歷史 API）、讀 horizon 之後 | 拒絕 `NO_DIAGNOSTIC_CAPABILITY`／`PURPOSE_MISMATCH`／`HISTORICAL_QUERY_IS_NOT_A_SENSING_ACT`／`FUTURE_SAMPLE` |
| 平面上只與圓盤相切（交集面積 0）的格被讀到 | 權重恰為 0（§14.6） |

## 9. 與其他引擎的介面
- **PH-3b（`engine/physics/solver2d.ts`）**：沉積的來源是 `AgentOut.samples`（`[t, x, y, heading, s, u]`，mm、s）中**實際走過**的片段，`origin_event_id` 指向該片段；接觸來自 `SolverEvent`（`class: 'physical_contact'`）。不得用畫面插值，也不得為遠處未走過的路段沉積。CHEM-1 先用合成輸入。
- **P0-A 世界時鐘**：§6；天氣（溫度、降雨）對衰退或沖刷的影響屬 CHEM-2 的環境開關，預設關閉，數值為 `null` 或候選並做敏感度。
- **個體生物學引擎**：是否沉積、沉積多少由個體自身狀態（嗉囊、記憶、生理）決定（D1／D2a），取樣結果只成為該個體的輸入；化學層**絕不讀**蟻群庫存或需求（CLAUDE.md §2.1、§2.1b）。
- **#103（物理接入 Day0）**：CHEM-3 的局部暴露介面依賴 #103 的「工蟻在 Day0 中有 PH-3b 實際姿態」；#103 未解決前，CHEM-3 只能在隔離實驗中以 opt-in OFF 存在。

| #103 提供 | CHEM 使用 |
|---|---|
| 每隻工蟻的 2D 姿態與走過的片段（mm、s、layer） | `DepositEvent.where`、`time`、`origin_event_id` |
| 觸角位置（PH-3b 之後的擴充） | `SampleQuery.sensor`（目前以體中心代替，標為 D） |
| 接觸事件 | CHC 比對（CHEM-4） |

## 10. 現有正式參數的地位（不得改標）
`species/pheidole-megacephala.json` 的 `recruitment.trail_daily_retention`（0.55）、`trail_deposit_per_success`（0.35）、`trail_min_detectable`（0.08）、`trail_max_strength`（3）都是**每日、無因次單一訊號模型的遊戲假設**（機制方向：文獻支持）。它們**不是**濃度、不是半衰期、不能換算成 λ，也不得被改標為化學量。契約以 `LEGACY_TRAIL_PARAMS` 固定這個地位，測試檢查物種檔仍標 `assumption: true`、`basis: 遊戲假設`。

## 11. CHEM-1～5 規格依賴
| 包 | 內容 | 依賴 | 驗收重點 |
|---|---|---|---|
| CHEM-1（#132） | 純函式事件驅動核心：`surface_edge`、`sparse_2d`、解析衰退、λ＝0、三個 API、多頻道、收支、反例 | 本契約 | §7、§8 全部；效能表 |
| CHEM-2（#133） | 分鐘級衰退、環境開關、M1／M2 × λ＝0 的 Y 迷宮（上游 P-1～P-6、O1～O5） | CHEM-1 | 上游 §6 判讀規則；不預設贏家；**O3（JEB 實驗 3）不得當成已由 M1 重現**（Saund & Friedman 2023 依 #130 轉述未處理實驗 3） |
| CHEM-3（#134） | PH-3b／P0-A → 局部暴露 → 個體行為，隔離 Day0 opt-in OFF | #103、CHEM-0～2 | 同一座標時間契約；golden 不變 |
| CHEM-4（#135） | 短距警戒、CHC 接觸辨識兩個分開的候選 | CHEM-0、CHEM-1 | 不以路徑擴散取代 CHC；接觸不必然攻擊／招募 |
| CHEM-5（#136） | V6 唯讀圖層、重播、手機／桌面、效能、正式接入閘門 | 隔離重播可先做；正式整合受 CHEM-3 阻擋 | 「假設／非正式」標示；像素不回寫 |

## 12. 測試計畫
- CHEM-0：`chem0-contract`（契約接受正確案例，拒絕 §8 中可在結構層檢查的每一項；舊參數仍是遊戲假設）、`chemistry-isolation`（正式管線不匯入、無平台 API、無物種名、無蟻群狀態）。
- CHEM-1：§8 每一反例注入後必須失敗；數學：非負、解析與逐步相等、不同 `advance` 切分逐位元相同、打亂順序逐位元相同、改名 ID 容許內相同、多種子；合成範例（兩蟻、Y 迷宮、重疊／遠離、稀疏空間）；14／100／1000 隻的沉積與取樣 CPU、記憶體。
- 全部：typecheck、完整測試、golden 逐位元、`check:saves`、naturalism、physics／scheduler／clock 隔離。

## 13. 未決與需 Owner 裁示
- 同時刻政策：**已由 Owner 裁示**（分層時間契約，§6、§14.5）：同一時刻提交的沉積，同一時刻的局部感測可讀。
- `surface_edge` 的分格 `bin_mm`、`sparse_2d` 的 `cell_mm`、感知半徑上限都是遊戲假設（無本種觸角感知範圍資料）。
- 平面取樣：**已由 Owner 裁示**改為精確面積加權（§14.6）。仍未決：格內沉積位置的表示誤差（§14.6「仍存在的誤差」）是否需要局部自適應細分；`surface_edge` 是否同樣改為長度加權（CHEM-1b 未改，§14.6）。
- Saund & Friedman 2023 全文 Claude 本次仍無法讀取（研究文件 §11），M1 對 O3 的狀態以「未處理」對待。

## 14. CHEM-1（#132）：事件驅動核心（隔離）
> **程式**：`engine/chemistry/core.ts`（`ChemStore`、`replayChem`）。**原型**：`prototypes/chem1/scenarios.ts`（合成情境）、`examples.ts`、`perf.ts`（只印到終端機，不寫檔）。**測試**：`tests/chem1-core.test.ts`（阻擋性）。正式引擎不匯入；**沒有改任何覓食決策**；golden 逐位元不變。所有數值都是合成候選（`遊戲假設`、D），不是本種濃度、半衰期或感知半徑。

### 14.1 做了什麼
- `ChemStore` 是決定性的狀態機：沒有平台 API、亂數或時鐘；唯一可變狀態是呼叫者持有的 store。`replayChem(config, ops)` 是純函式（同輸入同輸出；被拒絕的操作記錄為 `refused`）。
- 兩個後端：`surface_edge`（每邊依 `bin_mm` 分格；路段沉積依重疊長度分配到各格）、`sparse_2d`（只存有沉積的 `cell_mm` 方格；線段依穿越長度分配）。**沒有擴散、平流、吸附或沖刷**。
- 解析衰退：格的量 A 只在有沉積進入時更新參考時刻（`A ← A·e^{−λ(t_d−t_ref)} + q`），取樣時才乘 `e^{−λ(h−t_ref)}`。因此 `advance` 怎麼切都**逐位元相同**；λ＝0 時完全不衰退。
- 沉積先進 `pending`，`advance(to)` 才依正準順序 `(t_s, round, layer, 位置, amount, deposit_id)` 併入；取樣只能在 horizon（未來與過去都拒絕）、只讀同層、只讀與有界半徑相交的格（邊：同一條邊上的區間；平面：圓盤，不是外接正方形）。暴露量＝相交格的值總和（格解析度、無面積加權：D）。**CHEM-1b 起平面改為精確面積加權（§14.6）；邊不變。**
- 拒收：結構錯誤（單位、時鐘、層、負值……）整批拒絕且不留痕跡；出界、遲到（≤ horizon）、`deposit_id` 重複、同一 `(頻道, 個體, origin_event_id)` 重複，逐筆拒收並記帳。
- 收支（每頻道）：接受、待處理、已併入、目前存量、已衰退（每次更新時記錄＋到 horizon 的部分）、殘差、各類拒收的筆數與量；normalized activity 標為 `activity_audit`（不是化學質量守恆）。觀察器另有 `snapshot()`（`observer_only`）與 `provenance()`（哪些沉積到過某格）。
- 多頻道：每頻道獨立欄位（例如 M2 的 E、F），互不讀取。

### 14.2 測試結果的分類
| 類別 | 內容 |
|---|---|
| 程式測試 | #132 每個反例注入後被拒絕或沒有效果：未來／過去取樣、倒填、跨層取樣與沉積、無限或超界半徑、沒有位置的讀取、重複來源事件與重複 ID（跨批次也偵測）、負值／零／NaN／無限量、沒有沉積時沒有訊號、分鐘時間與邊長分數、錯誤時鐘、CHC 當欄位；正確案例通過 |
| 數學不變量 | 20 個種子 × 兩後端：非負；`advance` 隨機切分逐位元相同；打亂輸入（整批與分批）逐位元相同；改名 ID 數值相同；存量＝Σ q·e^{−λΔt}；已併入＝存量＋已衰退；解析與逐步參考在 λ＝0、0.01、0.2 時相等（相對 10⁻¹²）。另以「依輸入順序相加」的天真實作證明位元測試有鑑別力；8 個人為注入的缺陷（去掉正準排序、去掉未來檢查、整批併入未來沉積、去掉層檢查、去掉重複檢查、不記衰退、正方形代替圓盤、固定步長衰退）全部被測試抓到（一次性手動突變檢查，未納入 CI） |
| 合成範例（不是生物比較） | Y 形（三條 60 mm 邊，形狀借用，不是重現 Dussutour 實驗）：10 隻走主幹＋左支，λ＝0 時左支入口讀到 0.833333、右支 0；λ＝ln2／600 s 時左支 0.493951、右支 0。兩隻並行：路徑重疊時讀到兩者之和，相距 50 mm 時只讀到自己的（CHEM-1 整格讀取為 0.8／0.4；CHEM-1b 面積加權後為 0.551984／0.275992，連續參考值為 0.6／0.3，見 §14.6）。稀疏空間：14 隻 30 秒只存 2166／250000 格 |
| 使用者可見 | 只有終端機輸出（`node prototypes/chem1/examples.ts`、`perf.ts`）；**沒有**接入觀察器（CHEM-5） |

### 14.3 效能（合成隨機走動 10 mm/s，每隻每秒一筆沉積、一次取樣，120 秒；單機量測，數值依機器而異，只供量級參考）
| 後端 | 個體 | 沉積 | 格數 | 沉積 ms | advance ms | 取樣 ms | µs／沉積（含 advance） | µs／取樣 | 堆積增量 MB（強制 GC 後） |
|---|---|---|---|---|---|---|---|---|---|
| surface_edge | 14 | 1680 | 470 | 5.4 | 9.2 | 6.5 | 8.7 | 3.9 | 0.6 |
| surface_edge | 100 | 12000 | 2398 | 25.1 | 66.8 | 34.1 | 7.7 | 2.8 | 3.1 |
| surface_edge | 1000 | 120000 | 3998 | 420.2 | 1261.8 | 189.4 | 14.0 | 1.6 | 22.3 |
| sparse_2d | 14 | 1680 | 7639 | 14.8 | 73.3 | 25.1 | 52.4 | 15.0 | 3.3 |
| sparse_2d | 100 | 12000 | 54181 | 27.3 | 134.6 | 92.1 | 13.5 | 7.7 | 23.0 |
| sparse_2d | 1000 | 120000 | 427404 | 475.7 | 2393.2 | 2297.8 | 23.9 | 19.2 | 185.7 |

熱點：`advance` 的排序比較時才組字串鍵；格以字串為鍵；每格保留全部貢獻者 ID（溯源）是 2D 記憶體的主要來源。合理降級（CHEM-5 再決定）：預先計算排序鍵、整數格鍵、溯源改為可選或分段保存；**不得**以剪除低值格換效能而不記帳（剪除會破壞切分不變性，CHEM-1 不做）。

### 14.4 已知限制
- 沉積在路段「走完」的時刻一次記入（與 v2-review.23 相同）；路段內的時間分布屬 CHEM-3（需要 PH-3b 實際取樣點）。
- 邊的取樣不跨節點；在節點上要分別讀每條相連的邊（CHEM-3 規定）。
- 感測閾值為 `null` 時 `detectable` 為 `null`；感知函數（選擇函數 C 軸）不在化學層。
- 警戒（`point_exposure`）與 CHC（`contact`）只有契約，沒有核心（CHEM-4）。
- 效能只量 CPU 與堆積；沒有量事件佇列與觀察器成本（CHEM-5）。

### 14.5 分層同時刻契約與網格敏感度（Owner 裁示）
- **程式**：`contract.ts` 新增 `CHEM_PHASES`／`ChemPhase`，`SampleQuery.phase` 為必填；`core.ts` 行為未改（原本就是「horizon 關閉＝提交＋更新、只在 horizon 取樣」），只多了階段檢查。**原型**：`prototypes/chem1/grid-sensitivity.ts`（只印到終端機）。
- **新增測試**（`tests/chem1-core.test.ts`，阻擋性）：因果（同一 t 的④讀得到②的沉積；提交前取樣被拒絕、上一已提交時刻讀不到待提交沉積；下一輪、t＋ε、t＋1 的沉積都不可見；⑤以已提交時刻送出的沉積為 `LATE_DEPOSIT`；改寫已提交沉積的三種方式被拒絕並記帳；改動呼叫者的事件物件、溯源副本、快照副本不影響已提交狀態）；排列不變（20 種子 × 兩後端：同一時刻打亂順序、置換工蟻與沉積 ID、任意分批 → 取樣**逐位元**相同，含刻意的完全平手）；不全域傳播（有效感測範圍外的同時刻沉積，即使量為 10⁹，貢獻**恰為 0**；跨邊、跨層、平面對角格皆然）；網格收斂（下表）。
- **有效感測範圍**：讀取「與半徑相交的整格」（D），所以平面上距離介於 r 與 r＋cell·√2 的沉積也會被讀到（測試中 4.9 mm 處的沉積被 3 mm 圓盤讀到）。這是格解析度的模型假設，不是感知距離的生物數值。**（已由 §14.6 取代：CHEM-1b 改為面積加權，該例現在讀到 0。下表為 CHEM-1 的「之前」紀錄，保留不改；之後的表在 §14.6。）**

**網格敏感度與收斂（CHEM-1，整格讀取，之前）**（`sparse_2d`，λ＝0；200 次合成試驗：20 mm 直線沉積量 1，r＝3 mm 圓盤，感測點在線段上加 ±5 mm 垂直偏移；參考值為連續解析值 量×|線段∩圓盤|／長度。全部合成、遊戲假設 D，非本種數值）。欄位：格寬 mm｜平均參考值｜平均取樣｜平均絕對誤差｜最大絕對誤差｜相對偏差｜假陽性（參考值 0 但讀到 >0）比例｜網格平移半格的最大差｜可證明誤差帶 exact(r＋cell·√2)−exact(r) 平均｜違反上下界次數

| cell_mm | 參考 | 取樣 | 平均誤差 | 最大誤差 | 偏差 | 假陽性 | 平移差 | 誤差帶 | 違反 |
|---|---|---|---|---|---|---|---|---|---|
| 8 | 0.1588 | 0.6114 | 0.4527 | 0.8644 | 285.1% | 33.0% | 0.8033 | 0.8245 | 0 |
| 4 | 0.1588 | 0.4195 | 0.2608 | 0.6008 | 164.2% | 32.5% | 0.6025 | 0.5880 | 0 |
| 2 | 0.1588 | 0.2958 | 0.1370 | 0.3612 | 86.3% | 28.0% | 0.3022 | 0.3408 | 0 |
| 1 | 0.1588 | 0.2232 | 0.0644 | 0.2503 | 40.6% | 14.5% | 0.2007 | 0.1609 | 0 |
| 0.5 | 0.1588 | 0.1909 | 0.0321 | 0.1752 | 20.2% | 7.0% | 0.1000 | 0.0718 | 0 |
| 0.25 | 0.1588 | 0.1745 | 0.0158 | 0.0751 | 9.9% | 4.0% | 0.0331 | 0.0351 | 0 |

- **結果（照實記錄，不調參）**：格寬**實質改變**取樣值。目前合成通道預設 `cell_mm`＝2 mm、r＝3 mm 時，平均高估 86%、28% 的試驗在連續參考值為 0 時仍讀到訊號，網格平移半格最多改變 0.30。格寬減半時平均誤差約減半（一階收斂），0.25 mm 時偏差 9.9%。所有取樣都落在可證明的上下界內（永不低估）。
- **意義**：CHEM-2～CHEM-4 比較 M1／M2 時，`cell_mm` 必須與感測半徑一起列為敏感度軸並報告，不能只用單一格寬下結論；是否改用面積加權或更細的格屬於規則／模型選擇，**需 Owner 裁示**，CHEM-1 不改。

### 14.6 CHEM-1b：平面精確面積加權取樣（Owner 裁示 30；數值方法，不是生物校準）
- **程式**：`engine/chemistry/sampling.ts`（新）：`circleRectArea`（圓與矩形交集的**解析**面積：沿 x 在 h(x)＝√(r²−x²) 與 |y₀|、|y₁| 相交處分段，每段是「上緣 y₁ 或 h」減「下緣 y₀ 或 −h」的閉式積分，沒有容斥相消、每段非負）、`discCellWeights`、`cellRect`。`core.ts` 的 `sparse_2d` 取樣改用它；`surface_edge` **不變**。
- **定義**：儲存的平面欄位是分段常數（格量 a_c 均勻分布在格面積 |c|，格裁切到定義域邊界）。圓盤 D 的讀值是這個欄位在 D 上的積分：`exposure`＝Σ a_c·|D∩c|／|c|（圓盤內的量）；`mean_density_per_mm2`＝Σ w_c·a_c／|c|，w_c＝|D∩c|／|D|（面積加權平均；內部圓盤 Σw＝1；`sensed_area_fraction`＝Σw，定義域邊緣 < 1，定義域外沒有欄位）。恆有 `exposure`＝`mean_density`·πr²。交集面積為 0 的格（在外、或只在一點／一條邊相切）**權重恰為 0、不列出**。r＝0（點感測）：面積 0，`exposure`＝0；`mean_density` 取 r→0 極限（點所在格；在格線上 2×½、在格角 4×¼）。四角都在圓內的格直接取格面積（cover 恰為 1）。`detectable` 仍比較 `exposure`。
- **仍存在的誤差（照實）**：面積加權消除了「因格邊界而讀到圓盤外的欄位」；但沉積在格內的實際位置在儲存時已被抹平到整格，所以位在圓盤外、但所在格被圓盤部分覆蓋的沉積，仍以覆蓋比例貢獻（下表「外漏」欄）。它只來自距離 < r＋cell·√2 的格、隨格寬約一階趨近 0；因為任何正的貢獻都算，「假陽性」**比例**與 CHEM-1 相同（量級大幅下降）。要完全消除，需要保留格內沉積幾何或**局部自適應細分**（在感測圓盤附近細分格、或沉積保留線段幾何），列為未來選項，**本包不實作**，也不做全域縮格。
- **網格收斂（CHEM-1b，之後）**：設定同 §14.5（200 次合成試驗，20 mm 線段、量 1、r＝3 mm、±5 mm 偏移；全部合成、遊戲假設 D，非本種數值）。可證明誤差帶改為雙側：exact(max(0, r−cell·√2)) ≤ 取樣 ≤ exact(r＋cell·√2)。最後三欄是在同一批試驗上重算的 CHEM-1 整格讀取（與 §14.5 表一致）。欄位：格寬｜平均參考｜平均取樣｜平均絕對誤差｜最大絕對誤差｜相對偏差｜假陽性比例｜平移半格最大差｜雙側誤差帶平均｜違反上下界｜格內外漏平均｜CHEM-1 平均誤差｜CHEM-1 偏差｜CHEM-1 假陽性

| cell_mm | 參考 | 取樣 | 平均誤差 | 最大誤差 | 偏差 | 假陽性 | 平移差 | 誤差帶 | 違反 | 外漏 | 舊平均誤差 | 舊偏差 | 舊假陽性 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 8 | 0.1588 | 0.1152 | 0.1074 | 0.2204 | -27.4% | 33.0% | 0.1484 | 0.9833 | 0 | 0.0735 | 0.4527 | 285.1% | 33.0% |
| 4 | 0.1588 | 0.1508 | 0.0562 | 0.1634 | -5.0% | 32.5% | 0.1472 | 0.7468 | 0 | 0.0581 | 0.2608 | 164.2% | 32.5% |
| 2 | 0.1588 | 0.1550 | 0.0210 | 0.0924 | -2.4% | 28.0% | 0.1208 | 0.4990 | 0 | 0.0295 | 0.1370 | 86.3% | 28.0% |
| 1 | 0.1588 | 0.1578 | 0.0082 | 0.1161 | -0.6% | 14.5% | 0.0972 | 0.2734 | 0 | 0.0155 | 0.0644 | 40.6% | 14.5% |
| 0.5 | 0.1588 | 0.1586 | 0.0040 | 0.0580 | -0.1% | 7.0% | 0.0610 | 0.1357 | 0 | 0.0081 | 0.0321 | 20.2% | 7.0% |
| 0.25 | 0.1588 | 0.1585 | 0.0018 | 0.0207 | -0.2% | 4.0% | 0.0274 | 0.0701 | 0 | 0.0039 | 0.0158 | 9.9% | 4.0% |

- **結果**：每一種格寬下面積加權都比整格讀取更接近連續參考值；2 mm 格時平均誤差 0.1370→0.0210、偏差 +86.3%→−2.4%、平移差 0.3022→0.1208；平均誤差、誤差帶、外漏都隨格寬單調下降（約一階或略優）。**最大誤差不單調**（1 mm 的 0.1161 大於 2 mm 的 0.0924，單一試驗的格對齊效應），照實記錄。8 mm 格偏差 −27.4%（低估），粗格仍不可用於下結論；`cell_mm` 仍須與感測半徑一起列為 CHEM-2～4 的敏感度軸。
- **CHEM-1 輸出的改變（前後對照；未合併的隔離模組）**：只影響 `sparse_2d` 的取樣值與結果欄位；沉積、衰退、收支、快照、`surface_edge` 全部不變。(1) §14.5 的 4.9 mm 相切例：之前讀到 1（整格），之後 0。(2) 兩隻並行（§14.2）：0.8／0.4 → 0.551984／0.275992（連續參考 0.6／0.3；y＝50 的線段存入 [50,52) 那一列格，圓盤只覆蓋那一列的一部分——格內位置表示誤差）。(3) 部分覆蓋格以覆蓋比例計（`chem1-core` 的 2D 斷言隨之改寫）。(4) r＝0 圓盤之前讀整格量，之後 `exposure`＝0、密度見 `mean_density_per_mm2`。(5) `SampleResult` 新增 `read_kind`、`sensing_time`、`state_commit`、`mean_density_per_mm2`、`sensed_area_fraction`、`sampling`，格檢視新增 `weight`、`cover`；`replayChem` 結果新增 `view: replay_diagnostic`。
- **效能**（同 §14.3 方法，單機、只供量級）：2D 取樣 µs／次：1000 隻 19.2→29.2、100 隻 7.7→13.1。歷史 API 需要保存已提交沉積的副本，堆積增量：1000 隻 2D 185.7→231.6 MB、邊 22.3→64.9 MB。若成為瓶頸，副本可改為可選（只在需要診斷時保存），屬 CHEM-5 決定。
- **測試**（`tests/chem1b-sampling.test.ts`，阻擋性）：解析面積對細分求積（40 個隨機矩形，最大差 1.6×10⁻⁸）與 Monte Carlo（20 萬點，全部在 5 SE 內）、閉式特例（全圓、四分之一、半圓、圓弓形、相切為 0）；300 個內部圓盤 Σw＝1（誤差 < 10⁻¹²）、列出的格都有正面積且距離 < r、沒有遺漏正面積的格；鏡射與對角對稱、平移不變（圓盤＋網格原點一起平移、整格平移）；定義域角／邊為 ¼／½；r＝0 極限；非負、`exposure` ≤ 現存量、`exposure`＝密度·πr²、200 次取樣不改變欄位與帳（逐位元）；覆蓋整個支撐的圓盤讀到恰好的現存量；圓盤摺積積分＝πr²·總量；交集面積 0 的格放 10⁹ 的沉積讀值逐位元不變（≥100 例）。`chem1-core` 的網格測試改為：雙側界 0 違反、誤差／誤差帶／外漏單調下降、每一格寬都優於 CHEM-1、文件表逐字相符。另以一次性突變檢查確認測試有鑑別力（列出零面積格、改回整格加總、歷史重建不依時間過濾、即時讀取器加上歷史 API——全部被抓到；未納入 CI）。

### 14.7 CHEM-1b：統一因果讀取契約（Owner 裁示 43）
- **兩種時刻分開記錄**：`ChemCommit {seq, time}`＝**狀態提交時刻**（某 `(t_s, round)` 的②＋③完成；`seq` 是該 store 上單調遞增的提交序號；同一時刻重複 `advance` 不產生新提交）。`SampleResult.sensing_time`＝**個體感測時刻**（該時刻的④）。即時讀取時兩者必須相等，結果兩者都記（`time` 欄保留為 `sensing_time` 的相容別名）。
- **即時（行為決策）**：只能讀**最新的、已關閉且已提交**的狀態——`ChemStore.sampleLocal(q)`，或把 `ChemStore.realtimeReader()` 回傳的 `ChemRealtimeReader`（只有 `latestCommitted()`、`sampleLocal()`）交給行為程式。感測時刻晚於最新提交＝`FUTURE_SAMPLE`；早於最新提交（讀舊狀態）＝`STALE_SAMPLE`；未提交（`pending`）的沉積、之後的輪次、之後的時刻一律不可見。
- **歷史（只供重播／診斷／重建）**：`ChemStore.sampleHistorical(cap, hq)`。`cap` 必須是 `createDiagnosticCapability('replay' | 'diagnosis' | 'reconstruction')` 發出的物件（執行時以身分檢查，手寫物件被拒；型別上有品牌，手寫物件是型別錯誤）；`hq`＝`{signal_id, layer, at, sensor, purpose}`，**沒有** `agent_id` 與 `phase`（帶著就拒絕）。它以時刻 ≤ `at` 的已提交沉積依正準順序重建狀態，與當時的即時讀值**逐位元相同**；`at` > horizon 拒絕。結果 `view: diagnostic_history`、`decision_use: forbidden`、`covered_by_commit`（第一個時刻 ≥ `at` 的提交）、`exact_commit_instant`、`queried_at_horizon`。型別上它**不能**指派給 `SampleResult`，`ChemRealtimeReader` 也沒有這個方法（`npm run typecheck` 以 `@ts-expect-error` 檢查）。`replayChem` 的結果標為 `replay_diagnostic`。
- **KIN 局部感測端要對齊的 API**（`engine/physics/local-sensing.ts`，PR #167；由另一個 agent 修改）：
  1. `ChemLocalFieldAdapter` 應持有 `ChemRealtimeReader`（`store.realtimeReader()`），不持有 `ChemStore`；`committedThrough()` 回傳 `reader.latestCommitted()?.time`。
  2. 即時路徑 `sampleLocal(sampler, q)` 的時間檢查從「`t ≤ committed`」改為「`(t_s, round)` **等於** `latestCommitted().time`」：較早＝`STALE_SAMPLE`、較晚＝`FUTURE_SAMPLE`（與 CHEM 同碼）。每個觸角點呼叫 `reader.sampleLocal({signal_id, agent_id, layer, time, phase: 'local_sensing', sensor: {kind: 'disc', x_mm, y_mm, radius_mm}})`；結果一併保存 `state_commit` 與 `sensing_time`。
  3. 讀值：`range_mm > 0` 用 `exposure`（圓盤內的量）或 `mean_density_per_mm2`（面積加權平均），要在請求中明示用哪一個；`range_mm＝0`（點感測）時 `exposure` 恆為 0，**必須**用 `mean_density_per_mm2`。
  4. 診斷／重播要讀過去時刻時，另開函式（名稱 `sampleHistorical`），呼叫 `ChemStore.sampleHistorical(createDiagnosticCapability('diagnosis'), {signal_id, layer, at, sensor, purpose: 'diagnosis'})`；結果不得流入控制器。
- **測試**（`tests/chem1b-sampling.test.ts` (D)）：即時讀取器只有三個鍵且凍結；提交序號與感測時刻分開記錄；提交前感測、讀舊狀態被拒；同一時刻重複關閉不新增提交；8 種子 × 兩後端、每個過去提交時刻的歷史重建與當時即時讀值逐位元相同且不改變 store；兩次提交之間的時刻正確重建並標示非提交時刻；未來／未提交時刻、偽造或缺少能力、用途不符、把感測查詢送進歷史 API、要求「行為」用途的能力全部被拒；三個型別層級分隔以 `@ts-expect-error` 由 typecheck 檢查。

## 15. CHEM-2（#133）：環境耦合動力學、M1／M2 實驗台、CHEM-3 接入契約（隔離、opt-in）
> **程式**：`engine/chemistry/kinetics.ts`（新；環境耦合衰退）、`engine/chemistry/core.ts`（只加 opt-in 掛鉤：`ChannelConfig.kinetics`、`StoreConfig.environment`）、`engine/chemistry/sense-contract.ts`（新；CHEM-3 個體讀取契約）。**原型**：`prototypes/chem2/env-trace.ts`（由 P0-A1 世界時鐘的環境事件建立環境軌跡）、`prototypes/chem2/bench.ts`（實驗台，只印到終端機）。**測試**：`tests/chem2-kinetics.test.ts`（阻擋性）。
> **隔離**：正式引擎、`cli/`、`web/src` 不匯入；不在規則指紋內；golden 逐位元不變；沒有接入 P0-A2 世界或物理模組；不改物種參數、存檔、日誌；不推進遊戲日。不設 `kinetics` 的頻道，或所有環境項都是 `null` 的頻道，衰退式與 CHEM-1 **同一個運算式、逐位元相同**（測試 (2)）。

### 15.1 模型
格的流失率（hazard）在區域 z：`h_z(τ) = λ_ref · f_T(T_z(τ)) + w_rain · 1[z 在 τ 下雨]`，格值 `C(t) = C(t_ref) · exp(−∫_{t_ref}^{t} h_z dτ)`。
- `λ_ref`＝頻道 `time_rule.lambda_per_s`，解讀為**參考溫度 `t_ref_c` 下**的值。
- 溫度項 `f_T(T) = Q10^((T − t_ref_c)/10)`（一般生理學形式；與 Arrhenius 在窄溫度範圍內幾乎等價，未另做）。溫度軌跡在節點之間為線性，所以 `∫ f_T dτ` 每段有閉式解 `Δ·e^{a}·expm1(b−a)/(b−a)`（a、b 為段端點的 ln f_T），以前綴和保存；`hazard(from, to) = λ_ref·(Θ(to) − Θ(from))`。溫度項 OFF 時用 `λ_ref·(to − from)`。
- 雨水沖刷 `w_rain`：雨區間是分段常數，積分＝下雨時間；**沒有任何證據支持任何數值**，預設 `null`（OFF）。
- 濕度、基質：找不到有證據的函數形式，欄位**必須**是 `null`（`NO_FUNCTIONAL_FORM:*`）。
- 擴散／散布：CHEM-0 契約固定 `isotropic_diffusion: false`，#130 也禁止預設地表各向同性擴散；欄位**必須**是 `null`（`DIFFUSION_NOT_IN_CHEM0_CONTRACT`）。要加入擴散需先由 Owner 改 CHEM-0 契約（§15.7）。
- **環境資料只從世界時鐘來**：`envTraceFromClock` 讀 `environmentSpecs(cfg, series, plan)`（P0-A1 時鐘實際排程的 `weather_sample`、`rain_start`、`rain_end` 事件，純函式），溫度在兩個樣本之間線性內插，雨為 `[rain_start, rain_end)`；有雨但時段未知的日子標 `timing_known: false`（**不當成無雨**；啟用沖刷時拒絕 `ENV_RAIN_TIMING_UNKNOWN`）。化學層不匯入時鐘模組，也不讀任何蟻群狀態。
- **位置**：每格屬於恰好一個環境區域（`all`、指定邊、或矩形；零個或兩個以上都在建構時拒絕）。P0-A1 只有全站一個溫度，所以實驗台只有一個區域；介面已可接受日照／遮蔭等分區，**但目前沒有任何分區資料**。
- **未知不猜**：軌跡中溫度為 `null` 的時段、或 horizon 超出軌跡範圍、或沉積早於軌跡起點 → `advance` 拒絕（`ENV_VALUE_UNKNOWN`／`ENV_TRACE_NOT_COVERED`），被拒的 `advance` 不改變 store。
- **收支**：沖刷與揮發／降解合在一個 hazard，只適用 normalized activity 的活性帳；真實量單位的頻道啟用環境項會被拒（`SINKS_NOT_SEPARATED_FOR_TRUE_AMOUNT`，§7 第 6 點要求各匯分帳）。

### 15.2 證據分類表
| 項目 | 數值 | 分類 | 來源與限制 |
|---|---|---|---|
| 指數衰退機制（行為反推） | — | 本種 A 資料，機制是模型相依推論 | R21／R96／R152（Dussutour 2009 JEB）：實驗室 60 mm 橋、25±1 °C；沒有化學量測 |
| `λ_ref` 半衰期 10.06／17.46 分 | 只當網格點 | 本種資料的**模型相依估計**（C） | R21；只在作者的選擇函數 1＋E、1＋F² 下成立；**不可直接用作西屯室外參數**；實驗台與 5、30、60 分並列 |
| 單一訊號衰退率 0.069／分 | 未採用 | 理論模型示例反推（C） | R102（Saund & Friedman 2023）；參數表沒有列衰退率 |
| λ＝0 基準 | 0 | 遊戲假設（必備基準） | 研究文件 §4、§6 |
| `t_ref_c`＝25 °C | 25 | 本種實驗**條件**（A），用作參考溫度是假設 | R21 飼養室溫 25±1 °C |
| 溫度方向（基質越熱，路徑訊號越快消失） | 方向 | **他種 B，非本種**：*Tapinoma nigerrimum*、*Aphaenogaster senilis* | R35、R36（van Oudenhove 2011／2012，只讀摘要）；**曲線與數值不複製** |
| Q10 形式 | — | 一般生理學 | 外溫過程的一般形式，不是本種量測 |
| Q10 值 | 預設 `null`（OFF）；實驗台網格 1.5、2、3 | 遊戲假設 D | 本種沒有任何量測 |
| 溫度輸入 | 氣溫 | 遊戲假設 D（**氣溫代替地表溫度**） | P0-A1 只提供站點氣溫；R36 談的是基質溫度；`input` 必須寫明 `air_temp_c_surrogate`，宣告 `substrate_temp_c` 的頻道吃到氣溫軌跡會被拒 |
| 日內溫度曲線 | P0-A1 合成 | 合成（`synthetic: true`）、形狀係數遊戲假設 | `engine/clock/weather-input.ts`（R247 只讀書目） |
| 雨水沖刷率 | `null` | 無證據 | — |
| 濕度、基質效應 | `null`（必須） | 無證據、無函數形式 | — |
| 擴散係數 D | `null`（必須） | CHEM-0 契約不允許 | #130、§3.1 |
| 感知閾值、增益、指數（CHEM-3 槽） | `null` | 本種無劑量反應資料 | 形式：C-a 線性加閾值（D）、C-b Deneubourg 型（C，R102 相關比較） |

### 15.3 分段不變與決定性（證明與測試）
- **證明**：格只在沉積進入時更新參考時刻 `t_ref`（與 CHEM-1 相同）；任一格在 horizon h 的值是 `a·exp(−H_z(t_ref, h))`，`H_z` 只依 `(t_ref, h)` 與（設定時就固定的）環境軌跡決定，前綴和在建構時一次算好。`advance` 怎麼切分只改變「何時被呼叫」，不改變任何格的 `(a, t_ref)` 序列（沉積依正準順序併入），所以值**逐位元相同**；同理，任一過去時刻的歷史重建（`sampleHistorical`）等於當時的即時讀值。
- **測試**（`tests/chem2-kinetics.test.ts`，183 項檢查）：
  - 2 後端 × 6 種子、80 筆隨機沉積、溫度與雨都開：一次 `advance` 與 40 次隨機切分（並打亂輸入）的快照逐位元相同；收支的 present／decayed／integrated 逐位元相同（`accepted_amount` 依輸入順序加總，是 CHEM-1 既有行為，只差浮點加總順序）；每次即時讀值都等於一步 store 的歷史重建（逐位元）。
  - OFF 等價：2 後端 × 4 個 λ（含 0）× 3 種子，無 kinetics／全 `null` kinetics／Q10 `null` 三者的快照、收支、讀值逐位元相同。
  - 解析精度：閉式積分對分段 Simpson 求積的最大相對差 6.65×10⁻¹⁵；溫度恆等於 `t_ref_c`、或 Q10＝1 時與 CHEM-1 常數 λ 的相對差 0；以固定時間步（步首凍結 hazard）推進的格式在 Δt＝600、60、6 s 的相對誤差 7.9×10⁻³、3.4×10⁻³、3.6×10⁻⁴，收斂到解析值（解析式是極限，不是另一種模型）。
  - 收支殘差 ≤ 10⁻⁹·已併入量；非負、有限；整體平移溫度 −5／0／＋5 °C 時讀值單調（方向依 R35／R36，他種；大小是網格假設）。
  - 環境軌跡：每個節點都是 `weather_sample` 事件的時刻，值與 `WeatherSeries.temperature` 逐位元相同；雨事件轉成一個 `[start, end)` 區間；無時段情境的雨天 → `timing_known: false`。
- **環境取樣步長**（實驗台）：解析積分對所給軌跡是精確的；唯一的離散化是「時鐘每 N 分鐘一個溫度樣本、中間線性內插」對合成日內曲線的近似。熱天、Q10 3、半衰期 10 分、16:00 讀值對 1 分鐘樣本的相對差：60 分 5.2×10⁻²、30 分 1.3×10⁻²、10 分 1.4×10⁻³、5 分 3.5×10⁻⁴（約二階）。實驗台用 10 分。

### 15.4 M1／M2 實驗台（`node prototypes/chem2/bench.ts`；全部合成、非正式、不選模型）
- **設定**：化學時鐘 0 s＝第 1 日 12:00；合成天氣（非臺中氣候統計）：涼天日最低／最高 18／24 °C、熱天 26／34 °C，形狀係數（峰值在正午後 2 h、夜間衰減 2、最低溫在日出）為遊戲假設；14:00～16:00 氣溫涼天 23.6～24.0 °C（約等於 `t_ref_c`）、熱天 33.5～34.0 °C。全部情境 rain_mm＝0（無雨）。
- **事先寫定的網格（全部列出，不挑選）**：半衰期@25 °C ∈ {λ＝0, 5, 10, 17, 30, 60 分} × Q10 ∈ {OFF, 1.5, 2, 3} × {涼, 熱}；M2：λ_E／λ_F ∈ {0.3, 0.6, 1}（研究文件 §6 範圍）。
- **線性**：欄位對沉積是線性的，所以 M1 在任何探索／帶食沉積比 q_X／q_L 下的讀值＝q_X·（探索單位反應）＋q_L·（帶食單位反應）；實驗台分別列出兩個單位反應，**不選比值**。M2 的「F 局部抑制 E 沉積」是沉積規則（行為，CHEM-3），不是動力學，實驗台**沒有**模擬。
- **S1 單一路徑**（600 mm 邊、5 mm 格；13:00–13:15 探索 15 次、13:15–14:00 帶食 45 次，每次全長；探針 s＝300 mm、r＝3 mm）帶食段單位反應節錄（完整表見 PR 說明或執行實驗台）：

| 半衰期@25°C | Q10 | 天氣 | 14:00 | 15:00 | 16:00 | 18:00 |
|---|---|---|---|---|---|---|
| λ=0 | OFF | — | 0.750 | 0.750 | 0.750 | 0.750 |
| 10 min | OFF | — | 0.238 | 3.72e-3 | 5.81e-5 | 1.42e-8 |
| 10 min | 2 | 涼 | 0.252 | 5.24e-3 | 1.15e-4 | 7.61e-8 |
| 10 min | 2 | 熱 | 0.137 | 5.96e-5 | 2.96e-8 | 1.74e-14 |
| 17 min | OFF | — | 0.351 | 0.030 | 2.63e-3 | 1.97e-5 |
| 17 min | 2 | 涼 | 0.366 | 0.038 | 3.96e-3 | 5.35e-5 |
| 17 min | 2 | 熱 | 0.220 | 2.32e-3 | 2.64e-5 | 5.70e-9 |
| 60 min | OFF | — | 0.588 | 0.294 | 0.147 | 0.037 |
| 60 min | 2 | 熱 | 0.485 | 0.134 | 0.038 | 3.44e-3 |

- **S3 熱天／涼天比**（帶食段 16:00 讀值；Q10 OFF 恆為 1）：

| 半衰期@25°C | Q10 OFF | 1.5 | 2 | 3 |
|---|---|---|---|---|
| 5 min | 1 | 2.54e-4 | 1.20e-7 | 7.71e-14 |
| 10 min | 1 | 0.014 | 2.59e-4 | 1.71e-7 |
| 17 min | 1 | 0.074 | 6.67e-3 | 7.88e-5 |
| 30 min | 1 | 0.221 | 0.054 | 4.05e-3 |
| 60 min | 1 | 0.464 | 0.227 | 0.060 |

- **敏感度判讀**：熱／涼比 ≈ `exp(−λ_ref·∫(f_hot − f_cool)dτ)`，所以溫度效應的大小由「半衰期 × Q10」**一起**決定：短半衰期配高 Q10 時，兩小時後熱天讀值比涼天低 7～13 個數量級；60 分配 Q10 1.5 只差約一半。`t_ref_c` 平移等於把 `λ_ref` 乘上 Q10 的冪次，與半衰期軸不可分辨。**現有本種資料無法約束 Q10、也無法約束野外 λ**，所以這張表只顯示「若溫度項存在，它會主導下午的路徑存量」這個**模型相依**的敏感度，不是預測。
- **S1 M2**（Q10 2；16:00）：λ_E／λ_F＝0.3 時，探索訊號 E 在 16:00 仍高於 F（例：F 半衰期 17 分、涼天 E 0.036 對 F 3.96e-3）；比值＝1 時 F 較高（E 只來自較早、較少的 15 次探索）。這只是兩個衰退率的直接結果，**不是** M2 與觀察相容或不相容的證據（需要 O1～O5 與選擇函數）。
- **S2 交叉路徑**（400×400 mm 平面、2 mm 格；A 沿 y＝200 於 13:00–13:30、B 沿 x＝200 於 13:30–14:00；r＝3 mm 平均密度）：λ＝0 時交點≈兩條路之和（0.029 對 0.015＋0.015 /mm²）；半衰期 17 分時較晚的 B 在 14:00 是 A 的 3.4 倍（8.62e-3 對 2.54e-3），熱天 Q10 2 時 9.8 倍（溫度在 13:00–14:00 已高）；交點讀值始終是兩者之和（欄位線性，沒有交互作用項）。
- **S4 無雨**：全部情境無雨。對照：熱天、半衰期 17 分、Q10 2，「當日 5 mm、14:26–15:26 合成一小時雨、沖刷 `null`」與無雨**逐位元相同**；只為顯示開關有效，以無證據的網格點 1e-3/s 開沖刷時 16:00 讀值 2.64e-5→7.22e-7。
- **與每日日終舊模型對照**：舊模型（`trail_daily_retention` 0.55，日終一次）在一個下午之內就是 λ＝0 基準（表中第一列）；依 §10，該參數**不能**換算成 λ，所以沒有做「等效半衰期」。
- **成本**（單機、只供量級）：S1 於 16:00 讀 20000 次（先暖機），CHEM-1 公式約 2.6 µs／次、溫度項 ON 約 3.9 µs／次（二分搜尋節點＋兩次指數）；整個實驗台約 2 s。沒有量 RAM（每頻道只多一份節點前綴和陣列，與格數無關）。

### 15.5 CHEM-3 接入契約（`engine/chemistry/sense-contract.ts`；尚未接入任何世界或物理）
| 規則 | 實作 | 反例（測試讓它失敗） |
|---|---|---|
| 個體只持有 `LocalChemSense`，由 `createLocalSense(reader, poses, agent_id)` 建立；`reader` 必須是 `store.realtimeReader()`（凍結、只有 `kind`、`latestCommitted`、`sampleLocal`） | 檢查成員與凍結 | 傳入 `ChemStore` → `GLOBAL_ACCESS_REFUSED`；手寫讀取器 → `NOT_A_REALTIME_READER`；帶 `snapshot` 的讀取器 → `GLOBAL_ACCESS_REFUSED` |
| 感測位置**不是參數**：取自物理端的 `PoseSource.poseAt(agent_id, t)`（CHEM-3 由 PH-3b 提供；目前以體中心代替觸角，D） | 請求只允許 `signal_id`、`time`、`radius_mm`、`measure` | 帶 `x_mm`／`sensor`／`agent_id`／`at` → `REQUEST_KEY_NOT_ALLOWED`；沒有姿態 → `NO_POSE` |
| 只讀最新已提交狀態（CHEM-1b） | 一律 `phase: 'local_sensing'`，交給 reader 檢查 | 未來時刻 → `FUTURE_SAMPLE`；舊時刻 → `STALE_SAMPLE` |
| 半徑有界 | 頻道上限 | 全圖半徑 → `RADIUS_ABOVE_BOUND`；無限 → `UNBOUNDED_RADIUS` |
| 量度要明示 | `exposure` 或 `mean_density_per_mm2` | 平面 r＝0 用 `exposure` → `EXPOSURE_AT_ZERO_RADIUS`；邊上要面積密度 → `MEASURE_UNAVAILABLE_ON_BACKEND` |
| 讀值是純量 | 不含格鍵、溯源、他人 ID | 測試檢查鍵集合 |
| 反應函數是**槽** | `ResponseSlots {form, threshold, gain, exponent, form_evidence, sources}`，每個數值附 `ParamProvenance`；`linear_above_threshold`（C-a，D）、`deneubourg_power`（C-b，C） | 預設全 `null` → `evaluateResponse` 回傳 `null`（OFF）並列出原因；無本種證據卻標 `assumption: false` → 拒絕；線性形式帶指數 → 拒絕 |
- 反應函數只產生「單一選項的吸引度」；多選項合成選擇（選擇算子 C、記憶、飢餓、接觸）屬 CHEM-3 的決策算子，化學層不做。

### 15.6 未驗證（照實）
- **沒有**對 Dussutour 2009 的 O1～O5 擬合或保留資料檢驗（需要 CHEM-3 決策算子與 1000～1500 隻的 Y 迷宮實驗台）；本節不判讀 M1／M2 誰與觀察相容。O3 仍是「M1 未處理」。
- Q10、野外 λ、沖刷率、濕度與基質效應、擴散：本種**全部沒有**資料；實驗台的值都是網格點。
- 氣溫代替地表溫度：方向與大小都未驗證（日曬地表可比氣溫高很多，也可能遮蔭較低）。
- 溫度軌跡在樣本之間線性內插，是對 P0-A1 合成曲線的近似（§15.3 的步長收斂）；沒有觀測逐時資料的測試（不造假觀測）。
- 單一環境區域：沒有遮蔭、基質或微氣候分區資料。
- 效能只量讀取 CPU；沒有 14／100／1000 隻的完整動力學效能表（CHEM-1 §14.3 的沉積／advance 成本不變，hazard 只在格更新與讀取時多一次二分搜尋）。

### 15.7 需 Owner 裁示
1. 是否允許在 CHEM-0 契約中加入擴散（目前 `isotropic_diffusion: false` 是型別常數）；若允許，要先決定邊界、吸附、CFL 與格網收斂的驗收。
2. 溫度輸入：是否需要地表溫度模型（日照、基質），或接受「氣溫代替地表」的假設進入 CHEM-3 實驗。
3. 實驗台網格（半衰期 5～60 分＋λ＝0、Q10 1.5～3）是否作為 CHEM-3 Y 迷宮的事先寫定敏感度範圍。

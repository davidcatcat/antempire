# 化學生態引擎（CHEM）：ODD 描述、跨引擎契約與不變量

> **地位**：CHEM-0（#131）的設計與契約。**隔離**：正式每日模擬（`engine/day.ts` 等頂層 `engine/*.ts`）、`cli/`、`web/src` 都不匯入 `engine/chemistry/`（`tests/chemistry-isolation.test.ts`）；不在規則指紋內；不改任何物種參數、存檔或日誌；不推進遊戲日；不啟動正式 Day0。
> **上游規格**：[`research-pheromone-models-2026-11.md`](research-pheromone-models-2026-11.md)（M1／M2、D1／D2a、X、C、O1～O6、P-1～P-6）。本文件**不另造**一套候選模型，只規定化學層的資料結構、時間空間契約與測試。
> **程式**：`engine/chemistry/contract.ts`（公開型別與純函式驗證器）；CHEM-1 的核心見 §11。**測試**：`tests/chem0-contract.test.ts`、`tests/chemistry-isolation.test.ts`（阻擋性）。
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
`{signal_id, agent_id, layer, time, sensor}`；`sensor` 為 `{kind:'edge', edge_id, s_mm, radius_mm}` 或 `{kind:'disc', x_mm, y_mm, radius_mm}`。**沒有**不帶位置的查詢形式；`radius_mm` 必須有限且不超過頻道上限。觀察器可另取全圖快照（標示 `observer_only`），它**永遠不得**成為個體的輸入（CLAUDE.md §2.4）。

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
| `sampleLocal(store, q)` | `SampleQuery` | `q.time` 必須**等於** horizon（不能讀未來，也不重讀過去）；只回傳同層、半徑內的格；結果標示 `agent_local` |
| 多頻道 | 每頻道一個欄位 | 頻道之間互不讀取；M2 是兩個頻道（E、F），合成方式屬 CHEM-2 的選擇函數 C 軸 |

正準順序：`(t_s, round, layer, 位置鍵, amount, deposit_id)`。輸入陣列的順序與工蟻編號**不影響**結果（§7）。

## 6. 時間：與 P0-A0／P0-A1 分層時間的對應
- 化學時鐘是**物理時鐘**（`ChemClock {name, anchor:{day, minute}}`，秒）。換成世界精確時刻：`engine/clock/time-frames.ts` 的 `physicsNative(name, anchor, t_s)` → `exactOf`（無誤差，#117）。分鐘只是顯示視圖（`minutesOfDay`），不用於排序。
- `round` 對應排程器 `layered` 契約的輪次：同一精確時刻的子事件進入下一輪。
- **同時刻政策 `visible_if_round_not_later`**：沉積 `(t_d, r_d)` 對取樣 `(t_q, r_q)` 可見，若且唯若 `(t_d, r_d) ≤ (t_q, r_q)`，且 horizon 已關閉到 `(t_q, r_q)`。這與正式引擎 v2-review.20 的「同一分鐘先沉積、再走進路段」方向一致（`activity.ts` KIND_ORDER），但以輪次而不是事件種類決定。因為可見性是集合條件，**同一時刻、同一輪的多筆沉積的提交順序不影響任何取樣**。
- 由取樣導致的沉積（感知→決策→沉積）必須在**較晚的時刻或下一輪**；同一輪不能讀到自己因這次讀取而做的沉積。
- 舊引擎以「分鐘」為路段時間單位（`edgeMinutes`）、以 mm/s 為步行速度；化學層只收 mm 與 s。分鐘、邊長分數、或「每分鐘的 λ」一律拒收（單位混淆反例）。

## 7. 不變量
1. **非負**：所有欄位值 ≥ 0；`amount > 0`；λ ≥ 0。
2. **無憑空訊號**：欄位中任一格的量 = 該格所有已併入沉積的解析衰退和；沒有沉積的格不存在。
3. **先沉積後感知**：§6 政策；取樣時刻 ≠ horizon 拒絕（未來與過去都拒絕）。
4. **順序／ID 排列不變**：打亂輸入順序 → 逐位元相同；改名工蟻 ID → 數值在浮點容許內相同（正準順序只在 amount 等完全相同時才以 ID 決定先後，和不變）。
5. **步長／時窗收斂**：解析衰退下，`advance` 的切分方式不影響任何值（逐位元相同；欄位只在沉積時更新參考時刻，取樣時才乘 `exp`）。
6. **收支**：`已沉積 = 目前存量 + 已衰退`（normalized activity 只稱為「活性帳」，**不稱化學質量守恆**）；拒收（重複、出界、遲到）分項記錄，不進欄位。真實量單位時，吸附、揮發、降解、沖刷每一項都要有獨立的帳。
7. **只讀局部**：取樣只回傳同層、半徑內的格；不得從 `colony.trail_by_edge` 或任何全圖值把遠處資訊給個體。
8. **不讀蟻群需求**：化學層沒有任何蟻群庫存、缺口、幼體數、嗉囊或飢餓的輸入；沉積量由呼叫者以**該個體自己的**狀態決定（D 軸，CHEM-3），化學層只記錄。

## 8. 明確失敗案例（每一項都要有測試讓它失敗）
| 反例 | 期望 |
|---|---|
| 感知超過 horizon（未來）或過去時刻 | 拒絕 `FUTURE_SAMPLE`／`STALE_SAMPLE` |
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
- 同時刻政策：本文採「同輪可見」（與 v2-review.20 方向一致）。若 Owner 要「同輪不可見、下一輪才可見」，只需改契約常數並重跑測試。
- `surface_edge` 的分格 `bin_mm`、`sparse_2d` 的 `cell_mm`、感知半徑上限都是遊戲假設（無本種觸角感知範圍資料）。
- Saund & Friedman 2023 全文 Claude 本次仍無法讀取（研究文件 §11），M1 對 O3 的狀態以「未處理」對待。

# 遊戲畫面品質 P0 稽核（VIS-0，Owner 2026-11-13 指示）

> **地位**：盤點文件。只讀 `origin/main`（`9d014c8`）的程式與文件後整理，不改任何程式、不改模擬、不推進遊戲時間。
> **用途**：Owner 2026-11-13 把「遊戲畫面品質與真實世界呈現」列為與科學引擎**並行**的獨立 P0 工作線（[`owner-decisions-2026-11-13c.md`](owner-decisions-2026-11-13c.md)）。本文回答：現在做到哪裡、缺什麼、依賴什麼。規格見 [`visual-p0-scene-spec.md`](visual-p0-scene-spec.md)，工作包見 [`roadmap.md`](roadmap.md) §3f（追蹤 [#238](https://github.com/davidcatcat/antempire/issues/238)：VIS-1 #239、VIS-2 #240、VIS-3 #241、VIS-4 #242、VIS-5 #243、VIS-6 #244、VIS-7 #245、VIS-8 #246）。
> **判讀方式**：「已完成」＝main 上有程式且有測試；「部分」＝有程式但沒接到 P0-A2 世界的畫面，或只在原型頁；「缺」＝沒有程式。每一列都附檔案位置。CI 綠燈只代表程式性質，**不代表畫面品質**（Owner 指示：觀看體驗是主要驗收）。

## 0. 結論（先講）

1. **畫面的瓶頸不是繪圖後端，而是「P0-A2 世界給畫面的資料很少」加上「實驗頁沒有用上已經做好的美術」。** P0-A2 狀態框沒有任何二維座標：只有每隻工蟻的活動狀態、巢內／巢外、狀態開始時刻、（只有走路線與巢內移動時才有的）預定結束時刻、嗉囊比例與路線記憶（§2）。所以畫面上：路線是一條固定方位的 200 cm 直線（方向是示意）；搜尋中的工蟻是巢口附近**不動的**示意點；取食的工蟻是食源周圍的固定圈；巢內 30 隻中的大多數根本不在地表，只出現在一個像儀表板的「巢內（示意）」小圖。這就是 Owner 看到「座標上移動的點」與「儀表板」感的主要原因。
2. **美術資產與分層繪圖器已經相當完整**（`web/src/art-*.ts`、`render-canvas.ts`、`display-motion.ts`；PR A／B／C、#159、#164），但**實驗模式（`experiment.html`，P0-A2）沒有開啟頭部轉動與左右觸角微動作**（`v62.ts` 呼叫 `LayeredRenderer.frame` 時沒有傳 `micro`；只有舊的重播頁 `game.ts` 有傳）。
3. **步態頻率在畫面上依放大倍率而變，而且在真實比例下過快。** 目前每個步態週期身體前進 0.20 體長（`art-ant.ts` `CYCLE_ADVANCE = 2·STRIDE = 20` 單位／體長 100）。真實比例（×1）走 17 mm/s 時等於約 34 Hz，遠高於僅有的螞蟻步頻參考（R890，*Linepithema humile*，**非本種**，最高約 14 Hz）；放大 ×N 時又變成 34/N Hz（例如 ×10 時 3.4 Hz，看起來像在滑行）。需要改成「畫面上的地面速度 ÷ 畫面步幅（以體長計）」，並對高頻做時間抗鋸齒（規格 §6）。
4. **物理／運動學模組都還是隔離的**：`engine/physics/` 的 KIN-2D、自然步行候選、PH-3b、觸角幾何、局部感測都**沒有**接進 P0-A2 世界，也不在 Worker 白名單裡（`prototypes/continuous-world/worker-boundary.json`；`tests/physics-isolation.test.ts`）。R2 驗收矩陣把它們記為 M21／M22「未接入」。畫面現在**能用的物理軌跡只有原型頁的合成情境**（`prototypes/natural-walk/` 的 `antempire.pose-stream.v1`、`prototypes/physics-playback/` 的 PH-3b 分段），不能拿來畫 P0-A2 世界裡的螞蟻（§4）。
5. **繪圖後端**：#159 的同機交錯量測（無頭 Chromium、軟體繪圖）在目前規模（≤ 30 隻）下 Canvas 2D 比 PixiJS 快或相當；實機數據（#192 第 3 項）**仍缺**。建議維持 Canvas 2D，PixiJS 待實機與「畫質功能」量測後依規則決定（[`visual-p0-scene-spec.md`](visual-p0-scene-spec.md) §10）。

## 1. 網頁入口與模組

| 項目 | 位置 | 狀態 | 說明 |
|---|---|---|---|
| 重播遊戲畫面 | `web/index.html` → `web/src/game.ts`、`game-model.ts`、`replay-ux.ts` | 已完成（V6-1、PR C） | 讀 `web/data/`：**舊每日引擎**的 A1／A5／A4 三個 30 日實驗重播（秋季、種子 20270001）。分層繪圖器、示意場景、顯示微動作（頭、觸角）、追蹤、事件跳轉都在。重播資料只有每日 360 分鐘活動時窗，**沒有日夜**，光源固定示意。#212 Q1 之後舊每日引擎只作研究與資料來源，所以這頁不是 P0 畫面的主要目標。 |
| 分析模式 | `web/analysis.html` → `web/src/main.ts`、`model.ts`、`charts.ts` | 已完成（V3～V5） | 地圖、事件時間軸、統計圖。是分析介面，不是遊戲畫面。 |
| 實驗模式（Worker 即時世界） | `web/experiment.html` → `web/src/v62.ts`、`v62-model.ts`、`v62-p0a2-model.ts`、`v62-p0a2-view.ts`、`v62-menu.ts` | 已完成（V6-2、SAVE-2/3），**畫面品質部分** | 預設 P0-A2 24 小時個體行為世界（候選／實驗世界，非正式）。用同一個 `LayeredRenderer` 畫地表；光照依引擎光照狀態分段（夜／曙暮光／日三段＋太陽高度分段）；工蟻點選、追蹤、速度、幀率上限、示意落葉開關、「尚未模擬」面板、存檔選單。**沒有**：頭與觸角微動作、地下（剖面）視圖、搜尋中工蟻的移動、地表上的巢內工蟻。 |
| Worker 示範頁 | `web/experimental-worker.html` | 已完成 | 合成世界的 Worker 執行環境示範，不是遊戲畫面。 |
| 分層繪圖器 | `web/src/render-scene.ts`（純函式）、`web/src/render-canvas.ts`（`LayeredRenderer`） | 已完成 | 11 層：`ground → decals → shadows → propsLow → routes → antShadows → ants → propsHigh → lighting → weather → ui`；地面分塊烘焙、無接縫非週期地面、引擎物件精靈、螞蟻圖集、畫質自動降級。見 [`game-render-system.md`](game-render-system.md)。 |
| 美術資產 | `web/src/art-core.ts`、`art-ant.ts`、`art-ground.ts`、`art-props.ts`、`art-fx.ts`、`art-raster.ts` | 已完成 | 全部由程式以種子產生（無外部素材）。螞蟻：12 節膝狀觸角、腹柄＋後腹柄、六足分節；頭寬／頭長／柄節比例依 R99；步態列 walk 12、idle 8、curveL/R、pivotL/R 各 12 幀。地面：土壤磚、落葉、樹枝、石子、草叢、苔、碎屑。物件：巢口、寄主植物（活／死）、蚜蟲、介殼蟲、花、昆蟲屍體。光線：`LightState`。見 [`game-art-style.md`](game-art-style.md)。 |
| 顯示微動作 | `web/src/display-motion.ts` | 已完成（#164），**只接在重播頁** | 頭部非週期轉動、左右觸角各自的半馬可夫模式（掃動／前探／點地／休息）、走↔停混合、播放倍速減弱。純函式（τ＝模擬秒＋個體 ID）。`tests/display-motion.test.ts`（阻擋性）。 |
| 預旋轉圖集（B） | `render-scene.ts` `planRotatedAtlas` 等、`LayeredRenderer({ antSprites: 'prerotated' })` | 已完成，預設關閉 | 見 [`render-comparison.md`](render-comparison.md)。 |
| PixiJS（C） | `prototypes/render-compare/src/pixi-ants.ts`、`prototypes/render-bench/` | 原型 | 只在比較頁；正式與實驗畫面都沒有 PixiJS 依賴。 |
| 實機量測頁 | `prototypes/render-compare/device-bench.html`（`src/device-bench.ts`、`src/bench-stats.ts`） | 已完成，**沒有實機結果** | 只有無頭樣本 `device-bench-headless.json`（標示「NOT a device result」）。 |

## 2. Worker 執行環境與 P0-A2 狀態框（畫面真正拿得到的資料）

來源：`prototypes/continuous-world/worker/p0a2-world.ts` 的 `frame()` 與 `antView()`；型別在 `web/src/experimental/worker-protocol.ts`（`P0a2FrameMsg`）。

| 欄位 | 內容 | 語意 | 畫面可用性 |
|---|---|---|---|
| `t_sim`、`seq`、`log.{count,hash}` | 世界時間（秒，整數毫秒格點）、事件序號、事件日誌雜湊 | 引擎 | 時間顯示、重播比對 |
| `workers[].id`、`state` | 9 種活動：`resting`、`idle`、`brood_care`、`to_entrance`、`from_entrance`、`outbound`、`searching`、`feeding`、`returning` | 引擎狀態 | 分組、姿勢選擇（休息／走動） |
| `workers[].loc` | `nest`／`nest_transit`／`outside` 三類位置 | 引擎狀態（**不是座標**） | 地表或地下 |
| `workers[].since_s` | 目前狀態的開始時刻 | 引擎紀錄點 | 動畫起點 |
| `workers[].until_s` | 只有 `outbound`／`returning`（固定走路時間 `travel_ms` = 2000 mm ÷ 17 mm/s ≈ 117.6 s）與 `to_entrance`／`from_entrance`（固定 `move_ms`）才有，其餘 `null` | 引擎已排定的下一個事件時刻 | 路線上的位置＝兩個紀錄點之間的**顯示插值** |
| `workers[].crop_fill` | 自己的嗉囊比例，**推算到 `t_sim`**（#225，`World.projectedView`） | 引擎（個體生理） | 腹部飽滿程度的示意（規格 §5.4） |
| `workers[].route` | 路線記憶（食源 ID 或 `null`） | 引擎（個體記憶） | 卡片文字 |
| `larvae[].id`、`gut_fill` | 8 隻幼蟲、各自腸道比例（推算到 `t_sim`） | 引擎 | 地下視圖中的幼蟲 |
| `source.stock_portions` | 蜜露源存量 | **玩家視角**（沒有工蟻讀它） | 食源外觀只能標「玩家視角」 |
| `layout.source_distance_cm`、`travel_s`、`move_s` | 路線**長度** 200 cm（遊戲假設）、固定移動時間 | 引擎參數 | 路線長度；**方向不是引擎資料**（`SOURCE_BEARING_RAD = π/7` 是示意，`v62-p0a2-model.ts`） |
| `env.light`、`sun_altitude_deg`、`before_solar_noon`、`temperature_c`、`site_temperature_c`、`rh_percent`、`date` | 工蟻在巢口感知的光照狀態（夜／曙暮光／日）、一般方法的太陽高度（只供畫面）、合成氣溫與濕度 | 引擎（`synthetic: true`） | 日夜光照、陰影長度 |
| 追蹤副本 `antView(id)` | 個體門檻、近期接觸、幼蟲求食紀錄、已代謝量、未滿足需求、上次結帳時刻 | 引擎（唯讀副本） | 個體卡片 |

**沒有的**（因此畫面不得假裝有）：任何個體的 x、y、朝向、速度、角速度；搜尋的空間路徑（搜尋只有一個指數分布時長，`world.ts` `search_ms`）；巢內任何位置；巢室、通道、巢口幾何；蟻后、卵、蛹、大工蟻、死亡（R2 矩陣 M15～M18：未接入）；身體接觸與交哺的身體位置（M14：巢內相遇是機率，不是接觸）；費洛蒙（M24）。完整清單由 Worker 寫在 `save_meta.not_simulated`（`not-simulated.ts`，由 `docs/r2-acceptance-matrix.json` 產生），實驗頁頂列「尚未模擬」面板原樣顯示。

**時間契約**：畫面時鐘只讀 Worker 的狀態框，兩框之間最多超前 0.05 秒真實時間的推進量（`v62-model.ts` `displayTime`）；暫停＝`t_sim`；UI 操作不改事件（`tests/web-v62-experiment.test.ts`、`tests/browser/v62-experiment.check.cjs`）。這些保證**要原樣保留**。

## 3. 實驗頁目前的畫法（P0-A2）與觀看體驗缺口

| 畫面元素 | 目前畫法（`v62-p0a2-model.ts`、`v62.ts`） | 觀看體驗問題 | 能否改善而不捏造 |
|---|---|---|---|
| 去程／回程工蟻 | 巢口與食源兩點間直線插值，約 117.6 s 走完 200 cm；轉身緩動 | 長直線、等速、無微動作；在可辨識的放大下整條路線看不到兩端 | 可：路線形狀、步態、微動作都是畫法（規格 §5、§6）；**路徑弧長必須等於引擎長度，紀錄時刻必須在端點** |
| 搜尋中工蟻 | 巢口周圍一個雜湊決定的**靜止**示意點 | 一隻工蟻站著不動但標「搜尋」，與真實觀察最不像 | 只能改成「示意搜尋動畫」並明確標示；不得暗示真的有空間搜尋（M13 簡化代理）。另一選項：不畫在地表，只在巢口外「搜尋中 N 隻」標示（規格 §5.3 讓 Owner 選） |
| 取食工蟻 | 食源周圍固定圈 | 圈狀排列太規則 | 可：排列本來就是畫面；改成貼在寄主枝條上的自然姿勢（示意） |
| 巢內工蟻（多數時間的多數個體） | 地表不畫；右下「巢內（示意）」小圖：依引擎狀態分四區的圓點，填色＝嗉囊 | 儀表板感；主畫面常常幾乎沒有螞蟻 | 可：地下概念視圖（規格 §7），仍只依引擎狀態分組，不畫巢室幾何 |
| 巢口 | `art-props.nestEntrance` 小土坑 | 尚可 | 巢口土粒、鬆土是示意（R95 定性：地表常見多個出入口與鬆土堆） |
| 食源 | 情境蜜露源；寄主植物＋蚜蟲圖示（示意） | 尚可；蚜蟲數不是引擎資料（P0-A2 的食源是固定產出，M07 簡化代理） | 只能畫成「情境蜜露源（示意外觀）」 |
| 光照 | 引擎光照狀態＋太陽高度**分段**（避免每幀重烘） | 段與段之間跳變；夜間對比 | 可：在段內以疊層連續過渡（不重烘地面），規格 §8 |
| 地面／裝飾 | 示意地面；落葉石塊**預設關閉**（合成世界沒有障礙物） | 地面空曠 | 可：預設開啟並標「裝飾」；裝飾不得像食物、不得暗示障礙（規格 §4） |
| 鏡頭 | 縮放、平移、追蹤、全場地、＋／－ | 開場視角與比例不利於看清螞蟻 | 可：開場預設「巢口近景」並提供多個鏡頭預設（規格 §9） |

## 4. 物理與運動學模組：是否可用於 P0-A2 的顯示路徑

| 模組 | 位置／文件 | 做什麼 | 是否接入 P0-A2 | 能否當 P0-A2 的顯示軌跡 |
|---|---|---|---|---|
| MV-1／MV-2 一維運動學 | `engine/physics/kinematics.ts`、[`physics-kinematics2d.md`](physics-kinematics2d.md) 前身 | 沿通道中心線的點、分段等速 | 否（隔離） | 否：一維、無朝向 |
| PH-2 一維碰撞 | `engine/physics/collision.ts` | 一維讓路候選 | 否 | 否 |
| PH-3a 身體占位 | `engine/physics/body2d.ts`、[`physics-2d-occupancy-contract.md`](physics-2d-occupancy-contract.md) | 膠囊身體幾何 | 否 | 只作形狀契約 |
| PH-3b 二維解算器 | `engine/physics/solver2d.ts`、[`physics-ph3b-solver2d.md`](physics-ph3b-solver2d.md) | 車道上的事件驅動多體約束；分段直線平移 | 否 | 否（需要車道幾何；P0-A2 沒有）。播放頁 `prototypes/physics-playback/` 用合成情境 |
| WP4 局部避讓候選 | `engine/physics/local-steer.ts`、[`wp4-local-avoidance.md`](wp4-local-avoidance.md) | A／B／C／N 候選 | 否 | 否 |
| **KIN-2D 剛體運動學** | `engine/physics/kinematics2d.ts`、[`physics-kinematics2d.md`](physics-kinematics2d.md) | 姿態 (x, y, θ)、等扭轉圓弧（**閉式解**）、連續碰撞 | 否 | **技術上最適合**：每段是精確圓弧，畫面可在任何時刻精確求值，不需要插值 |
| **自然步行候選 A／B／C** | `engine/physics/natural-walk.ts`；原型 `prototypes/natural-walk/`（`pose-stream.ts`、`data/*.json`、`compare/`） | 模型 A 直線、B 時間相關方向控制（OU）、C 加合成濃度場；與 R133 的比對（診斷，不是校準） | 否 | 只在原型頁的合成情境可看（`antempire.pose-stream.v1`：t、x_mm、y_mm、θ、v、ω）；**不能套到 P0-A2 的螞蟻**（見下） |
| 觸角幾何 | `engine/physics/antenna-geometry.ts`、[`antenna-geometry.md`](antenna-geometry.md) | 平面兩節觸角、觸角接觸事件；物種模式因缺資料一律拒絕，只有候選模式 | 否 | 否：它的擺動是運動學輸入，不是畫面動畫（文件 §3 明文分開），也沒有接任何決策 |
| 局部感測契約 | `engine/physics/local-sensing.ts`、[`kin2d-local-sensing.md`](kin2d-local-sensing.md) | 只能局部讀取的化學取樣介面 | 否 | 否（沒有顯示意義） |
| LANE-FLOW、目的地容量 | `engine/physics/lane-flow.ts`、`destinations.ts` | #189 的整合候選 | 否 | 否 |
| 物理播放頁 | `prototypes/physics-playback/`、[`physics-playback.md`](physics-playback.md) | PH-3b 分段原樣播放 | — | 只播合成情境 |

**為什麼不能直接把自然步行軌跡套到 P0-A2 的螞蟻上**：P0-A2 的往返時間是 `source_distance_mm ÷ trail_walking_speed_mm_s`（`prototypes/p0a2-24h/params.ts`）。任何物理模型算出的軌跡（有轉向、會停、會碰撞）都會有自己的抵達時刻與走過的距離；把它塞進 P0-A2 已排定的 `since_s`→`until_s` 區間，就是用畫面上的物理去「演」一個引擎沒有算的運動——這正是 Owner 要求禁止的「與引擎脫鉤的行為」。反過來讓物理決定抵達時刻，就改變了 P0-A2 的事件時間，是**規則更新**（CLAUDE.md §6），屬 #189／#103／R2 矩陣 M22 的範圍。

**可行路徑（詳見規格 §6.4 與 VIS-7）**：
- **短期（不改引擎）**：路線上的位置維持「兩個紀錄點之間的顯示插值」。路線**形狀**可以是平滑曲線，但必須是固定的（同一條路線每次相同、不隨個體或時間抖動），弧長等於引擎長度，所以速度仍是引擎的 17 mm/s；朝向取路徑切線；整體標「顯示插值／路線形狀示意」。細微的左右擺動（R133 的 1.1～1.7 mm 偏移）**不畫**，因為那是身體路徑統計，畫了就等於冒充模型 B。
- **中期（規則更新，另開 PR）**：依 #189 的方向把 KIN-2D（模型 A 或經證據審查的 B）以預設關閉的開關接入 P0-A2，往返時間由運動學決定；狀態框增加每隻巢外工蟻目前的**運動段**（起點姿態 x0、y0、θ0、v、ω、vl、t0、t1；KIN-2D 的等扭轉段）。畫面以閉式解求值：在任何時刻都是引擎位置，不是插值。前置條件：路線幾何（P1-B 共用幾何或明示合成路線）、Worker 白名單擴充（規則修改 PR，附邊界測試）、跨環境決定性（KIN-2D 使用 `Math.sin/cos/atan2`，需比照 #190 改用決定性數學或證明誤差界）、#144（鏡頭不改命運）。
- **對照頁**：`prototypes/natural-walk/` 的姿態串流（合成情境）可以作為「步態與轉向在有權威 ω 時看起來如何」的視覺驗收場景，標「合成情境／候選模型」，不得與 P0-A2 世界混在同一模式（CLAUDE.md §8 示範資料）。

## 5. 美術與規格文件的現況

| 文件 | 內容 | 與 P0 畫面線的關係 |
|---|---|---|
| [`game-art-style.md`](game-art-style.md) | 2.5D 俯視、mm 比例、放大規則「螞蟻放大顯示 ×N」、色彩（R99 淺褐至深褐）、11 層、本種外形（R99 比例；12 節觸角／3 節棒已由 R871、R870 核對，見 `antenna-geometry.md`，本文件 §9b／§10 的「待核對」是舊狀態）、步態、§5b 顯示微動作參數、引擎物件 vs 示意裝飾、光線與天氣只能用日值 | 保留為美術基準；本 P0 線在其上補「P0-A2 世界」與「地下視圖」 |
| [`game-render-system.md`](game-render-system.md) | 分層繪圖器、效能快照（已過期） | 沿用 |
| [`render-comparison.md`](render-comparison.md) | #159：A Canvas 2D／B 預旋轉／C PixiJS 同機交錯量測、正式畫面重測、實機量測頁 | 繪圖後端決策的資料（規格 §10） |
| [`visualization-architecture.md`](visualization-architecture.md) | 早期設計：三種資料、PixiJS 為「上千隻時」的選項 | 原則沿用 |
| [`visual-physics-integration-roadmap-2026-11-07.md`](visual-physics-integration-roadmap-2026-11-07.md) | Rapier（#101）與 PixiJS（#102）以可替換元件評估；Rapier 不是螞蟻大腦 | 原則沿用；#96 仍是 Draft |
| [`v62-experiment-mode.md`](v62-experiment-mode.md) | 實驗頁的資料分類、操作、驗證、P0-A2 §7 | P0 線的直接起點 |
| [`viewer-v6-game.md`](viewer-v6-game.md) | 重播遊戲畫面 | 參考 |

## 6. Roadmap 與需求中的可視化項目

| 項目 | 文件 | 狀態 |
|---|---|---|
| 舊 V1～V8（§3）、需求 §9.3 V1～V7 | `roadmap.md` §3、`requirements-and-plan.md` §9.3 | V1～V5 大致完成；V6「共用空間地圖＋巢內剖面（只畫引擎實際建立的巢室）」依賴 P1-B，未開始；「之後：更好的畫面（貼圖、光影、PixiJS）」 |
| V-P0a／V-P1（#96、#102） | `roadmap.md` §3a | #96 Draft 未合併；#102 開啟中 |
| V6 遊戲畫面（V6-1、V6-2a～d） | `roadmap.md` §3b | V6-1 已合併；V6-2a／2b 以 P0-A2 Worker 完成；**V6-2c（移動與接觸改由物理計算）未開始**；V6-2d（環境逐時演化）部分（日夜光照有，植物與半翅目沒有模型） |
| #159 渲染對照、#164 微動作、#189 行走模型 | GitHub | 渲染與微動作已合併；#189 授權收斂設計，運動學尚未接入 |
| #191 重播 UX Q5（手機控制列不得長期遮住約三分之一畫面，需實機驗收）、#192 第 3 項（實機 FPS） | GitHub | 未完成（需 Owner 實機） |

## 7. 完成／部分／缺 一覽

| 能力 | 狀態 | 依據 |
|---|---|---|
| 本種外形（小工蟻）向量資產、分節、比例 | 已完成 | `art-ant.ts`、R99／R870／R871 |
| 大工蟻外形 | 缺（刻意）：引擎沒有大工蟻（M18） | 規格 §5.6 只寫規格，不畫 |
| 六足交替三腳架步態 | 部分：有，但步頻依放大倍率變化、真實比例下過快、12 幀量化 | `art-ant.ts` `STRIDE`、`walkCycles` |
| 朝向取路徑切線、轉身緩動 | 部分：直線路線所以只有固定朝向；轉身緩動 ≤ 8 rad/s | `render-scene.ts` `planAnts` |
| 頭部與觸角微動作 | 部分：只在重播頁 | `display-motion.ts`；`v62.ts` 未傳 `micro` |
| 嗉囊飽滿的外觀 | 缺 | 引擎有 `crop_fill`，畫面只在小圖用填色 |
| 地表場景（土壤、落葉、石子、草、苔） | 已完成（示意） | `art-ground.ts`；實驗頁預設關閉裝飾 |
| 植物、寄主與半翅目外觀 | 部分（示意） | `art-props.ts`；P0-A2 的食源沒有植物或族群模型（M07） |
| 其他生物（蜘蛛、其他昆蟲、其他蟻群） | 缺（刻意）：未模擬（M08、M27） | 不畫，或只在「尚未模擬」清單說明 |
| 巢口土丘 | 部分（示意） | `art-props.nestEntrance` |
| 地下剖面 | 缺：只有「巢內（示意）」小圖 | `v62-p0a2-view.ts`；引擎沒有巢室幾何（M20） |
| 依引擎光照的日夜 | 部分：三段＋太陽高度分段，段間跳變 | `v62-p0a2-model.ts` `p0Light` |
| 天氣 | 部分：P0-A2 只有合成氣溫與濕度，沒有降雨（M05） | 不畫雨 |
| 縮放、平移、追蹤、速度、幀率上限 | 已完成 | `v62.ts` |
| 地表／地下切換 | 缺 | — |
| 手機控制列配置 | 部分：未經實機驗收（#191 Q5） | — |
| 物理軌跡驅動的顯示 | 缺：只有合成原型頁 | §4 |
| 繪圖後端決策 | 部分：無頭量測完成，實機缺 | `render-comparison.md`、#192 |
| 截圖比較流程（每階段與前一版並排） | 部分：各瀏覽器測試會產生功能截圖，但沒有固定鏡頭、固定時刻、前後版本並排的比較工具 | `tests/browser/*.check.cjs` |

## 8. 依賴

- **不依賴科學引擎就能做**（VIS-1～VIS-6、VIS-8）：全部只讀現有狀態框與事件，屬純可視化 PR；不改 Worker、不改 P0-A2 世界、不改規則指紋。
- **依賴科學引擎**（VIS-7 中期）：#189（行走模型）、#103（物理接入 Day0）、R2 矩陣 M21／M22、P1-B（#40，路線與巢口幾何）、#190（跨環境決定性數學）、#144（鏡頭不得改變命運）、Worker 白名單擴充（CLAUDE.md §9，規則修改 PR）。
- **依賴科學引擎才會出現在畫面上的內容**：真實巢室（P1-B）、蟻后與卵（M15）、幼體發育與蛹（M16、BP-1）、大工蟻（M18、CQ-1）、死亡與屍體（M17）、費洛蒙（M24、CHEM）、植物與半翅目族群（RU-3～RU-7）、降雨（M05、#151）。在那之前畫面只能不畫或標「尚未模擬」。
- **依賴 Owner 本人**：實機效能量測（#192 第 3 項）、手機控制列實機驗收（#191 Q5）、觀看驗收。

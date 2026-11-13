# 行走／接觸／交通候選的共用指標（#189、#193 裁示第 6 項）

> **地位**：隔離物理實驗工具。`engine/physics/candidate-metrics.ts` 不被每日循環、Day0、`cli/`、`web/` 引用（`tests/physics-isolation.test.ts`），也不呼叫任何解算器；正式引擎輸出不變（golden 逐位元組相同）。沒有推進遊戲日，沒有改存檔或日誌。
> **不宣稱**：指標只量測候選模型在物理與帳目上的後果，不是生物學驗證。本種沒有窄道交通、相遇讓路或流量資料（`docs/physics-destinations-traffic.md` §2）。

## 1. 用途

PH-3b（`solve2D`）、WP4（`steer2D`）、KIN-2D（`runKinematics`／`runKinematicsWithContactMode`）與之後的整合候選，都把輸出轉成通用紀錄（位置樣本、回報的接觸段、觀察者自行計算的間距樣本、抵達、目的地帳事件、個體狀態轉換），再交給本模組。它沿用 #158 的 `traffic-metrics.ts`（分布統計 `dist`），不取代它。

## 2. 指標與量測定義

| 指標 | 函式 | 定義 |
|---|---|---|
| 無穿透／漏接觸 | `auditContacts` | 觀察者**自己**在選定時刻計算的精確膠囊間距（不是解算器事件）。穿透＝間距 < −`penetration_tol_mm`；漏接觸＝間距 ≤ `contact_tol_mm` 但不在該對任何回報接觸段內（± `time_slack_s`）；接觸段內間距 > 容差＋`episode_gap_slack_mm` 記為 `phantom_samples`；沒有任何樣本落入的接觸段記為 `unsampled_episodes`（取樣稀疏，只供參考） |
| 吞吐量 | `throughput`、`admissionsOf` | 閉區間視窗內的抵達（或目的地帳的 `admit`）數 ÷ 視窗長度。抵達率**不是**選擇標準（#158） |
| 等待時間 | `waitingTimes` | 停滯：相鄰樣本平均速度 < `stall_speed_mm_s` 的時間（左矩形）；排隊：帳的 `queue` → `admit`；進場等待：排定 → 實際進場 |
| 迎面碰撞 | `classifyEncounters`、`headingAt` | 接觸段開始時兩身體朝向（有 θ 用 θ，否則用位移方向）的夾角：≥ `head_on_min_deg` 為迎面、≤ `same_direction_max_deg` 為同向、其餘為交叉；沒有朝向資料為 `unknown_heading` |
| 位置守恆 | `checkConservation`、`checkNoTeleport` | 每隻個體的狀態紀錄（`scheduled`／`waiting_entry`／`in_lane`／`queued`／`at_destination`／`released`／`turned_away`）。每次轉換後，每隻恰在一個狀態、總數不變、轉換屬於 `ALLOWED_EDGES`（例：`in_lane → released` 不合法＝跳過目的地帳，視為漏帳）、時間不倒退。不瞬移：相鄰樣本位移 ≤ v_max·Δt＋容差 |
| 分段決定性 | `compareOutputs` | 兩份輸出逐值比較：是否逐位元相同（`Object.is`，0 與 −0 不同）；不同時回報第一個不同的路徑、最大數值差、是否有結構差異。**不偷用容差**：呼叫端同時看到兩者 |
| 轉向統計 | `turningStatistics`、`resampleByArc` | 路徑依弧長每 `resample_ds_mm` 重新取樣，相鄰弦的朝向變化；rad/mm、總轉角、轉角 > `turn_threshold_rad` 的次數 ÷ 150 mm。這是**代理量**（ruling 9），`same_measure_as_R133: false`：R133 是人工在 5 mm 格紙上計數，原始影片不可得 |

`evaluateCandidate` 一次算出全部，並依 #158 的 `FAMILY_SCOPE` 規則標 `behavioural_conclusions_allowed`（只有依時間流入的比較為 `true`；同時進場壓力測試一律 `false`）。

## 3. 觀察門檻

所有門檻都是觀察者的選擇，必須以 `{ value, assumption: true, basis: '遊戲假設', note }` 傳入；沒有預設值，缺標籤即拒絕（`MetricsRefused`）。

## 4. 測試

`tests/k189-candidate-metrics.test.ts`（阻擋性）：每項指標的已知答案；輸入順序不影響結果；未標示的門檻被拒絕；真實生產者（KIN-2D 迎面兩隻）的接觸段與獨立取樣間距給出 0 穿透、0 漏接觸，刪掉回報的接觸段後稽核會報出漏接觸；迎面被分類為 head_on。

## 5. 尚未驗證

- 漏接觸稽核的靈敏度取決於觀察者取樣密度：取樣點之間的短暫擦身無法以取樣發現（生產者自己的連續碰撞偵測負責這部分）。
- 轉向代理與 R133 不同口徑（ruling 9）；不得用它宣稱與文獻相符。

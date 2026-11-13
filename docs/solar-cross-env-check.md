# 日出時刻的跨環境差異調查（Owner 決定 51）

> 狀態：§1～§6 是**調查報告＋規則 PR 提案**（歷史紀錄，保留不改寫其結論）；**§7 是依 Owner 決定 #190（#193 裁示，2026-11-12）實作方案 A 的紀錄**。不推進遊戲日；不改存檔、日誌或正式引擎。
> 調查結論：差異**不只影響顯示值**，在構造的情境下可以改變事件批次、順序與分類，因此**不定義比較容許值**，改提規則 PR（§6）。正式歷史目前不受影響（§4.4）。
> 實作結果（§7）：`engine/clock/solar.ts` 改用 `engine/clock/detmath.ts` 後，A1、A2、A3 全部 639 625 個值在 Node、Chromium 頁面與 Chromium Worker **逐位元相同**（0 個不同，沒有容許值）；與舊版 `Math.*` 結果最大差 3.9×10⁻¹² 分。**ARM64 未驗證**。

## 1. 問題

PR #169（P0-A2 Worker 執行環境，`docs/experimental-worker-runtime.md` §6）發現：種子 11、12、13 各 48 小時，17 937 個事件中有 3 個在 Node 與 Chromium Worker 之間不同，都是 `engine/clock/solar.ts` 算出的第 2 日日出時刻，相差 1 ulp（5.7×10⁻¹⁴ 分）。原因：`solar.ts` 用 `Math.sin/cos/tan/asin/acos`，ECMAScript 只要求「實作近似」，V8 在 Node 22.23 與 Chromium 153 的結果可差 1 ulp 以上。

要回答：(1) 是否改變事件分類；(2) 是否改變依日出／日落的決策；(3) 是否讓 Node 與 Worker 的歷史分岔；(4) 在時間邊界附近找反例。

## 2. 方法（`prototypes/solar-xenv/sweep.ts`；本節與 §3 的結果保存在 `prototypes/solar-xenv/out/sweep-v1-math-builtin.json`，方案 A 之後的結果見 §7）

- **A：跨環境掃描**（需 Playwright Chromium）。同一份 `engine/clock/solar.ts` 原始碼（只去掉型別註記，算術不變）分別在 Node 與真實 Chromium 頁面執行：
  - A1：實驗世界代表點（24.18°N、120.64°E、UTC+8）連續 4 年每天（1 461 天 × 5 個時刻）；
  - A2：緯度 −72°～72°（每 1°）× 6 個經度（−179.5、−120、0、60、120.64、179.5；時區取 round(經度/15) 小時）× 一年中每第 5 天（63 510 天 × 5）。
  - 每個不同的值都分類：ulp 數、精確時刻差、`tick` 模式標籤（10⁻⁶ 分格）是否不同、顯示分鐘／顯示精確值是否不同、兩值之間是否夾著整數分鐘（整點、逐分鐘事件）、某天是否只在一個環境被拒絕（`clockFail`）、兩組時刻在午夜（時鐘實際查詢光照狀態的時刻）給出的光照狀態是否不同。
- **B：合成實驗世界**（只用 Node）：`prototypes/continuous-world` 種子 1–20 × 30 天，計算每個光照轉換時刻與任何其他事件（個體、整點、日界）精確時刻的最小距離。
- **C：對抗反例**（只用 Node）：把 Node 值的相鄰雙精度數當作另一環境的值（A 量到的正是 1～數個 ulp），構造事件落在轉換時刻 10⁻⁹ 分以內的情形。

執行：`node prototypes/solar-xenv/sweep.ts`（約 4 分鐘）；`--no-browser` 只跑 B、C。

## 3. 結果（Node 22.23.4、Chromium 153.0.8010.12）

| 掃描 | 值 | 不同 | 最大 ulp | 最大差（分） | 最大精確時刻差（µs） | tick 標籤翻轉 | 顯示翻轉（分／精確） | 夾整數分鐘 | 拒絕翻轉 | 午夜光照狀態翻轉 |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 臺中代表點 4 年 | 7 305 | 168（2.3%） | 2 | 2.3×10⁻¹³ | 1.4×10⁻⁵ | 0 | 0／0 | 0 | 0 | 0 |
| A2 緯度×經度×日期 | 302 960 | 12 738（4.2%） | 320 | 1.1×10⁻¹² | 6.8×10⁻⁵ | 0 | 0／0 | 0 | 0（兩邊都拒絕 2 918 天） | 0 |

- A2 的 ulp 分布：1 ulp 10 031、2 ulp 743、3–16 ulp 1 949、17–128 ulp 14、>128 ulp 1。最大 320 ulp 在南緯 63°、1 月 16 日的曙光（太陽幾乎不到 −6°，acos 在 |cosH|≈1 附近放大誤差）。差異不只 1 ulp，也會被病態條件放大。
- B：20 個種子 × 30 天，光照轉換與其他事件的最小距離 3 842 µs（種子 9），比最大跨環境差 6.8×10⁻⁵ µs 大 5×10⁷ 倍。
- C（構造）：
  - **C1**：一個事件恰排在 Node 日出精確時刻 → Node 中與日出同一批（`light+other`）；以相鄰值代替時變成兩批、事件先於日出（`other | light`）。**批次組成與順序改變。**
  - C2：相鄰雙精度數之間沒有第三個數；事件在日出後 10⁻¹² 分則兩邊順序相同。只有「恰好等於其中一個值」才會落入窗口。
  - **C3**：在半個 tick 附近，兩個相鄰值的 `tick` 標籤不同（354.829176 與 354.829177 分）→ `tick` 相容模式下批次歸屬可以不同。
  - **C4**：以一組時刻查另一組的轉換值，光照狀態不同（`day` 對 `civil_twilight`）。

## 4. 判定

1. **事件分類**：掃描中 0 次（tick 標籤、顯示、拒絕、午夜狀態都沒有翻轉）。但 C1、C3、C4 證明**可以**：光照事件的分鐘值直接成為排程器的精確時刻（`exactOf`），1 ulp 就是不同的時刻；同時刻成批、`tick` 標籤、邊界上的狀態判定都可能因此改變。機率極小（A 的差 ≤ 6.8×10⁻⁵ µs），但不是零，也無法以比較測試證明永遠不發生。
2. **依日出／日落的決策**：目前**沒有**任何個體讀光照（實驗世界個體規則只讀自己與自己的亂數串流；`engine/clock` 不讀任何蟻群狀態，`tests/clock-isolation.test.ts`）。所以目前 0 個決策受影響。日後若 P0-A2 行為讀光照狀態，某個體決策時刻落在兩環境的轉換值之間（或恰等於其一）時，兩環境的決策會不同。
3. **Node 與 Worker 歷史**：**位元組層面已經分岔**——光照分鐘值、光照事件的精確時刻、`light_times` 狀態與 payload 雜湊都不同（PR #169 已記錄）。事件順序、個體狀態、亂數抽樣在 A、B 中相同。另一個情形：Node 取快照、Worker 還原後，之後各天的光照時刻由 Worker 計算，得到的歷史既不等於純 Node 也不等於純 Worker。
4. **正式歷史**：**目前不受影響**。`engine/clock` 不被正式管線（頂層 `engine/*.ts`、`cli/`、`web/src`）匯入，不在規則指紋內（`tests/clock-isolation.test.ts`）；正式推進只在 Node（CLAUDE.md §8）。但同一問題在 Node 版本之間也存在（V8 更換數學函式實作即可能差 1 ulp）：若 P0-A1 時鐘日後進入正式歷史，`.nvmrc` 換版就可能改變正式事件時刻。

**因此不是「只影響顯示」**：不寫比較容許值。在事件時刻上加容許值（例如「相差 ≤ 10⁻⁹ 分視為相同」）會把 C1、C3 的翻轉藏起來，等於放寬正式歷史的決定性要求，不採用。

## 5. 調查分支做了什麼（歷史紀錄；方案 A 之後的變更見 §7）

- `prototypes/solar-xenv/sweep.ts` 與 `out/sweep.json`：調查程式與結果（不被任何正式或實驗程式匯入）。
- `tests/solar-xenv.test.ts`（阻擋性，只用 Node）：B（種子 1–3 × 10 天）的最小距離 ≫ 量到的差；C1、C3、C4 反例可重現；光照時刻的使用者清單固定（新增使用者時測試會失敗，需對照本文件審查）；頂層 `engine/*.ts` 不引用 `engine/clock`。
- 沒有修改 `engine/clock/solar.ts`、排程器、實驗世界核心或任何規則。

### 5a. 新使用者審查：P0-A2 24 小時原型（#186，2026-11-12）

`prototypes/p0a2-24h/environment.ts` 與 `world.ts` 新增為光照時刻的使用者。依本文件審查如下：

- **用途**：
  - 每日四個光照轉換事件，時刻是 `Math.round(minute × 60000)` 整數毫秒，等於方案 B 的量化，格寬 1 ms；
  - 工蟻出巢決策在自己位置讀到的光照狀態 `lightStateAt`。
- **暴露**：
  - Node 與 Chromium 的光照時刻相差 1 ulp（約 10⁻¹³ 分）。只有當捨入前的值落在毫秒格界 ±1 ulp 內，事件時刻才會翻轉；機率約 10⁻¹³ ÷ (1/60000) ≈ 6×10⁻⁹／轉換。
  - `lightStateAt` 的 C4 型反例（在轉換值本身上狀態不同）只在事件時刻正好等於轉換分鐘值時發生。
  - 兩者都不為零，所以**不能**宣稱 Node 與 Worker 逐位元相同。
- **目前影響**：原型只在 Node 執行，正式歷史與 Day14 不受影響，Node 內的重播決定性不受影響。
- **第三階段要求**：接入實驗 Worker 之前，必須先依 §6 的 Owner 裁示（方案 A 或 A+B）解決，並以 Node 對 Chromium 的逐位元比較驗證，不得改用容許值。
- **更新（#190 方案 A，§7）**：光照時刻現在逐位元跨環境相同（x86-64 驗證）。原型的 `Math.round(minute × 60000)` 量化與 `lightStateAt` 讀到的轉換值因此在 Node 與 Chromium 相同；上面的「暴露」機率不再適用於已驗證的環境。原型 24 小時釘選雜湊不變（見 §7.5）。ARM64 未驗證。

### 5b. 新使用者審查：P0-A2 實驗 Worker 轉接層（#156 第三階段，2026-11-12）

`prototypes/continuous-world/worker/p0a2-world.ts` 新增為使用者：狀態框中的 `sun_altitude_deg`（`solarAltitude`）與「是否在太陽正午前」（`lightTimes().solar_noon`），**只供畫面**分段光照與陰影方向示意；沒有任何事件、決策或快照讀取它們。兩者都經 `engine/clock/detmath.ts`（§7），Node 與 Chromium 相同（x86-64）；即使將來不同，也只影響畫面亮度分段，不影響世界。P0-A2 世界本身的光照轉換與 `lightStateAt` 的審查見 §5a。Node 與 Chromium Worker 的 P0-A2 比較中唯一的差異是記錄的相對濕度（`weather-input.ts` 的 `Math.exp`），不是光照（`docs/experimental-worker-runtime.md` §9）。

## 6. 規則 PR 提案（調查時的提案；Owner 已於 #193 裁示採方案 A，實作見 §7）

目標：光照時刻在任何符合 ECMAScript 的環境（Node 各版本、瀏覽器 Worker、x86-64／ARM64）都**逐位元相同**，不放寬任何決定性要求。

**方案 A（建議）：跨環境決定性計算。** `solar.ts` 改用只含 IEEE 基本運算（+、−、×、÷，規格要求正確捨入）與 `Math.sqrt`（同上；`detmath.ts` 已用）的實作：
- sin／cos：Cody–Waite 角度縮減＋固定係數多項式（minimax，係數以十進位字面值寫死）；tan＝sin/cos；asin／acos：以 atan 恆等式＋多項式，或在 |x|→1 時用 sqrt 形式避免病態放大；
- 與目前 `Math.*` 版本比較：光照時刻差應在 NOAA 方法誤差（約 1 分）的 10⁻⁹ 以下；
- 測試：Node 與 Chromium（CI viewer-smoke）在 A1、A2 全部輸入上**逐位元相同**；再加上 x86-64 與 ARM64（若 CI 可用）；
- 影響：所有使用光照時刻的實驗世界輸出（P0-A1 時鐘、P0-A2 實驗世界）改變末位 → 提高實驗世界 `ENGINE_VERSION`、重產固定資料；正式歷史不變（`engine/clock` 不在正式管線）。

**方案 B：量化。** 把光照時刻以決定性方式捨入到粗格（例如整秒；NOAA 方法本身只準到約 1 分，整秒不損失科學資訊）。單獨使用**不足**：輸入若落在格點中央附近，1 ulp 仍會翻轉捨入（機率約 差/格寬 ≈ 10⁻¹² 分 ÷ (1/60 分) ≈ 7×10⁻¹¹，非零）。可與 A 合用，讓畫面與日誌的值穩定，但決定性靠 A。

**方案 C（不建議）**：由 Node 預先算好光照時刻表，Worker 只讀表。可行但讓 Worker 依賴預先產生的資料、無法任意日期／地點，且仍不解決 Node 版本間的差異。

**不做的事**：比較時加容許值、只在 Worker 裡「修正」數值、改用 `Math.fround` 等降精度——都不能保證跨環境相同，或會改變事件時刻卻不留紀錄。

需要 Owner 決定：採用 A（或 A＋B）、量化格寬（若採 B）、是否要求 ARM64 也逐位元相同、P0-A1 時鐘進入正式歷史前是否以此為前提。

## 7. 實作紀錄：方案 A（Owner 決定 #190，#193 裁示，2026-11-12）

> 規則更新（實驗世界）：不推進遊戲日；正式引擎、規則指紋、存檔與日誌都不變。

### 7.1 裁示內容
- 採方案 A：在 `engine/clock/solar.ts` 以固定、跨環境決定性的演算法計算光照時刻；只用 IEEE 基本運算（+、−、×、÷）與 `Math.sqrt`（ECMAScript 規格要求正確捨入）。三角函數以 Cody–Waite 角度縮減＋固定係數多項式（係數寫成十進位字面值）；asin／acos 以恆等式＋多項式，|x|→1 時用 sqrt 形式。
- **不使用任何容許值比較**。以 Node 對 Chromium Worker 在既有掃描全部輸入（含轉換邊界與 #181 反例）**逐位元相同**驗證。
- 要包含 ARM64 驗證；CI 目前沒有 ARM64，所以明確記為「**ARM64 未驗證**」，不宣稱。
- 這是 `engine/clock` 進入正式歷史、以及 P0-A2 宣稱跨環境一致的前提條件。
- 若方案 A 無法達到逐位元相同：不得放寬，改寫錯誤／影響報告並停止（A＋B 只在報告中提出）。**本次已達成，不需要此路徑。**

### 7.2 演算法（`engine/clock/detmath.ts`）
- `detSin`、`detCos`：Cody–Waite 縮減 x = k·(π/2) + r。π/2 拆成三段（fdlibm `e_rem_pio2.c` 的 `pio2_1`、`pio2_2`、`pio2_3`，前兩段 33 個有效位元，|k| < 2²⁰ 時 k·P₁、k·P₂ 精確）；k = Math.round(x·2/π)（`Math.round` 規格精確）。|r| ≤ π/4 上用 fdlibm `k_sin.c`／`k_cos.c` 的 minimax 係數（十進位字面值，各引擎解析成同一個 double）。引數上限 |x| ≤ 1.6×10⁶（超過即拒絕，不靜默）；本模型最大引數約 600 弧度。
- `detTan` = sin／cos（只用於 ε/2 ≈ 11.7°，遠離極點）。原本的 `Math.tan(...) ** 2` 也改成 `t * t`（`**` 同樣是實作近似）。
- `detAsin`、`detAcos`：fdlibm `e_asin.c`／`e_acos.c` 的有理近似 R(z) = z·P(z)/Q(z)；|x| < 0.5 直接用；|x| ≥ 0.5 用半角 sqrt 形式（1 − |x| 在 |x| ≥ 0.5 時精確，Sterbenz 引理），避免 |x|→1 時的病態放大；定義域外回傳 NaN（與 `Math.asin/acos` 相同語意）。
- 精度（與 V8 `Math.*` 比較，±1000 弧度隨機 2×10⁶ 點）：sin、cos 絕對差 ≤ 1.1×10⁻¹⁶；tan ≤ 3 ulp；asin ≤ 2 ulp；acos ≤ 1 ulp。是工程程式，不是模型參數；NOAA 方法本身的誤差約 1 分（R390），不受影響。
- 為什麼決定性：每一步只有「規格規定唯一結果」的運算（基本四則、`Math.sqrt`、`Math.round`、`Math.abs`、`%`、十進位字面值）；`Math.PI` 是規格固定的常數。沒有任何實作近似的 `Math` 函式（`tests/solar-xenv.test.ts` 掃描原始碼）。
- 放在 `engine/clock/`：P0-A1 時鐘與實驗 Worker 都能匯入（`engine/clock/` 已在 `worker-boundary.json` 白名單；`tests/clock-isolation.test.ts` 的 clock 模組匯入清單加入 `./detmath.ts`）。實驗 Worker 個體規則用的 `prototypes/continuous-world/worker/detmath.ts`（detLog 等）不變。

### 7.3 驗證結果（Node 22.23.4、Chromium 153.0.8010.12，linux-x64；`prototypes/solar-xenv/out/sweep.json`）

| 掃描 | 案例 | 比較的值 | Node vs Chromium 頁面 不同 | Node vs Chromium Worker 不同 | 拒絕翻轉 | 兩邊都拒絕 |
|---|---|---|---|---|---|---|
| A1 臺中代表點 4 年 | 1 461 | 7 305 | 0 | 0 | 0 | 0 |
| A2 緯度×經度×日期 | 63 510 | 302 960 | 0 | 0 | 0 | 2 918 |
| A3 高緯轉換邊界（±60°～±72°，0.1°，每日） | 88 330 | 329 360 | 0 | 0 | 0 | 22 458 |

- 合計 153 301 個案例、639 625 個值，三個環境**逐位元相同**（`Object.is`），SHA-256 摘要（IEEE 位元型樣）三方相同。
- A3 是新增的邊界集：高緯度上曙光／日出解出現與消失的日期（|cos H|→1、acos 病態、拒絕邊界），包含舊版 320 ulp 最大差所在的條件。
- 舊版的差異與反例輸入逐一列出（`spotlight`）：#181 C1／C3／C4 的輸入（實驗世界第 1 日日出，2026-03-27）、舊 A1 最大差（2027-09-03 曙光）、舊 A2 最大差（南緯 63°、2026-01-16 曙光，320 ulp）——三個環境都逐位元相同。
- 實驗 Worker（`tests/browser/worker-runtime.check.cjs`，種子 11、12、13，各 48 小時）：17 937／17 937 個事件、3／3 個 48 小時狀態逐位元組相同（PR #169 的 3 個不同事件已消失）。原本光照時刻的誤差界（10⁻⁹ 分、10⁻³ µs）**已移除**，改為嚴格相等。
- `tests/solar-xenv.test.ts`（阻擋性，Node）：讀取上述真實 Chromium 執行的紀錄，要求 0 個不同；並在 Node 重新計算 A1～A3，摘要必須等於紀錄的 Chromium 摘要（`solar.ts`／`detmath.ts` 改變任何位元都會失敗，直到重新以 Chromium 掃描並記錄）。
- C1、C3、C4 反例仍保留並可重現：它們說明「1 ulp 不只影響顯示」，這正是要求逐位元相同、不用容許值的理由。

### 7.4 與舊版（`Math.*`）的差異
- A1～A3 全部 639 625 個值：36 002 個（5.6%）末位不同，**最大差 3.9×10⁻¹² 分**（南緯 71°、2026-05-19 日落），遠小於 NOAA 方法誤差（約 1 分）的 10⁻⁹（即 6×10⁻¹⁰ 分）；0 個拒絕翻轉。A1（實驗世界代表點）：75／7 305 個不同，最大 2.3×10⁻¹³ 分，第一個不同在 2026-04-21（世界第 26 日）。
- `tests/p0a1-24h-clock.test.ts`：轉換時刻的太陽高度自洽誤差 1.1×10⁻¹⁰°（門檻 10⁻⁶°），與 USNO 曆書演算法的差 ≤ 0.199 分，結果同前。

### 7.5 版本與雜湊
- 實驗世界 `ENGINE_VERSION`：`experiment-world-runtime/1` → `experiment-world-runtime/2`（`prototypes/continuous-world/worker/params.ts`）。理由：光照時刻在第 26 日之後的末位改變；舊版快照若在新版還原，之後各天會得到「既非舊版也非新版」的混合歷史，所以以 `ENGINE_MISMATCH` 拒絕。
  - 規則指紋（`RULES_FINGERPRINT`）：`269810bd1ab9633e70617fa6b5ecf5a7f9206181be4726764216881c3af97fc0` → `90ccff0fee7331f675bef995cb970f15ef7d2830e07da8ebeed09c4fc4031fee`。
  - `tests/worker-runtime.test.ts` 的 48 小時狀態雜湊（種子 11）：`1be68441…7517ec` → `539dbf1d…c34c384`；只因 `engine_version` 欄位改變（以新演算法、舊版本字串計算時雜湊與舊版相同：前 48 小時的光照時刻逐位元未變）。這兩個值沒有釘選在測試中，僅記錄。
- P0-A2 24 小時原型（`tests/p0a2-24h-proto.test.ts`）的釘選雜湊**不變**（log `7d6e43af…187d85`、state `eeae295c…e8582f`）：該情境的光照事件（量化到整數毫秒後）在新舊版相同。原型沒有自己的版本字串。
- P0-A1 時鐘（`engine/clock`）沒有釘選雜湊；不在正式規則指紋內。
- 正式引擎：輸出逐位元組不變（`tests/golden.test.ts` 未改、通過）；頂層 `engine/*.ts` 仍不引用 `engine/clock`。

### 7.6 未驗證事項
- **ARM64 未驗證**：CI 與本次執行都只有 x86-64（linux-x64）。演算法只用規格規定唯一結果的運算，理論上 ARM64 也應相同，但這是推論，不是驗證；在 ARM64 上執行 `node prototypes/solar-xenv/sweep.ts` 與 `node tests/solar-xenv.test.ts` 之前不得宣稱。
- 其他瀏覽器引擎（Firefox、Safari）未驗證；Node 其他版本未驗證（只有 `.nvmrc` 的 22.23.4）。
- `Math.sqrt` 的正確捨入依規格；本次以三環境結果相同作為實測佐證。

### 7.7 回滾
- 還原本次提交即可：`solar.ts` 回到 `Math.*`、刪除 `detmath.ts`、`ENGINE_VERSION` 回到 `/1`、`sweep.json` 回到 v1 紀錄。回滾後 §3 的跨環境差異會重新出現，P0-A2 不得宣稱跨環境一致，`engine/clock` 進入正式歷史的前提也不再成立。實驗世界 `/2` 的快照在回滾後會被拒絕（`ENGINE_MISMATCH`）；正式存檔與日誌不受影響。

## 8. 規則更新 detmath-exp：決定性 `exp`／`log`／`**`（方案 A 的延伸，2026-11-12）

### 8.1 問題
方案 A（§7）只處理三角函數。`Math.exp`／`Math.log`／`**`（`Math.pow`）同樣是 ECMAScript 的「實作近似」函式，Worker 匯入圖中仍在使用：

| 位置 | 用途 | 是否被決策讀取 |
|---|---|---|
| `engine/clock/weather-input.ts` `saturationVapourKPa`（`Math.exp`） | P0-A2 記錄的 `rh_percent`；FAO-56 飽和水氣壓 | 只記錄（日誌與事件鏈涵蓋它） |
| `engine/clock/weather-input.ts` 夜間降溫分支（`Math.exp`）、白天分支（`Math.sin`） | 由日最低／最高溫重建逐時氣溫（`WeatherSeries`，P0-A1 時鐘） | 氣溫是決策輸入（目前 Worker 世界未使用此分支） |
| `prototypes/p0a2-24h/world.ts`（`Math.log(1 − g())`，兩處） | 指數分布的休息／活動時長 | 是（事件時刻） |
| `prototypes/p0a2-24h/decision.ts` `hill`（`s ** n`） | 反應門檻 | 是（任務選擇機率） |

實測（PR #209，head 8592c8a，x64 Linux、Node 22.23.4 vs. Chromium 153.0.8010.12）：`tests/browser/worker-runtime.check.cjs` 兩個種子 48 小時 42 480 個事件中 12 個 `env_sample` 的 `rh_percent` 差 1 ulp（最大 1.4×10⁻¹⁴ %），整份 payload 0／2 相同；瀏覽器推進 26.2 小時的 P0-A2 存檔交給 `npm run verify:save` → `mismatch`（`CHAIN_MISMATCH`＋`STATE_MISMATCH`）。同一批輸入上，引擎內建函式在 Node 與 Chromium 之間的差異（本次掃描，§8.4）：`Math.exp` 14 961／180 035、`Math.log` 2 939／165 035、`Math.pow` 5 348／80 000、`Math.sin` 2 017／60 000 個結果位元不同。

### 8.2 演算法（`engine/clock/detmath.ts`）
- **`detExp`**：fdlibm 5.3 `e_exp.c` 逐行移植。以 ln 2 分成高低兩段（`k·ln2_hi` 精確）約化到 |r| ≤ ½ln 2，再用 fdlibm 的 5 項 minimax 有理式；乘 2ᵏ 以位元型樣建構的 2 的冪做精確乘法（等同 fdlibm 直接加指數欄位）。只用 ＋−×÷、`Math.trunc` 與 `DataView`（大端序、規格完全規定）讀寫 IEEE-754 位元。
- **`detLog`**：fdlibm 5.3 `e_log.c` 逐行移植。以位元取出指數與尾數，把尾數正規化到 [√2/2, √2)，以 s = f/(2+f) 的 7 項多項式（Lg1～Lg7）計算；次正規數先乘 2⁵⁴（精確）。
- **`detPowInt(x, n)`**：整數指數用二進位快速冪（固定次序的正確捨入乘法）；n = 2 就是 x·x，與 `x ** 2` 在 Node 中的結果相同。
- **`detPow(x, y)`**：整數 y → `detPowInt`；否則 x > 0 時 `detExp(y·detLog(x))`。**不是** fdlibm `e_pow.c` 的移植：相對誤差約 (|y·ln x|＋2)·2⁻⁵²，足以用於模型曲線（測試驗證此界）。目前 P0-A2 的 `hill_n = 2`，走整數路徑。
- 特殊值（與 fdlibm／`Math.*` 一致）：`detExp`：NaN→NaN、+∞→+∞、−∞→+0、x > 709.782712893384 → +∞、x < −745.1332191019411 → +0、結果低於 2⁻¹⁰²² 為次正規數、|x| < 2⁻²⁸ → 1＋x。`detLog`：±0→−∞、負數→NaN、NaN→NaN、+∞→+∞、1→+0。`detPowInt` 非整數指數拋出例外；`detPow`：NaN→NaN、0^(y>0)=0、0^(y<0)=+∞、負底數配非整數指數→NaN。
- 已知差異：`detExp(1) = 2.7182818284590455`（fdlibm 原樣，比 `Math.E` 高 1 ulp）。為保持「移植而非新演算法」不特例處理。
- NaN：ECMAScript 只有一個 NaN 值；其位元型樣由實作決定，跨入瀏覽器時會被正規化，因此比較時所有 NaN 記為 `NaN`（不影響任何可觀察的計算；JSON 也把 NaN 寫成 `null`）。

### 8.3 取代與靜態規則
- `weather-input.ts`：`Math.exp`（兩處夜間分支、一處 `saturationVapourKPa`）→ `detExp`；`Math.sin`（白天分支）→ `detSin`。
- `prototypes/p0a2-24h/world.ts`：`Math.log(1 − g())` → `detLog(1 − g())`；`decision.ts` `hill`：`**` → `detPow`。`decision.ts` 的局部性靜態檢查（`tests/p0a2-24h-proto.test.ts`）放行**且只放行**從 `engine/clock/detmath.ts` 以具名方式匯入 `detExp`／`detLog`／`detPow`／`detPowInt`（無狀態純數學；新增 3 個負面樣本：匯入 `solar.ts`、匯入 detmath 的其他名稱、命名空間匯入都會被抓到）。
- **新靜態規則**（`prototypes/continuous-world/worker-boundary.json` 的 `deterministic_math_in_worker_graph`，由 `tests/lib/worker-boundary.ts` 檢查、`tests/worker-boundary.test.ts` 執行）：Worker 匯入圖中每個模組只能以 `Math.<白名單成員>` 使用 Math（abs、ceil、clz32、floor、fround、imul、max、min、round、sign、sqrt、trunc 與常數；`Math.random` 另有禁止），`**` 只能接非負整數字面值。`Math['cos']`、`const { exp } = Math`、`Math.pow`、`x ** n`、`x ** 0.5`、`x ** -2` 都有負面樣本。
- 合成實驗世界自己的 `prototypes/continuous-world/worker/detmath.ts`（`detLog` 以 atanh 級數、只用基本運算，早已決定性）保持不變，以免改變合成世界的輸出；P0-A2 與 `engine/clock` 使用 `engine/clock/detmath.ts` 的 fdlibm 版本。
- 唯一豁免：`engine/rng.ts` 的 `normal`／`gamma`（正式日引擎的抽樣器，受黃金測試保護，本 PR 不修改）。規則檢查 Worker 匯入圖中沒有模組匯入這兩個名稱、沒有以命名空間匯入或轉出整個模組，而且 `rng.ts` 其他部分不呼叫它們（各有負面樣本）。

### 8.4 驗證（x64 Linux、Node 22.23.4、Chromium 153.0.8010.12 headless）
- **精確度**（`tests/detmath-explog.test.ts`，阻擋性）：以 BigInt 定點（256 位小數；ln 用 atanh 級數、exp 用 ln 2 約化＋泰勒級數）的獨立高精度參考值比較。`detExp` 7 007 個輸入（正規結果）最大誤差 0.829 ulp、90.0 % 正確捨入；`detLog` 7 504 個輸入最大 0.753 ulp、97.0 % 正確捨入（皆低於 fdlibm 宣稱的 1 ulp）。參考值自檢：ln 2、ln 10、e 都捨入到對應的 IEEE 值。特殊值與門檻逐一斷言。
- **跨環境逐位元相同**（`tests/browser/detmath-xenv.check.cjs`，CI 瀏覽器步驟）：Node 執行 TypeScript 原始檔（驗證器使用的路徑），Chromium 頁面與 Chromium 模組 Worker 執行建置後的 `web/worker-dist/engine/clock/detmath.js`（實驗 Worker 匯入的同一檔）。`detExp` 180 035、`detLog` 165 035、`detPow` 80 000、`detPowInt` 40 000、`detSin`／`detCos` 各 60 000 個輸入：**0 個位元不同**（輸入涵蓋整個有限範圍、所有指數含次正規數、溢位／下溢門檻、約化邊界、P0-A2 實際使用的範圍）。對照：同批輸入上引擎內建 `Math.*` 的差異見 §8.1。
- **P0-A2 世界**（`tests/browser/worker-runtime.check.cjs`，已收緊）：種子 11、12 各 48 小時，Node vs. Chromium Worker 42 480／42 480 個事件、P0-A2 日誌雜湊鏈 2／2、事件鏈 head 2／2、整份 payload 2／2 **逐位元組相同**。原本的 `rh_percent`（10⁻⁹ %）與 `chain.head` 例外**已移除**——任何差異都會失敗。
- **Worker 推進、Node 驗證**（`tests/browser/save2-acceptance.check.cjs` 新增段落）：在 Chromium Worker 以 3600× 推進新世界（種子 424242）到 ≥ 26 小時（實測 t = 94 032.577 s，13 155 個鏈事件，跨過日落、夜間與日出），手動存檔、由選單匯出，`node cli/verify-save.ts` → **`node_verified`**（exit 0，差異欄位 0，輸入檔未改）。同一段檢查在本 PR 之前的程式（8592c8a）上執行：`mismatch`（`CHAIN_MISMATCH`＋`STATE_MISMATCH`，exit 1）。
- **Node 中的行為**：fdlibm 移植在 Node 中與 V8 的 `Math.exp`／`Math.log` 幾乎相同（30 萬個隨機輸入 0 個不同；唯一已知差異是 x = 1），`x ** 2` 與 x·x 相同。因此 P0-A2 在 Node 的輸出**逐位元組不變**：20 個種子 × 72 小時、571 021 個事件（去掉版本／指紋欄位）0 個不同，20／20 個狀態相同；`tests/p0a2-24h-proto.test.ts`（log `0ca01939…`）與 `tests/save-verify.test.ts`（事件 `1107894c…`、狀態 `292c59fa…`、payload `672229a6…`）的行為釘選值不需更動。沒有任何決策改變。
- **`WeatherSeries` 日值重建分支**（P0-A1 時鐘原型，Node；目前不在 Worker 世界的執行路徑上）：`detSin` 與 V8 的 `Math.sin` 在 [0, π] 約 10.7 % 的輸入末位不同。27 組形狀係數 × 38 天 × 每分鐘：1 477 440 個氣溫值中 19 073 個（1.3 %）改變，最大 2 ulp（7.1×10⁻¹⁵ °C）；相對溼度 15 591 個（1.1 %），最大 7.1×10⁻¹⁴ %。P0-A1 測試以容許值（10⁻⁹）比較，全部通過；沒有釘選雜湊。

### 8.5 版本與雜湊
- `P0A2_CODE_SHA256`（`node prototypes/continuous-world/tools/p0a2-code-hash.ts --write`）：`9bcaac24…57d7b6` → `b5645457…e835d5b`；P0-A2 規則指紋 `00f8dff2…52f669` → `b235ca1b…91cdc7de`。依 P0-A2 的既有慣例（`docs/experimental-worker-runtime.md`：修改行為檔後重新產生程式碼雜湊，舊存檔以 `FINGERPRINT_MISMATCH` 拒絕、原樣保留、可匯出），**不**另改 `experiment-p0a2-24h/1` 引擎版本字串：程式碼雜湊已在規則指紋內，舊存檔不會在新規則下默默接續；改版本字串反而會讓執行期把舊 P0-A2 快照分派給合成世界，產生誤導的錯誤訊息。
- 因指紋改變，P0-A2 種子 7 的 48 小時事件鏈 head `b4992964…3c9` → `041176d0…f333`、payload SHA-256 `d39cb4dc…bfb2` → `16aeca6b…da28`（未釘選，`tests/save-verify.test.ts` 只輸出；鏈內每個事件帶有規則指紋）。
- 合成實驗世界（`experiment-world-runtime/2`）：不經過任何被修改的函式，輸出、規則指紋與釘選值全部不變。
- 正式引擎：未修改（`engine/rng.ts` 的 `normal`／`gamma` 保留 `Math.*`），`tests/golden.test.ts` 逐位元組通過。

### 8.6 已驗證／未驗證環境
- **已驗證**：x64 Linux，Node 22.23.4（`.nvmrc`）＋ Playwright Chromium 153.0.8010.12（headless，頁面與模組 Worker）。
- **未驗證**：ARM64（沒有執行環境）、Firefox、Safari、其他 Node 版本、實體手機瀏覽器。演算法只用規格規定唯一結果的運算，理論上這些環境也應相同，但這是推論，不是驗證；在這些環境執行 `tests/browser/detmath-xenv.check.cjs` 與 `tests/browser/worker-runtime.check.cjs` 之前不得宣稱。

### 8.7 回滾
還原本次提交：`detmath.ts` 移除 `detExp`／`detLog`／`detPow`／`detPowInt`，`weather-input.ts`、`world.ts`、`decision.ts` 回到 `Math.*`／`**`，`P0A2_CODE_SHA256` 回到舊值，靜態規則與收緊的瀏覽器檢查一併還原。回滾後 Node 中的 P0-A2 輸出不變（逐位元組相同），但瀏覽器產生的 P0-A2 存檔重新無法通過 Node 驗證（§8.1），`docs/save-format-v2.md` §5b 的已知限制恢復。本版產生的 P0-A2 實驗存檔在回滾後以 `FINGERPRINT_MISMATCH` 拒絕（原樣保留、可匯出）；正式存檔與日誌不受影響。

## 附註（2026-11-13，#213 Q2 b；只新增）

新增光照消費者 `engine/clock/surface-temperature.ts`（SURF-0 地表溫度候選）：只把 `solarAltitude()` 當作模型值的連續輸入，不產生任何事件、批次或光照狀態邊界；只用 `detmath.ts` 與 IEEE 基本運算；沒有任何模組匯入它。已在 `tests/solar-xenv.test.ts` 的消費者清單登錄。它的輸出跨環境逐位元相同的前提是**相同的氣溫輸入**；`WeatherSeries.temperature` 已由 §8（#211）改用 `detSin`／`detExp`，但 SURF-0 本身的跨環境掃描尚未執行（只以 Node 測試）。

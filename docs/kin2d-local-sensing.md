# 局部化學感測介面契約（KIN-2D 後續）

> **地位**：隔離模組 `engine/physics/local-sensing.ts`，**非正式**；正式管線不匯入（`tests/physics-isolation.test.ts`）。**CHEM 尚未接入**：CHEM-0／1（PR #140／#141）仍在審查，本模組只對齊其 `sampleLocal` 的名稱並宣告轉接器，沒有建立任何 CHEM store。
> **測試**（阻擋性）：`tests/local-sensing.test.ts`。

## 1. 契約
- **唯一入口** `sampleLocal(sampler, request)`：先驗證，再向取樣器做局部讀取。沒有任何讀取整個場的方法；合成場的資料是私有欄位。
- **請求必填**：個體 ID、模擬時刻（秒）與同時刻輪次 `round`（對應 CHEM `ChemTime`）、個體**實際身體姿態**與觸角幾何、感測點、空間圖層、訊號通道、感測半徑（有界；0＝點取樣）、預期來源、假設標籤（`assumption`、根據類型、說明）。
- **感測點**必須**恰好**是由實際姿態與觸角幾何算出的兩個觸角尖端（`antennaSensors`）；其他點一律拒絕（`SENSOR_NOT_FROM_POSE`），所以不能讀遠處。
- **不讀未來**：請求時刻必須 ≤ 該通道與圖層已提交沉積的時刻（`FUTURE_SAMPLE`）。
- **不靜默替代**：請求的來源必須等於取樣器的來源（`SOURCE_MISMATCH`）；訊號缺失（未知通道、其他圖層、沒有已提交資料、CHEM 拒絕）一律丟出 `MISSING_SIGNAL` 錯誤，**沒有**任何退回合成場的程式路徑。
- **來源記錄**：結果帶 `source` 與 `synthetic`；模型 C 的 `WalkPlan.sensing` 與每筆 `sensor_samples[].source` 記錄來源。已提交的姿態串流（`antempire.pose-stream.v1`）位元組不變，其中 `chem_field.synthetic`、`sensor_samples[].synthetic` 已標示合成來源。

## 2. 實作
| 實作 | 來源 | 用途 | 狀態 |
|---|---|---|---|
| `SyntheticChemicalField` | `synthetic` | 測試與可重播的合成實驗；高斯脊（不是費洛蒙模型），點取樣（max_range 0 mm），宣告提交到 `committed_through_s` | 使用中（模型 C 預設） |
| `ChemLocalFieldAdapter` | `chem_local_field` | 把請求轉成 CHEM-1 `SampleQuery`（`signal_id`、`agent_id`、`layer`、`time {clock, unit:'s', t_s, round}`、`phase:'local_sensing'`、`sensor {kind:'disc', x_mm, y_mm, radius_mm}`），讀 `exposure` 與 `detectable`；已提交時刻取自 CHEM 的 `horizon` | **只有宣告**（`integrated = false`），以假 store 測試 |

## 3. 模型 C 的重構與「逐位元相同」證明
- `planWalk` 的模型 C 只經 `sampleLocal` 取得濃度（測試以原始碼檢查與注入的監看取樣器雙重確認）；未提供取樣器時，以 `spec.field` 建立 `SyntheticChemicalField`。觸角尖端與高斯脊的計算式**原樣搬進** `local-sensing.ts`，`natural-walk.ts` 的 `antennaTips`、`fieldValue` 改為呼叫它們。
- **證明**：重構**之前**先計算 750 次執行（A／B／C × 去回程 × 75 隻，加 Δc 0.01／0.05／0.1 與起點 ±5 mm 的 C）的計畫段、事件、截斷、抵達與感測值的 SHA-256（`tests/lib-walk-digest.ts`），記為 `b8a3fe6b…`；重構後相同。`docs/physics-kinematics2d.md` §8 的原始失敗表與四個姿態串流也仍逐字／逐位元相同。

## 4. 假設與未決
- 觸角幾何（長度、半角）、點取樣、雙側比較都是 `assumption: true`（遊戲假設；機制方向只有非本種 R810）。每次請求都附這些標籤。
- CHEM 只允許在**剛好**已關閉的 horizon 讀取（之前是 `STALE_SAMPLE`、之後是 `FUTURE_SAMPLE`）；本契約允許 ≤ 已提交時刻。接入時兩者的差異要由排程器（每個控制時刻先推進 CHEM 再取樣）解決，目前任何 CHEM 拒絕都會變成錯誤，不會被吞掉。
- CHEM 的取樣是格子層級的暴露量總和（不做面積加權），與合成場的點值不同量綱；接入後模型 C 的增益與 floor 都要重新評估，不能沿用。

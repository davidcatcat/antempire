# 局部化學感測介面契約（KIN-2D 後續）

> **地位**：隔離模組 `engine/physics/local-sensing.ts`，**非正式**；正式管線不匯入（`tests/physics-isolation.test.ts`）。**CHEM 尚未接入**：CHEM-0／1（PR #140／#141）仍在審查，本模組只對齊其 `sampleLocal` 的名稱並宣告轉接器，沒有建立任何 CHEM store。
> **測試**（阻擋性）：`tests/local-sensing.test.ts`。

## 1. 契約
- **唯一入口** `sampleLocal(sampler, request)`：先驗證，再向取樣器做局部讀取。沒有任何讀取整個場的方法；合成場的資料是私有欄位。
- **請求必填**：個體 ID、模擬時刻（秒）與同時刻輪次 `round`（對應 CHEM `ChemTime`）、個體**實際身體姿態**與觸角幾何、感測點、空間圖層、訊號通道、感測半徑（有界；0＝點取樣）、預期來源、假設標籤（`assumption`、根據類型、說明）。
- **感測點**必須**恰好**是由實際姿態與觸角幾何算出的兩個觸角尖端（`antennaSensors`）；其他點一律拒絕（`SENSOR_NOT_FROM_POSE`），所以不能讀遠處。
- **統一因果讀取契約（Owner 決定 43；名稱對齊 CHEM-1b，分支 `claude/ant-empire-engine-refactor-i45q93-chem1b-sampling` 的 `aba070a`）**：
  - **即時決策**只能用 `sampleLocal(reader, request)`：只讀**最新已提交狀態**，且感測時刻必須**等於**該狀態的提交時刻——尚未提交 → `FUTURE_SAMPLE`；已有更新的狀態 → `STALE_SAMPLE`（與 CHEM-1b `ChemStore.sampleLocal` 規則相同）。結果標 `read_kind: 'realtime_latest_committed'`，**分開記錄**感測時刻 `sensing_time` 與所讀狀態的提交 `state_commit {seq, time}`。
  - 決策程式只持有 `RealtimeSensingReader`（對應 CHEM-1b `ChemRealtimeReader`）：只有 `latestCommitted` 與局部讀取，沒有歷史、沒有提交（`advance`），且凍結。**提交狀態是排程器的工作**（`WalkSpec.scheduler`；預設合成場由 `planWalk` 以排程器身分在每個控制時刻先提交再感測），不是螞蟻的能力。
  - **歷史查詢**只能用另一個診斷 API `sampleHistorical(source, capability, query)`（對應 CHEM-1b `sampleHistorical(cap, q)`）：需要不可偽造的 `createDiagnosticCapability(purpose)`（replay／diagnosis／reconstruction），查詢**不帶個體與姿態**（不是感測行為），結果 `view: 'diagnostic_history'`、`decision_use: 'forbidden'`，記錄 `covered_by_commit`、`exact_commit_instant`、`queried_at_horizon`。`assertRealtime()`（模型 C 每次取樣都呼叫）拒絕任何非即時結果。
- **不靜默替代**：請求的來源必須等於取樣器的來源（`SOURCE_MISMATCH`）；訊號缺失（未知通道、其他圖層、沒有已提交資料、CHEM 拒絕）一律丟出 `MISSING_SIGNAL` 錯誤，**沒有**任何退回合成場的程式路徑。
- **來源記錄**：結果帶 `source` 與 `synthetic`；模型 C 的 `WalkPlan.sensing` 與每筆 `sensor_samples[].source` 記錄來源。已提交的姿態串流（`antempire.pose-stream.v1`）位元組不變，其中 `chem_field.synthetic`、`sensor_samples[].synthetic` 已標示合成來源。

## 2. 實作
| 實作 | 來源 | 用途 | 狀態 |
|---|---|---|---|
| `SyntheticChemicalField` | `synthetic` | 測試與可重播的合成實驗；靜態場（高斯脊，或**零訊號對照場** `zero_signal`；不是費洛蒙模型），點取樣（max_range 0 mm）。靜態場的值不隨時間變，但狀態仍由排程器一個時刻一個時刻提交（`advance`），所以即時規則與 CHEM 相同；保留提交歷史供診斷查詢 | 使用中（模型 C 預設） |
| `ChemLocalFieldAdapter` | `chem_local_field` | 包裝 CHEM-1b `ChemRealtimeReader`（`latestCommitted()`、`sampleLocal(q)`）：請求轉成 `SampleQuery`（`signal_id`、`agent_id`、`layer`、`time {clock, unit:'s', t_s, round}`、`phase:'local_sensing'`、`sensor {kind:'disc', x_mm, y_mm, radius_mm}`），讀 `exposure`、`detectable`；提交取自 CHEM 的 `latestCommitted()`。CHEM 的歷史 API 不包裝（決策不需要） | **只有宣告**（`integrated = false`），以假 reader 測試 |

## 3. 模型 C 的重構與「逐位元相同」證明
- `planWalk` 的模型 C 只經 `sampleLocal` 取得濃度（測試以原始碼檢查與注入的監看取樣器雙重確認）；未提供取樣器時，以 `spec.field` 建立 `SyntheticChemicalField`。觸角尖端與高斯脊的計算式**原樣搬進** `local-sensing.ts`，`natural-walk.ts` 的 `antennaTips`、`fieldValue` 改為呼叫它們。
- **證明**：重構**之前**先計算 750 次執行（A／B／C × 去回程 × 75 隻，加 Δc 0.01／0.05／0.1 與起點 ±5 mm 的 C）的計畫段、事件、截斷、抵達與感測值的 SHA-256（`tests/lib-walk-digest.ts`），記為 `b8a3fe6b…`；重構後相同。`docs/physics-kinematics2d.md` §8 的原始失敗表與四個姿態串流也仍逐字／逐位元相同。

## 4. 假設與未決
- 觸角幾何（長度、半角）、點取樣、雙側比較都是 `assumption: true`（遊戲假設；機制方向只有非本種 R810）。每次請求都附這些標籤。
- **（已解決，Owner 決定 43）**本契約現在與 CHEM-1b 相同：感測時刻必須等於最新提交（`FUTURE_SAMPLE`／`STALE_SAMPLE`）；排程器在每個控制時刻先提交再取樣。任何 CHEM 拒絕都會變成錯誤，不會被吞掉。
- 名稱對照：`sensing_time`、`state_commit`、`read_kind`、`decision_use: 'forbidden'`、`covered_by_commit`、`exact_commit_instant`、`queried_at_horizon`、`STALE_SAMPLE`、`FUTURE_SAMPLE` 與 CHEM-1b 相同；本模組的 `SimTime` 對應 `ChemTime`（不含 clock／unit）、`StateCommit` 對應 `ChemCommit`、`RealtimeSensingReader` 對應 `ChemRealtimeReader`、`DiagnosticCapability` 對應 `ChemDiagnosticCapability`。CHEM-1b 仍在審查；若其名稱再變，本模組跟著改。
- CHEM 的取樣是格子層級的暴露量總和（不做面積加權），與合成場的點值不同量綱；接入後模型 C 的增益與 floor 都要重新評估，不能沿用。

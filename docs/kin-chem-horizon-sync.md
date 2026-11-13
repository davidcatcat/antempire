# 運動學 ↔ CHEM horizon 同步契約（#189、#193 裁示第 14 項）

> **地位**：**設計＋契約**（文件、型別、契約測試）。`engine/physics/chem-horizon-sync.ts` 隔離，不被正式流程引用（`tests/physics-isolation.test.ts`）。**沒有修改** CHEM（`engine/chemistry/*`）、local-sensing、KIN-2D 或任何解算器；**合成場（`SyntheticChemicalField`）保留**，尚未移除，也還沒有把模型 C 接到 CHEM。golden 逐位元組相同。
> **不宣稱**：這是時間與因果的工程契約，不是化學或行為模型；所有化學數值都是合成候選（證據 D）。

## 1. 背景

#167 Q3：CHEM 只允許在已關閉的 horizon 上讀取，運動學的感測契約則允許讀到 horizon 前任一已提交時刻。Owner 決定 43 之後兩邊都改為「即時讀取只讀**最新**提交狀態，且感測時刻必須等於該提交時刻」（`sampleLocal`：未提交 → `FUTURE_SAMPLE`，已有更晚的提交 → `STALE_SAMPLE`）。剩下的問題是**排程**：運動學何時推進、何時提交、何時感測，才能讓結果與步長無關。

## 2. 契約（C1–C6）

- **C1 只讀已提交時間截面**：個體在 s 感測，僅當化學存放的最新提交恰為 s。兩次提交之間沒有讀取。
- **C2 先物理後提交**：存放在 s 提交之前，s 之前（含）的運動必須已執行完，且由該運動產生、事件時刻 ≤ s 的沉積都已送出（CHEM_PHASES 第 1 階段 → 第 2–3 階段；deposit-before-sense）。
- **C3 同一時刻的因果次序**：物理（≤ s）與沉積（≤ s）→ 提交（s）→ 感測（s）→ 決策（s）→ s 之後的物理。物理**不得**越過一個還有決策未做的時刻（決策只能影響其後的運動）；s 之後的運動造成的沉積帶自己的事件時刻（> s）。
- **C4 以事件時刻標記沉積**：沉積的時刻是來源事件真正發生的時刻（閉式求得的越過時刻），不是產生它的物理步的終點。
- **C5 提交集合與物理步長無關**：只在感測／決策時刻與時間終點提交（`syncSchedule`）；額外的物理切點（步長、分段）不增加提交。
- **C6 跨步長一致**：在 C4、C5 之下，若生產者的位置是「自決策錨點起的絕對時間閉式」，則每個讀值、決策、沉積與提交序號對任何物理分段都**逐位元相同**（已測試）。像 LANE-FLOW 這樣在每個切點從目前姿態重新起算的生產者**目前不滿足 C6**（`docs/physics-follower-ab.md` §4）；要滿足需要裁示第 8 項的絕對時間位置計算（另案規則／候選更新），不在本契約變更範圍。

時間一律是 `SimTime { t_s, round }`（等於 CHEM 的 `ChemTime` 去掉 clock／unit），依 (t_s, round) 字典序比較。

## 3. 型別與工具

| 名稱 | 用途 |
|---|---|
| `SyncOp` | 執行紀錄：`physics_advance`、`deposit_submit`、`chem_commit`、`sense`、`decide` |
| `checkSyncTrace(ops, due)` | 獨立檢查 C1–C3：`TIME_BACKWARDS`、`COMMIT_AHEAD_OF_PHYSICS`、`DEPOSIT_FROM_FUTURE`、`LATE_DEPOSIT`、`DUPLICATE_DEPOSIT`、`SENSE_UNCOMMITTED`、`SENSE_STALE`、`SENSE_COMMIT_MISMATCH`、`DECIDE_WITHOUT_SENSE`、`DECIDE_ON_OTHER_INSTANT`、`PHYSICS_PAST_UNDECIDED`、`UNDECLARED_DECISION` |
| `syncSchedule(決策時刻, H, 物理切點)` | C5：提交＝決策時刻 ∪ {H}；物理分段切在提交時刻與額外切點 |
| `runSynced(producer, chem, …)` | 參考驅動：依契約次序執行；`SyncProducer`（推進、到期決策、決策）與 `SyncChem`（送出、提交、感測）是兩側的介面，CHEM-1 `ChemStore` 或 local-sensing 的讀取器都可接上 |

## 4. 測試（`tests/k189-chem-horizon-sync.test.ts`，阻擋性）

- 參考驅動＋真正的 CHEM-1 `ChemStore`（sparse_2d、λ = 0.5 /s，合成）＋一個玩具行走者（三隻同一列、各自的決策時鐘 0、0.05、0.13 起每 0.1 s；位置為自決策錨點的閉式；每走過 1 mm 沉積一次，時刻為越過時刻；前方讀值超過門檻就減速）：紀錄通過 C1–C3、存放沒有拒絕任何操作、化學確實改變決策；四種物理分段（無、每 0.037 s、每 0.01 s、隨機 40 個）的讀值、決策、沉積、提交序號與最終狀態**逐位元相同**。
- 反例（存放與檢查器都抓到）：(a) 提交前感測 → `FUTURE_SAMPLE`／`SENSE_UNCOMMITTED`；(b) 物理與提交越過還沒決策的 0.1 再感測 0.1 → `STALE_SAMPLE`／`PHYSICS_PAST_UNDECIDED`＋`SENSE_STALE`；(c) 事件時刻不晚於已提交時刻的沉積 → `LATE_DEPOSIT`，超出已執行物理的沉積 → `DEPOSIT_FROM_FUTURE`；(d) 以步終點標記沉積：仍符合 C1–C3，但結果隨步長改變（C4 必要）；(e) 把物理切點當提交時刻：個體記錄到的提交序號隨步長改變（C5 必要）。
- 同一個驅動接合成場（`SyntheticChemicalField` 經 local-sensing `sampleLocal`）：契約成立、每個決策一個讀值——合成場保留為對照來源。

## 5. 之後要做（不在本 PR）

1. 模型 C 改用 `runSynced` 的次序：在每個控制時刻提交 CHEM，再透過 `ChemLocalFieldAdapter`（目前只有宣告）讀取；合成場保留為對照與測試來源。
2. 讓 KIN-2D／LANE-FLOW 的位置成為自決策錨點的絕對時間閉式（裁示第 8 項，需獨立規則更新 PR、版本化、驗證重播相容），才能宣稱 C6。
3. 同一時刻多輪（round > 0）的沉積—感測迴圈：契約已用 (t_s, round) 排序，但目前測試只用 round 0。

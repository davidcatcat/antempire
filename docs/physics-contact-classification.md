# 接觸分類：幾何接觸段與力學約束分開（#189、#193 裁示第 1 項）

> **地位**：隔離物理實驗。`engine/physics/contact-classification.ts` 只**讀取** PH-3b（`solver2d.ts`）、WP4（`local-steer.ts`）、KIN-2D（`kinematics2d.ts` 凍結、`kinematics2d-contact.ts` 投影）與 ANTENNA-GEO（`antenna-geometry.ts`）的輸出，轉成同一種紀錄格式；這些解算器**都沒有修改**。不被正式流程引用（`tests/physics-isolation.test.ts`），golden 逐位元組相同。
> **不宣稱**：本種沒有觸角接觸（antennation）、CHC 辨識或接觸後反應的量測。下面的「生物接觸條件」是**候選規則（遊戲假設）**，只決定「何時允許考慮一個觸角訊號」，不模擬辨識、交哺或任何決策。

## 1. 兩種紀錄，不混用

| 紀錄 | 意義 | 來源（各解算器） |
|---|---|---|
| `contact_episode`（幾何接觸） | 兩個形狀的間距 ≤ θ 的區間。`geometry`：`body_body`、`body_static`、`antenna_body`、`antenna_antenna`、`antenna_static`。不含任何力學欄位 | PH-3b、WP4：`contact_start`／`contact_end`（WP4 的 `contact_end_estimated` 是邊界規則，`end_is_physical: false`）；KIN-2D 兩種模式：`contact_start`／`contact_end`；ANTENNA-GEO：`antenna_contact` 的 start／end |
| `constraint_active`（力學作用） | 不穿透約束確實作用在身體上（停下、速度投影、再壓入）。不含任何感知意義。`in_contact` 標示作用時形狀是否接觸 | PH-3b：`Solver2DResult.constraint_active`（成對）；WP4：`stop`（physical_constraint）到下一次 `resume`／新決策／抵達／離場；保守停止（對方的計畫路徑）`in_contact: false`；KIN-2D 凍結：`stop_on_contact`、`repress` 是**瞬時**反應（之後的靜止是凍結規則，不是約束）；KIN-2D 投影：`constrained`／`stop_on_contact` 到 `constraint_free` |

- 力學（停下、減速、側滑）只看 `constraint_active`。
- 生物訊號**只能**由 `contact_episode` 觸發；把 `constraint_active` 紀錄交給生物閘門會被拒絕（`ClassificationRefused`），混合清單也拒絕，不默默過濾。
- 一致性檢查 `constraintsOutsideContact`：宣稱接觸中的約束，起點必須落在同一對身體的接觸段內（與 PH-3b 文件的 constraint_active ⊆ geometric_contact 相同方向）。

## 2. 生物接觸條件（定義）

觸角訊號（`antennation`，或 CHC／CHEM 接觸讀取 `chc_contact`）對接收者 r 與對象 p 只能在下列接觸段的**開始**被觸發：

1. 接觸段的幾何是 `antenna_body` 或 `antenna_antenna`；
2. 觸碰的觸角屬於 r：r 的柄節或鞭節膠囊與 p 的身體膠囊或觸角膠囊間距 ≤ θ（ANTENNA-GEO #175 `detectAntennaContacts`，在**已執行**的身體運動上計算）；
3. p 是另一隻個體（不是靜態物體）。

身體對身體的接觸本身**不是**觸角接觸（觸角才是感覺器官；CHEM 契約的 CHC 感知規則是 `antennal_contact`）。觸發只是允許之後的模型考慮一個訊號；沒有辨識（ANTENNA-GEO 的 `recognition: null`）。規則本身標 `assumption: true`、`遊戲假設`。

## 3. 測試（`tests/k189-contact-classification.test.ts`，阻擋性）

- 同一個迎面相遇在 PH-3b、WP4 `none`、WP4 `N_no_yield`、KIN-2D 凍結、KIN-2D 投影：各有一個 `body_body` 接觸段、接觸時刻一致（≤ 1e-6 s，解析值 0.875 s）、約束都落在接觸段內。
- **反例**：上述五者都有身體接觸與作用中的約束，但沒有觸角模型 → 0 個觸角訊號。追撞（KIN-2D 投影）：前者與後者有身體接觸、成對力學在作用，但前者的觸角朝前、沒有碰到後者 → 前者 0 個訊號；只有後者的觸角碰到前者時觸發，而且早於身體接觸。
- 側向經過靜止個體：沒有身體接觸、沒有約束，仍有觸角接觸觸發（兩種紀錄彼此獨立）。觸角與身體碰牆：只有幾何接觸段，沒有社會訊號。
- 輸入順序不影響分類與觸發。

## 4. 尚未驗證／仍是假設

- 觸角幾何與掃動參數是候選值（`scenarios/physics/pheidole-megacephala.antenna-candidates.json`，只有柄節長度有文獻範圍）。
- 「接觸段開始才觸發一次」是候選規則；持續接觸中的重複取樣、近接（near-contact）都沒有建模。
- WP4 的約束區間終點以下一個事件推定（解算器本身沒有輸出區間）。

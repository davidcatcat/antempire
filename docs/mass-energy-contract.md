# MEC-0：共用的質量／能量契約（#219 Q1、#222）

> 2026-11-13。**基礎設施，不是規則更新**：本 PR 新增一個純模組 `engine/units/mass-energy.ts` 與測試，不改引擎、參數、存檔或日誌，不推進遊戲日。官方引擎（`engine/*.ts`）、`cli/`、`web/src/` 與實驗 Worker 都還**沒有**匯入它；它不在 v1／v2 規則指紋內，也不在 Worker 白名單內（`tests/mass-energy-contract.test.ts` T1 檢查）。黃金測試逐位元組不變。
> 依據：Owner 在 #219 的裁示（2026-11-13，Q1）——新的個體／生態核心以 **mg** 計糖與蛋白（內部用整數 µg 或更細的定點數，並有清楚的顯示與換算）、以 **J** 計能量；液體體積與濃度分開（µL、mg/µL 或質量分率）；糖、蛋白、能量**不得**合成一種「份」；舊遊戲「份」只能存在於有版本、標 `assumption: true` 的換算／比較層，原始值與換算值都可追溯，不得把假設係數冒充量測；耗能機制要列出轉換效率／質量流；允許嚴格守恆的定點數；保持事件切分與重播決定性。#222（幼體生理）必須使用**同一份**契約。

## 1. 契約內容

| 量 | 型別 | 內部單位（整數） | 顯示 |
|---|---|---|---|
| 糖質量 | `Mass<'sugar'>`（`SugarMass`） | ng | mg（`formatMg`）、自動 mg／µg／ng（`formatMass`） |
| 蛋白質量 | `Mass<'protein'>`（`ProteinMass`） | ng | 同上 |
| 能量 | `Energy` | µJ | J（`formatJ`）、自動 J／mJ／µJ（`formatEnergy`） |
| 液體體積 | `Volume` | pL | µL（`formatUL`） |
| 濃度 | `Concentration<F>` | mg/µL（＝ ng/pL）的精確有理數 | — |
| 舊遊戲份 | `MicroPortions` | µP（10⁻⁶ 份） | `formatPortions`（標「遊戲單位」） |

- **型別分離**：每種量是帶品牌（brand）的 `number`。`add(糖, 蛋白)`、`add(質量, 能量)`、`add(體積, 質量)`、把蛋白轉進糖帳、用糖的換算紀錄換蛋白，全部是編譯錯誤（測試 T2 以 `@ts-expect-error` 驗證，`npm run typecheck` 會在任何一行不再是錯誤時失敗）。直接用 `+` 會得到普通 `number`，不能再存回量的型別。
- **精確算術**：`add`、`sub`、`sum` 用 BigInt 中間值；結果必須是 0～2⁵³−1 的整數，否則丟出 `OVERFLOW`／`NEGATIVE`（絕不環繞或靜默截斷）。
- **帳本**（`Ledger`，每種貨幣一本）：`inflow`（只能由**具名來源**產生，例如生態產生事件 ID 或換算紀錄 ID）、`transfer`（從一池移到另一池，不能拿超過池內的量）、`outflow`（進入**具名匯**，例如 respired、egested）。不變式 `Σ 來源 − Σ 匯 = Σ 池`、每池 ≥ 0，整數逐位元成立（`assertConserved`）。被拒絕的操作不改變任何東西（全有或全無）。帳本是純 JSON，可直接存檔與還原。
- **速率累積與換算的餘數**：`accrue(每日速率, dt 毫秒, carry)` 與 `scaleWithCarry(x, 有理數, carry)` 回傳整數結果與餘數；同一段時間或同一筆量**任意切分**（中間存檔、還原）得到逐位元相同的總量（T5）。餘數是擁有者狀態的一部分，必須一起存檔。這就是 `docs/p0a2-brood-physiology-design.md` §5.3 要求的「分子＋餘數」累加。
- **質量→能量換算紀錄**（`EnergyDensityRecord`，有 `id`＋`version`）：每次換算都回傳 `{ value, carry, provenance }`，provenance 記錄紀錄 ID、版本、輸入值與單位、係數、`assumption: true`、依據類型與來源。`oxidise` 把一筆質量從質量帳移到匯 `oxidised:<紀錄>`，同時把能量以來源 `oxidation:<紀錄>` 加入能量帳——兩本帳分開，由紀錄連結。
- **舊份橋接層**（`PortionBridge`，版本 `antempire.portion-bridge.v1`）：見 §4。
- **顯示**：從整數精確產生十進位字串（四捨五入、遠離零），只供畫面與報告，不回寫模擬。

## 2. 解析度與理由

| 貨幣 | 解析度 | 最小的實際事件量（例） | 上限（2⁵³−1 個單位） |
|---|---|---|---|
| 質量 | 1 ng | 原型幼蟲每口 0.025 份 × 稽核換算下限 0.0162 mg/份 ≈ **405 ng**；幼體設計需求下角 L1 每小時餵一次 ≈ 1.4 µg/日 ÷ 24 ≈ **58 ng** | ≈ **9.0 kg** |
| 能量 | 1 µJ | 1 ng 糖 ＝ 16.5 µJ（能量解析度比質量更細） | ≈ **9.0 GJ**（約 546 kg 蔗糖） |
| 體積 | 1 pL | 0.025 份 × 100 000 pL/份（#222 候選橋接，密度 1 mg/µL 假設）＝ **2 500 pL**；R132 一趟載量 0.08 mg ≈ 80 000 pL | ≈ 9 000 L |

- 選 ng 而不是 µg：µg 會把 58 ng 的一口餵食捨成 0，405 ng 也有 ±12% 的捨入。ng 讓最小事件的單次捨入 ≤ 2%，而且捨入只發生在**連續速率**上，並由餘數保留（例：小工蟻靜止耗糖下限 0.00162 mg/日，每秒只有 0.019 ng，但 86 400 個 1 秒步驟累積起來剛好 1 620 ng，測試 T6）。
- 上限：個體與蟻群的池（嗉囊、腸、巢內存糧、食源存量）都在毫克到克的量級，比 9 kg 小四個數量級以上。**跨年、全花園的累計來源計數**在極端文獻產量下可能接近上限（例如每日數十克蜜露 × 數百日）；超過時會丟出 `OVERFLOW` 而不是環繞——RU-3 若需要，要把累計帳依日或依來源分段。
- 為什麼不全部用 BigInt：量要能直接放進 JSON 存檔、跨 Node／Worker 傳遞並逐位元比較；BigInt 只用在乘法與除法的中間值。
- 為什麼不用浮點：浮點加總依切分順序不同而不同，無法保證重播與切分不變（CLAUDE.md §8）。

## 3. 換算紀錄（哪些是假設）

| 紀錄 | 值 | 依據類型 | 來源 | 限制 |
|---|---|---|---|---|
| `sugar_energy_density@v1` | 16.5 J/mg（＝ 33/2 µJ/ng） | 一般生理學，`assumption: true` | 無引用文獻（一般值）；與 `data/garden-supply-demand-anchors.json` 的 `sugar_energy_j_per_mg` **同值**（測試 T7 檢查，全 repo 只有一個糖能量密度） | 只換算化學能，不含消化／同化效率；蜜露、花蜜不全是蔗糖（己糖約 15.6 J/mg） |
| `protein_energy_density@v1` | 17 J/mg | 一般生理學，`assumption: true` | 無引用文獻（Atwater 型一般值），非本種量測 | 昆蟲多以尿酸排氮，淨能量不同；**是否**以蛋白補能量是 Owner 待決（#222 `protein_catabolism`），這筆紀錄不代表引擎會這樣做 |

新增紀錄（例如 RU-6 的耗氧→能量）要：新的 `id@version`、標 `assumption: true` 與三類依據之一、文獻支持者附 `docs/references.md` 的 ID、寫明外推限制；不得修改已發佈版本的數值（改值＝新版本）。

**能量的兩條路線要擇一並記錄**：#222 設計以化學計量把耗氧換成「糖當量 µg」（0.8915 mg 蔗糖／mg O₂），再以 `sugar_energy_density` 換成 J；若改用呼吸熱當量（例如稽核錨點的 20.1 J/mL O₂，混合基質值），兩條路線差約 4～5%（純碳水化合物約 21.1 J/mL）。同一機制只能用一條，並在紀錄中寫明。

## 4. 舊遊戲份的橋接層（唯一允許「份 ↔ 質量／體積」係數的地方）

- `makePortionBridge({ id, target, per_portion, evidence, sources })`：`target` 是 `sugar`、`protein`（每份多少 ng）或 `volume`（每份多少 pL）；係數由**呼叫者明確給出**並附證據說明，**模組本身沒有任何預設係數**。橋接一律 `assumption: true`、依據「遊戲假設」、版本 `antempire.portion-bridge.v1`。
- `bridgeFromPortions(橋, µP, carry)`／`bridgeToPortions(橋, 量, carry)`：回傳換算值、餘數，以及 provenance（**原始份數**〔µP 與十進位字串〕、橋 ID 與版本、係數、`assumption: true`）。糖橋另標 `within_audit_sugar_candidate_range`：係數是否落在稽核的候選區間 **0.0162～0.08812 mg 糖／份**（`reports/garden-supply-demand-audit/audit.json` 的 `conversion_candidates_mg_sugar_per_gp.union`；任務描述的 0.016～0.088 是其四捨五入）。這個區間只是參考標記，**不是**係數；測試 T8 檢查它等於已提交的稽核結果。
- 舊引擎的浮點份數用 `legacyPortionsRounded` 明確四捨五入到 µP 並回傳殘差；十進位參數值用 `legacyPortions`（超過 6 位小數會被拒絕）。
- 測試 T8 掃描 `engine/`、`cli/`、`tools/`、`prototypes/`、`web/src/` 的程式碼（不含字串與註解），確認沒有其他地方定義 `mg_per_portion`、`portion_to_ug` 之類的係數常數。

## 5. #222（幼體生理）與 RU-6 如何使用

- **#222**：幼蟲的 `gut_*`、`reserve_*`、`structure_protein`、`meconium_*`、`egesta_*`、`corpse_*` 用 `SugarMass`／`ProteinMass`（ng 整數），每隻幼蟲每種食物一本 `Ledger`；吸收、維持、成長、沉積都是 `transfer`／`outflow`，餵食是照護者嗉囊帳 → 幼蟲腸帳的 `transfer`（給方減、收方加）。速率（維持 µg 糖當量／日、吸收速率）用 `accrue` 帶餘數，滿足設計 §5.3 的切分不變。設計中的「糖當量 µg」是質量帳（糖），需要以 J 報告時用 `sugar_energy_density@v1` 換算並帶 provenance。
  候選檔 `prototypes/brood-physiology/brood-physiology.candidates.json` 的 `bridge_portion_solution_ug`（100 µg 液體／份）與 `bridge_sugar_fraction`、`bridge_protein_fraction` 是**橋接的候選輸入**，不是第二個換算常數：實作時以 `makePortionBridge({ target: 'volume', per_portion: <pL/份>, evidence: … })` 建立（µg 液體換成 pL 需要明確的密度假設），再以 `Concentration`（mg/µL）求溶質質量。測試 T8 以這條路線重現設計 §4.6 的「0.025 份／日 ≈ 0.25 µg 糖／日」（10% w/v 假設）。
- **RU-6**（需求改用 mg／J）：工蟻代謝以能量（µJ）或糖當量（ng）表示，用 `accrue` 累積、以 `oxidise` 從個體的糖帳燒掉並記入能量帳；每個耗能機制列出它用的換算紀錄（`id@version`）與轉換效率參數（例如同化率，標 `assumption: true`），質量流都經由帳本。
- **RU-3～RU-5、RU-7**：生態產生的糖與蛋白以 `inflow(帳, 來源事件 ID, 食源池, 量)` 進入世界，來源 ID 對應已記錄的自然事件（CLAUDE.md §2.2）。
- **接線是規則變更**：任何官方或 Worker 模組開始匯入本模組時，要在該 PR 中處理規則指紋與 Worker 白名單（`prototypes/continuous-world/worker-boundary.json`，屬規則修改），並附邊界測試證據。本模組已符合 Worker 的決定性數學規則（只用 IEEE 精確的整數／BigInt 運算，不需要 `engine/clock/detmath.ts`，T1 檢查），所以接線時不必改寫。

## 6. 不在本 PR 範圍

- 沒有改任何參數值、沒有選定任何份↔mg 係數、沒有把任何引擎機制改成 mg／J（RU-1～RU-7 各自另開 PR）。
- 沒有宣稱舊引擎的份數守恆是質量或能量守恆（`docs/garden-supply-demand-audit.md` §2）。
- 跨平台：本模組只用整數與 BigInt 運算，理論上不受浮點差異影響；但逐位元一致的聲明仍只限已證明的環境（CLAUDE.md §8）。

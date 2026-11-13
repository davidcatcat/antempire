# CQ-1：蟻群成員模組（多后、大小工蟻、幼體來源）——隔離實作

> 狀態：**隔離模組＋測試＋設計**。`engine/colony/members.ts` **尚未接入** P0-A2 世界、實驗 Worker 或正式引擎；沒有改任何科學參數值、存檔、日誌，也**不推進遊戲時間**。
> 授權：Owner 2026-11-13（#219 留言 6846471035、#222 留言 6846471780）：「大工蟻與多后系統的資料結構、個體事件、行為與存檔可同步排程」；「先做個體類型、蟻后獨立繁殖及死亡帳、各自代謝接口、幼體來源／階級分化資料欄位、存檔與可視化。營養數值及階級分化門檻未獲證據前保持假設／隔離。不得用單后演算法假裝多后，也不得憑空增加幼體。」；#202：預設 2～3 后（1～3 敏感度），多后個體、產卵、死亡與存檔須真正實作；大工蟻須支援個體／工作／能量／存檔。
> 相關：[`research-design-p1a-majors.md`](research-design-p1a-majors.md)（P1-A 大工蟻設計）、[`day0-founding-evidence.md`](day0-founding-evidence.md)（蟻后數證據）、[`r2-day0-official-spec.md`](r2-day0-official-spec.md)（M09、M15～M18）、[`p0a2-24h-prototype.md`](p0a2-24h-prototype.md)、[`p0a2-brood-physiology-design.md`](p0a2-brood-physiology-design.md)。

---

## 1. 範圍

| 做了（本 PR） | 沒做（之後的 PR） |
|---|---|
| 蟻后個體：各自 id、事件計數、雜湊鏈、亂數流、帳本、產卵事件、死亡紀錄 | 產卵速率、營養→產卵關係、每卵成本的**數值**（全部 `null`，尚未模擬） |
| 工蟻階級 `minor`／`major`／`null`（形態未知），由參數檔開關 | 大工蟻的任務閾值、招募、搬運、防衛行為（P1-A PR-D） |
| 幼體來源欄位：母后 id、產卵事件 id、階級命運 `undetermined`→`minor`／`major` | 階級分化門檻（P1-A §5.1；`null`）、幼體發育（P0-A2 幼體紀錄 v2／BP-1） |
| 每種成員型別的代謝**接口**（蟻后、小工蟻、大工蟻、未知階級工蟻） | 代謝數值（等 MEC-0 與 RU-6） |
| 正準 JSON 快照／還原（逐位元組往返）、檢視器資料形狀 | 接入 P0-A2 世界、Worker 白名單、存檔格式 v2 欄位、`web/src` 畫面 |

## 2. 資料結構

所有量都是安全整數：時間＝實驗時間毫秒；糖、蛋白＝µg；能量＝µJ（暫定名稱，見 §5 的 MEC-0 綁定）。

- **成員共通**：`id`、`alive`、`added_t`、`metab_t`、`last_t`、`ledger`、`n`（自己的事件計數）、`chain`（自己的事件雜湊鏈）。
- **帳本 `Ledger`**：`have`（現有）、`initial`（進入情境時或產卵時由母后移入）、`received`（只由帶來源事件 id 的 `food_received` 加入）、`metabolised`、`deficit`（缺口；診斷，不是食物）、`to_eggs`（蟻后移入卵的量）。
- **蟻后 `Queen`**：`origin: 'initial_scenario'`（新后生產、收養、分巢都尚未模擬）、`eggs_laid`（自己的卵計數；卵 id＝`${蟻后id}.egg${k}`）、`last_oviposition_t`。
- **工蟻 `Worker`**：`caste: 'minor'|'major'|null`、`caste_source`（`initial_scenario`／`developed_in_model`／`single_caste_params`／`fate_not_modelled`）、`mother_queen_id`（情境初始工蟻為 `null`）。依 P1-A §0：形態未知的個體保持 `null`，**不得**事後改判為 major，也不以 minor 代用。
- **幼體 `Brood`**：`mother_queen_id`、`laid_event_id`、`caste_fate`（`undetermined` 直到階級候選規則觸發）、`caste_fate_event_id`、`caste_fate_candidate`。只記來源與命運；發育階段由幼體紀錄 v2／BP-1 負責。
- **死亡紀錄 `DeathRecord`**：`id`、`kind`、`t`、`cause`（由模組外的死亡模型提供；本模組不含死亡風險）、`event_id`、`ledger_at_death`（屍體的質量仍記錄，不會消失）。

## 3. 事件與規則

| 事件 | 觸發者 | 規則 |
|---|---|---|
| `queen_added`／`worker_added` | 情境初始化 | 初始儲備是情境輸入（其數值屬情境的假設，不屬本模組） |
| `food_received` | 世界中實際的局部移轉（如交哺） | 必須帶來源事件 id；死者不能接收 |
| `metabolism_booked` | 世界排程 | 用該成員型別的代謝接口；接口為 `null` 就不記帳（尚未模擬）。不足部分記為自己的 `deficit` |
| `oviposition`＋每粒卵的 `egg_laid` | 世界排程該蟻后的產卵機會 | 蟻后死亡或產卵候選為 `null` → 不產生任何事件與幼體。候選只拿到**她自己的視圖**與**她自己的亂數流** `rng(hash32(seed\|蟻后id\|ovi\|n))`；每卵成本由另一個接口提供，成本為零或沒有成本接口 → 拒絕（不可憑空產生幼體）；實際產卵數受**她自己的儲備**限制，每粒卵的供給從她的帳本移到卵的帳本（整數守恆） |
| `caste_fate_set` | 世界排程該幼體的敏感期 | 候選只拿到幼體**自己的視圖**與自己的亂數流；參數檔未啟用的階級 → 錯誤；已決定的不再改 |
| `eclosion` | 發育模型（本模組外）判定成蟲 | 保留 id、母后、帳本；命運已定 → 該階級（`developed_in_model`）；物種只有一種工蟻階級 → 該階級（`single_caste_params`）；多型物種但命運未定 → `caste: null`（`fate_not_modelled`），不默認為小工蟻 |
| `death` | 模組外的死亡模型 | 死者不再產卵、接收食物或代謝 |

**多后不是單后的倍數**：每隻蟻后有自己的計數、雜湊鏈、亂數流、帳本與卵 id 空間；新增、移除、殺死另一隻蟻后，或改變不同蟻后呼叫的交錯順序，都不會改變某隻蟻后自己的事件（測試 §2、§3）。

**局部性（CLAUDE.md §2.1b）**：候選函式只接收 `queenOwnView(q, t)`（她自己的 `have`、`received`、`deficit`、年齡、距自己上次產卵的時間）或 `broodOwnView(b, t)`（自己的 `have`、`received`、年齡）。兩個建構函式只接受一個成員，不接受整體狀態；`audit()` 是統計與守恆驗證用，從不作為任何成員的輸入。

**物種差異（§4）**：`worker_castes.minor/major.enabled` 來自參數檔；單型物種把 `major.enabled` 設為 `false` 即可，程式中沒有物種名稱。

## 4. 證據表

| 項目 | 本模組中的處理 | 分類 | 來源與外推限制 |
|---|---|---|---|
| 本種工蟻二型（小工蟻／大工蟻） | `worker_castes` 兩者啟用 | 文獻支持（本種） | R99 頭寬 major 1.10–1.54 mm、minor 0.50–0.61 mm；R97 各族群體型與比例。**比例不是輸入**，須湧現（P1-A §1） |
| 大工蟻比例 | 不設；不得作為任何個體的輸入 | — | R94 新羽化 11.86%（28°C 實驗室）、R97 野外 0.06–0.25：只作 P1-A V4 驗證型態 |
| 本種多后 | 多隻獨立蟻后個體 | 文獻支持（本種） | R94（華南巢片段 2～7 后）、R101（喀麥隆單巢最多 71 后）、R116（沖繩庫存群多后）、R99、R137（分巢可帶一或多后，二手） |
| 預設蟻后數 2～3、敏感度 1～3 | 只寫在候選參數檔 `queen_count`，模組不讀 | **遊戲假設**（Owner #202） | 2～7 是實驗室巢片段計數，不是分巢單位分布，也不是臺中野外值 |
| 產卵速率、營養→產卵關係 | `oviposition: null`（尚未模擬） | 未知 | R136 夏威夷成熟群蟻后 31 日 97～292 粒（約 3～9 粒／日，成批、人工餵食）：只可作日後驗證，**不是**營養→產卵函數；他種資料不得直接套用 |
| 每卵成本（糖／蛋白／能量） | `egg_cost: null` | 未知 | 本種沒有卵質量與組成量測 |
| 階級分化門檻 | `caste_fate: null` | 機制：文獻支持（**非本種**，*P. pallidula*、*P. bicarinata* 等，R174、R212、R213、R175、R269）；數值：未知 | 見 P1-A §5.1；本種只有季節與翅芽樣式（R94、R142、R167） |
| 代謝數值（蟻后、minor、major） | 接口已建，四個接口皆 `null` | major/minor 縮放指數 b 0.67–1.0：一般生理學（R272）；質量比：文獻支持範圍（本種 R97、R98／R132），選值未定 | 數值等 MEC-0／RU-6 的 mg／J 契約；不在本 PR 設定 |
| 死亡風險 | 只記錄死亡事件與原因；不產生死亡 | — | 大工蟻存活 R94（n = 14）只作 P1-A V8 驗證；蟻后壽命本種未知 |

測試用的候選接口（id 以 `test_only_` 開頭）只用來驅動帳務與獨立性檢查，**不是科學模型**，也不在模組或參數檔中。

## 5. 尚未模擬（畫面、存檔中繼資料須標示）

`NOT_SIMULATED` 常數與 `viewerData().not_simulated` 列出：產卵速率、每卵成本、階級分化門檻、代謝數值、幼體發育、死亡風險、繁殖階級（新后／雄蟻、婚飛、收養、分巢）、大工蟻行為。接入世界時，這份清單要進入 `save_meta` 與畫面標示（R2 M43）。

**MEC-0 綁定（後續）**：本 PR 建立時 origin 上還沒有 MEC-0 分支（`engine/units/mass-energy.ts`）。本模組先定義最小的 `Amount { sugar_ug, protein_ug, energy_uj }`（安全整數）。MEC-0 合併後要做：(1) 改用其型別名稱與單位（例如能量單位與是否為獨立儲存池或由質量導出）；(2) 代謝接口回傳型別對齊 MEC-0 的需求帳；(3) 若名稱改變，快照 schema 升版（`antempire.colony-members.v2`），不靜默改寫舊快照。

## 6. 存檔與檢視器

- `snapshot(s)`＝正準 JSON（鍵排序）；`restore(text)` 驗證 schema、`official: false`、每個帳本為非負安全整數、每個幼體的母后存在，且要求輸入本身是正準形式；往返逐位元組相同。
- 多后與大工蟻需要的存檔欄位：每隻蟻后的帳本、計數、雜湊鏈、卵計數、上次產卵時刻；工蟻 `caste`、`caste_source`、`mother_queen_id`；幼體 `mother_queen_id`、`laid_event_id`、`caste_fate*`；`deaths`。
- 檢視器資料 `viewerData(s, ports)`：每列 `id`、`kind`、`alive`、`caste`、`caste_source`、`caste_fate`、`queen_id`、`mother_queen_id`，加上目前候選 id（`null`＝關閉）與尚未模擬清單、「非正式實驗世界／研究候選」標籤。本 PR 不改 `web/src`。

## 7. 接入 P0-A2 的計畫（另開 PR）

順序（依 #219 RU 順序與 #222）：
1. **幼體紀錄 v2**（P0-A2 larvae log）合併：幼體 id 與發育事件；本模組的 `Brood` 只提供來源與命運欄位，接入時與幼體紀錄合併為同一個實體（不維護兩份幼體）。
2. **MEC-0** 合併：改用統一的 mg／J 型別（§5）。
3. **BP-1**（育幼生理隔離候選）：卵／幼體的代謝與發育；`eclose` 由其成蟲事件觸發。
4. **整合 PR（規則更新）**：P0-A2 `world.ts` 以 `addQueen` 建立 2～3 后（情境抽樣，標假設）、以實際交哺事件呼叫 `receiveFood`、把 `oviposit`／`decideCasteFate`／`bookMetabolism` 排入 P0-A0 事件佇列（每成員自己的事件、`hash32(seed|id)` 亂數流）；擴充 `prototypes/continuous-world/worker-boundary.json` 白名單加入 `engine/colony/`（屬規則修改，附邊界測試）；存檔格式升版；`web/src` 依 §6 顯示階級、母后與「尚未模擬」標籤。
5. 驗證：多種子、多后 1～3 敏感度、候選關閉時的參考紀錄逐位元組不變、事件切分與快照重播不變、整數守恆。

## 8. 測試

`tests/colony-members.test.ts`（BLOCKING）：參數檔與證據分類；多后獨立（新增／移除／殺死他后、改變交錯順序不影響某后）；N 后 N 份帳本與亂數流；每粒卵可追溯到產卵當時存活的母后並從她帳本扣除；整數守恆；候選關閉時零卵；無成本或零成本拒絕；死后不產卵；單型物種只靠參數；程式中沒有物種名稱（含負面樣本）；快照往返與「分段＋還原＋續跑」逐位元組相同；代謝記帳切分不變；局部性（靜態＋執行期反事實：加入他后與 100 隻工蟻不改變某后與其幼體感知到的任何東西）；隔離（正式引擎、`cli/`、`web/src`、Worker、P0-A2 都未匯入）；Worker 決定性數學規則；檢視器資料形狀。

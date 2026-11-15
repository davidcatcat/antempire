# 蟻群成員候選世界（`p0a2-colony-v1`）：蟻后、大工蟻、卵、蛹為引擎個體

> **狀態：候選／實驗，預設關閉，非正式。** 規則更新（CLAUDE.md §6），2026-11-15；對應 #202（Day0 初始條件暫定規格）、#219、#222（CQ-1 蟻群成員）。
> 這不是 #201 GO，不建立正式世界，不寫入 `saves/` 或 `journal/`。預設的 P0-A2 世界（`p0a2-24h-v1`）**逐位元不變**。
> 本世界只讓蟻后、大工蟻、卵、蛹**以引擎個體存在**；它們的生理、行為、發育與死亡**全部尚未模擬**，沒有為此新增任何模型或數值。

## 1. 範圍

| 項目 | 本候選世界 | 預設 P0-A2 世界 |
|---|---|---|
| 小工蟻 | 30 隻（P0-A2 原型群，行為完全相同） | 30 隻 |
| 幼蟲 | 8 隻（P0-A2 原型群，行為完全相同） | 8 隻 |
| 蟻后 | 2～3 隻（情境抽樣），引擎個體，全程 `in_nest` | 沒有 |
| 大工蟻 | 2～10 隻（情境的隔離比例候選 × 30 隻小工蟻），引擎個體，全程 `in_nest` | 沒有 |
| 卵 | 8 粒（情境「中」幼體負載：round(0.25 × 30)），不發育的引擎個體 | 沒有 |
| 蛹 | 3 隻（round(0.10 × 30)），不發育的引擎個體 | 沒有 |

做法是**組合，不是第二份實作**：`P0a2ColonyWorld`（`prototypes/continuous-world/worker/p0a2-colony-world.ts`）持有一個**未修改**的 `P0a2ExperimentWorld`，加上一份蟻群名冊（`engine/colony/roster.ts`，建立在 CQ-1 的 `engine/colony/members.ts` 之上）。兩者在本版**完全不互動**：沒有任何規則在它們之間搬移食物、資訊或個體。所以同一種子下，30 隻小工蟻與 8 隻幼蟲的事件流與預設世界**逐事件相同**（測試逐一比對 5 個種子的 24 小時事件）。

## 2. 初始條件：候選情境 BUD-CAND-2

來源是 `scenarios/day0-budding-candidate.json`（Owner #202 暫定實驗規格，全部 `assumption: true`）。抽樣規則就是既有的 `engine/day0/founding-sampler.ts`：每個欄位一條具名亂數流 `hash32("${seed}|day0_budding_candidate|${欄位}") / 2^32`，各抽一次；種子就是世界種子。Worker 不打包整份情境檔（含大量說明文字與正式存檔路徑字樣），而是讀由工具產生的摘錄 `p0a2-colony-scenario.ts`：只含 id、PRNG、抽樣順序、各欄位的分布規格，以及**整份情境檔的 checksum**。摘錄不定義任何數值；測試檢查它與情境檔一致、且 200 個種子的抽樣值等於取樣器在完整情境檔上的結果。

| 情境欄位 | 抽樣值 | 本世界如何使用 |
|---|---|---|
| `queens`（均勻整數 2～3） | 該種子的值 | **套用**：蟻后數 |
| `major_fraction`（均勻 0.06～0.25，情境標 `isolated`） | 該種子的 f | **套用**：大工蟻數 = round(f × 30 ÷ (1 − f))（情境檔的公式，小工蟻數取 P0-A2 實際的 30） |
| `eggs_per_minor`（中：0.25） | 0.25 | **套用**：卵 = round(0.25 × 30) = 8 |
| `pupae_per_minor`（中：0.10） | 0.10 | **套用**：蛹 = round(0.10 × 30) = 3 |
| `minor_workers`（對數均勻 50～500） | 該種子的值 | **只記錄、未套用**：小工蟻沿用 P0-A2 原型的 30 隻 |
| `larvae_per_minor`（中：0.15） | 0.15（＝5 隻） | **只記錄、未套用**：幼蟲沿用 P0-A2 原型的 8 隻 |
| `carried_brood_progress`（均勻 0.1～0.9） | 該種子的值 | **只記錄、未套用**：`stage_progress = null`（沒有發育模型） |

**最小侵入的對應**：小工蟻數與幼蟲數若改成情境的值，會改變 P0-A2 核心世界的行為（另一個規則更新），所以本 PR 不動它們，並在 `save_meta.colony.composition.not_applied` 逐項記下「情境值、實際使用值、原因」。若情境檔沒有 `major_fraction` 欄位（null），大工蟻數為 0，不另訂比例；沒有蟻后數欄位則拒絕建立（沒有預設蟻后數）。

## 3. 假設清單

每一項都寫在 `prototypes/continuous-world/worker/p0a2-colony-params.json`（`assumption: true`），並原樣寫進 `save_meta.colony.assumptions`。

| 參數 | 值 | 根據類型 | 來源與外推限制 |
|---|---|---|---|
| 蟻后數 | 情境抽樣 2～3 | 遊戲假設 | R137、R101、R94。分巢單位的蟻后數沒有實測；R94 的 2～7 后是實驗室巢片段計數，不是分巢分布 |
| 大工蟻比例 f | 情境的隔離候選 0.06～0.25 | 遊戲假設（範圍方向：文獻支持） | R97 五個引入族群的野外巢樣本（本種，不含臺灣）、R94 28°C 新羽化群 11.86%（實驗室）都是**成熟巢或實驗群**的觀察值；用到分巢單位是外推，不是實測的初始比例 |
| 數量基準 | P0-A2 實際小工蟻數（30） | 遊戲假設 | 情境的小工蟻數未套用（§2） |
| 幼體負載 | 情境預設「中」 | 遊戲假設 | R94、R136。分巢單位帶多少幼體沒有資料；零／低／中／高是事前定義的情境 |
| 幼蟲來源 | P0-A2 原型 8 隻 | 遊戲假設 | 情境的幼蟲數未套用（§2） |
| `major_behaviour` | `in_nest_only` | 遊戲假設 | 見下 |
| 初始體內儲備（蟻后、大工蟻） | `null` | 遊戲假設（未知） | 帳本由 0 起算只表示「沒有記入任何食物」，不是實測，也不據以推論飢餓 |
| 隨行幼體階段進度 | `null`（未套用） | 遊戲假設（未知） | 情境抽樣值只記錄 |

沒有「一般生理學」類的參數：本世界沒有任何生理模型。

### `major_behaviour` 開關

- `in_nest_only`（預設，唯一可執行的值）：大工蟻以引擎個體存在，全程 `in_nest`，不覓食、不交哺、不育幼。這是**較保守的標示假設**，不是本種行為的描述。
- `as_minor`（大工蟻沿用小工蟻的決策規則）：**只宣告、未實作**，選用時引擎拒絕（`ROSTER: major_behaviour as_minor is declared but NOT implemented`）。理由：本 repo 引用的文獻沒有支持「大工蟻與小工蟻決策相同」的依據（R95 只記載大小工蟻會口對口交換，R97 記載形態與角色差異）；而且讓大工蟻加入 P0-A2 的決策會改變小工蟻的事件流，屬另一個規則更新。
- 階級只由參數物件 `worker_castes` 控制（§4）：把 `major.enabled` 設為 false，同一份程式就拒絕建立大工蟻；程式中沒有物種名稱判斷。

## 4. 尚未模擬

蟻后、大工蟻、卵、蛹的下列項目全部尚未模擬；每個個體在訊框中帶 `not_simulated` 鍵清單，標籤在 `colony.not_simulated_fields`。

| 個體 | 尚未模擬／未知 |
|---|---|
| 蟻后 | 產卵（CQ-1 產卵候選為 null，**不會產下任何卵**；世界中的卵是初始情境帶入的）、被餵食、代謝、初始儲備（未知）、巢內位置與移動、死亡 |
| 大工蟻 | 階級特有行為、被餵食、代謝、初始儲備（未知）、嗉囊內容（未知）、巢內位置與移動、死亡 |
| 卵、蛹 | 發育（孵化、化蛹、羽化；BP-1 未接入）、階段內進度（未套用）、母后（未知）、階級命運（`undetermined`）、被照護、代謝、死亡 |

- C3a 蟻后餵食規則只存在於舊每日引擎，**沒有**移植到本世界。
- 存檔中繼資料的「尚未模擬／簡化代理」清單（`save_meta.not_simulated`）沿用預設世界由 `docs/r2-acceptance-matrix.json` 產生的清單，只改寫 M09、M15、M16、M18 四列的文字；**狀態一列都沒有升級**（四列仍是未接入）。
- R2 驗收矩陣：M09／M15／M16／M18 的狀態不變，只更新說明，並在 `candidate_world.opt_in_candidates` 宣告本候選（預設關閉的世界種類不算「已接入」）。

## 5. 事件、存檔與驗證

- **事件**：名冊事件排在最前（`seq` 0…K−1，全部 t = 0）：`queen_added`、`worker_added`（`caste: major`）、`brood_item_added`（`stage: egg | pupa`），`event_id` 為 `colony:<個體 id>#0`，資料帶 `assumption: true`、`scenario_id`、`initial_reserve_known: false`。之後是基底世界的事件，`seq` = K + 基底 `seq`。每個事件帶本世界自己的規則指紋與引擎版本 `experiment-p0a2-colony/1`，並推進本世界自己的事件鏈。
- **規則指紋** = 引擎版本＋payload schema＋基底 P0-A2 規則指紋＋參數（基底參數檔、本候選參數檔、整份情境檔 checksum）＋本世界匯入圖的程式雜湊（`p0a2-colony-code-hash.ts`，包含整個預設圖）。
- **存檔**（payload schema 2）：`payload.base` 是基底世界**完整的**快照（由預設世界自己的 `restore` 驗證），`payload.colony` 是名冊狀態，`payload.save_meta.colony` 記錄情境 id／checksum、PRNG、種子、抽樣值、套用值、未套用值、假設清單與名冊雜湊。
- **還原**：拒絕任何不一致（從不修補）。本版名冊沒有動態，所以還原要求名冊**等於**由種子重建的名冊；多一粒卵、少一隻蟻后、蟻后有食物或產過卵、大工蟻改標小工蟻或離巢，都會被拒絕。預設世界與本世界互相拒絕對方的快照。
- **Node 驗證**：`cli/verify-save.ts` 不需修改；`world-kinds.ts` 登錄 `p0a2-colony-v1`，Node 用**同一個模組**由（world id、seed）重建並推進到存檔時刻，比對事件鏈與狀態雜湊，通過才是 `node_verified`。竄改後重算所有雜湊的存檔不會通過。
- **守恆**：基底世界的整數食物守恆不變（名冊沒有取走任何食物）；名冊帳本由 CQ-1 `audit()` 對帳；個體數不變。

## 6. 檢視器如何選擇這個世界

協定檔（`prototypes/continuous-world/worker/protocol.ts` 與逐位元組相同的 `web/src/experimental/worker-protocol.ts`）新增世界種類 `'p0a2-colony'`：

```ts
const client = new ExperimentWorkerClient();            // web/src/experimental/worker-client.ts（未修改）
await client.init('exp-my-world', seed, 'p0a2-colony'); // 只有明確指定才會建立；不指定仍是原本的預設
// 或經 session：session.newGame(name, seedInput, 'p0a2-colony')
client.onState = (frame) => { if (isP0a2ColonyFrame(frame)) draw(frame.colony); };
```

訊框是 **P0-A2 訊框**（`frame.world_kind === 'p0a2'`，原有欄位不變），另外多出：

- `frame.workers[i].caste`：一律 `'minor'`（只在本世界出現）。
- `frame.colony`（`P0a2ColonyMsg`）：
  - `world_kind: 'p0a2-colony'`、`save_world_kind: 'p0a2-colony-v1'`、`candidate: true`、`status_zh`
  - `scenario: { id, checksum, brood_level, status }`
  - `assumptions: { major_behaviour, major_fraction, major_fraction_isolated, all_counts_are_assumptions }`
  - `counts: { queens, minor_workers, major_workers, eggs, larvae, pupae }`（玩家視角統計）
  - `queens[]`、`majors[]`、`eggs[]`、`pupae[]`：每個元素是 `ColonyIndividualMsg`
  - `not_simulated_fields: Record<鍵, 中文標籤>`
- `ColonyIndividualMsg` 欄位（未知或不適用一律 `null`）：
  `id`、`kind`（`'queen' | 'worker' | 'brood'`）、`caste`（`'major' | null`）、`caste_source`、`stage`（`'egg' | 'pupa' | null`）、`state`（`'in_nest'`）、`loc`（`'nest'`）、`since_s`、`until_s`（`null`）、`alive`、`origin`（`'initial_scenario'`）、`mother_queen_id`（`null`）、`caste_fate`、`stage_progress`（`null`）、`crop_fill`（`null`）、`initial_reserve`（`null`）、`eggs_laid`、`last_oviposition_s`、`ledger`（蟻后與大工蟻：`{ have, received }`，各含 `sugar_ug`、`protein_ug`、`energy_uj`）、`not_simulated`（鍵清單）。
- id：蟻后 `q01`…、大工蟻 `m01`…、卵 `e01`…、蛹 `p01`…（基底世界：小工蟻 `w001`…、幼蟲 `l01`…）。`follow` 可指定任何一個。

畫面責任（CLAUDE.md §8）：模型**沒有巢內座標**，這些個體在畫面上的位置只能是標示清楚的示意／顯示插值；`not_simulated` 列出的項目必須標「尚未模擬」，不得用動畫暗示產卵、餵食、發育或大工蟻工作。

「預設關閉」的確切意思：沒有任何頁面或選單會以本種類開新遊戲，`init` 不指定種類時仍是原本的預設。既有的 `ExperimentSession` 會對協定列出的**每一個**世界種類各建立一個丟棄用的探測世界（`exp-runtime-probe`，只為讀取該種類的引擎版本與規則指紋，從不顯示、從不存檔），因此存檔清單開啟時 Worker 會短暫建立一次本種類的探測世界；這不影響任何已存在或之後建立的世界（每個世界彼此隔離、由自己的種子決定）。

本 PR 對 `web/src` 的修改只有兩處：協定副本 `worker-protocol.ts`（必須與 Worker 端逐位元組相同）與 `experimental/save-format.ts` 的存檔摘要（候選存檔不再被誤標成「合成世界：沒有蟻后」）。既有檢視器（v62 等）不會建立本世界；若載入本世界的存檔，會畫出基底世界的個體，不會畫名冊個體（後續工作）。

## 7. 白名單變更

`prototypes/continuous-world/worker-boundary.json` 的 `allowed_import_prefixes` 新增兩項：`engine/colony/`（`members.ts`、`roster.ts`）與單一檔案 `engine/day0/founding-sampler.ts`。兩者都在 `pure_module_prefixes`（`engine/`）之下，受純度與決定性數學規則檢查。沒有加入 `scenarios/`、`prototypes/colony-members/` 或 BP-1。只有本候選世界的轉接層匯入它們；預設 P0-A2 世界的匯入圖不含這些模組。邊界測試見 `tests/worker-boundary.test.ts`（負面樣本）與 `tests/p0a2-colony-world.test.ts` 第 13 段。

## 8. 重新產生的檔案

```
node prototypes/continuous-world/tools/p0a2-code-hash.ts --write   # 情境摘錄、兩個程式雜湊常數檔
node cli/r2-matrix.ts --write                                      # 矩陣衍生區塊（本 PR 沒有任何變動）
```

預設世界的程式雜湊常數（`p0a2-code-hash.ts`）在本 PR 沒有變動。

## 9. 後續工作（各自另開 PR）

1. 取樣器完整接線：小工蟻數與幼蟲數採情境值（會改變 P0-A2 核心行為；需要多種子評估）。
2. 蟻后餵食（C3a 規則在 P0-A2 連續時間模型中的對應）、代謝、產卵（CQ-1 候選接口）與死亡。
3. BP-1 育幼生理接入：卵、蛹的發育與羽化；隨行幼體進度的套用。
4. 大工蟻行為：先有本種證據與設計（`docs/research-design-p1a-majors.md`），再決定 `as_minor` 或階級特有規則。
5. 情境檔 `simulation_status.not_simulated` 的文字仍寫「尚未接入 Worker 候選世界」（對預設世界仍然成立）；更新文字會改變情境 checksum，須以情境版本更新處理。
6. 既有檢視器（v62）顯示名冊個體與其「尚未模擬」標籤。

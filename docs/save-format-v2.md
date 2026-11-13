# 存檔格式 v2：事件鏈承諾與 Node 重算驗證（SAVE-O）

> 狀態：設計＋第一版實作（合成實驗世界）。依據：Owner 裁示 #200（2026-11-12，採 C：世界在瀏覽器 Web Worker 推進、IndexedDB 自動存檔；Node 是獨立、可重現的驗證器）。延伸 [`experimental-save-system.md`](experimental-save-system.md)（SAVE-0～SAVE-2），兩者不一致時以較嚴格者為準。
>
> **本文件不代表新版 Day0 已通過啟用**（啟用依 #201 由 Owner 裁示），也不修改 CLAUDE.md；CLAUDE.md §8／§9 的修訂由另一個規則 PR 提出。目前所有世界仍是**非正式實驗世界**（`official: false`）。

## 1. 架構

```
瀏覽器 Web Worker（權威世界；共用決定性核心）──快照──► IndexedDB（本機自動存檔、回復點）──匯出檔──► Node 驗證器
        ▲                                                                                     │
        └──────── 同一份核心程式（prototypes/continuous-world/worker/，不是第二套科學實作）────────┘
```

- **同一核心**：瀏覽器 Worker 與 Node 驗證器 import 同一組 TypeScript 模組（`core.ts`、`chain.ts`、`world-kinds.ts` 及白名單內的 `engine/clock`、`engine/scheduler`）。驗證器沒有自己的模擬邏輯。
- **節奏與結果解耦**：速度、暫停、FPS、追蹤、存檔都只決定「推進到哪個時刻」，不改變事件（`tests/worker-runtime.test.ts`、`tests/save-verify.test.ts` §4）。
- **離線可玩**：遊玩、存檔、讀檔完全不需要網路或 Node；Node 驗證是事後、可選的。

## 2. 格式總覽

格式分三層；v2 的變更只在**第二層**（payload 結構 2），信封與匯出容器不變，儲存模組仍把 payload 當成不透明資料。

| 層 | 名稱 | 版本 | 本 PR |
|---|---|---|---|
| 1 | 快照信封 `antempire.experiment-world-snapshot.v1` | 不變 | 欄位不增減（SAVE-0 §2） |
| 2 | payload 結構（信封的 `schema_version`） | **1 → 2** | 新增 `payload.save_meta`、`payload.chain` |
| 3 | 匯出檔 `antempire.experiment-world-export.v1` | 不變 | 驗證器的輸入；也接受單獨的快照信封 |

#200 要求的欄位與位置：

| 要求 | 位置 | 說明 |
|---|---|---|
| schema 版本 | 信封 `schema`、`schema_version`；匯出 `schema` | 信封 v1、payload 結構 2 |
| rules 版本與指紋 | 信封與 payload 的 `engine_version`、`rules_fingerprint` | 指紋＝SHA-256(canonical{engine_version, schema_version, params})；因此 payload 結構升版也會改變指紋 |
| species 版本與指紋 | `payload.save_meta.species` | 合成世界沒有物種參數：`id: null`、`fingerprint: null`，並註明原因（不捏造） |
| environment 版本與指紋 | `payload.save_meta.environment` | `id: "synthetic-env/1"`、`fingerprint`＝SHA-256(canonical{calendar, site, temperature_profile_c})、`synthetic: true` |
| 初始條件與種子 | `payload.save_meta.initial` | `{ world_id, seed, t_sim: 0, params_sha256, how }`；`world_kind` 在 `save_meta.world_kind` |
| 模擬時刻 | 信封 `t_sim`、`seq`；payload `now`（精確時刻 day/us/us_lo） | 驗證器推進到 `now` 這個**精確**時刻 |
| 必要狀態 | payload 其餘欄位 | SAVE-0 §3（個體、環境、亂數串流、事件佇列、帳本） |
| 事件鏈承諾 | `payload.chain` | §3 |
| 校驗資訊 | 信封 `payload_sha256`；匯出 `export_sha256` | 只偵測意外損壞，**不是**真實性或科學驗證 |
| fork 紀錄 | `payload.save_meta.lineage` | §6；目前永遠是空陣列 |
| 驗證狀態 | **不在檔案中** | 只由驗證器的結果產生（§8）；檔案若自帶狀態欄位，匯入與驗證器都拒絕 |

`save_meta` 對一個世界是常數：Worker 還原時重新計算 `saveMetaOf(world_id, seed, params)` 並要求完全相同，否則拒絕（`META_MISMATCH`）。

## 3. 事件鏈承諾（`antempire.event-chain.v1`）

精確定義（實作 [`prototypes/continuous-world/worker/chain.ts`](../prototypes/continuous-world/worker/chain.ts)；向量 [`event-chain-vectors.v1.json`](../prototypes/continuous-world/save/event-chain-vectors.v1.json)，測試以 `node:crypto` 交叉驗證）：

```
H(x)     = SHA-256(UTF-8(x))，輸出 64 位小寫十六進位文字
genesis  = H("antempire.event-chain.v1" + "\n" + canonicalJson({ world_kind, world_id, seed, rules_fingerprint }))
head_0   = genesis,  count_0 = 0
head_k+1 = H(head_k + "\n" + canonicalJson(event_k)),  count_k+1 = count_k + 1
```

- `canonicalJson` 與 SAVE-0 §2 相同（鍵依 UTF-16 碼元排序、無空白、`-0` 寫成 `0`、拒絕非 JSON 值；[`canonical-vectors.v1.json`](../prototypes/continuous-world/save/canonical-vectors.v1.json)）。
- `event_k` 是 Worker **原樣輸出**的第 k 個事件紀錄（含 `seq = k`、`event_id`、精確時刻、資料、每次亂數抽樣、版本與標示欄位）。
- 次序：依精確時刻；同一時刻的事件是一個批次，依正規 `event_id` 排序後依序提交（`core.ts` `prepare()`）。因此同時刻事件的鏈與分段方式無關（測試：午夜的 `env_day`／`env_hour` 批次）。
- 每個已提交事件都更新鏈；`payload.chain = { algo, genesis, head, count }`，且 `count === seq`。
- Worker 還原時檢查：欄位形狀、`algo`、`genesis` 屬於此世界／種子／規則、`count === seq`。**還原無法檢查 head 本身**（任何人都能對捏造的事件算出自洽的 head）；只有 §7 的重算可以。

**狀態雜湊**：就是信封的 `payload_sha256`（整個 payload，包含 `chain`）。驗證器比較重算的 `payload_sha256` 與存檔的值，並列出不同的 payload 頂層欄位。

**成本**（Node 22、x64 測試機，7 個模擬日 21 030 事件，兩次量測）：加入鏈之前約 1.6～2.1 s，之後約 4.3～4.9 s（純 TypeScript SHA-256，每事件約 0.13 ms）。以最高速 86 400×（每真實秒一個模擬日）仍可跟上；落後時 Worker 照常回報 `lagging`，不跳過事件。手機未量測。

## 4. 行為不變的證明

payload 結構升到 2 之後，事件與狀態除了下列欄位外**逐位元組相同**：事件的 `schema_version`（1→2）與 `rules_fingerprint`（含 schema 版本），payload 的同兩欄與新增的 `save_meta`、`chain`。`tests/save-verify.test.ts` §2 以舊核心（origin/main 198d359）產生的摘要釘住：種子 7、48 h、6 084 個事件，去掉上述欄位後的事件 SHA-256 `d7b0cc58…` 與狀態 SHA-256 `3444f2f7…`。

## 5. 世界種類（world kind）抽象

[`world-kinds.ts`](../prototypes/continuous-world/worker/world-kinds.ts) 登錄每一種世界的版本化核心：

```ts
interface WorldKind {
  id: string; engine_version: string; schema_version: number; rules_fingerprint: string; params_sha256: string;
  create(worldId, seed): { world: VerifiableWorld; events: unknown[] };   // 受信任的初始條件
  restore(snapshot): VerifiableWorld;                                     // 結構檢查；失敗就丟出，不修改任何東西
}
interface VerifiableWorld { advanceToExact(end, maxBatches?); nowExact(); seqNo(); chainState(); snapshot(); }
```

目前只有 `synthetic-v1`（合成實驗世界）。P0-A2 世界接入時新增一個符合 `WorldKind` 的項目，並在其 payload 寫入同樣的 `save_meta`（含自己的 species／environment 指紋）與 `chain`；驗證器不需要改。`runtime.ts` 不需要改（仍由指令分派器使用目前的世界）。

## 6. 版本邊界、遷移與 fork

- **存檔永遠留在建立它的規則版本上。** 在規則 R 下建立的存檔，只能以 R 繼續；`rules_fingerprint` 不同就是「規則不同，無法繼續」（SAVE-2，決策 53），存檔原樣保留、可以匯出。
- **payload 結構遷移**只處理資料表示（`n → n+1` 的純函式，SAVE-0 §6），不得改變任何已發生的事件或狀態；遷移若需要過去的事件（例如補算事件鏈）就**不可能**，必須拒絕。結構 1 的存檔沒有事件鏈，無法遷移：Worker 拒絕（`SCHEMA_MISMATCH`，訊息說明沒有事件鏈承諾）、儲存模組回報 `no_migration_path`／`migration_failed` 並保留原檔、驗證器回報 `invalid`（`NO_CHAIN`）。
- **fork（以新規則 R′ 接續 R 的世界）**：不是遷移，而是新世界。設計如下（本 PR **未實作**，Worker 目前拒絕任何非空的 `lineage`：`FORK_UNSUPPORTED`）：
  - 新世界取得新的 `world_id`；R 的存檔不被修改，仍可在支援 R 的版本讀取與驗證。
  - 新世界的 `save_meta.lineage` 追加一筆 fork 紀錄：`{ parent_world_id, parent_rules_fingerprint, parent_engine_version, parent_schema_version, parent_t_sim, parent_seq, parent_chain_head, parent_payload_sha256, child_rules_fingerprint, state_mapping: "<版本化的狀態對映函式 ID>", reason }`。
  - 新世界的 `genesis` 改為對 fork 紀錄計算（`H("antempire.event-chain.v1\nfork\n" + canonicalJson(fork_record))`），因此新鏈明確接在舊鏈的 head 之後，舊歷史不會被重寫。
  - Node 驗證 fork：先在 R 下驗證父存檔到 `parent_t_sim`（需要 R 的核心版本），再以版本化的對映函式產生 R′ 的初始狀態，然後在 R′ 下重算。缺少任一版本核心時只能回報 `integrity_ok`，不能宣稱已驗證。
- 已完成的歷史永不回溯改寫；驗證失敗只產生報告，不修改存檔。

## 7. Node 驗證器（`cli/verify-save.ts`）

```
npm run verify:save -- <存檔.json> [--no-recompute]
```

輸入：選單「匯出」的檔案（`antempire.experiment-world-export.v1`）或單獨的快照信封。輸出：stdout 上的一份 JSON 報告（`antempire.save-verify-report.v1`）。**只讀取輸入檔**：不寫任何檔案、不修改存檔、不碰 `saves/`／`journal/`（`tests/worker-boundary.test.ts` 以 `node_verifier` 例外規則檢查：只有此檔可 import Worker 目錄，且不得出現寫檔、子程序、網路 API 或正式存檔路徑）。

步驟：

1. **完整性**：容器欄位（不得多也不得少，例如自帶的 `verification` 欄位被拒絕）、非正式標示、重算 `export_sha256` 與 `payload_sha256`、信封與 payload 的標頭一致。
2. **相容性**：`save_meta.world_kind` 是驗證器登錄的種類；payload 結構、引擎版本、規則指紋都等於該種類的版本；`save_meta.initial` 指向本世界與種子、`t = 0`，且 `params_sha256` 等於**驗證器自己的**參數（檔案中的參數永遠不被採用）。
3. **有效性**：同一核心的 `restore` 結構檢查（佇列、亂數串流、帳本、事件鏈形狀）。
4. **重算**：由受信任的初始條件 `create(world_id, seed)` 建立新世界，推進到存檔的精確時刻 `now`，比較事件鏈 `head`／`count` 與狀態雜湊。

| status | 意義 | exit code |
|---|---|---|
| `node_verified` | 1～4 全部通過 | 0 |
| `mismatch` | 1～3 通過，重算不同（`CHAIN_MISMATCH`／`STATE_MISMATCH`，列出不同的欄位） | 1 |
| `invalid` | 1、2 或 3 失敗（附原因代碼，例如 `HASH_MISMATCH`、`UNSUPPORTED_RULES`、`NO_CHAIN`、`RESTORE_REFUSED`） | 2 |
| `integrity_ok` | 1～3 通過，但未重算（`--no-recompute`） | 3 |

報告內容：驗證器版本與平台（Node 版本、作業系統、CPU 架構）、輸入檔 SHA-256、存檔的版本／指紋／時刻／鏈、重算結果、逐項檢查與診斷。報告**未簽章**：它是可重現的證據（任何人可用同一版本重跑），不是憑證。

**用戶自填的 hash 不是驗證**：把 payload 改掉再把 `payload_sha256`、`chain.head`、`export_sha256` 全部重算，第 1 步會通過，但第 4 步一定 `mismatch`（測試涵蓋：改位置、改帳本、偽造 head、改一個事件、刪一個事件、改種子）。

## 8. 三種狀態與 UI

| 狀態 | 誰能給 | 條件 |
|---|---|---|
| 本機可玩 | 瀏覽器 | 存檔相容、可讀取（存檔清單不重算雜湊，只顯示這一級） |
| 完整性檢查通過 | 瀏覽器 | 讀取時儲存模組重讀並重算雜湊、檢查信封與版本，Worker 還原時檢查結構與事件鏈欄位，全部通過 |
| Node 已重算驗證 | 只有 Node 驗證器 | `status = node_verified` 且針對**這一份**存檔（輸入檔雜湊、`payload_sha256`、`chain.head` 完全相同） |

- 存檔清單每一列顯示「本機可玩｜未經 Node 驗證」；讀取後世界畫面的存檔狀態列顯示「完整性檢查通過｜未經 Node 驗證」；新遊戲顯示「本機可玩｜未經 Node 驗證」（`save-format.ts` `verificationOf()`，測試保證它永遠不會給出 Node 已重算驗證）。
- **報告匯入（設計，未實作）**：使用者交來的報告本身也是用戶提供的資料，可以被偽造，因此瀏覽器**不得**只因匯入報告就顯示「Node 已重算驗證」。可行做法（需 Owner 決定）：(a) 由受信任的驗證服務以金鑰簽章報告，瀏覽器驗章且比對存檔雜湊與 head；或 (b) 只顯示「附有 Node 報告（未簽章，未經本機確認）」並提供重跑指令。在此之前一律顯示「未經 Node 驗證」。
- 驗證失敗保留可診斷資料：驗證器報告列出重算值與差異欄位；瀏覽器端的損壞快照仍依 SAVE-1 移入隔離區保留，不自動修補、不改寫。

## 9. 原子提交（雙槽或等效）

SAVE-1 的寫入程序等同（且多於）雙槽：

1. 新快照寫入**新的**代號紀錄（`pending`），從不覆寫已驗證的快照；
2. 另一個交易重讀、重算 SHA-256、比對信封；
3. 單一 IndexedDB 交易（全有或全無）把最新指標 `slots[0]` 移到新代號並標 `verified`，同時保留 3 個回復點與所有手動存檔。

任一步中斷（包括在寫入／提升中途終止整個瀏覽器，SAVE-2 驗收 B 以 SIGKILL 測試）時，最新指標仍指向上一個已驗證快照；讀取時最新快照損壞就回到上一個並告知。這等於「雙槽＋原子指標切換」，回復點數為 3。

本 PR 的改進：寫入與提升兩個交易要求 `durability: 'strict'`（瀏覽器支援時，交易 `complete` 只在資料寫入持久儲存後才觸發，使「已儲存」不會在作業系統當機時遺失；不支援的瀏覽器忽略此選項，維持原行為）。效果未在手機實機或斷電情境驗證。

## 10. 已驗證與未驗證範圍

- 已在本 PR 測試：Node 22（x64 Linux）上的事件鏈定義、行為不變、任意分段／工作預算／同時刻批次、存檔→還原→接續（含兩次重啟）、驗證器的誠實與竄改案例、CLI 不修改輸入；Chromium（headless，x64）上 Worker 與存檔流程的既有瀏覽器驗收。
- **未驗證**：ARM64（手機與 Apple Silicon）、Firefox／Safari／手機瀏覽器、手機實機的背景終止與斷電。#197 的跨環境一致性證據只涵蓋實際測過的 Node／Chromium／Worker；逐位元一致的聲明只限這些環境。若日後發現跨平台浮點差異，先處理決定性數學或定義相容界線，不得宣稱普遍一致。

## 11. 測試

| 測試 | 內容 |
|---|---|
| `tests/save-verify.test.ts` | §3～§7：鏈定義與向量、行為不變釘選、還原檢查、分段／預算／同時刻／重啟、驗證器各狀態與竄改案例、CLI |
| `tests/worker-runtime.test.ts` | 既有：連續 vs. 分段、節奏無關、拒絕竄改快照（payload 結構 2） |
| `tests/worker-boundary.test.ts` | Node 驗證器例外：只限 `cli/verify-save.ts`、唯讀；其他 `cli/` 檔案 import Worker 仍被拒絕 |
| `tests/save-format.test.ts` | 結構 1 存檔在結構 2 runtime 下為 `no_migration_path`；`verificationOf` 永不給 Node 已重算驗證 |

# 非正式實驗世界存檔系統（SAVE-0 契約）

> 狀態：SAVE-0 契約、SAVE-1 儲存模組、SAVE-2 選單／自動存檔／接續（§12c，已接上 Worker 與 V6-2 實驗模式，並在真實 Chromium 做 SAVE-3 式驗收）。
> 依據：Owner SAVE 需求（2026-11-08，P0）與 CLAUDE.md §9「實驗世界本地存檔」最小例外；邊界見 [`experimental-worker-boundary.md`](experimental-worker-boundary.md) §4b。若本文件與 CLAUDE.md 不一致，以較嚴格者為準。

本系統**只**保存非正式實驗世界。正式 Day14 存檔、`saves/`、`journal/` 與 Node 正式推進流程完全不受影響，也不能被本系統讀寫。

## 1. 架構與責任

```
UI（選單／存檔狀態）──► Worker Client ──postMessage──► Experimental Web Worker（權威狀態）
        ▲                    │  ▲                               │ 只在一致事件邊界產生快照
        │ 儲存狀態            │  └──────── 快照（envelope）◄──────┘
        │                    ▼
        └──────────── save-store.ts（唯一寫入 IndexedDB 的模組；資料庫名稱 antempire-experiment-*）
```

| 角色 | 可以 | 不可以 |
|---|---|---|
| Worker | 擁有權威世界狀態；在事件邊界序列化快照；從快照還原 | 使用任何持久化 API；因存檔改變行為、時間或隨機串流 |
| Worker Client | 轉送快照與還原指令 | 修改 payload |
| `web/src/experimental/save-store.ts` | IndexedDB、`navigator.storage.persist/estimate/persisted`、`navigator.locks` | 開啟非 `antempire-experiment-` 開頭的資料庫；localStorage、Cache API、網路、檔案選擇器；讀取或解析 payload 內容 |
| Renderer | 讀取最新狀態並繪製 | 修改世界；觸發存檔以外的狀態改變 |

payload 對儲存模組是**不透明**的：儲存模組只計算雜湊、檢查信封欄位、保存與取回。

## 2. 快照信封（`antempire.experiment-world-snapshot.v1`）

Worker runtime 與儲存模組共用此信封，欄位不得增減（新增欄位要升 `schema` 版本並寫遷移）。JSON Schema：[`prototypes/continuous-world/save/experiment-world-snapshot.v1.schema.json`](../prototypes/continuous-world/save/experiment-world-snapshot.v1.schema.json)。

| 欄位 | 型別 | 意義 |
|---|---|---|
| `schema` | 常數 `antempire.experiment-world-snapshot.v1` | 信封格式 |
| `label` | 常數 `非正式實驗世界／不屬於正式遊戲歷史` | 必要標示 |
| `official` | 常數 `false` | 永遠不是正式世界 |
| `world_id` | 字串 `^exp-[A-Za-z0-9._-]{1,60}$` | 實驗世界 ID（新遊戲時產生，不重複使用；格式與 Worker runtime 相同） |
| `seed` | 整數 0～2³²−1 | 世界種子（新種子或使用者指定；Worker runtime 只接受此範圍的整數，使用者輸入的文字種子由選單先轉成整數並顯示） |
| `rules_fingerprint` | 字串 | 引擎＋參數指紋；不同指紋表示規則不同，不能接續 |
| `engine_version` | 字串 | Worker runtime 版本 |
| `schema_version` | 正整數 | **payload** 結構版本（目前 2，含事件鏈承諾；見 [`save-format-v2.md`](save-format-v2.md)）；遷移以此為準 |
| `t_sim` | 非負數 | 模擬時間：實驗 Day0 00:00 起算的**秒數**（與 Worker runtime 事件的 `t_sim` 相同；畫面顯示第 ⌊t/86400⌋ 日與當日時刻） |
| `seq` | 非負整數 | Worker 事件序號；快照位於第 `seq` 個事件提交之後 |
| `payload` | JSON 物件 | 世界完整狀態（§3），對儲存模組不透明 |
| `payload_sha256` | 64 位小寫十六進位 | `SHA-256(UTF-8(canonicalJSON(payload)))` |

**canonicalJSON**：物件鍵依 UTF-16 碼元排序、無空白、數字用 ECMAScript `JSON.stringify` 的最短往返表示；`NaN`、`±Infinity`、`undefined`、函式、`BigInt`、typed array 不得出現（typed array 由 Worker 轉為一般陣列或 base64 字串）。`-0` 會寫成 `0`：若 Worker 狀態依賴 `-0` 與 `0` 的差異，驗收 A（§12）會失敗並揭露。儲存模組保存的就是 canonical 文字，回讀時重算雜湊。Worker runtime 的 `canonicalJson`／`hashJson` 與 [`canonical-vectors.v1.json`](../prototypes/continuous-world/save/canonical-vectors.v1.json) 的向量逐一相同。

**對未來 payload 的要求**：所有新加入 payload 的狀態都必須是 canonical JSON 資料。特別是化學場（費洛蒙格點）、物理狀態等目前可能以 typed array 實作的資料，必須序列化成一般數字陣列（或明確定義、可逆的編碼），且不得依賴 `-0`、`NaN`、`Infinity`；加入時要在驗收 A 證明還原後逐位元組相同，並量測快照大小與存檔時間。

## 3. 必須保存的內容（payload）

原則：**任何會影響未來的狀態都要保存**。只有能由已保存資料確定性重建、且有測試證明重建後完全相同的資料可以省略（列入 `rebuildable`）。載入時**絕不重新抽樣命運**（死亡、出生、發育時間、天氣等已決定的結果都從快照讀回）。

完整清單：[`prototypes/continuous-world/save/snapshot-content.v1.json`](../prototypes/continuous-world/save/snapshot-content.v1.json)（測試檢查四大類都在）。

1. **世界**：世界 ID、種子、世界與物種設定（或其指紋＋可解析的版本）、規則版本與指紋、模擬時間、天氣與環境狀態、生態資源（植物、半翅目、昆蟲族群、自然食源與來源 ID）、生產／消耗／遷移／食物帳本。
2. **蟻群與個體**：穩定 ID、生死狀態、年齡與發育階段、飢餓／營養／嗉囊與負載、受傷、位置與朝向、當前活動、個體記憶（路線、食源）、巢與巢內資源。
3. **物理與化學（整合後才要求）**：身體狀態、速度、待處理物理事件、化學場與衰減狀態、個體局部感知狀態。整合前此類標 `required_when: "integrated"`，Worker 若尚未模擬就不輸出，也不得捏造。
4. **連續性**：PRNG 種子、具名亂數串流與各自的抽取進度、事件佇列（含排程時間與次序鍵）、待執行的行為與計時器，以及其他任何影響未來的狀態。

## 4. 一致事件邊界

快照只在**一致事件邊界**產生：所有已開始的事件都已提交，沒有半途的交哺、捕食、搬運或未結算的食物轉移；帳本守恆在此刻成立。Worker 在輸出快照前自行檢查（開放中的轉移數為 0、帳本收支平衡），失敗就不輸出並回報，不得輸出「差不多」的狀態。儲存模組無法檢查 payload 內容，因此這是 Worker 的責任（SAVE-2 測試）。

存檔只**讀取**狀態：不得推進時間、不得抽取亂數、不得改變事件順序。驗收 E 檢查有存檔與無存檔的結果完全相同。

## 5. 原子寫入與回復點

IndexedDB 資料庫 `antempire-experiment-worlds`（版本 1）：

| 物件庫 | 鍵 | 內容 |
|---|---|---|
| `worlds` | `world_id` | 名稱、種子、建立時間、`next_gen`、`slots`（已驗證快照的代號，新到舊）、`quarantined`、最後儲存時間、摘要（蟻后／工蟻數，由 client 提供） |
| `snapshots` | `[world_id, gen]` | 信封欄位、canonical payload 文字、雜湊、狀態 `pending`／`verified`、寫入時間 |

`gen` 是儲存模組自己的遞增代號，與 Worker 的 `seq` 無關（從較早的快照回復後，確定性重跑可能再產生相同 `seq`）。

**寫入步驟**（每步一個交易，只有收到交易 `complete` 才算完成）：

1. **寫入**：分配 `gen = next_gen`，以 `pending` 寫入新快照；`slots`（最新指標）不變。
2. **驗證**：另一個交易回讀，重算 SHA-256，比對信封欄位與 `world_id`、`gen`。
3. **提升**：確認 `slots[0]` 仍是本分頁預期的值（樂觀並行檢查），把新 `gen` 放到 `slots` 最前面，標 `verified`，刪除超出保留數與殘留的 `pending` 紀錄。
4. 交易 `complete` 後，UI 才能顯示「已儲存」。

任一步失敗：最新指標仍指向上一個已驗證快照；回報型別化錯誤（`quota_exceeded`、`aborted`、`verify_failed`、`conflict`、`not_writer`、`write_failed`）。

**保留**：至少 2 個、預設 3 個已驗證快照（產品候選值，不是生物參數）。

**載入**：依 `slots` 由新到舊讀取，第一個通過檢查（雜湊、信封、`official === false`、標示、版本）的快照就是結果。若跳過了較新的快照，回傳 `recovered: true` 與原因，UI **必須**告知使用者。所有快照都失敗時回傳 `no_valid_snapshot`；**任何情況都不會默默建立新世界**。損壞的快照移入 `quarantined`（保留供診斷，不再當作回復點）。

## 6. 版本與遷移

- 載入時比較信封與目前 runtime：`schema` 不認得 → `unknown_schema`；`schema_version` 比目前新 → `newer_schema`（不可載入，不修改）；較舊 → 依遷移登錄表逐版遷移；`rules_fingerprint` 不同 → `rules_mismatch`（不能接續，只能匯出或刪除，因為接續會用不同規則改寫歷史）。
- 遷移是明確、逐版的純函式（`n → n+1`）。v1 是恆等。遷移在副本上執行，結果重新計算雜湊；**原快照不變**。遷移失敗時原始資料完整保留，回報 `migration_failed`。遷移後的世界在下一次存檔時才以新 `gen` 寫入。

## 7. 自動存檔

| 觸發 | 規則 |
|---|---|
| 每 30 秒真實時間檢查 | 若上次成功儲存後世界有變化就存檔（產品候選值；SAVE-1 量測寫入成本後再定） |
| 暫停 | 存檔 |
| 回到選單前 | 存檔完成（或失敗並告知）後才離開 |
| `visibilitychange → hidden`、`pagehide` | 額外嘗試；手機可能在完成前終止頁面，**不能是唯一機制** |
| 「立即存檔」按鈕 | 手動存檔 |

同時只進行一次存檔；進行中又有觸發時合併為一次後續存檔。UI 狀態：「正在儲存」「已儲存」「上次成功儲存時間」「儲存失敗」。「已儲存」只在 IndexedDB 提升交易的 `complete` 事件後顯示。

**離線時間不模擬**：關閉瀏覽器期間世界不推進；回來時從已儲存的 `t_sim` 繼續。

## 8. 多分頁

每個世界一個 Web Lock（`antempire-experiment-world:<world_id>`）。取得鎖的分頁是唯一寫入者；第二個分頁為**唯讀**，或提示使用者「切換到此分頁」（`steal`，原分頁收到通知後轉為唯讀，之後的寫入被拒絕）。不支援 Web Locks 的瀏覽器只靠 §5 的樂觀並行檢查，並在 UI 標示。

## 9. 風險與告知

| 風險 | 處理 |
|---|---|
| 寫入失敗、配額不足 | 型別化錯誤；顯示「儲存失敗」與原因；舊存檔不受影響 |
| 手機背景終止 | 30 秒週期＋暫停＋隱藏時嘗試；最多損失最後一個週期 |
| 私密模式、清除網站資料 | 存檔可能消失；首頁說明，建議匯出備份 |
| 版本更新 | §6；不相容的存檔不會被修改或刪除 |
| 分頁衝突 | §8 |
| 永久性 | 請求 `navigator.storage.persist()`，但**不保證**永久保存，UI 不得宣稱永久 |

## 10. 匯出／匯入

匯出檔 `antempire.experiment-world-export.v1`（[`schema`](../prototypes/continuous-world/save/experiment-world-export.v1.schema.json)）：世界中繼資料＋最新已驗證快照信封＋整體 SHA-256。下載由畫面以 Blob 產生（部分沙箱環境擋下載，真實觀察器可用）。匯入時檢查：格式、`official === false`、標示、payload 雜湊、整體雜湊、規則相容性；已存在相同 `world_id` 時拒絕（不覆寫）。匯入不得產生正式存檔。

## 11. 選單

「繼續遊戲」（最近儲存的世界）／「開始新遊戲」／「讀取存檔」／「存檔管理」。

- **新遊戲**：新的 `world_id`；新種子或使用者指定；合法的實驗 Day0（依本種研究依據，不是選存活率最高的實驗組）；立即寫入初始快照；不覆寫任何世界；世界之間不共用資料。
- **存檔清單**：名稱、種子、模擬日與時間、上次儲存時間、蟻后／工蟻數、版本相容性、「非正式」標示。
- **改名**；**刪除**需頁面內兩步確認（不用 `confirm()`），且只能由持有寫入鎖的分頁執行。

## 12. 驗收測試

| 代號 | 內容 | 階段 |
|---|---|---|
| A | 連續跑 48 小時 vs. 跑 24 小時 → 存檔 → 終止 Worker → 新 Worker 載入 → 再跑 24 小時；比較完整狀態、位置、事件、資源、化學場、帳本與亂數串流 | SAVE-2（需 Worker runtime） |
| B | 執行中強制終止 → 回到最後一個已提交快照，絕無半寫狀態 | SAVE-1（合成 payload）、SAVE-2（真實 Worker） |
| C | 新遊戲隔離：建立、推進世界 B 不改變世界 A 的任何紀錄 | SAVE-1（合成）、SAVE-3 |
| D | 損壞最新快照 → 偵測、告知、回復上一個 | SAVE-1 |
| E | FPS、縮放、追蹤、播放速度與存檔本身都不改變結果 | SAVE-2／SAVE-3（需 Worker 與畫面） |

SAVE-1 只用**合成 payload**（Worker runtime 尚未合併），不得宣稱已與 Worker 整合。

**階段**：

| 階段 | 內容 | 依賴 |
|---|---|---|
| SAVE-0 | 本文件、schema、契約測試 | 3080e24（#39 例外） |
| SAVE-1 | `save-store.ts`：原子寫入、回復、遷移、鎖、匯出入、清單；Node 純邏輯測試＋Chromium 實機測試 | SAVE-0 |
| SAVE-2 | Worker 快照產生與還原、一致事件邊界、驗收 A／B／E | Worker runtime（PR 2）、SAVE-1 |
| SAVE-3 | 選單、存檔狀態 UI、自動存檔接線、驗收 C／E 的畫面部分 | V6-2 畫面整合（PR 3）、SAVE-2 |

## 12b. SAVE-1 實作與量測（合成 payload）

- `web/src/experimental/save-format.ts`：純邏輯（canonical JSON、SHA-256、信封檢查、相容性、遷移登錄、匯出入檢查、保留規則、自動存檔狀態機），`tests/save-format.test.ts` 在 Node 測試。
- `web/src/experimental/save-store.ts`：唯一使用 IndexedDB／Web Locks／`navigator.storage` 的模組。寫入者必須先 `createWorld` 或以鎖 `loadLatest`，才能 `saveSnapshot`（樂觀並行檢查需要知道目前的最新指標）。
- `tests/browser/save-store.check.cjs`：真實 Chromium（CI viewer-smoke job）。涵蓋：寫入中與提升中中止、注入配額錯誤、在 3.7 MB 存檔的不同時點關閉頁面或讓 renderer 崩潰（10 次，舊快照保留 5、新快照提交 5，皆無半寫）、損壞偵測與回復、全部損壞時 `no_valid_snapshot`、兩分頁搶鎖與 `steal`、世界 A 在建立與推進世界 B 後逐位元組不變、關閉瀏覽器後重新啟動繼續、遷移與失敗遷移、匯出入、兩步刪除。
- 寫入成本（headless 桌面 Chromium，三次中位數；**不是手機量測**）：約 0.07 MB 12 ms、0.72 MB 70 ms、3.7 MB 250 ms（其中雜湊約 40%）。30 秒週期在此量級下負擔很小；真實 payload 大小要等 SAVE-2 才知道。
- **尚未整合**：Worker runtime 未合併，所有 payload 都是合成資料；驗收 A、E 與 UI 尚未進行。

## 13. 待協調事項

- `t_sim`（秒）、`seed`（0～2³²−1 整數）、`world_id`（`exp-` 開頭）已與 Worker runtime（`docs/experimental-worker-runtime.md` §4、`prototypes/continuous-world/worker/core.ts`）對齊。
- 化學場等大型狀態整合時的編碼與大小（見 §2「對未來 payload 的要求」）。
- 30 秒週期與保留 3 份是產品候選值，依 SAVE-1 的寫入成本量測再定。

## 12c. SAVE-2：選單、自動存檔與接續（Worker 整合）

> Owner 決策 47、53～57（2026-11-08）適用。仍然只有**非正式實驗世界**；只能本機接續，不跨裝置同步。

**模組**：`web/src/experimental/session.ts`（Worker client＋儲存模組＋自動存檔控制器；不直接使用任何儲存 API）、`web/src/v62-menu.ts`（選單）、`web/src/v62.ts`（世界畫面），頁面 `web/experiment.html`。`?seed=N` 仍是不存檔的臨時實驗（V6-2 測試用）。

**選單**：【繼續遊戲】（最近儲存的世界）【開始新遊戲】【讀取存檔】【存檔管理】，並顯示持久儲存是否獲准、已用空間與配額，以及「瀏覽器仍可能刪除存檔，請匯出備份」（決策 56；不宣稱永久）。

- **新遊戲**：新的 `exp-<UUID>` 世界 ID；種子留空＝隨機 uint32、0～4294967295 的整數＝原值、其他文字＝SHA-256 前 4 位元組（大端）並顯示結果；選擇世界種類（預設 **P0-A2 24 小時個體行為世界**，候選／實驗世界，非正式；或合成測試世界），從該世界的實驗 Day0（第 0 天 00:00）開始，**建立後立即寫入初始快照**；重複 ID 被儲存模組拒絕，不覆寫。每個存檔世界的相容性以**它自己的世界種類**（快照的 `engine_version`）的執行環境判斷；未知引擎版本以預設種類判斷（顯示規則不同）。P0-A2 快照格式見 `experimental-worker-runtime.md` §9。
- **存檔清單**：名稱、「非正式」、世界 ID、種子、實驗第 ⌊t/86400⌋ 天 HH:MM:SS、上次儲存時間、上次存檔大小與耗時、個體數（取自快照；合成世界**沒有蟻后**，顯示「個體 6（合成世界：沒有蟻后，個體不分階級）」；P0-A2 世界顯示「工蟻 30、幼蟲 8」，蟻后尚未模擬；不捏造）、回復點與隔離數、相容性；手動存檔另列，可單獨讀取。
- **改名**；**刪除**：頁面內兩步確認（不使用 `confirm()`），目前開啟的世界不能刪除。
- **匯出**：Blob 下載備份檔（不是正式存檔；不相容的世界也能匯出，決策 53）。**匯入**：檔案超過 16 MB 不讀取；只做 JSON 解析與檢查（格式、標示、雜湊、規則相容性），不執行任何內容（決策 57）；同一世界已存在時拒絕並提供 **「匯入為副本」**（決策 54）：新紀錄 ID `exp-copy-<UUID>`，保存來源的已驗證快照**原樣**（快照內的世界 ID 仍是來源 ID，記為 `sim_world_id`，世界狀態不變），並記錄來源世界 ID、名稱、匯出時間、`export_sha256`、`payload_sha256` 與「匯入時重算相符（只偵測意外損壞，不是真實性證明）」。
- **規則不同**（決策 53）：清單標示「規則不同，無法繼續」並列出存檔與目前的規則指紋、引擎版本、結構版本；讀取按鈕停用、載入被拒，存檔原樣保留，可以匯出。遷移路徑以後再做。

**自動存檔**（決策 55）：每 1 秒檢查一次，距上次嘗試 ≥30 秒（真實時間）且世界有變化（有新事件或執行中世界時間前進）就存；暫停時存；回到選單前存（完成或失敗告知後才離開）；`visibilitychange → hidden` 與 `pagehide` 額外嘗試（手機可能先被終止，不是唯一機制）；「立即存檔」為手動存檔。

- 自動存檔輪替保留 **3 個回復點**；**手動存檔另外保存**（`manual` 清單），輪替與清理永遠不刪；每個世界最多 20 個手動存檔，超過時拒絕（`manual_limit`），不會刪舊的。
- 狀態：「正在儲存」「已儲存」（只在提升交易 `complete` 後）、「上次成功儲存時間」、本次大小與耗時（雜湊＋寫入＋驗證＋提升）、「⚠ 儲存失敗（原因）— 上一個成功的存檔仍保留」。配額不足顯示 `quota_exceeded`。
- 快照只由 Worker 的 `snapshot` 指令產生（Worker 單執行緒，指令之間就是一致事件邊界）；取快照不抽亂數、不推進時間。

**多分頁**：每個世界一個 Web Lock。第二個分頁開啟同一世界時顯示「另一個分頁正在使用」並提供【切換到此分頁】（接手；原分頁收到通知轉為唯讀並顯示橫幅）或【唯讀開啟（不存檔）】。

**載入**：讀取最新回復點（或選定的手動存檔）→ 驗證（雜湊、信封、標示、版本）→ Worker `restore`（Worker 再驗證一次）→ 從該 `t_sim` 繼續（預設 1×）。最新快照損壞時自動回復上一個並在畫面上警告；全部損壞時拒絕（`no_valid_snapshot`），**不會默默建立 Day0**。關閉期間世界不推進。

### 驗收（`tests/browser/save2-acceptance.check.cjs`，真實 Chromium、持久設定檔＝磁碟上的 IndexedDB）

| 項目 | 內容 |
|---|---|
| Owner 最小流程 1～10 | 開啟 → 新遊戲 → 世界運作 → 30 秒自動存檔完成 → 關閉瀏覽器 context → 重新開啟 → 繼續遊戲 → 精確從最後一次提交的存檔接續 → 建立第二個世界 → 第一個世界仍可獨立讀取 |
| A | 24 h → 手動存檔 → 關閉頁面（Worker 終止）→ 新頁面／新 Worker → 繼續 → 再 24 h；與另一個 Worker 連續 48 h 比較：所有事件（ID、精確時刻、資料、每次亂數抽樣）與 48 h 完整 payload（標準 JSON）相同 |
| B | 3600× 下每 120 ms 要求存檔，隨機時刻以 SIGKILL 終止整個瀏覽器（3 次）；重開後最新回復點都是已驗證快照，世界從最後一次提交接續 |
| C | 建立、執行、存檔另一個世界後，世界 A 的紀錄與快照逐位元組不變 |
| D | 損壞最新快照 → 警告並回復上一個（t>0）；全部損壞 → 拒絕，不建立世界 |
| E | 縮放、拖曳、追蹤、幀率上限、改速、暫停與手動存檔 → 與未操作的獨立 Worker 在同一 t_sim 事件流與 payload 雜湊相同 |
| 其他 | 多分頁接手／唯讀、規則不同拒絕並顯示版本差異且可匯出、匯入為副本、兩步刪除、改名、手動存檔不被輪替、Pixel 7 觸控畫面 |

Node 端：`tests/save2-session.test.ts`（阻擋性）—標準 JSON 往返後還原與連續世界逐位元相同（4 個切點）、每拍取快照不改結果、清單個體數取自快照且不捏造蟻后、種子轉換（與 node:crypto 交叉驗證）、匯入大小限制、副本驗證、手動存檔不被清理、選單不用 `confirm()`、名稱經過跳脫、不執行匯入內容。

**不能誠實做到的**：手機作業系統在背景直接終止頁面無法在此環境重現；B 用桌面 Chromium 的 SIGKILL 代替。Pixel 7 是模擬視窗與觸控，不是實機。存檔大小與耗時是無頭 Chromium 在測試機上的數字。

## SAVE-O：存檔格式 v2、事件鏈承諾與 Node 驗證（Owner 裁示 #200）

詳見 [`save-format-v2.md`](save-format-v2.md)。摘要：

- payload 結構升為 2：新增 `save_meta`（世界種類、受信任的初始條件與種子、物種與環境的版本與指紋、fork 紀錄）與 `chain`（`antempire.event-chain.v1` 事件鏈承諾：head＋count）。信封與匯出容器不變。結構 1 的存檔無法接續（沒有事件鏈），原檔保留、可匯出。
- `cli/verify-save.ts`（`npm run verify:save`）以同一核心由受信任的初始條件重算，比對事件鏈與狀態雜湊；只讀不寫。
- 三種狀態：「本機可玩」「完整性檢查通過」（瀏覽器）、「Node 已重算驗證」（只由驗證器）；瀏覽器目前一律顯示「未經 Node 驗證」。
- 原子提交：§5 的先驗證再提升＋回復點等同雙槽；寫入交易改為 `durability: 'strict'`。

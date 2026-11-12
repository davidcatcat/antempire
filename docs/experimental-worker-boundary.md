# 非正式實驗 Worker 邊界（Owner 決策 #39）

> 狀態：規則與保護測試（PR 1／3）；Worker 執行環境（PR 2）見 [`experimental-worker-runtime.md`](experimental-worker-runtime.md)；V6-2 畫面整合（PR 3）見 [`v62-experiment-mode.md`](v62-experiment-mode.md)。白名單已擴充到 P0-A2 24 小時原型的核心檔（Owner 2026-11-12 授權，#156 第三階段，§4c）。
> 本文件說明 CLAUDE.md §9「觀察器的兩種模式」的有限例外；若兩者不一致，以 CLAUDE.md 與較嚴格者為準。

## 1. 為什麼要例外

最終產品目標是在網頁中觀看**持續自主運作**的螞蟻生態世界，而不只是播放 CLI 預先算好的歷史（Owner 2026-11-08）。
因此 V6-2 的主要實驗架構是 Web Worker；Node CLI 保留，負責正式推進與實驗結果的獨立驗證。

例外**只**適用於非正式實驗模式，正式觀察模式的規則全部不變。

## 2. 兩種模式

| | A. 正式觀察模式 | B. 非正式實驗模式 |
|---|---|---|
| 資料來源 | 正式引擎（Node）產生的 `web/data/` | Worker 中執行的隔離實驗世界 |
| `web/src/` 匯入 `engine/` | 不得 | 不得（只能經 Worker client 以訊息連接） |
| 執行模擬 | 不得 | 只在 Worker 內，不在畫面主執行緒 |
| 寫入 `saves/`／`journal/` | 不得 | 不得 |
| 標示 | 正式 | 「非正式實驗世界／不屬於正式遊戲歷史」 |
| 持久化 | 無 | 只經實驗儲存模組寫入 `antempire-experiment-*` IndexedDB（SAVE 例外）；其他持久化不得 |

## 3. 架構

```
V6-2 UI ──► Worker Client (web/src/experimental/worker-client.ts)
              │  postMessage（指令：init / start / pause / resume / speed / follow）
              ▼
        Experimental Web Worker (prototypes/continuous-world/worker/，獨立入口與建置設定)
              │  只匯入白名單內的純 TypeScript 模組
              ▼
        P0-A2 純 TypeScript 引擎（模擬時間契約）
              │  事件／狀態（帶 seq、event_id、t_sim、版本、種子、參數指紋）
              ▼  postMessage
        V6-2 Renderer（只讀；插值只用於畫面，不回寫）
```

- UI 不得直接修改模擬世界的權威狀態；指令只能改變**排程**（開始、暫停、速度）與**觀察**（追蹤個體），不能改變生物規則、種子或自然事件。
- Worker 獨立於 Renderer 運作；FPS、手機效能與鏡頭操作不得改變模擬因果。

## 4. 匯入白名單（`prototypes/continuous-world/worker-boundary.json`）

- 允許：`prototypes/continuous-world/worker/`、`engine/clock/`、`engine/scheduler/`、`engine/rng.ts`、`engine/sha256.ts`（rng 的相依）。白名單必須對匯入封閉：白名單模組的遞移相依也必須在白名單內（測試檢查）。
- 禁止：`cli/`、`saves/`、`journal/`、`tests/`、`web/`、`sim/`、`engine/index.ts`、`engine/day.ts`（正式日循環）、`engine/legacy.ts`、`engine/migration.ts`。
- 禁止任何 `node:` 或外部套件匯入、非字面的動態 `import()`、巢狀 Worker。
- 禁止在 Worker 匯入圖中使用：IndexedDB、Cache API、localStorage／sessionStorage、`fetch`、XHR、WebSocket、EventSource、`navigator`（含 `navigator.storage` 檔案系統）、`importScripts`、BroadcastChannel、檔案選擇器 API、`require`、`process`、`Buffer`；以 `self.x`、`globalThis['x']` 形式出現也算。
- 匯入圖中的 `engine/` 模組不得使用 `Math.random`、`Date.now`、`new Date(`、`performance.`、`requestAnimationFrame`、`setTimeout`、`setInterval`（行為只依模擬時間與種子）。
- 匯入圖中不得出現指向正式資料的路徑字串（`saves/`、`journal/`、`commit-log`、`.advance-tmp`）。
- `web/src/` 中只有清單內的 client 檔可以 `new Worker(...)`；正式程式（`engine/*.ts`、`engine/scheduler/`、`engine/clock/`、`cli/`、`web/src/`）不得匯入 Worker 目錄。
- P0-A2 新增的純模組要加入白名單時，屬規則修改：另開 PR、列出該模組的純度檢查，並取得 Owner 授權。**Owner 2026-11-12 的授權（#156 第三階段）取代了原本「經 Codex 固定 SHA 審查」這一步**（適用於這類白名單擴充）。CLAUDE.md §9 B 已由 #203（依 #200 裁示）改為「依 Owner 2026-11-12 授權由 Claude 自審並附邊界測試證據（Codex 恢復後另安排獨立審查）」，與本段一致。

## 4c. P0-A2 24 小時原型核心（Owner 2026-11-12 授權，#156 第三階段）

- **加入白名單的檔案（只有核心，逐檔列出）**：`prototypes/p0a2-24h/canon.ts`、`decision.ts`、`environment.ts`、`params.ts`、`types.ts`、`world.ts` 與參數檔 `params.json`（以 JSON 模組匯入）。`observer.ts`（觀察算子）不在白名單；`prototypes/p0a2-24h/tools/`（Node 分析工具，使用 `fs`）與 `out/` 列入**禁止**清單。
- **純度檢查**：新增 `pure_module_prefixes: ["engine/", "prototypes/p0a2-24h/"]`，`forbidden_in_engine_modules`（`Math.random`、`Date.now`、`new Date(`、`performance.`、`requestAnimationFrame`、`setTimeout`、`setInterval`）也套用到 P0-A2 核心；儲存／網路全域、`node:`／外部套件匯入、動態匯入、正式資料路徑字串的檢查本來就涵蓋整個 Worker 匯入圖。`tests/worker-boundary.test.ts` 的真實掃描現在也讀入 `prototypes/p0a2-24h/`，並確認 Worker 圖到達 `world.ts`、`decision.ts`、`params.json`，且不到達 `tools/`、`out/`、`observer.ts`。
- **新增負面樣本**（7 個，全部必須失敗）：匯入 `tools/`（denied-module）、匯入 `observer.ts`（not-allowlisted）、核心檔用 `Math.random`、用 `Date.now`（engine-impurity）、核心檔匯入 `node:fs`（node-import）、核心檔遞移匯入 `cli/`（denied-module）、核心檔用 `fetch`（forbidden-global）。
- **介接方式**：Worker 目錄內的薄轉接層 `prototypes/continuous-world/worker/p0a2-world.ts`（不改 P0-A2 任何行為檔），見 [`experimental-worker-runtime.md`](experimental-worker-runtime.md) §9。P0-A2 核心仍是平台無關（`prototypes/p0a2-24h/tsconfig.json`：無 DOM、無 Node 型別），Worker 的獨立 tsconfig 只多列這些檔案。
- 規則指紋包含 P0-A2 參數檔 SHA-256 與「程式碼 SHA-256」（P0-A2 轉接層的執行期匯入圖中每個 TypeScript 檔，`prototypes/continuous-world/tools/p0a2-code-hash.ts` 產生、`tests/worker-runtime.test.ts` 檢查是否過期）；任何一個檔案改變，舊存檔載入時都會被拒絕（`FINGERPRINT_MISMATCH`），不會在不同規則下默默接續。

## 4b. 實驗世界本地存檔例外（SAVE）

Owner 2026-11-08 授權非正式實驗世界的本地即時存檔：

- 只有 `experimental_save_store.files`（目前 `web/src/experimental/save-store.ts`）可以使用 IndexedDB、`navigator.storage.persist/estimate/persisted` 與 `navigator.locks`。
- 只能開啟字面名稱以 `antempire-experiment-` 開頭的資料庫；不得用 localStorage、Cache API、`fetch`、`sendBeacon`、檔案選擇器；只能匯入 `./` 觀察器模組；不得出現正式資料路徑字串。
- 快照由 Worker 在一致事件邊界產生，經 client 傳給儲存模組；Worker 匯入圖本身仍禁止所有持久化 API。
- 存檔格式、原子性、回復點、版本遷移、多分頁鎖與驗收測試見 `docs/experimental-save-system.md`（SAVE-0）。

## 5. 驗證

| 項目 | 何時 | 方法 |
|---|---|---|
| 匯入邊界 | PR 1 起 | `tests/worker-boundary.test.ts`：靜態匯入圖＋36 個負面樣本（cli／存檔／正式日循環匯入、遞移洩漏、`node:`、外部套件、動態匯入、儲存與網路 API、巢狀 Worker、路徑字串、引擎內牆鐘與亂數、client 以外建立 Worker、正式程式反向匯入、儲存模組以外使用 IndexedDB／Web Locks、非實驗前綴或計算出的資料庫名稱、儲存模組使用其他持久化或網路 API、儲存模組匯入引擎） |
| 建置限制 | PR 2 | Worker 獨立 tsconfig（`lib` 只含 `WebWorker`，`include` 只含 Worker 目錄與白名單模組） |
| 正式資料不可寫入 | PR 2 | 執行 Worker 前後 `saves/`、`journal/` 雜湊不變；匯入圖不含寫入 API |
| Node／Worker 比較 | PR 2 | 同一初始資料、種子、規則在 Node 與瀏覽器 Worker 執行，比較事件序列；浮點差異記錄並驗證誤差界 |
| 種子與重播 | PR 2 | 同環境重跑逐筆相同；不同播放速度、暫停點與分段推進結果相同 |
| UI 操作不改變結果 | PR 3 | 暫停、縮放、拖曳、追蹤個體、改變速度前後，相同模擬時刻的狀態相同（#144 方法） |
| 手機與桌面 | PR 3 | Playwright 桌面與手機尺寸；CPU、記憶體、FPS |

## 6. 與 #144、#145 的關係

#144「鏡頭不得改變生物命運」與 #145「單一權威帳本」仍是正式整合的阻擋條件。Worker 架構與隔離測試可以先做，但：

- 未通過 #144，不得宣稱觀察不影響結果；
- 未通過 #145，不得宣稱背景生態帳本已正確整合；
- 驗證完成前只能使用明確標示的隔離實驗世界。

## 7. 三張 PR

1. **PR 1（本 PR）**：CLAUDE.md 有限例外、本文件、邊界設定檔、保護測試。
2. **PR 2**：Experimental Worker Runtime。小型合成實驗世界；初始化、P0-A2 時間推進、狀態與事件、開始／暫停／繼續／速度、固定種子重播、Node 對照。不修改正式日循環。
3. **PR 3**：V6-2 畫面整合。持續運算的螞蟻世界、播放暫停、速度、個體追蹤、世界時間、手機與桌面、事件與畫面一致性、CPU／記憶體／FPS、正式與非正式隔離測試。

每張 PR 都要通過 typecheck、golden、naturalism、`check:saves` 與上表適用的項目，經 Codex 固定 SHA 獨立審查，未經 Owner 授權不合併。

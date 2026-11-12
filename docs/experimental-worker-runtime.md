# 非正式實驗 Worker 執行環境（P0-A2 PR 2，Owner 決策 #39）

> **地位**：非正式實驗世界／不屬於正式遊戲歷史。本 PR 只建立 Worker 執行環境與一個**合成**的小世界，讓「瀏覽器中持續運作、可暫停、可快照還原」的管線可以被測試。**不是螞蟻科學模型**，沒有任何本種行為；不修改正式每日循環、Day14、`saves/`、`journal/`，不推進遊戲日。
> 邊界規則見 [`experimental-worker-boundary.md`](experimental-worker-boundary.md) 與 CLAUDE.md §9 B；V6-2 畫面整合是 PR 3；本地存檔（SAVE-1，`web/src/experimental/save-store.ts`）由另一張 PR 實作，本 PR 不持久化任何東西。

## 1. 架構與檔案

```
web/experimental-worker.html ─ web/src/experimental/demo.ts（只畫圖）
        │
web/src/experimental/worker-client.ts（唯一可 new Worker 的檔；只送訊息，檢查每則回覆都標「非正式」）
        │ postMessage（worker-protocol.ts ＝ worker/protocol.ts，逐位元組相同）
        ▼
prototypes/continuous-world/worker/
  entry.ts     Worker 入口：計時器與 performance.now() 只用於「排程」（每一拍推進多少）
  runtime.ts   指令分派與節拍器（牆鐘以函式注入；Node 測試用假時鐘）
  core.ts      模擬核心（純 TypeScript；無 DOM／Node／牆鐘／Math.random）
  params.ts    合成世界參數（全部 assumption: true）
  rng.ts       具名亂數串流（mulberry32，狀態＝1 個 uint32＋抽取次數）
  detmath.ts   跨平台決定性數學（見 §6）
  sha256.ts    SHA-256 與標準 JSON（engine/sha256.ts 不在白名單，故在 Worker 目錄內移植）
  tsconfig.json  獨立建置：lib 只有 ES2023＋WebWorker、types 為空；include 只有本目錄與白名單模組；輸出 web/worker-dist/（gitignore）
```

Worker 匯入的引擎模組只有白名單內的 `engine/scheduler/world-events.ts`（排程器）、`engine/clock/solar.ts` 與 `engine/clock/time-frames.ts`（光照，一般方法）。`engine/rng.ts` 與 `engine/clock/environment.ts`／`weather-input.ts` **沒有**使用：它們會遞移匯入 `engine/sha256.ts`，不在白名單（見 §8）。

建置：`npm run web:build`（觀察器＋Worker）；`npm run typecheck` 包含 Worker 的 tsconfig。示範頁：`npm run web` 後開 `http://localhost:8780/experimental-worker.html`（可加 `?seed=N`）。

## 2. 訊息協定（`antempire.experiment-worker-protocol.v1`）

| 指令 | 作用 | 會改變什麼 |
|---|---|---|
| `init {world_id, seed}` | 建立新的隔離實驗世界（`world_id` 必須以 `exp-` 開頭；seed 為 0～2³²−1 整數）；處理 00:00 的事件 | 新世界 |
| `start`／`pause`／`resume` | 開始、暫停、繼續節拍 | 只有排程 |
| `set_speed {speed}` | 世界秒／真實秒，0.1～86 400；先以舊速度追到現在再換 | 只有排程 |
| `step_until {t_sim}` | 暫停時推進到世界時間 t（含 t），不可倒退 | 推進世界時間 |
| `snapshot` | 回傳快照（§4）；純讀取 | 無 |
| `restore {snapshot}` | 驗證後以快照取代目前世界；驗證失敗**拒絕**且目前世界不變（不重新初始化） | 換成已驗證世界 |
| `follow {id\|null}` | 追蹤個體（只觀察；回覆附該個體的唯讀副本） | 無 |

其他訊息一律 `UNKNOWN_COMMAND` 拒絕。沒有任何指令能改規則、參數、執行中世界的種子、個體或事件（§2.5 只觀察）。

回覆：`ack`（附狀態框）、`error {code}`、`events`、`state`（每拍）、`snapshot`。每則回覆都帶 `protocol`、`label: 非正式實驗世界／不屬於正式遊戲歷史`、`official: false`。每個事件帶 `seq`（從 0 連續）、`event_id`（排程器標準 ID）、`t_sim`（自第 0 日 00:00 起的秒數）、`exact`（精確時刻）、`round`、`world_id`、`seed`、`rules_fingerprint`、`engine_version`、`schema_version`、`rng`（串流名、起始抽取序號、本事件抽到的值），以及標示。

## 3. 時間契約

- 採 P0-A0／P0-A1 的 `layered` 契約（`WorldScheduler`，`order: 'layered'`、`on_conflict: 'refuse'`）。每個事件保留原生時間：工蟻時鐘 `ant.<id>`（秒）、`eco.calendar`／`eco.weather`／`eco.light`（分鐘）；排序只依精確時刻 → round → 標準 ID。
- 同一精確時刻的事件是**一個集合**：每個處理只讀批次前的狀態、只寫自己的個體或不同的環境欄位、只從自己的具名串流抽樣；兩個事件寫同一欄位會被拒絕（`SAME_INSTANT_CONTEST`，規則未決，不選贏家）。例：每日 00:00 的 `env_day` 與 `env_hour` 同批。
- `advanceTo(t)` 處理所有精確時刻 ≤ t 的批次，之後世界時間＝t。每拍工作量上限只會讓世界**晚一點**到達目標，且只停在兩個不同時刻之間（一致邊界）；**不跳過、不丟棄事件**。
- 節拍器：執行中每拍目標＝錨點世界時間＋速度×（牆鐘−錨點牆鐘）。暫停、繼續、改速只移動錨點；落後時重新錨定並回報 `lagging`。牆鐘與 `requestAnimationFrame` 都不決定行為；示範頁的 rAF 只畫圖。
- 下一個事件在批次提交後以「世界輸入」（根事件）排入，造成它的事件 ID 放在 payload 的 `cause`，所以長時間執行 ID 不會無限變長。已執行的事件在一致邊界從排程器中壓縮掉（已送出）；排序只依待處理事件，壓縮不改行為（測試：每 7 個事件壓縮與從不壓縮，結果相同）。

## 4. 快照格式（為 SAVE 系統設計）

```
{ schema: 'antempire.experiment-world-snapshot.v1', label: '非正式實驗世界／不屬於正式遊戲歷史', official: false,
  world_id, seed, rules_fingerprint, engine_version, schema_version, t_sim, seq, payload, payload_sha256 }
```

- `payload`＝完整權威狀態：參數、`now`（精確時刻）、每隻個體（穩定 ID、活動、線段起點與終點、開始／結束時刻、是否在巢內、記憶的最近途經點、下一事件 ID）、環境（日期、光照狀態與當日光照時刻、合成氣溫、下一環境事件 ID）、具名亂數串流（狀態＋已抽次數）、待處理事件佇列（壓縮後的排程器快照，含每個事件的原生時間與精確時刻）、帳本（各種事件數、每隻個體的段數、步行距離與時間）。
- `payload_sha256`＝payload 標準 JSON（鍵排序、−0 寫成 0）的 SHA-256。`rules_fingerprint`＝SHA-256（engine_version、schema_version、參數）。
- 只在一致事件邊界取得（Worker 單執行緒，指令之間永遠在邊界）；取快照是純讀取，**不消耗任何亂數、不改佇列與時間**（測試：48 小時內取約 170 次快照，結果不變）。
- `restore` 依序驗證：欄位集合、schema 與 schema_version、標示與 `official:false`、engine_version、雜湊、標頭＝payload、規則指紋＝本執行環境、`world_id`、排程器快照（原生時間→精確時刻逐位元、因果、round）、個體與佇列一致、串流齊全、帳本守恆。任何一項不符即拒絕（錯誤碼：`HASH_MISMATCH`、`SCHEMA_MISMATCH`、`NOT_EXPERIMENT`、`ENGINE_MISMATCH`、`HEADER_MISMATCH`、`FINGERPRINT_MISMATCH`、`BAD_QUEUE`、`BAD_STATE`、`LEDGER_MISMATCH`…），不修補。
- 已證明：連續 48 小時 ＝ 24 小時 → 快照 →（structured clone）→ 新執行個體 → 還原 → 24 小時；事件序列（含每次亂數抽樣的值）與 48 小時完整狀態逐位元組相同。另在某事件時刻、午夜（同時刻批次）與 23:59:59.5 切分也相同；瀏覽器中以「終止 Worker → 新 Worker → 還原」也相同。

## 5. 合成世界（全部遊戲假設）

6 隻個體在半徑 60 cm 的圓形場地；巢在中心。狀態機：巢內休息（指數分布，平均 900 s）→ 走一段隨機直線（5～40 cm，1 cm/s）→ 巢外停頓（指數分布，平均 120 s）→ 35% 回巢、否則再走一段。環境：光照轉換（曙光、日出、日落、暮光）由 `engine/clock/solar.ts` 以一般方法計算（代表點，花園為虛構情境）；逐時氣溫是 `synthetic: true` 的手寫 24 值剖面。**沒有任何個體讀取環境**；這些數值都不是本種資料，不得引用（`params.ts` 每個參數都有 `assumption: true` 與理由）。

## 6. Node 與瀏覽器 Worker 的比較（跨環境浮點）

- ECMAScript 的 `Math.sin/cos/log/exp/hypot/**` 等是「實作近似」。2026-11-08 實測：Node 22.23（V8 12.4）與 Playwright Chromium 153 在 2 000 個輸入中約 4～10% 相差 1 ulp。第一版核心用了 `Math.cos/sin/log/hypot`，48 小時中 3 228 個數值相差（最大 1.5×10⁻⁵ µs），事件順序仍相同，但 1 ulp 可能翻轉分支（例如場地邊界判斷）而讓兩個環境分岔。
- 因此個體規則改用 `detmath.ts`：只用 IEEE 基本運算（+、−、×、÷，ECMAScript 要求正確捨入）與 `Math.sqrt`（V8 在 x86-64／ARM64 為正確捨入；由比較測試量測，不是規格保證）。方向以單位圓拒絕抽樣、對數以 2ᵏ 縮減＋atanh 級數。
- 結果（種子 11、12、13，各 48 小時，`tests/browser/worker-runtime.check.cjs`）：17 937 個事件中 17 934 個逐位元組相同；3 個不同的都是 `engine/clock/solar.ts` 算出的**第 2 日日出時刻**（相差 1 ulp，5.7×10⁻¹⁴ 分），因此 48 小時完整狀態的雜湊不同，但去掉光照時刻後三個種子的完整狀態都逐位元組相同。誤差界：光照分鐘值 ≤ 10⁻⁹ 分、精確時刻 ≤ 10⁻³ µs（實測 3.4×10⁻⁶ µs）。
- **不宣稱**跨環境逐位元組相同。光照時刻的 1 ulp 差異不會影響個體（個體不讀光照），但若某個個體事件與光照事件相距小於 1 ulp，兩環境的順序理論上可能不同；這只能以比較測試觀察，無法證明。修正需要讓 `engine/clock/solar.ts` 使用決定性三角函數，屬於另一張規則／引擎 PR（待 Owner 裁示）。
- 後續調查（Owner 決定 51，`docs/solar-cross-env-check.md`）：系統掃描（4 年臺中代表點、緯度 −72°～72° × 6 經度）最大差 320 ulp（1.1×10⁻¹² 分），掃描中沒有任何分類、顯示或拒絕翻轉；但構造反例證明 1 ulp 可以改變同時刻批次、`tick` 標籤與邊界狀態，所以不只是顯示差異，不定義容許值，改提規則 PR（決定性三角函數）。

## 7. 驗證

| 測試 | 內容 |
|---|---|
| `tests/worker-runtime.test.ts`（阻擋性，Node） | SHA-256＝node:crypto；協定檔兩份相同；核心無牆鐘／亂數／實作近似函式；Worker tsconfig 限制；參數全部標示；事件標示與欄位；seq 連續、精確時刻不遞減、同時刻連續成組、每個串流連續抽樣、帳本守恆、光照事件時刻＝一般方法；同種子重播、不同種子不同；48 h 連續＝24 h＋快照＋還原＋24 h（四種切點）；快照純讀取；15 種竄改／外來快照被拒且目前世界保留；指令驗證；不同速度、暫停、拍長、工作量上限（3 批，會落後）與追蹤個體 → 相同結果；不規則分段相同；壓縮不改行為；`saves/`、`journal/` 雜湊不變 |
| `tests/worker-boundary.test.ts`（阻擋性） | 現在掃描真實 Worker 目錄：只匯入白名單、無儲存／網路 API、無正式資料路徑字串 |
| `tests/web.test.ts`（阻擋性） | 改為遞迴掃描 `web/src/`，`experimental/` 同樣只匯入 `./` 模組、無亂數、無寫入 |
| `tests/browser/worker-runtime.check.cjs`（CI viewer-smoke） | Chromium 真實 Worker：Node 比較（§6）、同環境重播、終止 Worker 後還原、不規則分段、節拍（3600×／86 400×／10×、暫停、繼續）後推進到 48 h 相同、竄改快照被拒、未知指令被拒、示範頁標示、持續移動與暫停凍結、`saves/`、`journal/` 不變 |

## 8. 限制與待決

- **合成世界**：不是科學模型；P0-A2 個體行為（`docs/p0a2-24h-behaviour-design.md`）尚未接入。
- **白名單**：`engine/sha256.ts`、`engine/rng.ts` 不在白名單，所以 Worker 內有 SHA-256 與 mulberry32 的移植副本（以 node:crypto 交叉驗證）。若要直接共用，需另開規則 PR 把 `engine/sha256.ts`（與 `engine/rng.ts`）加入白名單。
- **跨環境**：見 §6；光照時刻 1 ulp 差異未消除。
- 規則指紋只涵蓋 engine_version 與參數，不含程式碼雜湊；改核心行為時必須提高 `ENGINE_VERSION`。
- 執行中 Worker 只保留待處理事件；已送出的事件不留在 Worker 記憶體中（畫面端自行保存需要的事件）。
- 尚未做：#144（鏡頭不改命運）的完整畫面測試、#145 單一帳本、手機效能、V6-2 整合（PR 3）、本地存檔（SAVE-1）。

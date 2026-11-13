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
- **已解決（Owner 決定 #190，#193 裁示，2026-11-12，方案 A）**：`engine/clock/solar.ts` 改用 `engine/clock/detmath.ts`（只用 IEEE 基本運算與 `Math.sqrt`）。`ENGINE_VERSION` 提高為 `experiment-world-runtime/2`（舊版快照以 `ENGINE_MISMATCH` 拒絕）。同一比較（種子 11、12、13，各 48 小時）：17 937／17 937 個事件、3／3 個 48 小時狀態**逐位元組相同**；原本的光照誤差界已移除，改為嚴格相等。上兩點保留為歷史紀錄。只在 x86-64 驗證，**ARM64 未驗證**。詳見 `docs/solar-cross-env-check.md` §7。

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
- **跨環境**：見 §6；光照時刻的 1 ulp 差異已由 #190 方案 A 消除（x86-64 上 Node 與 Chromium Worker 逐位元組相同）；**ARM64 未驗證**（CI 沒有 ARM64 執行器）。
- 規則指紋只涵蓋 engine_version 與參數，不含程式碼雜湊；改核心行為時必須提高 `ENGINE_VERSION`。
- 執行中 Worker 只保留待處理事件；已送出的事件不留在 Worker 記憶體中（畫面端自行保存需要的事件）。
- V6-2 畫面整合（PR 3）已完成：`web/experiment.html`，見 [`v62-experiment-mode.md`](v62-experiment-mode.md)（含鏡頭／縮放／追蹤／速度／幀率不改結果的瀏覽器測試與無頭量測）。
- 尚未做：#145 單一帳本、實機手機效能。本地存檔接線（SAVE-2）已完成（`experimental-save-system.md` §12c）。

## 9. P0-A2 24 小時個體行為世界（#156 第三階段；候選／實驗世界，非正式）

> Owner #201：未經 Owner 核准不建立正式 Day0。這個世界只是**候選／實驗世界，非正式**；所有事件、狀態框與快照仍帶「非正式實驗世界／不屬於正式遊戲歷史」與 `official:false`。

- **世界種類**：協定的 `init` 多了可選的 `kind`（`'synthetic'`＝本文件 §5 的合成世界，省略時的預設；`'p0a2'`＝P0-A2 24 小時原型）。`restore` 依快照的 `engine_version` 選擇世界種類。實驗頁（`web/experiment.html`）的新遊戲預設為 P0-A2，`?world=synthetic` 或讀取合成世界的存檔時是合成世界。
- **轉接層** `prototypes/continuous-world/worker/p0a2-world.ts`（**不修改** `prototypes/p0a2-24h/` 的任何檔案）：以 `params.json` 的參考變體（`reference_variant`）與固定的天氣情境 `taichung-march-ref`（合成，`synthetic: true`）建立 `World`；`advanceTo(t)` 把節拍器的目標（世界秒）向下取到世界的整數毫秒後呼叫 `World.advanceTo`（連續事件時間；原型本身已證明任意切分不改結果）；世界自己的標準日誌行一行對應一個協定事件（`seq`＝日誌位置，`data`＝該行的 `p` 加上同時刻平手值 `tie_q`；`rng: null`——P0-A2 每個事件用自己的內容衍生串流 `rng(hash32(seed|event id))`，抽樣值沒有逐一記錄，事件日誌雜湊鏈涵蓋結果）。工作量上限以事件數計（`Runtime.P0A2_BUDGET`，預設 4 000）：以 60 秒世界時間為一段推進，達到上限就停在段落邊界（一致邊界），只會讓世界晚一點到達目標，不跳過事件。
- **快照**：仍是 `antempire.experiment-world-snapshot.v1` 信封（SAVE 系統不需改格式）。`payload`＝`{world_kind:'p0a2', world_id, seed, engine_version:'experiment-p0a2-24h/1', schema_version:2, rules_fingerprint, params_sha256, code_sha256, scenario, variant, t_sim, seq, state, save_meta, chain}`（payload 結構 2：`save_meta` 與事件鏈承諾 `chain`，見 [`save-format-v2.md`](save-format-v2.md) §5b；結構 1 的 P0-A2 存檔被拒絕、原樣保留），`state`＝`World.snapshot()`（全部個體、待處理事件、事件日誌雜湊鏈、食物帳本與統計）。`rules_fingerprint`＝SHA-256（引擎版本、結構版本、世界種類、`params.json` 的標準 JSON SHA-256、程式碼 SHA-256 與檔案清單、情境、變體）。程式碼 SHA-256 涵蓋轉接層執行期匯入圖中每個 TypeScript 檔（P0-A2 核心、轉接層、`engine/clock/*`、`engine/scheduler/world-events.ts`、`engine/rng.ts`、`engine/sha256.ts`、Worker 的 `sha256.ts`），由 `node prototypes/continuous-world/tools/p0a2-code-hash.ts --write` 產生到 `p0a2-code-hash.ts`；`tests/worker-runtime.test.ts` 在常數過期時失敗。**因此任何人修改 P0-A2 行為檔（例如育幼餵食）後必須重新產生這個常數，之前的 P0-A2 存檔會以 `FINGERPRINT_MISMATCH` 被拒絕**（不會在不同規則下默默接續；存檔原樣保留、可以匯出）。
- **還原**依序檢查：欄位、schema、標示、引擎版本、雜湊、標頭＝payload、規則指紋／參數／程式碼／情境／變體＝本執行環境、`World.restore`（標準形式、參數檔雜湊）、種子／時間／日誌位置與標頭一致、食物守恆與個體數、每隻工蟻的待處理事件在佇列中、佇列事件都在世界時間之後、還原後再快照逐位元組相同，最後是 `save_meta`（須等於本執行環境依世界 ID 與種子重算的值）與事件鏈形狀／genesis／`count === seq`。任何一項不符即拒絕（`HASH_MISMATCH`、`FINGERPRINT_MISMATCH`、`LEDGER_MISMATCH`、`BAD_STATE`…），目前世界不變。
- **狀態框**（`P0a2FrameMsg`）只含引擎狀態：每隻工蟻的活動、位置類別（巢內／巢內移動／巢外）、開始時刻、路線往返與巢內移動的結束時刻（＝它的待處理事件，模型的固定時長；測試逐一比對佇列）、自己的嗉囊比例與路線記憶；幼蟲腸道比例；食源存量（玩家視角）；工蟻在巢口感知的光照狀態、合成氣溫、相對濕度；另有只供畫面用的太陽高度（一般方法）。**沒有任何 2D 座標**（模型沒有），畫面如何呈現見 [`v62-experiment-mode.md`](v62-experiment-mode.md) §7。
- **已證明（Node，`tests/worker-runtime.test.ts` §8；瀏覽器，`tests/browser/worker-runtime.check.cjs`）**：轉接層的事件與直接執行 `prototypes/p0a2-24h` 的 `World` 的日誌一行對一行、狀態逐位元組相同；48 小時連續＝在 24 h、某事件時刻、午夜、23:59:59.5、次毫秒切點快照（structured clone）→還原→推進，事件與完整狀態逐位元組相同；不規則分段與穿插快照相同；不同速度、暫停、拍長、極小工作量（會落後）與追蹤個體 → 事件、事件日誌雜湊、完整狀態相同；Chromium Worker 中「24 h→快照→終止 Worker→新 Worker→還原→24 h」＝48 h 連續。**Node 與 Chromium Worker 逐位元組相同（規則更新 detmath-exp，2026-11-12；x86-64 Linux、Node 22.23.4 vs. Chromium 153.0.8010.12）**：種子 11、12 各 48 小時，42 480／42 480 個事件、P0-A2 日誌雜湊鏈、事件鏈 head 與整份 payload 都相同，瀏覽器檢查不再有任何例外（無容許值）。之前（PR #209 head 8592c8a）有 12 個 `env_sample` 事件的 `rh_percent` 差 1 ulp（`saturationVapourKPa` 用 `Math.exp`），日誌雜湊鏈與事件鏈 head 因此不同，瀏覽器推進的 P0-A2 存檔在 Node 驗證器下是 `mismatch`。修正：`weather-input.ts`（`exp`、`sin`）、`world.ts`（`log`）、`decision.ts`（`**`）改用 `engine/clock/detmath.ts` 的 fdlibm 移植（`detExp`／`detLog`／`detPow`／`detSin`），`tests/worker-boundary.test.ts` 以靜態規則禁止 Worker 匯入圖再使用實作近似的 `Math.*` 或非整數字面值指數的 `**`。Node 中的 P0-A2 輸出逐位元組不變（20 個種子 × 72 小時 0 個事件不同）。瀏覽器推進、手動存檔、由選單匯出的 P0-A2 存檔 → `node cli/verify-save.ts` → `node_verified`（`tests/browser/save2-acceptance.check.cjs`）。ARM64、Firefox、Safari **未驗證**。詳見 [`solar-cross-env-check.md`](solar-cross-env-check.md) §8 與 [`save-format-v2.md`](save-format-v2.md) §5b。

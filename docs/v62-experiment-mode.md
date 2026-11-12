# V6-2 實驗模式（P0-A2 PR 3：Worker × 分層畫面）

> **地位**：非正式實驗世界／不屬於正式遊戲歷史。世界是 [`experimental-worker-runtime.md`](experimental-worker-runtime.md) 的**合成**小世界（全部遊戲假設，不是螞蟻科學模型）。本頁不修改正式觀察模式（`web/index.html`、`web/analysis.html`）、正式每日循環、Day14、`saves/`、`journal/`，不推進遊戲日。

## 1. 入口與分離

- 網址：`web/experiment.html`（`npm run web` 後開 `http://localhost:8780/experiment.html`：先顯示選單，見 SAVE-2；加 `?seed=N` 是不存檔的臨時實驗，`&autostart=0` 只建立世界、不開始）。頂列固定顯示「非正式」標籤與「非正式實驗世界／不屬於正式遊戲歷史」。
- 正式模式（`index.html`→`game.ts`、`analysis.html`→`main.ts`）的匯入圖**不包含** Worker client 或實驗頁；瀏覽器測試確認兩頁都不建立 Worker、不載入 `worker-dist/`。
- 實驗頁的匯入圖沒有 `fetch`、XHR、儲存 API，也不含 `data/`、`saves/`、`journal/` 路徑；瀏覽器測試確認它不請求這些路徑。
- 模擬只在 Worker 內執行（`experimental/worker-client.ts` 是唯一可建立 Worker 的檔）。主執行緒只送排程／觀察指令並畫圖，不匯入 `engine/`、`prototypes/`、`cli/`（`tests/worker-boundary.test.ts`、`tests/web-v62-experiment.test.ts`）。

## 2. 畫面內容與資料分類

| 類別 | 內容 |
|---|---|
| 引擎事件／狀態 | Worker 每拍送來的狀態框（每隻個體目前線段的起點、終點、起訖時刻、活動、是否在巢內；環境日期、光照狀態、合成氣溫）與事件列表（「引擎事件」按鈕，原樣顯示 seq、時間、種類）。 |
| 顯示插值 | 個體在目前線段**兩個紀錄點之間**的位置（直線插值）；兩個狀態框之間畫面時鐘最多超前 0.05 秒真實時間的推進量；腳步、轉身、鏡頭、縮放。只供畫面，不回寫、不產生事件。 |
| 示意 | 地面紋理、可選的落葉石塊（預設關閉：合成世界**沒有障礙物**）、固定示意光源。虛線圓是場地邊界（引擎參數 `arena_radius_cm`）。螞蟻放大顯示（左下角 ×N）。 |

- 在紀錄時刻（線段起點、終點）畫面位置**就是**引擎位置：`v62-model.poseAt` 在 k≤0 回傳起點、k≥1 回傳終點（不做 `from + (to−from)×1`，以免浮點誤差）；只有 0<k<1 才標為插值。巢內個體不畫位置，只計數。
- 世界時間：自實驗第 0 天 00:00 起的秒數（`t_sim`），顯示為「實驗第 ⌊t/86400⌋ 天 HH:MM:SS」。

## 3. 操作（只觀察）

開始／暫停／繼續、觀察速度（1×、5×、10×、60×、600×、3600×；**預設 1×**，Owner 決策 47）、追蹤個體（下拉選單或點選螞蟻後「鏡頭追蹤」；Worker 只回傳該個體的唯讀副本）、滾輪／雙指縮放、＋／－按鈕、拖曳平移、「全場地」、畫面幀率上限（60／30／15，只影響畫面）、示意落葉石塊開關。**沒有任何干預功能**（不能改食物、天氣、個體、參數或種子）。

## 4. 驗證

| 測試 | 內容 |
|---|---|
| `tests/web-v62-experiment.test.ts`（阻擋性，Node） | 三個種子各 24 小時、8 551 個個體事件：事件前與事件後的畫面姿態都與事件記錄位置逐位元相同；插值點落在紀錄線段上；巢內不畫；不改動狀態框。畫面時鐘（暫停＝t_sim；超前有上限）。世界時間格式。事件摘要（順序、缺號）。與頁面相同的指令序列（追蹤、改速、暫停／繼續、不同拍長、分段推進）後推進到同一 t_sim：事件摘要、事件數、完整狀態 SHA-256 相同。正式／實驗隔離（靜態匯入圖）。`saves/`、`journal/` 不變。 |
| `tests/browser/v62-experiment.check.cjs`（CI viewer-smoke；桌面 1280×800 滑鼠、Pixel 7 觸控） | 標籤；11 層繪製；預設 1× 時世界時間≈真實時間；暫停凍結；在 12 個紀錄時刻（暫停後 `step_until` 到某隻個體的 `until_s`）每隻巢外個體的繪製點＝Worker 位置的仿射映射，有事件的個體＝事件記錄位置；真實輸入（暫停／繼續、速度、縮放、拖曳、點選、追蹤、幀率上限、示意開關）後推進到 12 小時 → 與只推進的新頁面事件摘要與狀態雜湊相同；正式頁不建立 Worker；實驗頁只建立 1 個 Worker、不請求 `data/`／`saves/`／`journal/`；效能量測（見 §5）。 |

## 5. 效能數字的性質

瀏覽器測試記錄畫面間隔（fps）、主執行緒工作時間（CDP `TaskDuration`／`ScriptDuration`，每秒）、JS heap、Worker 推進量（世界秒／真實秒）與是否落後，另以 4 倍 CPU 節流量測一次。這些都是**無頭 Chromium 在測試機器上的數字**；Pixel 7 是模擬視窗與觸控，**不是實機**；Worker 自身的 CPU 沒有量測。不以這些數字宣稱達成任何幀率目標（Owner 決策 50）；畫質自動降級只影響畫面，不影響個體或事件。

## 6. 限制

- 合成世界不是科學模型；P0-A2 個體行為尚未接入。
- 畫面光源固定（示意），沒有依 Worker 的光照狀態畫日夜；光照狀態以文字顯示。
- 跨環境（Node 與 Chromium）逐位元組相同的限制見 [`experimental-worker-runtime.md`](experimental-worker-runtime.md) §6；本頁的「UI 操作不改結果」比較都在同一個瀏覽器內進行。
- 選單、自動存檔與接續（SAVE-2）見 [`experimental-save-system.md`](experimental-save-system.md) §12c；`experiment.html` 不帶參數時先顯示選單，`?seed=N` 是不存檔的臨時實驗。

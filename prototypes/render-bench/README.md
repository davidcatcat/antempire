# 繪圖效能測試：Canvas 2D 與 PixiJS（Issue #102 第 1 步）

> **效能測試用繪圖精靈，不是螞蟻，也不是模擬資料。**
> 本原型量的是「把 N 個小圖形畫到畫面上」的代價，**不是**蟻群規模、**不是**模擬吞吐量，也和任何存檔、引擎、日誌無關。GPU 繪圖速度不能被解讀成生態物理的運算速度。

這是一個**獨立**原型：不接到 `web/` 觀察器，`web/src/` 不匯入它，它也不匯入 `engine/`、`cli/`、`web/`。觀察器預設仍是 Canvas 2D。

## 內容

| 檔案 | 用途 |
|---|---|
| `package.json`／`package-lock.json` | 自己的相依（版本固定）；不動根目錄 lockfile |
| `build.mjs` | 用 esbuild 打包成 `dist/index.html` + `dist/bench.js`（IIFE，可直接以 `file://` 開啟） |
| `src/index.html`、`src/main.js` | 測試頁：可用網址參數 `?renderer=canvas｜pixi&n=100｜1000｜10000` 或頁面上的選單切換 |
| `bench.cjs` | Playwright 自動量測，寫出 `results.json` 並印出表格 |
| `results.json` | 下表的原始量測結果（含環境 meta） |

版本：PixiJS **8.22.0**（2026-10-01 發布，量測時已超過五週）、esbuild **0.28.2**；量測用 Playwright 1.63.0（環境預裝）、Chromium 153.0.8010.12 headless、Node v22.23.4、Linux x64、4 核心。

執行：

```sh
cd prototypes/render-bench
npm ci
node build.mjs
node bench.cjs            # 預設每組暖機 1 秒、記錄 5 秒
```

## 畫面與兩種繪圖器

- **背景**：15 個地點（圓點＋標籤）與 15 條連線，位置由種子 PRNG 產生，只是版面，不是花園地圖。
- **精靈**：外形照 `web/src/main.ts` 的 `draw()`：黑色橢圓（3.5×2.3 px）；每 8 個中 1 個帶灰色外圈（同插值外圈的畫法）；第 0 個是「選取」樣式（紅色 5×3.2 橢圓＋粗體標籤＋虛線圈）。
- **路徑**：每個精靈沿一條連線來回移動，位置只由「影格編號＋種子」決定（mulberry32 PRNG，種子 102；沒有 `Math.random`）。因為以影格計，FPS 低時精靈在牆鐘時間上移動較慢；這不影響每格的繪圖量。
- **Canvas 2D**：每格整個重畫，使用與觀察器相同的原語（`fillRect`、`arc`、`ellipse`、`stroke`、`fillText`、`setLineDash`）。
- **PixiJS**：WebGL 繪圖器；用 `renderer.generateTexture()` 由 `Graphics` 產生兩張共用材質（本體橢圓、外圈），每個精靈是一個 `Sprite`，放在一般 `Container`（**未用** `ParticleContainer`）；背景一次畫進 `Graphics`＋`Text`，尺寸變動才重畫；選取精靈每格用 `Graphics` 重畫（v8 沒有 `setLineDash`，虛線圈以 16 段弧近似）。Pixi 內建 ticker 已停用，兩種繪圖器都由同一個 `requestAnimationFrame` 迴圈驅動並以同一方式計時。Pixi 初始化失敗時頁面會顯示錯誤並建議改用 Canvas 2D。

## 量測方法

每個組合（繪圖器 × N ∈ {100, 1000, 10000} × 設定檔）各開一個新的瀏覽器 context，等頁面就緒後暖機 1 秒，再記錄 5 秒：

- **影格時間**＝相鄰兩次 `requestAnimationFrame` 時間戳之差；報告平均 FPS、p50／p95／p99 與最長影格。headless Chromium 的 rAF 約上限 60 Hz，所以 16.7 ms 是下限。
- **cpuP50／cpuP95**＝單一影格回呼內的 JS 時間（位置更新＋繪圖呼叫／送出）；**不含 GPU 時間**。
- **JS heap**＝記錄結束時的 `performance.memory.usedJSHeapSize`（以 `--enable-precise-memory-info` 啟動）。不含 GPU 材質、畫布後備緩衝等原生記憶體，所以**不是**總記憶體用量。
- **設定檔**：desktop＝1280×800、DPR 1；phone＝Playwright `devices['Pixel 7']`（412×839、DPR 2.625、觸控／行動 UA 模擬）。**手機設定檔只是視窗大小與像素比的模擬，CPU／GPU 仍是同一台測試機。**

## 環境：軟體 GL（重要）

WebGL 繪圖器字串（`WEBGL_debug_renderer_info`）：

```
ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
```

這是 **SwiftShader 軟體 GL**：WebGL 在 CPU 上模擬，沒有真 GPU。因此下表**只能做本機相對比較**，而且對 PixiJS（WebGL）系統性不利；Canvas 2D 在此也是軟體點陣化（Skia CPU），但它本來就為 CPU 最佳化。**這些數字不代表任何真實裝置（尤其手機 GPU）的表現。**

## 實測結果（2026-11-07，本機 headless，SwiftShader）

| 設定檔 | 繪圖器 | N | 平均 FPS | p50 ms | p95 ms | p99 ms | 最長 ms | cpu p50 ms | cpu p95 ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|---|
| desktop | Canvas 2D | 100 | 60 | 16.7 | 16.8 | 16.8 | 16.8 | 0.2 | 0.4 | 4.00 |
| desktop | Canvas 2D | 1000 | 60 | 16.7 | 16.7 | 16.8 | 16.8 | 0.8 | 2.7 | 3.43 |
| desktop | Canvas 2D | 10000 | 37.73 | 33.3 | 33.4 | 50 | 50.1 | 7.0 | 10.3 | 4.75 |
| desktop | PixiJS | 100 | 44.8 | 16.7 | 33.4 | 49.9 | 50 | 0.7 | 3.4 | 6.32 |
| desktop | PixiJS | 1000 | 29.6 | 33.3 | 50 | 50.1 | 66.7 | 1.3 | 3.3 | 9.26 |
| desktop | PixiJS | 10000 | 9.46 | 100 | 149.9 | 150.1 | 150.1 | 6.4 | 11.9 | 24.35 |
| phone（Pixel 7 模擬） | Canvas 2D | 100 | 60 | 16.7 | 16.7 | 16.8 | 16.8 | 0.2 | 0.4 | 4.27 |
| phone（Pixel 7 模擬） | Canvas 2D | 1000 | 60 | 16.7 | 16.7 | 16.8 | 16.8 | 0.7 | 1.1 | 3.24 |
| phone（Pixel 7 模擬） | Canvas 2D | 10000 | 20.34 | 50 | 66.7 | 66.8 | 83.3 | 6.1 | 9.1 | 4.00 |
| phone（Pixel 7 模擬） | PixiJS | 100 | 22.2 | 50 | 50.1 | 66.7 | 66.7 | 0.7 | 2.6 | 6.12 |
| phone（Pixel 7 模擬） | PixiJS | 1000 | 15.96 | 66.6 | 83.3 | 83.4 | 83.4 | 1.3 | 2.9 | 7.97 |
| phone（Pixel 7 模擬） | PixiJS | 10000 | 3.99 | 250 | 316.7 | 316.7 | 316.7 | 6.9 | 18.0 | 22.22 |

原始數據見 `results.json`。重跑會有些許差異（共用機器、軟體 GL）；以上是單次量測，未挑選。

### 能讀出的東西

- 在**這個環境**，Canvas 2D 在 100、1000 個精靈時兩種設定檔都穩定 60 FPS；10000 個時降到 desktop 約 38、phone 模擬約 20 FPS。
- PixiJS 在 SwiftShader 上每一級都比 Canvas 2D 慢，且隨畫布像素數（phone 模擬 DPR 2.625）明顯變差；但它的 **JS 端時間（cpu p50）在 N=100／1000 與 Canvas 2D 同級，N=10000 時兩者相近（約 6～7 ms）**，可見慢的部分主要在軟體模擬的 GPU 工作，而不是 Pixi 的 JS 層。這正是真 GPU 可能改變結論的地方，但本環境**無法證明**。
- PixiJS 的 JS heap 較高（N=10000 約 22～24 MB，對 Canvas 2D 約 4～5 MB），因為每個精靈是一個場景圖物件；這部分與 GPU 無關，在真裝置上也大致成立。

### 不能讀出的東西（解讀限制）

1. **headless 軟體 GL ≠ 手機 GPU**：SwiftShader 把 WebGL 放在 CPU 上跑；真手機 GPU 上的排名可能相反。
2. **Pixel 7 設定檔只是模擬**視窗與 DPR，不是 Pixel 7 的硬體。
3. **繪圖精靈 ≠ 螞蟻**：N 是畫面上的圖形數，不代表蟻群大小、也不是任何模擬能力的上限。
4. **繪圖成本 ≠ 模擬成本**：引擎在 Node 跑、觀察器只讀結果（CLAUDE.md §8）；畫得快不代表模擬能跑多少隻，反之亦然。
5. 單次、單機、單一種子；未量耗電、發熱、GPU 記憶體。

## 建議

**維持 Canvas 2D 為預設與後備，現在不採用 PixiJS。** 目前 `web/data/` 匯出的正式 Day14 與 Day0 實驗世界中，畫面上的個體只有數十個（遠低於 1000），而 Canvas 2D 在本環境 1000 個精靈時仍是 60 FPS。

要把 PixiJS 加入成為**可選**繪圖器，至少要先成立：

1. **在真實手機（含中低階 Android）與真 GPU 桌機的瀏覽器上**重跑本測試（開啟本頁、或以 Playwright 連線真裝置），PixiJS 在觀察器實際會遇到的 N 下，p95／p99 影格時間**明顯優於** Canvas 2D；
2. 觀察器確實有需要畫到上千個以上標記的情境（由引擎輸出決定，不為了畫面去增加個體）；
3. WebGL 不可用或初始化失敗時能自動退回 Canvas 2D，且使用者能手動切換；
4. 新增的相依大小（本原型 bundle 約 570 KB，minified）與維護成本可接受。

## 下一步（若上述條件成立）

- 在 `web/` 後面加一個繪圖器開關（例如 `?renderer=pixi`，預設 `canvas`）；抽出「繪圖器介面」：輸入是 `web/src/model.ts` 已算好的唯讀狀態（位置、插值旗標、選取、圖層開關），輸出只是畫面。
- **`web/src/model.ts` 不改**；兩種繪圖器吃同一份模型輸出，繪圖器**不得**修改事件或狀態、不得產生事件，插值仍只是顯示插值（§8 三類標示不變）。
- 加一個測試：同一份模型輸出在兩種繪圖器下的「要畫什麼」清單（個體 ID、位置、樣式）完全相同，只有像素不同。
- 先在真裝置量測，再決定是否開 PR 把開關接進觀察器。

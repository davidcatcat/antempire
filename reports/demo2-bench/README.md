# Demo 2 效能測試：無頭執行結果（軟體算繪，不是裝置結果）

這個目錄只放**無頭 Chromium＋SwiftShader（CPU 算繪）**跑出來的結果。每個檔案的 `result.measurement_class` 都是 `software`，標示「**軟體算繪，不是裝置結果**」。它們**不能代表**任何手機或電腦的 GPU 效能，也不能用來比較 WebGL 2 與 WebGPU。

方法、分類規則、怎麼在手機上跑、怎麼讀表：見 [`docs/demo2.md`](../../docs/demo2.md) 的「效能測試」一節。測試頁是 `web/demo2-bench.html`。

| 檔案 | 環境 | 內容 |
|---|---|---|
| `headless-software-webgl2-desktop-1280x800.json` | 無頭 Chromium，WebGL 2（SwiftShader），1280×800，DPR 1 | 30／100／300／1,000 × 純渲染／完整模擬 |
| `headless-software-webgl2-pixel7-412x839.json` | 無頭 Chromium，WebGL 2（SwiftShader），Pixel 7 模擬 412×839，DPR 2.625（**不是實機**） | 同上 |
| `headless-software-webgpu-desktop-1280x800.json` | 無頭 Chromium，WebGPU（SwiftShader adapter），1280×800，**離屏繪圖**（畫到 render target，沒有呈現到螢幕；每幀等 GPU 佇列完成） | 同上 |

主機：4 核心共用主機、15.6 GB 記憶體；執行期間可能有其他負載，同一項重跑的數字會有明顯差異。每項暖機 3 秒、量測 10 秒，模擬 5×，畫質 medium。

每個檔案是執行工具（`tests/browser/demo2-bench.run.cjs`）的輸出：`result` 是測試頁自己產生的紀錄（schema `antempire.demo2-bench.v1`，含 GPU 辨識與每一項的數字）；外層另有主機資訊與**整個瀏覽器行程樹的 RSS** 時間序列（`tree_rss_mb`，含所有 Worker 與訊息佇列——頁面自己的 JS heap 數字不含這些）。

## 這些結果能說明什麼

- 測試流程能從頭跑完；純渲染確實沒有啟動任何 Worker，完整模擬畫的確實是 N 隻引擎工蟻（來自 ⌈N/30⌉ 個互不相干的獨立蟻群）。
- 在 CPU 算繪下，隻數增加時幀時間怎麼長；draw calls 不隨隻數增加。
- 完整模擬在主機跟不上時會**自己停止並寫下原因**，不會跑到記憶體不足（見各檔 1,000 隻那一列與 `tree_rss_mb`）。

## 不能說明什麼

- 任何真實 GPU 上的幀率、耗電、發熱。
- WebGL 2 與 WebGPU 誰快：兩者在這裡都是 CPU 算繪，幀的計時方式也不同（`frame_pacing`）。
- 單一大蟻群的模擬成本：完整模擬是多個 30 隻的獨立蟻群，不是一個 N 隻的蟻群。

## 產生表格

```
node cli/demo2-bench-table.ts reports/demo2-bench/headless-software-webgl2-desktop-1280x800.json reports/demo2-bench/headless-software-webgl2-pixel7-412x839.json
node cli/demo2-bench-table.ts reports/demo2-bench/headless-software-webgpu-desktop-1280x800.json
```

把不同量測類別（software／real_gpu／unknown）或不同 API 的檔案一起丟進去，工具會拒絕（退出碼 2）。實機結果（Owner 從手機貼回的 JSON）要放在別的檔名、別的表，不放進這個目錄的軟體表。

## 重跑

```
npm ci && npm run web:build && node cli/web-serve.ts 8787 &
node tests/browser/demo2-bench.run.cjs reports/demo2-bench/headless-software-webgl2-desktop-1280x800.json http://localhost:8787/
node tests/browser/demo2-bench.run.cjs reports/demo2-bench/headless-software-webgl2-pixel7-412x839.json http://localhost:8787/ --viewport pixel7
node tests/browser/demo2-bench.run.cjs reports/demo2-bench/headless-software-webgpu-desktop-1280x800.json http://localhost:8787/ --renderer webgpu --present offscreen
```

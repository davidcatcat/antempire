# Three.js 3D 原型（第一階段；#256、#257、交接 #258）

> **地位**：獨立的**原型頁**，讓 Owner 依 Demo 決定是否採用 Three.js 作為主要 3D 架構。**不取代**現有 Canvas 遊戲畫面（`index.html`）與 2D 實驗頁（`experiment.html`），**不改引擎、參數、Worker、白名單、存檔**。螞蟻來自 P0-A2 **候選／實驗世界（非正式）**；頁面標「原型・非正式」。

## 1. 怎麼跑

```sh
npm ci
npm run web:build        # tsc（web 與 Worker）＋ 把 three 複製到 web/vendor/three（git-ignored）
node cli/web-serve.ts    # 預設 8780；開 http://localhost:8780/three.html
```

網址參數：`?seed=1`、`?t=32400`（開場世界時刻，只用 `step_until` 排程）、`?speed=1`、`?mag=14`、`?ants=30|100|1000`、`?follow=w004`、`?quality=low|high`、`?bench=1&warm=4&secs=10`（自動量測，結果在效能面板，可複製 JSON）。

## 2. 架構

| 檔案 | 內容 | 純度 |
|---|---|---|
| `web/three.html` | 頁面、import map（`three` → `./vendor/three/three.module.js`，**本機，不連 CDN**）、資料說明 | — |
| `web/src/three/main.ts` | 場景、燈光、鏡頭（OrbitControls）、每幀組裝、選取／追蹤、效能面板與量測 | DOM＋Three.js |
| `web/src/three/placement.ts` | 每隻工蟻畫在哪裡（只讀 Worker 的 P0-A2 frame＋顯示時間） | 純函式 |
| `web/src/three/motion.ts` | 每隻的步態相位、顯示轉身、活動度（只依畫出的位置變化） | 純函式 |
| `web/src/three/nest3d.ts` | 巢內剖面巢室（依引擎狀態分組，示意）、巢口通道 | 純函式 |
| `web/src/three/terrain.ts` | 地表高度、種子 PRNG、景物避讓 | 純函式 |
| `web/src/three/perf.ts` | 幀統計、`measurementClass`（軟體繪圖／自動化＝NOT a device result） | 純函式 |
| `web/src/three/garden.ts` | 花園 diorama（土壤、剖面、落葉、草、植物、石頭、巢口、蚜蟲群、示意路線） | Three.js |
| `web/src/three/ant-model.ts` | *P. megacephala* 小工蟻 3D 模型與頂點著色器關節（InstancedMesh，近／遠兩層 LOD） | Three.js |
| `cli/web-vendor-three.ts` | 把 `node_modules/three` 的 4 個檔與 LICENSE 複製到 `web/vendor/three/` | Node 建置工具 |

- **與模擬的連接**：只經 `web/src/experimental/worker-client.ts`（CLAUDE.md §9 B）。送出的指令只有排程（`init`、`step_until`、`start`、`pause`、`resume`、`set_speed`）與觀察（`follow`），以及關閉 Worker。不匯入 `engine/`、Worker 目錄或 `cli/`；主執行緒不跑生態；不寫任何存檔。`tests/worker-boundary.test.ts`（掃整個 `web/src`）、`tests/web.test.ts`（匯入只限 `web/src` 內與 vendored three）與 `tests/web-three-proto.test.ts` 檢查。
- **與 2D 實驗頁共用顯示模型**：地表位置用 2D 實驗頁 VIS-1 的同一個 `VisModel`（`web/src/vis1-model.ts`）：同一條顯示路徑、同一個搜尋示意圈、同一個取食位置；卡片與狀態列用同一份 `cardHtml`／`hudStatus`。2D 的 (x 東, y 北) → 3D 的 (X 東, Z 南)。
- **時間**：顯示時間沿用 2D 頁的 `displayTime`（Worker 回報的 `t_sim`＋依倍速的顯示外推）；渲染 FPS、鏡頭、放大倍數、追蹤都不改變任何事件（Worker 只收排程與觀察指令）。

## 3. 資料分類（頁面「資料說明」同步標示）

| 類別 | 內容 |
|---|---|
| **引擎** | 每隻工蟻的狀態與開始時刻、路線**長度**（200 cm）與走完時間、出發／抵達時刻、嗉囊與幼蟲腸道填充、幼蟲數、光照（日／曙暮光／夜）、各巢室（＝狀態分組）的工蟻數 |
| **顯示插值** | 路線上與巢口通道上，兩個引擎紀錄時刻之間的位置（出發與抵達時刻正好在路線端點，測試逐點檢查） |
| **示意** | P0-A2 **沒有任何 2D 或 3D 座標**：路線方向與彎曲形狀、搜尋中的位置（巢口附近的示意繞圈；搜尋沒有空間模型）、食源旁的取食排列、巢室形狀與每隻在巢室中的位置（巢內位置未模擬，巢室＝引擎狀態分組）、整座花園（土壤、落葉、草、植物、石頭、蚜蟲群、展示台）、陽光方向、夜間加亮、螞蟻放大倍數 |
| **畫面動作（不是事件）** | 六足三腳步態（相位只依**畫出的位置實際移動的距離**推進，停下就停）、轉身（只在紀錄的朝向改變時畫，Owner 決策 20）、不動時的原地微動作（觸角、頭、腹、腳；不可通約頻率的準週期雜訊，強度依引擎狀態，不改位置、不產生事件；世界暫停時也停） |
| **效能量測用的額外世界** | 100／1,000 隻＝ 4／34 個**不同種子**的獨立 P0-A2 世界（各在自己的 Worker、彼此不互動），只畫前 N 隻；巢位置與路線方向是排版；不複製軌跡、不造假路線 |

尚未模擬、畫面也不假裝有的：巢內移動（`idle`「巢內走動」只有較強的原地微動作，沒有畫移動，因為引擎沒有巢內座標）、觸角接觸與交哺的空間位置、搜尋路徑、巢的真實結構。

## 4. 這一輪（接手）的變更
- 合併 `main`（#250～#255，含 VIS-1 #252 連續性修正）。
- 地表位置改用 2D 實驗頁的 VIS-1 `VisModel`（原本用直線 `p0Pose`）：3D 與 2D 畫同一條顯示路徑；搜尋中的螞蟻沿 2D 頁同一個示意繞圈走（原本原地站著），標「示意」；路線虛線與景物避讓改由 frame 推得的顯示路徑產生，移除程式中的預設路線常數。
- 草、石頭、小石子降低明度（強光下偏白）；巢後方深色襯底已截圖確認（剖面縫隙看不到天空）；加深色展示台，低角度鏡頭不再看到方塊下方的天空。
- 預設視角拉近、預設放大 ×14（桌面）／×18（手機），地表螞蟻在起始視角可辨識；仍標示「位置與路線長度不放大」。
- 效能量測的額外世界改為並行啟動（34 個 Worker 依序啟動要數分鐘）。
- 測試：`tests/web-three-proto.test.ts`（BLOCKING）、`tests/browser/three-demo.check.cjs`（CI viewer job）、量測工具 `tests/browser/three-bench.run.cjs`；preview artifact 加入 `three.html`、`experiment.html`、`vendor/`、`worker-dist/`。

## 5. 效能（#257）

> **NOT a device result.** 以下全部來自無頭 Chromium＋**SwiftShader 軟體 WebGL**（GPU 工作在 CPU 上）、4 核心**共用主機**（量測時 load average 見 JSON）。只能用來確認頁面與量測流程可以跑完、比較同一次執行內的相對差異；**不能當作手機或桌機效能**（沿用 [`render-comparison.md`](render-comparison.md) 的規則）。

結果檔：[`reports/three-prototype/headless-bench-desktop.json`](../reports/three-prototype/headless-bench-desktop.json)（桌面 1280×800，DPR 1，暖機 4 s、量測 10 s）。

| 頁面 | 螞蟻 | 世界／Worker | 平均 fps | 幀時間 p50／p95 ms | 主執行緒 JS ms/幀（p50） | draw calls | 三角形 | JS heap | 瀏覽器行程 RSS |
|---|---|---|---|---|---|---|---|---|---|
| `three.html`（high） | 30 | 1 | 1.12 | 883／973 | 2.9 | 232 | 約 88 萬 | 23 MB | 681 MB |
| `three.html`（high） | 100 | 4（並行啟動 9.3 s） | 0.86 | 1,175／1,209 | 3.1 | 236 | 約 103 萬 | 23 MB | 837 MB |
| `three.html`（high） | 1,000 | 34 | **未量到** | — | — | — | — | — | 啟動期間 renderer 行程 RSS 漲到 9.6～11.3 GB（主機 15.7 GB）後被系統以記憶體不足終止（兩次） |
| `experiment.html?seed=1&world=p0a2`（Canvas 2D） | 30 | 1 | 60 | 16.7／16.8 | 0.4（繪製） | — | — | 10 MB | 582 MB |

解讀（只在這個環境成立）：
- 3D 頁每幀的主執行緒 JS 只有約 3 ms；慢的是 **SwiftShader 在 CPU 上算 WebGL**（約 88 萬個三角形，含陰影第二次繪製；草葉約 5,200 片、落葉約 900 片）。`?quality=low`（關抗鋸齒、陰影 1024、景物減量，約 25 萬三角形、132 draw calls）在同一環境另一次量到約 2.1 fps（high 同時段 0.6 fps，load 約 6）。真 GPU 上這個量級通常不是問題，但**沒有實機數據之前不能這樣宣稱**。
- 30 → 100 隻幾乎不變（螞蟻是 2 個 InstancedMesh、2 個 draw call），成本在場景，不在螞蟻數。
- **1,000 隻的失敗是發現，不是量測結果**：每個實驗 Worker 每 16 ms 送出一個完整的 P0-A2 狀態框（JSON 約 4.9 KB，`prototypes/continuous-world/worker/entry.ts` 的 `TICK_MS`），沒有背壓；34 個 Worker 約 10 MB/s，主執行緒被軟體繪圖卡住時佇列沒有被消化，與觀察到的約 10～11 MB/s 成長一致（推測，未在真 GPU 上驗證）。4 個 Worker 時 RSS 穩定（啟動 40 s 後連續 30 s 在 789～819 MB）。要讓 1,000 隻的量測在慢裝置上安全，需要 Worker 端的狀態框合併／背壓——這是 Worker 修改，**另開 PR**，不在本原型範圍。實機上若主執行緒跟得上，可能不會發生；請 Owner 量 1,000 隻時留意記憶體。
- 用 `node tests/browser/three-bench.run.cjs <out.json> <url> 4 10 30,100` 重跑（小機器不要跑 1000）。

## 6. 實機量測（Owner，#192）
1. 在要量的裝置（至少一支中階 Android、一支 iPhone、一台桌機）用瀏覽器開 `http://<電腦 IP>:8780/three.html?bench=1`（電腦先 `npm ci && npm run web:build && node cli/web-serve.ts`；或用 CI artifact `antempire-viewer-preview` 的 `site/` 以任一靜態伺服器提供）。
2. 等候約 1～6 分鐘（1,000 隻要先啟動 34 個 Worker 並各自推進到 09:00），不要切換分頁或鎖螢幕。
3. 效能面板出現 JSON（`schema: antempire.three-bench.v1`），全選複製，貼到 #257。`measurement_class` 必須是 `device`；若是 `NOT a device result`（軟體繪圖、自動化），該筆不算實機結果。
4. 對照：同一台裝置開 `experiment.html?seed=1&world=p0a2`，或跑 `prototypes/render-compare/device-bench.html`（#192 的既有步驟）。
5. 手機若太慢，可加 `&quality=low`（關抗鋸齒、DPR 上限 1.5、陰影 1024、景物減量）再量一次，兩筆都貼。

## 7. 依賴
- `three@0.187.0`、`@types/three@0.187.0`（root devDependencies，exact；**MIT**，見 [`licensing.md`](licensing.md) §2）。頁面載入未壓縮的 `three.module.js`＋`three.core.js`＋2 個 addon 約 2.2 MB（0.187 不附 min 檔；伺服器有 gzip 時約 1/4）。引擎仍然沒有任何第三方執行期依賴。
- 回滾：刪除 `web/three.html`、`web/src/three/`、`cli/web-vendor-three.ts`、兩個 devDependencies、`web:build` 的複製步驟與本文件、測試與 CI 步驟即可；其他頁面不受影響。

## 8. 評估與建議

**依 [`visual-p0-scene-spec.md`](visual-p0-scene-spec.md) §10 的決策規則**（原本針對 PixiJS，對 Three.js 同樣適用：三項同時成立才改用 WebGL 後端，且保留 Canvas 2D 退路）：

| 條件 | 現況 |
|---|---|
| (a) **實機**上 P0 場景 Canvas 2D 達不到 §9 目標而 WebGL 版本達到；或規格要求的畫質功能 Canvas 2D 無法在預算內實作 | **未知**：沒有實機數據。無頭環境 Canvas 2D 60 fps、3D 約 1 fps（軟體 GL，不可比）。另一方面，真正的 3D（可旋轉的立體花園、即時陰影、立體剖面、任意角度的六足步態）在 Canvas 2D 沒有對應實作，屬於「畫質功能」條件的候選，但規格 §9／§10 目前沒有把 3D 列為要求——這是產品方向，由 Owner 決定 |
| (b) 兩個後端畫出的位置、時間、事件相同 | **部分成立**：3D 與 2D 實驗頁用同一個 `VisModel`（`tests/web-three-proto.test.ts` 逐點比對 24 小時、兩個種子）；Worker 只收排程與觀察指令。尚未做 2D／3D 的瀏覽器端輸入雜湊交錯比對與「UI 操作不改結果」完整套件（`three-demo.check.cjs` 只驗證暫停時世界時間不動） |
| (c) 依賴與維護成本寫入 PR、WebGL 失敗時退回 Canvas 2D | 依賴：three 0.187.0（MIT，約 2.2 MB 未壓縮，本機 vendor）。**沒有自動退回**：本頁是獨立原型，WebGL 不可用時會顯示「載入失敗」，Canvas 頁不受影響 |

**建議**：**目前不把 Three.js 定為主要架構**，保留本頁為可操作的原型，交給 Owner 觀看後決定方向。理由：(a) 缺實機數據；(b) 1,000 隻需要先解 Worker 狀態框背壓；(c) 沒有 WebGL 失敗退路。若 Owner 看過 Demo 後決定朝 3D 發展，下一步依序是：實機量測（§6）、Worker 狀態框合併／背壓（另開 PR）、場景減量與 LOD（草葉、陰影、石頭改 instanced）、WebGL 失敗退回 Canvas 2D、2D／3D 交錯雜湊比對。

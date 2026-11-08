# 物理接觸播放（PH-3b 隔離播放頁）

> **地位**：隔離物理實驗・**非正式**・**不是生物行為**（讓路／側移決策尚未建模）。`prototypes/physics-playback/` 不被每日生態循環、Day0、`cli/`、`web/` 引用；沒有推進遊戲日，沒有改存檔、日誌或 `engine/` 任何檔案。所有情境都是合成世界（`synthetic: true`），不是臺中西屯花園。

## 1. 內容
| 檔案 | 作用 |
|---|---|
| `prototypes/physics-playback/export.ts` | 在 Node 執行 PH-3b 解算器（`engine/physics/solver2d.ts`）與原生 PH-2（`collision.ts`，對照用），輸出 `data/*.json` |
| `prototypes/physics-playback/scenarios/*.json` | 新增的 4 個合成情境（沿用 solver-compare 的格式與載入器） |
| `index.html`、`app.js`、`motion.js` | 靜態播放頁（Canvas 2D，無外部相依）；**只 fetch `./data`，不匯入 `engine/`、不執行模擬、不寫入** |
| `browser-check.cjs` | Chromium／Playwright 檢查與截圖（`screenshots/`） |
| `tests/physics-playback.test.ts` | BLOCKING 測試 |
| WP4 候選（`*--steer-A/B/C.json`） | 隔離物理實驗・候選行為規則（非本種/假設）：`engine/physics/local-steer.ts` 的 A／B／C 候選，見 `docs/wp4-local-avoidance.md` |

## 2. 畫面上的每個變化都是引擎事件
- **運動**：PH-3b 在兩個事件之間讓每個身體直線等速平移，且只在速度或朝向改變時記錄姿態。匯出的每一段 `[t0, t1]` 帶兩端的精確姿態；畫面直接計算這段運動。這**就是解算器的運動，不是取樣點的插值**；沒有任何平滑。播放速度、縮放、平移只改變觀看方式。
- 每一段的邊界都必須是「涉及該個體的引擎事件時刻」或時間起點／終點；不符合時匯出器拒絕寫檔。
- 事件清單與時間軸同步（點一下跳到該時刻）；「◀ 事件／事件 ▶」逐個事件時刻前進；目前事件的個體加粗框。
- 身體是真實尺寸的膠囊（體長 2.5 mm：R94，文獻支持；碰撞寬 0.8 mm：候選範圍上限，遊戲假設，只作敏感度），畫面有比例尺。尺寸只經 solver-compare 載入器從候選檔取得，沒有新增任何數值。
- 原生 PH-2 對照：一維、u = 0，含**非本種候選**的讓路／交叉等待規則；分段是引擎的 MotionInterval 紀錄，以「原生運動紀錄」列在事件清單。並排通過時畫面會重疊（一維模型沒有橫向座標）。

## 3. 情境（皆為合成情境）
| 情境 | 來源 | 結果（PH-3b） |
|---|---|---|
| head-on-2 | solver-compare | 1.0 mm 窄段迎面：2.75 s 接觸、兩隻停止，到 20 s 卡住 |
| offset-block（新） | nest-entrance 10 mm 通路，u = −0.2／+0.2 | 寬度夠兩隻並排，但給定 u 只相距 0.4 mm：2.577 s 頭部斜碰，兩隻停 |
| pass-clear（新） | 同上，u = −1.0／+1.0 | 2.647 s 錯身（沒有接觸），A 4.865 s、B 5.806 s 抵達 |
| pass-graze（新） | 同上，u = −0.4／+0.4 | 間距剛好 0（契約：1e-10 mm 內的擦身不算接觸）：錯身、抵達 |
| crossing | solver-compare | 同時到交叉口：2.858 s 角對角接觸，兩隻卡住 |
| crossing-flank（新） | crossing，E 延後 0.1 s | 2.944 s E 的頭碰到 N 的側面而停；N 滑過；2.991 s 起 E 恢復並沿 N 的後端圓弧以分段等速近似滑過（約 6,000 個細碎事件）；N 5.882 s、E 6.049 s 抵達 |
| stone | solver-compare | 兩隻停在石頭前（u 固定，不繞路） |
| corridor-8 | solver-compare | 跟隨／停止鏈，8 隻全部卡住 |

E 延後 0.1 s 是事先用運動學算的情境設計（讓 E 抵達交叉口時 N 的身體正好在交叉點上），用來展示「碰到側面 → 停 → 等 → 對方離開 → 恢復」；沒有為抵達而試誤調整。u 值都是情境給定值。crossing-traffic-100／1000 沒有放進播放（事件數 4.5 萬／10.8 萬，檔案太大）。（PH-3b 版本；WP4 候選 A／B／C、不讓路控制組 N 與對照情境 K0–K3 的 100 隻執行有放進播放，見 `docs/wp4-local-avoidance.md` §6.4。）

## 4. 驗證
- `node tests/physics-playback.test.ts`（BLOCKING）：`data/` 等於重新匯出；PH-3b 每個分段邊界都是該個體的引擎事件時刻；用**頁面自己的** `motion.js` 重播，在每個解算器紀錄點與最終姿態都與重新求解一致（≤ 1e-9 mm；最終姿態逐位元相同）；原生分段就是 MotionInterval 紀錄；頁面三個檔案不引用 `engine/`、`cli/`、`web/`，只匯入 `./motion.js`、只 fetch `./data`；正式流程不引用本頁。
- `node prototypes/physics-playback/browser-check.cjs 40`：桌面 1280×800、手機 412×915（DPR 2）；12 個 run 每個走前 40 個事件時刻＋最後一個，畫面上每隻的位置與獨立從 JSON 算的精確運動相差 ≤ 1e-9 mm、加粗的個體＝目前事件的個體、點事件列會跳到該時刻、沒有頁面錯誤、沒有水平捲動。

## 5. 限制與未決
- 事件清單時間顯示到 1e-6 s；更接近的事件（滑動近似）顯示為同一數字，精確值在資料中。
- 滑動接觸的分段等速近似（PH-3b §3）讓 crossing-flank 有約 6,000 個事件、1.3 MB 資料；這是解算器真實輸出，不是畫面問題。
- 沒有建模：讓路、側移、掉頭、交叉口誰先走（本種依據 null）；u 隨時間變化；觸角；推擠、質量、加速度。
- 本頁只是物理約束的觀察工具，**不能**拿來推論大頭家蟻的行為。

## 6. 執行
```
node prototypes/physics-playback/export.ts            # 重新匯出 data/
node prototypes/physics-playback/export.ts --check    # 與重新匯出比對
node tests/physics-playback.test.ts
node prototypes/physics-playback/browser-check.cjs 40 # 需 Chromium＋Playwright
```
頁面需經 HTTP 服務（例如任何靜態伺服器）開啟 `prototypes/physics-playback/index.html`。

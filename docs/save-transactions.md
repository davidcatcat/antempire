# 正式存檔交易：一個遊戲日＝一筆可復原的提交

> 適用 `npm run advance`（`cli/advance.ts`、`cli/lib/save-transaction.ts`）。**存檔格式不變**：`saves/main.json`、`saves/world-state.json` 與 v2 相同；新增 `saves/commit-log.json`（第一次正式推進時建立）。

## 1. 一個遊戲日提交的內容

| 檔案 | 方式 | 說明 |
|---|---|---|
| `saves/world-state.json` | 取代 | 世界與引擎狀態（`sim_engine_v2`） |
| `saves/main.json` | 取代 | 蟻群主存檔；`simulation.latest_journal` 指向下列日誌 |
| `journal/v2-day-NNNN.md` | **新建（不可覆寫）** | 引擎輸出的完整事件紀錄（每個事件一行）＋自動整理的當日摘要與守恆檢查結果 |
| `saves/commit-log.json` | 取代／新建 | 已確認版本：每天四個檔案的 sha256、被取代的上一版 sha256、引擎版本、規則指紋 |

四個檔案在同一筆交易中提交；不會出現「存檔已是 Day15、日誌卻不存在」而沒有錯誤的情況。

## 2. 流程

1. 取得排他鎖 `saves/.advance.lock`（`O_CREAT|O_EXCL`）。另一個推進程序存在時拒絕（`LOCKED`）。
2. 拒絕下列情況：未完成的交易、殘留暫存檔、存檔不是 commit log 中最後確認的版本、`--day` 不等於下一個遊戲日、新一天的日誌已存在、規則指紋不符。
3. 用凍結的引擎跑一天；檢查人口、幼體、糖蛋白帳、時間、日誌內容與存檔是否一致。
4. 建立 `saves/.txn/pending-day-NNNN/`：
   1. `intent.json`：每個目標檔目前的 sha256；
   2. `backup/`：上一版的完整位元組；
   3. `staged/`：新版本的完整位元組；
   4. `manifest.json`（狀態 `PREPARED`，含所有雜湊），以「寫暫存→fsync→rename→fsync 目錄」寫入。**這個 rename 就是提交點。**
5. 依序套用每個目標檔（每個檔各自 tmp→fsync→rename；日誌用 hard link 確保「不存在才建立」），然後逐一驗證雜湊。
6. 把交易目錄改名為 `committed-day-NNNN`（只保留最近一筆，也就是本機上的上一版），釋放鎖。

## 3. 一致性保證與限制

- **檔案系統沒有多檔原子交易**；兩次 rename 也不是。這裡保證的是**可復原性**：任何失敗或程序被終止後，`npm run advance -- --recover` 會讓四個檔案回到以下兩種狀態之一，或拒絕：
  - 提交點之前中斷 → **roll back**：保留完整的前一天，刪除暫存區；
  - 提交點之後中斷 → **roll forward**：從暫存區完成新的一天（套用步驟是冪等的，可以重複執行）；
  - 無法證明哪一個正確時（暫存檔損毀、目標檔被外部修改）→ **拒絕**，不覆寫任何東西，需要人工檢查。
- 單一檔案永遠是原子取代，讀取端不會讀到寫了一半的 JSON。
- **交易進行中或中斷後、復原前，四個檔案可能是新舊混合**（例如 world 已是 Day15、main 仍是 Day14）。`npm run check:saves` 會報錯；推進工具在復原前拒絕一切操作。
- 依賴 POSIX rename 與 fsync 的語意（Linux／macOS 本機磁碟）。網路檔案系統或關閉 fsync 的環境不在保證範圍內。
- 鎖只防止同一份存檔上的多個程序；不能防止有人繞過工具直接編輯檔案（這種情況會被 commit log 雜湊檢查發現）。
- 程序被終止後留下的鎖：只有 `--recover` 在確認該程序已不存在（同一台主機、pid 不存在）時才會移除；pid 仍在執行時一律拒絕。

## 4. 防止重複推進同一天

- `--confirm-advance` 必須搭配 `--day N`，且 N 必須等於下一個遊戲日；重複執行同一個指令會被拒絕（`DUPLICATE_DAY`）。
- 日誌以「不存在才建立」寫入；新一天的日誌已存在時拒絕。
- 存檔被換回舊版本（例如把 Day14 存檔複製回來）時，commit log 的最後一天與雜湊不符，拒絕推進。
- 復原時若 roll forward 完成了某一天，`--recover` 不會再推進下一天。

## 5. 讀取端需要配合的地方

- 讀取 `saves/` 之前，若存在 `saves/.txn/pending-day-*`、`*.advance-tmp` 或 `saves/.advance.lock`，**不要把存檔當成一致狀態**；先執行 `npm run advance -- --recover`（或等待推進完成）。
- 只看 git repository 的讀取端（例如 ChatGPT、未來的網頁）：`.txn/`、鎖與暫存檔不會進 git（`.gitignore`），但任何混合狀態都會讓 CI 的 `npm run check:saves` 失敗（日期不一致、commit log 不符或日誌缺失）。
- 網頁版應以 `saves/commit-log.json` 最後一筆的雜湊驗證所讀到的存檔與日誌。
- 已提交的日誌是不可改寫的歷史。之後若要補充敘事，請另建新檔（例如另一份紀事），不要修改 `journal/v2-day-NNNN.md`；commit log 中的雜湊會檢查這一點。

## 6. 指令

| 指令 | 作用 |
|---|---|
| `npm run advance` | 預演：不取得鎖、不寫任何檔案 |
| `npm run advance -- --confirm-advance --day 15` | 玩家明確要求推進 Day15 時使用 |
| `npm run advance -- --recover` | 完成或撤銷中斷的交易、清除暫存檔、移除已確認失效的鎖；不推進新的一天 |
| `npm run check:saves` | 唯讀檢查守恆、交易狀態、commit log 與日誌雜湊 |

## 7. 測試（只用臨時副本）

`tests/save-transaction.test.ts`：
- 在提交流程的 15 個步驟逐一注入「程序突然終止」與「磁碟已滿（只寫入一半）」兩種故障，共 30 種情況；每一種在復原後都必須逐位元組等於完整的 Day14 或完整的 Day15，之後也不能重複推進；
- 實際以 `process.exit(137)` 終止 CLI 程序後用 `--recover` 復原；
- 三個程序同時要求推進 Day15，只有一個成功；
- 換回舊存檔、暫存檔損毀、交易中被外部修改、殘留暫存檔。

故障注入只透過可替換的 I/O 物件或環境變數 `ANTEMPIRE_FAULT`，而且**只允許用在 `--root` 指向臨時副本時**；用在正式存檔上會被拒絕。

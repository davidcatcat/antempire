# 規則指紋 v2：模擬相關程式碼的內容雜湊（Owner 決定 52）

> 狀態：**規則更新 PR**（另開 PR；合併需 Owner 另行授權）。本 PR **不登錄新規則版本、不改任何模擬輸出**（黃金測試逐位元組相同），也**不改寫任何存檔、日誌或 commit log**。實作：`cli/lib/fingerprint-v2.ts`；相容層：`cli/lib/rules-registry.ts`、`cli/lib/project-day.ts`、`cli/advance.ts`；測試：`tests/fingerprint-v2.test.ts`。

## 1. 為什麼需要 v2

v1（`cli/lib/fingerprint.ts`）只雜湊 `engine/` **最上層**的 `*.ts` 與參數檔，而且以原始位元組計算：

| v1 的缺口 | 後果 |
|---|---|
| 不含子目錄（`engine/clock/`、`engine/physics/`、`engine/scheduler/`）與 `cli/lib/project-day.ts`（存檔映射） | 若日後正式流程匯入子目錄，或修改存檔映射，凍結檢查看不到 |
| 不含輸入資料（Day15 遷移讀取的氣候平年值）與固定的 Node 版本 | 輸入改變而指紋不變 |
| 不正規化換行 | Windows CRLF checkout 會得到不同指紋，誤判「規則被改」 |
| 沒有格式版本 | 無法安全地改演算法 |

## 2. v2 的定義（固定規則）

| 群組 | 內容（固定、可重現的規則） |
|---|---|
| `source` | 由固定進入點 `engine/index.ts`、`cli/lib/project-day.ts`、`cli/lib/load.ts` 出發的**靜態匯入閉包**：所有相對路徑的 `import … from`、`export … from`、`import '…'`、字面字串的 `import('…')`（含 `import type`，保守處理）。註解中的匯入不算。 |
| `params` | `world/xitun-garden.json` 與 `species/*.json`（與 v1 相同的檔案集合） |
| `data` | 固定清單：`data/taichung-climatology-1991-2020.json`（正式流程的輸入資料）、`.nvmrc`（固定 Node 版本，CLAUDE.md §8） |

- **以匯入閉包取代手寫清單**：新機制只要被正式流程匯入就自動納入，不會「忘了加」；沒被匯入的原型（`engine/physics/`、`engine/clock/`、`engine/scheduler/`、`prototypes/`）不影響存檔。目前閉包＝28 個檔案（`node cli/lib/fingerprint-v2.ts` 列出）。
- **拒絕而非略過**：閉包中出現套件匯入（程式碼不在 repo 內）→ `UNHASHED_DEPENDENCY`；匯入不存在的檔案 → `MISSING_SOURCE`；沒有副檔名或跑出 repo → `BAD_IMPORT`；`node:` 內建模組允許（Node 版本已由 `.nvmrc` 涵蓋）。
- **編碼**：位元組必須是合法 UTF-8（否則 `NOT_UTF8`，不修補）；去掉開頭一個 BOM；CRLF 與單獨 CR 一律換成 LF；以正規化後文字的 UTF-8 計算 sha256。Windows CRLF checkout 與 LF checkout 得到相同 v2。
- **路徑與順序**：repo 相對路徑、`/` 分隔、只允許 ASCII 安全字元；依碼位（＝位元組）排序。結果與檔案系統列目錄的順序、進入點順序無關。
- **群組雜湊**：sha256(依路徑排序的 `路徑\0sha256(正規化內容)\n`)。
- **總摘要**：`digest = sha256("antempire.rules-fingerprint.v2\nengine_version\0<ENGINE_VERSION>\nsource\0<source>\nparams\0<params>\ndata\0<data>\n")`。
- **紀錄格式**（存檔、登錄檔、commit log 共用，鍵順序固定）：

```json
{ "schema": "antempire.rules-fingerprint.v2", "engine_version": "…", "source": "<64 hex>", "params": "<64 hex>", "data": "<64 hex>", "digest": "<64 hex>" }
```

  `engine_version` 取自被雜湊原始碼中唯一的 `export const ENGINE_VERSION = '…'`；`digest` 必須等於由其他欄位重算的值（手改紀錄會被偵測）。
- **內容雜湊、不是語意雜湊**：連註解或空白的變動也會改變 v2。這是刻意的保守選擇（無法自動證明某個改動不影響行為）。
- **不使用 Git commit SHA**：只看檔案內容，與歷史、分支、checkout 中繼資料無關。

### 2.1 不自我參照

存放「預期雜湊」的檔案絕不在雜湊集合內：`rules/registry.json`、`cli/lib/fingerprint.ts`、`cli/lib/fingerprint-v2.ts`、`cli/lib/rules-registry.ts`，以及 `saves/`、`journal/`、`tests/`、`docs/`、`web/`、`reports/`。若正式流程匯入了其中任何一個，計算直接失敗（`SELF_REFERENCE`）。

### 2.2 不影響存檔的修改（v2 不變）

網頁觀察器（`web/`）、文件、測試、`cli/advance.ts`、`cli/check-saves.ts`、`cli/web-export.ts`、`cli/lib/save-transaction.ts`、報告產生器、登錄檔、未被正式流程匯入的 `engine/` 子目錄與 `engine/globals.d.ts`。

**注意（待 Owner 確認的範圍取捨）**：`cli/advance.ts`、`cli/lib/conservation.ts`、`cli/lib/day-summary.ts` 是推進工具（決定交易、守恆檢查與日誌摘要格式），**不在** v2 內，以免每次工具修正都要登錄新規則版本。它們不改變模擬出的狀態；Day15 遷移所讀的氣候檔由 `data` 群組涵蓋。若 Owner 認為日誌摘要格式也屬「規則」，可把它們加入進入點（會使 v2 變動，屬規則更新）。

## 3. 與 v1 的相容（既有歷史不改）

- **目前正式存檔**：`saves/` 是 Day14，`sim_engine_v2` 尚不存在，所以**沒有任何凍結指紋**；`saves/commit-log.json` 也尚未建立（第一次正式推進時才建立）。本 PR 不動它們；`npm run check:saves` 與 `npm run advance`（預演）照常通過。
- **v1 不變、繼續驗證**：`cli/lib/fingerprint.ts` 一字未改；登錄檔中 v6～v31 只有 v1 指紋，`tests/rules-registry.test.ts` 仍以 v1 確認目前程式＝v31。
- **依凍結紀錄自己的格式比對**：凍結紀錄沒有 `schema` → v1，以 `{engine, params}` 比對；`schema = antempire.rules-fingerprint.v2` → 以 v2 全部欄位比對。推進工具每次同時計算 v1 與 v2。
- **登錄檔**（`rules/registry.json`，schema 不變）：每筆可選欄位 `fingerprint_v2`。CI 規則：
  1. `fingerprint_v2` 必須格式正確、`digest` 與欄位一致、`engine_version`＝該筆 `rules_version`；
  2. 第一筆帶 `fingerprint_v2` 的版本之後，**每一筆都必須帶**；
  3. 最後一筆若帶 `fingerprint_v2`，目前程式的 v1 **與** v2 都必須相符；
  4. 各版本的 v1 指紋不得重複。
- **Day15 啟用**：若目前程式對應的登錄版本帶 `fingerprint_v2`，直接凍結 v2；否則凍結 v1（＝現行行為，輸出逐位元組相同）。

## 4. 只對「下一個遊戲日」採用 v2

1. 下一個規則更新 PR（任何會改輸出的版本，例如 v32）在登錄檔新增一筆，同時填 `fingerprint`（v1）與 `fingerprint_v2`（`node cli/lib/fingerprint-v2.ts` 的輸出，不含 `files`）。PR 合併＝Owner 核准。
2. 存檔若凍結在 v1（例如 v31），一般推進會被拒絕（`RULES FROZEN`，並列出正確指令），**不會自動切換**。
3. 玩家明確要求時：`npm run advance -- --adopt-rules <v32> --confirm-advance --day N`。在同一筆可復原交易中：
   - 驗證存檔凍結於前一版（以 v1 比對）、目前程式＝v32（v1 與 v2 都比對）、不可跳版；
   - `rules_fingerprint` 換成 v2 紀錄、`activated_from_day: N`；`rules_history` 追加 `{from_fingerprint: v1, to_fingerprint: v2, effective_from_day: N}`；
   - commit log 第 N 天記錄 v2 紀錄與 `rules_adopted`。**第 N 天之前的 commit log 項目、日誌與 `rules_history` 保留 v1，不回溯改寫。**
4. 之後每天以 v2 比對：即使 v1 相同，只要正式流程的任何原始碼（例如 `cli/lib/project-day.ts`）、參數、輸入資料或 Node 版本改變就拒絕推進。
5. 凍結 v2 之後不可再切換到沒有 `fingerprint_v2` 的版本（`V2_DOWNGRADE`）。

**為什麼不在本 PR 給 v31 補上 `fingerprint_v2`**：那等於改寫已核准版本的登錄紀錄；而且 `--adopt-rules` 只接受「下一版」，同一版本無法「再採用」。因此 v2 隨下一個正式規則版本一起生效。

## 5. 實驗 Worker（PR #169，分支 `…-worker-runtime`）的現況與日後採用

- 現況：`prototypes/continuous-world/worker/core.ts` 的 `rules_fingerprint`＝sha256(標準 JSON `{engine_version, schema_version, params}`)，是單一字串，**不含程式碼雜湊**；文件註明「改核心行為時必須提高 `ENGINE_VERSION`」。它只用於非正式實驗世界的快照驗證，與正式存檔無關。
- 日後採用 v2 的建議（另開 PR，不在本 PR 修改該分支）：
  1. 進入點改為 Worker 的 `entry.ts`（＋`worker-boundary.json` 白名單內的引擎模組），用同一套 `sourceClosure` 規則與編碼計算 `source`；`params` 用 Worker 的參數標準 JSON；
  2. 瀏覽器端無法讀自己的原始碼，因此由 Node 在建置／匯出時計算，寫入**不在雜湊集合內**的清單檔（例如 `prototypes/continuous-world/worker-fingerprint.json`），由 Node 測試確認與原始碼一致；Worker 只讀這個值，避免自我參照；
  3. 快照的 `rules_fingerprint` 改為與本文相同 schema 的物件（另取 schema 名，例如 `antempire.experiment-fingerprint.v2`，以免與正式存檔混用），並把 `schema_version` 升版；舊快照依舊格式驗證或明確拒絕，不靜默轉換。

## 6. 測試（`tests/fingerprint-v2.test.ts`，列入 BLOCKING）

決定性（兩次、不同目錄）；輸入順序與進入點順序無關；CRLF＋BOM、單獨 CR 與 LF 相同（同時證明 v1 對 CRLF 敏感）；非法 UTF-8 拒絕；13 種非模擬檔案修改不改變 v2；9 種模擬檔案修改會改變對應欄位；新檔被匯入後才納入；自我參照、套件匯入、缺檔一律拒絕；註解中的匯入不算；登錄檔規則（必填、篡改、v1 同而 v2 不同、v1 重複）；臨時副本上 v1 凍結→v1 推進→`--adopt-rules` 切到 v2（只從第 N 天）→v2 推進→v2 偵測 v1 看不到的改動→禁止回到 v1；登錄版本帶 v2 時 Day15 直接凍結 v2；正式 Day14 存檔 `check:saves` 通過、`advance` 預演通過且不寫檔。

## 7. 風險與限制

- 匯入偵測是對原始碼的正規表示式掃描（不是完整 TypeScript 解析器）。字串中恰好出現 `from './x.ts'` 會多算一個檔（偏保守）；以變數組出的動態匯入偵測不到——正式流程目前沒有動態匯入，新增時應以測試把關。
- 內容雜湊：純格式化或註解修改也需要新規則版本。
- 若 Owner 日後改變 Day15 遷移的輸入（`cli/advance.ts` 讀取的檔案），需同步更新 `V2_DATA_FILES`（這本身就是規則更新）。

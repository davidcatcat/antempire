# 規則更新 RU-2（v2-review.33）：三個死參數標「未實作」

> 2026-11-13。依據：Owner 在 #219 的裁示（Q5：RU-1 → RU-2 → …，各自一個 PR）與 `docs/garden-supply-demand-audit.md` §0 第 9 點、§5 的 RU-2 定義（「移除或標『未實作』」）。
> **規則更新，但只改中繼資料**：數值、單位與其他欄位一律不變；所有輸出與 v2-review.32 逐位元組相同。不推進遊戲時間。

## 1. 三個參數與證明

| 參數 | 值 | 為什麼是死的 | 證明 |
|---|---:|---|---|
| `world` `honeydew.honeydew_daily_replenish` | 0.65 份／日 | 蜜露產量來自半翅目群數 × `hemipterans.honeydew_per_colony_per_day`（`engine/ecology.ts`），沒有固定補充 | 靜態＋動態 |
| `world` `plants.new_plant_event_probability` | 0.035／日 | 引擎沒有新植物、新花期或落果事件；花期只有一次倒數（稽核 D4） | 靜態＋動態 |
| `species` `nutrition.brood_protein_min_fraction` | 0.45 | 舊幼體規則、C4a、C4b 都不讀；幼蟲發育的營養反應形式是 Owner 待決（`larval_development.nutrition_response` = null） | 靜態＋動態 |

`tests/ru2-dead-params.test.ts`（阻擋型）：
1. **靜態**：`engine/`（含所有子目錄）與 `cli/` 的程式碼（去除註解與字串）完全沒有這三個名稱；正面對照確認偵測器看得到引擎確實讀的參數。
2. **動態**：把每個參數設成 0 與 3 倍，三個 Day0 世界（含暖機，各 45 日）與 Day14 fixture 30 日的完整輸出雜湊都與原本相同。
3. **標記**：每個都有 `implementation: { status: "未實作", engine_reads: false, since_rules_version, evidence, note }`，其他欄位與 v32 完全相同；稽核工具把它們標為 `MARKED_NOT_IMPLEMENTED`；稽核找到的其他未讀參數必須列出理由（目前只有已退役 Day15 遷移的 `listed_production`，描述本來就寫「未使用」，不在 #219 列出的三個之內）。
4. **相容**：由 `bundleAtVersion` 重建的 v32 參數檔（沒有標記）雜湊等於登錄的 v32 參數指紋，仍能載入、解析並得到相同輸出。

## 2. 為什麼標記而不刪除

- 刪除會讓凍結的舊黃金情境失效：`tests/lib/scenarios.ts` 的 `abundant-30` 以舊路徑覆寫 `sources.honeydew_daily_replenish`（它對輸出本來就沒有作用，但覆寫找不到參數會丟錯），而黃金 fixture 與情境是唯讀的回歸基準（CLAUDE.md §1）。
- 刪除也會讓 `tests/params-split.test.ts`（v6 參數一對一保留）、`bundleAtVersion`（重建舊版本參數雜湊，目前不支援 `param_removed`）需要另外的遷移規則；標記不需要。
- 相容性：較舊的參數檔（沒有 `implementation` 欄位）照常載入，行為完全相同（引擎從不讀這三個值），所以沒有「靜默改變」的風險；標記只讓讀檔的人與稽核工具看得到它們沒有作用。
- 之後若要真的實作其中任何一個機制（例如 RU-4 的季節重新開花），要另開規則更新 PR，拿掉標記並以新版本說明。

## 3. 回滾

還原本 PR 即回到 v2-review.32（只移除標記與版本登錄）。

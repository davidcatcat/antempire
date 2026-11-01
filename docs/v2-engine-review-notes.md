> 2026-11-01 提交說明：此頁為提交前審閱包的原始紀錄；v2 規則與測試現已合併至 main，但官方遊戲時鐘仍停 Day14。以下尚未提交字樣僅描述審閱時的歷史狀態。

# 🐜 《螞蟻帝國》引擎 v2｜**未提交的 Day15 規則更新審閱包**

**正式 GitHub `main` 仍是 Day14 / 336 小時；這個資料夾只有在本次對話隔離環境產生的程式、假設參數、測試與結果。沒有修改 GitHub、Day1～14存檔或日誌，也沒有正式推進 Day15。**

## 檔案與權威

- `sim/day_engine.cjs`：可執行 Node.js v2 **純單日決策＋狀態遞推**，不依賴 Git Commit SHA、無第三方套件。
- `sim/params.json`：**104項明示 `assumption:true` 的遊戲參數**（不是科學量測）；只有這一處是數值權威。
- `sim/migrate_day15.cjs`：由**真正Day14兩份JSON及現有氣候基準檔**產生一次性遷移、更新continuity/updated_at的提案，不重算前14天。
- `sim/run_day.cjs`：讀最新 `main.json`、`world-state.json`、凍結規則，執行1天後向**獨立輸出目錄**產生三個擬提交檔案：`saves/main.json`、`saves/world-state.json`及當日`journal/v2-day-NNNN.md`；原Repo不會被修改。原子GitHub commit需在使用者確認後由連接器單次提交。
- `docs/gm-rules.md`：日常唯一規則卡，整理原25份科學與機制長規格；未全面完成的進階功能標為待擴充。
- `sim/day14-projection.json`：從GitHub Day14已核對之個體/幼體/食源/氣候欄位建立的**隔離試跑投影**，未知值採假設；**不是Day14正式存檔的替代品**。
- `reports/review-report.md`：Day15～44每日的人口、糖/蛋白份、缺糧日數，以及一般/完全斷糧/食物充裕三情境對照。
- `reports/params-complete.md`, `reports/params-complete.csv`：所有參數說明。
- `reports/*-day15-44.csv`, `reports/*-day15-44.json`：30日實際程式試跑的詳細逐日帳與事件。

## v2.2 自然生態與無上帝視角規則（審閱補充）

- **不准 AI 介入死活、食物或事件結果**。蟻群全滅／衰退／成長皆可自然發生，不允許為了劇情、過關或保住人口而調整當日擲骰。
- 新昆蟲殘骸有**活體昆蟲存量 → 自然死亡 → 屍體生成 → 腐敗／採集**的來源鏈，並追蹤 F07、F11 局部昆蟲數；新昆蟲若移入，從已計數的有限鄰近花園昆蟲族群扣除，非憑空提供蛋白。
- 工蟻的出勤與食源偏好依**昨天同巢餵食互動訊號、個體舊路線及本人實際收穫記憶**決定，不偷看遠方食物存量或全巢精確庫存。未知點需沿已知鄰接路徑探索。
- `sim/test_naturalism.cjs` 驗證禁止任何 GM 強制指令、來源因果、事件白名單、外界昆蟲數量守恆、重播與局部探索。
- **重要：更新後的 Day15～44 一般情境沒有在30日內羽化新工蟻，Day44剩2隻工蟻、2隻蛹。** 這是新的因果約束造成的結果，**不能為了補齊羽化驗收而強制加食物或強迫羽化**；該項目前未通過。只有隔離的「增糧反事實試驗」能觀察羽化，並非正式遊戲未來。
- 所有 `--no-food`、`--abundant` 對照均是**測試副本**，絕不更動官方存檔或正式天氣/事件。Day1～14及GitHub main仍維持原狀。

## 在本審閱包重現試跑

安裝 Node.js 18+，不需要任何 npm 套件：

```sh
node sim/test_migration.cjs
node sim/test_30_days.cjs
node sim/test_30_days.cjs --no-food
node sim/test_30_days.cjs --abundant
node sim/test_scaling.cjs
node sim/test_naturalism.cjs
node sim/day_engine.cjs sim/day14-projection.json sim/params.json
```

上述命令在審閱包的隔離投影上運行。所有事件概率為遊戲參數，且同一輸入可逐字重播。`test_30_days.cjs`只輸出 `reports/`，不會碰兩份原始Save。

## 使用者確認之後（**目前不要執行正式提交**）

1. 將本包 `sim/` 的程式與參數、`docs/gm-rules.md` 加入Repo規則更新；**先確認**Day14兩份Save和歷史日誌不變。將`continuity`及`updated_at`修正使用 `sim/migrate_day15.cjs` 產生的待核准變更，而不是手改Day1～14。
2. 收到玩家**另一次明確「繼續」**後，從正式Repo根目錄運行 `node sim/run_day.cjs . /some/outside-repo/preview`，生成1天的三個擬提交檔案；該命令保證原Repo不改，先審計輸出，再用GitHub單次原子提交。
3. 推進中**不准**修改引擎/參數；下一次規則修改應獨立進行並指定未來生效日。以SHA256監督凍結狀態。

## 重要限制

- **份≠mg**：初始糖7.6份、蛋白2.3份、幼蟲初始半階段進度、老工蟻假設年齡7天等不是實驗數據。
- 30日一般情境可能有顯著工蟻死亡；這是特定情境的可重播結果，不是野外預言。
- 不包含實測土壤水分/巢溫或未來天氣；月氣候資料為長期均值，單日天氣屬合成值。
- 原有25份長規格中的多巢、病原、詳細捕獵、10,000個體cohort等尚未全部進入引擎；本包不宣稱完整實現。
- `sim/run_day.cjs` 在正式Repo根目錄才能讀到正確的兩份Save，**這次沒有對私人GitHub的完整Day14檔案進行本機端到端寫入測試**；現有migration/regression測試根據從GitHub核對的必要欄位構造隔離投影。經確認後仍須對正式完整Save再跑一次dry-run與雙存檔守恆驗證。

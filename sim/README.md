# 《螞蟻帝國》可執行單日程式

> **退役說明（Owner 2026-11-12，#194）**：舊版 Day14 存檔退役後，本目錄只保留 **v6 參考引擎**（`day_engine.cjs`、`foraging_physics.cjs`、`params.json`、`day14-projection.json`）與其原始 v6 測試腳本：`tests/differential.test.ts` 以它們證明目前的 TypeScript 引擎與 v6 只差已核准的規則更新（回歸 fixture，不是遊戲進度）。舊版正式流程的 `run_day.cjs`、`migrate_day15.cjs`、`test_migration.cjs`、Day9～14 重播引擎 `day_engine_v1_day9_day14.cjs` 與 `results/day9*～day14*` 已移除，保存在封存分支 `claude/ant-empire-engine-refactor-i45q93-legacy-day14-final`。下文是當時的說明，保留作歷史。

`day_engine.cjs`為Node.js CommonJS、無第三方套件，確實執行固定種子的歷史氣候生成、食源可及性、工蟻個體覓食、環境事件及蟻后產卵**情境抽樣**。範例：`node sim/day_engine.cjs < sim/results/day9-input.json`。輸出必須與`sim/results/day9.json`相符。

**尚未實作的部分**：由程式自動完成主世界JSON異動、能量代謝的mg/mJ定量結算、巢內微氣候、完整連續生命史、大群上萬隻稀疏cohort等。Day9世界與人口存檔是ChatGPT按程式輸出和既有科學規格做因果更新及守恆檢查後提交。**所有目前概率係數均屬未校準虛構情境，非蟻種實測發生率**。下一日要使用前一天持久化的氣候記憶，不可重用Day9靜態輸入。

# saves/（目前沒有正式存檔）

舊版正式遊戲存檔（`main.json`、`world-state.json`，停在 Day14）已依 Owner 裁示（2026-11-12，[#194](https://github.com/davidcatcat/antempire/issues/194)）**退役**：

- 不再延續 Day15，也沒有任何推進工具會寫入本目錄。
- 舊狀態保存在 git 歷史與封存分支 `claude/ant-empire-engine-refactor-i45q93-legacy-day14-final`（commit `d70174b`）。
- 引擎回歸測試需要的舊狀態逐位元組複製在 [`tests/fixtures/legacy-day14/`](../tests/fixtures/legacy-day14/README.md)，只作測試用，**不是遊戲進度，不可推進**。

新版正式世界將由新版 Day0 建立，須先通過正式化門檻（R2）。在那之前所有世界都是**非正式實驗**，本目錄只有這份說明。測試會檢查實驗執行期與觀察器不會在這裡寫入任何檔案。

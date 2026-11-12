# 已退役的舊版 Day14 狀態（只作引擎回歸測試）

> **已退役的舊版 Day14 狀態，只作引擎回歸測試，不是遊戲進度，不可推進。**

Owner 於 2026-11-12 裁示（[#194](https://github.com/davidcatcat/antempire/issues/194)）：舊版 Day14 遊戲存檔正式退役，不再延續 Day15；正式遊戲將由新版 Day0 開始。本目錄保留仍有回歸測試價值的舊狀態，**沒有任何工具會從這裡推進或寫回**。

| 檔案 | 來源 | sha256 | 用途 |
|---|---|---|---|
| `main.json` | 原 `saves/main.json`（Day14，`git mv`，逐位元組相同） | `f08578e831ccb3778c352364d44875b77d39f2241aa57236d9d0f89d48f38c93` | `tests/injury.test.ts`（Day14 傷害紀錄 → 傷害類型分類的回歸）、`cli/reports/compare-v11-v12.ts`（重現 v11→v12 報告） |
| `world-state.json` | 原 `saves/world-state.json`（Day14，`git mv`，逐位元組相同） | `820e627d893ba8c3de81c71e47b1062b3dfe27ff5f3f3f3d42ff4c9ce0013e23` | 同上；也是 `data/xitun-garden-geography.json` 逐字抽取花園地理的來源 |
| `../day14-projection.json` | 舊版 Day14 存檔投影成的 v2 引擎狀態（與 `sim/day14-projection.json` 逐位元組相同） | — | golden 的 28 條完整輸出軌跡、Day15–134 報告、差異測試（對 `sim/` v6 引擎）與多數引擎情境測試的起始狀態。golden 檔記錄了這個來源路徑，為了讓 golden 檢查的內容完全不變，此檔留在原位置 |

規則：

- 這些檔案**只讀**；不可修改、不可「推進」、不可當成正式世界或新遊戲的起點（新版 Day0 不載入舊版 Day14）。
- 測試以它們驗證引擎行為不變；它們的數值是舊版遊戲歷史，不是野外實測，也不是科學結論。
- 舊版完整狀態與 Day1～14 日誌在封存分支 `claude/ant-empire-engine-refactor-i45q93-legacy-day14-final`（commit `d70174b`）與 git 歷史中。

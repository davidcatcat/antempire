# 規則更新 v2-review.16 審查報告：死亡診斷（Owner 項目 3.2）

> **診斷正確性修復**：沒有改任何死亡機率、隨機抽樣順序或狀態。正式存檔仍是 Day14。依賴 #28（v15），尚未合併。

## 1. 問題（程式證據）
v15 的 `engine/queen.ts` `queenSurvival()`：
- 只要「連續缺口日 ≥ 12」或「無工蟻 ≥ 3 日」，就用**一次**抽樣比對 `max(0.008, 0.24)`；
- 但死亡事件一律寫成 `prolonged_energy_or_protein_deficit_scenario`（長期能量或蛋白不足）。
- 結果：
  - 「沒有工蟻」造成的死亡被誤標成營養不足；
  - 糖與蛋白不足無法區分；
  - 蟻后根本沒有自然／年齡風險，報告卻看不出來。

工蟻死亡（`workerSurvival()`）：
- 自然／年齡／傷害風險與飢餓風險以 `1-(1-a)(1-b)` 一次抽樣；
- 原標籤只說「飢餓與自然競合」，沒有記錄各項大小。

## 2. 修改後
- `queen_death`：
  - `reason`：決定實際套用機率的那個觸發條件。規則取最大值，所以有「無工蟻」時就是 `no_workers`。
  - `active_triggers`：所有同時成立的條件（`chronic_sugar_deficit`／`chronic_protein_deficit`／`chronic_sugar_and_protein_deficit`／`no_workers`）。
  - `hazards`：各條件的機率、實際套用值，以及 `natural_age: 'not_modelled'`（不是 0 風險，是沒有模擬）。
  - 糖、蛋白缺口日數、無工蟻日數，以及抽樣方式說明（`sampling`）。
- `worker_death`：保留原 `reason`，新增 `hazards`（自然／年齡／傷害、糖缺口飢餓）與抽樣方式（競合風險，無法分出單一死因）。

## 3. 隔離證明
- `tests/golden/approved-rule-changes.json`：`kind: engine, diagnostics_only: true, normalise_output: death_diagnostics_v16`。
- `tests/rules-isolation.test.ts`：移除這些新增欄位、把蟻后 `reason` 還原後，28 個 Day14 情境與 24 個 Day0 情境都和 v15 golden **逐位元組相同**；之前各版的隔離步驟也一併套用這個還原。
- `tests/differential.test.ts`（對 v6）同樣通過。
- `reports/day15-134-v16-*.csv` 與 v15 相同。

## 4. 用新診斷重看 v15 的 Day0 結果（`reports/day0-v16/`；人口、營養完全不變）
| 蟻后死亡的實際觸發條件（236 次死亡） | 次數 |
|---|---:|
| 無工蟻（同時糖缺口） | 110 |
| 無工蟻（同時蛋白缺口） | 41 |
| 無工蟻（同時糖＋蛋白缺口） | 28 |
| 無工蟻（無營養缺口） | 13 |
| 長期蛋白不足（仍有工蟻） | 35 |
| 長期糖不足（仍有工蟻） | 9 |

**解讀**：
- 192/236（81%）的蟻后是在**工蟻全部死亡之後**才死；
- v15 報告中「蟻后全部死於長期營養不足」是錯誤標籤；
- 滅巢的主線是「工蟻先因糖缺口死光 → 蟻后在無工蟻狀態下死亡」，修正工蟻覓食（第一階段）是正確的優先順序。

# Codex repository review — round 6, 2026-11-07

審查者：Codex。重新讀取 GitHub main、open PR／issue 清單與 #106 最新說明。結果仍為9張 open PR、23項 open issue；相對上一輪只有 #106 更新。審查及測試在隔離 archive 副本執行，Node22.23.4。

## 結論

**#106 的上輪 P3（F-R5-01，巢內視角死亡後仍保留追蹤）已在 `ce17591` 獨立複驗修復，可關閉。** 本輪新增差異未發現新的 P0／P1／P2／P3。#106 維持 **APPROVE WITH COMMENTS**，僅適用唯讀 UI 與本次修復；favicon 的瀏覽器測試條件及既有科學／物理限制仍須保留。

main 未變，未重跑其整套測試。上一輪 main 完整51/51、存檔20/20、typecheck通過的結果，只作同一SHA的既有證據，沒有冒充本輪執行結果。

## 固定版本與範圍

| 對象 | SHA | 本輪處理 |
|---|---|---|
| main | `ffb54ff95bb65ac623319a4e0e2d985ee58b803e` | 未變，沿用上輪審查與限制 |
| #93 | `fafe9b18adf247e8aa317b84d04eaec55d144cd0` | 未變，沿用有限APPROVE；仍未合併 |
| #95 | `e76a5ee9b0f1be78d596c75b1b35e5d40ba73856` | 未變，沿用先驗候選的有限APPROVE |
| #96 | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | 未變，沿用隔離見證／回放原型的APPROVE WITH COMMENTS |
| #97 | `b391704ed41277bf2d5d501c84b640b254c3d771` | 未變，沿用C4b工程契約的APPROVE WITH COMMENTS |
| #98 | `003184d785c7279174de8152e12941ea255b36f5` | 未變，原修復的有限審查不代表後續已知缺陷消失 |
| #105 | `ef8308d5a663ad2a9835c4c2ca023ad3652c85fb` | 未變，仍須帶入#108的P1-A修正才能對完整物理定案 |
| #106 | `ce175913af3ede9fab424f96502d38e87c9badfd` | 新增差異審查、原始探針與瀏覽器複驗；APPROVE WITH COMMENTS |
| #108 | `30900f26f73ba17f90f88d499718ea86135bb48a` | 未變，沿用A／B數值修復的有限APPROVE WITH COMMENTS；B採用待Owner決定 |
| #109 | `66047ef633ab33181608d36fc72014022d6b9fa0` | 未變，沿用純狀態文件的APPROVE WITH COMMENTS |

完整前輪證據：[round5](https://github.com/davidcatcat/antempire/blob/c52a07c792d72b00a1c772dd51cdc3a726381a98/reports/codex-review-main-open-prs-round5-2026-11-07.md)。本輪不重新宣稱已深度複驗每張未變PR的所有內容。

## F-R5-01 修復審查

相對93a80cb只改兩個檔案：

- `web/src/main.ts`：`draw()` 現在先取得繪圖個體、執行 `applyFollow()`，才分支到nest視角。死亡／不存在的追蹤終止不再依賴是否正在畫地表。
- `tests/browser/web-follow.check.cjs`：在桌面與Android觸控配置各增加巢內視角跨死亡結算的前置及結果檢查；其餘斷言沒有放寬。

原始探針使用提交內的真實重播資料，沒有修改個體、時間紀錄或引擎：A1秋季種子20270001，Day10分鐘360選W009追蹤，切nest，再移到361（日終結算）。

| 狀態 | 新head的實測 |
|---|---|
| 結算前 | following=`W009`，W009仍在名冊 |
| 巢內死亡結算後 | following=`null`；名冊沒有W009；按鈕不再是「取消追蹤」 |
| 提示 | `W009 於 Day10 日終結算死亡（無時刻紀錄），追蹤結束` |
| 再切回garden | following仍為null，提示維持一致 |

這對應上一輪完全相同的重現步驟，修正不需要先切回花園。沒有改寫死亡時刻，也沒有復活工蟻。該P3可關閉。

## 本輪驗證

- typecheck、web build 通過。
- `web-v3-follow` 7,857項、既有 `web`／引擎匯出一致性1,458項、`platform-purity` 4,467項通過。
- 原始巢內死亡探針確認 following=null、正確死亡提示。
- 原browser suite：69項行為斷言通過，但因 `/favicon.ico` 404 的唯一console error，程序仍exit1。
- 僅對favicon回應204後重跑：69項、failures=[]、errors=[]；既有viewer smoke亦為failures=[]、errors=[]。這是有明示條件的通過，不宣稱原程序本機無條件通過。

測試副本只因本機環境設定既有Chromium的executablePath。原browser suite與只對favicon請求作204回應的版本均保留，原始輸出分開記錄；沒有攔截JS、JSON或其他應用程式錯誤。Android為Playwright觸控／尺寸模擬，不是實體手機。

未重跑main完整npm test、#108物理fuzz或每張PR的完整CI；沒有下載本次GitHub Actions artifact。本輪也沒有新的文獻全文核讀，不冒稱新的生物學驗證。

## 仍開放的事項

1. main的C3a opt-in實驗驗證仍缺#93的接觸／餵食順序檢查。上一輪原始探針在main接受多餵0.28份、在#93拒絕；本輪兩個SHA均未變，仍是已知P2，非本輪新增，也非正式Day14啟用配置。
2. #105仍有#107的行走終點遺漏P1；#108 A已在上輪獨立證實修復，尚未合併。#108 B的並排容差修正採用待Owner決定，不能用抵達率選正確模型。
3. #107的多體寬度容量、等待環等限制仍存在。上一輪三隻各0.8mm在2.0mm通路並排仍被接受，`checkExclusion=[]`不能當完整多體幾何證明。
4. 本種速度、非本種交通觀察與候選讓路規則的證據等級沿用前輪；本次純UI修復沒有增加物理／生物模型的文獻證據。#95先驗、#97營養函數與生命史／局部性／順序等待決事項未變。
5. favicon與舊Roadmap審查狀態等維護意見未因本次兩檔修改而關閉。科學接入仍須獨立規則與介面驗證；本次批准不等於合併或正式接入授權。

原始日誌位於本次工作區 `/workspace/scratch/repo-review-round6/`。只上傳本文到獨立review分支；沒有修改產品程式、正式存檔、日誌或參數，沒有合併PR、force-push、推進Day15或開始正式新版Day0。

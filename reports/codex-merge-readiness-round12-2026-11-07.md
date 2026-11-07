# Codex 複審與合併就緒報告 — round 12，2026-11-07

審查者：Codex。目的：重新核對目前哪些PR已可合併。沒有實際合併PR。

## 結論

**13張非Draft PR均已通過固定SHA的工程範圍複審與目前CI，可按依賴順序合併。#96仍為Draft，暫不列入。**

**可先合併：#98、#106、#116。**

| 堆疊 | 合併順序 | 批准範圍 |
|---|---|---|
| 隔離物理與播放 | **#98 → #105 → #108 → #111 → #115 → #118 → #120** | 合成場景／隔離物理，不接正式日循環 |
| 唯讀觀察器 | **#106 → #110 →（#113、#121）** | #113、#121是平行分支；#113不替換正式渲染器 |
| 世界排程／時間契約 | **#116 → #117** | 隔離工程基礎，不啟用正式時間契約或日內生態 |

本輪與round11的實質差別：**#111、#115、#118、#120原本尚在執行的CI，現在已全部通過。** main與14張PR的head、base SHA、base分支及OPEN／DRAFT狀態皆與上輪相同，沒有新程式變更需要重新定案。

每合併上游後，將下一張base改為main、核對diff、解決整合衝突並重跑CI。這不是一次無條件合完13張的保證。

## 最新版本與CI

main：`e11919b43c068fbf41ea06f05267e047e54fd5f3`，未變。#95、#97、#114、#119已在main，不再列成待合併。

CI快照：2026-11-07T19:19:40.689776+00:00。直接讀取14張GitHub `/pull/N/checks`，核對所選SHA與遠端head相同：14張均success；#96雖CI通過，仍因Draft保留。不是只採信作者留言，也沒有拿前一個SHA的綠燈替代。

| PR | 完整head SHA | 目前base | CI | 判定 |
|---|---|---|---|---|
| [#96](https://github.com/davidcatcat/antempire/pull/96) | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | main | 通過 | **Draft，暫不列入可合併**；原隔離見證／回放範圍判定沿用，需作者標ready並核對整合條件。 |
| [#98](https://github.com/davidcatcat/antempire/pull/98) | `58222c60d2717c8dd058af595e03b132d49bf78a` | main | 通過 | **可先合併**；隔離物理修復。 |
| [#105](https://github.com/davidcatcat/antempire/pull/105) | `d9e5f7c7e1f7284ea7437891e7b2c0252209186c` | #98 | 通過 | 可依序合併；先#98。 |
| [#106](https://github.com/davidcatcat/antempire/pull/106) | `24f16ca5971834e6497c02f7368be5c1299c940b` | main | 通過 | **可先合併**；唯讀V3觀察器。 |
| [#108](https://github.com/davidcatcat/antempire/pull/108) | `dd470950cab13d19725ad3b32df319d356c0e596` | #105 | 通過 | 可依序合併；先#105，限一維數值修復與診斷。 |
| [#110](https://github.com/davidcatcat/antempire/pull/110) | `37823ea8dec1e4733d924c8a941e12924fcfa7ac` | #106 | 通過 | 可依序合併；先#106。 |
| [#111](https://github.com/davidcatcat/antempire/pull/111) | `bf6eb97f959a616c10f05ee1c861bdee21ce3487` | #108 | 通過 | **CI等待解除，可依序合併**；先#108。 |
| [#113](https://github.com/davidcatcat/antempire/pull/113) | `57b25f24708fcaa3cb210ad4265e2d4b7e27759e` | #110 | 通過 | 可依序合併；先#110，隔離繪圖benchmark。 |
| [#115](https://github.com/davidcatcat/antempire/pull/115) | `63f5a10fbfe4ff255c20194e195e09389571b31c` | #111 | 通過 | **CI等待解除，可依序合併**；先#111。 |
| [#116](https://github.com/davidcatcat/antempire/pull/116) | `6b3be149efabe21e957e30056526ad549d7960ea` | main | 通過 | **可先合併**；重入P2已關閉，隔離排程器。 |
| [#117](https://github.com/davidcatcat/antempire/pull/117) | `d784ce688f7231bf9aee19a8d50ca496c18a87b9` | #116 | 通過 | 可依序合併；先#116，隔離時間契約候選。 |
| [#118](https://github.com/davidcatcat/antempire/pull/118) | `52ca24c36b71cda2f63ecfc1f827dc36b566f14b` | #115 | 通過 | **CI等待解除，可依序合併**；先#115，P3邊界view意見仍保留。 |
| [#120](https://github.com/davidcatcat/antempire/pull/120) | `0185102f47222bd03b4f2eec47d65caff0f80091` | #118 | 通過 | **CI等待解除，可依序合併**；先#118，只播放合成物理記錄。 |
| [#121](https://github.com/davidcatcat/antempire/pull/121) | `223a7e49642ed4af6e5552998996436f4de36284` | #110 | 通過 | 可依序合併；先#110，唯讀V5。 |

## 本輪實際複驗與證據界線

- 重新查詢遠端main與open PR清單，逐張核對head／base／狀態，並與round11的固定版本比較；全部相同。
- 重新執行14張目前base／head的 `git merge-tree --write-tree`，均無文字衝突。
- 在#116 `6b3be14`、#117 `d784ce6`的同SHA隔離副本，**再次執行R9-01／R10原反例與對照**：getter取消其他事件或排入更早事件均被guard拒絕，失敗後snapshot不變；沒有時鐘倒退；拒絕後正常step仍可執行；getter捕捉重入錯誤後回傳合法[]，外層批次可正常commit。普通非法取消、純throw getter、直接handler重入及普通合法輸出對照亦通過。兩張繼續APPROVE WITH COMMENTS，不恢復舊的REQUEST CHANGES。
- **沒有重跑未變main的整套測試。** round11在完全相同main SHA的單次 `npm test`57/57、check:saves20/20、typecheck通過，屬前輪本人已執行證據，沒有冒稱本輪新跑。
- 同SHA的#116 scheduler317／isolation82／registry36、#117 time-contract18754／scheduler317／isolation86、#118 solver2375／occupancy2542／isolation107，以及#121 V5 1573／V3 7857／V4 1375與typecheck/build，沿用round11證據。本輪未重跑未變的瀏覽器／大型效能實驗或重新取得文獻全文。

詳細程式、反例、科學界線及前輪測試：[round11報告](https://github.com/davidcatcat/antempire/blob/34e3c17730a5a45cdc2b58c2967e6d720ddcf743/reports/codex-merge-readiness-round11-2026-11-07.md)。本輪沒有新增找到P0／P1／P2阻擋；未變程式的批准範圍與既有限制保持一致。

## 合併時仍要處理

**跨堆疊仍有實際整合工作**：上輪對相同base/head試算，#98＋#106、#98＋#116、#106＋#116均在 `tests/run-all.ts` 衝突。必須保留雙方所有blocking測試，核對整合後指紋／產生資料，再跑整合CI；不能ours/theirs丟掉另一方測試。三條堆疊各自從此main試算則均乾淨，#113與#121也可依序加入。

round11另已核對13張非Draft分支的blocking清單沒有因合入main而漏掉main或各自前輪測試。這些檢查與各head CI，不等於所有混合樹都已完成全套整合測試。未登入頁面也不能證明帳戶權限、分支保護要求或GitHub merge按鈕狀態；本報告給的是程式／測試範圍的合併建議。

**既有非阻擋P3仍保留：**

- #118：laneBoundary回傳的快取view只有淺層readonly，巢狀座標可被違反只讀用途的呼叫端修改。現行solver呼叫端只讀，因此仍非目前隔離合併阻擋；建議後續深層不可變／凍結或複製，沒有假稱修好。
- 觀察器瀏覽器harness在本環境曾因favicon404而exit1。前輪只有在隔離harness指定現有Chromium並將該favicon回204後，所有錯誤檢查才通過；這個條件仍揭露，不能說原harness在任何環境都無條件通過。現有GitHub CI則已在表列head實際成功。

## 科學與正式啟用界線

13張可合併限各自的工程範圍，不代表完整熱帶大頭家蟻模型已科學驗證。Vázquez2020的本種實驗室路線速度不驗證野外速度、讓路或碰撞身形；其他蟻種的交通研究只能支持候選比較。膠囊、固定u、瞬間轉折、最大可行速度與時間格點仍是模型／工程契約。

營養新開關維持預設關閉，nutrition_response仍null；隔離物理、排程器、時間契約與只讀UI的合併，不會自動修完順序、個體營養／死亡、溫度、生命史或生態閉合的既有issue，也沒有批准正式Day0、推進正式Day15或接入正式物理。

證據存於 `/workspace/scratch/repo-review-round12/`。Node22.23.4、隔離副本；唯一上傳內容為此Markdown報告。未實際合併PR、改base、force-push、修改產品程式、正式存檔／日誌／參數，未推進正式Day15或啟動新版正式Day0。

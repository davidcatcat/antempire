# Codex 複審與合併就緒報告 — round 10，2026-11-07

審查者：Codex。目標是重新審查最新 main 與未合併 PR，回答哪些可以合併。沒有執行 PR 合併。所有判定只適用於表列固定 SHA；推送前再次核對遠端。

## 1. 結論

**18 張未合併 PR 中，15 張可列入工程／文件範圍的合併候選。#96 仍是 Draft，#116 與 #117 因同一個已重現的排程器原子性／時間倒退問題暫緩。** 新增 PR #118、#119、#120、#121 在下列範圍可 APPROVE WITH COMMENTS；沒有發現新增的 P0／P1 阻擋，另有一項 P3 邊界view維護意見及既有favicon測試可攜性意見。

main 現為 `40dfe10ffc50c279b96fb150a2a7360f87c8c2a1`。上輪候選 #93、#109、#112 **已由其他人合併**，本輪不再列成待合併。#93 的 C3a 交錯接觸反例已在新 main 實際拒絕，合法對照仍接受。

**可先合併的三張：#95、#98、#106。** 後續按以下依賴順序：

| 堆疊 | 順序 | 必須保留的範圍 |
|---|---|---|
| 營養與分析 | **#95 → #97 → #114 → #119** | 新營養開關仍 OFF，nutrition_response=null；#119 只讀實驗報告，不調參 |
| 隔離物理與播放 | **#98 → #105 → #108 → #111 → #115 → #118 → #120** | 合成場景／隔離物理；沒有接到正式日循環或正式 Day0 |
| 唯讀觀察器 | **#106 → #110 →（#113、#121）** | #113 與 #121 都疊 #110，是平行分支；#113 不替換正式渲染器 |

每合併上游後，下一張須把 base 改成 main，再核對 diff、解決實際整合衝突與重跑 CI。**這是合併就緒建議，不是把預設關閉的候選機制啟用到正式模擬。**

## 2. 最新 SHA、CI 與個別判定

本輪從 GitHub PR HTML 核對實際 state／base／head；從每張 `/pull/N/checks` 頁面的所選 SHA 與 success 摘要核對 CI。18 張目前 head 均顯示 CI success，包括仍有漏洞的 #116／#117；沒有只採信作者留言。#116 head 仍是上輪的3818d1b，沒有誤用舊提交來否定後續修復。

| PR | 完整 head SHA | 目前 base | 判定 |
|---|---|---|---|
| [#95](https://github.com/davidcatcat/antempire/pull/95) | `b0e83b7adf18c46822fac2492539b8b2c6436f2f` | main | **建議合併**；預設 OFF。已合入新 main，整合衝突已處理，v29 指紋與本輪測試通過（執行條件見§3）。 |
| [#96](https://github.com/davidcatcat/antempire/pull/96) | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | main | **暫緩操作**：仍為 Draft；原隔離 sensor witness／回放工程判定可接受，未批准 Rapier 接入。 |
| [#97](https://github.com/davidcatcat/antempire/pull/97) | `662852dc968a1f2efd9c1ef8922d79db6623fc87` | #95 | **可依序合併**；先 #95。營養形式 null、開關 OFF，不替 Owner 選模型。 |
| [#98](https://github.com/davidcatcat/antempire/pull/98) | `ef182294688bb42eb5f66592b26a4151bd1a6878` | main | **建議合併**；隔離物理修復，接著合入 #105／#108，不能單獨當完整物理已修好。 |
| [#105](https://github.com/davidcatcat/antempire/pull/105) | `a5e838b5dbbf3d59567013dc87f3aa2c2f595bff` | #98 | **可依序合併**；先 #98，之後接 #108。 |
| [#106](https://github.com/davidcatcat/antempire/pull/106) | `0f60fa23c072d105c1ebd14b7681e8b06da6f29f` | main | **建議合併**；唯讀 V3 觀察器，未變動其本身 UI 邏輯。 |
| [#108](https://github.com/davidcatcat/antempire/pull/108) | `a79703d2f269878f0ae6ef5449dfc4b6094144b8` | #105 | **可依序合併**；先 #105，限一維修復與診斷，Owner D1 採用紀錄沿用。 |
| [#110](https://github.com/davidcatcat/antempire/pull/110) | `daa639d5aa3cdb5b09ecf6a6eb0c2d2544e1510e` | #106 | **可依序合併**；先 #106，唯讀統計與推得速度。 |
| [#111](https://github.com/davidcatcat/antempire/pull/111) | `b41a8b379ed48e668c4ed762b8c155e8f9781a23` | #108 | **可依序合併**；先 #108。上輪接縫與快取修復仍在，幾何程式未再改。 |
| [#113](https://github.com/davidcatcat/antempire/pull/113) | `1d0281da5b615d5628ef5690b386db886aee0135` | #110 | **可依序合併**；先 #110，僅隔離繪圖 benchmark。與 #121 是平行分支。 |
| [#114](https://github.com/davidcatcat/antempire/pull/114) | `02be173a7b380dfc2ed979312b3234cd42f8c9d4` | #97 | **可依序合併**；先 #97。局部線索修復／開關 OFF；v31 registry、局部性與型別檢查通過。 |
| [#115](https://github.com/davidcatcat/antempire/pull/115) | `ad736859a33cdd6e38c443e43f4307b73a221939` | #111 | **可依序合併**；先 #111。horizon 與共用幾何修復仍在，自身 solver 比較程式未再改。 |
| [#116](https://github.com/davidcatcat/antempire/pull/116) | `3818d1b0c4f90e28cea82a5dd52432bf572e17f9` | main | **REQUEST CHANGES**；R9-01 原反例仍重現，getter 重入可取消事件或倒轉時鐘。 |
| [#117](https://github.com/davidcatcat/antempire/pull/117) | `a51ab9ff6f5e4b6f729142666257aa02dc225d32` | #116 | **REQUEST CHANGES／上游受阻**；先修 #116，且本 head 也重現同一漏洞。時間契約測試通過不能消除此阻擋。 |
| [#118](https://github.com/davidcatcat/antempire/pull/118) | `2a231c5c098b564a753ffcfe56c87a7195383710` | #115 | **APPROVE WITH COMMENTS，可依序合併**；先 #115。限隔離二維運動約束解算器；P3 邊界 view 維護意見見下。 |
| [#119](https://github.com/davidcatcat/antempire/pull/119) | `6c97c33d79560f888a8c6cc30ccebd22da6abb31` | #114 | **APPROVE WITH COMMENTS，可依序合併**；先 #114。只讀報告，測試重算吻合；不是營養模型已科學驗證。 |
| [#120](https://github.com/davidcatcat/antempire/pull/120) | `97841d7d19a5cabe051ca7163391280b35b920ed` | #118 | **APPROVE WITH COMMENTS，可依序合併**；先 #118。只播放記錄；節點幾何、讓路、側移仍未建模。 |
| [#121](https://github.com/davidcatcat/antempire/pull/121) | `bd0af246f5241e93208ddc45f545ab01b4e9e9ae` | #110 | **APPROVE WITH COMMENTS，可依序合併**；先 #110。唯讀 V5；favicon 測試條件完整揭露於下。 |

## 3. Main 與合入 main 的複審

main 這次的 tree 差異只有已審過的 #93 驗證強化、#112 研究／文獻文件、#109 狀態文件，以及對應測試／指紋／網頁實驗資料。沒有把歷史上的祖先 commit 列表誤解成又重做一次 C4a。

- **#93 原反例**：先確認合法 C3a 日被引擎、C2 讀取器、queen 讀取器接受；再把第一接觸的 feed_queen 挪到第二接觸後，補足0.28份蛋白並平衡帳。新 main 的引擎與 queen 讀取器均拒絕，明指餵食必須緊隨自己的接觸。C2 單獨接受金額平衡是預期的檢查分工，不是整組接受。
- **main 全套：52個blocking腳本均已驗證通過；原sandbox全套是50/52，save-transaction斷言與web-serve監聽EPERM失敗。只將這兩個原檔在外層executor重跑，兩者exit0（web-serve11項），未改測試／產品程式。check:saves20/20、typecheck通過。**不是原單次npm test已exit0的宣告**。**
- **#95 全套：53個blocking腳本均已驗證通過；原sandbox全套是51/53，同樣兩個腳本失敗，在外層executor原檔重跑皆exit0。check:saves20/20、typecheck通過。其餘通過腳本未重跑，沒有為兩個執行條件問題再跑整套。**
- 舊 PR 的新 head 大多只加入上述 main 的14檔變更；物理／觀察器各自的程式沒有額外變動。#95／#97／#114 另更新對應版本 fingerprint，#114 的 registry36項驗證及其目前v31指紋通過。

上輪「main → #93 → 舊 #95」的四檔衝突不是仍然沒修：現在 #95 已合入新 main，對當前 main 的 merge-tree 可乾淨合併；本輪按新 head 判斷。

## 4. 仍未修復的 P2：#116 及 #117 的輸出 getter 重入

R9-01 報告：[round9](https://github.com/davidcatcat/antempire/blob/7a2381d9ae428748f41a5fbb11ba5feda7aea2f0/reports/codex-merge-readiness-round9-2026-11-07.md)。本輪在 **#1163818d1b** 與 **#117a51ab9f** 重新執行完全相同的公開 API 反例，不是從上輪結論推測。

問題位置：#116 [world-events.ts:324](https://github.com/davidcatcat/antempire/blob/3818d1b0c4f90e28cea82a5dd52432bf572e17f9/engine/scheduler/world-events.ts#L324)；#117 [world-events.ts:507](https://github.com/davidcatcat/antempire/blob/a51ab9ff6f5e4b6f729142666257aa02dc225d32/engine/scheduler/world-events.ts#L507)。兩者都先 `inHandler=false`，之後才執行 `copyOutput(raw)`。後者會呼叫回傳物件的 getter，但 mutation API 的重入保護已解除。

1. 第0日minute1有now:a、minute10有future:a。handler 回傳的 cancel getter 先呼叫 `s.cancel('future:a', ...)`，再 throw。兩個 head 都是：外層 step 失敗、now仍scheduled，future卻已cancelled，snapshot改變、log增加1筆，audit仍通過。
2. getter 改成排一個minute0.5的根事件再return []：外層先提交minute1，下一次step執行minute0.5，**時鐘1→0.5倒退**；#117新增exact/native欄位與報告沒有阻止這個路徑。
3. 普通非法取消、只拋錯但不修改排程器的 getter、handler 本體直接重入三個對照都被拒絕且snapshot不變。

前前輪的「同一 getter 被讀兩次」已修，不重報未修；這裡阻擋的是讀取輸出階段仍可重入。**修正要求維持**：handler、輸出讀取／複製與驗證全程保留 guard，完整 finally 復原；或可靠拒絕 accessor／proxy，不得只加時鐘檢查而留下取消的原子性缺口。

#117 的18,754項時間契約、208項排程器及80項隔離檢查、typecheck本輪皆通過，不能否定以上獨立反例。先在 #116 修正，再讓 #117 正常合入並重跑同一反例；目前不建議兩張合併。

## 5. 新增 PR 的審查範圍與證據

### #117 時間契約：有用的診斷，仍受上述缺陷阻擋

檢查了原生clock／unit／anchor／t來源、double-double換算、tick標籤與layered排序、衝突report／refuse、跨日、快照及測量程式。測試18754項通過，並確實揭露60µs、1µs甚至1ns會合併本次物理資料中的不同事件；layered在這組資料中不合併。

這只能比較現有模型輸出的時間表示。精確保留輸入double不等於物理時間已科學驗證，跨clock的二進位小數與生物同時競爭規則仍需契約。沒有將建議layered當成已經取得正式啟用決策。

### #118 PH-3b：可以合併隔離解算器，不宣稱自然螞蟻行為已正確

閱讀了連續膠囊接觸、lane／靜態幾何、轉折保守推進、接觸元件的速度約束、事件版本與批次、broad phase及共同裁判介面。

- solver2375、occupancy2542、physics-isolation101、typecheck通過。包含其他接觸計算法比對、三種broad phase、順序／時間窗／網格變體與未知值拒絕。
- 本輪另外寫獨立交叉探針：固定起始亂數，120組候選、3組起始重疊正確拒絕，**117組合法三體交叉**檢查通過；從輸出紀錄重算膠囊，在0～5秒每1/30秒及所有輸出事件姿態時刻檢查，最大數值穿入約4.01×10⁻¹⁴mm，小於1e-9mm契約容差；沒有unresolved／aborted。這是有限場景與有限取樣的額外檢查，不是一般無穿隧證明。
- 不重跑1000隻約20分鐘的完整裁判，未把作者的效能／大型裁判數字算成本人本輪量測。
- u固定、無側移／讓路、無質量／摩擦／加速度、轉折瞬間轉向、節點幾何未檢查都有揭露。許多場景全部stalled在這個模型中是預期結果，不能推出本種會永久堵死。
- 最大可行速度是此運動學模型的閉合選擇。Tarski／單調不動點可支持其數學求解方法；它不是牛頓力學、接觸力或本種決策資料的替代品。

**P3 維護意見（不阻擋目前只讀呼叫端）**：新匯出 [laneBoundary](https://github.com/davidcatcat/antempire/blob/2a231c5c098b564a753ffcfe56c87a7195383710/engine/physics/body2d.ts#L251) 把快取的 boundary 原物件交出去，`readonly Bnd[]`只有淺層唯讀；巢狀p／q仍可被TypeScript呼叫端修改。獨立探針先在width0.2車道拒絕width0.8膠囊，再**刻意修改回傳view的水平邊y座標**，同一lane就被接受，而相同lane內容的fresh clone仍拒絕。這個探針需要呼叫端違反「只讀view」用途，不是正常solve2D自行錯算，故不與R8的合法輸入變更混為同等阻擋。建議回傳深層不可變型別並凍結／複製，避免日後繪圖或單位換算意外就地修改快取；目前solver呼叫端只讀，因此列P3。

### #119 營養因果鏈：批准報告工具的工程範圍

2628項檢查與typecheck通過；重算180個世界（6變體×3創巢設定×2季×5種子，各60日）的JSON與Markdown和提交內容相同，檢查守恆、每個幼蟲日互斥分類、只讀狀態及來源錨點。

來源→cache→工蟻取得只追蹤**池級流量**，明示沒有parcel身份，沒有把當日某筆卸貨偽稱為某隻幼蟲吃下的特定一份食物。尚存幼蟲／全cohort等分母、舊全巢發育與死亡、固定接觸次數／一口上限、模型參數均有區分。

「缺乏接觸與傳遞可在庫存充足時造成低攝取」是此程式結構下的診斷；不等於真實P.megacephala的瓶頸，也不是以存活率替候選營養函數調參。前述守恆限追蹤的區室，不代表世界物質／死亡屍體與所有生態通量已全部封閉。

### #120 物理播放頁：讀取分段運動，不產生行為

Node23101項、12個run／3349段與typecheck通過；重算輸出吻合、每個分段邊界來自該個體事件／起終點。瀏覽器另跑桌面＋手機，1932項通過，failures／page errors皆空。只在隔離harness副本指定既有 `/usr/bin/chromium` 路徑，沒有修改頁面或攔截應用資料。

#118運動在事件間分段等速；#120由兩端精確姿態重建該段，與一般觀察器的示意位置插值用途有別。畫面仍標合成／非正式／非生物行為，不能把演示的滑過與停止直接當本種觀察。

### #121 V5：唯讀UI範圍可以依序合併

Node1572項通過（1809列事件、1626段路線且抵達有紀錄、1204有地點標記／605無地點、60個幼體ID），typecheck及web build通過。檢查類別、跨日跳轉、來源地點、未知座標、路線／推得速度、日終統計、正式／非正式世界標示；沒有引擎／參數／存檔改動。

**瀏覽器條件揭露**：只加Chromium路徑的原harness副本跑出35項斷言通過、failures空，但因唯一console error而exit1；另行載入頁面確認網址就是 `/favicon.ico`404。之後只在隔離harness加入該favicon的204路由再跑，桌面／手機35項、failures／errors皆空，18張截圖。沒有壓掉其他console error或改應用資料。故不是「原測試在此環境無條件通過」；建議補favicon或在測試明示處理。這是已知可攜性P3，不阻擋唯讀UI功能的範圍批准。

## 6. 合併可行性與整合風險

對18張目前base與head的 `git merge-tree --write-tree` 均無文字衝突。另在沒有切換工作分支、沒有更新PR的隔離Git物件中，按上述三條堆疊從新main依序試算，每條各自全部乾淨，包括 #113 後接平行的 #121。

但是，**跨堆疊的 #95＋#98、#98＋#106、#95＋#106 仍會在 `tests/run-all.ts` 衝突**。要保留雙方所有測試，重新核對規則指紋與產生資料，再跑整合後CI。各自head的綠燈不代表混合後的樹已測過；本輪沒有替所有混合樹做人工解衝突與全套測試，也不宣稱GitHub帳戶權限／保護規則已驗過。

## 7. 科學與未完成事項

本輪未新增取得外部文獻全文。學術主機未列於當前允許清單；引用核讀限制沿用既有報告，不冒稱重新閱讀臺灣學位論文或新文獻原文。

- 本種實驗室速度（Vázquez2020）支持指定實驗條件下的速度觀察，不支持野外固定速度、讓路、側移或碰撞身形。Dussutour及Poissonnier的其他蟻種交通研究只支持候選比較，不直接提供本種已驗證參數。
- 接觸頻率、先驗、膠囊形狀、u固定與最大可行速度是模型／工程約定；#119的流量與#118的堵塞都是模型輸出，不能作生態觀察。
- open issue列表本輪仍有23項，含#9／#56順序依賴、#80世界食源守恆、#81營養、#83溫度、#84個體生命史、#85競爭等。隔離scheduler／物理與只讀UI的合併不會自動關閉它們，也沒有完成正式新版Day0的科學驗收。
- 合併後開關不自動打開，營養形式仍未選；#103正式／Day0物理接入仍是另案規則更新與驗收。

所有測試使用Node22.23.4與獨立archive副本；原始證據位於 `/workspace/scratch/repo-review-round10/`。唯一上傳內容為本Markdown，存於獨立review分支；沒有合併PR、變更base、修產品程式、force-push、改正式存檔／日誌／參數、推進正式Day15或啟動新版正式Day0。交易測試中的Day15／復原只在隔離archive與臨時測試世界執行。

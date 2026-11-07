# Codex 合併就緒審查 — round 9，2026-11-07

審查者：Codex。目標：回答「哪些可以合併」，以最新遠端 head／base、實際 CI 頁面、先前審查及本輪修復反例為依據。沒有執行任何 PR 合併。

## 結論與可執行順序

**目前可列入合併的共 14 張；#96 維持 Draft，#116 因新 P2 暫緩。** 14 張包含 6 張直接以 main 為 base 的候選，以及 8 張須先處理上游的堆疊 PR。這是各 PR 自身範圍的工程／文件合併建議；不構成正式模型啟用或科學驗證通過。

1. **直接以 main 為 base：#93、#95、#98、#106、#112、#109。** 建議優先 #93（修補 main 的驗證缺口）；#109 是純狀態文件，可留到最後同步實際狀態。
2. **營養堆疊：#95 → #97 → #114。** 開關保持預設 OFF，#97 的 nutrition_response 保持 null；合併不替 Owner 選營養形式或開啟模型。
3. **物理堆疊：#98 → #105 → #108 → #111 → #115。** 全部限隔離模組／實驗；#115 是揭露與比較求解失敗的框架，不是物理求解器已通過的宣告。
4. **觀察器堆疊：#106 → #110 → #113。** #113 仍是獨立繪圖效能原型。
5. **#96：固定 SHA 的隔離原型工程審查可接受，但目前 Draft，需作者先標 ready；本輪未代為變更。**
6. **#116：暫不合併，先修 R9-01。** CI 全綠和原反例修復不能取代這個新反例。

每條堆疊合併上游後，把下一張 base 改為 main，核對 diff，再跑整合後 CI；不能直接把整條堆疊合進仍為功能分支的 base。以上列的是候選與依賴順序，**不是保證 14 張可以在不用處理衝突或新指紋的情況下一次合完**。

## 固定版本與逐張建議

main：`ffb54ff95bb65ac623319a4e0e2d985ee58b803e`，未變。

本輪直接讀取 16 張 PR 的 GitHub `/pull/N/checks` 頁面，核對頁面所選短 SHA 與遠端完整 head 相符，16 張摘要皆為 success。不是只採信作者留言。各 PR 頁面亦核對 OPEN／DRAFT 及實際 base；#93、#95 的 base 現在已是 main，沒有沿用舊描述。

| PR | 完整 head SHA | 目前 base | 合併判定與必要界線 |
|---|---|---|---|
| [#93](https://github.com/davidcatcat/antempire/pull/93) | `fafe9b18adf247e8aa317b84d04eaec55d144cd0` | main | **建議合併，優先**：只加嚴 C3a 餵食逐筆因果驗證；main 仍有其修正的缺口。 |
| [#95](https://github.com/davidcatcat/antempire/pull/95) | `dc1232948be238bc26c4e584b141b05cd7cb0a5d` | main | **建議合併**：預設 OFF 的先驗修復；cohort 分母問題已在前輪關閉。 |
| [#96](https://github.com/davidcatcat/antempire/pull/96) | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | main | **工程可接受，尚不能合併**：目前是 Draft；限隔離 sensor witness／回放，非 Rapier 重解交通。 |
| [#97](https://github.com/davidcatcat/antempire/pull/97) | `e1fa9a081e955b1372d33c9615de0b3f631d008d` | #95 | **相依合併候選**：先 #95；預設 OFF、nutrition_response=null，未選生物模型。 |
| [#98](https://github.com/davidcatcat/antempire/pull/98) | `46144effd846fe9422898ddd845d730112eb655e` | main | **建議合併，限隔離修復**：後續 #105／#108 的問題不能算作此 head 已修好。 |
| [#105](https://github.com/davidcatcat/antempire/pull/105) | `6495dfab115e76925cce1ae0bb441ea2936d47d2` | #98 | **相依合併候選**：先 #98；其後接 #108，不能單獨宣稱物理已正確。 |
| [#106](https://github.com/davidcatcat/antempire/pull/106) | `ce175913af3ede9fab424f96502d38e87c9badfd` | main | **建議合併**：唯讀觀察器；維持示意／插值／未知值標示。 |
| [#108](https://github.com/davidcatcat/antempire/pull/108) | `7c3fda02f6dfb60231be7cc29d1ae4f554ba7d6f` | #105 | **相依合併候選**：先 #105；A、B 採用已有 Owner D1 紀錄；限一維模型數值修復與診斷。 |
| [#109](https://github.com/davidcatcat/antempire/pull/109) | `66047ef633ab33181608d36fc72014022d6b9fa0` | main | **可合併的純文件**：建議最後依實際合併與審查狀態更新「待審查／待裁示」文字。 |
| [#110](https://github.com/davidcatcat/antempire/pull/110) | `1733f13620809d4d2dd83fb395ffac538e042fcc` | #106 | **相依合併候選**：先 #106；唯讀圖表／推得速度，不能當直接量測。 |
| [#111](https://github.com/davidcatcat/antempire/pull/111) | `09c658bbec05eb511dcf36ca68d89b1d22d20672` | #108 | **相依合併候選；本輪改判 APPROVE WITH COMMENTS**：先 #108；R8-01／02 已修復。 |
| [#112](https://github.com/davidcatcat/antempire/pull/112) | `a28105974198bc5902887f8d5513dea0ab443d4a` | main | **建議合併，限研究／候選設計文件**：守恆修正已通過；不代表已選用候選模型。 |
| [#113](https://github.com/davidcatcat/antempire/pull/113) | `ba97cfbf6985cd6b37b46af81a7750d5c8b06a05` | #110 | **相依合併候選**：先 #110；限隔離繪圖 benchmark，不批准換正式渲染器。 |
| [#114](https://github.com/davidcatcat/antempire/pull/114) | `93dc2daa8309a69218f9440aed6110e58357bd0a` | #97 | **相依合併候選**：先 #97；預設 OFF 的接觸局部性修復。 |
| [#115](https://github.com/davidcatcat/antempire/pull/115) | `37f4f59ebef2a2b518646ca2e70d9fbcb62c7504` | #111 | **相依合併候選；本輪改判 APPROVE WITH COMMENTS**：先 #111；共用幾何修復已帶入，時限反例仍通過。 |
| [#116](https://github.com/davidcatcat/antempire/pull/116) | `3818d1b0c4f90e28cea82a5dd52432bf572e17f9` | main | **REQUEST CHANGES，暫不合併**：原重讀問題已修，新 R9-01 仍可重入而留下部分變更／時鐘倒退。 |

這些 head 的 `git merge-tree --write-tree <當前baseSHA> <headSHA>` 均無文字衝突。這是本機 Git 的三方合併檢查；未登入的頁面不能證明帳戶權限、分支保護要求或 GitHub merge 按鈕狀態，故不宣稱那些額外條件已獲授權／全部滿足。

## 實際整合風險：#93 與 #95 不能直接整批接連合併

在隔離 Git 物件中試算：main → #93 成功；再接 #95 即出現 4 個文字衝突：

- `tests/run-all.ts`
- `web/data/experiment-day0-A1-autumn-20270001.json`
- `web/data/experiment-day0-A4-autumn-20270001.json`
- `web/data/experiment-day0-A5-autumn-20270001.json`

因此建議 #93 先合後，將其 main 變更正常合入 #95，保留雙方測試，再按整合後程式產生相應實驗資料、核對 registry／規則指紋並測試。不要只選 ours／theirs 丟掉一方，也不要因兩張目前各自 CI 綠就跳過重新驗證。#93 修改了引擎檢查程式及 v28 fingerprint；#95 另有 v29 程式，**文字合得上也不等於較新版本的 fingerprint 仍匹配整合後引擎**。

本輪只診斷衝突，沒有代為解決、改規則、重新產生產品檔案或改任何 PR head。此試算在第一個衝突停止，未宣稱後續所有組合已完成整合測試。

## R9-01 / P2 / #116：輸出複製時解除重入保護，仍能留下部分變更甚至倒轉時鐘

固定版本：`3818d1b0c4f90e28cea82a5dd52432bf572e17f9`。
位置：[world-events.ts:324](https://github.com/davidcatcat/antempire/blob/3818d1b0c4f90e28cea82a5dd52432bf572e17f9/engine/scheduler/world-events.ts#L324) 的 `finally { this.inHandler = false; }` 在 [329 行](https://github.com/davidcatcat/antempire/blob/3818d1b0c4f90e28cea82a5dd52432bf572e17f9/engine/scheduler/world-events.ts#L329) `copyOutput(raw)` 之前。

前輪 R8-03 的「同一欄位讀兩次」確實修好了：原 cancel getter 現在只讀一次，合法第一次值被穩定提交，不再拋出第二次讀取造成的錯誤。**本項不是把已修的 R8-03 重報未修**。

然而新程式明確接受並執行 producer getter／proxy；複製期間已取消重入保護，getter 可以呼叫同一個 scheduler 的 schedule／cancel／step。這違反公開 API 的批次原子性與拒絕重入保證。全程只用公開方法及型別可表示的 getter，不需存取 private 欄位。

### 反例 A：錯誤時留下取消紀錄

```ts
import { WorldScheduler } from './engine/scheduler/world-events.ts';
const s = new WorldScheduler('W');
const scope = { world: 'W', colony: null, individual: null };
s.schedule({ kind:'now', key:'a', at:{day:0,minute:1}, scope, source:null, target:null });
s.schedule({ kind:'future', key:'a', at:{day:0,minute:10}, scope, source:null, target:null });
const before = JSON.stringify(s.snapshot());
try {
  s.step(() => ({ get cancel(): never {
    s.cancel('future:a', 'inside output getter');
    throw new Error('producer getter failed');
  }}));
} catch {}
console.log(before === JSON.stringify(s.snapshot())); // false
console.log(s.get('now:a')?.state);    // scheduled
console.log(s.get('future:a')?.state); // cancelled
console.log(s.log.length);            // 1
```

實測外層 step 拋 `Error: producer getter failed`，now 仍待處理，但 future 已被取消、log 多 1 筆；audit 回 total2／executed0／cancelled1／pending1，仍通過。這不是 audit 計數錯，而是失敗 step 沒有保留原狀。

### 反例 B：不拋例外也能讓執行時鐘往回走

同樣初態，在輸出 `cancel` getter 內排一個第0日第0.5分鐘的根事件，然後 return []。複製當下時鐘仍是0，排程被接受；外層先提交 now（minute1），下一次 step 又執行新事件（minute0.5）。

實測時鐘 `1 → 0.5`，log 順序也是先 minute1、後 minute0.5。原本在 handler 本體直接呼叫 schedule／cancel 會被 guard 拒絕，但把相同動作放在回傳值 getter 就能繞過。

**對照皆通過**：普通非法取消、單純會拋錯但不改排程器的 getter、handler 本體直接重入，均拋錯且 snapshot 不變。因此不是探針把所有錯誤都當原子性失敗。

**修正要求**：在 handler、輸出讀取／複製及驗證全階段保留重入保護，以完整 try/finally 復原；或在呼叫 accessor／proxy trap 前可靠拒絕這類輸出。任何 producer 程式執行都不能在未提交的批次中透過公開 mutation API 修改同一 scheduler。加入上述兩個回歸與直接重入／純 getter 對照。可另加防止下一批早於 clock 的驗證，但不能只補時鐘檢查而留下取消的原子性漏洞。

本項是隔離工程模組的 P2，不表示正式 Day14 已受影響；目前 #116 未接入正式模擬。

## 前輪修復複驗與本輪測試

使用 Node22.23.4；新 head 由 git archive 展開到獨立 /tmp 副本；根 package-lock 相同才沿用已安裝依賴。Rapier 測試實際載入鎖定的 deterministic-compat0.21.0，沒有以「未安裝而跳過」冒充通過。

| 對象 | 本輪本人實際執行結果 |
|---|---|
| #111 09c658b | R8 接縫與快取原反例、R7 折線／錯位排列／順序對照；occupancy **2542**、physics-isolation **93**、typecheck 通過 |
| #115 37f4f59 | H0.014／0.016／0.02 原反例及陽性對照；solver-compare **96**（有 Rapier）、typecheck 通過 |
| #116 3818d1b | 舊 R8-03 現在 getter 讀 **1次**，合法值正常提交；scheduler **208**、isolation **76**、rules-registry **36**、typecheck 通過；另有 R9-01 兩個失敗案例及三組正常拒絕對照 |
| 全部16張 | 當前 head／base／狀態與 exact-head CI 摘要核對；當前 base 的三方合併可行性檢查 |
| 整合試算 | main → #93 無衝突；再接 #95 有上述4檔衝突，停止，未造整合已成功的結論 |

R8-01：U形中心線 `[(0,0),(10,0),(10,2),(0,2)]`、寬2mm，軸在y1的L2.5/w0.8膠囊現在 inside:true，與包含矩形的合法對照相同，occupancy valid:true。

R8-02：暖快取後將寬2改為0.2，暖／冷副本現在都拒絕，說明內容簽章失效生效；原誤接受可關閉。新的接縫容差1e-9mm應明列為**工程契約**，不拿來宣稱真實螞蟻可以通過某種微小縫隙；以該已明示容差作隔離幾何契約，本審查不將它另外列為合併阻擋。

#115 的 H0.016/dt0.01 最後sample=0.016且arrival=null；H0.014同樣不越界；H0.02正常抵達約0.017999959秒。新 head 已帶入 #111 幾何修復，所以前輪「等共用裁判修復」的具體阻擋可解除。

未變的13張 head 沿用先前固定 SHA 的審查與測試證據，並重新核對遠端版本／CI／base；沒有聲稱本輪重跑每張全套或重新做所有瀏覽器／大型效能實驗。main 同一 SHA 的完整 npm test51/51、saves20/20、typecheck 屬 round5 證據，本輪未重跑。#106 瀏覽器測試過往曾需在隔離副本處理 favicon404 及設定既有 Chromium 路徑；不是原 harness 在任何環境皆無條件通過的宣告。詳見前輪報告。

## 文獻與生態模型邊界

本輪沒有新增取得外部文獻全文，科學審查依先前原文查核限制、repo 引用與候選設計延續，不將作者的原文宣稱冒稱為本輪本人重新核讀。

- Vázquez2020 的本種實驗室人工路線速度，不驗證野外速度、碰撞身形、交叉退讓或負重因果；Dussutour2005／2009、Poissonnier2019 的其他蟻種交通研究只能支持候選比較，不能直接充作本種參數。
- #95 的初始求食先驗是明示遊戲假設；#97 的營養函數與 #114 接觸線索屬預設 OFF 的候選機制。工程合併不解決參數可辨識性，不將尚存幼蟲的條件平均當整個 cohort 的發育速度。
- #112 是修正文獻表述與建立觀察算子／候選計畫，不批准單／雙費洛蒙、沉積門檻、競爭者物種或正式生態替換。#111 的膠囊、圓角車道及1e-9mm容差是模型／數值契約。
- #115 實測仍有重疊、未抵達與求解差異，正是 benchmark 應揭露的結果；框架測試通過不能把96項檢查寫成物理或生物有效。
- #116 的60µs時格與物理精確時間的銜接，仍需後續量化、原始時刻保留與因果順序驗證；這是接入閘門，本次阻擋合併的具體原因則是 R9-01。
- #9／#56 的順序依賴、個體營養與生存、溫度／生命史及生態閉合等既有 issue 沒有因上述合併候選而全數關閉。**本輪沒有建議啟用新版正式 Day0、推進 Day15 或接入正式物理。**

前輪完整審查：[round8](https://github.com/davidcatcat/antempire/blob/a0a0bae0988da1bffc3e433bb4dc30d781f3ed66/reports/codex-review-main-open-prs-round8-2026-11-07.md)。原始證據保留於 `/workspace/scratch/repo-review-round9/`。唯一上傳內容是本 Markdown 報告，存於獨立 review 分支；未修改任何 PR 程式、存檔、日誌、參數、base，未合併或 force-push。

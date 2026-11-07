# Codex repository review — round 8, 2026-11-07

審查者：Codex。重新查核main、16張未合併PR、23項open issue；重點為上輪修復及新PR #116。版本於本輪開始取得、上傳前再次比對。Node22.23.4；使用隔離archive副本，不切換使用者工作分支。

## 結論

**上輪6項P2與1項P3的具體反例皆已修復，可以關閉；但本輪新發現3項P2。#111、#116：REQUEST CHANGES。** 沒有發現新的P0／P1。

新問題不是重複宣稱舊修復沒做：#111的舊折線、錯位排列與順序案例現在都通過，但新區域邊界及快取另有反例；#116的批次原子性在特殊但可由API表示的回傳物件上失效。這些都是隔離工程模組的問題，未接入正式Day14。

#95、#97、#112的修正可在本輪範圍內改為APPROVE WITH COMMENTS。#115的horizon修復已通過原始反例，其共用#111幾何契約仍需等後者修正；不能以horizon批准涵蓋整個裁判。

## 固定版本與處理範圍

| 對象 | 完整SHA | 判定與範圍 |
|---|---|---|
| main | `ffb54ff95bb65ac623319a4e0e2d985ee58b803e` | 未變，沿用已知限制，不作整庫APPROVE |
| #93 | `fafe9b18adf247e8aa317b84d04eaec55d144cd0` | 未變，沿用餵食檢查強化的有限APPROVE |
| #95 | `dc1232948be238bc26c4e584b141b05cd7cb0a5d` | 分母與cohort結果修正複驗通過；APPROVE WITH COMMENTS |
| #96 | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | 未變，沿用隔離見證／回放原型的有限APPROVE WITH COMMENTS |
| #97 | `e1fa9a081e955b1372d33c9615de0b3f631d008d` | θ端點及可辨識性文字修正通過；APPROVE WITH COMMENTS |
| #98 | `46144effd846fe9422898ddd845d730112eb655e` | 未變，原四項修復的有限範圍不代表完整物理批准 |
| #105 | `6495dfab115e76925cce1ae0bb441ea2936d47d2` | 未變，仍需#108等後續修復，不把它們算成此head已包含 |
| #106 | `ce175913af3ede9fab424f96502d38e87c9badfd` | 未變，沿用唯讀UI有限APPROVE WITH COMMENTS |
| #108 | `7c3fda02f6dfb60231be7cc29d1ae4f554ba7d6f` | 未變，沿用原一維模型修復／診斷的有限APPROVE WITH COMMENTS |
| #109 | `66047ef633ab33181608d36fc72014022d6b9fa0` | 未變，沿用純狀態文件APPROVE WITH COMMENTS |
| #110 | `1733f13620809d4d2dd83fb395ffac538e042fcc` | 未變，沿用唯讀統計／速度顯示的有限APPROVE WITH COMMENTS |
| #111 | `1ec7e0084d87644a535ddb138108d747b553a2d2` | REQUEST CHANGES；新R8-01、R8-02 |
| #112 | `a28105974198bc5902887f8d5513dea0ab443d4a` | 守恆式修正通過；APPROVE WITH COMMENTS，文獻全文核讀限制不變 |
| #113 | `ba97cfbf6985cd6b37b46af81a7750d5c8b06a05` | 未變，沿用隔離benchmark的有限APPROVE WITH COMMENTS |
| #114 | `93dc2daa8309a69218f9440aed6110e58357bd0a` | 併入#95／#97修復；自身局部性修復範圍APPROVE WITH COMMENTS |
| #115 | `b7422c4eb61c6d162a011ab622f0c2dd841816f1` | horizon修復範圍通過；整體共用幾何裁判依賴#111，尚不能定案 |
| #116 | `6633369a438425d2e8fa304c00409321ad6ce06b` | REQUEST CHANGES；新R8-03；排程器仍隔離，未完成P0-A生態行為 |

前輪完整反例：[round7](https://github.com/davidcatcat/antempire/blob/9c958cd65b066577412b2c9e9f51dbeab052e558/reports/codex-review-main-open-prs-round7-2026-11-07.md)。本輪沒有將各種有限批准當成合併、正式接入或新版正式Day0的授權。

## R8-01 / P2 / #111：相接區域的內部接縫仍被當成外邊界

位置：[body2d.ts:146](https://github.com/davidcatcat/antempire/blob/1ec7e0084d87644a535ddb138108d747b553a2d2/engine/physics/body2d.ts#L146)，laneRegion的邊界萃取，以及capsuleInLane使用該邊界的判定。

新契約把車道定義為各直段矩形與圓角接點的聯集。程式只刪去「位於其他片段開放內部」的邊界；當兩個矩形邊對邊相接、兩側都被聯集覆蓋時，共同邊既不在任何單一片段的開放內部，卻在**聯集的內部**，因此被錯誤保留。

**獨立合法反例**：

- 單一U形車道：中心線`[(0,0),(10,0),(10,2),(0,2)]`，寬2mm。
- 身體L=2.5、w=0.8mm，s=5、u=1、dir=1，中心`(5,1)`，水平放置。
- 下、上橫段的矩形分別是`[0,10]×[-1,1]`與`[0,10]×[1,3]`；兩者聯集包含整個`[0,10]×[-1,3]`。身體位於其中，離真正外界有充分空間。
- `capsuleInLane(U,c)`卻回`inside:false, checked:true`，原因為「lane edge 0mm from axis < radius0.4mm」；`checkOccupancy2D`也回`valid:false`及outside_lane。
- **同一個膠囊**放入已知包含它的直線矩形對照：中心線`(0,1)→(10,1)`、寬4mm，回inside:true。

這不是兩個不同高度層，也不是要求新增螞蟻側移行為；它是在新契約自己定義的同一車道區域中誤拒合法身體。

**要求**：萃取真正的聯集邊界，處理共享邊兩側都被覆蓋的情況；或明示哪些自接觸幾何尚未支援並回not_checked，不能當作已證實越界。加入U形接縫合法對照與真正越界案例。

## R8-02 / P2 / #111：依物件身分快取，使縮窄後的車道仍被判合法

位置：[body2d.ts:85](https://github.com/davidcatcat/antempire/blob/1ec7e0084d87644a535ddb138108d747b553a2d2/engine/physics/body2d.ts#L85)、laneRegion快取查詢及160行寫入。

`regionCache`只以可變的Lane2物件為WeakMap鍵，沒有核對width／centerline內容或強制輸入不可變。相同幾何數值會因先前是否曾用同一物件檢查過，得到不同答案。

**獨立反例**：

1. 直線車道`(0,0)→(20,0)`、寬2mm。身體L=2.5、w=0.8，中心`(10,0)`；先呼叫一次capsuleInLane，合法並暖快取。
2. 把同一個Lane2的width_mm改成0.2（仍是合法正數輸入）。
3. 暖快取的`capsuleInLane`仍回inside:true；`checkOccupancy2D`更回`valid:true, violations:[], not_checked:[]`。
4. 對**內容完全相同的structuredClone**檢查，則回inside:false／valid:false，正確報半寬0.1小於身體半徑0.4。

這是錯誤接受，不只是診斷順序或微小浮點差。現有Lane2介面可變，未定義／強制「建立後不得修改」，因此不能把快取正確性依賴留成隱含前提。

**要求**：以幾何內容或版本失效快取；或建立明確且由程式強制的不可變幾何快照。若選後者，必須防止寬度及巢狀座標變更、清楚定義API，不能在輸入已改變時仍給舊幾何的合法證明。加入暖／冷快取一致性、縮窄與修改中心線的回歸檢查。

## R8-03 / P2 / #116：重讀handler回傳值，在驗證錯誤時留下已提交批次

位置：[world-events.ts:259](https://github.com/davidcatcat/antempire/blob/6633369a438425d2e8fa304c00409321ad6ce06b/engine/scheduler/world-events.ts#L259)先讀out.cancel驗證；262–263行更新時鐘與已執行狀態；264行**重新讀取**out.cancel再套用。

StepOutput目前只檢查是object，沒有拒絕accessor；帶getter的物件可由該介面表示。回傳資料被讀兩次時，可以在第一次驗證合法、提交後第二次變成非法。

**獨立反例**：建立now:a於第0日第1分鐘、future:b於第10分鐘。handler回傳：

```js
let reads = 0;
({ get cancel() {
  return ++reads === 1 ? [] : [{ id: 'does-not-exist', reason: 'x' }];
} })
```

實測step拋`SchedulerError: cancel of unknown event does-not-exist`，但：

- snapshot與呼叫前不同；
- clock已到第0日第1分鐘，round0；
- now:a已是executed，log有1筆；future:b仍待處理；
- audit仍可通過（total2、executed1、pending1），因為audit檢查的是計數與狀態，並不證明這次失敗呼叫沒有提交。

陽性／負向對照：普通合法`{cancel:[]}`正常提交；普通非法取消相同missing id則拋錯且snapshot完全不變、now:a仍scheduled。

**要求**：提交前把handler輸出讀取、複製成穩定的已驗證資料；commit階段不得再存取呼叫端的getter／可變輸出。也可明確拒絕accessor，但必須在變更任何狀態前拒絕。新增「第一次讀合法、第二次讀非法／丟例外」的原子性回歸。此項不表示恰好一次計數已崩潰，直接違反的是「任何輸出驗證錯誤，狀態完全不變且該批仍待處理」的承諾。

## 上輪7項的複驗結果

| 前輪發現 | 新版本與實際證據 | 結果 |
|---|---|---|
| R7-01 合法第二直段被誤拒 | #111 1ec7e00：原`[(0,0),(10,0),(5,10)]`、s15/u0、L2.5/w0.8，現在valid:true | 關閉原反例；新接縫問題另列R8-01 |
| R7-02錯位膠囊排列 | 新API帶s、L、w；原兩體s5/7.4、W1.2現在feasible:true，有見證u約−0.2／0.187298，原合法排列也valid:true | 關閉 |
| R7-03進度平均缺分母 | #95 dc12329：標明仍是幼蟲者的條件平均、輸出分母與cohort去向；重算9組JSON相同；另從羽化／死亡事件獨立核對所有原始個體 | 關閉 |
| R7-04漏θ=0 | #97 e1fa9a0：保留合法θ=0，加入θ=0、1測試，明列N(0)=1的例外，縮小端點等價的適用域 | 關閉；未為了結論偷偷改參數域 |
| R7-05守恆缺期初 | #112 a281059：任意[t₀,t₁]明列期初＋流入＝流出＋期末；前輪10＋3＝4＋1＋8對照現在成立 | 關閉該設計式問題 |
| R7-06抵達超出horizon | #115 b7422c4：原H0.016、dt0.01，末sample=0.016且arrival=null；H0.014亦實際跑到0.014；H0.02陽性對照仍抵達 | 關閉時限反例；共享幾何仍待#111 |
| R7-07違規清單依輸入順序 | #111：反轉原多個outside_lane個體，完整結果JSON相同；不再只有成對重疊排序 | 關閉 |

舊API已改變的探針按新簽名傳入同一幾何與尺寸；沒有因誤用舊參數，讓合法對照也失敗再宣稱修復無效。

### #95cohort的額外獨立核對

原105隻首次初始化幼蟲、25個世界，在9組先驗設定各自追蹤到D14。不是只重用新報告的「曾化蛹後消失」推論，而是另外逐筆讀取`eclosion.source_brood_id`及`brood_death.stage`核對：9組中所有分類都與報告相同，無未解釋失蹤。

| 先驗 | 仍是幼蟲（平均的分母） | 蛹 | 已羽化 | 幼蟲死亡 | 蛹死亡 | 合計 |
|---|---:|---:|---:|---:|---:|---:|
| 0.3 | 3 | 61 | 22 | 19 | 0 | 105 |
| 0.6 | 2 | 62 | 22 | 19 | 0 | 105 |

文件現在不再把0.949→0.658解釋成全cohort變慢，已指出條件分母不同及高先驗組多一隻化蛹。這是正確的報告修正；不將這些模型結果當作本種發育資料。

### #97與#114

新比較報告包含合法θ=0的特殊情況；原參數探針仍得到N₀(threshold)=1、N₀(linear)=0.1，理想化不餵14日再餵的子模型分別12／24.6日，文字現在正確區分這個例外與其餘端點共享的子族。60項性質檢查通過，提交JSON與重算一致。較廣的生物模型仍未辨識／未選定，nutrition_response仍null。

#114新head是併入#95／#97修復；保育訊號局部性的自身邏輯沒有在這次額外改動。22項局部性測試、60項性質測試、typecheck與saves20/20通過。上輪對其局部修復的有限判定保留。

### #115時限與#111介面

最後不足一步的區間現在縮短，judge獨立將超過horizon的arrival映射null並計數；原三組時間對照通過。相依的OccupancyResult介面已從陣列調整為`{valid,violations,not_checked}`，96項solver-compare測試（實際有Rapier）與typecheck通過。新R8-01／02屬共用幾何契約，當前直線且不修改幾何的既有場景不會直接觸發它們；不能以這96項替共用契約作一般正確性保證。

## #116排程器：可接受的設計界線與未通過的保證

新模組不被simulateWorldDay、cli或web引用，不在正式規則指紋內。它是工程基礎，不是24小時生態、日內天氣、費洛蒙衰減或生物行為的實作，亦未修好既有#9／#56。

- 固定10⁻⁶分鐘（60µs）格點、同時刻因果輪次、批次交付、由內容決定ID與不抽亂數的設計界線明確。
- 不在排程器內偷偷選同時競爭的勝者；handler仍需遵守集合語意，ID順序本身不是生物學優先權。
- 現有174項測試包含排列、跨日、快照、恰好一次、原子失敗等一般情況；本輪也全部通過。
- 然而R8-03證實原子性保證尚未完整實現，所以目前REQUEST CHANGES。
- 未來將秒制物理時刻轉入此格點、改掉既有FIFO或接入正式日循環，都仍須獨立規則／介面驗證。本輪未授權這些接入。

## 本輪實際驗證

| 固定head | 本人本輪執行結果 |
|---|---|
| #95 dc12329 | 完整敏感度重算：25世界、9組JSON相同；先驗測試51項；另以實際事件獨立核對9組cohort去向 |
| #97 e1fa9a0 | 原θ=0探針；候選性質60項（含產生報告與提交JSON相等檢查） |
| #111 1ec7e00 | occupancy2530、physics-isolation93、typecheck通過；原反例及新接縫／暖冷快取探針 |
| #112 a281059 | 文件差異與前輪非零期初例子的獨立代數核對；未新增產品測試 |
| #114 93dc2da | locality22、候選性質60、typecheck、saves20/20通過 |
| #115 b7422c4 | 原H0.014／0.016／0.02探針、solver-compare96（Rapier實際安裝）、typecheck通過 |
| #116 6633369 | scheduler174、scheduler-isolation76、rules-registry36、typecheck通過；另有R8-03及普通合法／非法回傳對照 |

本輪沒有重跑未變main的完整npm test；之前同一ffb54ff的51/51與存檔20/20屬前輪證據，沒有冒充本輪新執行結果。也沒有對每張未變PR重跑整套測試、長效能實驗或Actions artifact；未把他人的全套通過留言當成本人結果。

本輪未重新取得文獻全文。文獻原文／摘要模型／他種觀察的核讀限制沿用前輪；本次修正多為數學、幾何與工程，不能把測試通過當生物學驗證。圓角車道區域、膠囊身形、橫向位置與讓路仍是模型約定／候選，非本種直接觀察結論。

main仍未合併#93的C3a接觸順序檢查；既有營養、順序、溫度、生命史與物理限制仍依各issue追蹤。上輪特定反例關閉，不等於這些一般科學限制也關閉。

所有證據位於本次工作區 `/workspace/scratch/repo-review-round8/`。唯一上傳內容為本Markdown報告，存於獨立review分支；未修改產品程式、正式存檔、日誌或參數，未合併PR、force-push、推進Day15或開始正式新版Day0。

# Codex repository review — round 7, 2026-11-07

審查者：Codex。範圍：main、原14張未合併PR，以及審查期間新出現的#115，共15張PR；重新讀取open issue清單與新PR說明。main仍為ffb54ff，與上輪相同。Node22.23.4；程式、探針、瀏覽器與診斷全部在隔離archive副本執行。

## 結論

本輪新增 **6項P2、1項P3**，涉及幾何契約、研究報告的分母與參數定義域、守恆設計式，以及求解器的時間終點。沒有發現新的P0／P1。**#95、#97、#111、#112、#115：REQUEST CHANGES**，範圍詳見下列發現；不是宣稱正式Day14發生這些新缺陷。

#110的顯示資料與瀏覽器測試、#114的局部性修正、#108更新的解析終點測試均通過，但工程測試通過不會抵銷下列獨立反例。科學接受、模型採用與合併仍是不同決定。

## 固定版本

| 對象 | 完整SHA | 本輪處理與判定 |
|---|---|---|
| main | `ffb54ff95bb65ac623319a4e0e2d985ee58b803e` | 未變，沿用已知限制；不作整庫APPROVE |
| #93 | `fafe9b18adf247e8aa317b84d04eaec55d144cd0` | 未變，沿用餵食檢查強化的有限APPROVE |
| #95 | `fb298160377d1beabe09fe1c46b315a2c0f38fae` | 新敏感度報告；REQUEST CHANGES，R7-03 |
| #96 | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | 未變，沿用隔離見證原型APPROVE WITH COMMENTS |
| #97 | `6e5c0f8bbeb08b545019651eab75dd5f82a28d9c` | 新候選比較／性質報告；REQUEST CHANGES，R7-04；亦含#95報告 |
| #98 | `46144effd846fe9422898ddd845d730112eb655e` | 併入main及限制文件；原physics程式相對003184d未變，仍需後續修復，不作完整物理批准 |
| #105 | `6495dfab115e76925cce1ae0bb441ea2936d47d2` | 併入main及限制文件；原physics程式相對ef8308d未變，仍需#108修復 |
| #106 | `ce175913af3ede9fab424f96502d38e87c9badfd` | 未變；上輪巢內死亡追蹤P3保持關閉，沿用有限APPROVE WITH COMMENTS |
| #108 | `7c3fda02f6dfb60231be7cc29d1ae4f554ba7d6f` | 解析終點與寬度診斷更新；APPROVE WITH COMMENTS，限原一維模型的修復／診斷 |
| #109 | `66047ef633ab33181608d36fc72014022d6b9fa0` | 未變，沿用純狀態文件APPROVE WITH COMMENTS |
| #110 | `1733f13620809d4d2dd83fb395ffac538e042fcc` | 唯讀統計／速度；APPROVE WITH COMMENTS，限顯示工程範圍 |
| #111 | `ed8e6c647bbf9d586f7725eeeace00964d11ef74` | 二維幾何契約；REQUEST CHANGES，R7-01、02、07 |
| #112 | `50f25c3302832459ae4af85c9e475fd9a141a4f0` | 文獻與競爭蟻群設計；REQUEST CHANGES，R7-05；原文數字未由本人重新核讀 |
| #113 | `ba97cfbf6985cd6b37b46af81a7750d5c8b06a05` | 隔離繪圖benchmark；APPROVE WITH COMMENTS，限原型，不批准渲染器替換 |
| #114 | `d365d4a168a5499bc11c7c2f093918abd06e3ed5` | 保育訊號局部性修復自身範圍APPROVE WITH COMMENTS；依賴栈中的#95／#97報告仍需修正 |
| #115 | `01451effaa6199cff342d88adb15adb51f16a141` | 新增Native/Rapier比較；REQUEST CHANGES，R7-06；共用#111契約尚未定案 |

對照前輪：[round6](https://github.com/davidcatcat/antempire/blob/530d9d3426c1b14d99331511c0a2697d60325e1e/reports/codex-review-main-open-prs-round6-2026-11-07.md)、[round5](https://github.com/davidcatcat/antempire/blob/c52a07c792d72b00a1c772dd51cdc3a726381a98/reports/codex-review-main-open-prs-round5-2026-11-07.md)。

## R7-01 / P2 / #111：合法的第二直段身體被第一直段提前判為越界

位置：[body2d.ts:80](https://github.com/davidcatcat/antempire/blob/ed8e6c647bbf9d586f7725eeeace00964d11ef74/engine/physics/body2d.ts#L80)，`capsuleInLane()`。

函式找到第一個「縱向投影落在段內」的段，就依橫向結果直接return。身體完全在後面的合法直段時，前一段的投影也可能符合縱向條件，於是提前回傳outside，沒有檢查真正所在的段。

**獨立反例**：

- 通道中心線`[(0,0),(10,0),(5,10)]`，寬2mm。
- 身體長2.5、寬0.8mm；s=15mm、u=0、dir=1。
- 中心為`(7.7639320225,4.4721359550)`，完全位於第二直段內，不跨轉折。
- 對整條折線：`{inside:false, checked:true}`，回報相對第一段的橫向延伸5.632399mm。
- **同一個膠囊**只以第二直段檢查：`{inside:true, checked:true}`。
- `checkOccupancy2D`因此也把合法個體列為outside_lane。

**修改要求**：檢查所有適用直段後再決定；任何一段完整包含身體即應接受。保留跨轉折／端點的not_checked語意。加入鈍角折線的合法對照及真正越界反例，不能只用直線與直角轉彎。

## R7-02 / P2 / #111：膠囊完整寬度加總不是所聲明條件下的必要條件

位置：[body2d.ts:106](https://github.com/davidcatcat/antempire/blob/ed8e6c647bbf9d586f7725eeeace00964d11ef74/engine/physics/body2d.ts#L106)、`docs/physics-2d-occupancy-contract.md` §2。

契約宣稱：平行膠囊只要縱向範圍共享共同點，存在合法橫向排列 **⇔ Σw≤W**。這對縱向錯開、只有圓頭投影相交的膠囊不成立；該截面的實際寬度可以小於完整w。

**兩體反例**：直線通道`(0,0)→(20,0)`、W=1.2mm。兩身體都L=2.5、w=0.8、dir=1，位置`(s,u)=(5,-0.2),(7.4,+0.2)`。

- 縱向完整範圍`[3.75,6.25]`與`[6.15,8.65]`有共同點。
- 精確capsuleGap=`+0.00622577483mm`，不重疊；`checkOccupancy2D=[]`，兩者均在通道內。
- `lateralPacking([0.8,0.8],1.2)`卻回傳feasible=false。

**三體見證**：W=2mm，三隻同尺寸，`(s,u)=(5,-0.6),(6.2,+0.6),(7.4,-0.2)`；縱向範圍也有共同點，`checkOccupancy2D=[]`，但Σw=2.4>2，packing回false。

**修改要求**：收窄並明示前提，例如共同截面穿過每隻膠囊的軸段、或中心對齊的整寬排列；在更一般情形不能單靠widths決定必要性，需帶入縱向位置與形狀，或回報保守／未知。加入上述合法錯位排列作負向對照。

**不要混淆模型**：#108的舊一維模型是「長度區間＋完整寬度」的矩形代理，其checkWidthOccupancy在這個代理下可以報告超寬；本輪同樣重現該診斷在上述三體弧長上報2.4>2。這不能直接升級為新膠囊模型的「任何二維排列都不可能」證明。此項要求修正#111的幾何普遍性主張，不宣稱#108原矩形代理的數值加總算錯。原本三隻**中心完全重合**的P2-E反例仍然成立。

## R7-03 / P2 / #95：進度平均值隱藏了條件化與分母改變

位置：[c4a-prior-sensitivity.ts:46](https://github.com/davidcatcat/antempire/blob/fb298160377d1beabe09fe1c46b315a2c0f38fae/cli/reports/c4a-prior-sensitivity.ts#L46)，及`docs/design-c4-larval-nutrition.md:307,326`。

`mean_progress_d14_first_seen`只計算第14日**仍在brood名冊、且階段仍是larva**的首次初始化個體。已化蛹或離開brood名冊者被排除，但表格未揭露這個條件，也沒記錄progN，並把0.949→0.658列為先驗提高後的進度下降。

本輪完整重算敏感度報告，25世界、9組結果與提交JSON完全一致；再追蹤原105隻個體，得到：

| 先驗 | 初始個體 | D14仍是幼蟲（平均值的分母） | D14蛹 | D14已不在brood名冊 | 條件平均進度 |
|---|---:|---:|---:|---:|---:|
| 0.3 | 105 | **3** | 61 | 41 | 0.9490923333 |
| 0.6 | 105 | **2** | 62 | 41 | 0.6578625 |

不在brood名冊不等於全部死亡，可能包括已羽化；本輪沒有將其誤標為死亡。較高先驗組反而多一隻已化蛹，剩餘幼蟲的平均較低不能證明整個cohort發育變慢。

**修改要求**：改名為「D14仍存活且未化蛹者的條件平均」，輸出n與各階段／退出原因；另報原cohort的化蛹、羽化、死亡等可比較結果。不得把階段轉換後重設的progress直接混成全cohort平均。這是研究報告解讀缺陷，不是原始小數算錯；#97／#114已併入此報告，修正需跟進。

## R7-04 / P2 / #97：可辨識性結論漏掉允許的θ=0

位置：[c4b-form-comparison.ts:57](https://github.com/davidcatcat/antempire/blob/6e5c0f8bbeb08b545019651eab75dd5f82a28d9c/cli/reports/c4b-form-comparison.ts#L57)、`docs/design-c4b-larval-development.md:155,171`；引擎`params.ts:165`允許θ∈[0,1]。

新增報告聲明「每種形式、每個θ與K」都有N(0)=n_min，因此任何x∈{0,1}的歷史都完全等價。但合法θ=0時，threshold以`x>=θ`判斷，N(0)=1而非n_min。

**合法參數探針**：在隔離bundle打開C3a、C4a、C4b，選threshold、設定`threshold_theta.value=0`；resolveBundle接受。結果：

```text
n_min = 0.1
N(0), threshold θ=0 = 1
N(0), clamp_linear = 0.1
不餵14日再餵，報告子模型：threshold θ=0 = 12日；clamp_linear = 24.6日
```

這不是出廠配置（出廠形式仍null、開關OFF），也不證明現有論文能唯一選定某個營養函數；它只直接反駁新報告對整個允許參數域的等價主張。39項新性質測試只掃θ=0.25／0.5／0.75，漏掉端點。

**修改要求**：把結論限制在端點相同的子族，例如θ>0，並說明對θ=0的例外；若要從API拒絕θ=0，須明示那是候選域／規則改動，不能悄悄為了通過結論改測試。增加端點測試，重產報告與文字。#114繼承相同文件。

非阻擋數學說明：saturating的凹性給的是`E[N(X)]≤N(E[X])`。它與clamp_linear的比較還涉及點態函數大小，不能把「高於同平均配給的線性形式」簡單歸因於Jensen；建議將兩個推理分開寫。

## R7-05 / P2 / #112：蜜露守恆驗收式缺期初存量

位置：[design-competitor-colonies-d7.md:58](https://github.com/davidcatcat/antempire/blob/50f25c3302832459ae4af85c9e475fd9a141a4f0/docs/design-competitor-colonies-d7.md#L58)。

設計列「生產=兩群取用＋自然損失＋現存」，沒有定義從空庫存開始的累積期間。對有期初蜜露的每日／任意期間帳本不成立。

例如S₀=10、當期生產3、兩群取用合計4、自然損失1，合法期末S₁=8。原式變成3=4+1+8，即3=13，會拒絕合法歷史。

**修改要求**：定義區間與單位，寫成`S₀+生產=H₁+H₂+損失+S₁`，或`ΔS=生產−H₁−H₂−損失`；其他輸入／輸出若有也需列明。只有明示零期初、從建立起累積時，才能使用簡化式。此項是未實作設計的數學契約問題，**不表示現行引擎新增食物損失**。

## R7-06 / P2 / #115：Rapier越過horizon仍計入抵達

位置：[rapier.ts:98](https://github.com/davidcatcat/antempire/blob/01451effaa6199cff342d88adb15adb51f16a141/prototypes/solver-compare/lib/rapier.ts#L98)，`nSteps=Math.round(horizon/dt)`；judge直接複製arrival_t_s。

以loadScenario('head-on-2')的第一隻個體作單獨對照：起點s=2、自由速度18.5mm/s，目標距離=18.5×0.018mm。其餘幾何與尺寸不變，dt=0.01s。

| horizon | 最後sample時刻 | 回報抵達時刻 | 終態 |
|---:|---:|---:|---|
| **0.016** | **0.020** | **0.01799995917** | **arrived，judge也照抄** |
| 0.020（陽性對照） | 0.020 | 0.01799995917 | arrived，合法落在範圍內 |
| 0.014 | 0.010 | null | not_arrived，但最後4ms沒有真正求解，posAt只延用末值 |

第一列抵達晚於horizon；這是時間範圍錯誤，不是f32的微小位置誤差。它讓Native與Rapier在不同有效時間範圍下比較，影響抵達數、接觸與成本。

**修改要求**：明確處理最後不足一步的區間，或拒絕不整除的horizon/dt並在CLI/schema說明；不能四捨五入後仍宣稱跑到同一horizon。禁止將horizon以後的抵達／事件計入，裁判也應驗證時間範圍。補上上述正反對照。原55項測試通過，沒有涵蓋這個有效輸入邊界。

## R7-07 / P3 / #111：outside_lane清單仍依輸入順序

位置：[body2d.ts:94](https://github.com/davidcatcat/antempire/blob/ed8e6c647bbf9d586f7725eeeace00964d11ef74/engine/physics/body2d.ts#L94)。個體通道違規先依原陣列寫入out，之後只有成對重疊使用排序後的caps。

兩隻可定位、但橫向超出通道的個體A、B，輸入AB得到outside_lane A、B；反轉輸入得到B、A。合法性結論沒變，但違反「違規清單與輸入順序無關」的契約，會影響逐位元重播／結果雜湊。現有測試沒有同時覆蓋多個outside/not_checked紀錄。

**修改要求**：所有類型的違規使用同一套確定排序，新增outside_lane與not_checked混合的順序對照。

## 其餘差異審查及實測

### #108更新

`end()`已由S_EPS內直接當前送出，改成`tAt(x)`解析時刻（有號速度非零）。`physics-p2e` **398項通過**；實測最大提早3.55e-15s，在聲明的SAME_INSTANT內。保存種子3／7各8/8；仍有137個非重合被擋環紀錄。舊一維矩形代理的寬度診斷頻率重現為traffic60/60、dense45/200、種子3／7的478／396個取樣時刻。這些不是膠囊二維可行性校準。golden74項比較、registry36項通過。

#98／#105相對前輪的physics程式未變；新併入的main/C4a內容已有前輪審查。沒有把大量報告檔與base差異錯認成新的物理實作，亦未把#108的修復算到尚未包含它的#105。

### #110唯讀統計

Node統計／速度 **1,375項通過**；推得速度1,556筆（沿跡1,498、離跡58），長度未知70筆仍回unknown。typecheck/build通過。實際Chromium桌面及Pixel7觸控模擬：新統計 **13項**與繼承追蹤 **69項**通過；追蹤套件仍只在隔離測試副本對favicon作204處理，未改其他斷言。已檢視統計截圖。

圖表資料是每日紀錄，Day0流量保持null；路段速度是設定長度／紀錄時間的平均值，沒有當成實測瞬時速度。原引擎、參數、存檔、journal與web/data未被這項UI增量修改。此批准不涉及生物模型。

### #114保育訊號局部性

自身程式新增預設OFF旗標，只在巢內抽取育幼室幼蟲；巢外不產生該接觸訊號。沿用原種子流與ID排序，沒有提高機率或改食物。這仍以單一育幼室與粗粒度位置為模型前提，不是本種巢內接觸頻率實測。

`nurse-cue-local-v31`22項、C4b性質39項、發育55項、v29先驗24項、C4a326項、registry36項、typecheck、check:saves20/20、golden74比較皆通過。重新執行完整保育診斷，JSON與提交內容相同：30世界、每臂1800日，ON/OFF總數差異0。局部性修復在目前同位置情境不改結果，並非沒有作用的空測試；反事實測試有實際接觸。原報告的接觸少、攝取少等是模型診斷，不能單憑觀察性總數證明自然界的限制原因。

#114自身修復範圍可接受，但它包含#95、#97的新報告問題，整合時必須同步修正，不能用此局部批准跳過依賴栈審查。

### #112文獻

文獻整理有明列原文XML、摘要模型、圖像估讀與讀不到全文的差別，刪除混併實驗導出的個體搬運量、將均值與上限／SD分開，方向合理。本輪重新嘗試EuropePMC與eLife，均在代理CONNECT回403；沒有取得新全文，不能獨立保證所有新數字正確。尤其經摘要模型的文獻，仍須保留來源、頁碼與量的定義，不得直接轉成species參數。

「本種沒有任何直接研究」宜限定為本輪可得／已查核文獻未找到；不能把有限搜尋寫成普遍不存在。Vázquez速度、非本種讓路／流量與行為反推的費洛蒙半衰期仍需分級；日尺度留存與分鐘半衰期的差異沒有被本輪文件更正直接修成正式機制。主文REQUEST CHANGES的直接數學理由是R7-05。

### #113繪圖benchmark

獨立package-lock與原型build成功；沒有接入引擎。原命令在本機因缺少Playwright下載的瀏覽器而不能啟動；使用既有Chromium後，file URL又被管理政策阻擋。改以**同一份建置內容的本地HTTP**執行，僅調整隔離副本的啟動位置與executablePath，沒有關閉瀏覽器政策。

以0.2秒暖機、1秒記錄完成Canvas/Pixi×100/1000/10000×桌面/觸控尺寸共 **12組**，無初始化錯誤。這只是運行檢查，**不是重現原報告1秒暖機＋5秒量測的數值**，也不是實體GPU評測。原型明列SwiftShader、精靈不等於螞蟻、繪圖不等於模擬吞吐量，維持Canvas預設的暫時建議可接受。建議補齊可攜的Playwright／browser準備與HTTP執行說明；目前package未釘選測試用Playwright。

### #115比較原型

有Rapier依賴時，`solver-compare` **55項通過**，isolation93項及typecheck通過；沒有重跑1000隻或1500秒的長實驗，也未把提交中的耗時當成本輪實測。Native缺橫向自由度、Rapier每步設定目標速度且無生物讓路等差異已揭露；不能把這個驅動設定的結果推廣成Rapier本身普遍較快／較不準。共用#111模組不等於裁判已被驗證無誤；R7-01／02須先定案。此階段的直線限制使R7-01不直接出現在這四個既有場景，但不會修好共用契約。

## 測試證據與範圍限制

| head | 本輪本人執行 |
|---|---|
| #95 fb29816 | 完整敏感度重算：25世界、9組JSON相同；另以原105隻cohort追蹤重現R7-03 |
| #97 6e5c0f8 | 合法θ=0的resolver／N／歷史反例；其39項新性質測試也在包含相同變更的#114上重跑 |
| #108 7c3fda0 | p2e398、registry36、golden74比較；三體舊矩形寬度診斷對照 |
| #110 1733f13 | model1375、typecheck/build、browser統計13／追蹤69 |
| #111 ed8e6c6 | occupancy2519、p2e398、isolation93、typecheck；另有R7-01／02／07原始探針 |
| #114 d365d4a | locality22、forms39、development55、prior24、C4a326、registry36、golden74、saves20、typecheck；完整診斷重算JSON相同 |
| #115 01451ef | solver55（Rapier實際安裝）、isolation93、typecheck、horizon三組探針 |
| #113 ba97cfb | npm ci、build、經明示環境調整的12組短benchmark |
| #112 50f25c3 | 文件、會計式及文獻證據等級審查；主機連線限制確認；沒有冒稱取得原文全文 |

本輪不重跑未變main的完整npm test；其前輪51/51、saves20/20是同SHA的歷史證據。各新分支也未全數重跑完整npm test或完整Actions，沒有將他人的CI留言當成本人結果。沒有更動既有測試斷言來讓反例消失；所有探針只在隔離副本新增。

main仍未包含#93的C3a接觸順序檢查，既有實驗驗證P2未關閉；#9／#56順序、#81個體營養、#83溫度／危險率、#84生命史變異、#85競爭蟻群及#107幾何／等待限制仍按原issue追蹤。沒有把本輪6項研究／原型P2誤稱為正式Day14的新事故。

分支順序仍重要：#110在#106上、#113在#110上；#111在#108上、#115在#111上；#114在#97上，#97又包含#95報告。各別有限批准不代表合併後已測，整合時需保留修復並重測。

原始輸出與探針證據在本次工作區 `/workspace/scratch/repo-review-round7/`，本文僅上傳Markdown到獨立review分支。未修改正式存檔／日誌／生態參數，未合併PR、force-push、推進Day15或啟動正式新版Day0。

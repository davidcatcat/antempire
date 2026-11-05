# 最新 PR 複驗與程式審查（2026-11-05）

日期：2026-11-05（Asia/Taipei）。審查者：Codex；未使用子代理。

**結論：REQUEST CHANGES。新增一項 P2：獨立食源讀取器的新入口缺少執行期驗證。前輪四項 P2 的修正已確認，不能繼續把那些舊反例描述為尚未修好。**

## 1. 本輪範圍

本輪重新 fetch 遠端；原 checkout 仍是 d701a23822f6018f527bcfcbcac57bd313e752c1，git status 無變更。

| PR | 本輪 head | 相對前輪 |
|---|---|---|
| #60 | 677072b1e8d4784b6aee43d71c67afbab749f78f | 新增轉移時間及共享食源重播 |
| #62 | 0aa3fa3172e93c9fea87049eaaf9139564bc86b6 | C3 修訂 3，補過渡契約 |
| #63 | 4d8134bfb1d0cf4943a4965cecc06c9b31b95aaa | 更新堆疊，含新 C2 檢查 |
| #64 | 44bd170e71a572371e03021aa2dbdc2fd21fc9f2 | 更新觀察統計與候選模型判讀 |
| #67 | 490b2986d94789e34f7fa00a22a38db7147b6be9 | 修數學契約、全因存活及新增測試 |
| #73 | 2a5e50ca0ea80ee83264cce8ee5a72a3758d45ad | 沒有新提交，沿用先前物理審查 |
| #74 | f6722a1d5ae56a5f517ca74710e5c0bd3a8e67d5 | 沒有新提交，沿用先前物理審查 |

用 git archive 在 /tmp 建立獨立副本。使用 Node 22.23.4，不修改應用程式、參數、正式存檔或日誌，不合併任何 PR，不推進遊戲。這次主要是更新差異的審查，不是宣稱對所有既有模組完成全新科學驗證。

## 2. N1 — P2：新增的 replayEngineSourcesDay 繞過了同檔案既有的格式驗證

位置：#60／#63 cli/lib/engine-transfers.ts:275–283。

replayEngineColonyDay 會先驗證事件列表與各筆 food_transfer；引擎 checkSources 也會呼叫 assertTransferShape。新增的 exported replayEngineSourcesDay 卻直接篩選事件、讀 source.kind／recipient.kind、把金額轉成微份；沒有呼叫獨立讀取器自己已存在的 recordSchemaErrors，也沒有拒絕未知食源。

**實際反例：**

設定 endSources={F01:{sugar:10,protein:0}}，單群 C1、timing:'timed'。一筆正常格式的 collect 記錄為：

- schema='antempire.food-transfer.v1'，transfer_id='FT-1-C1-1'，day=1；
- colony='C1'，minute=1，phase='foraging'，cause='collect'，attribution='individual'；
- source={kind:'source',id:'F01'}，recipient={kind:'in_transit',id:'W1'}；
- food_type='sugar'，portions=1。

各自只施加下列一種變化：

| 輸入變化 | replayEngineSourcesDay 實際結果 |
|---|---|
| events=null | []（當成沒有事件而通過） |
| portions=-1 | []（負數轉移通過） |
| source.id='DOES_NOT_EXIST' | []（不在 endSources 的食源通過） |
| 刪除 recipient | TypeError: Cannot read properties of undefined (reading 'kind') |

負數之所以通過，是因為重建期初與再重播彼此抵銷；未知食源則被 Map 的預設零值悄悄建立，再被消耗回零。輸入金額或食源 ID 非法時，不能把自洽的反推當成合法來源證據。

**影響範圍須分清楚：** 這是新 exported helper 單獨使用時的漏檢／崩潰，並非日常引擎輸出已損壞。目前測試的 E／M 呼叫位置先做 colony reader，因此那些組合路徑有前置保護。問題是這個函式對外回傳 [] 代表沒有發現錯誤，卻沒有明定「只接受已驗證記錄」的前置契約；直接使用它做獨立食源時間檢查會產生錯誤結論。

**建議：**

1. 在篩選及讀取欄位之前，驗證 events 是陣列、元素是合法事件物件，並對 food_transfer 使用本讀取器自己的 recordSchemaErrors。
2. 檢查觸及 source 的來源／收件人 ID 必須在權威 endSources 中；此重播的前提已規定覓食後食源不再改變，因此未知 ID 不能當作期初未知存量。
3. 對不合法輸入回傳包含 colony、record、field 的錯誤，不能 TypeError，也不能默認空列表。
4. 或將 helper 私有化、只由強制完成前置驗證的包裝函式呼叫，清楚表達 API 契約；不要讓裸 records 與已驗證 records 混用。
5. 加入上述四個直接呼叫的負面測試，並確認原有真實引擎日與 legacy 時間狀態的測試仍通過。

## 3. 前輪發現的複驗結果

| 前輪事項 | 本輪判定 | 證據 |
|---|---|---|
| 採集 1000 分、卸貨 0 分仍被接受 | **已修** | 同一 A1／種子 1／秋／第 5 日探針：引擎以 FOOD_TRANSFER 拒絕；讀取器 ok:false，列出工蟻時間倒退及食物未到 |
| 已正規化的度日速率累積至 K | **已修** | #67 明確區分積溫 H≥K 與進度 p≥1；測試 10 日範例、分段溫度與不同 dt |
| 把不顯著與有限搜尋作為費洛蒙模型反證 | **設計已修正** | #64 改用完整選擇曲線、首次不顯著端點的預測分布、λ=0 基準及有限範圍的結論 |
| 把實驗室全因 KM 視為純內在老化 | **說明已修** | #67 改稱條件下全因存活，死因未辨識；額外 hazard 僅能代表相對基準增量並處理重疊 |
| C3a 的過渡帳、來源鏈、總嗉囊容量、未知儲備、自行取食 | **設計已補足本輪要求** | #62 §12 分別定義 legacy stores 範圍、合法來源、共同容量、known_balance 與 unknown_initial_reserve、社會接觸和攝食的區別 |

這些是對工程修正與設計內容的肯定，不是核准新正式 Day0，也不是確認生物學參數已校準。C3a 仍保留舊產卵與舊存活規則，報告已揭露，不能把 C3a 的結果當作個體營養正確性的科學結論。

## 4. P3 意見：單位測試仍有錯誤文字與不足的檢驗

位置：#67 tests/math-contracts.test.ts:114。

Q10 測試把 Rref_per_day 乘 24，並以「per day → per hour·24」描述單位轉換。若 Rref=0.4/day，真正對應的數值是 0.4/24 per hour，不是 0.4×24。

目前斷言測的是 q10 對 Rref 的線性齊次性，無論換成哪個尺度都會通過，因此它不能證明使用了正確的日→小時轉換。建議以明確的 per_hour=per_day/24 比較：q10(per_hour,...)×24=q10(per_day,...)，並驗證數值 0.4/24。這不影響已修好的 Q10 文件公式，也不代表正式引擎有新增單位錯誤。

## 5. 既有問題與科學審查邊界

- #73／#74 的 SHA 沒變。先前重現的下坡跨層漏碰撞（P1）、短窄縮漏掃描（P2）、零距離目標仍移動（P2）仍適用；本輪不重跑未修改的物理套件，也不把它們列為新發現。原報告：https://github.com/davidcatcat/antempire/blob/f61db12f5ebce7fec9f77a59c9fc0c873cfde08f/reports/codex-review-physics-pr71-74-2026-11-04.md 。
- 共享食源的**跨蟻群時間**仍依整群順序，而非共同世界時鐘；新報告已明確列為 #9 的已知限制。本輪沒有把這項改寫成已解決。
- source reader 由期末反推期初，信任權威期末狀態；這個已揭露的信任前提與 N1 的格式缺口不同，不能混為同一問題。
- #64 的新「與觀察相容」用語、λ=0 對照及保留資料設計比前版嚴謹。但未執行 P-1～P-6，就不能宣稱已比較／驗證 M1、M2。
- 本輪閱讀儲存庫最新引用與設計差異，未新取得 Dussutour、Saund、Yuan、Sanders、Chang 原始全文或原始數據；不把其他審查者聲稱的全文核對計入本輪實證。分子數目、蛋白路線與未知碰撞寬度仍維持各自的證據限制。
- 本輪沒有發現新的生態參數修改。F01／A08、#56、#9、世界端物質去向及本種發育校準等已知問題仍需後續工作包。

## 6. 本輪測試與影響

| 檢查 | 本輪結果 |
|---|---|
| #63 4d8134b：typecheck | 通過 |
| #63 4d8134b：npm test | 39/39 腳本 PASS，退出碼 0；包括 C2、golden、rules-isolation、R3-05 |
| #63 4d8134b：check:saves | 20 pass、0 warnings、0 errors |
| #67 490b298：typecheck | 通過 |
| #67 490b298：math-contracts | 445 checks 通過（參考契約，非本種驗證） |
| 舊採集／卸貨時間反例 | 引擎與讀取器都拒絕，確認已修 |
| 新獨立食源讀取器反例 | 空事件列表／負金額／未知食源錯誤通過；缺收件人時 TypeError |
| 原 checkout | git status 無變更 |

本輪沒有對 #67 重跑所有原本未修改的模擬測試，也未重跑沒有新提交的 #73／#74 物理套件或完整文獻實驗。遠端 CI 狀態未獨立查核；表中是本機實際結果。所有探針與原始日誌留本機 /workspace/scratch/review-latest-1105；只上傳此報告。沒有修改 PR 程式或正式遊戲狀態。

# #60／#63／#67 修正複驗：食源輸入與 Q10（2026-11-05）

日期：2026-11-05（Asia/Taipei）。審查者：Codex，未使用子代理。

**結論：REQUEST CHANGES。原先四個食源輸入反例與 Q10 換算方向已修；仍有一項 P2 數值精確性問題，以及兩項 P3 健全性問題。** 這些限於新讀取器的輸入／運算邊界，不表示正式存檔或正常引擎輸出已損壞。

## 1. 固定版本與範圍

| PR | 本次完整 SHA |
|---|---|
| #60 | 1db0da6f5c74e32c2593645104b8cdc59dde25d1 |
| #63 | 97a2bd9aa5de9a4c944882ade1f44d05895afbd4 |
| #67 | 4a5f84f7523fc9b699fb63320f10474ade070f44 |

本次重新 fetch，讀取原 PR 上的修正與回歸測試；用 git archive 建立獨立檔案副本，Node 22.23.4，鎖定安裝。#60 與 #63 的 cli/lib/engine-transfers.ts 相同；相對前次 #60，engine、species、world、rules 沒有改動。

原 checkout 無變更。沒有修改 PR 程式、參數、正式存檔或日誌，沒有推進遊戲或合併任何 PR，也沒有 force push。

## 2. 前輪修正確認

- 原四個反例已重跑：events=null、負數 portions、不存在的食源、缺 recipient，現在均回傳錯誤，缺 recipient 不再直接 TypeError。
- 檢查程式確實加入 endSources、colony list、timing、事件列表與 source 路徑的驗證，不是只改報告。
- #67 將 0.4/day 改為 0.4/24 per hour；新測試比較 perHour×24 與 perDay，且驗證舊乘法不是每小時速率，方向正確。math-contracts 實跑 **448 checks 通過**。
- 「單獨食源讀取器不檢查 transfer_id/day/attribution 的完整語意與獵殺對應，完整檢查需合併 colony reader」已列為限制。本輪不把這些明定的分工當成新的缺陷。

## 3. N1 — P2：精確微份檢查驗證的是四捨五入後的數字，且沒有檢查累加結果

位置：#60／#63 cli/lib/engine-transfers.ts:45、70、291–310、342。

### 3.1 小於 1 µp 或有小數微份的金額仍可通過

exactMicro(v) 使用 toMicro(v)，而 toMicro 是 Math.round(v×10⁶)。因此檢查「整數且 ≥1」實際上驗證的是**捨入後**的數字，並沒有確認輸入本來就是合法微份。recordSchemaErrors 也只檢查捨入後是否為 safe integer，沒有執行 colony replay 中已有的六位小數檢查。

固定 endSources={F01:{sugar:10,protein:0}}，一筆正常 collect：schema='antempire.food-transfer.v1'、transfer_id='FT-1-C1-1'、day=1、colony='C1'、minute=1、phase='foraging'、cause='collect'、attribution='individual'，source=source:F01、recipient=in_transit:W1。

僅改 portions，單獨呼叫 replayEngineSourcesDay：

| portions（份） | 實際微份 | 實際結果 |
|---|---|---|
| 0.0000006 | 0.6 µp，未滿一微份 | []，接受並捨入成 1 µp |
| 0.0000014 | 1.4 µp，不是整數微份 | []，接受並捨入成 1 µp |
| 0.0000010005 | 1.0005 µp | []；屬浮點容差政策範圍，需與其他讀取器一致定義，不單獨視為缺陷 |

前兩筆違反「至少一微份、六位小數」的既有轉移契約；這是一般 JSON 數值，不需要 getter 或異常物件。原測試只選 1e-9（捨入為 0），未涵蓋捨入邊界上方的 0.6 µp。

**建議：** 在重播前同時驗證原始值至少為 1e-6、原值與合法整數微份的差在明定浮點容差內、結果為 safe integer；與 colony reader 的六位小數政策保持一致。不要只用 Math.round 後的結果判斷原始數值是否合法。加上 0.49／0.5／0.6／0.99／1／1.4 µp 的邊界測試及合法值的正向測試。

### 3.2 單筆安全不保證反推與重播的中間總量安全

同一函式只驗證每個輸入的微份數是 safe integer；held 的每次加減沒有檢查。

**實際反例：**

- 設 M=2^52=4503599627370496 µp。
- endSources.F01.sugar=M/10^6 份。
- 兩筆合法 collect，同群、同食源：第一筆 M/10^6 份、minute=1；第二筆 1e-6 份、minute=2；不同 transfer_id。
- 所有單筆轉換都是安全整數，均通過新輸入檢查。
- 真正期初應是 2M+1=9007199254740993 µp；Number 加法卻變成 9007199254740992。
- 重播後剩 M−1=4503599627370495 µp，而給定期末是 M。
- replayEngineSourcesDay 仍回傳 []，沒有檢查不安全的中間量，也沒有發現期末差一微份。

這是大數值 API 邊界案例，不是一般生態情境下已發生的食物損失；但本次新增的安全運算保證尚未成立。

**建議：** 對每次加減與反推期初使用 checked arithmetic，超出安全整數就回報錯誤，或用 BigInt 保存已驗證的整數微份；最後再核對重播結果與給定期末。不能只檢查單筆輸入。

## 4. N2 — P3：驗證完重新讀取原物件，後續 getter 例外仍會逸出

位置：cli/lib/engine-transfers.ts:286–289。

try/catch 只包住 sourceDayInputErrors；正式重播仍讀原始物件。使用以下 colony 物件，其他資料合法：

    let reads = 0;
    const c = {
      id: 'C1', timing: 'timed',
      get events() {
        if (++reads > 5) throw Error('late getter');
        return [validCollect];
      }
    };

前五次讀取完成輸入檢查；第六次在 colonies.map 讀 events 時丟錯，實際結果為 **Error: late getter 直接逸出**。

這是具 getter 的 JavaScript API 邊界，普通 JSON 沒有此問題，不應與一般引擎失敗混為一談。不過目前報告明寫 getter 失敗會回報、不丟例外，因此承諾超過程式實際保護範圍。

**建議：** 驗證時讀取並正規化成普通資料快照，後續只操作該快照；或明確限定只接受普通 JSON 資料並拒絕 accessor。若選擇支援任意物件，整個讀取／重播邊界都必須安全處理例外。另注意 catch 內 show(String(e)) 在 show 之前就轉字串，遇到無法轉字串的 thrown value 仍可能再丟錯。

## 5. N3 — P3：錯誤值有截斷，但 ID／錯誤整行仍無長度限制

位置：cli/lib/engine-transfers.ts:54–56、341、347–349。

show(v) 會截斷值；但 transfer_id、source id、colony id 仍直接插入錯誤字串。合法格式的 transfer_id='X'.repeat(100000)，再設 portions=-1，實際回傳一條 **100054 字元**的錯誤。並未實現報告中的「錯誤訊息長度有上限」。

這是輸出健全性問題，不是一般引擎行為問題。建議統一截斷錯誤的 ID／label，並在回傳前限制每條完整訊息長度及總字數；目前最多 50 筆的限制不能限制單筆長度。

## 6. 測試與未改動範圍

| 檢查 | 本輪實際結果 |
|---|---|
| #63 97a2bd9：typecheck | 通過 |
| #63 97a2bd9：npm test | 39/39 腳本 PASS，退出碼 0；含 C2、golden、rules-isolation |
| #63 97a2bd9：check:saves | 20 pass、0 warnings、0 errors |
| #67 4a5f84f：typecheck | 通過 |
| #67 4a5f84f：math-contracts | 448 checks 通過 |
| 原四個食源反例 | 均回報錯誤，不再接受／崩潰 |
| 新增微份／累加／getter／訊息長度探針 | 重現第 3～5 節結果 |
| 原工作區 | git status 無變更 |

本輪在 #63 的合併樹執行完整回歸；沒有另外重跑 #60 的完整 38 個腳本，亦未獨立查核遠端 CI。#60／#63 的讀取器檔案完全相同。原始探針與輸出留本機 /workspace/scratch/review-source-r3，只上傳報告。

本輪不重新打開已修好的 Q10 意見，也不把本次修正描述為新的科學驗證。跨蟻群時間 #9 及未更新的 #73／#74 物理問題仍為既有事項；本輪沒有對未修改模組重做審查。未重新取得本種原始文獻或原始數據。

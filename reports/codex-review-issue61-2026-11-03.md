# #59／#60／#62／#63 獨立程式與科學審查

日期：2026-11-03（Asia/Taipei）。審查者：Codex；本次未使用子代理。此為實際程式閱讀與本機重跑結果，不沿用前次審查者的 APPROVE 結論。

## 結論

**REQUEST CHANGES：#60 的獨立讀取器仍有可重現的階段驗證缺口；#62 的蛋白搬運設計需補完整。#63 的逐路段沉積修正可獨立肯定，但沉積決策仍未完成 Owner 原需求。**

這不是發現正式存檔已損壞，也不是否定全部測試。引擎自己的階段檢查可拒絕新反例；缺口在用來獨立驗證的 CLI 讀取器。不得再宣稱「唯一剩餘事項只有沉積決策」。

## 審查範圍與固定版本

| PR | 審查 SHA | 範圍 |
|---|---|---|
| #59 | b39ac2248f0b22d50188f64fecaf12c989bc63f7 | ODD、研究矩陣、需求與文件一致性；未逐篇重新取得全文 |
| #60 | 1bdba72a9e0077caa31cfd818c15ebfb846bd6c6 | C2 引擎轉移、獨立讀取器、負面測試、#56 探針 |
| #62 | 5f8c6bcf27f304835e128481ca880305580e50df | C3 設計；不是可執行實作 |
| #63 | c5259067f6be39110cb8329f82ea1137bbc615d7 | 相對 #60 的逐段留跡、事件順序、參數開關與測試 |

原 checkout 保持不變。用 git archive 在 /tmp 建立兩份獨立檔案副本，Node 22.23.4，npm ci 使用既有鎖檔及快取。沒有推進正式遊戲、啟動新版正式 Day0、合併 PR 或更改模擬參數。

## F1 — P2：獨立讀取器接受未定義 phase，繞過嚴格階段驗證

位置：#60／#63 的 cli/lib/engine-transfers.ts:95、106–111；exists 在同檔案以 curPhase === 'foraging' 決定使用起始名冊或起訖聯集。

程式只特殊處理 foraging 與 nest_settlement，沒有先驗證 phase 枚舉。collect、unload、trophallaxis 若填入 invalid_phase，會落入非 settlement 分支，卻不產生錯誤；exists 同時把它當作可使用期末名冊的情況。TypeScript 型別不能驗證來自 JSON 或 any 的執行期紀錄。

重現（phase-probe.ts 與輸出保留於本機 /workspace/scratch/review-61/，本次僅上傳報告）：

1. buildDay0('A1', 1, '2027-09-23')，逐日跑到第 5 日。
2. 僅把當日四筆 foraging food_transfer 的 phase 改成 invalid_phase，不改金額、來源、收件人或期末狀態。
3. replayEngineColonyDay 回傳 ok: true、errors: []。
4. checkColonyFood 拒絕：collect is recorded in phase invalid_phase, it belongs to foraging。

影響：獨立驗證器會把結構不合法的事件認證為通過；時間名冊選擇也不是嚴格封閉的。這是驗證能力缺口，未證明一般引擎執行會產生這種事件。

建議：先驗證 phase 僅為兩個合法值，並以獨立 cause→phase 表檢查一致性；不要讓未知 phase 取得期末名冊。增加 unknown／缺失／null phase 的負面回歸測試，確認兩個驗證器都拒絕，同時保留既有 4,960 項檢查。

## F2 — P2（設計）：C3 描述有工蟻搬運，但蛋白帳缺少工蟻持有區室

位置：#62 docs/design-c3-queen-feeding.md:42–45；T3／T4 驗收。

文字規定工蟻先從倉庫取蛋白並帶至蟻后處；唯一蛋白轉移卻是 cache:<巢> → queen_body:<蟻后>。queen_contact 只能證明接觸被記錄，不能證明該工蟻之前取到了蛋白。現有規格允許沒有搬運紀錄、當下未持有食物的工蟻，藉一次接觸觸發跨區室扣帳。

這是尚未實作的規格缺口，不是已發生的程式 bug。D 類假設可表示未知的生理路徑，但不能代替局部持有與因果鏈。

建議：明定 cache → 工蟻 protein cargo／in_transit → queen_body，各轉移引用同一工蟻與事件，加入取用位置、接觸順序及未完成搬運的期末處置。若選擇原子化取用與餵食，須明確規定倉庫與蟻后在同一可接觸位置，並限制同一事件可取用的實際存量。負面測試至少覆蓋未取用、取用不足、重複餵食、錯誤工蟻、錯誤地點。

## 已確認的改善與未完成事項

- #60 的合法來源／收件人名冊、相同工蟻卸貨、獵殺一次入帳、來源地與蛋白量檢查，確實存在；不是只改測試文字。
- #63 在 goHome 為帶食物回程安排逐段 trail 事件；step 以該段結束分鐘排程；home 在 v23 不再改寫遠處路段。同時刻 trail 優先於下一段 step，符合目前離散事件約定。
- v23 開關依賴 v20 的參數檢查存在。仍是「走完路段才整段生效」的離散近似，不代表沿路連續分泌。
- cargo 存在即留下固定沉積量；部分裝填也留完整量。這是已揭露、但未完成的沉積決策需求。Owner 接受延後之前，不應把 R3-05 的全部需求標為完成。
- #59 的 ODD 實際至少有三處相關敘述：行 11 的狀態表、行 243 的缺陷說明、行 764 的留跡條目。合併後跟進不能只機械改「兩處」；須搜尋全部 R3-05 及成功回巢留跡文字，區分已修時間與未決決策。
- #56 探針成功退出但明確輸出 defect PRESENT；它證明缺陷仍可被重現，不能列作「順序獨立性已通過」。

## 螞蟻生物學與自然科學判定

本次科學審查是「引用範圍、模型推論及程式對應」審查。未重新取得並核讀 Dussutour、Dejean、Mailleux、Chang、Yuan 原始全文；不能稱為新的文獻複核，也不能替摘要補上未知條件與樣本數。

1. 本種大型獵物招募者回程留跡的引用，不能自動推廣為所有食物類型、所有裝填量、所有工蟻均以固定強度留跡。一般帶食物回程目前僅引用 Dussutour 2009 摘要；固定 0.35、上限與衰退仍屬模型假設。Mailleux 的 Lasius niger 裝填機制只能列為非本種候選，不能當成本種已校準規則。
2. 地方訊號的事件先後修正是因果一致性改善；它本身不驗證生物學決策。需要把「是否分泌、分泌多少」與「分泌何時作用」分開驗證。建議保留兩種候選並做預先定義的敏感度比較，交 Owner 決定規則範圍，不挑存活較好的一種。
3. queen.ts 的 oviposition 仍讀 ratios、stores、全巢 broodCount；workerSurvival 仍讀全巢 sugar_gap_days，queenSurvival 仍讀全巢缺口。故 Day15–134 的人口／存量變化混有 F01／A08 等既知結構影響，不能據此推導留跡的生物學效益。
4. C2 提供逐區室工程閉合；dead worker crop → nest_unlocated 是明寫的 engine_rule，並非已證實的屍體營養回收。代謝／產卵消費者仍未知，不能把 unknown 帳解讀成已驗證的個體攝食。
5. C3 的接觸機率、初始儲備及蛋白路徑仍是候選假設。建議接觸參數用寬範圍與零接觸邊界做敏感度；限制只有 nurse 可餵蟻后也應列為待驗證假設。Day14 以 null 起算後如何避免 null 被轉成 0 或憑空補值，需在遷移規格中明定。這些是建議，並未代替 Owner 作決定。
6. Day0 v22／v23 evaluation.json 的遞迴比較只有四個頂層版本／指紋路徑不同：engine_version、rules_tag、rules_fingerprint.engine、rules_fingerprint.params。這支持「已提交評估資料的診斷結果相同」，不等於本次重新跑完 400 次年度模擬；也不等於自然科學驗證。

## 驗證結果

| 對象 | 本次實際執行 | 結果 |
|---|---|---|
| #63 c525906 | npm run typecheck | 無型別錯誤 |
| #63 c525906 | npm test | 39/39 個測試腳本 PASS，無 FAIL；含 golden、rules-isolation、C2、R3-05 |
| #63 c525906 | npm run check:saves | 20 pass、0 warnings、0 errors |
| #60 1bdba72 | tests/c2-engine-transfers.test.ts | 4,960 checks；2,366 colony-days、24,056 transfers |
| #60 1bdba72 | tests/issue56-worker-order.test.ts | 9 項探針；輸出 defect PRESENT，不是缺陷已修 |
| #60 1bdba72 | npm run check:saves | 20 pass、0 warnings、0 errors |
| 新負面探針 | phase-probe.ts | 獨立讀取器錯誤接受；引擎正確拒絕 |
| 已提交 Day0 評估 | v22/v23 evaluation.json 遞迴比較 | 僅四個版本／指紋路徑不同 |

原始日誌保留於本機 /workspace/scratch/review-61/，未上傳。本次未單獨重跑 #60 全套 38 個腳本或 #59 全套 36 個腳本，未跑瀏覽器視覺測試，未重新產生 400 次年度評估。測試數量代表 runner 執行的腳本數，不是斷言總數。CI 狀態因 GitHub API Forbidden 未獨立確認；不沿用「四個 PR CI 綠燈」當作本次查核結果。

## 建議處理順序

1. 修 F1 並重跑負面測試；更新本報告結論所依據的 SHA，勿把本報告套到後續版本。
2. Owner 決定是否接受 #63 沉積決策延後；若接受，明確保留未完需求與後續規則更新。
3. #60 合併後才調整 #63 base；本次不合併任何 PR。
4. #62 先補 F2 與 null 遷移規格，再做 C3 實作；#56 仍為前置驗收。
5. #59／#63 合併後同步 ODD 全部相關條目。#53／#55 的 SD 措辭更正尚未由本次代發，應另留更正紀錄。

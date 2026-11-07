# Codex repository review — round 4, 2026-11-07

審查者：Codex。範圍：GitHub 當前 main、9 張未合併 PR 的狀態與差異、相關 issues；重點是上輪三項 P2 的獨立複驗，以及新增 #104／#105。審查、測試與瀏覽器操作在隔離副本執行。Node 22.23.4。本文的 APPROVE 僅適用所列 SHA 和範圍，不授權合併、正式接入或開始新版正式 Day0。

## 1. 結論與固定版本

**本輪差異審查未找到新增 P0／P1／P2；上輪三項 P2 在新 SHA 上均可關閉。** main 沒有改變；既有生態、個體營養與物理限制不能因此視為已解決。本輪沒有重跑完整 npm test；下表列的是實際執行的針對性驗證。上一輪 #97 舊 head 的 53/53 不冒充本輪新 head 的結果。

| 對象 | 固定 SHA | 結論及適用範圍 |
|---|---|---|
| main | `6f37e1f64e44de961f7b3f0e86730094b9bf01d3` | 與上一輪相同；沿用既有審查與未解限制，沒有新的全庫科學認證 |
| #90 | `3487717b0f2ac9042adc6bbc7ae0d4e6537fcd27` | 未變；沿用 C4a 有限 APPROVE WITH COMMENTS |
| #93 | `e33972b892d016bbf70dce0d323d61e2450da7bf` | **APPROVE**，限既有餵食規則的檢查強化；上輪接觸交錯 P2 關閉 |
| #94 | `3df70e7c2fc2242187bc4ae2fb31369b7b483a4d` | **APPROVE WITH COMMENTS**，限研究設計；機率／危險率 P2 關閉，統計表述意見仍在 |
| #95 | `17da1f1f4538425e18bdb82448f85abc9b0e838d` | 未變；沿用首次求食先驗的有限 APPROVE，先驗仍是模型假設 |
| #96 | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | **APPROVE WITH COMMENTS**，限隔離的碰撞見證與回放原型；本輪新增實際瀏覽器驗證 |
| #97 | `d430471b7a24b92fff05c68435c400ec2af8098f` | **APPROVE WITH COMMENTS**，限 C4b 工程契約；階段／進度 P2 關閉，營養形式仍待選 |
| #98 | `003184d785c7279174de8152e12941ea255b36f5` | 未變；沿用四項事件修復的有限 APPROVE WITH COMMENTS；PH-P2D 在此 SHA 仍未修 |
| #104 | `6dfa0bb235caf7d68c4df03ba27ef8ad2ead0c02` | **APPROVE WITH COMMENTS**，純規劃；隔離與依賴界線合理，更新過時審查狀態即可 |
| #105 | `ef8308d5a663ad2a9835c4c2ca023ad3652c85fb` | **APPROVE WITH COMMENTS**，限 PH-P2D 排程修復；入口佇列退化及生物假設仍不通過正式接入門檻 |

上一輪報告：[round 3 固定版本](https://github.com/davidcatcat/antempire/blob/fb550110b35b08dd051c078a7f8ac66aa5fd5953/reports/codex-review-main-open-prs-2026-11-07.md)。

## 2. 上輪 P2 複驗

### R3-01 / #93：交錯接觸與餵食紀錄

檢查 `engine/queen-feeding.ts::checkFeedingRule` 與獨立的 `cli/lib/queen-round-replay.ts`。兩邊現在都要求餵食／拒絕屬於最近一次接觸，不能跨過下一次接觸後才結算上一個接觸的結果。這符合目前產生器立即處理接觸結果的契約，不要求前置宣告的移動區間全部按結束時間排序。

重跑上一輪原始探針，而非只相信新回歸測試：第一次接觸 ordinal 1.050260，第二次 1.148645；把第一次的餵食放到第二次接觸之後，將原本拒絕改成餵食並同步修改嗉囊、蟻后與巢帳，多餵 0.28 份糖。

- 合法對照：引擎與兩個讀取器接受。
- 偽造：`checkQueenRound` 拒絕「feed_queen ... is recorded after a later contact」；`replayQueenRound` 獨立拒絕同一順序違反。
- C2 帳本仍接受這個已平衡的偽造，這是預期結果：帳本閉合不負責證明飽足規則，完整驗證必須組合規則檢查。
- 新的 `c3a-feed-rule` 50 項通過，包含 C3a-only 與 C3a+C4a。

**關閉此 P2。** 每口量、飽足門檻、B1 液態蛋白路線仍屬候選規則，本修正沒有驗證其生物學真實性。

### R3-02 / #97：化蛹門檻與無照護日

檢查 `engine/larva-development.ts` 及獨立的 `cli/lib/larva-development-replay.ts`。現在計算後進度小於 1 不得化蛹；達到 1 必須有相符的化蛹終點／事件或死亡處理。無工蟻照護日不僅禁止發育紀錄，也要求存活幼蟲的階段、進度不變。

原始探針重跑：

| 情境 | 合法對照 | 新 head 上偽造結果 |
|---|---|---|
| E006 計算進度 0.546473，改為 pupa、餘數 0，補化蛹事件並同步人口摘要 | 全部組合檢查接受 | 引擎發育檢查與獨立發育讀取器均拒絕 `pupated at progress 0.546473 < 1` |
| 無工蟻日、沒有發育紀錄，只改 E006 進度 0.5 → 0.6 | 全部組合檢查接受 | 引擎與讀取器均拒絕 `no care/no worker ... progress changed` |

其他營養／人口帳本仍可能接受這兩種平衡偽造，不能省略發育讀取器。新增及既有 C4b 測試合計 55 項通過。測試的 clamp_linear、threshold、saturating 使用明示的測試參數；出廠 nutrition_response 仍是 null，沒有替 Owner 選定模型。

**關閉此 P2。** 全巢工蟻存在即代表照護的規則仍非個體接觸模型；保育工蟻訊號跨位置、上游蛋白供應、沒有個體生命史變異等已揭露限制未被本修正解決。

### R3-03 / #94：每日機率轉連續危險率

`docs/research-design-c4c-and-multinest.md` §A.4 現在明確將舊式數值當每日機率 p，以 `λ = -ln(1-p) / 1 day` 轉換，並要求 cap < 1。這修正了先前直接以 p 作 λ、卻宣稱只改局部輸入的矛盾。

獨立數值核對：p = 0.05、0.5、0.75 對應 λ = 0.0512932944、0.6931471806、1.3862943611 /day；代回 `-expm1(-λ × 1 day)` 恢復原 p。相同常數危險率分兩個半日，存活機率相乘亦恢復每日結果（浮點誤差內）。這只在每日 p 所對應的危險率假設下成立；變動生理輸入仍要積分、交代日內更新時刻。

**關閉此 P2。** 這是數學換算，沒有建立本種飢餓死亡劑量反應。

## 3. #105：新物理排程修復

相對 #98 的實際程式差異集中於 `engine/physics/collision.ts`：

1. pressOn 退出狹道的加速判斷改查接觸點前方的單列區段，避免在已排程邊界上因閉區間容差仍判「不能放行」。
2. 時鐘只停在事件時刻；沒有事件的 broadphase 時間窗結尾只延長搜尋範圍，不移動個體、不執行依容差判斷「現在」的事件。
3. broadphase 更新用前一時間窗結尾的解析位置及速度上界建立保守搜尋圓盤；運動記錄仍以各自起點與速度計算位置，不逐步累加。

實際重跑：

- 原 `physics-p2d`：122 項通過，含種子 7／34／38、對齊事件的時間窗、輸入反轉與保存的失敗場景。
- 在隔離副本把相同走廊產生器從 40 個種子擴至 200 個，將斷言改成 n=200、比較數至少 3,000；442 項全部通過。比較事件、final、intervals 的完整 JSON；不比較本來就可變的搜尋統計。**這是擴大既有產生器，不宣稱為另一套獨立場景模型。**
- `physics-event-fixes` 426、`ph2-collision` 685、`physics-isolation` 86、`rules-registry` 36 全通過；typecheck 通過。
- 1,000 隻 × 3 s 格狀場景本機約 6.3 s、6,000 步、5,414,300 成對評估；這是單次工程測量，沒有證明萬隻能力或野外精度。
- golden 74 項比較全通過。

### 仍存在的限制，不能以本次批准關閉

保存的種子 3、7 各為 **4 arrived / 4 unresolved（A0、A2、A4、A6）**。驗證器沒有查到其所定義的排斥違反，因為寬處允許並排，而此一維模型不儲存橫向位置；停在相同弧長不等於已證明真實身體穿透。反過來，「誰在前面」受捨入符號影響的協調佇列也不能解釋成螞蟻自然形成的幾何死結。這是文件已揭露的求解器限制，需另案處理，不能改種子或調參恢復漂亮的 96/96。

5 ms 取樣與記錄邊界的排斥檢查、這批時間窗比較，皆不能證明所有連續時間與任意幾何下沒有碰撞或穿隧。以對方當下速度計算放行、預先求退讓目標、入口協調、相切不算接觸等假設仍要保留其來源等級；不能因本次排程通過便接入交哺或正式日循環。

## 4. #96 瀏覽器原型與 #104 規劃

#96 SHA 沒變；上一輪已驗證 verify/build。本輪使用其 `scripts/browser-smoke.mjs`，只在隔離副本加 `executablePath: /usr/bin/chromium`，搭配 Playwright 1.63.0 執行現有 Chromium：

```json
{"browser_smoke":[{"name":"desktop","canvas":true,"scenario":"inside","time_s":5,"errors":0},{"name":"android-touch","canvas":true,"scenario":"inside","time_s":5,"errors":0}]}
```

桌面 1280×850、觸控 viewport 390×844、三個場景選項、切換 inside、時間滑桿與 Canvas 通過。兩張實際截圖均已檢視：畫面有螞蟻、走廊、事件與統計，合成／非正式／非生物實測標示清楚。Android viewport 不是實機測試；此煙霧測試也不涵蓋所有播放控制或長時間效能。

Rapier 是 120 Hz 的軌跡感測見證，未自主求解原生螞蟻的路線或讓路；重疊「格數」不等於獨立接觸事件數，中心線映射也不等於寬路中真實的橫向避讓。維持 APPROVE WITH COMMENTS。依賴沒有 lockfile 的可重建性問題仍應改善。

#104 的 V-P0b 對應既有 V3，artifact／公開部署區分對應 V8；#99～#103 分開 UI、求解器對照、渲染、隔離 Day0 接入，依賴沒有要求先完成所有物理才能交付唯讀畫面。科學優先、未知幾何、mm/s 與 cm/min 換算，以及 OFF 不變性等界線合理。

非阻擋文件意見：#104 仍寫 #96「未獲 Codex 固定 SHA 審查」，且把 #100 寫成未有修復 PR；上輪已有固定 SHA 的有限審查，本輪亦有瀏覽器驗證，#105 已存在。更新狀態與連結，避免誤導下一位 reviewer。不可把本次批准寫成 Rapier 已正式整合。

## 5. 科學根據與剩餘意見

本輪檢查引用與模型推論是否相符，未取得新的文獻全文。實際重新連線 eLife 流量研究頁及 PMC 時，代理 CONNECT 均回 403；GitHub 與 npm 可用。這是目前環境的目的地主機政策，沒有繞過或把 repo 的「全文已讀」標籤當作本人本輪重新讀全文的證據。

| 根據 | 本輪可支持的範圍 | 不可推出 |
|---|---|---|
| Vázquez et al., Insects 11:5, DOI 10.3390/insects11010005；repo R133 與候選檔 | 本種實驗室人工跡路的分方向速度候選；既有核讀記載的不確定量為平均值 CI | 野外速度、個體速度 SD、負重造成速度差 |
| Dussutour et al. 2005, DOI 10.1242/jeb.01711；R380 | 非本種 Lasius niger 的入口讓路方向，可作候選比較 | 本種精確讓路機率、長距離倒退規則 |
| Dussutour et al. 2009, DOI 10.1242/jeb.022988；R381 | 非本種 Atta colombica 的帶食優先觀察；負重與方向有混淆 | 所有螞蟻通用的 0.98 機率或 Pheidole 校準 |
| Poissonnier et al. 2019, eLife 8:e48945, DOI 10.7554/eLife.48945；R108 | 非本種 Linepithema humile 的交通研究，需保留實驗條件 | 本種交叉退讓、任意密度下速度與停頓參數 |
| Yuan 2026／Phillips 1933；repo 既有生命史整理 | 既有設計的生命史對照、停食後延遲發育方向 | C4b N 的形狀、θ/K、全體 SD 全當個體變異 |
| Tsuji & Win 2025, DOI 10.1242/bio.061976；R116 | 人工雙巢處理與標記轉移提供候選觀察算子 | 精確交換率、通用多巢均衡、本種自然條件定量校準 |

#94 的非阻擋統計意見延續：C 與 A 未達顯著差異，不證明統計等價；B.3 的 `C ≈ A` 必須按這個限制閱讀。後續驗證宜報效果量與信賴區間，若要主張等價須先定等價界值；不能把不顯著直接設成模型必須吻合的等價約束。

#97 的資料不足、候選形式 null 與多日上游供給缺口已明示，沒有選存活率最好者作為正確模型。此界線應保留。

## 6. main、PR 堆疊與 issues

重新讀取 open PR／issue 清單及 #99～#103 內文。main 未變，舊缺陷仍按原追蹤：#9 跨群共用食源時間順序、#56 個體順序、#81 營養與求食局部性、#83 溫度與機率／危險率、#84 個體變異與同步、#85 外部群體等，不重列為本輪新發現。沒有把 probe 存在或 CI 綠燈當成缺陷修好。

堆疊仍須區分：#93 在 #90 上，#95 也在 #90 上，#97 在 #95 上；**#97 目前不含 #93 的檢查強化**。各分支批准不代表整合後已測試，整合時要保留兩條驗證變更並重新驗證。#105 在 #98 上；#104 是獨立文件。沒有執行任何合併或修改 base。

正式接入仍受 #68／#69／#100／#103 的幾何、局部性、求解器限制、候選生物假設及獨立介面規則 PR 等門檻限制。#105 僅足以關閉本輪實際覆蓋的 PH-P2D 時間窗反例，不能將所有物理阻擋一併關閉。

## 7. 本輪執行紀錄與可重現方法

| 固定 head | 實際執行與通過結果 |
|---|---|
| #93 e33972b | 原始交錯探針；c3a-feed-rule 50；c3a-queen-feeding 326；c4a-larva-feeding 326；rules-registry 36；typecheck；golden 74 比較 |
| #97 d430471 | 原始化蛹與無照護探針；c4b-larva-development 55；c4a-larva-feeding 326；rules-registry 36；typecheck；golden 74 比較；check:saves 20/20 |
| #105 ef8308d | physics-p2d 122；擴大相同產生器 442；physics-event-fixes 426；ph2-collision 685；physics-isolation 86；rules-registry 36；typecheck；golden 74 比較 |
| #96 00c896b | 已建置的相同 head 上執行 Chromium desktop/android-touch smoke，兩者 errors=0，檢視兩張截圖 |
| #94 3df70e7 | 文件差異審查；p→λ→p 及兩半日存活乘積的獨立數值核對 |
| #104 6dfa0bb | 文件及依賴／issue 契約審查；純文件未新增測試 |

各專案測試以 `node tests/<表列名稱>.test.ts` 執行，另有 `npm run typecheck`、`npm run check:saves`。擴大時間窗測試僅在隔離副本將 `tests/physics-p2d.test.ts` 的 `seed <= 40` 改為 `seed <= 200`，同時將最終 n 斷言改為 200、比較數下限改為 3,000；沒有更動原有容差或比對內容。原始反例的完整構造與前一版接受結果見上一輪報告 §對應發現；本輪 §2 列新 head 拒絕結果和合法對照。

原始日誌保存在本次工作區 `/workspace/scratch/repo-review-round4/`，截圖位於隔離 prototype 的 `screenshots/`。本報告只上傳 Markdown；不把本地測試輸出、依賴或截圖寫進產品分支。未重跑完整套件與完整任意幾何 fuzz；未核對每個 GitHub CI job 的歷史，不以留言的「CI 全綠」替代上述本機結果。

正式存檔與歷史唯讀；未推進正式 Day15、未開始正式新版 Day0、未改參數、未修產品代碼、未 force-push、未合併 PR。唯一上傳內容為獨立 review 分支中的本文。

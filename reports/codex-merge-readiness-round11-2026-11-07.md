# Codex 複審與合併就緒報告 — round 11，2026-11-07

審查者：Codex。重新核對遠端main、14張未合併PR的head／base／狀態／CI，複驗上輪阻擋與新差異。只上傳報告，沒有執行PR合併。

## 1. 結論與合併順序

**目前9張非Draft PR已通過複審與CI，可按依賴順序合併；另外4張工程複審通過，但CI仍在跑；#96仍為Draft。#116及#117的重入漏洞已在新SHA上修復，解除REQUEST CHANGES，改為APPROVE WITH COMMENTS。** 本輪未發現新的P0／P1／P2阻擋；#118的邊界view及觀察器favicon仍是既有非阻擋P3。

**CI狀態快照（2026-11-07 19:05:54 UTC）**：通過10張（#96、#98、#105、#106、#108、#110、#113、#116、#117、#121）；尚在執行4張（#111、#115、#118、#120）。後者工程複審通過，但目前仍須等最新CI通過，不能視為已可執行合併。

**可先處理：#98、#106、#116**（三張都以main為base）。完整依賴順序：

| 堆疊 | 順序 | 範圍 |
|---|---|---|
| 隔離物理與播放 | **#98 → #105 → #108 → #111 → #115 → #118 → #120** | 合成場景、隔離物理，不接正式日循環 |
| 唯讀觀察器 | **#106 → #110 →（#113、#121）** | #113、#121都疊#110，是平行分支；#113不替換正式渲染器 |
| 世界排程／時間契約 | **#116 → #117** | 隔離工程基礎；不是完整P0-A生態實作，不啟用正式時間契約 |

每合併上游後，將下一張base改為main，核對diff並重跑整合後CI。#96需作者先解除Draft；本輪未代為變更。批准各PR的工程範圍，不表示所有候選機制已有本種文獻驗證。

## 2. 最新版本與逐張判定

main：`e11919b43c068fbf41ea06f05267e047e54fd5f3`。#95、#97、#114、#119已由其他人依序合併，不再列入待合併。

下表CI直接讀取GitHub `/pull/N/checks`，核對選中的SHA與遠端head相符。最初有多張in progress；沒有把空摘要當成通過，定稿時再讀取狀態。帳戶權限、保護規則、GitHub merge按鈕不在已驗證範圍。

| PR | 完整head SHA | 目前base | 最新CI | 複審判定與條件 |
|---|---|---|---|---|
| [#96](https://github.com/davidcatcat/antempire/pull/96) | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | main | 通過 | Draft；原隔離見證／回放工程判定沿用，需作者先標 ready。 |
| [#98](https://github.com/davidcatcat/antempire/pull/98) | `58222c60d2717c8dd058af595e03b132d49bf78a` | main | 通過 | 可先合併；限隔離物理修復，後續仍按堆疊順序。 |
| [#105](https://github.com/davidcatcat/antempire/pull/105) | `d9e5f7c7e1f7284ea7437891e7b2c0252209186c` | #98 | 通過 | 可依序合併；先 #98。 |
| [#106](https://github.com/davidcatcat/antempire/pull/106) | `24f16ca5971834e6497c02f7368be5c1299c940b` | main | 通過 | 可先合併；唯讀V3觀察器。 |
| [#108](https://github.com/davidcatcat/antempire/pull/108) | `dd470950cab13d19725ad3b32df319d356c0e596` | #105 | 通過 | 可依序合併；先 #105，限一維數值修復與診斷。 |
| [#110](https://github.com/davidcatcat/antempire/pull/110) | `37823ea8dec1e4733d924c8a941e12924fcfa7ac` | #106 | 通過 | 可依序合併；先 #106。 |
| [#111](https://github.com/davidcatcat/antempire/pull/111) | `bf6eb97f959a616c10f05ee1c861bdee21ce3487` | #108 | 執行中，合併前須等綠 | 工程通過，待CI完成再依序合併；先 #108，接縫／快取修復仍在。 |
| [#113](https://github.com/davidcatcat/antempire/pull/113) | `57b25f24708fcaa3cb210ad4265e2d4b7e27759e` | #110 | 通過 | 可依序合併；先 #110，限隔離繪圖benchmark；與 #121 平行。 |
| [#115](https://github.com/davidcatcat/antempire/pull/115) | `63f5a10fbfe4ff255c20194e195e09389571b31c` | #111 | 執行中，合併前須等綠 | 工程通過，待CI完成再依序合併；先 #111，horizon修復及共用幾何契約仍在。 |
| [#116](https://github.com/davidcatcat/antempire/pull/116) | `6b3be149efabe21e957e30056526ad549d7960ea` | main | 通過 | **改判 APPROVE WITH COMMENTS，可先合併**；R9-01／R10阻擋已關閉，模組仍隔離。 |
| [#117](https://github.com/davidcatcat/antempire/pull/117) | `d784ce688f7231bf9aee19a8d50ca496c18a87b9` | #116 | 通過 | **改判 APPROVE WITH COMMENTS，可依序合併**；先 #116，同一重入反例已修；未選正式時間契約。 |
| [#118](https://github.com/davidcatcat/antempire/pull/118) | `52ca24c36b71cda2f63ecfc1f827dc36b566f14b` | #115 | 執行中，合併前須等綠 | 工程通過，待CI完成再依序合併；先 #115，隔離PH-3b；P3深層唯讀意見仍未修，非阻擋。 |
| [#120](https://github.com/davidcatcat/antempire/pull/120) | `0185102f47222bd03b4f2eec47d65caff0f80091` | #118 | 執行中，合併前須等綠 | 工程通過，待CI完成再依序合併；先 #118，只播放合成物理記錄。 |
| [#121](https://github.com/davidcatcat/antempire/pull/121) | `223a7e49642ed4af6e5552998996436f4de36284` | #110 | 通過 | 可依序合併；先 #110，larva_development的顯示分類修正通過。 |

## 3. 上輪P2複驗：#116／#117確實修好了

固定head：#116 `6b3be149efabe21e957e30056526ad549d7960ea`；#117 `d784ce6`（完整SHA見表）。上輪證據：[round10 §4](https://github.com/davidcatcat/antempire/blob/3401d4426ef8d4e1ea014a4df0f50a32e7b97cd7/reports/codex-merge-readiness-round10-2026-11-07.md)。

新程式以 `busy`／`exclusive(op,fn)` 取代只保護handler本體的inHandler。step從取批次、呼叫handler、讀取／複製輸出、驗證到commit全程持有保護；schedule／cancel／runUntil讀取呼叫端輸入時也受保護。所有退出路徑在finally釋放；驗證失敗將批次放回。

**本輪本人重跑相同攻擊輸入，不只執行新增測試：**

| 反例／對照 | #116新head | #117新head |
|---|---|---|
| cancel getter先取消future:a再throw | 重入被拒；snapshot不變、future仍scheduled | 相同 |
| getter排minute0.5事件再return [] | 排程被拒；沒有past:a、snapshot不變 | 相同 |
| 拒絕後再正常step | 正常執行minute1，未倒退 | 相同 |
| getter捕捉重入錯誤、回傳合法[] | 阻止非法排程，但合法外層批次可正常commit | 相同 |
| 普通非法取消、純throw getter、handler本體重入 | 拒絕且snapshot不變 | 相同 |
| 普通合法{cancel:[]} | 正常commit | 相同 |

因此不是把所有getter一律拒絕當成通過，也不是只補一個時鐘檢查而漏掉取消的原子性。R9-01／R10的具體阻擋可以關閉。

- #116：scheduler **317**、isolation **82**、rules-registry **36**、typecheck通過。
- #117：time-contract **18,754**、scheduler **317**、isolation **86**、typecheck通過；診斷仍明確揭露tick量化合併及layered候選界線。
- 這不是任意呼叫端程式或任意未來排程擴充的形式化安全證明；本輪審核實際改動、原反例及相關回歸。模組尚未接入正式生態，也不會因合併就修完既有#9／#56。

## 4. Main整合審查

main的最終tree與上輪已審的#119 `6c97c33` **逐檔無差異**（git diff為空）；這次是把#95→#97→#114→#119堆疊實際合到main，不是另一批未知營養改動。

**本人本輪在此main執行單次完整 `npm test`：57/57 PASS、0 FAIL、exit0；check:saves20/20、typecheck通過。** 使用原檔與Node22.23.4，直接在已確認可監聽localhost／執行子程序的外層executor跑隔離archive，未修改斷言、未攔截測試錯誤；不再沿用上輪sandbox兩項失敗後分開重跑的結果。

檢查這次main帶入的預設OFF先驗、C4b候選營養形式與局部接觸開關、v29～31 registry／產生資料與只讀C4報告。出廠開關仍關閉，nutrition_response仍null。#119的180世界／60日實驗是診斷模型結構，沒有將低攝取或存活結果當調參目標。

其它新head大部分只是合入該main；物理程式及舊UI本身未再改。已比對差異檔名與相關程式內容，不把「新SHA」直接等同於「每個功能都重寫」。以本輪的main整合驗證與下列必要目標測試補足，沒有聲稱每張都重跑完整套件。

## 5. 其它變動與保留意見

### #121：新增C4b日結發育記錄的顯示分類

`web/src/model.ts`新增larva_development的中文名稱、brood類別及larva ID；沒有新增事件或捏造時間／地點。該事件沒有minute，仍應顯示日終（無時刻），不能畫成已觀測的分鐘級育幼接觸。

本輪Node1573項、V3追蹤7857項、V4統計1375項、typecheck及web build通過（詳原始log）。目前提交的三個重播沒有C4b發育事件；NATURAL_EVENT_TYPES涵蓋檢查可檢出漏分類，但不能說那些重播已展示C4b。

本輪未重跑未變的完整瀏覽器流程。前輪35項V5桌面／手機與18張截圖的條件仍適用：指定現有Chromium路徑的原harness會因favicon404而exit1；只在隔離harness把該請求回204後，failures/errors才皆空。應補favicon或明示測試處理，不能把它寫成無條件全綠；此P3非UI邏輯阻擋。畫面繼續區分事件記錄、推得值、示意路線與顯示插值。

### #118／#120及物理堆疊

PH-3b程式、broad phase與boundary程式未變，本輪 #118 solver2375、occupancy2542、physics-isolation107、typecheck通過。上輪獨立117組交叉探針的證據沿用，未重跑1000隻大型裁判或效能實驗。

**#118的P3邊界view仍未修**：laneBoundary回傳快取原物件，readonly Bnd[]僅淺層唯讀；呼叫端若違反只讀用途去修改巢狀座標，可以污染之後的幾何判定。上輪具體探針及優先級沿用，不假稱修復。本輪變更沒有新增會寫入該view的呼叫端，因此仍非當前隔離合併阻擋；建議後續深層不可變／凍結或複製。

#120只有main整合、播放程式沒有改動。上輪Node23101項與瀏覽器1932項屬相同播放邏輯的既有證據，不冒稱本輪重新執行。#96仍是sensor witness原型，不是Rapier重解交通。

## 6. 合併試算與剩餘整合工作

- 14張目前base／head的git merge-tree均無文字衝突。
- 從新main分別試算三條堆疊，**#116→#117、完整物理堆疊、#106→#110→#113→#121，各自均乾淨**。使用隔離Git物件，沒有變更使用者工作分支或任何PR。
- **跨堆疊的 #98＋#106、#98＋#116、#106＋#116，仍會在tests/run-all.ts衝突。** 必須保留雙方所有blocking測試、核對整合後指紋／產生資料、重跑CI，不能ours/theirs丟掉一方。
- 上述是文字合併試算與各固定head的檢查，不是所有混合樹都已編譯／完成全套整合測試。

## 7. 文獻與正式啟用界線

本輪未新增取得外部文獻全文，引用核讀限制沿用先前報告；沒有冒稱重讀臺灣文獻或找到新的本種數據。Vázquez2020的實驗室路線速度，不驗證野外速度、側移／讓路或膠囊身形；Dussutour／Poissonnier的其他蟻種交通證據只能支持候選比較。

13張工程範圍可合併，不表示已有完整P.megacephala的生物學模型。固定u、無摩擦／質量／加速度、瞬間轉折、最大可行速度與時間格點都是模型／工程契約。C4候選形式與先驗仍未科學辨識；死亡、營養、生命史個體差異、溫度、順序及生態閉合的既有issue未自動解決。正式Day0／Day15及物理接入需另案完成原訂驗收。

前輪完整審查：[round10](https://github.com/davidcatcat/antempire/blob/3401d4426ef8d4e1ea014a4df0f50a32e7b97cd7/reports/codex-merge-readiness-round10-2026-11-07.md)。本輪證據：`/workspace/scratch/repo-review-round11/`。Node22.23.4、獨立archive副本。唯一上傳內容是此Markdown報告；未實際合併PR、改base、force-push、改正式存檔／日誌／參數、推進正式Day15或啟動新版正式Day0。交易／規則測試只使用臨時世界與隔離副本。

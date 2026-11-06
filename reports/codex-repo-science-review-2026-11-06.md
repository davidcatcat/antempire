# Codex 審查：main、全部未合併 PR 與開放 issue（2026-11-06）

**結論：REQUEST CHANGES。** 新確認 4 項 P2：#78 的初始化漏帳、回合中嗉囊容量及離開後餵食；#77 的存活蟻后身分替換。它們都是驗證器假陽性，並非本次已證實正常引擎會自行生成相同錯誤。main 既有的個體營養、順序、生命史與生態收支問題仍未完成，不能宣稱符合全部本種文獻或已通過正式科學驗收。

審查者為 Codex，沒有使用子代理。基準與 PR 在本輪重新 fetch，讀取 GitHub 的公開說明／留言；清單共 **7 個 open PR（含 1 個 draft）、13 個 open issue**，兩個清單都只有一頁。本報告不把舊留言中的「未合併」當成目前狀態。審查完成後再次用遠端 Git refs 核對下列 SHA 未變。

## 1. 新確認的問題

### R6-01 — P2，#78：建立當日的獨立讀取器接受漏事件與憑空儲備

位置：[queen-feeding.ts:167](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/engine/queen-feeding.ts#L167)、[queen-round-replay.ts:33](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/cli/lib/queen-round-replay.ts#L33)、[engine-transfers.ts:168](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/cli/lib/engine-transfers.ts#L168)、[transfers.ts:349](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/engine/transfers.ts#L349)。

兩份巢內回合檢查只驗證「已存在的初始化事件」，不要求新建 queen record 必須有且只有一筆事件。獨立 C2 讀取器的期末核對又只遍歷有放進重播帳的區室；沒有期初 queen、初始化事件或觸及 queen_body 的轉移時，期末 queen_body 不會被核對。

重現：A4、seed 1、2027-09-23，C3a 開啟、初始 reserve 參數維持預設 0。第一天的正常期末已知儲備是糖 0、蛋白 0。保留其他事件，刪掉 `queen_body_initialized`，將期末已知儲備改為糖 **5**、蛋白 **7**。結果：

| 檢查 | 正常對照 | 無初始化事件、儲備 5／7 |
| --- | --- | --- |
| `checkQueenRound` | 接受 | **接受** |
| `replayEngineColonyDay(..., c3a=true)` | 無錯誤 | **無錯誤** |
| `replayQueenRound` | 無錯誤 | **無錯誤** |

**正式每日呼叫的界線：** `engine/day.ts` 在 `ensureQueens` 後才拍攝引擎 C2 快照。另以這個正式呼叫順序重測，`checkColonyFood` **會拒絕**上述假儲備（期初已知 0 與期末 5 不符）。直接用未初始化的原始期初狀態拍攝快照則接受，但這不是正式流程的呼叫方式。因此這項 P2 是建立當日的**獨立稽核與回合檢查缺口**，不宣稱已繞過正式流程的 C2 餘額防護。

讀取器的結果違反 ID-QUEEN-BODY 及「沒有來源事件就沒有攝取」的驗收契約。既有測試有改壞初始化金額，但沒有刪除初始化事件，故沒有涵蓋這條路徑。

建議：獨立讀取器及回合檢查把 queen record 的有無納入期初資料；新建時要求正確、唯一、歸屬本后的初始化事件。期末檢查遍歷**所有預期及實際 queen_body 區室的聯集**，不能只核對曾觸及的帳。第一天也必須有獨立讀取器的正常及負面驗收；目前多日測試主要在 `before.population.queens` 存在後才套用讀取器，應補齊建立當日的完整檢查。

### R6-02 — P2，#78：嗉囊只檢查期末，回合中超出共用容量仍通過

位置：[queen-feeding.ts:160](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/engine/queen-feeding.ts#L160)、[queen-round-replay.ts:29](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/cli/lib/queen-round-replay.ts#L29)。

引擎與讀取器都只看期末工蟻持有量；C2 逐筆核對可支出的量，沒有逐筆核對糖與液態蛋白的容量總和。因為回合結束前會把剩餘液態蛋白放回倉，期末檢查擋不住中途超載。

隔離回合的合法對照：一隻在巢育幼工蟻先持有糖 **0.75**；共用容量 **0.8**；倉與蟻后儲備充足。正常只取液態蛋白 **0.05**，稍後放回。把取用與放回各改為 **0.28**，保持帳目淨額及所有期末狀態不變：

```text
取用前糖 = 0.75
取用蛋白 = 0.28（沒有超過 take_from_cache_max_portions = 0.28）
取用後總持有 = 1.03 > 共用容量 0.8
期末液態蛋白 = 0（已放回）
引擎兩項檢查：接受；C2 與回合讀取器：都無錯誤
```

這個較小的反例沒有靠超過單次取用參數來觸發問題。另外在完整日輸出的反例中，取用／放回各增 1 份（取用 1.28）也被全部接受。兩者都是合成驗證資料，不是正式世界的餵食干預。

建議：從期初各工蟻的兩種嗉囊持有量開始，按轉移順序逐筆更新；**每一筆後**要求糖 ≥ 0、液態蛋白 ≥ 0、兩者相加 ≤ 共用容量。不得只保留一個期末超容量反例。

### R6-03 — P2，#78：工蟻已離開蟻后、回到倉庫，仍可接觸並餵食

位置：[queen-feeding.ts:186](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/engine/queen-feeding.ts#L186)、[queen-feeding.ts:197](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/engine/queen-feeding.ts#L197)、[queen-round-replay.ts:52](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/cli/lib/queen-round-replay.ts#L52)、[queen-round-replay.ts:67](https://github.com/davidcatcat/antempire/blob/9d2933f790f9a2cddc558058921d8947469079c9/cli/lib/queen-round-replay.ts#L67)。

兩份實作只檢查接觸不早於抵達。回程資料只保存「回到倉庫」的時間，沒有用「離開蟻后」的時間限制接觸／餵食。讀取器檔頭甚至把蟻后處的在場區間寫為 `[arrive, ∞)`。

A3、seed 1 的合成測試世界，在第 2 日開始前只將倉中蛋白設為 10，取得帶回程的正常第 4 日輸出。W006：

```text
離開蟻后 ordinal = 2.606224
抵達倉庫 ordinal = 3.106224
把原接觸與餵食移到 ordinal = 3.106224，放在自己的放回事件前，重編 transfer_id
所有持有量、期末存量與轉移金額不變
引擎兩項檢查：接受；C2 與回合讀取器：都無錯誤
```

位置欄位仍自稱在 queen，但工蟻自己的移動事件顯示它已在 store，驗證器沒有解決這個矛盾。這是**過渡序數模型本身**的局部因果缺口，不是要求 C3a 提前完成物理引擎。

建議：明確建立 store、在途、queen、回程、store 的有效區間；接觸與實際餵食都要落在 queen 的在場區間，不能只讓一個歷史接觸永久有效。加入抵達前、離開後、抵倉後及合法邊界對照，明定同序數事件順序。

### R6-04 — P2，#77（#78 繼承）：存活蟻后的 ID 可以無事件替換

位置：[invariants.ts:73](https://github.com/davidcatcat/antempire/blob/852155dbe55ef6ffecc5d44384780787bf2439aa/engine/invariants.ts#L73)、[invariants.ts:105](https://github.com/davidcatcat/antempire/blob/852155dbe55ef6ffecc5d44384780787bf2439aa/engine/invariants.ts#L105)、[population-replay.ts:49](https://github.com/davidcatcat/antempire/blob/852155dbe55ef6ffecc5d44384780787bf2439aa/cli/lib/population-replay.ts#L49)。

上一輪「其他蟻后的死亡可殺死本后」反例已修正。但 `queen_id` 前後相同的檢查被放在 `queen_death` 分支內；沒有死亡事件時，最後只核對 `queen_alive` 布林值。

重現：A1、seed 1、2027-09-23 第一個正常日，原后 Q001 存活。只把期末 `queen_id` 改為 `OTHER_COLONY_QUEEN`，其餘狀態與事件不變。`checkPopulationDay` 接受，`replayPopulationDay.ok=true`。同一對照的外后死亡事件現在確實被兩邊拒絕，兩種結果不能混為一談。

目前沒有蟻后遷入、遷出或更替事件，不能用「同樣還活著一隻」接受身分替換。建議在每天的入口／出口無條件核對蟻后身分；若日後支援更替，應由明確生命期／邊界事件推導期末身分。這延續上一輪 ID 層級的要求，不是把已修好的死亡反例重新列成未修。

## 2. 範圍、固定 SHA 與各 PR 判定

| 對象 | SHA | 本輪核對與判定 |
| --- | --- | --- |
| main | `4e8fc6e8f9cec12c18a7a450921143d03721006d` | 完整測試；正式引擎仍 v23，物理層是隔離實驗。已知科學／因果限制未解除；不是正式 Day0 的科學通過判定 |
| #53 | `e707d026508c4f430e726d2a70edff2cd70ea460` | 文獻報告。核對 RP 矩陣、研究條件、留言更正與 main 的修訂；合併前需明確連結／標示已被修訂部分，不把舊版研究變成第二份相反規格 |
| #55 | `8a25b99d639a05136fd8182425ecb0835ed0c855` | 繁殖設計。仍有舊 OD-2／3／4 建議及不完整的 SD 說明；main 已明文取代。合併前需同步，文獻表有 Git 衝突 |
| #70（draft） | `5554160fceb497411899bdea25e8f58dbca029cb` | 物理／運動設計，仍需對齊已合併 #71～#75；Roadmap 有 Git 衝突。設計要求本身不能作為實作或本種校準證據 |
| #76 | `6dcaf13fb25bffed3c1696892274c59ed060a754` | ODD v23 同步方向合理：區分沉積時地修正與未決沉積模型。若 #77／#78 合併，需同步最終版本標示；本輪未發現此文件差異新增行為問題 |
| #77 | `852155dbe55ef6ffecc5d44384780787bf2439aa` | **REQUEST CHANGES：R6-04**。舊 F1～F3／C1 反例已補驗；不能據此認定完整身分契約結案 |
| #78 | `9d2933f790f9a2cddc558058921d8947469079c9` | **REQUEST CHANGES：R6-01～03，加上繼承 R6-04**。開關預設關閉的回歸通過，不代表開關打開的因果驗證完成 |
| #79 | `b5da282da00599a076eeda2d8f1adc7742cc8c09` | 僅對這份文件差異可 **APPROVE WITH COMMENTS**：入口讓路、外部負載、未知參數的敘述與候選檔一致；沒有解除物理五項阻擋，也沒有提供本種新實測 |

#78 堆疊於 #77，不能因為對 #78 跑了完整套件，就把 #77 的新缺口視為已解決。對文件的有限肯定也不是替 Owner 合併 PR。

## 3. #77 上輪修正的實際複驗

| 舊項目 | 本輪結果 |
| --- | --- |
| 外后死亡事件 | 引擎拋 `queen_death of OTHER_COLONY_QUEEN`；讀取器拒絕；合法 Q001 對照接受 |
| 死亡後孵化 | 引擎及讀取器都拒絕；先孵化後死亡兩邊接受 |
| 幼體負日齡 | A4 期初 −3，完整 `simulateWorldDay` 在入口拒絕；`null` 的未知日齡仍可執行 |
| 非陣列事件／null start | 回傳錯誤，不再靜默轉成空陣列或讓這兩個例外逸出 |
| 新的身分替換 | 仍接受，見 R6-04 |

這不是完整的惡意 JavaScript 物件、getter、Proxy 或所有型別的 fuzz 審計；不把幾個輸入例子的改善解讀成無條件「永不拋錯」。

## 4. main 仍在的科學與因果阻擋（既有問題）

以下與 #77／#78 的新驗證器發現分列。它們已有研究／issue 記錄，本輪沒有要求在診斷 PR 中偷偷改變全部生物規則。

| 項目 | 現行程式／證據 | 含意與所需工作 |
| --- | --- | --- |
| 全巢帳代替個體營養（P1） | `engine/nutrition.ts:74`：依全巢存量與總需求計算攝取比例；`engine/queen.ts:15`、`:46`、`:76`：工蟻飢餓、傷勢復原、蟻后生存與產卵讀全巢日數／存量／幼體數 | F01／A08 未完成。C3a 只有蟻后已知儲備與自身代謝；C3b／c、C4、C5 未完成。不能以蟻后接觸事件證明整個營養鏈已局部化 |
| 幼蟲求食訊號的全巢輸入（P1） | `engine/nutrition.ts:106` 用共同 `pFraction` 更新每隻幼蟲，再由 nurseContact 取得 | 最後一步是局部接觸，不能消除上游訊號的非局部來源。應依幼蟲自身實際攝取建立訊號 |
| 沒有物質去處的流失（P1） | `engine/ecology.ts:43` 的到期蛋白清零，蜜露／花蜜容量 clamp；巢內溢出與死亡本體缺完整區室 | #77 的 720 世界日讀取器量化容量刪除 **419.129475**、到期刪除 **51.700346** 遊戲份。這是列帳，沒有修復生態去處；不是 mg 或能量守恆 |
| 儲存順序決定個體與競爭（P1） | `engine/workers.ts:69`、`nutrition.ts:97`；`engine/day.ts` 逐群完成覓食；既有 #56 探針仍斷言缺陷存在 | #56、#9 及共享 ecology RNG 尚未解。固定種子可重播不等於排列不變；每天隨機輪替也不是世界時間因果 |
| 發育分布未建立（正式 Day0 阻擋） | 本輪隔離 `developBrood`：28°C、足夠營養、持續照護，20 枚同初始卵全 Day29 羽化，群內時間變異為 0 | 再現平均附近不等於再現 Yuan 隊列的 24～34 日分布。#65 S1 必須區分群間、環境與個體差異，不能直接把全部 SD 當先天差異 |
| 溫度、死亡與時間尺度（P2） | 發育 Q10 有上下截限，代謝無相同截限，產卵另有 Q10；死亡程式使用每日機率 | 三種反應不必生物學上完全相同，但需各自證據及可比較觀察算子。若宣稱連續危險率 λ，須使用 `p=1-exp(-λΔt)` 並交代尺度；不能把每日機率直接當連續率 |
| 天氣統計（P2） | `engine/weather.ts` 雨日濕度 +5、乾日 −2 百分點 | 不計截限與距平時，均值偏移為 `5p-2(1-p)=7p-2`，只有 p=2/7 才為 0。AR＋Gamma 架構不等於當地濕度與雨量分布已驗證；需逐月分布、持續性及極端值驗收 |
| 捕食／競爭／外界（P2／功能未完成） | 固定遭遇機會、未模擬對手的固定蜜露分率、尚無正式雙向外部螞蟻生命期 | Holling 只能作有假設的候選／輸出比較，不可再疊加在已逐事件捕獲的過程上。完整繁殖與有限雙向外界依 D4-A／D7-A 驗收，不能用文件或固定補給代替 |
| 物理正式接入仍受阻 | main `docs/physics-motion-engine.md` 已列五項已知問題：P1-A 交叉反覆微退讓、P1-B 切線觸發尺度；P2-A 舊跟隨放行、P2-B 尾端 T_EPS、P2-C 累積捨入／時間窗依賴 | 本輪未重跑原始全部 fuzzer，保留先前獨立報告與程式未變的證據；不是新增問題，也不能因 #79 記錄決策就結案。不得當作 C3 已驗證的物理接觸來源 |

## 5. 文獻對照與證據界線

**讀取程度：** 本輪精讀了上述分支的程式、設計、`docs/references.md`、相關研究報告／工作筆記，以及 open PR／issue 的說明留言。受目前受控網路的允許網域限制，本輪**未獨立下載並逐頁核對期刊原文或補充資料**。下列原文摘錄與數據的本輪取得途徑是 repo 已保存的研究筆記；不能把 Claude 過去標示「全文已讀」轉寫成本輪 Codex 的全文查核。文獻合規判斷因此是證據鏈與外推限制審查，不是完成生物模型認證。

| 文獻／原則 | 可支持的內容與必要限制 | 對本 repo 的判定 |
| --- | --- | --- |
| Yuan et al. 2026，DOI [10.3390/insects17100992](https://doi.org/10.3390/insects17100992) | repo 工作筆記記載 28°C 非繁殖型卵至成體 28.73±2.83 日，n=52、範圍 24～34；涉及 8 群、minor／major 合併。繁殖型 37.60 日含借用工蟻前段時程，不能當逐隻完整追蹤 | main 的同批等速發育無法代表全部分布；先設觀察算子與候選變異層級。沒有配對資料／共變異數，不認定論文 SD 算錯 |
| Chang 1985，ScholarSpace [10125/11173](https://hdl.handle.net/10125/11173) | 26～27°C 人工供食、野外成熟群取出的蟻后／工蟻／蛹；試驗條件與新交配創巢不同 | 不能把「10 隻」推成通用安全創巢人口或每日接觸率。C3 路線 C 保留候選；不能由可自行取食推得所有情境的固定成功率 |
| Sanders et al. 1992，*Food acceptability and distribution…*（R346） | repo 摘錄：工蟻餵蛋白給蟻后未被直接觀察；標記蛋白在幼蟲先被餵後才到蟻后。染料／放射標記的分布不等同已直接證實某條蛋白交哺路線 | B1、B2、C 應維持候選；#78 的固體 1 份→液體 1 份、所有育幼蟻每日拜訪、序數旅程及放回規則是 D 類假設。標成假設是誠實披露，並不使其成為本種已驗證機制 |
| Tsuji & Win 2025，DOI [10.1242/bio.061976](https://doi.org/10.1242/bio.061976) | 本種實驗室多巢共享食物／工蟻等現象可支持營養流動研究方向 | 巢間交換證據不能直接證明特定工蟻→蟻后的 B1 路線、液化效率、每日個體攝食率或臺中營養供給 |
| Vázquez et al. 2020，DOI [10.3390/insects11010005](https://doi.org/10.3390/insects11010005) | 人工標記路線的 17／18.5／15.5 mm/s；依目前統一來源註記，誤差為平均值的 CI，不是個體 SD。方向與負載因果不同 | 方向候選可用，但不能用 CI 抽個體速度，不能當野外地形、負載、溫度係數。main 的實驗隔離與 #79 的保留限制合理 |
| Dussutour et al. 2009 JEB；Saund & Friedman 2023，DOI [10.1016/j.cogsys.2023.02.005](https://doi.org/10.1016/j.cogsys.2023.02.005) | 雙訊號為行為推論，不是化學鑑定；單訊號仍是可比較候選。選擇偏好失去顯著性不等於化學訊號消失或半衰期 | v23 只修沉積時地；沉積決策、量、衰退與 M1/M2 仍待 #64 的觀察算子實驗。公開作者程式不能替代發表版全文 |
| Dussutour et al. 2005、2009 交通研究，DOI [10.1242/jeb.01711](https://doi.org/10.1242/jeb.01711)、[10.1242/jeb.022988](https://doi.org/10.1242/jeb.022988) | 分別是 *Lasius niger* 與 *Atta colombica*；202/211、294/300 非本種機率，接觸損失時間不能再當停頓與退讓重複相加 | #79 將入口讓路作候選、外部物件才算負載、未知量維持 null，沒有發現新增的本種證據誤標。仍需本種觀察及數值驗收 |
| Fournier 2012、Liu 2022，DOI [10.1371/journal.pone.0031480](https://doi.org/10.1371/journal.pone.0031480)、[10.1002/ece3.9660](https://doi.org/10.1002/ece3.9660) | 地理、隱蔽類群、取樣選擇與遺傳推論的層級必須保留 | 不能把喀麥隆的近親估計搬為臺中日內交配率，不能把 100 m 當敵對閾值。#53／#55 必須連結 main 已合併的更正，不得復活舊外推 |
| ODD／POM，Grimm et al.，DOI [10.1016/j.ecolmodel.2010.08.019](https://doi.org/10.1016/j.ecolmodel.2010.08.019)、[10.1126/science.1116681](https://doi.org/10.1126/science.1116681) | 模型描述與多型態比較框架；可重播、守恆、測試通過與生物外部驗證是不同層次 | 需同時比較活動、路線、招募、營養、生命史、族群、季節與競爭型態，區分校準資料／保留驗證資料。不以存活率挑選模型 |

`SD(X+Y)^2 = SD(X)^2 + SD(Y)^2 + 2Cov(X,Y)`；只用獨立假設下的平方和算不回某篇表格，不能證明其 SD 錯誤。main 已正確降格為來源未確認；#55 的舊文字應同步這個更正。

## 6. 全部開放 issue 的核對

| Issue | 本輪核對後狀態／需要的驗收 |
| --- | --- |
| #9 世界共用時間軸 | 仍開放且正式引擎未修。設計／原型合併不能視為正式覓食排程已更換 |
| #25 major／minor | 仍為研究與分工設計；體型或候選 body schema 不等於正式 caste 發育、行為、生理已完成。不能將未知工蟻回填成已知 caste |
| #26 新蟻種 | 仍為資料需求／架構工作；「行軍蟻」需先指定物種，不能複製本種參數。尚無完成本輪可驗收的新物種 PR |
| #27 辨識與相遇 | 仍需局部化學／接觸機制與族群條件；異巢不等於必攻擊，距離不等於識別訊號。物理接觸本身不產生已驗證辨識行為 |
| #43 第一輪綜合缺陷 | F02～F05 等已有後續修正，不能全部重列未修；F01／A08、A09／A10 與正式科學驗收仍未完成 |
| #49 第二輪缺陷 | 幼體排程及轉移／輸入指紋有後續修正；工蟻順序另由 #56 追蹤，舊敏感度來源限制另由 #57 追蹤。不建議僅依 issue 標題判定全部仍錯或全部結案 |
| #56 工蟻順序 | 仍在。現有測試通過表示成功重現已知缺陷；#78 單一 nestRound 的反轉不變，不能證明上游任務、接觸、配給與整日結果不變 |
| #57 舊資料 provenance | 產生時沒記錄的 CLI hash 仍無法靠事後重跑證明。保留歷史及不確定性；不可把現在 hash 填回舊紀錄冒充同期驗證 |
| #61 第三輪缺陷 | R3-05 時地、R3-08 名冊與 reader hardening 已有合併修正；R3-09 的主線說明已降確定性。營養、排程、生命史及完整繁殖／外界等阻擋仍在；ODD 的完整 v23 同步是 open #76 |
| #65 隨機性 | S0 已隨 ME-0 文件合併；S1～S4 不因具名 RNG 或日抽樣而完成。發育探針仍無群內差異，需分開個體、環境、參數及觀察不確定性 |
| #66 數學生態 | ME-0 在 main；ME-1 是 open #77 且仍有 R6-04；ME-2～ME-5 尚未完成外部科學驗收。世界食物帳只是部分遊戲份量收支 |
| #68 物理空間 | #71～#75 已合併到 main 的實驗層。五項 P1／P2 接入阻擋保留；不可因 PR 已合併即關掉整個研究需求 |
| #69 動態速度 | 恆速分段、方向候選、碰撞等待有實作；正式每日循環、負載／溫度／地形校準、大規模與數值尺度驗收仍未全部完成 |

本輪沒有關閉 issue、代發留言、合併 PR 或替 Owner 作未提供的生物參數決定。

## 7. 真正執行的測試與整合核對

環境：Node **22.23.4**、鎖定依賴，Git archive 隔離副本。沒有修改既有斷言。

| 範圍 | 本輪實際結果 |
| --- | --- |
| main | `npm run typecheck` 通過；完整 `npm test` **45/45 腳本 PASS**；`check:saves` **20/20** |
| #78 | `npm run typecheck` 通過；完整 `npm test` **47/47 腳本 PASS**（含 ME-1、C3a、golden、rules-isolation、C2、物理）；`check:saves` **20/20** |
| #77 | `npm run typecheck` 通過；`tests/me1-invariants.test.ts` **111 checks**、720 colony-days／world-days；`check:saves` **20/20**。沒有另外重跑此 head 的完整套件；#78 包含其測試與修正 |
| 獨立反例 | R6-01～04 均成功重現，合法對照亦接受；反例程式 exit 0 不是產品通過證據 |
| 發育子模型探針 | 20 個羽化事件全為 Day29；單獨發育模組，不是正式世界推進或論文條件的完整複現 |
| 文件整合探查 | `git merge-tree --write-tree`：#77＋#76 無文字衝突；main＋#55 在 `docs/references.md` 衝突；main＋#70 在 `docs/roadmap.md` 衝突。只計算合併樹，未更新分支或工作目錄 |
| 正式歷史與工作區 | main→#77、main→#78 的 `saves/`、`journal/` 無差異；原工作區保持原 checkout、未更改 |

**數目更正建議（P3）：** #77 留言寫 66/66 BLOCKING、#78 說明寫 62/62，但這兩個固定 SHA 的 `tests/run-all.ts` 實際清單為 **46／47 個腳本**，main 為 45。請區分「腳本數」、「斷言數」及「資料日數」，並以提交 SHA 綁定。本輪沒有獨立讀取遠端 CI 結果，不把 PR 自述的 CI 綠燈當成本輪實驗。

## 8. 修正與科學驗收順序

1. #77 補無死亡事件時的蟻后身分連續性；保留上輪已通過的合法／非法對照。
2. #78 補新區室建立的必要事件、所有期末區室的核對、逐事件共享容量、完整在場區間。第一天與零轉移日必須納入反例。
3. 對修正 SHA 重跑原測試及本報告的獨立反例，不以移除未知值、放寬容差或只修改斷言來變綠。
4. 同步 #53／#55／#70／#76 與目前決策、版本、研究閱讀程度，保留歷史更正；保留物理五項正式接入阻擋。
5. 新版正式 Day0 前，依現行需求完成 C3b／c、C4、C5，消除全部全巢決策輸入；完成 #56／#9 與共享 RNG、P0-A／B、P1-B、D4-A／D7-A，以及費洛蒙候選與 ME-2～ME-5 的科學驗收。D 類候選可依既有規格研究，但需要明示範圍、敏感度與可辨識的外部觀察，不可改稱本種實測。

本報告只上傳單一 Markdown 檔。探針、測試日誌、抓取的網頁及清單留在 `/workspace/scratch/review-repo-20261106/`。沒有 force push、改引擎、調參、改正式存檔／日誌、推進 Day15 或啟動正式 Day0。

## 附錄：本輪可重播探針

在對應 SHA 的 Git archive／隔離 checkout 根目錄，將各程式碼存為所示檔名，安裝鎖定依賴後以 Node 22.23.4 執行 `node <檔名>`。程式只改記憶體中的合成測試資料，不讀寫正式存檔；預期的 ACCEPT／空錯誤列表是在重現缺陷，不是產品通過測試。

### A. #78 建立當日稽核與正式 C2 快照對照

檔名：`review-c3a-initial.ts`

```typescript
import {buildDay0} from './cli/lib/day0.ts';
import {loadBundle} from './cli/lib/load.ts';
import {resolveBundle} from './engine/params.ts';
import {simulateWorldDay} from './engine/index.ts';
import {colonySnapshot,checkColonyFood} from './engine/transfers.ts';
import {checkQueenRound,queenRoundStart} from './engine/queen-feeding.ts';
import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';
import {replayQueenRound} from './cli/lib/queen-round-replay.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;const sp=resolveBundle(b).species[sid];
const s:any=buildDay0('A4',1,'2027-09-23',b).state,before=structuredClone(s.colonies[0]),o:any=simulateWorldDay(s,b),after=o.state.colonies[0];
const check=(name:string,ev:any[])=>{let engine='ACCEPT';try{checkColonyFood(colonySnapshot(before,true),after,ev,'timed');checkQueenRound(queenRoundStart(before),after,ev,sp)}catch(e){engine=String(e)}
console.log(JSON.stringify({name,engine,food:replayEngineColonyDay(before,after,ev,o.day,new Set(Object.keys(s.sources)),'timed',true).errors,round:replayQueenRound(before,after,ev,b.species[sid]).errors,balance:after.population.queens[0].body.known_balance}));};
check('CONTROL',o.result.colonies[0].events);
const ev=o.result.colonies[0].events.filter((e:any)=>e.type!=='queen_body_initialized');
after.population.queens[0].body.known_balance.sugar=5;after.population.queens[0].body.known_balance.protein=7;
check('NO_INITIALIZATION_EVENT_PLUS_FREE_RESERVE',ev);
import {ensureQueens} from './engine/queen-feeding.ts';
const initialized=structuredClone(before);ensureQueens(s,initialized,sp,[]);
try{checkColonyFood(colonySnapshot(initialized,true),after,ev,'timed');console.log('PRODUCTION_STYLE_POST_INIT_SNAPSHOT ACCEPT')}catch(e){console.log('PRODUCTION_STYLE_POST_INIT_SNAPSHOT REJECT',String(e))}
```

### B. #78 不超過單次取用參數的中途超容量

檔名：`review-c3a-capacity.ts`

```typescript
import {buildDay0} from './cli/lib/day0.ts';import {loadBundle} from './cli/lib/load.ts';import {resolveBundle} from './engine/params.ts';
import {ensureQueens,nestRound,checkQueenRound,queenRoundStart} from './engine/queen-feeding.ts';
import {bindFoodTransfers,colonySnapshot,checkColonyFood} from './engine/transfers.ts';
import {replayQueenRound} from './cli/lib/queen-round-replay.ts';import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;const sp=resolveBundle(b).species[sid];
const s=buildDay0('A3',1,'2027-09-23',b).state,c=s.colonies[0];ensureQueens(s,c,sp,[]);s.sim_day=5;
for(const w of c.population.workers){w.task='rest';w.crop_cargo_sugar=0;w.last_location=c.nest_node;}
const w=c.population.workers[0];w.task='nurse';w.crop_cargo_sugar=0.75;c.stores.sugar=10;c.stores.protein=10;c.population.queens![0].body.known_balance.protein=1;
const before=structuredClone(c),ev:any[]=[];bindFoodTransfers(ev,6,c.id);nestRound(s,c,sp,ev);
function verify(name:string){let engine='ACCEPT';try{checkColonyFood(colonySnapshot(before,true),c,ev,'timed');checkQueenRound(queenRoundStart(before),c,ev,sp)}catch(e){engine=String(e)}console.log(JSON.stringify({name,engine,food:replayEngineColonyDay(before,c,ev,6,new Set(Object.keys(s.sources)),'timed',true).errors,round:replayQueenRound(before,c,ev,b.species[sid]).errors}));}
verify('CONTROL');const t=ev.find(e=>e.cause==='take_from_cache'),r=ev.find(e=>e.cause==='return_to_cache');
t.portions=0.28;t.nest_ledger_delta=-0.28;r.portions=0.28;r.nest_ledger_delta=0.28;
verify('SHARED_CAPACITY_EXCEEDED_WITHIN_TAKE_LIMIT');console.log(JSON.stringify({sugarHeldBeforeTake:0.75,proteinTaken:t.portions,instantaneousTotal:1.03,capacity:sp.trophallaxis.crop_capacity,perTakeMax:sp.queen_feeding.take_from_cache_max_portions,returned:r.portions,endLiquidProtein:w.crop_cargo_protein_liquid??0}));
```

### C. #78 完整日輸出的回合中超量及回倉後餵食

檔名：`review-c3a.ts`

```typescript
import {buildDay0} from './cli/lib/day0.ts';
import {loadBundle} from './cli/lib/load.ts';
import {resolveBundle} from './engine/params.ts';
import {simulateWorldDay} from './engine/index.ts';
import {colonySnapshot,checkColonyFood} from './engine/transfers.ts';
import {checkQueenRound,queenRoundStart} from './engine/queen-feeding.ts';
import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';
import {replayQueenRound} from './cli/lib/queen-round-replay.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;
const sp=resolveBundle(b).species[sid];
let s:any=buildDay0('A3',1,'2027-09-23',b).state;
const verify=(name:string,d:any)=>{
 let engine='ACCEPT';try{checkColonyFood(colonySnapshot(d.before,true),d.after,d.ev,'timed');checkQueenRound(queenRoundStart(d.before),d.after,d.ev,sp)}catch(e){engine=String(e)}
 const food=replayEngineColonyDay(d.before,d.after,d.ev,d.day,d.sources,'timed',true),round=replayQueenRound(d.before,d.after,d.ev,b.species[sid]);
 console.log(JSON.stringify({name,day:d.day,engine,food:food.errors,round:round.errors,meta:d.meta}));
};
let found=0;
for(let day=0;day<60 && found<2;day++){
 if(day===1)s.colonies[0].stores.protein=10;
 const before=structuredClone(s.colonies[0]),o:any=simulateWorldDay(s,b),after=o.state.colonies[0],ev:any[]=o.result.colonies[0].events;s=o.state;
 if(!before.population.queens)continue;
 const r=ev.find(e=>e.cause==='return_to_cache' && ev.some(t=>t.cause==='take_from_cache'&&t.recipient.id===e.source.id));
 if(!r||before.stores.protein<2)continue;
 const base={before,after,ev,day:o.day,sources:new Set(Object.keys(s.sources))};verify('CONTROL',base);
 const cap=structuredClone(base),take=cap.ev.find((e:any)=>e.cause==='take_from_cache'&&e.recipient.id===r.source.id),ret=cap.ev.find((e:any)=>e.cause==='return_to_cache'&&e.source.id===r.source.id);
 take.portions+=1;take.nest_ledger_delta-=1;ret.portions+=1;ret.nest_ledger_delta+=1;cap.meta={worker:r.source.id,taken:take.portions,capacity:sp.trophallaxis.crop_capacity,putBack:ret.portions};verify('OVER_CAPACITY_DURING_ROUND',cap);found++;
 const tl=structuredClone(base),feed=tl.ev.find((e:any)=>e.cause==='feed_queen'&&e.source.id===r.source.id),back=tl.ev.find((e:any)=>e.type==='nest_move'&&e.worker===r.source.id&&e.from==='queen'&&e.to==='store');
 if(feed&&back){
  const con=tl.ev.find((e:any)=>e.type==='queen_contact'&&e.contact_event_id===feed.contact.contact_event_id),feeds=tl.ev.filter((e:any)=>e.cause==='feed_queen'&&e.source.id===r.source.id);
  con.ordinal=back.arrive_ordinal;for(const f of feeds)f.ordinal=back.arrive_ordinal;
  tl.ev=tl.ev.filter((e:any)=>e!==con&&!feeds.includes(e));const at=tl.ev.findIndex((e:any)=>e.cause==='return_to_cache'&&e.source.id===r.source.id);tl.ev.splice(at,0,con,...feeds);
  let n=0;for(const e of tl.ev)if(e.type==='food_transfer')e.transfer_id=`FT-${tl.day}-${after.id}-${++n}`;
  tl.meta={worker:r.source.id,leftQueen:back.depart_ordinal,backAtStore:back.arrive_ordinal,contact:con.ordinal,feed:feed.ordinal};verify('FEED_AFTER_RETURN_TO_STORE',tl);found++;
 }
}
if(found<2)throw Error('No sample found');
```

### D. #77 修正複驗及新的無事件蟻后替換

檔名：`review77-followup.ts`

```typescript
import {buildDay0} from './cli/lib/day0.ts';
import {loadBundle} from './cli/lib/load.ts';
import {simulateWorldDay} from './engine/index.ts';
import {checkPopulationDay,populationSnapshot} from './engine/invariants.ts';
import {replayPopulationDay} from './cli/lib/population-replay.ts';
const b=loadBundle(),s=buildDay0('A1',1,'2027-09-23',b).state,before=structuredClone(s.colonies[0]),o=simulateWorldDay(s,b),after=o.state.colonies[0],ev=o.result.colonies[0].events;
function inspect(name:string,a:any,e:any[]){let engine='ACCEPT';try{checkPopulationDay(populationSnapshot(before),a,e)}catch(x){engine=String(x)}console.log(JSON.stringify({name,engine,reader:replayPopulationDay(before,a,e)}));}
inspect('CONTROL',after,ev);
const dead=structuredClone(after);dead.population.queen_alive=false;inspect('OLD_F1_FOREIGN_QUEEN_DEATH',dead,[...ev,{type:'queen_death',id:'OTHER_COLONY_QUEEN'}]);
const swapped=structuredClone(after);swapped.queen_id='OTHER_COLONY_QUEEN';inspect('ALIVE_QUEEN_ID_SWAPPED',swapped,ev);
const a4=buildDay0('A4',1,'2027-09-23',b).state;a4.colonies[0].population.brood[0].age_days=-3;try{simulateWorldDay(a4,b);console.log('OLD_F3_NEGATIVE_AGE ACCEPT')}catch(e){console.log('OLD_F3_NEGATIVE_AGE REJECT',String(e))}
a4.colonies[0].population.brood[0].age_days=null;try{simulateWorldDay(a4,b);console.log('NULL_BROOD_AGE CONTROL ACCEPT')}catch(e){console.log('NULL_BROOD_AGE',String(e))}
console.log('NULL_EVENTS',replayPopulationDay(before,after,null as any));console.log('NULL_START',replayPopulationDay(null as any,after,[]));
const bs:any=structuredClone(before);bs.population.brood=[{id:'REVIEW_EGG',stage:'egg',age_days:0,progress:0}];const be:any=structuredClone(bs);be.population.brood=[];for(const w of be.population.workers)w.age_days++;
for(const order of [['hatch','brood_death'],['brood_death','hatch']]){const events:any[]=order.map(type=>({type,id:'REVIEW_EGG'}));let engine='ACCEPT';try{checkPopulationDay(populationSnapshot(bs),be,events)}catch(e){engine=String(e)}console.log(JSON.stringify({name:'OLD_F2_RECHECK',order,engine,reader:replayPopulationDay(bs,be,events).ok}));}
```

### E. main 的發育分布控制實驗

檔名：`review-development.ts`

```typescript
import {buildDay0} from './cli/lib/day0.ts';
import {loadBundle} from './cli/lib/load.ts';
import {resolveBundle} from './engine/params.ts';
import {developBrood} from './engine/brood.ts';
const bundle=loadBundle(),sp=Object.values(resolveBundle(bundle).species)[0],s=buildDay0('A1',1,'2027-09-23',bundle).state,c=s.colonies[0];
c.population.brood=Array.from({length:20},(_,i)=>({id:`REVIEW-E${i+1}`,stage:'egg' as const,age_days:0,progress:0}));
const eclosionDays:number[]=[];
for(let day=1;day<=60&&eclosionDays.length<20;day++){
 s.sim_day=day-1;const ev:any[]=[],summary:any={brood_deaths:0,hatchings:0,pupations:0,eclosions:0};
 developBrood(s,c,sp,{nest_temp_model_c:28} as any,{sFraction:1,pFraction:1} as any,ev,summary);
 for(const e of ev)if(e.type==='eclosion')eclosionDays.push(day);
}
console.log(JSON.stringify({fixture:'20 initially identical eggs, 28 C, full nutrition, continuous worker care; isolated development module, not official world',n:eclosionDays.length,days:eclosionDays,uniqueDays:[...new Set(eclosionDays)],development:sp.development}));
```

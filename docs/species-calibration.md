# 物種設定、參數分級及校準計畫

## 物種選定已更新（2026-11-01；Day6起適用）
**本世界主蟻群已由玩家正式指定為熱帶大頭家蟻（Pheidole megacephala）**。權威物種規格見[species-pheidole-megacephala.md](species-pheidole-megacephala.md)，文獻R93–R101。這是**虛構模擬物種選擇**，不是現場標本鑑定；Day5以前各節的`species_taxon=null`、不預設major與特定費洛蒙是**舊研究基線**，從Day6起以新物種覆蓋，但個體形態、巢內實測溫濕與量化速率仍未知。

## 物種識別（以下為2026-10-31歷史基線，已被上述新選擇取代）
已知只有「黑色、地棲、單蟻后創巢敘事、住宅花園」；這不足以推定 `Lasius niger`、`Camponotus`、`Tetramorium` 或其他屬。**species_taxon=null**。已證實巢內有卵與工蟻，只能把「Q001可生殖」列為敘事事實，不等於完成分類鑑定。

## v2 最小生態類型（占位，非物種）
- 黑色地棲、單蟻后、中小型群體、廣食性搜尋者：只作敘事初始條件。
- 不預設蟻兵階級、專職護士、真菌農業、蟻群截肢醫療、可儲蜜罐蟻或大規模軍團攻擊。
- 不預設固定工蟻壽命、蟻后壽命、殖群上限、理想巢溫、產卵週期、成熟所需確切天數。
- 蜜露／昆蟲碎屑等食物利用是過去**故事確有描寫**，但數量是遊戲抽象單位。

## 參數分級
1. `observed_in_story`：歷史事件和故事中的相對距離、工蟻編號、當前14隻。
2. `literature_species_specific`：有研究支撐、必須標示研究物種與條件。如 `Lasius niger` 創巢工蟻成熟約42天**僅作示範**。
3. `model_assumption`：為了運行而自行選擇的機率分佈或步長；需明列名稱、版本、可修改。
4. `unknown`：尚無證據；保持 null。世界中的未知不是0，也不是自動「普通／安全」。

## 真正需要校準的資料
- 分類：清晰外觀、工蟻體長／生殖個體差異、築巢環境；由專業識別或參考地區蟻類名錄取得候選種。
- 工蟻：壽命與齡級、行速、載重量、嗅覺追跡行為、傷勢恢復／感染率、日夜活動。
- 蟻后：繁殖階段、卵巢活動、環境對產卵的影響、交配型態。
- 幼體：每個齡期在不同溫度與食物下的天數及生存機率。
- 生境：溫濕、土壤排水、每日雨勢、植物生長／蜜露再生、競爭與掠食者活動。
- 經濟：將舊糖／蛋白質抽象單位轉成可量測單位需要另做食物組成、品質、含水量與消耗率映射；沒有數據時不得轉換。

## 校準優先次序
P0：時間與歷史橋接、工蟻數／幼體守恆、科學不確定性、局部知識、飢餓與水分風險。
P1：幼體生長日尺度、工作切換、費洛蒙衰退、食物品質與有限補充、巢內微氣候。
P2：具體物種參數、季節、精確體重／營養攝入、病原／寄生蟲與其他蟻群互動。
P3：以文獻或專家資料進行敏感度測試、蒙地卡羅多次模擬與反事實比較；未完成不得宣稱預測準確。

## 如何評估「更真實」
- 用物種化時間尺度防止 20 分鐘卵→蛹→成蟻。
- 同一批起始種子可追查結果，環境單次觀察不會變成所有工蟻的全知。
- 工蟻工作比例會隨環境改變，不因其編號而固定。
- 危機能出現損失或消退；食源可能消失，不依玩家意願出現新糖源。
- 先有觀察／遭遇／暴露，才有結算與敘事；無事發生同樣有效。
- 一致性強不等於科學準確；若缺特定蟻種資料，結果應明示不確定性。
## 2026-11-01 雄蟻、gyne與工蟻形態分化校準
參照[castes-and-reproduction.md](castes-and-reproduction.md)及[references.md](references.md) R49–R61。要分清**性別、發育階級和現有任務**。優先收集：工蟻頭幅／體長分布，是否具有minor/major／連續形態；卵與幼蟲分期／營養條件、性別或受精證據、產卵者與蟻后交配狀態；本物種是否季節性產生雄蟻／有翅新后及婚飛生態。缺失時`adult_worker_subcaste=null`、`brood_sex=null`、`future_developmental_caste=null`、`reproductive_maturity=null`。**不直接沿用Pogonomyrmex badius約700工蟻的成熟門檻**，不因本殖群14工蟻就宣稱精確幾天後必有雄蟻。

## 2026-11-01 產卵速度與巢穴工程校準
依[queen-brood-growth.md](queen-brood-growth.md)、[nest-construction.md](nest-construction.md)與R62–R78。優先校準：本蟻種形態／分類，Q001巢內實際溫度與營養、產卵／幼體階段實測追蹤、照護工蟻接觸、個體存活／發育速率；另有N00土壤粒徑、含水率、黏聚性、巢室體積、孔隙CO₂/O₂、搬土負載、土粒來源去向、工蟻齡級與傷勢。沒有這些資料，`egg_rate_per_day=null`、`stage_duration_days=null`、`nest_soil_mass_mg=null`、`construction_rate_cm3_day=null`，**不得挪用他蟻數字填上**。

## 2026-11-01 探索與未知生態校準
參照 [exploration-dynamic-ecology.md](exploration-dynamic-ecology.md) R79–R92。需要鑑種、個體體長與腿長、溫度／濕度與負載、不同基質短距錄影測量`walking_speed_mm_per_s`，用路徑標記算`actual_path_length_cm`、`max_nest_distance_cm`、轉向分布、有效搜索覆蓋與每趟外出時間。沒有資訊就null，不能直接抄`Temnothorax`的8.3mm/s或樹棲`Cephalotes`的4.39cm/s。外界食物、昆蟲、蜘蛛、異巢蟻、人類干擾發生率也不具本場地真實統計，`stochastic_event_rates=null`。

## 2026-11-01 Pheidole megacephala校準里程碑
研究種已選定：工蟻minor/major雙態、二通道招募費洛蒙（濃度未知）、口對口分食能力、雜食、通常多蟻后也有單后創巢報告。R94廣西實驗室28±1°C、70±5%RH卵孵化7.69±0.63天，非繁殖卵至成蟻28.73±2.83天、繁殖37.60±3.20天，**只能作實驗參考，不能等同本巢實際發育速度**。待校準：W004–W017實際體型、Q001卵巢活動／交配與產卵日率、巢內溫濕、卵E001／幼蟲L001-L002生理齡、食量／嗉囊與訊號濃度、工蟻走速、巢內結構；沒有資料保持null。

## 2026-11-01 進階12系統與費洛蒙證據更正
優先讀[pheromone-model-evidence.md](pheromone-model-evidence.md) R102：P. megacephala雖有招募行為，**兩種招募分子的物質數量未被唯一證明**；應並列single/dual模型、化學成分數null。參照[advanced-ecology-integration.md](advanced-ecology-integration.md) R103–R114，病毒序列存在不等於病症或病死率、互利研究種的介殼蟲不等於Fxx已鑑定、獵物捕捉率／工蟻休息比率／神經記憶退化／巢群競爭／蟻道擁擠均需本地資料。除已知機制的**可能性**外，所有`infection_rate`、`mortality_rate`、`worker_idle_fraction`、`prey_catch_probability`、`traffic_flow`、`hemipteran_abundance`為null。

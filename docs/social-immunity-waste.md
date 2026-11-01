# 《螞蟻帝國》v2｜感染、社會免疫、屍體與廢棄物

**2026-11-01科學增補，自Day6（2026-11-05）起**。本主巢是虛構台中西屯花園的熱帶大頭家蟻`Pheidole megacephala`，只有14隻已存活工蟻、Q001、卵E001與幼蟲L001/L002。**規則新增≠當前已感染或多了一具屍體；Day5維持120h。**

## 疾病：病原存在 ≠ 暴露 ≠ 感染 ≠ 症狀 ≠ 死亡
- [R103] 2025年於臺灣25個、夏威夷47個熱帶大頭家蟻殖群採集，描述5種新RNA病毒（PmV1–5）。臺灣採樣殖群中有17/25至少一種病毒檢出；此是**特定野外樣本PCR／病毒序列檢出**，**不是我們的虛構N00感染率或每日死亡率**。研究未證明檢出即有病症或致死。大型／小型工蟻間檢出差異未達顯著，不能按形態設定「major免疫」。
- 本種的個體`exposure_status`、`infection_status`、`clinical_symptoms`、`pathogen_identity`、`individual_shedding`、`mortality_hazard`均為`null`；**不是false也不是零**。歷史W007/W008/W009/W012/W013/W014的舊傷不自動判細菌感染。
- 只有具來源的感染情境（接觸到被具體化且可能被污染的基材／食物／異巢個體／遺體）才可能登記**病原暴露**；感染轉換仍需要證據或**明確標`uncalibrated_scenario`**，沒有病原株與感染劑量實測時不可計算確切傳染率／潛伏日／死亡率。
- 交換食物、同巢梳理、觸角接觸可形成**潛在接觸邊**，但**接觸不等於感染**；同一接觸事件用[ant-communication.md](ant-communication.md)的event_id參照，不虛構第二次接觸 [R104,R111]。
- **社會免疫**：個體梳理、互相梳理、避開危險物、減少接觸、屍體搬移或幼體重新放置可改變暴露機會 [R104,R106]，是否成功取決於物種、個體在場、實際動作與環境，不保證能消滅病原。
- **巢內病原與資源是不同帳**：沒有食物入庫不直接產生感染；有傳染疑慮也不直接宣告全巢停工／死亡。蟻后Q001是否受到暴露要有真實接觸鏈，不能群體染病時自動染后。

## 清潔、遺體與垃圾
- [R105] 在`Myrmica rubra`研究中，允許正常搬走屍體的殖群，成年個體長期存活優於受限殖群。這是**其他物種**，作為可能的衛生防線，不推算P. megacephala的數值效果。
- 若此後工蟻死亡，原本工蟻活體數減一，建立具唯一`cadaver_id`的**實際遺體狀態**（位置、死亡來源、相對時間、腐敗／污染未知）。遺體搬到垃圾點只是從巢內移到別處，不會讓死亡次數再加一次，也不憑空產生外部蛋白食物。
- 已存在歷史死亡W001/W002/W003，**屍體目前位置／是否處理未知**；此次研究**不倒填三具還在N00的屍體**。
- 排泄物、獵物殘渣、泥土與食物垃圾分開記；可建立垃圾堆`midden`但需工蟻確實搬運和位置證據。對其他類群切葉蟻的**特殊垃圾室**不能當本蟻標準建築 [R112]。
- 垃圾管理與[nest-construction.md](nest-construction.md)有位置／能耗對帳、與[foraging-food-economy.md](foraging-food-economy.md)有屍體和殘渣來源守恆，與健康模型有可能暴露但**無校準不自動生病**。

## Day6事件鏈
`environment pathogen source (if instantiated) → actual encounter/contact → potential exposure → (conditional) colonization/infection → (conditional) symptoms → possible grooming/avoidance/isolation/care → recovery/stable/death`。每步記**證據等級**，新事件可以是零。
`confirmed death → single cadaver → local detection → pickup → carry with transport cost → deposit → persistent decay/cleanup`。沒有已確認新死亡，屍體新建清單保持空。

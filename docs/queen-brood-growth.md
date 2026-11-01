# 《螞蟻帝國》v2｜蟻后產卵、幼體發育、工蟻補充與殖群成長

> 科學規則研究日期：**2026-11-01**；**自遊戲 Day6（2026-11-05）起生效**。Day5（2026-11-04、120小時）事件、Q001、14工蟻、E001與L001/L002、v1第1150分鐘一概不改。這是文字情境推演的**文獻支持機制**，非已完成校準的種群動態計算程式。
>
> 蟻種`null`，體型、交配生理、餵食mg、卵巢成熟、巢室實測溫濕、幼蟲真實齡期不明。不得把研究的數值、品種或環境硬套西屯虛構花園蟻。文獻 [references.md](references.md) R05、R06、R08、R09、R23、R49–R61、R62–R68。

## 1. Q001不是一台固定「每天產卵X顆」的機器
文獻已確認以下方向：
- **蟻后個體與照護社會環境**：Formica fusca實驗分高低產卵組，初始平均0.6±1.2或16.0±7.3卵／日，較大的工蟻照護群使蟻后實驗期產卵總數增加 [R63]。那些數值是**研究蟻后群組**的分組結果，不是Q001產卵率，也不代表14工蟻足以使Q001日產16卵。
- **巢內實際溫度和季節**：Linepithema humile實驗不同溫度改變產卵率，在研究條件下28°C最高 [R64]；Cataglyphis niger的降溫抑制產卵，升溫可恢復，已存在的卵也可能因冷卻而消失（論文推測被工蟻吃掉，未必直接目擊每一顆）[R65]。這**不等於**臺中市預報白天30°C=巢內30°C，也不等於本蟻28°C最適。
- **餵養與生命階段**：創巢蟻后可能使用體內儲備照顧首代幼體；第一批工蟻出現後，部分物種蟻后的育幼行為減少，由工蟻接手 [R62,R66]。本巢已14工蟻，**不能重新當作剛交配且0工蟻的創巢蟻后**。
- **熱壓力**：Lasius niger在2026年研究中，創巢後急性熱壓力降低創巢成功與後續工蟻產出 [R68]；不把實驗的極端溫度或死亡率給本虛構蟻種。
- **營養供給和照護容量**：前述食物規則中食源、分食、幼蟲處理與維生代謝會直接影響可供繁殖的能量；缺實體庫存時，不可以從「Day5沒有確認新入巢食物」直接判Q001已停止繁殖／死亡。
- **工蟻與雄蟻／gyne命運**：卵的受精和階級分化依前述[castes-and-reproduction.md](castes-and-reproduction.md)；未知的E001性別保持null，不能因繁殖壓力改成雄蟻。

## 2. 三種時間尺度，不把卵直接跳成成蟻
- **分鐘／小時**：Q001與工蟻接觸、營養交換、幼體搬移、短期溫濕刺激；不是每20分鐘必產卵。
- **日**：產卵可能性、幼體生理發育的環境積分、照護與蛋白質可得性、卵存活及可能的卵食現象（必須有事件因果）。
- **數日到多週**：卵→幼蟲→蛹→羽化，可能因體型、物種、季節、遺傳及養育者條件產生不同速率與死亡。
- **重要文獻的正確讀法**：Konu et al. 2023在23°C的Lasius niger創巢研究，**從採集蟻后時刻**起，首批幼蟲約第18天、首批蛹約第25天、首批成蟻到能行走約第42天 [R62]。**這不是從同一顆卵產下那刻起算42天的統一孵化倒數**；起始蟻后年齡和本巢既有幼蟲的生理齡也不同。
- **照護者影響幼體**：一項跨巢移養研究顯示，幼體存活及發育速度受卵來源、工蟻照護群體來源影響 [R67]；應模擬「孵育適合度與育幼接觸」，而非單純每滿7天化一次蛹。

## 3. 個體守恆與實際繁殖速度
對任一日：
`eggs_end=eggs_start+new_eggs-egg_to_larva-egg_deaths-egg_eaten`
`larvae_end=larvae_start+egg_to_larva-larva_to_pupa-larva_deaths`
`pupae_end=pupae_start+larva_to_pupa-pupa_to_adult-pupa_deaths`
`workers_end=workers_start+eclosed_workers-worker_deaths-worker_departures+confirmed_worker_immigration`
雄蟻與gyne另帳，不能把雄蟻直接算入「存活工蟻」。如果有捕食／遷徙，須明確因果；現有w1死亡史不可倒改。

**繁殖率三個不同指標**：
1. `oviposition_rate`＝新產卵數／有觀察時間；未校準則null，不因某日0卵把長期產卵能力設成0。
2. `brood_survival_fraction`＝有起點和終點的同批幼體實際存活比例；未測或跨階段資料不全就null。
3. `net_colony_growth`＝存活工蟻數變化；既有主巢14工蟻，不等於「Q001在這120小時新生14工蟻」。

## 4. 各個體必須保留的狀態
- Q001：`oviposition_recent`（有證據才有事件數）、`ovarian_state=null`、`mated_status`（歷史設定假設）、`stored_sperm=null`、`nutrition_received_mg=null`、`water_intake_uL=null`、`individual_temperature_exposure=null`、`worker_care_contacts`（只有事件才計數）、`care_capacity=null`。
- E001：`laid_day=2`、`known_v2_elapsed_days=3`、`real_stage_age_days=null`、`sex=null`、`brood_care_exposure=null`；**不能直接從生理年齡未知推算Day6一定孵化**。
- L001/L002：已在v2記錄5個模擬日，但**原本幼體的生理齡未知**；階段成熟門檻未校準，不會被公式硬推成蛹。
- 新卵／新蛹／新成蟻：必須先有產生該階段的因果事件，並用唯一ID與出生／階段日期；不能缺一階就直接羽化。
- `fecundity_capacity`、`egg_survival_rate`、`min_development_days_by_stage`、`thermal_degree_days`都為null，除非先具物種與巢內溫度數據；城市天氣不提供巢室生理累積溫度。

## 5. Day6起每日推演順序（與食物、信號、巢穴耦合）
1. 取得有時戳的西屯／臺中區域天氣（預報或觀測依日期），不得當作巢溫。
2. 更新[foraging-food-economy.md](foraging-food-economy.md)食物供給、實際採入、巢內分享、個體營養；未量測保留null。
3. 更新[ant-communication.md](ant-communication.md)局部接觸、蟻后化學訊號與工蟻接收；不全巢廣播。
4. 更新[nest-construction.md](nest-construction.md)巢內育幼室通風、濕度、完整性、幼體所在位置與照護者通達性。
5. 用上述實際可得證據決定Q001當日產卵情境，**不使用固定X顆/天**，可有0卵、多卵、停產或遭逆境；沒有資料時即使情境抽樣，也須標`model_assumption_uncalibrated`。
6. 各幼體按個體／階段、發育齡和實際局部環境逐步更新，營養不足可能影響存活，但未知攝入不能硬判死亡。
7. 成蟻羽化若成立，加入對應工蟻／雄蟻／gyne分類計數，伴隨實際存活／死亡守恆；也更新下回合巢穴空間壓力。
8. 日終記錄`egg_events`、`brood_stage_events`、`nutrition_constraints`、`care_events`、`nest_conditions`、`worker_eclosions`、`daily_births_deaths`和模型種子；**不是將未知直接轉成0**。

## 6. 研究規格修改不是模擬事件
目前Q001×1；存活工蟻W004–W017×14；E001×1，L001/L002×2，蛹0；Day5已完成120小時；本次不新增卵／成蟻，不改舊v1 1150分鐘紀事。更新只新增未來日子可用的狀態欄位，未測量物理量均null。

### 不得出現的科學錯誤
- ❌ 將Formica fusca每日16卵照搬Q001；或拿Argentine ant 28°C最適解釋西屯巢溫。
- ❌ 把Lasius niger「採集蟻后至能行走首工蟻42天」當本巢每一顆卵產下後42天計時器。
- ❌ 因新幼蟲未確認真實齡級，忽然在Day6「升級為蛹」或「瞬間羽化」。
- ❌ 單純缺食物就判立即全滅／必然停產，沒有儲糧／代謝資料不可硬算。
- ✅ 允許連續數日無新卵、階段暫不變、部分幼體死亡或蟻后改變照護；每一結果都須有環境與個體事件鏈。

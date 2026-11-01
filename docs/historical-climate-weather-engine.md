# 臺中實際地點 × 歷史氣候生成虛擬天氣｜長期世界引擎 v1

> **玩家決議（2026-11-01）**：蟻群維持在**臺中市西屯區這個現實行政地理區域**中的**虛構獨棟別墅花園**，遊戲日期、季節與模擬物種沿用原設定；未來即使現實一天內連續推進數十／數百遊戲日，不能把當下七天預報重複當成不同日期的天氣。從**Day9（2026-11-08）起**正式啟用「觀測／預報／歷史氣候虛擬天氣」的單一選擇器。此文件更新**不推進Day8或重演既有天氣/事件**。

## 1. 資料事實（引用，非模擬器自行捏造）

- 官方氣象基準：**中央氣象署臺中站**。1991–2020年氣候值：年均氣溫23.3°C、年降水量1773.0mm、年雨日113.7天，官方[臺中站介紹](https://etour.cwa.gov.tw/station_inpage.php?stn_id=8)。氣象署[測站統計](https://climate.cwa.gov.tw/MeasuringObservation)說明1991–2020為30年氣候統計基準；[CODiS地面觀測](https://climate.cwa.gov.tw/GroundObservation)可查歷史日、月、年氣象站資料。
- 更細的**12個月區域統計**來自臺中市政府都市計畫報告**表6-1**（引用CWA 1991–2020臺中地區月平均氣溫、濕度、降水、風速）。結構化權威資料為[臺中氣候基準JSON](../data/taichung-climatology-1991-2020.json)。11月該表月平均氣溫22.6°C、月平均雨量23.8mm；12月18.7°C、30.5mm。**這些是30年氣候平均，不是2026/11/08預報或實測！**
- 臺中市府表按12個月合計1762.8mm、年均氣溫23.7°C，而氣象署站頁年平均1773.0mm、23.3°C，兩份資料存在小差異：**保存各自來源與統計口徑，不混寫成一份完全一致的資料**。113.7年雨日沒有對應官方分月雨日表，**不把月雨量÷降雨天數當實際分月降雨機率**。
- 場景不具有真實門牌／GPS，臺中站的溫雨不能直接當作西屯私人花園土壤或N00巢溫實測；`site_temperature_c`、`actual_soil_moisture_percent`、`actual_water_depth_mm`仍須區分未知。

## 2. 統一選擇器：每個遊戲日只選一種天氣來源（Day9起）

1. 以原曆日錨點 `Day1=2026-10-31` 計算遊戲日，**不管現實一天按了幾次「繼續」**；不會因現實時間自動模擬。
2. **歷史日期**：若遊戲日期已過且能取得完整、時間有效的地面**觀測**，使用`observation`；不完整時標註部分觀測及缺項，無可靠完整資料轉入虛擬氣候情境。
3. **現實當日／未來且在有效預報時段**：取得有發布時間與覆蓋時段的中央氣象署**預報**，標為`forecast`；只有預報實際涵蓋該遊戲日、已過期或資訊不足時，不可假裝有預報。若較長遊戲日只有部分時段被預報覆蓋，要註明半日缺漏並分段選模式，不將前一時段預報延用整日。
4. **未來超出可靠預報／外部資料不可取得**：使用`synthetic_climatology`，依真實臺中月平均與可重播的連續性抽樣**生成當日虛擬天氣**；這是玩家指定的長期遊戲路徑，`generated`值不是當日真實天氣、不是天氣預測。
5. **資料衝突**：同一時段只採一個權威`weather_kind`；需要覆蓋早晚不同來源時以`segments`保存，每段都要有`source_kind`、`valid_time`、`derived_from`，當日彙總標為`mixed_provenance`。不重複累加任何雨量。
6. 天氣快照一旦隨Day N的生態結果完成並入journal與world-state，**不因現實日期後來過了Day N就用新的觀測重演/覆寫歷史事件**；新資料可附`posthoc_comparison`，但與故事世界當日天氣分離。
7. **跨模式接續**：由預報轉為合成或再轉回預報時，保留巢口已知澆水、前日降雨/土壤**情境狀態**與資料可信度；缺量測則不強行把前日「預報晴」改成「實測沒雨」。

## 3. 不會逐日獨立亂抽：季節分布與連續天氣（算法契約）

日生成器固定 `climate-generator-v1`，採`year/month/day`、上一日已封存天氣/環境情境與獨立命名seed生成，並保存輸入、抽樣、模型版本。沒有完整逐日數據之前，以下係數是**明確標為`model_assumption_uncalibrated`的情境假設**，不得稱為臺中真實統計值。

**3.1 日基準：** 從[data JSON](../data/taichung-climatology-1991-2020.json)逐月的30年氣候平均（氣溫、雨量、濕度）選取對應季節，月中/跨月時用相鄰月份的中點做平滑內插（12→1採循環），避免11/30→12/1氣溫突然跳。每年日曆含閏年及月份天數，固定台灣時區。

**3.2 降雨日／晴雨連續性：**
- 建議模型用月別先驗`p_m`：分月雨量`R_m`、每月日數`d_m`、年雨日參考`113.7`，按`w_m = (R_m/d_m)^0.60`，以二分法求`k`讓 `Σ_m d_m·min(0.85,k·w_m)=113.7`（如資料不完整則先驗未知，不硬補0）。**0.60與0.85只是模型設定，不是雨日數科學定律**；月雨量**不等於**月雨日機率。
- 季節起伏的`p_base`是**演算法假設**。為避免每一天獨立互斥，下雨持續係數初始`ρ=0.45`（未校準），定義`P(wet_t|wet_{t-1})=p_base+ρ(1-p_base)`、`P(wet_t|dry_{t-1})=p_base(1-ρ)`，兩者不同，讓連續陰雨／乾燥有機會持續；跨月`p_base`可緩變。前一天`unknown`時用`p_base`先驗抽樣，不將「未知」當「沒雨」。
- 只有已抽中`wet`時才抽模型雨量；可用形狀參數`gamma_shape=1.6`的**假設**分布，均值`R_m/(d_m·p_m)`，缺資料則生成**定性有雨**並將`synthetic_rainfall_mm=null`。未抽中`wet`的**模型日**`synthetic_rainfall_mm=0`，但`observed_rainfall_mm`仍null。極端雨/颱風另有「特殊事件」前提和資料校準，不能每回合憑空造已發生2026年颱風。

**3.3 溫濕與天氣連續性：** 月均氣溫`T_m`加上相關日距平：`A_t=0.65·A_{t-1}+ε_t`，暫定`ε_t~Normal(0,1.8°C)`；濕雨冷卻偏差`-0.8·(wet_t-p_base)`（全為**未校準模型係數**）。月均濕度`H_m`按當日wet/dry、前日濕度狀態形成虛擬RH，再做0–100%界限檢查。生成溫度是`synthetic_daily_mean_air_temperature_c`，若無可信日較差模型，**日高低溫保持null**，不能直接從月均溫偽造逐日高低溫。

**3.4 雨水／土壤／巢室記憶：** 前日下雨／澆水→次日土表殘餘濕潤與排水，晴熱→蒸發、遮蔽處可較久潮濕。將`model_surface_wetness_index`與`model_shaded_soil_memory_index`當作**0–1無單位的虛構模型變數**，不等於土壤含水率％或巢室實測值；可以`clamp(0,1,0.75·I_prev+rain_input+irrigation_input-evap_loss)`更新，但0.75與所有轉換係數需標記未校準。**在Day8結束沒有數值實測時不回填Day8指數**：第一次合成日要用`initialization_source=climatology_prior_and_day8_qualitative_water_event`，單獨標記`unverified_initial_condition`，不冒充已量過花盆含水量。
- 城市雨量或虛擬雨量只有在水滴／遮蔽／排水／巢口結構相容時才可影響巢內淹水；不能見到`wet=true`就自動淹巢、孵化、餓死。
- 所有生態連動（蚜蟲、花蜜、真菌、蜘蛛、競爭蟻、工蟻出勤、卵發育、代謝）先接收**天氣條件/局部感知**，再依物種規格和實際模擬事件推演；**研究資料不足仍為unknown**。

## 4. 每日日誌及GitHub存檔契約（不可省略）

每日主天氣物件必有：`sim_day`,`calendar_date`,`timezone`,`weather_kind`（`observation|forecast|synthetic_climatology|mixed_provenance|unknown`）, `source_urls`, `forecast_issue_time`（若適用）, `climatology_period`（若適用）, `station_or_coverage`, `seed_and_draws`（只有合成時）, `previous_day_weather_ref`, `model_assumptions`,`synthetic_weather`,`actual_observations`,`microclimate`,`irrigation_events`, `unverified_parameters`。不適用者為null，不可擅把未知改成0。

- `saves/world-state.json#/weather/latest_external_reference`：**已完成Day8的最後外部預報引用不改**（其日期/issued_at仍11/7）；新的`#/climate_engine`是**待Day9啟用的規則與30年基準引用**，不是某天虛構天氣成果。
- 每次新推進後：`world.weather.active_date`、`world.weather.last_weather_driven_sim_day`、`latest_external_reference`或`latest_daily_weather`及`day_log_latest.weather`必須指**同一個已完成Day N與來源種類**。舊`forecast_temperature_range_day_c`等欄只適用mode=forecast，否則應設null或轉到不可變歷史索引，**禁止合成日遺留舊預報溫度**。
- `main.simulation.weather_policy_ref`指本規格，`weather_rules_effective_sim_day=9`，原Day8天氣及事件原封不動；下一次使用者說「繼續」才會真的算Day9。
- RNG：天氣單獨`weather_climate`命名子流；更改工蟻/地圖人口不能改變同一個日期已封存的天氣抽樣。抽樣輸入包括氣候表版本、上次天氣狀態摘要、明確氣候生成器版本和seed。不同`seed`可帶來不同天氣歷史但都須保有季節規律，不能拿平均值當固定每日值。
- 若需要實際校準降雨日轉移、雨量尾端/溫差、日較差、土壤水分，就從[CWA CODiS歷史逐日資料](https://climate.cwa.gov.tw/GroundObservation)取得**原始年份與站碼/樣本量**後再替換模型參數；未擷取不可宣稱已驗證日分布。
- 外部服務故障不阻止玩家連續模擬：只要已保留12個月氣候基準與版本，就可自動用`synthetic_climatology`推進，日誌註明source fallback；**不用每天要求玩家重新選晴雨**。

## 5. 測試案例

| 情境 | 必須通過 |
|---|---|
| 現在Day8、192h（11/07） | 規則設定時不推進Day9，Day8最後預報、園丁澆水、E002/E003、U01及巢群數完全不變 |
| 現實仍11/1、遊戲11/8 | 若11/8沒有有時間戳與有效時段的可靠官方預報，改生成`synthetic_climatology`；不得把11/7預報直接貼過來 |
| 11/30→12/1→12/31→1/1 | 用月中插值平滑進入冬季，日雨量/溫度連續記憶保留，不能在月界無因突變 |
| 連續推進100/365天 | 有天氣與獨立seed，源資料快照一次取得可離線沿用，不要求每次連網，天氣影響可透過土壤、覓食、繁殖累積 |
| wet/dry天氣串列 | 相鄰天的條件機率不同，連續乾旱/雨天可能發生，總雨水記帳一次；未經量測的指數不寫成百分比 |
| 降雨機率與雨量 | `forecast_pop_percent=0`不等於觀測無雨；合成`rain=0`不是實測0；`null`不是0 |
| 極端事件 | 颱風、暴雨、巢淹、蟻死亡必有對應前提，不能因存在季節氣候模型就預定發生 |
| 天氣種類與凍結 | 每日`observation/forecast/synthetic`來源註明且封存、日誌不倒轉；外部資料後來更新不能回頭改Day8 |
| 數值校準 | 1991–2020月均表有12月，月雨量總和1762.8mm；分月雨日及日死亡風險未取得保持null |
| 資料狀態一致 | 完成Day N後`weather.active_date`、`last_weather_driven_sim_day`、日誌、world/master皆指向Day N，無陳舊的Day5/Day4快取 |

## 6. 性能與存檔

氣候分支只產**一個共同花園每日天氣過程**，巢群數從14長到上萬不需重複為每一隻螞蟻抽天氣；每個巢的遮蔽、水分、風險及工蟻可達路線仍需局部計算。日誌以**天氣快照＋增量環境事件**保存，不新增每日巨量個體逐分鐘資料。所有天氣對生命週期的效果使用`docs/colony-demography-scaling.md`、`docs/simulation-engine.md`及物種來源，不因規格更新立即觸發死亡/羽化/新卵。

**這是可從Day9照規格運行的無程式碼模擬契約；repo本身並非已完成且量測驗證的氣候模型執行程式。**

# 研究紀事｜2026-11-01：真實臺中地理與歷史氣候虛擬天氣

玩家決定：**現實地理為臺灣臺中市西屯區，世界中的別墅花園仍為虛構；遊戲在現實同一天可以連續推進多日，不必受氣象署七天預報限制**。

## 檢查現況

- 2026-11-01的現實時間，遊戲已在Day8/2026-11-07/192h，仍採11月1日05:00發布的臺中市一週預報；**沒有任何預報能讓遊戲直接得知2026年12月實際逐日天氣**。
- 既有`world.weather.latest_external_reference`記Day8正確，但`weather.active_date=2026-11-04`、`last_weather_driven_sim_day=5`、舊forecast溫度範圍依然殘留Day5快取，需修正一致性。
- 氣象署可查1990年起歷史觀測，1991～2020為30年統計基準；官方臺中站1991～2020年平均雨日113.7、平均溫度23.3°C、降水1773mm。臺中市政府引用CWA 1991～2020資料整理每月均溫/雨量/濕度，已用12行建立結構化版本。`11月22.6°C/23.8mm`，`12月18.7°C/30.5mm`；不是未來實際氣溫或降雨。
- 兩個來源的年均數字存在些微差異，資料JSON標明來源及差異，不把它們錯誤宣稱完全一致。

## 本次不改動歷史事件

新增`docs/historical-climate-weather-engine.md`與`data/taichung-climatology-1991-2020.json`，更新氣象規則、推演順序、存檔稽核及README。存檔只加`climate_engine`**待Day9生效**的模型狀態與修正Day8快取，**不更新Day8 journal/day_log_latest**。

未來每日先取有效實際觀測或預報；當遊戲前進到未來超出預報範圍時就以30年臺中氣候平均＋明確標示的未校準季節/連續性模型生成一日虛擬天氣。全部合成數值以`synthetic`標記，非測得事實；舊Day8園丁局部澆水可當**定性前日記憶**，不能倒填成實測水量。地表記憶與蟻巢微氣候分層，不把「區域預報晴」等同巢內乾燥。

## 來源

- [中央氣象署：臺中氣象站](https://etour.cwa.gov.tw/station_inpage.php?stn_id=8)。
- [中央氣象署：歷史地面觀測](https://climate.cwa.gov.tw/GroundObservation)。
- [中央氣象署：1991–2020測站氣候統計](https://climate.cwa.gov.tw/MeasuringObservation)。
- 臺中市政府都市計畫公開文件，`表6-1 臺中地區歷年氣象資料統計表（1991–2020）`，來源網址由`data/taichung-climatology-1991-2020.json#/provenance/monthly_values/url`保留。

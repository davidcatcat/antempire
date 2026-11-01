# 《螞蟻帝國》可執行單日程式

`day_engine.cjs`為Node.js CommonJS、無第三方套件，確實執行固定種子的歷史氣候生成、食源可及性、工蟻個體覓食、環境事件及蟻后產卵**情境抽樣**。範例：`node sim/day_engine.cjs < sim/results/day9-input.json`。輸出必須與`sim/results/day9.json`相符。

**尚未實作的部分**：由程式自動完成主世界JSON異動、能量代謝的mg/mJ定量結算、巢內微氣候、完整連續生命史、大群上萬隻稀疏cohort等。Day9世界與人口存檔是ChatGPT按程式輸出和既有科學規格做因果更新及守恆檢查後提交。**所有目前概率係數均屬未校準虛構情境，非蟻種實測發生率**。下一日要使用前一天持久化的氣候記憶，不可重用Day9靜態輸入。

# 《螞蟻帝國》v2｜蜜露互利網與真正的捕獵—處理—搬運

**2026-11-01新增，Day6起有效**。物種`Pheidole megacephala`、地點虛構臺中西屯花園；沿用舊F01/F04/F05/F10吸汁昆蟲／蜜露潛在地點、F03果實、F07/F11舊昆蟲屍體，不憑空增加新食源或捕獲物。文獻R98、R104、R107、R108及原R17–R31。

## (1) 植物—蚜蟲／介殼蟲—螞蟻—瓢蟲的互利／競爭
- Bach (1991)直接研究`Pheidole megacephala`、綠介殼蟲`Coccus viridis`和寄主植物`Pluchea indica` [R104]：有螞蟻接觸時，研究中的介殼蟲數與繁殖較高，螞蟻可移除瓢蟲幼蟲與其他植食性鱗翅目幼蟲；植物淨效應含減少蜜露累積／煤煙病，**是研究場地特有結果，不是所有植物均受益**。
- F01/F04/F05/F10已有吸汁昆蟲**可能存在**的故事線索，但沒有證據指出就是`Coccus viridis`。`host_plant_species=null`、`hemipteran_taxon=null`、`producer_count=null`、`honeydew_production_mg_per_day=null`、`ladybird_present=null`；**不把舊蜜露點轉成已量測的綠介殼蟲群**。
- 只有工蟻真正到該枝葉並發生接觸或防衛時，才可能改變瓢蟲捕食成功率和吸汁蟲存活；沒有工蟻也可發生吸汁蟲繁殖／死亡，但需依季節、寄主與時間尺度，不每20分鐘生成整批新蟲。
- 食源循環：植物狀態→吸汁蟲攝食／存活→蜜露產出→滴落／蒸發／競爭者取食→本巢工蟻到場收集→一次性外部入庫。**螞蟻照護不等於自動糖+N**。介殼蟲對植物的負擔、蜜露堆積、煤煙病等為**條件式慢變背景**，沒有物種與現場證據不能宣稱已發生。
- 競爭巢／瓢蟲／寄生蜂等亦有自己的活動決策和場域資源，不能當為讓主巢獲利服務的NPC。

## (2) 活獵物與合作捕食
- Dejean等(2007)直接研究本物種 [R98,R107]：某些獵物由單隻工蟻捕獲；較大獵物可在**局部警戒與遠端招募**條件下，聯合拖住獵物；對白蟻與競爭蟻跡象可招募。**研究中成熟族群的獵捕表現不可當14隻小群的必勝能力**。
- 流程：`prey independently exists → local ant/prey spatiotemporal encounter → sensory detection → prey mobility/defense → single-ant attempt or recruitment → (possible) prey escape/ant injury → (possible) immobilization → cutting/transport → delivery → larval processing/assimilation`。
- 只有在同一物理地點／時間且獵物真存在時，才建立`prey_encounter`；大型獵物可能逃走、攻擊工蟻、躲避或被其他動物先吃掉；絕不能按「覓食成功」直接把鮮活蟲當已死蛋白。
- `prey_id`一個獨立個體只可死亡一次；捕獲後的實體仍保有`mass_mg=null`時不能入庫虛構蛋白克數；若已確認搬回巢，記**來源ID**、運輸路段、實際帶回證據，外部收入只計一次，巢內分食不是第二份獵物。
- 大型工蟻major在物種層次可處理食物與防禦，但14隻W004–W017誰是major仍null，**不能因W010守衛或本次故事需要就補造兵蟻**。
- 異巢蟻的工蟻不等於自由野外獵物；若靠近敵巢，先判辨識／接觸和對方防禦；`raid`必有群體規模與路線，不可用單位14工蟻秒殺成熟敵巢 [R100/R110]。

## (3) 食物與能量唯一帳
新系統只記`interactions`、`prey_life_state`、`supply_source_ids`，營養入庫仍由`foraging_economy`唯一管理。植物→蜜露來源更新一次、獵物→屍體一次、搬運→交付一次、工蟻口對口交換只做轉移、清理與昆蟲腐敗耗損另外記。

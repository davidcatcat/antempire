# Codex repository 複審：main、C4a #90、濕度 #92（2026-11-06）

**結論：#90 REQUEST CHANGES，新增一項 P2（兩個同源反例）；#92 APPROVE（限工程修正）。** 沒有發現新增 P0／P1。既有個體發育、飢餓與正式物理整合限制仍在，不能因測試通過而宣稱整體科學驗證完成。

## 1. 固定範圍與版本

| 對象 | 固定 SHA | 本輪範圍 |
|---|---|---|
| main | `665feb9122efa87bcd0ce46cb2b642eb9ab48190` | 已合併 #70、#87、#88、#89、#91，v26；核對與上輪 main 的差異及已知限制 |
| #92 | `a7e1925d52a4cee81a082b3df3103e8776adc42a` | v27，濕度 wet/dry 偏移置中，開關預設關閉 |
| #90 | `d9cd0cd14c541f847c93066dacfb9c1086cc4006` | v28，C4a 已實作，疊在 #92 之上，開關預設關閉且依賴 C3a |

直接讀取 GitHub 最新 head 與 PR 說明，建立隔離 git archive，Node **22.23.4**。主要審查引擎、C2、蟻后／幼蟲回合讀取器、孵化／代謝／關閉區室、測試與設計紀錄。生成的大型實驗 JSON 沒有逐行窮盡重讀。

#90 與設計 §7.2 記錄 Owner 已選 D1～D8；本輪以其明列實作範圍審查，不把文件中的歷史待選段落當成必須重新詢問 Owner 的理由，也沒有代作任何新生物學決定。

## 2. F-R2-01 — P2／#90：既有幼蟲的期末位置與繼承來源紀錄可無事件改寫

位置：[engine/larva-feeding.ts:265–266](https://github.com/davidcatcat/antempire/blob/d9cd0cd14c541f847c93066dacfb9c1086cc4006/engine/larva-feeding.ts#L265)、[cli/lib/larva-round-replay.ts:127–130](https://github.com/davidcatcat/antempire/blob/d9cd0cd14c541f847c93066dacfb9c1086cc4006/cli/lib/larva-round-replay.ts#L127)。

新檢查會驗證接觸發生在期初幼蟲位置，也重建期末 fed_balance 與 begging_signal；但對**原本已是幼蟲、且當日仍存活**的個體，沒有核對期末 location 或 body.egg_investment。兩個檢查器共同遺漏了會影響後續行為或來源可追溯性的狀態欄位。

### 合法完整日對照與兩個獨立反例

1. 使用原參數與開關：C3a、C4a 打開；Day0 A2、seed 3、2027-09-23。
2. 真正逐日執行 simulateWorldDay，取第 5 日第一個有餵食且仍有幼蟲的輸出。E006 在當日開始時已是有帳的幼蟲。
3. 未修改對照：E006.location = brood、body.egg_investment = null。
4. **反例 A（位置）**：只把期末 E006.location 改成 brood_far。沒有搬運、位置轉移、死亡或替換事件；保留全部轉移、聯絡、代謝、摘要與食物量。
5. **反例 B（來源紀錄）**：另取未修改輸出複本，只把 E006.body.egg_investment 由 null 改為 `{sugar:99, protein:99}`。沒有任何卵投入／孵化或繼承紀錄支持這項變更。它是帳務 metadata 的偽造，**不是**聲稱已有 198 份可支出食物被加入。

| 檢查器 | 合法對照 | A：無事件移位 | B：改寫繼承來源 |
|---|---|---|---|
| checkColonyFood | 接受 | 接受 | 接受 |
| checkQueenRound | 接受 | 接受 | 接受 |
| checkLarvaRound | 接受 | **接受** | **接受** |
| replayEngineColonyDay（c3a/c4a 打開） | errors: [] | errors: [] | errors: [] |
| replayQueenRound | errors: [] | errors: [] | errors: [] |
| replayLarvaRound | errors: [] | **errors: []** | **errors: []** |

我使用正確的期初快照與 had-record 旗標，合法對照先通過，沒有把錯誤參數造成的拒絕當成有效驗證。反例直接修改真正完整日的輸出複本，沒有使用會遺失 splice 的攤平陣列。

### 可觀察的後續影響

在 A 與合法對照的世界各再跑同一天：

- 對照：W003 在 brood 接觸 E006，交付 **0.08 份蛋白**。
- A：E006 已被移出可接觸集合，同一 W003 改為接觸 E005，**0.08 份蛋白改餵給 E005**。

亂數種子與合法事件相同；只有先前未記錄的移位改變了受食個體。因此 location 不只是顯示欄位。這不表示正常產生器已自動移位，而是新引擎檢查與三個讀取器共同接受可改變之後個體攝取的偽造輸出。

### 建議修正與驗收

- 對既有幼蟲及化蛹後仍存在的同一個體，依生命周期重建位置與不可變來源欄位。目前沒有幼蟲搬運機制時，期末位置應等於已知期初／初始化位置；未來有搬運時，須有本個體的授權事件。
- body.egg_investment 及來源標記須由期初紀錄保留，或在當日孵化時由該卵的已核驗紀錄產生；不能只在孵化當天驗一次。
- 引擎與獨立讀取器分別拒絕 A、B；保留未修改對照、正常孵化、化蛹與死亡／羽化案例，避免修正變成全面禁止合法生命周期變化。

兩個反例根因相同，合計列**一項新增 P2**，不重複計數。

## 3. #92：APPROVE（工程修正），有限月份與氣候驗證須分開

本輪專項 **46 項通過**，重現舊偏移相對插值基準最多約 1.737 百分點；新版本在既有 20 種子 × 3 年樣本中各月絕對差最多約 **0.142**。40 日反事實比較支持：相對濕度之外的天氣、事件與蟻群狀態不變。靜態搜尋也確認目前 ant engine 沒有讀取相對濕度作行為輸入。

新公式 Δ × (wet − p_t) 移除了原固定偏移的 7p−2 項。令 q_t 為實際邊際雨日機率、ρ 為固定 persistence，則：

```text
q_t = ρ q_(t−1) + (1−ρ) p_t
E[offset_t] = Δ (q_t−p_t)
Σ[t=1..n] (q_t−p_t) = −ρ/(1−ρ) × (q_n−q_0)
```

因此當 0 ≤ ρ < 1 時，**未截限偏移的長期均值會趨近 0，即使 p_t 隨時間變化**；有限月份的均值不必精確為 0。我用目前 ρ = 0.45、實際 rainPriors／monthInterp，先跑多年機率遞迴再計算 2036 各月的解析未截限偏移期望：最大約 **0.04143 百分點**（9 月），小於目前 0.2 工程允差。這是中心化與雨日持續性相容的有限期間效果，**不列為新缺陷**。

我在中途 commentary 曾把「長期零均值」的條件說得過窄；進一步求和後已如上更正，本報告不保留那個錯誤指控。

解讀界線：0–100 截限後不能直接沿用未截限的均值恆等式；固定同一 p_t 的 wet/dry 條件差距是 7 點，而跨日／按月分組的樣本差距不必完全相同（原測試也報告 6.998 → 6.968）。這不否定該 PR 的工程修正。若將來宣稱氣候驗證通過，仍須逐月分位數、持續性與極端值等觀察比對，而非僅靠偏移置中。

## 4. 科學根據與已知限制

- C4a 的固定一口／求食訊號機制引用 R210，Cassill & Tschinkel (1995), *Allocation of liquid food to larvae via trophallaxis in colonies of the fire ant*, *Animal Behaviour* 50:801–813。物種是 **Solenopsis invicta，非本種**。PR 已正確把 0.3 門檻、0.025／0.08 份、路線順序及同位置抽選等標為假設；本輪沒有新取得該論文全文，不宣稱逐項原文複核。
- unknown reserve = null 與可支出 fed_balance 已在程式分開：支付 min(need, own balance)，短缺另記；不再把負帳與可支出量混為一談。這處理了前輪 schema 意見的核心。
- C4a 的發育 L2 與飢餓死亡 L3 仍沿用全巢比例／缺口，PR 明示留待 C4b／C4c。個體攝取變了而化蛹數幾乎不變，不能當成生物學驗證。
- 第一次啟用時沿用的舊 begging_signal 含歷史全巢資訊，PR 已揭露；本輪不另算新問題。
- 個體接觸仍是命名位置及序數時間，不是物理碰觸。main 仍有正式物理整合阻擋與未知花園幾何。
- #92 使用 CWA 月平年值作合成天氣先驗。月資料插值本身的偏差、距平與濕度的關係等已揭露限制，不與本輪濕度偏移修正混為一談。
- 本輪沒有新取得本種或臺灣幼蟲餵食觀察資料，沒有以缺少資料判定候選假設已被否證。上述 F-R2-01 直接違反事件／狀態契約，不需依賴新的物種參數才可判定。

## 5. main、issues 與已合併狀態

main 已合併前輪審查的 #87／#88／#89，沒有再把它們列成未合併 PR。#88 是 opt-in 的 v26；預設關閉與生態刪除假設仍須分開看。#91 的來源標示將舊敏感度資料中未記錄的程式 provenance 明確標為 unverifiable，沒有事後補造產生時 hash；這是對歷史證據限制的合理處理。

目前未合併的是 #92 與疊在其上的 #90。#81 不能因 C4a PR／A0 測試通過就當成全部修復；L2／L3 仍未修。#82 在 main 尚未啟用新公式。#9、#56、#65、#66、#68／#69、#80、#83–#85 等仍需依各自範圍驗收，本輪沒有宣稱它們關閉。

## 6. 實際驗證

- #90：npm run typecheck 通過；C4a 專項 **316 項通過**，1,000 個開關開啟 colony-days、1,631 次接觸、886 次糖餵食、778 次蛋白餵食；三個讀取器接受其原測試合法日。
- #90：npm test **51/51 腳本通過**；check:saves **20/20 通過**。
- #90：本報告獨立探針的六個檢查器先接受未修改對照，之後仍錯誤接受兩個偽造輸出；隔日 E006／E005 的受食差異已實際執行重現。
- #92：npm run typecheck 通過；濕度專項 **46 項通過**。其測試亦包含在 #90 的完整套件中，因 #90 疊在 #92。
- #92：另以解析邊際雨日機率遞迴核對有限月份中心化殘差，並推導長期望遠鏡消去關係；不把這個殘差列為缺陷。
- 上述均使用 Node **22.23.4**。沒有重新把舊 SHA 的全綠結果當成本輪測試；main 的相容路徑亦由 PR 套件的 golden／rules-isolation 檢查覆蓋，未另跑一份重複完整套件。

## 7. 操作界線

沒有修改產品程式、參數、原斷言、正式 saves 或 journal；沒有合併、rebase、force push、推進 Day15 或啟動新版正式 Day0。完整測試、故障注入與探針只在隔離 archive／記憶體；發布內容只有本報告。

## 附錄：#90 完整日探針

在 d9cd0cd 根目錄以 Node 22.23.4 執行，先產生合法日、確認六個檢查器對照接受，再分別偽造位置與來源紀錄。

```ts
import {loadBundle} from './cli/lib/load.ts';import {buildDay0} from './cli/lib/day0.ts';import {simulateWorldDay,resolveBundle} from './engine/index.ts';import {ensureBroodRecords,larvaRoundStart,checkLarvaRound} from './engine/larva-feeding.ts';import {colonySnapshot,checkColonyFood} from './engine/transfers.ts';import {checkQueenRound,queenRoundStart,expectedInitBasis} from './engine/queen-feeding.ts';import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';import {replayQueenRound} from './cli/lib/queen-round-replay.ts';import {replayLarvaRound} from './cli/lib/larva-round-replay.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;b.species[sid].larval_feeding.individual_larva_body_c4a=true;const sp=resolveBundle(b).species[sid];
let w:any=buildDay0('A2',3,'2027-09-23',b).state;let out:any;
for(let d=0;d<60;d++){out=simulateWorldDay(w,b);if(out.result.colonies[0].events.some((e:any)=>e.cause==='feed_larva')&&out.state.colonies[0].population.brood.some((x:any)=>x.stage==='larva'&&x.body))break;w=out.state;}
const start=w.colonies[0],ev=out.result.colonies[0].events,world={sim_day:w.sim_day,migration_log:w.migration_log},before:any=structuredClone(start);const day0=expectedInitBasis(world)==='day0_scenario',had=ensureBroodRecords(before,day0,[]);const ls=larvaRoundStart(before,sp,had,day0),qs=queenRoundStart(before,!!start.population.queens,expectedInitBasis(world));
const check=(after:any)=>{const engines:string[]=[];for(const [n,fn] of [['C2',()=>checkColonyFood(colonySnapshot(before,true,true),after,ev,'timed')],['queen',()=>checkQueenRound(qs,after,ev,sp)],['larva',()=>checkLarvaRound(ls,after,ev,sp,out.result.colonies[0].summary.metabolic_factor)]] as any){try{fn();engines.push(n+':ACCEPT')}catch(e){engines.push(n+':'+e)}}return {engines,c2:replayEngineColonyDay(start,after,ev,out.day,new Set(Object.keys(w.sources)),'timed',true,true).errors,queen:replayQueenRound(start,after,ev,b.species[sid],world).errors,larva:replayLarvaRound(start,after,ev,b.species[sid],world,out.result.weather.nest_temp_model_c).errors}};
console.log('baseline',JSON.stringify(check(out.state.colonies[0])));
const fake=structuredClone(out);const l=fake.state.colonies[0].population.brood.find((x:any)=>x.stage==='larva'&&x.body&&start.population.brood.some((z:any)=>z.id===x.id&&z.stage==='larva'&&z.body));console.log('target',JSON.stringify({day:out.day,start_day:w.sim_day,larva:l.id,location:l.location,investment:l.body.egg_investment}));l.location='brood_far';console.log('teleport',JSON.stringify(check(fake.state.colonies[0])));
const metadata=structuredClone(out);const lm=metadata.state.colonies[0].population.brood.find((x:any)=>x.id===l.id);lm.body.egg_investment={sugar:99,protein:99};console.log('investment',JSON.stringify(check(metadata.state.colonies[0])));
for(const [name,s] of [['control',out.state],['teleport',fake.state]] as any){const n:any=simulateWorldDay(s,b);console.log('next day',name,JSON.stringify(n.result.colonies[0].events.filter((e:any)=>e.type==='larva_contact'||e.cause==='feed_larva').map((e:any)=>[e.type,e.larva??e.recipient?.id,e.worker??e.source?.id,e.portions])))}

```

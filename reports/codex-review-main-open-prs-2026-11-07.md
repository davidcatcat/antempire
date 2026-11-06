# Codex repository 第三輪增量審查（2026-11-07，Asia/Taipei）

版本核對時間：2026-11-06 22:19 UTC（臺灣時間 2026-11-07 06:19）。

**結論：#93、#94、#97 REQUEST CHANGES。** 本輪列三項 P2：一項 C3a 修正未完整、一項 C4b 端點驗證缺口，以及新 C4c 設計沿用舊每日機率時的單位／相容性問題。它們不等於三個已在正常日產生器中發生的錯誤；詳細範圍如下。未發現新增 P0／P1。

main、各實驗 PR 與科學驗證的界線維持；本輪沒有核准正式 Day0 或物理層接入。

## 1. 固定版本與結論

| 對象 | SHA | 本輪結論與基底 |
|---|---|---|
| main | `6f37e1f64e44de961f7b3f0e86730094b9bf01d3` | 已合併 #92，v27；與上輪 main 的增量為既已審查的濕度修正 |
| #90 | `3487717b0f2ac9042adc6bbc7ae0d4e6537fcd27` | 維持前輪有限 APPROVE WITH COMMENTS；98b59a7 的修正已在祖先中，之後合併 main；base main |
| #93 | `d0a5f0d55f88e04a78b52782908d1bd6ac55c3b4` | REQUEST CHANGES；C3a 檢查強化，base #90；F-R3-01 |
| #94 | `11d90797cb077c9ac45252dbff0aff74bf7e41ef` | REQUEST CHANGES；C4c／多巢研究文件，base main；F-R3-03 |
| #95 | `17da1f1f4538425e18bdb82448f85abc9b0e838d` | 有限 APPROVE；首次個體訊號先驗 v29，base #90 |
| #96 | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | 有限 APPROVE WITH COMMENTS；獨立原型，僅本輪完成的驗證／建置範圍，未重跑瀏覽器煙霧測試 |
| #97 | `38f1710b153c9db4ccea291b61f82d20d353d8e4` | REQUEST CHANGES；C4b v30，base #95；F-R3-02 |
| #98 | `003184d785c7279174de8152e12941ea255b36f5` | 有限 APPROVE WITH COMMENTS；實驗層四項物理修正的工程範圍；已知殘留問題及整合阻擋不變 |

GitHub open PR 清單共七張。#93 與 #95 是平行堆疊，不是後者已包含前者；#97 也尚未包含 #93。合併基底改變後，應在最後組合的 head 核對登錄與相關回歸，不能把各自的綠燈當成組合後已測。

本輪用 git archive 隔離快照、Node **22.23.4**，檢查新引擎、獨立讀取器、資料契約、物理修正、原型與研究文件。沒有逐行重讀所有生成 JSON 或重新取得 references 中全部文獻。

## 2. F-R3-01 — P2／#93：接觸與餵食的序數時間沒有合併核對，可繞過飽足拒絕

位置：`engine/queen-feeding.ts` 新增的 checkFeedingRule（約 282–324 行），以及 `cli/lib/queen-round-replay.ts` 對應重播。

新版成功抓到原來 0.28 → 0.33 的反例，且要求應餵／拒絕的紀錄完整。問題是只檢查 **queen_contact 相互排序**，卻依事件陣列重播蟻后餘額；沒有確保接觸當下已套用所有較早序數時間的餵食。

### 已執行反例（隔離 C3a 回合）

- 真正執行 nestRound 產生合法對照；工蟻嗉囊糖 0.6，route B1 關閉，蟻后期初糖餘額距飽足門檻差 0.1。
- 接觸 A 的序數為 **1.050260**；A 合法餵 **0.28**，因此在接觸 B（**1.148645**）之前蟻后已飽足，B 原本應拒餵。
- 只在事件陣列把 A 的餵食移到 B 的 contact 後面，**保留 A 餵食的原序數 1.050260**。
- 把 B 的拒絕換成同工蟻／同接觸的一筆 **0.28** 餵食；從 B 期末嗉囊與巢糖扣 0.28、蟻后帳加 0.28，轉移 ID 依順序重新編號，不改物質總量。

| 檢查 | 真正回合對照 | 偽造回合 |
|---|---|---|
| checkColonyFood + checkQueenRound | 接受 | **接受** |
| C2 獨立讀取器 | errors: [] | **errors: []** |
| queen-round 獨立讀取器 | errors: [] | **errors: []** |

餵食 A、B 各自仍符合接觸與離開區間，餵食轉移自身的序數也仍依 A → B 排列；但兩種決策事件合在一起時次序矛盾。新版在 B contact 的陣列位置看不到 A 的較早餵食，因此錯把 B 判為可餵。

**建議**：以同一條決策時間線核對 queen_contact、feed_queen、自取與拒絕；較早序數的交付必須先改變蟻后餘額，才計算較晚接觸的飽足狀態。若契約採現行產生器的「接觸當下立即交付／拒絕」，也可要求該接觸的結果完成後才處理下一次接觸。nest_move 是區間宣告，不能簡單要求整個事件陣列所有欄位都單調。

保留合法對照，新增上述交錯反例與同時接觸的平手案例，讓引擎與讀取器各自拒絕。此反例不是說正常 nestRound 自動超餵，而是新檢查仍接受違反序數因果的輸出。

## 3. F-R3-02 — P2／#97：C4b 沒有完整驗證期末階段與無照護日進度

位置：`engine/larva-development.ts` checkLarvaDevelopment、`cli/lib/larva-development-replay.ts`。

兩邊會重算 x、N(x) 與 progress_after，但對期末狀態採條件式檢查：

- end 是 pupa 時，比對 `max(0, after−1)`，**沒有要求 after ≥ 1**；
- 無照護日直接跳過，**沒有要求進度維持原值**。

### A：未完成發育就化蛹

以專項測試同樣允許的 **TEST-ONLY clamp_linear** 開啟 C3a／C4a／C4b；這不是替 Owner 選營養反應形式。Day0 A2、seed 3、2027-09-23，真正跑至有幼蟲餵食的完整日。

E006 的正確進度為 **0.546473**。保留所有營養轉移及 larva_development 紀錄，只將期末 E006 改成 pupa、progress = 0、age_days = 0，新增 pupation 事件並同步期末摘要分類。

### B：無照護日，沒有任何發育事件卻增加進度

另取同一 A2 種子起點，把工蟻設為 0 作為明示的測試初始情境，真正執行一個完整日。對照 E006 進度 **0.5**、沒有 larva_development；複製輸出後只改進度為 **0.6**，仍沒有發育事件。

| 檢查 | 合法對照 | A：未達門檻化蛹 | B：無照護日增加進度 |
|---|---|---|---|
| C2、queen、larva 引擎檢查 | 接受 | 接受 | 接受 |
| checkPopulationDay | 接受 | 接受 | 接受 |
| checkLarvaDevelopment | 接受 | **接受** | **接受** |
| C2、queen、larva 獨立讀取器 | errors: [] | errors: [] | errors: [] |
| replayLarvaDevelopment | errors: [] | **errors: []** | **errors: []** |

族群檢查會驗證「化蛹事件來自期初幼蟲」，但不會代替發育檢查驗證生理進度門檻。故 A 不會被現有族群檢查補抓。

**建議**：從期初階段、照護、自己的支付與公式先推導唯一合法的期末轉換，再核對事件／狀態。after < 1 不得 pupation；after ≥ 1 的存活個體須按規則化蛹並保留餘量。無照護且未死亡時，進度／階段應保持不變；死亡則核對合法死亡路徑。不要把「沒有發育」實作成「不檢查」。

A、B 根因都是端點契約不完整，列一項 P2，不重複計數。這不表示真實產生器目前提早化蛹。出廠 nutrition_response = null 及開關關閉仍會阻擋未選模型啟用，這個安全界線有效；但不能替代可選候選模型本身的正確驗證。

## 4. F-R3-03 — P2／#94：H-a 不能把舊每日機率直接當連續危險率並稱「只換輸入」

位置：`docs/research-design-c4c-and-multinest.md` §A.2、§A.4 H-a（約 19、45 行）；對照現行 engine/brood.ts 的 `g() < risk`。

§A.2 正確採用 `P = 1−exp(−∫λdt)`。但 H-a 把舊的 `clamp(base+(u−start)*slope,0,cap)` 直接當 λ，沿用 larva_daily_hazard_*，並稱只把輸入從全巢換成個體。

現行程式中的 risk 是直接與均勻亂數比較的**每日死亡機率 p**。參數描述也寫「機率增幅」「每日死亡機率上限」，不是已校準的連續率。即使兩者都是遊戲假設，也不能在說明「只換輸入」時混用估計量與單位。

| 舊每日 p | 若直接取 λ = p／日，新一日死亡機率 | 保留原一日 p 所需 λ／日 |
|---:|---:|---:|
| 0.05 | 0.0487706 | 0.0512933 |
| 0.75（目前 cap） | **0.5276334** | **1.3862944** |

因此 H-a 並非僅替換局部輸入；死亡反應曲線也會改變。這是 Issue #83 已提醒的概率／危險率差別，在新 C4c 設計中仍需具體處理，不把它算成新的現行 main 死亡程式錯誤。

**建議**：若 H-a 意圖保留原日機率，先定義 p_old(u)，再用 `λ(u)=−log1p(−p_old(u))/day`；若有意重新將舊數值解釋為率，須明示為另一個待選模型假設及其結果，不能稱只換輸入。加入一日機率與細分時間步存活概率相容的數學檢查。這不需要先有新的本種數據，也不替 Owner 選 H-a／b／c。

多巢文獻的附帶意見：R116 中「C 與 A 沒有顯著差異」不等於證明等效。觀察算子可以並列效應量、區間與未檢出差異，但不應把 C≈A 當已建立的等效性目標。

## 5. 其餘 PR 與科學界線

- **#90**：相較已審查 98b59a7，3487717 是合併 main；原位置／繼承來源 P2 的修正保留。#93／#95 是各自的後續工作，不能說 #90 已包含兩者。
- **#95**：首次訊號明示先驗的專項 24 項通過。先驗由物種參數核對、舊值保留追溯、既有個體紀錄不每天重設。0.3 等於餵食門檻的初始化效應仍是假設，不是測得的飢餓狀態；新開關預設關閉。
- **#96**：我實際安裝隔離依賴、執行 verify 與 Vite build 成功。Rapier 是沿 Native 軌跡配置的 2D 膠囊／感測器見證，不是另一個獨立運動解算器；PixiJS 是播放。entry／inside／control 的原生排斥違規均 0，Rapier body-overlap 樣本為 65／61／18；不同幾何／中心線投影不能把它們當 Native 穿透次數。瀏覽器 smoke／截圖本輪未重新執行，不把 PR 的 CI 敘述冒充本輪視覺驗證。
- **#98**：本輪新專項 426、原碰撞 685、運動 91、隔離 86、登錄 36 通過，另跑雙工蟻及 golden（結果見驗證節）。新位置／時間由運動區段錨點推導，切線使用共同 discEncounter，方向正確；P1-A 的退讓距離與放行規則屬實驗候選改動，不因程式通過就變成本種規則。
- **#98 已知限制沒有被修掉**：密集 PH-2b pressOn 放行未排程，文件記錄 400 次時間窗比較有 4 次事件時間不同；本輪沒有重跑該生成器，不能宣稱已全面時間窗不變。原碰撞測試本輪仍有 12 seeds × 8 ants 的 88 抵達／8 unresolved、密集情境 67 抵達／97 unresolved。維持正式整合阻擋；這些不是本輪新發現。
- **#97 已揭露的限制**：多日遠處幼蟲反事實在第 3 日仍會透過舊 nurse cue／產卵全巢路徑影響原個體。這不能寫成全面局部性已修；本輪不將作者已揭露的限制再算新缺陷。Yuan 的同步分布、未實作的 C4c／營養形式選擇仍待後續處理。

本輪沒有新取得 R116、Cassill & Tschinkel 1995、Yuan 2026 等全文；文件作者的閱讀敘述不等於我本輪親讀。沒有新本種／臺灣發育與餵食數據，不把其他物種的固定口量、未知儲備或未定 hazard 變成實測參數。三項 P2 都可由程式／時間契約或數學轉換判定，不依賴杜撰的生物學證據。

## 6. 驗證與讀取範圍

- #97（含 #95／#90 祖先）：typecheck 通過；C4b 專項 **46 項通過**；完整 npm test **53/53 腳本通過**；check:saves **20/20**。
- #93：typecheck 通過；新餵食規則 **44 項**（C3a-only／C3a+C4a 各 210 日）；原 C3a **326 項**、C4a **326 項**與 rules-registry **36 項**通過。
- #95 自身 head：首次先驗專項 **24 項通過**。#97 完整套件亦執行該測試，但兩個版本結果不混寫。
- #98：typecheck 通過；physics-event-fixes **426 項**、ph2-collision **685 項**、mv1-kinematics **91 項**、physics-two-ant **36 項**、physics-isolation **86 項**、rules-registry **36 項**與 golden 通過。
- #96：隔離 npm install、npm run verify 與 npm run build 成功；原型產生的 native/Rapier 數字與上文一致。未自行安裝或執行瀏覽器煙霧測試。
- 新反例：#93 隔離回合的對照與交錯攻擊皆被原檢查器接受；#97 的合法完整日對照、未達門檻化蛹與無照護日增加進度，皆被原檢查器接受；都有實際輸出紀錄，不只靜態推測。
- #94：從現行參數重算 p 與 λ 的一日轉換，不是生物學擬合或新增死亡模型。
- 沒有重跑每個堆疊分支的重複完整套件；以 #97 完整套件加 #93、#95、#98 各自的新專項覆蓋本輪增量。也沒有把不同 SHA 的測試誤寫成全在 main 執行。

main 已合併 #92，Issue #82 不再列為開啟 issue；這不代表合成天氣已通過完整氣候驗證。#9、#56、#65、#66、#68／#69、#80／#81、#83–#85 等既有科學／架構限制仍需依各自範圍處理。本輪沒有重讀全部歷史 issue 留言或重新執行所有舊 fuzzer。

沒有修改產品程式、參數、原斷言、正式 saves／journal；沒有合併、rebase、force push、推進 Day15 或啟動正式新版 Day0。探針、安裝、原型生成與測試僅作用於隔離 archive；發布內容只有本 Markdown 報告。

## 附錄 A：#93 交錯接觸／餵食的隔離回合探針

在 d0a5f0d 根目錄以 Node 22.23.4 執行。baseline 先由真正 nestRound 產生；偽造只在其複本進行。

```ts
import {loadBundle} from './cli/lib/load.ts';import {buildDay0} from './cli/lib/day0.ts';import {resolveBundle} from './engine/index.ts';import {ensureQueens,expectedInitBasis,queenRoundStart,nestRound,checkQueenRound} from './engine/queen-feeding.ts';import {bindFoodTransfers,colonySnapshot,checkColonyFood} from './engine/transfers.ts';import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';import {replayQueenRound} from './cli/lib/queen-round-replay.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;b.species[sid].queen_feeding.route_b1=false;const sp:any=resolveBundle(b).species[sid],w:any=buildDay0('A2',3,'2027-09-23',b).state,c=w.colonies[0];
ensureQueens(w,c,sp,[]);c.population.queens[0].body.known_balance={sugar:sp.queen_feeding.queen_satiation_days_of_need*sp.nutrition.queen_sugar_daily-.1,protein:0};for(const a of c.population.workers){a.task='nurse';a.last_location=c.nest_node;a.crop_cargo_sugar=.6;}c.stores.sugar=c.population.workers.length*.6+5;c.stores.protein=0;
const before=structuredClone(c),qs=queenRoundStart(before,true,expectedInitBasis(w)),snap=colonySnapshot(before,true),ev:any[]=[];bindFoodTransfers(ev,w.sim_day+1,c.id);nestRound(w,c,sp,ev);
function check(after:any,events:any[]){let engine='ACCEPT';try{checkColonyFood(snap,after,events,'timed');checkQueenRound(qs,after,events,sp)}catch(e){engine=String(e)}return{engine,c2:replayEngineColonyDay(before,after,events,w.sim_day+1,new Set(Object.keys(w.sources)),'timed',true).errors,queen:replayQueenRound(before,after,events,b.species[sid],w).errors}}
console.log('baseline',JSON.stringify(check(c,ev)));
const after=structuredClone(c),events=structuredClone(ev),first=events.find((e:any)=>e.cause==='feed_queen'&&e.food_type==='sugar'),contacts=events.filter((e:any)=>e.type==='queen_contact'),second=contacts[1];
events.splice(events.indexOf(first),1);events.splice(events.indexOf(second)+1,0,first);
const refusal=events.find((e:any)=>e.type==='queen_feeding_refused'&&e.contact_event_id===second.contact_event_id&&e.food_type==='sugar');if(!refusal)throw Error('no second refusal');
const extra=structuredClone(first);extra.source.id=second.worker;extra.ordinal=second.ordinal;extra.contact={contact_event_id:second.contact_event_id,worker:second.worker,queen:second.queen,location:second.location};events.splice(events.indexOf(refusal),1,extra);
const donor=after.population.workers.find((a:any)=>a.id===second.worker);donor.crop_cargo_sugar=+(donor.crop_cargo_sugar-extra.portions).toFixed(6);after.stores.sugar=+(after.stores.sugar-extra.portions).toFixed(6);after.population.queens[0].body.known_balance.sugar=+(after.population.queens[0].body.known_balance.sugar+extra.portions).toFixed(6);
let n=0;for(const e of events)if(e.type==='food_transfer')e.transfer_id=`FT-${w.sim_day+1}-${c.id}-${++n}`;
console.log('interleaved',JSON.stringify({first_ordinal:first.ordinal,second_contact_ordinal:second.ordinal,extra:extra.portions,result:check(after,events)}));

```

## 附錄 B：#97 未達門檻化蛹的完整日探針

在 38f1710 根目錄以 Node 22.23.4 執行。clamp_linear 是診斷 TEST-ONLY 值，不是替 Owner 選模型。

```ts
import {loadBundle} from './cli/lib/load.ts';import {buildDay0} from './cli/lib/day0.ts';import {simulateWorldDay,resolveBundle} from './engine/index.ts';import {ensureBroodRecords,larvaRoundStart,checkLarvaRound} from './engine/larva-feeding.ts';import {colonySnapshot,checkColonyFood} from './engine/transfers.ts';import {checkQueenRound,queenRoundStart,expectedInitBasis} from './engine/queen-feeding.ts';import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';import {replayQueenRound} from './cli/lib/queen-round-replay.ts';import {replayLarvaRound} from './cli/lib/larva-round-replay.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;b.species[sid].larval_feeding.individual_larva_body_c4a=true;b.species[sid].larval_development.individual_development_c4b=true;b.species[sid].larval_development.nutrition_response='clamp_linear';const sp=resolveBundle(b).species[sid];
let w:any=buildDay0('A2',3,'2027-09-23',b).state;let out:any;
for(let d=0;d<60;d++){out=simulateWorldDay(w,b);if(out.result.colonies[0].events.some((e:any)=>e.cause==='feed_larva')&&out.state.colonies[0].population.brood.some((x:any)=>x.stage==='larva'&&x.body))break;w=out.state;}
const start=w.colonies[0],ev=out.result.colonies[0].events,world={sim_day:w.sim_day,migration_log:w.migration_log},before:any=structuredClone(start);const day0=expectedInitBasis(world)==='day0_scenario',had=ensureBroodRecords(before,day0,[]);const ls=larvaRoundStart(before,sp,had,day0),qs=queenRoundStart(before,!!start.population.queens,expectedInitBasis(world));
const {checkLarvaDevelopment}=await import('./engine/larva-development.ts');const {replayLarvaDevelopment}=await import('./cli/lib/larva-development-replay.ts');const {populationSnapshot,checkPopulationDay}=await import('./engine/invariants.ts');
const check=(after:any)=>{const engines:string[]=[];for(const [n,fn] of [['C2',()=>checkColonyFood(colonySnapshot(before,true,true),after,ev,'timed')],['queen',()=>checkQueenRound(qs,after,ev,sp)],['population',()=>checkPopulationDay(populationSnapshot(start),after,ev)],['development',()=>checkLarvaDevelopment(ls,after,ev,sp,out.result.weather.nest_temp_model_c,out.result.colonies[0].summary.metabolic_factor,start.population.workers.length)],['larva',()=>checkLarvaRound(ls,after,ev,sp,out.result.colonies[0].summary.metabolic_factor)]] as any){try{fn();engines.push(n+':ACCEPT')}catch(e){engines.push(n+':'+e)}}return {engines,development:replayLarvaDevelopment(start,after,ev,b.species[sid],out.result.weather.nest_temp_model_c).errors,c2:replayEngineColonyDay(start,after,ev,out.day,new Set(Object.keys(w.sources)),'timed',true,true).errors,queen:replayQueenRound(start,after,ev,b.species[sid],world).errors,larva:replayLarvaRound(start,after,ev,b.species[sid],world,out.result.weather.nest_temp_model_c).errors}};
console.log('baseline',JSON.stringify(check(out.state.colonies[0])));

const f=structuredClone(out.state.colonies[0]),l=f.population.brood.find((x:any)=>x.stage==='larva'&&x.body&&ev.some((e:any)=>e.type==='larva_development'&&e.larva===x.id&&e.progress_after<1));const rec=ev.find((e:any)=>e.type==='larva_development'&&e.larva===l.id);l.stage='pupa';l.progress=0;l.age_days=0;if(f.last_report?.population){f.last_report.pupations++;f.last_report.population.larvae--;f.last_report.population.pupae++;}ev.push({type:'pupation',id:l.id});console.log('premature',JSON.stringify({id:l.id,computed_progress:rec.progress_after,result:check(f)}));

```

## 附錄 C：#97 無照護日進度改寫探針

```ts
import {loadBundle} from './cli/lib/load.ts';import {buildDay0} from './cli/lib/day0.ts';import {simulateWorldDay,resolveBundle} from './engine/index.ts';import {ensureBroodRecords,larvaRoundStart,checkLarvaRound} from './engine/larva-feeding.ts';import {colonySnapshot,checkColonyFood} from './engine/transfers.ts';import {checkQueenRound,queenRoundStart,expectedInitBasis} from './engine/queen-feeding.ts';import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';import {replayQueenRound} from './cli/lib/queen-round-replay.ts';import {replayLarvaRound} from './cli/lib/larva-round-replay.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;b.species[sid].larval_feeding.individual_larva_body_c4a=true;b.species[sid].larval_development.individual_development_c4b=true;b.species[sid].larval_development.nutrition_response='clamp_linear';const sp=resolveBundle(b).species[sid];
let w:any=buildDay0('A2',3,'2027-09-23',b).state;w.colonies[0].population.workers=[];let out:any=simulateWorldDay(w,b);
const start=w.colonies[0],ev=out.result.colonies[0].events,world={sim_day:w.sim_day,migration_log:w.migration_log},before:any=structuredClone(start);const day0=expectedInitBasis(world)==='day0_scenario',had=ensureBroodRecords(before,day0,[]);const ls=larvaRoundStart(before,sp,had,day0),qs=queenRoundStart(before,!!start.population.queens,expectedInitBasis(world));
const {checkLarvaDevelopment}=await import('./engine/larva-development.ts');const {replayLarvaDevelopment}=await import('./cli/lib/larva-development-replay.ts');const {populationSnapshot,checkPopulationDay}=await import('./engine/invariants.ts');
const check=(after:any)=>{const engines:string[]=[];for(const [n,fn] of [['C2',()=>checkColonyFood(colonySnapshot(before,true,true),after,ev,'timed')],['queen',()=>checkQueenRound(qs,after,ev,sp)],['population',()=>checkPopulationDay(populationSnapshot(start),after,ev)],['development',()=>checkLarvaDevelopment(ls,after,ev,sp,out.result.weather.nest_temp_model_c,out.result.colonies[0].summary.metabolic_factor,start.population.workers.length)],['larva',()=>checkLarvaRound(ls,after,ev,sp,out.result.colonies[0].summary.metabolic_factor)]] as any){try{fn();engines.push(n+':ACCEPT')}catch(e){engines.push(n+':'+e)}}return {engines,development:replayLarvaDevelopment(start,after,ev,b.species[sid],out.result.weather.nest_temp_model_c).errors,c2:replayEngineColonyDay(start,after,ev,out.day,new Set(Object.keys(w.sources)),'timed',true,true).errors,queen:replayQueenRound(start,after,ev,b.species[sid],world).errors,larva:replayLarvaRound(start,after,ev,b.species[sid],world,out.result.weather.nest_temp_model_c).errors}};
console.log('baseline',JSON.stringify(check(out.state.colonies[0])));

const f=structuredClone(out.state.colonies[0]),l=f.population.brood.find((x:any)=>x.stage==='larva'&&x.body),old=l.progress;l.progress=+(l.progress+.1).toFixed(6);console.log('no-care forged progress',JSON.stringify({id:l.id,old,now:l.progress,records:ev.filter((e:any)=>e.type==='larva_development').length,result:check(f)}));

```

# Codex 複驗 #90：98b59a7 與兩項待決建議（2026-11-06）

**結論：APPROVE WITH COMMENTS，限本輪 P2 修正與固定 SHA。** F-R2-01 的兩個原反例均被引擎與幼蟲讀取器拒絕，未修改對照接受。沒有發現新增 C4a P1／P2。既有 C3a 餵食量驗證缺口與首次啟用訊號政策仍需分開處理，不能把這份結論讀成整個生物模型已科學驗證。

## 1. 版本與複驗方法

- #90 head：`98b59a70d9faeb5cfd90077c9d035bd787d10e0f`。
- 前輪對照：`d9cd0cd14c541f847c93066dacfb9c1086cc4006`。
- main：`665feb9122efa87bcd0ce46cb2b642eb9ab48190`。
- #92 base：`a7e1925d52a4cee81a082b3df3103e8776adc42a`。
- Node **22.23.4**，隔離 git archive；直接閱讀修正與原程式，執行前輪相同探針及相關專項。

前輪報告：[main／#90／#92 審查與原始探針](https://github.com/davidcatcat/antempire/blob/73955e35d82e920c542ff539091f4d2c3c0116ba/reports/codex-review-main-pr90-pr92-2026-11-06.md)。本輪直接使用其完整日探針，沒有修改攻擊內容以迎合新檢查。

## 2. F-R2-01 關閉

引擎快照新增原始 begging 欄位，期末按初始化／孵化等合法事件重建允許的改變。獨立讀取器另行檢查相同契約：

- 幼體位置不能無事件改變；
- 既有 body 的 egg_investment、reserve_at_hatch、reserve_basis 保留來源；
- 非回合開始時有帳的幼蟲，不得任意新增／改寫求食訊號；
- 新產下的卵不能無事件帶入位置、帳或訊號；
- 正常初始化、孵化與既有幼蟲的攝取／代謝／訊號更新仍可執行。

### 相同完整日反例結果

Day0 A2、seed 3、2027-09-23，真正逐日模擬至第 5 日；E006 在期初已是有帳的幼蟲，location = brood、egg_investment = null。只修改輸出複本，事件與食物量不動。

| 情境 | 引擎 checkLarvaRound | 獨立 replayLarvaRound |
|---|---|---|
| 未修改完整日對照 | 接受 | errors: [] |
| A：期末 E006.location 改為 brood_far | **拒絕**：place brood → brood_far without any event that moves brood | **拒絕**：moved brood → brood_far; no event moves brood |
| B：期末 egg_investment 改為 sugar/protein 各 99 | **拒絕**：account record changed without an event | **拒絕**：account record changed with no event |

C2／queen 檢查器沒有針對這些 C4a 來源欄位拒絕，這是原有範圍；C4a 檢查器與獨立讀取器現在各自補上，整體驗證會拒絕。前輪「可無事件轉移位置、進而把隔日 0.08 蛋白改餵給別隻」的非法狀態轉換已被擋住。

## 3. 實際執行的檢查

- npm run typecheck：通過。
- c4a-larva-feeding：**326 項通過**，1,000 colony-days；包含 N23–N27；原樣本 1,631 次接觸、886 次糖餵食、778 次蛋白餵食。
- c3a-queen-feeding：**326 項通過**，467 colony-days，檢查共享回合沒有被此次修改破壞。
- rules-registry：**36 項通過**，current = v28，real_saves_unchanged = true。
- check:saves：**20/20 通過**。
- git diff --check：通過。
- 三份 Day0 evaluation JSON 與 d9cd0cd 逐欄比較：各自只有 `/rules_fingerprint/engine` 改變，沒有模型結果欄位差異。

本輪沒有重跑全部 npm test。前輪 d9cd0cd 的 51/51 是先前實際執行的結果；使用者回報新 head CI 綠燈也沒有冒充成本輪本機完整套件結果。本次改動集中在檢查器／測試，以上為實際獨立執行的檢查。

## 4. PR 中兩題的建議

以下是我的具體建議；本輪只評估與紀錄，沒有自動改程式或套用新政策。若採納第一項，會產生新的行為提交，不能自動沿用對 98b59a7 的結論。

### 4.1 首次啟用 C4a 的既有幼蟲訊號：採明示初始化先驗

**建議選擇：第一次建立 C4a 紀錄時，使用 default_larva_begging_prior；舊訊號保留供追溯，不再作新路徑決策輸入。**

理由：舊 begging_signal 可能由全巢比例計算，不能當成這隻幼蟲的個體攝取歷史。改用明示先驗能切開資訊來源；但先驗也不是測得的真實飢餓狀態，必須標為遊戲／初始化假設。

具體契約建議：

1. 僅針對尚未有 C4a 個體紀錄的既有幼蟲初始化；不得每天重設，也不得覆蓋已存在且可追溯的 C4a 個體訊號。
2. 初始化事件記錄 legacy 值、採用的先驗、原因與來源；引擎／讀取器從物種參數核對先驗，不能只相信事件自報的值。
3. 不修改 fed_balance、egg_investment 或 reserve_at_hatch；未知儲備仍為 null。
4. 預設先驗目前是 **0.3**，等於餵食門檻，因此會改變第一次接觸時的餵食資格；例如 Day14 原先 0.25 會由未達門檻變成達門檻。必須報告這個初始化效應，不能稱為新生物學發現。
5. 分別覆蓋 Day0 初始幼蟲、Day14 遷移、較晚開啟開關、已有 C4a 紀錄的對照；驗證「只改舊全巢訊號、其餘個體紀錄相同」不會改變新路徑第一次餵食。
6. 作為規則更新登錄指紋與初始化事件，重新比較診斷。這不是單純增加檢查器。

### 4.2 C3a feed_queen：另開檢查強化 PR，核對完整規則

**建議選擇：另開 C3a PR；依現有產生器行為，驗證應餵時的等式、拒絕時的條件與漏餵。**

需要更正原問題的前提：「目前已驗不超過上限」並不充分。我查讀實作並用隔離 C3a 回合反例確認：

- 使用真正的 nestRound 產生合法對照；工蟻初始嗉囊糖 0.6，蟻后初始已知帳 0、cache route B1 關閉，足夠工蟻庫存。
- 合法單口糖為 0.28；將一口改成 **0.33**（上限仍是 **0.28**），同步減少同一工蟻期末嗉囊與巢糖 0.05、增加蟻后已知帳 0.05，並同步該轉移 nest_ledger_delta。
- 未改接觸或移動。checkColonyFood + checkQueenRound、C2 讀取器、queen-round 讀取器對合法對照與偽造回合都接受。

這是 C3a 既有的金額契約缺口，與本次 C4a P2 修正分開。這個反例是**隔離巢內回合**，不是宣稱正常完整日產生器真的超量餵食。

另開 PR 至少應核對：

- 先有合法接觸、同工蟻同蟻后、各種食物的當時持有量；
- 未達現有飽足門檻、且持有量 > 0 時，給量恰為 `min(held, feed_max_portions_per_contact)`；不得超量、少給或漏掉該口；
- 已達門檻時不餵，拒絕紀錄理由須能由當時個體狀態驗證；持有量為 0 時遵守 C2 不寫零額轉移的規則；
- 同一回合逐筆重播蟻后的已知帳與工蟻嗉囊，不能只用期末帳或一個全回合總額核對。

不應順便改變飽足門檻、最大一口、接觸順序或生物學餵食模型。現行產生器在「未飽足」時給固定 min 值，即使那一口會跨過門檻，也應先驗證現行規則；若要改成只餵剩餘需求，是另一個模型決策。

## 5. 科學與操作界線

本輪沒有新取得生物學文獻全文，沒有新增本種數值。首次訊號先驗是模型選擇；C3a 等式是現行程式行為的契約，不是證明真實螞蟻必然按固定上限餵食。C4b／C4c 的發育及飢餓、物理整合等既有限制沒有因本次驗證而消失。

沒有合併或修改產品程式、參數、正式 saves／journal；沒有推進 Day15、啟動正式新版 Day0 或 force push。只在隔離 archive 執行探針與測試，並將本報告上傳至獨立 review 分支。

## 附錄：C3a 上限隔離回合探針

在 98b59a7 根目錄存為 .ts，以 Node 22.23.4 執行。這是特製合法帳務起點的回合檢查，不是整日輸出；baseline 先由真正 nestRound 產生並通過三類檢查，再修改其複本。

```ts
import {loadBundle} from './cli/lib/load.ts';import {buildDay0} from './cli/lib/day0.ts';import {resolveBundle} from './engine/index.ts';import {ensureQueens,expectedInitBasis,queenRoundStart,nestRound,checkQueenRound} from './engine/queen-feeding.ts';import {bindFoodTransfers,colonySnapshot,checkColonyFood} from './engine/transfers.ts';import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';import {replayQueenRound} from './cli/lib/queen-round-replay.ts';
const b:any=loadBundle(),sid=Object.keys(b.species)[0];b.species[sid].queen_feeding.individual_queen_body_c3a=true;b.species[sid].queen_feeding.route_b1=false;const sp:any=resolveBundle(b).species[sid],w:any=buildDay0('A2',3,'2027-09-23',b).state,c=w.colonies[0];
ensureQueens(w,c,sp,[]);c.population.queens[0].body.known_balance={sugar:0,protein:0};for(const a of c.population.workers){a.task='nurse';a.last_location=c.nest_node;a.crop_cargo_sugar=.6;}c.stores.sugar=c.population.workers.length*.6+5;c.stores.protein=0;
const before=structuredClone(c),qs=queenRoundStart(before,true,expectedInitBasis(w)),snap=colonySnapshot(before,true),ev:any[]=[];bindFoodTransfers(ev,w.sim_day+1,c.id);nestRound(w,c,sp,ev);
function check(after:any,events:any[]){let engine='ACCEPT';try{checkColonyFood(snap,after,events,'timed');checkQueenRound(qs,after,events,sp)}catch(e){engine=String(e)}return{engine,c2:replayEngineColonyDay(before,after,events,w.sim_day+1,new Set(Object.keys(w.sources)),'timed',true).errors,queen:replayQueenRound(before,after,events,b.species[sid],w).errors}}
console.log('baseline',JSON.stringify(check(c,ev)));const after=structuredClone(c),events=structuredClone(ev),f=events.find((x:any)=>x.cause==='feed_queen'&&x.food_type==='sugar');if(!f)throw Error('no sugar feeding');const old=f.portions;f.portions=+(f.portions+.05).toFixed(6);f.nest_ledger_delta=-f.portions;after.population.workers.find((x:any)=>x.id===f.source.id).crop_cargo_sugar=+(after.population.workers.find((x:any)=>x.id===f.source.id).crop_cargo_sugar-.05).toFixed(6);after.stores.sugar=+(after.stores.sugar-.05).toFixed(6);after.population.queens[0].body.known_balance.sugar=+(after.population.queens[0].body.known_balance.sugar+.05).toFixed(6);console.log('over cap',JSON.stringify({old,portions:f.portions,max:sp.queen_feeding.feed_max_portions_per_contact,...check(after,events)}));

```

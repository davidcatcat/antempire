# Codex 第七輪審查：R6 修正複驗與初始化來源（2026-11-06）

**結論：#77 的 R6-04 修正可有限範圍 APPROVE WITH COMMENTS；#78 仍為 REQUEST CHANGES，新增 1 項 P2（R7-01）。** 前次 R6-01～04 的原反例都已被修正擋下，不能繼續把它們列為未修。新的問題是初始化來源仍可由事件自行宣告，與遷移狀態矛盾卻被回合檢查及獨立讀取器接受。

審查者：Codex，未使用子代理。日期按 Asia/Taipei。沒有合併、force push、修改產品分支的程式／參數、推進正式日數、啟動正式 Day0，或更改正式存檔／日誌。

## 1. R7-01 — P2：遷移蟻后的初始化事件可自稱 Day0，獨立稽核接受不應取得的起始儲備

標的：#78 `1a4c6af834c9cfe253611289f0a357d31ea7069f`。

位置：

- [engine/queen-feeding.ts:183](https://github.com/davidcatcat/antempire/blob/1a4c6af834c9cfe253611289f0a357d31ea7069f/engine/queen-feeding.ts#L183)：依 `e.basis` 決定允許哪一種初始餘額。
- [cli/lib/queen-round-replay.ts:44](https://github.com/davidcatcat/antempire/blob/1a4c6af834c9cfe253611289f0a357d31ea7069f/cli/lib/queen-round-replay.ts#L44)：同樣由事件的 `basis` 選擇規則。
- [cli/lib/engine-transfers.ts:171](https://github.com/davidcatcat/antempire/blob/1a4c6af834c9cfe253611289f0a357d31ea7069f/cli/lib/engine-transfers.ts#L171)：沒有期初 queen record 時，將初始化事件的 `known_balance` 作為重播起點。

### 原因

R6-01 新增了初始化事件「有且只有一筆、本后 ID 正確」的要求，確實擋住缺少事件的舊反例。但事件仍可自稱 `basis='day0_scenario'`，驗證器就按 Day0 的 `k × dailyNeed` 接受金額；沒有核對它與蟻后記錄的初始化來源、未知儲備標記及可信世界初始化條件一致。

正常生成端 `ensureQueens` 是依世界的 `sim_day` 與 `day0_initialization` 紀錄決定來源；驗證端沒有維持這個來源限制。這不是要求用文獻推導未知的儲備量，而是已有規則的來源與會計一致性問題。

### 獨立重現

隔離測試資料：Day14 legacy fixture，打開 C3a，將已文件化的敏感度參數 `day0_initial_reserve_days_of_need` 設為 **3**。設計允許研究 `{0,3,10,30}`；沒有更改 repo 參數檔或正式存檔。真實的遷移日輸出是 Day15，起始已知儲備應為 0、未知儲備應為 null，不因 Day0 參數而取得食物。

保留正常事件的數量與 queen ID，只改該筆初始化事件：

```text
basis: unknown_at_migration → day0_scenario
unknown_initial_reserve: null → not_applicable
known_balance: {sugar:0, protein:0} → {sugar:0.66, protein:0.135}
reserve_days_of_need_assumption: null → 3
```

同時把期末蟻后的已知餘額各加上糖 0.66、蛋白 0.135；期末蟻后記錄仍是 `basis='unknown_at_migration'`、`unknown_initial_reserve=null`。結果：

| 項目 | 正常遷移日 | 偽稱 Day0 的初始化事件 |
| --- | --- | --- |
| 期末 body.basis | unknown_at_migration | unknown_at_migration |
| 期末 unknown_initial_reserve | null | null |
| 期末 known_balance.sugar | 0 | **0.66** |
| 期末 known_balance.protein | 0.245599 | **0.380599** |
| `checkQueenRound` | 接受 | **接受** |
| `replayQueenRound` | 無錯誤 | **無錯誤** |
| `replayEngineColonyDay(..., c3a=true)` | 無錯誤 | **無錯誤** |

蛋白的正常期末餘額 0.245599 是當日正常食物流動的結果，不是遷移時憑空授予；假資料在其上額外加了 0.135。

另外使用正式流程的初始化後 `QueenRoundStart` 複驗，回合檢查也接受，故不是漏傳 `hadRecord` 參數造成的假象。真正 Day0、k=3 的合法對照亦被兩個讀取器及回合檢查接受。

### 影響界線

**正式流程的 C2 快照仍會拒絕這個假餘額**：初始化後快照已記錄已知儲備為 0，因此 `checkColonyFood` 回報期末糖 660,000 µp 與重播 0 不符。沒有發現正常 `simulateWorldDay` 會自行生成這筆錯誤事件，也沒有宣稱正式引擎已憑空產生食物。

確認的缺陷是：回合檢查與兩個獨立讀取器會替互相矛盾的初始化來源及餘額背書。這延伸 R6-01 的獨立稽核邊界；「缺事件已修」不能等同「初始化來源已完整驗證」。預設 k=0 會讓虛構金額變成 0，容易掩蓋這條路徑；非零合法敏感度參數才暴露數量後果。

### 修正與驗收建議

1. 至少核對初始化事件的 basis、未知儲備標記與新建 queen record 一致。
2. 初始化模式要由可信的世界／遷移情境決定並傳入獨立檢查，不能僅信事件自填的 `basis`。若事件與期末記錄一起被偽造，光比對兩份自述仍不夠。
3. 對 Day0／遷移／稍後啟用開關三類情境測試 k=0 與非零 k；錯誤來源拒絕，真正 Day0 k=3 及正常遷移 k=3 仍接受。
4. 未知儲備仍保留 null；不要為通過檢查而填 0、禁止全部非零 Day0 情境，或修改正式歷史。

## 2. 前次四項修正：已通過原反例複驗

| 舊問題 | 本輪結果與對照 |
| --- | --- |
| R6-01 缺少初始化事件、期末儲備 5／7 | 新回合檢查要求唯一初始化事件；兩個讀取器拒絕；真實建立日通過。這個原反例可結案，R7-01 是另列的來源缺口 |
| R6-02 中途超出嗉囊共用容量 | 逐轉移檢查已生效；取用／放回 1.28 份被拒絕；較強的糖 0.75＋蛋白 0.28＝1.03 > 容量 0.8 反例也被拒絕，合法對照通過 |
| R6-03 回到倉庫後才接觸／餵食 | W006 的接觸 3.106224 不在 `[抵達, 離開 2.606224)`，引擎回合與獨立回合讀取器都拒絕；保持轉移有序的原反例亦被擋下 |
| R6-04 存活蟻后 ID 無事件替換 | #77 的檢查已改為每天核對；引擎與人口讀取器均拒絕，Q001 身分不變的正常對照通過；#78 已繼承 |

C2 食物讀取器主要處理餘額與路徑，回合讀取器處理在場與共用容量；R6-02／03 的 C2 錯誤列表為空，不代表修正失敗，應合併相應兩類檢查解讀。本輪核對的是它們的完整組合。

`queenRoundStart` 新增必要的 `hadRecord` 參數。本次只將舊獨立探針的呼叫改為 `queenRoundStart(before, !!before.population.queens)`，原反例金額、時間及期末狀態不變；沒有用錯介面造成「所有合法對照也失敗」後誤判產品缺陷。

## 3. 有限的故障注入：R6-03 回歸測試有效

另建立完全隔離的故障注入副本，沒有修改受測 head 或產品工作區：

| 注入 | `tests/c3a-queen-feeding.test.ts` 結果 |
| --- | --- |
| 移除引擎與讀取器共四條「必須早於離開蟻后」防護 | exit 1，R6-03 的「engine rejects」斷言失敗 |
| 保留引擎防護，只移除讀取器兩條對應防護 | exit 1，R6-03 的「readers reject」斷言失敗 |

這支持新增 R6-03 測試確實能抓到對應防護被移除，不是只依賴某個無關格式錯誤。它不是完整突變測試或所有驗證器的安全證明。

## 4. 範圍、版本及其餘 PR／issue

重新取得 Git refs 及 GitHub open 清單：**7 個 open PR、13 個 open issue**，均只有一頁。

| 對象 | 本輪 SHA | 審查範圍與狀態 |
| --- | --- | --- |
| main | `4e8fc6e8f9cec12c18a7a450921143d03721006d` | 未變，沿用前報告的程式／科學限制；沒有理由宣稱已解除正式 Day0 阻擋 |
| #77 | `f9efab0df397b3909b3309b3d807b51615f1d75b` | 相對 `852155d`，重點為每日蟻后 ID 一致性。R6-04 可結案；本次差異有限範圍 APPROVE WITH COMMENTS，不代表所有身分或科學規則已驗證 |
| #78 | `1a4c6af834c9cfe253611289f0a357d31ea7069f` | 相對 `9d2933f` 複驗 R6-01～03，並檢查初始化來源；因 R7-01 仍為 REQUEST CHANGES |
| #79 | `b5da282da00599a076eeda2d8f1adc7742cc8c09` | 未變；維持先前僅對文件差異的 APPROVE WITH COMMENTS，不解除物理五項接入阻擋 |
| #76 | `6dcaf13fb25bffed3c1696892274c59ed060a754` | 未變；ODD v23 文件同步仍需與最終 v24／v25 合併狀態一致 |
| #70（draft） | `5554160fceb497411899bdea25e8f58dbca029cb` | 未變；仍需對齊已合併物理實作與現行 Roadmap |
| #55 | `8a25b99d639a05136fd8182425ecb0835ed0c855` | 未變；舊繁殖設計、SD 說明與 D4-A／D7-A 的同步要求保留 |
| #53 | `e707d026508c4f430e726d2a70edff2cd70ea460` | 未變；仍需標明已被 main 研究複核修訂的內容 |

open issue 編號仍為 **#9、#25、#26、#27、#43、#49、#56、#57、#61、#65、#66、#68、#69**。本輪重點是有程式變動的 #77／#78，沒有把未變內容說成重新做過全部文獻全文審計。

- #56／#9 與共享亂數串流：儲存順序、跨群資源排程仍未完成。
- #43／#61／#65／#66：個體營養、幼體分布、完整生命史與 ME-2～ME-5 科學驗收仍未完成。
- #68／#69：物理仍是隔離實驗，既有五項接入阻擋保留；本輪沒有重跑完整物理 fuzzer。
- #57：舊資料的產生時 provenance 限制保留，不能用現在的 hash 回填舊紀錄冒充歷史證明。
- #25～#27：階級、新物種與辨識的未完成研究／實作界線保留。

完整逐項基線及外推限制見[前份綜合報告（含替代來源實查）](https://github.com/davidcatcat/antempire/blob/928f9ee702adf5a6b91f9e781bec46ce41e1e15f/reports/codex-repo-science-review-2026-11-06.md)。本報告取代它對上述新 head 的 R6 狀態，不改寫舊報告的歷史判定。

## 5. 實際驗證與保存界線

Node **22.23.4**，依鎖定檔安裝，在各 Git archive 隔離副本執行。

| 範圍 | 本輪實際結果 |
| --- | --- |
| #78 `1a4c6af` | `npm run typecheck` 通過；完整 `npm test` **47/47 腳本 PASS**，exit 0；`npm run check:saves` **20/20**，0 warnings、0 errors |
| #77 `f9efab0` | `npm run typecheck` 通過；ME-1 **113 checks**、720 colony-days／world-days；`check:saves` **20/20**。沒有另跑此 head 的全套，#78 堆疊套件涵蓋其測試 |
| 原 R6 探針 | 原缺陷拒絕，合法對照接受，見第 2 節 |
| R7-01 探針 | 正常遷移 k=3、正常 Day0 k=3 接受；錯誤來源仍被回合檢查及兩讀取器接受；正式 C2 快照拒絕假餘額 |
| R6-03 有限故障注入 | 合併移除兩邊防護與僅移除讀取器防護均被現有測試抓到，exit 1 為預期 |

上述為本機實際結果，沒有另外宣稱已獨立查核遠端 CI。報告定稿前重新核對遠端 refs，與本輪固定 SHA 一致。

- 新、舊 #77／#78 間的 `saves/`、`journal/` 無差異；species／world 參數檔亦無變更。
- 更新規則指紋並重新產生報告／web data，是這些引擎檢查變動的版本記錄，不等於新增科學驗證。
- main 沒有變更，本輪沒有重跑一模一樣的 main 全套；前份同 SHA 的 45/45 是前輪結果，不列成本輪新實驗。
- 獨立反例、讀取器錯誤及故障注入日誌保留在 `/workspace/scratch/review-r7-20261106/`。只上傳本報告，不上傳故障注入後的產品檔案。

## 6. 科學根據的判定邊界

本輪新增問題是初始化來源及遊戲份量收支的一致性。`unknown_at_migration` 不授予已知初始食物、Day0 情境可明示 `k × dailyNeed`，是目前設計契約，不需要以某篇螞蟻論文替互相矛盾的事件與狀態背書。k=3 是已列出的 D 類敏感度情境，不能當成實測的本種三日生理儲備。

#78 的新差異沒有新增生物機制或改變研究參數，因此本輪沒有重跑或冒稱重讀全部原始論文。上一輪實際取得的 Pietrek 作者野外資料、Saund／Friedman 公開模型重播、TaiBIF 官方取用文件仍可支持研究設計與觀察算子；它們都沒有驗證 C3a 的蟻后路線、液化效率或局部接觸率。

Sanders 的蛋白分配證據、Chang 的飼養條件、臺灣活動／遺傳／營養階研究，以及本種／他種來源的限制維持前報告所述。C3a B1／C 路線與巢內序數模型仍是候選，不因工程修正而升格為已驗證生物機制。

本輪環境狀態仍為 restricted、`allowed_hosts=[]`；沒有把尚未套用的學術網域草稿當作連線成功，也沒有重試先前已遭代理拒絕的同一端點或宣稱本輪完成期刊全文查核。這不影響上述程式反例的可重播性，但限制了本輪新增原文科學複核的範圍。

## 附錄：R7-01 可重播程式

在 #78 上述 SHA 的隔離 checkout 根目錄儲存為 `review-r7-provenance.ts`，使用 Node 22.23.4 執行 `node review-r7-provenance.ts`。程式只變更記憶體測試資料，不寫正式世界。其 exit 0 表示成功重現當前缺陷及取得合法對照，不是產品驗收通過。

```typescript
import assert from 'node:assert/strict';
import {loadBundle} from './cli/lib/load.ts';
import {resolveBundle} from './engine/params.ts';
import {simulateWorldDay,legacyToWorldState,legacyColonyMeta} from './engine/index.ts';
import {fixture,MAIN_SPECIES,setParam} from './tests/lib/harness.ts';
import {checkQueenRound,queenRoundStart,ensureQueens} from './engine/queen-feeding.ts';
import {checkColonyFood,colonySnapshot} from './engine/transfers.ts';
import {replayEngineColonyDay} from './cli/lib/engine-transfers.ts';
import {replayQueenRound} from './cli/lib/queen-round-replay.ts';
const b:any=loadBundle();b.species[MAIN_SPECIES].queen_feeding.individual_queen_body_c3a=true;setParam(b,MAIN_SPECIES,'queen_feeding.day0_initial_reserve_days_of_need',3);
const sp=resolveBundle(b).species[MAIN_SPECIES],s=legacyToWorldState(fixture(),legacyColonyMeta(b.world.scenario_colonies as any)),before=structuredClone(s.colonies[0]),o=simulateWorldDay(s,b),after:any=structuredClone(o.state.colonies[0]),events:any[]=structuredClone(o.result.colonies[0].events);
function inspect(name:string){let roundCheck='ACCEPT';try{checkQueenRound(queenRoundStart(before,false),after,events,sp)}catch(e){roundCheck=String(e)}
 const food=replayEngineColonyDay(before,after,events,o.day,new Set(Object.keys(s.sources)),'timed',true),round=replayQueenRound(before,after,events,b.species[MAIN_SPECIES]);
 const result={name,day:o.day,roundCheck,food:food.errors,round:round.errors,body:after.population.queens[0].body,init:events.find(e=>e.type==='queen_body_initialized')};console.log(JSON.stringify(result));return result;}
const control=inspect('MIGRATION_CONTROL');assert.equal(control.roundCheck,'ACCEPT');assert.deepEqual(control.food,[]);assert.deepEqual(control.round,[]);
const init=events.find(e=>e.type==='queen_body_initialized');init.basis='day0_scenario';init.unknown_initial_reserve='not_applicable';
const reserve={sugar:Math.round(3*sp.nutrition.queen_sugar_daily*1e6)/1e6,protein:Math.round(3*sp.nutrition.queen_protein_daily*1e6)/1e6};init.known_balance=reserve;init.reserve_days_of_need_assumption=3;
for(const f of ['sugar','protein'] as const)after.population.queens[0].body.known_balance[f]=Math.round((after.population.queens[0].body.known_balance[f]+reserve[f])*1e6)/1e6;
const forged=inspect('MIGRATED_QUEEN_FORGED_AS_DAY0_IN_EVENT');assert.equal(forged.roundCheck,'ACCEPT');assert.deepEqual(forged.food,[]);assert.deepEqual(forged.round,[]);
const initialized=structuredClone(before);ensureQueens(s,initialized,sp,[]);let productionC2='ACCEPT';try{checkColonyFood(colonySnapshot(initialized,true),after,events,'timed')}catch(e){productionC2=String(e)}console.log(JSON.stringify({productionC2,scope:'The normal post-initialization C2 snapshot is a separate protection; this counterexample targets the round check and independent readers.'}));
let productionRound='ACCEPT';try{checkQueenRound(queenRoundStart(initialized,false),after,events,sp)}catch(e){productionRound=String(e)}console.log(JSON.stringify({productionStyleRoundStart:productionRound}));
import {buildDay0} from './cli/lib/day0.ts';
const ds=buildDay0('A4',1,'2027-09-23',b).state,db=structuredClone(ds.colonies[0]),dout=simulateWorldDay(ds,b),da=dout.state.colonies[0],de=dout.result.colonies[0].events;
checkQueenRound(queenRoundStart(db,false),da,de,sp);const dr=replayQueenRound(db,da,de,b.species[MAIN_SPECIES]),df=replayEngineColonyDay(db,da,de,dout.day,new Set(Object.keys(ds.sources)),'timed',true);assert.equal(dr.ok,true);assert.equal(df.ok,true);console.log(JSON.stringify({name:'TRUE_DAY0_K3_CONTROL',roundCheck:'ACCEPT',food:df.errors,round:dr.errors,body:da.population.queens?.[0]?.body}));
```

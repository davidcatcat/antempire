# Codex 複審與合併就緒報告・第 13 輪（2026-11-08）

審查者：Codex。本輪直接檢查程式並執行獨立反例，沒有另開 Claude 或其他代理審查。範圍是 main `0c7ba29f4899ed659b6e8ee8e616baf38ad9f5ec` 與本輪讀取時的 11 張未合併 PR。下列結論只適用於表列 SHA。

**可列入合併候選：#116、#117、#122、#123、#127；#129 程式／文件審查無阻擋，但 CI 尚未確認完成。#124、#125、#126、#128 為 REQUEST CHANGES，共 6 項新 P2。#96 維持 Draft。** #116 必須先於 #117；這些候選的通過範圍是其文件、研究或隔離工程，不代表正式生態模型已獲科學驗證。

上輪的 #98、#105、#108、#111、#115、#118、#120、#106、#110、#121、#113 已進 main，不能再列成「待合併」。本輪沒有實際合併 PR，沒有改正式存檔、日誌、參數或產品程式，沒有推進 Day15／啟動新版正式 Day0。報告用獨立 Markdown 分支上傳。

## 1. 對象、CI 與判定

CI 欄是本輪成功取得的 GitHub checks 頁面快照，核對頁面顯示的短 SHA。收尾以 `git ls-remote` 再次確認 main 與全部 11 張 head 未變；GitHub HTML/checks 再抓取遇到 HTTP 504，因此不能宣稱收尾重新確認了全部 CI，亦不能排除快照後新增的 PR。#128、#129 的快照未顯示成功彙總，不能沿用作者的綠燈說法。這是讀取端可觀察到的狀況，沒有證據判定成平台禁止或授權失效。

| PR | 完整 head SHA | base | GitHub CI 快照 | Codex 判定 |
|---|---|---|---|---|
| [#96](https://github.com/davidcatcat/antempire/pull/96) | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | main | 成功 | DRAFT；不建議合併 |
| [#116](https://github.com/davidcatcat/antempire/pull/116) | `97359bc026503e502b6d98708bae82741d27c83d` | main | 成功 | APPROVE WITH COMMENTS；可合併候選 |
| [#117](https://github.com/davidcatcat/antempire/pull/117) | `040f1cded1c951cb26a32c6800cb7bbd03a549bf` | #116 | 成功 | APPROVE WITH COMMENTS；可合併候選 |
| [#122](https://github.com/davidcatcat/antempire/pull/122) | `70a72b343af8770bf77dfb5ea341a50f97f5880a` | main | 成功 | APPROVE WITH COMMENTS；可合併候選 |
| [#123](https://github.com/davidcatcat/antempire/pull/123) | `9ecb6d2f7a59f1ba2276bd4a5c0c8a0177ebc08f` | main | 成功 | APPROVE WITH COMMENTS；可合併候選 |
| [#124](https://github.com/davidcatcat/antempire/pull/124) | `40d69cdac172e3307f10ea5fa324d26af4037c02` | main | 成功 | REQUEST CHANGES |
| [#125](https://github.com/davidcatcat/antempire/pull/125) | `8cd9a3a3778ae263662040aa58e11c45fa2adbc4` | #117 | 成功 | REQUEST CHANGES |
| [#126](https://github.com/davidcatcat/antempire/pull/126) | `eb61fbafac17110baa4a1d951ec8fcaf4dda2d35` | main | 成功 | REQUEST CHANGES |
| [#127](https://github.com/davidcatcat/antempire/pull/127) | `47b1107ed38d495f691214021b7ef7e604afd968` | main | 成功 | APPROVE WITH COMMENTS；可合併候選 |
| [#128](https://github.com/davidcatcat/antempire/pull/128) | `0bc0d4dba1e6ae066234c46e577884287068b1ad` | main | 未確認完成 | REQUEST CHANGES |
| [#129](https://github.com/davidcatcat/antempire/pull/129) | `44aca58e87df368274320401c2cd9832db0772fd` | main | 未確認完成 | 審查無阻擋；待 CI 確認 |

## 2. 阻擋項目：可重現的新 P2

### R13-01 — #124：重新播放回到 Day1，卻保留 Day30 名冊與路線索引

位置：`web/src/game.ts:36` 的 `ui.play.onclick`；比較同檔 `gotoDay()` 的完整初始化。

播放結束後的分支只設定 `day=1;t=0;ended=false;jumped()`，沒有重建 `idx`、`roster`、`walks` 等每日快取。用提交內 A1 真實重播，先到 Day30 尾端，讓它正常結束，再按「重新播放」，畫面顯示 Day1，卻只列出 W002、W003、W005、W007、W010 五隻。期望的 Day1 名冊是 W001～W010 十隻。同一份資料經 `gotoDay(1)` 則立即恢復十隻，陽性對照成功。

重現採一般播放按鈕、時間滑桿，以及現有唯讀測試介面的跳日功能；沒有修改重播內容。這會把錯誤個體與路徑呈現為引擎紀錄，屬產品正確性問題。修正應共用完整世界／日期初始化流程，並測試播放結束→重新播放的名冊、位置、路線與新載入 Day1 相同。

### R13-02 — #125：環境狀態與排程器提交不具原子性，失敗後無法重試

位置：`engine/clock/environment.ts:119–142`。handler 先直接改 `this.state`，最後才呼叫 foreign handler；WorldScheduler 的回滾不涵蓋外部環境物件。

合法合成條件：臺中座標 24.17°N、120.64°E，UTC+8，2027-06-21，layered，60 分取樣；當日 20～30°C、平均 25°C、RH 70%、無雨。把一個 foreign 事件排在 civil dawn 的同一 native 時刻（284.565614 分），foreign 暫時丟出例外。結果：scheduler snapshot 不變，但環境已變成 `civil_twilight`。移除暫時例外後重試相同 batch，固定失敗：`light transition ... from civil_twilight (expected night)`。不拋錯的相同輸入，環境與排程器均正常提交。

這不是陌生輸入格式：可插入 foreign handler 的公開介面無法在暫時故障後維持一致狀態。應先在環境副本執行整個 batch，待所有 handler 結果與 scheduler 輸出驗證成功再提交，或提供涵蓋全部環境欄位的可靠回滾。也須涵蓋「handler 正常返回、排程輸出驗證失敗」，不能只捕捉 foreign 例外。

### R13-03 — #126：獨立 audit 接受無遷移紀錄的個體跨區互換

位置：`prototypes/mixed-precision/audit.ts:81–115`。區域總數與 ID 集合都有檢查，但沒有逐一重建 ID 所在區域。

兩區 G（fine、花園內）與 P（coarse、園外），同一焦點群 C 的 W1 在 G、W2 在 P，分別帶 100、200 微份糖。`runDay(initial, [])` 的合法期末通過。只把期末兩隻的 `region` 互換，不增刪任何事件、金額或 ID，`auditDay(initial, [], forgedFinal)` 仍回傳 `[]`。個別螞蟻已穿越邊界，卻完全沒有 migration／transport。

這違反檔頭「任何生物移動都須有對應紀錄」與焦點個體保留身分的契約。應依事件順序獨立重建每個 ID 的位置與表示層切換，核對來源、目的、身分及相關 food moves。不能僅以每區數量相同視為個體路徑正確。

### R13-04 — #126：不存在的 producer 可用平衡帳目憑空產生食物

位置：`prototypes/mixed-precision/audit.ts:70–80,91–101`。

沿用前例，期末新增 `producers.ghost=-100` 與 stock S 的 100 微份，附一筆格式正常的 `produce` 紀錄：`producer:ghost → stock:S, amount=100`。獨立 audit 回傳 `[]`；同樣要求交給 `runDay()` 則明確拒絕 `NO_PRODUCER: ghost is not a living modeled producer`。真正存在的 modeled producer 所產生的合法對照仍通過 audit。

負的累計生產帳戶本身是原型的記帳定義，並非本項指控；缺陷是 audit 沒有獨立確認生產者存在且在事件當時存活。數學上加一正一負保持總和，不能證明生態來源合法。應逐事件驗證 producer 存在、存活與合法來源，加入 ghost／已死亡 producer 的負面測試。

### R13-05 — #128：目的地恰好在決策時間邊界，永久漏記抵達

位置：`engine/physics/local-steer.ts:428–433`，抵達只在 `moved` 且 `bT < span` 的分支中處理。

合法開闊單一直線，寬 10 mm，A 從 s=10 走向 11 mm，速度 10 mm/s，決策間隔 0.1 s，horizon 0.4 s，無其他個體或障礙。解析解是 0.1 s 抵達。實際位置已到 11，卻得到 `arrival_t_s:null`、`final_mode:waiting_or_stopped`，只有 `stop(goal)`，沒有 arrive。改目的地為 11.1 mm，陽性對照在 0.11 s 正常抵達。

邊界後剩餘距離為零，下一格 `moved` 為 false，因此不會補記。應明確處理區間終點／零剩餘距離的抵達，確保只記一次，加入恰在格點、非格點、初始已達與 horizon 終點的解析對照。

### R13-06 — #128：接觸結束時間倒填到尚未分離時

位置：`engine/physics/local-steer.ts:443–446`：若區間末 gap 已開，將 contact_end 寫在 `Math.max(t0, ts)`。

同一直線，兩隻長 2.5、寬 0.8 mm，速度 10 mm/s，決策間隔 0.2 s，感測半徑 0.5 mm。A 在 s=10、t=0 開始；B 在 s=13.1、t=0.15 才開始同向行走。引擎在 0.06000000000000027 s 令 A 停在 10.6，記 contact_start；B 到 0.15 前一直在 13.1。兩者在 [0.06,0.15] 持續接觸，卻被記成相同 0.06 s 的 contact_end。輸出的分段位置也證明 B 直到 0.15 才開始移動。

接觸紀錄會用於行為、餵食或其他因果鏈，不能早於分離運動。應依實際分段運動求首次分離時刻，明訂 gap 容差，加入個體延遲出發、跨決策格與正接觸持續時間的測試。最終沒有重疊並不能使錯誤時間戳合法。

## 3. 可以合併的範圍與非阻擋意見

- **#116 → #117**：scheduler 核心與上輪已複驗通過的版本相同；新 main 整合後重新執行 scheduler 317、time-contract 18,758、isolation 87 項，型別通過。獨立重入／getter／handler 失敗探針仍拒絕且保持快照，再正常 step 成功。#117 把先前已修的物理視窗差異改成預期零差異，是加嚴斷言。#116 先合併，#117 改 base 為 main 後重跑 CI；此通過不延伸到 #125 的環境狀態。
- **#122**：純文件、固定 main 0c7ba29 的產品驗收紀錄，可合併為作者的驗收紀錄。私人 artifact 連結及其錄影／雜湊沒有由本輪重新取得，不能描述成 Codex 已逐一驗證，也不涵蓋之後 #124 的 V6。
- **#123**：127 項與型別通過，可合併為研究工具與候選模型比較。未改正式生命史規則。平均、變異、同批差異、區間死亡觀察及外推限制有區分，不能由平均吻合推出分布已驗證。文字的「快 45.8%」宜改為「所需時間少 45.8%」；速度百分比的分母不同。
- **#127**：1,070 項與型別通過，可合併為離線單日反事實分析；它不回饋下一日，也不是正式 C4b 更新。非阻擋 P3：`docs/wp6-c4-next-stage.md:53` 的 `D ≤ ... Σ_i needᵢ` 並不嚴格適用於目前固定一口的「實際送達量」：程式只在餵前判斷未飽，最後一口可超過剩餘需求，報告本身也出現 111.2%。應把需求界線限定為截斷後有效供給，或在送達量上界加入最後一口的超額；不要把這個式子當成對所有反事實的證明。這不推翻當前較緊的接觸數上限或帳目回放。
- **#129**：純 Roadmap 狀態追加，審查未見阻擋；但 CI 成功尚未獨立確認，故不是無條件「現在可合併」。本報告發布後應追加 #124／#125／#126／#128 的 REQUEST CHANGES 與新依賴狀態，保留歷史紀錄的日期語意。

每張 PR 與其當前 base 的 `git merge-tree --write-tree` 均成功；這不代表多張候選連續合併完全無衝突。例如 #123 與 #127 互合在 `tests/run-all.ts` 衝突。處理時應保留雙方新增測試，再驗證合併結果，而不是刪掉其中一個註冊項。未把這些合併模擬更新任何產品分支。

## 4. 測試證據與界線

Node **22.23.4**；依鎖檔使用相同依賴。Rapier 原型另依鎖定版本 0.21.0 安裝；瀏覽器用系統 Chromium、Playwright 1.63.0。所有實驗在獨立 archive，正式 checkout 保持乾淨。

| 對象 | 本輪實際結果 |
|---|---|
| main 0c7ba29 | `npm test` **67/67**，`check:saves` **20/20**，`npm run typecheck` 通過 |
| #116／#117 | 317＋18,758＋87 項，型別、獨立失敗原子性／重入探針通過 |
| #123 | 127 項，型別通過 |
| #124 | Node 7,519 項／16,840 frames，型別、web build 通過；獨立 restart 反例失敗 |
| #124 瀏覽器 | 29 項 UI 斷言通過、無 page exception；整體 harness **exit 1**（一筆 console 404），不能記為全通過；桌機／Android 截圖與動畫均實際執行 |
| #125 | clock 2,930＋多群時間軸 43＋isolation 113、型別通過；獨立原子性反例失敗 |
| #126 | 原有 177 項、型別通過；兩個獨立 audit 反例仍被接受 |
| #127 | 1,070 項、型別通過 |
| #128 | local steering 1,146＋playback 77,176（39 runs／27 steering runs）、型別通過；兩個解析反例失敗 |

main 跑全套；各 PR 執行其新增／相關測試及型別，沒有宣稱每個 head 都重跑一次 main 的完整 67 套。這些通過不抵銷上述反例。

## 5. 科學與文獻審查的實際範圍

本輪查的是來源標籤、數學推導、觀察算子與程式是否相符，不以測試數、存活率或不重疊替代生物驗證。#123 的來源包括本種 Yuan 2026，以及臺灣 Chang 1985、舊 Fluker／Phillips 紀錄；作者明列取得狀態。本輪**未重新取得這些原始全文／補充表**，不可把作者的「已讀全文」轉寫成 Codex 本輪已讀。學術來源與私人 artifacts 的未獨立核對，是科學結論的限制。

應繼續遵守：

1. 不把不同個體集合的里程碑平均差當成逐隻階段期分布；Yuan 跨群 SD 不等於可直接抽樣的個體 CV。壽命 14 日普查屬區間觀測，且冷處理、飼養條件是潛在混淆。
2. #123 在 21～28°C 以外的度日、Q10、Brière 比較只能表達外推不確定性；把範圍中點、平均最短與平均混合擬合不是新參數已被本種支持。M1 Gamma 門檻與相同速率、相同門檻分布的 M2 階段鏈，在共同生理時間變換下等價，不因變溫自動可辨識。
3. #125 的太陽位置／時鐘工程精度不是本種活動時間資料；合成每日天氣、雨時分配、溫度形狀仍須保留 provenance。工程上的 layered 排序也不是螞蟻決策機制。
4. #128 的局部避障、探測角度、讓路／後退機率、身體尺寸與碰撞幾何分別標明來源；非本種與假設不可升級成大頭家蟻已觀察行為。即使作為隔離候選，也必須先修時間因果錯誤。
5. #126 的平衡恆等式是必要條件，不是來源、身分與歷史合法的充分條件；ghost 生產與個體交換正是兩個反例。粒度切換的抽樣也須保留生理歷史，不能只驗總量。
6. #127 的 one-day replay 只比較既定環境下的結構瓶頸；無法單獨推論多日回饋、幼蟲存活、蟻群適合度，或證實每口固定量的生物參數。

既有正式模型的順序性、開放生態、局部營養、生命史／溫度、個體差異與外部群體等問題仍由相關 Issues（如 #9、#56、#80、#81、#83～#85）追蹤。本輪不以隔離 PR 可合併來宣告這些議題已關閉，亦不建議據此啟動新版正式 Day0。

## 6. 可獨立重跑的最小探針

以下 TypeScript 放到各自表列 head 的 repository 根目錄，以 Node 22.23.4 執行 `node 檔名.ts`。它們只操作合成的記憶體資料。`[]` 表示 audit 未報錯；`arrival_t_s:null` 與零時長接觸是本輪要修的輸出，不是新預期。

### #125 — `probe-clock-atomic.ts`

```typescript
import {ClockRun} from './engine/clock/environment.ts';
const cfg:any={world:'W',official:false,anchor:{day0_date:'2027-06-21',utc_offset_minutes:480,zone:'Asia/Taipei'},site:{latitude_deg:24.17,longitude_deg:120.64},order:'layered',sample_step_min:60,first_day:0,last_day:0,seed:7,temperature_shape:null,rain_timing:null};
const input:any={date:'2027-06-21',provenance:{kind:'synthetic_climatology',synthetic:true,assumption:true,source:'review fixture',station_id:null,source_url:null,issued_at:null,valid_from:null,valid_to:null,generator:'fixture',rng_stream:'fixture'},t_min_c:20,t_max_c:30,t_mean_c:25,rh_mean_percent:70,rain_mm:0,hourly:null};
for(const fail of [false,true]){
 const r=new ClockRun(cfg,[input]);const d=r.scheduler.pending().find(e=>e.kind==='light_civil_dawn')!;
 r.scheduler.schedule({kind:'foreign_case',key:'x',native:d.native,scope:{world:'W',colony:null,individual:null},source:null,target:null});
 r.runUntil({day:0,minute:Math.floor(d.at.minute)});const before=JSON.stringify(r.state),sched=JSON.stringify(r.scheduler.snapshot());
 r.foreign=()=>{if(fail)throw Error('transient foreign failure')};let error='',retry='';try{r.scheduler.step(r.handler)}catch(e){error=String(e)}
 const stateChanged=before!==JSON.stringify(r.state),schedulerChanged=sched!==JSON.stringify(r.scheduler.snapshot());
 if(fail){r.foreign=()=>{};try{r.scheduler.step(r.handler)}catch(e){retry=String(e)}}
 console.log(JSON.stringify({fail,dawn:d.at.minute,error,environment_changed:stateChanged,scheduler_changed:schedulerChanged,light:r.state.light,retry_error:retry}));
}
```

實際輸出：

```text
{"fail":false,"dawn":284.565614,"error":"","environment_changed":true,"scheduler_changed":true,"light":"civil_twilight","retry_error":""}
{"fail":true,"dawn":284.565614,"error":"Error: transient foreign failure","environment_changed":true,"scheduler_changed":false,"light":"civil_twilight","retry_error":"ClockError: CLOCK: light transition light_civil_dawn:2027-06-21 from civil_twilight (expected night)"}
```

### #126 — `probe-audit.ts`

```typescript
import {runDay,type WorldState,type LedgerRecord} from './prototypes/mixed-precision/ledger.ts';
import {auditDay} from './prototypes/mixed-precision/audit.ts';
const initial:WorldState={schema:'antempire.wp5-mixed-precision.v1',seed:'fixture',day:0,regions:[{id:'G',resolution:'fine',in_garden:true},{id:'P',resolution:'coarse',in_garden:false}],individuals:[{id:'W1',taxon:'ant',stage:'worker',colony_id:'C',region:'G',physio:{age:1},comp:{sugar:100}},{id:'W2',taxon:'ant',stage:'worker',colony_id:'C',region:'P',physio:{age:2},comp:{sugar:200}}],cohorts:[],stocks:[],sinks:{},producers:{},retired:[],scenario_records:[],used_scenario_records:[],policy:{non_demotable_colonies:['C']}};
const legitimate=runDay(initial,[]);console.log('legitimate',auditDay(initial,legitimate.records,legitimate.state));
const swapped=structuredClone(legitimate.state);swapped.individuals[0].region='P';swapped.individuals[1].region='G';console.log('swapped-without-migration',auditDay(initial,[],swapped));
const final=structuredClone(legitimate.state);final.producers.ghost=-100;final.stocks.push({stock_id:'S',region:'G',amount:100,origin_event_id:'0.fake'});
const fake:LedgerRecord={event_id:'0.fake',kind:'produce',t:{day:0,minute:1,time_resolution:'minute'},source_region:null,destination_region:'G',identity:{action:'none',ids:[],anonymous:0},ledger_effects:[],food_moves:[{from:'producer:ghost',to:'stock:S',amount:100,cause:'production'}],cause:{kind:'produce',driver_event_ids:[],rule_id:'wp5.produce',rng_stream:null,roll:null},resolution_change:null,scenario_source:null};
console.log('ghost-production-audit',auditDay(initial,[fake],final));let error='';try{runDay(initial,[{day:0,minute:1,key:'fake',kind:'produce',producer:'ghost',stock:'S',region:'G',amount:100}])}catch(e){error=String(e)}console.log('ghost-production-engine',error);

const live=runDay(initial,[{day:0,minute:1,key:'live',kind:'produce',producer:'W1',stock:'liveS',region:'G',amount:100}]);console.log('modeled-live-producer-control',auditDay(initial,live.records,live.state));
```

實際輸出：

```text
legitimate []
swapped-without-migration []
ghost-production-audit []
ghost-production-engine Error: NO_PRODUCER: ghost is not a living modeled producer
modeled-live-producer-control []
```

### #128 — `probe-events.ts`

```typescript
import {steer2D} from './engine/physics/local-steer.ts';
const params:any={sensing_radius_mm:.5,decision_interval_s:.2,probe_angles_deg:[0,90],same_heading_max_deg:20,stall_window_s:1,stall_progress_mm:.01,p_wait:null,p_back:null,p_reroute:null,wait_s:null,back_distance_mm:null,reroute_max_s:null};
const lanes=[{id:'L',centerline_mm:[{x:0,y:0},{x:100,y:0}],width_mm:10,layer:'G'}];const body={length_mm:2.5,width_mm:.8};
const ag=(id:string,s:number,start:number,goal=90)=>({id,lane:'L',s_mm:s,u_mm:0,dir:1 as const,start_t_s:start,goal_s_mm:goal,free_speed_mm_s:10,body});
const r=steer2D({lanes,obstacles:[],agents:[ag('A',10,0),ag('B',13.1,.15)],horizon_s:.2,policy:'C_sidestep',params,seed:1});
console.log(JSON.stringify({case:'contact-interval',events:r.events,agents:r.agents}));
for(const goal of [11,11.1]){
 const q=steer2D({lanes,obstacles:[],agents:[ag('A',10,0,goal)],horizon_s:.4,policy:'C_sidestep',params:{...params,decision_interval_s:.1},seed:1});console.log(JSON.stringify({case:'goal',goal,expected_arrival:(goal-10)/10,actual_arrival:q.agents.A.arrival_t_s,final:q.agents.A.final_mode,events:q.events,position:q.agents.A.samples.at(-1)}));
}
```

實際輸出：

```text
{"case":"contact-interval","events":[{"t_s":0,"kind":"start","agents":["A"],"class":"motion","detail":null},{"t_s":0,"kind":"go","agents":["A"],"class":"behavioural_response","detail":"straight ahead is free"},{"t_s":0.06000000000000027,"kind":"stop","agents":["A"],"class":"physical_constraint","detail":"contact with B would penetrate"},{"t_s":0.06000000000000027,"kind":"contact_start","agents":["A","B"],"class":"physical_contact","detail":null},{"t_s":0.06000000000000027,"kind":"contact_end","agents":["A","B"],"class":"physical_contact","detail":"gap opened in this decision interval (time = its start, or the contact start if later)"},{"t_s":0.15,"kind":"start","agents":["B"],"class":"motion","detail":null},{"t_s":0.15,"kind":"go","agents":["B"],"class":"behavioural_response","detail":"straight ahead is free"}],"agents":{"A":{"lane":"L","layer":"G","samples":[[0,10,0,0,10,0],[0.06000000000000027,10.600000000000003,0,0,10.600000000000003,0],[0.2,10.600000000000003,0,0,10.600000000000003,0]],"arrival_t_s":null,"final_mode":"waiting_or_stopped","final_speed_mm_s":0,"stop_cause":"contact with B would penetrate","geometry_stop_s_mm":null,"blocked_reports":0},"B":{"lane":"L","layer":"G","samples":[[0,13.1,0,0,13.1,0],[0.15,13.1,0,0,13.1,0],[0.2,13.6,0,0,13.6,0]],"arrival_t_s":null,"final_mode":"moving","final_speed_mm_s":10,"stop_cause":null,"geometry_stop_s_mm":null,"blocked_reports":0}}}
{"case":"goal","goal":11,"expected_arrival":0.1,"actual_arrival":null,"final":"waiting_or_stopped","events":[{"t_s":0,"kind":"start","agents":["A"],"class":"motion","detail":null},{"t_s":0,"kind":"go","agents":["A"],"class":"behavioural_response","detail":"straight ahead is free"},{"t_s":0.1,"kind":"stop","agents":["A"],"class":"physical_constraint","detail":"goal"}],"position":[0.4,11,0,0,11,0]}
{"case":"goal","goal":11.1,"expected_arrival":0.10999999999999996,"actual_arrival":0.10999999999999997,"final":"arrived","events":[{"t_s":0,"kind":"start","agents":["A"],"class":"motion","detail":null},{"t_s":0,"kind":"go","agents":["A"],"class":"behavioural_response","detail":"straight ahead is free"},{"t_s":0.10999999999999997,"kind":"arrive","agents":["A"],"class":"motion","detail":null}],"position":[0.4,11.1,0,0,11.1,0]}
```

### #124 — 實際瀏覽器 restart 對照輸出

```json
{"ended":true,"restarted_day":1,"expected_day1_ids":["W001","W002","W003","W004","W005","W006","W007","W008","W009","W010"],"restarted_ids":["W002","W003","W005","W007","W010"],"restart_matches":false,"gotoDay1_ids":["W001","W002","W003","W004","W005","W006","W007","W008","W009","W010"],"gotoDay1_matches":true}
```

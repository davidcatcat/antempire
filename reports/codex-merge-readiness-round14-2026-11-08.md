# Codex 指定修正提交複審・第 14 輪（2026-11-08）

本輪由 Codex 直接讀碼、重跑前輪反例及延伸反例，未委派其他模型。指定的五張修正 PR：#124、#125、#126、#128、#129；另查 #123、#127 的整合 SHA 與依賴。這是實際複審報告，不是轉述 Claude 的 CI 或批准。

**結論：#123、#125、#129 可合併；#127 可在 #123 合併後接續合併。#124 的產品修正通過，但目前與 main 有測試清單衝突，須整合後重跑 CI。#126、#128 的前輪缺陷已修，但各有一項新 P2，因此仍為 REQUEST CHANGES。**

沒有實際合併任何 PR、修改產品程式、改正式存檔／日誌／參數、推進 Day15 或啟動新版正式 Day0；只發布 Markdown 審查報告。GitHub 正式 review APPROVE 與這份審查報告不是同一個物件；本輪沒有向 GitHub 提交正式核准。

## 1. 版本與 CI（本輪獨立取得）

本輪 main 是 `6e8a83d89b4ee361c060aa74b4b742c444728bda`。#116、#117、#122 已合併，不能再要求等待它們。#125 的 base 已是 main，實際 base commit 為 `08ed59f`。

| PR | 完整 head SHA | GitHub checks | Codex 結論 |
|---|---|---|---|
| [#123](https://github.com/davidcatcat/antempire/pull/123) | `0904c8808c267e5e47a2547b089c9a3a3244f268` | 成功（頁面 SHA 相符） | APPROVE WITH COMMENTS；可合併 |
| [#124](https://github.com/davidcatcat/antempire/pull/124) | `46ee861e205c4f470dce728d1c164e614c554f4a` | 成功（頁面 SHA 相符） | 產品修正 APPROVE；整合衝突未解除 |
| [#125](https://github.com/davidcatcat/antempire/pull/125) | `4d6bde1afb42bf10af36732a3db4ba74982000f4` | 成功（頁面 SHA 相符） | APPROVE WITH COMMENTS；可合併 |
| [#126](https://github.com/davidcatcat/antempire/pull/126) | `692ba7d757c9c1fe4ba20276b27fad4452f9f7e5` | 成功（頁面 SHA 相符） | REQUEST CHANGES：R14-01 |
| [#127](https://github.com/davidcatcat/antempire/pull/127) | `06bfb884979d68429e603ec29db1e9411839bbd8` | 成功（頁面 SHA 相符） | APPROVE WITH COMMENTS；#123 之後 |
| [#128](https://github.com/davidcatcat/antempire/pull/128) | `387a6096b5cc02958e6c63d98db9dca6c219aae9` | 成功（頁面 SHA 相符） | REQUEST CHANGES：R14-02 |
| [#129](https://github.com/davidcatcat/antempire/pull/129) | `421ff1f0cd4f69f8df13a26fe04349c174ae56f6` | 成功（頁面 SHA 相符） | APPROVE WITH COMMENTS；可合併 |

#123 的實際整合 head 是 `0904c88`、#127 是 `06bfb88`，均非前輪舊 head。七張 checks 頁本輪都成功取得並確認綠燈；初次 #123／#125／#127 抓取回應 503，重試成功。沒有把作者自報 CI 當成獨立驗證。

## 2. 前輪六項 P2 的複驗

| 前輪項目 | 本輪實際結果 | 判定 |
|---|---|---|
| R13-01 #124 restart 沿用 Day30 名冊 | 同一 A1 重播：結束→重新播放的 Day1 為 W001～W010 十隻，與重新 `gotoDay(1)` 相同；桌機、手機腳本亦覆蓋 restart | 已修 |
| R13-02 #125 環境與排程器部分提交 | 同一 civil-dawn／foreign batch：foreign 丟錯或回傳非法 cancel，兩邊 snapshot 都不變；移除故障重試，完整 snapshot 與正常路徑逐字相同 | 已修 |
| R13-03 #126 無紀錄個體跨區互換 | W1／W2 的期末 region 交換被逐 ID replay 拒絕；合法原始日仍接受 | 已修 |
| R13-04 #126 ghost producer | 同一筆平衡 produce 紀錄被獨立 audit 拒絕；存在的 modeled producer 對照接受 | 已修 |
| R13-05 #128 一般移動在決策格點漏記抵達 | 從 10 到 11 mm，10 mm/s，dt=0.1 s：正確 arrive=0.1 s；非格點對照仍為 0.11 s | 已修；但另有 R14-02 |
| R13-06 #128 contact_end 倒填 | 同一 A/B 延遲出發例：contact_start=0.06000000000000027，contact_end=0.1500000100000008，並有數值 bracket；不再早於 B 的 0.15 s 出發 | 已修 |

#125 使用副本計算與 CommitCell，讀完 handler 輸出、驗證所有 cell prepare 後才由 scheduler 寫入 cell。`ClockRun.state` 與 days 凍結，cell、暫存為私有欄位，失敗不對外發布 staged 狀態。已讀取新 scheduler／ClockRun 提交程式與對應測試。保證只涵蓋 scheduler 與所附 cells；foreign／prepare 自行寫到其他外部物件的副作用仍不回滾，文件有清楚限定，不能稱為任意外部狀態的通用交易。

## 3. 新 P2：R14-01 — #126 仍接受不符合群組分攤規則的升級

**位置**：`prototypes/mixed-precision/audit.ts:284–297`，及共享帳重播 `audit.ts:91–101`。目前只驗證 food move 的來源／目的區室與期末帳相符，沒有獨立重算每個群組區室應釋放的量。

**契約**：`docs/od1-mixed-precision-open-ecology.md:74` 明定升級各區室取 `floor(合計/count)`，最後一隻取全部餘數，並稱獨立稽核會重算。`ledger.ts` 的 `releaseShare()` 確實如此執行。

**最小合法對照**：G 中一個成蟲蚜蟲群組，count=2、sugar=100 µp，含一個既有 roster ID；執行一次合法 promote。真引擎輸出新個體 sugar=50、剩餘群組 sugar=50、food_move=50，audit 接受。

**反例**：只把同一筆 food_move 改成 **1** µp，期末新個體改為 **1**、剩餘群組改為 **99**。數量、總糖、身分、位置、生理快照與來源方向全都仍閉合，但違反每隻平均份額規則。新 audit 仍回傳 **`[]`**。

本項不是宣稱總質量不守恆，而是**守恆仍不足以證明表示層切換合法**；完整記錄與期末一起被改寫時，獨立 reader 會替錯誤的個體儲備背書。這可直接改變後續個體營養狀態。

**要求**：獨立重播逐區室餘額與事件前 count，按已宣告規則重算 promote、群組死亡、cohort crossing／transport 的份額，核對所有應有的 move、金額與目的；demote 應確認個體區室全數併入。包含有餘數、最後一隻、連續多次切換，以及金額都閉合但比例錯誤的反例。不要以同呼叫 `releaseShare()` 的方式削弱讀取器獨立性。

## 4. 新 P2：R14-02 — #128 在 horizon 當下出發且已在目的地，漏記抵達

**位置**：`engine/physics/local-steer.ts:411–443`。外迴圈只跑 `t0 < H`，live 篩選又用 `a.start < t1`；因此恰好在 H 開始的個體完全沒有事件，即使剩餘距離為零。

合法開闊單直線 100 mm、寬 10 mm，一隻 A 在 s=10、goal=10，速度 10 mm/s、dt=0.1、H=0.4，C_sidestep（感知半徑 0.5；其餘沿前輪合法探針）：

| start_t_s | 此版 steer arrival | 同輸入 PH-3b `solve2D` | 正確預期 |
|---|---|---|---|
| 0.399 | 0.399 | 0.399 | 0.399 |
| **0.4** | **null，事件空陣列** | **0.4** | **0.4** |
| 0.401 | null | null | null |

本檔文件明確採 PH-3b 的 `t ≤ horizon` 語意，也明定初始在目標者於 start 到達。現有回歸已涵蓋「走到 H 才抵達」與「H 後才出發」，但漏掉「就在 H 出發且路程為零」的組合。這是解析邊界反例，與讓路規則或文獻參數無關。

**要求**：在 horizon 處完成仍合法的零距離 start／arrive 處理且恰一次，不把 H 後事件提前。保留一般移動與接觸時間的已修斷言，加入本表三個對照；各候選及無讓路控制應一致。不要只把 `<` 全部改為 `<=` 而造成零長區間、重複事件或非零路程在 H 移動。

## 5. 合併就緒與實際整合障礙

- **#123**：新的整合 head 重跑生命史研究 127 項與型別通過；研究程式及證據矩陣相對前輪未改，新增的是已在 main 的 scheduler／契約。可合併為研究資料及模型比較，不代表選定正式生命史模型。
- **#125**：348 項 scheduler、18,758 項時間契約、3,148 項 clock、43 項多群時間軸、113 項 isolation、型別通過。原子性獨立反例與失敗後重試通過。已改接 main，可合併其隔離工程。
- **#129**：純文件，補歷史快照、重播／即時模擬區分與 R13 記錄；checks 綠、對 main 無衝突，可合併。標成歷史快照的 R13 REQUEST CHANGES 不因本輪部分通過而成錯誤；可另追加 R14 更新。
- **#127**：新的 head **已包含 #123 的 head `0904c88` 作為祖先**，與當前 main 合併模擬成功，與 #123 互合亦成功。1,070 項、型別通過。建議 #123 先合併，再確認新 main CI／mergeability；目前不是上輪那種測試清單衝突。前輪非阻擋數學意見仍在：固定一口可能超過剩餘 need，文件 `D ≤ Σ need` 應限定截斷後有效供給，不能套在所有實際送達量上。
- **#124**：產品修正通過，Node 7,519、web build、型別，以及實際 Chromium 桌機／Android 31 項都通過，console errors／failures 皆空。restart 的十隻名冊對照成功。**但與目前 main 的 `tests/run-all.ts` 有 merge conflict**，因此不能說目前 head 已可直接按 Merge。需保留兩側 scheduler／isolation／V6 等全部註冊，整合後重跑 CI；本報告的產品批准不自動涵蓋未出現的整合提交。
- **#126／#128**：除了新 P2，目前兩者也都與 main 的 `tests/run-all.ts` 衝突；不能僅重新產生報告或改文件來解決新反例。

合併模擬用 `git merge-tree --write-tree main head`，只產生本地暫存 tree，不移動 main／PR ref，不產生遠端 merge commit。#126 與 #129 的 Roadmap 內容互合目前成功，真正合併時仍須保留兩側內容。

## 6. 測試與科學界線

所有本輪 Node 測試使用 **22.23.4**，各 head 以 git archive 建立獨立目錄，鎖檔與既有依賴核對一致；物理依賴 Rapier 0.21.0，Chromium + Playwright 1.63.0。正式工作目錄未改。

main `6e8a83d`：本輪完整 `npm test` **70/70** 通過，`check:saves` **20/20**，`npm run typecheck` 通過（各命令 exit 0）。各 PR 另執行下列相關測試，沒有宣稱每個 head 都完整跑一次 70 套。

| 本輪對象 | 實際結果 |
|---|---|
| #123 | 127 項、型別通過 |
| #124 | Node 7,519 項／16,840 frames；型別、build；Chromium 31 項、0 failures、0 errors |
| #125 | 348＋18,758＋3,148＋43＋113＋87 項、型別；獨立原子性、重入探針通過 |
| #126 | 214 項、型別通過；舊兩反例拒絕，新分攤反例仍被接受 |
| #127 | 1,070 項、型別通過 |
| #128 | local-steer 49,815 項（921 次抵達／2,936 段接觸）、playback 77,230 項／39 runs、型別通過；獨立 horizon 邊界反例失敗 |
| #129 | 純文件、GitHub checks 綠、無合併衝突 |

瀏覽器桌機平均約 59.9 FPS、Android 約 60.0；4× CPU 約 41.3 FPS，已降畫布解析度。這是本環境的短時量測，不能推論所有手機硬體。瀏覽器 harness 的 review 副本只指定系統 Chromium executablePath；最初預設 Playwright browser 路徑不存在，後來改用已安裝 Chromium 完成驗收，沒有放寬任何產品斷言。

本輪 #128 新增了 N_no_yield 控制、流入／有限容量出口、contact_end 獨立檢查與決策間隔敏感度；已讀相關程式與標示。它們是合成情境與候選規則，不是本種窄道行為證據。出口移除造成的 `contact_end_estimated` 明確標 `usable_as_cause:false`，不得當真實分離／餵食因果。決策間隔改變會改變停等行為，不能把 dt 敏感度說成對同一生物模型的純數值收斂。PH-3b 基線的接觸結束仍有作者明列的近似限制，這次候選 contact_end 修正不代表所有基線 contact_end 已可用於生物因果；本輪沒有把該作者自報問題重新列為獨立重現。千隻高密度結果與效能仍是特定情境；本輪未重跑所有千隻離線報告，不能替作者每一個 CPU 數字背書。

文獻界線沿用前輪：#123 的本種 Yuan、臺灣 Chang 等原始全文與補充表，本輪未重新取得；只核對 repo 證據矩陣、觀察算子、產生報告程式與限制是否一致。跨群 SD 不可直接當個體 CV；里程碑平均差不可當逐隻階段分布；區間壽命、冷處理與外推仍是限制。#127 是單日反事實、無多日回饋；#125 天文精度不代表本種活動規則；#126 群組期間的非焦點個體生理不前進已明列為限制。上述條件下可合併研究／隔離工程，不能用作新版正式 Day0 的科學放行。

## 7. 可重跑的新反例與原始輸出

以下檔案放在各自表列 head 根目錄，用 `node 檔名.ts` 執行，不寫正式資料。

### #126 `probe-share.ts`

```typescript
import {runDay,type WorldState,cohortId} from './prototypes/mixed-precision/ledger.ts';
import {auditDay} from './prototypes/mixed-precision/audit.ts';
const C=cohortId('G','aphid','adult',null);
const initial:WorldState={schema:'antempire.wp5-mixed-precision.v1',seed:'fixture',day:0,regions:[{id:'G',resolution:'fine',in_garden:true}],individuals:[],cohorts:[{cohort_id:C,taxon:'aphid',stage:'adult',colony_id:null,region:'G',count:2,comp:{sugar:100},roster:[{id:'X',physio:{age:2}}],next_serial:0}],stocks:[],sinks:{},producers:{},retired:[],scenario_records:[],used_scenario_records:[],policy:{non_demotable_colonies:[]}};
const legit=runDay(initial,[{day:0,minute:1,key:'prom',kind:'promote',cohort:C,trigger:{kind:'contact_with_focal',driver_event_ids:['contact:x']}}]);
console.log('legitimate',JSON.stringify({records:legit.records,cohorts:legit.state.cohorts,individuals:legit.state.individuals,audit:auditDay(initial,legit.records,legit.state)}));
const records=structuredClone(legit.records),final=structuredClone(legit.state); const move=records[0].food_moves[0],owner=final.individuals[0];
move.amount=1;owner.comp.sugar=1;final.cohorts[0].comp.sugar=99;
console.log('forged',JSON.stringify({move,cohort:final.cohorts[0].comp,individual:owner.comp,audit:auditDay(initial,records,final)}));
```

```text
legitimate {"records":[{"event_id":"0.prom","kind":"promote","t":{"day":0,"minute":1,"time_resolution":"minute"},"source_region":"G","destination_region":"G","identity":{"action":"minted","ids":["M.C.G.aphid.adult.-.0"],"anonymous":0},"ledger_effects":[],"food_moves":[{"from":"cohort:C|G|aphid|adult|-:sugar","to":"org:M.C.G.aphid.adult.-.0:sugar","amount":50,"cause":"promotion_share"}],"cause":{"kind":"contact_with_focal","driver_event_ids":["contact:x"],"rule_id":"wp5.promote","rng_stream":"promote","roll":0.734750967938453},"resolution_change":null,"scenario_source":null,"parent":null,"cohort_id":"C|G|aphid|adult|-"}],"cohorts":[{"cohort_id":"C|G|aphid|adult|-","taxon":"aphid","stage":"adult","colony_id":null,"region":"G","count":1,"comp":{"sugar":50},"roster":[{"id":"X","physio":{"age":2}}],"next_serial":1}],"individuals":[{"id":"M.C.G.aphid.adult.-.0","taxon":"aphid","stage":"adult","colony_id":null,"region":"G","physio":{},"comp":{"sugar":50}}],"audit":[]}
forged {"move":{"from":"cohort:C|G|aphid|adult|-:sugar","to":"org:M.C.G.aphid.adult.-.0:sugar","amount":1,"cause":"promotion_share"},"cohort":{"sugar":99},"individual":{"sugar":1},"audit":[]}
```

### #128 `probe-horizon-start.ts`

```typescript
import {steer2D} from './engine/physics/local-steer.ts';
import {solve2D} from './engine/physics/solver2d.ts';
const base={lanes:[{id:'L',centerline_mm:[{x:0,y:0},{x:100,y:0}],width_mm:10,layer:'G'}],obstacles:[],horizon_s:.4};
const params={sensing_radius_mm:.5,decision_interval_s:.1,probe_angles_deg:[0,90],same_heading_max_deg:20,stall_window_s:1,stall_progress_mm:.01,p_wait:null,p_back:null,p_reroute:null,wait_s:null,back_distance_mm:null,reroute_max_s:null};
for(const t of [.399,.4,.401]){
 const input={...base,agents:[{id:'A',lane:'L',s_mm:10,u_mm:0,dir:1 as const,start_t_s:t,goal_s_mm:10,free_speed_mm_s:10,body:{length_mm:2.5,width_mm:.8}}]};
 const a=steer2D({...input,policy:'C_sidestep',params,seed:1}),b=solve2D(input);
 console.log(JSON.stringify({start:t,steer:a.agents.A.arrival_t_s,physics:b.agents.A.arrival_t_s,events:a.events}));
}
```

```text
{"start":0.399,"steer":0.399,"physics":0.399,"events":[{"t_s":0.399,"kind":"start","agents":["A"],"class":"motion","detail":null},{"t_s":0.399,"kind":"arrive","agents":["A"],"class":"motion","detail":null}]}
{"start":0.4,"steer":null,"physics":0.4,"events":[]}
{"start":0.401,"steer":null,"physics":null,"events":[]}
```

### #125 `probe-clock-atomic.ts`

```typescript
import assert from 'node:assert/strict';
import {ClockRun} from './engine/clock/environment.ts';
const cfg:any={world:'W',official:false,anchor:{day0_date:'2027-06-21',utc_offset_minutes:480,zone:'Asia/Taipei'},site:{latitude_deg:24.17,longitude_deg:120.64},order:'layered',sample_step_min:60,first_day:0,last_day:0,seed:7,temperature_shape:null,rain_timing:null};
const input:any={date:'2027-06-21',provenance:{kind:'synthetic_climatology',synthetic:true,assumption:true,source:'review fixture',station_id:null,source_url:null,issued_at:null,valid_from:null,valid_to:null,generator:'fixture',rng_stream:'fixture'},t_min_c:20,t_max_c:30,t_mean_c:25,rh_mean_percent:70,rain_mm:0,hourly:null};
let clean: string | null = null;
for(const fail of [false,true,"invalid-output"]){
 const r=new ClockRun(cfg,[input]);const d=r.scheduler.pending().find(e=>e.kind==='light_civil_dawn')!;
 r.scheduler.schedule({kind:'foreign_case',key:'x',native:d.native,scope:{world:'W',colony:null,individual:null},source:null,target:null});
 r.runUntil({day:0,minute:Math.floor(d.at.minute)});const before=JSON.stringify(r.state),sched=JSON.stringify(r.scheduler.snapshot());
 r.foreign=()=>{if(fail===true)throw Error('transient foreign failure');if(fail==='invalid-output')return {cancel:[{id:'missing',reason:'probe'}]}};let error='',retry='';try{r.scheduler.step(r.handler)}catch(e){error=String(e)}
 const stateChanged=before!==JSON.stringify(r.state),schedulerChanged=sched!==JSON.stringify(r.scheduler.snapshot());
 if(fail){r.foreign=()=>{};try{r.scheduler.step(r.handler)}catch(e){retry=String(e)}}
 if(!fail)clean=JSON.stringify(r.snapshot());else {assert(!stateChanged);assert(!schedulerChanged);assert.equal(retry,'');assert.equal(JSON.stringify(r.snapshot()),clean)}
 console.log(JSON.stringify({fail,dawn:d.at.minute,error,environment_changed:stateChanged,scheduler_changed:schedulerChanged,light:r.state.light,retry_error:retry}));
}
```

```text
{"fail":false,"dawn":284.565614,"error":"","environment_changed":true,"scheduler_changed":true,"light":"civil_twilight","retry_error":""}
{"fail":true,"dawn":284.565614,"error":"Error: transient foreign failure","environment_changed":false,"scheduler_changed":false,"light":"civil_twilight","retry_error":""}
{"fail":"invalid-output","dawn":284.565614,"error":"SchedulerError: WORLD_SCHEDULER: cancel of unknown event missing","environment_changed":false,"scheduler_changed":false,"light":"civil_twilight","retry_error":""}
```

### #124 restart 反例複驗

```json
{"ended":true,"restarted_day":1,"expected_day1_ids":["W001","W002","W003","W004","W005","W006","W007","W008","W009","W010"],"restarted_ids":["W001","W002","W003","W004","W005","W006","W007","W008","W009","W010"],"restart_matches":true,"gotoDay1_ids":["W001","W002","W003","W004","W005","W006","W007","W008","W009","W010"],"gotoDay1_matches":true}
```

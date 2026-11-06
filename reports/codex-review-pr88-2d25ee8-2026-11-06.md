# Codex review：PR #88 第三輪（2d25ee8）

日期：2026-11-06（Asia/Taipei）。結論：**APPROVE WITH COMMENTS**（限本輪工程修正）。上輪 P2 已由獨立探針確認修正，本輪沒有新增 P1／P2；有一項 P3 回歸測試注入方式需要改善。這不是科學驗證或正式模型切換的核准。

## 1. 審查對象與方法

- PR #88 head：`2d25ee8919ead21d3c16ea07392f4d9452fdf076`。
- 上輪 head：`ece3bc2562c9aa6c7219884d4815e56a807dfbf7`。
- 本輪開始時 main：`f07e73a11e9d26aac0d085cc57196e5c133c59a3`。相較先前 main `e93933f`，新增的是 #86 C4 設計文件，沒有引擎改動。PR 仍基於先前的 main；本輪沒有自行合併或 rebase。
- Node **22.23.4**，在固定 SHA 的 Git archive 隔離目錄，依 lockfile 安裝依賴，閱讀修正並執行原測試與獨立探針。
- 檢查 `checkCarcassTakes` 的日循環接入點、引擎與獨立讀取器的儲存順序重播、同工蟻同食源的 C2 collect 對應，以及 N18／N19 測試。

前輪報告：[ece3bc2 審查](https://github.com/davidcatcat/antempire/blob/feeb6c868efa5e4f561d5d99d5d1598dc7294579/reports/codex-review-pr88-ece3bc2-2026-11-06.md)。該 SHA 的漏洞紀錄保留；以下為新 SHA 的複驗結果。

## 2. 上輪 P2 已修正

新版完整日讀取器不再直接相信任意批次消耗量。它從生態流量重建批次，再依事件順序處理新屍體與各次採集；採集必須對應同工蟻、同食源的 C2 蛋白 collect 轉移，並符合現行模型逐批次儲存順序的取用結果。

引擎也新增 `checkCarcassTakes`，在生態步驟後拍攝批次快照，在 foraging 和原 C2 source check 之後檢查。它獨立重算採集分配，並核對期末批次 ID、original_day 與蛋白量；預設關閉的 source-flow 開關仍控制這項新檢查。

### 用上輪同一個完整日反例重跑

保留上輪探針設定：Day14 fixture，F07 兩批各 100 份、original_day 分別 6／14。先真正執行 `simulateWorldDay`，再只改輸出複本：老批次減 0.1、年輕批次加 0.1，在真實蟻群事件列表加入同一真實工蟻的 +0.1／−0.1 批次採集紀錄，不更改 C2 transfer。

| 輸入 | 新引擎 checkCarcassTakes | 獨立 replaySourceFlows |
|---|---|---|
| 未修改完整日對照 | 接受 | `ok: true` |
| 真正加入 +0.1／−0.1 紀錄並移轉批次蛋白 | 拒絕：`take YOUNG at F07: -0.1` | 拒絕：`batch take YOUNG of -0.1 portions (must be positive)`，另報未對應 collect 及期末不符 |
| 刪掉真實批次採集紀錄 | 拒絕 | 拒絕 |
| 重複真實批次採集紀錄 | 拒絕 | 拒絕 |
| 採集紀錄的工蟻改為不存在的 ID | 拒絕 | 拒絕 |
| 保持正數，只改取用批次並配平期末兩批蛋白 | 拒絕：不符儲存順序 | 拒絕：不符儲存順序與期末重建 |

這些都是獨立操作真正的巢群事件陣列，而非依賴下節有缺陷的測試 helper。原先兩個 C2 讀取器依舊接受「只偽造批次紀錄」的攻擊，這是它們原有總量職責的界線；新讀取器已能補上拒絕，不再存在上輪三個讀取器合用仍通過的情況。

## 3. F88-R3-01 — P3：N18 的 splice 沒有將負數紀錄加入送驗事件

位置：`tests/source-flows-v26.test.ts` 的 takeEngine／takeReader helper 及 forge callback。

引擎 helper 執行：

```ts
editEvents(ev.flat());
checkCarcassTakes(..., ev, ...);
```

讀取器 helper 執行：

```ts
editEvents(res.colonies.flatMap(c => c.events));
replaySourceFlows(..., res, ...);
```

`flat`／`flatMap` 會建立新的陣列。既有事件物件仍共享參照，因此 `ev[k].quantity_portions += 0.1` 會寫回送驗事件；但是 `splice(k + 1, 0, negativeRecord)` 只改新陣列，不會改原本的 `colony.events`。

我把原測試複製為隔離的 instrumented script，只加入觀測、不改斷言，執行輸出：

```text
N18_ENGINE_INJECTION {"edited_flat_negatives":1,"actual_events_negatives":0}
N18_READER_INJECTION {"edited_flat_negatives":1,"actual_events_negatives":0}
```

因此目前 N18 測到的是「原有正數採集量被加大」，不是它宣稱的「正負紀錄配對抵銷」。N19 只改既有物件欄位，沒有這個 splice 問題。

建議把 edit callback 改為直接取得某個真實 colony.events 陣列，或將回傳的新陣列明確寫回；再於呼叫檢查器前斷言：負數事件確實在送驗列表中、期末食源總量不變、C2 collect 不變，並保留合法對照。

此項列 P3：它影響回歸證據的準確性，但本輪獨立完整日探針已真正注入同一攻擊並確認引擎與讀取器拒絕，所以沒有以這個測試缺口推論產品修正失效。

## 4. 科學與模型界線

本輪新增的驗證採用既有 `takeProtein` 的儲存順序，屬於現行模型的一致性契約。文件已明示它是遊戲假設，沒有宣稱真實螞蟻會依程式陣列順序取食，這項分類合理。

前輪已修正的花蜜證據界線維持：Nepi & Stpiczyńska (2008), *The complexity of nectar: secretion and resorption dynamically regulate nectar features*, DOI **10.1007/s00114-007-0307-2**，提供一般分泌／再吸收背景；不能證成本站植物每天將所有超過硬上限的量立即再吸收。Way (1963), *Mutualism between ants and honeydew-producing Homoptera*, *Annual Review of Entomology* 8:307–344，也不能校準本站蜜露容量或流失速率。新版已將這些量及規則標為假設。

本輪沒有新取得上述文獻全文，不宣稱全文複核。屍體到期的科學矛盾、固定競爭者比例及尚未建模的植物／分解者內部物質池仍是既有限制。工程驗證不能取代螞蟻行為、營養與生態過程的觀測驗證。

## 5. 實際驗證

- `npm run typecheck`：通過。
- `node tests/source-flows-v26.test.ts`：**2,153 項通過**；1,880 世界日，開關前後 1,880/1,880 相同（原測試涵蓋的樣本）。
- `npm test`：**48/48 腳本一次通過**。本輪使用可執行本機 HTTP／子程序測試的環境，未修改測試或繞過斷言。
- `npm run check:saves`：**20/20 通過**。
- 獨立完整日探針：未修改對照被引擎與讀取器接受；真正加入正負批次紀錄的攻擊及四個變體均被兩者拒絕。
- N18 的加觀測副本：專項斷言保持不變且通過，但輸出確認原 helper 的實際送驗事件中負數筆數為 0。

## 6. 變更範圍

本輪沒有修改產品程式、原測試斷言、參數、正式存檔或 journal，沒有合併 PR、重寫分支、推進 Day15 或啟動正式新版 Day0。探針與加觀測的測試只寫在隔離 archive；上傳內容只有本 Markdown 報告。

## 附錄：獨立完整日反例及四種變體

以下在固定 SHA 根目錄以 Node 22.23.4 執行。與 N18 helper 不同，反例直接 push／splice 真實 `result.colonies[0].events`。

```ts
import { loadBundle } from './cli/lib/load.ts';
import { resolveBundle,simulateWorldDay,legacyToWorldState,legacyColonyMeta } from './engine/index.ts';
import { fixture } from './tests/lib/harness.ts';
import { replaySourceFlows } from './cli/lib/source-flow-replay.ts';
import { replayEngineColonyDay,replayEngineSourcesDay,speciesFoodTiming } from './cli/lib/engine-transfers.ts';
const b:any=loadBundle();b.world.source_flows.record_source_flows_v26=true;const wp=resolveBundle(b).world;
const start:any=legacyToWorldState(fixture() as any,legacyColonyMeta(b.world.scenario_colonies as any));
const id='F07';start.sources[id].batches=[{event_id:'OLD',original_day:6,age_days:8,protein:100,origin:'review'},{event_id:'YOUNG',original_day:14,age_days:0,protein:100,origin:'review'}];start.sources[id].protein=200;
const out:any=simulateWorldDay(start,b);
function check(label:string,o:any){const c=o.result.colonies[0];console.log(label,JSON.stringify({flow:replaySourceFlows(start,o.state,o.result,wp),colony:replayEngineColonyDay(start.colonies[0],o.state.colonies[0],c.events,o.day,new Set(Object.keys(start.sources))).ok,sources:replayEngineSourcesDay(o.state.sources,o.result.colonies.map((r:any)=>({id:r.colony_id,events:r.events,timing:speciesFoodTiming(b.species[r.species_id])})))}))}
check('baseline',out);
const f=structuredClone(out);f.state.sources[id].batches[0].protein-=.1;f.state.sources[id].batches[1].protein+=.1;
const worker=start.colonies[0].population.workers[0].id;
f.result.colonies[0].events.push({type:'source_batch_consumed',location:id,source_event_id:'OLD',quantity_portions:.1,worker},{type:'source_batch_consumed',location:id,source_event_id:'YOUNG',quantity_portions:-.1,worker});check('forged',f);

const {growEcology,carcassPiles,checkCarcassTakes}=await import('./engine/ecology.ts');
const eworld:any=structuredClone(start);growEcology(eworld,wp,out.result.weather,[]);
for(const [label,o] of [['baseline',out],['forged',f]] as any){try{checkCarcassTakes(carcassPiles(eworld.sources),o.result.colonies.map((c:any)=>c.events),o.state.sources,start.sim_day+1);console.log('ENGINE',label,'ACCEPT')}catch(e){console.log('ENGINE',label,String(e))}}
const cases:[string,(o:any)=>void][]=[
 ['missing take',o=>{const a=o.result.colonies[0].events;const k=a.findIndex((e:any)=>e.type==='source_batch_consumed');a.splice(k,1)}],
 ['duplicate take',o=>{const a=o.result.colonies[0].events;const k=a.findIndex((e:any)=>e.type==='source_batch_consumed');a.splice(k,0,structuredClone(a[k]))}],
 ['wrong worker',o=>{o.result.colonies[0].events.find((e:any)=>e.type==='source_batch_consumed').worker='MISSING-WORKER'}],
 ['positive batch relabel',o=>{const t=o.result.colonies[0].events.find((e:any)=>e.type==='source_batch_consumed'&&e.location===id&&e.source_event_id==='OLD');t.source_event_id='YOUNG';o.state.sources[id].batches[0].protein+=t.quantity_portions;o.state.sources[id].batches[1].protein-=t.quantity_portions}]
];
for(const [label,edit] of cases){const o=structuredClone(out);edit(o);let engine='ACCEPT';try{checkCarcassTakes(carcassPiles(eworld.sources),o.result.colonies.map((c:any)=>c.events),o.state.sources,start.sim_day+1)}catch(e){engine=String(e)}const r=replaySourceFlows(start,o.state,o.result,wp);console.log('VARIANT',label,JSON.stringify({engine,reader:r.ok,errors:r.errors.slice(0,2)}))}

```

# Codex review：PR #88 第二輪（ece3bc2）

日期：2026-11-06（Asia/Taipei）。結論：**REQUEST CHANGES**。前輪兩項 P2 的原始反例已修正，P3 文獻推論標示已修正；本輪重播讀取器仍有一項 **P2**。

## 1. 固定審查對象

- PR #88 head：`ece3bc2562c9aa6c7219884d4815e56a807dfbf7`。
- main：`e93933f88240b5e4625f000c899b402911982743`。
- 本輪修正 commit：`ece3bc2`，前輪對象：`290c440`。
- Node **22.23.4**，在 Git archive 隔離目錄安裝 lockfile 依賴、執行檢查。原工作分支未切換。
- 直接審查新增的引擎逐批次檢查、完整日批次重播、容量計算、測試與科學證據文件。

前輪報告：[固定在 290c440 的審查](https://github.com/davidcatcat/antempire/blob/0da4e212abc9c8b49f7eb19db35473c9cf42184a/reports/codex-review-pr88-290c440-2026-11-06.md)。其反例在舊 SHA 的結果仍然成立；本報告更新新 SHA 的狀態。

## 2. F88-R2-01 — P2：未驗證的批次採集紀錄能抵銷非法批次移轉

位置：[cli/lib/source-flow-replay.ts:119](https://github.com/davidcatcat/antempire/blob/ece3bc2562c9aa6c7219884d4815e56a807dfbf7/cli/lib/source-flow-replay.ts#L119)、[135–138](https://github.com/davidcatcat/antempire/blob/ece3bc2562c9aa6c7219884d4815e56a807dfbf7/cli/lib/source-flow-replay.ts#L135)。

新增重播從 `source_batch_consumed` 取得批次採集量，以 `w.protein -= Number(e.quantity_portions)` 直接入帳，沒有先驗證金額正數，也沒有將這批紀錄和 C2 的實際採集轉移核對。單純依期末總量閉合無法補足這項檢查。

### 完整日反例（已實際執行）

1. 從 Day14 fixture 的世界開始，打開 source flows，其他參數不變。
2. F07 建立兩個各 100 份的批次：OLD 的 original_day = 6，YOUNG = 14；同步 `source.protein = 200`。這是刻意建立的工程測試輸入，不是宣稱花園實測有這個存量。
3. 真正執行一次 `simulateWorldDay(start, bundle)`，作合法對照。
4. 複製輸出，只改 F07 期末 OLD 減 0.1、YOUNG 加 0.1；總量與 `source.protein` 不變。
5. 在真實蟻群的事件列表附加兩筆，worker 使用真實工蟻 ID：

```json
{"type":"source_batch_consumed","location":"F07","source_event_id":"OLD","quantity_portions":0.1,"worker":"實際存在的工蟻 ID"}
{"type":"source_batch_consumed","location":"F07","source_event_id":"YOUNG","quantity_portions":-0.1,"worker":"同一工蟻 ID"}
```

不修改任何 `food_transfer`、當日生態流量、蟻群狀態或其他來源紀錄。

| 檢查 | 合法對照 | 偽造期末批次＋兩筆紀錄 |
|---|---|---|
| 新 `replaySourceFlows` | `ok: true` | **`ok: true, errors: []`** |
| C2 `replayEngineColonyDay` | `ok: true` | **`ok: true`** |
| C2 `replayEngineSourcesDay` | `[]` | **`[]`** |

新讀取器回報 overflow／expired／washoff／decay 的 `unevented` 仍全部為 0。這表示即使把現有三個讀取器一起使用，仍沒有驗證這兩筆批次採集。負採集量把年輕批次增加的蛋白偽裝成合法重建結果；舊批次隔日到期時，供應量因此不同。

**範圍界線**：本輪並未發現正常產生器會自動寫出負採集量。引擎 `checkSourceFlows` 的生態步驟批次檢查已修正前輪反例；上述攻擊針對完整日輸出與獨立讀取器，不能據此說引擎該檢查也再次被繞過。

### 修正與驗收建議

- 使用前先檢查每筆 `source_batch_consumed` 的來源、批次、數量為有限正數及所屬蟻群／工蟻；負數不能代表退回來源，退回必須有自己的合法事件。
- 按工蟻、食源及採集時序，把批次消耗量與 C2 的蛋白採集轉移核對；只有格式檢查不能證明這些消耗確實發生。
- 批次不得因採集透支，來源與批次 ID 必須存在。錯誤食源的紀錄不能被略過後當作完整重播成功。
- 保留合法完整日對照；新增本反例，以及缺少 C2 對應、重複批次消耗、批次消耗量與合法採集不符的負面測試。

這些是重播資料的工程因果契約，不需要先選新的生態參數。

## 3. 前輪三項的複驗結果

| 前輪項目 | 本輪結果 | 獨立複驗 |
|---|---|---|
| F88-01：總量不變的批次移轉／返老 | 原始反例已修正；完整日新驗證另有 §2 缺口 | 以同樣 Day14 的兩個 1 份批次，期末挪動 0.1：引擎、讀取器各自拒絕；只改 original_day 也各自拒絕。未動對照都接受 |
| F88-02：期初超容量、無開花時新開關中止 | 已修正 | 預設參數 Day0 A1 seed 2、2027-03-21、F08 sugar 3.4/capacity 2.4、bloom_days_left 0、無雨，開關關閉與打開都能執行；兩個容量選項四種組合下，新讀取器都接受 |
| F88-03：再吸收文獻被推論為從未分泌 | 標示已修正 | R389、設計文件及 FLOW_BASIS 改為區分 resorption 與未分泌；withheld 為無直接證據的替代假設，預設關閉 |

引擎對來源快照的參數已由批次 ID 字串改為 `{ id, protein, original_day }`。本輪探針使用新介面，不以舊參數呼叫失敗作為「修正有效」的證據。

## 4. 科學根據與界線

Nepi & Stpiczyńska (2008), *The complexity of nectar: secretion and resorption dynamically regulate nectar features*, *Naturwissenschaften* 95:177–184，DOI **10.1007/s00114-007-0307-2**：可作花蜜分泌／再吸收的一般機制背景。新版把再吸收記為 source → plant、承認花蜜曾存在，因果含義比前版正確；但「每天把超過硬上限的全部量立即再吸收」仍是候選規則，並未由該花園植物資料驗證。新版已標示量、速率與容量是假設，本輪不再列原 P3。

Way (1963), *Mutualism between ants and honeydew-producing Homoptera*, *Annual Review of Entomology* 8:307–344：提供蜜露累積及相關利用的一般背景。新版明確限定其不能決定本站流失方式或數量，這個證據界線合理。

本輪沒有取得這兩篇全文，沒有宣稱全文複核或本種科學驗證。屍體到期的既有科學矛盾、固定 rival 比例與未建模的植物內部／分解者仍是既有模型限制；記錄流出去向不等於整個生態系物質守恆。前輪已揭露、且未在本輪改變的問題不重列成新缺陷。

## 5. 驗證

- `npm run typecheck`：通過。
- `node tests/source-flows-v26.test.ts`：**2,145 項通過**；1,880 世界日，開關前後 1,880/1,880 相同（原測試覆蓋的輸入）。
- `npm test` 首次：**46/48** 通過。`web-serve` 因沙箱 `listen EPERM` 失敗；`save-transaction` 的混合存檔子程序斷言失敗。
- 僅重跑上述兩項，改用較少限制的執行環境、程式與測試完全不變：**兩項均通過**。因此 48 項腳本最終皆有通過結果；不是聲稱首次整套一遍全綠。
- `npm run check:saves`：**20/20** 通過。
- 前輪同型探針：原始挪動／返老攻擊均被引擎與讀取器拒絕，合法對照接受；超容量案例四種容量選項組合均可執行並通過新讀取器。
- 本報告附錄的完整日探針已實際執行：baseline 與 forged 均被新讀取器及兩個 C2 讀取器接受，重現 §2 的新 P2。

本輪沒有改產品程式、原測試斷言、參數、正式存檔或 journal；沒有推進 Day15、啟動新版正式 Day0、合併 PR 或 force push。只上傳本報告至獨立審查分支。

## 附錄：完整日反例程式

在本 SHA 根目錄將下列內容存為 `.ts`，以 Node 22.23.4 執行。輸出 baseline 與 forged 各自的三個讀取器結果。測試批次會進入真正的完整日模擬；偽造只作用於其複本輸出。

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

```

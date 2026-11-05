# Codex 獨立審查：PR #77（ME-1）

- 審查日期：2026-11-06（Asia/Taipei）。
- 審查標的：`122474424d472f102a209d65a514f6ee277726ce`。
- 比較基準：main `4e8fc6e8f9cec12c18a7a450921143d03721006d`。
- 結論：**REQUEST CHANGES**。3 項 P2 需要修正，另有 1 項 P3 介面契約問題。
- 這是 Codex 另行讀碼及執行反例的審查。上一份 main／物理層報告沒有涵蓋 #77，不能視為本 PR 的審查。

## 1. Findings

### F1 — P2：蟻后死亡只按事件種類計數，沒有核對個體 ID

位置：[engine/invariants.ts:68–69](https://github.com/davidcatcat/antempire/blob/122474424d472f102a209d65a514f6ee277726ce/engine/invariants.ts#L68)、[cli/lib/population-replay.ts:36–39](https://github.com/davidcatcat/antempire/blob/122474424d472f102a209d65a514f6ee277726ce/cli/lib/population-replay.ts#L36)。

`queen_death` 只增加 `queenDeaths`，沒有把 `e.id` 與本群的 `queen_id` 比較；人口快照也沒有記錄 queen ID。真實產生事件的程式會填入 `colony.queen_id`（`engine/queen.ts:63`），因此這不是無意義的欄位。

重現：A1、seed 1、2027-09-23 的第一天，保留正常工蟻、幼體與事件，把期末 `queen_alive` 設為 false，附加死亡事件。`id: 'Q001'` 是合法對照；改成完全不存在的 `'OTHER_COLONY_QUEEN'`，兩個驗證器仍然接受。

```text
queenId=Q001                engine=ACCEPT reader.ok=true
queenId=OTHER_COLONY_QUEEN  engine=ACCEPT reader.ok=true
```

影響：一筆歸屬錯誤的死亡紀錄，仍能「證明」本群蟻后的消失，與本 PR 從摘要計數改為個體 ID 核對的目標不符。這是驗證器缺口；本次沒有發現正常模擬真的產生這種事件。

建議：快照保留蟻后身分，核對死亡事件 ID 及期初、期末蟻后身分；同時核對 `egg_laid.queen` 的歸屬。引擎與讀取器各自實作，加入錯誤、缺少身分的反例及合法對照。

### F2 — P2：死亡後再孵化／化蛹，正式引擎檢查仍會通過

位置：[engine/invariants.ts:50–59](https://github.com/davidcatcat/antempire/blob/122474424d472f102a209d65a514f6ee277726ce/engine/invariants.ts#L50)。

`step()` 檢查期初階段及一天最多一步，沒有檢查這個 ID 是否已在先前的 `brood_death` 結束生命。羽化另有 `broodDeaths.has(from)` 防護，孵化與化蛹沒有。

最小反例：期初有一枚卵 `REVIEW_EGG`；期末移除它，其餘存活工蟻日齡正常 +1；事件依序為 `brood_death(REVIEW_EGG)`、`hatch(REVIEW_EGG)`。所有人口計數及期末 ID 集合都正確，引擎接受；獨立讀取器拒絕：

```text
order=hatch,brood_death  engine=ACCEPT reader.ok=true
order=brood_death,hatch  engine=ACCEPT reader.ok=false
error: REVIEW_EGG: hatched after it died or eclosed
```

影響：讀取器有補抓到，但它不是正式每日循環的執行期檢查。登錄表 §7 的 ID-EVENT-TIME 明訂「死亡或羽化後不再有事件」；目前兩份實作沒有達成同一契約。

建議：所有幼體階段事件都先查生命是否已結束；保留「先孵化、後死亡」的合法對照，新增死亡後孵化、死亡後化蛹的負面測試。不要只把這個反例列為讀取器成功。

### F3 — P2：幼體負日齡可通過完整每日模擬及獨立定義域檢查

位置：[engine/invariants.ts:130–133](https://github.com/davidcatcat/antempire/blob/122474424d472f102a209d65a514f6ee277726ce/engine/invariants.ts#L130)、[cli/lib/population-replay.ts:111](https://github.com/davidcatcat/antempire/blob/122474424d472f102a209d65a514f6ee277726ce/cli/lib/population-replay.ts#L111)。

兩份定義域實作都檢查工蟻日齡，對幼體只檢查 stage、progress；遞迴有限數檢查擋不住負數或小數日齡。登錄表 ID-STATE-DOMAIN 明訂日齡為非負整數。

這項反例不是只呼叫小工具：建立 A4、seed 1、2027-09-23，將第一隻蛹的 `age_days` 設為 −3，直接執行 `simulateWorldDay`：

```text
start.age_days=-3
simulateWorldDay=ACCEPT
end.age_days=-2
domainErrors(end, events, capacity)=[]
```

影響：新增的期初與期末檢查都沒有阻止非法生命史狀態流入、流出每日引擎；「日齡定義域已檢查」的聲明過廣。

建議：對已知的幼體日齡要求有限、非負整數，並涵蓋期初與期末。`Brood.age_days` 的型別允許 `null`，遷移資料的未知日齡應依既有契約保留，不能在修正時把 `null` 當成 0。測試應包含負數、小數及合法未知值對照。

### C1 — P3：讀取器的「malformed input 不丟例外」契約未落實

位置：[cli/lib/population-replay.ts:18–27](https://github.com/davidcatcat/antempire/blob/122474424d472f102a209d65a514f6ee277726ce/cli/lib/population-replay.ts#L18)。

檔頭宣稱「Returns located errors; never throws on malformed input」，但非陣列的 events 被轉為空陣列，陣列裡的非物件項目被直接丟掉；start/end 沒有結構檢查。

以正常 A1 第一天的期初、期末呼叫，`events=null` 得到 `ok:true`；`start=null` 則讓 TypeError 逸出。前者這一天沒有必要的人口增減事件，因此沒有證明可以隱藏任意死亡；它證明的是不合法的事件容器被視為有效輸入。

建議：先檢查必要結構，再重播，回傳可定位的輸入錯誤。若函式只支援可信的已型別化資料，應明確收窄契約及呼叫邊界，不要保留「永不對 malformed input 丟例外」的說明。

## 2. 實際驗證

環境：Node **22.23.4**，以離線 npm cache 安裝鎖定依賴。

| 驗證 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過（根目錄、engine、web） |
| `npm test` | **46/46** 測試腳本通過，包含 `me1-invariants`、golden、rules-isolation 與物理測試 |
| `npm run check:saves` | **20/20** 通過，0 warnings、0 errors |
| 本次獨立反例與對照 | 確認 F1、F2、F3、C1 如上；探針程序 exit 0 代表成功重現缺陷，不代表產品通過 |

沒有重新讀取 GitHub CI 結果；上表是本次本機實際執行結果。推送報告前重新以遠端 refs 確認 #77 與 main 未變。

反例與測試都在解開的 Git archive `/tmp/antempire-review-pr77` 執行。沒有 checkout、重寫既有提交、修改引擎原始碼或既有測試。反例程式與輸出保留於本次環境的 `/workspace/scratch/review-pr77/`；本次上傳內容只有這份 Markdown 報告。

## 3. 數學、生態與科學根據的邊界

本 PR 的主要新增內容是會計恆等式、個體生命期與數值定義域檢查；它們可以由程式契約及反例直接判定，不需要用某篇螞蟻論文替錯誤的 ID 或死亡後孵化背書。上述問題均是新增檢查未履行其聲明，不代表此次已證實真實模擬產生相應生物事件。

世界端食源讀取器確實將生產、雨沖、分解、採集、容量刪除與到期刪除分開。重算生產量，比只相信引擎自己寫的生產紀錄更有檢查力。但帳目閉合包含 `overflow_deleted`、`expired_deleted`，只代表刪除量被列帳；這些物質沒有生態去處的既有問題仍然存在。單位也明確是遊戲份量，不能直接解讀成 mg、能量或營養化學計量驗證。

`engine/day.ts` 相對 main 的實質執行變更是新增檢查與版本標記，沒有新增螞蟻行為、生態方程或參數。因此本輪沒有重新查證 Yuan、Sanders、Dussutour 等原始文獻，也沒有完成分布、多型態、時間尺度收斂或野外資料驗證。正常回歸通過，只支持已測情境的工程相容性；既有營養局部性、共用資源順序、隨機串流及物理問題的處理狀態，不因這份報告而改變。

## 4. 修正後驗收

1. F1、F3 的反例在引擎與獨立讀取器都被拒絕，合法身分與未知幼體日齡對照仍通過。
2. F2 的引擎行為與讀取器一致；合法孵化後死亡通過，死亡後孵化／化蛹拒絕。
3. C1 的公開輸入契約與實作一致。
4. 保留舊斷言，重跑完整測試、型別檢查、存檔檢查與正常輸出隔離檢查。

沒有合併 PR、推進 Day15、啟動正式 Day0、改動正式存檔、日誌或生態參數。這份審查結論只適用於上述 SHA；修正後需再核對新提交。

## 附錄：可重播的最小反例

在上述 SHA 的隔離 checkout 根目錄把以下內容存成 `review77-confirm.ts`，使用 Node 22.23.4 執行 `node review77-confirm.ts`。這是審查用探針，不是更改既有測試的建議。

```typescript
import assert from 'node:assert/strict';
import {buildDay0} from './cli/lib/day0.ts';
import {loadBundle} from './cli/lib/load.ts';
import {simulateWorldDay} from './engine/index.ts';
import {checkPopulationDay,populationSnapshot} from './engine/invariants.ts';
import {replayPopulationDay,domainErrors} from './cli/lib/population-replay.ts';
const b=loadBundle(), s=buildDay0('A1',1,'2027-09-23',b).state;
const before=structuredClone(s.colonies[0]), out=simulateWorldDay(s,b), after=out.state.colonies[0], events=out.result.colonies[0].events;
const dead=structuredClone(after);dead.population.queen_alive=false;
for(const queenId of [before.queen_id,'OTHER_COLONY_QUEEN']){
 const ev:any[]=[...events,{type:'queen_death',id:queenId}];
 checkPopulationDay(populationSnapshot(before),dead,ev);
 const r=replayPopulationDay(before,dead,ev);assert.equal(r.ok,true);
 console.log(JSON.stringify({case:'queen-death identity',queenId,engine:'ACCEPT',reader:r.ok}));
}
const start:any=structuredClone(before);start.population.brood=[{id:'REVIEW_EGG',stage:'egg',progress:0,age_days:0}];
const end:any=structuredClone(start);end.population.brood=[];for(const w of end.population.workers)w.age_days++;
for(const kinds of [['hatch','brood_death'],['brood_death','hatch']]){
 const ev:any[]=kinds.map(type=>({type,id:'REVIEW_EGG'}));checkPopulationDay(populationSnapshot(start),end,ev);
 const r=replayPopulationDay(start,end,ev);assert.equal(r.ok,kinds[0]==='hatch');
 console.log(JSON.stringify({case:'brood lifetime',order:kinds,engine:'ACCEPT',reader:r.ok,errors:r.errors}));
}
const neg=buildDay0('A4',1,'2027-09-23',b).state,id=neg.colonies[0].population.brood[0].id;
neg.colonies[0].population.brood[0].age_days=-3;
const no=simulateWorldDay(neg,b),age=no.state.colonies[0].population.brood.find(x=>x.id===id)?.age_days;
const dom=domainErrors(no.state.colonies[0],no.result.colonies[0].events,0.8);assert.equal(age,-2);assert.deepEqual(dom,[]);
console.log(JSON.stringify({case:'negative brood age',start:-3,end:age,fullDay:'ACCEPT',readerDomain:dom}));
const malformed=replayPopulationDay(before,after,null as any);assert.equal(malformed.ok,true);
console.log(JSON.stringify({case:'null event list',reader:malformed.ok}));
let threw=false;try{replayPopulationDay(null as any,after,[])}catch{threw=true}assert.equal(threw,true);
console.log(JSON.stringify({case:'null start',uncaughtException:threw}));
```

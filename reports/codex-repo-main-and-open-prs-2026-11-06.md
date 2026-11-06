# Codex repository 程式與科學設計審查（2026-11-06，增量複審）

**結論：本輪新增三項 P2；#87、#88、#89 為 REQUEST CHANGES。** 未發現新增 P0／P1，不表示整個科學模型已驗證。main 的個體營養、生命史與物理整合阻擋仍存在；不建議據此啟動新版正式 Day0。

這次同時核對 main、目前五個未合併 PR，以及 19 個開啟 issues 的清單與相關內容。重點是最新增量與可執行反例；不是重新取得 references 中全部文獻或逐行窮盡整個 repository。

## 1. 固定版本與逐項結論

| 對象 | 固定 SHA | 範圍／本輪結論 |
|---|---|---|
| main | `f07e73a11e9d26aac0d085cc57196e5c133c59a3` | v25；重查營養／發育與相關不變量，已知科學限制仍在 |
| #70 | `98f2f421ee10bf18e7959f8a5a942110ce5476f1` | 物理研究／Roadmap 文件；本輪未發現新增阻擋，有限 APPROVE WITH COMMENTS，不是整合核准 |
| #87 | `3f25677753c767dce2a1105f75c9c4af25c6d4d1` | 發育差異設計；REQUEST CHANGES，F-G2 |
| #88 | `9fac940dc044ecd77a618a561ebe21516fb0b9e8` | v26 食源事件；REQUEST CHANGES，F-G1；前輪 N18 P3 已修正 |
| #89 | `79b3bd24687ee95f6a4192e3d7c069fe27404d27` | C4 設計修訂；REQUEST CHANGES，F-G3 |
| #90 | `cd67aa11fd8dde61565ae4fd34c1d2163740668b` | Draft，只是缺陷存在時通過的 A0 測試；有限 APPROVE WITH COMMENTS，不代表 C4a 已實作或修復 |

main 自先前 `e93933f` 只合併 #86 的 C4 設計文件。上輪對 #88 `2d25ee8` 的 APPROVE WITH COMMENTS 限定於該 SHA；不能自動套用到新增驗證邏輯的 `f1233a1`，以及之後只修 N18 helper 的 `9fac940`。原始正負批次紀錄漏洞在新 head 仍被拒絕，本輪 F-G1 是另一個輸入依賴缺口。

## 2. F-G1 — P2／#88：花蜜寄主可無事件死亡或復活，重播仍接受並改變食物量

位置：[cli/lib/source-flow-replay.ts:208–224](https://github.com/davidcatcat/antempire/blob/9fac940dc044ecd77a618a561ebe21516fb0b9e8/cli/lib/source-flow-replay.ts#L208)，以及前面的花蜜生產重算。

新 §3c 檢查容量、生產參數與 bloom_days_left，但 `host_alive` 的變更核對只在 honeydew 分支內。花蜜生產卻依賴 **期末** `s1.host_alive !== false`。現行 `growNectar` 沒有改變寄主存活狀態的規則，所以這是一天內本應保持不變的輸入，而非可以任意改寫的觀測結果。

### 已執行的完整日反例

Node 22.23.4，`loadBundle()`，打開 source flows；Day0 A1、seed 2、2027-03-21，F08 的 bloom_days_left 設為 5。該日無雨，production_per_day = 0.35，期初糖 0.022387。

**反例 A（消除生產）**：先以 host_alive = true 真正跑一個完整日。合法期末糖為 0.372387，分泌事件為 0.35。複製輸出後只做：

- 期末 host_alive 改 false；沒有 host_plant_death 事件；
- 刪除該 0.35 分泌事件；
- 期末糖改回 0.022387，同步 ecological_record 的 production_portions、stock_after 與 production_last_day。

**反例 B（增加生產）**：以 host_alive = false 的合法對照真正跑一個完整日，然後將輸出複本的 host_alive 改 true、加入 0.35 分泌事件，並在期末糖與對應生產紀錄加上 0.35。沒有任何寄主恢復事件。

| 檢查 | 兩個合法對照 | A：無事件死亡 | B：無事件復活，多 0.35 糖 |
|---|---|---|---|
| replaySourceFlows | 接受 | **ok: true, errors: []** | **ok: true, errors: []** |
| replayEngineSourcesDay | — | **[]** | **[]** |
| replayEngineColonyDay | — | **ok: true** | **ok: true** |

兩項攻擊沒有修改蟻群的 C2 轉移或狀態。食源讀取器的四項 unevented 均為 0。A 保持期末非負；B 則以無事件的寄主復活合理化新增糖。

這不是要求讀取器恢復不可觀測的真實事件：**現行規則沒有允許這個 nectar 狀態轉換**，卻讓變更後的欄位替流量提供依據。也不是上輪已修正的正負批次採集漏洞。

**建議**：在 nectar 分支先依期初狀態核對 host_alive 是否維持現行規則允許的值；若未來增加植物死亡／恢復機制，改由該事件推導。生產重算使用可信期初值或已核驗事件重建值。加入 A、B 與兩個合法對照；至少獨立食源讀取器須各自拒絕 A、B。

## 3. F-G2 — P2／#87：所列 M1／M2 不會僅因變溫而成為不同的發育模型

位置：[docs/research-design-p0b-development-variance.md:228–255](https://github.com/davidcatcat/antempire/blob/3f25677753c767dce2a1105f75c9c4af25c6d4d1/docs/research-design-p0b-development-variance.md#L228)。

文件的結論是「恆溫下 M1 的 θ 與 M2 等價；變動溫度下兩者不同，可以比較」。依它自己的公式，後半句不成立。

令持久差異關閉 z = 1、營養／照護因子固定為 1，選整數 k，CV = 1/√k。這是文件允許、且專門比較 θ 層的情況。令共同的非負速率為 r(t) = r_s(T(t))，並定義生理時間：

```text
A(t) = ∫[0,t] r(u) du
```

- M1：θ ~ Gamma(shape=k, rate=k)，在 A(t) ≥ θ 時轉換。
- M2：k 個子階段各以瞬時速率 k r(t) 轉換。在生理時間 A 裡，每個等待量是 Exp(rate=k)，k 個等待量的總和正是 Gamma(k, rate=k)。

所以在共同的任意變溫速率下，而不僅是恆溫：

```text
P(T > t) = exp(-k A(t)) × Σ[j=0..k-1] (k A(t))^j / j!
```

兩者有相同完成時間分布。M1 提前抽取整個門檻，並不代表提前固定「日曆完成日」；它仍然透過 A(t) 回應後續溫度。共同的非線性 r(T) 與 Jensen 效應也不會使兩種實作彼此不同。

**獨立數值核對**：k = 4，前 5 日 r = 0.1/日，之後 r = 0.3/日。10 萬組共用 Exp 子階段抽樣，分別求 M1 門檻與 M2 逐階段完成時間，最大差約 **7.11e-15 日**。解析存留機率在第 5 日皆為 0.8571234605，第 8 日皆為 0.1906224093。這是數學恆等式的數值核對，並非螞蟻實驗。

**影響**：不能用目前提出的變溫比較，宣稱辨識出兩個不同生物機制。差異可能只來自日步長、錯誤地把速率固定在階段入口，或其他實作不一致。

**建議**：把這兩個版本定位成等價模型的數值交叉驗證；若要真正不同的候選，必須明定不同的歷史依賴、子階段溫度反應或其他有科學理由的狀態機制。M1 的持久因子與 M2 未含持久因子是另一個模型維度，不能混入「θ 層由變溫可辨識」的結論。

## 4. F-G3 — P2／#89：建議方案與強制驗收要求互斥

位置：[docs/design-c4-larval-nutrition.md:154](https://github.com/davidcatcat/antempire/blob/79b3bd24687ee95f6a4192e3d7c069fe27404d27/docs/design-c4-larval-nutrition.md#L154)、§6 工作切分、§7.0 D2／D3。

D2 建議 (a) 明確要求：孵化只寫 `larva_hatch_nutrition`、不新增 C2 轉移；原 hatch_inherit／larva_yolk 改列替代方案 (b)。但 A10 沒有條件地要求每顆有 egg_investment 的卵孵化時都必須有 hatch_inherit 轉移，A11 也仍以該區室／原因撰寫。依 D2(a) 正確實作，仍一定無法通過目前 A10。

同一問題出現在代謝切分：D3 與「C4a 最小範圍」建議把 L4 幼蟲代謝移到 C4a；§6 的工作表與依賴圖仍把它放在 C4b。原章節沒有寫明只適用被保留的替代方案。

這不是否定待 Owner 決定的候選，也不是代替 Owner 選 D2／D3。問題是目前**沒有一套能同時遵守的驗收契約**，會導致依最新版建議完成後反而被舊驗收判錯，或實作漏掉宣稱要處理的代謝項。

**建議**：保留 D1–D8 待決，但將 A10／A11、工作表、依賴圖按候選明確分支。Owner 選定後，整份文件只使用一套生效條件。無論選哪一條，投入量的帳務紀錄都不能被說成已測得的可用儲備，null 也不能當 0 支出。

## 5. 前輪狀態與其他 PR

- **#88 前輪 P2**：本輪重跑真正加入正負批次採集紀錄的完整日攻擊，以及刪除、重複、錯誤工蟻、正數改記批次四個變體，仍被引擎／讀取器拒絕。F-G1 是新 head 的另一個缺口，沒有撤銷先前固定 SHA 的重現事實。
- **#88 N18 P3 已修正**：本輪開始時的 f1233a1 仍將 flat／flatMap 新陣列交給 forge；上傳前發現新 head 9fac940 已改為傳入真實的 per-colony 陣列。我取得新 head，重跑專項並對隔離副本加觀測，確認引擎與讀取器的實際送驗事件各有 1 筆負數紀錄。此 P3 關閉。9fac940 沒有修改產品程式，F-G1 的兩個反例也在新 head 重新執行，結果仍接受。
- **#70**：頂部已區分設計歷史、已實作物理模組、正式日循環未整合，以及現行 P1-A／P1-B／P2-B／P2-C 與只適用舊讓路規則的 P2-A。沒有因文件存在便宣稱真實花園幾何已量測或精準物理接觸已接入 C3a。本輪未重新執行先前所有物理故障生成器，不能宣稱那些缺陷已修。
- **#90**：專項 8 項通過，重現 Day0 原有 3 隻幼蟲求食訊號皆改變、Day14 2 隻訊號與發育都改變。測試通過在此表示**舊缺陷存在**，不是 C4 修正成功。
- 我另外核對 #90 L3 的兩個初始輸入：原 Day0 A2 的 protein 已是 0，因此程式再次將 hi.protein 設 0 並未額外改變食物。只將 gap 0 改 40，即得到相同 protein ratio = 0、幼蟲缺蛋白死亡 0 → 2。**不把這個冗餘賦值誤報成混淆變數問題。**

## 6. main 與 issues：仍未解決的科學阻擋

這些是既有問題，不計入本輪三項新增 P2。

| 主題 | 本輪核對 | 對應 |
|---|---|---|
| 個體營養與非局部訊號 | nutrition.consume 的幼蟲訊號仍讀 pFraction；brood.developBrood 的發育與死亡仍讀群比例／protein_gap_days。C4 尚未實作 | #43、#61、#81、#89／#90 |
| 陣列順序 | runWorldDay 仍逐 colony 呼叫 forageDay；工蟻部分結算仍依陣列。未以現有探針通過冒充修復 | #9、#56 |
| 世界端食物流量 | main ME-1 720 世界日再次列出 overflow 419.129475、expired 51.700346 遊戲份；#88 預設關閉且未合併，不能說 main 已修 #80 | #66、#80 |
| 發育與生命史 | 同條件仍確定性累加；分布、溫度適用區與來源估計量仍需 P0-B。不能把合併群 SD 全視為先天個體差異 | #65、#83、#84、#87 |
| 天氣與競爭 | 濕度偏移、固定 rival 比例仍未改。記錄 rival_harvest 事件不等於建模外部蟻群生命期 | #82、#85 |
| 物理整合 | 正式幾何大多未知，先前碰觸／時間窗／捨入問題仍有適用範圍；C3a 是序數接觸，不是物理接觸 | #68、#69、#70 |
| 生態／多物種 | major、多物種、巢友辨識仍需各自證據；不能以不分物種的參數替代研究 | #25、#26、#27 |

另讀取 #49、#57 與其他開啟 issue 的審查／Roadmap 脈絡。issue 內附舊 SHA 的歷史結論保留其版本限制，不以初始描述的舊版本號替代本輪真實 main。

## 7. 科學資料核對與閱讀界線

#87 對 Yuan 2026 補充表 S2 的**轉錄計數**，我獨立重算所得如下（平均／母體 SD）：

| 里程碑 | n | 平均 | SD |
|---|---:|---:|---:|
| 孵化 | 227 | 7.691630 | 0.631110 |
| 二齡 | 208 | 9.543269 | 0.732523 |
| 三齡 | 194 | 15.056701 | 0.674943 |
| 前蛹 | 93 | 21.129032 | 2.570410 |
| 化蛹 | 80 | 23.675000 | 2.381045 |
| 羽化 | 52 | 28.730769 | 2.829212 |

算術與文件吻合。這是轉錄表的算術複核，**不是本輪重新取得原 xlsx 或全文後確認轉錄無誤**。文件將群／品級混合、不同里程碑樣本集合、未知篩選與觀察誤差分開，且已撤回「87% 變異來自晚期」與無條件 3.6% 上限，方向正確。F-G2 不涉及指控 Yuan 的數據有錯。

本輪另外查閱 [SciPy v1.16.3 Gamma／Erlang 定義](https://github.com/scipy/scipy/blob/v1.16.3/scipy/stats/_continuous_distns.py#L3761)：整數 shape 的 Erlang 是 Gamma 特例。F-G2 的變動速率等價性另在本報告直接推導；SciPy 是數學工具文件，不是螞蟻生物學證據。

本輪沒有新取得 Yuan、Chang、Way、Nepi 等論文全文，也沒有取得新的臺灣本種發育資料；不將 repository 作者自述的全文閱讀算成我本輪親讀。現行網路允許 GitHub 與套件來源，學術站點未在已生效自訂 allowlist 內；本輪沒有繞過網路政策或反覆重試既知阻擋。沒有從資料不足推出某個機制已被科學否證。

## 8. 實際執行的檢查

- main：`npm run typecheck` 通過；`check:saves` **20/20**；ME-1 **113 項／720 世界日**；C3a **326 項／467 colony-days**。
- #88 9fac940（另先檢查 f1233a1）：`npm run typecheck` 通過；source-flows **2,164 項／1,880 世界日**，on/off **1,880/1,880** 相同（原樣本範圍）；原批次攻擊與四個變體各自拒絕。
- #88 新 nectar 反例 A／B：在 f1233a1 與最後取得的 9fac940 上各自執行，合法對照接受，兩個偽造輸出也被新讀取器與兩個 C2 讀取器接受。
- #88 N18：9fac940 的原專項通過；加觀測副本確認兩個檢查器實際接收的負數事件各為 1。
- #90 cd67aa1：A0 專項 **8 項通過**；另用只改 gap 的探針重現 L3。
- #87：轉錄表統計重算；M1／M2 解析等價與 100,000 組配對路徑核對。
- 本輪未重新跑整套 npm test 或全套物理 fuzzer，不沿用舊 SHA 的全綠結果冒充本輪全測。文件 PR 沒有為文字修改另跑整套引擎測試。
- 所有 Node 執行使用 **22.23.4**。檢查及探針作用於隔離 archive／記憶體，不是正式存檔。

## 9. 操作範圍

沒有修改產品程式、參數、原斷言、正式 saves 或 journal；沒有合併、rebase、force push、推進 Day15 或啟動新版正式 Day0。只將本報告發布到獨立審查分支。

## 附錄 A：#88 完整日反例

在 9fac940 根目錄存為 .ts，以 Node 22.23.4 執行。程式先跑合法對照，所有偽造只作用於輸出複本。

```ts
import { loadBundle } from './cli/lib/load.ts';import { buildDay0 } from './cli/lib/day0.ts';import {simulateWorldDay,resolveBundle} from './engine/index.ts';import {replaySourceFlows} from './cli/lib/source-flow-replay.ts';import {replayEngineSourcesDay,speciesFoodTiming,replayEngineColonyDay} from './cli/lib/engine-transfers.ts';
const b:any=loadBundle();b.world.source_flows.record_source_flows_v26=true;const wp:any=resolveBundle(b).world;
const start:any=buildDay0('A1',2,'2027-03-21',b).state;const id='F08';start.sources[id].bloom_days_left=5;start.sources[id].host_alive=true;
const o:any=simulateWorldDay(start,b),f:any=structuredClone(o);const s=f.state.sources[id];
const own=f.result.world_events.filter((e:any)=>e.type==='source_flow'&&e.site===id);console.log('base',JSON.stringify({source:start.sources[id],end:s,flows:own,reader:replaySourceFlows(start,o.state,o.result,wp).ok}));
const change=own.filter((e:any)=>e.cause==='secretion'||e.cause==='capacity_resorbed').reduce((t:number,e:any)=>t+(e.cause==='secretion'?e.portions:-e.portions),0);
s.host_alive=false;s.sugar=+(s.sugar-change).toFixed(6);s.ecological_record.production_portions=0;s.ecological_record.stock_after=+(s.ecological_record.stock_after-change).toFixed(6);s.production_last_day=0;
f.result.world_events=f.result.world_events.filter((e:any)=>!(e.type==='source_flow'&&e.site===id&&['secretion','capacity_resorbed'].includes(e.cause)));
console.log('forged',JSON.stringify({nonnegative:s.sugar>=0,reader:replaySourceFlows(start,f.state,f.result,wp),c2source:replayEngineSourcesDay(f.state.sources,f.result.colonies.map((c:any)=>({id:c.colony_id,events:c.events,timing:speciesFoodTiming(b.species[c.species_id])}))),colony:replayEngineColonyDay(start.colonies[0],f.state.colonies[0],f.result.colonies[0].events,f.day,new Set(Object.keys(start.sources))).ok}));
const dead:any=structuredClone(start);dead.sources[id].host_alive=false;const control:any=simulateWorldDay(dead,b),resurrect:any=structuredClone(control),sx=resurrect.state.sources[id];
sx.host_alive=true;sx.sugar=+(sx.sugar+.35).toFixed(6);sx.ecological_record.stock_after=+(sx.ecological_record.stock_after+.35).toFixed(6);sx.ecological_record.production_portions=.35;sx.production_last_day=.35;
resurrect.result.world_events.push({type:'source_flow',id:'SF-1-F08-999',day:1,site:id,food:'sugar',cause:'secretion',portions:.35,from:'producer:flowers:F08',to:'source:F08',assumption:true});
console.log('resurrection',JSON.stringify({baseline:replaySourceFlows(dead,control.state,control.result,wp).ok,extra_sugar:.35,reader:replaySourceFlows(dead,resurrect.state,resurrect.result,wp),c2source:replayEngineSourcesDay(resurrect.state.sources,resurrect.result.colonies.map((c:any)=>({id:c.colony_id,events:c.events,timing:speciesFoodTiming(b.species[c.species_id])}))),colony:replayEngineColonyDay(dead.colonies[0],resurrect.state.colonies[0],resurrect.result.colonies[0].events,resurrect.day,new Set(Object.keys(dead.sources))).ok}));

```

## 附錄 B：#87 數學核對程式

```python
import math,random,json
# integer k: physiological threshold is Erlang(k,rate=k), for BOTH M1 and M2
k=4;r=random.Random(8701)
# rate .1/day on [0,5), then .3/day; these represent two temperatures
inv=lambda a:a/.1 if a<=.5 else 5+(a-.5)/.3
max_delta=0
for _ in range(100000):
 e=[-math.log(1-r.random())/k for j in range(k)]
 t_m1=inv(sum(e))
 # M2 integrates the same physical rate between successive substage events
 a=0
 for x in e:a+=x
 t_m2=inv(a)
 max_delta=max(max_delta,abs(t_m1-t_m2))
rows=[]
for t in [2,5,6,8,10]:
 A=.1*min(t,5)+.3*max(0,t-5)
 S=math.exp(-k*A)*sum((k*A)**j/math.factorial(j) for j in range(k))
 rows.append({'day':t,'physiological_time':A,'M1_survival':S,'M2_survival':S})
print(json.dumps({'paired_paths':100000,'max_arrival_difference_days':max_delta,'analytic':rows},indent=2))

```

# Codex 全庫複審與合併建議・第 15 輪（2026-11-08）

審查者：Codex，直接讀碼、執行測試及獨立反例，沒有委派其他模型。本輪快照：main `686497493384b492cf0e34c5921f467000394922`，GitHub dashboard 的 **25 張未合併 PR**。本報告只適用表列完整 SHA；不把作者自述、CI 綠燈與獨立審查混為一談。

**目前可進入合併流程的根 PR：#126、#138、#139、#140、#152、#153、#154、#160、#165。** 各自是文件／研究／隔離工程的批准，不是正式生態模型放行。#128、#141、#142 屬通過其 head 審查、待父層整合；#170、#171 的 CI 收尾已全綠，仍須父層先合併。#137、#143、#155、#161、#162、#163、#167、#169 為 REQUEST CHANGES（7 項新 P2，#143／#155 共用一項）。#164、#168 因 #155 被阻擋，不能先合併；#96 保持 Draft。

#123、#124、#125、#127、#129 已合併 main，不能再列為未審待合併。沒有實際合併任何 PR、改產品程式、force push、改正式存檔／日誌／參數、推進 Day15 或建立新版正式 Day0。只發布這份 Markdown。這不是 GitHub 正式 review APPROVE 物件。

## 1. 完整版本、CI 與判定

全部 25 張 PR 的 CI 最後均已確認成功（包含 Draft #96，但 Draft 不因此可合併）。CI 由本輪實際讀取的 checks HTML 核對頁面選取 SHA；不是沿用 Claude 自報。`merge-tree` 檢查的是樹是否可合併，不替代整合後測試。下表「可合併」均限於該 PR 的隔離範圍；每合併一張都須更新下一張的 base／整合 SHA 並重驗。

| PR | 完整 head SHA | base | CI 快照 | Codex 判定 |
|---|---|---|---|---|
| [#96](https://github.com/davidcatcat/antempire/pull/96) | `00c896b767c1577fcb62af2ba80f1a88f04acfb1` | main | 成功 | DRAFT；暫緩 |
| [#126](https://github.com/davidcatcat/antempire/pull/126) | `a689e02741b4ffad9520c817df3b0277d623f067` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#128](https://github.com/davidcatcat/antempire/pull/128) | `7ebb5b1f74364242d26a8218e048372559e5931f` | main | 成功 | APPROVE WITH COMMENTS；先 #139；修整合衝突後複驗 |
| [#137](https://github.com/davidcatcat/antempire/pull/137) | `6ec0a8857d9f3f4e8aacfdcfc36fdf9df8fe2d0d` | #126 | 成功 | REQUEST CHANGES：R15-01 |
| [#138](https://github.com/davidcatcat/antempire/pull/138) | `ef14730d40c285d6911b500fd74e0d620e994d2d` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#139](https://github.com/davidcatcat/antempire/pull/139) | `cf800de8fabf4af3dcd7b58c1dea1c6cd8097941` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#140](https://github.com/davidcatcat/antempire/pull/140) | `b797cc252148bfafe11bcca17f1d79f72f134be7` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#141](https://github.com/davidcatcat/antempire/pull/141) | `0c6f2c1de20311c54e7469665696a6469794116c` | #140 | 成功 | APPROVE WITH COMMENTS；先 #140；整合後重驗 |
| [#142](https://github.com/davidcatcat/antempire/pull/142) | `97bfcb5e9c73b9698cf6d0a4f9a4f25d85c04c3b` | #128 | 成功 | APPROVE WITH COMMENTS；先 #139 → #128；整合後重驗 |
| [#143](https://github.com/davidcatcat/antempire/pull/143) | `88a5a7f241cffe796e3f32867bf1b293e9b986d7` | #138 | 成功 | REQUEST CHANGES：R15-02 |
| [#152](https://github.com/davidcatcat/antempire/pull/152) | `661f770103684b4f42d80da529bce5d469293200` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#153](https://github.com/davidcatcat/antempire/pull/153) | `01235b4ab0413fd97437956157dec649b7485726` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#154](https://github.com/davidcatcat/antempire/pull/154) | `0392e14965502dce572282d1cbb6fd7b78993cb9` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#155](https://github.com/davidcatcat/antempire/pull/155) | `68642b0151fa4e5705d6c32eaf3b56232ffc5ec8` | #143 | 成功 | REQUEST CHANGES：R15-02（繼承且接入畫面） |
| [#160](https://github.com/davidcatcat/antempire/pull/160) | `69443ef840cb0ab8a2ca9e24b8dd6f52e5fbe594` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#161](https://github.com/davidcatcat/antempire/pull/161) | `aaeeacb2f1e891237ebc51156b5c107d0c2deac8` | main | 成功 | REQUEST CHANGES：R15-03 |
| [#162](https://github.com/davidcatcat/antempire/pull/162) | `b75719abcaeeb66f8ae972f3ac41bda99c7a8ef1` | main | 成功 | REQUEST CHANGES：R15-04 |
| [#163](https://github.com/davidcatcat/antempire/pull/163) | `6fe6f269fde2f8f8961df72790f4154727ae2666` | main | 成功 | REQUEST CHANGES：R15-05 |
| [#164](https://github.com/davidcatcat/antempire/pull/164) | `aded36846422c6cbad91382661594b1e4811e5a4` | #155 | 成功 | 本體相關測試通過；等 #155 修正與合併 |
| [#165](https://github.com/davidcatcat/antempire/pull/165) | `6483c626984e264af0e16dae9a24d74734ba032c` | main | 成功 | APPROVE WITH COMMENTS；可合併 |
| [#167](https://github.com/davidcatcat/antempire/pull/167) | `2064c0de0d5d8b1d0718664e85f6ee2ec52fd172` | #163 | 成功 | REQUEST CHANGES：R15-06，且依賴 #163 |
| [#168](https://github.com/davidcatcat/antempire/pull/168) | `ed637779b1a97fcef78e802a42155592df182f13` | #155 | 成功 | 本體相關測試通過；等 #155 修正與合併 |
| [#169](https://github.com/davidcatcat/antempire/pull/169) | `34d7bb9a7a0e595ad2f1a267e8ea8cd97c61e2c8` | #165 | 成功 | REQUEST CHANGES：R15-07 |
| [#170](https://github.com/davidcatcat/antempire/pull/170) | `fb0f90de24a9c6da5f0373da58bb7bcc27a2b0b7` | #165 | 成功 | APPROVE WITH COMMENTS；先 #165；整合後重驗 |
| [#171](https://github.com/davidcatcat/antempire/pull/171) | `a1468f8ba1275bccedcee5af98612be507f211cf` | #170 | 成功 | APPROVE WITH COMMENTS；先 #170；整合後重驗 |

前輪結果：#126 的 50／50→1／99 分攤偽造已被新 allocation replay 拒絕；#128 的 start=H、起點即終點，已正確在 H 記錄 start＋arrive，H 前後對照亦正確。兩項 R14 P2 均**關閉**。本輪 #137 的新 reader 缺陷是另一個模組的問題，不代表 #126 原修正失效。

## 2. 新的阻擋發現（P2）

### R15-01 — #137：新統一帳本 reader 接受未記錄的逐個體跨區交換

位置：`prototypes/mixed-precision/unified-audit.ts:94–109`（U5 只驗 cohort、年齡與階段單調性，未核對 region／逐 ID 遷移）；U2／U3 是總量檢查。

建立同一 cohort C 的 W1@G、W2@P，皆精確年齡 5、reserve=4；階段無餵食、發育、繁殖與死亡機率，推進一天只產生 aging。合法結果 audit=`[]`。交換期末兩個 group 的 members（W2@G、W1@P），保留所有原紀錄、數量、儲備、年齡與 cohort，reader **仍回傳 `[]`**，當天沒有 migration。

這是單一權威帳本中的身分歷史缺口；總量閉合與 camera 測試通過，不足以證明每個 ID 的去向合法。請獨立重播 ID 的 region、stage／substage、reserve 變化及其記錄，不只驗階段不能倒退。至少拒絕此交換及同區內個體儲備錯配，保留合法原型／視角不影響命運的測試。不要用 authoritative engine 本身產生「預期結果」取代獨立 reader。

### R15-02 — #143，並存在於 #155：名稱仍被當作半翅目分類證據

位置：`web/src/render-scene.ts:35–50`，`EngineObject.insect` 只有 aphid／scale，`/介殼/.test(p.name) ? 'scale' : 'aphid'`；#155 的 `render-canvas.ts:216` 真正把它交給 hostPlant 繪圖。

相同 ID F、honeydew 類型、座標、host_alive、hemipteran_colonies，只有名稱分別為「未知蜜露點」「介殼蟲蜜露點」：registry 產生 `insect:'aphid'` 與 `insect:'scale'`，兩者都帶 `source:'engine'`，沒有 taxon 輸入。

這與已記錄的第 26 題「unknown／中性示意、不得從名稱推斷」及 #160 的分類原則衝突。說整個花園是示意，不能讓特定分類欄位變成引擎事實。請加入 unknown／中性呈現，只有有來源的結構化 taxonomy 才選特定類群；名稱改變不應改分類。保留 #138 可單獨展示的「示意蚜蟲／介殼蟲素材」，它們本身不需要刪除。#164／#168 從 #155 繼承此資料路徑，需等父層修正。

### R15-03 — #161：把不同的觀測過程當成主要科學可證偽測試

位置：`docs/p0a2-24h-behaviour-design.md:129–131,176,197`（§4.6、V3、觀測不回饋）。

文件自己描述 R145 為鮪魚油誘餌＋乙二醇致死落阱，每 3 小時收集；但模擬「虛擬落阱」只計數經過或停留，**不引誘、不捕獲／移除，也不改個體**，然後稱可對照曲線形狀，列 V3 為主要可證偽測試。

誘餌對招募的作用可隨時段、飢餓與溫度改變；致死捕捉也使同一隻不能在之後反覆被捕。只除去絕對量不會消除這些對形狀的影響。簡單例子：同一隻在兩個時間格各經過一次，非侵入觀察得 [1,1]，致死捕捉得 [1,0]；正規化後仍不同。這不是說應讓攝影機改命運，而是**實驗介入與純觀測器必須分開**。

請把誘餌／捕捉作為有來源、明示假設的實驗世界介入，對介入後世界再放純讀取的統計觀察器；或把這項比較降為探索性／不具相同觀察算子的診斷，不作機制排除與科學驗收。未有捕捉機率、誘餌機制等資料時應明列 unknown 並評估敏感度，不以「只比形狀」略過。

### R15-04 — #162：目的地稽核接受轉移個體在目的地消失

位置：`engine/physics/destinations.ts:286–380`，release 只將 where 設為 free，沒有要求 `to` 指定的 site 在同一精確時刻收到該個體；函式結束也未檢查待解決轉移。

A（dwell=1、on_release={site:B}）與 B（dwell=1、on_release=off_plane），容量各 1。合法 W 在 t0 抵達 A，t1 release→B、在 B arrive/admit，t2 離開；另有 X 在 t3 抵達 B、t4 離開。完整事件 reader=`[]`。

刪掉 W 在 B 的全部事件，保留 A 的 `release W to B` 以及 X 的 t3～t4 後續事件，reader **仍為 `[]`**。這不是剛好截在同一批次中間的前綴；紀錄已繼續到 t4。W 被宣稱轉入 B，卻沒有到達、占位或任何明示的後續去向。

請在 exact instant 的集合層級對每筆 site-to-site release 配對唯一的目的到達，核對個體、目的與時間；跨出平面必須是 spec 明示的目標。批次尾與函式尾的待決到達／轉移應拒絕或明報 unresolved，不能用各 site 的 entered=present+exited 視為全局通過。

### R15-05 — #163：不連續 Track 姿態被接受，可瞬間越牆

位置：`engine/physics/kinematics2d.ts:304–313` 只驗相鄰時間連續，沒有驗證下一個 `p0` 是否等於上一段解析終點。

一隻 2.5×0.8 mm 膠囊，第一段 [0,1] 在 x=0 靜止，第二段 [1,∞) 在 x=10 靜止；中間 x=5 有從 y=-5 到 5 的牆。這個 Track 不合法，應在開始前被拒絕。實際 solver 接受、final.x=10、無接觸或拒絕，兩段都被列為正常 executed motion。

這不是說連續合法計畫的 CA 公式失效，而是公開入口沒有保護其連續運動前提。請驗完整 Track 的時間域、有限數值、正長度、時間順序與解析姿態銜接（heading 按既定角度等價處理），在執行前拒絕跳躍。不得靠碰撞採樣彌補姿態瞬移，也不得悄悄把 caller 的計畫修成另一條路線。加入上述拒絕對照及 PlanBuilder 的合法連續計畫。

### R15-06 — #167：KIN-2D 共用轉接器捏造 horizon 之後的 start

位置：`engine/physics/shared-contract.ts:136` 的 fromKin2D，無條件為每隻 push start。

合法 shared scenario H=1、A 在 t=2 才開始走（s10→20、10 mm/s，寬 10 的直線）。runBoth 的 KIN-2D shared record 卻含 `start@2`，PH-3b shared record 為空事件。沒有改任何 solver，本來沒有超過 H 的事件是轉接器新增的。

請只輸出時間契約允許的事件（含精確 horizon 邊界），對未開始者保留狀態而非捏造未來事件；對 H−／H／H＋加入兩個轉接器相同的檢查。此修正也不能代替 #163 的 Track 檢查。

### R15-07 — #169：重算雜湊的非法活動狀態被 restore 接受，稍後崩潰

位置：`prototypes/continuous-world/worker/core.ts:329–343` 的 restore，只檢查 pending event／時間／stream 存在，未驗 activity 與 target、pos、in_nest 的關係。

由正常 create('exp-review',7).snapshot() 複製，把 w01.activity 改為 walking、target 保持 null，重算 payload hash；版本、規則指紋、seed、queue、時間均不改。restore **接受**，回讀 walking／target=null／in_nest=true。advanceTo(until_s) 隨後 `TypeError: Cannot read properties of null (reading 'x')`。

目前測試已用「修改內容再重算 hash」測 queue、ledger 等負例，因此不能把這例當成 hash 層已保證合法。請在替換 runtime world 之前驗證完整快照狀態的型別、有限值、activity／target／位置及時間一致性、RNG／ledger 欄位等必要不變量，以型別化拒絕保留原世界。SHA-256 保證位元一致，不保證狀態機合法；不要把這個責任轉給刻意保持 payload opaque 的 SAVE 儲存層。

## 3. 合併順序與工程證據

- **#126**：249 項、型別通過；R14 分攤反例被逐區室 allocation replay 拒絕，合法 50／50 仍接受。`free_input` 金額明列 unverified_shares，不再把沒有生產／營養規則的量當作科學驗證。可合併隔離原型；#137 需獨立修正。
- **物理 #139 → #128 → #142**：#139 的幾何接觸、constraint_active、antenna_contact=null 分開；讀取新事件追蹤與數值契約，重跑 contact-time／contact-kinds／solver 測試。#128 的 R14 horizon 反例已修。#142 的精確十進位控制時間、真實出發時刻第一次決策與分層介面已有對應測試。三張 head 的相關測試通過，但 **#139 與 #128 互合有多處衝突**（播放 app／export／index／截圖／tests/run-all），須先整合再審該 SHA，不能把三個 head 的 CI 當作合併樹的 CI。#142 的測試仍標記舊 PH-3b 部分模式為 pending pinned，父層修正後要更新為正確契約，不能移除檢查。
- **#138**：402 項與型別通過；實際檢視 ant 預覽，素材為原創示意、大小工蟻／放大顯示、足部及步態界線有標示。可以先合併素材；#143 的資料來源缺陷不回溯阻擋單獨素材。
- **化學 #140 → #141**：CHEM-0 契約、normalized activity 與真質量分開；CHEM-1 只有沉積、解析指數衰退、局部讀取，沒有替物種選定沉積決策／衰退係數、沒有默認擴散。λ=0、分段推進、重播、局部性與隔離測試通過。可依序合併隔離工程，並非 M1／M2 已科學定案。
- **#152、#153、#154、#160**：文件／研究可合併，讀取了新文件並檢查其支持範圍；本輪沒有重新取得所有學術原始全文，不能把作者閱讀紀錄冒充 Codex 的逐頁核實。#152 的決策摘要亦不取代真實 Owner 授權，不授予本輪實際合併、正式規則啟用等權限。
- **#165 → #170 → #171**：有限實驗 Worker／IndexedDB 例外、匯入白名單、正式寫入禁止清楚分離；相關靜態邊界與契約測試通過。#170／#171 收尾已確認四項 job 全部成功。#171 做的是獨立儲存模組，尚未證明與真實 Worker 的完整存檔整合，不能說成遊戲已有存檔功能。#169 與此鏈分開且需修 R15-07。
- **#164、#168**：顯示微動作／圖集相關測試通過，沒有發現其本體新增的生態回寫；但父層 #155 尚有 R15-02，因此列待父層，不可先合併。#168 的全部 WebGL／GPU／5000 隻 benchmark 本輪沒有獨立重跑，未替其所有效能數字背書。

全部 25 張對各自 base、對本輪 main 的 merge-tree 均成功；**成批整合不同**：#140／#153、#153／#154、#154／#160 的 `docs/references.md` 互合衝突。解衝突須保留各來源 ID、閱讀程度與外推限制；測試清單須保留雙側項目。不能由刪除另一方內容取得綠燈。

## 4. 本輪實測結果

Node **22.23.4**；各 SHA 用 git archive 隔離，核對 package-lock 後重用依賴；Rapier 0.21.0。正式 checkout 乾淨。下列是相關測試，不是每個 PR 都各跑一輪全套 main。

main `6864974` 本輪完整 `npm test` **76/76**、`check:saves` **20/20**、`npm run typecheck` 均通過（exit 0）。19 張有程式變更 PR 的新增／相關 Node 測試與型別檢查全部 exit 0。

| PR | 本輪相關測試 |
|---|---|
| #126 | mixed precision 249；型別通過 |
| #128 | local steer 50,706；playback 77,240；型別通過 |
| #137 | camera invariance 155；cohort lifetime 167；型別通過 |
| #138 | art assets 402；型別通過 |
| #139 | solver 2,376；contact time 1,045；contact kinds 129,281；型別通過 |
| #140 | contract 90；isolation 102；型別通過 |
| #141 | contract 95；core 486；isolation 107；型別通過 |
| #142 | local steer 35,839；time contract 7,872；playback 321,235；型別通過 |
| #143 | render system 1,238；型別通過 |
| #155 | art 405；render 1,242；art scene 241；型別通過 |
| #162 | destinations 121；型別通過 |
| #163 | kinematics 325；natural walk 53；型別通過 |
| #164 | display motion 174；型別通過 |
| #165 | worker boundary 967；型別通過 |
| #167 | diagnosis 11；sensing 29；shared 143；observer 38；型別通過 |
| #168 | render atlas 123,824；型別通過 |
| #169 | web boundary 1,478；runtime 122；型別通過 |
| #170 | save contract 239；型別通過 |
| #171 | web boundary 1,474；save format 87；型別通過 |

另行執行的 Chromium 154／Playwright 1.63.0：

- **#169 Worker**：15 項瀏覽器檢查通過。3 種子合計 17,937 事件，17,934 逐字相同；3 筆光照事件有浮點差異（最大光照分鐘差 5.684e−14、exact 微秒差 3.411e−6），在預先聲明界限內。3 個完整 payload **都不是跨環境逐位元相同**，排除 light 資料後 3/3 相同；不能寫成 Node／Worker 全部 byte-identical。這些正常路徑通過不抵銷 R15-07。
- **#171 SAVE**：47 項功能斷言通過，包括 IndexedDB 回讀、quota／abort、損壞回復、鎖／steal、跨世界隔離、匯入匯出、持久化 profile 重啟；但腳本出現 2 筆 console 404，嚴格 harness **exit 1**。這列為測試頁／資源診斷 P3，不能稱瀏覽器全綠。未放寬錯誤斷言。測試為合成 payload，不是 Worker 串接驗收。
- review harness 副本只指定已安裝的系統 Chromium（包括 persistent context）；第一次未指定 persistent context executablePath 的環境失敗已修正後重跑。沒有改產品程式或測試預期。

## 5. 科學、數學與證據限制（非本輪新增正式模型）

1. #153 對「查無相遇／轉向文獻」宜寫成本次搜尋未找到，而非全物種／全研究的絕對否定；它同時列出 R133 的 corrective turns。野外鑑定也不能只靠「大頭」確認熱帶大頭家蟻，應有鑑定鍵或可核對標本。這些列非阻擋文件意見。
2. #154 清楚區分臺中 CHC／攻擊相關、澳洲／喀麥隆情境、個體機制假設；群平均 profile 不能當個體分布，相關不能當化合物因果，body contact 不等於 antenna contact。Saund & Friedman 全文仍未讀到的狀態如實保留。批准純研究不等於批准警戒半徑或攻擊規則。
3. #160 的臺灣／屏東、佛州與夏威夷資料分開，合成關係不直接寫回世界。新分類保持 unknown；符合這個界線才可做有來源的虛構世界設定。
4. #161 另有非阻擋數學措辭：都市白天高、森林日夜相近，**不能排除所有單調溫度函數**。邏輯反例 `f(T)=1+0.001T+max(0,T−27)` 嚴格單調，森林 22.7／26.6°C 幾乎平坦、都市 27.7／31.2°C 則有大差。這只是反駁「不可能」的數學例，**不是擬合／推薦物種參數**；不能由這兩條描述曲線強推唯一的多因子結構。
5. #137 的離散每日 Erlang／負二項候選、pooled 比較與新 unified 權威帳的界線須保留。視角不影響命運是程式不變量，不是生態正確性的證據；精確／粗年齡差異與 O(個體) 成本應繼續報告。
6. #139 的接觸數值容差、確認時間與物理跨越時間分開；整合生物因果前不得把晚確認事件當成可回溯觸發的刺激。其誤差界與獨立測例適用已測數值尺度，不能由此聲稱任何坐標量級均有同樣絕對浮點誤差保證。
7. #162 的速度／接觸統計仍依軌跡與 gap 的取樣算子；非等間距資料的 segment 速度分布不是時間加權速度分布，與影片比較須統一。流量／抵達率不可成為調參目標。
8. Worker 核心是明示 synthetic bouts 的隔離世界，並非完整 P0-A2、正式 Day0 或生態科學驗證。SAVE 的 hash／交易正確亦不證明 payload 的生物合法性。

仍沒有據此授權正式規則、推進 Day15 或重啟正式 Day0。舊的局部營養、順序性、生命史／溫度與開放生態問題仍由相應 Issues 追蹤；合併研究／隔離模組不代表它們已解決。

## 6. 最小可重現探針

將以下 TypeScript 放到相應表列 head 根目錄，以 Node 22.23.4 執行。它們只操作合成記憶體狀態，不讀寫正式存檔。`[]` 是 reader 漏報的實際輸出，不是新的正確預期。

### #137 `probe-unified.ts`

```typescript
import {initialUnified,unifiedDay} from './prototypes/mixed-precision/unified.ts';
import {auditUnifiedDay} from './prototypes/mixed-precision/unified-audit.ts';
const P={stages:[{name:'adult',feeds:false,reproduces:false,senesces:false,substages:0,dd_required:null,hazard:0}],t_lower:10,meal:1,burn:0,crop_cap:10,egg_cost:1,p_lay:0,h_starve:0,dev_factor_hungry:1,senescence_start:30,senescence_slope:0};
const before=initialUnified('review',[{cohort:'C',taxon:'synthetic',colony_id:null,region:'G',stage:0,count:1,age:5,reserve:4,known:['W1']},{cohort:'C',taxon:'synthetic',colony_id:null,region:'P',stage:0,count:1,age:5,reserve:4,known:['W2']}]);
const good=unifiedDay(before,P,{temp_c:25,inflow:{},natural:[]});console.log('control',JSON.stringify({violations:auditUnifiedDay(before,good.records,good.state),kinds:good.records.map(r=>r.kind)}));
const bad=structuredClone(good.state);[bad.groups[0].members,bad.groups[1].members]=[bad.groups[1].members,bad.groups[0].members];console.log('swapped_without_migration',JSON.stringify({groups:bad.groups,violations:auditUnifiedDay(before,good.records,bad)}));
```

```text
control {"violations":[],"kinds":["aging"]}
swapped_without_migration {"groups":[{"cohort_id":"C","region":"G","stage":0,"sub":0,"age_mode":"exact","age":6,"reserve":4,"members":["W2"]},{"cohort_id":"C","region":"P","stage":0,"sub":0,"age_mode":"exact","age":6,"reserve":4,"members":["W1"]}],"violations":[]}
```

### #143 `probe-taxonomy.ts`

```typescript
import {engineRegistry} from './web/src/render-scene.ts';
for(const name of ['未知蜜露點','介殼蟲蜜露點']){console.log(JSON.stringify(engineRegistry([{id:'F',kind:'honeydew',name}] as any,{F:{x:0,y:0,known:true}},{F:{host_alive:true,hemipteran_colonies:1}})))}
```

```text
[{"id":"F","kind":"honeydew","x":0,"y":0,"name":"未知蜜露點","radiusCm":2.6,"hostAlive":true,"colonies":1,"insect":"aphid","source":"engine"}]
[{"id":"F","kind":"honeydew","x":0,"y":0,"name":"介殼蟲蜜露點","radiusCm":2.6,"hostAlive":true,"colonies":1,"insect":"scale","source":"engine"}]
```

### #162 `probe-transfer.ts`

```typescript
import {runSiteLedger,validateSiteEvents,type SiteSpec} from './engine/physics/destinations.ts';
const provenance={assumption:true as const,basis:'遊戲假設' as const,candidate_boundary:true as const,source_ids:[],note:'review synthetic'};
const sites:SiteSpec[]=[{id:'A',kind:'stay_spot',capacity:1,dwell_s:1,queue_max:1,on_release:{site:'B'},provenance},{id:'B',kind:'road_exit',capacity:1,dwell_s:1,queue_max:1,on_release:'off_plane',provenance}];
const good=runSiteLedger(sites,[{agent:'W',site:'A',kind:'arrive',t:0},{agent:'X',site:'B',kind:'arrive',t:3}],{kind:'agent_id'});
console.log('legitimate',JSON.stringify({events:good.events,violations:validateSiteEvents(sites,good.events)}));
const missing=good.events.filter(e=>!(e.agent==='W' && e.site==='B'));
console.log('missing_destination',JSON.stringify({events:missing,violations:validateSiteEvents(sites,missing)}));
```

```text
legitimate {"events":[{"t":0,"t_exact":"0","agent":"W","site":"A","kind":"arrive","occupancy_after":0,"queue_after":0},{"t":0,"t_exact":"0","agent":"W","site":"A","kind":"admit","occupancy_after":1,"queue_after":0},{"t":1,"t_exact":"1","agent":"W","site":"A","kind":"release","occupancy_after":0,"queue_after":0,"to":"B"},{"t":1,"t_exact":"1","agent":"W","site":"B","kind":"arrive","occupancy_after":0,"queue_after":0},{"t":1,"t_exact":"1","agent":"W","site":"B","kind":"admit","occupancy_after":1,"queue_after":0},{"t":2,"t_exact":"2","agent":"W","site":"B","kind":"release","occupancy_after":0,"queue_after":0,"to":"off_plane"},{"t":3,"t_exact":"3","agent":"X","site":"B","kind":"arrive","occupancy_after":0,"queue_after":0},{"t":3,"t_exact":"3","agent":"X","site":"B","kind":"admit","occupancy_after":1,"queue_after":0},{"t":4,"t_exact":"4","agent":"X","site":"B","kind":"release","occupancy_after":0,"queue_after":0,"to":"off_plane"}],"violations":[]}
missing_destination {"events":[{"t":0,"t_exact":"0","agent":"W","site":"A","kind":"arrive","occupancy_after":0,"queue_after":0},{"t":0,"t_exact":"0","agent":"W","site":"A","kind":"admit","occupancy_after":1,"queue_after":0},{"t":1,"t_exact":"1","agent":"W","site":"A","kind":"release","occupancy_after":0,"queue_after":0,"to":"B"},{"t":3,"t_exact":"3","agent":"X","site":"B","kind":"arrive","occupancy_after":0,"queue_after":0},{"t":3,"t_exact":"3","agent":"X","site":"B","kind":"admit","occupancy_after":1,"queue_after":0},{"t":4,"t_exact":"4","agent":"X","site":"B","kind":"release","occupancy_after":0,"queue_after":0,"to":"off_plane"}],"violations":[]}
```

### #163 `probe-discontinuous.ts`

```typescript
import {runKinematics,type Track} from './engine/physics/kinematics2d.ts';
const tr:Track={id:'A',body:{length_mm:2.5,width_mm:.8},segs:[{t0:0,t1:1,p0:{x:0,y:0,th:0},tw:{v:0,vl:0,w:0},label:'hold-before'},{t0:1,t1:Infinity,p0:{x:10,y:0,th:0},tw:{v:0,vl:0,w:0},label:'hold-after'}]};
try{const out=runKinematics({tracks:[tr],statics:[{id:'wall',kind:'segment',a:{x:5,y:-5},b:{x:5,y:5}}],horizon_s:2});console.log(JSON.stringify({accepted:true,final:out.final,events:out.events,executed:out.executed}))}catch(e){console.log('refused',String(e))}
```

```text
{"accepted":true,"final":{"A":{"x":10,"y":0,"th":0}},"events":[{"t_s":0,"kind":"plan_segment","ids":["A"],"class":"motion","detail":"hold-before v=0 vl=0 w=0"},{"t_s":1,"kind":"plan_segment","ids":["A"],"class":"motion","detail":"hold-after v=0 vl=0 w=0"}],"executed":{"A":{"body":{"length_mm":2.5,"width_mm":0.8},"segs":[{"t0":0,"t1":1,"p0":{"x":0,"y":0,"th":0},"tw":{"v":0,"vl":0,"w":0},"label":"hold-before"},{"t0":1,"t1":2,"p0":{"x":10,"y":0,"th":0},"tw":{"v":0,"vl":0,"w":0},"label":"hold-after"}],"stopped_at_s":null,"stop_cause":null}}}
```

### #167 `probe-future.ts`

```typescript
import {runBoth,ACCELERATION_RESERVED,type SharedScenario} from './engine/physics/shared-contract.ts';
const s:SharedScenario={schema:'antempire.physics-scenario.v1',id:'late',time:{unit:'s',t0_s:0,horizon_s:1},lanes:[{id:'L',layer:'G',centerline:[{x_mm:0,y_mm:0},{x_mm:100,y_mm:0}],width_mm:10}],obstacles:[],agents:[{id:'A',body:{shape:'capsule',length_mm:2.5,width_mm:.8},lane:'L',dir:1,s_mm:10,goal_s_mm:20,u_mm:0,start_t_s:2,speed_mm_s:10}],lane_edges_as_walls:true,acceleration:ACCELERATION_RESERVED};
const r=runBoth(s);console.log(JSON.stringify({horizon:1,kin_events:r.kin2d.motion_events,ph3b_events:r.ph3b.motion_events}));
```

```text
{"horizon":1,"kin_events":[{"t_s":2,"agent":"A","kind":"start","detail":null}],"ph3b_events":[]}
```

### #169 `probe-restore.ts`

```typescript
import {ExperimentWorld} from './prototypes/continuous-world/worker/core.ts';
import {hashJson} from './prototypes/continuous-world/worker/sha256.ts';
const original=ExperimentWorld.create('exp-review',7).world.snapshot();
console.log('valid',ExperimentWorld.restore(original).antView('w01')?.activity);
const bad=structuredClone(original);bad.payload.ants[0].activity='walking';bad.payload.ants[0].target=null;bad.payload_sha256=hashJson(bad.payload);
try{const w=ExperimentWorld.restore(bad);console.log('invalid_restore','accepted',w.antView('w01'));try{w.advanceTo(bad.payload.ants[0].until_s);console.log('advance succeeded')}catch(e){console.log('later_failure',String(e))}}catch(e){console.log('refused_at_restore',String(e))}
```

```text
valid resting
invalid_restore accepted {
  id: 'w01',
  activity: 'walking',
  since_s: 0,
  until_s: 2427.900108301237,
  pos: { x: 0, y: 0 },
  target: null,
  target_is_nest: false,
  in_nest: true,
  bout_index: 0,
  next_event: 'ant_bout_end:w01.b0',
  memory: []
}
later_failure TypeError: Cannot read properties of null (reading 'x')
```

### 舊 R14 反例修正複驗

```text
legitimate {"records":[{"event_id":"0.prom","kind":"promote","t":{"day":0,"minute":1,"time_resolution":"minute"},"source_region":"G","destination_region":"G","identity":{"action":"minted","ids":["M.C.G.aphid.adult.-.0"],"anonymous":0},"ledger_effects":[],"food_moves":[{"from":"cohort:C|G|aphid|adult|-:sugar","to":"org:M.C.G.aphid.adult.-.0:sugar","amount":50,"cause":"promotion_share"}],"cause":{"kind":"contact_with_focal","driver_event_ids":["contact:x"],"rule_id":"wp5.promote","rng_stream":"promote","roll":0.734750967938453},"resolution_change":null,"scenario_source":null,"parent":null,"cohort_id":"C|G|aphid|adult|-","allocation":{"rule":"cohort_share.floor_last_takes_rest","cohort_id":"C|G|aphid|adult|-","members":1}}],"cohorts":[{"cohort_id":"C|G|aphid|adult|-","taxon":"aphid","stage":"adult","colony_id":null,"region":"G","count":1,"comp":{"sugar":50},"roster":[{"id":"X","physio":{"age":2}}],"next_serial":1}],"individuals":[{"id":"M.C.G.aphid.adult.-.0","taxon":"aphid","stage":"adult","colony_id":null,"region":"G","physio":{},"comp":{"sugar":50}}],"audit":[]}
forged {"move":{"from":"cohort:C|G|aphid|adult|-:sugar","to":"org:M.C.G.aphid.adult.-.0:sugar","amount":1,"cause":"promotion_share"},"cohort":{"sugar":99},"individual":{"sugar":1},"audit":["0.prom: allocation cohort:C|G|aphid|adult|-:sugar -> org:M.C.G.aphid.adult.-.0:sugar: record moves 1, rule cohort_share.floor_last_takes_rest on the replayed balances gives 50"]}
{"start":0.399,"steer":0.399,"physics":0.399,"events":[{"t_s":0.399,"kind":"start","agents":["A"],"class":"motion","detail":null},{"t_s":0.399,"kind":"arrive","agents":["A"],"class":"motion","detail":null}]}
{"start":0.4,"steer":0.4,"physics":0.4,"events":[{"t_s":0.4,"kind":"start","agents":["A"],"class":"motion","detail":null},{"t_s":0.4,"kind":"arrive","agents":["A"],"class":"motion","detail":null}]}
{"start":0.401,"steer":null,"physics":null,"events":[]}
```

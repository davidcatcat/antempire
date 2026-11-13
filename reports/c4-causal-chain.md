# C4 因果鏈分析（自動產生；非正式 Day0 實驗世界）

由 `node cli/reports/c4-causal-chain.ts` 產生；引擎 `antempire.v2-review.33-dead-params`。A1/A3/A5 × 春／秋 × 種子 1,2,3,4,5 × 60 日。所有數字是遊戲假設下的模型輸出，不是野外值，也不是目標。說明見 docs/c4-causal-chain.md。

守恆：80871 個區室日（243615 個個體區室日）逐日檢查，最大殘差 0，失敗 0。

| 變體 | 無餵食接觸的幼蟲日 | 蛋白攝取／需求 | 卸貨蛋白／幼蟲需求 | 溢出／幼蟲需求 | 到達幼蟲／卸貨 | 取出的蛋白給蟻后 | 達門檻接觸中工蟻帶蛋白 |
|---|---|---|---|---|---|---|---|
| base_c3a_c4a | 68.3% | 19.4% | 3.402906 | 1.263211 | 5.7% | 19.2% | 53.8% |
| v29_first_seen_prior | 68.3% | 19.4% | 3.402906 | 1.263211 | 5.7% | 19.2% | 53.8% |
| v30_c4b_clamp_linear_TEST | 87.5% | 6.6% | 1.573466 | 0.542903 | 4.2% | 23.6% | 49.8% |
| v30_c4b_threshold_0.5_TEST | 87.5% | 6.6% | 1.573133 | 0.542788 | 4.2% | 23.6% | 49.8% |
| v30_c4b_saturating_K0.5_TEST | 87.5% | 6.6% | 1.573794 | 0.543016 | 4.2% | 23.6% | 49.8% |
| v31_nurse_cue_same_place | 68.3% | 19.4% | 3.402906 | 1.263211 | 5.7% | 19.2% | 53.8% |

## 基準變體（base_c3a_c4a）的幼蟲日瓶頸

| 階段 | 幼蟲日 | 比例 |
|---|---|---|
| larva-days (larva_nutrition records) | 3168 | 100.0% |
| a colony with no nurse task that day | 903 | 28.5% |
| nurse task but no nurse in the nest round (not at the nest) | 0 | 0.0% |
| nurses in the round but this larva not drawn | 1260 | 39.8% |
| contacted, begging below threshold | 111 | 3.5% |
| eligible contact, nurse holds no protein: the cache was empty at its turn | 2 | 0.1% |
| eligible contact, nurse holds no protein: its crop was full (sugar) | 272 | 8.6% |
| eligible contact, nurse holds no protein: it gave all to the queen first | 107 | 3.4% |
| eligible contact, nurse holds no protein: other | 0 | 0.0% |
| fed protein, less than need | 205 | 6.5% |
| fed protein, need met | 308 | 9.7% |

## 基準變體的蛋白流（份）

| 階段 | 蛋白（份） |
|---|---|
| 1 source: prey killed into a source (prey_kill) | 45.5 |
| 2 collect: source → in_transit (collect) | 847.180805 |
| 3 carry + 4 unload: in_transit → cache (unload) | 847.180805 |
| 5 nest store at round start (Σ over days, state replay) | 13534.802341 |
| 6 nurse obtains: cache → crop (take_from_cache) | 334.640471 |
| 6a queen leg first: crop → queen_body (feed_queen protein) | 64.162031 |
| 7 held by nurses at larva contacts (replay) | 186.618954 |
| 8 larva ingests: crop → larva_body (feed_larva protein) | 48.392416 |
| 9 larval metabolism paid (larva_metabolism protein) | 46.71992 |
| larval need (larva_nutrition need) | 248.958057 |
| put back: crop → cache (return_to_cache) | 222.086024 |
| lost: cache → loss:storage_overflow | 314.486596 |
| aggregate metabolism from cache (workers, F01) | 65.428771 |
| eggs from cache (lay_egg, A08) | 53.2 |

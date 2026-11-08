# 證據查核：Saund & Friedman 2023（R102）全文取得紀錄（2026-11-08）

> 目的：依 #130 要求，以**合法途徑**取得 Saund E, Friedman DA (2023) *A single-pheromone model accounts for empirical patterns of ant colony foraging previously modeled using two pheromones*. *Cognitive Systems Research* 80:81–89（DOI 10.1016/j.cogsys.2023.02.005；ScienceDirect PII S1389041723000207；出版社版本 CC BY）的全文，核對方程式、假設、涵蓋的實驗，以及是否處理 Dussutour et al. 2009 *J Exp Biol* 的實驗 3。
>
> **結論先講**：本次**仍未讀到全文**。方程式、假設、擬合方法、圖與「未處理實驗 3」的原文句子**全部未核對**。能確認的只有書目、授權狀態與摘要。舊文件（`docs/research-pheromone-models-2026-11.md` §1、§10.2、§11）的證據狀態維持「只讀摘要」；本文件只新增，不改寫它們。

## 1. 嘗試的途徑與結果

| 途徑 | 結果 |
|---|---|
| DOI 解析 `doi.org/10.1016/j.cogsys.2023.02.005` | 302 → `linkinghub.elsevier.com/retrieve/pii/S1389041723000207`（確認 PII） |
| ScienceDirect 文章頁、`/abs/` 頁、`/pdfft` 下載（curl 與網頁擷取工具） | 403（機器人防護） |
| `reader.elsevier.com` | TLS 交握失敗 |
| `ars.els-cdn.com` 主 PDF 位置 | 400 |
| Elsevier Article API（Crossref 提供的 `api.elsevier.com` 連結） | 無金鑰時 `text/xml` 只回約 2 KB 書目；`text/plain` 與 `view=FULL` 回 400／401（需要 API key）。未申請或使用任何金鑰 |
| Unpaywall API（通用客戶端，未使用使用者信箱） | `is_oa: true`、`oa_status: hybrid`、`license: cc-by`，唯一位置是出版社頁，`url_for_pdf: null`，`has_repository_copy: false` |
| OpenAlex | 同上；`has_fulltext: false`；無典藏副本 |
| Semantic Scholar Graph API | 取得摘要與 TLDR；`openAccessPdf` 只指回 DOI；`pdfs.semanticscholar.org` 轉址到論文頁、沒有 PDF |
| Semantic Scholar snippet 搜尋 API（論文內文片段） | 見 §3 |
| Europe PMC | 0 筆（不是生醫期刊，未收錄） |
| CORE API | 0 筆 |
| scholar.archive.org | 200，但沒有此 DOI 的檔案 |
| Wayback Machine（`archive.org`） | 被本環境的對外網路政策擋下 |
| AntWiki 開放 PDF（#130 所附網址；curl 與網頁擷取工具） | 403（Cloudflare 驗證頁），與 CHEM-0 §11.1 相同 |
| 作者程式 `github.com/docxology/ant-pheromone` | 本 session 未開放該 repo 的 GitHub 存取；未重讀（先前讀過，見研究文件 §1） |
| Google Scholar 快取 | 依指示**未使用** |

## 2. 能確認的內容

- **書目**：作者 Eric Saund（Saund Laboratories）、Daniel Ari Friedman（Active Inference Institute；UC Davis 昆蟲與線蟲系，通訊作者）；2023-02-16 線上；*Cognitive Systems Research* 80:81–89；41 篇參考文獻（Semantic Scholar 計數）。
- **授權**：出版社版本 CC BY（Unpaywall、OpenAlex 一致），所以若 Owner 在可通過驗證的瀏覽器下載，可合法存放於 repo 外工作區供查核。
- **摘要（Semantic Scholar API 原文要點）**：Dussutour et al. 2009 提出本種覓食使用探索與取食兩種吸引費洛蒙，並建立雙費洛蒙模型；本文「顯示主要報告的實驗觀察可以用單一費洛蒙模型解釋」；假設兩種費洛蒙「合理但不必要」，因此該研究「不足以作為雙費洛蒙模型的決定性證據」；更廣泛地，行為型態對感覺與認知機制可能是模糊的，呼籲對不同結構的模型做正式比較。

## 3. Semantic Scholar 片段搜尋

以三組查詢（「Experiment 3」、沉積／衰退／選擇函數、流量）限定本論文，各重試最多 9 次、間隔逐步加長到 75 秒，**全部回 429（無金鑰的速率限制）**，沒有取得任何內文片段。未申請金鑰。

## 4. 未核對（不得引用為論文內容）

- 模型方程式（沉積、衰退、感知／選擇函數）：**未核對**。專案文件中「冪次放大再乘 sigmoid」「有食物的分支沉積較多」只來自作者公開程式，程式可能和發表版不同。
- 假設清單、擬合方法、擬合品質、模型比較準則：**未核對**。
- 涵蓋哪些實驗：摘要只說「主要報告的實驗觀察」與「兩個主要結果」，沒有列出實驗編號。
- **實驗 3（流量）是否處理**：#130 轉述「正文 §3 指明未處理 Experiment 3」。Claude 本次**沒有讀到該句**，無法引用原文，也無法確認或否認；只能記為「依 Owner 轉述與作者程式一致：未處理」。
- 所有圖：**未核對**。

## 5. 使用限制（不論日後是否讀到全文）

- 單一費洛蒙模型能擬合同一批資料，**只表示這批資料不足以區分** M1 與 M2；**不能**說雙費洛蒙模型被推翻，也不能說本種只有一種費洛蒙。原作者（Dussutour 2009）的反方論點（兩實驗中 E＋F 選擇頻率約 15 分後分歧）仍然保留。
- CHEM-2 中 O3（JEB 實驗 3）**不得**當成 M1 已重現的型態。

## 6. 需要 Owner 的事
- 若要完成逐頁查核，需要 Owner 在可通過驗證的瀏覽器取得 PDF（CC BY，可合法保存），放在 repo 外的工作區；或授權使用 Elsevier API 金鑰（金鑰須經環境的憑證機制，不得寫入 repo）。

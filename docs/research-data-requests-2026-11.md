# 研究資料取得追蹤（2026-11）

> 性質：研究紀錄，不改引擎、參數、存檔或日誌；不推進遊戲日。
> 依 Owner 決定 31（R133 原始影片／人工轉彎計分規則）與 33（R720 附表 S2）。
> 原則：**未取得的資料一律不當作已取得**；不重建、不猜測未取得的數值；對外聯絡需 Owner 授權，本文件只有**草稿**，未寄出。
> 查核日期：2026-11-08（全部查詢在本 session 的受限網路環境中進行）。

## 狀態總表

| 項目 | 需要什麼 | 狀態 |
|---|---|---|
| 31 | R133 Vázquez, Koehler & Pereira 2020 原始錄影，或人工計分「轉彎」的操作規則 | **未取得**；公開來源都沒有。請求信草稿已備（§1.4）。**未寄出——對外聯絡需要 Owner 授權**（2026-11-08） |
| 33 | R720 Chiu et al. 2026 附表 S2（65 個 CHC 峰） | **未取得**；期刊頁標示「有附錄」，但本次看到的頁面沒有下載連結；其他公開典藏都沒有。**沒有重建或推測任何 S2 數值** |

## 1. 決定 31：R133 原始錄影與轉彎計分規則

**文獻**：Vázquez RJ, Koehler PG, Pereira RM (2020) Comparative Quantification of Trail-Following Behavior in Pest Ants. *Insects* 11(1):5. DOI 10.3390/insects11010005（線上 2019-12-19；CC BY 4.0）。第一作者 Ricardo J. Vázquez（論文所列單位 Bayer Crop Science, Waterman, IL）；Koehler、Pereira 為 University of Florida 昆蟲與線蟲系；**通訊作者 Roberto M. Pereira（rpereira@ufl.edu）**。

### 1.1 查過的地方與結果

| 來源 | 查詢 | 結果 |
|---|---|---|
| MDPI 文章頁 `mdpi.com/2075-4450/11/1/5`（含 `/pdf`、`/htm`；curl 與網頁擷取工具） | 找 Supplementary Materials 段 | **403**（機器人防護），無法看到 MDPI 頁面本身 |
| PMC 全文 `ncbi.nlm.nih.gov/pmc/articles/PMC7022549/` | 全文搜尋 supplementary、data availability、video | 200。**沒有** Supplementary Materials 段、**沒有**資料可得性聲明；只寫錄影（Sony DCR-HC36、30 分鐘、鏡頭高 61 cm）與「路徑轉描到方格紙」；致謝寫「錄影與實驗協助：M. Mitola」 |
| Europe PMC REST `supplementaryFiles`、`fullTextXML` | 附件 | 伺服器錯誤（Connection refused／500），無結果 |
| Crossref `api.crossref.org/works/10.3390/insects11010005` | `relation`（關聯資料集） | 空；唯一連結是 MDPI PDF |
| Unpaywall | 開放位置 | 金色 OA；位置只有 MDPI PDF 與 PMC，無資料典藏 |
| OpenAlex | 位置 | Insects、Europe PMC、PMC、PubMed；無資料集 |
| Zenodo API | 「trail-following」AND「pest ants」；DOI 字串 | 0 筆；0 筆 |
| Figshare API | 標題精確查詢 | 0 筆（關鍵字查詢只回無關的垃圾結果） |
| Dryad API | 「Pheidole megacephala trail」 | 0 筆 |
| DataCite | 「trail-following」AND Pheidole | 1 筆：Giraldo et al. 2015 Dryad「Trail following」（*Pheidole dentata* 老化研究，**無關**） |
| OSF／SHARE | 標題查詢 | 只找到本文的書目紀錄，無 OSF 專案或資料 |
| BASE | 標題查詢 | 回 404 頁 |
| University of Florida Digital Collections（ufdc.ufl.edu） | 學位論文／典藏 | **TLS 憑證錯誤，連不上**（未關閉驗證） |
| UF 昆蟲系教師頁、Urban Entomology 網站 | 作者頁面 | 404／502，連不上 |
| 網頁搜尋（作者＋trail-following＋video／dissertation） | 作者頁、學位論文、影片 | 沒有找到公開影片、資料或學位論文；只找到 2008 ESA 年會摘要（下） |
| ESA 2008 年會摘要 0534 `esa.confex.com/esa/2008/webprogram/Paper37578.html` | 同作者早期報告 | 200。只有研究假說（大頭家蟻與加勒比瘋蟻的覓食需求、路徑費洛蒙與生物特徵），**沒有方法細節或資料**；頁面列有「Audio File」（未聽） |

### 1.2 論文中已有的轉彎定義（PMC 全文，Materials and Methods）

- 原文：「Turns (total number of) measures the frequency of corrective actions (left and right turns away or towards the center trail) an ant takes as it follows the trail.」
- 計數條件：只計起點在中線 5 mm 內的個體；每次最多 10 分鐘或 15 隻；前 10 分鐘不錄（讓偵察蟻找路與招募）。路徑在影片中**轉描到方格紙**後量測。
- **缺的**（也就是要問作者的）：一次「轉彎」的最小角度或最小側移、是否以方格紙格線為判準、左右連續擺動如何切分、計分者人數與一致性、影片解析度與幀率、轉描方法（逐幀描點或目視）。
- **原文自身的文字問題（照記，不修正）**：速度定義寫「以完成 150 mm 的時間**除以**距離」，數學上應為距離除以時間；結果的單位（mm/s）與後者一致。

### 1.3 結論
公開來源**沒有**原始錄影，也**沒有**比 §1.2 更細的轉彎計分規則。專案中凡用到 R133「轉彎數」的地方，仍只能當「作者以人工目視從轉描路徑計數」的結果，**操作定義不完整**；不得自行補定義後宣稱與原文可比。

### 1.4 請求信草稿（**未寄出**）

> 狀態：**not sent — external contact requires Owner authorisation**（未寄出：對外聯絡需 Owner 授權），2026-11-08。
> 收件人建議：通訊作者 Roberto M. Pereira（rpereira@ufl.edu），副本 Philip G. Koehler（pgk@ufl.edu）。第一作者目前單位與信箱未經確認，不列。
> 寄出前請 Owner 決定：寄件人身分與署名、是否提及本專案名稱、是否附專案連結。

**中文摘要**：說明我們是一個以文獻為本的螞蟻生態模擬專案，引用了貴文的大頭家蟻沿跡速度與轉彎數；請問 (1) 是否能分享原始錄影（或部分片段），(2) 若影片無法提供，能否說明人工計分「轉彎」的操作規則；承諾只用於研究、標明出處、不轉散布，並接受無法提供的回覆。

**English letter (draft)**

> Subject: Request regarding trail-following videos / turn-scoring criteria — Vázquez, Koehler & Pereira (2020), *Insects* 11(1):5
>
> Dear Dr. Pereira,
>
> I am writing on behalf of a small, non-commercial ecological simulation project that models the foraging behaviour of *Pheidole megacephala* from the published literature. Your paper "Comparative Quantification of Trail-Following Behavior in Pest Ants" (*Insects* 2020, 11(1):5, doi:10.3390/insects11010005) is one of the very few sources reporting quantitative trail-following measures for this species, and we cite it for trail velocity, amplitude, fidelity and the number of turns.
>
> To use the turn counts correctly, we would be grateful for either of the following, whichever is easier:
>
> 1. Access to the original video recordings (or a subset of the *P. megacephala* trials), or
> 2. A short description of how turns were scored by hand — for example, the minimum angle or lateral displacement counted as one turn, how consecutive left–right oscillations were separated, whether the graph-paper grid was used as the criterion, how paths were transcribed from video, and how many people scored the tracings.
>
> We searched the journal page, PubMed Central, Zenodo, Figshare, Dryad, OSF and the University of Florida repositories before writing, and found no supplementary files.
>
> Any material would be used only for research purposes, cited to your paper, and not redistributed without your permission. We fully understand if the recordings are no longer available or cannot be shared; a reply to that effect would also help us document the limits of our model.
>
> Thank you very much for your time.
>
> Kind regards,
> [Name — to be filled in by the project owner]
> [Affiliation / contact — to be filled in by the project owner]

## 2. 決定 33：R720 Chiu et al. 2026 附表 S2

**文獻**：Chiu Y-C, Wang C-C, Nai Y-S, Peng M-H, Hsu J, Neoh K-B (2026) Genetics, cuticular hydrocarbon profiles, and bacterial endosymbionts are associated with the nestmate recognition in the invasive African big-headed ant, *Pheidole megacephala*, in Taiwan. *Myrmecological News* 36:59–72. DOI 10.25849/myrmecol.news_036:059（CC BY 4.0）。收稿 2024-12-04、修訂 2025-10-16、接受 2025-12-18；聯絡作者 Kok-Boon Neoh（中興大學昆蟲學系，neohkokboon@nchu.edu.tw）。

### 2.1 查過的地方與結果

| 來源 | 結果 |
|---|---|
| DOI 解析 | 302 → 期刊文章頁 `myrmecologicalnews.org/cms/index.php?option=com_content&view=category&id=1670&Itemid=444` |
| 期刊文章頁（200） | 欄位寫「**Supplementary material: Yes**」，但頁面上的下載連結只有主文 PDF、RIS、TXT 三個，**沒有附錄檔連結**；頁面中繼資料也只有主文 PDF |
| 主文 PDF（期刊官方，`…filename=volume36/mn36_59-72_printable.pdf`；14 頁；SHA-256 `dc202470555796c40f3883f5d0705f7cc67826eeadae749d4961a3aa15b3061d`） | 正文寫表 S1「as digital supplementary material to this article, at the journal's web pages」；表 S2 被引用於結果（66 峰）、圖 2 圖說（峰號對應表 S2）與討論。PDF **沒有內嵌附件**（`pdfdetach` 0 個） |
| 期刊部落格文章（2026-02-18） | 只連回文章頁；沒有附錄連結 |
| Zenodo、Figshare、Dryad、DataCite | 沒有本文的資料集（Zenodo DOI 查詢 0 筆；其餘只有無關的 *Pheidole* 紀錄） |
| OpenAlex | 只有期刊位置，無典藏副本 |
| 中興大學機構典藏 `ir.lib.nchu.edu.tw`、昆蟲系網站 | 連線被重設／代理 502，**連不上** |
| 依檔名規則猜測附錄網址 | **沒有做**：猜測未公開的網址不是「期刊公開提供」的途徑；本環境也拒絕了這類探測 |

### 2.2 結論
- 表 S2 **未取得**。期刊頁表示附錄存在，但本次在期刊公開頁面上找不到下載途徑；其他公開典藏也沒有。
- 因為沒有取得，**不能確認**其內容、單位、樣本、條件。專案內任何地方都**不得**重建、讀圖估計或猜測 S2 的峰值。
- 已知、可引用的只有主文內容（`docs/chem4-alarm-chc-literature.md` §B.1）：65 峰、C25～C40、群合併萃取 50 隻、只保留相對峰面積 > 0.5%、各化合物類別的百分比。
- 即使日後取得，S2 也只能當「臺中族群群平均的成分範圍」，不能當本花園蟻群的 profile（見 chem4 文件 §0.3）。

### 2.3 可能的下一步（需 Owner 決定，未執行）
1. Owner 用一般瀏覽器開期刊文章頁，看是否有本環境看不到的附錄連結（例如需要 JavaScript 或登入）。若有且是公開檔，放在 repo 外工作區，由 Claude 核對並記錄出處。
2. 若仍找不到：寫信問期刊編輯部或聯絡作者 Neoh 博士。草稿如下，**未寄出——對外聯絡需 Owner 授權**（2026-11-08）。

**中文摘要**：請問附表 S1～S4 的公開下載位置；若尚未上線，是否可提供表 S2；只用於研究並標明出處。

**English letter (draft)**

> Subject: Supplementary Table S2 — Chiu et al. (2026), *Myrmecological News* 36:59–72
>
> Dear Dr. Neoh,
>
> We are a small, non-commercial project building a literature-based ecological simulation of *Pheidole megacephala* in Taichung, and your 2026 paper is the only study we know of that reports cuticular hydrocarbon profiles for Taichung colonies.
>
> The article page on the *Myrmecological News* website indicates that supplementary material exists, and the paper refers to Tables S1–S4, but we could not find a download link for them. Could you tell us where the supplementary files are published, or, if they are not yet online, would you be willing to share Table S2 (the list of 65 peaks with their relative abundances per colony)?
>
> The data would be used only for research purposes, cited to your paper, and not redistributed without permission.
>
> Thank you very much for your time.
>
> Kind regards,
> [Name — to be filled in by the project owner]
> [Affiliation / contact — to be filled in by the project owner]

## 3. 尚未解決／需 Owner 決定
1. 是否寄出 §1.4（R133）與 §2.3（R720）的信；以誰的名義寄。
2. R133 的轉彎數在補到操作定義前，是否應在使用處加註「定義不完整」（建議：是）。
3. R720 表 S2：先請 Owner 以一般瀏覽器確認期刊頁是否有附錄連結。

# 研究資料的輸入來源與指紋（Issue #51／#49 N3、#43 R12）

## 原則
- 研究資料（例如 `reports/phase2-sensitivity*`）必須能證明它是用哪些輸入產生的。
- 輸入一改，舊資料就必須失效，直到輸入恢復或重新計算。
- 引擎與參數檔由規則指紋涵蓋（`cli/lib/fingerprint.ts`）。

## input manifest v2（`cli/lib/input-manifest.ts`，2026-11-03 起）
- **程式**：評估腳本在 `cli/` 內的匯入閉包，由原始碼的 import 推導，不是人工清單。
- **資料**：載入參數並初始化每一種創巢 × 每一季時，**實際從磁碟讀到**的檔案。觀察 `fs.readFileSync` 而得；參數檔除外，因為規則指紋已涵蓋。
  - 目前是 `data/taichung-climatology-1991-2020.json`（CWA 1991～2020 平年值）與 `scenarios/day0/*` 中實際使用的檔案。
- 每個資料檔記錄 sha256、大小、檔案自己的 `schema`，以及 `provenance`／`source` 區塊。
- manifest 納入 `configHash`；分片與批次只在設定完全相同時才能合併。

## 舊資料（v19、v20 敏感度資料）
- 產生時只記錄人工列出的檔案，**沒有氣候資料**。這些資料**不改寫**，也不事後把新的 hash 填進去。
- 每個資料目錄另有 `provenance-attestation.json`，是**事後的重新驗證**，不是產生時的紀錄：
  - 用產生該資料的規則版本，加上目前的資料檔，重跑全部 400 筆基準列；逐位元組相同才寫入。
  - v19、v20 都是 400/400。
  - 它只能證明「儲存的列與這些輸入一致」，不能證明產生當時用的是哪個檔案。
- 驗證器規則：
  - 舊清單中仍被讀取的檔案必須相同；
  - 舊清單沒有記錄的資料檔，必須有事後驗證，且雜湊相同；
  - 缺事後驗證就報 provenance gap（無效）；
  - 舊清單中已不再讀取的檔案只列出，不比較，因為無關的檔案改變不應讓資料失效。

## 測試
`tests/issue51-input-manifest.test.ts` 全部在暫存的 repository 副本中修改檔案，不碰真正的檔案：
- 一月氣溫 17 → 27 °C：Day0 的 `prior_air_temp_c` 17.04 → 27.04；`configHash` 改變；所有資料失效；恢復後通過；
- 改 garden、seasons、founding 檔：同樣失效；改無關的資料檔：不變；
- 移除事後驗證：報 provenance gap；
- v2 manifest 的資料：氣候改變就失效，恢復後通過。

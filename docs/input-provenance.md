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
  - 範圍：只重跑基準列（caf 0.5、rmin 0.5），即 3,520 列中的 400 列；其餘列由各工作的參數雜湊與 `tests/phase2-sensitivity.test.ts` 的固定種子重跑涵蓋，不在此事後驗證內（寫在 `scope` 欄位）。
  - 事後驗證檔本身也要驗證（獨立審查 #54）：schema、資料批次與規則版本必須與該目錄的資料相同，`rows_equal` 必須等於 `rows_rerun` 且為 400；`undo_chain_sha` 綁定重建舊參數所用的 `rules/registry.json` 版本順序與 `tests/golden/approved-rule-changes.json` 的相關條目，這兩個檔之後若改變，事後驗證就失效，要重新驗證。手改或從別的目錄複製的事後驗證檔都會被拒絕。
  - 目前的事後驗證是用 v2-review.21 引擎（`run_with_engine`）重建舊規則版本所做。
- 驗證器規則：
  - 舊清單中仍被讀取的檔案必須相同；
  - 舊清單沒有記錄的資料檔，必須有事後驗證，且雜湊相同；
  - 缺事後驗證就報 provenance gap（無效）；
  - 舊清單中已不再讀取的檔案只列出，不比較，因為無關的檔案改變不應讓資料失效。
  - 資料目錄缺少 `input_manifest` 時報錯，不會當掉；
  - 已知限制（Issue #57）：舊清單以外、現在 import closure 會讀到的 cli 程式，產生時沒有記錄，只列在 `code_files_not_recorded_at_generation`，無法比對。
    - **處理方式（Owner 2026-11-06 選擇方案 2）**：維持現狀，並在驗證結果中明確標示為「無法驗證」：`checks.input_manifest.code_provenance.status = 'unverifiable_not_recorded_at_generation'`，附檔案數。
    - 這些程式檔**不比較、不算作已驗證**，也不事後把 hash 填回舊資料（#49 N3）。
    - 事後驗證檔用的是今天的程式重跑基準列，它只證明一致性，不證明產生當時用的是哪份程式。
    - `tests/issue51-input-manifest.test.ts` 第 5 段檢查 v19、v20 兩個目錄都如實回報這個狀態。
    - 沒有採用的方案：方案 1（從 git 歷史反查產生時的 commit）與方案 3（用 v2 manifest 重新產生，成為新的資料目錄）。
- import closure 會辨識多行的 `import { … } from '…'`、副作用 import 與動態 `import()`。

## 測試
`tests/issue51-input-manifest.test.ts` 全部在暫存的 repository 副本中修改檔案，不碰真正的檔案：
- 一月氣溫 17 → 27 °C：Day0 的 `prior_air_temp_c` 17.04 → 27.04；`configHash` 改變；所有資料失效；恢復後通過；
- 改 garden、seasons、founding 檔：同樣失效；改無關的資料檔：不變；
- 移除事後驗證：報 provenance gap；
- v2 manifest 的資料：氣候改變就失效，恢復後通過。

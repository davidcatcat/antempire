# Phase 3 文獻筆記附錄：R167 Phillips 1933 停食試驗原文重讀（2026-11-13，#226）

> 本檔是 [`literature-notes.md`](literature-notes.md) 的附錄。原筆記是 2026-11-02 的研究紀錄，**不改寫**；這裡只新增原文重讀的結果與推論邊界。

## 原文

- Phillips JS (1933) *The biology, distribution and control of ants in Hawaiian pineapple fields*. PhD thesis, University of Hawaii. ScholarSpace：hdl:10125/13477（打字稿掃描 PDF，含 OCR 文字層）。
- 讀取程度：**IMG**（2026-11-13 將 PDF 第 34 頁轉成影像逐字閱讀；OCR 文字層把「77 deg. F.」誤讀為「17 deg. F.」，以影像為準）。
- 位置：打字稿 **p.29**，小節「Lengthening of the Life cycle under special conditions」。

## 處理組（分開記錄）

| 處理組 | 條件 | 原文結果 | 未記錄（null） |
|---|---|---|---|
| 意外漏餵 3 週 | 人工巢放在 77°F（約 25°C）溫度櫃；整巢 3 週沒有供食 | 第 38 日幼蟲仍未長成（38 日的起算點未寫）；恢復供食後再 8 日成熟並化蛹 | 幼蟲數、存活比例、停食開始的齡期（群數：原文寫「一個人工巢」，即 1 群） |
| 重複試驗 2 週 | 同溫度櫃；整巢停食 2 週後恢復 | 成功；幼蟲期延長為 32～36 日；蛹期看似正常 | 恢復→化蛹日數、群數、幼蟲數、存活比例、停食開始的齡期 |
| 重複試驗 3 週 | 同上，停食 3 週 | 工蟻死亡；補入的新工蟻殺死並吃掉幼蟲 | 沒有幼蟲耐飢資料 |
| 重複試驗 4 週 | 同上，停食 4 週 | 同 3 週組 | 沒有幼蟲耐飢資料 |

原筆記 A3 的「2-week starvation → 32–36 d」與「After 3 weeks unfed … pupated 8 d after refeeding」分開記錄，與原文一致。原筆記沒有寫到：停的是**整巢**供食，以及重複試驗 3、4 週組因工蟻死亡、幼蟲被替補工蟻吃掉而沒有結果。

## 推論邊界

- 停的是整巢供食；工蟻在停食後仍可能以嗉囊存量等餵幼蟲，**個別幼蟲實際未被餵的時長沒有記錄**。
- 設幼蟲停止被餵後 R 日儲備才用完、之後虧損 τ 日死亡，則停食到死亡＝R + τ。觀察只說明受觀察、存活下來的幼蟲 R + τ 超過停食時長（且只在「幼蟲自整巢停食起就沒被餵」的附加假設下）；R 未知，**不能**推出 τ 的下限。
- 這項觀察是定性的本種方向：缺食延長幼蟲期，恢復供食後可化蛹。

## 後續影響

- `docs/p0a2-brood-physiology-design.md` §4.5、§9 與候選檔 `haz_h1_tau_e_d`、`literature_observations` 已依此更正；`docs/references.md` R167 附加日期更正段。

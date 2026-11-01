# web/（預留）

未來的手機網頁版放在這裡。規則（見 [CLAUDE.md](../CLAUDE.md) §8）：

- 網頁**只讀取**正式結果（`saves/`、`journal/`、`reports/`），**不產生正式歷史**，也不寫回存檔。
- 可以直接載入 `engine/`（純 TypeScript，無 DOM／Node API）做唯讀重播或「如果…會怎樣」的試算，但試算結果不得寫回存檔。
- 正式推進只在 Node（`npm run advance`）執行。

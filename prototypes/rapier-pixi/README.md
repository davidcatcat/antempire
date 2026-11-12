# AntEmpire：Rapier 2D × PixiJS 物理見證實驗

**獨立實驗，不是正式模擬，也不是已完成物種科學驗證。**

這份實驗直接使用 repo 已實作的 `prototypes/physics/two-ant-corridor.ts`、`engine/physics/collision.ts` 與 `scenarios/physics/*.json`，沒有複製或自行猜測任何螞蟻運動數字。

- **Native AntEmpire**：事件驅動運動學，計算接觸、退讓、到達、軌跡。
- **Rapier 2D 0.21.0 deterministic-compat**：在每隔 1/120 秒的相同原生軌跡座標，配置水平膠囊體、觸角候選感測器與原始合成牆面，檢查身體重疊、牆面重疊及感測器相交。**不參與讓路決策**。
- **PixiJS 8.22.0**：只播放 Native 的 `MotionInterval` 並顯示原生事件，無新增行為。螞蟻畫面位置在同一原生運動區間內內插。

## 執行

需要 Node >= 22.18、可連 npm registry 的環境。

```bash
cd prototypes/rapier-pixi
npm install --no-audit --no-fund
npm run verify  # 產生 public/replays/compare.json，列出每個實驗場景的真實數字
npm run dev     # Vite，手機同區網可使用
npm run build   # 產生 dist/ 靜態預覽
```

子專案獨立安裝依賴；不修改根目錄 `package.json`、`package-lock.json`、`saves/` 或 `journal/`。

## 實驗設計

1. **入口讓路**：合成狹道、候選接觸停頓 0.18 秒；兩隻工蟻由既有 Native 演算法決定動作。
2. **雙方已進入窄道**：採用明示的 `inside_turn_back_probability=0.5` 候選值，不是本種實測。
3. **無牆對照**：原 Native 行為的對照。Rapier 投影到同一中心線，未模擬橫向錯身，可能出現**假陽性**；不可把它當作 Native 的身體穿透證據。

保留原有 `0.5–0.8 mm` 的碰撞寬度候選、`2.5 mm` 體長與 `18.5/15.5 mm/s` 速度。本種以外的讓路比例不能被描述為 *P. megacephala* 行為驗證。

### 比較結果如何解讀

`native_exclusion_violations` 是 AntEmpire 原有 2.5D 排斥檢查器的結果；Rapier 的 `body_overlap_frames` / `wall_overlap_pairs` 是 **2D、固定步長、沿同一中心線** 膠囊體感測器對原生軌跡的見證值。兩套測量具有不同的幾何近似，**不能**直接推論 Rapier 重現原有讓路統計、時間事件或證明自然科學正確。

沒有對 Rapier 採用任意新的速度、飢餓、負重減速、接觸決策或世界時間。未知的真正幾何仍是未知，演示只使用 `synthetic: true` 的場景。

若要真正**由 Rapier 解算下一步運動**，應另開隔離 PR，以同一輸入跑兩個引擎、比較不變量、重播與效能；不能把此「物理見證」誤稱為已替換原有物理引擎。

## 尚未涵蓋

- Rapier 目前只做 2D overlap witness，不做 2.5D 不同高度層、自由攀爬或精確多蟻合作搬運。
- Native 現有 P1-A、P1-B、P2-B、P2-C 仍未修復，正式整合仍被阻擋。
- 沒有把螞蟻接觸當成 C3a/C4a 交哺，也沒有連上正式每日循環。
- 效能結果是一次執行的工程測量，不是手機可達成的效能保證。
- 尚待 Playwright 真正驗證 Android 畫面與事件跳轉；CI 先驗證可建置並輸出可稽核數字。

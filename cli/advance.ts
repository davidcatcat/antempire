/**
 * 推進一個遊戲日（正式推進只在 Node 執行）。
 *
 *   npm run advance                         # 預演 (dry run)：跑一天、檢查守恆、印出摘要，不寫任何檔案
 *   npm run advance -- --confirm-advance    # 玩家明確要求推進時才使用：寫回兩份存檔
 *   npm run advance -- --root <dir>         # 對另一個存檔目錄（例如臨時副本）操作
 *   npm run advance -- --summary-out <file> # 另存當日事件摘要（Markdown）
 *
 * 流程：讀取 saves/main.json、saves/world-state.json →（Day15 時一次性遷移）→ 凍結的引擎跑一天 →
 * 檢查人口、幼體、糖與蛋白守恆及日序 → 全部通過才寫回兩份存檔 → 輸出當日事件摘要供寫日誌使用。
 * 不寫日誌檔、不改 Day1～14 歷史；規則指紋不符（引擎或參數被改過）時拒絕執行。
 * 引擎與參數一律來自本工具所在的 checkout；--root 只決定存檔位置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadBundle, readJson, REPO_ROOT } from './lib/load.ts';
import { rulesFingerprint } from './lib/fingerprint.ts';
import { projectDaily, DEFAULT_REFS } from './lib/project-day.ts';
import { checkSaves, checkTransition, type Check } from './lib/conservation.ts';
import { daySummaryMarkdown } from './lib/day-summary.ts';
import { num } from '../engine/index.ts';

export interface AdvanceOptions { root: string; confirm: boolean; now?: string; summaryOut?: string }
export interface AdvanceResult { written: boolean; day: number; date: string; checks: Check[]; summary: string; files: string[]; reason?: string }

const json = (x: unknown) => JSON.stringify(x, null, 2) + '\n';

export function advance(opts: AdvanceOptions): AdvanceResult {
  const root = path.resolve(opts.root);
  const main = readJson('saves/main.json', root), world = readJson('saves/world-state.json', root);
  const bundle = loadBundle(), fp = rulesFingerprint();
  const before = { main: structuredClone(main), world: structuredClone(world) };
  const beforeChecks = checkSaves(main, world).filter((c) => !c.ok && c.level === 'error');
  if (beforeChecks.length) throw Error('Current saves fail conservation checks; refusing to advance: ' + beforeChecks.map((c) => c.name).join('; '));
  const climatology = world.sim_engine_v2 ? null : readJson('data/taichung-climatology-1991-2020.json', root);
  const expectedStart = world.sim_engine_v2 ? { sugar: world.sim_engine_v2.colony.sugar, protein: world.sim_engine_v2.colony.protein } : { sugar: num(bundle.world, 'day15_migration.starting_sugar'), protein: num(bundle.world, 'day15_migration.starting_protein') };
  const run = projectDaily(main, world, climatology, bundle, fp, DEFAULT_REFS, opts.now ?? new Date().toISOString());
  const checks = [...checkSaves(run.main, run.world), ...checkTransition(before, { main: run.main, world: run.world }, run.report, expectedStart)];
  const summary = daySummaryMarkdown(run.report, checks);
  const errors = checks.filter((c) => !c.ok && c.level === 'error');
  const result: AdvanceResult = { written: false, day: run.report.day, date: run.report.summary.date, checks, summary, files: [] };
  if (opts.summaryOut) { fs.mkdirSync(path.dirname(path.resolve(opts.summaryOut)), { recursive: true }); fs.writeFileSync(path.resolve(opts.summaryOut), summary); }
  if (errors.length) return { ...result, reason: 'conservation checks failed; nothing written: ' + errors.map((c) => c.name).join('; ') };
  if (!opts.confirm) return { ...result, reason: 'dry run (add --confirm-advance to write the two saves)' };
  // Write both files via temporary names first, then rename, so a failure never leaves half a JSON file.
  const targets: [string, string][] = [['saves/world-state.json', json(run.world)], ['saves/main.json', json(run.main)]];
  for (const [rel, text] of targets) fs.writeFileSync(path.join(root, rel + '.advance-tmp'), text);
  for (const [rel] of targets) fs.renameSync(path.join(root, rel + '.advance-tmp'), path.join(root, rel));
  return { ...result, written: true, files: targets.map(([rel]) => rel) };
}

if (import.meta.main) {
  const args = process.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const r = advance({ root: value('--root') ?? REPO_ROOT, confirm: args.includes('--confirm-advance'), summaryOut: value('--summary-out') });
    process.stdout.write(r.summary + '\n');
    for (const c of r.checks.filter((x) => !x.ok)) console.error(`${c.level.toUpperCase()}: ${c.name} ${JSON.stringify(c.detail)}`);
    console.error(r.written ? `已寫入 Day ${r.day}（${r.date}）：${r.files.join('、')}。日誌尚未寫，請依上方摘要撰寫 journal/v2-day-${String(r.day).padStart(4, '0')}.md。` : `未寫入任何檔案：${r.reason}`);
    if (r.checks.some((c) => !c.ok && c.level === 'error')) process.exitCode = 1;
  } catch (err) {
    console.error('推進中止，未寫入任何檔案：' + (err as Error).message);
    process.exitCode = 1;
  }
}

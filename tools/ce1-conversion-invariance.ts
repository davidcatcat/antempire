/**
 * CE1 — conversion-invariance (dimensional-analysis) test of the legacy daily engine (docs/garden-supply-demand-audit.md
 * §4.2; RU-1, Owner #219). Experiment worlds only (Day0, non-official); nothing here is a target (CLAUDE.md §7).
 *
 *   node tools/ce1-conversion-invariance.ts           -> print the report (markdown)
 *   node tools/ce1-conversion-invariance.ts --write   -> also write reports/ce1-conversion-invariance/{ce1.md,ce1.json}
 *
 * Method: every parameter whose declared `unit` (species/*.json, world/*.json; RU-1) starts with `game_portion` is
 * multiplied by k. If the model is dimensionally consistent in its game unit, every portion-valued output must be k ×
 * the baseline and every other output (counts, times, IDs, decisions, events, draws) identical — up to the engine's
 * absolute rounding (engine/math.ts round(): 6 decimals of a portion) and its absolute portion thresholds in code.
 *
 * Comparison of one run pair, every day, over the full [result, state] JSON:
 *  - strings are compared with their numbers masked (event texts carry amounts), the numbers then compared as numbers;
 *  - a number is "equal" (identical), "scaled" (|S − k·B| ≤ 1e-3·max(1, |k·B|), nearer to k·B than to B) or
 *    "equal within rounding" (|S − B| ≤ 1e-3·max(1, |B|), nearer to B); anything else, any different key set, array
 *    length, type or masked text is a STRUCTURAL divergence (a different decision / event / draw happened);
 *  - reported: first structural-divergence day (or none in the horizon), the largest |S/k − B| over scaled leaves (in
 *    portions) and the largest |S − B| over unscaled leaves, up to and including that day.
 * The tolerances only classify; the report prints the measured deviations, so nothing is hidden behind them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../cli/lib/load.ts';
import { buildDay0, seasonStart, SEASONS, SUPPORTED_FOUNDINGS, type FoundingId, type Season } from '../cli/lib/day0.ts';
import { simulateWorldDay, type ParamBundle } from '../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- raw parameter trees and engine JSON
export const OUT_DIR = 'reports/ce1-conversion-invariance';
export const PORTION_UNIT = /^game_portion\b/;
export const HORIZON_DAYS = 90;
export const SEEDS = [20270001, 20270002];
export const FACTORS = [2, 0.5, 10];
/** The parameter CE1 found mixing units (it is added to a remembered harvest in portions, engine/activity.ts and
 *  engine/foraging.ts: score = (score_base_offset + prior) × …). Declared as game_portion by RU-1; the finding is
 *  reproduced by the experiment that leaves it unscaled. */
export const CE1_FINDING = { file: 'species:pheidole-megacephala', path: 'site_choice.score_base_offset' };

export interface PortionParam { file: string; path: string; value: number | null; unit: string }
/** every parameter declared in a game-portion unit (the declared unit decides, not a name pattern) */
export function portionParams(bundle: ParamBundle = loadBundle()): PortionParam[] {
  const out: PortionParam[] = [];
  const walk = (file: string, node: Any, at: string) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if ('value' in node) { if (typeof node.unit === 'string' && PORTION_UNIT.test(node.unit)) out.push({ file, path: at, value: node.value, unit: node.unit }); return; }
    for (const [k, v] of Object.entries(node)) walk(file, v, at ? `${at}.${k}` : k);
  };
  walk('world', bundle.world, '');
  for (const [id, sp] of Object.entries(bundle.species)) walk(`species:${id}`, sp, '');
  return out;
}
const nodeAt = (b: ParamBundle, file: string, p: string): Any => { const root: Any = file === 'world' ? b.world : (b.species as Any)[file.split(':')[1]]; return p.split('.').reduce((o: Any, k) => o?.[k], root); };
/** a copy of the bundle with every declared portion parameter × k (minus `exclude`, "file#path") */
export function scaledBundle(k: number, exclude: string[] = [], base: ParamBundle = loadBundle()): ParamBundle {
  const b = structuredClone(base);
  for (const p of portionParams(b)) if (!exclude.includes(`${p.file}#${p.path}`) && p.value !== null) nodeAt(b, p.file, p.path).value = p.value * k;
  return b;
}

const NUM = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
interface Acc { structural: string[]; max_scaled_dev: number; max_unscaled_dev: number; scaled_leaves: number }
function cmpNum(a: number, b: number, at: string, k: number, o: Acc) {
  if (Object.is(a, b)) return;
  const ds = Math.abs(b - k * a), de = Math.abs(b - a);
  if (ds <= de && ds <= 1e-3 * Math.max(1, Math.abs(k * a))) { o.scaled_leaves++; o.max_scaled_dev = Math.max(o.max_scaled_dev, ds / k); return; }
  if (de < ds && de <= 1e-3 * Math.max(1, Math.abs(a))) { o.max_unscaled_dev = Math.max(o.max_unscaled_dev, de); return; }
  o.structural.push(`${at}: ${a} vs ${b}`);
}
function cmp(a: Any, b: Any, at: string, k: number, o: Acc): void {
  if (typeof a === 'number' && typeof b === 'number') return cmpNum(a, b, at, k, o);
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return;
    if (a.replace(NUM, '#') !== b.replace(NUM, '#')) { o.structural.push(`${at}: text`); return; }
    const na = a.match(NUM) ?? [], nb = b.match(NUM) ?? [];
    na.forEach((x, i) => cmpNum(Number(x), Number(nb[i]), `${at}#${i}`, k, o)); return;
  }
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) { o.structural.push(`${at}: type`); return; }
  if (a && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length || ka.some((x, i) => x !== kb[i])) { o.structural.push(`${at}: keys`); return; }
    for (const x of ka) cmp(a[x], b[x], `${at}.${x}`, k, o);
    return;
  }
  if (a !== b) o.structural.push(`${at}: ${String(a)} vs ${String(b)}`);
}
const r3 = (x: number) => Number(x.toPrecision(3));

export interface CaseResult { founding: FoundingId; season: Season; seed: number; first_structural_divergence_day: number | null; first_divergence_sample: string[]; max_scaled_dev_portions: number; max_unscaled_dev: number; scaled_leaves: number }
/** one baseline / scaled pair over `days` (Day0 build + daily outputs) */
export function runCase(founding: FoundingId, season: Season, seed: number, k: number, scaled: ParamBundle, base: ParamBundle, days = HORIZON_DAYS): CaseResult {
  const start = seasonStart(season), i0 = buildDay0(founding, seed, start, base), i1 = buildDay0(founding, seed, start, scaled);
  const o: Acc = { structural: [], max_scaled_dev: 0, max_unscaled_dev: 0, scaled_leaves: 0 };
  cmp([i0.state, i0.warmup.events], [i1.state, i1.warmup.events], 'day0', k, o);
  let first: number | null = o.structural.length ? 0 : null, s0 = i0.state, s1 = i1.state;
  for (let d = 1; d <= days && first === null; d++) {
    const a = simulateWorldDay(s0, base), b = simulateWorldDay(s1, scaled);
    cmp([a.result, a.state], [b.result, b.state], `day${d}`, k, o);
    if (o.structural.length) first = d;
    s0 = a.state; s1 = b.state;
  }
  return { founding, season, seed, first_structural_divergence_day: first, first_divergence_sample: o.structural.slice(0, 3), max_scaled_dev_portions: r3(o.max_scaled_dev), max_unscaled_dev: r3(o.max_unscaled_dev), scaled_leaves: o.scaled_leaves };
}

export interface Experiment { id: string; k: number; exclude: string[]; description: string; cases: CaseResult[]; invariant: number; total: number }
export function experiment(id: string, k: number, exclude: string[], description: string, base = loadBundle()): Experiment {
  const scaled = scaledBundle(k, exclude, base), cases: CaseResult[] = [];
  for (const f of SUPPORTED_FOUNDINGS) for (const s of SEASONS) for (const seed of SEEDS) cases.push(runCase(f, s, seed, k, scaled, base));
  return { id, k, exclude, description, cases, invariant: cases.filter((c) => c.first_structural_divergence_day === null).length, total: cases.length };
}

/** absolute portion-valued constants in engine CODE (not parameters): what CE1 cannot scale */
export const CODE_CONSTANTS = [
  { where: 'engine/math.ts round()', what: 'every stored food amount is rounded to 1e-6 份 (absolute, UNIT_DECIMALS = world model.unit_precision)' },
  { where: 'engine/activity.ts, engine/foraging.ts sourceSum(site) <= 1e-5', what: 'a source with ≤ 1e-5 份 is treated as empty (perception threshold in portions)' },
  { where: 'engine/ecology.ts, engine/foraging.ts needed <= 1e-6', what: 'loop stop in portions' },
  { where: 'engine/ecology.ts TOL_FLOW = 1e-5, engine/day.ts carcass check 1e-4, engine/invariants.ts / queen-feeding.ts / larva-feeding.ts 1e-9', what: 'conservation / domain check tolerances in portions (checks only; they do not change outputs while they pass)' },
];

/** divergences of the declared-set experiments traced to their cause by hand (the others are not individually traced) */
export const TRACED = [
  { experiment: 'declared_k10', case: 'A1-summer-20270001', day: 7, cause: 'perception threshold in code: on day 7 the bloomed-out nectar site F08 holds 0.000002 份 (baseline) vs 0.000019 份 (×10); sourceSum(site) <= 1e-5 makes it "empty" only in the baseline, so W009 finds nothing there in one run and discovers nectar in the other' },
  { experiment: 'declared_k10', case: 'A5-winter-20270001', day: 25, cause: 'rounding: the collect duration is proportional to the rounded load (0.187246 vs 1.872458 份), so the activity ends at minute 15.411765 vs 15.411764; two events at minute 15.882352/3 are then processed in a different order' },
];

export function ce1(): Any {
  const base = loadBundle(), params = portionParams(base);
  const finding = `${CE1_FINDING.file}#${CE1_FINDING.path}`;
  const experiments = [
    ...FACTORS.map((k) => experiment(`declared_k${k}`, k, [], `every parameter declared game_portion (RU-1) × ${k}`, base)),
    experiment('audit_set_k2', 2, [finding], `the audit's original portion set (#202 item 8 registry), i.e. without ${CE1_FINDING.path}, × 2 — reproduces the CE1 finding`, base),
  ];
  return {
    schema: 'antempire.ce1-conversion-invariance.v1',
    status: '診斷，不是目標（docs/garden-supply-demand-audit.md §4.2 CE1；RU-1）；非正式 Day0 實驗世界；不改任何參數值',
    design: { foundings: SUPPORTED_FOUNDINGS, seasons: SEASONS, seeds: SEEDS, horizon_days: HORIZON_DAYS, factors: FACTORS, classification: 'see tools/ce1-conversion-invariance.ts header' },
    scaled_parameters: params.map((p) => ({ file: p.file, path: p.path, value: p.value, unit: p.unit })),
    finding: { parameter: finding, reason: 'added to a remembered harvest in portions: score = (score_base_offset + prior) × penalty × bias × (…) (engine/activity.ts, engine/foraging.ts); it is a portion quantity that was not declared as one' },
    code_constants_not_scalable: CODE_CONSTANTS,
    traced_divergences: TRACED,
    experiments,
  };
}

export function renderMarkdown(a: Any): string {
  const L: string[] = ['# CE1 換算不變性（自動產生）', '', '> 由 `node tools/ce1-conversion-invariance.ts --write` 產生。**診斷，不是目標**；非正式 Day0 實驗世界；不改任何參數值（CLAUDE.md §7）。方法見工具檔頭與 `docs/ru1-param-units.md`。', ''];
  L.push(`設計：${a.design.foundings.join('、')} × ${a.design.seasons.join('、')} × 種子 ${a.design.seeds.join('、')}，每組 ${a.design.horizon_days} 日；倍率 k ∈ {${a.design.factors.join(', ')}}。被乘上 k 的參數（宣告單位為 game_portion）共 ${a.scaled_parameters.length} 個。`, '');
  L.push('| 實驗 | k | 說明 | 無結構分歧（90 日） | 分歧日（中位／最早） | 縮放量最大偏差 |S/k − B|（份） | 非縮放量最大偏差 |S − B| |', '|---|---:|---|---:|---|---:|---:|');
  for (const e of a.experiments) {
    const days = e.cases.map((c: Any) => c.first_structural_divergence_day).filter((d: Any) => d !== null).sort((x: number, y: number) => x - y);
    const med = days.length ? days[Math.floor((days.length - 1) / 2)] : '—';
    L.push(`| ${e.id} | ${e.k} | ${e.description} | ${e.invariant}/${e.total} | ${days.length ? `${med}／${days[0]}` : '—'} | ${Math.max(...e.cases.map((c: Any) => c.max_scaled_dev_portions)).toExponential(2)} | ${Math.max(...e.cases.map((c: Any) => c.max_unscaled_dev)).toExponential(2)} |`);
  }
  L.push('', `**發現**：\`${a.finding.parameter}\`——${a.finding.reason}。`, '', '## 不能用參數縮放的程式常數（以份為單位的絕對值）', '');
  for (const c of a.code_constants_not_scalable) L.push(`- ${c.where}：${c.what}`);
  L.push('', '## 已追查原因的分歧（其餘未逐一追查）', '');
  for (const t of a.traced_divergences) L.push(`- ${t.experiment} ${t.case} 第 ${t.day} 日：${t.cause}`);
  L.push('', '## 各組結果', '', '| 實驗 | 情境 | 種子 | 第一個結構分歧日 | 分歧樣本 | 縮放量最大偏差 | 非縮放量最大偏差 |', '|---|---|---:|---:|---|---:|---:|');
  for (const e of a.experiments) for (const c of e.cases) L.push(`| ${e.id} | ${c.founding}-${c.season} | ${c.seed} | ${c.first_structural_divergence_day ?? '—'} | ${c.first_divergence_sample.map((s: string) => '`' + s.slice(0, 90) + '`').join('<br>') || '—'} | ${c.max_scaled_dev_portions} | ${c.max_unscaled_dev} |`);
  L.push('', '## 被縮放的參數', '', '| 檔案 | 參數 | 值 | 宣告單位 |', '|---|---|---:|---|');
  for (const p of a.scaled_parameters) L.push(`| ${p.file} | \`${p.path}\` | ${p.value} | ${p.unit} |`);
  return L.join('\n') + '\n';
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(REPO_ROOT, 'tools/ce1-conversion-invariance.ts');
if (isMain) {
  const a = ce1(), md = renderMarkdown(a);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.join(REPO_ROOT, OUT_DIR), { recursive: true });
    fs.writeFileSync(path.join(REPO_ROOT, OUT_DIR, 'ce1.md'), md);
    fs.writeFileSync(path.join(REPO_ROOT, OUT_DIR, 'ce1.json'), JSON.stringify(a, null, 2) + '\n');
  }
  process.stdout.write(md);
}

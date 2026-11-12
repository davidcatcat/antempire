/**
 * P0-A2 Q2 (Owner #188, ruled in #193 on 2026-11-12) — SENSITIVITY ANALYSIS of the candidate "a returning forager keeps
 * what it needs" (decision.ts ownReserve; default OFF). ISOLATED experiment: non-official Day0 experiment world only;
 * changes no parameter, writes no save / journal, is not a blocking test. Node tool (reads params.json, writes the
 * report); the prototype core it runs stays platform-free.
 *
 * Grid: retention formulation {off = reference ft-flat, q2-h1, q2-h6, q2-h24, q2-int1, q2-int2}
 *     × temperature base {ft-flat (reference), ft-r190 (sensitivity: R190 Pheidole pallidula anchors, other species)}
 *     × season {taichung-march-ref, taichung-may-ref} (synthetic weather) × seeds 1..N × D days.
 * Reported (statistics only; nothing is fed back): worker metabolic debt (need not met because the crop was empty — the
 * crop-deficit / starvation proxy; starvation death is NOT modelled), workers in debt, larval deficit and feeds,
 * trophallaxis count and amount, exits, empty arrivals, returns where the reserve bound the transfer, exact food
 * conservation. Paired by seed against 'off'. Diagnostics, NOT targets (CLAUDE.md §7): no formulation is chosen here.
 *
 *   node prototypes/p0a2-24h/tools/q2-retention-sensitivity.ts [--seeds 10] [--days 2]
 * Writes prototypes/p0a2-24h/out/q2-retention-sensitivity.json and .md (deterministic: no wall-clock in the output).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../world.ts';
import { applyVariant, buildModel, variantNames } from '../params.ts';
import { sha256Hex } from '../../../engine/sha256.ts';
import { canon } from '../canon.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = JSON.parse(fs.readFileSync(path.join(DIR, 'params.json'), 'utf8'));
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('--seeds', 10), DAYS = arg('--days', 2), DAY = 86_400_000, UP = 1_000_000;
const SEASONS = ['taichung-march-ref', 'taichung-may-ref'];
const FORMS = ['off', ...variantNames(RAW, 'q2_retention_variants')];
const BASES = ['ft-flat', 'ft-r190'];
if (RAW.reference_variant !== 'ft-flat') throw Error('expected the reference ft-flat (Owner #193 Q1 = B)');

/** the raw file for a temperature base: the reference itself, or the ft-r190 overrides folded into the parameters
 *  (each override keeps its own evidence label) so a Q2 variant can be layered on top */
const rawFor = (base: string) => { if (base === RAW.reference_variant) return RAW; const r = applyVariant(RAW, base); r.reference_variant = base; return r; };

interface Row { base: string; season: string; form: string; seed: number; [k: string]: number | string | boolean }
const rows: Row[] = [];
for (const base of BASES) for (const season of SEASONS) for (const form of FORMS) for (let seed = 1; seed <= SEEDS; seed++) {
  const raw = rawFor(base), variant = form === 'off' ? undefined : form;
  const w = World.create(raw, season, seed, { captureLog: true, variant });
  w.advanceTo(DAYS * DAY);
  const v = w.view(), c = w.conservation(), st = w.stats();
  const ws = Object.values(v.workers), ls = Object.values(v.larvae);
  let transferred = 0, fed = 0, exits = 0, empty = 0, bound = 0, returns = 0;
  for (const line of w.lines!) {
    const e = JSON.parse(line);
    if (e.k === 'arrive_nest') { returns++; for (const x of e.p.touched) transferred += x.amount; if (typeof e.p.reserve === 'number' && e.p.reserve > 0 && e.p.crop_left === e.p.reserve && e.p.touched.some((x: any) => x.amount > 0)) bound++; }
    if (Array.isArray(e.p.larvae)) for (const x of e.p.larvae) fed += x.fed;
    if (e.k === 'at_entrance' && e.p.choice === 'exit') exits++;
    if (e.p.take === 0) empty++;
  }
  const debts = ws.map((x) => x.debt);
  rows.push({
    base, season, form, seed, conserved: c.ok,
    worker_debt_total: debts.reduce((a, b) => a + b, 0) / UP, workers_in_debt: debts.filter((d) => d > 0).length,
    worker_debt_max: Math.max(...debts) / UP, workers_empty_crop_end: ws.filter((x) => x.crop === 0).length,
    worker_crop_end_mean: ws.reduce((a, x) => a + x.crop, 0) / ws.length / UP,
    larva_deficit_total: ls.reduce((a, l) => a + l.deficit, 0) / UP, larvae_in_deficit: ls.filter((l) => l.deficit > 0).length,
    larva_fed_total: fed / UP, larva_feeds: st.larva_feeds,
    trophallaxis_events: st.trophallaxis_events, transferred_total: transferred / UP,
    exits, empty_arrivals: empty, returns, reserve_bound_returns: bound, source_stock_end: v.sources['hemiptera-A'].stock / UP,
  });
}
const METRICS = Object.keys(rows[0]).filter((k) => !['base', 'season', 'form', 'seed', 'conserved'].includes(k));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const stats = (xs: number[]) => { const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return { mean: r4(m), sd: r4(sd), min: r4(Math.min(...xs)), max: r4(Math.max(...xs)) }; };
const cells: any[] = [];
for (const base of BASES) for (const season of SEASONS) for (const form of FORMS) {
  const rs = rows.filter((r) => r.base === base && r.season === season && r.form === form);
  const off = rows.filter((r) => r.base === base && r.season === season && r.form === 'off');
  const cell: any = { base, season, form, runs: rs.length, all_conserved: rs.every((r) => r.conserved) };
  for (const k of METRICS) {
    const s = stats(rs.map((r) => r[k] as number));
    if (form === 'off') { cell[k] = s; continue; }
    const d = rs.map((r, i) => (r[k] as number) - (off[i][k] as number));
    cell[k] = { ...s, paired_diff_vs_off: stats(d), seeds_up: d.filter((x) => x > 1e-12).length, seeds_down: d.filter((x) => x < -1e-12).length };
  }
  cells.push(cell);
}
const seasonsIdentical = Object.fromEntries(BASES.map((b) => [b, FORMS.every((f) => METRICS.every((k) => canon(rows.filter((r) => r.base === b && r.form === f && r.season === SEASONS[0]).map((r) => r[k])) === canon(rows.filter((r) => r.base === b && r.form === f && r.season === SEASONS[1]).map((r) => r[k]))))]));
const report = {
  schema: 'antempire.p0a2-q2-retention-sensitivity.v1', official: false,
  status: '非正式：Owner #188 Q2／#193 裁示的隔離敏感度分析。候選機制預設關；保留公式與數值為遊戲假設，機制方向 R147（Camponotus sanctus，非本種）僅候選；不選定任何公式，不是目標（CLAUDE.md §7）。合成天氣（synthetic: true）。',
  command: `node prototypes/p0a2-24h/tools/q2-retention-sensitivity.ts --seeds ${SEEDS} --days ${DAYS}`,
  params_sha: buildModel(RAW, SEASONS[0]).params_sha, seeds: SEEDS, days: DAYS, seasons: SEASONS, bases: BASES, formulations: FORMS,
  formulation_values: Object.fromEntries(FORMS.map((f) => [f, f === 'off' ? null : RAW.q2_retention_variants[f].overrides.forager_retention.value])),
  units: 'food in game portions (1 portion = 1e6 µP); worker debt = own metabolic need not met because the own crop was empty (diagnostic, not food; starvation death not modelled)',
  all_runs_conserved: rows.every((r) => r.conserved), runs: rows.length,
  seasons_identical: seasonsIdentical,
  cells, rows_sha256: sha256Hex(canon(rows)),
};
const OUT = path.join(DIR, 'out'); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'q2-retention-sensitivity.json'), JSON.stringify(report, null, 1) + '\n');

// markdown summary (Traditional Chinese)
const f2 = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3));
const pm = (c: any, k: string) => `${f2(c[k].mean)} ± ${f2(c[k].sd)}`;
const dd = (c: any, k: string) => (c.form === 'off' ? '—' : `${c[k].paired_diff_vs_off.mean >= 0 ? '+' : ''}${f2(c[k].paired_diff_vs_off.mean)}（↑${c[k].seeds_up}／↓${c[k].seeds_down}）`);
const md: string[] = [
  '# Q2 敏感度分析：「覓食者保留自身所需」候選機制（非正式）',
  '',
  `> 由 \`${report.command}\` 產生（決定性；params sha256 \`${report.params_sha.slice(0, 12)}…\`；逐列結果 sha256 \`${report.rows_sha256.slice(0, 12)}…\`）。`,
  '> **地位**：Owner #188 Q2、#193 裁示的隔離實驗。候選機制**預設關**，正式 `transfer_max` 不變；保留公式與數值都是**遊戲假設**，機制方向只來自 R147（*Camponotus sanctus*，**非本種**，僅候選；不採用「交出一半」比例）。以下是**診斷**，不是目標，也沒有選定任何公式（CLAUDE.md §7）。天氣為合成（`synthetic: true`）。工蟻 `debt`＝自己嗉囊空時未滿足的代謝需求（飢餓的代理量；**飢餓死亡尚未模擬**）。',
  '',
  `種子 1–${SEEDS}，每次 ${DAYS} 天；${rows.length} 次執行；食物整數守恆：${report.all_runs_conserved ? '全部通過' : '**有失敗**'}。數值為平均 ± 標準差（遊戲份）；「差」為與同種子 off 的成對差平均（↑／↓＝變大／變小的種子數）。`,
  '',
];
for (const base of BASES) for (const season of SEASONS) {
  md.push(`## ${base === 'ft-flat' ? '參考 ft-flat（暫定、未校準）' : '敏感度 ft-r190（R190 *Pheidole pallidula*，非本種錨點）'}／${season}`, '');
  md.push('| 保留公式 | 工蟻 debt 總量 | 差 | 有 debt 的工蟻 | 差 | 幼蟲缺額總量 | 差 | 餵幼蟲量 | 差 | 交哺量 | 差 | 交哺次數 | 出巢 | 保留量限制交哺的回巢 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cells.filter((x) => x.base === base && x.season === season)) md.push(`| ${c.form} | ${pm(c, 'worker_debt_total')} | ${dd(c, 'worker_debt_total')} | ${pm(c, 'workers_in_debt')} | ${dd(c, 'workers_in_debt')} | ${pm(c, 'larva_deficit_total')} | ${dd(c, 'larva_deficit_total')} | ${pm(c, 'larva_fed_total')} | ${dd(c, 'larva_fed_total')} | ${pm(c, 'transferred_total')} | ${dd(c, 'transferred_total')} | ${pm(c, 'trophallaxis_events')} | ${pm(c, 'exits')} | ${pm(c, 'reserve_bound_returns')} |`);
  md.push('');
}
md.push('## 讀法與限制', '',
  `- 兩個季節在 ft-flat 底下${seasonsIdentical['ft-flat'] ? '**完全相同**：參考情境中沒有任何機制依溫度（3、5 月都低於 CTmax 42°C），所以合成季節不影響工蟻行為' : '不同'}；ft-r190 底下${seasonsIdentical['ft-r190'] ? '相同' : '不同'}（f_T 依溫度）。`,
  '- 這是 30 隻工蟻、8 隻幼蟲、單一情境蜜露源的隔離原型；代謝為常數、沒有脂肪體、沒有飢餓死亡、沒有巢內工蟻間交哺。結果只說明候選公式在這個模型中的方向，不能外推為本種行為。',
  '- 沒有任何公式被選定為參考；是否採用、採用哪一種，由 Owner 決定。', '');
fs.writeFileSync(path.join(OUT, 'q2-retention-sensitivity.md'), md.join('\n'));
console.log(JSON.stringify({ tool: 'q2-retention-sensitivity', runs: rows.length, all_conserved: report.all_runs_conserved }));

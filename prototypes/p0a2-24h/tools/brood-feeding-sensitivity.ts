/**
 * P0-A2 — Owner #188 supplementary ruling (2026-11-12): SENSITIVITY ANALYSIS of the three food processes kept apart —
 * (1) worker own metabolism / own need, (2) adult–adult trophallaxis (forager reserve, Q2), (3) adult→brood feeding
 * (carer reserve, graded begging trigger, carer's own minimum crop fill). ISOLATED experiment: non-official Day0
 * experiment world only; changes no reference parameter and no species parameter, writes no save / journal, is not a
 * blocking test. Node tool (reads params.json, writes the report to out/); the prototype core it runs stays
 * platform-free.
 *
 * Design: one factor at a time around the reference ft-flat, plus a few combinations of (2)×(3) and (1)×(3):
 *   (1) m-half, m-double (own metabolic rate ×0.5 / ×2) — process (1) sensitivity
 *   (2) q2-h6, q2-int2 (forager keeps its own need; Q2 candidates)
 *   (3) b-res-h6, b-res-h24, b-res-int2, b-graded, b-minfill-25
 *   combos q2-h6 + {b-res-h6, b-graded, b-minfill-25}; m-double + b-res-h6
 *   × larval load {8 (reference), 24 (load-24)} × season {taichung-march-ref, taichung-may-ref} × seeds 1..N × D days.
 * Every layer is a labelled variant of params.json (brood_feeding_variants / q2_retention_variants); layering applies
 * their labelled overrides to the parameter block in order (each keeps its own evidence label).
 * Reported (statistics only; nothing is fed back): worker unmet own need (debt to t_now), workers with unmet need,
 * time with an empty crop and the longest continuous empty spell; larval food received (GROWTH PROXY — development is
 * NOT modelled), larval unmet need, empty time and longest spell; counts of individuals whose longest empty spell
 * reaches 6 / 12 / 24 h (a DIAGNOSTIC threshold, NOT a death: starvation death is NOT modelled); feeds,
 * trophallaxis, exits; exact food conservation and per-individual balance from the event log. Paired by seed against
 * the reference at the same load and season. Diagnostics, NOT targets (CLAUDE.md §7): no formulation is chosen here.
 *
 *   node prototypes/p0a2-24h/tools/brood-feeding-sensitivity.ts [--seeds 10] [--days 2]
 * Writes prototypes/p0a2-24h/out/brood-feeding-sensitivity.json and .md (deterministic: no wall-clock in the output).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../world.ts';
import { applyVariant, buildModel } from '../params.ts';
import { sha256Hex } from '../../../engine/sha256.ts';
import { canon } from '../canon.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = JSON.parse(fs.readFileSync(path.join(DIR, 'params.json'), 'utf8'));
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('--seeds', 10), DAYS = arg('--days', 2), DAY = 86_400_000, H = 3_600_000, UP = 1_000_000;
const SEASONS = ['taichung-march-ref', 'taichung-may-ref'];
if (RAW.reference_variant !== 'ft-flat') throw Error('expected the reference ft-flat (Owner #193 Q1 = B)');
const CONFIGS: Record<string, string[]> = {
  ref: [],
  'm-half': ['m-half'], 'm-double': ['m-double'],
  'q2-h6': ['q2-h6'], 'q2-int2': ['q2-int2'],
  'b-res-h6': ['b-res-h6'], 'b-res-h24': ['b-res-h24'], 'b-res-int2': ['b-res-int2'], 'b-graded': ['b-graded'], 'b-minfill-25': ['b-minfill-25'],
  'q2-h6+b-res-h6': ['q2-h6', 'b-res-h6'], 'q2-h6+b-graded': ['q2-h6', 'b-graded'], 'q2-h6+b-minfill-25': ['q2-h6', 'b-minfill-25'],
  'm-double+b-res-h6': ['m-double', 'b-res-h6'],
};
const LOADS: Record<string, string[]> = { 'larvae-8': [], 'larvae-24': ['load-24'] };
const PROCESS: Record<string, string> = { ref: '參考', 'm-half': '(1)', 'm-double': '(1)', 'q2-h6': '(2)', 'q2-int2': '(2)', 'b-res-h6': '(3)', 'b-res-h24': '(3)', 'b-res-int2': '(3)', 'b-graded': '(3)', 'b-minfill-25': '(3)', 'q2-h6+b-res-h6': '(2)+(3)', 'q2-h6+b-graded': '(2)+(3)', 'q2-h6+b-minfill-25': '(2)+(3)', 'm-double+b-res-h6': '(1)+(3)' };

/** the raw file with the labelled overrides of each layer folded into the parameters (in order) */
const rawFor = (layers: string[]) => { let r = RAW; for (const v of layers) { r = applyVariant(r, v); r.reference_variant = RAW.reference_variant; } return r; };

/** per-individual balance from the event log (the same rule as tests/p0a2-24h-proto.test.ts §7c) */
function balanced(raw: unknown, season: string, seed: number, w: World, evs: any[]): boolean {
  const v = w.view(), init = World.create(raw, season, seed).view(), flow: Record<string, number> = {};
  const add = (id: string, x: number) => { flow[id] = (flow[id] ?? 0) + x; };
  for (const e of evs) {
    if ((e.k === 'arrive_source' || e.k === 'search_end') && typeof e.p.take === 'number') add(e.a, e.p.take);
    if (e.k === 'arrive_nest') for (const x of e.p.touched) { add(e.a, -x.amount); add(x.worker, x.amount); }
    if (Array.isArray(e.p.larvae)) for (const x of e.p.larvae) { add(e.a, -x.fed); add(x.larva, x.fed); }
  }
  return Object.entries(v.workers).every(([id, x]) => init.workers[id].crop + (flow[id] ?? 0) - x.consumed === x.crop)
    && Object.entries(v.larvae).every(([id, x]) => init.larvae[id].gut + (flow[id] ?? 0) === x.gut + x.consumed && (flow[id] ?? 0) === x.received);
}

interface Row { config: string; load: string; season: string; seed: number; [k: string]: number | string | boolean }
const rows: Row[] = [];
for (const [load, lLayers] of Object.entries(LOADS)) for (const season of SEASONS) for (const [config, layers] of Object.entries(CONFIGS)) for (let seed = 1; seed <= SEEDS; seed++) {
  const raw = rawFor([...lLayers, ...layers]);
  const w = World.create(raw, season, seed, { captureLog: true });
  w.advanceTo(DAYS * DAY);
  const c = w.conservation(), st = w.stats(), hu = w.hunger();
  let transferred = 0, exits = 0, broodBouts = 0;
  const evs = w.lines!.map((l) => JSON.parse(l));
  for (const e of evs) {
    if (e.k === 'arrive_nest') for (const x of e.p.touched) transferred += x.amount;
    if (e.k === 'at_entrance' && e.p.choice === 'exit') exits++;
    if (e.p.choice === 'brood') broodBouts++;
  }
  const W = hu.workers, L = hu.larvae, sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const spell = (xs: typeof W, h: number) => xs.filter((x) => x.max_empty_ms >= h * H).length;
  rows.push({
    config, load, season, seed, conserved: c.ok, balanced: balanced(raw, season, seed, w, evs),
    worker_unmet_total: sum(W.map((x) => x.unmet)) / UP, workers_unmet: W.filter((x) => x.unmet > 0).length,
    worker_empty_h_total: sum(W.map((x) => x.empty_ms)) / H, worker_max_spell_h: Math.max(...W.map((x) => x.max_empty_ms)) / H,
    workers_spell_6h: spell(W, 6), workers_spell_12h: spell(W, 12), workers_spell_24h: spell(W, 24), workers_empty_end: W.filter((x) => x.empty_now).length,
    larva_received_total: sum(L.map((x) => x.received ?? 0)) / UP, larva_received_min: Math.min(...L.map((x) => x.received ?? 0)) / UP,
    larva_unmet_total: sum(L.map((x) => x.unmet)) / UP, larvae_unmet: L.filter((x) => x.unmet > 0).length,
    larva_empty_h_total: sum(L.map((x) => x.empty_ms)) / H, larva_max_spell_h: Math.max(...L.map((x) => x.max_empty_ms)) / H,
    larvae_spell_6h: spell(L, 6), larvae_spell_12h: spell(L, 12), larvae_spell_24h: spell(L, 24),
    larva_feeds: st.larva_feeds, brood_bouts: broodBouts, trophallaxis_events: st.trophallaxis_events, transferred_total: transferred / UP, exits,
  });
}
const METRICS = Object.keys(rows[0]).filter((k) => !['config', 'load', 'season', 'seed', 'conserved', 'balanced'].includes(k));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const stats = (xs: number[]) => { const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return { mean: r4(m), sd: r4(sd), min: r4(Math.min(...xs)), max: r4(Math.max(...xs)) }; };
const cells: any[] = [];
for (const load of Object.keys(LOADS)) for (const season of SEASONS) for (const config of Object.keys(CONFIGS)) {
  const rs = rows.filter((r) => r.load === load && r.season === season && r.config === config);
  const base = rows.filter((r) => r.load === load && r.season === season && r.config === 'ref');
  const cell: any = { config, process: PROCESS[config], layers: CONFIGS[config], load, season, runs: rs.length, all_conserved: rs.every((r) => r.conserved), all_balanced: rs.every((r) => r.balanced) };
  for (const k of METRICS) {
    const s = stats(rs.map((r) => r[k] as number));
    if (config === 'ref') { cell[k] = s; continue; }
    const d = rs.map((r, i) => (r[k] as number) - (base[i][k] as number));
    cell[k] = { ...s, paired_diff_vs_ref: stats(d), seeds_up: d.filter((x) => x > 1e-12).length, seeds_down: d.filter((x) => x < -1e-12).length };
  }
  cells.push(cell);
}
const seasonsIdentical = Object.fromEntries(Object.keys(LOADS).map((l) => [l, Object.keys(CONFIGS).every((cf) => canon(rows.filter((r) => r.load === l && r.config === cf && r.season === SEASONS[0]).map((r) => METRICS.map((k) => r[k]))) === canon(rows.filter((r) => r.load === l && r.config === cf && r.season === SEASONS[1]).map((r) => METRICS.map((k) => r[k]))))]));
const report = {
  schema: 'antempire.p0a2-brood-feeding-sensitivity.v1', official: false,
  status: '非正式：Owner #188 補充裁示（2026-11-12）的隔離敏感度分析。三種過程（自身代謝、成蟻間交哺、成蟻對幼體餵食）分開；全部候選預設關；公式與數值為遊戲假設，他種只提供機制方向（R147 Camponotus sanctus、R210 Solenopsis invicta，非本種）；不選定任何公式，不是目標（CLAUDE.md §7）。合成天氣（synthetic: true）。發育與飢餓死亡尚未模擬：幼蟲 received 是生長代理量；連續空腹 ≥ 6／12／24 h 的計數是診斷門檻，不是死亡。',
  command: `node prototypes/p0a2-24h/tools/brood-feeding-sensitivity.ts --seeds ${SEEDS} --days ${DAYS}`,
  params_sha: buildModel(RAW, SEASONS[0]).params_sha, seeds: SEEDS, days: DAYS, seasons: SEASONS, loads: LOADS, configs: CONFIGS,
  units: 'food in game portions (1 portion = 1e6 µP); times in hours; unmet = own metabolic need not met because the own pool was empty (diagnostic, not food)',
  all_runs_conserved: rows.every((r) => r.conserved), all_runs_balanced: rows.every((r) => r.balanced), runs: rows.length,
  seasons_identical: seasonsIdentical, cells, rows_sha256: sha256Hex(canon(rows)),
};
const OUT = path.join(DIR, 'out'); fs.mkdirSync(OUT, { recursive: true });
// one cell per line keeps the file small and diffable
const { cells: _c, ...head } = report;
fs.writeFileSync(path.join(OUT, 'brood-feeding-sensitivity.json'), JSON.stringify(head, null, 1).replace(/\n}$/, `,\n "cells": [\n${cells.map((c) => '  ' + JSON.stringify(c)).join(',\n')}\n ]\n}`) + '\n');

// markdown summary (Traditional Chinese)
const f2 = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(3));
const pm = (c: any, k: string) => `${f2(c[k].mean)}`;
const dd = (c: any, k: string) => (c.config === 'ref' ? '—' : `${c[k].paired_diff_vs_ref.mean >= 0 ? '+' : ''}${f2(c[k].paired_diff_vs_ref.mean)}（↑${c[k].seeds_up}／↓${c[k].seeds_down}）`);
const md: string[] = [
  '# 三種食物過程分開後的敏感度分析（Owner #188 補充裁示；非正式）',
  '',
  `> 由 \`${report.command}\` 產生（決定性；params sha256 \`${report.params_sha.slice(0, 12)}…\`；逐列結果 sha256 \`${report.rows_sha256.slice(0, 12)}…\`）。`,
  '> **地位**：隔離實驗。(1) 工蟻自身代謝／自身需求、(2) 成蟻間交哺、(3) 成蟻對幼體餵食各有自己的參數與決策函式，不共用上限或保留比；所有候選**預設關**，參考 `ft-flat` 的事件紀錄不變。公式與數值都是**遊戲假設**；他種只提供機制方向（R147 *Camponotus sanctus*、R210 *Solenopsis invicta*，**非本種**）。以下是**診斷**，不是目標，沒有選定任何公式（CLAUDE.md §7）。天氣為合成（`synthetic: true`）。',
  '> **發育與飢餓死亡尚未模擬**：幼蟲「得到的食物」只是生長代理量；「連續空腹 ≥ X 小時」的個體數是診斷門檻，**不是死亡數**。工蟻「未滿足需求」＝自己嗉囊空時未滿足的代謝需求（記到執行結束時刻）。',
  '',
  `種子 1–${SEEDS}，每次 ${DAYS} 天；${rows.length} 次執行；食物整數守恆：${report.all_runs_conserved ? '全部通過' : '**有失敗**'}；逐個體收支（由事件紀錄）：${report.all_runs_balanced ? '全部通過' : '**有失敗**'}。表中為平均（遊戲份或小時）；「差」為與同種子、同幼蟲數、同季節參考的成對差平均（↑／↓＝變大／變小的種子數）。`,
  '',
];
for (const load of Object.keys(LOADS)) for (const season of SEASONS) {
  if (season === SEASONS[1] && seasonsIdentical[load]) { md.push(`## ${load}／${season}`, '', `與 ${SEASONS[0]} **逐列完全相同**（參考 ft-flat 沒有任何機制依溫度，兩季都低於 CTmax 42°C）；表略。`, ''); continue; }
  md.push(`## ${load}／${season}`, '');
  md.push('| 候選 | 過程 | 工蟻未滿足需求 | 差 | 有缺額工蟻 | 工蟻最長空腹 h | 工蟻空腹 ≥12 h | 幼蟲得到食物 | 差 | 幼蟲最少得到 | 幼蟲未滿足需求 | 差 | 幼蟲最長空腹 h | 幼蟲空腹 ≥6 h | 幼蟲空腹 ≥12 h | 餵幼蟲次數 | 交哺量 | 出巢 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cells.filter((x) => x.load === load && x.season === season)) md.push(`| ${c.config} | ${c.process} | ${pm(c, 'worker_unmet_total')} | ${dd(c, 'worker_unmet_total')} | ${pm(c, 'workers_unmet')} | ${pm(c, 'worker_max_spell_h')} | ${pm(c, 'workers_spell_12h')} | ${pm(c, 'larva_received_total')} | ${dd(c, 'larva_received_total')} | ${pm(c, 'larva_received_min')} | ${pm(c, 'larva_unmet_total')} | ${dd(c, 'larva_unmet_total')} | ${pm(c, 'larva_max_spell_h')} | ${pm(c, 'larvae_spell_6h')} | ${pm(c, 'larvae_spell_12h')} | ${pm(c, 'larva_feeds')} | ${pm(c, 'transferred_total')} | ${pm(c, 'exits')} |`);
  md.push('');
}
md.push('## 讀法與限制', '',
  '- 30 隻工蟻、8 或 24 隻幼蟲、單一情境蜜露源、2 天；代謝為常數、沒有脂肪體、沒有蛋白質、沒有發育與死亡、沒有巢內工蟻之間的交哺。結果只說明候選公式在這個模型中的方向，不能外推為本種行為。',
  '- 本種沒有回巢者最低保留量、育幼投入比例或求食訊號門檻的數值；所有候選都是遊戲假設，不得當作本種參考。',
  '- 沒有任何公式被選定；是否採用、採用哪一種，由 Owner 決定。', '');
fs.writeFileSync(path.join(OUT, 'brood-feeding-sensitivity.md'), md.join('\n'));
console.log(JSON.stringify({ tool: 'brood-feeding-sensitivity', runs: rows.length, all_conserved: report.all_runs_conserved, all_balanced: report.all_runs_balanced }));

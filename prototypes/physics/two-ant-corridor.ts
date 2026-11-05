/**
 * Work C (Owner instruction, Issues #68/#69), v2 with the literature-based LOCAL encounter rules: two Pheidole
 * megacephala minor workers meet head-on in the synthetic single-file corridor (PH-1 geometry, MV-1/MV-2 kinematics,
 * PH-2 collision). Experimental world only (synthetic, not official; no save, no journal, no game day).
 * Run directly to print the report:  node prototypes/physics/two-ant-corridor.ts
 *
 * Scenarios:
 *  - ENTRY: W1 is already wholly inside the walls when W2 arrives at the far entry → entry-yield rule (Lasius niger,
 *    R380; non-species candidate). Contact pause 0.18 s (contact duration measured in L. humile, R108).
 *  - INSIDE: both start together and meet wholly inside → no study describes this; per-contact turn-back probability and
 *    contact time loss are swept over their candidate values (game assumptions).
 *  - LADEN: ENTRY geometry with W2 carrying a small item and the laden-priority rule (Atta colombica, R381).
 *  - CONTROL: the same corridor without the walls.
 * Every number that is not computed here comes from the candidate files in scenarios/physics/ with its evidence label.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhysicsGeometry } from '../../engine/physics/geometry.ts';
import { summarize, legSpeed, type SpeedModel } from '../../engine/physics/kinematics.ts';
import { simulate, checkExclusion, type EncounterRules, type PhysObject, type SimAgentSpec, type SimConfig, type SimResult } from '../../engine/physics/collision.ts';
import { sha256, utf8 } from '../../engine/sha256.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
export const SOURCES = {
  geometry: 'scenarios/physics/narrow-corridor.geometry.json',
  body: 'scenarios/physics/pheidole-megacephala.body-candidates.json',
  motion: 'scenarios/physics/pheidole-megacephala.motion-candidates.json',
  interaction: 'scenarios/physics/pheidole-megacephala.interaction-candidates.json',
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const hashOf = (x: unknown) => hex(sha256(utf8(JSON.stringify(x)))).slice(0, 16);
/** Engine numerical margins, restated (collision.ts EDGE_EPS and CONTACT_EXIT_EPS); not model parameters. */
const EDGE_EPS = 1e-6, CONTACT_EXIT_EPS = 1e-6;

export function setup() {
  const geom = read(SOURCES.geometry) as PhysicsGeometry, body = read(SOURCES.body), motion = read(SOURCES.motion), inter = read(SOURCES.interaction);
  const model: SpeedModel = {
    trail_speed_mm_s: { outbound: motion.trail_speed_mm_s.outbound.value, returning: motion.trail_speed_mm_s.returning.value, pooled: motion.trail_speed_mm_s.pooled.value },
    off_trail_factor: motion.off_trail_factor.value, individual_cv: motion.individual_cv.value,
  };
  const E = inter.encounter;
  const enc: EncounterRules = { priority: E.priority.value, entry_yield_probability: E.entry_yield_probability.value, laden_yield_probability: E.laden_yield_probability.value, contact_pause_s: E.contact_pause_s.value, inside_turn_back_probability: E.inside_turn_back_probability.value };
  return {
    geom, model, enc, L: body.castes.minor.body_length_mm.value as number, wHi: body.castes.minor.effective_collision_width_mm.candidate_range[1] as number,
    widths: body.castes.minor.effective_collision_width_mm.candidate_range as [number, number], reachMid: (inter.contact_reach_mm.candidate_range[0] + inter.contact_reach_mm.candidate_range[1]) / 2,
    tauC: E.contact_pause_s.candidate_values as number[], pC: E.inside_turn_back_probability.candidate_values as number[],
  };
}

export type Kind = 'entry' | 'inside';
/** W1 leaves the nest end (s=2 mm) outbound at t=0; W2 returns from s=98 mm. ENTRY: W2 starts so that it reaches the far
 *  entry (s=80.5) when W1 is at s=78, wholly inside. INSIDE: both start at t=0. Speeds: Vázquez 2020 by leg. */
export function agents(kind: Kind, width: number, reach: number, speeds?: [number, number], loadW2 = false): SimAgentSpec[] {
  const { L, model } = setup();
  const v1 = speeds?.[0] ?? legSpeed(model, 'outbound', true)!, v2 = speeds?.[1] ?? legSpeed(model, 'returning', true)!;
  const body = { length_mm: L, width_mm: width, contact_reach_mm: reach };
  const start2 = kind === 'entry' ? 76 / v1 - (98 - 80.5) / v2 : 0;
  return [
    { id: 'W1', passage: 'P-corridor', s_mm: 2, dir: 1, start_t_s: 0, free_speed_mm_s: v1, goal_s_mm: 98, body, load: null },
    { id: 'W2', passage: 'P-corridor', s_mm: 98, dir: -1, start_t_s: start2, free_speed_mm_s: v2, goal_s_mm: 2, body, load: loadW2 ? 'item' : null },
  ];
}

export interface RunSummary {
  label: string; width_mm: number; walls: boolean; seed: number;
  contact_t_s: number | null; contact_certain: boolean | null; obstruction_t_s: number | null;
  yielder: string | null; rule: string | null; contacts: number; hold_s: number; back_out_mm: number | null;
  ants: Record<string, { arrive_s: number | null; alone_s: number; added_s: number | null; path_mm: number; displacement_mm: number; waiting_s: number; mean_moving_speed: number | null; trip_speed: number | null }>;
  exclusion_violations: number; result_hash: string; replay_identical: boolean; order_identical: boolean;
}

const aloneCache = new Map<string, number>();
export function runOne(label: string, kind: Kind, o: { width?: number; walls?: boolean; seed?: number; enc?: Partial<EncounterRules>; speeds?: [number, number]; loadW2?: boolean; light?: boolean } = {}): { summary: RunSummary; res: SimResult; cfg: SimConfig } {
  const S = setup(), width = o.width ?? S.wHi, walls = o.walls ?? true, seed = o.seed ?? 1;
  const g = walls ? S.geom : { ...structuredClone(S.geom), world_id: 'synthetic-narrow-corridor-control', obstacles: [] };
  const ags = agents(kind, width, S.reachMid, o.speeds, o.loadW2);
  const objects: PhysObject[] = o.loadW2 ? [{ id: 'item', width_mm: 0.5, holder: 'W2' }] : [];
  const cfg: SimConfig = { geometry: g, agents: ags, objects, horizon_s: 60, seed, encounter: { ...S.enc, ...o.enc } };
  // light: sweeps over many seeds skip the replay/order/exclusion checks (done on the full runs) and reuse 'alone' times
  const res = simulate(cfg), replay = o.light ? res : simulate(cfg), reordered = o.light ? res : simulate({ ...cfg, agents: [...ags].reverse() });
  const alone = (a: SimAgentSpec) => {
    const key = JSON.stringify([a, walls, width]);
    let v = aloneCache.get(key);
    if (v === undefined) { v = simulate({ ...cfg, agents: [a], objects: a.load ? objects : [] }).events.find((e) => e.kind === 'arrive')!.t_s; aloneCache.set(key, v); }
    return v;
  };
  const c = res.events.find((e) => e.kind === 'contact_start') ?? null, ob = res.events.find((e) => e.kind === 'obstruction') ?? null, y = res.events.find((e) => e.kind === 'yield_start') ?? null;
  const ants: RunSummary['ants'] = {};
  for (const a of ags) {
    const arr = res.events.find((e) => e.kind === 'arrive' && e.agent === a.id)?.t_s ?? null, al = alone(a);
    const ivs = res.intervals[a.id].filter((r) => r.cause !== 'not_started' && (arr === null || r.t_end_s <= arr + 1e-9)), sm = summarize(ivs, a.free_speed_mm_s);
    ants[a.id] = { arrive_s: arr, alone_s: al, added_s: arr === null ? null : arr - al, path_mm: sm.path_length_mm, displacement_mm: sm.displacement_mm, waiting_s: sm.waiting_time_s + sm.stopped_time_s, mean_moving_speed: sm.mean_moving_speed_mm_s, trip_speed: sm.trip_speed_mm_s };
  }
  const contacts = y ? Number(/decided at contact (\d+)/.exec(y.detail ?? '')?.[1] ?? 1) : 0;
  const hold = y ? Number(/both stand ([0-9.]+) s/.exec(y.detail ?? '')?.[1] ?? 0) : 0;
  const summary: RunSummary = {
    label, width_mm: width, walls, seed, contact_t_s: c?.t_s ?? null, contact_certain: c?.certain ?? null, obstruction_t_s: ob?.t_s ?? null,
    yielder: y?.agent ?? null, rule: y ? (/^[^:;(]+/.exec(y.detail ?? '')?.[0].trim() ?? null) : null, contacts, hold_s: hold,
    back_out_mm: y ? Number(/stepping back ([0-9.]+) mm/.exec(y.detail ?? '')?.[1] ?? NaN) : null,
    ants, exclusion_violations: o.light ? -1 : checkExclusion(cfg, res, 0.005).length, result_hash: hashOf(res),
    replay_identical: JSON.stringify(replay) === JSON.stringify(res), order_identical: JSON.stringify(reordered) === JSON.stringify(res),
  };
  return { summary, res, cfg };
}

/**
 * Closed-form arrival times worked out by hand from the rules, for a GIVEN decision (who gives way, and the total contact
 * time) — the decision itself is a random draw; everything after it is deterministic kinematics:
 * touch at gap = L; both stand `hold`; the yielder walks back at its own speed to just outside the single-file section
 * (section end from the wall-corner geometry, 20/80 ∓ √(w² − 0.25), not engine code); the other walks on, no faster than
 * the yielder if it is pressing on it; the yielder waits until the other's centre is one body length past it.
 */
export function analytic(kind: Kind, width: number, yielder: 'W1' | 'W2', hold: number, speeds?: [number, number]): { W1: number; W2: number } {
  const S = setup(), [a1, a2] = agents(kind, width, S.reachMid, speeds), L = S.L, v1 = a1.free_speed_mm_s, v2 = a2.free_speed_mm_s;
  const k = Math.sqrt(width * width - 0.25), secA = 20 - k, secB = 80 + k;
  const tT = (a2.s_mm + v2 * a2.start_t_s - a1.s_mm + v1 * a1.start_t_s - L) / (v1 + v2), s1T = a1.s_mm + v1 * (tT - a1.start_t_s), s2T = a2.s_mm - v2 * (tT - a2.start_t_s), tH = tT + hold;
  if (yielder === 'W2') {
    const target = secB + EDGE_EPS + L / 2, tR = tH + (target - s2T) / v2;
    // W1 presses on W2 at W2's speed (if faster) until W1's front leaves the single-file part, i.e. W2 is EDGE_EPS short of its target
    const vp = Math.min(v1, v2), tF = v1 > v2 ? tH + (target - EDGE_EPS - s2T) / v2 : tH, s1F = s1T + vp * (tF - tH);
    const W1 = tF + (98 - s1F) / v1;
    const need = target + L + CONTACT_EXIT_EPS, tRes = Math.max(tR, tF + (need - s1F) / v1);
    return { W1, W2: tRes + (target - 2) / v2 };
  }
  const target = secA - EDGE_EPS - L / 2, tR = tH + (s1T - target) / v1;
  const vp = Math.min(v1, v2), tF = v2 > v1 ? tH + (s1T - (target + EDGE_EPS)) / v1 : tH, s2F = s2T - vp * (tF - tH);
  const W2 = tF + (s2F - 2) / v2;
  const need = target - L - CONTACT_EXIT_EPS, tRes = Math.max(tR, tF + (s2F - need) / v2);
  return { W1: tRes + (98 - target) / v1, W2 };
}

/** Independent fixed-time-step implementation of the same response for a given decision (different algorithm). */
export function fixedStep(kind: Kind, width: number, yielder: 'W1' | 'W2', hold: number, dt: number, speeds?: [number, number]): { W1: number; W2: number } {
  const S = setup(), [a1, a2] = agents(kind, width, S.reachMid, speeds), L = S.L, v1 = a1.free_speed_mm_s, v2 = a2.free_speed_mm_s;
  const k = Math.sqrt(width * width - 0.25), secA = 20 - k, secB = 80 + k, inSec = (x: number) => x >= secA && x <= secB;
  let s1 = a1.s_mm, s2 = a2.s_mm, t = 0, m1 = 'free', m2 = 'free', touched = false, holdEnd = Infinity, arr1 = NaN, arr2 = NaN;
  const tgt = yielder === 'W2' ? secB + EDGE_EPS + L / 2 : secA - EDGE_EPS - L / 2;
  while ((isNaN(arr1) || isNaN(arr2)) && t < 60) {
    const held = t < holdEnd && touched;
    let d1 = held || t < a1.start_t_s || m1 === 'wait' || m1 === 'done' ? 0 : m1 === 'back' ? -v1 * dt : v1 * dt;
    let d2 = held || t < a2.start_t_s || m2 === 'wait' || m2 === 'done' ? 0 : m2 === 'back' ? v2 * dt : -v2 * dt;
    if (m2 === 'back' && m1 === 'free' && s2 - s1 <= L + 1e-9 && inSec(s1 + L / 2)) d1 = Math.min(d1, d2);
    if (m1 === 'back' && m2 === 'free' && s2 - s1 <= L + 1e-9 && inSec(s2 - L / 2)) d2 = Math.max(d2, d1);
    s1 += d1; s2 += d2; t += dt;
    if (!touched && s2 - s1 <= L && inSec(s1 + L / 2)) { touched = true; const over = L - (s2 - s1); s1 -= over * v1 / (v1 + v2); s2 += over * v2 / (v1 + v2); holdEnd = t - over / (v1 + v2) + hold; if (yielder === 'W2') m2 = 'back'; else m1 = 'back'; }
    if (m2 === 'back' && s2 >= tgt) { s2 = tgt; m2 = 'wait'; }
    if (m1 === 'back' && s1 <= tgt) { s1 = tgt; m1 = 'wait'; }
    if (m2 === 'wait' && s1 >= s2 + L) m2 = 'free';
    if (m1 === 'wait' && s2 <= s1 - L) m1 = 'free';
    if (isNaN(arr1) && s1 >= 98) { arr1 = t - (s1 - 98) / v1; s1 = 98; m1 = 'done'; }
    if (isNaN(arr2) && s2 <= 2) { arr2 = t - (2 - s2) / v2; s2 = 2; m2 = 'done'; }
  }
  return { W1: arr1, W2: arr2 };
}

export interface Experiment {
  sources: Record<string, string>;
  entry: RunSummary; control: RunSummary; laden: RunSummary;
  entry_seeds: { seeds: number; W2_gave_way: number; literature: number };
  laden_seeds: { seeds: number; unladen_gave_way: number; literature: number };
  inside: { p: number; tau_s: number; seeds: number; W1_gave_way: number; mean_contacts: number; mean_added_W1_s: number; mean_added_W2_s: number; max_added_s: number; violations: number }[];
  width_sensitivity: RunSummary[];
  analytic: { entry: { W1: number; W2: number }; engine_minus_analytic_s: [number, number]; inside_checked: number; inside_max_abs_diff_s: number };
  convergence: { speeds_mm_s: [number, number]; yielder: string; hold_s: number; rows: { dt_s: number; W1_err_s: number; W2_err_s: number }[] };
}

export function runExperiment(): Experiment {
  const S = setup(), tauLn = S.tauC[0];
  const entry = runOne('ENTRY (L. niger rule, pause 0.18 s)', 'entry', { enc: { contact_pause_s: tauLn } }).summary;
  const control = runOne('CONTROL (no walls)', 'entry', { walls: false, enc: { contact_pause_s: tauLn } }).summary;
  const laden = runOne('LADEN (Atta rule, W2 carries an item)', 'entry', { loadW2: true, enc: { priority: 'laden_priority', contact_pause_s: tauLn } }).summary;
  const N = 400;
  let w2 = 0, unl = 0;
  for (let sd = 1; sd <= N; sd++) {
    if (runOne('e', 'entry', { seed: sd, light: true, enc: { contact_pause_s: tauLn } }).summary.yielder === 'W2') w2++;
    // laden rule with W1 laden instead would mirror this; here the unladen ant is W1, already inside
    if (runOne('l', 'entry', { seed: sd, light: true, loadW2: true, enc: { priority: 'laden_priority', contact_pause_s: tauLn } }).summary.yielder === 'W1') unl++;
  }
  const inside: Experiment['inside'] = [];
  let insideChecked = 0, insideMax = 0;
  for (const p of S.pC) for (const tau of S.tauC) {
    let y1 = 0, nc = 0, d1 = 0, d2 = 0, mx = 0, viol = 0;
    const n = 100;
    for (let sd = 1; sd <= n; sd++) {
      const r = runOne('i', 'inside', { seed: sd, light: sd > 3, enc: { inside_turn_back_probability: p, contact_pause_s: tau } }).summary;
      if (r.yielder === 'W1') y1++;
      nc += r.contacts; d1 += r.ants.W1.added_s!; d2 += r.ants.W2.added_s!; mx = Math.max(mx, r.ants.W1.added_s!, r.ants.W2.added_s!); if (r.exclusion_violations > 0) viol += r.exclusion_violations;
      if (sd <= 5) { const an = analytic('inside', S.wHi, r.yielder as 'W1' | 'W2', r.hold_s); insideMax = Math.max(insideMax, Math.abs(an.W1 - r.ants.W1.arrive_s!), Math.abs(an.W2 - r.ants.W2.arrive_s!)); insideChecked++; }
    }
    inside.push({ p, tau_s: tau, seeds: n, W1_gave_way: y1, mean_contacts: nc / n, mean_added_W1_s: d1 / n, mean_added_W2_s: d2 / n, max_added_s: mx, violations: viol });
  }
  const width_sensitivity = [S.widths[0], (S.widths[0] + S.widths[1]) / 2, S.widths[1]].map((w) => runOne(`width ${w} mm`, 'entry', { width: w, enc: { contact_pause_s: tauLn } }).summary);
  const an = analytic('entry', S.wHi, entry.yielder as 'W1' | 'W2', entry.hold_s);
  // convergence of the independent fixed-step version, with off-grid speeds so event times do not sit on the Δt grid
  const off: [number, number] = [legSpeed(S.model, 'outbound', true)!, 15.37];
  const offRun = runOne('offgrid', 'entry', { speeds: off, enc: { contact_pause_s: tauLn } }).summary;
  const rows = [0.1, 0.01, 0.001, 0.0001, 0.00001].map((dt) => { const f = fixedStep('entry', S.wHi, offRun.yielder as 'W1' | 'W2', offRun.hold_s, dt, off); return { dt_s: dt, W1_err_s: f.W1 - offRun.ants.W1.arrive_s!, W2_err_s: f.W2 - offRun.ants.W2.arrive_s! }; });
  return {
    sources: SOURCES, entry, control, laden,
    entry_seeds: { seeds: N, W2_gave_way: w2, literature: S.enc.entry_yield_probability },
    laden_seeds: { seeds: N, unladen_gave_way: unl, literature: S.enc.laden_yield_probability },
    inside, width_sensitivity,
    analytic: { entry: an, engine_minus_analytic_s: [entry.ants.W1.arrive_s! - an.W1, entry.ants.W2.arrive_s! - an.W2], inside_checked: insideChecked, inside_max_abs_diff_s: insideMax },
    convergence: { speeds_mm_s: off, yielder: offRun.yielder!, hold_s: offRun.hold_s, rows },
  };
}

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));
export function report(e: Experiment): string {
  const row = (r: RunSummary) => `| ${r.label} | ${r.contact_t_s === null ? '無' : `${f(r.contact_t_s)} s（${r.contact_certain ? '確定' : '可能'}）`} | ${r.obstruction_t_s === null ? '無' : f(r.obstruction_t_s)} | ${r.yielder ?? '—'} | ${r.rule ?? '—'} | ${f(r.hold_s, 2)} | ${f(r.back_out_mm, 2)} | ${f(r.ants.W1.arrive_s)}（+${f(r.ants.W1.added_s)}） | ${f(r.ants.W2.arrive_s)}（+${f(r.ants.W2.added_s)}） | ${r.exclusion_violations} | ${r.replay_identical && r.order_identical ? '是' : '否'} |`;
  const head = '| 情境 | 接觸 | 阻擋（s） | 讓路者 | 規則 | 接觸停頓 s | 退後 mm | W1 抵達 s（比單獨多） | W2 抵達 s（比單獨多） | 互斥違反 | 重播／換順序相同 |\n|---|---|---|---|---|---|---|---|---|---|---|';
  const pct = (a: number, n: number) => `${a}/${n} = ${(a / n).toFixed(3)}`;
  return `# 雙工蟻窄道實驗 v2（Work C，局部讓路規則）— 實驗世界，非正式

> 由 \`prototypes/physics/two-ant-corridor.ts\` 產生；\`tests/physics-two-ant.test.ts\` 會重跑並比對本檔末的 JSON。
> - 合成場景，不是臺中西屯花園；不產生存檔、日誌或遊戲日。
> - **大頭家蟻屬沒有任何窄道交通或讓路研究**；以下規則都是非本種研究提出的候選機制（\`${SOURCES.interaction}\` 的 \`encounter\`）。

## 設定
- 通路長 100 mm、寬 20 mm；x=20～80 mm 兩側有牆，牆間可用寬度 1.0 mm。兩隻 0.8 mm 寬的工蟻在 [19.3755, 80.6245] mm 內只能單行。
- W1 從巢端（s=2）出發，速度 18.5 mm/s；W2 回巢，速度 15.5 mm/s（Vázquez 2020，本種）。體長 2.5 mm（Yuan 2026，本種）。
- 碰撞寬度 0.8 mm、觸角可及距離 1.0 mm：遊戲假設的候選值。
- 讓路的方式（R380、R381 都這樣描述）：讓路的那隻退出窄段，在寬處等對方通過，再繼續。以自己的速度退後，轉身時間 0（遊戲假設）。

## 1. 入口讓路（ENTRY）：有文獻依據的情境
W2 到達遠端入口時，W1 已經完全在牆間。依 Lasius niger 的觀察（R380：往橋中央走、即將進入 3 mm 中央段的那隻，在 202/211 次有接觸的相遇中讓路），尚未進入的 W2 讓路；兩隻先停 0.18 s（接觸持續時間，L. humile 實測，R108）。
- 與原文不同之處：原文的讓路者在瓶頸原地等待（R380 模型），這裡單行通道旁沒有空間，讓路者退到最近的寬處再等。
- 「身體尚未完全進入單行段」是幾何代理（單行段由兩隻寬度和決定）。

${head}
${row(e.entry)}
${row(e.control)}
${row(e.laden)}

- **${e.entry_seeds.seeds} 個種子**（輕量模式：只記錄讓路者）：W2（尚未進入的那隻）讓路 ${pct(e.entry_seeds.W2_gave_way, e.entry_seeds.seeds)}；文獻比例 202/211 = ${f(e.entry_seeds.literature)}。模型只是重現了輸入的比例，這**不是**對本種的驗證。
- **帶食優先（LADEN）**：W2 帶著小物件，改用 Atta colombica 的規則（R381：294/300）。已在牆間的空手 W1 讓路 ${pct(e.laden_seeds.unladen_gave_way, e.laden_seeds.seeds)}。兩條規則在這個情境給出**相反**的讓路者：本種的答案取決於哪條規則適用，目前沒有資料可決定（預設用不依負重的 entry_yield）。
- **無牆對照**：只有一次「可能」的接觸，抵達時間與單獨行走相同（本版的接觸不觸發任何行為；C3–C5 尚未接上）。
- **解析解核對**：照規則手算（給定讓路者與停頓時間），W1 ${f(e.analytic.entry.W1, 9)} s、W2 ${f(e.analytic.entry.W2, 9)} s，引擎差 ${e.analytic.engine_minus_analytic_s.map((x) => x.toExponential(1)).join('、')} s。窄段端點用牆角幾何手算（80 + √(w² − 0.25)），不用引擎程式。

## 2. 兩隻都已在窄段內（INSIDE）：沒有任何研究
兩隻同時出發，在牆間迎面相遇。L. niger 與 Atta 的窄口都很短，沒有研究描述這種情況。模型的候選規則：每次接觸，兩隻**各自**以機率 p 決定回頭；剛好一隻回頭時那隻讓路，否則再接觸一次（每次都停 τ）。p 與 τ 都是候選值，以下是敏感度（每格 100 個種子）：

| p（每次接觸回頭的機率） | τ（每次接觸停頓 s） | W1 讓路次數 | 平均接觸次數 | W1 平均多花 s | W2 平均多花 s | 最多多花 s | 互斥違反（前 3 個種子完整檢查） |
|---|---|---|---|---|---|---|---|
${e.inside.map((r) => `| ${r.p} | ${r.tau_s} | ${r.W1_gave_way}/${r.seeds} | ${f(r.mean_contacts, 2)} | ${f(r.mean_added_W1_s)} | ${f(r.mean_added_W2_s)} | ${f(r.max_added_s)} | ${r.violations} |`).join('\n')}

- 誰讓路：規則對兩隻完全對稱，也不使用「誰離出口近」這類螞蟻不知道的資訊（v0 的規則已移除）；每格都用同一組 100 個種子，所以各格的讓路比例相同或幾乎相同，偏離一半屬抽樣誤差（測試以 2,000 個種子檢查接近 0.5）。
- p 越小，要接觸越多次才決定（期望 1/(2p(1−p)) 次），每次都付出 τ。**延遲主要取決於這兩個本種未量測的值。**
- 解析解核對（給定讓路者與停頓）：${e.analytic.inside_checked} 次，最大差 ${e.analytic.inside_max_abs_diff_s.toExponential(1)} s。

## 3. 碰撞寬度敏感度（ENTRY 情境）
${head}
${e.width_sensitivity.map(row).join('\n')}

寬度 0.5 mm 時兩隻以零間隙並排通過（臨界）；寬度大於 0.5 mm 就一定要讓路。

## 4. 時間解析度收斂（獨立的固定步長實作，同一個讓路決定）
速度 ${e.convergence.speeds_mm_s.join('／')} mm/s（不在格點上）、讓路者 ${e.convergence.yielder}、停頓 ${f(e.convergence.hold_s, 2)} s：

| Δt (s) | W1 抵達誤差 (s) | W2 抵達誤差 (s) |
|---|---|---|
${e.convergence.rows.map((c) => `| ${c.dt_s} | ${c.W1_err_s.toExponential(2)} | ${c.W2_err_s.toExponential(2)} |`).join('\n')}

固定步長版本的誤差隨 Δt 縮小而收斂到事件驅動引擎（引擎沒有時間步，與手算解析解一致）。

## 5. 與科學觀察的比較與驗證限制
| 項目 | 本模型 | 文獻 | 可否驗證本種 |
|---|---|---|---|
| 誰讓路（入口） | 以 0.957 讓尚未進入者讓 | L. niger 202/211（R380） | 不可：非本種 |
| 帶食優先 | 選用規則，0.98 | Atta colombica 294/300（R381）；L. niger 沒有（R380） | 不可：兩種研究矛盾，本種未知 |
| 每次接觸損失的時間（模型算出，非輸入） | ENTRY：兩隻平均 ${f((e.entry.ants.W1.added_s! + e.entry.ants.W2.added_s!) / 2)} s／次（停頓 0.18 s＋讓路） | L. humile 0.24（R108）、L. niger 0.43（R380）、Atta 0.80（R381）：都是回歸斜率，已含讓路 | 只能比較量級：非本種，且情境不同 |
| 接觸停頓 | 0.18 s（候選；0.43／0.80 只作上限，會重複計算） | L. humile 接觸持續 0.18 ± 0.14 s（R108） | 不可：本種未量測 |
| 兩隻都在窄段內 | 每次接觸各自回頭的機率 p | 沒有研究 | 不可 |
| 不超越 | 單行段不能超越（物理） | Atta：110 隻中只有 8 隻超越（R381） | 方向一致 |
| 自發迴轉 | 不模擬 | L. humile ≈1 %/次過橋（R108） | — |
| 群組（同向成群通過） | 會自然形成（讓路者等對方整群通過） | L. niger 窄橋平均 3.3 隻（R380） | 尚未量化比較 |

**結論**：本版的讓路規則只用螞蟻自己能感知的資訊，規則與比例都來自已核對的非本種研究，或明確標為遊戲假設。實驗證明這些機制在引擎中確實運作、可重播、可反駁；但**不能**宣稱它們重現了大頭家蟻的行為。

## 原始結果（JSON；測試比對用）
\`\`\`json
${JSON.stringify(e, null, 1)}
\`\`\`
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(report(runExperiment()));

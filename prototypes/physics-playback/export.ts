/**
 * Physics playback exporter (docs/physics-playback.md). ISOLATED experiment: not imported by the day loop, cli/ or web/.
 *
 * Runs the PH-3b event-driven 2-D solver (engine/physics/solver2d.ts) — and, for comparison, the PH-2 native 1-D solver
 * (engine/physics/collision.ts simulate) — on synthetic scenarios and writes, per run, the EXACT piecewise motion of every
 * agent and the engine's event list, for the static page in this directory (index.html + app.js). The page never runs
 * a solver; it only reads these files.
 *
 * Motion: PH-3b moves every body at a constant velocity between two of its motion records (it records a pose exactly when
 * its velocity or heading changes), so each exported segment [t0, t1] with its two exact end poses IS the solver's motion,
 * not a fit to samples. Every segment boundary must be the time of an engine event that names this agent, or the run
 * start (0) / horizon; the exporter refuses to write otherwise. Native segments are the engine's own MotionInterval
 * records (each with its kind and cause); their boundaries are listed as `record` entries next to the events.
 *
 * Nothing is tuned: sizes and speeds come from the solver-compare spec loader (candidate files), scenarios are synthetic.
 *   node prototypes/physics-playback/export.ts           # writes prototypes/physics-playback/data/*.json
 *   node prototypes/physics-playback/export.ts --check   # exit 1 if the files differ from a fresh export
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario, type Scenario, type ScenarioFile } from '../solver-compare/lib/spec.ts';
import { ph3bInput } from '../solver-compare/lib/ph3b.ts';
import { nativeConfig, toTrajectory as nativeTraj } from '../solver-compare/lib/native.ts';
import { laneFrames, poseOn } from '../solver-compare/lib/traj.ts';
import { solve2D, type Solver2DResult } from '../../engine/physics/solver2d.ts';
import { simulate } from '../../engine/physics/collision.ts';
import { checkContacts, checkConstraints, checkMotion, CONTRACT } from '../physics-check/contact-check.ts';
import { STEER_POLICIES, steer2D, type SteerPolicyId, type SteerResult, type SteerControl } from '../../engine/physics/local-steer.ts';
import { steerInput, steerParams, loadCandidates, CANDIDATE_LABEL, POLICY_LABEL, DENSE_BENCHMARK_SCOPE, isDenseBenchmark } from '../local-steer/lib.ts';
import { checkContacts as checkSteerContacts, DELTA_G_MM } from '../local-steer/contact-check.ts';
import { controlScenario, loadControls } from '../local-steer/controls.ts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(HERE, 'data');
export const PLAYBACK_SCHEMA = 'antempire.physics-playback.v1';

/** scenario id → where its file lives; every scenario is synthetic (the loader refuses anything else) */
export const SCENARIOS: { id: string; from: 'solver-compare' | 'playback'; native: boolean }[] = [
  { id: 'head-on-2', from: 'solver-compare', native: true },
  { id: 'offset-block', from: 'playback', native: false },
  { id: 'pass-clear', from: 'playback', native: false },
  { id: 'pass-graze', from: 'playback', native: false },
  { id: 'crossing', from: 'solver-compare', native: true },
  { id: 'crossing-flank', from: 'playback', native: false },
  { id: 'stone', from: 'solver-compare', native: true },
  { id: 'corridor-8', from: 'solver-compare', native: true },
];
/** WP4 candidate behaviour runs (engine/physics/local-steer.ts, seed 1): every playback scenario plus the 100-agent crossing
 *  (whose PH-3b run, 45k events, is too large for the page; its baseline is in the WP4 comparison table) */
export const STEER_SCENARIOS: { id: string; from: 'solver-compare' | 'playback' }[] = [...SCENARIOS.map((s) => ({ id: s.id, from: s.from })), { id: 'crossing-traffic-100', from: 'solver-compare' }];
/** the candidate behaviours A–C and the no-yield control N (Owner decision 9: the control is on the page too) */
export type SteerRunPolicy = Exclude<SteerPolicyId, 'none'>;
export const STEER_RUN_POLICIES = STEER_POLICIES.filter((p) => p !== 'none') as SteerRunPolicy[];
export const steerRunId = (scenario: string, p: SteerPolicyId) => `${scenario}--steer-${p.split('_')[0]}`;
/** WP4 control scenarios on the page (prototypes/local-steer/controls.ts, docs/wp4-local-avoidance.md §5b): the 100-agent
 *  crossing under K0–K3 for A, B, C and N, seed 1 only (seeds 2–5 and the 1000-agent runs stay in the comparison tables;
 *  16 runs keep the page data at a few MB) */
export const CONTROL_BASE = 'crossing-traffic-100';
export const CONTROL_VARIANTS = ['K0_lattice_stay', 'K1_lattice_exit', 'K2_inflow_stay', 'K3_inflow_exit'] as const;
export const controlRunId = (base: string, variant: string, p: SteerPolicyId) => `${base}-${variant.split('_')[0]}--steer-${p.split('_')[0]}`;
/** label of every run that is a control (the no-yield control N, or a control scenario K0–K3) */
export const CONTROL_LABEL = '隔離物理實驗・候選行為規則／控制組（非本種／假設）・非正式';
/** what the control runs are and are NOT valid for (shown on the page instead of the dense-benchmark note) */
export const CONTROL_SCOPE = '適用範圍（對照情境 K0–K3，遊戲假設，非生物情境）：同一個 100 隻交叉口，只改起點（格狀／依時間流入）與抵達後的處理（留在路上／有限容量出口）。只用來檢查密集基準的結果有多少來自情境設計，而不是候選規則本身；流入率、入口位置、出口容量、停留時間與時間終點都是遊戲假設（prototypes/local-steer/control-scenarios.json），不是本種資料。入口、出口與「接觸結束（估計）」是情境邊界規則，不是物理也不是行為，不能當生物原因。不適用於：推論交通流量、抵達率、清空時間或任何規則的生物合理性。只顯示種子 1。';
/** event kinds that are control-scenario boundary rules, not physics or behaviour */
const isBoundaryEvent = (e: { kind: string; detail: string | null }) => e.kind === 'exit' || e.kind === 'entry_blocked' || e.kind === 'contact_end_estimated' || (e.kind === 'start' && /control scenario boundary/.test(e.detail ?? ''));

export interface Segment { t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; heading: number; speed_mm_s: number; s0: number; s1: number; u: number; /** steer runs: u at t1 (u changes along a side step) */ u1?: number }
export interface PbEvent {
  t: number; kind: string; class: string; agents: string[]; detail: string | null;
  /** PH-3b contact events: the solver's root bracket and error bound, and the INDEPENDENT checker's interval (check_s,
   *  check_err_s = its width) computed from this file's own segments (prototypes/physics-check/contact-check.ts).
   *  steer contact_end: the solver's bisection bracket, and the INDEPENDENT checker's bracket of the physical separation
   *  instant with its error bound in err_s (prototypes/local-steer/contact-check.ts, from the segments in this file) */
  bracket_s?: [number, number]; err_s?: number; confirmed_t_s?: number; exact?: boolean; usable_as_cause?: boolean; check_s?: [number, number]; check_err_s?: number;
  /** contact events: 'geometric_contact' (the only contact kind PH-3b emits as events) */
  contact_kind?: string;
  /** control-scenario boundary rule (entry, exit, entry blocked, estimated contact end): not physics, not behaviour */
  boundary?: true;
}
/** the three contact kinds of a PH-3b run (docs/physics-time-contract.md §4): geometric episodes are the contact events;
 *  constraint_active intervals are the solver's constraint state (rows in `columns` order); antenna_contact is
 *  unsupported (no antenna geometry) and is null — never drawn, never invented */
export interface PbContactKinds {
  geometric_contact: { source: 'events'; episodes: number; note: string };
  constraint_active: { columns: string[]; rows: (string | number | null)[][]; binding: number; note: string };
  antenna_contact: { supported: false; value: null; note: string };
  note: string;
}
export interface PbAgent {
  id: string; lane: string; layer: string; dir: 1 | -1; u_mm: number; start_t_s: number; goal_s_mm: number; free_speed_mm_s: number; speed_source: string;
  segments: Segment[]; final: { t: number; x: number; y: number; heading: number } | null; arrival_t_s: number | null; final_mode: string; stop_cause: string | null;
  /** control runs: on the road from present_from_t_s (null = never entered) until removed_t_s (null = still there); the
   *  page draws the body only inside [from, until] (both inclusive, as the independent contact checker) */
  scheduled_start_t_s?: number; present_from_t_s?: number | null; removed_t_s?: number | null;
}
export interface PbRun {
  schema: string; run_id: string; solver: 'ph3b' | 'native' | 'steer'; solver_label: string; solver_notes: string[];
  /** steer runs: the candidate policy and the page badge for this run */
  policy?: SteerPolicyId; label?: string; seed?: number;
  /** control runs: the variant (K0–K3) and its boundary rules, parameters as in control-scenarios.json */
  control?: { variant: string; base_scenario: string; spawn: boolean; exit: { capacity: number; dwell_s: number } | null; why: string; params: string[] };
  /** what this scenario is and is not valid for (dense benchmark) */
  scope_note?: string;
  /** steer runs: independent contact_end check over this file's segments */
  contact_end_check?: { checker: string; episodes: number; exact: number; estimated: number; open: number; violations: number; max_err_s: number | null; delta_g_mm: number };
  scenario: { id: string; title: string; synthetic: true; source_file: string; provenance: ScenarioFile['provenance'] };
  status: string; horizon_s: number;
  body: { length_mm: number; width_mm: number; length_source: string; width_source: string; shape: string };
  lanes: { id: string; centerline_mm: [number, number][]; width_mm: number; layer: string }[];
  obstacles: ({ id: string; kind: 'circle'; center_mm: [number, number]; radius_mm: number } | { id: string; kind: 'polygon'; points_mm: [number, number][] })[];
  agents: PbAgent[]; events: PbEvent[];
  motion_note: string;
  /** PH-3b runs only */
  contact_kinds?: PbContactKinds;
}

export const scenarioFile = (s: { id: string; from: 'solver-compare' | 'playback' }) => s.from === 'playback' ? path.join(HERE, 'scenarios', `${s.id}.json`) : path.join(HERE, '..', 'solver-compare', 'scenarios', `${s.id}.json`);
const rel = (p: string) => path.relative(path.join(HERE, '..', '..'), p).split(path.sep).join('/');

function common(sc: Scenario, file: string) {
  return {
    scenario: { id: sc.id, title: sc.title, synthetic: true as const, source_file: rel(file), provenance: sc.file.provenance },
    horizon_s: sc.horizon_s,
    body: {
      length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value,
      length_source: `${sc.body.length_mm.source} [${sc.body.length_mm.basis}] ${sc.body.length_mm.why}`,
      width_source: `${sc.body.width_mm.source} [${sc.body.width_mm.basis}] ${sc.body.width_mm.why}`,
      shape: '膠囊（長 L、寬 w，兩端半圓；遊戲假設，不含觸角與腳）',
    },
    lanes: sc.lanes.map((l) => ({ id: l.passage.id, centerline_mm: l.passage.centerline_mm.map(([x, y]) => [x, y] as [number, number]), width_mm: l.passage.width_mm as number, layer: l.layer })),
    obstacles: sc.obstacles.map((o) => o.shape.type === 'circle'
      ? { id: o.id, kind: 'circle' as const, center_mm: [o.shape.center_mm[0], o.shape.center_mm[1]] as [number, number], radius_mm: o.shape.radius_mm }
      : { id: o.id, kind: 'polygon' as const, points_mm: o.shape.points_mm.map(([x, y]) => [x, y] as [number, number]) }),
  };
}

/** PH-3b: segments between consecutive motion records; each boundary checked against the engine's events */
export function ph3bRun(sc: Scenario, file: string): { run: PbRun; res: Solver2DResult } {
  const res = solve2D(ph3bInput(sc));
  const H = res.stats.t_end_s;
  const evTimes = new Map<string, Set<number>>();
  for (const e of res.events) for (const id of e.agents) { if (!evTimes.has(id)) evTimes.set(id, new Set()); evTimes.get(id)!.add(e.t_s); }
  const agents: PbAgent[] = [];
  for (const a of [...sc.agents].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))) {
    const o = res.agents[a.id], S = o.samples, segs: Segment[] = [];
    for (let i = 0; i + 1 < S.length; i++) {
      const p = S[i], q = S[i + 1];
      if (q[0] === p[0]) continue;                          // instant turn at a joint: heading changes, no motion
      const dt = q[0] - p[0];
      segs.push({ t0: p[0], t1: q[0], x0: p[1], y0: p[2], x1: q[1], y1: q[2], heading: p[3], speed_mm_s: Math.abs(q[4] - p[4]) / dt, s0: p[4], s1: q[4], u: p[5] });
    }
    const ok = evTimes.get(a.id) ?? new Set<number>();
    for (const g of segs) for (const t of [g.t0, g.t1]) if (!(t === 0 || t === H || ok.has(t))) throw Error(`PLAYBACK: ${sc.id}/${a.id}: segment boundary ${t} s is not an engine event time of this agent`);
    const last = S[S.length - 1];
    agents.push({ id: a.id, lane: a.passage, layer: a.layer, dir: a.dir, u_mm: a.u_mm, start_t_s: a.start_t_s, goal_s_mm: a.goal_s_mm, free_speed_mm_s: a.free_speed_mm_s, speed_source: a.speed_source, segments: segs, final: { t: last[0], x: last[1], y: last[2], heading: last[3] }, arrival_t_s: o.arrival_t_s, final_mode: o.final_mode, stop_cause: o.stop_cause });
  }
  const run: PbRun = {
    schema: PLAYBACK_SCHEMA, run_id: `${sc.id}--ph3b`, solver: 'ph3b', solver_label: 'PH-3b 事件驅動二維解算器',
    solver_notes: ['只有物理約束：碰到就停、追上就跟、側面可滑過；沒有讓路、側移、掉頭（生物決策未建模）', '橫向偏移 u 整段固定為情境給定值（橫向轉向模型未知，null）', `解算器狀態：${res.stats.aborted ? `中止（${res.stats.aborted}）` : '正常結束'}；unresolved ${res.stats.unresolved}`],
    ...common(sc, file), status: res.stats.aborted ? `aborted: ${res.stats.aborted}` : 'completed',
    agents, events: res.events.map((e) => ({ t: e.t_s, kind: e.kind, class: e.class, agents: e.agents, detail: e.detail, ...(e.bracket_s ? { bracket_s: e.bracket_s, err_s: e.err_s, confirmed_t_s: e.confirmed_t_s } : {}), ...(e.exact !== undefined ? { exact: e.exact, usable_as_cause: e.usable_as_cause } : {}), ...(e.contact_kind ? { contact_kind: e.contact_kind } : {}) })),
    motion_note: '每一段是解算器在兩個事件之間的直線等速平移（兩端是解算器紀錄的精確姿態）；畫面上的位置就是這個運動，不是取樣點的插值，沒有平滑。',
  };
  // independent check of every contact event against THIS file's segments; refuse to write a file that fails it
  const ck = checkContacts({ horizon_s: H, body: { length_mm: run.body.length_mm, width_mm: run.body.width_mm }, agents: agents.map((a) => ({ id: a.id, segments: a.segments, final: a.final, present_from: 0, present_until: null, layer: a.layer })), events: run.events });
  const mc = checkMotion({ horizon_s: H, body: run.body, agents: agents.map((a) => ({ id: a.id, segments: a.segments, final: a.final, present_from: 0, present_until: null })), events: [] });
  const cc = checkConstraints({ horizon_s: H, body: { length_mm: run.body.length_mm, width_mm: run.body.width_mm }, agents: agents.map((a) => ({ id: a.id, segments: a.segments, final: a.final, present_from: 0, present_until: null, layer: a.layer })), events: run.events }, res.constraint_active, ck);
  if (ck.violations || mc.problems.length || cc.violations) throw Error(`PLAYBACK: ${sc.id}: independent contact/motion/constraint check failed: ${[...ck.problems, ...mc.problems, ...cc.problems].slice(0, 3).join(' | ')}`);
  if (res.antenna_contact !== null || res.events.some((e) => e.contact_kind === 'antenna_contact')) throw Error(`PLAYBACK: ${sc.id}: PH-3b has no antenna geometry; an antenna contact must never be emitted`);
  run.contact_kinds = {
    geometric_contact: { source: 'events', episodes: ck.episodes, note: `contact_start／contact_end：兩身體膠囊間距 ≤ θ（${CONTRACT.tol_mm} mm）的連續區段；附根區間、誤差界與獨立檢查區間` },
    constraint_active: {
      columns: ['agent_a', 'agent_b', 'start_t_s', 'end_t_s', 'start_trigger', 'end_trigger', 'end_bracket_lo_s', 'binding_t_s', 'binding_solves'],
      rows: res.constraint_active.map((c) => [c.agents[0], c.agents[1], c.start_t_s, c.end_t_s, c.start_trigger, c.end_trigger, c.end_bracket_s ? c.end_bracket_s[0] : null, c.binding_t_s, c.binding_solves]),
      binding: res.stats.constraint_intervals_binding,
      note: `解算器的不穿透約束確實在速度求解中的區間（解算器狀態，不是間距穿越 θ 的根）；獨立檢查：每段都在同一對的幾何接觸之內（${cc.inside_episode}／${cc.intervals}，解析度以下 ${cc.below_resolution}）。end_t_s = null：時間終點仍作用。binding_t_s：第一次真的限制了速度的時刻（null：從未限制）`,
    },
    antenna_contact: { supported: false, value: null, note: 'PH-3b 沒有觸角幾何：不產生觸角接觸。之後的化學感知／CHC 辨識（#135）需要先建立觸角幾何模型；身體接觸不等於觸角接觸' },
    note: '三種接觸彼此不能互相推導；任何接觸都不代表交哺、招募或攻擊（這些生物行為沒有建模）',
  };
  run.solver_notes.push(`三種接觸：幾何接觸（事件 ${ck.episodes} 段）≠ 約束作用（區間 ${res.constraint_active.length} 段，其中 ${res.stats.constraint_intervals_binding} 段真的限制了速度）≠ 觸角接觸（PH-3b 無觸角幾何：不支援、不產生）。接觸不代表交哺、招募或攻擊`);
  for (const ep of ck.list) {
    const key = [...ep.pair].sort().join('|'), same = (e: PbEvent) => [...e.agents].sort().join('|') === key;
    const st = run.events.find((e) => e.kind === 'contact_start' && e.t === ep.t_start && same(e));
    if (st && ep.start_lo !== null) { st.check_s = [ep.start_lo, ep.start_hi!]; st.check_err_s = ep.start_hi! - ep.start_lo; }
    const en = ep.t_end === null ? undefined : run.events.find((e) => e.kind === 'contact_end' && e.t === ep.t_end && same(e));
    if (en && ep.lo !== null) { en.check_s = [ep.lo, ep.hi!]; en.check_err_s = ep.err_s!; }
  }
  run.solver_notes.push(`接觸事件＝間距 ≤ ${CONTRACT.tol_mm} mm 的連續區段（分離解析度 ${CONTRACT.resolution_mm} mm）；每個 contact_start／contact_end 附解算器的根區間與誤差界，以及獨立檢查器的區間（check_s）`);
  return { run, res };
}

/** Native PH-2 (1-D, u = 0): segments are the engine's MotionInterval records */
export function nativeRun(sc: Scenario, file: string): PbRun {
  const res = simulate(nativeConfig(sc)), tr = nativeTraj(sc, res), frames = laneFrames(sc), H = sc.horizon_s;
  const agents: PbAgent[] = [], records: PbEvent[] = [];
  for (const a of [...sc.agents].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))) {
    const f = frames.get(a.passage)!, segs: Segment[] = [];
    let dirNow: 1 | -1 = a.dir, sNow = a.s_mm, tNow = 0;
    const hold = (t1: number, cause: string) => { const p = poseOn(f, sNow, 0, dirNow); segs.push({ t0: tNow, t1, x0: p.x, y0: p.y, x1: p.x, y1: p.y, heading: p.heading, speed_mm_s: 0, s0: sNow, s1: sNow, u: 0 }); records.push({ t: tNow, kind: 'record', class: 'native_motion_record', agents: [a.id], detail: cause }); };
    for (const iv of res.intervals[a.id]) {
      if (iv.t_start_s > tNow) hold(iv.t_start_s, 'no native record (held at the last position)');
      const d = (iv.dir ?? a.dir) as 1 | -1, p = poseOn(f, iv.s_start_mm, 0, d), q = poseOn(f, iv.s_end_mm, 0, d);
      if (iv.t_end_s > iv.t_start_s) {
        segs.push({ t0: iv.t_start_s, t1: iv.t_end_s, x0: p.x, y0: p.y, x1: q.x, y1: q.y, heading: p.heading, speed_mm_s: Math.abs(iv.s_end_mm - iv.s_start_mm) / (iv.t_end_s - iv.t_start_s), s0: iv.s_start_mm, s1: iv.s_end_mm, u: 0 });
        records.push({ t: iv.t_start_s, kind: 'record', class: 'native_motion_record', agents: [a.id], detail: `${iv.kind}${iv.cause ? ` (${iv.cause}${iv.cause_ref ? ` ${iv.cause_ref}` : ''})` : ''}` });
      }
      dirNow = d; sNow = iv.s_end_mm; tNow = Math.max(tNow, iv.t_end_s);
    }
    if (tNow < H) hold(H, 'after the last native record (held at its end position)');
    const last = segs[segs.length - 1];
    agents.push({ id: a.id, lane: a.passage, layer: a.layer, dir: a.dir, u_mm: 0, start_t_s: a.start_t_s, goal_s_mm: a.goal_s_mm, free_speed_mm_s: a.free_speed_mm_s, speed_source: a.speed_source, segments: segs, final: { t: last.t1, x: last.x1, y: last.y1, heading: last.heading }, arrival_t_s: tr.agents[a.id].arrival_t_s, final_mode: tr.agents[a.id].final_mode, stop_cause: null });
  }
  const events: PbEvent[] = [...tr.events.map((e) => ({ t: e.t_s, kind: e.kind, class: e.class, agents: e.agents, detail: e.detail ?? null })), ...records];
  // stable order: time, then events before records, then original order
  const idx = new Map(events.map((e, i) => [e, i]));
  events.sort((p, q) => p.t - q.t || Number(p.kind === 'record') - Number(q.kind === 'record') || idx.get(p)! - idx.get(q)!);
  return {
    schema: PLAYBACK_SCHEMA, run_id: `${sc.id}--native`, solver: 'native', solver_label: '原生 PH-2（一維）對照',
    solver_notes: ['一維：每隻只有沿通道的位置，沒有橫向座標；畫在中心線 u = 0（情境給的 u 被忽略）。並排通過時畫面會重疊——這是一維模型的限制', '含相遇規則（讓路、交叉等待、後退）：非本種候選規則（interaction-candidates），不是本種行為', '分段邊界是引擎的 MotionInterval 紀錄（列為「record」）'],
    ...common(sc, file), status: `completed (t_end ${res.stats.t_end_s} s)`, agents, events,
    motion_note: '每一段是原生引擎的 MotionInterval（分段等速）紀錄本身；畫面上的位置就是這個運動，不是取樣點的插值，沒有平滑。',
  };
}

/** a control variant of the base scenario (same geometry, bodies, speeds, goals; start poses / times, horizon and the
 *  boundary rules from control-scenarios.json) */
export function controlFor(sc: Scenario, variant: string): { sc: Scenario; control: SteerControl } { return controlScenario(sc, variant); }

/** WP4 candidate / control policy (seed 1): segments between consecutive motion records; each boundary checked against
 *  the events. With `ctl`, `sc` is the control scenario and its boundary rules are applied. */
export function steerRun(sc: Scenario, file: string, policy: SteerRunPolicy, ctl?: { variant: string; control: SteerControl }): { run: PbRun; res: SteerResult } {
  const res = steer2D({ ...steerInput(sc, policy, { seed: 1 }), ...(ctl ? { control: ctl.control } : {}) }), H = res.stats.t_end_s;
  const evTimes = new Map<string, Set<number>>();
  for (const e of res.events) for (const id of e.agents) { if (!evTimes.has(id)) evTimes.set(id, new Set()); evTimes.get(id)!.add(e.t_s); }
  const agents: PbAgent[] = [];
  for (const a of [...sc.agents].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))) {
    const o = res.agents[a.id], S = o.samples, segs: Segment[] = [];
    for (let i = 0; i + 1 < S.length; i++) {
      const p = S[i], q = S[i + 1];
      if (q[0] === p[0]) continue;
      const dt = q[0] - p[0];
      segs.push({ t0: p[0], t1: q[0], x0: p[1], y0: p[2], x1: q[1], y1: q[2], heading: p[3], speed_mm_s: Math.hypot(q[1] - p[1], q[2] - p[2]) / dt, s0: p[4], s1: q[4], u: p[5], u1: q[5] });
    }
    const ok = evTimes.get(a.id) ?? new Set<number>();
    for (const g of segs) for (const t of [g.t0, g.t1]) if (!(t === 0 || t === H || ok.has(t))) throw Error(`PLAYBACK: ${sc.id}/${policy}/${a.id}: segment boundary ${t} s is not an engine event time of this agent`);
    const last = S.length ? S[S.length - 1] : null;
    agents.push({ id: a.id, lane: a.passage, layer: a.layer, dir: a.dir, u_mm: a.u_mm, start_t_s: a.start_t_s, goal_s_mm: a.goal_s_mm, free_speed_mm_s: a.free_speed_mm_s, speed_source: a.speed_source, segments: segs, final: last ? { t: last[0], x: last[1], y: last[2], heading: last[3] } : null, arrival_t_s: o.arrival_t_s, final_mode: o.final_mode, stop_cause: o.stop_cause,
      ...(o.scheduled_start_t_s !== undefined ? { scheduled_start_t_s: o.scheduled_start_t_s, present_from_t_s: o.present_from_t_s ?? null } : {}), ...(o.removed_t_s !== undefined ? { removed_t_s: o.removed_t_s } : {}) });
  }
  const prov = steerParams(sc).provenance, cand = loadCandidates(), isControl = policy === 'N_no_yield' || !!ctl;
  const C = ctl ? loadControls() : null, v = ctl ? C!.variants[ctl.variant] : null;
  const run: PbRun = {
    schema: PLAYBACK_SCHEMA, run_id: ctl ? controlRunId(CONTROL_BASE, ctl.variant, policy) : steerRunId(sc.id, policy), solver: 'steer',
    solver_label: ctl ? `${ctl.variant.split('_')[0]}・${POLICY_LABEL[policy]}` : POLICY_LABEL[policy], policy, label: isControl ? CONTROL_LABEL : CANDIDATE_LABEL, seed: 1,
    ...(ctl ? { control: { variant: ctl.variant, base_scenario: CONTROL_BASE, spawn: ctl.control.spawn === true, exit: ctl.control.exit ?? null, why: v!.why, params: Object.entries(C!.params).map(([k, e]) => `${k} = ${JSON.stringify(e.value)} [${e.basis}] ${e.why}`) } } : {}),
    solver_notes: [
      ...(policy === 'N_no_yield' ? ['控制組 N：不讓路（永遠直走、碰到就停到下一個決策時刻），用來對照 A–C 有多少差別來自規則本身；不是候選行為，也不是本種行為（大頭家蟻沒有讓路文獻）。'] : []),
      ...(ctl ? [`對照情境 ${ctl.variant}（遊戲假設，非本種，非正式）：${v!.why} 入口／出口是情境邊界規則，不是物理也不是行為；「離開道路」與「接觸結束（估計）」不能當生物原因。種子 1（種子 2–5 與 1000 隻版本只在比較表）。`] : []),
      `${CANDIDATE_LABEL}：WP4 候選局部行為規則（engine/physics/local-steer.ts），物理約束沿用 PH-3b 的膠囊與精確連續碰撞。大頭家蟻沒有任何讓路、側移或窄道交通研究；這不是本種行為，也沒有為抵達調參。`,
      ...cand.conventions,
      ...Object.entries(prov).map(([k, v]) => `參數 ${k} = ${v}`),
      `命名亂數流 steer.${policy}.*，種子 1；決策只讀取決策時刻的局部感知（感知半徑內的身體與牆），不讀全圖、不讀對方意圖。`,
      `解算狀態：fallback ${res.stats.fallback_intervals}、unresolved ${res.stats.unresolved}；受阻回報 ${JSON.stringify(res.stats.blocked_reports)}`,
    ],
    ...common(sc, file), status: res.stats.fallback_intervals || res.stats.unresolved ? `completed with fallback ${res.stats.fallback_intervals} / unresolved ${res.stats.unresolved}` : 'completed',
    ...(ctl ? { scope_note: CONTROL_SCOPE } : isDenseBenchmark(sc.id) ? { scope_note: DENSE_BENCHMARK_SCOPE } : {}),
    agents, events: res.events.map((e) => ({ t: e.t_s, kind: e.kind, class: e.class, agents: e.agents, detail: e.detail, ...(e.bracket_s ? { bracket_s: e.bracket_s } : {}), ...(e.usable_as_cause === false ? { usable_as_cause: false as const } : {}), ...(isBoundaryEvent(e) ? { boundary: true as const } : {}) })),
    motion_note: '每一段是候選規則選定的方向在兩個事件之間的直線等速平移（兩端是解算紀錄的精確姿態）；身體軸維持與通道平行（幾何約定）。畫面上的位置就是這個運動，不是插值，沒有平滑。',
  };
  // independent check of every contact_end from the exported segments themselves (not from the solver's internals)
  const ck = checkSteerContacts({ horizon_s: H, body: { length_mm: run.body.length_mm, width_mm: run.body.width_mm }, agents: run.agents.map((a) => ({ id: a.id, segments: a.segments, final: a.final, present_from: a.present_from_t_s === undefined ? 0 : a.present_from_t_s === null ? Infinity : a.present_from_t_s, present_until: a.removed_t_s ?? null })), events: run.events });
  const byEnd = new Map(ck.list.filter((e) => e.end_kind === 'contact_end').map((e) => [`${e.pair.join('|')}@${e.t_end}`, e]));
  for (const e of run.events) if (e.kind === 'contact_end') { const c = byEnd.get(`${[...e.agents].sort().join('|')}@${e.t}`); if (c && c.lo !== null && c.hi !== null) { e.check_s = [c.lo, c.hi]; e.err_s = c.err_s!; } }
  run.contact_end_check = { checker: 'prototypes/local-steer/contact-check.ts（獨立程式：自己的膠囊距離、分段凸性、二分法；只讀本檔的分段運動）', episodes: ck.episodes, exact: ck.exact, estimated: ck.estimated, open: ck.open, violations: ck.violations, max_err_s: ck.max_err_s, delta_g_mm: DELTA_G_MM };
  if (ck.violations) throw Error(`PLAYBACK: ${sc.id}/${policy}: independent contact_end check failed: ${ck.problems.slice(0, 3).join('; ')}`);
  return { run, res };
}

const stable = (o: unknown) => JSON.stringify(o) + '\n';

/** every output file (name → content); deterministic: no timestamps, no machine data */
export function buildAll(): Map<string, string> { return buildAllWithResults().files; }
/** the files plus each run's solver result (so the test checks the export against the solve that produced it) */
export function buildAllWithResults(): { files: Map<string, string>; results: Map<string, Solver2DResult | SteerResult> } {
  const files = new Map<string, string>(), index: unknown[] = [], results = new Map<string, Solver2DResult | SteerResult>();
  for (const s of SCENARIOS) {
    const file = scenarioFile(s), sc = loadScenario(JSON.parse(fs.readFileSync(file, 'utf8')) as ScenarioFile);
    const ph = ph3bRun(sc, file); results.set(ph.run.run_id, ph.res);
    const runs = [ph.run, ...(s.native ? [nativeRun(sc, file)] : [])];
    for (const r of runs) {
      files.set(`${r.run_id}.json`, stable(r));
      index.push({ run_id: r.run_id, file: `data/${r.run_id}.json`, scenario: r.scenario.id, title: r.scenario.title, solver: r.solver, solver_label: r.solver_label, agents: r.agents.length, events: r.events.length, arrived: r.agents.filter((a) => a.arrival_t_s !== null).length, synthetic: true });
    }
  }
  for (const s of STEER_SCENARIOS) {
    const file = scenarioFile(s), sc = loadScenario(JSON.parse(fs.readFileSync(file, 'utf8')) as ScenarioFile);
    for (const p of STEER_RUN_POLICIES) {
      const { run: r, res } = steerRun(sc, file, p); results.set(r.run_id, res);
      files.set(`${r.run_id}.json`, stable(r));
      index.push({ run_id: r.run_id, file: `data/${r.run_id}.json`, scenario: r.scenario.id, title: r.scenario.title, solver: r.solver, solver_label: r.solver_label, label: r.label, ...(r.scope_note ? { scope_note: r.scope_note } : {}), agents: r.agents.length, events: r.events.length, arrived: r.agents.filter((a) => a.arrival_t_s !== null).length, synthetic: true });
    }
  }
  {
    const base = STEER_SCENARIOS.find((s) => s.id === CONTROL_BASE)!, file = scenarioFile(base), sc0 = loadScenario(JSON.parse(fs.readFileSync(file, 'utf8')) as ScenarioFile);
    for (const variant of CONTROL_VARIANTS) {
      const { sc, control } = controlFor(sc0, variant);
      for (const p of STEER_RUN_POLICIES) {
        const { run: r, res } = steerRun(sc, file, p, { variant, control }); results.set(r.run_id, res);
        files.set(`${r.run_id}.json`, stable(r));
        index.push({ run_id: r.run_id, file: `data/${r.run_id}.json`, scenario: r.scenario.id, title: `${r.scenario.title}（對照 ${variant}）`, solver: r.solver, solver_label: r.solver_label, label: r.label, control: variant, ...(r.scope_note ? { scope_note: r.scope_note } : {}), agents: r.agents.length, events: r.events.length, arrived: r.agents.filter((a) => a.arrival_t_s !== null).length, exited: r.agents.filter((a) => typeof a.removed_t_s === 'number').length, synthetic: true });
      }
    }
  }
  files.set('index.json', stable({ schema: PLAYBACK_SCHEMA, label: '隔離物理實驗・非正式・不是生物行為（讓路／側移決策尚未建模）', candidate_label: CANDIDATE_LABEL, control_label: CONTROL_LABEL, runs: index }));
  return { files, results };
}

const me = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === me) {
  const files = buildAll();
  if (process.argv.includes('--check')) {
    const bad = [...files].filter(([n, c]) => !fs.existsSync(path.join(DATA_DIR, n)) || fs.readFileSync(path.join(DATA_DIR, n), 'utf8') !== c).map(([n]) => n);
    const extra = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter((n) => !files.has(n)) : [];
    if (bad.length || extra.length) { console.log(`differs: ${bad.join(', ')} extra: ${extra.join(', ')}`); process.exitCode = 1; } else console.log('playback data = fresh export');
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const n of fs.readdirSync(DATA_DIR)) if (!files.has(n)) fs.rmSync(path.join(DATA_DIR, n));
    for (const [n, c] of files) fs.writeFileSync(path.join(DATA_DIR, n), c);
    for (const [n, c] of files) console.log(`${n}  ${(c.length / 1024).toFixed(1)} KB`);
  }
}

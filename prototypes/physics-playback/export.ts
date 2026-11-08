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

export interface Segment { t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; heading: number; speed_mm_s: number; s0: number; s1: number; u: number }
export interface PbEvent {
  t: number; kind: string; class: string; agents: string[]; detail: string | null;
  /** PH-3b contact events: the solver's root bracket and error bound, and the INDEPENDENT checker's interval (check_s,
   *  check_err_s = its width) computed from this file's own segments (prototypes/physics-check/contact-check.ts) */
  bracket_s?: [number, number]; err_s?: number; confirmed_t_s?: number; exact?: boolean; usable_as_cause?: boolean; check_s?: [number, number]; check_err_s?: number;
  /** contact events: 'geometric_contact' (the only contact kind PH-3b emits as events) */
  contact_kind?: string;
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
  segments: Segment[]; final: { t: number; x: number; y: number; heading: number }; arrival_t_s: number | null; final_mode: string; stop_cause: string | null;
}
export interface PbRun {
  schema: string; run_id: string; solver: 'ph3b' | 'native'; solver_label: string; solver_notes: string[];
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

const scenarioFile = (s: (typeof SCENARIOS)[number]) => s.from === 'playback' ? path.join(HERE, 'scenarios', `${s.id}.json`) : path.join(HERE, '..', 'solver-compare', 'scenarios', `${s.id}.json`);
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

const stable = (o: unknown) => JSON.stringify(o) + '\n';

/** every output file (name → content); deterministic: no timestamps, no machine data */
export function buildAll(): Map<string, string> {
  const files = new Map<string, string>(), index: unknown[] = [];
  for (const s of SCENARIOS) {
    const file = scenarioFile(s), sc = loadScenario(JSON.parse(fs.readFileSync(file, 'utf8')) as ScenarioFile);
    const runs = [ph3bRun(sc, file).run, ...(s.native ? [nativeRun(sc, file)] : [])];
    for (const r of runs) {
      files.set(`${r.run_id}.json`, stable(r));
      index.push({ run_id: r.run_id, file: `data/${r.run_id}.json`, scenario: r.scenario.id, title: r.scenario.title, solver: r.solver, solver_label: r.solver_label, agents: r.agents.length, events: r.events.length, arrived: r.agents.filter((a) => a.arrival_t_s !== null).length, synthetic: true });
    }
  }
  files.set('index.json', stable({ schema: PLAYBACK_SCHEMA, label: '隔離物理實驗・非正式・不是生物行為（讓路／側移決策尚未建模）', runs: index }));
  return files;
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

/**
 * Natural-walk prototype (docs/physics-kinematics2d.md §7–§9): parameter loading from the candidate file, the straight
 * artificial-trail validation scenario (R133 conditions, 150 mm), trail metrics, and the pose-stream export
 * (`antempire.pose-stream.v1`) for the four viewing scenes. Isolated physics experiment, NOT official.
 */
import { loadCandidates, bodies } from '../kinematics2d/lib.ts';
import { planWalk, type WalkParams, type WalkModel, type SyntheticField, type WalkSpec, type WalkPlan } from '../../engine/physics/natural-walk.ts';
import { runKinematics, poseAt, twistAt, type Static, type KinResult, type Track, type Seg } from '../../engine/physics/kinematics2d.ts';
import { hash32, rng } from '../../engine/rng.ts';

export const LABEL = '隔離物理實驗・非正式';
export const TRAIL_MM = 150;
type PV = { value: number; assumption: boolean; basis: string; evidence: string };

export function walkParams(model: WalkModel, over: Partial<WalkParams> = {}, set: 'baseline' | 'exploration' = 'baseline'): WalkParams {
  const nw = loadCandidates().natural_walk, b = nw.baseline as Record<string, PV>, e = nw.exploration as Record<string, PV>;
  const v = (k: string) => (set === 'exploration' && e[k] ? e[k].value : b[k].value);
  return {
    model, speed_mm_s: nw.trail_scenario.speed_outbound_mm_s.value, control_dt_s: v('control_dt_s'), max_turn_rate_rad_s: v('max_turn_rate_rad_s'),
    max_curvature_per_mm: v('max_curvature_per_mm'), ou_tau_s: v('ou_tau_s'), ou_sigma_rad_s: v('ou_sigma_rad_s'), heading_gain_per_s: v('heading_gain_per_s'),
    antenna_len_mm: v('antenna_len_mm'), antenna_half_angle_rad: v('antenna_half_angle_rad'), chem_gain_rad_s: v('chem_gain_rad_s'), chem_floor: v('chem_floor'),
    avoid_turn_rate_rad_s: v('avoid_turn_rate_rad_s'), ...over,
  };
}
/** the parameters as exported in a pose stream: every value with its assumption flag and basis */
export function paramsDoc(p: WalkParams, set: 'baseline' | 'exploration' = 'baseline'): Record<string, unknown> {
  const nw = loadCandidates().natural_walk, out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(p)) {
    if (k === 'model') continue;
    const src = (set === 'exploration' && nw.exploration[k]) || nw.baseline[k] || (k === 'speed_mm_s' ? nw.trail_scenario.speed_outbound_mm_s : null);
    out[k] = { value: val, assumption: true, basis: src ? src.basis : '遊戲假設' };
  }
  return out;
}
export function trailField(): SyntheticField {
  const f = loadCandidates().natural_walk.synthetic_field;
  return { synthetic: true, kind: 'gaussian_ridge', polyline: [{ x: -20, y: 0 }, { x: TRAIL_MM + 20, y: 0 }], sigma_mm: f.sigma_mm.value, peak: f.peak.value };
}
export function body() { const { L, widths } = bodies(); return { length_mm: L, width_mm: widths[1] }; }

/** one ant on the straight 150 mm artificial trail (R133 conditions in geometry only) */
export function trailAnt(model: WalkModel, seed: number, idx: number, opts: { speed?: number; control_dt?: number; offset_mm?: number } = {}): { plan: WalkPlan; res: KinResult; spec: WalkSpec } {
  const ts = loadCandidates().natural_walk.trail_scenario, id = `ant-${String(idx).padStart(2, '0')}`;
  const R = rng(hash32(`${seed}|kin2d.start|${id}`)), off = opts.offset_mm ?? ts.start_offset_mm.value, hd = ts.start_heading_rad.value;
  const y0 = (2 * R() - 1) * off, th0 = (2 * R() - 1) * hd;
  const p = walkParams(model, { ...(opts.speed ? { speed_mm_s: opts.speed } : {}), ...(opts.control_dt ? { control_dt_s: opts.control_dt } : {}) });
  const spec: WalkSpec = { id, body: body(), start: { x: 0, y: y0, th: model === 'A' ? 0 : th0 }, t0_s: 0, seed, params: p, goal_heading_rad: 0, end_x_mm: TRAIL_MM, max_duration_s: 60, statics: [], field: model === 'C' ? trailField() : null };
  const plan = planWalk(spec);
  const res = runKinematics({ tracks: [plan.track], statics: [], horizon_s: plan.arrival_t_s ?? 60 });
  return { plan, res, spec };
}

export interface TrailMetrics { arrived: boolean; arrival_s: number | null; along_speed_mm_s: number | null; path_mm: number; amp_mean_mm: number; amp_max_mm: number; fidelity_pct: number; turns: Record<string, number>; dtheta_p50: number; dtheta_p90: number }
/** metrics on the EXECUTED motion. Lateral deviation, fidelity and turns are read on the path resampled at 1 mm of trail. */
export function trailMetrics(segs: Seg[], arrival: number | null, L: number): TrailMetrics {
  const tr: Track = { id: 'm', body: { length_mm: 1, width_mm: 1 }, segs: [...segs, { t0: segs[segs.length - 1].t1, t1: Infinity, p0: poseAt({ id: 'm', body: { length_mm: 1, width_mm: 1 }, segs }, segs[segs.length - 1].t1), tw: { v: 0, vl: 0, w: 0 }, label: 'hold' }] };
  const tEnd = segs[segs.length - 1].t1, n = Math.max(1, Math.ceil(tEnd / 0.0005)), pts: { t: number; x: number; y: number; th: number }[] = [];
  for (let i = 0; i <= n; i++) { const t = (tEnd * i) / n, p = poseAt(tr, t); pts.push({ t, x: p.x, y: p.y, th: p.th }); }
  let path = 0; for (const s of segs) path += Math.hypot(s.tw.v, s.tw.vl) * (s.t1 - s.t0);
  // first crossing of each integer x (trail coordinate)
  const ys: number[] = []; let k = 0;
  for (let X = 0; X <= TRAIL_MM; X++) { while (k + 1 < pts.length && pts[k + 1].x < X) k++; const a = pts[k], b = pts[Math.min(k + 1, pts.length - 1)]; const f = b.x === a.x ? 0 : Math.min(1, Math.max(0, (X - a.x) / (b.x - a.x))); ys.push(a.y + f * (b.y - a.y)); }
  const absy = ys.map(Math.abs), amp = absy.reduce((s, v) => s + v, 0) / absy.length;
  const turns: Record<string, number> = {};
  for (const d of [0.1, 0.5, 1.0]) turns[String(d)] = countReversals(ys, d);
  // heading change per body length of path
  const dth: number[] = []; let lastS = 0, lastTh = pts[0].th, s = 0;
  for (let i = 1; i < pts.length; i++) { s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); if (s - lastS >= L) { dth.push(Math.abs(pts[i].th - lastTh)); lastS = s; lastTh = pts[i].th; } }
  dth.sort((a, b) => a - b);
  const q = (p: number) => (dth.length ? dth[Math.min(dth.length - 1, Math.floor(p * dth.length))] : 0);
  return { arrived: arrival !== null, arrival_s: arrival, along_speed_mm_s: arrival !== null ? TRAIL_MM / arrival : null, path_mm: path, amp_mean_mm: amp, amp_max_mm: Math.max(...absy), fidelity_pct: (100 * absy.filter((v) => v <= 1).length) / absy.length, turns, dtheta_p50: q(0.5), dtheta_p90: q(0.9) };
}
/** direction reversals of the lateral coordinate with hysteresis δ (a turn = the lateral motion changes side by ≥ δ) */
export function countReversals(ys: number[], delta: number): number {
  // dir: +1 rising, −1 falling, 0 undecided (tracking both the running max and min)
  let dir = 0, hi = ys[0], lo = ys[0], n = 0;
  for (const y of ys) {
    if (dir === 0) {
      hi = Math.max(hi, y); lo = Math.min(lo, y);
      if (y <= hi - delta) { dir = -1; lo = y; } else if (y >= lo + delta) { dir = 1; hi = y; }
    } else if (dir > 0) {
      if (y > hi) hi = y; else if (y <= hi - delta) { n++; dir = -1; lo = y; }
    } else if (y < lo) lo = y; else if (y >= lo + delta) { n++; dir = 1; hi = y; }
  }
  return n;
}

// ---------------------------------------------------------------- pose stream (antempire.pose-stream.v1)
export interface PoseStream {
  schema: 'antempire.pose-stream.v1'; scenario_id: string; label: string; seed: number; model: WalkModel | 'mixed'; dt_record_s: number;
  params: Record<string, unknown>;
  agents: { id: string; model: WalkModel; samples: { t: number; x_mm: number; y_mm: number; theta: number; v_mm_s: number; omega_rad_s: number }[]; events: { t: number; kind: string; detail: string }[]; sensor_samples?: unknown[] }[];
  obstacles: Static[]; chem_field: (SyntheticField & Record<string, unknown>) | null;
  notes: string[];
}
const r9 = (x: number) => Math.round(x * 1e9) / 1e9;
export function streamAgent(plan: WalkPlan, res: KinResult, model: WalkModel, dt: number) {
  const id = plan.track.id, ex = res.executed[id], tEnd = ex.segs[ex.segs.length - 1].t1, segs = ex.segs;
  const tr: Track = { id, body: plan.track.body, segs: [...segs, { t0: tEnd, t1: Infinity, p0: res.final[id], tw: { v: 0, vl: 0, w: 0 }, label: 'hold' }] };
  const samples = [];
  for (let k = 0; ; k++) { const t = k * dt; if (t > tEnd + 1e-12) break; const p = poseAt(tr, t), w = t < tEnd ? twistAt(tr, t) : { v: 0, vl: 0, w: 0 }; samples.push({ t: r9(t), x_mm: r9(p.x), y_mm: r9(p.y), theta: r9(p.th), v_mm_s: r9(w.v), omega_rad_s: r9(w.w) }); }
  const events = [
    ...plan.events.filter((e) => ex.stopped_at_s === null || e.t <= ex.stopped_at_s).map((e) => ({ t: r9(e.t), kind: e.kind, detail: e.detail })),
    ...res.events.filter((e) => e.class !== 'motion').map((e) => ({ t: r9(e.t_s), kind: e.kind, detail: `${e.ids.join('|')}${e.detail ? ' ' + e.detail : ''}` })),
  ].sort((a, b) => a.t - b.t || (a.kind < b.kind ? -1 : 1));
  const sensor = model === 'C' ? plan.sensor_samples.filter((s) => s.t <= tEnd).map((s) => ({ t: r9(s.t), left: { x_mm: r9(s.left.x_mm), y_mm: r9(s.left.y_mm), c: r9(s.left.c) }, right: { x_mm: r9(s.right.x_mm), y_mm: r9(s.right.y_mm), c: r9(s.right.c) }, synthetic: true })) : undefined;
  return { id, model, samples, events, ...(sensor ? { sensor_samples: sensor } : {}) };
}

const NOTES = [
  '隔離物理實驗・非正式：不是正式世界、不推進遊戲日、沒有接入每日模擬。',
  '運動模型 A／B／C 都是候選模型；所有參數 assumption:true（見 params）。',
  'samples 是引擎姿態（解析解）在 dt_record_s 格點上的取樣；格點之間的畫面插值不是物理。',
  '頭部偏轉、觸角角度與步態不屬於物理輸出（由顯示層負責，不得回寫）。sensor_samples 只記錄模型 C 的兩個合成感測點與合成濃度值。',
];

export function buildStreams(): PoseStream[] {
  const out: PoseStream[] = [], dt = 0.02, seed = 7, b = body();
  const run = (specs: WalkSpec[], statics: Static[], H: number) => {
    const plans = specs.map((s) => planWalk(s));
    const res = runKinematics({ tracks: plans.map((p) => p.track), statics, horizon_s: Math.min(H, Math.max(...plans.map((p) => (p.arrival_t_s ?? H)))) });
    return { plans, res };
  };
  const base = (id: string, model: WalkModel, y: number, over: Partial<WalkSpec> = {}): WalkSpec => ({ id, body: b, start: { x: 0, y, th: 0 }, t0_s: 0, seed, params: walkParams(model), goal_heading_rad: 0, end_x_mm: TRAIL_MM, max_duration_s: 20, statics: [], field: null, ...over });
  // (1) same ant, straight A vs natural B, side by side (separate layers: they never interact)
  {
    const specs = [base('ant-1', 'A', 0, { layer: 'lane-A' }), base('ant-1-natural', 'B', 8, { layer: 'lane-B' })];
    specs[1] = { ...specs[1], seed };
    const { plans, res } = run(specs, [], 20);
    out.push({ schema: 'antempire.pose-stream.v1', scenario_id: 'straight-vs-natural', label: LABEL, seed, model: 'mixed', dt_record_s: dt, params: { A: paramsDoc(specs[0].params), B: paramsDoc(specs[1].params) }, agents: plans.map((p, i) => streamAgent(p, res, (['A', 'B'] as const)[i], dt)), obstacles: [], chem_field: null, notes: [...NOTES, '兩隻在不同圖層並排顯示，互不碰撞；ant-1-natural 與 ant-1 是同一隻的兩種候選模型，不是兩隻螞蟻。'] });
  }
  // (2) trail following with the synthetic field (C)
  {
    const f = trailField(), spec = base('ant-1', 'C', 0.8, { field: f, start: { x: 0, y: 0.8, th: 0.15 } });
    const { plans, res } = run([spec], [], 20);
    out.push({ schema: 'antempire.pose-stream.v1', scenario_id: 'trail-following-C', label: LABEL, seed, model: 'C', dt_record_s: dt, params: paramsDoc(spec.params), agents: [streamAgent(plans[0], res, 'C', dt)], obstacles: [], chem_field: { ...f, label: '合成濃度場（synthetic: true）；不是費洛蒙模型，CHEM 尚未接入' }, notes: NOTES });
  }
  // (3) exploration of an unknown area (B with wider correlated turning)
  {
    const p = walkParams('B', {}, 'exploration'), spec = base('ant-1', 'B', 0, { params: p, end_x_mm: null, max_duration_s: 12 });
    const { plans, res } = run([spec], [], 12);
    out.push({ schema: 'antempire.pose-stream.v1', scenario_id: 'exploration-B', label: LABEL, seed, model: 'B', dt_record_s: dt, params: paramsDoc(p, 'exploration'), agents: [streamAgent(plans[0], res, 'B', dt)], obstacles: [], chem_field: null, notes: [...NOTES, '探索參數是候選（較寬的相關轉向、無方向回正）；不是本種探索行為的量測。'] });
  }
  // (4) obstacle ahead: antenna contact → turn in place → continue (collision-checked by runKinematics)
  {
    const obst: Static[] = [{ id: 'stone', kind: 'disc', c: { x: 25, y: 0.6 }, r: 3 }];
    const spec = base('ant-1', 'B', 0, { statics: obst, end_x_mm: 60, max_duration_s: 15 });
    const { plans, res } = run([spec], obst, 15);
    out.push({ schema: 'antempire.pose-stream.v1', scenario_id: 'obstacle-turn', label: LABEL, seed, model: 'B', dt_record_s: dt, params: paramsDoc(spec.params), agents: [streamAgent(plans[0], res, 'B', dt)], obstacles: obst, chem_field: null, notes: [...NOTES, '障礙物只經由觸角尖端碰觸感知（候選）；身體與障礙的碰撞由連續碰撞檢查（runKinematics）處理，若身體碰到會停下並記錄事件。'] });
  }
  return out;
}

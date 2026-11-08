/**
 * antempire.pose-stream.v1 — the body-trajectory export of the physics prototype (PR A, kinematics2d). This module only
 * READS such files: validation, interpolation between two recorded samples (labelled 顯示插值 on the page), and the
 * display-motion context derived from the physics data. DOM-free (the Node test imports it).
 * Schema (PR A): { schema, scenario_id, label, seed, model: 'A'|'B'|'C', dt_record_s, params, agents: [{ id,
 *   samples: [{ t, x_mm, y_mm, theta, v_mm_s, omega_rad_s }], events: [{ t, kind, detail }] }], obstacles, chem_field|null }
 * World frame: mm, x east, y north, theta = heading (rad, counter-clockwise from +x), omega = dθ/dt.
 * Obstacles: discs {kind:'disc', c:{x,y}, r} (PR A) or {x_mm,y_mm,r_mm}; polygons {points_mm} or {points:[{x,y}]}.
 * chem_field: PR A's synthetic {kind:'gaussian_ridge', polyline:[{x,y}], sigma_mm} (labelled synthetic, not a pheromone
 * model) or the placeholder trail {points_mm, half_width_mm}. Other shapes are not drawn (never guessed).
 */
export const POSE_SCHEMA = 'antempire.pose-stream.v1';
export interface PoseSample { t: number; x_mm: number; y_mm: number; theta: number; v_mm_s: number; omega_rad_s: number }
export interface PoseEvent { t: number; kind: string; detail: unknown }
export interface PoseAgent { id: string; model?: 'A' | 'B' | 'C'; samples: PoseSample[]; events: PoseEvent[]; sensor_samples?: unknown[] }
export interface PoseStream {
  schema: string; scenario_id: string; label: string; seed: number; model: 'A' | 'B' | 'C' | 'mixed'; dt_record_s: number;
  params: Record<string, unknown>; agents: PoseAgent[]; obstacles: unknown[]; chem_field: unknown | null;
}
export type Circle = { x_mm: number; y_mm: number; r_mm: number };
export type Polygon = { points_mm: [number, number][] };

/** Structural validation; returns the list of problems (empty = valid). */
export function validatePoseStream(o: unknown): string[] {
  const bad: string[] = [], s = o as Partial<PoseStream>;
  if (!s || typeof s !== 'object') return ['not an object'];
  if (s.schema !== POSE_SCHEMA) bad.push(`schema ${String(s.schema)}`);
  for (const k of ['scenario_id', 'label'] as const) if (typeof s[k] !== 'string' || !s[k]) bad.push(`${k} missing`);
  if (!Number.isFinite(s.seed)) bad.push('seed');
  if (!['A', 'B', 'C', 'mixed'].includes(s.model as string)) bad.push(`model ${String(s.model)}`); // 'mixed': per-agent model (PR A)
  if (!(Number(s.dt_record_s) > 0)) bad.push('dt_record_s');
  if (!s.params || typeof s.params !== 'object') bad.push('params');
  if (!Array.isArray(s.obstacles)) bad.push('obstacles');
  if (!('chem_field' in s)) bad.push('chem_field missing (null allowed)');
  if (!Array.isArray(s.agents) || !s.agents.length) bad.push('agents');
  for (const a of s.agents ?? []) {
    if (typeof a.id !== 'string') bad.push('agent id');
    if (!Array.isArray(a.samples) || a.samples.length < 2) { bad.push(`${a.id}: samples`); continue; }
    if (!Array.isArray(a.events)) bad.push(`${a.id}: events`);
    let tPrev = -Infinity;
    for (const x of a.samples) {
      if (!['t', 'x_mm', 'y_mm', 'theta', 'v_mm_s', 'omega_rad_s'].every((k) => Number.isFinite((x as unknown as Record<string, number>)[k]))) { bad.push(`${a.id}: non-finite sample at t=${x.t}`); break; }
      if (!(x.t > tPrev)) { bad.push(`${a.id}: samples not strictly increasing in t at ${x.t}`); break; }
      tPrev = x.t;
    }
  }
  return bad;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Pose at time t: a recorded sample, or linear interpolation between the two around t (θ along the shorter arc).
 *  Clamped to the first / last sample. `interpolated` = strictly between two samples. */
export function sampleAt(a: PoseAgent, t: number): PoseSample & { interpolated: boolean; index: number } {
  const S = a.samples;
  if (t <= S[0].t) return { ...S[0], interpolated: false, index: 0 };
  if (t >= S[S.length - 1].t) return { ...S[S.length - 1], interpolated: false, index: S.length - 1 };
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].t <= t) lo = m; else hi = m; }
  const p = S[lo], q = S[hi], f = (t - p.t) / (q.t - p.t);
  if (f === 0) return { ...p, interpolated: false, index: lo };
  return { t, x_mm: p.x_mm + (q.x_mm - p.x_mm) * f, y_mm: p.y_mm + (q.y_mm - p.y_mm) * f, theta: p.theta + wrap(q.theta - p.theta) * f, v_mm_s: p.v_mm_s + (q.v_mm_s - p.v_mm_s) * f, omega_rad_s: p.omega_rad_s + (q.omega_rad_s - p.omega_rad_s) * f, interpolated: true, index: lo };
}
/** Cumulative path length (mm) at each recorded sample — drives the gait phase (stride from distance travelled). */
export function cumulativeDistance(a: PoseAgent): number[] {
  const out = [0];
  for (let i = 1; i < a.samples.length; i++) out.push(out[i - 1] + Math.hypot(a.samples[i].x_mm - a.samples[i - 1].x_mm, a.samples[i].y_mm - a.samples[i - 1].y_mm));
  return out;
}
export function distanceAt(a: PoseAgent, cum: readonly number[], t: number): number {
  const s = sampleAt(a, t), i = s.index, p = a.samples[i];
  return cum[i] + (s.interpolated ? Math.hypot(s.x_mm - p.x_mm, s.y_mm - p.y_mm) : 0);
}
/** obstacle as a circle (mm), from either supported form, or null */
export function asCircle(o: unknown): Circle | null {
  const r = o as Record<string, unknown> & { c?: { x: number; y: number } };
  if (!r || typeof r !== 'object') return null;
  if (['x_mm', 'y_mm', 'r_mm'].every((k) => Number.isFinite(r[k] as number))) return { x_mm: r.x_mm as number, y_mm: r.y_mm as number, r_mm: r.r_mm as number };
  if (r.c && Number.isFinite(r.c.x) && Number.isFinite(r.c.y) && Number.isFinite(r.r as number)) return { x_mm: r.c.x, y_mm: r.c.y, r_mm: r.r as number };
  return null;
}
export function asPolygon(o: unknown): Polygon | null {
  const r = o as { points_mm?: [number, number][]; points?: { x: number; y: number }[] };
  if (!r || typeof r !== 'object') return null;
  if (Array.isArray(r.points_mm) && r.points_mm.length >= 3) return { points_mm: r.points_mm };
  if (Array.isArray(r.points) && r.points.length >= 3) return { points_mm: r.points.map((p) => [p.x, p.y]) };
  return null;
}
export const isCircle = (o: unknown): boolean => asCircle(o) !== null;
export const isPolygon = (o: unknown): boolean => asPolygon(o) !== null;
/** chem field as a drawable band (polyline + half width, mm) or null */
export function chemBand(cf: unknown): { points: [number, number][]; halfWidth: number; synthetic: boolean; label: string } | null {
  const c = cf as { points_mm?: [number, number][]; half_width_mm?: number; polyline?: { x: number; y: number }[]; sigma_mm?: number; synthetic?: boolean; label?: string } | null;
  if (!c || typeof c !== 'object') return null;
  if (Array.isArray(c.points_mm)) return { points: c.points_mm, halfWidth: c.half_width_mm ?? 2, synthetic: !!c.synthetic, label: c.label ?? '' };
  if (Array.isArray(c.polyline)) return { points: c.polyline.map((p) => [p.x, p.y]), halfWidth: 2 * (c.sigma_mm ?? 1), synthetic: !!c.synthetic, label: c.label ?? '' };
  return null;
}
function segDist(px: number, py: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2)) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
/** distance (mm) from a point to the nearest supported obstacle surface (Infinity when there is none) */
export function obstacleDistance(obstacles: readonly unknown[], x: number, y: number): number {
  let d = Infinity;
  for (const ob of obstacles) {
    const o = asCircle(ob), q = asPolygon(ob);
    if (o) d = Math.min(d, Math.max(0, Math.hypot(x - o.x_mm, y - o.y_mm) - o.r_mm));
    else if (q) { const P = q.points_mm; for (let i = 0; i < P.length; i++) d = Math.min(d, segDist(x, y, P[i], P[(i + 1) % P.length])); }
  }
  return d;
}
/** distance (mm) within which an obstacle counts as near for the display context (示意) */
export const NEAR_MM = 6;
/** Raw display-motion context sample from the physics data at time t (screen heading = −θ: screen y points down). */
export function rawFromStream(s: PoseStream, a: PoseAgent, t: number) {
  const p = sampleAt(a, t), d = obstacleDistance(s.obstacles, p.x_mm, p.y_mm);
  return { moving: Math.min(1, Math.max(0, p.v_mm_s / 3)), heading: -p.theta, near: Number.isFinite(d) ? Math.max(0, 1 - d / NEAR_MM) : 0, explore: s.params?.mode === 'explore' || /explor/i.test(s.scenario_id) ? 1 : 0 };
}
/** The four comparison scenes the Owner asked for and the scenario_id keyword that selects a file for each. */
export const SCENES = [
  { slot: 'straight', match: /straight|直線/i, title: '① 直線基準（A） vs 自然行走候選（B）', note: '同一條身體軌跡畫兩次：上＝無顯示微動作，下＝有頭部、觸角與步態過渡。' },
  { slot: 'trail', match: /trail|pheromone|費洛蒙/i, title: '② 沿化學路徑前進（小幅修正）', note: '身體的修正來自物理資料（沿化學場）；頭與觸角是顯示動畫。' },
  { slot: 'explore', match: /explor|search|探索/i, title: '③ 探索未知區域（觸角、頭部較活躍）', note: '探索情境：觸角較多掃動與點地、頭部較多轉看（示意）。' },
  { slot: 'obstacle', match: /obstacle|障礙/i, title: '④ 接近障礙物、真的轉向再繼續', note: '轉向是物理資料的 θ／ω；靠近障礙時觸角較多前探與點地（示意）。' },
] as const;
export type SceneSlot = typeof SCENES[number]['slot'];
export const slotOf = (s: Pick<PoseStream, 'scenario_id'>): SceneSlot | null => SCENES.find((x) => x.match.test(s.scenario_id))?.slot ?? null;
export const isPlaceholder = (s: PoseStream) => s.params?.placeholder === true;

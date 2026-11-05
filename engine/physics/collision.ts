/**
 * PH-2 / PH-3 (Issue #68), first working version: local collision, contact and mechanical limits for ants moving on
 * PH-1 lanes with MV-1 kinematics. Event-driven and exact in time (no fixed step, so nothing can tunnel).
 *
 * Three kinds of interaction are kept apart (Issue #68):
 *  A. Physical obstruction — two bodies cannot occupy the same space. On one lane a body is the interval
 *     [s − L/2, s + L/2] (L = body length) with a width w. Two bodies may overlap along the lane only where the usable
 *     width (passage width, narrowed by obstacles at the lane's level) is ≥ wA + wB; elsewhere they obstruct. Across
 *     lanes a body is a disc of radius L/2 (bounding circle of the capsule; conservative).
 *  B. Biological contact — an EVENT with time and position: the two bodies come within antennal reach. A contact does
 *     not imply any behaviour. On a lane wider than wA + wB + 2·reach the lateral offset of the two ants is not modelled,
 *     so the contact is marked `certain: false` (possible, not certain).
 *  C. Mechanical interaction — an ant's effective width is max(body width, carried load width); a passage section or a
 *     nest-entrance aperture narrower than that stops it. A carried object has exactly one holder (no double carrying).
 *
 * Responses (model choices; NOT species data — see interaction-candidates file):
 *  - same direction in a single-file section: the rear ant cannot pass; it walks no faster than the ant in front
 *    (a physical consequence, not a slow-down factor);
 *  - head-on in a single-file section: one ant backs out to the end of the narrow section it came from, waits until the
 *    other has passed, then continues. Which one: the one with the shorter way back (candidate rule, game assumption);
 *    exact ties are broken by a named random stream keyed by the sorted pair of ids, never by array order;
 *  - across lanes (e.g. at a crossing): the ant that has the other more directly ahead stops until the other's body has
 *    cleared; ties as above.
 *  - Turning around takes no time; backing out is at the ant's own free speed; passing abreast in a wide section costs no
 *    time; no slow-down from load, slope or temperature (no species data; stated limits).
 *  - NOT LOCAL (CLAUDE.md §2.1, disclosed): choosing who yields compares both ants (way back; cosines), and the crossing
 *    back-out and resume use the other ant's remaining path. These are pairwise engineering solvers, not information an
 *    ant could sense; they must be replaced or backed by evidence before joining the official model.
 *  - Cost: every event step re-evaluates all agents and all broadphase pairs, so wall time grows roughly with N² on dense
 *    lattices (measured 250/500/1000 ants: ≈0.75/1.8/7.9 s for 5 simulated s); an event queue with local invalidation is
 *    the next step for 10⁴ ants. Narrow-section boundaries are precomputed per distinct pair of widths, analytically (Codex physics review F2).
 *  - A configuration this version cannot resolve (e.g. a backing-out ant blocked from behind) is reported as an
 *    `unresolved` event and the ants involved stop: never an overlap, never a silent fix.
 *
 * Broadphase: uniform grid over conservative per-window reach discs (exactly equivalent to brute force; tested).
 * The module moves bodies only. It never reads or changes food, crops, brood or population (Issue #68: contact →
 * behaviour → nutrition is a later chain; this is the contact end of it).
 */
import type { Vec3 } from './vec.ts';
import { type PhysicsGeometry, type Passage, obstacleDistance, obstacleReachesLevel, physicsReady, validateGeometry, arcPositionOf, ON_TOLERANCE_MM } from './geometry.ts';
import { type MotionInterval, positionAt, headingAt, vertexArcs, laneLength, passageOf, T_EPS, S_EPS } from './kinematics.ts';
import { pointSegment2D } from './vec.ts';
import { hash32, rng } from '../rng.ts';

export const COLLISION_MODEL_REF = 'PH-2 v0: lane bodies (interval along lane + width), discs across lanes, antennal-reach contact, single-file follow/back-out yield (candidate rules)';
/** Numerical hysteresis for leaving a contact (mm): not a model parameter. */
const CONTACT_EXIT_EPS = 1e-6;
/** Distance kept outside a narrow-section boundary when backing out (mm): numerical, not a model parameter. */
const EDGE_EPS = 1e-6;
/** Cross-lane bodies count as on one height layer a little before the checker's |dz| ≤ L limit, so that an ant meeting
 *  another by changing height is stopped while the two are still apart (mm; numerical, not a model parameter). */
const LEVEL_EPS = 1e-6;

export interface PhysBody { length_mm: number; width_mm: number; contact_reach_mm: number }
export interface PhysObject { id: string; width_mm: number; holder: string | null }
export interface SimAgentSpec {
  id: string; passage: string; s_mm: number; dir: 1 | -1; start_t_s: number;
  free_speed_mm_s: number; goal_s_mm: number; body: PhysBody; load: string | null;
}
export interface SimConfig {
  geometry: PhysicsGeometry; agents: SimAgentSpec[]; objects?: PhysObject[];
  horizon_s: number; seed: number;
  /** broadphase window (s); any positive value gives the same events (tested) */
  window_s?: number;
  /** spacing (mm) of the numerical scans that remain: the 'cleared' time and the back-out target. Narrow-section
   *  boundaries are analytic and do not use it (Codex physics review F2). */
  boundary_step_mm?: number;
}
export type PhysEventKind = 'start' | 'arrive' | 'contact_start' | 'contact_end' | 'obstruction' | 'follow_start' | 'follow_end' | 'yield_start' | 'yield_hold' | 'yield_resume' | 'cross_wait' | 'cross_resume' | 'blocked' | 'unresolved';
export interface PhysEvent {
  t_s: number; kind: PhysEventKind; agent: string; other: string | null; passage: string; s_mm: number;
  position_mm: [number, number, number]; certain: boolean | null; detail: string | null; model_ref: string;
}
type Mode = 'idle' | 'free' | 'follow' | 'retreat' | 'yield_wait' | 'cross_wait' | 'blocked' | 'arrived' | 'unresolved';
export interface SimResult {
  intervals: Record<string, MotionInterval[]>;
  events: PhysEvent[];
  final: Record<string, { s_mm: number; mode: Mode; t_s: number }>;
  stats: { windows: number; steps: number; pair_evaluations: number; t_end_s: number };
}

// ---------------------------------------------------------------- geometry helpers

/** Usable width (mm) of a passage at arc length s: the passage width, narrowed by obstacles at the lane's level. */
export function usableWidth(g: PhysicsGeometry, p: Passage, s: number): number {
  const q = positionAt(p, s);
  let w = p.width_mm ?? 0;
  for (const o of g.obstacles) if (obstacleReachesLevel(o, q.z, q.z)) w = Math.min(w, 2 * Math.max(0, obstacleDistance(o, q)));
  return w;
}

/**
 * Sections [a, b] of a passage where the usable width is < T (Codex physics review f61db12, F2: found analytically, not by
 * sampling). Along each centre-line segment the lane point moves linearly, so every place where "usable width < T" can
 * switch is a root of a known equation: the circle |q − c| = r + T/2, the polygon's vertex discs and edge strips at T/2,
 * the polygon's edges (inside / outside), and the obstacle's height range on a sloped segment. Between consecutive
 * candidate points the predicate is constant and is evaluated once with usableWidth itself (the same definition the
 * exclusion checker uses), so a narrowing of any length is found. `_step` is kept for the API and is not used.
 */
export function narrowSections(g: PhysicsGeometry, p: Passage, T: number, _step = 0.01): [number, number][] {
  const L = laneLength(p), f = (s: number) => usableWidth(g, p, s) < T, d = T / 2, cuts: number[] = [0, L];
  const pts = p.centerline_mm.map(([x, y, z]) => ({ x, y, z }));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1], B = pts[i], Ls = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    if (Ls === 0) continue;
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, add = (u: number) => { if (u > 0 && u < 1 && Number.isFinite(u)) cuts.push(acc + u * Ls); };
    const lin = (c0: number, c1: number) => { if (c1 !== 0) add(-c0 / c1); };                       // c0 + c1·u = 0
    const disc = (cx: number, cy: number, R: number) => {                                            // |A + u·D − c| = R
      const ex = A.x - cx, ey = A.y - cy, a = dx * dx + dy * dy, b = 2 * (ex * dx + ey * dy), c = ex * ex + ey * ey - R * R;
      if (a === 0) return; const D = b * b - 4 * a * c; if (D < 0) return; const r = Math.sqrt(D); add((-b - r) / (2 * a)); add((-b + r) / (2 * a));
    };
    for (const o of g.obstacles) {
      if (o.base_z_mm !== null) {                                                                    // height range on a slope
        const top = o.height_mm === null ? Infinity : o.base_z_mm + o.height_mm;
        if (dz !== 0) { lin(A.z - (o.base_z_mm - ON_TOLERANCE_MM), dz); if (Number.isFinite(top)) lin(A.z - (top + ON_TOLERANCE_MM), dz); }
      }
      if (o.shape.type === 'circle') { disc(o.shape.center_mm[0], o.shape.center_mm[1], o.shape.radius_mm + d); continue; }
      const poly = o.shape.points_mm;
      for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
        const P = { x: poly[j][0], y: poly[j][1] }, Q = { x: poly[k][0], y: poly[k][1] }, ex = Q.x - P.x, ey = Q.y - P.y, el = Math.hypot(ex, ey);
        disc(P.x, P.y, d);                                                                           // vertex discs
        if (el === 0) continue;
        const nx = -ey / el, ny = ex / el;
        lin(nx * (A.x - P.x) + ny * (A.y - P.y) - d, nx * dx + ny * dy);                             // edge strip ±T/2
        lin(nx * (A.x - P.x) + ny * (A.y - P.y) + d, nx * dx + ny * dy);
        lin(((A.x - P.x) * ex + (A.y - P.y) * ey) / (el * el), (dx * ex + dy * ey) / (el * el));     // strip ends (projection 0, 1)
        lin(((A.x - P.x) * ex + (A.y - P.y) * ey) / (el * el) - 1, (dx * ex + dy * ey) / (el * el));
        lin(nx * (A.x - P.x) + ny * (A.y - P.y), nx * dx + ny * dy);                                 // crossing the edge's line (inside/outside)
      }
    }
    acc += Ls;
    cuts.push(acc);
  }
  const xs = [...new Set(cuts.filter((x) => x >= 0 && x <= L))].sort((a, b) => a - b), out: [number, number][] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1], b = xs[i];
    if (!(b > a) || !f((a + b) / 2)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - a) <= 1e-12) last[1] = b; else out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------- broadphase

export interface ReachDisc { id: string; x: number; y: number; r: number }
/** Pairs (sorted ids) of discs that overlap, via a uniform grid of the given cell size. Same result as bruteForcePairs. */
export function gridPairs(items: readonly ReachDisc[], cell: number): [string, string][] {
  if (!(cell > 0)) throw Error('PHYSICS: grid cell must be positive');
  const grid = new Map<string, number[]>();
  items.forEach((it, i) => {
    for (let gx = Math.floor((it.x - it.r) / cell); gx <= Math.floor((it.x + it.r) / cell); gx++)
      for (let gy = Math.floor((it.y - it.r) / cell); gy <= Math.floor((it.y + it.r) / cell); gy++) {
        const k = `${gx},${gy}`, l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
      }
  });
  const seen = new Set<string>(), out: [string, string][] = [];
  for (const l of grid.values()) for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) {
    const A = items[l[a]], B = items[l[b]], key = A.id < B.id ? `${A.id}\u0000${B.id}` : `${B.id}\u0000${A.id}`;
    if (seen.has(key)) continue; seen.add(key);
    if (Math.hypot(A.x - B.x, A.y - B.y) <= A.r + B.r) out.push(A.id < B.id ? [A.id, B.id] : [B.id, A.id]);
  }
  return out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
}
export function bruteForcePairs(items: readonly ReachDisc[]): [string, string][] {
  const out: [string, string][] = [];
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const A = items[a], B = items[b];
    if (Math.hypot(A.x - B.x, A.y - B.y) <= A.r + B.r) out.push(A.id < B.id ? [A.id, B.id] : [B.id, A.id]);
  }
  return out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
}

// ---------------------------------------------------------------- object registry (no double carrying)

export function pickUp(objects: readonly PhysObject[], objectId: string, agentId: string): PhysObject[] {
  const o = objects.find((x) => x.id === objectId);
  if (!o) throw Error(`PHYSICS: object ${objectId} does not exist (objects are never created here)`);
  if (o.holder !== null && o.holder !== agentId) throw Error(`PHYSICS: object ${objectId} is already carried by ${o.holder} (no double carrying)`);
  if (objects.some((x) => x.id !== objectId && x.holder === agentId)) throw Error(`PHYSICS: ${agentId} already carries another object`);
  return objects.map((x) => (x.id === objectId ? { ...x, holder: agentId } : x));
}
export function drop(objects: readonly PhysObject[], objectId: string, agentId: string): PhysObject[] {
  const o = objects.find((x) => x.id === objectId);
  if (!o || o.holder !== agentId) throw Error(`PHYSICS: ${agentId} does not hold ${objectId}`);
  return objects.map((x) => (x.id === objectId ? { ...x, holder: null } : x));
}

// ---------------------------------------------------------------- simulation

interface RT {
  id: string; spec: SimAgentSpec; p: Passage; L: number; w: number; reach: number; free: number; travel: 1 | -1;
  s: number; v: number; mode: Mode; partner: string | null; retreat_s: number | null;
  /** backing out across lanes (then waits for the other to clear) / standing still until the other has made room */
  crossRetreat: boolean; waitRoom: boolean;
  open: { t: number; s: number; v: number; cause: string | null; ref: string | null };
  ivs: MotionInterval[];
}
const sgn = (x: number): -1 | 0 | 1 => (x > 0 ? 1 : x < 0 ? -1 : 0);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function simulate(cfg: SimConfig): SimResult {
  const g = cfg.geometry, H = cfg.window_s ?? 1, step = cfg.boundary_step_mm ?? 0.01;
  const issues = validateGeometry(g);
  if (issues.length) throw Error(`PHYSICS: invalid geometry: ${issues.map((i) => `${i.code} ${i.ref}`).join('; ')}`);
  if (!(cfg.horizon_s > 0) || !(H > 0)) throw Error('PHYSICS: horizon and window must be positive');
  // objects: every load must exist and be held by exactly that agent; nothing is created
  const objects = (cfg.objects ?? []).map((o) => ({ ...o }));
  const ids = new Set<string>();
  for (const a of cfg.agents) { if (ids.has(a.id)) throw Error(`PHYSICS: duplicate agent ${a.id}`); ids.add(a.id); }
  const loads = new Map<string, string>();
  for (const a of cfg.agents) if (a.load !== null) {
    const o = objects.find((x) => x.id === a.load);
    if (!o) throw Error(`PHYSICS: ${a.id} carries unknown object ${a.load}`);
    if (loads.has(a.load)) throw Error(`PHYSICS: object ${a.load} carried by both ${loads.get(a.load)} and ${a.id} (no double carrying)`);
    if (o.holder !== a.id) throw Error(`PHYSICS: object ${a.load} holder is ${o.holder}, not ${a.id}`);
    loads.set(a.load, a.id);
  }
  for (const o of objects) if (o.holder !== null && loads.get(o.id) !== o.holder) throw Error(`PHYSICS: object ${o.id} holder ${o.holder} does not carry it`);

  // canonical agent order: by id (never input order)
  const rts: RT[] = [...cfg.agents].sort((a, b) => (a.id < b.id ? -1 : 1)).map((sp) => {
    const p = passageOf(g, sp.passage), Lp = laneLength(p);
    const ready = physicsReady(g, p.id);
    if (!ready.ready) throw Error(`PHYSICS: passage ${p.id} has unknown geometry: ${ready.unknown.join(', ')}`);
    if (!(sp.free_speed_mm_s > 0) || !(sp.body.length_mm > 0) || !(sp.body.width_mm > 0) || !(sp.body.contact_reach_mm >= 0)) throw Error(`PHYSICS: ${sp.id} needs positive speed, body length and width, non-negative reach`);
    if (sp.s_mm < 0 || sp.s_mm > Lp || sp.goal_s_mm < 0 || sp.goal_s_mm > Lp || (sp.goal_s_mm - sp.s_mm) * sp.dir < 0) throw Error(`PHYSICS: ${sp.id} start/goal inconsistent with passage ${p.id} and direction`);
    const lw = sp.load === null ? 0 : objects.find((o) => o.id === sp.load)!.width_mm;
    return { id: sp.id, spec: sp, p, L: sp.body.length_mm, w: Math.max(sp.body.width_mm, lw), reach: sp.body.contact_reach_mm, free: sp.free_speed_mm_s, travel: sp.dir, s: sp.s_mm, v: 0, mode: 'idle', partner: null, retreat_s: null, crossRetreat: false, waitRoom: false, open: { t: 0, s: sp.s_mm, v: 0, cause: 'not_started', ref: null }, ivs: [] };
  });
  const byId = new Map(rts.map((a) => [a.id, a]));
  const events: PhysEvent[] = [];
  const stats = { windows: 0, steps: 0, pair_evaluations: 0, t_end_s: 0 };
  const yielder = (sp: { seed: number }, a: string, b: string) => { const [x, y] = a < b ? [a, b] : [b, a]; return rng(hash32(`${sp.seed}|physics.yield|${x}|${y}`))() < 0.5 ? x : y; };

  // narrow sections per (passage, threshold), cached
  const secCache = new Map<string, [number, number][]>();
  const sections = (p: Passage, T: number) => { const k = `${p.id}|${T}`; let v = secCache.get(k); if (!v) { v = narrowSections(g, p, T, step); secCache.set(k, v); } return v; };
  const narrowAt = (p: Passage, T: number, s: number) => sections(p, T).some(([a, b]) => a <= s + 1e-9 && b >= s - 1e-9);
  const narrowOver = (p: Passage, T: number, lo: number, hi: number) => sections(p, T).some(([a, b]) => a < hi - 1e-9 && b > lo + 1e-9);
  const sectionAt = (p: Passage, T: number, s: number) => sections(p, T).find(([a, b]) => a <= s + 1e-9 && b >= s - 1e-9) ?? null;
  // every boundary an agent's leading edge may cross (all pair thresholds and its own width) for re-check events
  const widths = [...new Set(rts.map((a) => a.w))].sort((a, b) => a - b);
  const boundaries = new Map<string, number[]>();
  for (const a of rts) {
    const key = `${a.p.id}|${a.w}`;
    if (boundaries.has(key)) continue;
    const Ts = [a.w, ...widths.map((w) => a.w + w)];
    boundaries.set(key, [...new Set(Ts.flatMap((T) => sections(a.p, T).flat()))].sort((x, y) => x - y));
  }
  const entranceBlocksOf = (a: RT) => g.entrances.filter((e) => e.passage_ref === a.p.id && e.aperture_width_mm !== null && e.aperture_width_mm < a.w).map((e) => ({ id: e.id, s: arcPositionOf(a.p, { x: e.position_mm[0], y: e.position_mm[1] }), ap: e.aperture_width_mm as number }));

  const eCache = new Map<string, { id: string; s: number; ap: number }[]>();
  const entranceBlocks = (a: RT) => { let v = eCache.get(a.id); if (!v) { v = entranceBlocksOf(a); eCache.set(a.id, v); } return v; };
  const pos = (a: RT) => positionAt(a.p, a.s);
  const ev = (t: number, kind: PhysEventKind, a: RT, other: RT | null, detail: string | null, certain: boolean | null = null) => {
    const q = pos(a), o = other ? pos(other) : q, m: [number, number, number] = [(q.x + o.x) / 2, (q.y + o.y) / 2, (q.z + o.z) / 2];
    events.push({ t_s: t, kind, agent: a.id, other: other?.id ?? null, passage: a.p.id, s_mm: a.s, position_mm: m, certain, detail, model_ref: COLLISION_MODEL_REF });
  };
  // ---- trajectory records (MV-1 MotionInterval format)
  const close = (a: RT, t: number) => {
    const o = a.open;
    if (t - o.t > T_EPS || Math.abs(a.s - o.s) > S_EPS) {
      const moving = o.v !== 0, dir = (moving ? sgn(o.v) : a.travel) as 1 | -1, st = positionAt(a.p, o.s), en = positionAt(a.p, a.s);
      const h = moving ? headingAt(a.p, o.s, dir) : null;
      a.ivs.push({ agent: a.id, passage: a.p.id, kind: moving ? 'move' : o.cause === null ? 'stop' : 'wait', cause: moving ? (o.cause === 'free' ? null : o.cause) : o.cause, cause_ref: o.ref, t_start_s: o.t, t_end_s: t, s_start_mm: o.s, s_end_mm: a.s, distance_mm: Math.abs(a.s - o.s), speed_mm_s: Math.abs(o.v), dir, heading: h ? [h.x, h.y, h.z] : null, start_mm: [st.x, st.y, st.z], end_mm: [en.x, en.y, en.z], model_ref: COLLISION_MODEL_REF });
    }
  };
  const setMotion = (a: RT, t: number, v: number, cause: string | null, ref: string | null) => {
    if (a.open.v === v && a.open.cause === cause && a.open.ref === ref) { a.v = v; return; }
    close(a, t); a.open = { t, s: a.s, v, cause, ref }; a.v = v;
  };
  const split = (a: RT, t: number) => { close(a, t); a.open = { ...a.open, t, s: a.s }; };
  const modeMotion = (a: RT, t: number) => {
    switch (a.mode) {
      case 'free': return setMotion(a, t, a.travel * a.free, 'free', null);
      case 'retreat': return setMotion(a, t, -a.travel * a.free, 'yield_back_out', a.partner);
      case 'yield_wait': return setMotion(a, t, 0, 'yield', a.partner);
      case 'cross_wait': return setMotion(a, t, 0, 'yield', a.partner);
      case 'blocked': return setMotion(a, t, 0, 'blocked', a.partner);
      case 'unresolved': return setMotion(a, t, 0, 'unresolved', a.partner);
      case 'arrived': return setMotion(a, t, 0, null, null);
      case 'idle': return setMotion(a, t, 0, 'not_started', null);
      case 'follow': return; // set by resolveFollow
    }
  };
  // ---- geometry of a pair on one lane
  const M = (a: RT, b: RT) => (a.L + b.L) / 2;
  const C = (a: RT, b: RT) => (a.L + b.L) / 2 + Math.max(a.reach, b.reach);
  const lateralCertain = (a: RT, b: RT) => usableWidth(g, a.p, a.s) < a.w + b.w + 2 * Math.max(a.reach, b.reach);
  /** the narrow region two touching or overlapping lane bodies share (null when they do not touch) */
  const overlap = (a: RT, b: RT): [number, number] | null => { const lo = Math.max(a.s - a.L / 2, b.s - b.L / 2), hi = Math.min(a.s + a.L / 2, b.s + b.L / 2); return hi >= lo - 1e-9 ? [lo, hi] : null; };
  const pinched = (a: RT, b: RT) => { const o = overlap(a, b); return !!o && (o[1] - o[0] <= 1e-9 ? narrowAt(a.p, a.w + b.w, (o[0] + o[1]) / 2) : narrowOver(a.p, a.w + b.w, o[0], o[1])); };
  const sameLane = (a: RT, b: RT) => a.p.id === b.p.id;
  const terminal = (a: RT) => a.mode === 'arrived' || a.mode === 'blocked' || a.mode === 'unresolved';

  // ---- follow resolution: a follower walks no faster than the body in front of it (chains resolved in order)
  const resolveFollow = (t: number) => {
    for (let iter = 0; iter <= rts.length; iter++) {
      let changed = false;
      for (const f of rts) {
        if (f.mode !== 'follow') continue;
        const ld = byId.get(f.partner!)!, gap = Math.abs(ld.s - f.s), m = f.travel, mm = M(f, ld);
        const ahead = (ld.s - f.s) * m > 0, touching = gap >= mm - 1e-9, vAlong = ld.v * m;
        const end = (why: string) => { f.mode = 'free'; f.partner = null; ev(t, 'follow_end', f, ld, why); modeMotion(f, t); changed = true; };
        if (touching && !ahead) { end('nothing in front any more'); continue; }
        if (touching && !narrowAt(f.p, f.w + ld.w, f.s + m * f.L / 2)) { end('wide enough to pass'); continue; }
        if (touching && vAlong >= f.free) { end('front ant walks at least as fast'); continue; }
        // still overlapping (held at a narrow entry) or touching in a single-file section: never faster than the body in front
        const nv = touching ? m * Math.max(0, Math.min(f.free, vAlong)) : 0;
        if (f.v !== nv || (f.open.cause !== 'follow' && f.open.cause !== 'blocked_by')) { setMotion(f, t, nv, nv === 0 ? 'blocked_by' : 'follow', ld.id); changed = true; }
      }
      if (!changed) return;
    }
  };

  // ---- stuck detection: a standing waiter whose partner has stopped for good, or a ring of standing waiters, can never
  // move again in this version: report it as `unresolved` (never a silent wait)
  const WAIT_MODES = new Set<Mode>(['follow', 'yield_wait', 'cross_wait']);
  const detectStuck = (t: number) => {
    for (let changed = true; changed;) {
      changed = false;
      for (const a of rts) {
        if (!WAIT_MODES.has(a.mode) || a.v !== 0 || !a.partner) continue;
        const p = byId.get(a.partner)!;
        if (terminal(p)) { unresolved(t, a, p, `waits for ${p.id}, which has stopped for good (${p.mode})`); changed = true; continue; }
        const ring: RT[] = [a];
        let q = p;
        while (WAIT_MODES.has(q.mode) && q.v === 0 && q.partner && !ring.includes(q)) { ring.push(q); q = byId.get(q.partner)!; }
        if (q === a && ring.length > 1) { for (let i = 0; i < ring.length; i++) if (!terminal(ring[i])) unresolved(t, ring[i], ring[(i + 1) % ring.length], `mutual wait (${ring.map((r) => r.id).join(' → ')} → ${a.id})`); changed = true; }
      }
    }
  };

  // ---- event prediction
  interface Cand { t: number; kind: string; a: string; b: string | null; data?: number }
  const linRoot = (d0: number, rate: number, target: number) => { if (rate === 0) return Infinity; const dt = (target - d0) / rate; return dt >= 0 ? dt : Infinity; };
  const intrinsic = (a: RT, t: number, out: Cand[]) => {
    if (a.mode === 'idle') { out.push({ t: Math.max(t, a.spec.start_t_s), kind: 'start', a: a.id, b: null }); return; }
    if (a.v === 0) return;
    const m = sgn(a.v), lead = a.s + m * a.L / 2;
    const at = (x: number, kind: string, data?: number) => { const dt = (x - a.s) / a.v; if (dt > T_EPS || (dt >= 0 && Math.abs(x - a.s) > S_EPS)) out.push({ t: t + dt, kind, a: a.id, b: null, data }); };
    if (a.mode === 'retreat') at(a.retreat_s!, 'retreat_done');
    else if (m === a.travel) at(a.spec.goal_s_mm, 'arrive');
    for (const x of vertexArcs(a.p)) if ((x - a.s) * m > S_EPS) at(x, 'vertex');
    // boundaries ahead of the leading edge, and one the edge is standing on when it starts to move (checked once per motion piece)
    for (const b of boundaries.get(`${a.p.id}|${a.w}`)!) {
      const dx = (b - lead) * m;
      if (dx > S_EPS) out.push({ t: t + dx / Math.abs(a.v), kind: 'boundary', a: a.id, b: null, data: b });
      else if (dx > -1e-7 && !boundaryDone.has(`${a.id}|${b}|${a.open.t}|${a.open.v}`)) out.push({ t, kind: 'boundary', a: a.id, b: null, data: b });
    }
    // own-width blocks: passage too narrow for this body/load, or an entrance aperture
    for (const [s0, s1] of sections(a.p, a.w)) { const edge = m > 0 ? s0 : s1, dx = (edge - lead) * m; if (dx > -S_EPS) { out.push({ t: t + Math.max(0, dx) / Math.abs(a.v), kind: 'wall', a: a.id, b: null, data: edge }); } }
    for (const e of entranceBlocks(a)) { const dx = (e.s - lead) * m; if (dx > -S_EPS) out.push({ t: t + Math.max(0, dx) / Math.abs(a.v), kind: 'aperture', a: a.id, b: null, data: e.s }); }
  };
  const inContact = new Set<string>();
  let wEndNow = 0;
  const boundaryDone = new Set<string>();
  const clearMemo = new Map<string, { key: string; t: number | null }>();
  const pairCands = (a: RT, b: RT, t: number, out: Cand[]) => {
    stats.pair_evaluations++;
    const key = pairKey(a.id, b.id);
    if (sameLane(a, b)) {
      const d0 = b.s - a.s, rate = b.v - a.v, gap = Math.abs(d0), grate = sgn(d0) * rate || (d0 === 0 ? Math.abs(rate) : 0);
      const c = C(a, b), mm = M(a, b);
      if (!inContact.has(key) && gap > c + S_EPS && grate < 0) out.push({ t: t + linRoot(gap, grate, c), kind: 'contact_start', a: a.id, b: b.id });
      if (inContact.has(key) && grate > 0 && gap < c + CONTACT_EXIT_EPS) out.push({ t: t + linRoot(gap, grate, c + CONTACT_EXIT_EPS), kind: 'contact_end', a: a.id, b: b.id });
      if (gap > mm + S_EPS && grate < 0) out.push({ t: t + linRoot(gap, grate, mm), kind: 'touch', a: a.id, b: b.id });
      // already touching and still closing in a single-file stretch (e.g. a faster ant behind one that just started to back out)
      else if (Math.abs(gap - mm) <= 1e-7 && grate < 0 && pinched(a, b)) out.push({ t, kind: 'touch', a: a.id, b: b.id });
      // overlapping bodies sliding past each other: an event when their centres cross (re-evaluation point)
      if (gap < mm - S_EPS && gap > S_EPS && grate < 0) out.push({ t: t + linRoot(gap, grate, 0), kind: 'centre', a: a.id, b: b.id });
      // a follower waiting for room (overlapping) gets an event when the room opens
      for (const [f, l] of [[a, b], [b, a]] as const) if (f.mode === 'follow' && f.partner === l.id && gap < mm - S_EPS && grate > 0) out.push({ t: t + linRoot(gap, grate, mm), kind: 'room', a: f.id, b: l.id });
      // a backed-out ant resumes when the other has passed it (other's centre M beyond it, on its back side)
      for (const [y, p] of [[a, b], [b, a]] as const) if (y.mode === 'yield_wait' && y.partner === p.id) {
        const rel = (p.s - y.s) * y.travel, rrate = (p.v - y.v) * y.travel;
        if (rel > -(mm + CONTACT_EXIT_EPS) && rrate < 0) out.push({ t: t + linRoot(rel, rrate, -(mm + CONTACT_EXIT_EPS)), kind: 'passed', a: y.id, b: p.id });
      }
    } else {
      const pa = pos(a), pb = pos(b);
      const ha = a.v ? headingAt(a.p, a.s, sgn(a.v) as 1 | -1) : { x: 0, y: 0, z: 0 }, hb = b.v ? headingAt(b.p, b.s, sgn(b.v) as 1 | -1) : { x: 0, y: 0, z: 0 };
      // Codex physics review f61db12, F1: bodies on different lanes interact only while on one height layer
      // (|dz| ≤ max(L) + LEVEL_EPS; stated simplification). dz changes linearly until the next event (vertices are events),
      // so the layer window [lo, hi] is exact; planar events are kept only inside it.
      const H = Math.max(a.L, b.L) + LEVEL_EPS, dz0 = pb.z - pa.z, dzr = hb.z * Math.abs(b.v) - ha.z * Math.abs(a.v);
      let lo = 0, hi = Infinity;
      if (dzr === 0) { if (Math.abs(dz0) > H) return; }
      else { const t1 = (-H - dz0) / dzr, t2 = (H - dz0) / dzr; lo = Math.max(0, Math.min(t1, t2)); hi = Math.max(t1, t2); if (!(hi > lo + T_EPS) && !(Math.abs(dz0) <= H && hi >= 0)) return; if (hi < 0) return; }
      const dpx = pb.x - pa.x, dpy = pb.y - pa.y, dvx = hb.x * Math.abs(b.v) - ha.x * Math.abs(a.v), dvy = hb.y * Math.abs(b.v) - ha.y * Math.abs(a.v);
      const A = dvx * dvx + dvy * dvy, B = 2 * (dpx * dvx + dpy * dvy), d2 = dpx * dpx + dpy * dpy, dd = Math.sqrt(d2);
      const first = (R: number) => { const c0 = d2 - R * R, disc = B * B - 4 * A * c0; if (A === 0 || disc < 0 || B >= 0) return Infinity; const r = (-B - Math.sqrt(disc)) / (2 * A); return r >= 0 ? r : Infinity; };
      const later = (R: number) => { const c0 = d2 - R * R, disc = B * B - 4 * A * c0; if (A === 0 || disc < 0) return Infinity; const r = (-B + Math.sqrt(disc)) / (2 * A); return r >= 0 ? r : Infinity; };
      const c = C(a, b), mm = M(a, b);
      // the planar "within R" interval [enter, leave) of the current motion
      const within = (R: number): [number, number] => (dd <= R ? [0, later(R)] : [first(R), later(R)]);
      const [cIn, cOut] = within(c), cStart = Math.max(cIn, lo);
      if (!inContact.has(key) && Number.isFinite(cStart) && cStart < Math.min(cOut, hi) - T_EPS) out.push({ t: t + cStart, kind: 'contact_start', a: a.id, b: b.id });
      if (inContact.has(key)) { const end = Math.min(dd < c + CONTACT_EXIT_EPS ? later(c + CONTACT_EXIT_EPS) : 0, hi); if (Number.isFinite(end)) out.push({ t: t + end, kind: 'contact_end', a: a.id, b: b.id }); }
      const [mIn, mOut] = within(mm);
      if (lo > T_EPS) {
        // the pair reaches one height layer later: if their footprints already overlap then, the ant cannot be put
        // anywhere consistent (vertical approach is not modelled) — stopped and reported, never passed through
        if (mIn <= lo + T_EPS && mOut > lo + T_EPS && lo < hi) out.push({ t: t + lo, kind: 'layer_overlap', a: a.id, b: b.id });
        else if (mIn > lo && mIn < hi) out.push({ t: t + mIn, kind: 'disc_touch', a: a.id, b: b.id });
      } else if (dd > mm + S_EPS) { if (mIn < hi) out.push({ t: t + mIn, kind: 'disc_touch', a: a.id, b: b.id }); }
      // already touching and still closing (e.g. starting at exactly one body length apart): handle now
      else if (dd <= mm + 1e-7 && B < -1e-12) out.push({ t, kind: 'disc_touch', a: a.id, b: b.id });
      for (const [y, p] of [[a, b], [b, a]] as const) if (y.mode === 'cross_wait' && y.partner === p.id && !y.waitRoom) {
        // resume once the other has passed: its remaining path stays ≥ M from y, and it is ≥ M from y's own remaining path
        // memoised while neither ant's motion changes (the answer is the same absolute time)
        const key = `${p.id}|${p.open.t}|${p.open.s}|${p.open.v}|${y.s}|${wEndNow}`;
        let abs = clearMemo.get(y.id);
        if (!abs || abs.key !== key) { const tc = clearedAt(y, p, wEndNow - t); abs = { key, t: tc === null ? null : t + tc }; clearMemo.set(y.id, abs); }
        if (abs.t !== null) out.push({ t: Math.max(t, abs.t), kind: 'cleared', a: y.id, b: p.id });
      }
    }
  };

  /** smallest 2D distance from point q to the rest of x's path (from arc length `from`, default its position, to its goal) */
  const clearance = (x: RT, q: Vec3, from = x.s) => {
    const m = sgn(x.v) || x.travel, goal = m === x.travel ? x.spec.goal_s_mm : (m > 0 ? laneLength(x.p) : 0);
    const cuts = [from, ...vertexArcs(x.p).filter((v) => (v - from) * m > 0 && (goal - v) * m > 0), goal].map((s) => positionAt(x.p, s));
    let d = Infinity;
    for (let i = 1; i < cuts.length; i++) d = Math.min(d, pointSegment2D(q, cuts[i - 1], cuts[i]).d);
    if (cuts.length === 1 || cuts.every((c) => c.x === cuts[0].x && c.y === cuts[0].y)) d = Math.hypot(q.x - cuts[0].x, q.y - cuts[0].y);
    return d;
  };
  /**
   * Earliest time offset τ ∈ [0, horizon] at which a waiting ant y may go on after the other ant o: o's remaining path no
   * longer comes within M of y, and o is at least M from y's remaining path. o moves on with its current velocity. Found by
   * a scan at 0.01 mm of o's travel and bisection (numerical); null when not within the horizon (re-checked next window).
   */
  const clearedAt = (y: RT, o: RT, horizon: number): number | null => {
    const need = M(y, o) + CONTACT_EXIT_EPS, py = positionAt(y.p, y.s), Lo = laneLength(o.p);
    const ok = (tau: number) => { const so = Math.max(0, Math.min(Lo, o.s + o.v * tau)); return clearance(o, py, so) >= need && clearance(y, positionAt(o.p, so)) >= need; };
    if (ok(0)) return 0;
    if (o.v === 0) return null;
    const dtau = step / Math.abs(o.v);
    let prev = 0;
    for (let tau = dtau; tau <= horizon + dtau; tau += dtau) {
      if (ok(tau)) { let lo = prev, hi = tau; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; } return hi; }
      prev = tau;
    }
    return null;
  };
  /** arc length behind y (opposite to its walking direction) where y is at least `need` from the other's remaining path */
  const backOutTarget = (y: RT, o: RT, need: number): number | null => {
    const m = sgn(y.v) || y.travel, Lp = laneLength(y.p), f = (s: number) => clearance(o, positionAt(y.p, s)) >= need;
    let prev = y.s;
    for (let k = 1; ; k++) {
      const s = y.s - m * k * step;
      if (s < 0 || s > Lp) return null;
      if (f(s)) { let lo = prev, hi = s; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (f(mid)) hi = mid; else lo = mid; } return hi; }
      prev = s;
    }
  };
  // ---- event handling
  const KIND_ORDER = ['vertex', 'start', 'arrive', 'retreat_done', 'wall', 'aperture', 'passed', 'cleared', 'room', 'centre', 'contact_end', 'contact_start', 'boundary', 'touch', 'disc_touch', 'layer_overlap'];
  const unresolved = (t: number, x: RT, y: RT, why: string) => {
    for (const z of [x, y]) if (!terminal(z)) { z.mode = 'unresolved'; z.partner = z === x ? y.id : x.id; modeMotion(z, t); }
    ev(t, 'unresolved', x, y, why);
  };
  const handle = (c: Cand, t: number) => {
    const a = byId.get(c.a)!, b = c.b ? byId.get(c.b)! : null;
    switch (c.kind) {
      case 'vertex': if (a.v !== 0) split(a, t); return;
      case 'start': if (a.mode === 'idle') {
        // Codex physics review F3: an ant already at its goal arrives at its start time and never moves
        if (Math.abs(a.spec.goal_s_mm - a.s) <= S_EPS) { a.s = a.spec.goal_s_mm; a.mode = 'arrived'; modeMotion(a, t); ev(t, 'start', a, null, null); ev(t, 'arrive', a, null, 'already at its goal'); return; }
        a.mode = 'free'; modeMotion(a, t); ev(t, 'start', a, null, null);
      } return;
      case 'arrive': if (a.mode === 'free' || a.mode === 'follow') { a.s = a.spec.goal_s_mm; a.mode = 'arrived'; a.partner = null; modeMotion(a, t); ev(t, 'arrive', a, null, null); } return;
      case 'retreat_done': if (a.mode === 'retreat') {
        const p = byId.get(a.partner!)!;
        if (a.crossRetreat) {
          a.s = a.retreat_s!; a.crossRetreat = false; a.mode = 'cross_wait'; modeMotion(a, t); ev(t, 'cross_wait', a, p, 'backed out clear of the other ant’s path; waits for it to pass');
          if (p.mode === 'cross_wait' && p.partner === a.id && p.waitRoom) { p.mode = 'free'; p.partner = null; p.waitRoom = false; modeMotion(p, t); ev(t, 'cross_resume', p, a, 'room made'); }
          return;
        }
        a.s = a.retreat_s!; a.mode = 'yield_wait'; modeMotion(a, t); ev(t, 'yield_hold', a, p, `waiting at s=${a.s.toFixed(6)} outside the narrow section`);
        if ((p.s - a.s) * a.travel <= -M(a, p)) { a.mode = 'free'; a.partner = null; modeMotion(a, t); ev(t, 'yield_resume', a, p, 'the other had already passed'); }
      } return;
      case 'wall': case 'aperture': if (!terminal(a) && a.v !== 0) {
        a.mode = 'blocked'; a.partner = null; modeMotion(a, t);
        ev(t, 'blocked', a, null, c.kind === 'wall' ? `passage narrower than effective width ${a.w} mm (body ${a.spec.body.width_mm} mm${a.spec.load ? `, load ${a.spec.load}` : ''})` : `entrance aperture narrower than effective width ${a.w} mm${a.spec.load ? ` (load ${a.spec.load})` : ''}`);
      } return;
      case 'passed': if (a.mode === 'yield_wait' && a.partner === b!.id) { a.mode = 'free'; a.partner = null; modeMotion(a, t); ev(t, 'yield_resume', a, b, null); } return;
      case 'cleared': if (a.mode === 'cross_wait' && a.partner === b!.id && !a.waitRoom) { a.mode = 'free'; a.partner = null; modeMotion(a, t); ev(t, 'cross_resume', a, b, null); } return;
      case 'room': case 'centre': return; // velocities are re-resolved after every step
      case 'contact_start': { const k = pairKey(a.id, b!.id); if (!inContact.has(k)) { inContact.add(k); ev(t, 'contact_start', a, b, null, sameLane(a, b!) ? lateralCertain(a, b!) : null); } return; }
      case 'contact_end': { const k = pairKey(a.id, b!.id); if (inContact.delete(k)) ev(t, 'contact_end', a, b, null); return; }
      case 'boundary': {
        // the leading edge of a reaches a narrow-section boundary: a body beside it that covers that point must not be
        // squeezed into the narrow part together with it. If both edges arrive at the same point together, the named
        // stream decides who waits (never array order).
        if (a.v === 0) return;
        const bnd = c.data as number, m = sgn(a.v);
        boundaryDone.add(`${a.id}|${bnd}|${a.open.t}|${a.open.v}`);
        for (const o of rts) {
          if (o === a || !sameLane(a, o)) continue;
          if (o.mode === 'follow' && o.partner === a.id) {
            // o is already waiting for a. Fine only if o's body ends at the boundary; if it reaches into the narrow part,
            // a would squeeze in beside it: report, never overlap
            const oFar = o.s + m * o.L / 2;
            if ((oFar - bnd) * m > 1e-9 && Math.abs(o.s - a.s) < M(a, o) - S_EPS && narrowAt(a.p, a.w + o.w, bnd + m * EDGE_EPS)) { unresolved(t, a, o, 'would enter a narrow section beside an ant that is waiting for it'); return; }
            continue;
          }
          if (Math.abs(o.s - a.s) >= M(a, o) - S_EPS) continue;               // not beside a
          if (!(o.s - o.L / 2 <= bnd + 1e-9 && bnd - 1e-9 <= o.s + o.L / 2)) continue;
          if (!narrowAt(a.p, a.w + o.w, bnd + m * EDGE_EPS)) continue;
          const oLead = o.s + sgn(o.v || o.travel) * o.L / 2, together = sgn(o.v) === m && Math.abs(oLead - bnd) <= 1e-9;
          const waiter = together && yielder(cfg, a.id, o.id) === o.id ? o : a, other = waiter === a ? o : a;
          if (waiter.mode === 'retreat') { unresolved(t, waiter, other, 'backing-out ant squeezed against another body'); return; }
          waiter.mode = 'follow'; waiter.partner = other.id;
          ev(t, 'obstruction', waiter, other, `abreast at the entry of a narrow section: waits for room${together ? ' (arrived together; tie broken by named stream physics.yield)' : ''}`);
          ev(t, 'follow_start', waiter, other, null);
          setMotion(waiter, t, 0, 'blocked_by', other.id);
          if (waiter === a) return;
        }
        return;
      }
      case 'touch': {
        if (!b || !pinched(a, b)) return;                          // wide here: they pass beside each other
        const [lo, hi] = a.s < b.s ? [a, b] : [b, a];
        ev(t, 'obstruction', lo, hi, `bodies touch in a section narrower than ${(a.w + b.w).toFixed(3)} mm`);
        if (lo.v > 0 && hi.v < 0) {
          // head-on in a single-file section: one backs out
          if (!['free', 'follow'].includes(lo.mode) || !['free', 'follow'].includes(hi.mode)) { unresolved(t, lo, hi, `head-on while ${lo.mode}/${hi.mode}`); return; }
          const T = a.w + b.w, touchS = lo.s + lo.L / 2, sec = sectionAt(a.p, T, touchS);
          const plan = (x: RT) => {
            if (!sec) return null;
            const m = sgn(x.v), back = m > 0 ? sec[0] : sec[1], Lp = laneLength(x.p);
            if ((m > 0 && back <= 1e-9) || (m < 0 && back >= Lp - 1e-9)) return null;  // narrow up to the passage end: no room behind
            const target = back - m * (EDGE_EPS + x.L / 2);
            if (target < 0 || target > Lp) return null;
            if (narrowOver(x.p, T, target - x.L / 2, target + x.L / 2)) return null;   // another pinch right behind: no room to wait
            // the stretch it would back through must be free of other bodies (no chain retreat in this version)
            const lo2 = Math.min(target, x.s) - x.L / 2, hi2 = Math.max(target, x.s) + x.L / 2, partner = x === lo ? hi : lo;
            if (rts.some((o) => o !== x && o !== partner && sameLane(o, x) && o.s + o.L / 2 > lo2 + 1e-9 && o.s - o.L / 2 < hi2 - 1e-9)) return null;
            return { target, dist: Math.abs(x.s - target) };
          };
          const pl = plan(lo), ph = plan(hi);
          if (!pl && !ph) { unresolved(t, lo, hi, 'head-on with no room behind either ant'); return; }
          let y: RT;
          if (pl && ph) y = Math.abs(pl.dist - ph.dist) <= 1e-9 ? byId.get(yielder(cfg, lo.id, hi.id))! : pl.dist < ph.dist ? lo : hi;
          else y = pl ? lo : hi;
          const other = y === lo ? hi : lo, pY = y === lo ? pl! : ph!;
          y.mode = 'retreat'; y.partner = other.id; y.retreat_s = pY.target; modeMotion(y, t);
          ev(t, 'yield_start', y, other, `backs out ${pY.dist.toFixed(6)} mm (other would back out ${(y === lo ? ph : pl)?.dist.toFixed(6) ?? 'n/a'} mm); rule: shorter way back${pl && ph && Math.abs(pl.dist - ph.dist) <= 1e-9 ? ', tie broken by named stream physics.yield' : ''}`);
          return;
        }
        // same direction, or one standing: the one closing in from behind follows
        const rear = lo.v > 0 ? lo : hi;
        const front = rear === lo ? hi : lo;
        if (rear.mode === 'retreat' || sgn(rear.v) !== rear.travel) { unresolved(t, rear, front, 'backing-out ant blocked from behind'); return; }
        if (rear.mode === 'follow' && rear.partner === front.id) return;
        rear.mode = 'follow'; rear.partner = front.id; ev(t, 'follow_start', rear, front, null);
        return;
      }
      case 'layer_overlap': {
        if (!b || terminal(a) && terminal(b)) return;
        ev(t, 'obstruction', a, b, 'reaches the same height layer while the footprints overlap');
        unresolved(t, a, b, 'reaches the same height layer as the other ant while their footprints already overlap (vertical approach is not modelled)');
        return;
      }
      case 'disc_touch': {
        if (!b) return;
        ev(t, 'obstruction', a, b, 'bodies touch across lanes');
        const pa = pos(a), pb = pos(b);
        const ahead = (x: RT, q: Vec3, r: Vec3) => { if (x.v === 0) return -Infinity; const h = headingAt(x.p, x.s, sgn(x.v) as 1 | -1), dx = r.x - q.x, dy = r.y - q.y, n = Math.hypot(dx, dy) || 1; return (h.x * dx + h.y * dy) / n; };
        const ca = ahead(a, pa, pb), cb = ahead(b, pb, pa);
        if (ca <= 0 && cb <= 0) return;                            // neither is moving towards the other
        const y = Math.abs(ca - cb) <= 1e-12 ? byId.get(yielder(cfg, a.id, b.id))! : ca > cb ? a : b, other = y === a ? b : a;
        if (y.mode === 'retreat' || other.mode === 'retreat') { unresolved(t, y, other, 'backing-out ant blocked across lanes'); return; }
        const tie = Math.abs(ca - cb) <= 1e-12 ? '; tie broken by named stream physics.yield' : '';
        if (terminal(other)) { unresolved(t, y, other, `blocked across lanes by an ant that has stopped for good (${other.mode})`); return; }
        // the yielder must stand clear of the other's remaining path, or the other would walk into it. If the other is not
        // walking now (not started, or itself waiting), standing still is safe: nothing is coming towards the yielder.
        const mm = M(y, other), otherWalking = other.v !== 0 && (other.mode === 'free' || other.mode === 'follow');
        if (!otherWalking || clearance(other, positionAt(y.p, y.s)) >= mm - 1e-9) {
          y.mode = 'cross_wait'; y.partner = other.id; modeMotion(y, t);
          ev(t, 'cross_wait', y, other, `stops: the other is more directly ahead (cosine ${Math.max(ca, cb).toFixed(3)})${tie}`);
          return;
        }
        const back = backOutTarget(y, other, mm + EDGE_EPS);
        if (back === null) { unresolved(t, y, other, 'no room to back out of the other ant’s path'); return; }
        y.mode = 'retreat'; y.crossRetreat = true; y.partner = other.id; y.retreat_s = back; modeMotion(y, t);
        other.mode = 'cross_wait'; other.partner = y.id; other.waitRoom = true; modeMotion(other, t);
        ev(t, 'yield_start', y, other, `backs out ${Math.abs(y.s - back).toFixed(6)} mm clear of the other ant’s path; the other waits for room${tie}`);
        return;
      }
    }
  };

  // ---- initial state checks: no body starts where it does not fit; no two bodies start in mutually exclusive positions
  for (const a of rts) if (narrowOver(a.p, a.w, a.s - a.L / 2, a.s + a.L / 2)) throw Error(`PHYSICS: ${a.id} starts in a section narrower than its width ${a.w} mm`);
  for (let i = 0; i < rts.length; i++) for (let j = i + 1; j < rts.length; j++) {
    const a = rts[i], b = rts[j];
    if (sameLane(a, b) ? (Math.abs(a.s - b.s) < M(a, b) - S_EPS && pinched(a, b)) : (a.p.id !== b.p.id && Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y) < M(a, b) - S_EPS && Math.abs(pos(a).z - pos(b).z) <= Math.max(a.L, b.L))) throw Error(`PHYSICS: ${a.id} and ${b.id} start in the same space`);
    const gap = sameLane(a, b) ? Math.abs(a.s - b.s) : Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y);
    if (gap <= C(a, b) && (sameLane(a, b) || Math.abs(pos(a).z - pos(b).z) <= Math.max(a.L, b.L) + LEVEL_EPS)) inContact.add(pairKey(a.id, b.id));
  }

  // ---- main loop
  let t = 0;
  const vmax = Math.max(...rts.map((a) => a.free));
  while (t < cfg.horizon_s - T_EPS && rts.some((a) => !terminal(a))) {
    const wEnd = Math.min(t + H, cfg.horizon_s);
    wEndNow = wEnd;
    stats.windows++;
    // broadphase for this window: any pair that can come within contact range before wEnd (conservative reach discs)
    const discs: ReachDisc[] = rts.map((a) => { const q = pos(a); return { id: a.id, x: q.x, y: q.y, r: vmax * (wEnd - t) + a.L / 2 + a.reach }; });
    const pairs = gridPairs(discs, Math.max(1e-6, 2 * Math.max(...discs.map((d) => d.r)))).map(([x, y]) => [byId.get(x)!, byId.get(y)!] as const);
    while (t < wEnd - T_EPS) {
      stats.steps++;
      const cands: Cand[] = [];
      for (const a of rts) intrinsic(a, t, cands);
      for (const [a, b] of pairs) pairCands(a, b, t, cands);
      let tn = wEnd;
      for (const c of cands) if (c.t < tn) tn = c.t;
      if (!(tn >= t)) tn = t;
      for (const a of rts) a.s = a.s + a.v * (tn - t);
      t = tn;
      const due = cands.filter((c) => c.t <= tn + T_EPS).sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || ((x.b ?? '') < (y.b ?? '') ? -1 : (x.b ?? '') > (y.b ?? '') ? 1 : 0));
      for (const c of due) handle(c, t);
      resolveFollow(t);
      detectStuck(t);
      if (stats.steps > 1e7) throw Error('PHYSICS: event budget exceeded (Zeno or runaway)');
    }
  }
  stats.t_end_s = t;
  for (const a of rts) close(a, t);
  const final: SimResult['final'] = {};
  for (const a of rts) final[a.id] = { s_mm: a.s, mode: a.mode, t_s: t };
  const intervals: Record<string, MotionInterval[]> = {};
  for (const a of rts) intervals[a.id] = a.ivs;
  return { intervals, events, final, stats };
}

/**
 * Independent check of a simulation result (tests): samples every trajectory at every record boundary and every dt and
 * verifies that no two bodies are in mutually exclusive positions (21 samples per overlap region), no body is in a section
 * too narrow for it (21 samples per body), and no body straddles an entrance narrower than it. Returns violations.
 */
export function checkExclusion(cfg: SimConfig, res: SimResult, dt: number): string[] {
  const g = cfg.geometry, out: string[] = [], specs = new Map(cfg.agents.map((a) => [a.id, a]));
  const width = (id: string) => { const a = specs.get(id)!; const o = a.load ? cfg.objects!.find((x) => x.id === a.load)! : null; return Math.max(a.body.width_mm, o?.width_mm ?? 0); };
  const times = new Set<number>();
  for (const ivs of Object.values(res.intervals)) for (const r of ivs) { times.add(r.t_start_s); times.add(r.t_end_s); }
  for (let t = 0; t <= res.stats.t_end_s; t += dt) times.add(t);
  const sAt = (id: string, t: number) => { const ivs = res.intervals[id]; for (const r of ivs) if (t >= r.t_start_s - 1e-12 && t <= r.t_end_s + 1e-12) { const f = r.t_end_s === r.t_start_s ? 1 : (t - r.t_start_s) / (r.t_end_s - r.t_start_s); return r.s_start_mm + (r.s_end_mm - r.s_start_mm) * Math.max(0, Math.min(1, f)); } return ivs.length ? ivs[ivs.length - 1].s_end_mm : specs.get(id)!.s_mm; };
  const ids = [...specs.keys()].sort();
  for (const t of [...times].sort((a, b) => a - b)) {
    const S = new Map(ids.map((id) => [id, sAt(id, t)]));
    for (const id of ids) {
      const a = specs.get(id)!, p = passageOf(g, a.passage), s = S.get(id)!, Lb = a.body.length_mm, Lp = laneLength(p);
      for (let k = 0; k <= 20; k++) { const x = s - Lb / 2 + 1e-6 + ((Lb - 2e-6) * k) / 20; if (x >= 0 && x <= Lp && usableWidth(g, p, x) < width(id) - 1e-9) { out.push(`t=${t}: ${id} is in a section narrower than its width at s=${x}`); break; } }
      for (const e of g.entrances) if (e.passage_ref === a.passage && e.aperture_width_mm !== null && e.aperture_width_mm < width(id) - 1e-9) {
        const se = arcPositionOf(p, { x: e.position_mm[0], y: e.position_mm[1] });
        if (s - Lb / 2 < se - 1e-6 && se + 1e-6 < s + Lb / 2) out.push(`t=${t}: ${id} is passing entrance ${e.id} (aperture ${e.aperture_width_mm} mm) with width ${width(id)} mm`);
      }
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const A = specs.get(ids[i])!, B = specs.get(ids[j])!, sa = S.get(A.id)!, sb = S.get(B.id)!, mm = (A.body.length_mm + B.body.length_mm) / 2;
      if (A.passage === B.passage) {
        if (Math.abs(sa - sb) >= mm - 1e-6) continue;
        const p = passageOf(g, A.passage), lo = Math.max(sa - A.body.length_mm / 2, sb - B.body.length_mm / 2), hi = Math.min(sa + A.body.length_mm / 2, sb + B.body.length_mm / 2);
        for (let k = 0; k <= 20; k++) { const x = lo + ((hi - lo) * k) / 20; if (usableWidth(g, p, x) < width(A.id) + width(B.id) - 1e-6) { out.push(`t=${t}: ${A.id} and ${B.id} overlap at s=${x.toFixed(6)} where the passage is too narrow for both`); break; } }
      } else {
        const pa = positionAt(passageOf(g, A.passage), sa), pb = positionAt(passageOf(g, B.passage), sb);
        if (Math.abs(pa.z - pb.z) > Math.max(A.body.length_mm, B.body.length_mm)) continue;
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < mm - 1e-6) out.push(`t=${t}: ${A.id} and ${B.id} discs overlap across lanes`);
      }
    }
  }
  return out;
}

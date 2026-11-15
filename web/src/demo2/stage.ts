/**
 * Demo 2 — the display director: where and how every ENGINE worker is drawn in the one world (surface + nest).
 * Pure: no DOM, no Three.js, no engine import. It never changes, steps or feeds anything back to the simulation.
 *
 * Inputs: the Worker's P0-A2 frames (each worker's engine state, since_s / until_s, crop fill), the Worker's events
 * (trophallaxis partners and amounts, larvae touched and fed), the display time, and the fixed nest geometry (展示假設).
 * Output per worker: ONE drawn point with a forward / up direction — the same record (same id) whether the worker is in
 * a chamber, in a tunnel, at the entrance or on the surface.
 *
 * What is whose:
 *  ENGINE     the state, its start instant, the fixed-duration moves (to_entrance / from_entrance: since_s → until_s;
 *             outbound / returning: departure → arrival), who met whom and how much was passed (arrive_nest.touched),
 *             which larvae a carer touched / fed, crop fill.
 *  DISPLAY    everything spatial inside the nest (the engine has no nest coordinates):
 *   - to_entrance: the worker walks the shortest graph route to the entrance and is EXACTLY at the entrance at until_s;
 *     from_entrance: it reaches its place in the entry chamber at until_s (engine instants; route = 展示假設);
 *   - a state change with no engine duration (→ resting / idle / brood_care, or arriving home) is shown as a walk along
 *     the graph that starts where the worker is drawn and lasts at most CATCHUP_MAX_S of simulated time (bounded
 *     display travel time): for at most that long the drawn place may lag the engine state, never longer;
 *   - resting workers stand still in a resting-chamber slot (only in-place micro-motion, drawn by the renderer);
 *   - idle (巢內走動) workers wander between chamber places with pauses (seeded per worker and bout: deterministic);
 *   - brood_care: the carer walks to the larvae the ENGINE event says it touched (fed ones first) and stands by each;
 *   - trophallaxis: after an arrive_nest event the forager walks to partners the engine says received food and stops
 *     head to head (a partner walking up to the entrance is met on the way); shown only when route and time allow
 *     (a forager that must be back at the entrance at an engine instant never misses it for a meeting);
 *   - depth lanes: each worker keeps its own lane inside the tunnel depth so workers going opposite ways pass
 *     (display-only avoidance; the engine has no bodies);
 *   - a small jump of the drawn point (the page learns a state change up to one frame late) is absorbed and decays
 *     (≤ ABSORB_MAX_CM); larger jumps are engine-defined discontinuities and are listed (STAGE_DISCONTINUITIES).
 *
 * MOTION (round 4; all of it 畫面 — the world has no kinematics, no body contact, no antennation: M21 / M22 尚未模擬):
 *   - everything drawn is a FUNCTION of (the frames and events received, simulated time t). Plans are made when a frame
 *     is ingested, at the frame's own instant; nothing is integrated per rendered frame and nothing follows the wall
 *     clock. The same frames sampled at any frame rate give the same drawn ants; a paused world is perfectly still;
 *   - walking: a walk starts and ends with a speed ramp and slows through bends (speed profile along the path); the
 *     engine instants at both ends of a walk are unchanged;
 *   - turning: the body frame never flips. A change of heading is a turn at TURN_RATE: small ones while walking, large
 *     ones (a reversal in a tunnel, facing a partner or a resting heading) in place before the walk starts;
 *   - the odometer (distance the drawn point walked, plus steps taken to turn) drives the gait phase (gait.ts);
 *   - resting / standing places are irregular (places.ts); a second tier of resting places is on the chamber's back wall;
 *   - bodies are kept apart per instant (separate.ts): in the nest along the cavity depth only, never into the soil;
 *   - two ants meeting head-on point their antennae at each other (display; the engine records no such contact).
 */
import type { EventMsg, P0a2FrameMsg } from '../experimental/worker-protocol.ts';
import type { VisModel } from '../vis1-model.ts';
import { hash32 } from '../game-model.ts';
import { NestGraph, pathAt, upFor, type P3, type Path, type Pos } from './nest-graph.ts';
import { BLOCK, ground, surfacePose } from './surface.ts';
import { PLACE_FRONT_Z, carerSpot, chamberPlaces, larvaSpot, placeFrame, type Place } from './places.ts';
import { separate, type Body } from './separate.ts';
import { gaitPhase, poseValues, stanceAmp, strideCm, type PoseValues } from './gait.ts';

/** in-nest display walking speed as a multiple of the engine's trail speed (the engine has no in-nest speed; 展示假設) */
export const NEST_SPEED_FACTOR = 1;
/** the longest a display walk may take to bring a worker to the place of its new engine state (s of simulated time) */
export const CATCHUP_MAX_S = 45;
/** how long the head-to-head / larva-tending pose is held (s of simulated time; display) */
export const TROPH_HOLD_S = 6, BROOD_HOLD_S = 5, MIN_HOLD_S = 1.5;
/** centre-to-centre distance of two ants meeting head to head (× body length): antennae and mouthparts meet, bodies do not overlap */
export const MEET_GAP_BODY = 1.0;
export const MAX_MEETINGS = 3, MAX_VISITS = 4;
/** the fastest a display walk may go (× the in-nest display speed) when a deadline is tight */
export const VMAX_FACTOR = 2.5;
/** jumps of the drawn point up to this size are absorbed (cm); larger ones are cuts */
export const ABSORB_MAX_CM = 4;
/** decay time of an absorbed jump (s of SIMULATED time: the decay is a function of the world instant) */
export const ABSORB_TAU_S = 0.4;
/** turning rate of the drawn body (rad per simulated second; the peak of the eased turn is 1.5 × this). 畫面選擇 */
export const TURN_RATE = 2.4;
/** a heading change larger than this is turned in place before the walk starts (rad) */
export const TURN_IN_PLACE_RAD = 0.6;
/** distance of leg stepping counted per radian turned in place (× body length): a turning ant steps — it lifts and replants its
 *  legs with no stride reach (DrawnAnt.amp → 0), it does not pivot on frozen legs and does not walk on the spot */
export const TURN_STEP_PER_RAD = 0.6;
/** time over which the stride reach of the legs fades out / in around a turn in place (s, simulated) */
const REACH_BLEND_S = 0.25;
/** speed profile of a walk: ramp length at both ends (× body length) and how much a bend slows the walk */
export const RAMP_BODY = 0.6, BEND_SLOW = 1.6;
/** the drawn body frame never turns faster than this (rad per simulated second) — asserted by the tests */
export const YAW_RATE_BOUND = 8;
/** bound of the drawn speed (× the engine trail speed) used by the jump detector and the continuity tests */
export const DRAWN_SPEED_BOUND = 4.5;

export const OUTSIDE = new Set(['outbound', 'searching', 'feeding', 'returning']);
export type Pose = 'walk' | 'stand' | 'rest' | 'feed' | 'troph' | 'brood';
export type DataClass = 'engine' | 'interp' | 'schematic' | 'display';
export const CLASS_LABEL: Record<DataClass, string> = {
  engine: '引擎紀錄點', interp: '顯示插值（起訖時刻＝引擎；路徑＝展示假設）', schematic: '示意位置（引擎沒有空間模型）', display: '展示假設位置（狀態＝引擎；巢內位置與走法＝畫面）',
};
export interface DrawnAnt {
  id: string; state: string; realm: 'surface' | 'nest'; x: number; y: number; z: number;
  fx: number; fy: number; fz: number; ux: number; uy: number; uz: number;
  /** false = no recorded heading here (the renderer keeps the last drawn one) */
  heading: boolean; moving: boolean; pose: Pose; crop: number; partner: string | null; cls: DataClass;
  /** chamber id, 'tunnel', or the surface place */
  place: string;
  /** graph place (nest only) */
  edge: number | null;
  /** how far the drawn point is displaced by an absorbed jump (cm) */
  absorbed: number;
  /** how far the drawn point is moved by the display separation of bodies (cm; separate.ts) */
  sep: number;
  /** distance this drawn ant has walked (cm, display odometer) and the gait phase / stance amplitude that follow from it */
  odo: number; phase: number; amp: number;
  /** 0..1: walking weight (body bob, antenna sway) */
  walk: number;
  /** display pose values at this instant (gait.ts) */
  pv: PoseValues;
  /** turning in place at this instant (display) */
  turning: boolean;
  /** drawn body length (cm) */
  len: number;
}
/** drawn-point jumps the display cannot avoid (the legend lists them; the continuity tests allow only these) */
export const STAGE_DISCONTINUITIES = [
  { key: 'search_found', basis: 'engine', label_zh: '搜尋成功→取食／回程：搜尋沒有空間模型，引擎在同一時刻讓工蟻位於食源，畫面從搜尋區（示意）直接到食源旁' },
  { key: 'search_short_failed', basis: 'display_limit', label_zh: '極短的失敗搜尋→回程：回程起點在搜尋示意圈上（畫面只讀目前狀態）' },
  { key: 'first_sight', basis: 'display_limit', label_zh: '開啟頁面、載入存檔或重新開始的第一個畫面：沒有前一個畫面位置，直接放在目前引擎狀態對應的位置' },
] as const;

type Q4 = { x: number; y: number; z: number; w: number };
interface Leg {
  t0: number; t1: number; path: Path; a: number; b: number; pose: Pose; partner: string | null; cls: DataClass; f: P3 | null;
  /** up override (on the back wall), else the up of the graph place */
  up: P3 | null;
  /** walking straight into / out of a standing place, between the others: not moved by the display separation */
  fix: boolean;
  // filled by finish(): entry frame, turn time, in-place turn time before the walk starts, odometer at the leg start,
  // the odometer steps of the turn, the end frame, the pose before this leg, and the speed profile of a walk
  q0: Q4 | null; qs: Q4 | null; tau: number; lead: number; o0: number; turnOdo: number; qe: Q4 | null; prevPose: Pose; prevWalk: boolean; ak0: number; ak1: number; prof: { u: Float64Array; s: Float64Array } | null;
}
interface Before { x: number; y: number; z: number; q: Q4; odo: number; pose: Pose; ampK: number }
interface Rec {
  id: string; key: string; state: string; legs: Leg[]; slot: string | null; lane: number; outside: boolean; wander: number;
  /** engine deadline of the current legs (to / from entrance), else null */
  deadline: number | null;
  /** hold given by a meeting: the state plan restarts from there at this instant */
  resume: number | null;
  over: { t0: number; t1: number; pose: Pose; partner: string; f: P3 | null } | null;
  /** the engine record this plan was made for (the latest frame's) */
  w: PW;
  /** absorbed jump: offset at instant offT, decaying in simulated time */
  off: P3; offT: number;
  /** start of the current plan: instant, drawn frame / odometer / pose there, surface odometer base */
  /** surface heading follower: headings on the time grid of the engine state `key` */
  hd: { key: string; th: number[] };
  planT: number; q0: Q4 | null; tq0: Q4 | null; odo0: number; ak0: number; pose0: Pose; dist0: number; tau0: number;
}
type PW = P0a2FrameMsg['workers'][number];
interface Raw {
  realm: 'surface' | 'nest'; x: number; y: number; z: number; q: Q4; heading: boolean; moving: boolean; turning: boolean; pose: Pose; prev: Pose; since: number; walk: number;
  partner: string | null; cls: DataClass; place: string; edge: number | null; odo: number; ampK: number; mobK: number; zLo: number; zHi: number; lift: number;
}
const u01 = (key: string) => (hash32(key) >>> 0) / 4294967296;
const smooth = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const WANDER_WEIGHT: Record<string, number> = { entry: 2, exchange: 3, rest: 1, brood: 1.5, queen: 1, pupa: 1 };
/** how readily a drawn ant gives way in the display separation, per pose (resting ants are never moved) */
const MOBILITY: Record<Pose, number> = { walk: 1, stand: 0.4, feed: 0.25, troph: 0.15, brood: 0.3, rest: 0 };
const UP: P3 = { x: 0, y: 1, z: 0 };
/** walking lanes on a chamber floor (cm of cavity depth; display) */
const FLOOR_LANE_LO = 0.7, FLOOR_LANE_HI = 1.5;
/** the display separation is averaged over this much simulated time (s), in this many samples */
const SEP_WINDOW_S = 0.36, SEP_SAMPLES = 4, SEP_NEAR_CM = 1.5;
/** surface trips: the drawn heading is the direction of the drawn point's motion over ± this much simulated time (s) */
const HEADING_DT_S = 0.6;
/** surface: the drawn heading follows the wanted heading at no more than this (rad per simulated second), on a grid of this step (s) */
const SURFACE_TURN_RATE = 3.2, HEADING_STEP_S = 0.1;
/** half-length of the tunnel stretch whose slope decides which way is up for an ant in it (cm): long enough that the
 *  body rolls over gradually where a tunnel passes through the vertical */
const UP_WINDOW_CM = 1.8;

// ---------- small frame algebra (unit quaternions; x = forward, y = up) ----------
function basisQ(f: P3, u: P3): Q4 {
  let fx = f.x, fy = f.y, fz = f.z; const fl = Math.hypot(fx, fy, fz); if (fl < 1e-9) { fx = 1; fy = 0; fz = 0; } else { fx /= fl; fy /= fl; fz /= fl; }
  let zx = fy * u.z - fz * u.y, zy = fz * u.x - fx * u.z, zz = fx * u.y - fy * u.x, zl = Math.hypot(zx, zy, zz);
  if (zl < 1e-4) { zx = fy * 1 - fz * 0; zy = fz * 0 - fx * 1; zz = 0; zl = Math.hypot(zx, zy, zz); if (zl < 1e-4) { zx = 0; zy = fz; zz = -fy; zl = Math.hypot(zx, zy, zz); } }
  zx /= zl; zy /= zl; zz /= zl;
  const ux = zy * fz - zz * fy, uy = zz * fx - zx * fz, uz = zx * fy - zy * fx, tr = fx + uy + zz; let q: Q4;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = { w: s / 4, x: (uz - zy) / s, y: (zx - fz) / s, z: (fy - ux) / s }; }
  else if (fx > uy && fx > zz) { const s = Math.sqrt(1 + fx - uy - zz) * 2; q = { w: (uz - zy) / s, x: s / 4, y: (ux + fy) / s, z: (zx + fz) / s }; }
  else if (uy > zz) { const s = Math.sqrt(1 + uy - fx - zz) * 2; q = { w: (zx - fz) / s, x: (ux + fy) / s, y: s / 4, z: (zy + uz) / s }; }
  else { const s = Math.sqrt(1 + zz - fx - uy) * 2; q = { w: (fy - ux) / s, x: (zx + fz) / s, y: (zy + uz) / s, z: s / 4 }; }
  return q;
}
const qFwd = (q: Q4): P3 => ({ x: 1 - 2 * (q.y * q.y + q.z * q.z), y: 2 * (q.x * q.y + q.w * q.z), z: 2 * (q.x * q.z - q.w * q.y) });
const qUp = (q: Q4): P3 => ({ x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) });
const qAngle = (a: Q4, b: Q4) => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));
const qMul = (a: Q4, b: Q4): Q4 => ({ w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w });
/** a turn from frame q0 to a moving target: the way round is fixed once (from q0 to the target's first value t0), then the
 *  target's own motion since is applied on top — a half-turn never flips direction between two instants */
const turnTo = (q0: Q4, t0: Q4, target: Q4, k: number): Q4 => (k >= 1 ? target : qMul(qMul(target, { w: t0.w, x: -t0.x, y: -t0.y, z: -t0.z }), slerp(q0, t0, k)));
function slerp(a: Q4, b: Q4, k: number): Q4 {
  if (k <= 0) return a; if (k >= 1) return b;
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, s = 1; if (d < 0) { d = -d; s = -1; }
  let ka = 1 - k, kb = k; if (d < 0.9995) { const th = Math.acos(d), sn = Math.sin(th); ka = Math.sin((1 - k) * th) / sn; kb = Math.sin(k * th) / sn; }
  const x = a.x * ka + b.x * kb * s, y = a.y * ka + b.y * kb * s, z = a.z * ka + b.z * kb * s, w = a.w * ka + b.w * kb * s, l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

export interface StageStats { troph_events: number; troph_shown: number; larva_feeds: number; larva_visits_shown: number }

export class ColonyStage {
  readonly graph: NestGraph;
  private recs = new Map<string, Rec>();
  private slotOwner = new Map<string, string>();
  private pending = new Map<string, EventMsg>();
  private antLen: number;
  private speed = 1.7;
  private vis: VisModel | null = null;
  private frame: P0a2FrameMsg | null = null;
  private statics: Body[] = [];
  /** larva id → display instant until which its "being fed" highlight shows */
  readonly larvaPulse = new Map<string, { t0: number; t1: number }>();
  readonly stats: StageStats = { troph_events: 0, troph_shown: 0, larva_feeds: 0, larva_visits_shown: 0 };
  private larvaIds: string[] = [];
  constructor(graph: NestGraph, antLen: number) { this.graph = graph; this.antLen = antLen; }

  /** forget every display state (new world, restored save, changed magnification): the next update is a first sight */
  reset(antLen = this.antLen) { this.recs.clear(); this.slotOwner.clear(); this.pending.clear(); this.larvaPulse.clear(); this.antLen = antLen; this.frame = null; Object.assign(this.stats, { troph_events: 0, troph_shown: 0, larva_feeds: 0, larva_visits_shown: 0 }); }
  /** bodies that never move (queens, majors: display places) — workers are kept out of them by the display separation */
  setStatics(list: readonly Body[]) { this.statics = list.map((b) => ({ ...b, mob: 0 })); }

  /** engine events from the Worker (observation only): remembered until the frame that shows their state change */
  onEvents(events: readonly EventMsg[]) {
    for (const e of events) {
      if (!e.entity) continue;
      const d = e.data as { touched?: { amount: number }[]; larvae?: { fed: number }[]; idle_larvae?: unknown[] };
      if (Array.isArray(d.touched)) this.stats.troph_events += d.touched.filter((x) => x.amount > 0).length;
      if (Array.isArray(d.larvae)) this.stats.larva_feeds += d.larvae.filter((x) => x.fed > 0).length;
      if (Array.isArray(d.touched) || Array.isArray(d.larvae)) this.pending.set(e.entity, e);
    }
  }

  // ---------- geometry helpers ----------
  private v() { return this.speed * NEST_SPEED_FACTOR; }
  /** a walking route: the worker's own lane in tunnels, and its own lane in the FRONT part of a chamber floor (the back part
   *  holds the resting places, the brood and the queens) */
  private rt(a: Pos, b: Pos, lane: number): Path { return this.graph.route(a, b, lane, FLOOR_LANE_LO + ((lane + 0.8) / 1.6) * (FLOOR_LANE_HI - FLOOR_LANE_LO)); }
  private mk(t0: number, t1: number, path: Path, a: number, b: number, pose: Pose, partner: string | null, cls: DataClass, f: P3 | null, up: P3 | null = null): Leg {
    return { t0, t1, path, a, b, pose, partner, cls, f, up, fix: false, q0: null, qs: null, tau: 0, lead: 0, o0: 0, turnOdo: 0, qe: null, prevPose: pose, prevWalk: false, ak0: 1, ak1: 1, prof: null };
  }
  private walk(from: Pos, to: Pos, t0: number, t1: number, lane: number, cls: DataClass, cut = 0, pose: Pose = 'walk'): Leg {
    const path = this.rt(from, to, lane);
    return this.mk(t0, t1, path, 0, Math.max(0, path.len - cut), pose, null, cls, null);
  }
  private hold(at: Pos, t0: number, t1: number, pose: Pose, f: P3 | null = null, partner: string | null = null, lift = 0, up: P3 | null = null): Leg {
    const p = this.graph.point(at);
    return this.mk(t0, t1, { pts: [{ x: p.x, y: p.y + lift, z: p.z }], cum: [0], len: 0, edge: [at.edge], es: [at.s] }, 0, 0, pose, partner, 'display', f, up);
  }
  /** a straight climb on the back wall between the floor point and `lift` cm above it (dir +1 up, −1 down) */
  private climb(at: Pos, lift: number, dir: 1 | -1, t0: number): Leg {
    const p = this.graph.point(at), lo = { x: p.x, y: p.y, z: p.z }, hi = { x: p.x, y: p.y + lift, z: p.z }, pts = dir > 0 ? [lo, hi] : [hi, lo];
    return this.mk(t0, t0 + lift / this.v(), { pts, cum: [0, lift], len: lift, edge: [at.edge, at.edge], es: [at.s, at.s] }, 0, lift, 'walk', null, 'display', null, { x: 0, y: 0, z: 1 });
  }
  private endPos(l: Leg): Pos { const q = pathAt(l.path, l.b); return { edge: q.edge, s: q.es, z: q.z }; }
  /** up of an ant standing on the graph at (edge, s): the floor normal; on a tunnel it eases to level where the tunnel meets a floor */
  private upAt(edge: number, s: number): P3 {
    const e = this.graph.edges[edge]; if (e.kind === 'floor') return UP;
    const a = this.graph.point({ edge, s: s - UP_WINDOW_CM, z: 0 }), b = this.graph.point({ edge, s: s + UP_WINDOW_CM, z: 0 }), u = upFor(b.x - a.x, b.y - a.y), ent = this.graph.layout.entrance.id;
    const d = Math.min(e.a === ent ? Infinity : s, e.b === ent ? Infinity : e.len - s), k = smooth(d / 1.6), x = u.x * k, y = u.y * k + (1 - k), z = u.z * k, l = Math.hypot(x, y, z) || 1;
    return { x: x / l, y: y / l, z: z / l };
  }
  /** the frame of a walk leg at arc s: heading = the smoothed path tangent, up = the floor normal of THAT tangent (so the
   *  two are never parallel; where the path passes through the vertical the body rolls over toward the viewer) */
  private legFrame(l: Leg, s: number): Q4 {
    const q = pathAt(l.path, s), dir = l.b >= l.a ? 1 : -1;
    if (l.up) { const p0 = l.path.pts[0], p1 = l.path.pts[l.path.pts.length - 1]; return basisQ(l.path.len > 0 ? { x: (p1.x - p0.x) * dir, y: (p1.y - p0.y) * dir, z: (p1.z - p0.z) * dir } : { x: 1, y: 0, z: 0 }, l.up); }
    // which way is up follows the slope over a longer stretch than the heading does, so the body rolls over gradually
    const a = pathAt(l.path, Math.max(Math.min(l.a, l.b), s - UP_WINDOW_CM)), b = pathAt(l.path, Math.min(Math.max(l.a, l.b), s + UP_WINDOW_CM)), wx = b.x - a.x, wy = b.y - a.y, wl = Math.hypot(wx, wy, b.z - a.z) || 1;
    const h = Math.hypot(wx, wy) / wl, u = upFor(wx, wy), k = smooth(h / 0.25), x = u.x * k, y = u.y * k + (1 - k), z = u.z * k, n = Math.hypot(x, y, z) || 1;
    return basisQ({ x: q.tx * dir, y: q.ty * dir, z: q.tz * dir }, { x: x / n, y: y / n, z: z / n });
  }
  private holdFrame(l: Leg, q0: Q4 | null): Q4 {
    const up = l.up ?? this.upAt(l.path.edge[0], l.path.es[0]);
    return l.f ? basisQ(l.f, up) : q0 ? basisQ(qFwd(q0), up) : basisQ({ x: 1, y: 0, z: 0 }, up);
  }
  /** speed profile of a walk: u (0..1 of the walking time) → arc length; ramps at both ends, slower through bends */
  private profile(l: Leg): { u: Float64Array; s: Float64Array } {
    const len = Math.abs(l.b - l.a), n = Math.max(4, Math.min(160, Math.ceil(len / 0.3))), u = new Float64Array(n + 1), s = new Float64Array(n + 1), w = new Float64Array(n), ramp = RAMP_BODY * this.antLen, dir = l.b >= l.a ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const d = ((i + 0.5) / n) * len, at = l.a + dir * d, bend = qAngle(this.legFrame(l, at - 0.5), this.legFrame(l, at + 0.5)); // how much the body frame turns (yaw, pitch, roll) per cm here
      w[i] = Math.sqrt(Math.min(1, (Math.min(d, len - d) + 0.04 * ramp) / ramp)) / (1 + BEND_SLOW * bend);
    }
    // keep the fastest stretch within 1.45 × the mean walking speed on an engine-timed walk, 2 × on a display-timed one
    // (the drawn speed stays bounded)
    for (let pass = 0; pass < 6; pass++) { let tot = 0, mx = 0; for (let i = 0; i < n; i++) { tot += 1 / w[i]; mx = Math.max(mx, w[i]); } if (mx * tot / n <= (l.cls === 'interp' ? 1.45 : 2)) break; for (let i = 0; i < n; i++) w[i] = (w[i] + mx) / 2; }
    let tot = 0; for (let i = 0; i < n; i++) tot += 1 / w[i];
    let acc = 0; for (let i = 0; i < n; i++) { acc += 1 / w[i]; u[i + 1] = acc / tot; s[i + 1] = ((i + 1) / n) * len; }
    return { u, s };
  }
  /** complete legs[from..]: entry frames, turn times, odometer bases, pose history (pure: depends on the legs only) */
  private finish(r: Rec, from = 0) {
    for (let i = from; i < r.legs.length; i++) {
      const l = r.legs[i], p = i > 0 ? r.legs[i - 1] : null, walking = l.a !== l.b, span = l.t1 - l.t0;
      l.q0 = p ? p.qe : r.q0; l.o0 = p ? p.o0 + p.turnOdo * (p.a === p.b && p.tau > 0 && p.t1 - p.t0 < p.tau ? smooth((p.t1 - p.t0) / p.tau) : 1) + Math.abs(p.b - p.a) : r.odo0; l.prevPose = p ? (p.a !== p.b ? 'walk' : p.pose) : r.pose0; l.prevWalk = p ? p.a !== p.b : r.pose0 === 'walk'; l.ak0 = p ? p.ak1 : r.ak0;
      const target = walking ? this.legFrame(l, l.a) : this.holdFrame(l, l.q0), th = l.q0 ? qAngle(l.q0, target) : 0;
      l.tau = th / TURN_RATE; l.lead = 0; l.qs = target;
      if (walking) {
        if (th > TURN_IN_PLACE_RAD) { const room = Number.isFinite(span) ? Math.max(0, Math.min(0.45 * span, span - Math.abs(l.b - l.a) / (this.v() * VMAX_FACTOR))) : l.tau; l.lead = Math.min(l.tau, room); }
        if (Number.isFinite(span)) l.tau = Math.min(l.tau, Math.max(l.lead, span));
        l.qe = this.legFrame(l, l.b); l.prof = this.profile(l); l.turnOdo = l.lead > 0 ? th * TURN_STEP_PER_RAD * this.antLen * Math.min(1, l.lead * TURN_RATE / th) : 0; // steps for the part of the turn made in place
      } else { l.qe = target; l.turnOdo = th > 0.2 ? th * TURN_STEP_PER_RAD * this.antLen : 0; l.prof = null; }
      // stride reach of the legs: full while walking, none while turning in place (and it stays so until the next walk)
      l.ak1 = walking ? 1 : l.turnOdo > 0 ? 0 : l.ak0;
      // a leg shorter than its turn ends part-way through the turn: the next leg starts from the frame actually reached
      if (l.q0 && Number.isFinite(span) && span < l.tau) l.qe = turnTo(l.q0, l.qs, l.qe, smooth(span / l.tau));
    }
  }
  private legAt(r: Rec, t: number): { leg: Leg; s: number; u: number } | null {
    if (!r.legs.length) return null;
    let leg = r.legs[0]; for (const l of r.legs) { if (l.t0 <= t) leg = l; else break; }
    const span = leg.t1 - leg.t0 - leg.lead, tt = t - leg.t0 - leg.lead, u = span > 0 && Number.isFinite(span) ? Math.max(0, Math.min(1, tt / span)) : (t >= leg.t1 ? 1 : 0);
    let d = 0;
    if (leg.prof && u > 0) { const P = leg.prof, n = P.u.length - 1; let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.u[m] <= u) lo = m; else hi = m; } const k = (u - P.u[lo]) / Math.max(1e-12, P.u[hi] - P.u[lo]); d = u >= 1 ? P.s[n] : P.s[lo] + (P.s[hi] - P.s[lo]) * k; }
    return { leg, u, s: leg.a + (leg.b >= leg.a ? d : -d) };
  }
  private posAt(r: Rec, t: number): Pos { const k = this.legAt(r, t); if (!k) return this.graph.entrancePos(); const q = pathAt(k.leg.path, k.s); return { edge: q.edge, s: q.es, z: q.z }; }
  private walkFor(from: Pos, to: Pos, t0: number, lane: number, cut = 0): Leg {
    const l = this.walk(from, to, t0, t0, lane, 'display', cut); l.t1 = t0 + Math.min(CATCHUP_MAX_S, l.b / this.v() + 0.8); return l;
  }
  private freePlace(chambers: readonly string[], wall: boolean, from: Pos | null, id: string): Place {
    let best: Place | null = null, cost = Infinity; const all: Place[] = [];
    for (const c of chambers) for (const s of chamberPlaces(this.graph, c, this.antLen, wall)) {
      all.push(s); const own = this.slotOwner.get(s.id); if (own && own !== id) continue;
      const k = (from ? this.graph.route(from, s.pos).len : 0) + 14 * u01(`slot|${id}|${s.id}`) + (s.wall ? 6 : 0);
      if (k < cost) { cost = k; best = s; }
    }
    return best ?? all[hash32(`over|${id}`) % all.length];
  }
  private anyPlace(key: string, near: Pos | null): Pos {
    const cs = this.graph.layout.chambers, pick = (k: string): Pos => {
      const tot = cs.reduce((a, c) => a + (WANDER_WEIGHT[c.role] ?? 1), 0); let x = u01(`${k}|c`) * tot, c = cs[0];
      for (const q of cs) { x -= WANDER_WEIGHT[q.role] ?? 1; if (x <= 0) { c = q; break; } }
      // where a wandering worker stops: anywhere in front of the resting places / brood / queens — in the entry chamber, the whole floor
      // (a standing worker gives way to walkers: display separation)
      const open = c.role === 'entry', zLo = open ? this.graph.backZ + 0.9 : 0.35, zHi = 1.5;
      return { edge: this.graph.floorEdge(c.id), s: 1.2 + u01(`${k}|s`) * (c.x1 - c.x0 - 2.4), z: zLo + u01(`${k}|z`) * (zHi - zLo) };
    };
    const a = pick(`${key}|1`); if (!near) return a;
    const b = pick(`${key}|2`); return this.graph.route(near, a).len <= this.graph.route(near, b).len ? a : b;
  }
  private release(r: Rec) { if (r.slot) { if (this.slotOwner.get(r.slot) === r.id) this.slotOwner.delete(r.slot); r.slot = null; } }
  /** a straight walk across the chamber floor at one place along it: from depth z0 to z1 (into / out of a standing place) */
  private zleg(at: Pos, z0: number, z1: number, t0: number, t1: number, cls: DataClass): Leg {
    const p = this.graph.point(at), len = Math.abs(z1 - z0);
    const l = this.mk(t0, t1, { pts: [{ x: p.x, y: p.y, z: z0 }, { x: p.x, y: p.y, z: z1 }], cum: [0, len], len, edge: [at.edge, at.edge], es: [at.s, at.s] }, 0, len, 'walk', null, cls, null); l.fix = true; return l;
  }
  /**
   * Legs that bring a worker to a standing / resting place and keep it there: along the chamber in its walking lane to the
   * place, a turn, straight in between the others (a wall place: through the corridor, then up the wall).
   */
  private toPlace(r: Rec, pl: Place, from: Pos | null, t0: number, pose: Pose, tArrive: number | null, cls: DataClass): Leg[] {
    this.slotOwner.set(pl.id, r.id); r.slot = pl.id;
    const fr = placeFrame(pl), up = pl.wall ? fr.u : null;
    if (!from) { const h = this.hold(pl.pos, t0, Infinity, pose, fr.f, null, pl.lift, up); h.fix = true; return [h]; }
    const out: Leg[] = [], front: Pos = { edge: pl.pos.edge, s: pl.pos.s, z: Math.max(pl.pos.z, PLACE_FRONT_Z) }, dz = front.z - pl.pos.z, tIn = dz / this.v() + (dz > 0 ? 0.7 : 0), tClimb = pl.wall ? pl.lift / this.v() + 0.5 : 0;
    const l = tArrive === null ? this.walkFor(from, front, t0, r.lane) : this.walk(from, front, t0, Math.max(t0, tArrive - (tIn + tClimb) * Math.min(1, Math.max(0, tArrive - t0) / (3 * (tIn + tClimb) + 1e-6))), r.lane, cls);
    out.push(l); let tc = l.t1; const k = tArrive === null ? 1 : Math.max(0, tArrive - tc) / Math.max(1e-6, tIn + tClimb);
    if (dz > 1e-6) { const z = this.zleg(pl.pos, front.z, pl.pos.z, tc, tc + tIn * k, cls === 'interp' ? 'interp' : 'display'); out.push(z); tc = z.t1; }
    if (pl.wall) { const c = this.climb(pl.pos, pl.lift, 1, tc); c.t1 = tc + tClimb * k; out.push(c); tc = c.t1; }
    const h = this.hold(pl.pos, tc, Infinity, pose, fr.f, null, pl.lift, up); h.fix = true; out.push(h); // at its place: never moved
    return out;
  }
  /** legs that bring a worker out of a standing / resting place (down the wall, straight out to the front) before a new plan */
  private outOf(start: Pos, lift: number, T: number, atPlace: boolean): { legs: Leg[]; at: Pos; t: number } {
    const legs: Leg[] = []; let t = T, at = start; if (!atPlace && lift <= 0.02) return { legs, at, t };
    if (lift > 0.02) { const d = this.climb(start, lift, -1, t); legs.push(d); t = d.t1; }
    if (this.graph.edges[start.edge].kind === 'floor' && start.z < PLACE_FRONT_Z - 0.6) { at = { edge: start.edge, s: start.s, z: PLACE_FRONT_Z }; const z = this.zleg(start, start.z, PLACE_FRONT_Z, t, t + (PLACE_FRONT_Z - start.z) / this.v() + 0.4, 'display'); legs.push(z); t = z.t1; }
    return { legs, at, t };
  }

  // ---------- planning ----------
  /** legs that show engine state w.state from place `from` (null = first sight: no previous drawn place) starting at t0 */
  private planState(w: PW, r: Rec, from: Pos | null, t0: number): Leg[] {
    const g = this.graph, E = g.entrancePos(), lane = r.lane; r.deadline = null;
    if (w.state === 'resting') {
      // resting places: the resting chambers and the food-exchange area (展示假設; the engine has no resting place)
      const pl = this.freePlace([...g.chambersOf('rest'), ...g.chambersOf('exchange')].map((c) => c.id), true, from, r.id);
      return this.toPlace(r, pl, from, t0, 'rest', null, 'display');
    }
    if (w.state === 'idle') {
      const start = from ?? this.anyPlace(`idle0|${r.id}|${w.since_s}`, null); r.wander = 0;
      const a = u01(`face|${r.id}|${w.since_s}`) * Math.PI * 2;
      return [this.hold(start, t0, t0 + (from ? 0.2 : 1 + 4 * u01(`idle0h|${r.id}|${w.since_s}`)), 'stand', from ? null : { x: Math.cos(a), y: 0, z: Math.sin(a) })];
    }
    if (w.state === 'brood_care') {
      const ev = this.pending.get(r.id), list = ev && Math.abs(ev.t_sim - w.since_s) < 1e-6 ? ((ev.data as { larvae?: { larva: string; fed: number }[] }).larvae ?? []) : [];
      const visits = [...list].sort((a, b) => Number(b.fed > 0) - Number(a.fed > 0)).slice(0, MAX_VISITS), n = Math.max(1, this.larvaIds.length);
      const out: Leg[] = []; let cur = from, tc = t0;
      const face = (lp: Pos, tgt: Pos): P3 => { const a = g.point(lp), b = g.point(tgt), dx = a.x - b.x, dz = a.z - b.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, y: 0, z: dz / l }; };
      for (const vst of visits) {
        const i = this.larvaIds.indexOf(vst.larva); if (i < 0) continue;
        const lp = larvaSpot(g, i, n, this.antLen), cand = ([-1, 1] as const).map((sd) => carerSpot(g, lp, sd, this.antLen));
        const tgt = !cur ? cand[hash32(`${r.id}|${vst.larva}`) % 2] : g.route(cur, cand[0]).len <= g.route(cur, cand[1]).len ? cand[0] : cand[1];
        if (cur) { const l = this.walkFor(cur, tgt, tc, lane); out.push(l); tc = l.t1; }
        out.push(this.hold(tgt, tc, tc + BROOD_HOLD_S, 'brood', face(lp, tgt), vst.larva));
        if (vst.fed > 0) this.larvaPulse.set(vst.larva, { t0: tc, t1: tc + BROOD_HOLD_S });
        this.stats.larva_visits_shown++; tc += BROOD_HOLD_S; cur = tgt;
      }
      if (!out.length) { // no touched larva known (or first sight): stand next to the brood pile
        const i = hash32(`brood|${r.id}|${w.since_s}`) % n, lp = larvaSpot(g, i, n, this.antLen), tgt = carerSpot(g, lp, hash32(`side|${r.id}|${w.since_s}`) % 2 ? 1 : -1, this.antLen);
        if (cur) { const l = this.walkFor(cur, tgt, tc, lane); out.push(l); tc = l.t1; }
        out.push(this.hold(tgt, tc, Infinity, 'stand', face(lp, tgt)));
      } else out[out.length - 1].t1 = Infinity;
      return out;
    }
    if (w.state === 'to_entrance' && w.until_s !== null) {
      r.deadline = w.until_s;
      const start = from ?? this.freePlace(g.chambersOf('entry').map((c) => c.id), false, null, r.id).pos, tA = from ? t0 : w.since_s;
      if (g.route(start, E).len < 0.5) { // already at the entrance (a forager that turns round): a short way in and back out
        const edge = g.edges[g.entranceEdge], down = Math.min(edge.len, (this.v() * Math.max(0, w.until_s - tA)) / 2.6), inside: Pos = { edge: g.entranceEdge, s: Math.abs(E.s - down), z: lane }, mid = (tA + w.until_s) / 2;
        return [this.walk(E, inside, tA, mid, lane, 'interp'), this.walk(inside, E, mid, w.until_s, lane, 'interp'), this.hold(E, w.until_s, Infinity, 'stand')];
      }
      return [this.walk(start, E, tA, Math.max(tA, w.until_s), lane, 'interp'), this.hold(E, w.until_s, Infinity, 'stand')];
    }
    if (w.state === 'from_entrance' && w.until_s !== null) {
      r.deadline = w.until_s;
      const pl = this.freePlace(g.chambersOf('entry').map((c) => c.id), false, from ?? E, r.id), tA = from ? t0 : w.since_s;
      return this.toPlace(r, pl, from ?? E, tA, 'stand', Math.max(tA, w.until_s), 'interp');
    }
    return [this.hold(from ?? E, t0, Infinity, 'stand')];
  }

  /** more wander legs for an idle worker until the plan covers t (seeded by worker, bout and leg number) */
  private extendWander(r: Rec, t: number) {
    let guard = 0; const w = r.w;
    while (r.legs.length && r.legs[r.legs.length - 1].t1 <= t && guard++ < 400) {
      const last = r.legs[r.legs.length - 1], from = this.endPos(last), k = `wander|${r.id}|${w.since_s}|${r.wander++}`, n0 = r.legs.length;
      const l = this.walkFor(from, this.anyPlace(k, from), last.t1, r.lane), speedK = 0.7 + 0.3 * u01(`${k}|v`); l.t1 = l.t0 + (l.t1 - l.t0) / speedK;
      // a pause: sometimes the ant turns to look another way (seeded)
      const a = u01(`${k}|f`) * Math.PI * 2, look = u01(`${k}|l`) < 0.5 ? { x: Math.cos(a), y: 0, z: Math.sin(a) } : null;
      r.legs.push(l, this.hold(this.endPos(l), l.t1, l.t1 + 2 + 6 * u01(`${k}|h`), 'stand', look));
      this.finish(r, n0);
      if (r.legs.length > 12) r.legs.splice(0, r.legs.length - 12);
    }
  }

  /** the meetings of a forager that just arrived (engine event arrive_nest): legs before its state plan */
  private planArrival(w: PW, r: Rec, t: number): Leg[] {
    const g = this.graph, E = g.entrancePos(), ev = this.pending.get(r.id), out: Leg[] = [];
    const touched = ev && Math.abs(ev.t_sim - w.since_s) < 1e-6 ? ((ev.data as { touched?: { worker: string; amount: number }[] }).touched ?? []).filter((x) => x.amount > 0) : [];
    let cur = E, tc = t, shown = 0; const v = this.v(), gap = this.antLen * MEET_GAP_BODY;
    const deadline = w.state === 'to_entrance' && w.until_s !== null ? w.until_s : t + CATCHUP_MAX_S;
    for (const x of touched) {
      if (shown >= MAX_MEETINGS) break;
      const p = this.recs.get(x.worker); if (!p || p.outside || !p.legs.length || p.over) continue; const pw = p.w;
      const back = (from: Pos) => w.state === 'to_entrance' ? g.route(from, E).len / (v * VMAX_FACTOR) : 0;
      if (p.deadline !== null) {
        // the partner is walking up to the entrance on an engine deadline: meet it on the way (first meeting only)
        if (shown > 0 || pw.state !== 'to_entrance' || this.liftAt(p, tc) > 0.02) continue;
        const pp = this.posAt(p, tc), route = this.rt(cur, pp, r.lane), rem = g.route(pp, E).len, vp = rem / Math.max(1e-6, p.deadline - tc);
        if (route.len <= gap * 1.6) continue;
        const tm = tc + (route.len - gap) / (v + vp) + 0.6, df = (route.len - gap) * v / (v + vp), dp = (route.len - gap) * vp / (v + vp);
        const pPath = this.rt(pp, E, p.lane), pRest = Math.max(0, pPath.len - dp);
        const H = Math.min(TROPH_HOLD_S, p.deadline - tm - pRest / (v * VMAX_FACTOR) - 1.5, deadline - tm - back(pp) - 1.5);
        if (!(H >= MIN_HOLD_S)) continue;
        const fl = this.mk(tc, tm, route, 0, Math.min(route.len, df), 'walk', null, 'display', null);
        out.push(fl, this.hold(this.endPos(fl), tm, tm + H, 'troph', this.dirAt(fl), p.id));
        const pl = this.mk(tc, tm, pPath, 0, Math.min(pPath.len, dp), 'walk', null, 'interp', null), pm = this.endPos(pl);
        this.setPlan(p, [pl, this.hold(pm, tm, tm + H, 'troph', this.dirAt(pl), r.id), this.walk(pm, E, tm + H, p.deadline, p.lane, 'interp'), this.hold(E, p.deadline, Infinity, 'stand')], tc, this.before(p, tc));
        cur = this.endPos(fl); tc = tm + H; shown++; continue;
      }
      // a partner without a deadline: it waits where it is drawn (a walking one pauses), the forager walks up to it
      // (a walking partner stops where it is drawn NOW, at t — never at a place it has not reached yet)
      if (this.liftAt(p, t) > 0.02) continue; // a partner resting on the wall is not met (the forager stays on the floor)
      const still = this.legAt(p, t), moving = !!still && still.leg.a !== still.leg.b && still.u < 1 || p.legs[p.legs.length - 1].t1 !== Infinity;
      const pp = this.posAt(p, moving ? t : tc), route = this.rt(cur, pp, r.lane), tm = tc + Math.max(0, route.len - gap) / v + 0.8;
      const H = Math.min(TROPH_HOLD_S, deadline - tm - back(pp) - 1.5);
      if (!(H >= MIN_HOLD_S) || tm - t > CATCHUP_MAX_S || route.len < gap) continue;
      const fl = this.mk(tc, tm, route, 0, Math.max(0, route.len - gap), 'walk', null, 'display', null), fdir = this.dirAt(fl);
      out.push(fl, this.hold(this.endPos(fl), tm, tm + H, 'troph', fdir, p.id));
      const pface: P3 = { x: -fdir.x, y: -fdir.y, z: -fdir.z };
      if (moving) { const b = this.before(p, t); this.setPlan(p, [this.hold(pp, t, tm + H, 'stand', null)], t, b); p.resume = tm + H; }
      p.over = { t0: tm, t1: tm + H, pose: 'troph', partner: r.id, f: pface };
      cur = this.endPos(fl); tc = tm + H; shown++;
    }
    this.stats.troph_shown += shown;
    return [...out, ...this.planState(w, r, cur, tc)];
  }
  /** did this worker's current state start with an arrive_nest event the page has seen (engine)? */
  private arrival(w: PW): boolean { const ev = this.pending.get(w.id); return !!ev && Array.isArray((ev.data as { touched?: unknown[] }).touched) && Math.abs(ev.t_sim - w.since_s) < 1e-6; }
  private dirAt(l: Leg): P3 { const q = pathAt(l.path, l.b); return { x: q.tx, y: q.ty, z: q.tz }; }
  private liftAt(r: Rec, t: number): number { const k = this.legAt(r, t); if (!k) return 0; const q = pathAt(k.leg.path, k.s); return q.y - this.graph.point({ edge: q.edge, s: q.es, z: 0 }).y; }

  // ---------- the drawn state at an instant (pure given the plans) ----------
  private raw(r: Rec, t: number): Raw {
    const w = r.w, L = this.antLen;
    if (r.outside) {
      const E = this.graph.point(this.graph.entrancePos());
      // the drawn surface point: the display model's point, kept to the right of the display path with a slow seeded meander
      // (none at the two ends of a trip: the engine instants are unchanged)
      const point = (tt: number) => {
        const p = surfacePose(this.vis!, w, tt, L); let x = p.x, z = p.z;
        if (p.where === 'route' && p.fx !== null && w.until_s !== null) { const lat = lateral(w.id, w.since_s, p.dist_cm, Math.min(p.dist_cm, Math.max(0, w.until_s - tt) * this.speed), L), hl = Math.hypot(p.fx, p.fz) || 1; x += (-p.fz / hl) * lat; z += (p.fx / hl) * lat; if (z > BLOCK.z1 - 0.8) z = BLOCK.z1 - 0.8; }
        return { p, x, z };
      };
      const c = point(t), p = c.p, x = c.x, z = c.z; let f: P3 | null = p.fx === null ? null : { x: p.fx, y: p.fy, z: p.fz };
      if (f) {
        // The body's heading FOLLOWS a wanted heading at no more than SURFACE_TURN_RATE. Wanted: on a trip, where the drawn
        // point is going (so no sideways walking); elsewhere the display model's heading. The follower runs on a fixed grid
        // of simulated time that starts with the engine state (not on rendered frames), so it is a pure function of t.
        const wanted = (tt: number): number | null => {
          const q = tt === t ? c : point(tt); if (q.p.fx === null) return null;
          if (q.p.where === 'route' && w.until_s !== null) {
            const tc = Math.max(w.since_s + HEADING_DT_S, Math.min(w.until_s - HEADING_DT_S, tt)), a = point(Math.max(w.since_s, tc - HEADING_DT_S)), b = point(Math.min(w.until_s, tc + HEADING_DT_S)), dx = b.x - a.x, dz = b.z - a.z;
            if (Math.hypot(dx, dz) > 0.25) return Math.atan2(dz, dx);
          }
          return Math.atan2(q.p.fz, q.p.fx);
        };
        const key = `${w.state}|${w.since_s}`; if (r.hd.key !== key) r.hd = { key, th: [] };
        const H = r.hd.th, n = Math.max(0, Math.floor((t - w.since_s) / HEADING_STEP_S)), step = (from: number, tt: number) => { const a = wanted(tt); if (a === null) return from; let d = a - from; d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2; return from + Math.max(-SURFACE_TURN_RATE * HEADING_STEP_S, Math.min(SURFACE_TURN_RATE * HEADING_STEP_S, d)); };
        if (!H.length) H.push(wanted(w.since_s) ?? Math.atan2(f.z, f.x));
        while (H.length <= n + 1 && H.length < 200000) H.push(step(H[H.length - 1], w.since_s + H.length * HEADING_STEP_S));
        const i = Math.min(n, H.length - 2), k = Math.max(0, Math.min(1, (t - w.since_s) / HEADING_STEP_S - i)), ang = H[i] + (H[i + 1] - H[i]) * k;
        f = { x: Math.cos(ang), y: 0, z: Math.sin(ang) };
      }
      const y = ground(x, z), n = normal(x, z);
      const tq = f ? basisQ(f, n) : r.q0 ?? basisQ({ x: 1, y: 0, z: 0 }, n), q = r.q0 && r.tq0 && r.tau0 > 0 ? turnTo(r.q0, r.tq0, tq, smooth((t - r.planT) / r.tau0)) : tq;
      const pose: Pose = w.state === 'feeding' ? 'feed' : p.moving ? 'walk' : 'stand', since = Math.max(0, t - Math.max(r.planT, w.since_s));
      const dE = Math.hypot(x - E.x, z - E.z);
      return { realm: 'surface', x, y, z, q, heading: f !== null, moving: p.moving, turning: false, pose, prev: r.pose0, since, walk: p.moving ? (r.pose0 === 'walk' ? 1 : smooth(since / 0.3)) : r.pose0 === 'walk' ? 1 - smooth(since / 0.35) : 0,
        partner: null, cls: p.schematic ? 'schematic' : p.interpolated ? 'interp' : 'engine', place: p.where === 'route' ? '地表路線' : p.where === 'source' ? '食源' : '搜尋區（示意）', edge: null, odo: r.odo0 + Math.max(0, p.dist_cm - r.dist0), ampK: r.ak0 + (1 - r.ak0) * smooth((t - r.planT) / REACH_BLEND_S), mobK: smooth(dE / 1.4), zLo: BLOCK.z0, zHi: BLOCK.z1 - 0.8, lift: 0 };
    }
    if (w.state === 'idle' && r.resume === null) this.extendWander(r, t);
    const k = this.legAt(r, t)!, l = k.leg, q = pathAt(l.path, k.s), walking = l.a !== l.b, tl = t - l.t0;
    const mv = walking && k.u > 0 && k.u < 1, target = walking ? this.legFrame(l, k.s) : l.qs!, kt = l.tau > 0 ? smooth(tl / l.tau) : 1;
    let qq = l.q0 ? turnTo(l.q0, l.qs!, target, kt) : target;
    const turning = !mv && l.q0 !== null && l.tau > 0 && tl < l.tau && l.turnOdo > 0;
    let pose: Pose, prev: Pose, since: number, walk: number;
    if (mv) { pose = 'walk'; prev = l.lead > 0 ? 'stand' : l.prevPose; since = tl - l.lead; walk = l.lead <= 0 && l.prevWalk ? 1 : smooth(since / 0.3); }
    else if (walking && k.u <= 0) { pose = 'stand'; prev = l.prevPose; since = Math.max(0, tl); walk = l.prevWalk ? 1 - smooth(since / 0.35) : 0; }
    else if (walking) { pose = 'stand'; prev = 'walk'; since = Math.max(0, t - l.t1); walk = 1 - smooth(since / 0.35); }
    else { pose = l.pose === 'walk' ? 'stand' : l.pose; prev = l.prevPose; since = Math.max(0, tl); walk = l.prevWalk ? 1 - smooth(since / 0.35) : 0; }
    let partner = mv ? null : l.partner;
    const ov = r.over;
    if (ov && !mv) {
      // the partner of a meeting turns to face the forager as it comes up, and turns back afterwards
      const TURN = 1.4, ko = smooth((t - (ov.t0 - TURN)) / TURN) * (1 - smooth((t - ov.t1) / TURN));
      if (ov.f && ko > 0) qq = slerp(qq, basisQ(ov.f, l.up ?? this.upAt(q.edge, q.es)), ko);
      if (t >= ov.t0 && t < ov.t1) { prev = pose; pose = ov.pose; since = t - ov.t0; partner = ov.partner; }
      else if (t >= ov.t1 && t < ov.t1 + 1) { prev = ov.pose; since = Math.min(since, t - ov.t1); }
    }
    const e = this.graph.edges[q.edge], onE = q.edge === this.graph.entranceEdge ? Math.abs(q.es - this.graph.entrancePos().s) : Infinity;
    const lift = q.y - this.graph.point({ edge: q.edge, s: q.es, z: 0 }).y;
    const odo = l.o0 + (l.tau > 0 ? l.turnOdo * smooth(tl / (walking ? Math.max(1e-6, l.lead) : l.tau)) : l.turnOdo) + Math.abs(k.s - l.a);
    return { realm: 'nest', x: q.x, y: q.y, z: q.z, q: qq, heading: true, moving: mv, turning, pose, prev, since, walk, partner, cls: mv ? l.cls : 'display', place: e.chamber ?? 'tunnel', edge: q.edge, odo, ampK: l.ak0 + (l.ak1 - l.ak0) * smooth((tl - (walking ? l.lead : 0)) / REACH_BLEND_S),
      mobK: (l.up || lift > 0.02 || (!walking && (l.pose === 'rest' || l.fix)) ? 0 : l.fix ? smooth((q.z - (PLACE_FRONT_Z - 0.8)) / 0.8) : 1) * smooth(onE / 1.4), /* a resting ant is never moved, also while a forager meets it */ zLo: e.kind === 'floor' ? this.graph.backZ + 0.45 : -1.25, zHi: e.kind === 'floor' ? this.graph.faceZ - 0.55 : 1.25, lift };
  }
  private offAt(r: Rec, t: number): P3 { const k = Math.exp(-Math.max(0, t - r.offT) / ABSORB_TAU_S), o = r.off; return Math.hypot(o.x, o.y, o.z) * k < 1e-3 ? { x: 0, y: 0, z: 0 } : { x: o.x * k, y: o.y * k, z: o.z * k }; }
  /** what is drawn for r at instant t under its current plan (before a replan) */
  private before(r: Rec, t: number): Before { const a = this.raw(r, t), o = this.offAt(r, t); return { x: a.x + o.x, y: a.y + o.y, z: a.z + o.z, q: a.q, odo: a.odo, pose: a.pose, ampK: a.ampK }; }
  /** install a new plan that starts at instant T; `b` = what was drawn at T under the old plan (null = first sight) */
  private setPlan(r: Rec, legs: Leg[], T: number, b: Before | null) {
    r.planT = T; r.q0 = b ? b.q : null; r.odo0 = b ? b.odo : 0; r.ak0 = b ? b.ampK : 1; r.pose0 = b ? b.pose : (legs[0]?.a !== legs[0]?.b ? 'walk' : legs[0]?.pose ?? 'stand'); r.legs = legs; r.off = { x: 0, y: 0, z: 0 }; r.offT = T; r.dist0 = 0; r.tau0 = 0; r.tq0 = null;
    if (r.outside) { const p = surfacePose(this.vis!, r.w, T, this.antLen); r.dist0 = p.dist_cm; r.pose0 = b ? b.pose : r.w.state === 'feeding' ? 'feed' : p.moving ? 'walk' : 'stand'; }
    this.finish(r);
    const a = this.raw(r, T);
    if (b) {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, j = Math.hypot(dx, dy, dz);
      if (j > 1e-6 && j <= ABSORB_MAX_CM) r.off = { x: dx, y: dy, z: dz };
      else if (j > ABSORB_MAX_CM) { r.q0 = null; if (!r.outside) this.finish(r); } // a cut (listed discontinuity): no turn from the old frame
      if (r.outside && r.q0) { r.tq0 = a.q; r.tau0 = qAngle(r.q0, a.q) / TURN_RATE; }
    }
  }
  // ---------- frames ----------
  /** take in a Worker frame: every plan change happens here, at the frame's own instant (never at a render instant) */
  ingest(f: P0a2FrameMsg, vis: VisModel) {
    const T = f.t_sim; this.vis = vis; this.frame = f;
    this.speed = f.layout.source_distance_cm / f.layout.travel_s; this.larvaIds = f.larvae.map((l) => l.id);
    const seen = new Set<string>(), changed: { w: PW; r: Rec; first: boolean; b: Before | null; from: Pos | null; lift: number; atPlace: boolean }[] = [];
    for (const r of this.recs.values()) this.resumeDue(r, T);
    for (const w of f.workers) {
      seen.add(w.id); let r = this.recs.get(w.id); const first = !r, key = `${w.state}|${w.since_s}`;
      if (!r) { r = { id: w.id, key: '', state: '', legs: [], slot: null, lane: (u01(`lane|${w.id}`) - 0.5) * 1.6, outside: false, wander: 0, deadline: null, resume: null, over: null, w, off: { x: 0, y: 0, z: 0 }, offT: T, hd: { key: '', th: [] }, planT: T, q0: null, tq0: null, odo0: 0, ak0: 1, pose0: 'stand', dist0: 0, tau0: 0 }; this.recs.set(w.id, r); }
      if (r.key !== key) { const b = first ? null : this.before(r, T), from = first || r.outside ? null : this.posAt(r, T), lift = first || r.outside ? 0 : this.liftAt(r, T), atPlace = !first && !r.outside && !!this.legAt(r, T)?.leg.fix; changed.push({ w, r, first, b, from, lift, atPlace }); } else r.w = w;
    }
    // pass 1: every changed worker gets the plan of its new state (from where it is drawn at T)
    for (const { w, r, first, b, from, lift, atPlace } of changed) {
      const wasOutside = r.outside;
      this.release(r); r.over = null; r.resume = null; r.key = `${w.state}|${w.since_s}`; r.state = w.state; r.outside = OUTSIDE.has(w.state); r.w = w; r.deadline = null;
      if (r.outside) { this.setPlan(r, [], T, b); continue; }
      // a forager that just came home is planned in pass 2 (after its partners); until then it stands at the entrance
      if (!first && this.arrival(w)) { this.setPlan(r, [this.hold(this.graph.entrancePos(), T, Infinity, 'stand')], T, b); continue; }
      if (first) { this.setPlan(r, this.planState(w, r, null, T), T, null); continue; }
      const start = wasOutside || !from ? this.graph.entrancePos() : from;
      // out of a resting / standing place first (down the wall, straight out between the others), then the plan of the new state
      const o = this.outOf(start, lift, T, atPlace); this.setPlan(r, [...o.legs, ...this.planState(w, r, o.at, o.t)], T, b);
    }
    // pass 2: foragers that came home get their meetings (engine arrive_nest event), now that partners are planned
    for (const { w, r, first, b } of changed) { if (first || r.outside) continue; if (this.arrival(w)) this.setPlan(r, this.planArrival(w, r, T), T, b); }
    for (const { r } of changed) this.pending.delete(r.id);
    for (const id of [...this.recs.keys()]) if (!seen.has(id)) { this.release(this.recs.get(id)!); this.recs.delete(id); }
  }
  /** a worker held by a meeting goes on with its state plan at the instant the hold ends (wherever that instant is noticed) */
  private resumeDue(r: Rec, t: number) {
    if (r.resume === null || t < r.resume || r.outside) return;
    const T = r.resume, b = this.before(r, T), at = this.posAt(r, T); r.resume = null; r.over = null; this.release(r);
    this.setPlan(r, this.planState(r.w, r, at, T), T, b);
  }

  /** every worker of the latest ingested frame as drawn at simulated instant t */
  at(t: number): DrawnAnt[] {
    const f = this.frame; if (!f) return [];
    const L = this.antLen, raws: { r: Rec; a: Raw; o: P3 }[] = [], bodies: Body[] = [];
    const body = (r: Rec, a: Raw, o: P3): Body => {
      const fw = qFwd(a.q), mob = a.pose === 'rest' ? 0 : (MOBILITY[a.prev] + (MOBILITY[a.pose] - MOBILITY[a.prev]) * smooth(a.since / 0.6)) * a.mobK;
      return { id: r.id, realm: a.realm, x: a.x + o.x, y: a.y + o.y, z: a.z + o.z, fx: fw.x, fy: fw.y, fz: fw.z, len: L, mob, zLo: a.zLo, zHi: a.zHi, partner: a.partner };
    };
    for (const w of f.workers) {
      const r = this.recs.get(w.id)!; this.resumeDue(r, t);
      if (r.over && t >= r.over.t1 + 1.4) r.over = null;
      const a = this.raw(r, t), o = this.offAt(r, t);
      raws.push({ r, a, o }); bodies.push(body(r, a, o));
    }
    // display separation of bodies: the correction of this instant averaged with those of the last SEP_WINDOW_S of simulated
    // time (each one a pure function of its own instant), so a change of sides is a short glide, never a snap
    const sep = new Map<string, { x: number; z: number }>(), out: DrawnAnt[] = [];
    // (only bodies with another body nearby at t can have had a correction within the window: the others are skipped)
    const near: number[] = [], all = [...bodies, ...this.statics];
    for (let i = 0; i < bodies.length; i++) { const a = bodies[i]; if (all.some((b) => b !== a && b.realm === a.realm && Math.abs(a.x - b.x) < SEP_NEAR_CM + (a.len + b.len) / 2 && Math.abs(a.y - b.y) < SEP_NEAR_CM + (a.len + b.len) / 2 && Math.abs(a.z - b.z) < SEP_NEAR_CM + (a.len + b.len) / 2)) near.push(i); }
    for (let k = 0; k < SEP_SAMPLES && near.length; k++) {
      const tt = t - (k * SEP_WINDOW_S) / (SEP_SAMPLES - 1), bs = near.map((i) => (k === 0 ? bodies[i] : body(raws[i].r, this.raw(raws[i].r, tt), this.offAt(raws[i].r, tt))));
      for (const [id, v] of separate([...bs, ...this.statics])) { const c = sep.get(id) ?? { x: 0, z: 0 }; c.x += v.x / SEP_SAMPLES; c.z += v.z / SEP_SAMPLES; sep.set(id, c); }
    }
    for (let i = 0; i < raws.length; i++) {
      // (the averaged correction is weighted by what this body may give way NOW: exactly none at the entrance instant, on the wall, at rest)
      const { r, a, o } = raws[i], b = bodies[i], s0 = sep.get(r.id), s = s0 && a.mobK > 0 && a.pose !== 'rest' ? { x: s0.x * a.mobK, z: s0.z * a.mobK } : undefined, fw = qFwd(a.q), up = qUp(a.q), w = r.w;
      let x = b.x + (s?.x ?? 0), z = b.z + (s?.z ?? 0), y = b.y; if (a.realm === 'surface' && s) { z = Math.min(z, BLOCK.z1 - 0.8); y = ground(x, z) + o.y; }
      const pv = poseValues(a.prev, a.pose, a.since);
      // two ants coming head-on point their antennae at each other (display; the engine records no such contact)
      let meet = 0;
      for (let j = 0; j < bodies.length; j++) {
        if (j === i || bodies[j].realm !== b.realm) continue; const c = bodies[j], dx = c.x - b.x, dy = c.y - b.y, dz = c.z - b.z, d = Math.hypot(dx, dy, dz); if (d > 1.7 * L || d < 1e-6) continue;
        meet = Math.max(meet, Math.max(0, (fw.x * dx + fw.y * dy + fw.z * dz) / d) * Math.max(0, -(c.fx * dx + c.fy * dy + c.fz * dz) / d) * smooth((1.7 * L - d) / (0.9 * L)));
      }
      if (a.pose !== 'rest' || a.prev !== 'rest') { pv.conv = Math.max(pv.conv, meet * 0.9); pv.antUp += meet * 0.3; }
      const stride = strideCm(r.id, L);
      out.push({ id: w.id, state: w.state, realm: a.realm, x, y, z, fx: fw.x, fy: fw.y, fz: fw.z, ux: up.x, uy: up.y, uz: up.z, heading: a.heading, moving: a.moving, pose: a.pose, crop: w.crop_fill, partner: a.partner, cls: a.cls, place: a.place, edge: a.edge,
        absorbed: Math.hypot(o.x, o.y, o.z), sep: s ? Math.hypot(s.x, s.z) : 0, odo: a.odo, phase: gaitPhase(r.id, a.odo, L), amp: stanceAmp(stride, L) * a.ampK, walk: a.walk, pv, turning: a.turning, len: L });
    }
    for (const [id, p] of this.larvaPulse) if (t >= p.t1 + 5) this.larvaPulse.delete(id);
    return out;
  }
  /**
   * Every worker of the frame at display time t (ingests f when it is a new frame). The last argument is kept for the
   * callers of round 1–3 and is NOT used: nothing in the display director follows the wall clock.
   */
  update(f: P0a2FrameMsg, vis: VisModel, t: number, _dtReal = 0): DrawnAnt[] {
    if (f !== this.frame) this.ingest(f, vis); else this.vis = vis;
    return this.at(t);
  }
  /** is larva `id` shown as being fed at display time t (engine: a feed event; the instant shown is display) */
  fedNow(id: string, t: number): boolean { const p = this.larvaPulse.get(id); return !!p && t >= p.t0 && t < p.t1; }
  /** the planned display route of a worker from display time t on (for the "selected route" line; display) */
  plannedRoute(id: string, t: number): P3[] {
    const r = this.recs.get(id); if (!r || r.outside) return [];
    const out: P3[] = [];
    for (const l of r.legs) { if (l.t1 <= t || l.a === l.b) continue; const n = Math.max(2, Math.ceil(Math.abs(l.b - l.a) / 1)); for (let i = 0; i <= n; i++) { const q = pathAt(l.path, l.a + ((l.b - l.a) * i) / n); out.push({ x: q.x, y: q.y, z: q.z }); } }
    return out;
  }
}
/** unit normal of the drawn ground (surface ants tilt with the terrain) */
export function normal(x: number, z: number): P3 { const d = 0.6, gx = (ground(x + d, z) - ground(x - d, z)) / (2 * d), gz = (ground(x, z + d) - ground(x, z - d)) / (2 * d), l = Math.hypot(gx, 1, gz); return { x: -gx / l, y: 1 / l, z: -gz / l }; }
/** sideways offset (cm, to the right of the heading) of a surface trip at path distance `dist`, `dEnd` cm from the nearer end */
export function lateral(id: string, since: number, dist: number, dEnd: number, antLen: number): number {
  const s = u01(`meander|${id}|${since}`) * 40, n = Math.sin(dist / 6.3 + s) * 0.6 + Math.sin(dist / 2.9 + s * 1.7) * 0.4;
  return antLen * (LANE_BODY + MEANDER_BODY * n) * smooth(dEnd / 4);
}
/** surface trips: lane to the right of the display path and the amplitude of the meander (× body length; 畫面選擇) */
export const LANE_BODY = 0.3, MEANDER_BODY = 0.14;

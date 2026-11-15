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
 */
import type { EventMsg, P0a2FrameMsg } from '../experimental/worker-protocol.ts';
import type { VisModel } from '../vis1-model.ts';
import { hash32 } from '../game-model.ts';
import { NestGraph, pathAt, upFor, type P3, type Path, type Pos } from './nest-graph.ts';
import { surfacePose } from './surface.ts';
import { carerSpot, larvaSpot } from './places.ts';

/** in-nest display walking speed as a multiple of the engine's trail speed (the engine has no in-nest speed; 展示假設) */
export const NEST_SPEED_FACTOR = 1;
/** the longest a display walk may take to bring a worker to the place of its new engine state (s of simulated time) */
export const CATCHUP_MAX_S = 45;
/** how long the head-to-head / larva-tending pose is held (s of simulated time; display) */
export const TROPH_HOLD_S = 6, BROOD_HOLD_S = 5, MIN_HOLD_S = 1.5;
export const MAX_MEETINGS = 3, MAX_VISITS = 4;
/** the fastest a display walk may go (× the in-nest display speed) when a deadline is tight */
export const VMAX_FACTOR = 2.5;
/** jumps of the drawn point up to this size are absorbed (cm); larger ones are cuts */
export const ABSORB_MAX_CM = 4;
/** decay time of an absorbed jump (s of wall time) */
export const ABSORB_TAU_S = 0.25;
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
}
/** drawn-point jumps the display cannot avoid (the legend lists them; the continuity tests allow only these) */
export const STAGE_DISCONTINUITIES = [
  { key: 'search_found', basis: 'engine', label_zh: '搜尋成功→取食／回程：搜尋沒有空間模型，引擎在同一時刻讓工蟻位於食源，畫面從搜尋區（示意）直接到食源旁' },
  { key: 'search_short_failed', basis: 'display_limit', label_zh: '極短的失敗搜尋→回程：回程起點在搜尋示意圈上（畫面只讀目前狀態）' },
  { key: 'first_sight', basis: 'display_limit', label_zh: '開啟頁面、載入存檔或重新開始的第一個畫面：沒有前一個畫面位置，直接放在目前引擎狀態對應的位置' },
] as const;

interface Leg { t0: number; t1: number; path: Path; a: number; b: number; pose: Pose; partner: string | null; cls: DataClass; f: P3 | null }
interface Rec {
  id: string; key: string; state: string; legs: Leg[]; slot: string | null; lane: number; outside: boolean; wander: number;
  /** engine deadline of the current legs (to / from entrance), else null */
  deadline: number | null;
  /** hold given by a meeting: the state plan restarts from there at this instant */
  resume: number | null;
  over: { t0: number; t1: number; pose: Pose; partner: string; f: P3 | null } | null;
  off: P3; last: P3 | null; lastT: number; lastF: P3;
}
type PW = P0a2FrameMsg['workers'][number];
const u01 = (key: string) => (hash32(key) >>> 0) / 4294967296;
const ease = (u: number, f: number) => u <= 0 ? 0 : u >= 1 ? 1 : u < f ? (u * u) / (2 * f * (1 - f)) : u > 1 - f ? 1 - ((1 - u) * (1 - u)) / (2 * f * (1 - f)) : (u - f / 2) / (1 - f);
const WANDER_WEIGHT: Record<string, number> = { entry: 2, exchange: 3, rest: 1, brood: 1.5, queen: 1, pupa: 1 };

export interface StageStats { troph_events: number; troph_shown: number; larva_feeds: number; larva_visits_shown: number }

export class ColonyStage {
  readonly graph: NestGraph;
  private recs = new Map<string, Rec>();
  private slotOwner = new Map<string, string>();
  private pending = new Map<string, EventMsg>();
  private antLen: number;
  private speed = 1.7;
  /** larva id → display instant until which its "being fed" highlight shows */
  readonly larvaPulse = new Map<string, { t0: number; t1: number }>();
  readonly stats: StageStats = { troph_events: 0, troph_shown: 0, larva_feeds: 0, larva_visits_shown: 0 };
  private larvaIds: string[] = [];
  constructor(graph: NestGraph, antLen: number) { this.graph = graph; this.antLen = antLen; }

  /** forget every display state (new world, restored save, changed magnification): the next update is a first sight */
  reset(antLen = this.antLen) { this.recs.clear(); this.slotOwner.clear(); this.pending.clear(); this.larvaPulse.clear(); this.antLen = antLen; Object.assign(this.stats, { troph_events: 0, troph_shown: 0, larva_feeds: 0, larva_visits_shown: 0 }); }

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
  private walk(from: Pos, to: Pos, t0: number, t1: number, lane: number, cls: DataClass, cut = 0, pose: Pose = 'walk'): Leg {
    const path = this.graph.route(from, to, lane);
    return { t0, t1, path, a: 0, b: Math.max(0, path.len - cut), pose, partner: null, cls, f: null };
  }
  private hold(at: Pos, t0: number, t1: number, pose: Pose, f: P3 | null = null, partner: string | null = null): Leg {
    const p = this.graph.point(at);
    return { t0, t1, path: { pts: [p], cum: [0], len: 0, edge: [at.edge], es: [at.s] }, a: 0, b: 0, pose, partner, cls: 'display', f };
  }
  private endPos(l: Leg): Pos { const q = pathAt(l.path, l.b); return { edge: q.edge, s: q.es, z: q.z }; }
  private legAt(r: Rec, t: number): { leg: Leg; s: number; u: number } | null {
    if (!r.legs.length) return null;
    let leg = r.legs[0]; for (const l of r.legs) { if (l.t0 <= t) leg = l; else break; }
    const span = leg.t1 - leg.t0, u = span > 0 && Number.isFinite(span) ? Math.max(0, Math.min(1, (t - leg.t0) / span)) : (t >= leg.t1 ? 1 : 0);
    const f = Math.max(0.03, Math.min(0.3, 1.2 / Math.max(1e-6, span)));
    return { leg, u, s: leg.a + (leg.b - leg.a) * ease(u, f) };
  }
  private posAt(r: Rec, t: number): Pos { const k = this.legAt(r, t); if (!k) return this.graph.entrancePos(); const q = pathAt(k.leg.path, k.s); return { edge: q.edge, s: q.es, z: q.z }; }
  private walkFor(from: Pos, to: Pos, t0: number, lane: number, cut = 0): Leg {
    const l = this.walk(from, to, t0, t0, lane, 'display', cut); l.t1 = t0 + Math.min(CATCHUP_MAX_S, l.b / this.v()); return l;
  }
  private freeSlot(chambers: readonly string[], from: Pos | null, id: string): { id: string; pos: Pos } {
    let best: { id: string; pos: Pos } | null = null, cost = Infinity;
    for (const c of chambers) for (const s of this.graph.slots(c, this.antLen)) {
      const own = this.slotOwner.get(s.id); if (own && own !== id) continue;
      const k = (from ? this.graph.route(from, s.pos).len : 0) + 6 * u01(`slot|${id}|${s.id}`);
      if (k < cost) { cost = k; best = { id: s.id, pos: s.pos }; }
    }
    if (!best) { const all = chambers.flatMap((c) => this.graph.slots(c, this.antLen)), s = all[hash32(`over|${id}`) % all.length]; best = { id: s.id, pos: { ...s.pos, z: s.pos.z + 0.3 } }; }
    return best;
  }
  private anyPlace(key: string, near: Pos | null): Pos {
    const cs = this.graph.layout.chambers, pick = (k: string): Pos => {
      const tot = cs.reduce((a, c) => a + (WANDER_WEIGHT[c.role] ?? 1), 0); let x = u01(`${k}|c`) * tot, c = cs[0];
      for (const q of cs) { x -= WANDER_WEIGHT[q.role] ?? 1; if (x <= 0) { c = q; break; } }
      return { edge: this.graph.floorEdge(c.id), s: 1 + u01(`${k}|s`) * (c.x1 - c.x0 - 2), z: this.graph.backZ + 0.8 + u01(`${k}|z`) * (this.graph.faceZ - this.graph.backZ - 1.8) };
    };
    const a = pick(`${key}|1`); if (!near) return a;
    const b = pick(`${key}|2`); return this.graph.route(near, a).len <= this.graph.route(near, b).len ? a : b;
  }
  private release(r: Rec) { if (r.slot) { if (this.slotOwner.get(r.slot) === r.id) this.slotOwner.delete(r.slot); r.slot = null; } }

  // ---------- planning ----------
  /** legs that show engine state w.state from place `from` (null = first sight: no previous drawn place) starting at t0 */
  private planState(w: PW, r: Rec, from: Pos | null, t0: number): Leg[] {
    const g = this.graph, E = g.entrancePos(), lane = r.lane; r.deadline = null;
    if (w.state === 'resting') {
      // resting places: the resting chambers and the food-exchange area (展示假設; the engine has no resting place)
      const s = this.freeSlot([...g.chambersOf('rest'), ...g.chambersOf('exchange')].map((c) => c.id), from, r.id); this.slotOwner.set(s.id, r.id); r.slot = s.id;
      const face: P3 = { x: u01(`face|${r.id}|${s.id}`) < 0.5 ? 1 : -1, y: 0, z: 0 };
      if (!from) return [this.hold(s.pos, t0, Infinity, 'rest', face)];
      const l = this.walkFor(from, s.pos, t0, lane); return [l, this.hold(s.pos, l.t1, Infinity, 'rest')];
    }
    if (w.state === 'idle') {
      const start = from ?? this.anyPlace(`idle0|${r.id}|${w.since_s}`, null); r.wander = 0;
      return [this.hold(start, t0, t0 + (from ? 0.2 : 1 + 4 * u01(`idle0h|${r.id}|${w.since_s}`)), 'stand', from ? null : { x: u01(`face|${r.id}`) < 0.5 ? 1 : -1, y: 0, z: 0 })];
    }
    if (w.state === 'brood_care') {
      const ev = this.pending.get(r.id), list = ev && Math.abs(ev.t_sim - w.since_s) < 1e-6 ? ((ev.data as { larvae?: { larva: string; fed: number }[] }).larvae ?? []) : [];
      const visits = [...list].sort((a, b) => Number(b.fed > 0) - Number(a.fed > 0)).slice(0, MAX_VISITS), n = Math.max(1, this.larvaIds.length);
      const out: Leg[] = []; let cur = from, tc = t0;
      for (const vst of visits) {
        const i = this.larvaIds.indexOf(vst.larva); if (i < 0) continue;
        const lp = larvaSpot(g, i, n, this.antLen), cand = ([-1, 1] as const).map((sd) => carerSpot(g, lp, sd, this.antLen));
        const tgt = !cur ? cand[hash32(`${r.id}|${vst.larva}`) % 2] : g.route(cur, cand[0]).len <= g.route(cur, cand[1]).len ? cand[0] : cand[1];
        const lpt = g.point(lp), tp = g.point(tgt), face: P3 = { x: Math.sign(lpt.x - tp.x) || 1, y: 0, z: 0 };
        if (cur) { const l = this.walkFor(cur, tgt, tc, lane); out.push(l); tc = l.t1; }
        out.push(this.hold(tgt, tc, tc + BROOD_HOLD_S, 'brood', face, vst.larva));
        if (vst.fed > 0) this.larvaPulse.set(vst.larva, { t0: tc, t1: tc + BROOD_HOLD_S });
        this.stats.larva_visits_shown++; tc += BROOD_HOLD_S; cur = tgt;
      }
      if (!out.length) { // no touched larva known (or first sight): stand next to the brood pile
        const i = hash32(`brood|${r.id}|${w.since_s}`) % n, lp = larvaSpot(g, i, n, this.antLen), tgt = carerSpot(g, lp, hash32(`side|${r.id}|${w.since_s}`) % 2 ? 1 : -1, this.antLen);
        const face: P3 = { x: Math.sign(g.point(lp).x - g.point(tgt).x) || 1, y: 0, z: 0 };
        if (cur) { const l = this.walkFor(cur, tgt, tc, lane); out.push(l); tc = l.t1; }
        out.push(this.hold(tgt, tc, Infinity, 'stand', face));
      } else out[out.length - 1].t1 = Infinity;
      return out;
    }
    if (w.state === 'to_entrance' && w.until_s !== null) {
      r.deadline = w.until_s;
      const start = from ?? this.freeSlot(g.chambersOf('entry').map((c) => c.id), null, r.id).pos, tA = from ? t0 : w.since_s;
      if (g.route(start, E).len < 0.5) { // already at the entrance (a forager that turns round): a short way in and back out
        const edge = g.edges[g.entranceEdge], down = Math.min(edge.len, (this.v() * Math.max(0, w.until_s - tA)) / 2), inside: Pos = { edge: g.entranceEdge, s: Math.abs(E.s - down), z: lane }, mid = (tA + w.until_s) / 2;
        return [this.walk(E, inside, tA, mid, lane, 'interp'), this.walk(inside, E, mid, w.until_s, lane, 'interp'), this.hold(E, w.until_s, Infinity, 'stand')];
      }
      return [this.walk(start, E, tA, Math.max(tA, w.until_s), lane, 'interp'), this.hold(E, w.until_s, Infinity, 'stand')];
    }
    if (w.state === 'from_entrance' && w.until_s !== null) {
      r.deadline = w.until_s;
      const s = this.freeSlot(g.chambersOf('entry').map((c) => c.id), from ?? E, r.id), tA = from ? t0 : w.since_s;
      return [this.walk(from ?? E, s.pos, tA, Math.max(tA, w.until_s), lane, 'interp'), this.hold(s.pos, w.until_s, Infinity, 'stand')];
    }
    return [this.hold(from ?? E, t0, Infinity, 'stand')];
  }

  /** more wander legs for an idle worker until the plan covers t (seeded by worker, bout and leg number) */
  private extendWander(w: PW, r: Rec, t: number) {
    let guard = 0;
    while (r.legs.length && r.legs[r.legs.length - 1].t1 <= t && guard++ < 400) {
      const last = r.legs[r.legs.length - 1], from = this.endPos(last), k = `wander|${r.id}|${w.since_s}|${r.wander++}`;
      const l = this.walkFor(from, this.anyPlace(k, from), last.t1, r.lane), speedK = 0.7 + 0.3 * u01(`${k}|v`); l.t1 = l.t0 + (l.t1 - l.t0) / speedK;
      r.legs.push(l, this.hold(this.endPos(l), l.t1, l.t1 + 2 + 6 * u01(`${k}|h`), 'stand'));
      if (r.legs.length > 12) r.legs.splice(0, r.legs.length - 12);
    }
  }

  /** the meetings of a forager that just arrived (engine event arrive_nest): legs before its state plan */
  private planArrival(w: PW, r: Rec, t: number, byId: Map<string, PW>): Leg[] {
    const g = this.graph, E = g.entrancePos(), ev = this.pending.get(r.id), out: Leg[] = [];
    const touched = ev && Math.abs(ev.t_sim - w.since_s) < 1e-6 ? ((ev.data as { touched?: { worker: string; amount: number }[] }).touched ?? []).filter((x) => x.amount > 0) : [];
    let cur = E, tc = t, shown = 0; const v = this.v(), gap = this.antLen * 0.85;
    const deadline = w.state === 'to_entrance' && w.until_s !== null ? w.until_s : t + CATCHUP_MAX_S;
    for (const x of touched) {
      if (shown >= MAX_MEETINGS) break;
      const p = this.recs.get(x.worker), pw = byId.get(x.worker); if (!p || !pw || p.outside || !p.legs.length || p.over) continue;
      const back = (from: Pos) => w.state === 'to_entrance' ? g.route(from, E).len / (v * VMAX_FACTOR) : 0;
      if (p.deadline !== null) {
        // the partner is walking up to the entrance on an engine deadline: meet it on the way (first meeting only)
        if (shown > 0 || pw.state !== 'to_entrance') continue;
        const pp = this.posAt(p, tc), route = g.route(cur, pp, r.lane), rem = g.route(pp, E).len, vp = rem / Math.max(1e-6, p.deadline - tc);
        if (route.len <= gap * 1.2) continue;
        const tm = tc + (route.len - gap) / (v + vp), df = v * (tm - tc), dp = vp * (tm - tc);
        const pPath = g.route(pp, E, p.lane), pRest = Math.max(0, pPath.len - dp);
        const H = Math.min(TROPH_HOLD_S, p.deadline - tm - pRest / (v * VMAX_FACTOR), deadline - tm - back(pp));
        if (!(H >= MIN_HOLD_S)) continue;
        const fl: Leg = { t0: tc, t1: tm, path: route, a: 0, b: Math.min(route.len, df), pose: 'walk', partner: null, cls: 'display', f: null };
        out.push(fl, { ...this.hold(this.endPos(fl), tm, tm + H, 'troph', null, p.id), f: this.dirAt(fl) });
        const pl: Leg = { t0: tc, t1: tm, path: pPath, a: 0, b: Math.min(pPath.len, dp), pose: 'walk', partner: null, cls: 'interp', f: null }, pm = this.endPos(pl);
        p.legs = [pl, { ...this.hold(pm, tm, tm + H, 'troph', null, r.id), f: this.dirAt(pl) }, this.walk(pm, E, tm + H, p.deadline, p.lane, 'interp'), this.hold(E, p.deadline, Infinity, 'stand')];
        cur = this.endPos(fl); tc = tm + H; shown++; continue;
      }
      // a partner without a deadline: it waits where it is drawn (a walking one pauses), the forager walks up to it
      // (a walking partner stops where it is drawn NOW, at t — never at a place it has not reached yet)
      const still = this.legAt(p, t), moving = !!still && still.leg.a !== still.leg.b && still.u < 1 || p.legs[p.legs.length - 1].t1 !== Infinity;
      const pp = this.posAt(p, moving ? t : tc), route = g.route(cur, pp, r.lane), tm = tc + Math.max(0, route.len - gap) / v;
      const H = Math.min(TROPH_HOLD_S, deadline - tm - back(pp));
      if (!(H >= MIN_HOLD_S) || tm - t > CATCHUP_MAX_S) continue;
      const fl: Leg = { t0: tc, t1: tm, path: route, a: 0, b: Math.max(0, route.len - gap), pose: 'walk', partner: null, cls: 'display', f: null }, fdir = this.dirAt(fl);
      out.push(fl, { ...this.hold(this.endPos(fl), tm, tm + H, 'troph', null, p.id), f: fdir });
      const pface: P3 = { x: -fdir.x, y: -fdir.y, z: -fdir.z };
      if (moving) { p.legs = [this.hold(pp, t, tm + H, 'stand', null)]; p.resume = tm + H; p.over = { t0: tm, t1: tm + H, pose: 'troph', partner: r.id, f: pface }; }
      else p.over = { t0: tm, t1: tm + H, pose: 'troph', partner: r.id, f: pface };
      cur = this.endPos(fl); tc = tm + H; shown++;
    }
    this.stats.troph_shown += shown;
    return [...out, ...this.planState(w, r, cur, tc)];
  }
  /** did this worker's current state start with an arrive_nest event the page has seen (engine)? */
  private arrival(w: PW): boolean { const ev = this.pending.get(w.id); return !!ev && Array.isArray((ev.data as { touched?: unknown[] }).touched) && Math.abs(ev.t_sim - w.since_s) < 1e-6; }
  private dirAt(l: Leg): P3 { const q = pathAt(l.path, l.b); return { x: q.tx, y: q.ty, z: q.tz }; }

  // ---------- per frame ----------
  /**
   * Every worker of the frame at display time t. dtReal = wall seconds since the previous call (only for the decay of
   * absorbed jumps; 0 while paused). The frame is never mutated.
   */
  update(f: P0a2FrameMsg, vis: VisModel, t: number, dtReal: number): DrawnAnt[] {
    this.speed = f.layout.source_distance_cm / f.layout.travel_s; this.larvaIds = f.larvae.map((l) => l.id);
    const byId = new Map(f.workers.map((w) => [w.id, w] as const)), changed: { w: PW; r: Rec; first: boolean }[] = [];
    for (const w of f.workers) {
      let r = this.recs.get(w.id); const first = !r, key = `${w.state}|${w.since_s}`;
      if (!r) { r = { id: w.id, key: '', state: '', legs: [], slot: null, lane: (u01(`lane|${w.id}`) - 0.5) * 1.6, outside: false, wander: 0, deadline: null, resume: null, over: null, off: { x: 0, y: 0, z: 0 }, last: null, lastT: t, lastF: { x: 1, y: 0, z: 0 } }; this.recs.set(w.id, r); }
      if (r.key !== key) changed.push({ w, r, first });
    }
    // pass 1: every changed worker gets the plan of its new state (from where it is drawn now)
    for (const { w, r, first } of changed) {
      const wasOutside = r.outside, from = first ? null : wasOutside ? this.graph.entrancePos() : this.posAt(r, t);
      this.release(r); r.over = null; r.resume = null; r.key = `${w.state}|${w.since_s}`; r.state = w.state; r.outside = OUTSIDE.has(w.state);
      if (r.outside) { r.legs = []; r.deadline = null; continue; }
      // a forager that just came home is planned in pass 2 (after its partners); until then it stands at the entrance
      if (!first && this.arrival(w)) { r.deadline = null; r.legs = [this.hold(this.graph.entrancePos(), t, Infinity, 'stand')]; continue; }
      r.legs = this.planState(w, r, from, t);
    }
    // pass 2: foragers that came home get their meetings (engine arrive_nest event), now that partners are planned
    for (const { w, r, first } of changed) {
      if (first || r.outside) continue;
      if (this.arrival(w)) r.legs = this.planArrival(w, r, t, byId);
    }
    for (const { r } of changed) this.pending.delete(r.id);
    const out: DrawnAnt[] = [];
    for (const w of f.workers) {
      const r = this.recs.get(w.id)!;
      if (r.resume !== null && t >= r.resume && !r.outside) { const at = this.posAt(r, r.resume), t0 = r.resume; r.resume = null; this.release(r); r.legs = this.planState(w, r, at, t0); }
      if (r.over && t >= r.over.t1) r.over = null;
      let d: DrawnAnt;
      if (r.outside) {
        const p = surfacePose(vis, w, t, this.antLen);
        d = { id: w.id, state: w.state, realm: 'surface', x: p.x, y: p.y, z: p.z, fx: p.fx ?? r.lastF.x, fy: p.fx === null ? r.lastF.y : p.fy, fz: p.fx === null ? r.lastF.z : p.fz, ux: 0, uy: 1, uz: 0, heading: p.fx !== null,
          moving: p.moving, pose: w.state === 'feeding' ? 'feed' : p.moving ? 'walk' : 'stand', crop: w.crop_fill, partner: null, cls: p.schematic ? 'schematic' : p.interpolated ? 'interp' : 'engine', place: p.where === 'route' ? '地表路線' : p.where === 'source' ? '食源' : '搜尋區（示意）', edge: null, absorbed: 0 };
      } else {
        if (w.state === 'idle' && r.resume === null) this.extendWander(w, r, t);
        const k = this.legAt(r, t)!, q = pathAt(k.leg.path, k.s), walking = k.leg.a !== k.leg.b, dir = k.leg.b >= k.leg.a ? 1 : -1;
        const mv = walking && k.u > 0 && k.u < 1, ov = r.over && t >= r.over.t0 && t < r.over.t1 ? r.over : null;
        let fwd: P3 = walking ? { x: q.tx * dir, y: q.ty * dir, z: q.tz * dir } : k.leg.f ?? r.lastF; if (ov?.f && !mv) fwd = ov.f;
        const e = this.graph.edges[q.edge], up = e.kind === 'floor' ? { x: 0, y: 1, z: 0 } : this.upOnTunnel(q.edge, q.es);
        d = { id: w.id, state: w.state, realm: 'nest', x: q.x, y: q.y, z: q.z, fx: fwd.x, fy: fwd.y, fz: fwd.z, ux: up.x, uy: up.y, uz: up.z, heading: true, moving: mv,
          pose: ov && !mv ? ov.pose : mv ? 'walk' : k.leg.pose === 'walk' ? 'stand' : k.leg.pose, crop: w.crop_fill, partner: ov && !mv ? ov.partner : mv ? null : k.leg.partner, cls: mv ? k.leg.cls : 'display', place: e.chamber ?? 'tunnel', edge: q.edge, absorbed: 0 };
      }
      // jump absorber: a small sudden displacement of the drawn point is spread over ABSORB_TAU_S of wall time
      const raw = { x: d.x, y: d.y, z: d.z };
      if (r.last) {
        const jump = Math.hypot(raw.x - r.last.x, raw.y - r.last.y, raw.z - r.last.z), allowed = DRAWN_SPEED_BOUND * this.speed * Math.max(0, t - r.lastT) + 0.03;
        if (jump > allowed && jump <= ABSORB_MAX_CM) { r.off.x += r.last.x - raw.x; r.off.y += r.last.y - raw.y; r.off.z += r.last.z - raw.z; }
        else if (jump > ABSORB_MAX_CM) r.off = { x: 0, y: 0, z: 0 };
      }
      const k = dtReal > 0 ? Math.exp(-dtReal / ABSORB_TAU_S) : 1; r.off.x *= k; r.off.y *= k; r.off.z *= k;
      if (Math.hypot(r.off.x, r.off.y, r.off.z) < 1e-4) r.off = { x: 0, y: 0, z: 0 };
      r.last = raw; r.lastT = t; r.lastF = { x: d.fx, y: d.fy, z: d.fz };
      d.x += r.off.x; d.y += r.off.y; d.z += r.off.z; d.absorbed = Math.hypot(r.off.x, r.off.y, r.off.z);
      out.push(d);
    }
    for (const [id, p] of this.larvaPulse) if (t >= p.t1 + 5) this.larvaPulse.delete(id);
    for (const id of [...this.recs.keys()]) if (!byId.has(id)) { this.release(this.recs.get(id)!); this.recs.delete(id); }
    return out;
  }
  /** up vector on a tunnel edge at arc s (floor normal on slopes, toward the viewer on steep shafts; display) */
  private upOnTunnel(edge: number, s: number): P3 {
    const a = this.graph.point({ edge, s: s - 0.7, z: 0 }), b = this.graph.point({ edge, s: s + 0.7, z: 0 });
    return upFor(b.x - a.x, b.y - a.y);
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

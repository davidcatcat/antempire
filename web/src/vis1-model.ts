/**
 * VIS-1 (P0-A2 experiment view) — display poses of the workers from the Worker's P0-A2 frame. Pure and DOM-free.
 * Input: ONLY the frame (engine state) and the display time. Output: where each worker is DRAWN and why:
 *  - outbound / returning: on its trip's display path (vis1-path.ts); exactly at the nest / source at the recorded
 *    departure / arrival instants (engine), display interpolation in between (`interpolated: true`).
 *  - feeding: the engine says "at the source"; the pose is the source point (engine); the drawn spot around the host
 *    stem is a display arrangement (`slot`, cm), reached by a short display walk in the first seconds of the state.
 *  - searching: search has no spatial model → a schematic loop near the nest (`schematic: true`).
 *  - in the nest (resting, idle, brood care, to / from the entrance): no surface position (`vis: 'in_nest'`); the
 *    underground concept view (vis1-underground.ts) groups them by engine state.
 * The frame is never mutated; nothing is written back; no events are generated.
 */
import type { P0a2FrameMsg } from './experimental/worker-protocol.ts';
import type { P0Pose } from './v62-p0a2-model.ts';
import { h01 } from './art-core.ts';
import { hash32 } from './game-model.ts';
import { makeCorridor, poseOnLoop, poseOnTrip, searchLoop, tripPath, type Corridor, type Polyline, type TripPath, type Pt } from './vis1-path.ts';

type PW = P0a2FrameMsg['workers'][number];
export interface VisPose extends P0Pose {
  /** distance walked on the current displayed path (cm; drives the gait phase) — display */
  dist_cm: number;
  /** display walking (legs stepping) — follows the engine state, never invented */
  walking: boolean;
  /** key of the displayed path (trip / search loop / feeding approach) */
  path: string | null;
}
/** radius of the schematic search area around the nest (cm, 示意) */
export const SEARCH_RADIUS_CM = 22;
/** display approach to the feeding spot at the start of 'feeding' (s of simulated time, 示意) */
export const FEED_APPROACH_S = 6;

export class VisModel {
  readonly corridor: Corridor;
  readonly speedCmS: number;
  private trips = new Map<string, TripPath>();
  private loops = new Map<string, Polyline>();
  readonly worldSeed: number; readonly route_cm: number; readonly travel_s: number;
  constructor(worldSeed: number, route_cm: number, travel_s: number) {
    this.worldSeed = worldSeed; this.route_cm = route_cm; this.travel_s = travel_s;
    this.corridor = makeCorridor(worldSeed, route_cm);
    this.speedCmS = route_cm / travel_s;
  }
  static of(f: P0a2FrameMsg): VisModel { return new VisModel(f.seed, f.layout.source_distance_cm, f.layout.travel_s); }
  matches(f: P0a2FrameMsg) { return f.seed === this.worldSeed && f.layout.source_distance_cm === this.route_cm && f.layout.travel_s === this.travel_s; }
  /** cached display path of one trip (same ant + departure instant → same curve) */
  trip(w: PW): TripPath {
    const dir = w.state === 'outbound' ? 'outbound' : 'returning', key = `${w.id}|${w.since_s}|${dir}|${w.route ?? '-'}`;
    let P = this.trips.get(key);
    if (!P) {
      P = tripPath(this.corridor, w.id, w.since_s, w.until_s ?? w.since_s, dir, dir === 'returning' && w.route === null ? searchPoint(w.id, w.since_s) : undefined);
      if (this.trips.size > 400) this.trips.clear();
      this.trips.set(key, P);
    }
    return P;
  }
  loop(w: PW): Polyline {
    const key = `${w.id}|${w.since_s}`;
    let L = this.loops.get(key);
    if (!L) { L = searchLoop(w.id, w.since_s, SEARCH_RADIUS_CM); if (this.loops.size > 200) this.loops.clear(); this.loops.set(key, L); }
    return L;
  }
  /** feeding spot around the host stem (cm offset from the source point; display arrangement, 示意) */
  slot(id: string): Pt { const h = hash32(`slot|${id}`) >>> 0, ang = h01(h, 1, 2, 3) * Math.PI * 2, r = 1.2 + 2.2 * h01(h, 4, 5, 6); return { x: Math.cos(ang) * r, y: Math.sin(ang) * r }; }

  pose(w: PW, t: number): VisPose {
    const base = { id: w.id, interpolated: false, schematic: false };
    if (w.state === 'outbound' || w.state === 'returning') {
      const P = this.trip(w), q = poseOnTrip(P, t);
      return { ...base, x: q.x, y: q.y, heading: q.heading, vis: 'walking', moving: q.k < 1, interpolated: q.interpolated, schematic: P.schematicStart, where: 'route', dist_cm: q.dist_cm, walking: q.k < 1, path: P.key };
    }
    if (w.state === 'feeding') {
      const s = this.slot(w.id), k = Math.max(0, Math.min(1, (t - w.since_s) / FEED_APPROACH_S)), e = k * k * (3 - 2 * k);
      const heading = k < 1 ? Math.atan2(s.y, s.x) : Math.atan2(-s.y, -s.x) + 0.35 * (h01(hash32(w.id), 7, 7, 7) - 0.5);
      return { ...base, x: this.corridor.source.x, y: this.corridor.source.y, heading, vis: 'at_site', moving: k < 1, where: 'source', slot: { dx: s.x * e, dy: s.y * e }, dist_cm: Math.hypot(s.x, s.y) * e, walking: k > 0 && k < 1, path: `feed|${w.id}|${w.since_s}` };
    }
    if (w.state === 'searching') {
      const q = poseOnLoop(this.loop(w), w.since_s, t, this.speedCmS);
      return { ...base, x: q.x, y: q.y, heading: q.heading, vis: 'walking', moving: true, schematic: true, where: 'search', dist_cm: q.dist_cm, walking: true, path: `search|${w.id}|${w.since_s}` };
    }
    return { ...base, x: 0, y: 0, heading: null, vis: 'in_nest', moving: false, where: 'nest', dist_cm: 0, walking: false, path: null };
  }
  poses(f: P0a2FrameMsg, t: number): VisPose[] { return f.workers.map((w) => this.pose(w, t)); }
}
/** schematic point in the search area where a failed searcher starts its way home (示意) */
export function searchPoint(id: string, since: number): Pt { const h = hash32(`sp|${id}|${since}`) >>> 0, a = h01(h, 1, 1, 1) * Math.PI * 2, r = SEARCH_RADIUS_CM * (0.4 + 0.4 * h01(h, 2, 2, 2)); return { x: Math.cos(a) * r, y: Math.sin(a) * r }; }

/** Data classes shown in the legend (Owner directive 2026-11-13: keep engine, display and decoration apart) */
export const VIS_LEGEND = {
  engine: '引擎：工蟻活動狀態與開始時刻、出發／抵達時刻、嗉囊量、路線記憶、幼蟲腸道量、路線長度 200 cm、光照（日／曙暮光／夜）、合成氣溫',
  display: '顯示插值：路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎；步態相位依畫面行走距離；轉向緩和、觸角擺動只是畫面',
  schematic: '示意：路線方向、搜尋中位置（搜尋沒有空間模型）、食源周圍排列、巢內位置、地下概念圖',
  decor: '裝飾：土壤、石頭、礫石、落葉、細枝、草叢、苔蘚、樹冠遮蔭、寄主植物外形——花園景物沒有生態模擬，不是障礙物，螞蟻也不感知它們',
} as const;
export const PATH_LABEL = '路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎';
export const UNDERGROUND_LABEL = '概念圖：巢室幾何尚未模擬';

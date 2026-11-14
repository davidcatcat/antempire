/**
 * VIS-1 (P0-A2 experiment view) — display poses of the workers from the Worker's P0-A2 frame. Pure and DOM-free.
 * Input: ONLY the frame (engine state) and the display time. Output: where each worker is DRAWN and why:
 *  - outbound / returning: on its trip's display path (vis1-path.ts); exactly at the nest / source at the recorded
 *    departure / arrival instants (engine), display interpolation in between (`interpolated: true`).
 *  - feeding: the engine says "at the source"; the pose is the source point (engine); the drawn spot around the host
 *    stem is a display arrangement (`slot`, cm), held for the whole state.
 *  - one display end-point policy at the source (issue #252): every trip that touches the source carries the same slot
 *    offset, blended in over the last SLOT_BLEND_CM of the outbound path and out over the first SLOT_BLEND_CM of the
 *    return path. The pose (x, y) stays on the trip path — exactly the source / nest at the engine departure / arrival
 *    instants, path length and constant speed unchanged; only the DRAWN point (pose + slot) is continuous across
 *    outbound → feeding → returning and outbound → returning. Engine instants are never moved.
 *  - searching: search has no spatial model → a schematic orbit around the nest (`schematic: true`) whose place depends
 *    only on the absolute display time, unfolded from the entrance over the first SEARCH_EMERGE_S of the search; a failed
 *    searcher's way home starts at the orbit point of its departure instant (continuous drawn point).
 *  - the remaining drawn-point discontinuities are listed in VIS_DISCONTINUITIES (engine-defined or 示意 limits).
 *  - in the nest (resting, idle, brood care, to / from the entrance): no surface position (`vis: 'in_nest'`); the
 *    underground concept view (vis1-underground.ts) groups them by engine state.
 * The frame is never mutated; nothing is written back; no events are generated.
 */
import type { P0a2FrameMsg } from './experimental/worker-protocol.ts';
import type { P0Pose } from './v62-p0a2-model.ts';
import { h01 } from './art-core.ts';
import { hash32 } from './game-model.ts';
import { atArc, makeCorridor, orbitArc, poseOnTrip, searchOrbit, tripPath, type Corridor, type Polyline, type TripPath, type Pt } from './vis1-path.ts';

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
/** path length near the source over which the drawn point moves between the trail and the feeding spot (cm, 示意).
 *  The slot is ≤ 3.4 cm, so the drawn speed there is at most 1 + 3.4·1.5/8 ≈ 1.64 × the path speed (measured ≤ 1.62 ×),
 *  and the DRAWN length of a trip differs from the path length (= engine route length within 0.5 %) by ≤ ±1.7 %. */
export const SLOT_BLEND_CM = 8;
/** time over which the schematic search orbit unfolds from the entrance (s of simulated time, 示意). The drawn speed
 *  stays ≤ trail speed + 0.92·R·1.5/SEARCH_EMERGE_S ≈ 1.7 + 2.5 cm/s. */
export const SEARCH_EMERGE_S = 12;
/** path length next to the feeding spot over which the drawn heading turns between facing the stem and walking (cm, 示意) */
export const TURN_CM = 1;
/** bound of the drawn speed used by the continuity tests (× the engine trail speed route / travel time; display) */
export const MAX_DRAWN_SPEED_FACTOR = 4;
const smooth = (k: number) => k * k * (3 - 2 * k), dSmooth = (k: number) => 6 * k * (1 - k);

export class VisModel {
  readonly corridor: Corridor;
  readonly speedCmS: number;
  private trips = new Map<string, TripPath>();
  private orbits = new Map<string, Polyline>();
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
      P = tripPath(this.corridor, w.id, w.since_s, w.until_s ?? w.since_s, dir, dir === 'returning' && w.route === null ? this.searchPoint(w.id, w.since_s) : undefined);
      if (this.trips.size > 400) this.trips.clear();
      this.trips.set(key, P);
    }
    return P;
  }
  /** the ant's schematic search orbit (id only) */
  orbit(id: string): Polyline {
    let L = this.orbits.get(id);
    if (!L) { L = searchOrbit(id, SEARCH_RADIUS_CM); if (this.orbits.size > 200) this.orbits.clear(); this.orbits.set(id, L); }
    return L;
  }
  /** point of the search orbit at absolute display time t (where a failed searcher that departs at t starts home; 示意) */
  searchPoint(id: string, t: number): Pt { return atArc(this.orbit(id), orbitArc(this.orbit(id), id, t, this.speedCmS)).p; }
  /** heading while feeding: facing the host stem (display arrangement, 示意) */
  feedHeading(id: string): number { const s = this.slot(id); return Math.atan2(-s.y, -s.x) + 0.35 * (h01(hash32(id), 7, 7, 7) - 0.5); }
  /** feeding spot around the host stem (cm offset from the source point; display arrangement, 示意) */
  slot(id: string): Pt { const h = hash32(`slot|${id}`) >>> 0, ang = h01(h, 1, 2, 3) * Math.PI * 2, r = 1.2 + 2.2 * h01(h, 4, 5, 6); return { x: Math.cos(ang) * r, y: Math.sin(ang) * r }; }

  pose(w: PW, t: number): VisPose {
    const base = { id: w.id, interpolated: false, schematic: false };
    if (w.state === 'outbound' || w.state === 'returning') {
      const P = this.trip(w), q = poseOnTrip(P, t);
      let heading = q.heading, slot: { dx: number; dy: number } | undefined;
      if (!P.schematicStart) { // the trip touches the source: blend the feeding slot in (outbound end) / out (return start)
        const out = w.state === 'outbound', d = out ? P.line.len - q.dist_cm : q.dist_cm, k = Math.max(0, Math.min(1, d / SLOT_BLEND_CM)), wt = 1 - smooth(k);
        const s = this.slot(w.id); slot = { dx: s.x * wt, dy: s.y * wt };
        if (k > 0 && k < 1) { const dw = -dSmooth(k) / SLOT_BLEND_CM * (out ? -1 : 1); heading = Math.atan2(Math.sin(q.heading) + s.y * dw, Math.cos(q.heading) + s.x * dw); }
        // turn between the feeding heading (facing the stem) and the walking heading over the TURN_CM next to the spot
        const kt = Math.max(0, Math.min(1, d / TURN_CM)), f = this.feedHeading(w.id), dh = Math.atan2(Math.sin(heading - f), Math.cos(heading - f));
        if (kt < 1) heading = f + dh * smooth(kt);
      }
      return { ...base, x: q.x, y: q.y, heading, vis: 'walking', moving: q.k < 1, interpolated: q.interpolated, schematic: P.schematicStart, where: 'route', ...(slot ? { slot } : {}), dist_cm: q.dist_cm, walking: q.k < 1, path: P.key };
    }
    if (w.state === 'feeding') {
      const s = this.slot(w.id);
      return { ...base, x: this.corridor.source.x, y: this.corridor.source.y, heading: this.feedHeading(w.id), vis: 'at_site', moving: false, where: 'source', slot: { dx: s.x, dy: s.y }, dist_cm: 0, walking: false, path: `feed|${w.id}|${w.since_s}` };
    }
    if (w.state === 'searching') {
      const L = this.orbit(w.id), a = atArc(L, orbitArc(L, w.id, t, this.speedCmS)), k = Math.max(0, Math.min(1, (t - w.since_s) / SEARCH_EMERGE_S)), e = smooth(k);
      const de = k > 0 && k < 1 ? dSmooth(k) / SEARCH_EMERGE_S : 0, vx = a.tx * this.speedCmS * e + a.p.x * de, vy = a.ty * this.speedCmS * e + a.p.y * de;
      return { ...base, x: a.p.x * e, y: a.p.y * e, heading: Math.atan2(vy, vx), vis: 'walking', moving: true, schematic: true, where: 'search', dist_cm: Math.max(0, t - w.since_s) * this.speedCmS, walking: true, path: `search|${w.id}|${w.since_s}` };
    }
    return { ...base, x: 0, y: 0, heading: null, vis: 'in_nest', moving: false, where: 'nest', dist_cm: 0, walking: false, path: null };
  }
  poses(f: P0a2FrameMsg, t: number): VisPose[] { return f.workers.map((w) => this.pose(w, t)); }
}
/** the point the renderer draws (cm): the display pose plus its display arrangement offset (vis1-render.ts frame) */
export const drawnPoint = (p: VisPose): Pt => ({ x: p.x + (p.slot?.dx ?? 0), y: p.y + (p.slot?.dy ?? 0) });

/** Every place where the DRAWN point may still jump between two instants 1 ms apart (issue #252 audit; tests/web-vis1-
 *  continuity.test.ts allows a jump above the drawn-speed bound only for these, and counts them). basis: 'engine' = the
 *  engine itself puts the worker elsewhere at that instant; 'display_limit' = the display, which reads only the current
 *  frame, cannot know what it would need; 'concept_view' = the underground concept diagram (chambers not simulated). */
export const VIS_DISCONTINUITIES = [
  { key: 'search_found', basis: 'engine', label_zh: '搜尋成功→取食／回程：搜尋沒有空間模型，引擎在搜尋結束的同一時刻讓工蟻位於食源，畫面從搜尋區（示意）直接跳到食源旁（模型限制）' },
  { key: 'search_short_failed', basis: 'display_limit', label_zh: `失敗搜尋短於 ${SEARCH_EMERGE_S} 秒→回程：搜尋示意圈在出巢後 ${SEARCH_EMERGE_S} 秒內才展開，畫面只讀目前狀態、不知道前一段搜尋何時開始，回程起點會跳到示意圈上` },
  { key: 'nest_concept', basis: 'concept_view', label_zh: '地下概念圖：巢室幾何尚未模擬，工蟻換狀態＝換到另一個概念巢室或通道端，畫面直接重新擺放，不是巢內移動路徑' },
] as const;
export type VisDiscontinuity = typeof VIS_DISCONTINUITIES[number]['key'];
/** which listed discontinuity (if any) a boundary between the immediately consecutive engine states w0 → w1 is */
export function classifyBoundary(w0: PW, w1: PW, _jump: number, view: 'surface' | 'underground'): VisDiscontinuity | null {
  if (view === 'underground') return w0.state !== w1.state ? 'nest_concept' : null;
  if (w0.state !== 'searching') return null;
  if (w1.state === 'feeding' || (w1.state === 'returning' && w1.route !== null)) return 'search_found';
  if (w1.state === 'returning' && w1.route === null && w1.since_s - w0.since_s < SEARCH_EMERGE_S) return 'search_short_failed';
  return null;
}

/** Data classes shown in the legend (Owner directive 2026-11-13: keep engine, display and decoration apart) */
export const VIS_LEGEND = {
  engine: '引擎：工蟻活動狀態與開始時刻、出發／抵達時刻、嗉囊量、路線記憶、幼蟲腸道量、路線長度 200 cm、光照（日／曙暮光／夜）、合成氣溫',
  display: '顯示插值：路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎；步態相位依畫面行走距離；轉向緩和、觸角擺動只是畫面',
  schematic: '示意：路線方向、搜尋中位置（搜尋沒有空間模型）、食源周圍排列、巢內位置、地下概念圖',
  jumps: '畫面跳位（已列出）：搜尋成功時從搜尋區直接到食源（搜尋沒有空間模型）；極短的失敗搜尋回程起點；地下概念圖換巢室',
  decor: '裝飾：土壤、石頭、礫石、落葉、細枝、草叢、苔蘚、樹冠遮蔭、寄主植物外形——花園景物沒有生態模擬，不是障礙物，螞蟻也不感知它們',
} as const;
export const PATH_LABEL = '路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎';
export const UNDERGROUND_LABEL = '概念圖：巢室幾何尚未模擬';

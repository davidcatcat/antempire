/**
 * V6-2 experiment mode, P0-A2 24 h world — pure (DOM-free) display model, shared by v62.ts and the Node tests.
 * Input is ONLY the Worker's P0-A2 frame / events (experimental/worker-protocol.ts). Nothing here runs, steps or changes
 * the simulation, and nothing is written back. Candidate / experiment world, non-official (Owner #201).
 *
 * What the P0-A2 world records and what it does not (docs/p0a2-24h-prototype.md):
 *  - ENGINE STATE: each worker's activity state, location class (nest / nest_transit / outside), the instant the state
 *    started, its own crop fill and route memory; for route travel and in-nest moves the fixed model duration, so the
 *    instant the movement ends (until_s = its pending event); the route LENGTH (source_distance_mm); the light state
 *    the workers sense at the entrance; the synthetic air temperature.
 *  - NOT RECORDED: any 2-D coordinate. The route DIRECTION, a searching worker's whereabouts, and every position inside
 *    the nest are not modelled. They are drawn SCHEMATICALLY (示意) and flagged `schematic: true`.
 * Drawn surface positions:
 *  - outbound / returning: on the straight route nest ↔ source; exactly at the recorded ends at the record instants
 *    (since_s, until_s), DISPLAY INTERPOLATION in between (`interpolated: true`).
 *  - feeding: at the source (engine: the worker is at the source); its slot around the source is a display arrangement.
 *  - searching: schematic point near the nest (search has no spatial model) — `schematic: true`.
 *  - in the nest (resting / idle / brood care / moving to or from the entrance): not on the surface; shown in the
 *    schematic nest inset grouped by ENGINE state (insetSlots).
 */
import type { P0a2FrameMsg, EventMsg } from './experimental/worker-protocol.ts';
import type { AntInput } from './render-scene.ts';
import type { Place } from './model.ts';
import { hash32 } from './game-model.ts';
import { lightFromSun, type LightState } from './art-core.ts';

export const P0A2_STATUS_LABEL = '候選／實驗世界，非正式';
type PW = P0a2FrameMsg['workers'][number];

/** route direction on screen: NOT modelled (示意). Only the length is the engine parameter. */
export const SOURCE_BEARING_RAD = Math.PI / 7;
export interface P0Layout { nest: { x: number; y: number }; source: { x: number; y: number }; distance_cm: number }
export function layoutOf(f: Pick<P0a2FrameMsg, 'layout'>): P0Layout {
  const d = f.layout.source_distance_cm;
  return { nest: { x: 0, y: 0 }, source: { x: d * Math.cos(SOURCE_BEARING_RAD), y: d * Math.sin(SOURCE_BEARING_RAD) }, distance_cm: d };
}

export const STATE_LABEL: Record<string, string> = {
  resting: '巢內休息', idle: '巢內走動', brood_care: '育幼（照顧幼蟲）', to_entrance: '走向巢口', from_entrance: '從巢口回巢內',
  outbound: '沿路線前往食源', searching: '巢外搜尋', feeding: '在食源取食', returning: '回巢途中',
};
export const IN_NEST_STATES = ['resting', 'idle', 'brood_care', 'to_entrance', 'from_entrance'] as const;
export const OUTSIDE_STATES = ['outbound', 'searching', 'feeding', 'returning'] as const;

export interface P0Pose { id: string; x: number; y: number; heading: number | null; vis: 'walking' | 'at_site' | 'in_nest'; moving: boolean; interpolated: boolean; schematic: boolean; where: 'route' | 'source' | 'search' | 'nest'; slot?: { dx: number; dy: number } }

/** Display pose of one P0-A2 worker at display time t (seconds). Exact recorded ends at k <= 0 and k >= 1. */
export function p0Pose(w: PW, t: number, L: P0Layout): P0Pose {
  const base = { id: w.id, interpolated: false, schematic: false };
  if (w.state === 'outbound' || w.state === 'returning') {
    const [a, b] = w.state === 'outbound' ? [L.nest, L.source] : [L.source, L.nest];
    const heading = Math.atan2(b.y - a.y, b.x - a.x), span = (w.until_s ?? w.since_s) - w.since_s, k = span > 0 ? (t - w.since_s) / span : 1;
    if (k <= 0) return { ...base, x: a.x, y: a.y, heading, vis: 'walking', moving: true, where: 'route' };
    if (k >= 1) return { ...base, x: b.x, y: b.y, heading, vis: 'walking', moving: false, where: 'route' };
    return { ...base, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, heading, vis: 'walking', moving: true, interpolated: true, where: 'route' };
  }
  if (w.state === 'feeding') {
    const h = hash32(`slot|${w.id}`), ang = ((h % 360) * Math.PI) / 180, r = 10 + (h % 7);
    return { ...base, x: L.source.x, y: L.source.y, heading: null, vis: 'at_site', moving: false, where: 'source', slot: { dx: Math.cos(ang) * r, dy: Math.sin(ang) * r } };
  }
  if (w.state === 'searching') {
    const h = hash32(`search|${w.id}|${w.since_s}`), ang = ((h % 3600) / 3600) * 2 * Math.PI, r = 12 + ((h >>> 12) % 24);
    return { ...base, x: L.nest.x + r * Math.cos(ang), y: L.nest.y + r * Math.sin(ang), heading: ang, vis: 'at_site', moving: false, schematic: true, where: 'search' };
  }
  return { ...base, x: L.nest.x, y: L.nest.y, heading: null, vis: 'in_nest', moving: false, where: 'nest' };
}
export const p0Poses = (f: P0a2FrameMsg, t: number): P0Pose[] => { const L = layoutOf(f); return f.workers.map((w) => p0Pose(w, t, L)); };
export const p0AntInputs = (poses: readonly P0Pose[]): AntInput[] => poses.map((p) => ({ id: p.id, x: p.x, y: p.y, vis: p.vis, moving: p.moving, heading: p.heading, ...(p.slot ? { displayOffset: { dx: p.slot.dx, dy: p.slot.dy, heading: Math.atan2(-p.slot.dy, -p.slot.dx) } } : {}) }));

/** the engine places of the P0-A2 world for the layered renderer (positions: nest origin; source at the engine
 *  distance along the schematic bearing) */
export function p0Places(f: P0a2FrameMsg): { places: Place[]; pos: Record<string, { x: number; y: number; known: boolean }>; routes: [{ x: number; y: number }, { x: number; y: number }][] } {
  const L = layoutOf(f), sid = f.layout.source_id;
  return {
    places: [
      { id: 'N00', name: 'P0-A2 實驗巢', bearing: null, distance_cm: null, kind: 'nest', layout: { x: 0, y: 0, basis: '畫面原點（巢的位置不是量測值）' } },
      { id: sid, name: '半翅目蜜露源（情境；蚜蟲圖示為示意）', bearing: null, distance_cm: L.distance_cm, kind: 'honeydew', layout: { x: L.source.x, y: L.source.y, basis: '距離＝引擎參數 source_distance_mm；方向示意' } },
    ],
    pos: { N00: { x: 0, y: 0, known: true }, [sid]: { x: L.source.x, y: L.source.y, known: true } },
    routes: [[{ ...L.nest }, { ...L.source }]],
  };
}

/** in-nest inset (示意): engine-state groups and per-worker slots in inset units [0, 1] (positions are NOT modelled) */
export const INSET_ZONES: { key: string; states: readonly string[]; label: string; x: number; y: number; w: number; h: number }[] = [
  { key: 'rest', states: ['resting'], label: '休息', x: 0.02, y: 0.18, w: 0.30, h: 0.80 },
  { key: 'idle', states: ['idle'], label: '巢內走動', x: 0.34, y: 0.18, w: 0.22, h: 0.80 },
  { key: 'brood', states: ['brood_care'], label: '育幼（幼蟲）', x: 0.58, y: 0.18, w: 0.24, h: 0.80 },
  { key: 'transit', states: ['to_entrance', 'from_entrance'], label: '巢口通道', x: 0.84, y: 0.18, w: 0.14, h: 0.80 },
];
export function insetSlots(f: P0a2FrameMsg): { id: string; zone: string; x: number; y: number; state: string }[] {
  const out: { id: string; zone: string; x: number; y: number; state: string }[] = [];
  for (const z of INSET_ZONES) {
    const ws = f.workers.filter((w) => z.states.includes(w.state)), cols = Math.max(1, Math.round(z.w / 0.07)), rows = Math.max(1, Math.ceil(ws.length / cols));
    ws.forEach((w, i) => { const c = i % cols, r = Math.floor(i / cols); out.push({ id: w.id, zone: z.key, state: w.state, x: z.x + (c + 0.5) * (z.w / cols), y: z.y + 0.12 + (r + 0.5) * ((z.h - 0.14) / Math.max(rows, 3)) }); });
  }
  return out;
}

/** counts of workers per engine state (statistics for the player; no worker reads them) */
export function stateCounts(f: P0a2FrameMsg): Record<string, number> {
  const c: Record<string, number> = {}; for (const s of [...IN_NEST_STATES, ...OUTSIDE_STATES]) c[s] = 0;
  for (const w of f.workers) c[w.state] = (c[w.state] ?? 0) + 1;
  return c;
}

export const P0_LIGHT_LABEL: Record<string, string> = { night: '夜', civil_twilight: '曙暮光', day: '日' };
/**
 * Scene light from the world's light state (the state the workers sense) and the sun altitude (general method,
 * engine/clock/solar.ts, computed in the Worker for drawing only). Bucketed so the renderer re-bakes rarely; the
 * shadow DIRECTION (morning east, afternoon west) is schematic.
 */
export function p0Light(f: P0a2FrameMsg): LightState {
  const e = f.env, alt = e.sun_altitude_deg;
  const elev = e.light === 'night' ? -20 : e.light === 'civil_twilight' ? -3 : alt < 15 ? 8 : alt < 40 ? 25 : 55;
  const az = e.light === 'day' ? (e.before_solar_noon ? 105 : 255) : 180;
  const band = e.light === 'day' ? `太陽高度約 ${elev}°（一般方法，分段）、${e.before_solar_noon ? '上午' : '下午'}` : P0_LIGHT_LABEL[e.light];
  return lightFromSun(az, elev, `引擎光照：${P0_LIGHT_LABEL[e.light]}｜${band}｜陰影方向示意`, false);
}

/** one line of the engine-event list for a P0-A2 event (the event's own data, nothing invented) */
export function p0EventText(e: EventMsg): string {
  const d = e.data as Record<string, unknown>;
  switch (e.kind) {
    case 'bout_end': case 'wake': return `${String(d.from ?? '')}→${String(d.choice ?? '')}`;
    case 'at_entrance': return `巢口：${String(d.choice)}（${String(d.light)}，${d.temp_c === null ? '—' : Number(d.temp_c).toFixed(1)}°C 合成）`;
    case 'back_in': return '回到巢內';
    case 'arrive_source': return d.heat ? '食源過熱回頭' : `取食 ${String(d.take ?? 0)} µP${d.found ? '（搜尋找到）' : ''}`;
    case 'search_end': return d.found ? `找到 ${String(d.found)}` : '搜尋未找到';
    case 'feed_end': return `取食結束（嗉囊 ${String(d.crop)} µP${d.loaded ? '，滿載' : ''}）`;
    case 'arrive_nest': return `回巢：接觸 ${Array.isArray(d.touched) ? d.touched.length : 0} 隻同伴${d.loaded ? '（滿載，傳遞路線）' : ''}→${String(d.choice ?? '')}`;
    case 'produce': return `蜜露 +${String(d.amount)} µP（情境，synthetic）`;
    case 'env_light': return `光照→${P0_LIGHT_LABEL[String(d.to)] ?? String(d.to)}`;
    case 'env_sample': return `氣溫 ${d.temp_c === null ? '—' : Number(d.temp_c).toFixed(1)}°C（合成）`;
    case 'env_day': return `新的一天 ${String(d.date)}`;
    default: return '';
  }
}

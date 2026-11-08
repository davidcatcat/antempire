/**
 * Layered renderer — pure (DOM-free) planning layer, shared by render-canvas.ts and the Node tests.
 *  - LAYERS: the fixed 11-layer draw order (docs/game-art-style.md §4).
 *  - camera: world (cm, y = north/up) → screen (CSS px) is an AFFINE map; engine positions are drawn exactly there.
 *  - engine object registry: places with a recorded position (nest, food sources) and their engine state, so overlays
 *    can tell engine objects from 示意 décor.
 *  - décor plan: deterministic per 10 cm cell, kept clear of engine places AND of the straight route segments between
 *    known places (visual only: it never moves anything).
 *  - ant plan: screen position / heading / gait per ant from the caller's frames; inputs are never mutated; a turning
 *    gait only when an authoritative ω is supplied (the replay supplies none).
 *  - weather day state from the engine's DAILY weather (labelled; no rain streaks, no clock minute).
 * Nothing here creates an engine event or reads any engine module.
 */
import { hash32, mulberry32 } from './game-model.ts';
import { selectGait, type Gait } from './art-ant.ts';
import { LEAF_KINDS, type LeafKind } from './art-ground.ts';
import type { Experiment, ExperimentDay, Place } from './model.ts';

export const LAYERS = ['ground', 'decals', 'shadows', 'propsLow', 'routes', 'antShadows', 'ants', 'propsHigh', 'lighting', 'weather', 'ui'] as const;
export type Layer = typeof LAYERS[number];

// ------------------------------------------------------------------ camera
export interface Camera { cx: number; cy: number; s: number; w: number; h: number } // s = CSS px per cm
export const worldToScreen = (c: Camera, x: number, y: number): [number, number] => [c.w / 2 + (x - c.cx) * c.s, c.h / 2 - (y - c.cy) * c.s];
export const screenToWorld = (c: Camera, sx: number, sy: number): [number, number] => [c.cx + (sx - c.w / 2) / c.s, c.cy - (sy - c.h / 2) / c.s];
export function visibleWorld(c: Camera, marginPx = 0) { const [x0, y1] = screenToWorld(c, -marginPx, -marginPx), [x1, y0] = screenToWorld(c, c.w + marginPx, c.h + marginPx); return { x0, y0, x1, y1 }; }

// ------------------------------------------------------------------ engine objects
export type EngineKind = 'nest' | 'honeydew' | 'nectar' | 'carcass';
export interface EngineObject {
  id: string; kind: EngineKind; x: number; y: number; name: string;
  /** drawn footprint radius (cm) — used for décor clearance and picking */
  radiusCm: number;
  hostAlive: boolean | null; colonies: number | null;
  /** which hemipteran sprite: inferred from the place NAME (the engine has no structured field — Owner question) */
  insect: 'aphid' | 'scale';
  source: 'engine';
}
export const FOOTPRINT_CM: Record<EngineKind, number> = { nest: 2.4, honeydew: 2.6, nectar: 1.4, carcass: 1.0 };
type Pos = Record<string, { x: number; y: number; known: boolean }>;
type Sources = Record<string, { host_alive: boolean | null; hemipteran_colonies: number | null }>;
/** Registry of engine places that have a recorded garden position, with their engine state at this moment. */
export function engineRegistry(places: readonly Place[], pos: Pos, sources: Sources, nestId = 'N00'): EngineObject[] {
  const out: EngineObject[] = [];
  for (const p of places) {
    const q = pos[p.id]; if (!q?.known) continue;
    const kind: EngineKind | null = p.id === nestId ? 'nest' : p.kind === 'honeydew' || p.kind === 'nectar' || p.kind === 'carcass' ? p.kind : null;
    if (!kind) continue;
    const s = sources[p.id];
    out.push({ id: p.id, kind, x: q.x, y: q.y, name: p.name, radiusCm: FOOTPRINT_CM[kind], hostAlive: s?.host_alive ?? null, colonies: s?.hemipteran_colonies ?? null, insect: /介殼/.test(p.name) ? 'scale' : 'aphid', source: 'engine' });
  }
  return out;
}
/** Straight segments between known places that the record shows ants walking ('A>B' places), deduplicated. */
export function recordedRoutes(exp: Experiment, pos: Pos): [{ x: number; y: number }, { x: number; y: number }][] {
  const seen = new Set<string>(), out: [{ x: number; y: number }, { x: number; y: number }][] = [];
  for (const d of exp.days) for (const e of d.events) {
    const pl = e.place; if (typeof pl !== 'string' || !pl.includes('>')) continue;
    const [a, b] = pl.split('>'), k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(k) || !pos[a]?.known || !pos[b]?.known) continue;
    seen.add(k); out.push([{ x: pos[a].x, y: pos[a].y }, { x: pos[b].x, y: pos[b].y }]);
  }
  return out;
}

// ------------------------------------------------------------------ décor plan (示意場景)
export type DecorKind = 'leaf' | 'twig' | 'pebble' | 'grass' | 'moss' | 'debris';
export interface DecorItem { kind: DecorKind; x: number; y: number; rot: number; sizeMm: number; seed: number; leafKind?: LeafKind; dry?: number; schematic: true }
export const DECOR_CELL_CM = 10;
/** items per 10 cm × 10 cm cell (遊戲假設: a visual density, not a survey) */
export const DECOR_DENSITY: Record<DecorKind, number> = { leaf: 1.4, pebble: 1.8, twig: 0.12, grass: 0.3, moss: 0.08, debris: 0.35 };
/** footprint radius (cm) of an item, for clearance */
export const decorRadiusCm = (it: Pick<DecorItem, 'kind' | 'sizeMm'>) => (it.kind === 'leaf' || it.kind === 'twig' ? it.sizeMm * 0.5 : it.kind === 'grass' ? it.sizeMm * 0.7 : it.kind === 'debris' ? it.sizeMm : it.sizeMm * 1.2) / 10;
export const CLEAR_PLACE_CM = 3, CLEAR_ROUTE_CM = 1.5;
export interface Obstacles { places: readonly { x: number; y: number; radiusCm: number }[]; routes: readonly [{ x: number; y: number }, { x: number; y: number }][] }
export function distToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
export function isClear(x: number, y: number, r: number, ob: Obstacles): boolean {
  for (const p of ob.places) if (Math.hypot(x - p.x, y - p.y) < p.radiusCm + CLEAR_PLACE_CM + r) return false;
  for (const [a, b] of ob.routes) if (distToSegment(x, y, a, b) < CLEAR_ROUTE_CM + r) return false;
  return true;
}
/** Décor of one 10 cm cell (i, j): deterministic from (seed, i, j), independent of which cells are drawn. */
export function decorCell(seed: number, i: number, j: number, ob: Obstacles): DecorItem[] {
  const r = mulberry32(hash32(`${seed}|decor|${i}|${j}`)), out: DecorItem[] = [], x0 = i * DECOR_CELL_CM, y0 = j * DECOR_CELL_CM;
  for (const kind of Object.keys(DECOR_DENSITY) as DecorKind[]) {
    const lam = DECOR_DENSITY[kind]; let n = Math.floor(lam); if (r() < lam - n) n++;
    for (let k = 0; k < n; k++) {
      const x = x0 + r() * DECOR_CELL_CM, y = y0 + r() * DECOR_CELL_CM, rot = r() * Math.PI * 2, u = r(), s = r() * 1e9 >>> 0;
      const sizeMm = kind === 'leaf' ? 18 + u * 34 : kind === 'pebble' ? 1.2 + Math.pow(u, 2.2) * 9 : kind === 'twig' ? 25 + u * 45 : kind === 'grass' ? 20 + u * 24 : kind === 'moss' ? 4 + u * 6 : 8 + u * 10;
      const it: DecorItem = { kind, x, y, rot, sizeMm, seed: s, schematic: true };
      if (kind === 'leaf') it.leafKind = LEAF_KINDS[Math.floor(r() * LEAF_KINDS.length)];
      if (kind === 'grass') it.dry = 0.3;
      if (isClear(x, y, decorRadiusCm(it), ob)) out.push(it);
    }
  }
  return out;
}

// ------------------------------------------------------------------ ants
/** What the caller supplies per ant (e.g. from game-model.antFrame). Read-only to the renderer. */
export interface AntInput {
  id: string; x: number; y: number; vis: 'walking' | 'at_site' | 'in_nest' | 'unknown_place'; moving: boolean;
  /** recorded edge direction (world radians, y north) or null */
  heading: number | null;
  /** authoritative angular velocity (rad/s, screen frame, + = clockwise). Replay: undefined. */
  omega?: number | null;
  /** DISPLAY arrangement offset in CSS px (lane / site slot) and the heading to use when not on an edge */
  displayOffset?: { dx: number; dy: number; heading?: number };
}
export interface AntLook { h: number; phase: number; sx: number; sy: number }
export interface AntDraw { id: string; sx: number; sy: number; ex: number; ey: number; heading: number; gait: Gait; cycles: number }
export const MIN_ANT_PX = 26, MINOR_LEN_CM = 0.25, MAX_TURN_RATE = 8;
export const antLengthPx = (s: number) => Math.max(MIN_ANT_PX, MINOR_LEN_CM * s);
/** Plan one frame of ants. Pure: returns new draw records and a NEW look map; `ants` and `prev` are not mutated.
 *  ex/ey = the exact affine image of the engine position; sx/sy = ex/ey + the caller's display offset. */
export function planAnts(cam: Camera, ants: readonly AntInput[], prev: ReadonlyMap<string, AntLook>, dt: number, walkCycles: (distPx: number, lenPx: number) => number): { draws: AntDraw[]; look: Map<string, AntLook> } {
  const L = antLengthPx(cam.s), draws: AntDraw[] = [], look = new Map<string, AntLook>();
  for (const a of ants) {
    if (a.vis !== 'walking' && a.vis !== 'at_site') continue;
    const [ex, ey] = worldToScreen(cam, a.x, a.y), off = a.displayOffset, sx = ex + (off?.dx ?? 0), sy = ey + (off?.dy ?? 0);
    const target = a.vis === 'walking' && a.heading !== null ? -a.heading : off?.heading ?? 0;
    const p = prev.get(a.id);
    let h = target, phase = p?.phase ?? (hash32(a.id) % 1000) / 1000;
    if (p) { const dh = Math.atan2(Math.sin(target - p.h), Math.cos(target - p.h)), m = MAX_TURN_RATE * dt; h = p.h + Math.max(-m, Math.min(m, dh)); } // display ease only
    const moved = p ? Math.hypot(sx - p.sx, sy - p.sy) : 0;
    if (a.moving && p) phase += walkCycles(moved, L);
    const gait = selectGait({ moving: a.moving, omega: a.omega ?? null, speedBL: dt > 0 ? moved / dt / L : 0 });
    look.set(a.id, { h, phase, sx, sy });
    draws.push({ id: a.id, sx, sy, ex, ey, heading: h, gait, cycles: phase });
  }
  return { draws, look };
}

// ------------------------------------------------------------------ weather day state
export interface WeatherState { wet: boolean; overcast: boolean; rainStreaks: false; label: string }
/** Day state from the engine's DAILY weather. Rain has no minute in the engine, so streaks are never drawn. */
export function weatherState(w: ExperimentDay['weather'] | null): WeatherState {
  if (!w) return { wet: false, overcast: false, rainStreaks: false, label: '天氣：無資料' };
  const wet = !!w.wet, overcast = w.rain_mm > 0;
  return { wet, overcast, rainStreaks: false, label: `當日天氣（日值）：${w.rain_mm > 0 ? `雨 ${w.rain_mm.toFixed(1)} mm` : '無雨'}${wet ? '・地面潮濕' : ''}` };
}

// ------------------------------------------------------------------ adaptive quality
export interface Quality { level: 0 | 1 | 2 | 3; dprCap: number; glints: boolean; antShadows: boolean; decorLod: 0 | 1; maxBakesPerFrame: number }
export const QUALITY: Quality[] = [
  { level: 0, dprCap: 2, glints: true, antShadows: true, decorLod: 0, maxBakesPerFrame: 2 },
  { level: 1, dprCap: 2, glints: false, antShadows: true, decorLod: 1, maxBakesPerFrame: 1 },
  { level: 2, dprCap: 1, glints: false, antShadows: true, decorLod: 1, maxBakesPerFrame: 1 },
  { level: 3, dprCap: 1, glints: false, antShadows: false, decorLod: 1, maxBakesPerFrame: 1 },
];
/** Step quality down (never up, so it cannot oscillate) when the 75th percentile of recent frame times exceeds the
 *  budget — a sustained cost, not isolated spikes (day changes, first use of a cached bitmap). */
export function nextQuality(level: number, recentFrameMs: readonly number[], budgetMs = 20, window = 60): number {
  if (recentFrameMs.length < window || level >= QUALITY.length - 1) return level;
  const r = [...recentFrameMs.slice(-window)].sort((a, b) => a - b), p75 = r[Math.floor(r.length * 0.75)];
  return p75 > budgetMs ? level + 1 : level;
}
/** LOD 1 drops the smallest décor (debris, moss, small pebbles) — drawing only. */
export const keepAtLod = (it: DecorItem, lod: 0 | 1) => lod === 0 || !(it.kind === 'debris' || it.kind === 'moss' || (it.kind === 'pebble' && it.sizeMm < 2.5));

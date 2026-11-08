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
import { PIVOT_RAD_PER_CYCLE, selectGait, type Gait } from './art-ant.ts';
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

// ------------------------------------------------------------------ world-space ground field (示意)
/** Non-periodic value noise in WORLD space (cm): a lattice hash, so nothing repeats at any zoom and every chunk sees
 *  the same continuous field. Used for large-scale soil colour / moisture variation and for décor density. */
function lattice(seed: number, i: number, j: number): number {
  let h = (seed ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function valueNoise(seed: number, x: number, y: number, period: number): number {
  const fx = x / period, fy = y / period, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = lattice(seed, i, j), b = lattice(seed, i + 1, j), c = lattice(seed, i, j + 1), d = lattice(seed, i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
/** Ground field at a world point: tone (0 dark … 1 pale), moisture (0 … 1), litter density (0 bare … 1 thick),
 *  grass (0 … 1), gravel (0 … 1). Periods 0.6–4.5 m (遊戲假設 composition, not a survey). */
/** Micro-relief height (cm-scale undulation of the soil surface, 示意) at a world point. */
export const reliefHeight = (seed: number, x: number, y: number) => 0.6 * valueNoise(seed + 104729, x, y, 26) + 0.4 * valueNoise(seed + 130363, x, y, 9);
export function groundField(seed: number, x: number, y: number) {
  const n = (k: number, p: number) => valueNoise(seed + k * 7919, x, y, p);
  const tone = 0.5 * n(1, 450) + 0.3 * n(2, 160) + 0.2 * n(3, 60);
  const moist = 0.6 * n(4, 300) + 0.4 * n(5, 90);
  const lit = 0.55 * n(6, 140) + 0.3 * n(7, 55) + 0.15 * n(8, 22);
  const grass = 0.7 * n(9, 180) + 0.3 * n(10, 45);
  const gravel = 0.7 * n(11, 220) + 0.3 * n(12, 70);
  const shape = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return { tone, moist, litter: shape(lit, 0.3, 0.66) ** 1.2, grass: shape(grass, 0.45, 0.75), gravel: shape(gravel, 0.5, 0.82) };
}

// ------------------------------------------------------------------ décor plan (示意場景)
export type DecorKind = 'leaf' | 'twig' | 'pebble' | 'grass' | 'moss' | 'debris';
export interface DecorItem { kind: DecorKind; x: number; y: number; rot: number; sizeMm: number; seed: number; leafKind?: LeafKind; dry?: number; schematic: true }
export const DECOR_CELL_CM = 10;
/** largest distance (cm) an item's footprint can reach outside its own cell (cluster spread + item size) */
export const DECOR_REACH_CM = 12;
/** footprint radius (cm) of an item, for clearance */
export const decorRadiusCm = (it: Pick<DecorItem, 'kind' | 'sizeMm'>) => (it.kind === 'leaf' || it.kind === 'twig' ? it.sizeMm * 0.5 : it.kind === 'grass' ? it.sizeMm * 0.7 : it.kind === 'debris' ? it.sizeMm : it.sizeMm * 1.2) / 10;
export const CLEAR_PLACE_CM = 3, CLEAR_ROUTE_CM = 1.5;
export interface Obstacles {
  places: readonly { x: number; y: number; radiusCm: number }[];
  routes: readonly [{ x: number; y: number }, { x: number; y: number }][];
  /** plants (engine honeydew / nectar places): litter is denser near them (visual composition only) */
  plants?: readonly { x: number; y: number }[];
}
export function distToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
export function isClear(x: number, y: number, r: number, ob: Obstacles): boolean {
  for (const p of ob.places) if (Math.hypot(x - p.x, y - p.y) < p.radiusCm + CLEAR_PLACE_CM + r) return false;
  for (const [a, b] of ob.routes) if (distToSegment(x, y, a, b) < CLEAR_ROUTE_CM + r) return false;
  return true;
}
const poisson = (r: () => number, lam: number) => { let n = 0, p = Math.exp(-lam), c = p; const u = r(); while (u > c && n < 40) { n++; p *= lam / n; c += p; } return n; };
/** Décor of one 10 cm cell (i, j), deterministic from (seed, i, j). Composition (示意): leaf litter in drifts
 *  (Poisson cluster process thinned by a low-frequency litter field, denser near plants), bare patches, rare large
 *  stones with gravel aprons, gravel patches, grass clumps, moss in damp areas; sizes skewed small. */
export function decorCell(seed: number, i: number, j: number, ob: Obstacles): DecorItem[] {
  const r = mulberry32(hash32(`${seed}|decor|${i}|${j}`)), out: DecorItem[] = [], x0 = i * DECOR_CELL_CM, y0 = j * DECOR_CELL_CM;
  const cx = x0 + DECOR_CELL_CM / 2, cy = y0 + DECOR_CELL_CM / 2, f = groundField(seed, cx, cy);
  const near = (ob.plants ?? []).reduce((m, p) => Math.max(m, Math.max(0, 1 - Math.hypot(p.x - cx, p.y - cy) / 40)), 0);
  const litter = Math.min(1, f.litter + near * 0.6);
  const add = (it: Omit<DecorItem, 'seed' | 'schematic'>) => { const full: DecorItem = { ...it, seed: (r() * 4294967296) >>> 0, schematic: true }; if (isClear(full.x, full.y, decorRadiusCm(full), ob)) out.push(full); };
  // leaf-litter drifts: clusters of leaves around a parent point, sizes many small / few large
  for (let c = 0, nc = poisson(r, 0.12 + litter * 2.2); c < nc; c++) {
    const px = x0 + r() * DECOR_CELL_CM, py = y0 + r() * DECOR_CELL_CM, spread = 2 + r() * 4, dir = r() * Math.PI * 2;
    for (let k = 0, nk = 2 + poisson(r, 2 + litter * 6); k < nk; k++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread, u = r();
      add({ kind: 'leaf', x: px + Math.cos(a) * d, y: py + Math.sin(a) * d * 0.7, rot: dir + (r() - 0.5) * 1.6, sizeMm: 12 + 44 * u ** 2.2, leafKind: LEAF_KINDS[Math.floor(r() * LEAF_KINDS.length)] });
    }
    if (r() < 0.25) add({ kind: 'twig', x: px + (r() - 0.5) * 4, y: py + (r() - 0.5) * 4, rot: r() * Math.PI * 2, sizeMm: 20 + 50 * r() ** 1.5 });
    if (r() < 0.5) add({ kind: 'debris', x: px, y: py, rot: 0, sizeMm: 6 + r() * 8 });
  }
  // a rare large stone with a gravel apron
  if (r() < 0.045 + f.gravel * 0.08) {
    const sx = x0 + r() * DECOR_CELL_CM, sy = y0 + r() * DECOR_CELL_CM, R = 8 + r() * 14;
    add({ kind: 'pebble', x: sx, y: sy, rot: 0, sizeMm: R });
    for (let k = 0, nk = 6 + Math.floor(r() * 14); k < nk; k++) { const a = r() * Math.PI * 2, d = (R * 1.2 + r() * R * 1.6) / 10; add({ kind: 'pebble', x: sx + Math.cos(a) * d, y: sy + Math.sin(a) * d, rot: 0, sizeMm: 0.8 + 2.2 * r() ** 2 }); }
  }
  // gravel patches and sparse pebbles (size skewed small)
  for (let k = 0, nk = poisson(r, 0.25 + f.gravel * 6); k < nk; k++) add({ kind: 'pebble', x: x0 + r() * DECOR_CELL_CM, y: y0 + r() * DECOR_CELL_CM, rot: 0, sizeMm: 0.9 + 5 * r() ** 3 });
  // grass clumps: tufts grouped together where the grass field is high
  for (let c = 0, nc = poisson(r, f.grass * 1.1 + near * 0.5); c < nc; c++) {
    const gx = x0 + r() * DECOR_CELL_CM, gy = y0 + r() * DECOR_CELL_CM;
    for (let k = 0, nk = 2 + Math.floor(r() * 4); k < nk; k++) add({ kind: 'grass', x: gx + (r() - 0.5) * 3, y: gy + (r() - 0.5) * 3, rot: 0, sizeMm: 18 + 26 * r(), dry: 0.15 + litter * 0.4 });
  }
  // moss in damp, shaded spots
  if (f.moist > 0.58 && r() < (f.moist - 0.58) * 2) add({ kind: 'moss', x: x0 + r() * DECOR_CELL_CM, y: y0 + r() * DECOR_CELL_CM, rot: 0, sizeMm: 3 + r() * 7 });
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
export interface AntDraw { id: string; sx: number; sy: number; ex: number; ey: number; heading: number; gait: Gait; cycles: number;
  /** the turning frames show the display ease toward a RECORDED heading change (顯示插值), not a physics result */
  turnDisplay: boolean }
/** heading difference (rad) above which the display ease uses the turning frames */
export const TURN_DISPLAY_MIN = 0.08;
export const MIN_ANT_PX = 26, MINOR_LEN_CM = 0.25, MAX_TURN_RATE = 8;
/** drawn ant length: true length (2.5 mm) at this zoom, magnified to at least `minPx` (labelled 放大顯示 ×N) */
export const antLengthPx = (s: number, minPx = MIN_ANT_PX) => Math.max(minPx, MINOR_LEN_CM * s);
/** Plan one frame of ants. Pure: returns new draw records and a NEW look map; `ants` and `prev` are not mutated.
 *  ex/ey = the exact affine image of the engine position; sx/sy = ex/ey + the caller's display offset. */
export function planAnts(cam: Camera, ants: readonly AntInput[], prev: ReadonlyMap<string, AntLook>, dt: number, walkCycles: (distPx: number, lenPx: number) => number, minAntPx = MIN_ANT_PX, displayTurns = false): { draws: AntDraw[]; look: Map<string, AntLook> } {
  const L = antLengthPx(cam.s, minAntPx), draws: AntDraw[] = [], look = new Map<string, AntLook>();
  for (const a of ants) {
    if (a.vis !== 'walking' && a.vis !== 'at_site') continue;
    const [ex, ey] = worldToScreen(cam, a.x, a.y), off = a.displayOffset, sx = ex + (off?.dx ?? 0), sy = ey + (off?.dy ?? 0);
    const target = a.vis === 'walking' && a.heading !== null ? -a.heading : off?.heading ?? 0;
    const p = prev.get(a.id);
    let h = target, phase = p?.phase ?? (hash32(a.id) % 1000) / 1000;
    if (p) { const dh = Math.atan2(Math.sin(target - p.h), Math.cos(target - p.h)), m = MAX_TURN_RATE * dt; h = p.h + Math.max(-m, Math.min(m, dh)); } // display ease only
    const moved = p ? Math.hypot(sx - p.sx, sy - p.sy) : 0;
    if (a.moving && p) phase += walkCycles(moved, L);
    let gait = selectGait({ moving: a.moving, omega: a.omega ?? null, speedBL: dt > 0 ? moved / dt / L : 0 }), turnDisplay = false;
    // display-only turning frames: while the drawn heading eases toward a heading the RECORD changed to (a new edge,
    // or the arrangement heading at a site); positions, times and events are untouched
    if (displayTurns && p && (a.omega === undefined || a.omega === null)) {
      const rest = Math.atan2(Math.sin(target - h), Math.cos(target - h)), turned = Math.atan2(Math.sin(h - p.h), Math.cos(h - p.h));
      if (Math.abs(rest) > TURN_DISPLAY_MIN || Math.abs(turned) > 1e-6) {
        const dir = (Math.abs(turned) > 1e-6 ? turned : rest) > 0;
        gait = a.moving ? (dir ? 'curveR' : 'curveL') : (dir ? 'pivotR' : 'pivotL'); turnDisplay = true;
        if (!a.moving) phase += Math.abs(turned) / PIVOT_RAD_PER_CYCLE;
      }
    }
    look.set(a.id, { h, phase, sx, sy });
    draws.push({ id: a.id, sx, sy, ex, ey, heading: h, gait, cycles: phase, turnDisplay });
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

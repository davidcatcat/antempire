/**
 * Art kit core (PR A, drawing only): a tiny vector "draw list" format shared by every asset generator.
 * Generators are pure and DOM-free: they return SVG path strings plus paint specs, so the same seed always gives the
 * same text (tests compare it in Node). art-raster.ts turns a draw list into canvas pixels in the browser.
 * Nothing here reads or writes simulation data; every shape is decorative or a drawing of an engine object's state.
 * Convention: local units, +x = right/forward, +y = down (screen). Lighting comes from the active LightState below.
 */
import { hash32, mulberry32 } from './game-model.ts';

export { hash32, mulberry32 };
export type Rng = () => number;
/** Integer lattice hash in [0,1): avalanche-mixed (murmur3 finaliser) so neighbouring cells are uncorrelated. */
export function h01(seed: number, a: number, b: number, c: number): number {
  let h = (seed ^ Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const rng = (seed: number | string): Rng => mulberry32(typeof seed === 'string' ? hash32(seed) : seed >>> 0);

/**
 * Light state. Every generator reads the ACTIVE light (set with withLight) at call time, so the same assets can be
 * produced under any sun position. Replay mode uses SCHEMATIC_LIGHT: a fixed, labelled schematic key light from the
 * upper left — the replay data has a 360-minute activity window and no time of day. A real day-night look is wired
 * only when the engine supplies real time and sun position (P0-A1 engine/clock/solar.ts; V6-2).
 * Frame: screen x right, y down; map north = screen up. azimuth = compass bearing of the sun (deg, 0 = north/up,
 * 90 = east/right); elevation = sun height above the horizon (deg).
 */
export interface LightState {
  label: string; schematic: boolean; azimuthDeg: number; elevationDeg: number;
  /** unit screen vector the light travels along (from the sun toward the ground) */
  dir: { x: number; y: number };
  /** screen offset of a cast shadow per unit of object height (0 when the sun is down) */
  shadow: { x: number; y: number };
  /** 0..1 direct light strength; ambient fill 0..1; colour grade applied over the scene */
  intensity: number; ambient: number; grade: string;
}
const MAX_SHADOW_PER_HEIGHT = 4;
export function lightFromSun(azimuthDeg: number, elevationDeg: number, label: string, schematic = false): LightState {
  const az = (azimuthDeg * Math.PI) / 180, el = (Math.max(-90, Math.min(90, elevationDeg)) * Math.PI) / 180;
  const toSun = { x: Math.sin(az), y: -Math.cos(az) }, dir = { x: -toSun.x, y: -toSun.y };
  const up = el > 0, len = up ? Math.min(MAX_SHADOW_PER_HEIGHT, 1 / Math.tan(el)) : 0;
  const s = up ? Math.sin(el) : 0, intensity = up ? Math.min(1, 0.25 + s * 1.1) : 0;
  const warm = up ? Math.max(0, 1 - s * 3) : 0; // low sun → warm grade (一般物理示意, not a radiative model)
  const grade = !up ? 'rgba(70,86,130,0.62)' : `rgba(255,${Math.round(236 - warm * 70)},${Math.round(214 - warm * 120)},${(0.1 + warm * 0.25).toFixed(3)})`;
  return { label, schematic, azimuthDeg, elevationDeg, dir, shadow: { x: dir.x * len, y: dir.y * len }, intensity, ambient: up ? 0.55 + s * 0.2 : 0.35, grade };
}
/** Fixed schematic key light for replay mode (from the upper left, ≈47° high): labelled 示意, not a time of day. */
export const SCHEMATIC_LIGHT: LightState = lightFromSun(323.13, 47.1, '示意固定光源（重播資料沒有時刻）', true);
let ACTIVE: LightState = SCHEMATIC_LIGHT;
/** The light generators use right now. */
export const light = (): LightState => ACTIVE;
/** Run `fn` with `l` as the active light (synchronous, restored afterwards). */
export function withLight<T>(l: LightState, fn: () => T): T { const prev = ACTIVE; ACTIVE = l; try { return fn(); } finally { ACTIVE = prev; } }

export type Stop = [number, string];
export type Paint = string | { lin: [number, number, number, number]; stops: Stop[] } | { rad: [number, number, number, number, number, number]; stops: Stop[] };
export interface Shape {
  /** SVG path data in local units */
  d: string;
  fill?: Paint;
  stroke?: Paint;
  /** stroke width in local units */
  lw?: number;
  /** minimum stroke width in device px (keeps outlines visible when small) */
  minPx?: number;
  alpha?: number;
  cap?: 'round' | 'butt';
  evenodd?: boolean;
  /** compositing hint: 'multiply' for shading/AO, 'screen' for glints */
  blend?: 'multiply' | 'screen';
}
export type DrawList = Shape[];

/** Fixed-precision number formatting so path text is identical everywhere. */
export const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** Minimal path builder producing SVG path data. */
export class P {
  private s: string[] = [];
  M(x: number, y: number) { this.s.push(`M${f2(x)} ${f2(y)}`); return this; }
  L(x: number, y: number) { this.s.push(`L${f2(x)} ${f2(y)}`); return this; }
  Q(cx: number, cy: number, x: number, y: number) { this.s.push(`Q${f2(cx)} ${f2(cy)} ${f2(x)} ${f2(y)}`); return this; }
  C(a: number, b: number, c: number, d: number, x: number, y: number) { this.s.push(`C${f2(a)} ${f2(b)} ${f2(c)} ${f2(d)} ${f2(x)} ${f2(y)}`); return this; }
  Z() { this.s.push('Z'); return this; }
  add(d: string) { if (d) this.s.push(d); return this; }
  toString() { return this.s.join(''); }
}

/** Ellipse (rotated by rot radians) as four cubic arcs. */
export function ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0): string {
  const k = 0.5522847, c = Math.cos(rot), s = Math.sin(rot);
  const T = (x: number, y: number) => [cx + x * c - y * s, cy + x * s + y * c] as const;
  const p = new P(), a = T(rx, 0); p.M(a[0], a[1]);
  const q: [number, number][][] = [
    [[rx, k * ry], [k * rx, ry], [0, ry]], [[-k * rx, ry], [-rx, k * ry], [-rx, 0]],
    [[-rx, -k * ry], [-k * rx, -ry], [0, -ry]], [[k * rx, -ry], [rx, -k * ry], [rx, 0]],
  ];
  for (const [u, v, w] of q) { const A = T(u[0], u[1]), B = T(v[0], v[1]), W = T(w[0], w[1]); p.C(A[0], A[1], B[0], B[1], W[0], W[1]); }
  return p.Z().toString();
}

/** Closed smooth curve through points (Catmull-Rom → cubic Bézier). */
export function smoothClosed(pts: [number, number][], tension = 1): string {
  const n = pts.length, p = new P(); p.M(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n], t = tension / 6;
    p.C(p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t, p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t, p2[0], p2[1]);
  }
  return p.Z().toString();
}
/** Open smooth curve through points. */
export function smoothOpen(pts: [number, number][]): string {
  const n = pts.length, p = new P(); p.M(pts[0][0], pts[0][1]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    p.C(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  return p.toString();
}
/** Irregular blob radius profile (closed, deterministic). */
export function blobPoints(r: Rng, cx: number, cy: number, rx: number, ry: number, n: number, jitter: number, rot = 0): [number, number][] {
  const out: [number, number][] = [], ph = r() * 6.283, c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, k = 1 + (r() - 0.5) * 2 * jitter + Math.sin(a * 2 + ph) * jitter * 0.5;
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k; out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}

/** Soft elliptical shadow (radial gradient, no blur filter so it bakes the same on every browser). */
export function softShadow(cx: number, cy: number, rx: number, ry: number, strength = 0.35, rot = 0): Shape {
  const r = Math.max(rx, ry);
  return { d: ellipse(cx, cy, rx, ry, rot), fill: { rad: [cx, cy, 0, cx, cy, r], stops: [[0, `rgba(28,16,6,${strength})`], [0.55, `rgba(28,16,6,${(strength * 0.55).toFixed(3)})`], [1, 'rgba(28,16,6,0)']] }, blend: 'multiply' };
}

export const hsl = (h: number, s: number, l: number, a = 1) => a >= 1 ? `hsl(${f2(h)},${f2(s)}%,${f2(l)}%)` : `hsla(${f2(h)},${f2(s)}%,${f2(l)}%,${f2(a)})`;
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Translate / rotate / scale a whole draw list by rewriting its path text (pure, used to place decals). */
export function transformPath(d: string, tx: number, ty: number, rot = 0, sc = 1): string {
  const c = Math.cos(rot) * sc, s = Math.sin(rot) * sc;
  return d.replace(/([MLQCZ])([^MLQCZ]*)/g, (_m, cmd: string, args: string) => {
    if (cmd === 'Z') return 'Z';
    const n = args.trim().split(/[\s,]+/).map(Number), o: string[] = [];
    for (let i = 0; i < n.length; i += 2) o.push(`${f2(tx + n[i] * c - n[i + 1] * s)} ${f2(ty + n[i] * s + n[i + 1] * c)}`);
    return cmd + o.join(' ');
  });
}
function transformPaint(p: Paint | undefined, tx: number, ty: number, rot: number, sc: number): Paint | undefined {
  if (!p || typeof p === 'string') return p;
  const c = Math.cos(rot) * sc, s = Math.sin(rot) * sc, T = (x: number, y: number) => [tx + x * c - y * s, ty + x * s + y * c];
  if ('lin' in p) { const [a, b] = T(p.lin[0], p.lin[1]), [e, f] = T(p.lin[2], p.lin[3]); return { lin: [a, b, e, f], stops: p.stops }; }
  const [a, b] = T(p.rad[0], p.rad[1]), [e, f] = T(p.rad[3], p.rad[4]); return { rad: [a, b, p.rad[2] * sc, e, f, p.rad[5] * sc], stops: p.stops };
}
export function place(list: DrawList, tx: number, ty: number, rot = 0, sc = 1): DrawList {
  return list.map((s) => ({ ...s, d: transformPath(s.d, tx, ty, rot, sc), fill: transformPaint(s.fill, tx, ty, rot, sc), stroke: transformPaint(s.stroke, tx, ty, rot, sc), lw: s.lw === undefined ? undefined : s.lw * sc }));
}
/** Stable text digest of a draw list (for determinism tests). */
export const digest = (list: DrawList) => hash32(JSON.stringify(list)).toString(16);

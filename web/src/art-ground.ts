/**
 * Art kit: ground (drawing only, 示意場景). Pure and DOM-free.
 *  - soilTile(): seamless procedural soil texture as RGBA pixels (periodic multi-octave value noise height field,
 *    lit by the fixed key light, crumbs, sand grains, darker moist patches; a wet variant).
 *  - decals in MILLIMETRE units placed at (x, y, rot): leaf litter (lanceolate, ovate, decayed with holes, curled,
 *    skeletonised), twigs, pebbles (contact shadow + ambient occlusion), grass tufts split into a LOW layer (under ants)
 *    and a HIGH layer (blade tips overhanging ants), moss cushions, seeds and debris.
 * Lighting is computed after rotation, in the screen frame, so a decal placed at any angle is lit from the upper left.
 * None of this is a survey of a real garden; species of the litter and grass are not identified (示意).
 */
import { light, type LightState, P, blobPoints, clamp, ellipse, h01, hash32, hsl, lerp, rng, smoothClosed, smoothOpen, softShadow, type DrawList, type Rng, type Shape } from './art-core.ts';

// ------------------------------------------------------------------ soil texture
/** periodic value noise lattice hash */
function lat(seed: number, oct: number, i: number, j: number): number { return h01(seed, oct * 7919 + i, j, oct); }
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export interface SoilOptions { size: number; seed: number; wet?: boolean; /** defaults to the active light */ light?: LightState;
  /** 0..1: weaken the two lowest octaves (for small on-screen tiles, where they would read as a repeating grid; the
   *  renderer's large-scale macro tint supplies that variation instead). Default 0 = unchanged. */
  flatten?: number }
/** Soil palette (示意: a warm brown garden soil; not a measured soil colour). */
export const SOIL = { dry: [[52, 36, 24], [88, 63, 42], [122, 93, 64]], wetMul: 0.62 } as const;

/** Seamless soil tile, `size`×`size` RGBA (size must be a multiple of 64). Same options → identical bytes. */
export function soilTile(o: SoilOptions): Uint8ClampedArray {
  const N = o.size, seed = o.seed >>> 0, H = new Float32Array(N * N), M = new Float32Array(N * N);
  // multi-octave periodic value noise: periods 2..64 lattice cells across the tile (wraps exactly at the edges)
  const periods = [2, 4, 8, 16, 32, 64], fl = 1 - (o.flatten ?? 0), amps = [0.9 * fl, 0.7 * fl, 0.45, 0.3, 0.2, 0.12], mMean = o.flatten ? 0.5 * (amps[0] + amps[1] + amps[2] + amps[3]) : 1.175;
  const tables = periods.map((p, oi) => { const t = new Float32Array(p * p); for (let j = 0; j < p; j++) for (let i = 0; i < p; i++) t[j * p + i] = lat(seed, oi, i, j); return t; });
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let h = 0, m = 0;
    for (let k = 0; k < periods.length; k++) {
      const p = periods[k], fx = (x / N) * p, fy = (y / N) * p, i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fade(fx - i0), ty = fade(fy - j0);
      const t = tables[k], i1 = (i0 + 1) % p, j1 = (j0 + 1) % p;
      const v = lerp(lerp(t[j0 * p + i0], t[j0 * p + i1], tx), lerp(t[j1 * p + i0], t[j1 * p + i1], tx), ty);
      h += v * amps[k]; if (k < 4) m += v * amps[k];
    }
    H[y * N + x] = h; M[y * N + x] = m;
  }
  // crumbs (rounded aggregates) and sand grains, wrapped across tile edges
  const r = rng(seed ^ 0x51ed), grainCol = new Float32Array(N * N * 3), grainA = new Float32Array(N * N);
  const bump = (cx: number, cy: number, rad: number, hgt: number, col: [number, number, number] | null) => {
    const R = Math.ceil(rad);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const d2 = (dx * dx + dy * dy) / (rad * rad); if (d2 >= 1) continue;
      const X = (((Math.round(cx) + dx) % N) + N) % N, Y = (((Math.round(cy) + dy) % N) + N) % N, q = Y * N + X, w = Math.sqrt(1 - d2);
      H[q] += hgt * w;
      if (col) { const a = Math.min(1, w * 1.6); grainCol[q * 3] = col[0]; grainCol[q * 3 + 1] = col[1]; grainCol[q * 3 + 2] = col[2]; grainA[q] = Math.max(grainA[q], a); }
    }
  };
  const area = (N / 64) * (N / 64);
  for (let i = 0; i < 70 * area; i++) bump(r() * N, r() * N, 3 + r() * 5, 0.22 + r() * 0.2, null);                              // crumbs / aggregates
  for (let i = 0; i < 160 * area; i++) bump(r() * N, r() * N, 1.4 + r() * 2.2, 0.1 + r() * 0.12, null);                         // small crumbs
  for (let i = 0; i < 150 * area; i++) { const c = r(), col: [number, number, number] = c < 0.5 ? [138, 112, 84] : c < 0.8 ? [112, 88, 64] : c < 0.94 ? [176, 160, 138] : [44, 32, 24]; bump(r() * N, r() * N, 0.6 + r() * 1.0, 0.05 + r() * 0.05, col); } // sand / mineral grains, humus specks
  // light the height field with the key light (from the upper left, raised)
  const lt = o.light ?? light(), el = Math.max(0.02, lt.elevationDeg * Math.PI / 180), dl = Math.hypot(lt.dir.x, lt.dir.y) || 1;
  const L = { x: -lt.dir.x / dl * Math.cos(el), y: -lt.dir.y / dl * Math.cos(el), z: Math.sin(el) }, ln = 1, night = lt.intensity <= 0, out = new Uint8ClampedArray(N * N * 4), wet = !!o.wet;
  const [c0, c1, c2] = SOIL.dry;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const q = y * N + x, xl = y * N + ((x - 1 + N) % N), xr = y * N + ((x + 1) % N), yu = ((y - 1 + N) % N) * N + x, yd = ((y + 1) % N) * N + x;
    const gx = (H[xr] - H[xl]) * 6, gy = (H[yd] - H[yu]) * 6, nz = 1 / Math.hypot(gx, gy, 1);
    const lam = clamp(((-gx * L.x - gy * L.y + L.z) * nz) / ln, 0, 1), shade = night ? 0.8 : 0.62 + 0.52 * lam;
    const tone = clamp((M[q] - mMean) / 0.9 + 0.5, 0, 1), moist = clamp((mMean - 0.175 - M[q]) * 1.6, 0, 1); // tone from low frequencies; moist hollows
    const lo = tone < 0.5 ? c0 : c1, hi = tone < 0.5 ? c1 : c2, t = tone < 0.5 ? tone * 2 : (tone - 0.5) * 2;
    let R = lerp(lo[0], hi[0], t), G = lerp(lo[1], hi[1], t), B = lerp(lo[2], hi[2], t);
    const dm = 1 - moist * 0.12; R *= dm; G *= dm * 0.97; B *= dm * 0.92;
    if (grainA[q] > 0) { const a = grainA[q] * 0.7; R = lerp(R, grainCol[q * 3], a); G = lerp(G, grainCol[q * 3 + 1], a); B = lerp(B, grainCol[q * 3 + 2], a); }
    const fine = (h01(seed, x, y, 0x5eed) - 0.5) * 7; // per-pixel grain
    R = R * shade + fine; G = G * shade + fine; B = B * shade + fine * 0.8;
    if (wet) { const k = SOIL.wetMul; R = R * k * 0.95; G = G * k; B = B * k * 1.02; if (grainA[q] > 0.6 && lam > 0.82) { R += 60; G += 58; B += 55; } } // wet sheen on grain tops
    const i4 = q * 4; out[i4] = R; out[i4 + 1] = G; out[i4 + 2] = B; out[i4 + 3] = 255;
  }
  return out;
}

/** Low-frequency colour-variation tile (RGBA, alpha = strength) drawn very large with 'multiply' over the soil so the
 *  small tile's repetition does not show. Seamless, deterministic. */
export function soilMacroTile(seed: number, size = 128): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4), periods = [2, 4, 8], amps = [1, 0.55, 0.3];
  const tables = periods.map((p, oi) => { const t = new Float32Array(p * p); for (let j = 0; j < p; j++) for (let i = 0; i < p; i++) t[j * p + i] = lat(seed ^ 0x9e37, oi, i, j); return t; });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (let k = 0; k < periods.length; k++) { const p = periods[k], fx = (x / size) * p, fy = (y / size) * p, i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fade(fx - i0), ty = fade(fy - j0), t = tables[k], i1 = (i0 + 1) % p, j1 = (j0 + 1) % p; v += lerp(lerp(t[j0 * p + i0], t[j0 * p + i1], tx), lerp(t[j1 * p + i0], t[j1 * p + i1], tx), ty) * amps[k]; }
    const d = clamp((v / 1.85 - 0.5) * 2.2 + 0.5, 0, 1), q = (y * size + x) * 4; // 0 = light patch, 1 = dark damp patch
    out[q] = lerp(255, 120, d); out[q + 1] = lerp(250, 104, d); out[q + 2] = lerp(240, 92, d); out[q + 3] = 255;
  }
  return out;
}

// ------------------------------------------------------------------ placement helpers
type XY = [number, number];
const T = (x: number, y: number, rot: number, sc = 1) => (p: XY): XY => [x + (p[0] * Math.cos(rot) - p[1] * Math.sin(rot)) * sc, y + (p[0] * Math.sin(rot) + p[1] * Math.cos(rot)) * sc];
const sh = (h: number): XY => [light().shadow.x * h, light().shadow.y * h];
const shift = (pts: XY[], d: XY): XY[] => pts.map(([x, y]) => [x + d[0], y + d[1]]);
/** two-layer soft-edged cast shadow of an outline at height h (mm) */
function castShadow(pts: XY[], h: number, a = 0.32): DrawList {
  const o = sh(h);
  return [{ d: smoothClosed(shift(pts, [o[0] * 1.25, o[1] * 1.25])), fill: `rgba(30,18,8,${(a * 0.45).toFixed(3)})`, blend: 'multiply' }, { d: smoothClosed(shift(pts, o)), fill: `rgba(30,18,8,${(a * 0.6).toFixed(3)})`, blend: 'multiply' }];
}
/** radial paint centred slightly toward the key light */
const litRadial = (cx: number, cy: number, r: number, stops: [number, string][]) => ({ rad: [cx - light().dir.x * r * 0.35, cy - light().dir.y * r * 0.35, r * 0.05, cx, cy, r * 1.08] as [number, number, number, number, number, number], stops });

export interface Decal { shadow: DrawList; body: DrawList; high?: DrawList; highShadow?: DrawList }

// ------------------------------------------------------------------ leaves
export type LeafKind = 'lanceolate' | 'ovate' | 'decayed' | 'curled' | 'skeleton';
export const LEAF_KINDS: LeafKind[] = ['lanceolate', 'ovate', 'decayed', 'curled', 'skeleton'];
/** A fallen leaf, length `len` mm, placed at (x,y) with rotation rot. */
export function leaf(seed: number, kind: LeafKind, x: number, y: number, rot: number, len: number): Decal {
  const r = rng(seed), tr = T(x, y, rot), W = len * (kind === 'lanceolate' ? 0.2 : kind === 'curled' ? 0.24 : 0.34), n = 26, bend = (r() - 0.5) * 0.18 * len;
  const asym = 0.85 + r() * 0.3, curl = kind === 'curled';
  const mid = (t: number): XY => [-len / 2 + t * len, Math.sin(t * Math.PI) * bend];
  const hw = (t: number) => {
    const base = kind === 'lanceolate' ? Math.pow(Math.sin(Math.PI * t), 0.85) * (1 - 0.25 * t) : Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.9);
    return W * base * (1 + (r() - 0.5) * 0.08);
  };
  const left: XY[] = [], right: XY[] = [];
  for (let i = 0; i <= n; i++) { const t = i / n, m = mid(t), w = hw(t); left.push([m[0], m[1] - w * asym]); right.push([m[0], m[1] + w * (curl ? 0.35 : 1)]); }
  const outline = [...left, ...right.reverse().slice(1, -1)].map(tr);
  const pal = r(), hue = pal < 0.6 ? 22 + r() * 14 : pal < 0.85 ? 34 + r() * 10 : 12 + r() * 8, sat = 18 + r() * 22, li = 20 + r() * 18, h = curl ? 2.4 : 0.5;
  const c = (dl: number, a = 1) => hsl(hue, sat, clamp(li + dl, 5, 80), a);
  const [cx, cy] = tr(mid(0.5)), body: DrawList = [];
  const d = smoothClosed(outline, 0.9);
  if (kind === 'skeleton') {
    // only the vein network of a skeletonised leaf remains
    const vein: string[] = [smoothOpen([0, 0.25, 0.5, 0.75, 1].map((t) => tr(mid(t))))];
    for (let i = 1; i < 9; i++) { const t = i / 9, m = mid(t); for (const sd of [-1, 1]) vein.push(smoothOpen([tr(m), tr([m[0] + len * 0.12, m[1] + sd * hw(t) * 0.55]), tr([m[0] + len * 0.16, m[1] + sd * hw(t) * 0.95])])); }
    body.push({ d: vein.join(''), stroke: c(14, 0.9), lw: Math.max(0.3, len * 0.012), cap: 'round' });
    body.push({ d: smoothOpen([0, 0.5, 1].map((t) => tr(mid(t)))), stroke: c(18), lw: len * 0.016 });
    return { shadow: [{ d: vein.join(''), stroke: 'rgba(30,18,8,0.25)', lw: Math.max(0.25, len * 0.008), blend: 'multiply' }], body };
  }
  // holes of a decaying leaf (even-odd) and dark necrotic spots
  let holes = '';
  if (kind === 'decayed') for (let i = 0, k = 2 + Math.floor(r() * 4); i < k; i++) { const t = 0.2 + r() * 0.6, m = mid(t), o = (r() - 0.5) * hw(t) * 1.1; holes += smoothClosed(blobPoints(r, m[0] + r() * 2, m[1] + o, len * (0.03 + r() * 0.05), len * (0.02 + r() * 0.04), 8, 0.35).map(tr)); }
  body.push({ d: d + holes, evenodd: true, fill: litRadial(cx, cy, len * 0.55, [[0, c(8)], [0.55, c(0)], [0.85, c(-6)], [1, c(-12)]]), stroke: c(-16, 0.9), lw: Math.max(0.15, len * 0.006) });
  // blade texture: a few soft blotches, darker near the margin
  for (let i = 0; i < 5; i++) { const t = 0.15 + r() * 0.7, m = mid(t); const p = tr([m[0], m[1] + (r() - 0.5) * hw(t)]); body.push({ d: ellipse(p[0], p[1], len * (0.04 + r() * 0.06), len * (0.03 + r() * 0.04), rot + r()), fill: c(r() < 0.5 ? -8 : 7, 0.35) }); }
  { let dk = '', lt = ''; for (let i = 0; i < len * 1.6; i++) { const t = 0.06 + r() * 0.88, m = mid(t), w = hw(t) * 0.85, p = tr([m[0] + (r() - 0.5) * 1.5, m[1] + (r() * 2 - 1) * w]), z = len * (0.004 + r() * 0.01); if (r() < 0.55) dk += ellipse(p[0], p[1], z, z * 0.8); else lt += ellipse(p[0], p[1], z, z * 0.8); }
    body.push({ d: dk, fill: c(-12, 0.45) }, { d: lt, fill: c(12, 0.4) }); } // fine mottling of a dead leaf
  if (kind === 'decayed') for (let i = 0; i < 4; i++) { const t = 0.1 + r() * 0.8, m = mid(t), p = tr([m[0], m[1] + (r() - 0.5) * hw(t) * 1.2]); body.push({ d: ellipse(p[0], p[1], len * 0.035, len * 0.028, r() * 3), fill: 'rgba(40,24,12,0.45)', blend: 'multiply' }); }
  // veins: midrib + paired secondary veins toward the tip
  const midrib = smoothOpen([0, 0.25, 0.5, 0.75, 1].map((t) => tr(mid(t))));
  body.push({ d: midrib, stroke: c(16, 0.8), lw: Math.max(0.2, len * 0.014), cap: 'round' });
  let sec = ''; for (let i = 1; i < 8; i++) { const t = i / 8.5, m = mid(t); for (const sd of [-1, 1]) { if (curl && sd > 0) continue; const w = hw(t) * (sd < 0 ? asym : 1); sec += smoothOpen([tr(m), tr([m[0] + w * 0.45, m[1] + sd * w * 0.5]), tr([m[0] + w * 0.75, m[1] + sd * w * 0.85])]); } }
  body.push({ d: sec, stroke: c(12, 0.45), lw: Math.max(0.12, len * 0.006), cap: 'round' });
  // petiole stub
  body.push({ d: smoothOpen([tr(mid(0)), tr([-len / 2 - len * 0.08, bend * 0.2])]), stroke: c(-4), lw: Math.max(0.25, len * 0.018), cap: 'round' });
  if (curl) { // rolled margin catching the light, with the rolled-under shadow inside
    body.push({ d: smoothOpen(right.slice(2, -2).reverse().map(tr)), stroke: c(20, 0.9), lw: len * 0.03, cap: 'round' });
    body.push({ d: smoothOpen(right.slice(3, -3).reverse().map((p) => tr([p[0], p[1] - W * 0.12]))), stroke: 'rgba(30,16,6,0.35)', lw: len * 0.025, cap: 'round', blend: 'multiply' });
  }
  return { shadow: castShadow(outline, h, curl ? 0.42 : 0.3), body };
}

// ------------------------------------------------------------------ twigs
export function twig(seed: number, x: number, y: number, rot: number, len: number): Decal {
  const r = rng(seed), tr = T(x, y, rot), w = 1.2 + r() * 1.6, pts: XY[] = [];
  for (let i = 0; i <= 6; i++) pts.push([-len / 2 + (i / 6) * len, (r() - 0.5) * len * 0.05]);
  const br: XY[] = [pts[3], [pts[3][0] + len * 0.18, pts[3][1] - len * 0.14 * (r() < 0.5 ? 1 : -1)]];
  const hue = 26 + r() * 10, body: DrawList = [], shadow: DrawList = [], o = sh(w * 0.9);
  for (const [line, lw] of [[pts, w], [br, w * 0.6]] as [XY[], number][]) {
    const P0 = line.map(tr), d = smoothOpen(P0);
    shadow.push({ d: smoothOpen(shift(P0, o)), stroke: 'rgba(30,18,8,0.32)', lw: lw * 1.1, cap: 'round', blend: 'multiply' });
    body.push({ d, stroke: hsl(hue, 22, 22), lw, cap: 'round' });
    body.push({ d: smoothOpen(shift(P0, [-light().dir.x * lw * 0.22, -light().dir.y * lw * 0.22])), stroke: hsl(hue, 18, 40, 0.8), lw: lw * 0.45, cap: 'round' }); // lit upper edge
    body.push({ d: smoothOpen(shift(P0, [-light().dir.x * lw * 0.32, -light().dir.y * lw * 0.32])), stroke: hsl(hue, 14, 58, 0.35), lw: lw * 0.15, cap: 'round' });
  }
  // bark rings and the paler cut end
  for (let i = 1; i < 6; i++) { const p = tr(pts[i]), a = rot + Math.PI / 2; body.push({ d: new P().M(p[0] - Math.cos(a) * w * 0.4, p[1] - Math.sin(a) * w * 0.4).L(p[0] + Math.cos(a) * w * 0.4, p[1] + Math.sin(a) * w * 0.4).toString(), stroke: 'rgba(20,12,6,0.45)', lw: w * 0.12 }); }
  const e = tr(pts[6]); body.push({ d: ellipse(e[0], e[1], w * 0.42, w * 0.5, rot), fill: hsl(38, 35, 62) });
  return { shadow, body };
}

// ------------------------------------------------------------------ pebbles
/** Irregular stone of radius ~rad mm: contact shadow, ambient occlusion ring, lit body, mineral flecks, glint. */
export function pebble(seed: number, x: number, y: number, rad: number): Decal {
  const r = rng(seed), pts = blobPoints(r, x, y, rad, rad * (0.6 + r() * 0.32), 7 + Math.floor(r() * 5), 0.16, r() * Math.PI);
  const kind = r(), base = kind < 0.4 ? [30, 10, 40] : kind < 0.7 ? [24, 16, 32] : kind < 0.85 ? [210, 5, 36] : [16, 22, 46];
  const [hu, sa, li] = base, h = rad * 0.5, body: DrawList = [];
  const shadow: DrawList = [softShadow(x + sh(h)[0] * 0.9, y + sh(h)[1] * 0.9, rad * 1.3, rad * 1.05, 0.5), { d: smoothClosed(shift(pts, sh(h * 0.5)), 0.7), fill: 'rgba(24,14,6,0.42)', blend: 'multiply' }, softShadow(x, y, rad * 1.22, rad * 1.05, 0.42)]; // cast + AO
  body.push({ d: smoothClosed(pts, 0.7), fill: litRadial(x, y, rad, [[0, hsl(hu, sa, li + 14)], [0.4, hsl(hu, sa, li + 2)], [0.8, hsl(hu, sa + 3, li - 12)], [1, hsl(hu, sa + 4, li - 22)]]), stroke: hsl(hu, sa, li - 30, 0.6), lw: Math.max(0.08, rad * 0.025) });
  // facets: a couple of flat faces catching the light differently
  for (let i = 0; i < 2; i++) { const a = r() * 6.283, q = blobPoints(r, x + Math.cos(a) * rad * 0.3, y + Math.sin(a) * rad * 0.25, rad * 0.4, rad * 0.28, 5, 0.25, r() * 3); body.push({ d: smoothClosed(q, 0.3), fill: r() < 0.5 ? hsl(hu, sa, li + 10, 0.25) : hsl(hu, sa, li - 12, 0.22) }); }
  let fd = '', fl = ''; for (let i = 0; i < 10 + rad * 5; i++) { const a = r() * 6.283, d = Math.sqrt(r()) * rad * 0.8, z = rad * (0.012 + r() * 0.03); if (r() < 0.5) fd += ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.75, z, z * 0.8); else fl += ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.75, z, z * 0.8); }
  body.push({ d: fd, fill: hsl(hu, sa, li - 24, 0.55) }, { d: fl, fill: hsl(hu, sa, li + 26, 0.55) }); // mineral flecks
  body.push({ d: ellipse(x - light().dir.x * rad * 0.35, y - light().dir.y * rad * 0.28, rad * 0.26, rad * 0.12, -0.6), fill: { rad: [x - light().dir.x * rad * 0.35, y - light().dir.y * rad * 0.28, 0, x - light().dir.x * rad * 0.35, y - light().dir.y * rad * 0.28, rad * 0.26], stops: [[0, 'rgba(255,250,240,0.4)'], [1, 'rgba(255,250,240,0)']] }, blend: 'screen' });
  return { shadow, body };
}

// ------------------------------------------------------------------ grass, moss, seeds
/** Grass tuft: short blades in `body` (LOW layer) and long overhanging blade tips in `high` (drawn above ants). */
export function grassTuft(seed: number, x: number, y: number, size: number, dry = 0): Decal {
  const r = rng(seed), n = 7 + Math.floor(r() * 9), body: DrawList = [], shadow: DrawList = [], high: DrawList = [], highShadow: DrawList = [];
  const lean = (r() - 0.5) * 1.2;
  for (let i = 0; i < n; i++) {
    const a = lean + (r() - 0.5) * 3.2, len = size * (0.35 + r() * 0.75), w = size * (0.016 + r() * 0.014), bendA = (r() - 0.5) * 0.9;
    const bx = x + (r() - 0.5) * size * 0.12, by = y + (r() - 0.5) * size * 0.12;
    const pt = (t: number): XY => { const aa = a + bendA * t * t; return [bx + Math.cos(aa) * len * t, by + Math.sin(aa) * len * t]; };
    const left: XY[] = [], right: XY[] = [];
    for (let k = 0; k <= 6; k++) { const t = k / 6, p = pt(t), aa = a + bendA * t * t + Math.PI / 2, ww = w * (1 - t) ** 0.8; left.push([p[0] + Math.cos(aa) * ww, p[1] + Math.sin(aa) * ww]); right.push([p[0] - Math.cos(aa) * ww, p[1] - Math.sin(aa) * ww]); }
    const outline = [...left, ...right.reverse()], d = smoothOpen(outline) + 'Z';
    const isDry = r() < dry, [g0, g1] = isDry ? [hsl(42, 38, 38), hsl(48, 45, 66)] : [hsl(95, 40, 20), hsl(84, 48, 52)];
    const tip = pt(1), fill = { lin: [bx, by, tip[0], tip[1]] as [number, number, number, number], stops: [[0, g0], [1, g1]] as [number, string][] };
    // a blade rises toward its tip, so its shadow is offset more at the tip (height ∝ t)
    const shOut = outline.map(([px, py], k) => { const t = (k <= 6 ? k : 13 - k) / 6, o = sh(len * 0.35 * t); return [px + o[0], py + o[1]] as XY; });
    const tall = len > size * 0.75;
    (tall ? highShadow : shadow).push({ d: smoothOpen(shOut) + 'Z', fill: 'rgba(30,20,8,0.22)', blend: 'multiply' });
    (tall ? high : body).push({ d, fill, stroke: isDry ? hsl(40, 30, 28, 0.6) : hsl(100, 40, 14, 0.55), lw: Math.max(0.08, w * 0.18) });
    (tall ? high : body).push({ d: smoothOpen([pt(0.1), pt(0.5), pt(0.92)]), stroke: isDry ? 'rgba(255,240,200,0.35)' : 'rgba(230,255,190,0.3)', lw: w * 0.35, cap: 'round' }); // midrib sheen
  }
  shadow.unshift(softShadow(x, y, size * 0.22, size * 0.18, 0.4));
  return { shadow, body, high, highShadow };
}
/** Moss cushion: dense tiny shoots. */
export function moss(seed: number, x: number, y: number, rad: number): Decal {
  const r = rng(seed), body: DrawList = [], pts = blobPoints(r, x, y, rad, rad * 0.75, 12, 0.25, r() * 3);
  body.push({ d: smoothClosed(pts), fill: litRadial(x, y, rad, [[0, hsl(80, 35, 24, 0.85)], [0.8, hsl(95, 40, 14, 0.7)], [1, hsl(95, 40, 14, 0)]]) });
  let dots = '', lit = '';
  for (let i = 0; i < rad * rad * 5; i++) { const a = r() * 6.283, d = Math.sqrt(r()) * rad * 0.95, px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * 0.75, s = 0.12 + r() * 0.2, ro = r() * 3; if (r() < 0.55) dots += ellipse(px, py, s * 1.6, s * 0.5, ro) + ellipse(px, py, s * 0.5, s * 1.6, ro); else lit += ellipse(px - 0.05, py - 0.05, s * 1.2, s * 0.4, ro) + ellipse(px - 0.05, py - 0.05, s * 0.4, s * 1.2, ro); } // tiny leafy shoots (stars)
  body.push({ d: dots, fill: hsl(92, 42, 22, 0.95) }, { d: lit, fill: hsl(76, 48, 42, 0.9) });
  return { shadow: castShadow(pts, 0.8, 0.3), body };
}
/** Seeds, bark flakes and soil crumbs scattered around (x,y) within `rad` mm. */
export function debris(seed: number, x: number, y: number, rad: number, count: number): Decal {
  const r = rng(seed), body: DrawList = [], shadow: DrawList = [];
  for (let i = 0; i < count; i++) {
    const a = r() * 6.283, d = Math.sqrt(r()) * rad, px = x + Math.cos(a) * d, py = y + Math.sin(a) * d, k = r();
    if (k < 0.4) { const s = 0.6 + r() * 1.2, rot = r() * 3; shadow.push(softShadow(px + 0.25, py + 0.35, s * 1.1, s * 0.7, 0.35, rot)); body.push({ d: ellipse(px, py, s, s * 0.58, rot), fill: litRadial(px, py, s, [[0, hsl(34, 45, 52)], [1, hsl(26, 45, 24)]]), stroke: 'rgba(30,16,6,0.5)', lw: 0.08 }); } // seed
    else if (k < 0.7) { const pts = blobPoints(r, px, py, 0.8 + r() * 1.4, 0.4 + r() * 0.7, 5, 0.3, r() * 3); shadow.push({ d: smoothClosed(shift(pts, [0.2, 0.3])), fill: 'rgba(28,16,6,0.3)', blend: 'multiply' }); body.push({ d: smoothClosed(pts, 0.4), fill: hsl(24, 30, 18 + r() * 14) }); } // bark flake
    else { const s = 0.3 + r() * 0.5; shadow.push(softShadow(px + 0.15, py + 0.2, s * 1.3, s * 1.1, 0.3)); body.push({ d: ellipse(px, py, s, s * 0.85), fill: litRadial(px, py, s, [[0, hsl(30, 25, 50)], [1, hsl(28, 30, 26)]]) }); } // crumb
  }
  return { shadow, body };
}

export const decalDigest = (d: Decal) => hash32(JSON.stringify(d)).toString(16);
export type { Shape, Rng };

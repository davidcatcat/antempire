/**
 * Art kit: objects that stand for ENGINE places (drawing only). Pure and DOM-free, millimetre units.
 *  - nestEntrance: the nest place (N00). Soil crater with excavated granules and a dark entrance — 示意: the story nest
 *    is a crevice / pot-mound complex and this species often nests in soil under objects without a large open mound
 *    (docs/species-pheidole-megacephala.md §4), so the crater is kept small and labelled schematic.
 *  - hostPlant: a honeydew place. One hemipteran CLUSTER is drawn per engine colony (hemipteran_colonies); the number
 *    of individuals inside a cluster is not an engine value (示意). host_alive === false → wilted brown variant.
 *  - flower: a nectar place; insectCarcass: a carcass place (insect not identified → 示意).
 */
import { light, P, blobPoints, ellipse, hsl, rng, smoothClosed, smoothOpen, softShadow, type DrawList } from './art-core.ts';
import type { Decal } from './art-ground.ts';

type XY = [number, number];
const sh = (h: number): XY => [light().shadow.x * h, light().shadow.y * h];
const shift = (pts: XY[], d: XY): XY[] => pts.map(([x, y]) => [x + d[0], y + d[1]]);
const litRadial = (cx: number, cy: number, r: number, stops: [number, string][]) => ({ rad: [cx - light().dir.x * r * 0.35, cy - light().dir.y * r * 0.35, r * 0.05, cx, cy, r * 1.08] as [number, number, number, number, number, number], stops });

// ------------------------------------------------------------------ nest
export function nestEntrance(seed: number, x: number, y: number, rad = 20): Decal {
  const r = rng(seed), shadow: DrawList = [], body: DrawList = [];
  // disturbed, slightly paler excavated soil (not a tall mound)
  const apron = blobPoints(r, x, y, rad, rad * 0.86, 16, 0.18, r() * 3);
  body.push({ d: smoothClosed(apron), fill: { rad: [x, y, rad * 0.15, x, y, rad * 1.02], stops: [[0, 'rgba(120,90,60,0.0)'], [0.3, 'rgba(132,100,68,0.45)'], [0.7, 'rgba(120,92,62,0.3)'], [1, 'rgba(110,84,58,0)']] } });
  // excavated granules: grouped into a few paths (shadow / three tones / highlights) so the nest stays cheap to draw
  let sd = '', t0 = '', t1 = '', t2 = '', hl = '';
  const n = Math.round(rad * rad * 0.9);
  for (let i = 0; i < n; i++) {
    const a = r() * 6.283, u = r(), d = rad * (0.2 + 0.72 * Math.pow(u, 0.9)), s = (0.45 + r() * 0.75) * (1.2 - d / rad * 0.6);
    const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * 0.9, rot = r() * 3, k = r();
    sd += ellipse(px + s * 0.45, py + s * 0.6, s * 1.05, s * 0.85, rot);
    const e = ellipse(px, py, s, s * 0.82, rot); if (k < 0.4) t0 += e; else if (k < 0.75) t1 += e; else t2 += e;
    hl += ellipse(px - light().dir.x * s * 0.35, py - light().dir.y * s * 0.35, s * 0.42, s * 0.32, rot);
  }
  shadow.push({ d: sd, fill: 'rgba(30,18,8,0.38)', blend: 'multiply' });
  body.push({ d: t0, fill: '#6e5238' }, { d: t1, fill: '#5c432e' }, { d: t2, fill: '#836346' }, { d: hl, fill: 'rgba(255,230,196,0.16)', blend: 'screen' });
  // entrance: shallow depression ring, then the hole with depth (inner wall facing the light is lit)
  const hole = blobPoints(r, x, y, rad * 0.2, rad * 0.16, 10, 0.18, r() * 3);
  body.push(softShadow(x, y, rad * 0.42, rad * 0.37, 0.6));
  body.push({ d: smoothClosed(hole), fill: { rad: [x + light().dir.x * rad * 0.03, y + light().dir.y * rad * 0.03, 0, x, y, rad * 0.18], stops: [[0, '#050302'], [0.55, '#140c06'], [1, '#3a2717']] } });
  body.push({ d: smoothOpen(hole.slice(1, 6)), stroke: 'rgba(196,160,118,0.55)', lw: rad * 0.018 }); // lit lower-right inner wall
  body.push({ d: smoothOpen(hole.slice(6, 10)), stroke: 'rgba(0,0,0,0.45)', lw: rad * 0.025 });     // shaded upper-left lip
  return { shadow, body };
}

// ------------------------------------------------------------------ hemipterans
/** Aphid seen from above (len mm): pear-shaped body, cornicles, legs, antennae swept back. Colours 示意. */
export function aphid(x: number, y: number, rot: number, len: number, tone: number): DrawList {
  const c = Math.cos(rot), s = Math.sin(rot), T = (px: number, py: number): XY => [x + (px * c - py * s) * len, y + (px * s + py * c) * len];
  const out: DrawList = [], col = hsl(78 + tone * 16, 38, 50 + tone * 8), dark = hsl(88, 40, 26);
  const leg = (a: XY, b: XY, cc: XY) => out.push({ d: new P().M(...T(...a)).Q(...T(...b), ...T(...cc)).toString(), stroke: 'rgba(55,62,28,0.85)', lw: len * 0.03, cap: 'round' });
  for (const sd of [-1, 1]) { leg([0.2, 0.08 * sd], [0.3, 0.26 * sd], [0.36, 0.34 * sd]); leg([0.12, 0.1 * sd], [0.12, 0.3 * sd], [0.04, 0.38 * sd]); leg([0.04, 0.12 * sd], [-0.08, 0.32 * sd], [-0.24, 0.38 * sd]); }
  for (const sd of [-1, 1]) out.push({ d: new P().M(...T(0.4, 0.04 * sd)).Q(...T(0.42, 0.3 * sd), ...T(0.1, 0.4 * sd)).toString(), stroke: 'rgba(60,66,32,0.75)', lw: len * 0.022, cap: 'round' }); // antennae swept back
  const [ax, ay] = T(-0.12, 0);
  out.push({ d: ellipse(ax, ay, len * 0.33, len * 0.25, rot), fill: litRadial(ax, ay, len * 0.33, [[0, hsl(70, 46, 70)], [0.55, col], [1, dark]]), stroke: 'rgba(45,55,20,0.6)', lw: len * 0.018 }); // abdomen
  const [tx, ty] = T(0.22, 0); out.push({ d: ellipse(tx, ty, len * 0.13, len * 0.14, rot), fill: litRadial(tx, ty, len * 0.14, [[0, hsl(74, 42, 62)], [1, dark]]), stroke: 'rgba(45,55,20,0.5)', lw: len * 0.015 }); // thorax
  const [hx, hy] = T(0.37, 0); out.push({ d: ellipse(hx, hy, len * 0.08, len * 0.1, rot), fill: hsl(80, 35, 40) }); // head
  for (const sd of [-1, 1]) { const e = T(0.39, 0.085 * sd); out.push({ d: ellipse(e[0], e[1], len * 0.028, len * 0.028), fill: '#5a1e12' }); }
  for (const sd of [-1, 1]) out.push({ d: new P().M(...T(-0.3, 0.12 * sd)).L(...T(-0.47, 0.17 * sd)).toString(), stroke: hsl(84, 30, 20), lw: len * 0.05, cap: 'round' }); // cornicles (siphunculi)
  out.push({ d: ellipse(...T(-0.47, 0), len * 0.05, len * 0.035, rot), fill: hsl(84, 30, 30) }); // cauda
  return out;
}
/** Soft scale insect (domed oval shell) seen from above. */
export function scaleInsect(x: number, y: number, rot: number, len: number, tone: number): DrawList {
  return [
    softShadow(x + len * 0.12, y + len * 0.16, len * 0.55, len * 0.42, 0.4, rot),
    { d: ellipse(x, y, len * 0.5, len * 0.36, rot), fill: litRadial(x, y, len * 0.5, [[0, hsl(36, 50, 62 + tone * 8)], [0.6, hsl(30, 48, 38)], [1, hsl(26, 50, 22)]]), stroke: 'rgba(40,20,8,0.6)', lw: len * 0.03 },
    { d: new P().M(x - Math.cos(rot) * len * 0.35, y - Math.sin(rot) * len * 0.35).L(x + Math.cos(rot) * len * 0.35, y + Math.sin(rot) * len * 0.35).toString(), stroke: 'rgba(60,30,10,0.35)', lw: len * 0.04 },
  ];
}

// ------------------------------------------------------------------ host plant
export interface HostPlantOptions { alive: boolean; colonies: number; insect: 'aphid' | 'scale'; size?: number }
/** Low herb seen from above with hemipteran clusters (one per engine colony). Returns the cluster sites too. */
export function hostPlant(seed: number, x: number, y: number, o: HostPlantOptions): Decal & { colonySites: XY[] } {
  const r = rng(seed), size = o.size ?? 34, nL = 6 + Math.floor(r() * 3), shadow: DrawList = [], body: DrawList = [], high: DrawList = [], highShadow: DrawList = [];
  const sites: XY[] = [];
  const order = Array.from({ length: nL }, (_, i) => i);
  for (const i of order) {
    const a = (i / nL) * 6.283 + (r() - 0.5) * 0.5, tier = i % 2, L = size * (tier ? 0.62 : 0.85) * (0.8 + r() * 0.35), W = L * (o.alive ? 0.36 : 0.22), hgt = 3 + tier * 5;
    const ca = Math.cos(a), sa = Math.sin(a), T = (u: number, v: number): XY => [x + (u * ca - v * sa), y + (u * sa + v * ca)];
    const droop = o.alive ? 0 : 0.25;
    const pts: XY[] = [];
    for (let k = 0; k <= 16; k++) { const t = k / 16, w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9) * (k % 2 && o.alive ? 0.93 : 1); pts.push(T(size * 0.08 + t * L, -w * (1 - droop))); }
    for (let k = 15; k >= 1; k--) { const t = k / 16, w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9) * (k % 2 && o.alive ? 0.93 : 1); pts.push(T(size * 0.08 + t * L, w * (o.alive ? 1 : 0.5))); }
    const [hu, sa_, li] = o.alive ? [92 + r() * 16, 30 + r() * 10, 24 + tier * 6 + r() * 4] : [30 + r() * 10, 30, 28 + r() * 8];
    const mid = T(size * 0.08 + L * 0.5, 0), dst = tier ? high : body, dsh = tier ? highShadow : shadow;
    dsh.push({ d: smoothClosed(shift(pts, sh(hgt))), fill: 'rgba(24,18,6,0.3)', blend: 'multiply' });
    dst.push({ d: smoothClosed(pts, 0.8), fill: litRadial(mid[0], mid[1], L * 0.55, [[0, hsl(hu, sa_, li + 12)], [0.6, hsl(hu, sa_, li)], [1, hsl(hu, sa_ + 4, li - 10)]]), stroke: hsl(hu, sa_, li - 16, 0.8), lw: 0.18 });
    // leaf folded slightly along the midrib: the half facing the key light is brighter, the other half darker
    const half = [...pts.slice(0, 17), T(size * 0.08, 0)], lx = Math.sin(a), ly = -Math.cos(a), facing = -(lx * light().dir.x + ly * light().dir.y) > 0;
    dst.push({ d: smoothClosed(half, 0.8), fill: facing ? 'rgba(255,255,230,0.10)' : 'rgba(10,30,0,0.16)', blend: facing ? 'screen' : 'multiply' });
    dst.push({ d: smoothClosed(pts, 0.8), stroke: o.alive ? 'rgba(20,40,8,0.35)' : 'rgba(40,24,8,0.35)', lw: L * 0.035, blend: 'multiply' }); // darker, thinner margin
    dst.push({ d: smoothOpen([T(size * 0.02, 0), T(size * 0.08 + L * 0.5, 0), T(size * 0.08 + L * 0.95, 0)]), stroke: hsl(hu, sa_ - 10, li + 18, 0.75), lw: L * 0.022, cap: 'round' });
    let v = ''; for (let k = 1; k < 7; k++) { const u = size * 0.08 + (k / 7.5) * L, w = W * Math.sin(Math.PI * Math.pow(k / 7.5, 0.75)); for (const sd of [-1, 1]) { if (!o.alive && sd > 0) continue; v += smoothOpen([T(u, 0), T(u + w * 0.4, sd * w * 0.55), T(u + w * 0.7, sd * w * 0.85)]); } }
    dst.push({ d: v, stroke: hsl(hu, sa_ - 10, li + 14, 0.45), lw: L * 0.01, cap: 'round' });
    if (o.alive) dst.push({ d: ellipse(...T(size * 0.08 + L * 0.42, -W * 0.3), L * 0.18, W * 0.18, a), fill: 'rgba(255,255,235,0.12)', blend: 'screen' }); // leaf gloss
    { let tx = ''; for (let k = 0; k < L * 1.2; k++) { const t = 0.08 + r() * 0.85, w = W * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9) * 0.8, p = T(size * 0.08 + t * L, (r() * 2 - 1) * w), z = 0.12 + r() * 0.3; tx += ellipse(p[0], p[1], z, z * 0.8); } dst.push({ d: tx, fill: o.alive ? hsl(hu, sa_, li - 8, 0.35) : 'rgba(50,30,12,0.35)' }); } // leaf surface texture
    if (!o.alive) for (let k = 0; k < 3; k++) { const p = T(size * 0.08 + L * (0.2 + r() * 0.7), (r() - 0.5) * W * 0.5); dst.push({ d: ellipse(p[0], p[1], L * 0.05, L * 0.035, r() * 3), fill: 'rgba(40,22,8,0.45)', blend: 'multiply' }); }
    // hemipteran sites along the lower part of the midrib and the petiole
    sites.push(T(size * 0.08 + L * 0.28, 0), T(size * 0.08 + L * 0.55, W * 0.15));
  }
  // stem at the centre
  body.push(softShadow(x + 1.5, y + 2, size * 0.09, size * 0.08, 0.5), { d: ellipse(x, y, size * 0.06, size * 0.06), fill: litRadial(x, y, size * 0.06, o.alive ? [[0, '#86a556'], [1, '#3d5a22']] : [[0, '#9a7d55'], [1, '#5a4228']]) });
  const colonySites: XY[] = [];
  const nC = Math.max(0, Math.floor(o.colonies));
  for (let c = 0; c < nC; c++) {
    const s = sites[(c * 3) % sites.length]; colonySites.push(s);
    const k = 5 + Math.floor(r() * 3); // individuals per cluster: 示意 (the engine records colonies, not individuals)
    const dst = high; // clusters sit on upper surfaces / petioles: drawn with the high layer so leaves do not hide them
    for (let i = 0; i < k; i++) {
      const a = r() * 6.283, d = Math.sqrt(r()) * 2.2, px = s[0] + Math.cos(a) * d, py = s[1] + Math.sin(a) * d, rot = r() * 6.283, len = 1.1 + r() * 1.0;
      if (o.insect === 'aphid') { dst.push(softShadow(px + 0.3, py + 0.4, len * 0.5, len * 0.35, 0.35, rot)); dst.push(...aphid(px, py, rot, len, r())); }
      else dst.push(...scaleInsect(px, py, rot, len * 1.1, r()));
    }
  }
  return { shadow, body, high, highShadow, colonySites };
}

// ------------------------------------------------------------------ flower (nectar place)
export function flower(seed: number, x: number, y: number, size = 16): Decal {
  const r = rng(seed), shadow: DrawList = [], body: DrawList = [], high: DrawList = [], highShadow: DrawList = [];
  for (let i = 0; i < 4; i++) { // basal leaves
    const a = r() * 6.283, L = size * (0.7 + r() * 0.4), W = L * 0.25, ca = Math.cos(a), sa = Math.sin(a), T = (u: number, v: number): XY => [x + u * ca - v * sa, y + u * sa + v * ca];
    const pts: XY[] = []; for (let k = 0; k <= 10; k++) pts.push(T((k / 10) * L, -W * Math.sin(Math.PI * k / 10))); for (let k = 9; k >= 1; k--) pts.push(T((k / 10) * L, W * Math.sin(Math.PI * k / 10)));
    shadow.push({ d: smoothClosed(shift(pts, sh(2))), fill: 'rgba(24,18,6,0.28)', blend: 'multiply' });
    body.push({ d: smoothClosed(pts), fill: litRadial(...T(L / 2, 0), L * 0.5, [[0, hsl(100, 40, 40)], [1, hsl(105, 45, 20)]]), stroke: hsl(105, 40, 16, 0.7), lw: 0.15 }, { d: smoothOpen([T(0, 0), T(L * 0.5, 0), T(L * 0.95, 0)]), stroke: hsl(90, 35, 55, 0.6), lw: 0.25 });
  }
  const fh = 9, np = 5, rot0 = r() * 6.283, pr = size * 0.42; // raised flower head: its cast shadow lands well to the lower right
  const petal = (i: number): XY[] => { const a = rot0 + (i / np) * 6.283, ca = Math.cos(a), sa = Math.sin(a), T = (u: number, v: number): XY => [x + u * ca - v * sa, y + u * sa + v * ca], pts: XY[] = []; for (let k = 0; k <= 10; k++) { const t = k / 10; pts.push(T(t * pr, -pr * 0.42 * Math.sin(Math.PI * Math.pow(t, 0.7)) * (k === 10 ? 0.6 : 1))); } for (let k = 9; k >= 1; k--) { const t = k / 10; pts.push(T(t * pr, pr * 0.42 * Math.sin(Math.PI * Math.pow(t, 0.7)))); } return pts; };
  for (let i = 0; i < np; i++) { const pts = petal(i); highShadow.push({ d: smoothClosed(shift(pts, sh(fh))), fill: 'rgba(24,18,6,0.22)', blend: 'multiply' }); }
  for (let i = 0; i < np; i++) {
    const pts = petal(i), a = rot0 + (i / np) * 6.283, tip: XY = [x + Math.cos(a) * pr, y + Math.sin(a) * pr];
    high.push({ d: smoothClosed(pts), fill: { lin: [x, y, tip[0], tip[1]], stops: [[0, '#f0e6c8'], [0.35, '#fbf7ec'], [1, '#ffffff']] }, stroke: 'rgba(150,140,110,0.55)', lw: 0.15 });
    let v = ''; for (const o of [-0.18, 0, 0.18]) v += smoothOpen([[x + Math.cos(a) * pr * 0.15, y + Math.sin(a) * pr * 0.15], [x + Math.cos(a + o) * pr * 0.75, y + Math.sin(a + o) * pr * 0.75]]);
    high.push({ d: v, stroke: 'rgba(170,160,130,0.35)', lw: 0.12 });
  }
  high.push({ d: ellipse(x, y, pr * 0.28, pr * 0.28), fill: litRadial(x, y, pr * 0.28, [[0, '#ffe27a'], [0.7, '#e2a91f'], [1, '#a8740e']]) });
  let st = ''; for (let i = 0; i < 12; i++) { const a = i * 0.52 + r() * 0.2, d = pr * (0.18 + r() * 0.08); st += ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.32, 0.32); }
  high.push({ d: st, fill: '#c98a12' });
  return { shadow, body, high, highShadow };
}

// ------------------------------------------------------------------ insect carcass (carcass place)
/** A small dead insect (not identified, 示意): lying on its back with curled legs, wings askew. `whole` = false draws
 *  fragments only (wings, legs, a piece of cuticle). */
export function insectCarcass(seed: number, x: number, y: number, rot: number, len = 7, whole = true): Decal {
  const r = rng(seed), c = Math.cos(rot), s = Math.sin(rot), T = (u: number, v: number): XY => [x + (u * c - v * s) * len, y + (u * s + v * c) * len];
  const shadow: DrawList = [], body: DrawList = [];
  const wing = (sd: number, a: number, k: number) => { const base = T(0.08, 0.04 * sd), tip = T(-0.42 + a, (0.42 + k) * sd), mid = T(-0.1, (0.36 + k) * sd); const pts: XY[] = [base, mid, tip, T(-0.28 + a, (0.18 + k * 0.5) * sd)];
    body.push({ d: smoothClosed(pts, 0.8), fill: 'rgba(225,232,236,0.42)', stroke: 'rgba(80,80,80,0.55)', lw: len * 0.012 });
    body.push({ d: smoothOpen([base, T(-0.2 + a * 0.5, (0.28 + k) * sd), tip]) + smoothOpen([base, T(-0.15 + a * 0.5, (0.16 + k * 0.5) * sd)]), stroke: 'rgba(70,60,50,0.5)', lw: len * 0.008 }); };
  if (!whole) {
    wing(1, r() * 0.1, 0.05); for (let i = 0; i < 3; i++) { const p = T((r() - 0.5) * 0.8, (r() - 0.5) * 0.8), q = T((r() - 0.5) * 0.8, (r() - 0.5) * 0.8); body.push({ d: smoothOpen([p, [(p[0] + q[0]) / 2 + 0.3, (p[1] + q[1]) / 2], q]), stroke: '#3a2a1e', lw: len * 0.03, cap: 'round' }); }
    const pc = blobPoints(r, ...T(-0.1, -0.2), len * 0.14, len * 0.1, 7, 0.25, rot); shadow.push({ d: smoothClosed(shift(pc, [0.3, 0.4])), fill: 'rgba(24,14,6,0.35)', blend: 'multiply' }); body.push({ d: smoothClosed(pc), fill: '#2e241c' });
    return { shadow, body };
  }
  shadow.push(softShadow(...T(0, 0), len * 0.55, len * 0.32, 0.45, rot));
  // legs curled over the body (dead insects lie with flexed legs)
  for (const sd of [-1, 1]) for (const u of [0.18, 0.06, -0.06]) { const a = T(u, 0.08 * sd), b = T(u + 0.06, 0.3 * sd), e = T(u - 0.06, 0.2 * sd); body.push({ d: new P().M(...a).Q(...b, ...e).toString(), stroke: '#2b211a', lw: len * 0.028, cap: 'round' }); }
  wing(-1, 0.06, 0.02); wing(1, -0.04, 0.08);
  const abd = blobPoints(r, ...T(-0.22, 0), len * 0.26, len * 0.16, 12, 0.06, rot);
  body.push({ d: smoothClosed(abd), fill: litRadial(...T(-0.22, 0), len * 0.26, [[0, '#7c6e60'], [0.6, '#4a3e34'], [1, '#2a221c']]), stroke: 'rgba(20,14,8,0.8)', lw: len * 0.012 });
  for (let k = 1; k < 4; k++) { const a = T(-0.22 - 0.2 + k * 0.1, -0.15), b = T(-0.22 - 0.2 + k * 0.1, 0.15); body.push({ d: new P().M(...a).Q(...T(-0.22 - 0.24 + k * 0.1, 0), ...b).toString(), stroke: 'rgba(20,14,8,0.5)', lw: len * 0.012 }); }
  body.push({ d: ellipse(...T(0.08, 0), len * 0.13, len * 0.12, rot), fill: litRadial(...T(0.08, 0), len * 0.13, [[0, '#6a5c50'], [1, '#2a221c']]), stroke: 'rgba(20,14,8,0.8)', lw: len * 0.012 });
  const hd = T(0.27, 0); body.push({ d: ellipse(hd[0], hd[1], len * 0.075, len * 0.1, rot), fill: '#3a2e26' });
  for (const sd of [-1, 1]) { const e = T(0.28, 0.065 * sd); body.push({ d: ellipse(e[0], e[1], len * 0.055, len * 0.045, rot), fill: litRadial(e[0], e[1], len * 0.055, [[0, '#b0584a'], [1, '#5a1e16']]) }); }
  body.push({ d: ellipse(...T(-0.18, -0.06), len * 0.08, len * 0.03, rot), fill: 'rgba(255,240,220,0.25)', blend: 'screen' });
  return { shadow, body };
}

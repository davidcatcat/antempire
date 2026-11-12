/**
 * Art kit rasterizer (browser only): draws art-core draw lists onto a canvas and bakes sprite atlases.
 * Drawing only — it receives finished vector data and never reads or writes simulation data.
 */
import type { DrawList, Paint } from './art-core.ts';
import { ANT_EXTENT, ANT_PALETTE, GAITS, IDLE_FRAMES, NECK, WALK_FRAMES, antDrawListAt, antFrameDrawList, antGlints, antPoseAt, antennaPoints, framesOf, ANT_BODY_HEIGHT, type AntParts, type AntPalette, type Gait, type MicroPose } from './art-ant.ts';
import { light } from './art-core.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const pathCache = new Map<string, Path2D>();
const path2d = (d: string, cache = true) => { let p = pathCache.get(d); if (!p) { p = new Path2D(d); if (cache && pathCache.size < 20000) pathCache.set(d, p); } return p; };

function paint(g: Ctx, p: Paint): string | CanvasGradient {
  if (typeof p === 'string') return p;
  const gr = 'lin' in p ? g.createLinearGradient(p.lin[0], p.lin[1], p.lin[2], p.lin[3]) : g.createRadialGradient(p.rad[0], p.rad[1], p.rad[2], p.rad[3], p.rad[4], p.rad[5]);
  for (const [o, c] of p.stops) gr.addColorStop(o, c);
  return gr;
}

/** Draw a list with the current transform; `pxPerUnit` is the device-pixel scale (for minimum line widths). */
export function drawList(g: Ctx, list: DrawList, pxPerUnit: number, cache = true) {
  for (const s of list) {
    const p = path2d(s.d, cache);
    g.globalAlpha = s.alpha ?? 1;
    g.globalCompositeOperation = s.blend === 'multiply' ? 'multiply' : s.blend === 'screen' ? 'screen' : 'source-over';
    if (s.fill) { g.fillStyle = paint(g, s.fill); g.fill(p, s.evenodd ? 'evenodd' : 'nonzero'); }
    if (s.stroke && s.lw) {
      g.strokeStyle = paint(g, s.stroke); g.lineWidth = Math.max(s.lw, (s.minPx ?? 0) / pxPerUnit);
      g.lineCap = s.cap ?? 'round'; g.lineJoin = 'round'; g.stroke(p);
    }
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
}

export interface AntAtlas { canvas: HTMLCanvasElement | ImageBitmap; shadow: HTMLCanvasElement | ImageBitmap; cellW: number; cellH: number; scale: number; walk: number; idle: number; ox: number; oy: number; rows: Gait[] }
/** Bake every gait (one row each, GAITS order) for an ant drawn `lengthPx` long (CSS px) at device ratio `dpr`.
 *  The body sprite carries no directional light (rotation-safe); shadow offset and glints follow the active light. */
export function bakeAntAtlas(lengthPx: number, dpr: number, rows: Gait[] = GAITS, palette: AntPalette = ANT_PALETTE, parts: AntParts = 'all'): AntAtlas {
  const scale = (lengthPx * dpr) / 100, e = ANT_EXTENT;
  const cellW = Math.ceil((e.x1 - e.x0) * scale) + 2, cellH = Math.ceil((e.y1 - e.y0) * scale) + 2, cols = Math.max(WALK_FRAMES, IDLE_FRAMES);
  const mk = () => { const c = document.createElement('canvas'); c.width = cellW * cols; c.height = cellH * rows.length; return c; };
  const canvas = mk(), shadow = mk(), g = canvas.getContext('2d') as CanvasRenderingContext2D, gs = shadow.getContext('2d') as CanvasRenderingContext2D;
  rows.forEach((kind, row) => {
    for (let i = 0; i < framesOf(kind); i++) {
      const fr = antFrameDrawList(kind, i, palette, parts);
      for (const [ctx, list] of [[g, fr.body], [gs, fr.shadow]] as const) {
        ctx.setTransform(scale, 0, 0, scale, i * cellW + 1 - e.x0 * scale, row * cellH + 1 - e.y0 * scale);
        drawList(ctx, list, scale);
      }
    }
  });
  g.setTransform(1, 0, 0, 1, 0, 0); gs.setTransform(1, 0, 0, 1, 0, 0);
  const atlas: AntAtlas = { canvas, shadow, cellW, cellH, scale, walk: WALK_FRAMES, idle: IDLE_FRAMES, ox: 1 - e.x0 * scale, oy: 1 - e.y0 * scale, rows };
  // swap to ImageBitmaps when ready (much cheaper to blit in software-rendered browsers); same pixels
  if (typeof createImageBitmap === 'function') { void createImageBitmap(canvas).then((b) => { atlas.canvas = b; }); void createImageBitmap(shadow).then((b) => { atlas.shadow = b; }); }
  return atlas;
}

/** Draw one ant from an atlas at CSS position (x,y), heading (radians, screen frame), frame of gait `kind`.
 *  The caller's context must have the DPR transform set (CSS px units). Shadow offset is applied in screen space. */
export function drawAntSprite(g: CanvasRenderingContext2D, a: AntAtlas, dpr: number, x: number, y: number, heading: number, kind: Gait, frame: number, opts: { glints?: boolean; shadowAlpha?: number; part?: 'both' | 'shadow' | 'body' } = {}) {
  const part = opts.part ?? 'both';
  const row = Math.max(0, a.rows.indexOf(kind)), sx = (frame % framesOf(kind)) * a.cellW, sy = row * a.cellH, k = 1 / dpr, u = a.scale / dpr; // u = CSS px per unit
  const h = ANT_BODY_HEIGHT * u, L = light();
  if (L.intensity > 0 && part !== 'body') {
    g.save(); g.globalAlpha = (opts.shadowAlpha ?? 1) * Math.min(1, 0.35 + L.intensity); g.translate(x + L.shadow.x * h, y + L.shadow.y * h); g.rotate(heading);
    g.drawImage(a.shadow, sx, sy, a.cellW, a.cellH, -a.ox * k, -a.oy * k, a.cellW * k, a.cellH * k); g.restore();
  }
  if (part === 'shadow') return;
  g.save(); g.translate(x, y); g.rotate(heading);
  g.drawImage(a.canvas, sx, sy, a.cellW, a.cellH, -a.ox * k, -a.oy * k, a.cellW * k, a.cellH * k);
  if (opts.glints !== false) { g.scale(u, u); drawList(g, antGlints(heading), u * dpr); }
  g.restore();
}

/** RGBA pixel buffer → canvas (for the procedural soil tiles). */
export function pixelsToCanvas(px: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  (c.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  return c;
}

// ------------------------------------------------------------------ display micro-motion (head yaw + antennae)
/** Head sprite (head, mandibles, eyes at yaw 0) for the parts path; drawn rotated about NECK. */
export interface HeadSprite { canvas: HTMLCanvasElement; scale: number; ox: number; oy: number; w: number; h: number }
export function bakeHeadSprite(lengthPx: number, dpr: number, palette: AntPalette = ANT_PALETTE): HeadSprite {
  const scale = (lengthPx * dpr) / 100, x0 = 18, x1 = 52, y0 = -12, y1 = 12, w = Math.ceil((x1 - x0) * scale) + 2, h = Math.ceil((y1 - y0) * scale) + 2;
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(scale, 0, 0, scale, 1 - x0 * scale, 1 - y0 * scale); drawList(g, antFrameDrawList('idle', 0, palette, 'head').body, scale); g.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas: c, scale, ox: 1 - x0 * scale, oy: 1 - y0 * scale, w, h };
}
/** Antennae drawn live from a micro-pose, in the ant's local frame (the caller has translated / rotated / scaled to
 *  local units). Two passes (dark outline, then limb colour) with a thicker club. */
export function drawAntennaeLocal(g: CanvasRenderingContext2D, m: MicroPose, palette: AntPalette, pxPerUnit: number) {
  const c = Math.cos(m.headYaw), s = Math.sin(m.headYaw), rot = ([x, y]: [number, number]): [number, number] => [NECK[0] + (x - NECK[0]) * c - (y - NECK[1]) * s, NECK[1] + (x - NECK[0]) * s + (y - NECK[1]) * c];
  const L = antennaPoints(-1, m.L.scape, m.L.fun, m.L.reach).map(rot), R = antennaPoints(1, m.R.scape, m.R.fun, m.R.reach).map(rot), min = 0.6 / pxPerUnit;
  const pass = (from: number, to: number) => { g.beginPath(); for (const pts of [L, R]) { g.moveTo(pts[from][0], pts[from][1]); for (let i = from + 1; i <= to; i++) g.lineTo(pts[i][0], pts[i][1]); } };
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const [col, extra] of [[palette.outline, 0.7], [palette.limb, 0]] as const) {
    g.strokeStyle = col;
    pass(0, 9); g.lineWidth = Math.max(min + extra / 2, 1.5 + extra); g.stroke();
    pass(9, 12); g.lineWidth = Math.max(min * 1.6 + extra / 2, 2.6 + extra); g.stroke();
  }
}
/** Parts path: trunk atlas frame + head sprite rotated by the micro head yaw + live antennae. Positions / heading are
 *  the caller's (engine or physics); this only draws. */
export function drawAntParts(g: CanvasRenderingContext2D, trunk: AntAtlas, head: HeadSprite, dpr: number, x: number, y: number, heading: number, kind: Gait, frame: number, micro: MicroPose, palette: AntPalette) {
  drawAntSprite(g, trunk, dpr, x, y, heading, kind, frame, { part: 'body', glints: false });
  drawAntHeadLive(g, trunk, head, dpr, x, y, heading, micro, palette);
}
/** The live part of drawAntParts: the head sprite turned by the micro head yaw about the neck, and the antennae, drawn
 *  over a trunk already on the canvas at (x, y, heading) (the live trunk sprite, or a pre-rotated trunk blit whose
 *  bucket heading is passed here). `trunk` only supplies the scale. Drawing only. */
export function drawAntHeadLive(g: CanvasRenderingContext2D, trunk: AntAtlas, head: HeadSprite, dpr: number, x: number, y: number, heading: number, micro: MicroPose, palette: AntPalette) {
  const k = 1 / dpr, u = trunk.scale / dpr;
  g.save(); g.translate(x, y); g.rotate(heading);
  g.save(); g.translate(NECK[0] * u, NECK[1] * u); g.rotate(micro.headYaw); g.translate(-NECK[0] * u, -NECK[1] * u);
  g.drawImage(head.canvas, 0, 0, head.w, head.h, -head.ox * k, -head.oy * k, head.w * k, head.h * k); g.restore();
  g.scale(u, u); drawAntennaeLocal(g, micro, palette, u); g.restore();
}
/** Detail path (close-ups): the whole ant drawn live from a continuous pose (gait phase, walk weight, micro-pose).
 *  Not cached in the shared path cache (every frame is a new pose). */
export function drawAntDetail(g: CanvasRenderingContext2D, lengthPx: number, x: number, y: number, heading: number, kind: Gait, phi: number, walkW: number, micro: MicroPose, palette: AntPalette, opts: { part?: 'both' | 'shadow' | 'body' } = {}) {
  const u = lengthPx / 100, fr = antDrawListAt(antPoseAt(kind, phi, { walkW, micro }), palette), part = opts.part ?? 'both', L = light(), h = ANT_BODY_HEIGHT * u;
  if (L.intensity > 0 && part !== 'body') { g.save(); g.globalAlpha = Math.min(1, 0.35 + L.intensity); g.translate(x + L.shadow.x * h, y + L.shadow.y * h); g.rotate(heading); g.scale(u, u); drawList(g, fr.shadow, u, false); g.restore(); }
  if (part === 'shadow') return;
  g.save(); g.translate(x, y); g.rotate(heading); g.scale(u, u); drawList(g, fr.body, u, false); g.restore();
}

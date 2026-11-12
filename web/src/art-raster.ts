/**
 * Art kit rasterizer (browser only): draws art-core draw lists onto a canvas and bakes sprite atlases.
 * Drawing only — it receives finished vector data and never reads or writes simulation data.
 */
import type { DrawList, Paint } from './art-core.ts';
import { ANT_EXTENT, ANT_PALETTE, GAITS, IDLE_FRAMES, WALK_FRAMES, antFrameDrawList, antGlints, framesOf, ANT_BODY_HEIGHT, type AntPalette, type Gait } from './art-ant.ts';
import { light } from './art-core.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const pathCache = new Map<string, Path2D>();
const path2d = (d: string) => { let p = pathCache.get(d); if (!p) { p = new Path2D(d); if (pathCache.size < 20000) pathCache.set(d, p); } return p; };

function paint(g: Ctx, p: Paint): string | CanvasGradient {
  if (typeof p === 'string') return p;
  const gr = 'lin' in p ? g.createLinearGradient(p.lin[0], p.lin[1], p.lin[2], p.lin[3]) : g.createRadialGradient(p.rad[0], p.rad[1], p.rad[2], p.rad[3], p.rad[4], p.rad[5]);
  for (const [o, c] of p.stops) gr.addColorStop(o, c);
  return gr;
}

/** Draw a list with the current transform; `pxPerUnit` is the device-pixel scale (for minimum line widths). */
export function drawList(g: Ctx, list: DrawList, pxPerUnit: number) {
  for (const s of list) {
    const p = path2d(s.d);
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
export function bakeAntAtlas(lengthPx: number, dpr: number, rows: Gait[] = GAITS, palette: AntPalette = ANT_PALETTE): AntAtlas {
  const scale = (lengthPx * dpr) / 100, e = ANT_EXTENT;
  const cellW = Math.ceil((e.x1 - e.x0) * scale) + 2, cellH = Math.ceil((e.y1 - e.y0) * scale) + 2, cols = Math.max(WALK_FRAMES, IDLE_FRAMES);
  const mk = () => { const c = document.createElement('canvas'); c.width = cellW * cols; c.height = cellH * rows.length; return c; };
  const canvas = mk(), shadow = mk(), g = canvas.getContext('2d') as CanvasRenderingContext2D, gs = shadow.getContext('2d') as CanvasRenderingContext2D;
  rows.forEach((kind, row) => {
    for (let i = 0; i < framesOf(kind); i++) {
      const fr = antFrameDrawList(kind, i, palette);
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

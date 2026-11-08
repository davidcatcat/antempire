/**
 * Layered Canvas renderer (browser). Draws a garden scene in the fixed 11-layer order (render-scene LAYERS):
 *   ground → decals → shadows → propsLow → routes → antShadows → ants → propsHigh → lighting → weather → ui.
 * - Ground, litter, contact/cast shadows and low décor are BAKED per chunk (512 device px, zoom bucketed to powers of
 *   two, DPR-aware, LRU-capped) with a per-frame bake budget; the high décor layer (grass tips) is baked alongside.
 * - Engine objects (nest, food sources) are drawn at their exact affine position from per-state sprite caches, and are
 *   listed in `engineObjects()` so overlays can distinguish them from 示意 décor (which is never pickable).
 * - Ants: planAnts (pure) → atlas sprites; walk/idle from the caller's moving flag; turning gaits only with an
 *   authoritative ω. Input frames are never mutated; the renderer creates no events and writes nothing.
 * - Light: the active LightState (replay: SCHEMATIC_LIGHT). Weather: daily day state only (no rain streaks).
 * - Adaptive quality steps down (never up) when frames are slow: glints/décor LOD → DPR 1 → no ant shadows.
 * - Options (drawing only, positions unchanged): `antSprites: 'prerotated'` blits walk / idle frames from pre-rotated
 *   sheets (heading bucketed to 2π/n, n chosen under a texture budget; render-scene planRotatedAtlas) instead of a
 *   rotated drawImage per ant; `externalAnts` hands the two ant layers to another drawer (e.g. a WebGL overlay, used by
 *   prototypes/render-compare) and draws the layers above the ants on its `above` context; `fixedQuality` pins the
 *   quality level (comparisons).
 */
import { LAYERS, QUALITY, PREROTATED_GAITS, ROT_ATLAS_BUDGET, ROT_SHEET_PX, bucketAngle, chooseBuckets, headingBucket, planRotatedAtlas, rotCellIndex, rotDrawRect, rotatedAtlasBytes, type RotPlan, DECOR_CELL_CM, DECOR_REACH_CM, groundField, reliefHeight, antLengthPx, decorCell, engineRegistry, keepAtLod, nextQuality, planAnts, weatherState, worldToScreen, type AntDraw, type AntInput, type AntLook, type Camera, type DecorItem, type EngineObject, type Layer, type Obstacles, type WeatherState } from './render-scene.ts';
import { bakeAntAtlas, drawAntSprite, drawList, pixelsToCanvas, type AntAtlas } from './art-raster.ts';
import { ANT_BODY_HEIGHT, PALETTE_VARIANTS, antGlintSpots, antPalette, magnification, walkCycles, walkFrame, framesOf, type Gait } from './art-ant.ts';
import { SCHEMATIC_LIGHT, withLight, type LightState } from './art-core.ts';
import { soilTile, leaf, twig, pebble, grassTuft, moss, debris, type Decal } from './art-ground.ts';
import { nestEntrance, hostPlant, flower, insectCarcass } from './art-props.ts';
import type { Place } from './model.ts';
import { hash32 } from './game-model.ts';

type Pos = Record<string, { x: number; y: number; known: boolean }>;
type Sources = Record<string, { host_alive: boolean | null; hemipteran_colonies: number | null }>;
export interface SceneInput { /** false = ground only (seam tests) */ decor?: boolean; seed: number; places: readonly Place[]; pos: Pos; routes: Obstacles['routes']; sources: Sources; weather: Parameters<typeof weatherState>[0]; light?: LightState }
export interface FrameOptions { showRoutes?: boolean; highlightEngine?: boolean; labels?: boolean; /** minimum drawn ant length (CSS px); larger = more magnified (labelled ×N) */ minAntPx?: number; /** use the turning frames for the display ease toward recorded heading changes */ displayTurns?: boolean; /** per-ant colour variants (light … dark brown) */ colourVariants?: boolean; /** space kept free at the bottom for page controls (CSS px) */ uiBottom?: number }
/** Options of the layered renderer. All of them change drawing only. */
export interface RendererOptions {
  /** 'rotate' (default): one rotated atlas blit per ant. 'prerotated': walk / idle from pre-rotated sheets. */
  antSprites?: 'rotate' | 'prerotated';
  /** texture budget (bytes) of the pre-rotated sheets for all colour variants + the shared shadow set */
  atlasBudgetBytes?: number;
  /** pin the quality level (no adaptive steps); for like-for-like comparisons */
  fixedQuality?: 0 | 1 | 2 | 3;
  /** another drawer for the antShadows / ants layers; the layers after 'ants' are then drawn on `above` */
  externalAnts?: ExternalAnts;
  /** maximum side (device px) of one pre-rotated sheet (default ROT_SHEET_PX) */
  rotSheetPx?: number;
  /** keep the destination anchor of every ant blit of the last frame (tests) */
  recordBlits?: boolean;
}
export interface AntLayerInfo { L: number; dpr: number; cam: Camera; shadows: boolean; crowd: boolean; light: LightState; atlasFor: (variant: number) => AntAtlas; variantOf: (id: string) => number; frameOf: (d: AntDraw) => number; shadowLift: number }
export interface ExternalAnts { draw(layer: 'antShadows' | 'ants', draws: readonly AntDraw[], info: AntLayerInfo): void; above: CanvasRenderingContext2D }
/** one pre-rotated set: plan + sheets per colour variant (lazily baked) + the shared shadow sheets */
interface RotAtlas { plan: RotPlan; key: string; body: Map<number, (HTMLCanvasElement | ImageBitmap)[]>; shadow: (HTMLCanvasElement | ImageBitmap)[] | null }
const CROWD = 300, CHUNK_PX = 256, SOIL_TILE_MM = 80, SOIL_TILE_PX = 512, MAX_CHUNKS = 120, MIN_ITEM_DEVICE_PX = 2.5;
/** world-space ground field sampled on a (FIELD_N+1)² grid per chunk, samples exactly on the chunk edges, so bilinear
 *  upscaling is continuous across chunk boundaries */
const FIELD_N = 32, FIELD_STEP = CHUNK_PX / FIELD_N, GUTTER = 4;
const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
const ctxOf = (c: HTMLCanvasElement) => c.getContext('2d') as CanvasRenderingContext2D;
/** Resample a seamless tile to `px` square WITHOUT edge darkening: fill through a repeating pattern (wraps at the edges,
 *  where a plain scaled drawImage would blend in transparent pixels and draw a visible grid). */
function resampleTile(src: HTMLCanvasElement, px: number): HTMLCanvasElement {
  const n = Math.max(8, Math.round(px)), t = mk(n, n), g = ctxOf(t), pat = g.createPattern(src, 'repeat') as CanvasPattern;
  pat.setTransform(new DOMMatrix([n / src.width, 0, 0, n / src.height, 0, 0])); g.imageSmoothingQuality = 'high'; g.fillStyle = pat; g.fillRect(0, 0, n, n);
  return t;
}

export class LayeredRenderer {
  readonly g: CanvasRenderingContext2D;
  /** layers drawn in the last frame, in order (tests / harness) */
  trace: Layer[] = [];
  stats = { bakes: 0, bakedThisFrame: 0, chunks: 0, missing: 0, quality: 0, planMs: 0, layerMs: {} as Record<string, number>, lastMs: {} as Record<string, number> };
  private scene: SceneInput | null = null;
  private registry: EngineObject[] = [];
  private obstacles: Obstacles = { places: [], routes: [] };
  private weather: WeatherState = weatherState(null);
  private light: LightState = SCHEMATIC_LIGHT;
  private chunks = new Map<string, { low: HTMLCanvasElement; high: HTMLCanvasElement | null }>();
  private cells = new Map<string, DecorItem[]>();
  private objSprites = new Map<string, { low: HTMLCanvasElement; high: HTMLCanvasElement | null; half: number; scale: number }>();
  private tiles = new Map<string, HTMLCanvasElement>();
  private soilSrc = new Map<string, HTMLCanvasElement>();
  private atlases = new Map<string, AntAtlas>();
  private look = new Map<string, AntLook>();
  private frameMs: number[] = [];
  private q = 0;
  private dpr = 1;
  private cam: Camera = { cx: 0, cy: 0, s: 4, w: 1, h: 1 };
  private draws: AntDraw[] = [];
  private overlays = new Map<string, HTMLCanvasElement>();
  private glint: HTMLCanvasElement | null = null;
  private bakedLast = true;
  private spritesBaked = 0;

  private rot = new Map<string, RotAtlas | null>();
  /** ant blits of the last frame: id, anchor (CSS px), drawn heading, bucket (−1 = live rotation) — tests only */
  blits: { id: string; ax: number; ay: number; heading: number; bucket: number; n: number }[] = [];
  antStats = { prerotated: 0, rotated: 0, buckets: 0 as number | null, rotBytes: 0, rotBakeMs: 0 };
  /** current drawing target (the main context, or ExternalAnts.above for the layers above the ants) */
  private tg: CanvasRenderingContext2D;

  readonly canvas: HTMLCanvasElement;
  readonly opts: RendererOptions;
  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) { this.canvas = canvas; this.g = ctxOf(canvas); this.tg = this.g; this.opts = opts; if (opts.fixedQuality !== undefined) this.q = opts.fixedQuality; }

  /** New world: places, recorded routes, engine state and weather. Clears every cache. */
  setScene(s: SceneInput) {
    this.scene = s; this.light = s.light ?? SCHEMATIC_LIGHT; this.chunks.clear(); this.objSprites.clear(); this.look.clear(); this.cells.clear();
    this.setEngineState(s.sources, s.weather);
    this.obstacles = { places: this.registry.map((o) => ({ x: o.x, y: o.y, radiusCm: o.radiusCm })), routes: s.routes, plants: this.registry.filter((o) => o.kind === 'honeydew' || o.kind === 'nectar').map((o) => ({ x: o.x, y: o.y })) }; this.cells.clear();
  }
  /** Per-day engine state (food-source state, daily weather). Only engine-object sprites change; wet ground is a per-frame tint. */
  setEngineState(sources: Sources, weather: SceneInput['weather']) {
    if (!this.scene) return;
    this.registry = engineRegistry(this.scene.places, this.scene.pos, sources);
    const w = weatherState(weather);
    this.weather = w;
  }
  /** Pre-build the sprites and overlay a coming engine state needs (e.g. the next day), without switching to it, so
   *  the day change does not stall a frame. Drawing caches only. */
  prepare(sources: Sources, weather: SceneInput['weather']) {
    if (!this.scene) return;
    for (const o of engineRegistry(this.scene.places, this.scene.pos, sources)) this.objSprite(o);
    const w = this.weather; this.weather = weatherState(weather); this.overlayFor(this.cam.w, this.cam.h); this.weather = w;
  }
  /** Forget the drawing-only motion state (heading ease, leg phase), e.g. after a time jump. */
  resetMotion() { this.look = new Map(); }
  engineObjects(): readonly EngineObject[] { return this.registry; }
  /** Screen x / y of the visible chunk boundaries at the current zoom (CSS px; seam tests). */
  chunkBoundaries(): { xs: number[]; ys: number[] } {
    const b = this.bucket(this.cam.s), cm = CHUNK_PX / b, xs: number[] = [], ys: number[] = [];
    for (const [i, j] of this.visibleChunks(b)) { xs.push(worldToScreen(this.cam, i * cm, 0)[0]); ys.push(worldToScreen(this.cam, 0, j * cm)[1]); }
    return { xs: [...new Set(xs)].filter((x) => x > 2 && x < this.cam.w - 2), ys: [...new Set(ys)].filter((y) => y > 2 && y < this.cam.h - 2) };
  }
  weatherDay(): WeatherState { return this.weather; }
  quality() { return QUALITY[this.q]; }
  lastDraws(): readonly AntDraw[] { return this.draws; }

  /** Size the backing store to the element × DPR (capped by the quality level). */
  resize() {
    this.dpr = Math.min(QUALITY[this.q].dprCap, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
    this.overlays.clear(); // world caches are keyed by zoom bucket (which includes the DPR), so they need no clearing
  }

  // ------------------------------------------------------------ chunk baking
  /** zoom bucket from the device's own DPR (not the quality-capped one), so a quality step never forces a rebake */
  private bucket(s: number) { return Math.min(128, Math.max(1, 2 ** Math.round(Math.log2(s * Math.min(2, window.devicePixelRatio || 1))))); }
  private soilTileAt(px: number): HTMLCanvasElement {
    const k = `${this.scene?.seed}|${this.light.label}|${px}`; let t = this.tiles.get(k); if (t) return t;
    const sk = this.light.label; let src = this.soilSrc.get(sk);
    if (!src) { src = pixelsToCanvas(soilTile({ size: SOIL_TILE_PX, seed: (this.scene?.seed ?? 1) ^ 0x50f1, light: this.light, flatten: 0.85 }), SOIL_TILE_PX, SOIL_TILE_PX); this.soilSrc.set(sk, src); }
    t = resampleTile(src, px);
    this.tiles.set(k, t); return t;
  }
  /** World-space ground field (colour / damp variation, periods 0.6–4.5 m) for one chunk as a multiply image. */
  private fieldImage(seed: number, x0: number, y1: number, cm: number): HTMLCanvasElement {
    // soft-light image (128 = no change): large-scale tone / damp variation plus a lit micro-relief (hillshade of a
    // world-space height field, key light from the active LightState). Samples −1 … N+1, one beyond each edge.
    const n = FIELD_N + 3, c = mk(n, n), g = ctxOf(c), img = g.createImageData(n, n), step = cm / FIELD_N, e = Math.max(0.25, step * 0.5);
    const L = this.light, dl = Math.hypot(L.dir.x, L.dir.y) || 1, lx = -L.dir.x / dl, ly = L.dir.y / dl; // toward the light, world frame (y north)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = x0 + (i - 1) * step, y = y1 - (j - 1) * step, f = groundField(seed, x, y);
      const gx = (reliefHeight(seed, x + e, y) - reliefHeight(seed, x - e, y)) / (2 * e), gy = (reliefHeight(seed, x, y + e) - reliefHeight(seed, x, y - e)) / (2 * e);
      const shade = Math.max(-1, Math.min(1, -(gx * lx + gy * ly) * 9 * L.intensity));
      const v = Math.max(0, Math.min(1, 0.5 + 0.3 * shade + 0.32 * (f.tone - 0.5) - 0.16 * f.moist)), q = (j * n + i) * 4;
      img.data[q] = 255 * v; img.data[q + 1] = 255 * v * 0.98; img.data[q + 2] = 255 * v * 0.95; img.data[q + 3] = 255;
    }
    g.putImageData(img, 0, 0); return c;
  }
  private decalOf(it: DecorItem, xm: number, ym: number, detail: 0 | 1): Decal {
    switch (it.kind) {
      case 'leaf': return leaf(it.seed, it.leafKind ?? 'ovate', xm, ym, it.rot, it.sizeMm, detail);
      case 'twig': return twig(it.seed, xm, ym, it.rot, it.sizeMm);
      case 'pebble': return pebble(it.seed, xm, ym, it.sizeMm);
      case 'grass': return grassTuft(it.seed, xm, ym, it.sizeMm, it.dry ?? 0);
      case 'moss': return moss(it.seed, xm, ym, it.sizeMm);
      default: return debris(it.seed, xm, ym, it.sizeMm, 14);
    }
  }
  private bakeChunk(bucket: number, i: number, j: number) {
    const s = this.scene as SceneInput, cm = CHUNK_PX / bucket, x0 = i * cm, y0 = j * cm, y1 = y0 + cm, lod = QUALITY[this.q].decorLod;
    // baked with a GUTTER of neighbouring ground on every side, so the bilinear resampling at blit time sees the real
    // neighbouring pixels at the chunk edge (no clamped edge column = no seam)
    const low = mk(CHUNK_PX + 2 * GUTTER, CHUNK_PX + 2 * GUTTER), g = ctxOf(low); g.translate(GUTTER, GUTTER);
    withLight(this.light, () => {
      // ground: soil tile anchored at the world origin (continuous across chunks) + large-scale tint
      // ground detail: the soil tile anchored at the world origin, its world period growing at far zoom so it never
      // shrinks below 128 px (a tiny repeating tile reads as a grid), plus a second copy rotated and rescaled
      // (golden ratio) at low alpha so the period is broken; then the world-space ground field (non-periodic).
      const tp = Math.max(SOIL_TILE_MM / 10 * bucket, 128), tile = this.soilTileAt(tp), k0 = tp / tile.width;
      const pat = g.createPattern(tile, 'repeat') as CanvasPattern, base = new DOMMatrix([1, 0, 0, 1, -x0 * bucket, y1 * bucket]);
      pat.setTransform(base.scale(k0)); g.fillStyle = pat; g.fillRect(-GUTTER, -GUTTER, CHUNK_PX + 2 * GUTTER, CHUNK_PX + 2 * GUTTER);
      const pat2 = g.createPattern(tile, 'repeat') as CanvasPattern; pat2.setTransform(base.rotate(37).scale(k0 * 1.618));
      g.save(); g.globalAlpha = 0.5; g.fillStyle = pat2; g.fillRect(-GUTTER, -GUTTER, CHUNK_PX + 2 * GUTTER, CHUNK_PX + 2 * GUTTER); g.restore();
      g.save(); g.globalCompositeOperation = 'soft-light'; g.imageSmoothingEnabled = true; g.drawImage(this.fieldImage(s.seed, x0, y1, cm), -FIELD_STEP * 1.5, -FIELD_STEP * 1.5, (FIELD_N + 3) * FIELD_STEP, (FIELD_N + 3) * FIELD_STEP); g.restore();
      // décor of all cells that can overlap this chunk, in mm relative to the chunk's top-left corner
      const items: DecorItem[] = [], c0 = Math.floor((x0 - DECOR_REACH_CM) / DECOR_CELL_CM), c1 = Math.floor((x0 + cm + DECOR_REACH_CM) / DECOR_CELL_CM), r0 = Math.floor((y0 - DECOR_REACH_CM) / DECOR_CELL_CM), r1 = Math.floor((y1 + DECOR_REACH_CM) / DECOR_CELL_CM);
      for (let ci = c0; ci <= c1; ci++) for (let cj = r0; cj <= r1; cj++) for (const it of (s.decor === false ? [] : this.cell(s.seed, ci, cj))) if (keepAtLod(it, lod) && (it.sizeMm / 10) * bucket >= MIN_ITEM_DEVICE_PX) items.push(it); // zoom LOD: skip items under ~2.5 device px
      const detail: 0 | 1 = bucket >= 24 ? 1 : 0, decals = items.map((it) => ({ it, d: this.decalOf(it, (it.x - x0) * 10, (y1 - it.y) * 10, detail) }));
      const flat = decals.filter((x) => x.it.kind !== 'pebble' && x.it.kind !== 'grass'), raised = decals.filter((x) => x.it.kind === 'pebble' || x.it.kind === 'grass');
      const k = bucket / 10; g.save(); g.scale(k, k);
      for (const { d } of flat) drawList(g, d.shadow, k); for (const { d } of flat) drawList(g, d.body, k);   // decals
      for (const { d } of raised) drawList(g, d.shadow, k);                                                  // contact / cast shadows
      for (const { d } of raised) drawList(g, d.body, k);                                                    // low props
      g.restore();
      let high: HTMLCanvasElement | null = null;
      const hi = decals.filter((x) => x.d.high?.length);
      if (hi.length) { high = mk(CHUNK_PX + 2 * GUTTER, CHUNK_PX + 2 * GUTTER); const h = ctxOf(high); h.translate(GUTTER, GUTTER); h.scale(k, k); for (const { d } of hi) drawList(h, d.highShadow ?? [], k); for (const { d } of hi) drawList(h, d.high ?? [], k); }
      this.chunks.set(this.chunkKey(bucket, i, j), { low, high });
    });
    this.stats.bakes++; this.stats.bakedThisFrame++;
    while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value as string); // LRU (insertion order, refreshed on use)
  }
  private chunkKey(b: number, i: number, j: number) { return `${b}|${i}|${j}`; } // wet days are a per-frame tint, so a day change never forces a rebake // décor LOD applies to new bakes only (no rebake storm on a quality step)
  private cell(seed: number, i: number, j: number): DecorItem[] {
    const k = `${i}|${j}`; let c = this.cells.get(k);
    if (!c) { c = decorCell(seed, i, j, this.obstacles); this.cells.set(k, c); if (this.cells.size > 6000) this.cells.delete(this.cells.keys().next().value as string); }
    return c;
  }
  private visibleChunks(bucket: number) {
    const cm = CHUNK_PX / bucket, c = this.cam, x0 = c.cx - c.w / 2 / c.s, x1 = c.cx + c.w / 2 / c.s, y0 = c.cy - c.h / 2 / c.s, y1 = c.cy + c.h / 2 / c.s, out: [number, number][] = [];
    for (let i = Math.floor(x0 / cm); i <= Math.floor(x1 / cm); i++) for (let j = Math.floor(y0 / cm); j <= Math.floor(y1 / cm); j++) out.push([i, j]);
    return out;
  }
  /** Bake every visible chunk now (scene open / large jumps), ignoring the per-frame budget. */
  warm(cam: Camera) { this.cam = cam; const b = this.bucket(cam.s); for (const [i, j] of this.visibleChunks(b)) if (!this.chunks.has(this.chunkKey(b, i, j))) this.bakeChunk(b, i, j); }

  private blitChunks(which: 'low' | 'high') {
    const b = this.bucket(this.cam.s), cm = CHUNK_PX / b, g = this.tg, size = cm * this.cam.s;
    for (const [i, j] of this.visibleChunks(b)) {
      const key = this.chunkKey(b, i, j); let ch = this.chunks.get(key);
      if (!ch && which === 'low' && this.stats.bakedThisFrame < QUALITY[this.q].maxBakesPerFrame) { this.bakeChunk(b, i, j); ch = this.chunks.get(key); }
      const [sx, sy] = worldToScreen(this.cam, i * cm, (j + 1) * cm);
      if (!ch) { if (which === 'low') { this.stats.missing++; g.fillStyle = '#4a3726'; g.fillRect(sx, sy, size + 1, size + 1); } continue; }
      if (which === 'low') { this.chunks.delete(key); this.chunks.set(key, ch); }
      // snap both edges to the device-pixel grid: neighbouring chunks then share an exact edge (no overlap, no gap,
      // no antialiased boundary column)
      const D = this.dpr, ax = Math.round(sx * D) / D, ay = Math.round(sy * D) / D, bx = Math.round((sx + size) * D) / D, by = Math.round((sy + size) * D) / D;
      const img = which === 'low' ? ch.low : ch.high; if (img) g.drawImage(img, GUTTER, GUTTER, CHUNK_PX, CHUNK_PX, ax, ay, bx - ax, by - ay);
    }
  }

  // ------------------------------------------------------------ engine objects
  private objSprite(o: EngineObject) {
    const b = this.bucket(this.cam.s), key = `${o.id}|${b}|${o.hostAlive}|${o.colonies}|${this.light.label}`; let sp = this.objSprites.get(key); if (sp) return sp;
    const halfCm = o.radiusCm * 2.2, px = Math.min(1600, 2 * halfCm * b), scale = px / (2 * halfCm), low = mk(px, px), gl = ctxOf(low), k = scale / 10, c = halfCm * 10;
    let high: HTMLCanvasElement | null = null;
    withLight(this.light, () => {
      const seed = (this.scene?.seed ?? 1) ^ (o.id.charCodeAt(1) * 7919 + o.id.charCodeAt(2));
      const d: Decal = o.kind === 'nest' ? nestEntrance(seed, c, c, o.radiusCm * 10 * 0.85) : o.kind === 'honeydew' ? hostPlant(seed, c, c, { alive: o.hostAlive !== false, colonies: o.colonies ?? 0, insect: o.insect, size: o.radiusCm * 10 * 1.35 }) : o.kind === 'nectar' ? flower(seed, c, c, o.radiusCm * 10) : insectCarcass(seed, c, c, (seed % 628) / 100, o.radiusCm * 10 * 0.8);
      gl.scale(k, k); drawList(gl, d.shadow, k); drawList(gl, d.body, k);
      if (d.high?.length) { high = mk(px, px); const gh = ctxOf(high); gh.scale(k, k); drawList(gh, d.highShadow ?? [], k); drawList(gh, d.high, k); }
    });
    sp = { low, high, half: halfCm, scale }; this.spritesBaked++; this.objSprites.set(key, sp); if (this.objSprites.size > 64) this.objSprites.delete(this.objSprites.keys().next().value as string);
    return sp;
  }
  private drawObjects(which: 'low' | 'high') {
    for (const o of this.registry) {
      const [x, y] = worldToScreen(this.cam, o.x, o.y), sp = this.objSprite(o), img = which === 'low' ? sp.low : sp.high, half = sp.half * this.cam.s;
      if (x < -half || y < -half || x > this.cam.w + half || y > this.cam.h + half || !img) continue;
      this.tg.drawImage(img, x - half, y - half, half * 2, half * 2); // centred exactly on the engine position
    }
  }

  /** Lighting + weather grade baked once per (size, light, weather) and drawn with one plain blit per frame. */
  private overlayFor(w: number, h: number): HTMLCanvasElement {
    const key = `${w}|${h}|${this.dpr}|${this.light.label}|${this.weather.overcast}`, have = this.overlays.get(key); if (have) return have;
    const c = mk(w * this.dpr, h * this.dpr), g = ctxOf(c); g.scale(this.dpr, this.dpr);
    // source-over equivalents of the screen / multiply grades (one cheap blit instead of full-screen blend passes)
    const L = this.light, cx = w / 2, cy = h / 2, r = Math.hypot(w, h) / 2, d = Math.hypot(L.dir.x, L.dir.y) || 1, ux = L.dir.x / d, uy = L.dir.y / d;
    const wash = g.createLinearGradient(cx - ux * r, cy - uy * r, cx + ux * r, cy + uy * r); wash.addColorStop(0, `rgba(255,214,150,${(0.1 * L.intensity).toFixed(3)})`); wash.addColorStop(0.55, 'rgba(255,214,150,0)');
    g.fillStyle = wash; g.fillRect(0, 0, w, h);
    if (!L.schematic) { g.fillStyle = `rgba(18,20,34,${(1 - (0.42 + 0.58 * L.intensity)).toFixed(3)})`; g.fillRect(0, 0, w, h); }
    if (this.weather.overcast) { g.fillStyle = 'rgba(60,66,78,0.28)'; g.fillRect(0, 0, w, h); }
    const v = g.createRadialGradient(w * 0.45, h * 0.42, r * 0.35, cx, cy, r); v.addColorStop(0, 'rgba(30,18,8,0)'); v.addColorStop(0.6, 'rgba(30,18,8,0.12)'); v.addColorStop(1, 'rgba(24,14,6,0.42)');
    g.fillStyle = v; g.fillRect(0, 0, w, h);
    this.overlays.set(key, c); if (this.overlays.size > 8) this.overlays.delete(this.overlays.keys().next().value as string); this.spritesBaked++; return c;
  }
  private drawGlints(u: number) {
    if (!this.glint) { this.glint = mk(64, 64); const g = ctxOf(this.glint), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,246,232,1)'); gr.addColorStop(0.35, 'rgba(255,236,210,0.38)'); gr.addColorStop(1, 'rgba(255,236,210,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    const g = this.tg; g.save(); g.globalCompositeOperation = 'screen';
    for (const d of this.draws) {
      const c = Math.cos(d.heading), s = Math.sin(d.heading);
      for (const p of antGlintSpots(d.heading)) { const x = d.sx + (p.x * c - p.y * s) * u, y = d.sy + (p.x * s + p.y * c) * u, r = p.r * u; g.globalAlpha = p.a; g.drawImage(this.glint, x - r, y - r, r * 2, r * 2); }
    }
    g.restore();
  }

  // ------------------------------------------------------------ ants
  private atlasFor(L: number, variant: number): AntAtlas {
    const Lq = Math.max(8, Math.round((L * this.dpr) / 4) * 4) / this.dpr, key = `${Lq}|${this.dpr}|${variant}`;
    let a = this.atlases.get(key);
    if (!a) { a = bakeAntAtlas(Lq, this.dpr, undefined, antPalette(variant)); this.atlases.set(key, a); this.spritesBaked++; if (this.atlases.size > PALETTE_VARIANTS * 2) this.atlases.delete(this.atlases.keys().next().value as string); }
    return a;
  }

  /** Pre-rotated set for this drawn length (null = over budget: live rotation). Sheets are baked from the same
   *  unrotated atlas the live path blits, rotated once per bucket, so both paths show the same frame art. */
  private rotFor(L: number): RotAtlas | null {
    const Lq = Math.max(8, Math.round((L * this.dpr) / 4) * 4) / this.dpr, key = `${Lq}|${this.dpr}`;
    if (this.rot.has(key)) return this.rot.get(key) as RotAtlas | null;
    const n = chooseBuckets(Lq, this.dpr, PALETTE_VARIANTS, this.opts.atlasBudgetBytes ?? ROT_ATLAS_BUDGET);
    const sp = this.opts.rotSheetPx ?? ROT_SHEET_PX, r: RotAtlas | null = n === null ? null : { plan: planRotatedAtlas(Lq, this.dpr, n, undefined, 1, sp, sp), key, body: new Map(), shadow: null };
    this.rot.set(key, r); if (this.rot.size > 2) { const k0 = this.rot.keys().next().value as string; this.rot.delete(k0); }
    return r;
  }
  private bakeRot(r: RotAtlas, src: AntAtlas, part: 'body' | 'shadow'): (HTMLCanvasElement | ImageBitmap)[] {
    const t0 = performance.now(), sheets = r.plan.sheets.map((s) => mk(s.w, s.h)), img = part === 'body' ? src.canvas : src.shadow;
    for (const c of r.plan.cells) {
      const g = ctxOf(sheets[c.sheet]), row = Math.max(0, src.rows.indexOf(c.gait)), th = bucketAngle(c.bucket, r.plan.n), co = Math.cos(th), si = Math.sin(th);
      g.setTransform(co, si, -si, co, c.x + c.ax, c.y + c.ay); // same transform as the live path at heading θ_k (device px)
      g.drawImage(img, (c.frame % framesOf(c.gait)) * src.cellW, row * src.cellH, src.cellW, src.cellH, -src.ox, -src.oy, src.cellW, src.cellH);
    }
    this.spritesBaked++; this.antStats.rotBakeMs += performance.now() - t0;
    // swap each sheet to an ImageBitmap when ready (as the live atlas does): same pixels, cheaper blits in software
    const out: (HTMLCanvasElement | ImageBitmap)[] = sheets;
    if (typeof createImageBitmap === 'function') sheets.forEach((c, i) => { void createImageBitmap(c).then((b) => { out[i] = b; }); });
    return out;
  }
  /** Estimated RGBA bytes of the ant textures held now (live atlases + pre-rotated sheets). */
  antTextureBytes(): number {
    let b = 0; for (const a of this.atlases.values()) b += 2 * a.cellW * a.cellH * Math.max(a.walk, a.idle) * a.rows.length * 4;
    for (const r of this.rot.values()) if (r) b += r.plan.bytesPerSet * (r.body.size + (r.shadow ? 1 : 0));
    return b;
  }
  /** Estimated RGBA bytes of the baked ground chunks held now. */
  chunkBytes(): number { let b = 0; for (const c of this.chunks.values()) b += (c.low.width * c.low.height + (c.high ? c.high.width * c.high.height : 0)) * 4; return b; }

  /** Draw one frame. `ants` are read only. Returns the ant draw records (screen positions) for picking. */
  frame(cam: Camera, ants: readonly AntInput[], dt: number, frameMs: number | null, opts: FrameOptions = {}): readonly AntDraw[] {
    // frames that followed a bake (chunks, object sprites, atlas) are not counted: quality reacts to steady-state cost only
    if (frameMs !== null && !this.bakedLast && this.opts.fixedQuality === undefined) { this.frameMs.push(frameMs); if (this.frameMs.length > 240) this.frameMs.shift(); const nq = nextQuality(this.q, this.frameMs); if (nq !== this.q) { this.q = nq; this.frameMs = []; this.resize(); } }
    this.stats.quality = this.q; this.stats.bakedThisFrame = 0; this.stats.missing = 0; this.cam = cam; this.trace = [];
    this.tg = this.g; let g = this.g; const tp = performance.now(), Q = QUALITY[this.q], plan = planAnts(cam, ants, this.look, dt, walkCycles, opts.minAntPx, opts.displayTurns ?? false);
    this.stats.planMs = this.stats.planMs * 0.95 + (performance.now() - tp) * 0.05;
    this.look = plan.look; this.draws = plan.draws;
    const L = antLengthPx(cam.s, opts.minAntPx), variantOf = (id: string) => (opts.colourVariants ? hash32(id) % PALETTE_VARIANTS : Math.floor(PALETTE_VARIANTS / 2)), atlas = this.atlasFor(L, variantOf(''));
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const frameOf = (d: AntDraw) => d.gait === 'idle' ? Math.floor(d.cycles * 4) % framesOf('idle') : walkFrame(d.cycles);
    const ext = this.opts.externalAnts, rec = this.opts.recordBlits, rot = this.opts.antSprites === 'prerotated' && !ext ? this.rotFor(L) : null;
    this.blits = []; this.antStats.prerotated = 0; this.antStats.rotated = 0; this.antStats.buckets = rot ? rot.plan.n : this.opts.antSprites === 'prerotated' ? null : 0;
    this.antStats.rotBytes = rot ? rotatedAtlasBytes(rot.plan, PALETTE_VARIANTS) : 0;
    const info = (): AntLayerInfo => ({ L, dpr: this.dpr, cam, shadows: Q.antShadows && this.light.intensity > 0, crowd: this.draws.length > CROWD, light: this.light, atlasFor: (v) => this.atlasFor(L, v), variantOf, frameOf, shadowLift: ANT_BODY_HEIGHT * atlas.scale / this.dpr });
    /** pre-rotated blit (B) of one ant; false = this gait has no pre-rotated sheet (live rotation) */
    const rotBlit = (d: AntDraw, part: 'body' | 'shadow'): boolean => {
      if (!rot || !PREROTATED_GAITS.includes(d.gait)) return false;
      const k = headingBucket(d.heading, rot.plan.n), c = rot.plan.cells[rotCellIndex(rot.plan, d.gait, frameOf(d), k)];
      let sheets: (HTMLCanvasElement | ImageBitmap)[];
      if (part === 'body') { const v = variantOf(d.id); sheets = rot.body.get(v) ?? (() => { const s = this.bakeRot(rot, this.atlasFor(L, v), 'body'); rot.body.set(v, s); return s; })(); }
      else sheets = rot.shadow ?? (rot.shadow = this.bakeRot(rot, atlas, 'shadow'));
      let x = d.sx, y = d.sy;
      if (part === 'shadow') { const h = ANT_BODY_HEIGHT * atlas.scale / this.dpr, Ls = this.light; x += Ls.shadow.x * h; y += Ls.shadow.y * h; g.globalAlpha = Math.min(1, 0.35 + Ls.intensity); }
      const r = rotDrawRect(c, this.dpr, x, y); g.drawImage(sheets[c.sheet], c.x, c.y, c.w, c.h, r.dx, r.dy, r.dw, r.dh); g.globalAlpha = 1;
      if (part === 'body') { this.antStats.prerotated++; if (rec) this.blits.push({ id: d.id, ax: r.dx + c.ax / this.dpr, ay: r.dy + c.ay / this.dpr, heading: bucketAngle(k, rot.plan.n), bucket: k, n: rot.plan.n }); }
      return true;
    };
    withLight(this.light, () => {
      const draw: Record<Layer, () => void> = {
        ground: () => { this.blitChunks('low'); if (this.weather.wet) { g.fillStyle = 'rgba(22,16,10,0.3)'; g.fillRect(0, 0, cam.w, cam.h); } }, // baked: soil + decals + shadows + low props; wet day = darkened ground (日值)
        decals: () => {}, shadows: () => {},    // (baked into the ground chunks)
        propsLow: () => this.drawObjects('low'),
        routes: () => { if (!opts.showRoutes) return; g.save(); g.setLineDash([4, 5]); g.strokeStyle = 'rgba(255,236,190,0.45)'; g.lineWidth = 1; for (const [a, b] of this.obstacles.routes) { const p = worldToScreen(cam, a.x, a.y), q = worldToScreen(cam, b.x, b.y); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); } g.restore(); },
        antShadows: () => {
          if (ext) { ext.draw('antShadows', this.draws, info()); return; }
          if (!Q.antShadows || this.light.intensity <= 0) return;
          if (this.draws.length <= CROWD) { for (const d of this.draws) if (!rotBlit(d, 'shadow')) drawAntSprite(g, atlas, this.dpr, d.sx, d.sy, d.heading, d.gait as Gait, frameOf(d), { part: 'shadow' }); return; }
          // crowd LOD: one batched path of soft body-shadow ellipses instead of one sprite per ant
          const o = this.light.shadow, h = L * 0.05; g.beginPath();
          for (const d of this.draws) g.ellipse(d.sx + o.x * h, d.sy + o.y * h, L * 0.42, L * 0.12, d.heading, 0, Math.PI * 2);
          g.fillStyle = 'rgba(24,14,6,0.28)'; g.fill();
        },
        ants: () => {
          if (ext) {
            ext.draw('ants', this.draws, info());
            // the layers above the ants go to the overlay context (cleared each frame), so the stacking order is kept
            g = ext.above; this.tg = g; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, g.canvas.width, g.canvas.height); g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); return;
          }
          for (const d of this.draws) {
            if (rotBlit(d, 'body')) continue;
            drawAntSprite(g, this.atlasFor(L, variantOf(d.id)), this.dpr, d.sx, d.sy, d.heading, d.gait as Gait, frameOf(d), { part: 'body', glints: false }); this.antStats.rotated++;
            if (rec) this.blits.push({ id: d.id, ax: d.sx, ay: d.sy, heading: d.heading, bucket: -1, n: 0 });
          }
          if (Q.glints) this.drawGlints(atlas.scale / this.dpr);
        },
        propsHigh: () => { this.blitChunks('high'); this.drawObjects('high'); },
        lighting: () => g.drawImage(this.overlayFor(cam.w, cam.h), 0, 0, cam.w, cam.h), // light grade + vignette (+ overcast day state, baked together)
        weather: () => {},                                                           // wet ground: tint in the ground layer; overcast: in the overlay
        ui: () => {
          const n = magnification(L, cam.s); // drawn length ÷ (2.5 mm × px per mm)
          if (n > 1.05) { const t = `螞蟻放大顯示 ×${n.toFixed(1)}`, yb = cam.h - (opts.uiBottom ?? 0); g.font = '12px system-ui'; const w = g.measureText(t).width + 12; g.fillStyle = 'rgba(20,12,6,0.7)'; g.fillRect(8, yb - 28, w, 20); g.fillStyle = '#f6e7cf'; g.fillText(t, 14, yb - 14); }
          if (opts.highlightEngine || opts.labels) for (const o of this.registry) {
            const [x, y] = worldToScreen(cam, o.x, o.y), r = Math.max(10, o.radiusCm * 1.6 * cam.s);
            if (opts.highlightEngine) { g.strokeStyle = 'rgba(255,224,138,0.85)'; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
            if (opts.labels) { g.font = '12px system-ui'; g.fillStyle = '#fff6dc'; g.fillText(o.id, x + r + 3, y - 3); }
          }
        },
      };
      for (const layer of LAYERS) { const t0 = performance.now(); draw[layer](); const ms = performance.now() - t0; this.stats.lastMs[layer] = ms; this.stats.layerMs[layer] = (this.stats.layerMs[layer] ?? 0) * 0.95 + ms * 0.05; this.trace.push(layer); }
    });
    this.stats.chunks = this.chunks.size; this.bakedLast = this.stats.bakedThisFrame > 0 || this.spritesBaked > 0; this.spritesBaked = 0;
    return this.draws;
  }
}

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
 */
import { LAYERS, QUALITY, DECOR_CELL_CM, antLengthPx, decorCell, engineRegistry, keepAtLod, nextQuality, planAnts, weatherState, worldToScreen, type AntDraw, type AntInput, type AntLook, type Camera, type DecorItem, type EngineObject, type Layer, type Obstacles, type WeatherState } from './render-scene.ts';
import { bakeAntAtlas, drawAntSprite, drawList, pixelsToCanvas, type AntAtlas } from './art-raster.ts';
import { antGlintSpots, magnification, walkCycles, walkFrame, framesOf, type Gait } from './art-ant.ts';
import { SCHEMATIC_LIGHT, withLight, type LightState } from './art-core.ts';
import { soilTile, soilMacroTile, leaf, twig, pebble, grassTuft, moss, debris, type Decal } from './art-ground.ts';
import { nestEntrance, hostPlant, flower, insectCarcass } from './art-props.ts';
import { wetDarken } from './art-fx.ts';
import type { Place } from './model.ts';

type Pos = Record<string, { x: number; y: number; known: boolean }>;
type Sources = Record<string, { host_alive: boolean | null; hemipteran_colonies: number | null }>;
export interface SceneInput { seed: number; places: readonly Place[]; pos: Pos; routes: Obstacles['routes']; sources: Sources; weather: Parameters<typeof weatherState>[0]; light?: LightState }
export interface FrameOptions { showRoutes?: boolean; highlightEngine?: boolean; labels?: boolean }
const CROWD = 300, CHUNK_PX = 256, SOIL_TILE_MM = 80, SOIL_TILE_PX = 512, MACRO_CM = 36, MAX_CHUNKS = 120, MAX_ITEM_CM = 4, MIN_ITEM_DEVICE_PX = 2.5;
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
  private macro: HTMLCanvasElement | null = null;
  private atlas: { key: string; a: AntAtlas } | null = null;
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

  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; this.g = ctxOf(canvas); }

  /** New world: places, recorded routes, engine state and weather. Clears every cache. */
  setScene(s: SceneInput) {
    this.scene = s; this.light = s.light ?? SCHEMATIC_LIGHT; this.chunks.clear(); this.objSprites.clear(); this.look.clear(); this.cells.clear();
    this.setEngineState(s.sources, s.weather);
    this.obstacles = { places: this.registry.map((o) => ({ x: o.x, y: o.y, radiusCm: o.radiusCm })), routes: s.routes }; this.cells.clear();
  }
  /** Per-day engine state (food-source state, daily weather). Only engine-object sprites / wet chunks are rebuilt. */
  setEngineState(sources: Sources, weather: SceneInput['weather']) {
    if (!this.scene) return;
    this.registry = engineRegistry(this.scene.places, this.scene.pos, sources);
    const w = weatherState(weather); // chunk keys include the wet state, so both variants stay cached
    this.weather = w;
  }
  engineObjects(): readonly EngineObject[] { return this.registry; }
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
  private bucket(s: number) { return Math.min(128, Math.max(1, 2 ** Math.round(Math.log2(s * this.dpr)))); }
  private soilTileAt(px: number): HTMLCanvasElement {
    const k = `${this.scene?.seed}|${this.weather.wet}|${this.light.label}|${px}`; let t = this.tiles.get(k); if (t) return t;
    const sk = `${this.weather.wet}|${this.light.label}`; let src = this.soilSrc.get(sk);
    if (!src) { src = pixelsToCanvas(soilTile({ size: SOIL_TILE_PX, seed: (this.scene?.seed ?? 1) ^ 0x50f1, wet: this.weather.wet, light: this.light, flatten: 0.85 }), SOIL_TILE_PX, SOIL_TILE_PX); this.soilSrc.set(sk, src); }
    t = resampleTile(src, px);
    this.tiles.set(k, t); return t;
  }
  private macroAt(px: number): HTMLCanvasElement {
    const k = `macro|${px}`; let t = this.tiles.get(k); if (t) return t;
    this.macro ??= pixelsToCanvas(soilMacroTile((this.scene?.seed ?? 1) ^ 0x3ac0), 128, 128);
    t = resampleTile(this.macro, px); this.tiles.set(k, t); return t;
  }
  private decalOf(it: DecorItem, xm: number, ym: number): Decal {
    switch (it.kind) {
      case 'leaf': return leaf(it.seed, it.leafKind ?? 'ovate', xm, ym, it.rot, it.sizeMm);
      case 'twig': return twig(it.seed, xm, ym, it.rot, it.sizeMm);
      case 'pebble': return pebble(it.seed, xm, ym, it.sizeMm);
      case 'grass': return grassTuft(it.seed, xm, ym, it.sizeMm, it.dry ?? 0);
      case 'moss': return moss(it.seed, xm, ym, it.sizeMm);
      default: return debris(it.seed, xm, ym, it.sizeMm, 14);
    }
  }
  private bakeChunk(bucket: number, i: number, j: number) {
    const s = this.scene as SceneInput, cm = CHUNK_PX / bucket, x0 = i * cm, y0 = j * cm, y1 = y0 + cm, lod = QUALITY[this.q].decorLod;
    const low = mk(CHUNK_PX, CHUNK_PX), g = ctxOf(low);
    withLight(this.light, () => {
      // ground: soil tile anchored at the world origin (continuous across chunks) + large-scale tint
      const tp = SOIL_TILE_MM / 10 * bucket, pat = g.createPattern(this.soilTileAt(tp), 'repeat') as CanvasPattern;
      pat.setTransform(new DOMMatrix([tp / Math.round(tp), 0, 0, tp / Math.round(tp), -x0 * bucket, y1 * bucket])); g.fillStyle = pat; g.fillRect(0, 0, CHUNK_PX, CHUNK_PX);
      const mp = Math.min(2048, MACRO_CM * bucket), mpat = g.createPattern(this.macroAt(mp), 'repeat') as CanvasPattern;
      mpat.setTransform(new DOMMatrix([1, 0, 0, 1, -x0 * bucket, y1 * bucket])); g.save(); g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.75; g.fillStyle = mpat; g.fillRect(0, 0, CHUNK_PX, CHUNK_PX); g.restore();
      // décor of all cells that can overlap this chunk, in mm relative to the chunk's top-left corner
      const items: DecorItem[] = [], c0 = Math.floor((x0 - MAX_ITEM_CM) / DECOR_CELL_CM), c1 = Math.floor((x0 + cm + MAX_ITEM_CM) / DECOR_CELL_CM), r0 = Math.floor((y0 - MAX_ITEM_CM) / DECOR_CELL_CM), r1 = Math.floor((y1 + MAX_ITEM_CM) / DECOR_CELL_CM);
      for (let ci = c0; ci <= c1; ci++) for (let cj = r0; cj <= r1; cj++) for (const it of this.cell(s.seed, ci, cj)) if (keepAtLod(it, lod) && (it.sizeMm / 10) * bucket >= MIN_ITEM_DEVICE_PX) items.push(it); // zoom LOD: skip items under ~2.5 device px
      const decals = items.map((it) => ({ it, d: this.decalOf(it, (it.x - x0) * 10, (y1 - it.y) * 10) }));
      const flat = decals.filter((x) => x.it.kind !== 'pebble' && x.it.kind !== 'grass'), raised = decals.filter((x) => x.it.kind === 'pebble' || x.it.kind === 'grass');
      const k = bucket / 10; g.save(); g.scale(k, k);
      for (const { d } of flat) drawList(g, d.shadow, k); for (const { d } of flat) drawList(g, d.body, k);   // decals
      for (const { d } of raised) drawList(g, d.shadow, k);                                                  // contact / cast shadows
      for (const { d } of raised) drawList(g, d.body, k);                                                    // low props
      g.restore();
      if (this.weather.wet) drawList(g, [wetDarken(CHUNK_PX, CHUNK_PX)], 1);
      let high: HTMLCanvasElement | null = null;
      const hi = decals.filter((x) => x.d.high?.length);
      if (hi.length) { high = mk(CHUNK_PX, CHUNK_PX); const h = ctxOf(high); h.scale(k, k); for (const { d } of hi) drawList(h, d.highShadow ?? [], k); for (const { d } of hi) drawList(h, d.high ?? [], k); }
      this.chunks.set(this.chunkKey(bucket, i, j), { low, high });
    });
    this.stats.bakes++; this.stats.bakedThisFrame++;
    while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value as string); // LRU (insertion order, refreshed on use)
  }
  private chunkKey(b: number, i: number, j: number) { return `${b}|${i}|${j}|${this.weather.wet}`; } // décor LOD applies to new bakes only (no rebake storm on a quality step)
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
    const b = this.bucket(this.cam.s), cm = CHUNK_PX / b, g = this.g, size = cm * this.cam.s;
    for (const [i, j] of this.visibleChunks(b)) {
      const key = this.chunkKey(b, i, j); let ch = this.chunks.get(key);
      if (!ch && which === 'low' && this.stats.bakedThisFrame < QUALITY[this.q].maxBakesPerFrame) { this.bakeChunk(b, i, j); ch = this.chunks.get(key); }
      const [sx, sy] = worldToScreen(this.cam, i * cm, (j + 1) * cm);
      if (!ch) { if (which === 'low') { this.stats.missing++; g.fillStyle = '#4a3726'; g.fillRect(sx, sy, size + 0.5, size + 0.5); } continue; }
      if (which === 'low') { this.chunks.delete(key); this.chunks.set(key, ch); }
      const img = which === 'low' ? ch.low : ch.high; if (img) g.drawImage(img, sx, sy, size + 0.35, size + 0.35); // +0.35 px hides hairline seams
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
      this.g.drawImage(img, x - half, y - half, half * 2, half * 2); // centred exactly on the engine position
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
    const g = this.g; g.save(); g.globalCompositeOperation = 'screen';
    for (const d of this.draws) {
      const c = Math.cos(d.heading), s = Math.sin(d.heading);
      for (const p of antGlintSpots(d.heading)) { const x = d.sx + (p.x * c - p.y * s) * u, y = d.sy + (p.x * s + p.y * c) * u, r = p.r * u; g.globalAlpha = p.a; g.drawImage(this.glint, x - r, y - r, r * 2, r * 2); }
    }
    g.restore();
  }

  // ------------------------------------------------------------ ants
  private atlasFor(L: number): AntAtlas {
    const Lq = Math.max(8, Math.round((L * this.dpr) / 4) * 4) / this.dpr, key = `${Lq}|${this.dpr}`;
    if (this.atlas?.key !== key) { this.atlas = { key, a: bakeAntAtlas(Lq, this.dpr) }; this.spritesBaked++; }
    return this.atlas.a;
  }

  /** Draw one frame. `ants` are read only. Returns the ant draw records (screen positions) for picking. */
  frame(cam: Camera, ants: readonly AntInput[], dt: number, frameMs: number | null, opts: FrameOptions = {}): readonly AntDraw[] {
    // frames that followed a bake (chunks, object sprites, atlas) are not counted: quality reacts to steady-state cost only
    if (frameMs !== null && !this.bakedLast) { this.frameMs.push(frameMs); if (this.frameMs.length > 240) this.frameMs.shift(); const nq = nextQuality(this.q, this.frameMs); if (nq !== this.q) { this.q = nq; this.frameMs = []; this.resize(); } }
    this.stats.quality = this.q; this.stats.bakedThisFrame = 0; this.stats.missing = 0; this.cam = cam; this.trace = [];
    const tp = performance.now(), g = this.g, Q = QUALITY[this.q], plan = planAnts(cam, ants, this.look, dt, walkCycles);
    this.stats.planMs = this.stats.planMs * 0.95 + (performance.now() - tp) * 0.05;
    this.look = plan.look; this.draws = plan.draws;
    const L = antLengthPx(cam.s), atlas = this.atlasFor(L);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const frameOf = (d: AntDraw) => d.gait === 'idle' ? Math.floor(d.cycles * 4) % framesOf('idle') : walkFrame(d.cycles);
    withLight(this.light, () => {
      const draw: Record<Layer, () => void> = {
        ground: () => this.blitChunks('low'), // baked: soil + decals + their shadows + low props, in that order
        decals: () => {}, shadows: () => {},    // (baked into the ground chunks)
        propsLow: () => this.drawObjects('low'),
        routes: () => { if (!opts.showRoutes) return; g.save(); g.setLineDash([4, 5]); g.strokeStyle = 'rgba(255,236,190,0.45)'; g.lineWidth = 1; for (const [a, b] of this.obstacles.routes) { const p = worldToScreen(cam, a.x, a.y), q = worldToScreen(cam, b.x, b.y); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); } g.restore(); },
        antShadows: () => {
          if (!Q.antShadows || this.light.intensity <= 0) return;
          if (this.draws.length <= CROWD) { for (const d of this.draws) drawAntSprite(g, atlas, this.dpr, d.sx, d.sy, d.heading, d.gait as Gait, frameOf(d), { part: 'shadow' }); return; }
          // crowd LOD: one batched path of soft body-shadow ellipses instead of one sprite per ant
          const o = this.light.shadow, h = L * 0.05; g.beginPath();
          for (const d of this.draws) g.ellipse(d.sx + o.x * h, d.sy + o.y * h, L * 0.42, L * 0.12, d.heading, 0, Math.PI * 2);
          g.fillStyle = 'rgba(24,14,6,0.28)'; g.fill();
        },
        ants: () => { for (const d of this.draws) drawAntSprite(g, atlas, this.dpr, d.sx, d.sy, d.heading, d.gait as Gait, frameOf(d), { part: 'body', glints: false }); if (Q.glints) this.drawGlints(atlas.scale / this.dpr); },
        propsHigh: () => { this.blitChunks('high'); this.drawObjects('high'); },
        lighting: () => g.drawImage(this.overlayFor(cam.w, cam.h), 0, 0, cam.w, cam.h), // light grade + vignette (+ overcast day state, baked together)
        weather: () => {},                                                           // wet ground is baked into the chunks; overcast is in the overlay
        ui: () => {
          const n = magnification(L, cam.s); // drawn length ÷ (2.5 mm × px per mm)
          if (n > 1.05) { const t = `螞蟻放大顯示 ×${n.toFixed(1)}`; g.font = '12px system-ui'; const w = g.measureText(t).width + 12; g.fillStyle = 'rgba(20,12,6,0.7)'; g.fillRect(8, cam.h - 28, w, 20); g.fillStyle = '#f6e7cf'; g.fillText(t, 14, cam.h - 14); }
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

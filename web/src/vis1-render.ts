/**
 * VIS-1 garden renderer (browser, Canvas 2D) for the P0-A2 experiment world. DRAWING ONLY: it receives the display
 * poses (vis1-model.ts, computed from the Worker frame) and never reads or changes the simulation, writes nothing and
 * creates no events.
 * Layer order (same names as the V6 layered renderer, render-scene LAYERS):
 *   ground → decals → shadows → propsLow → routes → antShadows → ants → propsHigh → lighting → weather → ui
 *  - ground…propsLow are BAKED per chunk (256 CSS px, zoom bucketed to powers of two, DPR-aware, LRU-capped, a
 *    per-frame bake budget; while a chunk is missing a coarser cached chunk is drawn scaled). Soil colour and grain,
 *    gravel, stones, litter, twigs, grass, clover and moss are DECORATION (裝飾, vis1-garden.ts); the nest entrance
 *    and the host stem with its aphid cluster mark ENGINE objects (the nest and the honeydew source exist in the
 *    model; their look is 示意).
 *  - ants: articulated vector ants (art-ant / art-raster drawAntDetail: head, mesosoma with propodeal spines,
 *    petiole, postpetiole, gaster, six legs in an alternating tripod, 12-segment antennae). Gait phase advances with
 *    the displayed ground distance (vis1-path gaitAdvance); heading eases toward the path tangent; antennae move by a
 *    display animation. Far-out zoom levels draw a simplified ant (same proportions).
 *  - lighting: the engine light state (day / twilight / night) as a colour grade; shadow direction is 示意.
 *  - weather: nothing (rain is not simulated in P0-A2).
 */
import { LAYERS, worldToScreen, type Camera, type Layer } from './render-scene.ts';
import { drawAntDetail } from './art-raster.ts';
import { antPalette, PALETTE_VARIANTS, type MicroPose, type Gait } from './art-ant.ts';
import { withLight, type LightState } from './art-core.ts';
import { h01 } from './art-core.ts';
import { hash32 } from './game-model.ts';
import { Garden, fbm, fields, type Decor } from './vis1-garden.ts';
import { ART_STRIDE_SCALE, gaitAdvance, type Polyline } from './vis1-path.ts';
import type { VisModel, VisPose } from './vis1-model.ts';

export const MINOR_LEN_CM = 0.25;
const CHUNK = 256, MAX_CHUNKS = 140, TAU = Math.PI * 2;
const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
const ctxOf = (c: HTMLCanvasElement) => c.getContext('2d') as CanvasRenderingContext2D;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c: number[], a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
/** small deterministic rng */
function rnd(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export interface AntDrawRec { id: string; sx: number; sy: number; ex: number; ey: number; heading: number; lenPx: number; gait: Gait; phase: number; walkW: number; capped: boolean }
interface Look { phase: number; dist: number; path: string | null; h: number; w: number; capped: boolean; amp: number }
export interface GardenFrameOpts { minAntPx: number; selected: string | null; following: string | null; running: boolean; showIds: boolean; selectedPath: Polyline | null }

export class GardenRenderer {
  readonly g: CanvasRenderingContext2D;
  trace: Layer[] = [];
  stats = { bakes: 0, bakeMs: 0, frameMs: [] as number[], missing: 0, lastBakeMs: 0 };
  private chunks = new Map<string, HTMLCanvasElement>();
  private model: VisModel | null = null;
  private garden: Garden | null = null;
  private light: LightState | null = null;
  private night = 0;
  private decor = true;
  private dpr = 1;
  private dprCap = 2;
  private q = 0;
  private cam: Camera = { cx: 0, cy: 0, s: 4, w: 1, h: 1 };
  private looks = new Map<string, Look>();
  private draws: AntDrawRec[] = [];
  private grain: HTMLCanvasElement | null = null;
  private vig: { key: string; c: HTMLCanvasElement } | null = null;
  private tau = 0;
  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; this.g = ctxOf(canvas); }

  setWorld(model: VisModel, light: LightState, night: number, decor: boolean) {
    const same = this.model === model && this.light?.label === light.label && this.decor === decor;
    this.model = model; this.light = light; this.night = night; this.decor = decor;
    if (!this.garden || this.garden.C !== model.corridor) this.garden = new Garden(hash32(`garden|${model.worldSeed}`) >>> 0, model.corridor);
    if (!same) this.chunks.clear();
  }
  resetMotion() { this.looks.clear(); }
  resize() {
    this.dpr = Math.min(this.dprCap, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
    this.chunks.clear(); this.vig = null;
  }
  quality() { return { level: this.q, dpr: this.dpr }; }
  lastDraws(): readonly AntDrawRec[] { return this.draws; }
  /** drawn ant length (CSS px): the true 2.5 mm at this zoom, magnified to at least minPx (labelled ×N) */
  static antLenPx(s: number, minPx: number) { return Math.max(minPx, MINOR_LEN_CM * s); }

  // ------------------------------------------------------------------ chunks
  private bucket(s: number) { return Math.pow(2, Math.round(Math.log2(Math.max(0.5, s)))); }
  private key(b: number, i: number, j: number) { return `${b}|${i}|${j}`; }
  /** bake visible chunks for a camera now (no budget): used before the first frame */
  warm(cam: Camera) { this.cam = cam; const b = this.bucket(cam.s); for (const [i, j] of this.visible(b)) if (!this.chunks.has(this.key(b, i, j))) this.bake(b, i, j); }
  private visible(b: number): [number, number][] {
    const c = this.cam, cm = CHUNK / b, x0 = c.cx - c.w / 2 / c.s, x1 = c.cx + c.w / 2 / c.s, y0 = c.cy - c.h / 2 / c.s, y1 = c.cy + c.h / 2 / c.s, out: [number, number][] = [];
    const ci = (c.cx / cm), cj = (c.cy / cm);
    for (let i = Math.floor(x0 / cm); i <= Math.floor(x1 / cm); i++) for (let j = Math.floor(y0 / cm); j <= Math.floor(y1 / cm); j++) out.push([i, j]);
    return out.sort((a, b2) => Math.hypot(a[0] + 0.5 - ci, a[1] + 0.5 - cj) - Math.hypot(b2[0] + 0.5 - ci, b2[1] + 0.5 - cj));
  }
  private grainTile(): HTMLCanvasElement {
    if (this.grain) return this.grain;
    const n = 128, c = mk(n, n), g = ctxOf(c), img = g.createImageData(n, n), r = rnd(91);
    for (let i = 0; i < n * n; i++) { const v = r(), k = i * 4, l = v < 0.5 ? 0 : 255; img.data[k] = l; img.data[k + 1] = l * 0.95; img.data[k + 2] = l * 0.85; img.data[k + 3] = Math.abs(v - 0.5) * 2 > 0.82 ? 120 : Math.abs(v - 0.5) * 70; }
    g.putImageData(img, 0, 0); this.grain = c; return c;
  }
  private bake(b: number, i: number, j: number): HTMLCanvasElement {
    const t0 = performance.now(), cm = CHUNK / b, dpr = this.dpr, px = Math.round(CHUNK * dpr), c = mk(px, px), g = ctxOf(c);
    const x0 = i * cm, y0 = j * cm, x1 = x0 + cm, y1 = y0 + cm, k = b * dpr, G = this.garden!, seed = G.seed, L = this.light!;
    // 1. soil colour field (decoration): (N+1)² samples on the chunk edges → bilinear upscale (continuous across chunks)
    const N = 16, img = new ImageData(N + 1, N + 1), shade = new ImageData(N + 1, N + 1);
    const dry = [128, 101, 74], damp = [78, 58, 42], humus = [64, 46, 33], pale = [150, 124, 92];
    for (let v = 0; v <= N; v++) for (let u = 0; u <= N; u++) {
      const wx = x0 + (u / N) * cm, wy = y1 - (v / N) * cm, F = fields(seed, wx, wy), fine = (fbm(seed + 3, wx, wy, 0.9, 3) - 0.5) * 0.22 + (fbm(seed + 5, wx, wy, 0.12, 2) - 0.5) * 0.12;
      let col = mix(dry, damp, clamp((F.moist - 0.35) * 1.8, 0, 1));
      col = mix(col, humus, clamp((F.litter - 0.5) * 1.6, 0, 0.7));
      col = mix(col, pale, clamp((F.soil - 0.55) * 1.4, 0, 0.45));
      const q = (v * (N + 1) + u) * 4, f = 1 + (F.soil - 0.5) * 0.18 + fine;
      img.data[q] = col[0] * f; img.data[q + 1] = col[1] * f; img.data[q + 2] = col[2] * f; img.data[q + 3] = 255;
      shade.data[q] = 18; shade.data[q + 1] = 22; shade.data[q + 2] = 30; shade.data[q + 3] = clamp((F.shade - 0.42) * 2.4, 0, 1) * 120 * (L.intensity > 0 ? 1 : 0.3);
    }
    const tmp = mk(N + 1, N + 1); ctxOf(tmp).putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(tmp, 0.5, 0.5, N, N, 0, 0, px, px);
    // 2. fine grain (decoration): a speckle pattern, then individual soil crumbs / sand grains when they reach ≥ 1.3 px
    g.globalAlpha = 0.2; g.globalCompositeOperation = 'overlay'; g.fillStyle = g.createPattern(this.grainTile(), 'repeat')!; g.fillRect(0, 0, px, px);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.setTransform(k, 0, 0, -k, -x0 * k, y1 * k); // world cm → chunk device px (y north up)
    this.grains(g, x0, y0, x1, y1, b, seed);
    // 3. decoration items (above the soil), then the engine-object marks (nest entrance, host stem)
    if (this.decor) for (const it of G.itemsIn(x0, y0, x1, y1, b)) this.item(g, it, k, L);
    this.nest(g, k, L, b);
    this.hostPlant(g, k, L, b);
    // 4. canopy shade (decoration; dappled light), drawn over everything baked
    g.setTransform(1, 0, 0, 1, 0, 0);
    const st = mk(N + 1, N + 1); ctxOf(st).putImageData(shade, 0, 0);
    if (this.decor) g.drawImage(st, 0.5, 0.5, N, N, 0, 0, px, px);
    this.chunks.set(this.key(b, i, j), c);
    if (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    this.stats.bakes++; this.stats.lastBakeMs = performance.now() - t0; this.stats.bakeMs += this.stats.lastBakeMs;
    return c;
  }
  /** soil crumbs and sand grains (decoration): world-cell placement so chunks agree at their edges */
  private grains(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, b: number, seed: number) {
    const CLS = [{ r: 0.018, cell: 0.2, n: 4 }, { r: 0.035, cell: 0.4, n: 3 }, { r: 0.07, cell: 0.8, n: 2 }, { r: 0.13, cell: 1.6, n: 1 }];
    CLS.forEach((C, ci) => {
      if (C.r * 2 * b < 1.3) return;
      const nCells = ((x1 - x0) / C.cell + 2) * ((y1 - y0) / C.cell + 2); if (nCells * C.n > 9000) return;
      const big = C.r * 2 * b >= 5;
      for (let i = Math.floor((x0 - C.r) / C.cell); i <= Math.floor((x1 + C.r) / C.cell); i++) for (let j = Math.floor((y0 - C.r) / C.cell); j <= Math.floor((y1 + C.r) / C.cell); j++) {
        const s = seed + ci * 131;
        for (let q = 0; q < C.n; q++) {
          const x = (i + h01(s, i, j, q * 4 + 1)) * C.cell, y = (j + h01(s, i, j, q * 4 + 2)) * C.cell, u = h01(s, i, j, q * 4 + 3), r = C.r * (0.5 + u);
          const tone = h01(s, i, j, q * 4 + 4), quartz = tone > 0.93, dark = tone < 0.3;
          const base = quartz ? [214, 204, 186] : dark ? [72, 54, 40] : tone > 0.7 ? [168, 138, 104] : [122, 96, 70];
          if (!big) { g.fillStyle = rgb(base, 0.85); g.beginPath(); g.ellipse(x, y, r, r * 0.8, u * 3, 0, TAU); g.fill(); continue; }
          // crumb with a contact shadow and a lit top (decoration)
          g.fillStyle = 'rgba(30,20,12,0.22)'; g.beginPath(); g.ellipse(x + r * 0.18, y - r * 0.22, r * 1.02, r * 0.8, u * 3, 0, TAU); g.fill();
          const gr = g.createLinearGradient(x - r, y + r, x + r, y - r);
          gr.addColorStop(0, rgb(mix(base, [250, 240, 220], quartz ? 0.4 : 0.18))); gr.addColorStop(1, rgb(mix(base, [30, 20, 10], 0.25)));
          g.fillStyle = gr; g.beginPath(); this.blob(g, x, y, r, r * (0.55 + u * 0.4), u * 6, 6, s + i * 7 + j * 13 + q, 0.32); g.fill();
        }
      }
    });
  }
  /** closed irregular blob (quadratic curves through jittered vertices) */
  private blob(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot: number, n: number, seed: number, jit = 0.16) {
    const r = rnd(seed), pts: [number, number][] = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU, f = 1 + (r() - 0.5) * 2 * jit, px = Math.cos(a) * rx * f, py = Math.sin(a) * ry * f; pts.push([x + px * Math.cos(rot) - py * Math.sin(rot), y + px * Math.sin(rot) + py * Math.cos(rot)]); }
    const mid = (a: [number, number], b2: [number, number]) => [(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2];
    const m0 = mid(pts[n - 1], pts[0]); g.moveTo(m0[0], m0[1]);
    for (let i = 0; i < n; i++) { const p = pts[i], m = mid(p, pts[(i + 1) % n]); g.quadraticCurveTo(p[0], p[1], m[0], m[1]); }
    g.closePath();
  }
  /** cast shadow offset in WORLD cm for an object of height h (cm): screen shadow vector, y flipped */
  private sh(L: LightState, h: number) { return { x: L.shadow.x * h, y: -L.shadow.y * h }; }
  private soft(g: CanvasRenderingContext2D, k: number, blurCm: number, col: string) { g.shadowColor = col; g.shadowBlur = Math.min(60, Math.max(0, blurCm * k)); g.shadowOffsetX = 0; g.shadowOffsetY = 0; }
  private noSoft(g: CanvasRenderingContext2D) { g.shadowColor = 'transparent'; g.shadowBlur = 0; }

  private item(g: CanvasRenderingContext2D, it: Decor, k: number, L: LightState) {
    const r = rnd(it.seed), day = L.intensity > 0;
    switch (it.kind) {
      case 'stone': case 'pebble': {
        const stone = it.kind === 'stone', el = 0.55 + 0.4 * r(), h = it.r * (stone ? 0.45 : 0.4), n = stone ? 13 : 9, jit = stone ? 0.22 : 0.26;
        const pal = [[141, 135, 125], [138, 110, 84], [96, 90, 84], [179, 168, 148], [112, 98, 82]][Math.floor(it.tone * 5)];
        // ambient occlusion ring and cast shadow (示意 direction)
        g.fillStyle = 'rgba(25,16,8,0.32)'; this.soft(g, k, it.r * 0.35, 'rgba(25,16,8,0.45)'); g.beginPath(); this.blob(g, it.x, it.y, it.r * 1.06, it.r * el * 1.06, it.rot, n, it.seed, jit); g.fill();
        if (day) { const o = this.sh(L, h); g.fillStyle = 'rgba(20,12,6,0.42)'; this.soft(g, k, it.r * 0.5, 'rgba(20,12,6,0.4)'); g.beginPath(); this.blob(g, it.x + o.x * 0.8, it.y + o.y * 0.8, it.r, it.r * el, it.rot, n, it.seed, jit); g.fill(); }
        this.noSoft(g);
        const lx = -L.dir.x, ly = L.dir.y, gr = g.createRadialGradient(it.x + lx * it.r * 0.4, it.y + ly * it.r * 0.4, it.r * 0.05, it.x, it.y, it.r * 1.15);
        gr.addColorStop(0, rgb(mix(pal, [250, 246, 236], 0.22))); gr.addColorStop(0.6, rgb(pal)); gr.addColorStop(1, rgb(mix(pal, [36, 30, 24], 0.4)));
        g.fillStyle = gr; g.beginPath(); this.blob(g, it.x, it.y, it.r, it.r * el, it.rot, n, it.seed, jit); g.fill();
        if (it.r * k > 6) { // speckles, mottling and lichen (decoration)
          
          g.save(); g.beginPath(); this.blob(g, it.x, it.y, it.r * 0.98, it.r * el * 0.98, it.rot, n, it.seed, jit); g.clip();
          for (let q = 0; q < (stone ? 7 : 3); q++) { const a = r() * TAU, d = r() * it.r * 0.7; g.fillStyle = r() < 0.5 ? 'rgba(255,250,240,0.10)' : 'rgba(30,25,20,0.12)'; g.beginPath(); this.blob(g, it.x + Math.cos(a) * d, it.y + Math.sin(a) * d * el, it.r * (0.2 + r() * 0.3), it.r * (0.15 + r() * 0.2), r() * 3, 8, it.seed + 99 + q, 0.35); g.fill(); }
          for (let q = 0; q < (stone ? 60 : 14); q++) { const a = r() * TAU, d = Math.sqrt(r()) * it.r, s = it.r * (0.01 + r() * 0.03); g.fillStyle = r() < 0.5 ? 'rgba(255,250,240,0.35)' : 'rgba(30,25,20,0.35)'; g.beginPath(); g.arc(it.x + Math.cos(a) * d, it.y + Math.sin(a) * d * el, s, 0, TAU); g.fill(); }
          if (stone && it.tone > 0.45) for (let q = 0; q < 3; q++) { const a = r() * TAU, d = r() * it.r * 0.6; g.fillStyle = `rgba(${170 + r() * 30},${180 + r() * 20},${140 + r() * 30},0.45)`; g.beginPath(); this.blob(g, it.x + Math.cos(a) * d, it.y + Math.sin(a) * d * el, it.r * (0.12 + r() * 0.15), it.r * (0.1 + r() * 0.12), r() * 3, 9, it.seed + q, 0.3); g.fill(); }
          g.restore();
        }
        return;
      }
      case 'leaf': {
        const len = it.r * 2, wid = len * (0.22 + r() * 0.2), dry = it.tone < 0.82;
        const pal = dry ? [[139, 90, 43], [160, 112, 60], [107, 68, 38], [184, 137, 63], [122, 90, 42], [92, 64, 40]][Math.floor(r() * 6)] : [[120, 128, 58], [96, 116, 52]][Math.floor(r() * 2)];
        const ca = Math.cos(it.rot), sa = Math.sin(it.rot), P = (u: number, v: number): [number, number] => [it.x + (u * ca - v * sa), it.y + (u * sa + v * ca)];
        const outline = () => { const a = P(-len / 2, 0), b2 = P(len / 2, 0), c1 = P(-len * 0.1, wid), c2 = P(-len * 0.1, -wid); g.moveTo(a[0], a[1]); g.quadraticCurveTo(c1[0], c1[1], b2[0], b2[1]); g.quadraticCurveTo(c2[0], c2[1], a[0], a[1]); g.closePath(); };
        if (day) { const o = this.sh(L, 0.12); g.fillStyle = 'rgba(20,12,6,0.3)'; this.soft(g, k, 0.12, 'rgba(20,12,6,0.35)'); g.save(); g.translate(o.x, o.y); g.beginPath(); outline(); g.fill(); g.restore(); this.noSoft(g); }
        const a = P(-len / 2, 0), b2 = P(len / 2, 0), gr = g.createLinearGradient(a[0], a[1], b2[0], b2[1]);
        gr.addColorStop(0, rgb(mix(pal, [40, 25, 12], 0.25))); gr.addColorStop(0.5, rgb(pal)); gr.addColorStop(1, rgb(mix(pal, [230, 200, 150], 0.2)));
        g.fillStyle = gr; g.beginPath(); outline(); g.fill();
        if (len * k > 14) {
          g.strokeStyle = rgb(mix(pal, [40, 26, 14], 0.45), 0.8); g.lineWidth = Math.max(0.6 / k, len * 0.018); g.beginPath(); const s0 = P(-len / 2 - len * 0.08, 0); g.moveTo(s0[0], s0[1]); g.lineTo(b2[0], b2[1]); g.stroke();
          g.lineWidth = Math.max(0.4 / k, len * 0.008); g.strokeStyle = rgb(mix(pal, [40, 26, 14], 0.3), 0.55);
          for (let q = 1; q < 7; q++) { const u = -len / 2 + (q / 7) * len, w2 = wid * Math.sin((q / 7) * Math.PI) * 0.75; for (const sd of [-1, 1]) { const m = P(u, 0), e = P(u + len * 0.1, sd * w2); g.beginPath(); g.moveTo(m[0], m[1]); g.lineTo(e[0], e[1]); g.stroke(); } }
          if (dry && r() < 0.35) for (let q = 0; q < 3; q++) { const c = P((r() - 0.5) * len * 0.6, (r() - 0.5) * wid * 0.6); g.fillStyle = 'rgba(60,40,24,0.55)'; g.beginPath(); g.ellipse(c[0], c[1], len * 0.03 + r() * len * 0.03, len * 0.025, r() * 3, 0, TAU); g.fill(); }
        }
        return;
      }
      case 'twig': {
        const len = it.r * 2, wd = 0.12 + it.tone * 0.22, pts: [number, number][] = [];
        for (let q = 0; q <= 6; q++) { const u = q / 6 - 0.5, bend = Math.sin(u * 3 + it.tone * 5) * len * 0.04; pts.push([it.x + Math.cos(it.rot) * u * len - Math.sin(it.rot) * bend, it.y + Math.sin(it.rot) * u * len + Math.cos(it.rot) * bend]); }
        const stroke = (w: number, col: string, dx = 0, dy = 0) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(pts[0][0] + dx, pts[0][1] + dy); for (const p of pts.slice(1)) g.lineTo(p[0] + dx, p[1] + dy); g.stroke(); };
        if (day) { const o = this.sh(L, wd * 1.2); this.soft(g, k, wd, 'rgba(15,10,5,0.4)'); stroke(wd, 'rgba(15,10,5,0.35)', o.x, o.y); this.noSoft(g); }
        stroke(wd, '#4a3424'); stroke(wd * 0.55, '#6e533b', -L.dir.x * wd * 0.15, L.dir.y * wd * 0.15); stroke(wd * 0.15, 'rgba(190,160,120,0.35)', -L.dir.x * wd * 0.25, L.dir.y * wd * 0.25);
        const m = pts[3], ba = it.rot + (r() < 0.5 ? 0.6 : -0.6); g.strokeStyle = '#4f392a'; g.lineWidth = wd * 0.5; g.beginPath(); g.moveTo(m[0], m[1]); g.lineTo(m[0] + Math.cos(ba) * len * 0.22, m[1] + Math.sin(ba) * len * 0.22); g.stroke();
        return;
      }
      case 'grass': {
        const n = 10 + Math.floor(r() * 18), blades: { a: number; l: number; w: number; bend: number; c: number[] }[] = [];
        for (let q = 0; q < n; q++) blades.push({ a: r() * TAU, l: it.r * (0.45 + r() * 0.55), w: it.r * (0.035 + r() * 0.03), bend: (r() - 0.5) * 0.8, c: mix([62, 98, 40], [150, 160, 74], r() * (0.4 + it.tone * 0.6)) });
        const blade = (bl: typeof blades[number], dx: number, dy: number, col: string | null) => {
          const ex = it.x + dx + Math.cos(bl.a) * bl.l, ey = it.y + dy + Math.sin(bl.a) * bl.l, cx = it.x + dx + Math.cos(bl.a + bl.bend) * bl.l * 0.55, cy = it.y + dy + Math.sin(bl.a + bl.bend) * bl.l * 0.55;
          const nx = -Math.sin(bl.a) * bl.w, ny = Math.cos(bl.a) * bl.w;
          g.beginPath(); g.moveTo(it.x + dx + nx, it.y + dy + ny); g.quadraticCurveTo(cx + nx * 0.6, cy + ny * 0.6, ex, ey); g.quadraticCurveTo(cx - nx * 0.6, cy - ny * 0.6, it.x + dx - nx, it.y + dy - ny); g.closePath();
          if (col) { g.fillStyle = col; g.fill(); return; }
          const gr = g.createLinearGradient(it.x, it.y, ex, ey); gr.addColorStop(0, rgb(mix(bl.c, [20, 30, 10], 0.5))); gr.addColorStop(1, rgb(mix(bl.c, [230, 230, 160], 0.25))); g.fillStyle = gr; g.fill();
        };
        if (day) { const o = this.sh(L, it.r * 0.5); this.soft(g, k, it.r * 0.12, 'rgba(15,20,8,0.35)'); for (const bl of blades) blade(bl, o.x * (bl.l / it.r), o.y * (bl.l / it.r), 'rgba(15,20,8,0.22)'); this.noSoft(g); }
        g.fillStyle = 'rgba(30,24,12,0.5)'; g.beginPath(); g.arc(it.x, it.y, it.r * 0.12, 0, TAU); g.fill();
        for (const bl of blades.sort((a, b2) => a.l - b2.l)) blade(bl, 0, 0, null);
        return;
      }
      case 'clover': {
        const n = 4 + Math.floor(r() * 5), base = mix([58, 98, 44], [96, 128, 54], it.tone);
        if (day) { const o = this.sh(L, it.r * 0.35); g.fillStyle = 'rgba(15,20,8,0.3)'; this.soft(g, k, it.r * 0.15, 'rgba(15,20,8,0.35)'); g.beginPath(); g.arc(it.x + o.x, it.y + o.y, it.r * 0.8, 0, TAU); g.fill(); this.noSoft(g); }
        for (let q = 0; q < n; q++) {
          const a = it.rot + (q / n) * TAU + r() * 0.4, d = it.r * (0.45 + r() * 0.4), lx = it.x + Math.cos(a) * d, ly = it.y + Math.sin(a) * d, ls = it.r * (0.22 + r() * 0.1);
          g.strokeStyle = rgb(mix(base, [40, 50, 20], 0.3)); g.lineWidth = Math.max(0.5 / k, ls * 0.08); g.beginPath(); g.moveTo(it.x, it.y); g.lineTo(lx, ly); g.stroke();
          for (let f = 0; f < 3; f++) { // trifoliate leaflets, heart-shaped, pale chevron
            const fa = a + (f - 1) * (TAU / 3), fx = lx + Math.cos(fa) * ls * 0.55, fy = ly + Math.sin(fa) * ls * 0.55;
            const gr = g.createRadialGradient(fx - L.dir.x * ls * 0.2, fy + L.dir.y * ls * 0.2, ls * 0.05, fx, fy, ls * 0.7); gr.addColorStop(0, rgb(mix(base, [210, 230, 150], 0.35))); gr.addColorStop(1, rgb(mix(base, [20, 40, 15], 0.35)));
            g.fillStyle = gr; g.beginPath(); g.ellipse(fx, fy, ls * 0.55, ls * 0.42, fa, 0, TAU); g.fill();
            if (ls * k > 8) { g.strokeStyle = 'rgba(225,240,190,0.35)'; g.lineWidth = Math.max(0.5 / k, ls * 0.06); g.beginPath(); g.arc(lx + Math.cos(fa) * ls * 0.45, ly + Math.sin(fa) * ls * 0.45, ls * 0.22, fa - 1.2, fa + 1.2); g.stroke(); }
          }
        }
        return;
      }
      case 'moss': {
        const n = Math.min(500, Math.floor(it.r * it.r * 30)), dotR = Math.max(0.6 / k, 0.06);
        for (let q = 0; q < n; q++) { const a = r() * TAU, d = Math.sqrt(r()) * it.r * (0.8 + 0.2 * Math.sin(a * 3 + it.tone * 9)); const c = mix([58, 82, 30], [132, 150, 60], r()); g.fillStyle = rgb(c, 0.75); g.beginPath(); g.arc(it.x + Math.cos(a) * d, it.y + Math.sin(a) * d, dotR * (0.6 + r()), 0, TAU); g.fill(); }
        return;
      }
      case 'seed': {
        const c = mix([150, 118, 70], [205, 180, 130], it.tone);
        if (day) { const o = this.sh(L, it.r); g.fillStyle = 'rgba(20,12,6,0.35)'; g.beginPath(); g.ellipse(it.x + o.x * 0.6, it.y + o.y * 0.6, it.r, it.r * 0.6, it.rot, 0, TAU); g.fill(); }
        const gr = g.createRadialGradient(it.x - L.dir.x * it.r * 0.3, it.y + L.dir.y * it.r * 0.3, 0, it.x, it.y, it.r); gr.addColorStop(0, rgb(mix(c, [255, 250, 230], 0.5))); gr.addColorStop(1, rgb(mix(c, [40, 25, 10], 0.4)));
        g.fillStyle = gr; g.beginPath(); g.ellipse(it.x, it.y, it.r, it.r * 0.6, it.rot, 0, TAU); g.fill();
        return;
      }
    }
  }
  /** nest entrance (ENGINE: the nest exists at the origin; the crater of excavated soil pellets is 示意) */
  private nest(g: CanvasRenderingContext2D, k: number, L: LightState, b: number) {
    const C = this.model!.corridor.nest, r = rnd(4242);
    const ring = g.createRadialGradient(C.x, C.y, 0.2, C.x, C.y, 3.2); ring.addColorStop(0, 'rgba(176,140,98,0.0)'); ring.addColorStop(0.25, 'rgba(176,140,98,0.75)'); ring.addColorStop(0.6, 'rgba(160,126,88,0.45)'); ring.addColorStop(1, 'rgba(160,126,88,0)');
    g.fillStyle = ring; g.beginPath(); g.arc(C.x, C.y, 3.2, 0, TAU); g.fill();
    const pelR = 0.05; // excavated pellets (示意): only where they are visible
    if (pelR * 2 * b >= 1.2) for (let q = 0; q < 650; q++) {
      const a = r() * TAU, d = 0.32 + Math.pow(r(), 1.6) * 2.4, pr = pelR * (0.6 + r() * 0.9), x = C.x + Math.cos(a) * d, y = C.y + Math.sin(a) * d, c = mix([150, 116, 80], [196, 162, 120], r());
      if (L.intensity > 0) { g.fillStyle = 'rgba(30,18,8,0.25)'; g.beginPath(); g.arc(x + L.shadow.x * pr * 0.4, y - L.shadow.y * pr * 0.4, pr, 0, TAU); g.fill(); }
      g.fillStyle = rgb(c); g.beginPath(); this.blob(g, x, y, pr, pr * 0.75, a, 6, q * 31 + 7, 0.3); g.fill();
      if (pr * b >= 4) { g.fillStyle = 'rgba(255,240,215,0.18)'; g.beginPath(); g.arc(x - L.dir.x * pr * 0.3, y + L.dir.y * pr * 0.3, pr * 0.45, 0, TAU); g.fill(); }
    }
    const hole = g.createRadialGradient(C.x, C.y, 0, C.x, C.y, 0.36); hole.addColorStop(0, '#060302'); hole.addColorStop(0.6, '#140b06'); hole.addColorStop(1, 'rgba(40,26,16,0)');
    g.fillStyle = hole; g.beginPath(); g.ellipse(C.x, C.y, 0.36, 0.3, 0.4, 0, TAU); g.fill();
  }
  /** host stem at the honeydew source (ENGINE: the source exists at the route end; plant and aphids are 示意 —
   *  the hemipteran population and the host plant are not simulated) */
  private hostPlant(g: CanvasRenderingContext2D, k: number, L: LightState, b: number) {
    const S = this.model!.corridor.source, r = rnd(777), day = L.intensity > 0;
    // a few broad leaves of the host shoot (seen from above), then the stem, then the aphid cluster on the stem base
    const leaves = [0.3, 1.5, 2.6, 3.7, 4.9, 5.8].map((a) => ({ a: a + r() * 0.3, len: 5 + r() * 3.5, w: 1.8 + r() * 1.1 }));
    for (const lf of leaves) {
      const ca = Math.cos(lf.a), sa = Math.sin(lf.a), P = (u: number, v: number): [number, number] => [S.x + u * ca - v * sa, S.y + u * sa + v * ca];
      const shape = (dx: number, dy: number) => { const a = P(0.8, 0), e = P(0.8 + lf.len, 0), c1 = P(0.8 + lf.len * 0.45, lf.w), c2 = P(0.8 + lf.len * 0.45, -lf.w); g.beginPath(); g.moveTo(a[0] + dx, a[1] + dy); g.quadraticCurveTo(c1[0] + dx, c1[1] + dy, e[0] + dx, e[1] + dy); g.quadraticCurveTo(c2[0] + dx, c2[1] + dy, a[0] + dx, a[1] + dy); g.closePath(); };
      if (day) { const o = this.sh(L, 3); g.fillStyle = 'rgba(10,18,6,0.28)'; this.soft(g, k, 0.8, 'rgba(10,18,6,0.3)'); shape(o.x, o.y); g.fill(); this.noSoft(g); }
      const a = P(0.8, 0), e = P(0.8 + lf.len, 0), gr = g.createLinearGradient(a[0], a[1], e[0], e[1]); gr.addColorStop(0, '#3f6a2a'); gr.addColorStop(0.6, '#5d8a3a'); gr.addColorStop(1, '#7ea24c');
      g.fillStyle = gr; shape(0, 0); g.fill();
      g.strokeStyle = 'rgba(200,225,150,0.45)'; g.lineWidth = Math.max(0.6 / k, 0.06); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(e[0], e[1]); g.stroke();
      if (lf.len * k > 30) { g.lineWidth = Math.max(0.4 / k, 0.03); g.strokeStyle = 'rgba(200,225,150,0.3)'; for (let q = 1; q < 6; q++) for (const sd of [-1, 1]) { const m = P(0.8 + (q / 6) * lf.len, 0), en = P(0.8 + (q / 6) * lf.len + lf.len * 0.12, sd * lf.w * 0.6 * Math.sin((q / 6) * Math.PI)); g.beginPath(); g.moveTo(m[0], m[1]); g.lineTo(en[0], en[1]); g.stroke(); } }
    }
    const sg = g.createRadialGradient(S.x - L.dir.x * 0.15, S.y + L.dir.y * 0.15, 0.02, S.x, S.y, 0.6); sg.addColorStop(0, '#93a868'); sg.addColorStop(0.7, '#5a6e38'); sg.addColorStop(1, '#2f3a1c');
    g.fillStyle = sg; g.beginPath(); g.arc(S.x, S.y, 0.55, 0, TAU); g.fill();
    // aphid cluster (示意): pear-shaped bodies with cornicles; honeydew droplets
    if (0.2 * b >= 1.5) for (let q = 0; q < 26; q++) {
      const a = r() * TAU, d = 0.55 + Math.pow(r(), 0.8) * 0.9, x = S.x + Math.cos(a) * d, y = S.y + Math.sin(a) * d, len = 0.14 + r() * 0.1, ha = a + Math.PI + (r() - 0.5) * 0.8;
      const c = r() < 0.75 ? mix([126, 160, 70], [170, 196, 96], r()) : [92, 110, 52];
      const gr = g.createRadialGradient(x - L.dir.x * len * 0.2, y + L.dir.y * len * 0.2, 0, x, y, len * 0.8); gr.addColorStop(0, rgb(mix(c, [240, 250, 200], 0.4))); gr.addColorStop(1, rgb(mix(c, [30, 40, 10], 0.35)));
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, len * 0.62, len * 0.4, ha, 0, TAU); g.fill();
      if (len * b > 10) { g.strokeStyle = 'rgba(40,50,20,0.7)'; g.lineWidth = Math.max(0.4 / k, len * 0.05); for (const sd of [-1, 1]) { const bx = x - Math.cos(ha) * len * 0.45, by = y - Math.sin(ha) * len * 0.45; g.beginPath(); g.moveTo(bx + Math.cos(ha + sd * 1.9) * len * 0.15, by + Math.sin(ha + sd * 1.9) * len * 0.15); g.lineTo(bx + Math.cos(ha + Math.PI + sd * 0.35) * len * 0.3, by + Math.sin(ha + Math.PI + sd * 0.35) * len * 0.3); g.stroke(); } }
    }
    if (0.05 * b >= 1.2) for (let q = 0; q < 10; q++) { const a = r() * TAU, d = 0.6 + r() * 1.6, x = S.x + Math.cos(a) * d, y = S.y + Math.sin(a) * d, dr = 0.025 + r() * 0.03; g.fillStyle = 'rgba(250,240,190,0.55)'; g.beginPath(); g.arc(x, y, dr, 0, TAU); g.fill(); g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(x - dr * 0.3, y + dr * 0.3, dr * 0.3, 0, TAU); g.fill(); }
  }

  // ------------------------------------------------------------------ frame
  private drawChunk(b: number, i: number, j: number, budget: { n: number; t0: number }): boolean {
    const c = this.cam, cm = CHUNK / b, key = this.key(b, i, j);
    let ch = this.chunks.get(key);
    if (!ch && budget.n > 0 && performance.now() - budget.t0 < 14) { ch = this.bake(b, i, j); budget.n--; }
    const [sx, sy] = worldToScreen(c, i * cm, (j + 1) * cm), size = cm * c.s;
    if (ch) { this.chunks.delete(key); this.chunks.set(key, ch); this.g.drawImage(ch, sx - 0.25, sy - 0.25, size + 0.5, size + 0.5); return true; }
    // fallback: a coarser cached chunk, scaled
    for (let d = 1; d <= 4; d++) {
      const bb = b / Math.pow(2, d), ccm = CHUNK / bb, ii = Math.floor((i * cm + cm / 2) / ccm), jj = Math.floor((j * cm + cm / 2) / ccm), cc = this.chunks.get(this.key(bb, ii, jj));
      if (!cc) continue;
      const f = cc.width / ccm, srcX = (i * cm - ii * ccm) * f, srcY = ((jj + 1) * ccm - (j + 1) * cm) * f;
      this.g.drawImage(cc, srcX, srcY, cm * f, cm * f, sx - 0.25, sy - 0.25, size + 0.5, size + 0.5); return false;
    }
    this.g.fillStyle = '#6e563f'; this.g.fillRect(sx, sy, size, size); return false;
  }
  /** Draw one frame. Returns the draw records (ex/ey = exact affine image of the display pose). */
  frame(cam: Camera, poses: readonly VisPose[], dt: number, o: GardenFrameOpts): AntDrawRec[] {
    const t0 = performance.now(), g = this.g, L = this.light!, dpr = this.dpr;
    this.cam = cam; this.trace = [];
    if (o.running) this.tau += dt;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'medium';
    // ground … propsLow: baked chunks
    const b = this.bucket(cam.s), budget = { n: this.chunks.size === 0 ? 64 : 3, t0 }; let missing = 0;
    for (const [i, j] of this.visible(b)) if (!this.drawChunk(b, i, j, budget)) missing++;
    this.stats.missing = missing;
    this.trace.push('ground', 'decals', 'shadows', 'propsLow');
    // routes: the selected ant's displayed path (顯示插值, dashed) — never a trail on the ground
    this.trace.push('routes');
    if (o.selectedPath) {
      const P = o.selectedPath.pts; g.save(); g.setLineDash([5, 6]); g.strokeStyle = 'rgba(255,236,170,0.55)'; g.lineWidth = 1.4; g.beginPath();
      for (let q = 0; q < P.length; q += 4) { const [x, y] = worldToScreen(cam, P[q].x, P[q].y); if (q === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke(); g.restore();
    }
    // ants
    const lenPx = GardenRenderer.antLenPx(cam.s, o.minAntPx), lenCm = lenPx / cam.s, draws: AntDrawRec[] = [], seen = new Set<string>();
    for (const p of poses) {
      if (p.vis === 'in_nest') continue;
      seen.add(p.id);
      const [ex, ey] = worldToScreen(cam, p.x, p.y), sx = ex + (p.slot ? p.slot.dx * cam.s : 0), sy = ey - (p.slot ? p.slot.dy * cam.s : 0);
      const lk = this.looks.get(p.id) ?? { phase: h01(hash32(p.id), 1, 1, 1), dist: p.dist_cm, path: p.path, h: -(p.heading ?? 0), w: p.walking ? 1 : 0, capped: false, amp: 1 };
      const dd = lk.path === p.path ? p.dist_cm - lk.dist : p.dist_cm, adv = gaitAdvance(dd, lenCm);
      lk.phase += adv.cycles; lk.capped = adv.capped; lk.amp += (adv.amp - lk.amp) * 0.3; lk.dist = p.dist_cm; lk.path = p.path;
      const target = -(p.heading ?? 0), dh = Math.atan2(Math.sin(target - lk.h), Math.cos(target - lk.h));
      lk.h += dh * (1 - Math.exp(-Math.max(0, dt) / 0.07));
      lk.w += ((p.walking ? 1 : 0) - lk.w) * (1 - Math.exp(-Math.max(0, dt) / 0.12));
      this.looks.set(p.id, lk);
      draws.push({ id: p.id, sx, sy, ex, ey, heading: lk.h, lenPx, gait: lk.w > 0.02 ? 'walk' : 'idle', phase: lk.phase, walkW: lk.w * lk.amp, capped: lk.capped });
    }
    for (const id of [...this.looks.keys()]) if (!seen.has(id)) this.looks.delete(id);
    const pad = lenPx, onScreen = draws.filter((d) => d.sx > -pad && d.sy > -pad && d.sx < cam.w + pad && d.sy < cam.h + pad);
    this.trace.push('antShadows', 'ants');
    withLight(L, () => { for (const d of onScreen) this.ant(d, lenPx, o); });
    this.trace.push('propsHigh');
    // lighting: engine light state → colour grade (twilight / night), plus a soft vignette
    this.trace.push('lighting');
    if (this.night > 0) { g.fillStyle = `rgba(18,28,58,${(0.55 * this.night).toFixed(3)})`; g.globalCompositeOperation = 'multiply'; g.fillRect(0, 0, cam.w, cam.h); g.globalCompositeOperation = 'source-over'; }
    else { g.fillStyle = 'rgba(255,214,150,0.06)'; g.globalCompositeOperation = 'soft-light'; g.fillRect(0, 0, cam.w, cam.h); g.globalCompositeOperation = 'source-over'; }
    g.drawImage(this.vignette(cam.w, cam.h), 0, 0, cam.w, cam.h);
    this.trace.push('weather'); // rain is not simulated in P0-A2: nothing to draw
    this.trace.push('ui');
    this.draws = draws;
    const ms = performance.now() - t0; this.stats.frameMs.push(ms); if (this.stats.frameMs.length > 120) this.stats.frameMs.shift();
    return draws;
  }
  private vignette(w: number, h: number) {
    const key = `${w}x${h}`; if (this.vig?.key === key) return this.vig.c;
    const c = mk(w, h), g = ctxOf(c), gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(12,8,4,0.42)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    this.vig = { key, c }; return c;
  }
  /** display-only antenna motion: sweeping while walking, slow probing at rest, quick tapping while feeding */
  private micro(id: string, walkW: number, feeding: boolean): MicroPose {
    const h = hash32(id) >>> 0, t = this.tau, ph = h01(h, 2, 2, 2) * TAU, f = feeding ? 3.4 : 1.1 + walkW * 1.4;
    const side = (sd: number) => ({ scape: 0.98 + 0.12 * Math.sin(t * f + ph + sd) * (0.5 + walkW * 0.5) + (feeding ? -0.12 : 0), fun: 0.3 + 0.18 * Math.sin(t * f * 1.37 + ph * 2 + sd * 2.1), reach: feeding ? 0.62 + 0.18 * Math.max(0, Math.sin(t * f * 2 + sd * 1.7 + ph)) : 0.84 + 0.06 * Math.sin(t * 0.7 + sd) });
    return { headYaw: 0.06 * Math.sin(t * 0.9 + ph) * (1 - walkW * 0.5), L: side(-1), R: side(1) };
  }
  private ant(d: AntDrawRec, lenPx: number, o: GardenFrameOpts) {
    const g = this.g, pal = antPalette(hash32(d.id) % PALETTE_VARIANTS), sel = o.selected === d.id;
    const feeding = d.walkW < 0.5 && d.sx !== d.ex;
    if (lenPx >= 22) drawAntDetail(g, lenPx, d.sx, d.sy, d.heading, d.gait, d.phase % 1, d.walkW, this.micro(d.id, d.walkW, feeding), pal, { stride: ART_STRIDE_SCALE });
    else this.smallAnt(d, lenPx, pal.gaster[1], pal.head[1]);
    if (sel) { g.strokeStyle = o.following === d.id ? '#9fe0ff' : '#ffe08a'; g.lineWidth = 2; g.beginPath(); g.arc(d.sx, d.sy, lenPx * 0.7 + 4, 0, TAU); g.stroke(); }
  }
  /** far zoom: a simplified ant with the same proportions (gaster, petiole, mesosoma, head, legs in tripod phase) */
  private smallAnt(d: AntDrawRec, len: number, gaster: string, body: string) {
    const g = this.g, u = len / 100, ph = (d.phase % 1) * TAU, L = this.light!;
    g.save(); g.translate(d.sx, d.sy); g.rotate(d.heading); g.scale(u, u);
    if (L.intensity > 0) { g.fillStyle = 'rgba(20,12,6,0.35)'; g.beginPath(); g.ellipse(-4 + L.shadow.x * 6, L.shadow.y * 6, 48, 13, 0, 0, TAU); g.fill(); }
    g.strokeStyle = 'rgba(40,20,8,0.95)'; g.lineWidth = Math.max(3.2, 0.9 / u); g.lineCap = 'round';
    for (const [bx, sd, ax, set] of [[15, 1, 31, 0], [6, 1, 4, 1], [0, 1, -26, 0], [15, -1, 31, 1], [6, -1, 4, 0], [0, -1, -26, 1]] as const) {
      const sw = Math.sin(ph + (set ? Math.PI : 0)) * 9 * d.walkW; g.beginPath(); g.moveTo(bx, 0); g.lineTo(ax + sw, sd * 25); g.stroke();
    }
    g.fillStyle = gaster; g.beginPath(); g.ellipse(-34, 0, 14, 10, 0, 0, TAU); g.fill();
    g.fillStyle = body; g.beginPath(); g.ellipse(-14, 0, 4, 3, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(8, 0, 13, 6.5, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(32, 0, 12, 10.5, 0, 0, TAU); g.fill();
    g.strokeStyle = body; g.lineWidth = Math.max(2.4, 0.7 / u); g.beginPath(); g.moveTo(40, -3); g.lineTo(62, -16); g.lineTo(72, -10); g.moveTo(40, 3); g.lineTo(62, 16); g.lineTo(72, 10); g.stroke();
    g.restore();
  }
}

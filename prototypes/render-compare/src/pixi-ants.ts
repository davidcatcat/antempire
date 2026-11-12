/**
 * Option C: the two ant layers drawn by PixiJS (WebGL) as batched sprites, the approach of the #102 / #113 bench
 * (one Sprite per object in a plain Container, shared textures, Pixi ticker off, rendered from the page's own rAF).
 * The textures are the SAME unrotated atlas canvases the Canvas 2D path blits (web/src/art-raster bakeAntAtlas), cut
 * into frames, so A / B / C show the same frame art; sprite position = the planned screen position, rotation = the
 * planned heading (exact, no bucketing). Crowd shadows (> 300 ants) use one soft-ellipse texture, as the 2D path
 * uses one batched ellipse path. Drawing only: it receives the renderer's draw records and writes nothing back.
 */
import { autoDetectRenderer, Container, Graphics, Rectangle, Sprite, Texture, type Renderer } from 'pixi.js';
import type { AntDraw } from '../../../web/src/render-scene.ts';
import type { AntLayerInfo } from '../../../web/src/render-canvas.ts';
import type { AntAtlas } from '../../../web/src/art-raster.ts';
import type { Gait } from '../../../web/src/art-ant.ts';

export class PixiAnts {
  private shadowLayer = new Container();
  private antLayer = new Container();
  private stage = new Container();
  private bodies: Sprite[] = [];
  private shadows: Sprite[] = [];
  private bases = new Map<AntAtlas, { body: Texture; shadow: Texture; frames: Map<string, Texture> }>();
  private ellipse: Texture | null = null;
  /** sprite anchors of the last frame (tests): position and rotation actually given to Pixi */
  anchors: { id: string; ax: number; ay: number; heading: number; bucket: number; n: number }[] = [];
  gpuTimer: string;
  readonly renderer: Renderer;
  private constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.stage.addChild(this.shadowLayer, this.antLayer);
    const gl = (renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    this.gpuTimer = !gl ? 'no WebGL context' : gl.getExtension('EXT_disjoint_timer_query_webgl2') ? 'EXT_disjoint_timer_query_webgl2 available' : 'EXT_disjoint_timer_query_webgl2 NOT available';
  }
  static async create(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): Promise<PixiAnts> {
    const renderer = await autoDetectRenderer({ preference: 'webgl', canvas, width: w, height: h, resolution: dpr, autoDensity: false, backgroundAlpha: 0, antialias: false, clearBeforeRender: true });
    return new PixiAnts(renderer);
  }
  resize(w: number, h: number, dpr: number) {
    if (this.renderer.width !== w || this.renderer.height !== h || this.renderer.resolution !== dpr) this.renderer.resize(w, h, dpr);
  }
  describe() {
    const gl = (this.renderer as unknown as { gl?: WebGL2RenderingContext }).gl, ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { name: this.renderer.name, gl: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null, gpu_timer: this.gpuTimer, sprites: this.bodies.length + this.shadows.length };
  }
  /** RGBA bytes of the textures uploaded (the atlas canvases; GPU copies) */
  textureBytes() { let b = 0; for (const a of this.bases.keys()) b += 2 * a.cellW * a.cellH * Math.max(a.walk, a.idle) * a.rows.length * 4; return b + (this.ellipse ? 64 * 16 * 4 : 0); }

  private frameTex(a: AntAtlas, part: 'body' | 'shadow', gait: Gait, frame: number): Texture {
    let b = this.bases.get(a);
    if (!b) { b = { body: Texture.from(a.canvas as HTMLCanvasElement), shadow: Texture.from(a.shadow as HTMLCanvasElement), frames: new Map() }; this.bases.set(a, b); }
    const k = `${part}|${gait}|${frame}`; let t = b.frames.get(k);
    if (!t) { const row = Math.max(0, a.rows.indexOf(gait)); t = new Texture({ source: (part === 'body' ? b.body : b.shadow).source, frame: new Rectangle(frame * a.cellW, row * a.cellH, a.cellW, a.cellH) }); b.frames.set(k, t); }
    return t;
  }
  private pool(list: Sprite[], layer: Container, n: number) {
    while (list.length < n) { const s = new Sprite(); list.push(s); layer.addChild(s); }
    for (let i = 0; i < list.length; i++) list[i].visible = i < n;
  }
  draw(layer: 'antShadows' | 'ants', draws: readonly AntDraw[], info: AntLayerInfo) {
    const k = 1 / info.dpr;
    if (layer === 'antShadows') {
      if (!info.shadows) { this.pool(this.shadows, this.shadowLayer, 0); return; }
      this.pool(this.shadows, this.shadowLayer, draws.length);
      const o = info.light.shadow;
      if (info.crowd) {
        if (!this.ellipse) this.ellipse = this.renderer.generateTexture({ target: new Graphics().ellipse(0, 0, 32, 8).fill({ color: 0x180e06 }), resolution: 1 });
        const h = info.L * 0.05;
        draws.forEach((d, i) => { const s = this.shadows[i]; s.texture = this.ellipse as Texture; s.anchor.set(0.5); s.alpha = 0.28; s.position.set(d.sx + o.x * h, d.sy + o.y * h); s.rotation = d.heading; s.scale.set((info.L * 0.84) / 64, (info.L * 0.24) / 16); });
      } else {
        const a = info.atlasFor(Math.floor(5 / 2)), h = info.shadowLift;
        draws.forEach((d, i) => { const s = this.shadows[i]; s.texture = this.frameTex(a, 'shadow', d.gait, info.frameOf(d)); s.anchor.set(a.ox / a.cellW, a.oy / a.cellH); s.alpha = Math.min(1, 0.35 + info.light.intensity); s.position.set(d.sx + o.x * h, d.sy + o.y * h); s.rotation = d.heading; s.scale.set(k); });
      }
      return;
    }
    this.pool(this.bodies, this.antLayer, draws.length); this.anchors = [];
    draws.forEach((d, i) => {
      const a = info.atlasFor(info.variantOf(d.id)), s = this.bodies[i];
      s.texture = this.frameTex(a, 'body', d.gait, info.frameOf(d)); s.anchor.set(a.ox / a.cellW, a.oy / a.cellH); s.alpha = 1;
      s.position.set(d.sx, d.sy); s.rotation = d.heading; s.scale.set(k);
      this.anchors.push({ id: d.id, ax: s.position.x, ay: s.position.y, heading: s.rotation, bucket: -1, n: 0 });
    });
    this.renderer.render(this.stage);
  }
}

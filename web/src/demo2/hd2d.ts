/**
 * Demo 2 — the opt-in "HD-2D" picture style (畫面效果, display only; WebGL 2 renderer only).
 *
 * A post-processing chain over the SAME scene, camera and drawn positions as the standard style. Nothing here is read
 * by the simulation, the display director or the picking code; it adds no organism, no event and no light source.
 *  1. the scene is drawn into a REDUCED-resolution target (pixel factor 1 / 2 / 3 / 4) and enlarged with
 *     nearest-neighbour sampling (pixel look); the HTML overlay (labels, panels) stays at native resolution;
 *  2. depth of field at the reduced resolution: blur grows with the distance from the focus plane (the camera target,
 *     or the followed ant);
 *  3. bloom: bright parts blurred and added back;
 *  4. colour grade and vignette. The grade tint is chosen from the ENGINE's light state (day: warm; civil twilight:
 *     warmer; night: none) — the style never changes the time of day; the sun / sky colours still come from setLight().
 * Effects can be switched off one by one (auto quality drops depth of field first, then bloom).
 */
import * as THREE from 'three';

export interface Hd2dEffects { dof: boolean; bloom: boolean }
export type LightState = 'day' | 'civil_twilight' | 'night';
/** grade per engine light state: rgb tint, saturation, bloom strength (display only) */
export const HD2D_GRADE: Record<LightState, { tint: [number, number, number]; sat: number; bloom: number }> = {
  day: { tint: [1.07, 1.0, 0.9], sat: 1.14, bloom: 0.5 },
  civil_twilight: { tint: [1.12, 0.97, 0.84], sat: 1.1, bloom: 0.6 },
  night: { tint: [1.0, 1.0, 1.0], sat: 1.0, bloom: 0.35 },
};
export const PIXEL_FACTORS = [1, 2, 3, 4] as const;

const VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const DOF_FS = /* glsl */ `
#include <packing>
varying vec2 vUv; uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 texel; uniform float near; uniform float far; uniform float focus; uniform float range; uniform float maxR;
float viewDist(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
float coc(float d) { return clamp(abs(d - focus) / range - 0.12, 0.0, 1.0) * maxR; }
void main() {
  float c = coc(viewDist(vUv)); vec3 acc = texture2D(tColor, vUv).rgb; float wsum = 1.0;
  for (int i = 0; i < 14; i++) {
    float a = float(i) * 2.39996, r = sqrt((float(i) + 0.5) / 14.0); vec2 uv = vUv + vec2(cos(a), sin(a)) * r * c * texel;
    // a sharp (in-focus) neighbour does not bleed into a blurred pixel more than its own blur allows
    float w = clamp(coc(viewDist(uv)) / max(c, 0.001), 0.15, 1.0); acc += texture2D(tColor, uv).rgb * w; wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;
const BRIGHT_FS = /* glsl */ `varying vec2 vUv; uniform sampler2D tColor; uniform float threshold;
void main() { vec3 c = texture2D(tColor, vUv).rgb; float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); gl_FragColor = vec4(c * smoothstep(threshold, threshold + 0.6, l), 1.0); }`;
const BLUR_FS = /* glsl */ `varying vec2 vUv; uniform sampler2D tColor; uniform vec2 dir;
void main() { vec3 s = texture2D(tColor, vUv).rgb * 0.227; s += (texture2D(tColor, vUv + dir * 1.385).rgb + texture2D(tColor, vUv - dir * 1.385).rgb) * 0.316; s += (texture2D(tColor, vUv + dir * 3.231).rgb + texture2D(tColor, vUv - dir * 3.231).rgb) * 0.070; gl_FragColor = vec4(s, 1.0); }`;
const OUT_FS = /* glsl */ `varying vec2 vUv; uniform sampler2D tColor; uniform sampler2D tBloom; uniform float bloom; uniform vec3 tint; uniform float sat; uniform float vignette;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb + texture2D(tBloom, vUv).rgb * bloom;
  c *= tint; float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, sat);
  c *= 1.0 - vignette * smoothstep(0.42, 0.98, length(vUv - 0.5) * 1.3);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Hd2dPipeline {
  private readonly r: THREE.WebGLRenderer;
  private readonly quad: THREE.Mesh; private readonly qScene = new THREE.Scene(); private readonly qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private rtScene: THREE.WebGLRenderTarget; private rtDof: THREE.WebGLRenderTarget; private rtA: THREE.WebGLRenderTarget; private rtB: THREE.WebGLRenderTarget;
  private readonly mDof: THREE.ShaderMaterial; private readonly mBright: THREE.ShaderMaterial; private readonly mBlur: THREE.ShaderMaterial; private readonly mOut: THREE.ShaderMaterial;
  private readonly black: THREE.DataTexture;
  factor = 3; lowW = 1; lowH = 1;
  constructor(renderer: THREE.WebGLRenderer) {
    this.r = renderer;
    const mk = (w: number, h: number, depth: boolean, filter: THREE.MagnificationTextureFilter) => { const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: depth, magFilter: filter, minFilter: filter }); if (depth) { t.depthTexture = new THREE.DepthTexture(w, h); t.depthTexture.type = THREE.UnsignedIntType; } return t; };
    this.rtScene = mk(2, 2, true, THREE.NearestFilter); this.rtDof = mk(2, 2, false, THREE.NearestFilter); this.rtA = mk(2, 2, false, THREE.LinearFilter); this.rtB = mk(2, 2, false, THREE.LinearFilter);
    const sm = (fs: string, u: Record<string, THREE.IUniform>, toneMapped = false) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms: u, depthTest: false, depthWrite: false, toneMapped });
    this.mDof = sm(DOF_FS, { tColor: { value: null }, tDepth: { value: null }, texel: { value: new THREE.Vector2() }, near: { value: 1 }, far: { value: 100 }, focus: { value: 50 }, range: { value: 40 }, maxR: { value: 5 } });
    this.mBright = sm(BRIGHT_FS, { tColor: { value: null }, threshold: { value: 0.9 } });
    this.mBlur = sm(BLUR_FS, { tColor: { value: null }, dir: { value: new THREE.Vector2() } });
    this.mOut = sm(OUT_FS, { tColor: { value: null }, tBloom: { value: null }, bloom: { value: 0.5 }, tint: { value: new THREE.Vector3(1, 1, 1) }, sat: { value: 1 }, vignette: { value: 0.32 } }, true);
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.black.needsUpdate = true;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mOut); this.quad.frustumCulled = false; this.qScene.add(this.quad);
  }
  /** drawing-buffer size (px) and pixel factor → reduced target sizes */
  setSize(bufW: number, bufH: number, factor: number) {
    this.factor = factor; this.lowW = Math.max(2, Math.round(bufW / factor)); this.lowH = Math.max(2, Math.round(bufH / factor));
    this.rtScene.setSize(this.lowW, this.lowH); this.rtDof.setSize(this.lowW, this.lowH);
    const bw = Math.max(2, Math.round(this.lowW / 2)), bh = Math.max(2, Math.round(this.lowH / 2)); this.rtA.setSize(bw, bh); this.rtB.setSize(bw, bh);
  }
  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) { this.quad.material = mat; this.r.setRenderTarget(target); this.r.render(this.qScene, this.qCam); }
  /** focus = distance (cm) from the camera to the focus plane along the view direction */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, focus: number, light: LightState, fx: Hd2dEffects) {
    const r = this.r, G = HD2D_GRADE[light];
    r.setRenderTarget(this.rtScene); r.render(scene, camera);
    let src = this.rtScene.texture;
    if (fx.dof) {
      const u = this.mDof.uniforms; u.tColor.value = src; u.tDepth.value = this.rtScene.depthTexture; u.texel.value.set(1 / this.lowW, 1 / this.lowH); u.near.value = camera.near; u.far.value = camera.far;
      u.focus.value = focus; u.range.value = Math.max(8, focus * 0.55); u.maxR.value = Math.max(2, 9 / this.factor + 1.5);
      this.pass(this.mDof, this.rtDof); src = this.rtDof.texture;
    }
    if (fx.bloom) {
      this.mBright.uniforms.tColor.value = src; this.pass(this.mBright, this.rtA);
      const bw = this.rtA.width, bh = this.rtA.height;
      for (let i = 0; i < 2; i++) { this.mBlur.uniforms.tColor.value = this.rtA.texture; this.mBlur.uniforms.dir.value.set((1 + i) / bw, 0); this.pass(this.mBlur, this.rtB); this.mBlur.uniforms.tColor.value = this.rtB.texture; this.mBlur.uniforms.dir.value.set(0, (1 + i) / bh); this.pass(this.mBlur, this.rtA); }
    }
    const o = this.mOut.uniforms; o.tColor.value = src; o.tBloom.value = fx.bloom ? this.rtA.texture : this.black; o.bloom.value = G.bloom; o.tint.value.set(G.tint[0], G.tint[1], G.tint[2]); o.sat.value = G.sat;
    this.pass(this.mOut, null);
  }
}

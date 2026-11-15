/**
 * Demo 2 — instanced, rigged ant models for the castes of Pheidole megacephala and the brood stages (display only).
 *
 * Castes (drawing proportions; body length of the minor = MINOR_LEN_CM × the magnification):
 *  - minor worker: the 3-D prototype's model (web/src/three/ant-model.ts);
 *  - major worker ("大頭"): disproportionately large, heart-shaped head. Head width: minor 0.50–0.61 mm, major
 *    1.10–1.54 mm (docs/references.md R99, Sarnat et al. 2015; complete dimorphism R97). The drawn head-width ratio
 *    (≈ 2.9 ×) is inside that range; the major's BODY length (≈ 4 mm drawn) is not in the repo's sources → 展示假設;
 *  - queen: larger body, big gaster, thicker mesosoma. No size value for this species in the repo's sources → 展示假設;
 *  - larva (segmented, legless grub), pupa (pale, appendages folded; naked pupa as in Myrmicinae in general — general
 *    morphology, 展示假設), egg (small ovoid). Sizes are drawing sizes.
 * The joint rig runs in the vertex shader (legs, antennae, head, gaster about their pivots) from per-instance
 * attributes: aAnim (gait phase, walk weight, seed, activity) and aPose (crop distension of the gaster — ENGINE crop
 * fill; head pitch; antenna raise; crouch). The shader never moves an ant: only its parts about their joints.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildAntGeometry, MINOR_MORPH, type AntMorph } from '../three/ant-model.ts';
import { RIG, CUTICLE, glf } from './rig-params.ts';

export type RigCaste = 'minor' | 'major' | 'queen';
/** scale = body scale relative to the minor worker (applied to the instance) */
export const MORPHS: Record<RigCaste, { morph: AntMorph; scale: number; note_zh: string }> = {
  minor: { morph: MINOR_MORPH, scale: 1, note_zh: '小工蟻：體長 2.5 mm（畫面放大）' },
  major: { morph: { head: 1.9, headWide: 1.06, lobes: true, antenna: 0.62, gaster: [1.05, 1.05, 1.08], meso: [1.12, 1.18] }, scale: 1.45, note_zh: '大工蟻：頭寬比依 R99（1.10–1.54 mm 對 0.50–0.61 mm）；體長為展示假設' },
  queen: { morph: { head: 1.02, headWide: 1.05, lobes: false, antenna: 0.85, gaster: [1.55, 1.45, 1.5], meso: [1.3, 1.45] }, scale: 2.5, note_zh: '蟻后：體型為展示假設（repo 文獻沒有本種蟻后尺寸）' },
};

const K = RIG, f = glf;
/** the GLSL rig of the WebGL 2 renderer; every number comes from rig-params.ts (shared with the TSL rig) */
export const RIG_GLSL = /* glsl */ `
attribute vec3 aPart;
attribute vec3 aPivot;
attribute vec4 aAnim;
attribute vec4 aPose;
attribute vec4 aMore;
uniform float uTime;
float qn(float t, float s) { return ${f(K.qn.amp[0])} * sin(t * ${f(K.qn.freq[0])} + s * ${f(K.qn.phase[0])}) + ${f(K.qn.amp[1])} * sin(t * ${f(K.qn.freq[1])} + s * ${f(K.qn.phase[1])}) + ${f(K.qn.amp[2])} * sin(t * ${f(K.qn.freq[2])} + s * ${f(K.qn.phase[2])}); }
mat3 rY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
vec3 antRig(vec3 p, out mat3 R) {
  float kind = aPart.x, idx = aPart.y, w = aPart.z;
  float ph = aAnim.x, walk = aAnim.y, seed = aAnim.z, t = uTime;
  float crop = aPose.x, pitch = aPose.y, antUp = aPose.z, crouch = aPose.w;
  float act = aAnim.w * (${f(K.act.base)} + ${f(K.act.mod)} * qn(t * ${f(K.act.freq)}, seed + ${f(K.act.seed)}));
  float still = 1.0 - walk;
  float drop = ${f(K.body.drop)} * crouch;
  vec3 off = vec3(0.0, ${f(K.body.bob)} * walk * sin(2.0 * ph) + ${f(K.body.idleBob)} * act * still * qn(t * ${f(K.body.idleFreq)}, seed + ${f(K.body.idleSeed)}) - drop, 0.0);
  R = mat3(1.0);
  vec3 headPiv = vec3(${K.headPivot.map(f).join(', ')});
  mat3 Rh = rY(${f(K.head.yaw)} * act * qn(t * ${f(K.head.yawFreq)}, seed + ${f(K.head.yawSeed)})) * rZ(${f(K.head.nod)} * act * qn(t * ${f(K.head.nodFreq)}, seed + ${f(K.head.nodSeed)}) - ${f(K.head.walk)} * walk - pitch);
  if (kind < 0.5) {
    return p + off;
  } else if (kind < 1.5) {
    R = Rh; return headPiv + Rh * (p - headPiv) + off;
  } else if (kind < 2.5) {
    R = rZ(${f(K.gaster.idle)} * act * qn(t * ${f(K.gaster.idleFreq)}, seed + ${f(K.gaster.idleSeed)}) - ${f(K.gaster.walk)} * walk * sin(2.0 * ph) + ${f(K.gaster.pitch)} * pitch);
    vec3 d = (p - aPivot) * vec3(1.0 + ${f(K.gaster.cropX)} * crop, 1.0 + ${f(K.gaster.cropYZ)} * crop, 1.0 + ${f(K.gaster.cropYZ)} * crop);
    return aPivot + R * d + off;
  } else if (kind < 3.5) {
    float side = idx < 2.5 ? 1.0 : -1.0;
    float pair = mod(idx, 3.0);
    float grp = abs(pair - 1.0) < 0.5 ? (side > 0.0 ? 1.0 : 0.0) : (side > 0.0 ? 0.0 : 1.0);
    float cyc = fract((ph + grp * 3.14159265) / 6.2831853);
    float legs = aMore.x, A = aMore.w, D, lift;
    // stance (first half of the cycle): the tip goes straight back at the body's own speed; swing: carried forward, lifted
    if (cyc < 0.5) { D = A * (1.0 - 4.0 * cyc); lift = 0.0; } else { float u = (cyc - 0.5) * 2.0; D = -A * cos(3.14159265 * u); lift = ${f(K.leg.lift)} * sin(3.14159265 * u); }
    D *= legs; lift *= legs;
    vec2 r0 = pair < 0.5 ? vec2(${K.leg.reach[0].map(f).join(', ')}) : pair < 1.5 ? vec2(${K.leg.reach[1].map(f).join(', ')}) : vec2(${K.leg.reach[2].map(f).join(', ')});
    float k = length(vec2(r0.x + D, r0.y)) / length(r0);
    float ang = -side * (atan(r0.y, r0.x + D) - atan(r0.y, r0.x)) + side * ${f(K.leg.idle)} * act * still * qn(t * ${f(K.leg.idleFreq)}, seed + idx * ${f(K.leg.idleSeed)});
    R = rY(ang);
    vec3 d = R * (p - aPivot);
    d.xz *= k; if (d.y > 0.0) d.y /= pow(k, ${f(K.leg.kneeFlat)});
    vec3 q = aPivot + d;
    q.y += w * (lift + ${f(K.leg.idleLift)} * act * still * max(0.0, qn(t * ${f(K.leg.idleLiftFreq)}, seed + idx * ${f(K.leg.idleLiftSeed)}) - ${f(K.leg.idleGate)}));
    q.y += drop * w + off.y * (1.0 - w); // the feet stay planted while the body bobs or crouches
    return q;
  } else {
    float side = idx < 0.5 ? 1.0 : -1.0;
    float scan = aMore.y, conv = aMore.z;
    float sweep = scan * ${f(K.antenna.scan)} * sin(t * ${f(K.antenna.scanFreq)} + (idx < 0.5 ? 0.0 : ${f(K.antenna.scanLag)}) + seed * 6.2831853);
    mat3 Ra = rY(side * (${f(K.antenna.yaw)} * act * qn(t * ${f(K.antenna.yawFreq)}, seed + idx * ${f(K.antenna.yawSeed)}) + ${f(K.antenna.walkYaw)} * walk * sin(ph * 0.5) - conv * ${f(K.antenna.conv)}) + sweep) * rZ(${f(K.antenna.nod)} * act * qn(t * ${f(K.antenna.nodFreq)}, seed + idx * ${f(K.antenna.nodSeed)} + ${f(K.antenna.nodSeed0)}) - ${f(K.antenna.walkNod)} * walk + ${f(K.antenna.up)} * antUp + conv * ${f(K.antenna.convUp)} + scan * ${f(K.antenna.scanNod)} * sin(t * ${f(K.antenna.scanFreq)} * 2.0 + seed * 6.2831853 + idx));
    R = Rh * Ra;
    vec3 q = aPivot + Ra * (p - aPivot);
    return headPiv + Rh * (q - headPiv) + off;
  }
}
`;
/** PBR cuticle material with the rig injected (WebGL: onBeforeCompile). uTime is shared and frozen while paused. */
export function rigMaterial(uTime: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...CUTICLE });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = RIG_GLSL + sh.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  mat3 antR; vec3 antP = antRig(position, antR);\n  objectNormal = antR * objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = antP;');
  };
  m.customProgramCacheKey = () => 'antempire-demo2-rig-v3';
  return m;
}

/** one caste at one level of detail: InstancedMesh + per-instance aAnim / aPose */
export class RigLayer {
  readonly mesh: THREE.InstancedMesh; readonly anim: THREE.InterleavedBufferAttribute; readonly pose: THREE.InterleavedBufferAttribute;
  /** per instance: unit quaternion (xyz w) and uniform scale of the instance transform — the same rotation and scale as
   *  instanceMatrix. Only the TSL rig reads it (three's node pipeline applies the instance matrix BEFORE positionNode,
   *  so the rig, which works in model space, has to carry its joint offsets into instance space itself). */
  readonly xf: THREE.InterleavedBufferAttribute; readonly scl: THREE.InterleavedBufferAttribute;
  /** per instance: leg stride pose weight, antenna scan, antenna convergence, stance amplitude A (model units) */
  readonly more: THREE.InterleavedBufferAttribute;
  /** the four per-instance attributes share ONE interleaved buffer (WebGPU allows 8 vertex buffers per pipeline) */
  private readonly inst: THREE.InstancedInterleavedBuffer;
  readonly caste: RigCaste; readonly triangles: number;
  constructor(caste: RigCaste, level: 'hi' | 'lo', capacity: number, mat: THREE.Material) {
    const g = buildAntGeometry(level, MORPHS[caste].morph);
    this.caste = caste;
    this.inst = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * 17), 17); this.inst.setUsage(THREE.DynamicDrawUsage);
    this.anim = new THREE.InterleavedBufferAttribute(this.inst, 4, 0); this.pose = new THREE.InterleavedBufferAttribute(this.inst, 4, 4);
    this.xf = new THREE.InterleavedBufferAttribute(this.inst, 4, 8); this.scl = new THREE.InterleavedBufferAttribute(this.inst, 1, 12);
    this.more = new THREE.InterleavedBufferAttribute(this.inst, 4, 13);
    g.setAttribute('aAnim', this.anim); g.setAttribute('aPose', this.pose); g.setAttribute('aXf', this.xf); g.setAttribute('aScl', this.scl); g.setAttribute('aMore', this.more);
    this.mesh = new THREE.InstancedMesh(g, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1)); this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.count = 0;
    this.triangles = (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  commit(n: number) { this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true; this.inst.needsUpdate = true; }
}

const ell = (c: [number, number, number], r: [number, number, number], ws: number, hs: number) => new THREE.SphereGeometry(1, ws, hs).scale(r[0], r[1], r[2]).translate(c[0], c[1], c[2]);
const strip = (g: THREE.BufferGeometry) => { g.deleteAttribute('uv'); return g; };
/** larva: a legless, curved, segmented grub lying on its side (unit length ≈ 1) */
export function larvaGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [], n = 8;
  for (let i = 0; i < n; i++) { const u = i / (n - 1), a = -0.9 + u * 2.0, r = 0.36, rad = 0.2 * (0.55 + 0.75 * Math.sin(Math.PI * (0.18 + 0.72 * u))); parts.push(strip(ell([Math.sin(a) * r, rad * 0.9, Math.cos(a) * r - r * 0.6], [rad * 1.05, rad, rad * 1.05], 9, 6))); }
  const g = mergeGeometries(parts, false)!; g.computeBoundingSphere(); return g;
}
/** pupa: pale ant shape with the appendages folded against the body (unit length ≈ 1, lying on its back) */
export function pupaGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [strip(ell([0.3, 0.17, 0], [0.17, 0.15, 0.16], 10, 7)), strip(ell([0.03, 0.16, 0], [0.19, 0.13, 0.13], 10, 7)), strip(ell([-0.3, 0.17, 0], [0.24, 0.16, 0.17], 10, 7))];
  for (const s of [1, -1]) for (let k = 0; k < 3; k++) { const c = new THREE.CylinderGeometry(0.022, 0.016, 0.3, 4).rotateZ(Math.PI / 2 - 0.5).translate(0.1 - k * 0.1, 0.3, 0.07 * s); parts.push(strip(c)); }
  for (const s of [1, -1]) parts.push(strip(new THREE.CylinderGeometry(0.016, 0.012, 0.3, 4).rotateZ(Math.PI / 2 + 0.25).translate(0.26, 0.31, 0.06 * s)));
  const g = mergeGeometries(parts, false)!; g.computeBoundingSphere(); return g;
}
export const eggGeometry = () => new THREE.SphereGeometry(1, 7, 5).scale(0.5, 0.3, 0.3);

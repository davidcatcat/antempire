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

export type RigCaste = 'minor' | 'major' | 'queen';
/** scale = body scale relative to the minor worker (applied to the instance) */
export const MORPHS: Record<RigCaste, { morph: AntMorph; scale: number; note_zh: string }> = {
  minor: { morph: MINOR_MORPH, scale: 1, note_zh: '小工蟻：體長 2.5 mm（畫面放大）' },
  major: { morph: { head: 1.9, headWide: 1.06, lobes: true, antenna: 0.62, gaster: [1.05, 1.05, 1.08], meso: [1.12, 1.18] }, scale: 1.45, note_zh: '大工蟻：頭寬比依 R99（1.10–1.54 mm 對 0.50–0.61 mm）；體長為展示假設' },
  queen: { morph: { head: 1.02, headWide: 1.05, lobes: false, antenna: 0.85, gaster: [1.55, 1.45, 1.5], meso: [1.3, 1.45] }, scale: 2.5, note_zh: '蟻后：體型為展示假設（repo 文獻沒有本種蟻后尺寸）' },
};

const RIG = /* glsl */ `
attribute vec3 aPart;
attribute vec3 aPivot;
attribute vec4 aAnim;
attribute vec4 aPose;
uniform float uTime;
float qn(float t, float s) { return 0.5 * sin(t + s * 6.2831) + 0.3 * sin(t * 1.6180339 + s * 2.71828) + 0.2 * sin(t * 2.4142136 + s * 4.1231); }
mat3 rY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
vec3 antRig(vec3 p, out mat3 R) {
  float kind = aPart.x, idx = aPart.y, w = aPart.z;
  float ph = aAnim.x, walk = aAnim.y, seed = aAnim.z, t = uTime;
  float crop = aPose.x, pitch = aPose.y, antUp = aPose.z, crouch = aPose.w;
  float act = aAnim.w * (0.55 + 0.45 * qn(t * 0.13, seed + 0.9));
  float still = 1.0 - walk;
  float drop = 0.04 * crouch;
  vec3 off = vec3(0.0, 0.006 * walk * sin(2.0 * ph) + 0.003 * act * still * qn(t * 0.7, seed + 0.3) - drop, 0.0);
  R = mat3(1.0);
  vec3 headPiv = vec3(0.245, 0.205, 0.0);
  mat3 Rh = rY(0.07 * act * qn(t * 0.55, seed + 0.11)) * rZ(0.05 * act * qn(t * 0.8, seed + 0.37) - 0.02 * walk - pitch);
  if (kind < 0.5) {
    return p + off;
  } else if (kind < 1.5) {
    R = Rh; return headPiv + Rh * (p - headPiv) + off;
  } else if (kind < 2.5) {
    R = rZ(0.045 * act * qn(t * 0.35, seed + 0.5) - 0.03 * walk * sin(2.0 * ph) + 0.12 * pitch);
    vec3 d = (p - aPivot) * vec3(1.0 + 0.1 * crop, 1.0 + 0.36 * crop, 1.0 + 0.36 * crop);
    return aPivot + R * d + off;
  } else if (kind < 3.5) {
    float side = idx < 2.5 ? 1.0 : -1.0;
    float pair = mod(idx, 3.0);
    float grp = abs(pair - 1.0) < 0.5 ? (side > 0.0 ? 1.0 : 0.0) : (side > 0.0 ? 0.0 : 1.0);
    float lp = ph + grp * 3.14159265;
    float ang = side * (0.42 * walk * sin(lp) + 0.06 * act * still * qn(t * 0.23, seed + idx * 0.173));
    R = rY(ang);
    vec3 q = aPivot + R * (p - aPivot);
    q.y += w * (0.09 * walk * max(0.0, cos(lp)) + 0.02 * act * still * max(0.0, qn(t * 0.31, seed + idx * 0.29) - 0.55));
    q.y += drop * w; // the feet stay planted while the body crouches
    return q + off;
  } else {
    float side = idx < 0.5 ? 1.0 : -1.0;
    mat3 Ra = rY(side * (0.24 * act * qn(t * 1.3, seed + idx * 0.43) + 0.12 * walk * sin(ph * 0.5))) * rZ(0.2 * act * qn(t * 0.97, seed + idx * 0.71 + 0.2) - 0.05 * walk + 0.45 * antUp);
    R = Rh * Ra;
    vec3 q = aPivot + Ra * (p - aPivot);
    return headPiv + Rh * (q - headPiv) + off;
  }
}
`;
/** PBR cuticle material with the rig injected (WebGL: onBeforeCompile). uTime is shared and frozen while paused. */
export function rigMaterial(uTime: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.05 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = RIG + sh.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  mat3 antR; vec3 antP = antRig(position, antR);\n  objectNormal = antR * objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = antP;');
  };
  m.customProgramCacheKey = () => 'antempire-demo2-rig-v1';
  return m;
}

/** one caste at one level of detail: InstancedMesh + per-instance aAnim / aPose */
export class RigLayer {
  readonly mesh: THREE.InstancedMesh; readonly anim: THREE.InstancedBufferAttribute; readonly pose: THREE.InstancedBufferAttribute;
  readonly caste: RigCaste; readonly triangles: number;
  constructor(caste: RigCaste, level: 'hi' | 'lo', capacity: number, mat: THREE.Material) {
    const g = buildAntGeometry(level, MORPHS[caste].morph);
    this.caste = caste;
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); this.anim.setUsage(THREE.DynamicDrawUsage); g.setAttribute('aAnim', this.anim);
    this.pose = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); this.pose.setUsage(THREE.DynamicDrawUsage); g.setAttribute('aPose', this.pose);
    this.mesh = new THREE.InstancedMesh(g, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1)); this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.count = 0;
    this.triangles = (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  commit(n: number) { this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true; this.anim.needsUpdate = true; this.pose.needsUpdate = true; }
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

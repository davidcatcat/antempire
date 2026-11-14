/**
 * Three.js 3D prototype — instanced 3-D model of a Pheidole megacephala MINOR worker (display only).
 *
 * Basic morphology drawn (general ant / Myrmicinae anatomy; proportions are a DRAWING, not a measurement):
 *  head with mandibles and compound eyes; geniculate (elbowed) antennae — long scape, funiculus ending in a 3-segment
 *  club; mesosoma with a convex promesonotum and a propodeum carrying two short spines; TWO waist nodes (petiole and
 *  postpetiole, typical of Myrmicinae); oval, darker, glossy gaster; six legs (coxa→femur→tibia→tarsus) from the
 *  mesosoma. Body length = MINOR_LEN_CM (2.5 mm, the value the 2-D renderer uses, vis1-render.ts) × the magnification.
 *
 * One merged geometry per level of detail; every vertex carries its part (aPart: kind, index, reach) and the pivot of
 * that part (aPivot). The vertex shader rotates legs, antennae, head and gaster about their pivots from per-instance
 * attributes (aAnim: gait phase, walk weight, seed, activity) — computed on the CPU from the ENGINE-derived position
 * (motion.ts). The shader never moves the ant: only the parts around their joints.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const MINOR_LEN_CM = 0.25;
/** model-space body length (mandible tip to gaster tip) of the geometry below */
export const MODEL_LEN = 0.95;
export const KIND = { body: 0, head: 1, gaster: 2, leg: 3, antenna: 4 } as const;

type V3 = [number, number, number];
const v = (a: V3) => new THREE.Vector3(...a);
const COL = { head: new THREE.Color('#6e3818'), meso: new THREE.Color('#77401d'), gaster: new THREE.Color('#3a1d0e'), leg: new THREE.Color('#82502a'), eye: new THREE.Color('#120d0b'), mand: new THREE.Color('#4a2410'), club: new THREE.Color('#6a3a1c') };

function tag(g: THREE.BufferGeometry, kind: number, idx: number, pivot: V3, color: THREE.Color, reach = 0): THREE.BufferGeometry {
  const n = g.attributes.position.count, pos = g.attributes.position as THREE.BufferAttribute;
  const part = new Float32Array(n * 3), piv = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = reach > 0 ? Math.min(1, Math.hypot(pos.getX(i) - pivot[0], pos.getY(i) - pivot[1], pos.getZ(i) - pivot[2]) / reach) : 0;
    part.set([kind, idx, d], i * 3); piv.set(pivot, i * 3); col.set([color.r, color.g, color.b], i * 3);
  }
  g.setAttribute('aPart', new THREE.BufferAttribute(part, 3));
  g.setAttribute('aPivot', new THREE.BufferAttribute(piv, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function ellipsoid(c: V3, r: V3, ws: number, hs: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, ws, hs).scale(r[0], r[1], r[2]).translate(c[0], c[1], c[2]);
}
/** tapered rod from a to b (radius ra at a, rb at b) */
function rod(a: V3, b: V3, ra: number, rb: number, radial: number): THREE.BufferGeometry {
  const A = v(a), B = v(b), d = B.clone().sub(A), len = d.length();
  const g = new THREE.CylinderGeometry(rb, ra, len, radial, 1, false).translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  return g.translate(a[0], a[1], a[2]);
}
const joint = (p: V3, r: number, s: number) => ellipsoid(p, [r, r, r], s, Math.max(3, s - 2));

/** leg geometry (z side = +1 / −1); hip, knee (femur–tibia), foot (tibia–tarsus), tarsus tip */
const LEGS: { hip: V3; knee: V3; foot: V3; tip: V3 }[] = [
  { hip: [0.19, 0.145, 0.035], knee: [0.27, 0.225, 0.13], foot: [0.37, 0.004, 0.21], tip: [0.43, 0.0, 0.235] }, // fore
  { hip: [0.115, 0.135, 0.04], knee: [0.12, 0.215, 0.165], foot: [0.1, 0.004, 0.29], tip: [0.075, 0.0, 0.325] }, // mid
  { hip: [0.045, 0.135, 0.04], knee: [-0.02, 0.215, 0.15], foot: [-0.17, 0.004, 0.27], tip: [-0.235, 0.0, 0.295] }, // hind
];
const zs = (p: V3, side: number): V3 => [p[0], p[1], p[2] * side];

/** build one level of detail: hi = smooth enough for close-up / follow, lo = cheap for distant ants */
export function buildAntGeometry(level: 'hi' | 'lo'): THREE.BufferGeometry {
  const hi = level === 'hi', S = hi ? 14 : 7, T = hi ? 10 : 5, R = hi ? 6 : 3, parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, kind: number, idx: number, pivot: V3, c: THREE.Color, reach = 0) => parts.push(tag(g, kind, idx, pivot, c, reach));
  const neck: V3 = [0.245, 0.205, 0], waist: V3 = [-0.06, 0.18, 0];
  // gaster (+ postpetiole) — pivots at the waist
  add(ellipsoid([-0.31, 0.175, 0], [0.165, 0.118, 0.128], S, T), KIND.gaster, 0, waist, COL.gaster);
  add(ellipsoid([-0.125, 0.175, 0], [0.045, 0.042, 0.05], hi ? 10 : 6, hi ? 8 : 4), KIND.gaster, 0, waist, COL.meso);
  // petiole: stalk + node (stays with the body)
  add(rod([-0.035, 0.16, 0], [-0.09, 0.17, 0], 0.022, 0.024, R), KIND.body, 0, [0, 0, 0], COL.meso);
  add(ellipsoid([-0.065, 0.195, 0], [0.028, 0.04, 0.033], hi ? 10 : 6, hi ? 8 : 4), KIND.body, 0, [0, 0, 0], COL.meso);
  // mesosoma: promesonotum (convex) + propodeum + spines
  add(ellipsoid([0.135, 0.195, 0], [0.11, 0.072, 0.062], S, T), KIND.body, 0, [0, 0, 0], COL.meso);
  add(ellipsoid([0.02, 0.18, 0], [0.065, 0.048, 0.046], hi ? 12 : 6, hi ? 8 : 4), KIND.body, 0, [0, 0, 0], COL.meso);
  if (hi) for (const s of [1, -1]) add(rod([-0.005, 0.215, 0.02 * s], [-0.03, 0.258, 0.03 * s], 0.009, 0.002, 4), KIND.body, 0, [0, 0, 0], COL.meso);
  add(rod([0.22, 0.2, 0], neck, 0.03, 0.03, R), KIND.body, 0, [0, 0, 0], COL.meso);
  // head (+ eyes, mandibles, clypeus)
  add(ellipsoid([0.335, 0.2, 0], [0.098, 0.078, 0.088], S, T), KIND.head, 0, neck, COL.head);
  for (const s of [1, -1]) {
    add(ellipsoid([0.35, 0.225, 0.08 * s], [0.018, 0.016, 0.012], hi ? 8 : 4, hi ? 6 : 3), KIND.head, 0, neck, COL.eye);
    add(rod([0.415, 0.17, 0.035 * s], [0.468, 0.162, 0.008 * s], 0.017, 0.006, hi ? 5 : 3), KIND.head, 0, neck, COL.mand);
  }
  // antennae: scape (socket → elbow), funiculus, 3-segment club; pivot at the socket (the head moves them too)
  for (const [i, s] of [[0, 1], [1, -1]] as const) {
    const sock: V3 = [0.405, 0.232, 0.032 * s], elbow: V3 = [0.42, 0.33, 0.13 * s], f1: V3 = [0.5, 0.33, 0.18 * s], f2: V3 = [0.56, 0.305, 0.215 * s], tip: V3 = [0.61, 0.28, 0.24 * s];
    const reach = Math.hypot(tip[0] - sock[0], tip[1] - sock[1], tip[2] - sock[2]);
    add(rod(sock, elbow, 0.011, 0.012, R), KIND.antenna, i, sock, COL.leg, reach);
    if (hi) add(joint(elbow, 0.013, 6), KIND.antenna, i, sock, COL.leg, reach);
    add(rod(elbow, f1, 0.009, 0.01, R), KIND.antenna, i, sock, COL.leg, reach);
    add(rod(f1, f2, 0.011, 0.016, R), KIND.antenna, i, sock, COL.club, reach);
    add(rod(f2, tip, 0.017, 0.012, R), KIND.antenna, i, sock, COL.club, reach);
  }
  // legs: index 0..2 on +z (fore, mid, hind), 3..5 on −z
  for (const [side, base] of [[1, 0], [-1, 3]] as const) {
    LEGS.forEach((L, k) => {
      const hip = zs(L.hip, side), knee = zs(L.knee, side), foot = zs(L.foot, side), tip = zs(L.tip, side), idx = base + k;
      const reach = Math.hypot(tip[0] - hip[0], tip[1] - hip[1], tip[2] - hip[2]);
      add(rod(hip, knee, 0.02, 0.017, R), KIND.leg, idx, hip, COL.leg, reach); // femur
      if (hi) add(joint(knee, 0.017, 6), KIND.leg, idx, hip, COL.leg, reach);
      add(rod(knee, foot, 0.014, 0.009, R), KIND.leg, idx, hip, COL.leg, reach); // tibia
      add(rod(foot, tip, 0.008, 0.005, hi ? 4 : 3), KIND.leg, idx, hip, COL.leg, reach); // tarsus
    });
  }
  const g = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p; }), false);
  if (!g) throw new Error('ant geometry merge failed');
  g.computeBoundingSphere();
  return g;
}

/** GLSL: the joint rig. Quasi-periodic noise from incommensurate frequencies (the sum never repeats exactly). */
const RIG = /* glsl */ `
attribute vec3 aPart;
attribute vec3 aPivot;
attribute vec4 aAnim;
uniform float uTime;
float qn(float t, float s) { return 0.5 * sin(t + s * 6.2831) + 0.3 * sin(t * 1.6180339 + s * 2.71828) + 0.2 * sin(t * 2.4142136 + s * 4.1231); }
mat3 rY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
// rigged position of p and the rotation applied to it (for the normal)
vec3 antRig(vec3 p, out mat3 R) {
  float kind = aPart.x, idx = aPart.y, w = aPart.z;
  float ph = aAnim.x, walk = aAnim.y, seed = aAnim.z, t = uTime;
  float act = aAnim.w * (0.55 + 0.45 * qn(t * 0.13, seed + 0.9));
  float still = 1.0 - walk;
  vec3 off = vec3(0.0, 0.006 * walk * sin(2.0 * ph) + 0.003 * act * still * qn(t * 0.7, seed + 0.3), 0.0);
  R = mat3(1.0);
  vec3 headPiv = vec3(0.245, 0.205, 0.0);
  mat3 Rh = rY(0.07 * act * qn(t * 0.55, seed + 0.11)) * rZ(0.05 * act * qn(t * 0.8, seed + 0.37) - 0.02 * walk);
  if (kind < 0.5) {
    return p + off;
  } else if (kind < 1.5) {
    R = Rh; return headPiv + Rh * (p - headPiv) + off;
  } else if (kind < 2.5) {
    R = rZ(0.045 * act * qn(t * 0.35, seed + 0.5) - 0.03 * walk * sin(2.0 * ph));
    return aPivot + R * (p - aPivot) + off;
  } else if (kind < 3.5) {
    float side = idx < 2.5 ? 1.0 : -1.0;
    float pair = mod(idx, 3.0);
    float grp = abs(pair - 1.0) < 0.5 ? (side > 0.0 ? 1.0 : 0.0) : (side > 0.0 ? 0.0 : 1.0);
    float lp = ph + grp * 3.14159265;
    float ang = side * (0.42 * walk * sin(lp) + 0.06 * act * still * qn(t * 0.23, seed + idx * 0.173));
    R = rY(ang);
    vec3 q = aPivot + R * (p - aPivot);
    q.y += w * (0.09 * walk * max(0.0, cos(lp)) + 0.02 * act * still * max(0.0, qn(t * 0.31, seed + idx * 0.29) - 0.55));
    return q + off;
  } else {
    float side = idx < 0.5 ? 1.0 : -1.0;
    mat3 Ra = rY(side * (0.24 * act * qn(t * 1.3, seed + idx * 0.43) + 0.12 * walk * sin(ph * 0.5))) * rZ(0.2 * act * qn(t * 0.97, seed + idx * 0.71 + 0.2) - 0.05 * walk);
    R = Rh * Ra;
    vec3 q = aPivot + Ra * (p - aPivot);
    return headPiv + Rh * (q - headPiv) + off;
  }
}
`;

/** standard PBR material (glossy cuticle) with the rig injected; uTime is shared so it can be frozen while paused */
export function antMaterial(uTime: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.05 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = RIG + sh.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  mat3 antR; vec3 antP = antRig(position, antR);\n  objectNormal = antR * objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = antP;');
  };
  m.customProgramCacheKey = () => 'antempire-ant-rig-v1';
  return m;
}

/**
 * One level of detail of the ant swarm: InstancedMesh + its per-instance animation attribute (aAnim).
 * Callers write instanceMatrix / instanceColor / aAnim and set .count each frame.
 */
export class AntLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly anim: THREE.InstancedBufferAttribute;
  constructor(level: 'hi' | 'lo', capacity: number, mat: THREE.Material) {
    const g = buildAntGeometry(level);
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aAnim', this.anim);
    this.mesh = new THREE.InstancedMesh(g, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move every frame; bounds are the whole garden
    this.mesh.count = 0;
  }
  get triangles(): number { const g = this.mesh.geometry; return (g.index ? g.index.count : g.attributes.position.count) / 3; }
}

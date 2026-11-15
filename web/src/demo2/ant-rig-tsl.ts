/**
 * Demo 2 — the ant joint rig as a TSL node graph, for the OPT-IN WebGPU renderer (three's WebGPURenderer ignores
 * onBeforeCompile, so the GLSL rig of ant-rig.ts cannot run there). Display only.
 *
 * The same rig as RIG_GLSL in ant-rig.ts: the same per-vertex attributes (aPart: kind / index / reach; aPivot), the
 * same per-instance attributes (aAnim: gait phase, walk weight, seed, activity; aPose: crop, head pitch, antenna
 * raise, crouch), the same formulas, and EVERY number from rig-params.ts — there is no second set of constants.
 * The CPU side (gait.ts, the display director) is not touched by the choice of renderer.
 * The three modules are passed in (loaded only when ?renderer=webgpu asks for them).
 */
import type * as WebGPU from 'three/webgpu';
import type * as TSLNS from 'three/tsl';
import { RIG, CUTICLE } from './rig-params.ts';

// TSL nodes are dynamically typed graph objects; their generated TypeScript types do not compose across operators
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
export interface RigNodeMaterial { material: WebGPU.MeshStandardNodeMaterial; setTime(t: number): void }

export function rigNodeMaterial(G: typeof WebGPU, T: typeof TSLNS): RigNodeMaterial {
  const { attribute, uniform, float, vec3, sin, cos, mod, abs, max, select, cross, Fn, positionLocal, normalLocal, positionGeometry, normalGeometry } = T as unknown as Record<string, N>, K = RIG;
  const uTime = uniform(0);
  const aPart = attribute('aPart', 'vec3'), aPivot = attribute('aPivot', 'vec3'), aAnim = attribute('aAnim', 'vec4'), aPose = attribute('aPose', 'vec4');
  const aXf = attribute('aXf', 'vec4'), aScl = attribute('aScl', 'float');
  // rotate a model-space vector into instance space (unit quaternion aXf; the same rotation as the instance matrix)
  const toInstance = (v: N): N => v.add(cross(aXf.xyz, cross(aXf.xyz, v).add(v.mul(aXf.w))).mul(2));
  type V = N;
  const qn = (t: N, s: N): N => sin(t.mul(K.qn.freq[0]).add(s.mul(K.qn.phase[0]))).mul(K.qn.amp[0]).add(sin(t.mul(K.qn.freq[1]).add(s.mul(K.qn.phase[1]))).mul(K.qn.amp[1])).add(sin(t.mul(K.qn.freq[2]).add(s.mul(K.qn.phase[2]))).mul(K.qn.amp[2])) as N;
  // the same rotations as rY / rZ of the GLSL rig, applied to a vector
  const rotY = (v: V, a: N): V => { const c = cos(a), s = sin(a); return vec3(c.mul(v.x).add(s.mul(v.z)), v.y, c.mul(v.z).sub(s.mul(v.x))); };
  const rotZ = (v: V, a: N): V => { const c = cos(a), s = sin(a); return vec3(c.mul(v.x).sub(s.mul(v.y)), s.mul(v.x).add(c.mul(v.y)), v.z); };

  const position = Fn(() => {
    const kind = aPart.x, idx = aPart.y, w = aPart.z, ph = aAnim.x, walk = aAnim.y, seed = aAnim.z, t = uTime;
    const crop = aPose.x, pitch = aPose.y, antUp = aPose.z, crouch = aPose.w;
    const act = aAnim.w.mul(float(K.act.base).add(qn(t.mul(K.act.freq) as N, seed.add(K.act.seed) as N).mul(K.act.mod))).toVar();
    const still = float(1).sub(walk), drop = crouch.mul(K.body.drop);
    const offY = walk.mul(K.body.bob).mul(sin(ph.mul(2))).add(act.mul(still).mul(K.body.idleBob).mul(qn(t.mul(K.body.idleFreq) as N, seed.add(K.body.idleSeed) as N))).sub(drop).toVar();
    const off = vec3(0, offY, 0), headPiv = vec3(K.headPivot[0], K.headPivot[1], K.headPivot[2]);
    const hY = act.mul(K.head.yaw).mul(qn(t.mul(K.head.yawFreq) as N, seed.add(K.head.yawSeed) as N)).toVar() as N;
    const hZ = act.mul(K.head.nod).mul(qn(t.mul(K.head.nodFreq) as N, seed.add(K.head.nodSeed) as N)).sub(walk.mul(K.head.walk)).sub(pitch).toVar() as N;
    const Rh = (v: V): V => rotY(rotZ(v, hZ), hY);
    // three's node pipeline has ALREADY applied the instance matrix to positionLocal / normalLocal here. The rig works in
    // model space on the raw geometry (positionGeometry / normalGeometry); the joint displacement is then carried into
    // instance space (rotation aXf, uniform scale aScl) and added to the instanced position.
    const p = vec3(positionGeometry), n = vec3(normalGeometry);
    // head
    const headP = headPiv.add(Rh(p.sub(headPiv) as V)).add(off), headN = Rh(n);
    // gaster (distended by the crop fill before it swings about the waist)
    const gA = act.mul(K.gaster.idle).mul(qn(t.mul(K.gaster.idleFreq) as N, seed.add(K.gaster.idleSeed) as N)).sub(walk.mul(K.gaster.walk).mul(sin(ph.mul(2)))).add(pitch.mul(K.gaster.pitch)).toVar() as N;
    const gD = p.sub(aPivot).mul(vec3(float(1).add(crop.mul(K.gaster.cropX)), float(1).add(crop.mul(K.gaster.cropYZ)), float(1).add(crop.mul(K.gaster.cropYZ))));
    const gasterP = aPivot.add(rotZ(gD as V, gA)).add(off), gasterN = rotZ(n, gA);
    // legs: alternating tripod; the foot lifts in swing; the feet stay planted while the body crouches
    const lSide = select(idx.lessThan(2.5), float(1), float(-1)), pair = mod(idx, 3);
    const grp = select(abs(pair.sub(1)).lessThan(0.5), select(lSide.greaterThan(0), float(1), float(0)), select(lSide.greaterThan(0), float(0), float(1)));
    const lp = ph.add(grp.mul(Math.PI)).toVar();
    const lA = lSide.mul(walk.mul(K.leg.swing).mul(sin(lp)).add(act.mul(still).mul(K.leg.idle).mul(qn(t.mul(K.leg.idleFreq) as N, seed.add(idx.mul(K.leg.idleSeed)) as N)))).toVar() as N;
    const lQ = aPivot.add(rotY(p.sub(aPivot) as V, lA));
    const lLift = w.mul(walk.mul(K.leg.lift).mul(max(0, cos(lp))).add(act.mul(still).mul(K.leg.idleLift).mul(max(0, qn(t.mul(K.leg.idleLiftFreq) as N, seed.add(idx.mul(K.leg.idleLiftSeed)) as N).sub(K.leg.idleGate))))).add(drop.mul(w));
    const legP = lQ.add(vec3(0, lLift, 0)).add(off), legN = rotY(n, lA);
    // antennae: about their socket, then with the head
    const aSide = select(idx.lessThan(0.5), float(1), float(-1));
    const aY = aSide.mul(act.mul(K.antenna.yaw).mul(qn(t.mul(K.antenna.yawFreq) as N, seed.add(idx.mul(K.antenna.yawSeed)) as N)).add(walk.mul(K.antenna.walkYaw).mul(sin(ph.mul(0.5))))).toVar() as N;
    const aZ = act.mul(K.antenna.nod).mul(qn(t.mul(K.antenna.nodFreq) as N, seed.add(idx.mul(K.antenna.nodSeed)).add(K.antenna.nodSeed0) as N)).sub(walk.mul(K.antenna.walkNod)).add(antUp.mul(K.antenna.up)).toVar() as N;
    const Ra = (v: V): V => rotY(rotZ(v, aZ), aY);
    const antQ = aPivot.add(Ra(p.sub(aPivot) as V)), antP = headPiv.add(Rh(antQ.sub(headPiv) as V)).add(off), antN = Rh(Ra(n));
    // pick by part kind: 0 body, 1 head, 2 gaster, 3 leg, 4 antenna
    const pick = (b: V, h: V, g: V, l: V, a: V): V => select(kind.lessThan(0.5), b, select(kind.lessThan(1.5), h, select(kind.lessThan(2.5), g, select(kind.lessThan(3.5), l, a)))) as V;
    normalLocal.assign(toInstance(pick(n, headN, gasterN, legN, antN)));
    const rigged = pick(p.add(off) as V, headP as V, gasterP as V, legP as V, antP as V);
    return positionLocal.add(toInstance(rigged.sub(p)).mul(aScl));
  });
  const material = new G.MeshStandardNodeMaterial({ vertexColors: true, ...CUTICLE });
  material.positionNode = position();
  return { material, setTime: (t) => { uTime.value = t; } };
}

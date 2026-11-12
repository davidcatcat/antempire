/**
 * KIN-2D prototype helpers (docs/physics-kinematics2d.md): candidate file loading, numeric integrators for comparison,
 * a fixed-step (sampled) contact detector for the Δt study, the scenarios, the comparison with the translation-only
 * models, and conversion of a run to the independent checker's record format. Prototype code: may use Node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { advancePose, capsuleAt, capGap, dimsOf, PlanBuilder, poseAt, runKinematics, staticCaps, type BodyDims, type KinInput, type KinResult, type Pose, type Static, type Track, type Twist } from '../../engine/physics/kinematics2d.ts';
import type { XRecord } from '../kinematics2d-check/check.ts';

export const CANDIDATES_PATH = 'scenarios/physics/kinematics2d-candidates.json';
export function loadCandidates(): any { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CANDIDATES_PATH), 'utf8')); }
/** body sizes come ONLY from the candidate file (which refers to the body-candidate file) */
export function bodies(): { L: number; widths: number[] } {
  const c = loadCandidates(), b = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scenarios/physics/pheidole-megacephala.body-candidates.json'), 'utf8'));
  const L = b.castes.minor.body_length_mm.value, widths = b.castes.minor.effective_collision_width_mm.candidate_range;
  if (L !== c.body.length_mm.value || JSON.stringify(widths) !== JSON.stringify(c.body.width_mm_candidates.values)) throw Error('candidate file out of sync with body candidates');
  return { L, widths };
}

// ---------------------------------------------------------------- numeric integrators (comparison only)
const rhs = (p: Pose, tw: Twist) => ({ x: tw.v * Math.cos(p.th) - tw.vl * Math.sin(p.th), y: tw.v * Math.sin(p.th) + tw.vl * Math.cos(p.th), th: tw.w });
export function integrate(p0: Pose, tw: Twist, T: number, dt: number, method: 'euler' | 'rk4'): Pose {
  const n = Math.round(T / dt), h = T / n; let p = { ...p0 };
  for (let i = 0; i < n; i++) {
    if (method === 'euler') { const k = rhs(p, tw); p = { x: p.x + h * k.x, y: p.y + h * k.y, th: p.th + h * k.th }; continue; }
    const k1 = rhs(p, tw), k2 = rhs({ x: p.x + (h / 2) * k1.x, y: p.y + (h / 2) * k1.y, th: p.th + (h / 2) * k1.th }, tw);
    const k3 = rhs({ x: p.x + (h / 2) * k2.x, y: p.y + (h / 2) * k2.y, th: p.th + (h / 2) * k2.th }, tw), k4 = rhs({ x: p.x + h * k3.x, y: p.y + h * k3.y, th: p.th + h * k3.th }, tw);
    p = { x: p.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x), y: p.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y), th: p.th + (h / 6) * (k1.th + 2 * k2.th + 2 * k3.th + k4.th) };
  }
  return p;
}

/** fixed-step detection: first sample time with gap ≤ 0 between a track and statics (null = missed: tunnelling) */
export function sampledFirstContact(tr: Track, statics: Static[], t0: number, t1: number, dt: number): number | null {
  const d = dimsOf(tr.body, tr.id), caps = statics.flatMap(staticCaps), n = Math.round((t1 - t0) / dt);
  for (let i = 0; i <= n; i++) { const t = t0 + (i * (t1 - t0)) / n, c = capsuleAt(poseAt(tr, t), d); if (caps.some((k) => capGap(c, k).g <= 0)) return t; }
  return null;
}
/** sampled minimum gap (diagnostic; lower-bounded by min − M·dt/2) of two pose functions with given capsules */
export function sampledMinGap(poseA: (t: number) => Pose, dA: { h: number; r: number }, poseB: (t: number) => Pose, dB: { h: number; r: number }, t0: number, t1: number, n: number): number {
  let g = Infinity;
  for (let i = 0; i <= n; i++) { const t = t0 + ((t1 - t0) * i) / n; g = Math.min(g, capGap(capsuleAt(poseA(t), dA), capsuleAt(poseB(t), dB)).g); }
  return g;
}

export function toRecord(input: KinInput, res: KinResult): XRecord {
  const bodies: XRecord['bodies'] = {};
  for (const [id, e] of Object.entries(res.executed)) bodies[id] = { body: e.body, segs: e.segs.map((s) => ({ t0: s.t0, t1: s.t1, p0: s.p0, tw: s.tw })) };
  const layers: Record<string, string> = {};
  for (const t of input.tracks) layers[t.id] = t.layer ?? '';
  for (const s of input.statics) layers[s.id] = s.layer ?? '';
  return { horizon_s: input.horizon_s, bodies, statics: input.statics as XRecord['statics'], events: res.events, layers };
}

export const corridor = (W: number, x0 = -20, x1 = 20): Static[] => [
  { id: 'wall-lo', kind: 'segment', a: { x: x0, y: -W / 2 }, b: { x: x1, y: -W / 2 } },
  { id: 'wall-hi', kind: 'segment', a: { x: x0, y: W / 2 }, b: { x: x1, y: W / 2 } },
];
export const pivotTrack = (id: string, body: BodyDims, start: Pose, dth: number, w: number): Track => new PlanBuilder(id, body, start).pivot(dth, w).build();
export { advancePose, runKinematics };

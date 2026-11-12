/**
 * KIN-2D CONTACT-RESPONSE MODES (Owner decision 42; docs/physics-contact-constraint.md). ISOLATED: not imported by the
 * official pipeline (tests/physics-isolation.test.ts). kinematics2d.ts is NOT modified: its response (a body that does
 * not clearly separate is frozen until the horizon) stays the comparison BASELINE ('freeze', default). This module adds
 * an OPT-IN mode 'project' that follows the shared physical contact constraint contract (shared-contract.ts):
 *  - no penetration; for every touching pair the relative normal velocity must not compress the contact;
 *  - each body executes the constrained velocity closest to its commanded twist (projectVelocity, exact);
 *    sliding along a boundary is kept when feasible; no feasible direction → the body stops (v = vl = ω = 0);
 *  - no pushing: only a body whose own commanded motion closes the gap yields, and it yields to the other body's
 *    EXECUTED motion; if both close the gap, each removes its own closing part. No mass, no force, no behaviour.
 * Scope of the KIN-2D projection (stated, not hidden):
 *  - the projection variables are the TRANSLATIONAL body-frame velocities (v, vl); the commanded angular rate ω is kept
 *    (KIN-2D has no inertia or torque, so a contact cannot rotate a body). If no translation satisfies the constraints,
 *    the body stops completely.
 *  - the plan is a TIME-INDEXED command schedule (twist per time); a slowed body does not "make up" lost distance.
 *  - a constraint stays engaged from contact until the gap exceeds RELEASE_GAP_MM (numerical hysteresis, not a model
 *    parameter); while engaged its row is enforced (ġ ≥ 0).
 * Event timing: free pairs use conservative advancement exactly as kinematics2d.ts (no tunnelling). An engaged pair whose
 * two bodies both translate (ω = 0) has a CONVEX gap in time (distance between convex sets under linear motion), and the
 * projection makes its initial rate ≥ 0, so the gap is non-decreasing: its next event (contact_end at θ + ρ, release at
 * RELEASE_GAP_MM) is found by bisection on the closed form. An engaged pair with rotation uses conservative advancement
 * with the KIN-2D iteration cap; if the cap is reached both bodies are stopped and a solver_status event is recorded.
 * Pure, deterministic, independent of input array order (everything keyed by sorted ids). Units mm, s, rad.
 */
import { advancePose, twistAt, dimsOf, capsuleAt, capGap, staticCaps, runKinematics, Kin2DRefused, CONTACT_TOL_MM, CA_LEVEL_MM, CA_CONTACT_LEVEL_MM, SEP_RES_MM, CA_MAX_ITER, SAME_INSTANT, type KinInput, type KinResult, type Pose, type Twist, type Seg, type Cap, type P2, type Track, type BodyDims } from './kinematics2d.ts';
import { projectVelocity, type ConstraintRow, type ProjectionStatus } from './shared-contract.ts';

export type ContactMode = 'freeze' | 'project';
/** numerical hysteresis: an engaged constraint is released when the gap exceeds this (mm); not a model parameter */
export const RELEASE_GAP_MM = 1e-3;
/** numerical: a commanded normal speed above this (mm/s) counts as closing the gap */
export const CLOSING_TOL_MM_S = 1e-9;
/** numerical: an engaged translating pair with initial gap rate ≥ −this (mm/s) is treated as non-decreasing */
export const RATE_TOL_MM_S = 1e-10;
export const MAX_BATCHES = 1_000_000;

export interface ContactEvent {
  t_s: number;
  kind: 'contact_start' | 'contact_end' | 'constraint_release' | 'repress' | 'constrained' | 'stop_on_contact' | 'constraint_free' | 'solver_status';
  ids: string[]; class: 'physical_contact' | 'physical_constraint' | 'solver_status';
  bracket_s?: [number, number]; gap_mm?: number; detail?: string;
}
export interface ContactRunResult {
  mode: 'project'; events: ContactEvent[];
  /** executed motion (same shape as KinResult.executed; stopped_at_s = start of the final stop, if the body ends stopped by a constraint) */
  executed: Record<string, { body: BodyDims; segs: Seg[]; stopped_at_s: number | null; stop_cause: string | null }>;
  final: Record<string, Pose>;
  stats: { batches: number; projections: number; ca_iterations: number; exact_bisections: number; mutual_pairs: number; no_push_redos: number; solver_caps: number };
}
export function runKinematicsWithContactMode(input: KinInput, mode: 'freeze'): KinResult;
export function runKinematicsWithContactMode(input: KinInput, mode: 'project'): ContactRunResult;
export function runKinematicsWithContactMode(input: KinInput, mode: ContactMode): KinResult | ContactRunResult {
  if (mode === 'freeze') return runKinematics(input); // baseline: the unchanged KIN-2D response
  if (mode === 'project') return runProjected(input);
  throw new Kin2DRefused(`unknown contact mode ${String(mode)}`);
}

// ---------------------------------------------------------------- internals
interface Body { id: string; tr: Track; d: { h: number; r: number }; layer: string; pose: Pose; tw: Twist; segs: Seg[]; segFrom: number; status: 'free' | 'constrained' | 'stopped'; blockedUntil: number; cause: string | null; stopSince: number | null }
interface Elem { id: string; sid: string; cap: Cap; layer: string }
interface Pair { key: string; A: Body; B: Body | null; E: Elem | null; group: string; engaged: boolean; touching: boolean; lastLe: number | null }
const ZERO: Twist = { v: 0, vl: 0, w: 0 };
const cmdAt = (b: Body, t: number): Twist => (t < b.tr.segs[0].t0 ? ZERO : twistAt(b.tr, t));
const poseAtB = (b: Body, now: number, t: number): Pose => advancePose(b.pose, b.tw, t - now);
const boundB = (b: Body): number => Math.hypot(b.tw.v, b.tw.vl) + Math.abs(b.tw.w) * b.d.h;
/** world velocity of a material point p of body b with pose `pose` and twist tw */
function pointVel(pose: Pose, tw: Twist, p: P2): P2 {
  const c = Math.cos(pose.th), s = Math.sin(pose.th), rx = p.x - pose.x, ry = p.y - pose.y;
  return { x: c * tw.v - s * tw.vl - tw.w * ry, y: s * tw.v + c * tw.vl + tw.w * rx };
}
function nextBreak(b: Body, t: number): number {
  const S = b.tr.segs; if (t < S[0].t0) return S[0].t0;
  for (const s of S) if (s.t0 > t) return s.t0;
  return Infinity;
}

function runProjected(input: KinInput): ContactRunResult {
  const H = input.horizon_s;
  if (!(H >= 0) || !Number.isFinite(H)) throw new Kin2DRefused('bad horizon');
  if (input.tracks.length === 0) throw new Kin2DRefused('no tracks');
  const ids = input.tracks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new Kin2DRefused('duplicate track id');
  const sids = input.statics.map((s) => s.id);
  if (new Set(sids).size !== sids.length || sids.some((s) => ids.includes(s))) throw new Kin2DRefused('duplicate static id');
  const t0 = Math.min(...input.tracks.map((t) => (t.segs.length ? t.segs[0].t0 : Infinity)));
  const bodies: Body[] = [...input.tracks].sort((a, b) => (a.id < b.id ? -1 : 1)).map((tr) => {
    if (tr.segs.length === 0) throw new Kin2DRefused(`${tr.id}: empty plan`);
    for (let i = 1; i < tr.segs.length; i++) if (tr.segs[i].t0 !== tr.segs[i - 1].t1) throw new Kin2DRefused(`${tr.id}: segments not contiguous`);
    return { id: tr.id, tr, d: dimsOf(tr.body, tr.id), layer: tr.layer ?? '', pose: { ...tr.segs[0].p0 }, tw: ZERO, segs: [], segFrom: t0, status: 'free', blockedUntil: -Infinity, cause: null, stopSince: null };
  });
  const elems: Elem[] = [...input.statics].sort((a, b) => (a.id < b.id ? -1 : 1)).flatMap((s) => staticCaps(s).map((cap, k) => ({ id: `${s.id}#${k}`, sid: s.id, cap, layer: s.layer ?? '' })));
  const pairs: Pair[] = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) if (bodies[i].layer === bodies[j].layer) pairs.push({ key: `${bodies[i].id}|${bodies[j].id}`, A: bodies[i], B: bodies[j], E: null, group: `${bodies[i].id}|${bodies[j].id}`, engaged: false, touching: false, lastLe: null });
    for (const e of elems) if (e.layer === bodies[i].layer) pairs.push({ key: `${bodies[i].id}|${e.id}`, A: bodies[i], B: null, E: e, group: bodies[i].id < e.sid ? `${bodies[i].id}|${e.sid}` : `${e.sid}|${bodies[i].id}`, engaged: false, touching: false, lastLe: null });
  }
  const events: ContactEvent[] = [];
  const stats = { batches: 0, projections: 0, ca_iterations: 0, exact_bisections: 0, mutual_pairs: 0, no_push_redos: 0, solver_caps: 0 };
  let now = t0;
  const capOf = (b: Body, t: number) => capsuleAt(poseAtB(b, now, t), b.d);
  const gapAt = (p: Pair, t: number) => capGap(capOf(p.A, t), p.B ? capOf(p.B, t) : (p.E as Elem).cap);
  const M = (p: Pair) => boundB(p.A) + (p.B ? boundB(p.B) : 0);
  // initial legality (no overlap, no body inside a polygon) — same rule as runKinematics
  for (const p of pairs) if (gapAt(p, now).g < -1e-9) throw new Kin2DRefused(`${p.key}: overlapping at start`);
  for (const s of input.statics) if (s.kind === 'polygon') for (const b of bodies) if (b.layer === (s.layer ?? '') && inPolygon(b.pose, s.pts)) throw new Kin2DRefused(`${b.id} starts inside polygon ${s.id}`);
  // touching groups (aggregated per body–static or body–body) for contact events
  const touchingGroups = new Set<string>();
  const groupIds = (p: Pair) => (p.B ? [p.A.id, p.B.id] : [p.A.id, (p.E as Elem).sid]).sort();
  const setTouching = (p: Pair, on: boolean, t: number, br: [number, number] | undefined, g: number) => {
    p.touching = on;
    const any = pairs.some((q) => q.group === p.group && q.touching);
    if (on && !touchingGroups.has(p.group)) { touchingGroups.add(p.group); events.push({ t_s: br ? br[1] : t, kind: 'contact_start', ids: groupIds(p), class: 'physical_contact', ...(br ? { bracket_s: br } : {}), gap_mm: g, detail: p.E ? `element ${p.E.id}` : undefined }); }
    if (!on && !any && touchingGroups.has(p.group)) { touchingGroups.delete(p.group); events.push({ t_s: br ? br[1] : t, kind: 'contact_end', ids: groupIds(p), class: 'physical_contact', ...(br ? { bracket_s: br } : {}), gap_mm: g }); }
  };
  // contacts that already touch at the start are engaged
  for (const p of pairs) { const g = gapAt(p, now).g; if (g <= CONTACT_TOL_MM) { p.engaged = true; setTouching(p, true, now, undefined, g); p.lastLe = now; } }

  // ---------------------------------------------------------------- projection (no-push ordering)
  const project = (t: number) => {
    const cmd = new Map(bodies.map((b) => [b.id, t < b.blockedUntil ? ZERO : cmdAt(b, t)]));
    const eng = pairs.filter((p) => p.engaged);
    const mutual = new Set<string>();
    for (let redo = 0; ; redo++) {
      // geometry of each engaged pair at t (pose already at t: now === t here)
      const geo = eng.map((p) => {
        const q = gapAt(p, t), dx = q.cB.x - q.cA.x, dy = q.cB.y - q.cA.y, n = Math.hypot(dx, dy);
        return { p, cA: q.cA, cB: q.cB, n: n > 0 ? { x: dx / n, y: dy / n } : null };
      });
      // yield relation from COMMANDED motion: A yields to B if A closes and B does not; both close → mutual
      const yieldsTo = new Map<string, { pair: Pair; other: Body | null; side: 'A' | 'B' }[]>();
      const add = (id: string, x: { pair: Pair; other: Body | null; side: 'A' | 'B' }) => { const l = yieldsTo.get(id) ?? []; l.push(x); yieldsTo.set(id, l); };
      const deps = new Map<string, Set<string>>(bodies.map((b) => [b.id, new Set<string>()]));
      for (const g of geo) {
        const p = g.p;
        if (!g.n) { mutual.add(p.key); }
        if (!p.B) { add(p.A.id, { pair: p, other: null, side: 'A' }); continue; }
        const vA = pointVel(p.A.pose, cmd.get(p.A.id) as Twist, g.cA), vB = pointVel(p.B.pose, cmd.get(p.B.id) as Twist, g.cB);
        const n = g.n ?? { x: 0, y: 0 }, cA = n.x * vA.x + n.y * vA.y, cB = -(n.x * vB.x + n.y * vB.y);
        const closeA = cA > CLOSING_TOL_MM_S, closeB = cB > CLOSING_TOL_MM_S;
        if (mutual.has(p.key) || closeA === closeB) { mutual.add(p.key); add(p.A.id, { pair: p, other: null, side: 'A' }); add(p.B.id, { pair: p, other: null, side: 'B' }); }
        else if (closeA) { add(p.A.id, { pair: p, other: p.B, side: 'A' }); (deps.get(p.A.id) as Set<string>).add(p.B.id); }
        else { add(p.B.id, { pair: p, other: p.A, side: 'B' }); (deps.get(p.B.id) as Set<string>).add(p.A.id); }
      }
      // topological order (Kahn, ties by id); bodies left in a cycle treat their cycle pairs as mutual (redo)
      const order: string[] = [], done = new Set<string>();
      for (;;) {
        const ready = bodies.filter((b) => !done.has(b.id) && [...(deps.get(b.id) as Set<string>)].every((d) => done.has(d)));
        if (!ready.length) break;
        for (const b of ready) { order.push(b.id); done.add(b.id); }
      }
      if (order.length < bodies.length) {
        const left = new Set(bodies.filter((b) => !done.has(b.id)).map((b) => b.id));
        for (const g of geo) if (g.p.B && left.has(g.p.A.id) && left.has(g.p.B.id)) mutual.add(g.p.key);
        stats.no_push_redos++; continue;
      }
      const exec = new Map<string, { tw: Twist; status: ProjectionStatus; active: string[] }>();
      for (const id of order) {
        const b = bodies.find((x) => x.id === id) as Body, c = cmd.get(id) as Twist, ys = yieldsTo.get(id) ?? [];
        if (!ys.length) { exec.set(id, { tw: c, status: 'free', active: [] }); continue; }
        const cs = Math.cos(b.pose.th), sn = Math.sin(b.pose.th), rows: ConstraintRow[] = [];
        for (const y of ys) {
          const g = geo.find((q) => q.p === y.pair) as (typeof geo)[number];
          if (!g.n) { rows.push({ id: y.pair.key, a: [0, 0], b: 1 }); continue; } // degenerate normal: infeasible → stop
          // outward normal from this body toward the other shape, and this body's / the other's contact points
          const n = y.side === 'A' ? g.n : { x: -g.n.x, y: -g.n.y }, pSelf = y.side === 'A' ? g.cA : g.cB, pOther = y.side === 'A' ? g.cB : g.cA;
          const r = { x: pSelf.x - b.pose.x, y: pSelf.y - b.pose.y }, rotPart = n.x * (-c.w * r.y) + n.y * (c.w * r.x);
          let otherN = 0;
          if (y.other) { const o = exec.get(y.other.id) as { tw: Twist }; const vo = pointVel(y.other.pose, o.tw, pOther); otherN = n.x * vo.x + n.y * vo.y; }
          // n·v_self(x) ≤ n·v_other  ⇔  −(n·R e_v) v − (n·R e_vl) vl ≥ rotPart − otherN
          rows.push({ id: y.pair.key, a: [-(n.x * cs + n.y * sn), -(-n.x * sn + n.y * cs)], b: rotPart - otherN });
        }
        stats.projections++;
        const pr = projectVelocity([c.v, c.vl], rows);
        if (pr.status === 'infeasible' || pr.status === 'too_many_rows') exec.set(id, { tw: ZERO, status: 'stopped', active: pr.active });
        else if (pr.status === 'stopped') exec.set(id, { tw: { v: 0, vl: 0, w: c.w }, status: c.w === 0 ? 'stopped' : 'constrained', active: pr.active });
        else exec.set(id, { tw: { v: pr.x[0], vl: pr.x[1], w: c.w }, status: pr.status, active: pr.active });
      }
      // verify no engaged pair compresses under executed twists; otherwise mark it mutual and redo
      let bad = false;
      for (const g of geo) {
        if (!g.n) continue;
        const ta = (exec.get(g.p.A.id) as { tw: Twist }).tw, va = pointVel(g.p.A.pose, ta, g.cA);
        const vb = g.p.B ? pointVel(g.p.B.pose, (exec.get(g.p.B.id) as { tw: Twist }).tw, g.cB) : { x: 0, y: 0 };
        const rate = g.n.x * (vb.x - va.x) + g.n.y * (vb.y - va.y);
        if (rate < -1e-9 && !mutual.has(g.p.key)) { mutual.add(g.p.key); bad = true; }
      }
      if (bad && redo < pairs.length + 2) { stats.no_push_redos++; continue; }
      if (bad) { for (const b of bodies) exec.set(b.id, { tw: ZERO, status: 'stopped', active: [] }); events.push({ t_s: t, kind: 'solver_status', ids: [], class: 'solver_status', detail: 'no-push ordering did not converge: all bodies stopped conservatively' }); }
      stats.mutual_pairs = Math.max(stats.mutual_pairs, mutual.size);
      for (const b of bodies) {
        const e = exec.get(b.id) as { tw: Twist; status: ProjectionStatus; active: string[] }, c = cmd.get(b.id) as Twist;
        const st: Body['status'] = e.status === 'free' ? 'free' : e.status === 'stopped' ? 'stopped' : 'constrained';
        if (st !== b.status) {
          const kind = st === 'free' ? 'constraint_free' : st === 'stopped' ? 'stop_on_contact' : 'constrained';
          events.push({ t_s: t, kind, ids: [b.id], class: 'physical_constraint', detail: st === 'free' ? undefined : `${e.active.join(',') || 'no feasible direction'}; cmd v=${c.v} vl=${c.vl} w=${c.w} → v=${e.tw.v} vl=${e.tw.vl} w=${e.tw.w}` });
          b.cause = st === 'free' ? null : e.active.join(',') || 'no feasible direction';
          b.stopSince = st === 'stopped' ? t : null;
        }
        b.status = st; b.tw = e.tw;
      }
      return;
    }
  };

  // ---------------------------------------------------------------- next event of a pair (from now, up to tLim)
  type Ev = { t: number; kind: 'touch' | 'end' | 'release' | 'repress' | 'cap'; g: number; prev: number };
  /** gap rate at t for a pair whose bodies both translate (world velocities constant) */
  const rateAt = (p: Pair, t: number): number => {
    const q = gapAt(p, t), dx = q.cB.x - q.cA.x, dy = q.cB.y - q.cA.y, n = Math.hypot(dx, dy);
    const va = pointVel(p.A.pose, p.A.tw, q.cA), vb = p.B ? pointVel(p.B.pose, p.B.tw, q.cB) : { x: 0, y: 0 };
    return n > 0 ? (dx * (vb.x - va.x) + dy * (vb.y - va.y)) / n : -Infinity;
  };
  const findEvent = (p: Pair, tLim: number): Ev | null => {
    const both0 = p.A.tw.w === 0 && (!p.B || p.B.tw.w === 0);
    if (!p.engaged && both0 && tLim > now) {
      // FREE pair, both translating: the gap is convex in t. Locate its minimum on [now, tLim] by bisection on the sign
      // of the (non-decreasing) rate, then the first crossing of θ on the decreasing branch (exact, no grazing stall).
      const g0 = gapAt(p, now).g;
      if (g0 <= CONTACT_TOL_MM) return { t: now, kind: 'touch', g: g0, prev: now };
      if (rateAt(p, now) >= 0) return null;
      let tm = tLim;
      if (rateAt(p, tLim) > 0) { let lo = now, hi = tLim; for (let k = 0; k < 200; k++) { const mid = lo + (hi - lo) / 2; if (!(mid > lo && mid < hi)) break; if (rateAt(p, mid) > 0) hi = mid; else lo = mid; } tm = hi; }
      if (gapAt(p, tm).g > CONTACT_TOL_MM) return null;
      let lo = now, hi = tm;
      for (let k = 0; k < 200; k++) { const mid = lo + (hi - lo) / 2; if (!(mid > lo && mid < hi)) break; if (gapAt(p, mid).g > CONTACT_TOL_MM) lo = mid; else hi = mid; }
      stats.exact_bisections++;
      return { t: hi, kind: 'touch', g: gapAt(p, hi).g, prev: lo };
    }
    if (p.engaged && both0) {
      // convex, non-decreasing gap: bisection for the first upward crossing of the next level
      const q = gapAt(p, now), dx = q.cB.x - q.cA.x, dy = q.cB.y - q.cA.y, n = Math.hypot(dx, dy);
      const va = pointVel(p.A.pose, p.A.tw, q.cA), vb = p.B ? pointVel(p.B.pose, p.B.tw, q.cB) : { x: 0, y: 0 };
      const rate = n > 0 ? (dx * (vb.x - va.x) + dy * (vb.y - va.y)) / n : -Infinity;
      if (rate >= -RATE_TOL_MM_S) {
        const up = p.touching ? CONTACT_TOL_MM + SEP_RES_MM : RELEASE_GAP_MM;
        if (!(tLim > now)) return null;
        const gL = gapAt(p, tLim).g;
        if (gL <= up) return null;
        let lo = now, hi = tLim;
        for (let k = 0; k < 200; k++) { const mid = lo + (hi - lo) / 2; if (!(mid > lo && mid < hi)) break; if (gapAt(p, mid).g > up) hi = mid; else lo = mid; }
        stats.exact_bisections++;
        return { t: hi, kind: p.touching ? 'end' : 'release', g: gapAt(p, hi).g, prev: lo };
      }
    }
    // conservative advancement (free pairs; engaged pairs with rotation)
    const low = p.engaged ? (p.touching ? CA_CONTACT_LEVEL_MM : CA_LEVEL_MM) : CA_LEVEL_MM;
    const press = CA_CONTACT_LEVEL_MM + (CA_LEVEL_MM - CA_CONTACT_LEVEL_MM) / 2;
    const Mv = M(p);
    let t = now, prev = now, iters = 0;
    for (;;) {
      if (t > tLim) return null;
      const g = gapAt(p, t).g;
      if (!p.engaged) { if (g <= CONTACT_TOL_MM) return { t, kind: 'touch', g, prev }; }
      else if (p.touching) { if (g <= CONTACT_TOL_MM) p.lastLe = t; if (t > now && g > CONTACT_TOL_MM + SEP_RES_MM) return { t, kind: 'end', g, prev }; if (t > now && g <= press) return { t, kind: 'repress', g, prev }; }
      else { if (g <= CONTACT_TOL_MM) return { t, kind: 'touch', g, prev }; if (g > RELEASE_GAP_MM) return { t, kind: 'release', g, prev }; }
      if (Mv === 0) return null;
      prev = t;
      let tn = t + Math.max(g - low, 0) / Mv;
      if (tn >= tLim) tn = tLim === t ? Infinity : tLim;
      if (!(tn > t) || ++iters > CA_MAX_ITER) { stats.ca_iterations += iters; return { t, kind: 'cap', g, prev }; }
      t = tn;
    }
  };

  project(now);
  for (;;) {
    if (++stats.batches > MAX_BATCHES) { events.push({ t_s: now, kind: 'solver_status', ids: [], class: 'solver_status', detail: 'batch cap reached' }); break; }
    const tLim = Math.min(H, ...bodies.map((b) => nextBreak(b, now)), ...bodies.map((b) => (b.blockedUntil > now ? b.blockedUntil : Infinity)));
    let T = tLim; const evs: { p: Pair; e: Ev }[] = [];
    for (const p of pairs) { const e = findEvent(p, tLim); if (e) { evs.push({ p, e }); if (e.t < T) T = e.t; } }
    // advance every body to T (closed form) and record the executed segment
    if (T > now) for (const b of bodies) { const p1 = poseAtB(b, now, T); b.segs.push({ t0: now, t1: T, p0: b.pose, tw: b.tw, label: b.status === 'free' ? 'cmd' : b.status }); b.pose = p1; }
    const prevNow = now; now = T;
    for (const { p, e } of evs.filter((x) => x.e.t <= T + SAME_INSTANT(T)).sort((a, b) => (a.p.key < b.p.key ? -1 : 1))) {
      if (e.kind === 'touch') {
        const lo = Math.max(prevNow, e.prev), gPrev = gapAt0(p, lo);
        const br: [number, number] | undefined = gPrev > CONTACT_TOL_MM && lo < e.t ? bisectExecuted(p, lo, e.t, CONTACT_TOL_MM) : undefined;
        p.engaged = true; setTouching(p, true, T, br, e.g); p.lastLe = T;
      } else if (e.kind === 'end') { const br = bisectExecuted(p, Math.max(prevNow, p.lastLe ?? e.prev), e.t, CONTACT_TOL_MM); setTouching(p, false, T, br, e.g); p.lastLe = null; }
      else if (e.kind === 'release') { p.engaged = false; events.push({ t_s: T, kind: 'constraint_release', ids: groupIds(p), class: 'physical_constraint', gap_mm: e.g, detail: p.E ? `element ${p.E.id}` : undefined }); }
      else if (e.kind === 'repress') events.push({ t_s: T, kind: 'repress', ids: groupIds(p), class: 'physical_constraint', gap_mm: e.g });
      else {
        stats.solver_caps++;
        for (const b of [p.A, ...(p.B ? [p.B] : [])]) b.blockedUntil = Math.min(H, nextBreak(b, T));
        events.push({ t_s: T, kind: 'solver_status', ids: groupIds(p), class: 'solver_status', gap_mm: e.g, detail: 'conservative advancement iteration limit in contact: bodies stopped until their next command change' });
      }
    }
    if (T >= H) break;
    project(now);
  }
  // executed record (segments merged only by construction; a final zero-length horizon is not added)
  const executed: ContactRunResult['executed'] = {}, final: Record<string, Pose> = {};
  for (const b of bodies) {
    const segs = b.segs.length ? b.segs : [{ t0: t0, t1: t0, p0: b.pose, tw: ZERO, label: 'hold' }];
    executed[b.id] = { body: b.tr.body, segs, stopped_at_s: b.status === 'stopped' ? b.stopSince : null, stop_cause: b.status === 'stopped' ? b.cause : null };
    final[b.id] = { ...b.pose };
  }
  const KIND = ['contact_end', 'constraint_release', 'contact_start', 'repress', 'solver_status', 'stop_on_contact', 'constrained', 'constraint_free'];
  events.sort((a, b) => a.t_s - b.t_s || KIND.indexOf(a.kind) - KIND.indexOf(b.kind) || (a.ids.join('|') < b.ids.join('|') ? -1 : a.ids.join('|') > b.ids.join('|') ? 1 : 0));
  return { mode: 'project', events, executed, final, stats };

  /** gap at an earlier time of the CURRENT executed interval (bodies already advanced to `now`) */
  function gapAt0(p: Pair, t: number): number { return capGap(capsuleAt(execPose(p.A, t), p.A.d), p.B ? capsuleAt(execPose(p.B, t), p.B.d) : (p.E as Elem).cap).g; }
  function execPose(b: Body, t: number): Pose { const s = b.segs[b.segs.length - 1]; return s && t >= s.t0 && t <= s.t1 ? advancePose(s.p0, s.tw, t - s.t0) : b.pose; }
  function bisectExecuted(p: Pair, lo: number, hi: number, level: number): [number, number] {
    if (!(hi > lo)) return [hi, hi];
    const gl = gapAt0(p, lo) - level;
    for (let k = 0; k < 200; k++) { const mid = lo + (hi - lo) / 2; if (!(mid > lo && mid < hi)) break; const gm = gapAt0(p, mid) - level; if ((gm > 0) === (gl > 0)) lo = mid; else hi = mid; }
    stats.exact_bisections++;
    return [lo, hi];
  }
}
function inPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside; }
  return inside;
}

/**
 * ONE judge for both solvers (Issue #101, docs/physics-2d-occupancy-contract.md §6). Uses the exact 2-D contract of
 * engine/physics/body2d.ts: capsule bodies (capsuleOf / capsuleGap), lane bands (capsuleInLane), the per-instant
 * contract checkOccupancy2D, and swept contact between instants (sweptCapsuleContact), so a contact that falls between
 * two recorded instants of a fixed-step run is FOUND, never reported as 0 because nothing was sampled there.
 *
 * Timeline: the union of every agent's own sample times (+ an optional dense grid). Between two consecutive timeline
 * instants every agent translates in a straight line at constant velocity (true for both trajectory sources, see traj.ts),
 * so the pair gap is a convex function of time on each piece (body2d.ts) and its minimum is found exactly by ternary search.
 * Tolerances are numerical, not model parameters: OCC_TOL_MM (overlap), CONTACT_TOL_MM (touching).
 */
import { type Capsule, capsuleOf, capsuleGap, capsuleInLane, checkOccupancy2D, sweptCapsuleContact, OCC_TOL_MM, type LaneBody } from '../../../engine/physics/body2d.ts';
import { gridPairs, usableWidth, type ReachDisc } from '../../../engine/physics/collision.ts';
import { pointSegment2D } from '../../../engine/physics/vec.ts';
import { segmentObstacleApproach } from '../../../engine/physics/geometry.ts';
import type { Scenario } from './spec.ts';
import { type Trajectory, type LaneFrame, laneFrames, posAt, project } from './traj.ts';

/** a body gap ≤ this counts as touching (mm); numerical, far below body size */
export const CONTACT_TOL_MM = 1e-6;
/** a second, coarse reporting threshold (mm): above the f32 position resolution of Rapier at coordinates ≤ 500 mm
 *  (ulp ≈ 3e-5 mm), so violations larger than this are not rounding. Reporting only; not a model parameter. */
export const COARSE_TOL_MM = 1e-3;

export interface JudgeOptions { dense_dt_s?: number | null; occupancy2d?: boolean }
export interface JudgeResult {
  instants: number; pieces: number; pair_checks: number;
  overlap_pair_instants: number; max_penetration_mm: number;
  overlap_between_instants: number; max_penetration_between_mm: number;
  body_contact_episodes: number; body_contacts_only_between_instants: number; first_body_contact_t_s: number | null;
  reach_contact_episodes: number; first_reach_contact_t_s: number | null;
  out_of_walkable_agent_instants: number; not_checked_agent_instants: number; junction_not_checked_agent_instants: number; max_out_of_walkable_mm: number; out_of_walkable_gt_coarse: number; overlap_pair_instants_gt_coarse: number; obstacle_violation_gt_coarse: number; coarse_tol_mm: number;
  /** overlapping pair-instants (same lane) where the usable width over the overlap is ≥ the two widths: a side-by-side
   *  layout would exist, the trajectory just has no lateral offset for it (the native 1-D case) */
  overlap_pair_instants_wide_section: number; overlap_between_instants_wide_section: number;
  obstacle_violation_agent_instants: number; max_obstacle_penetration_mm: number; obstacle_depth_note: string;
  max_abs_u_mm: number;
  occupancy2d: null | { instants: number; outside_lane: number; not_checked: number; overlap: number; note: string };
  arrivals: Record<string, number | null>;
  judge_wall_ms: number;
}

export function judge(sc: Scenario, tr: Trajectory, opts: JudgeOptions = {}): JudgeResult {
  const w0 = performance.now();
  const frames = laneFrames(sc), body = { length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value }, reach = sc.body.contact_reach_mm.value;
  const ids = Object.keys(tr.agents).sort(), A = ids.map((id) => tr.agents[id]);
  const T = new Set<number>([0, sc.horizon_s]);
  for (const a of A) for (const s of a.samples) if (s[0] >= 0 && s[0] <= sc.horizon_s) T.add(s[0]);
  if (opts.dense_dt_s) for (let k = 0; k * opts.dense_dt_s <= sc.horizon_s; k++) T.add(k * opts.dense_dt_s);
  const times = [...T].sort((x, y) => x - y);
  const hints = A.map(() => ({ i: 0 }));
  const capsAt = (t: number) => A.map((a, i) => { const p = posAt(a.samples, t, hints[i]); return { p, c: capsuleOf({ x: p.x, y: p.y, heading_rad: p.heading }, body) }; });
  const shift = (c: Capsule, dx: number, dy: number, tt: number): Capsule => ({ a: { x: c.a.x + dx * tt, y: c.a.y + dy * tt }, b: { x: c.b.x + dx * tt, y: c.b.y + dy * tt }, r: c.r });
  const r: JudgeResult = { instants: times.length, pieces: Math.max(0, times.length - 1), pair_checks: 0, overlap_pair_instants: 0, max_penetration_mm: 0, overlap_between_instants: 0, max_penetration_between_mm: 0, body_contact_episodes: 0, body_contacts_only_between_instants: 0, first_body_contact_t_s: null, reach_contact_episodes: 0, first_reach_contact_t_s: null, out_of_walkable_agent_instants: 0, not_checked_agent_instants: 0, junction_not_checked_agent_instants: 0, max_out_of_walkable_mm: 0, out_of_walkable_gt_coarse: 0, overlap_pair_instants_gt_coarse: 0, obstacle_violation_gt_coarse: 0, coarse_tol_mm: COARSE_TOL_MM, overlap_pair_instants_wide_section: 0, overlap_between_instants_wide_section: 0, obstacle_violation_agent_instants: 0, max_obstacle_penetration_mm: 0, obstacle_depth_note: 'circle: exact depth; polygon: a capsule whose axis touches or enters the polygon is reported with depth ≥ its radius (lower bound)', max_abs_u_mm: 0, occupancy2d: null, arrivals: Object.fromEntries(ids.map((id) => [id, tr.agents[id].arrival_t_s])), judge_wall_ms: 0 };
  const touching = new Set<string>(), reaching = new Set<string>();
  const lanesByLayer = new Map<string, LaneFrame[]>();
  for (const l of sc.lanes) { const list = lanesByLayer.get(l.layer) ?? []; list.push(frames.get(l.passage.id)!); lanesByLayer.set(l.layer, list); }
  const occ = opts.occupancy2d ? { instants: 0, outside_lane: 0, not_checked: 0, overlap: 0, note: 'checkOccupancy2D with each body in its OWN lane band and layer = level; at a crossing a body inside the other lane band is reported outside_lane by this contract' } : null;
  const maxR = body.length_mm / 2 + reach, passages = new Map(sc.lanes.map((l) => [l.passage.id, l.passage]));

  /** same lane, and the usable width (passage narrowed by obstacles, collision.usableWidth) over the pair's common
   *  along-lane extent is ≥ the two widths: a side-by-side layout exists there (checked at 21 points, like checkExclusion) */
  const wideAt = (i: number, j: number, pi: { x: number; y: number }, pj: { x: number; y: number }) => {
    if (A[i].lane !== A[j].lane) return false;
    const f = frames.get(A[i].lane)!, p = passages.get(A[i].lane)!, si = project(f, pi.x, pi.y).s, sj = project(f, pj.x, pj.y).s;
    const lo = Math.max(0, Math.max(si, sj) - body.length_mm / 2), hi = Math.min(f.length, Math.min(si, sj) + body.length_mm / 2);
    for (let q = 0; q <= 20; q++) if (usableWidth(sc.geometry, p, lo + ((hi - lo) * q) / 20) < 2 * body.width_mm - 1e-9) return false;
    return true;
  };
  let cur = capsAt(times[0]);
  for (let k = 0; k < times.length; k++) {
    const t0 = times[k];
    // ---- per-instant checks: lanes, obstacles, 2-D contract
    for (let i = 0; i < A.length; i++) {
      const c = cur[i].c, lanes = lanesByLayer.get(A[i].layer) ?? [];
      const res = lanes.map((f) => capsuleInLane(f.lane2, c));
      if (!res.some((x) => x.inside)) {
        // not wholly inside one band: if both axis-end discs lie in some band each, the body straddles a junction of bands
        // (union not proven by the straight-band contract) → not_checked; otherwise it is outside the walkable bands
        const discIn = (q: { x: number; y: number }) => lanes.some((f) => { const pr = project(f, q.x, q.y); return pr.s - c.r >= -OCC_TOL_MM && pr.s + c.r <= f.length + OCC_TOL_MM && Math.abs(pr.u) + c.r <= f.width / 2 + OCC_TOL_MM; });
        if (lanes.length > 1 && discIn(c.a) && discIn(c.b)) r.junction_not_checked_agent_instants++;
        else if (res.some((x) => x.checked)) {
          r.out_of_walkable_agent_instants++;
          const ex = Math.min(...lanes.map((f) => { const pa = project(f, c.a.x, c.a.y), pb = project(f, c.b.x, c.b.y); return Math.max(Math.abs(pa.u), Math.abs(pb.u)) + c.r - f.width / 2; }));
          r.max_out_of_walkable_mm = Math.max(r.max_out_of_walkable_mm, ex); if (ex > COARSE_TOL_MM) r.out_of_walkable_gt_coarse++;
        } else r.not_checked_agent_instants++;
      }
      const own = frames.get(A[i].lane)!, u = Math.abs(project(own, cur[i].p.x, cur[i].p.y).u); if (u > r.max_abs_u_mm) r.max_abs_u_mm = u;
      for (const o of sc.obstacles) {
        let g: number;
        if (o.shape.type === 'circle') g = pointSegment2D({ x: o.shape.center_mm[0], y: o.shape.center_mm[1] }, c.a, c.b).d - o.shape.radius_mm - c.r;
        else g = segmentObstacleApproach(o, c.a, c.b).d - c.r;
        if (g < -OCC_TOL_MM) { r.obstacle_violation_agent_instants++; if (-g > COARSE_TOL_MM) r.obstacle_violation_gt_coarse++; r.max_obstacle_penetration_mm = Math.max(r.max_obstacle_penetration_mm, -g); }
      }
    }
    if (occ) {
      const bodies: LaneBody[] = [];
      let bad = false;
      for (let i = 0; i < A.length; i++) { const f = frames.get(A[i].lane)!, q = project(f, cur[i].p.x, cur[i].p.y); if (q.s < 0 || q.s > f.length) { bad = true; break; } bodies.push({ id: ids[i], lane: A[i].lane, s_mm: q.s, u_mm: q.u, dir: Math.cos(cur[i].p.heading) * f.t.x + Math.sin(cur[i].p.heading) * f.t.y >= 0 ? 1 : -1, body, layer: A[i].layer }); }
      occ.instants++;
      if (bad) occ.not_checked++; else for (const v of checkOccupancy2D(sc.lanes.map((l) => frames.get(l.passage.id)!.lane2), bodies)) occ[v.kind]++;
    }
    const last = k === times.length - 1, t1 = last ? t0 : times[k + 1], dt = t1 - t0;
    const nxt = last ? cur : capsAt(t1);
    // ---- pairs: broadphase over discs covering the piece
    const discs: ReachDisc[] = A.map((_, i) => ({ id: String(i).padStart(6, '0'), x: (cur[i].p.x + nxt[i].p.x) / 2, y: (cur[i].p.y + nxt[i].p.y) / 2, r: maxR + Math.hypot(nxt[i].p.x - cur[i].p.x, nxt[i].p.y - cur[i].p.y) / 2 }));
    const pairs = A.length <= 24 ? (() => { const o: [string, string][] = []; for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) o.push([discs[i].id, discs[j].id]); return o; })() : gridPairs(discs, 4 * maxR);
    const seen = new Set<string>();
    for (const [pi, pj] of pairs) {
      const i = Number(pi), j = Number(pj);
      if (A[i].layer !== A[j].layer) continue;
      r.pair_checks++;
      const key = `${i}|${j}`; seen.add(key);
      const P = cur[i].c, Q = cur[j].c, g0 = capsuleGap(P, Q), g1 = capsuleGap(nxt[i].c, nxt[j].c);
      if (g0 < -OCC_TOL_MM) {
        r.overlap_pair_instants++; r.max_penetration_mm = Math.max(r.max_penetration_mm, -g0); if (-g0 > COARSE_TOL_MM) r.overlap_pair_instants_gt_coarse++;
        if (wideAt(i, j, cur[i].p, cur[j].p)) r.overlap_pair_instants_wide_section++;
      }
      let gmin = Math.min(g0, g1), tmin = g0 <= g1 ? 0 : dt;
      const vp = dt > 0 ? { x: (nxt[i].p.x - cur[i].p.x) / dt, y: (nxt[i].p.y - cur[i].p.y) / dt } : { x: 0, y: 0 }, vq = dt > 0 ? { x: (nxt[j].p.x - cur[j].p.x) / dt, y: (nxt[j].p.y - cur[j].p.y) / dt } : { x: 0, y: 0 };
      const rel = Math.hypot(vq.x - vp.x, vq.y - vp.y) * dt;
      // g(t) ≥ (g0 + g1 − rel)/2 on the piece (gap is 1-Lipschitz in the relative displacement): search the minimum
      // only when it could cross a threshold the endpoints have not already crossed
      const lb = (g0 + g1 - rel) / 2, k0 = `${i}|${j}`;
      const need = (lb < -OCC_TOL_MM && g0 >= -OCC_TOL_MM && g1 >= -OCC_TOL_MM) || (lb <= CONTACT_TOL_MM && g0 > CONTACT_TOL_MM && g1 > CONTACT_TOL_MM && !touching.has(k0)) || (lb <= reach && g0 > reach && g1 > reach && !reaching.has(k0));
      if (dt > 0 && rel > 0 && need) {
        let lo = 0, hi = dt; const g = (tt: number) => capsuleGap(shift(P, vp.x, vp.y, tt), shift(Q, vq.x, vq.y, tt));
        for (let it = 0; it < 80; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (g(m1) <= g(m2)) hi = m2; else lo = m1; }
        const gm = g((lo + hi) / 2); if (gm < gmin) { gmin = gm; tmin = (lo + hi) / 2; }
      }
      if (!last && g0 >= -OCC_TOL_MM && g1 >= -OCC_TOL_MM && gmin < -OCC_TOL_MM) {
        r.overlap_between_instants++; r.max_penetration_between_mm = Math.max(r.max_penetration_between_mm, -gmin);
        if (wideAt(i, j, { x: cur[i].p.x + vp.x * tmin, y: cur[i].p.y + vp.y * tmin }, { x: cur[j].p.x + vq.x * tmin, y: cur[j].p.y + vq.y * tmin })) r.overlap_between_instants_wide_section++;
      }
      // contact episodes (body touch, antennal reach), start times from swept contact
      if (gmin <= CONTACT_TOL_MM && !touching.has(key)) {
        r.body_contact_episodes++;
        if (g0 > CONTACT_TOL_MM && g1 > CONTACT_TOL_MM) r.body_contacts_only_between_instants++;
        const ts = g0 <= CONTACT_TOL_MM ? t0 : t0 + (sweptCapsuleContact(P, vp, Q, vq, dt, CONTACT_TOL_MM) ?? tmin);
        if (r.first_body_contact_t_s === null || ts < r.first_body_contact_t_s) r.first_body_contact_t_s = ts;
      }
      if (g1 <= CONTACT_TOL_MM) touching.add(key); else touching.delete(key);
      if (gmin <= reach && !reaching.has(key)) {
        r.reach_contact_episodes++;
        const inflate = (c: Capsule): Capsule => ({ ...c, r: c.r + reach / 2 });
        const ts = g0 <= reach ? t0 : t0 + (sweptCapsuleContact(inflate(P), vp, inflate(Q), vq, dt, CONTACT_TOL_MM) ?? tmin);
        if (r.first_reach_contact_t_s === null || ts < r.first_reach_contact_t_s) r.first_reach_contact_t_s = ts;
      }
      if (g1 <= reach) reaching.add(key); else reaching.delete(key);
    }
    // pairs that left the broadphase are no longer touching / in reach
    for (const key of [...touching]) if (!seen.has(key)) touching.delete(key);
    for (const key of [...reaching]) if (!seen.has(key)) reaching.delete(key);
    cur = nxt;
  }
  r.occupancy2d = occ;
  r.judge_wall_ms = performance.now() - w0;
  return r;
}

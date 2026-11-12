/**
 * Shared physical contact constraint contract (Owner decision 42; engine/physics/shared-contract.ts projectVelocity,
 * engine/physics/kinematics2d-contact.ts, docs/physics-contact-constraint.md). Blocking.
 *  - the reference projector is exact (KKT + optimality against random feasible points), deterministic and
 *    order-independent; the PH-3b 1-D follow rule is exactly this projection;
 *  - kinematics2d.ts is byte-identical (baseline kept); mode 'freeze' === runKinematics;
 *  - mode 'project': no penetration (independent sampled check with Lipschitz certification), constrained velocity never
 *    compresses a contact, sliding where feasible, stop where not, no pushing, no-contact runs equal the plan;
 *  - the comparison table in the document is reproduced verbatim. No assertion on biology: this is physics only.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { projectVelocity, laneFollowProjection, type ConstraintRow } from '../engine/physics/shared-contract.ts';
import { PlanBuilder, runKinematics, type KinInput, type Static } from '../engine/physics/kinematics2d.ts';
import { runKinematicsWithContactMode, RELEASE_GAP_MM, type ContactRunResult } from '../engine/physics/kinematics2d-contact.ts';
import { xPose, type XSeg } from '../prototypes/kinematics2d-check/check.ts';
import { contactModeTable, contactModeScenarios, runKin2DProjected, compare } from '../prototypes/physics-shared/compare.ts';
import { runBoth } from '../engine/physics/shared-contract.ts';
import { rng, hash32 } from '../engine/rng.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const json = (x: unknown) => JSON.stringify(x);
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

// ---------------------------------------------------------------- reference projector
{
  ok(projectVelocity([3, 4], [{ id: 'w', a: [0, -1], b: -10 }]).status === 'free', 'command that does not compress is unchanged');
  const sl = projectVelocity([10, 0], [{ id: 'w', a: [-Math.cos(0.3), -Math.sin(0.3)], b: 0 }]);
  ok(sl.status === 'constrained' && Math.abs(dot(sl.x, [Math.cos(0.3), Math.sin(0.3)])) < 1e-12 && sl.x[1] < 0, 'oblique contact: the tangential part is kept (slide)');
  const st = projectVelocity([10, 0], [{ id: 'w', a: [-1, 0], b: 0 }, { id: 'u', a: [0, -1], b: 0 }, { id: 'd', a: [0, 1], b: 0 }]);
  ok(st.status === 'stopped' && st.x.every((v) => v === 0), 'no feasible motion direction → stop');
  ok(projectVelocity([1, 1], [{ id: 'a', a: [1, 0], b: 1 }, { id: 'b', a: [-1, 0], b: 1 }]).status === 'infeasible', 'contradictory rows → infeasible (caller stops), never an approximation');
  ok(projectVelocity([1], Array.from({ length: 13 }, (_, i) => ({ id: `r${i}`, a: [-1], b: -0.5 + i * 1e-3 }))).status === 'too_many_rows', 'above the reference row cap: refused, not approximated');
  for (const [v, vL] of [[18.5, 10], [10, 18.5], [5, 0], [0, 3], [7, -1]]) ok(laneFollowProjection(v, vL) === Math.min(v, vL), `PH-3b 1-D follow rule = projection (v=${v}, v_leader=${vL})`);
  // exactness on random problems: KKT optimality vs random feasible points; order independence
  const R = rng(hash32('contact-projector-test'));
  let worst = 0;
  for (let k = 0; k < 300; k++) {
    const n = 2 + (k % 2), m = 1 + (k % 4), x0 = Array.from({ length: n }, () => 20 * R() - 10);
    const rows: ConstraintRow[] = Array.from({ length: m }, (_, i) => ({ id: `r${i}`, a: Array.from({ length: n }, () => 2 * R() - 1), b: -R() * 2 }));
    const p = projectVelocity(x0, rows), q = projectVelocity(x0, [...rows].reverse());
    ok(json(p) === json(q), `projector independent of row order (${k})`);
    ok(rows.every((r) => dot(r.a, p.x) >= r.b - 1e-9), `projection feasible (${k})`);
    const d0 = Math.hypot(...p.x.map((v, i) => v - x0[i]));
    for (let j = 0; j < 40; j++) {
      const y = Array.from({ length: n }, () => 30 * R() - 15);
      if (rows.every((r) => dot(r.a, y) >= r.b)) worst = Math.max(worst, d0 - Math.hypot(...y.map((v, i) => v - x0[i])));
    }
  }
  ok(worst <= 1e-9, `no random feasible point is closer than the projection (worst excess ${worst})`);
}

// ---------------------------------------------------------------- baseline untouched
{
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/kinematics2d.ts'))).digest('hex');
  ok(sha === '7225ee217b2e16456d320230444c3b12f64f83c87021c801b3db822d4adc2730', 'kinematics2d.ts byte-identical to PR #163/#167 (freeze response kept as baseline)');
  ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/solver2d.ts'))).digest('hex') === '6391856acb70dd49d3f0ed73e89339faaae8f7482a8f19109d6b67b4dcddda12', 'solver2d.ts (PH-3b) byte-identical to the PH-3b reference (main + #139; was 3726d1d5… before #139)');
}

// ---------------------------------------------------------------- independent non-penetration check (sampled + Lipschitz)
const body = { length_mm: 2.5, width_mm: 0.8 };
function segDist(p1: { x: number; y: number }, q1: { x: number; y: number }, p2: { x: number; y: number }, q2: { x: number; y: number }): number {
  const pd = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, u = L === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)); return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy); };
  const o = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const s1 = o(p1, q1, p2), s2 = o(p1, q1, q2), s3 = o(p2, q2, p1), s4 = o(p2, q2, q1);
  if (s1 * s2 < 0 && s3 * s4 < 0) return 0;
  return Math.min(pd(p1, p2, q2), pd(q1, p2, q2), pd(p2, p1, q1), pd(q2, p1, q1));
}
function independentCheck(input: KinInput, r: ContactRunResult): { minGap: number; violations: number; uncertified: number } {
  const h = (body.length_mm - body.width_mm) / 2, rad = body.width_mm / 2, H = input.horizon_s;
  const segOf = (id: string, t: number): XSeg => { const S = r.executed[id].segs; for (const s of S) if (t >= s.t0 && t <= s.t1) return s; return { ...S[S.length - 1], t0: S[S.length - 1].t1, tw: { v: 0, vl: 0, w: 0 }, p0: r.final[id] }; };
  const cap = (id: string, t: number) => { const p = xPose(segOf(id, t), t), c = Math.cos(p.th) * h, s = Math.sin(p.th) * h; return { a: { x: p.x - c, y: p.y - s }, b: { x: p.x + c, y: p.y + s } }; };
  const statCaps = (s: Static) => (s.kind === 'segment' ? [{ a: s.a, b: s.b, r: s.r ?? 0 }] : s.kind === 'disc' ? [{ a: s.c, b: s.c, r: s.r }] : s.pts.map((p, i) => ({ a: p, b: s.pts[(i + 1) % s.pts.length], r: 0 })));
  const ids = Object.keys(r.executed).sort();
  let minGap = Infinity, violations = 0, uncertified = 0;
  const cuts = [...new Set(ids.flatMap((id) => r.executed[id].segs.flatMap((s) => [s.t0, s.t1])).concat([H]))].filter((t) => t <= H).sort((a, b) => a - b);
  const speed = (id: string, t: number) => { const s = segOf(id, t); return Math.hypot(s.tw.v, s.tw.vl) + Math.abs(s.tw.w) * h; };
  const relSpeed = (a: string, b: string | null, t: number) => {
    const A = segOf(a, t), B = b ? segOf(b, t) : null;
    if (A.tw.w === 0 && (!B || B.tw.w === 0)) { const va = { x: Math.cos(A.p0.th) * A.tw.v - Math.sin(A.p0.th) * A.tw.vl, y: Math.sin(A.p0.th) * A.tw.v + Math.cos(A.p0.th) * A.tw.vl }, vb = B ? { x: Math.cos(B.p0.th) * B.tw.v - Math.sin(B.p0.th) * B.tw.vl, y: Math.sin(B.p0.th) * B.tw.v + Math.cos(B.p0.th) * B.tw.vl } : { x: 0, y: 0 }; return Math.hypot(va.x - vb.x, va.y - vb.y); }
    return speed(a, t) + (b ? speed(b, t) : 0);
  };
  const translating = (a: string, b: string | null, t: number) => segOf(a, t).tw.w === 0 && (!b || segOf(b, t).tw.w === 0);
  const check = (gap: (t: number) => number, a: string, b: string | null) => {
    for (let k = 0; k + 1 < cuts.length; k++) {
      const lo = cuts[k], hi = cuts[k + 1]; if (!(hi > lo)) continue;
      const mid = lo + (hi - lo) / 2;
      if (translating(a, b, mid)) {
        // constant velocities: the gap is convex on [lo, hi] → its minimum by ternary search (exact up to float)
        let l = lo, r = hi;
        for (let it = 0; it < 200; it++) { const m1 = l + (r - l) / 3, m2 = r - (r - l) / 3; if (gap(m1) <= gap(m2)) r = m2; else l = m1; }
        const g = Math.min(gap(lo), gap(hi), gap(l + (r - l) / 2)); minGap = Math.min(minGap, g); if (g < -1e-9) violations++;
        continue;
      }
      // rotation: Lipschitz-certified adaptive bisection (point-speed bound L)
      const L = relSpeed(a, b, mid);
      const cert = (l: number, r: number, gl: number, gr: number, depth: number): void => {
        minGap = Math.min(minGap, gl, gr);
        if (gl < -1e-9 || gr < -1e-9) { violations++; return; }
        if ((gl + gr) / 2 - (L * (r - l)) / 2 >= -1e-9) return;
        const m = l + (r - l) / 2; if (depth >= 80 || !(m > l && m < r)) { uncertified++; return; }
        const gm = gap(m); cert(l, m, gl, gm, depth + 1); cert(m, r, gm, gr, depth + 1);
      };
      cert(lo, hi, gap(lo), gap(hi), 0);
    }
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) check((t) => { const A = cap(ids[i], t), B = cap(ids[j], t); return segDist(A.a, A.b, B.a, B.b) - 2 * rad; }, ids[i], ids[j]);
    for (const s of input.statics) check((t) => { const A = cap(ids[i], t); return Math.min(...statCaps(s).map((c) => segDist(A.a, A.b, c.a, c.b) - rad - c.r)); }, ids[i], null);
  }
  return { minGap, violations, uncertified };
}
const run = (input: KinInput) => runKinematicsWithContactMode(input, 'project');
const vel = (r: ContactRunResult, id: string, t: number) => { for (const s of r.executed[id].segs) if (t >= s.t0 && t < s.t1) return { x: Math.cos(s.p0.th) * s.tw.v - Math.sin(s.p0.th) * s.tw.vl, y: Math.sin(s.p0.th) * s.tw.v + Math.cos(s.p0.th) * s.tw.vl, w: s.tw.w }; return { x: 0, y: 0, w: 0 }; };

const scen: Record<string, KinInput> = {
  'rear-end': { tracks: [new PlanBuilder('lead', body, { x: 20, y: 0, th: 0 }).straight(80, 10).build(), new PlanBuilder('follow', body, { x: 0, y: 0, th: 0 }).straight(180, 18.5).build()], statics: [], horizon_s: 10 },
  'head-on': { tracks: [new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(60, 18.5).build(), new PlanBuilder('b', body, { x: 60, y: 0, th: Math.PI }).straight(60, 15.5).build()], statics: [], horizon_s: 6 },
  'oblique-wall': { tracks: [new PlanBuilder('a', body, { x: 0, y: 0, th: 0.3 }).straight(40, 10).build()], statics: [{ id: 'wall', kind: 'segment', a: { x: -10, y: 5 }, b: { x: 100, y: 5 } }], horizon_s: 4 },
  'wall-pivot': { tracks: [new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(10, 10).pivot(Math.PI / 2, 2).straight(5, 10).build()], statics: [{ id: 'wall', kind: 'segment', a: { x: 5, y: -10 }, b: { x: 5, y: 10 } }], horizon_s: 3 },
  'disc': { tracks: [new PlanBuilder('a', body, { x: 0, y: 0.5, th: 0 }).straight(40, 10).build()], statics: [{ id: 'stone', kind: 'disc', c: { x: 15, y: 0 }, r: 2 }], horizon_s: 4 },
  'corner': { tracks: [new PlanBuilder('a', body, { x: 0, y: 0, th: 0.4 }).straight(40, 10).build()], statics: [{ id: 'box', kind: 'polygon', pts: [{ x: 6, y: -20 }, { x: 30, y: -20 }, { x: 30, y: 4 }, { x: 6, y: 4 }] }, { id: 'top', kind: 'segment', a: { x: -10, y: 4 }, b: { x: 6, y: 4 } }], horizon_s: 4 },
};
const results: Record<string, ContactRunResult> = {};
for (const [k, input] of Object.entries(scen)) {
  const r = run(input), r2 = run(input), rev = run({ ...input, tracks: [...input.tracks].reverse(), statics: [...input.statics].reverse() });
  results[k] = r;
  ok(json(r) === json(r2), `${k}: deterministic`);
  ok(json(r) === json(rev), `${k}: independent of input array order`);
  const c = independentCheck(input, r);
  ok(c.violations === 0 && c.uncertified === 0 && c.minGap >= -1e-9, `${k}: no penetration (independent sampled check; min gap ${c.minGap})`);
  ok(r.events.every((e) => e.kind !== 'solver_status'), `${k}: no solver status event`);
  ok(json(runKinematicsWithContactMode(input, 'freeze')) === json(runKinematics(input)), `${k}: mode 'freeze' is exactly the unchanged KIN-2D response`);
}
{ // rear-end: after contact the follower's executed speed equals the leader's (no compression), the leader is unaffected (no push)
  const r = results['rear-end'], t = 5;
  ok(Math.abs(vel(r, 'follow', t).x - 10) < 1e-12 && r.events.some((e) => e.kind === 'constrained' && e.ids[0] === 'follow'), 'rear-end: follower constrained to the leader speed (physical constraint)');
  const solo = run({ tracks: [scen['rear-end'].tracks[0]], statics: [], horizon_s: 10 });
  ok(json(solo.final.lead) === json(r.final.lead) && !r.events.some((e) => e.ids.length === 1 && e.ids[0] === 'lead' && e.kind !== 'contact_start'), 'rear-end: leader motion identical to its solo run (never pushed)');
  ok(r.events.some((e) => e.kind === 'stop_on_contact' && e.ids[0] === 'follow' && e.t_s === 8), 'rear-end: follower stops when the leader stops (no feasible forward direction)');
}
ok(results['head-on'].events.filter((e) => e.kind === 'stop_on_contact').length === 2, 'head-on: both close the gap → each removes its own closing part → both stop');
{ const r = results['oblique-wall'], v = vel(r, 'a', 2); ok(Math.abs(v.y) < 1e-9 && v.x > 0 && r.events.some((e) => e.kind === 'constrained'), 'oblique wall: slides along the wall (normal velocity 0, tangential kept)'); }
{ const r = results['wall-pivot']; ok(r.events.some((e) => e.kind === 'stop_on_contact') && r.events.some((e) => e.kind === 'constraint_release') && r.final.a.y > 4.9, 'head-on wall: stop; a commanded pivot away is feasible and the body continues'); }
{ const r = results['disc']; ok(r.final.a.x > 30 && r.events.filter((e) => e.kind === 'contact_start').length > 1, 'disc: slides around the stone (curved boundary: tangent pieces, gap ≤ release band)'); }
{ const r = results['corner']; ok(r.events.some((e) => e.kind === 'stop_on_contact'), 'concave corner (wall + box): no feasible direction → stop'); }
ok(RELEASE_GAP_MM === 1e-3, 'release band is the documented numerical constant');
{ // no contact: project mode reproduces the plan exactly
  const input: KinInput = { tracks: [new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).arc(10, 0.1, 10).straight(5, 10).build(), new PlanBuilder('b', body, { x: 0, y: 30, th: 0 }).straight(10, 5).build()], statics: [], horizon_s: 3 };
  const p = run(input), f = runKinematics(input);
  ok(json(p.final) === json(f.final) && p.events.length === 0, 'no contact: projected run equals the plan bit for bit');
}
// ---------------------------------------------------------------- shared comparison (PH-3b unchanged)
for (const x of contactModeScenarios()) {
  const c = compare(x.scenario, { kin2d: runKin2DProjected(x.scenario), ph3b: runBoth(x.scenario).ph3b });
  ok(x.expect_projected === 'agree' ? c.ok : !c.ok, `${x.id}: projected KIN-2D vs PH-3b ${x.expect_projected}`);
}
{
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/physics-contact-constraint.md'), 'utf8');
  ok(doc.includes(contactModeTable()), 'docs/physics-contact-constraint.md contains the contact-mode table verbatim (rerun node prototypes/physics-shared/compare.ts)');
}
console.log(JSON.stringify({ physics_contact_constraint: 'pass', checks }));

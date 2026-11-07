/**
 * PH-3a 2-D occupancy contract (engine/physics/body2d.ts; docs/physics-2d-occupancy-contract.md). Engineering checks of
 * exact geometry, not a validation of P. megacephala behaviour. Isolated: nothing here is used by the daily simulation.
 *  1. sizes: unknown or non-positive body sizes are refused (never defaulted);
 *  2. capsule gap = exact segment distance − radii: against dense brute-force sampling (2,000 random pairs), symmetric,
 *     translation-invariant;
 *  3. lane region (points within W/2 of the centerline, round joints, flat ends) containment is exact: on a straight band
 *     at the boundary; a collinear vertex changes nothing (Owner P2 counterexample: a body across it was rejected); bends
 *     against brute-force sampling on 400 random polyline lanes; a body past a lane end is not_checked (valid null), not a
 *     violation;
 *  4. lateral packing is exact with along-lane offsets (Owner P2 counterexample: two 0.8 mm bodies 2.3 mm apart fit in
 *     1.4 mm although Σw = 1.6 mm); Σw ≤ W only when all axes overlap; witnesses pass the contract and random search never
 *     beats an 'infeasible';
 *  5. P2-E (#107): the 12 × 8-style state the 1-D model accepts — three 0.8 mm bodies overlapping in arc length on a
 *     2.0 mm lane — fails the 2-D contract for EVERY lateral assignment (packing proof + 5,000 random layouts); two such
 *     bodies abreast at u = ±0.5 pass; bodies on different layers never interact;
 *  6. swept contact: analytic head-on time; a fast thin body is caught where 10 ms sampling tunnels through; grazing
 *     passes terminate (contact just below the clearance, none just above); never later than a contact found by fine
 *     sampling (500 random cases);
 *  7. determinism: input order does not change the violations.
 */
import assert from 'node:assert/strict';
import { capsuleOf, capsuleGap, capsulesOverlap, checkOccupancy2D, lateralPacking, sweptCapsuleContact, laneBodyPose, capsuleInLane, OCC_TOL_MM, type Capsule, type Lane2, type LaneBody } from '../engine/physics/body2d.ts';
import { rng } from '../engine/rng.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const r = rng(20261107);

// 1. sizes
for (const body of [{ length_mm: null, width_mm: 0.8 }, { length_mm: 2.5, width_mm: null }, { length_mm: 0, width_mm: 0.8 }, { length_mm: 2.5, width_mm: -1 }]) assert.throws(() => capsuleOf({ x: 0, y: 0, heading_rad: 0 }, body), /unknown or not positive/);
checks++;
const cap = capsuleOf({ x: 1, y: 2, heading_rad: Math.PI / 2 }, { length_mm: 2.5, width_mm: 0.8 });
ok(Math.abs(cap.r - 0.4) < 1e-15 && Math.abs(Math.hypot(cap.b.x - cap.a.x, cap.b.y - cap.a.y) - 1.7) < 1e-12 && Math.abs(cap.b.y - cap.a.y - 1.7) < 1e-12, 'capsule: axis length L − w along the heading, radius w/2');

// 2. exact gap vs brute force
const rand = (lo: number, hi: number) => lo + (hi - lo) * r();
const randCap = (): Capsule => capsuleOf({ x: rand(-5, 5), y: rand(-5, 5), heading_rad: rand(-Math.PI, Math.PI) }, { length_mm: rand(0.5, 4), width_mm: rand(0.2, 1.5) });
let worst = 0;
for (let k = 0; k < 2000; k++) {
  const p = randCap(), q = randCap(), N = 200;
  let brute = Infinity;
  for (let i = 0; i <= N; i++) { const a = { x: p.a.x + (p.b.x - p.a.x) * i / N, y: p.a.y + (p.b.y - p.a.y) * i / N }; for (let j = 0; j <= N; j++) { const b = { x: q.a.x + (q.b.x - q.a.x) * j / N, y: q.a.y + (q.b.y - q.a.y) * j / N }; brute = Math.min(brute, Math.hypot(a.x - b.x, a.y - b.y)); } }
  brute -= p.r + q.r;
  const exact = capsuleGap(p, q), seg = (Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) + Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y)) / N;
  // sampling can only over-estimate a positive distance; an intersection of the axes shows as gap = −(r_p + r_q)
  assert.ok(exact <= brute + 1e-12 && brute - exact <= seg + 1e-12, `gap ${exact} vs sampled ${brute} (sampling step ${seg})`);
  assert.ok(Math.abs(capsuleGap(q, p) - exact) <= 1e-12, 'symmetric (up to rounding of the segment-distance formula)');
  const dx = rand(-3, 3), dy = rand(-3, 3), sh = (c: Capsule): Capsule => ({ a: { x: c.a.x + dx, y: c.a.y + dy }, b: { x: c.b.x + dx, y: c.b.y + dy }, r: c.r });
  assert.ok(Math.abs(capsuleGap(sh(p), sh(q)) - exact) < 1e-9, 'translation invariant');
  worst = Math.max(worst, brute - exact);
}
ok(true, `2,000 random capsule pairs: exact gap ≤ sampled gap ≤ exact + sampling step (worst ${worst.toExponential(2)} mm); symmetric within 1e-12 mm; translation-invariant`); checks += 2000;

// 3. lanes
const lane = (W: number | null, pts: [number, number][] = [[0, 0], [100, 0]]): Lane2 => ({ id: 'P', centerline_mm: pts.map(([x, y]) => ({ x, y })), width_mm: W });
const B = (id: string, s: number, u: number, w = 0.8, layer?: string): LaneBody => ({ id, lane: 'P', s_mm: s, u_mm: u, dir: 1, body: { length_mm: 2.5, width_mm: w }, ...(layer ? { layer } : {}) });
const inL = (l: Lane2, b: LaneBody) => capsuleInLane(l, capsuleOf(laneBodyPose(l, b), b.body));
const L2 = lane(2.0);
ok(inL(L2, B('a', 10, 0.6)).inside === true, 'u = 0.6, r = 0.4 in a 2.0 mm band: inside (0.6 + 0.4 = 1.0)');
ok(inL(L2, B('a', 10, 0.61)).inside === false, 'u = 0.61: outside by 0.01 mm');
ok(capsuleInLane(lane(null), capsuleOf({ x: 10, y: 0, heading_rad: 0 }, { length_mm: 2.5, width_mm: 0.8 })).checked === false, 'unknown lane width: not checked, never accepted');
// Owner P2 counterexample: a collinear vertex at x = 5; a body centred on it was reported not_checked and counted as a violation
const split = lane(2.0, [[0, 0], [5, 0], [10, 0]]), whole = lane(2.0, [[0, 0], [10, 0]]);
{ const res = checkOccupancy2D([split], [B('a', 5, 0.5)]); ok(res.valid === true && res.violations.length === 0 && res.not_checked.length === 0, 'collinear vertex: a body across it at u = 0.5 is checked and legal (was rejected as not_checked)'); }
let agree = 0;
for (let k = 0; k < 2000; k++) { const b = B('a', rand(1.3, 8.7), rand(-0.7, 0.7)); assert.deepEqual(inL(split, b), inL(whole, b), 'a collinear vertex does not change containment'); agree++; }
ok(agree === 2000, '2,000 random bodies: a lane with a collinear vertex judges exactly as the unsplit lane');
// region membership, brute force, written independently: in a segment rectangle, or within W/2 of a vertex where the direction turns
const inRegionBF = (l: Lane2, p: { x: number; y: number }, tol: number) => {
  const c = l.centerline_mm, h = (l.width_mm as number) / 2;
  for (let i = 1; i < c.length; i++) { const a = c[i - 1], b = c[i], len = Math.hypot(b.x - a.x, b.y - a.y); if (!len) continue; const tx = (b.x - a.x) / len, ty = (b.y - a.y) / len, al = (p.x - a.x) * tx + (p.y - a.y) * ty, la = -(p.x - a.x) * ty + (p.y - a.y) * tx; if (al >= -tol && al <= len + tol && Math.abs(la) <= h + tol) return true; }
  for (let i = 1; i < c.length - 1; i++) { const u1 = { x: c[i].x - c[i - 1].x, y: c[i].y - c[i - 1].y }, u2 = { x: c[i + 1].x - c[i].x, y: c[i + 1].y - c[i].y }; if (Math.abs(u1.x * u2.y - u1.y * u2.x) <= 1e-12 * Math.hypot(u1.x, u1.y) * Math.hypot(u2.x, u2.y) && u1.x * u2.x + u1.y * u2.y > 0) continue; if (Math.hypot(p.x - c[i].x, p.y - c[i].y) <= h + tol) return true; }
  return false;
};
const capPoints = (c: Capsule, n: number) => { const out: { x: number; y: number }[] = []; const ax = c.b.x - c.a.x, ay = c.b.y - c.a.y; for (let i = 0; i <= n; i++) for (let k = 0; k < 4 * n; k++) for (const rr of [c.r, c.r / 2, 0]) { const th = (2 * Math.PI * k) / (4 * n); out.push({ x: c.a.x + (ax * i) / n + rr * Math.cos(th), y: c.a.y + (ay * i) / n + rr * Math.sin(th) }); } return out; };
{
  // bend [[0,0],[10,0],[10,10]], W = 2: a body at the corner along the first segment protrudes at the outer corner — exactly outside
  const bent = lane(2.0, [[0, 0], [10, 0], [10, 10]]), corner = inL(bent, B('a', 10, 0)), cc = capsuleOf(laneBodyPose(bent, B('a', 10, 0)), B('a', 10, 0).body);
  ok(corner.checked && !corner.inside && capPoints(cc, 40).some((q) => !inRegionBF(bent, q, 1e-9)), `a body across a right-angle bend that cuts outside the outer corner: checked, outside (${corner.why}); brute force agrees`);
  const res = checkOccupancy2D([bent], [B('a', 15, 0)]); ok(res.valid === true, 'a body within the second straight segment is checked and inside');
  const wide = lane(4.0, [[0, 0], [10, 0], [10, 10]]), inner = inL(wide, B('a', 10, 0.8));
  ok(inner.inside === true && capPoints(capsuleOf(laneBodyPose(wide, B('a', 10, 0.8)), B('a', 10, 0.8).body), 40).every((q) => inRegionBF(wide, q, 1e-9)), 'a body across a bend lying in the union of both bands and the joint: legal (was rejected as not_checked)');
}
let nIn = 0, nOut = 0;
for (let k = 0; k < 400; k++) {
  const nseg = 2 + Math.floor(r() * 3), pts: [number, number][] = [[0, 0]]; let ang = rand(-Math.PI, Math.PI);
  for (let i = 0; i < nseg; i++) { ang += rand(-2.6, 2.6); const len = rand(1.5, 8), [x, y] = pts[pts.length - 1]; pts.push([x + len * Math.cos(ang), y + len * Math.sin(ang)]); }
  const l = lane(rand(1, 3.5), pts), total = (() => { let t = 0; for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return t; })();
  if (total < 4) continue;
  for (let m = 0; m < 5; m++) {
    const b = B('a', rand(1.3, total - 1.3), rand(-1, 1) * ((l.width_mm as number) / 2)), c = capsuleOf(laneBodyPose(l, b), b.body), ex = capsuleInLane(l, c);
    const N = 30, step = Math.max(Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) / N, (2 * Math.PI * c.r) / (4 * N)), bf = capPoints(c, N).every((q) => inRegionBF(l, q, 1e-9));
    if (ex.inside) { assert.ok(bf, `exact inside but a sampled point is outside (lane ${JSON.stringify(pts)}, body s ${b.s_mm} u ${b.u_mm})`); nIn++; }
    else { const prot = Number(/protrudes ([0-9.e-]+)/.exec(ex.why ?? '')?.[1] ?? Infinity); assert.ok(!bf || prot <= step, `exact outside (${ex.why}) but sampling finds every point inside beyond the sampling step ${step}`); nOut++; }
  }
}
ok(nIn > 100 && nOut > 100, `random polyline lanes (2–4 segments, turns up to ±149°): ${nIn} inside / ${nOut} outside — exact inside ⇒ every sampled point inside; exact outside ⇒ sampling finds a point outside unless the protrusion is below the sampling step`);
{ const res = checkOccupancy2D([L2], [B('a', 0.5, 0)]); ok(res.valid === null && res.violations.length === 0 && res.not_checked.length === 1, 'a body extending past the lane start into the node: not_checked, valid null — not a violation'); }
{ const res = checkOccupancy2D([lane(null)], [B('a', 50, 0)]); ok(res.valid === null && res.violations.length === 0, 'unknown lane width: valid null, not accepted, not a violation'); }

// 4. packing (exact, with along-lane offsets)
const PI8 = (s: number, w = 0.8) => ({ s_mm: s, length_mm: 2.5, width_mm: w });
for (let k = 0; k < 500; k++) {
  const n = 1 + Math.floor(r() * 4), ws = Array.from({ length: n }, () => rand(0.3, 1.2)), W = rand(0.5, 4), pk = lateralPacking(ws.map((w) => PI8(50, w)), W);
  assert.equal(pk.feasible, ws.reduce((q, w) => q + w, 0) <= W + OCC_TOL_MM, 'all axes overlapping: packing feasible ⇔ Σw ≤ W');
  if (pk.feasible) assert.equal(checkOccupancy2D([lane(W)], ws.map((w, i) => B(`b${i}`, 50, pk.u![i], w))).valid, true, 'the packing witness passes the 2-D contract');
}
checks += 500;
{
  // Owner P2 counterexample to Σw ≤ W: axes 0.6 mm apart along the lane need only √(0.8² − 0.6²) = 0.529 mm laterally
  const pk = lateralPacking([PI8(50), PI8(52.3)], 1.4);
  ok(pk.feasible === true && checkOccupancy2D([lane(1.4)], [B('a', 50, pk.u![0]), B('b', 52.3, pk.u![1])]).valid === true, `two 0.8 mm bodies 2.3 mm apart in a 1.4 mm lane: feasible (Σw = 1.6 mm > W; witness u = ${pk.u!.map((x) => x.toFixed(4))}) and the witness is legal`);
  ok(lateralPacking([PI8(50), PI8(52.3)], 1.3).feasible === false, 'same pair in 1.3 mm: infeasible (|u| ≤ 0.25, separation ≤ 0.5 < 0.529)');
  ok(lateralPacking([PI8(50), PI8(52.5)], 0.8).feasible === true, 'axes 0.8 mm apart (= r + r): no lateral room needed — single file fits a 0.8 mm lane');
}
let pkF = 0, pkI = 0;
for (let k = 0; k < 300; k++) {
  const n = 2 + Math.floor(r() * 2), items = Array.from({ length: n }, () => PI8(50 + rand(0, 3.5), rand(0.4, 1))), W = rand(0.8, 2.6), pk = lateralPacking(items, W), Lw = lane(W);
  const lay = (u: number[]) => checkOccupancy2D([Lw], items.map((it, i) => ({ ...B(`b${i}`, it.s_mm, u[i], it.width_mm as number) })));
  if (pk.feasible) { assert.equal(lay(pk.u!).valid, true, 'feasible: the witness is legal'); pkF++; }
  else { for (let t = 0; t < 1500; t++) assert.notEqual(lay(items.map((it) => rand(-1, 1) * (W / 2 - (it.width_mm as number) / 2))).valid, true, 'infeasible: no random layout is legal'); pkI++; }
}
ok(pkF > 50 && pkI > 50, `300 random 2–3 body sets with along offsets: ${pkF} feasible (witness legal), ${pkI} infeasible (1,500 random layouts each, none legal)`);
ok(lateralPacking([PI8(50)], null).feasible === null && lateralPacking([{ s_mm: 0, length_mm: null, width_mm: 0.8 }], 2).feasible === null, 'unknown lane width or body size: packing unknown (null), not assumed');
ok(lateralPacking(Array.from({ length: 10 }, (_, i) => PI8(50 + i)), 5).feasible === null, 'n above the exhaustive limit: null with a reason, never a guess');

// 5. P2-E counterexample and controls
ok(lateralPacking([PI8(10), PI8(10.5), PI8(11)], 2.0).feasible === false, 'P2-E: three 0.8 mm bodies at s = 10, 10.5, 11 (axes overlap pairwise) need 2.4 mm > 2.0 mm (packing proof)');
let anyOk = 0;
for (let k = 0; k < 5000; k++) { const v = checkOccupancy2D([L2], [B('a', 10, rand(-0.6, 0.6)), B('b', 10.5, rand(-0.6, 0.6)), B('c', 11, rand(-0.6, 0.6))]); if (v.valid === true) anyOk++; }
ok(anyOk === 0, 'P2-E: 5,000 random lateral layouts of the 1-D-accepted state (s = 10, 10.5, 11) — every one fails the 2-D contract');
ok(checkOccupancy2D([L2], [B('a', 10, -0.5), B('b', 10.5, 0.5)]).valid === true, 'two 0.8 mm bodies abreast at u = ±0.5 on 2.0 mm: valid');
ok(checkOccupancy2D([L2], [B('a', 10, 0), B('b', 10.5, 0)]).violations.some((v) => v.kind === 'overlap'), 'two bodies at the same u overlapping: overlap reported');
ok(checkOccupancy2D([L2], [B('a', 10, 0, 0.8, 'ground'), B('b', 10.5, 0, 0.8, 'leaf-above')]).valid === true, 'different layers (not the same collidable space): no interaction');

// 6. swept contact
const P = capsuleOf({ x: 0, y: 0, heading_rad: 0 }, { length_mm: 2.5, width_mm: 0.8 }), Q = capsuleOf({ x: 10, y: 0, heading_rad: Math.PI }, { length_mm: 2.5, width_mm: 0.8 });
const tHead = sweptCapsuleContact(P, { x: 17, y: 0 }, Q, { x: -17, y: 0 }, 10)!;
ok(Math.abs(tHead - (10 - 2.5) / 34) < 1e-12, `head-on: contact at (distance − L) / v_rel = ${(7.5 / 34).toFixed(6)} s (got ${tHead})`);
const thin = capsuleOf({ x: 0, y: 0, heading_rad: Math.PI / 2 }, { length_mm: 0.5, width_mm: 0.1 }), fast = { x: 1000, y: 0 }, wall = capsuleOf({ x: 5, y: 0, heading_rad: Math.PI / 2 }, { length_mm: 0.5, width_mm: 0.1 });
let sampledHit = false; for (let t = 0; t <= 0.02; t += 0.01) if (capsulesOverlap({ a: { x: thin.a.x + fast.x * t, y: thin.a.y }, b: { x: thin.b.x + fast.x * t, y: thin.b.y }, r: thin.r }, wall)) sampledHit = true;
const tFast = sweptCapsuleContact(thin, fast, wall, { x: 0, y: 0 }, 0.02);
ok(!sampledHit && tFast !== null && Math.abs(tFast - (5 - 0.1) / 1000) < 1e-12, `fast thin body: 10 ms sampling misses it (tunnelling); the swept test finds contact at ${tFast}`);
const passBy = (clear: number) => sweptCapsuleContact(P, { x: 17, y: 0 }, capsuleOf({ x: 10, y: 0.8 + clear, heading_rad: Math.PI }, { length_mm: 2.5, width_mm: 0.8 }), { x: -17, y: 0 }, 10);
ok(passBy(1e-6) === null && passBy(-1e-6) !== null, 'grazing pass: no contact 1e-6 mm clear, contact 1e-6 mm closer (terminates both ways)');
let checked = 0;
for (let k = 0; k < 500; k++) {
  const p = randCap(), q = randCap(), vp = { x: rand(-20, 20), y: rand(-20, 20) }, vq = { x: rand(-20, 20), y: rand(-20, 20) }, H = 1;
  if (capsuleGap(p, q) <= 0) continue;
  const tc = sweptCapsuleContact(p, vp, q, vq, H);
  const mv = (c: Capsule, v: { x: number; y: number }, t: number): Capsule => ({ a: { x: c.a.x + v.x * t, y: c.a.y + v.y * t }, b: { x: c.b.x + v.x * t, y: c.b.y + v.y * t }, r: c.r });
  let first: number | null = null; for (let i = 0; i <= 4000; i++) { const t = (H * i) / 4000; if (capsuleGap(mv(p, vp, t), mv(q, vq, t)) < -1e-6) { first = t; break; } }
  if (first !== null) assert.ok(tc !== null && tc <= first + 1e-12, `swept contact ${tc} is not later than sampled overlap ${first}`);
  if (tc !== null) assert.ok(capsuleGap(mv(p, vp, tc), mv(q, vq, tc)) <= OCC_TOL_MM + 1e-12, 'gap at the returned contact time ≤ tol');
  checked++;
}
ok(checked > 300, `${checked} random swept cases: never later than fine sampling, gap ≤ tol at the returned time`);

// 7. determinism
const bodies = [B('c', 30, 0.2), B('a', 30.4, -0.3), B('b', 31, 0.1), B('d', 60, 0)];
ok(JSON.stringify(checkOccupancy2D([lane(1.5)], bodies)) === JSON.stringify(checkOccupancy2D([lane(1.5)], [...bodies].reverse())), 'the result (violations and not_checked) does not depend on input order');
console.log(JSON.stringify({ passed: true, checks }));

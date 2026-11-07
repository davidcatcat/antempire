/**
 * PH-3a 2-D occupancy contract (engine/physics/body2d.ts; docs/physics-2d-occupancy-contract.md). Engineering checks of
 * exact geometry, not a validation of P. megacephala behaviour. Isolated: nothing here is used by the daily simulation.
 *  1. sizes: unknown or non-positive body sizes are refused (never defaulted);
 *  2. capsule gap = exact segment distance − radii: against dense brute-force sampling (2,000 random pairs), symmetric,
 *     translation-invariant;
 *  3. lane band containment is exact on straight segments; a body across a bend is 'not checked', never accepted;
 *  4. lateral packing: feasible ⇔ Σw ≤ W; the witness layout passes the 2-D contract;
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
const L2 = lane(2.0);
ok(capsuleInLane(L2, capsuleOf(laneBodyPose(L2, B('a', 10, 0.6)), B('a', 10, 0.6).body)).inside === true, 'u = 0.6, r = 0.4 in a 2.0 mm band: inside (0.6 + 0.4 = 1.0)');
ok(capsuleInLane(L2, capsuleOf(laneBodyPose(L2, B('a', 10, 0.61)), B('a', 10, 0.61).body)).inside === false, 'u = 0.61: outside by 0.01 mm');
ok(capsuleInLane(lane(null), capsuleOf({ x: 10, y: 0, heading_rad: 0 }, { length_mm: 2.5, width_mm: 0.8 })).checked === false, 'unknown lane width: not checked, never accepted');
const bent = lane(2.0, [[0, 0], [10, 0], [10, 10]]);
ok(checkOccupancy2D([bent], [{ ...B('a', 10, 0), lane: 'P' }]).some((v) => v.kind === 'not_checked'), 'a body across a bend is reported not_checked');
ok(checkOccupancy2D([bent], [{ ...B('a', 15, 0), lane: 'P' }]).length === 0, 'a body within the second straight segment is checked and inside');

// 4. packing
for (let k = 0; k < 500; k++) {
  const n = 1 + Math.floor(r() * 4), ws = Array.from({ length: n }, () => rand(0.3, 1.2)), W = rand(0.5, 4), pk = lateralPacking(ws, W);
  assert.equal(pk.feasible, ws.reduce((q, w) => q + w, 0) <= W + OCC_TOL_MM, 'packing feasible ⇔ Σw ≤ W');
  if (pk.feasible) assert.deepEqual(checkOccupancy2D([lane(W)], ws.map((w, i) => B(`b${i}`, 50, pk.u![i], w))), [], 'the packing witness passes the 2-D contract');
}
checks += 500;
ok(lateralPacking([0.8], null).feasible === null, 'unknown lane width: packing unknown (null), not assumed');

// 5. P2-E counterexample and controls
ok(lateralPacking([0.8, 0.8, 0.8], 2.0).feasible === false, 'P2-E: three 0.8 mm bodies need 2.4 mm > 2.0 mm (packing proof)');
let anyOk = 0;
for (let k = 0; k < 5000; k++) { const v = checkOccupancy2D([L2], [B('a', 10, rand(-0.6, 0.6)), B('b', 10.5, rand(-0.6, 0.6)), B('c', 11, rand(-0.6, 0.6))]); if (!v.length) anyOk++; }
ok(anyOk === 0, 'P2-E: 5,000 random lateral layouts of the 1-D-accepted state (s = 10, 10.5, 11) — every one fails the 2-D contract');
ok(checkOccupancy2D([L2], [B('a', 10, -0.5), B('b', 10.5, 0.5)]).length === 0, 'two 0.8 mm bodies abreast at u = ±0.5 on 2.0 mm: valid');
ok(checkOccupancy2D([L2], [B('a', 10, 0), B('b', 10.5, 0)]).some((v) => v.kind === 'overlap'), 'two bodies at the same u overlapping: overlap reported');
ok(checkOccupancy2D([L2], [B('a', 10, 0, 0.8, 'ground'), B('b', 10.5, 0, 0.8, 'leaf-above')]).length === 0, 'different layers (not the same collidable space): no interaction');

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
ok(JSON.stringify(checkOccupancy2D([lane(1.5)], bodies)) === JSON.stringify(checkOccupancy2D([lane(1.5)], [...bodies].reverse())), 'violations do not depend on input order');
console.log(JSON.stringify({ passed: true, checks }));

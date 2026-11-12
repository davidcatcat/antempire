/**
 * KIN-2D (Issue #157; docs/physics-kinematics2d.md): rigid capsule bodies with orientation, constant-twist arcs, turn in
 * place, conservative-advancement continuous collision including rotation. The module never grades itself: legality is
 * checked by the independent checker prototypes/kinematics2d-check/check.ts (imports nothing from engine/), plus
 * analytic solutions. Also: closed form vs RK4/Euler, Δt (fixed-step) comparison and tunnelling, determinism, input-order
 * invariance, horizon prefix, refusals, swept-occupancy bound, checker positive controls, document tables verbatim.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import * as K from '../engine/physics/kinematics2d.ts';
import { PlanBuilder, runKinematics, advancePose, poseAt, capsuleAt, dimsOf, sweptOccupancy, checkLimits, Kin2DRefused, type Static, type Track, type KinInput } from '../engine/physics/kinematics2d.ts';
import * as X from '../prototypes/kinematics2d-check/check.ts';
import { bodies, corridor, integrate, sampledFirstContact, toRecord } from '../prototypes/kinematics2d/lib.ts';
import { allTables } from '../prototypes/kinematics2d/measure.ts';
import { rng } from '../engine/rng.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const { L, widths } = bodies(), w = widths[1], BODY = { length_mm: L, width_mm: w }, h = (L - w) / 2, r = w / 2;
const json = (x: unknown) => JSON.stringify(x);

// ---- copied contract numbers equal the module's (the checker copies, never imports)
ok(X.CHECK_CONTACT_TOL_MM === K.CONTACT_TOL_MM && X.CHECK_CA_LEVEL_MM === K.CA_LEVEL_MM && X.CHECK_MISS_LEVEL_MM === K.CA_CONTACT_LEVEL_MM && X.CHECK_SEP_RES_MM === K.SEP_RES_MM, 'checker constants equal module constants');
ok(!/from\s+['"][^'"]*engine\//.test(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/kinematics2d-check/check.ts'), 'utf8')), 'checker imports nothing from engine/');
ok(!/kinematics2d|natural-walk/.test(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/solver2d.ts'), 'utf8')), 'solver2d.ts is untouched by KIN-2D');

// ---- closed form: vs RK4, vs the checker's independent formula, small-ω continuity
{
  const R = rng(157);
  let maxRk = 0, maxX = 0;
  for (let i = 0; i < 300; i++) {
    const p0 = { x: R() * 10 - 5, y: R() * 10 - 5, th: R() * 6 - 3 }, tw = { v: R() * 20, vl: R() * 4 - 2, w: (R() * 2 - 1) * (i % 3 === 0 ? 1e-7 : 10) }, T = R() * 2;
    const a = advancePose(p0, tw, T), b = integrate(p0, tw, T, 1e-3, 'rk4'), c = X.xPose({ t0: 0, t1: T, p0, tw }, T);
    maxRk = Math.max(maxRk, Math.hypot(a.x - b.x, a.y - b.y)); maxX = Math.max(maxX, Math.hypot(a.x - c.x, a.y - c.y), Math.abs(a.th - c.th));
  }
  ok(maxRk < 1e-8, `closed form = RK4 (dt 1e-3) within 1e-8 mm (max ${maxRk})`);
  ok(maxX < 1e-10, `closed form = independent checker formula within 1e-10 (max ${maxX})`);
  const s0 = advancePose({ x: 0, y: 0, th: 0 }, { v: 17, vl: 0, w: 0 }, 2), s1 = advancePose({ x: 0, y: 0, th: 0 }, { v: 17, vl: 0, w: 1e-12 }, 2);
  ok(Math.abs(s0.x - s1.x) < 1e-12 && Math.abs(s1.y - 17 * 1e-12 * 2) < 1e-15, 'ω → 0 continuous (no 0/0)');
  const e1 = Math.hypot(...(() => { const a = integrate({ x: 0, y: 0, th: 0 }, { v: 17, vl: 0, w: 3 }, 2, 0.01, 'euler'), x = advancePose({ x: 0, y: 0, th: 0 }, { v: 17, vl: 0, w: 3 }, 2); return [a.x - x.x, a.y - x.y]; })());
  const e2 = Math.hypot(...(() => { const a = integrate({ x: 0, y: 0, th: 0 }, { v: 17, vl: 0, w: 3 }, 2, 0.001, 'euler'), x = advancePose({ x: 0, y: 0, th: 0 }, { v: 17, vl: 0, w: 3 }, 2); return [a.x - x.x, a.y - x.y]; })());
  ok(Math.abs(Math.log10(e1 / e2) - 1) < 0.05, 'Euler converges at first order to the closed form');
}

// ---- U-turn by pivot in a corridor: analytic contact angle φc = asin((W/2 − r)/h)
for (const W of [1.6, 2.0, 2.4]) {
  const tr = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).pivot(Math.PI, 3).build(), input: KinInput = { tracks: [tr], statics: corridor(W), horizon_s: 2 };
  const res = runKinematics(input), st = res.executed.A.stopped_at_s as number, phi = Math.asin((W / 2 - r) / h);
  ok(st !== null && st * 3 <= phi && phi - st * 3 < 1e-6, `pivot in W=${W}: stops before and within 1e-6 rad of φc (${phi - st * 3})`);
  ok(res.events.some((e) => e.kind === 'contact_start') && res.events.some((e) => e.kind === 'stop_on_contact'), 'contact and stop recorded');
  const chk = X.checkRecord(toRecord(input, res)); ok(chk.violations.length === 0 && chk.uncertified === 0, `checker clean (${chk.violations[0] ?? ''})`);
}
{ const tr = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).pivot(Math.PI, 3).build(), res = runKinematics({ tracks: [tr], statics: corridor(L + 0.01), horizon_s: 2 }); ok(res.executed.A.stopped_at_s === null && Math.abs(res.final.A.th - Math.PI) < 1e-12, 'pivot completes when W > L'); }

// ---- head-on translation: exact contact time g0 / closing speed
{
  const gap0 = 5, A = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).straight(10, 17).build(), B = new PlanBuilder('B', BODY, { x: L + gap0, y: 0, th: Math.PI }).straight(10, 17).build();
  const res = runKinematics({ tracks: [A, B], statics: [], horizon_s: 2 }), c = res.events.find((e) => e.kind === 'contact_start') as K.KinEvent, tExact = gap0 / 34;
  ok(c && (c.bracket_s as [number, number])[0] <= tExact - K.CONTACT_TOL_MM / 34 + 1e-12 && Math.abs(c.t_s - (tExact - K.CONTACT_TOL_MM / 34)) < 1e-12, `θ-crossing bracket contains the exact time (${c?.t_s})`);
  const st = res.executed.A.stopped_at_s as number; ok(st >= c.t_s && tExact - st <= (K.CONTACT_TOL_MM - K.CA_LEVEL_MM) / 34 + 1e-12, 'stop between θ crossing and the λ bound');
}

// ---- random multi-body scenes: walls + discs + polygon, arcs/pivots/stops/sidesteps; independent checker
const randomScene = (seed: number): KinInput => {
  const R = rng(seed * 7919 + 13), box: Static[] = [
    { id: 'w0', kind: 'segment', a: { x: -12, y: -12 }, b: { x: 12, y: -12 } }, { id: 'w1', kind: 'segment', a: { x: 12, y: -12 }, b: { x: 12, y: 12 } },
    { id: 'w2', kind: 'segment', a: { x: 12, y: 12 }, b: { x: -12, y: 12 } }, { id: 'w3', kind: 'segment', a: { x: -12, y: 12 }, b: { x: -12, y: -12 } },
    { id: 'd0', kind: 'disc', c: { x: 0, y: 0 }, r: 1.2 }, { id: 'p0', kind: 'polygon', pts: [{ x: 5, y: 5 }, { x: 8, y: 5 }, { x: 7, y: 8 }] },
  ];
  const tracks: Track[] = [];
  const starts = [{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: -8, y: 8 }, { x: -3, y: 4 }, { x: 4, y: -3 }];
  for (let i = 0; i < 4; i++) {
    const b = new PlanBuilder(`ant${i}`, { length_mm: L, width_mm: widths[i % 2] }, { ...starts[(seed + i) % 5], th: R() * 6.28 }, R() * 0.2);
    for (let k = 0; k < 6; k++) {
      const u = R();
      if (u < 0.35) b.arc(2 + R() * 6, (R() * 2 - 1) * 0.8, 5 + R() * 15);
      else if (u < 0.55) b.pivot((R() * 2 - 1) * 3, 1 + R() * 9);
      else if (u < 0.7) b.stop(R() * 0.3);
      else if (u < 0.8) b.sidestep((R() * 2 - 1) * 2, 2 + R() * 5);
      else b.straight(2 + R() * 6, 5 + R() * 15);
    }
    tracks.push(b.build());
  }
  return { tracks, statics: box, horizon_s: 3 };
};
let contacts = 0, unc = 0, scenes = 0, refused = 0;
for (let seed = 1; seed <= 40; seed++) {
  const input = randomScene(seed);
  let res: K.KinResult;
  try { res = runKinematics(input); } catch (e) { if (e instanceof Kin2DRefused && /overlapping at start|inside polygon/.test(e.message)) { refused++; continue; } throw e; }
  scenes++;
  const chk = X.checkRecord(toRecord(input, res));
  ok(chk.violations.length === 0, `seed ${seed}: independent checker finds no penetration / missed contact / teleport (${chk.violations.slice(0, 2).join('; ')})`);
  unc += chk.uncertified; contacts += res.events.filter((e) => e.kind === 'contact_start').length;
  // input-order invariance
  const rev = runKinematics({ ...input, tracks: [...input.tracks].reverse(), statics: [...input.statics].reverse() });
  ok(json(rev) === json(res), `seed ${seed}: reversed input order gives identical result`);
  // horizon prefix
  const H1 = 1.3, pre = runKinematics({ ...input, horizon_s: H1 });
  ok(json(pre.events) === json(res.events.filter((e) => e.t_s <= H1 + K.TIME_TOL(H1) && !(e.kind === 'plan_segment' && e.t_s > H1 + K.TIME_TOL(H1)))), `seed ${seed}: events up to H1 are a prefix`);
  for (const id of Object.keys(pre.final)) { const a = pre.final[id], b = poseAt({ id, body: res.executed[id].body, segs: [...res.executed[id].segs, { t0: 3, t1: Infinity, p0: res.final[id], tw: { v: 0, vl: 0, w: 0 }, label: 'hold' }] }, H1); ok(a.x === b.x && a.y === b.y && a.th === b.th, `seed ${seed} ${id}: pose at H1 bit-identical in both runs`); }
}
ok(scenes >= 30 && contacts >= 20, `random scenes exercise contacts (${scenes} scenes, ${contacts} contacts, ${refused} refused starts)`);
ok(unc === 0, `no uncertified interval (${unc})`);
console.log(JSON.stringify({ random_scenes: scenes, contacts, refused_starts: refused, uncertified: unc }));

// ---- horizon: zero-length processed instant; float drift at H
{
  const tr = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }, 0.1).straight(0.2, 1).straight(1, 1).build(); // breakpoint 0.1 + 0.2 = 0.30000000000000004
  const res = runKinematics({ tracks: [tr], statics: [], horizon_s: 0.3 });
  ok(res.events.filter((e) => e.kind === 'plan_segment').length === 2, 'plan event at 0.1+0.2 counts as at H = 0.3');
  ok(Math.abs(res.final.A.x - 0.2) < 1e-15, 'no motion after H');
  const late = runKinematics({ tracks: [new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }, 1).straight(1, 1).build()], statics: [], horizon_s: 0.5 });
  ok(late.final.A.x === 0 && late.events.length === 0, 'start after H: no motion, no event');
}

// ---- refusals (unknowns never defaulted)
assert.throws(() => runKinematics({ tracks: [new PlanBuilder('A', { length_mm: L, width_mm: null }, { x: 0, y: 0, th: 0 }).straight(1, 1).build()], statics: [], horizon_s: 1 }), Kin2DRefused); checks++;
assert.throws(() => runKinematics({ tracks: [new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).build(), new PlanBuilder('B', BODY, { x: 1, y: 0, th: 0 }).build()], statics: [], horizon_s: 1 }), Kin2DRefused); checks++;
assert.throws(() => runKinematics({ tracks: [new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).build(), new PlanBuilder('A', BODY, { x: 9, y: 0, th: 0 }).build()], statics: [], horizon_s: 1 }), Kin2DRefused); checks++;
assert.throws(() => runKinematics({ tracks: [new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).build()], statics: [{ id: 'P', kind: 'polygon', pts: [{ x: -9, y: -9 }, { x: 9, y: -9 }, { x: 0, y: 9 }] }], horizon_s: 1 }), Kin2DRefused); checks++;
assert.throws(() => new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).pivot(1, 0), Kin2DRefused); checks++;

// ---- limits: unknown limits reported unchecked, never assumed
{
  const tr = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).straight(2, 17).arcAngle(1, 0.5, 17).pivot(1, 5).build();
  const c0 = checkLimits(tr, { max_speed_mm_s: null, max_turn_rate_rad_s: null, max_curvature_per_mm: null, pivot_allowed: null, max_accel_mm_s2: null, max_ang_accel_rad_s2: null });
  ok(c0.violations.length === 0 && c0.unchecked.some((u) => u.startsWith('max_accel_mm_s2')) && c0.unchecked.includes('pivot_allowed'), 'all-null limits: nothing assumed, acceleration reported as not modelled');
  const c1 = checkLimits(tr, { max_speed_mm_s: 17, max_turn_rate_rad_s: 10, max_curvature_per_mm: 0.8, pivot_allowed: false, max_accel_mm_s2: null, max_ang_accel_rad_s2: null });
  ok(c1.violations.some((v) => v.includes('curvature')) && c1.violations.some((v) => v.includes('turn rate')) && c1.violations.some((v) => v.includes('turn in place')), 'curvature, turn-rate and pivot limits are enforced when given');
}

// ---- swept occupancy: two-sided bound S ⊆ ∪caps ⊆ S ⊕ δ
{
  const tr = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).arcAngle(2, 1.5, 10).pivot(-2, 4).build(), d = dimsOf(BODY, 'A');
  const { caps, delta_mm } = sweptOccupancy(tr, 0, 0.8, 0.01), R = rng(5);
  ok(delta_mm <= 0.01, 'δ within the requested error');
  let outside = 0;
  for (let i = 0; i < 3000; i++) { const t = R() * 0.8, c = capsuleAt(poseAt(tr, t), d), u = R(), p = { x: c.a.x + u * (c.b.x - c.a.x), y: c.a.y + u * (c.b.y - c.a.y) }; if (!caps.some((k) => K.capGap({ a: p, b: p, r: 0 }, k).g <= c.r + 1e-12)) outside++; }
  ok(outside === 0, 'every swept core point (with its radius) lies in the bound');
}

// ---- tunnelling: fixed-step sampling misses a thin post that the continuous method catches
{
  const rho = h + r - 0.05, post: Static[] = [{ id: 'post', kind: 'disc', c: { x: rho * Math.SQRT1_2, y: rho * Math.SQRT1_2 }, r: 0.02 }];
  const tr = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).pivot(Math.PI / 2, 30).build();
  ok(sampledFirstContact(tr, post, 0, Math.PI / 60, 0.1) === null, 'fixed step Δt = 0.1 s tunnels through the post');
  ok(runKinematics({ tracks: [tr], statics: post, horizon_s: 1 }).executed.A.stopped_at_s !== null, 'conservative advancement does not');
}

// ---- checker positive controls
{
  const W = 2.0, tr = new PlanBuilder('A', BODY, { x: 0, y: 0, th: 0 }).pivot(Math.PI, 3).build(), input: KinInput = { tracks: [tr], statics: corridor(W), horizon_s: 2 }, res = runKinematics(input);
  const rec = toRecord(input, res);
  const noStop = { ...rec, bodies: { A: { body: BODY, segs: tr.segs.slice(0, -1).map((s) => ({ ...s, t1: Math.min(s.t1, 2) })).concat([{ t0: tr.segs[0].t1, t1: 2, p0: tr.segs[1].p0, tw: { v: 0, vl: 0, w: 0 }, label: 'stop' }]) } }, events: [] };
  ok(X.checkRecord(noStop).violations.some((v) => v.includes('penetration') || v.includes('missed')), 'positive control: rotating through the wall is caught');
  ok(X.checkRecord({ ...rec, events: rec.events.filter((e) => e.kind !== 'contact_start') }).violations.length > 0, 'positive control: a deleted contact_start is caught');
  const tele = JSON.parse(json(rec)); tele.bodies.A.segs[1].p0.x += 1e-6;
  ok(X.checkRecord(tele).violations.some((v) => v.includes('teleport')), 'positive control: a 1e-6 mm teleport is caught');
}

// ---- document tables verbatim
{
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/physics-kinematics2d.md'), 'utf8');
  for (const [k, t] of Object.entries(allTables())) ok(doc.includes(t), `docs/physics-kinematics2d.md contains the ${k} table verbatim (rerun node prototypes/kinematics2d/measure.ts)`);
}
console.log(JSON.stringify({ kin2d: 'pass', checks }));

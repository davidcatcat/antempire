/**
 * Regression tests for the four physics event/numerics defects listed in docs/physics-motion-engine.md §6.5 (second
 * independent review, 2026-11-05): PH-P1-A repeated yielding at a crossing, PH-P1-B tangent contact, PH-P2-B events just
 * after a window end handled early, PH-P2-C per-step position rounding. Each section first reproduces the defect's
 * symptom (it failed on main 6f37e1f; the failing output is recorded in the fix PR), then checks legal positive controls.
 *
 * Engineering evidence only: the physics layer is experimental, NOT connected to the daily simulation, and not a
 * verified causal source for anything. No result here validates P. megacephala behaviour.
 *
 * Sections are collected so that one run reports every failing section (the namespace import keeps the file loadable on
 * the old code, where discEncounter / releaseTime / SAME_INSTANT do not exist).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import type { PhysicsGeometry } from '../engine/physics/geometry.ts';
import * as K from '../engine/physics/kinematics.ts';
import * as Col from '../engine/physics/collision.ts';
import { rng } from '../engine/rng.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const X = Col as Any;
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const failures: string[] = [];
const section = (name: string, fn: () => void) => { try { fn(); console.error(`PASS ${name}`); } catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.error(`FAIL ${name}: ${String(e instanceof Error ? e.message : e).slice(0, 400)}`); } };

const dir = path.join(REPO_ROOT, 'scenarios/physics');
const geo = (n: string): PhysicsGeometry => JSON.parse(fs.readFileSync(path.join(dir, `${n}.geometry.json`), 'utf8'));
const cr = geo('crossing'), cor = geo('narrow-corridor');
const ENC: Col.EncounterRules = { priority: 'entry_yield', entry_yield_probability: 0.957, laden_yield_probability: 0.98, contact_pause_s: null, inside_turn_back_probability: 0.5 };
const EPS = Number.EPSILON;
const prov = { source: 'synthetic_scenario', assumption: true, basis: '遊戲假設', note: 'regression scene for PH-P1/P2 fixes' };
const scene = (passages: Any[], box: [number, number, number, number] = [-1000, -1000, 1000, 1000]): PhysicsGeometry => ({ schema: 'antempire.physics-geometry.v1', layer_of: 'antempire.world-geometry.v1', world_geometry_ref: null, world_id: 'synthetic-event-fixes', geometry_version: '0.1.0', synthetic: true, synthetic_note: 'regression scene', frame: { units: 'mm', axes: { x: 'east', y: 'north', z: 'up' }, origin: 'synthetic' }, obstacles: [], entrances: [],
  surfaces: [{ id: 'S', material: 'bare_soil', polygon_mm: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], elevation: { kind: 'flat', z_mm: 0 }, provenance: prov }], passages } as Any);
const lane = (id: string, pts: number[][]) => ({ id, centerline_mm: pts, width_mm: 20, route_edge_ref: null, provenance: prov });
const ant = (id: string, passage: string, s: number, o: Partial<Col.SimAgentSpec> & { reach?: number; L?: number } = {}): Col.SimAgentSpec => ({ id, passage, s_mm: s, dir: 1, start_t_s: 0, free_speed_mm_s: 10, goal_s_mm: 500, body: { length_mm: o.L ?? 2.5, width_mm: 0.8, contact_reach_mm: o.reach ?? 1 }, load: null, ...o });
const kinds = (r: Col.SimResult, k: string) => r.events.filter((e) => e.kind === k);
const exactSame = (a: Col.SimResult, b: Col.SimResult) => JSON.stringify(a.events) === JSON.stringify(b.events) && JSON.stringify(a.final) === JSON.stringify(b.final) && JSON.stringify(a.intervals) === JSON.stringify(b.intervals);
const consistent = (cfg: Col.SimConfig, r: Col.SimResult, why: string) => {
  ok(Col.checkExclusion(cfg, r, 0.01).length === 0, `${why}: no mutually exclusive positions`);
  const vmax = Math.max(...cfg.agents.map((a) => a.free_speed_mm_s));
  ok(cfg.agents.every((a) => K.checkTrajectory(cfg.geometry, r.intervals[a.id], vmax).length === 0), `${why}: trajectories continuous, |Δs| = v·Δt`);
};

// ---------------------------------------------------------------- PH-P1-A: repeated yielding at a crossing
section('PH-P1-A crossing yield', () => {
  // E walks east on y = 0, N walks north on x = 250, both from t = 0 at 10 mm/s: they meet at the crossing (250, 0).
  // Old code, reach 0: 1,474,059 steps, 312,500 yield_start events, then out of memory on the second seed.
  for (const reach of [0, 0.01, 0.1, 1]) for (const seed of [1, 2]) {
    const cfg: Col.SimConfig = { encounter: ENC, geometry: cr, agents: [ant('E', 'P-east-west', 0, { reach }), ant('N', 'P-north-south', 0, { reach })], horizon_s: 60, seed };
    const r = Col.simulate(cfg);
    ok(r.stats.steps <= 200, `reach ${reach} seed ${seed}: the meeting takes a bounded number of steps (${r.stats.steps} ≤ 200; old code at reach 0: 1,474,059)`);
    ok(kinds(r, 'yield_start').length === 1 && kinds(r, 'cross_wait').length <= 2, `reach ${reach} seed ${seed}: one press-and-back-off, at most two crossing waits (${kinds(r, 'yield_start').length} / ${kinds(r, 'cross_wait').length})`);
    ok(r.final.E.mode === 'arrived' && r.final.N.mode === 'arrived', `reach ${reach} seed ${seed}: both arrive`);
    consistent(cfg, r, `reach ${reach} seed ${seed}`);
    // the yielder really leaves the other's way: when it stands after backing off, its centre is ≥ C from the other's
    // (straight) lane line, so the other walks past without touching it again
    const y = kinds(r, 'yield_start')[0], hold = r.events.find((e) => e.kind === 'cross_wait' && e.agent === y.agent && e.t_s >= y.t_s && /backed off/.test(e.detail ?? ''))!;
    const s = K.stateAt(r.intervals[y.agent], hold.t_s)!.s_mm, q = K.positionAt(K.passageOf(cr, y.agent === 'E' ? 'P-east-west' : 'P-north-south'), s);
    const off = y.agent === 'E' ? Math.abs(q.x - 250) : Math.abs(q.y);
    ok(off >= 2.5 + reach, `reach ${reach} seed ${seed}: ${y.agent} stands ${off.toFixed(6)} mm from the other's line (≥ C = ${2.5 + reach})`);
    ok(r.events.filter((e) => e.kind === 'obstruction').length === 2, `reach ${reach} seed ${seed}: exactly two touches (meeting, press), none after the back-off`);
  }
  // progress invariants (pure): a repeat with no movement is flagged; any real progress is not
  const rec = { wS: 240, oS: 247.5, dir: 1, hx: 1, hy: 0 };
  ok(X.pressWithoutProgress(rec, { ...rec }) === true, 'press invariant: same stand, same heading, o not behind → no progress (error in simulate)');
  ok(X.pressWithoutProgress(rec, { ...rec, oS: 248 }) === true, 'press invariant: o walked on along the same line → still no progress for a re-press');
  ok(!X.pressWithoutProgress(rec, { ...rec, wS: 239 }) && !X.pressWithoutProgress(rec, { ...rec, hx: 0, hy: 1 }) && !X.pressWithoutProgress(rec, { ...rec, dir: -1 }) && !X.pressWithoutProgress(rec, { ...rec, oS: 247 }), 'press invariant: w moved, o turned, o reversed or o behind → progress');
  ok(X.releaseWithoutProgress({ t: 3, oT: 2, oV: 10 }, { yT: 3, oT: 2, oV: 10 }) === true && !X.releaseWithoutProgress({ t: 3, oT: 2, oV: 10 }, { yT: 3, oT: 3.1, oV: 10 }), 'release invariant: a re-touch with neither motion changed is flagged; a changed motion is not');
  // fuzz: random crossing lanes (straight and bent), every fourth seed with reach 0 — no error, no overlap, window-exact
  const fz = (seed: number): Col.SimConfig => {
    const r = rng(seed * 7919), nl = 2 + Math.floor(r() * 3), lanes: Any[] = [];
    for (let i = 0; i < nl; i++) {
      const a = r() * Math.PI, R = 60, off = (r() - 0.5) * 10, bend = r() < 0.5;
      const p0 = [Math.cos(a) * -R - Math.sin(a) * off, Math.sin(a) * -R + Math.cos(a) * off, 0], p2 = [Math.cos(a) * R - Math.sin(a) * off, Math.sin(a) * R + Math.cos(a) * off, 0];
      const mid = bend ? [(p0[0] + p2[0]) / 2 + (r() - 0.5) * 20, (p0[1] + p2[1]) / 2 + (r() - 0.5) * 20, 0] : null;
      lanes.push(lane(`P${i}`, mid ? [p0, mid, p2] : [p0, p2]));
    }
    const g = scene(lanes, [-300, -300, 300, 300]), na = 2 + Math.floor(r() * 5), agents: Col.SimAgentSpec[] = [];
    for (let k = 0; k < na; k++) {
      const ln = lanes[k % nl], Lp = K.laneLength(ln), d = (r() < 0.5 ? 1 : -1) as 1 | -1, s = d > 0 ? 5 + r() * 30 + Math.floor(k / nl) * 6 : Lp - 5 - r() * 30 - Math.floor(k / nl) * 6, Lb = 1.5 + r() * 2.5;
      agents.push(ant(`a${k}`, ln.id, s, { dir: d, goal_s_mm: d > 0 ? Lp - 1 : 1, free_speed_mm_s: 5 + r() * 20, start_t_s: r() * 3, body: { length_mm: Lb, width_mm: 0.5 + r() * 0.4, contact_reach_mm: seed % 4 === 0 ? 0 : r() } }));
    }
    return { encounter: ENC, geometry: g, agents, horizon_s: 20, seed };
  };
  let n = 0, zero = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const cfg = fz(seed); let r0: Col.SimResult;
    try { r0 = Col.simulate({ ...cfg, window_s: 100 }); } catch (e) { if (/same space|narrower than its width|inconsistent/.test(String(e))) continue; throw e; }
    ok(Col.checkExclusion(cfg, r0, 0.005).length === 0, `crossing fuzz ${seed}: no overlap`);
    ok(r0.stats.steps < 5000, `crossing fuzz ${seed}: bounded steps (${r0.stats.steps})`);
    for (const w of [1, 0.05, 0.003]) ok(exactSame(Col.simulate({ ...cfg, window_s: w }), r0), `crossing fuzz ${seed}: window ${w} gives a bit-identical result`);
    n++; if (seed % 4 === 0) zero++;
  }
  ok(n >= 40 && zero >= 10, `crossing fuzz: ${n} scenes run (${zero} with reach 0)`);
});

// ---------------------------------------------------------------- PH-P1-B: one contact geometry, tangent contact
section('PH-P1-B tangent crossings (simulate)', () => {
  // simulate: exact tangent crossings and near-tangent controls, for windows that put a boundary on the tangent instant
  const tcase = (d: number, reach: number, w: number) => Col.simulate({ encounter: ENC, geometry: cr, agents: [ant('E', 'P-east-west', 0, { reach }), ant('N', 'P-north-south', d, { reach })], horizon_s: 60, seed: 1, window_s: w });
  const sig = (r: Col.SimResult) => r.events.map((e) => `${e.kind}|${e.agent}|${e.other}|${e.t_s}`).join(',');
  for (const [label, reach, R] of [['touch (reach 0, R = M)', 0, 2.5], ['contact (reach 1, R = C)', 1, 3.5]] as const) for (const f of [1 - 1e-6, 1, 1 + 1e-6]) {
    // E at (10t, 0), N at (250, −250 + d + 10t): miss distance of the centres d/√2; tangent at d = R√2 (t ≈ 25 s)
    const runs = [1, 0.37, 7, 25, 24.99, 25.000001].map((w) => tcase(R * Math.SQRT2 * f, reach, w));
    ok(runs.every((x) => sig(x) === sig(runs[0])), `${label}, b/R = ${f}: identical events for windows 1, 0.37, 7, 25, 24.99, 25.000001 (old code: exact tangent touched only for window 1)`);
    const c = kinds(runs[0], 'contact_start').length, o = kinds(runs[0], 'obstruction').length;
    if (f === 1) ok(c === 0 && o === 0, `${label}, exact tangent: no contact and no touch (graze)`);
    if (f < 1) ok(c === 1 && (reach > 0 ? o === 0 : o === 1), `${label}, b/R = ${f}: a real contact${reach === 0 ? ' and touch' : ''} (${c}, ${o})`);
    if (f > 1) ok(c === 0 && o === 0, `${label}, b/R = ${f}: a miss`);
  }
  // simultaneous events: with reach 0 the contact (R = C) and the touch (R = M) are the same instant — contact first,
  // both at one time, the same for reversed input and every window
  { const mk = (w: number, rev = false) => { const ags = [ant('E', 'P-east-west', 0, { reach: 0 }), ant('N', 'P-north-south', 0, { reach: 0 })]; return Col.simulate({ encounter: ENC, geometry: cr, agents: rev ? ags.reverse() : ags, horizon_s: 60, seed: 3, window_s: w }); };
    const r = mk(1), cs = r.events.findIndex((e) => e.kind === 'contact_start'), ob = r.events.findIndex((e) => e.kind === 'obstruction');
    ok(cs >= 0 && ob === cs + 1 && r.events[cs].t_s === r.events[ob].t_s, 'reach 0: contact_start and the touch at one instant, contact first (same-instant priority)');
    ok([0.05, 7, 100].every((w) => exactSame(mk(w), r)) && exactSame(mk(1, true), r), 'same-instant order is independent of window and input order'); }
  // random tangent crossings at random angles and speeds (the reproducer of this defect): window-exact, never an error
  { let wd = 0, n = 0;
    for (let k = 1; k <= 80; k++) {
      const r = rng(k * 31337), ang = 0.3 + r() * 2.5, va = 5 + r() * 20, vb = 5 + r() * 20, reach = r() < 0.5 ? 0 : r(), L = 2.5, R = [L, L + reach][Math.floor(r() * 2)];
      const u = { x: Math.cos(ang), y: Math.sin(ang) }, v = { x: u.x * vb - va, y: u.y * vb }, nv = Math.hypot(v.x, v.y), nn = { x: -v.y / nv, y: v.x / nv };
      const T0 = 100 / va, A0 = { x: -100 + va * T0, y: 0 }, B0 = { x: A0.x + R * nn.x, y: A0.y + R * nn.y }, Bs = { x: B0.x - u.x * vb * T0, y: B0.y - u.y * vb * T0 };
      const g = scene([lane('PA', [[-100, 0, 0], [200, 0, 0]]), lane('PB', [[Bs.x, Bs.y, 0], [Bs.x + u.x * 300, Bs.y + u.y * 300, 0]])]);
      const mk = (w: number) => Col.simulate({ encounter: ENC, geometry: g, agents: [ant('A', 'PA', 0, { free_speed_mm_s: va, goal_s_mm: 290, reach }), ant('B', 'PB', 0, { free_speed_mm_s: vb, goal_s_mm: 290, reach })], horizon_s: 30, seed: 1, window_s: w });
      const base = mk(1); n++;
      if (![T0, T0 * (1 + 1e-12), 0.37, 100].every((w) => exactSame(mk(w), base))) wd++;
    }
    ok(n === 80 && wd === 0, `80 random exact-tangent crossings × 5 windows (incl. a boundary at the tangent instant): ${wd} window-dependent (old code: 214 of 300)`); }
});
section('PH-P1-B contact geometry (discEncounter)', () => {
  const E = (rx: number, ry: number, vx: number, vy: number, R: number, scale = 0) => X.discEncounter(rx, ry, vx, vy, R, scale) as { t_in: number; t_out: number } | null;
  // normal approach: r = (10, 0), v = (−1, 0), R = 2 → within (8, 12)
  { const e = E(10, 0, -1, 0, 2); ok(e && Math.abs(e.t_in - 8) < 1e-14 && Math.abs(e.t_out - 12) < 1e-14, `normal approach: (${e?.t_in}, ${e?.t_out}) = (8, 12)`); }
  // exact tangent: miss distance = R → no encounter; also for rotated / scaled copies whose coordinates carry rounding
  ok(E(10, 2, -1, 0, 2) === null, 'exact tangent (b = R): no encounter (a graze is not a contact)');
  { const g = rng(99); let bad = 0;
    for (let k = 0; k < 2000; k++) {
      const a = g() * 2 * Math.PI, R = 0.5 + g() * 3, sp = 1 + g() * 30, far = 5 + g() * 400, ca = Math.cos(a), sa = Math.sin(a);
      // v along (ca, sa); r = −far·(ca, sa) + R·(−sa, ca): closest approach exactly R
      const v = [sp * ca, sp * sa], r = [-far * ca - R * sa, -far * sa + R * ca];
      if (E(r[0], r[1], v[0], v[1], R, far) !== null) bad++;
      if (E(r[0], r[1], v[0], v[1], R * (1 + 1e-9), far) === null) bad++;                // a hair wider: a real encounter
      if (E(r[0], r[1], v[0], v[1], R * (1 - 1e-9), far) !== null) bad++;                // a hair narrower: a miss
    }
    ok(bad === 0, `2000 random rotated tangents: graze → none, R(1+1e-9) → encounter, R(1−1e-9) → none (${bad} wrong)`); }
  // initial overlap: r = (1, 0), v = (1, 0), R = 2 → already inside, until τ = 1
  { const e = E(1, 0, 1, 0, 2); ok(e && e.t_in < 0 && Math.abs(e.t_out - 1) < 1e-14, `initial overlap: inside now, leaves at τ = 1 (${e?.t_in}, ${e?.t_out})`); }
  // zero relative velocity: inside forever / never / exactly on the boundary = outside
  { const a = E(1, 1, 0, 0, 2), b = E(3, 0, 0, 0, 2), c = E(2, 0, 0, 0, 2); ok(a && a.t_in === -Infinity && a.t_out === Infinity && b === null && c === null, 'zero relative velocity: inside → always; outside → never; on the boundary → never'); }
  // separation after contact: the same pair taken after it has left → the interval lies in the past
  { const e = E(3, 0, 1, 0, 2); ok(e && e.t_out <= 0 && e.t_in < e.t_out, `after separation the encounter is over (${e?.t_in}, ${e?.t_out})`); }
  // the decision and the interval do not depend on when r is taken (time-shift invariance ↔ window splitting)
  { let bad = 0; const r0 = [137.25, -41.5], v = [-3.3, 1.0], R = 2.75;
    const e0 = E(r0[0], r0[1], v[0], v[1], R, 200)!;
    for (const tau of [0, 1e-9, 0.37, 7, 25, 33.3333333, 41.000001]) { const e = E(r0[0] + v[0] * tau, r0[1] + v[1] * tau, v[0], v[1], R, 200); if (!e || Math.abs(e.t_in + tau - e0.t_in) > 1e-12 * Math.max(1, e0.t_in) || Math.abs(e.t_out + tau - e0.t_out) > 1e-12 * Math.max(1, e0.t_out)) bad++; }
    ok(bad === 0, 'shift invariance: the interval taken at any later instant is the same interval, shifted'); }
});

// ---------------------------------------------------------------- PH-P2-B: explicit event time boundary
const line = scene([lane('P', [[0, 0, 0], [4000, 0, 0]])], [-10, -10, 4010, 10]);
section('PH-P2-B window boundary', () => {
  const v = 17, s0 = 0.3, goal = 100.3, ta = (goal - s0) / v;
  // a window ends 0.5 ns before the arrival: the arrival is handled at its own time, not at the window end
  for (const w of [1, ta - 5e-10, (ta - 5e-10) / 3, ta + 5e-10]) {
    const r = Col.simulate({ encounter: ENC, geometry: line, agents: [ant('A', 'P', s0, { free_speed_mm_s: v, goal_s_mm: goal })], horizon_s: 20, seed: 1, window_s: w });
    const a = kinds(r, 'arrive')[0];
    ok(a && a.t_s === ta && r.intervals.A.at(-1)!.t_end_s === ta, `window ${w}: arrival at ${a?.t_s} = analytic ${ta} exactly (old code: ${ta - 5e-10} for a window ending 0.5 ns before)`);
  }
  // the horizon is a boundary too: 0.5 ns before the arrival the ant has not arrived; 0.5 ns after, it has
  { const early = Col.simulate({ encounter: ENC, geometry: line, agents: [ant('A', 'P', s0, { free_speed_mm_s: v, goal_s_mm: goal })], horizon_s: ta - 5e-10, seed: 1 });
    const late = Col.simulate({ encounter: ENC, geometry: line, agents: [ant('A', 'P', s0, { free_speed_mm_s: v, goal_s_mm: goal })], horizon_s: ta + 5e-10, seed: 1 });
    ok(early.final.A.mode === 'free' && kinds(early, 'arrive').length === 0 && early.final.A.s_mm < goal, `horizon 0.5 ns before the arrival: not arrived (${early.final.A.mode}, s = ${early.final.A.s_mm})`);
    ok(late.final.A.mode === 'arrived' && kinds(late, 'arrive')[0].t_s === ta, 'horizon 0.5 ns after: arrived at the analytic time'); }
  // stable order at one instant: two ants on separate lanes arriving at exactly the same time, any input order / window;
  // a start and an arrival at one instant come in kind order (start before arrive)
  { const g2 = scene([lane('P', [[0, 0, 0], [100, 0, 0]]), lane('Q', [[0, 50, 0], [100, 50, 0]])], [-10, -10, 110, 60]);
    const mk = (rev: boolean, w: number) => { const ags = [ant('Z', 'Q', 0, { goal_s_mm: 50 }), ant('B', 'P', 0, { goal_s_mm: 50 })]; return Col.simulate({ encounter: ENC, geometry: g2, agents: rev ? ags.reverse() : ags, horizon_s: 10, seed: 1, window_s: w }); };
    const r = mk(false, 1), arr = kinds(r, 'arrive');
    ok(arr.length === 2 && arr[0].t_s === arr[1].t_s && arr[0].agent === 'B' && arr[1].agent === 'Z', 'simultaneous arrivals: one instant, ordered by agent id');
    ok(exactSame(mk(true, 1), r) && exactSame(mk(false, 5), r) && exactSame(mk(false, 0.003), r), 'simultaneous arrivals: same result for reversed input and other windows');
    const f3 = Col.simulate({ encounter: ENC, geometry: g2, agents: [ant('A', 'P', 1, { goal_s_mm: 1, start_t_s: 0.2 })], horizon_s: 1, seed: 1 });
    ok(f3.events.map((e) => e.kind).join() === 'start,arrive' && f3.events[0].t_s === f3.events[1].t_s, 'start and arrive at one instant: start first'); }
});

// ---------------------------------------------------------------- PH-P2-C: analytic positions, window-split invariance
section('PH-P2-C analytic positions', () => {
  // a free walk of 200 s at 17 mm/s split into 2 … 200,000 windows: the final position is the analytic one within
  // 4 ulps of the coordinate scale (old code: +9.3e-10 mm with 20,000 windows, +1.4e-8 mm with 200,000)
  const v = 17, s0 = 0.3, T = 200, want = s0 + v * T, tol = 4 * EPS * (Math.abs(s0) + v * T);
  for (const w of [T, 0.7 * T, 1, 0.01, 0.001]) {
    const r = Col.simulate({ encounter: ENC, geometry: line, agents: [ant('A', 'P', s0, { free_speed_mm_s: v, goal_s_mm: 3999 })], horizon_s: T, seed: 1, window_s: w });
    ok(Math.abs(r.final.A.s_mm - want) <= tol, `window ${w} (${r.stats.steps} steps): final s ${r.final.A.s_mm} = analytic ${want} within ${tol.toExponential(2)} mm`);
  }
  // one run over Δt vs the same run split as Δt1 + Δt2 (window_s = 0.7·Δt: windows [0, 0.7Δt] and [0.7Δt, Δt]) and into
  // many windows, under the same event semantics (no event is handled at a window end). Stated tolerance: event times
  // within SAME_INSTANT(t) = 16 ulps of t, positions within LEN_TOL = 64 ulps of the coordinate scale. Observed: equal.
  const close = (a: Col.SimResult, b: Col.SimResult) => a.events.length === b.events.length && a.events.every((e, i) => e.kind === b.events[i].kind && e.agent === b.events[i].agent && e.other === b.events[i].other && Math.abs(e.t_s - b.events[i].t_s) <= X.SAME_INSTANT(e.t_s) && Math.abs(e.s_mm - b.events[i].s_mm) <= X.LEN_TOL(1000))
    && Object.keys(a.final).every((k) => a.final[k].mode === b.final[k].mode && Math.abs(a.final[k].s_mm - b.final[k].s_mm) <= X.LEN_TOL(1000));
  const P = scene([lane('P', [[0, 0, 0], [20, 0, 0]])], [-5, -15, 25, 15]);
  const cases: [string, Col.SimConfig][] = [
    ['crossing, reach 0', { encounter: ENC, geometry: cr, agents: [ant('E', 'P-east-west', 0, { reach: 0 }), ant('N', 'P-north-south', 0, { reach: 0 })], horizon_s: 60, seed: 1 }],
    ['crossing, reach 1', { encounter: ENC, geometry: cr, agents: [ant('E', 'P-east-west', 0), ant('N', 'P-north-south', 0)], horizon_s: 60, seed: 2 }],
    ['corridor head-on with contact pause', { encounter: { ...ENC, contact_pause_s: 0.43 }, geometry: cor, agents: [ant('W1', 'P-corridor', 2, { goal_s_mm: 98, free_speed_mm_s: 18.5 }), ant('W2', 'P-corridor', 98, { dir: -1, goal_s_mm: 2, free_speed_mm_s: 15.5 })], horizon_s: 60, seed: 1 }],
    ['overtaking in a wide lane', { encounter: ENC, geometry: P, agents: [ant('F', 'P', 0, { free_speed_mm_s: 20, goal_s_mm: 19, reach: 0.5 }), ant('S', 'P', 5, { free_speed_mm_s: 5, goal_s_mm: 15, reach: 0.5 })], horizon_s: 2, seed: 1 }],
  ];
  for (const [name, cfg] of cases) {
    const one = Col.simulate({ ...cfg, window_s: cfg.horizon_s });
    consistent(cfg, one, name);
    for (const f of [0.7, 0.3, 0.01]) { const two = Col.simulate({ ...cfg, window_s: f * cfg.horizon_s }); ok(close(two, one), `${name}: windows of ${f}·Δt give the one-window result within the stated tolerance`); ok(exactSame(two, one), `${name}: … and in fact bit-identical (${f}·Δt)`); }
  }
  // MV-1 walk: one walk over Δt vs a walk over Δt1 followed by a walk over Δt2 (each call starts from the agent state, so
  // a split adds at most one rounding: tolerance 4 ulps of the scale); vertex times inside one walk are analytic
  { const Po = K.passageOf(geo('open-plane'), 'P-open'), a0: K.AgentKinematics = { id: 'W', passage: 'P-open', s_mm: 3.3, dir: 1, t_s: 1.1, state: 'stopped', speed_mm_s: 0, base_speed_mm_s: 17 };
    const dt = 9.7, one = K.walk(Po, a0, K.laneLength(Po), 17, { until_s: a0.t_s + dt }).agent, h1 = K.walk(Po, a0, K.laneLength(Po), 17, { until_s: a0.t_s + 0.7 * dt }).agent, two = K.walk(Po, h1, K.laneLength(Po), 17, { until_s: a0.t_s + dt }).agent;
    ok(one.t_s === two.t_s && Math.abs(one.s_mm - two.s_mm) <= 4 * EPS * (a0.s_mm + 17 * dt), `walk Δt vs Δt1 + Δt2: s ${one.s_mm} vs ${two.s_mm} (≤ 4 ulps)`);
    const zig = scene([lane('Z', Array.from({ length: 201 }, (_, i) => [i, (i % 2) * 0.5, 0]))], [-5, -5, 205, 5]), Pz = K.passageOf(zig, 'Z'), arcs = K.vertexArcs(Pz);
    const ivs = K.walk(Pz, { ...a0, passage: 'Z', s_mm: 0, t_s: 0 }, K.laneLength(Pz), 17).intervals;
    ok(ivs.every((iv, i) => iv.t_end_s === (i === ivs.length - 1 ? K.laneLength(Pz) / 17 : arcs[i + 1] / 17)), `walk over 200 vertices: every vertex time = arc length / speed exactly (${ivs.length} records)`); }
});

if (failures.length) { console.error(`\n${failures.length} section(s) failed:\n${failures.join('\n')}`); process.exit(1); }
console.log(JSON.stringify({ physics_event_fixes: 'pass', checks }, null, 2));

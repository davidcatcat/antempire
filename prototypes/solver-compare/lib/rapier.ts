/**
 * Rapier runner (Issue #101): an INDEPENDENT position/collision solve with Rapier 2D (@dimforge/rapier2d-deterministic-compat,
 * pinned in prototypes/solver-compare/package.json). Same spec as the native runner: same bodies, lanes, obstacles,
 * start positions, start times, free speeds and goals.
 *
 * What Rapier does here (and nothing more):
 *  - each ant is a DYNAMIC rigid body with one capsule collider (length L, radius w/2 — the same capsule as body2d.ts),
 *    rotation locked with its axis along its lane (heading fixed; a model choice, recorded), real (x, y) with lateral freedom;
 *  - every step its velocity is set to its free speed towards its goal point (lane point at goal s, at its start offset u),
 *    or to 0 before its start time and after arrival; Rapier's contact solver then resolves body–body and body–wall contacts;
 *  - walls: the complement of the used lanes' bands (from the passage widths) inside a bounding box, plus the geometry's
 *    obstacles at the lanes' level (circle → ball, convex polygon → convex hull). One layer only (2.5D is refused, never projected);
 *  - contacts recorded from Rapier's own event queue (collision start / stop).
 * What Rapier does NOT do: NO biological decision. No yield, no give-way, no crossing wait, no contact pause, no recruitment,
 * no perception. Where the native model applies an encounter rule, the Rapier run has none — a measured difference.
 * Numerical choices (recorded in every result): gravity 0 (top view), friction 0, restitution 0, density 1 (equal masses
 * for equal bodies), Rapier's default integration parameters (lengthUnit 1 = 1 mm). Rapier computes in 32-bit floats.
 */
import type { Scenario } from './spec.ts';
import { HERE } from './spec.ts';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { type Trajectory, type TrajEvent, type Sample, laneFrames, poseOn, project } from './traj.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const RAPIER_PKG = '@dimforge/rapier2d-deterministic-compat';
let R: Any = null;
/** Load Rapier from this sub-project's node_modules; null when it is not installed (offline / no npm install). */
export async function loadRapier(): Promise<Any | null> {
  if (R) return R;
  const entry = path.join(HERE, 'node_modules', RAPIER_PKG, 'dist', 'rapier.mjs');
  if (!fs.existsSync(entry)) return null;
  const mod = await import(pathToFileURL(entry).href);
  R = mod.default ?? mod; await R.init();
  return R;
}

export interface RapierOptions { dt_s: number; ccd: boolean; reverse_order?: boolean; only?: string[] }

/** walls: complement of the union of axis-aligned lane bands inside their bounding box grown by `margin` */
function bandWalls(sc: Scenario, margin: number) {
  const frames = laneFrames(sc), rects: [number, number, number, number][] = [];
  for (const f of frames.values()) {
    if (!(Math.abs(f.t.x) === 1 && f.t.y === 0) && !(Math.abs(f.t.y) === 1 && f.t.x === 0)) throw Error(`SOLVER_COMPARE: lane ${f.id} is not axis-aligned; band walls for oblique lanes are not implemented in this step`);
    const b = { x: f.a.x + f.t.x * f.length, y: f.a.y + f.t.y * f.length }, h = f.width / 2;
    rects.push([Math.min(f.a.x, b.x) - Math.abs(f.n.x) * h, Math.max(f.a.x, b.x) + Math.abs(f.n.x) * h, Math.min(f.a.y, b.y) - Math.abs(f.n.y) * h, Math.max(f.a.y, b.y) + Math.abs(f.n.y) * h]);
  }
  const X0 = Math.min(...rects.map((r) => r[0])) - margin, X1 = Math.max(...rects.map((r) => r[1])) + margin, Y0 = Math.min(...rects.map((r) => r[2])) - margin, Y1 = Math.max(...rects.map((r) => r[3])) + margin;
  const xs = [...new Set([X0, X1, ...rects.flatMap((r) => [r[0], r[1]])])].sort((a, b) => a - b), ys = [...new Set([Y0, Y1, ...rects.flatMap((r) => [r[2], r[3]])])].sort((a, b) => a - b);
  const cells: { cx: number; cy: number; hx: number; hy: number }[] = [];
  for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
    const mx = (xs[i - 1] + xs[i]) / 2, my = (ys[j - 1] + ys[j]) / 2;
    if (rects.some((r) => mx > r[0] && mx < r[1] && my > r[2] && my < r[3])) continue;
    cells.push({ cx: mx, cy: my, hx: (xs[i] - xs[i - 1]) / 2, hy: (ys[j] - ys[j - 1]) / 2 });
  }
  return cells;
}

export async function runRapier(sc: Scenario, o: RapierOptions) {
  const RA = await loadRapier();
  if (!RA) throw Error(`SOLVER_COMPARE: ${RAPIER_PKG} is not installed (run npm ci in prototypes/solver-compare)`);
  if (new Set(sc.lanes.map((l) => l.layer)).size !== 1) throw Error('SOLVER_COMPARE: more than one height layer; this step refuses 2.5D rather than projecting layers into one plane');
  const frames = laneFrames(sc), L = sc.body.length_mm.value, w = sc.body.width_mm.value, half = Math.max(0, (L - w) / 2), dt = o.dt_s;
  const m0 = process.memoryUsage(), c0 = process.cpuUsage(), w0 = performance.now();
  const world = new RA.World({ x: 0, y: 0 });
  world.timestep = dt;
  const ip = world.integrationParameters;
  const params = { rapier_version: RA.version(), dt_s: dt, ccd: o.ccd, length_unit: ip.lengthUnit, normalized_allowed_linear_error: ip.normalizedAllowedLinearError, normalized_prediction_distance: ip.normalizedPredictionDistance, num_solver_iterations: ip.numSolverIterations, gravity: [0, 0], friction: 0, restitution: 0, density: 1, rotation: 'locked along the lane', float: 'f32 inside Rapier' };
  const names = new Map<number, string>();
  const fixed = world.createRigidBody(RA.RigidBodyDesc.fixed());
  const wallMargin = 5; // mm: thickness of the bounding walls (numerical; far thicker than one step's travel)
  for (const [k, c] of bandWalls(sc, wallMargin).entries()) names.set(world.createCollider(RA.ColliderDesc.cuboid(c.hx, c.hy).setTranslation(c.cx, c.cy).setFriction(0).setRestitution(0), fixed).handle, `band-wall-${k}`);
  for (const ob of sc.obstacles) {
    let d: Any;
    if (ob.shape.type === 'circle') d = RA.ColliderDesc.ball(ob.shape.radius_mm).setTranslation(ob.shape.center_mm[0], ob.shape.center_mm[1]);
    else {
      const pts = ob.shape.points_mm; d = RA.ColliderDesc.convexHull(new Float32Array(pts.flat()));
      if (!d) throw Error(`SOLVER_COMPARE: obstacle ${ob.id} has no convex hull`);
      // refuse non-convex polygons (a hull would silently fill concavities)
      const signs = pts.map((a, i) => { const b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length]; return Math.sign((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])); }).filter((x) => x !== 0);
      if (new Set(signs).size > 1) throw Error(`SOLVER_COMPARE: obstacle ${ob.id} is not convex; refused`);
    }
    names.set(world.createCollider(d.setFriction(0).setRestitution(0), fixed).handle, ob.id);
  }
  let agents = [...sc.agents].filter((a) => !o.only || o.only.includes(a.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (o.reverse_order) agents = agents.reverse();
  const rt = agents.map((a) => {
    const f = frames.get(a.passage)!, p = poseOn(f, a.s_mm, a.u_mm, a.dir), goal = poseOn(f, a.goal_s_mm, a.u_mm, a.dir);
    const desc = RA.RigidBodyDesc.dynamic().setTranslation(p.x, p.y).setRotation(p.heading - Math.PI / 2).lockRotations().setLinearDamping(0).setAngularDamping(0).setCcdEnabled(o.ccd);
    const body = world.createRigidBody(desc);
    const col = world.createCollider(RA.ColliderDesc.capsule(half, w / 2).setFriction(0).setRestitution(0).setDensity(1).setActiveEvents(RA.ActiveEvents.COLLISION_EVENTS), body);
    names.set(col.handle, a.id);
    const s0 = project(f, p.x, p.y);
    return { a, f, body, goal, heading: p.heading, samples: [[0, p.x, p.y, p.heading, s0.s, s0.u]] as Sample[], arrived: null as number | null };
  });
  const eq = new RA.EventQueue(true), events: TrajEvent[] = [];
  const nSteps = Math.round(sc.horizon_s / dt);
  let rawContacts = 0;
  for (let n = 0; n < nSteps; n++) {
    const t = n * dt;
    for (const r of rt) {
      let vx = 0, vy = 0;
      if (t >= r.a.start_t_s - 1e-12 && r.arrived === null) {
        const q = r.body.translation(), dx = r.goal.x - q.x, dy = r.goal.y - q.y, d = Math.hypot(dx, dy);
        if (d > 0) { vx = (r.a.free_speed_mm_s * dx) / d; vy = (r.a.free_speed_mm_s * dy) / d; }
      }
      r.body.setLinvel({ x: vx, y: vy }, true);
    }
    world.step(eq);
    const t1 = (n + 1) * dt;
    eq.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      rawContacts++;
      const ids = [names.get(h1) ?? `?${h1}`, names.get(h2) ?? `?${h2}`].sort();
      events.push({ t_s: t1, kind: started ? 'rapier_collision_start' : 'rapier_collision_stop', agents: ids, class: 'physical_contact', source: 'Rapier EventQueue (reported at the end of the step)' });
    });
    for (const r of rt) {
      const q = r.body.translation(), pr = project(r.f, q.x, q.y), prev = r.samples[r.samples.length - 1];
      r.samples.push([t1, q.x, q.y, r.heading, pr.s, pr.u]);
      if (r.arrived === null && t1 >= r.a.start_t_s && (pr.s - r.a.goal_s_mm) * r.a.dir >= 0) {
        // crossing time interpolated inside the step (the step itself is the solver's resolution)
        const f0 = (prev[4] - r.a.goal_s_mm) * r.a.dir, f1 = (pr.s - r.a.goal_s_mm) * r.a.dir;
        r.arrived = f1 === f0 ? t1 : prev[0] + (t1 - prev[0]) * (-f0 / (f1 - f0));
        events.push({ t_s: r.arrived, kind: 'arrive', agents: [r.a.id], class: 'motion', source: 'runner (goal s crossed, interpolated within the step)' });
      }
    }
  }
  const wall_ms = performance.now() - w0, cpu = process.cpuUsage(c0), m1 = process.memoryUsage();
  world.free(); eq.free();
  events.sort((x, y) => x.t_s - y.t_s || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0) || (x.agents.join() < y.agents.join() ? -1 : 1));
  const tr: Trajectory = {
    solver: 'rapier', scenario: sc.id, lateral_dof: true,
    notes: ['Rapier 2D independent solve: dynamic capsules, velocity set towards the goal every step, contacts resolved by Rapier', 'NO biological decisions: no yield / give-way / crossing wait / contact pause (native encounter rules have no Rapier counterpart)', 'positions are Rapier f32 values; motion between samples = the integrator\'s straight step'],
    agents: Object.fromEntries([...rt].sort((x, y) => (x.a.id < y.a.id ? -1 : 1)).map((r) => [r.a.id, { lane: r.a.passage, layer: r.a.layer, samples: r.samples, arrival_t_s: r.arrived, final_mode: r.arrived !== null ? 'arrived' : 'not_arrived' }])),
    events,
  };
  return { tr, params, cost: { wall_ms, cpu_user_ms: cpu.user / 1000, cpu_system_ms: cpu.system / 1000, heap_used_delta_mb: (m1.heapUsed - m0.heapUsed) / 2 ** 20, array_buffers_mb: m1.arrayBuffers / 2 ** 20, rss_mb: m1.rss / 2 ** 20, steps: nSteps, raw_collision_events: rawContacts } };
}

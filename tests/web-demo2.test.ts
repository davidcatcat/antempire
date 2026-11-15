/**
 * Demo 2 (web/demo2.html, web/src/demo2/; Owner brief 2026-11-15) — Node checks of the pure display modules with real
 * P0-A2 Worker state, and source scans. NON-OFFICIAL experiment world. BLOCKING. Nothing here changes a world.
 *  1. nest layout + graph: the layout is labelled 展示假設 / scenario_assumption (an unlabelled one is refused); the
 *     graph is connected; every walk-line point lies inside the cavity; routes stay on graph edges, are symmetric in
 *     length and never shorter than the straight line; slots lie on their chamber floor inside the cavity depth.
 *  2. the display director over real worlds (2 seeds × 1.5 h, 0.1–0.2 s steps): always the same 30 ids; every in-nest drawn
 *     point is inside the cavity and inside its depth; the drawn point is continuous (bounded speed) everywhere —
 *     through the entrance in both directions with the same id — except the listed engine-defined discontinuities;
 *     a worker reaches the entrance exactly when its to_entrance move ends; a resting worker that has arrived does not
 *     translate; a state without an engine duration is at its place within the bounded display travel time;
 *     same inputs → same output; frames are not mutated and observing does not change the world.
 *  3. ColonyFeed: natural mode = engine individuals only; demo individuals are labelled, seeded, reproducible, only for
 *     castes the engine lacks, and are in no snapshot; a frame that supplies a caste switches that caste to the engine.
 *  4. gait: phase advances only with drawn distance, nothing changes while paused; surface fold keeps points behind the
 *     cut face and is continuous.
 *  5. source scans: no engine / Worker / cli import, no Math.random, Worker only through worker-client with scheduling /
 *     observation commands, no CDN, labels present, demo data never sent to the Worker or the save store.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import type { EventMsg, P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { VisModel, SEARCH_EMERGE_S } from '../web/src/vis1-model.ts';
import { NestGraph, parseLayout, pathAt, upFor, type Pos } from '../web/src/demo2/nest-graph.ts';
import { ColonyStage, OUTSIDE, CATCHUP_MAX_S, TROPH_HOLD_S, ABSORB_MAX_CM, DRAWN_SPEED_BOUND, STAGE_DISCONTINUITIES, CLASS_LABEL, type DrawnAnt } from '../web/src/demo2/stage.ts';
import { BLOCK, FOLD_CM, fold, ground, surfacePose, corridor3 } from '../web/src/demo2/surface.ts';
import { roster, engineFeed, demoFeed, missingCastes, engineCastes, DEMO_COUNTS, DEMO_BADGE, NATURAL_BADGE, DEMO_FOOD_PROPS } from '../web/src/demo2/feed.ts';
import { larvaSpot, carerSpot, queenSpot, eggSpot, pupaSpot, majorSpot } from '../web/src/demo2/places.ts';
import { newGait, stepGait, STRIDE_PER_BODY, POSE_TARGET } from '../web/src/demo2/gait.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const frameOf = (w: P0a2ExperimentWorld) => w.frame() as unknown as P0a2FrameMsg;
const raw = JSON.parse(read('data/demo2-nest-layout.json'));
const layout = parseLayout(raw), g = new NestGraph(layout, ground(0, 0)), L = 2.5;

// 1. layout + graph
{
  ok(raw.scenario_assumption === true && raw.assumption === true && raw.label_zh.includes('展示假設') && raw.provenance.not_measured === true, 'layout is labelled a scenario assumption (展示假設), not measured');
  ok(/R290/.test(raw.provenance.literature_direction_zh) && /R290/.test(read('docs/references.md')), 'the only literature cited for the layout exists in docs/references.md (direction only)');
  for (const bad of [{ ...raw, scenario_assumption: false }, { ...raw, assumption: undefined }, { ...raw, label_zh: '巢' }, { ...raw, schema: 'x' }]) assert.throws(() => parseLayout(bad), 'an unlabelled layout is refused'), checks++;
  const roles = new Set(layout.chambers.map((c) => c.role));
  ok(['entry', 'rest', 'brood', 'queen', 'exchange', 'pupa'].every((r) => roles.has(r as never)) && new Set(layout.chambers.map((c) => c.x1 - c.x0)).size >= 4, 'chambers of every role and of different sizes');
  const ids = [...g.nodes.keys()]; for (const a of ids) for (const b of ids) ok(Number.isFinite(g.nodeDistance(a, b)) && Math.abs(g.nodeDistance(a, b) - g.nodeDistance(b, a)) < 1e-9, `nodes ${a}–${b} connected, symmetric`);
  let worst = -Infinity;
  g.edges.forEach((e, k) => { for (let s = 0; s <= e.len; s += 0.2) { const p = g.point({ edge: k, s, z: 0 }), d = g.sdf(p.x, p.y + 0.3); worst = Math.max(worst, d); } });
  ok(worst < -0.05, `every walk-line point is inside the cavity (worst sdf ${worst.toFixed(3)} cm)`);
  ok(g.sdf(0, -20) > 1 && g.sdf(60, -10) > 1 && g.sdf(-30, -8) > 1, 'solid soil has a positive distance');
  const E = g.entrancePos(), ep = g.point(E); ok(Math.abs(ep.x) < 1e-9 && Math.abs(ep.y - ground(0, 0)) < 1e-9, 'the entrance node sits on the drawn ground at the origin');
  const rnd = (i: number, m: number) => ((i * 2654435761) >>> 0) / 4294967296 * m;
  for (let i = 0; i < 300; i++) {
    const a: Pos = { edge: Math.floor(rnd(i, g.edges.length)), s: 0, z: rnd(i + 7, 2) - 1 }, b: Pos = { edge: Math.floor(rnd(i * 3 + 1, g.edges.length)), s: 0, z: rnd(i + 9, 2) - 1 };
    a.s = rnd(i + 11, g.edges[a.edge].len); b.s = rnd(i + 13, g.edges[b.edge].len);
    const P = g.route(a, b, 0.2), Rv = g.route(b, a, 0.2), pa = g.point(a), pb = g.point(b);
    ok(Math.abs(P.len - Rv.len) < 1e-6 && P.len >= Math.hypot(pa.x - pb.x, pa.y - pb.y) - 1e-6, 'route length symmetric and not shorter than the straight line');
    ok(Math.hypot(P.pts[0].x - pa.x, P.pts[0].y - pa.y) < 1e-9 && Math.hypot(P.pts[P.pts.length - 1].x - pb.x, P.pts[P.pts.length - 1].y - pb.y) < 1e-9, 'route ends at the two places');
    let on = true, maxStep = 0;
    P.pts.forEach((p, j) => { const q = g.point({ edge: P.edge[j], s: P.es[j], z: 0 }); if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-9 || p.z < g.backZ || p.z > g.faceZ) on = false; if (j) maxStep = Math.max(maxStep, Math.hypot(p.x - P.pts[j - 1].x, p.y - P.pts[j - 1].y)); });
    ok(on && maxStep < 12, 'every route vertex is a graph point inside the cavity depth (the points between are checked against the cavity below)');
    for (let s = 0; s <= P.len; s += 0.37) { const q = pathAt(P, s); if (!(g.sdf(q.x, q.y + 0.3) < 0)) { ok(false, `route point outside the cavity at (${q.x.toFixed(2)}, ${q.y.toFixed(2)})`); break; } }
  }
  for (const c of layout.chambers) { const S = g.slots(c.id, L); ok(S.length >= 3 && S.every((s) => s.pos.edge === g.floorEdge(c.id) && s.pos.s > 0 && s.pos.s < c.x1 - c.x0 && s.pos.z > g.backZ && s.pos.z < g.faceZ && g.sdf(g.point(s.pos).x, c.floor + 0.3) < 0), `${c.id}: slots on the floor, inside the cavity`); }
  const restCap = [...g.chambersOf('rest'), ...g.chambersOf('exchange')].reduce((a, c) => a + g.slots(c.id, L).length, 0); ok(restCap >= 30, `resting places for all 30 workers (${restCap})`);
  const u = upFor(1, 0), v = upFor(0, -1); ok(u.y === 1 && v.z === 1, 'up: floor normal on a level floor, toward the viewer in a vertical shaft');
  for (const spot of [larvaSpot(g, 3, 8, L), carerSpot(g, larvaSpot(g, 3, 8, L), 1, L), queenSpot(g, 1, 2, L), eggSpot(g, 5, 1, L), pupaSpot(g, 4, 9, L), majorSpot(g, 2, 1, L).pos]) { const p = g.point(spot); ok(g.edges[spot.edge].kind === 'floor' && g.sdf(p.x, p.y + 0.3) < 0, 'display places are on chamber floors'); }
  ok(g.edges[larvaSpot(g, 0, 8, L).edge].chamber === g.chambersOf('brood')[0].id && g.edges[queenSpot(g, 0, 2, L).edge].chamber === g.chambersOf('queen')[0].id && g.edges[pupaSpot(g, 0, 9, L).edge].chamber === g.chambersOf('pupa')[0].id, 'larvae in the brood chamber, queens in the queen chamber, pupae in the pupa chamber');
}

// 2. the display director over real worlds
const summary: Record<string, unknown> = {};
function run(seed: number, t0: number, t1: number, dt = 0.1, every = 2): { trace: string; cuts: Record<string, number>; stats: unknown } {
  const { world, events } = P0a2ExperimentWorld.create('exp-demo2-test', seed), stage = new ColonyStage(g, L);
  stage.onEvents(events as unknown as EventMsg[]); stage.onEvents(world.advanceTo(t0).events as unknown as EventMsg[]);
  let f = frameOf(world); const vis = VisModel.of(f), v = f.layout.source_distance_cm / f.layout.travel_s, E = g.point(g.entrancePos());
  const prev = new Map<string, DrawnAnt>(), prevW = new Map<string, P0a2FrameMsg['workers'][number]>(), restAt = new Map<string, { x: number; y: number; z: number }>(), cuts: Record<string, number> = {};
  let n = 0, exits = 0, entries = 0, trace = '', maxLag = 0, restMoves = 0, maxAbs = 0, troph = 0, brood = 0;
  const steps = Math.round((t1 - t0) / dt);
  for (let i = 0; i <= steps; i++) {
    const t = t0 + i * dt;
    if (i % every === 0) { const before = JSON.stringify(f); stage.onEvents(world.advanceTo(t).events as unknown as EventMsg[]); f = frameOf(world); if (i % 200 === 0) { const copy = JSON.stringify(f); stage.update(f, vis, t, 0); ok(JSON.stringify(f) === copy && typeof before === 'string', 'the frame is not mutated'); } }
    const ants = stage.update(f, vis, t, 0.016);
    if (ants.length !== 30 || new Set(ants.map((a) => a.id)).size !== 30) ok(false, 'always the same 30 workers, one drawn point each');
    for (const a of ants) {
      n++; const w = f.workers.find((x) => x.id === a.id)!, p = prev.get(a.id), pw = prevW.get(a.id);
      maxAbs = Math.max(maxAbs, a.absorbed); if (a.pose === 'troph') troph++; if (a.pose === 'brood') brood++;
      if ((a.realm === 'surface') !== OUTSIDE.has(w.state)) ok(false, `${a.id}: realm follows the engine state`);
      if (a.realm === 'nest') {
        if (a.z < g.backZ - ABSORB_MAX_CM || a.z > g.faceZ + 1e-9 && a.absorbed === 0) ok(false, `${a.id}: outside the cavity depth`);
        if (a.absorbed === 0 && !(g.sdf(a.x, a.y + 0.3) < 0)) ok(false, `${a.id} (${a.state}) drawn inside the soil at (${a.x.toFixed(2)}, ${a.y.toFixed(2)})`);
      } else if (a.z > BLOCK.z1 - 0.5) ok(false, `${a.id}: drawn beyond the cut face on the surface`);
      if (p) {
        const j = Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z);
        if (j > DRAWN_SPEED_BOUND * v * dt + 0.05) {
          const found = pw!.state === 'searching' && (w.state === 'feeding' || (w.state === 'returning' && w.route !== null)), short = pw!.state === 'searching' && w.state === 'returning' && w.route === null && w.since_s - pw!.since_s < SEARCH_EMERGE_S;
          const key = found ? 'search_found' : short ? 'search_short_failed' : `UNLISTED ${pw!.state}->${w.state}`;
          cuts[key] = (cuts[key] ?? 0) + 1;
          if (!found && !short) ok(false, `${a.id}: unlisted jump of ${j.toFixed(2)} cm (${pw!.state} → ${w.state}) at t=${t.toFixed(1)}`);
        }
        if (p.realm === 'nest' && a.realm === 'surface') { exits++; if (Math.hypot(p.x - E.x, p.y - E.y, p.z - E.z) > DRAWN_SPEED_BOUND * v * dt * every + ABSORB_MAX_CM * 0.2) ok(false, `${a.id}: left the nest away from the entrance`); }
        if (p.realm === 'surface' && a.realm === 'nest') { entries++; if (Math.hypot(a.x - E.x, a.y - E.y, a.z - E.z) > DRAWN_SPEED_BOUND * v * dt * every + ABSORB_MAX_CM * 0.2) ok(false, `${a.id}: entered the nest away from the entrance`); }
      }
      // exactly at the entrance when the engine's move to the entrance ends
      if (w.state === 'to_entrance' && w.until_s !== null && t >= w.until_s && a.absorbed === 0 && Math.hypot(a.x - E.x, a.y - E.y, a.z - E.z) > 1e-6) ok(false, `${a.id}: not at the entrance at the end of to_entrance`);
      // resting: once arrived (pose rest), it stays put until the state changes
      if (w.state === 'resting' && a.pose === 'rest' && !a.moving && a.absorbed === 0) { const r = restAt.get(a.id); if (r && Math.hypot(a.x - r.x, a.y - r.y, a.z - r.z) > 1e-9) restMoves++; restAt.set(a.id, { x: a.x, y: a.y, z: a.z }); } else restAt.delete(a.id);
      // bounded display travel time for states without an engine duration
      if ((w.state === 'resting' || w.state === 'brood_care') && a.moving) maxLag = Math.max(maxLag, t - w.since_s);
      if (w.state === 'resting' && !a.moving && a.partner === null && t - w.since_s > 2 * CATCHUP_MAX_S + TROPH_HOLD_S + 1 && !['rest', 'exchange'].includes(g.layout.chambers.find((c) => c.id === a.place)?.role ?? '')) ok(false, `${a.id}: resting but not in a resting place after the bound`);
      if (w.state === 'brood_care' && !a.moving && t - w.since_s > 2 * CATCHUP_MAX_S + TROPH_HOLD_S + 1 && a.place !== g.chambersOf('brood')[0].id) ok(false, `${a.id}: brood care but not in the brood chamber after the bound`);
      prev.set(a.id, a); prevW.set(a.id, w);
      if (i % 50 === 0) trace += `${a.id}:${a.x.toFixed(4)},${a.y.toFixed(4)},${a.z.toFixed(4)},${a.pose};`;
    }
  }
  ok(n === 30 * (steps + 1), `seed ${seed}: ${n} drawn points checked`);
  ok(exits > 20 && entries > 20, `seed ${seed}: workers pass the entrance with the same id, continuously (${exits} out, ${entries} in)`);
  ok(restMoves === 0, `seed ${seed}: an arrived resting worker never translates`);
  ok(maxLag <= 2 * CATCHUP_MAX_S + TROPH_HOLD_S + 1, `seed ${seed}: display travel after a state change is bounded (${maxLag.toFixed(1)} s ≤ ${2 * CATCHUP_MAX_S + TROPH_HOLD_S + 1} s)`);
  ok(maxAbs <= ABSORB_MAX_CM + 1e-9, `seed ${seed}: absorbed jumps stay ≤ ${ABSORB_MAX_CM} cm (${maxAbs.toFixed(2)})`);
  ok(troph > 0 && brood > 0 && stage.stats.troph_shown > 0 && stage.stats.troph_shown <= stage.stats.troph_events, `seed ${seed}: engine trophallaxis / larva events are shown (${stage.stats.troph_shown} of ${stage.stats.troph_events} meetings)`);
  // observing did not change the world
  const { world: plain } = P0a2ExperimentWorld.create('exp-demo2-test', seed); plain.advanceTo(world.tSim());
  ok(plain.snapshot().payload_sha256 === world.snapshot().payload_sha256, `seed ${seed}: observing does not change the world (payload hash)`);
  ok(!JSON.stringify(world.snapshot()).includes('demo-'), `seed ${seed}: no demo individual in the snapshot`);
  summary[`seed${seed}`] = { points: n, exits, entries, cuts, max_display_lag_s: Number(maxLag.toFixed(1)), stats: { ...stage.stats } };
  return { trace, cuts, stats: { ...stage.stats } };
}
{
  const a = run(1, 9 * 3600, 10.5 * 3600, 0.2, 1), b = run(1, 9 * 3600, 10.5 * 3600, 0.2, 1);
  ok(a.trace === b.trace && a.trace.length > 1000, 'same frames, events and display times → the same drawn points (deterministic)');
  run(7, 12 * 3600, 13.5 * 3600, 0.1, 2);
  ok(STAGE_DISCONTINUITIES.every((d) => d.label_zh.length > 10) && STAGE_DISCONTINUITIES.some((d) => d.key === 'search_found'), 'the listed discontinuities carry labels');
  // first sight (new page / restored save): placed directly, state-consistent, no walk from nowhere
  const { world } = P0a2ExperimentWorld.create('exp-demo2-test', 3); world.advanceTo(10 * 3600);
  const f = frameOf(world), st = new ColonyStage(g, L), ants = st.update(f, VisModel.of(f), f.t_sim, 0);
  for (const a of ants) { const w = f.workers.find((x) => x.id === a.id)!; if (w.state === 'resting') ok(a.pose === 'rest' && !a.moving, 'first sight: a resting worker is already at its resting place'); }
  ok(Object.keys(CLASS_LABEL).length === 4, 'four display classes are labelled');
}

// 3. ColonyFeed
{
  const { world } = P0a2ExperimentWorld.create('exp-demo2-test', 1); world.advanceTo(9 * 3600);
  const f = frameOf(world), nat = roster('natural', f, 5), demo = roster('demo', f, 5);
  ok(nat.badge === NATURAL_BADGE && nat.individuals.every((x) => x.source === 'engine') && nat.individuals.length === 38 && nat.counts.minor.engine === 30 && nat.counts.larva.engine === 8, 'natural mode: only the 30 engine workers and 8 engine larvae');
  ok(JSON.stringify(missingCastes(f)) === JSON.stringify(['queen', 'major', 'egg', 'pupa']) && JSON.stringify(engineCastes(f)) === JSON.stringify(['minor', 'larva']), 'P0-A2 supplies minors and larvae only');
  ok(['queen', 'major', 'egg', 'pupa'].every((c) => nat.counts[c as 'queen'].engine === 0 && nat.counts[c as 'queen'].demo === 0), 'natural mode shows no demo individual of any caste');
  const d = demo.individuals.filter((x) => x.source === 'demo');
  ok(demo.badge === DEMO_BADGE && DEMO_BADGE.includes('示範資料') && d.length === DEMO_COUNTS.queen + DEMO_COUNTS.major + DEMO_COUNTS.egg + DEMO_COUNTS.pupa && d.every((x) => x.id.startsWith('demo-') && x.state !== null && x.state.includes('示範')), 'demo individuals are labelled 示範 and carry demo- ids');
  ok(DEMO_COUNTS.queen >= 2 && DEMO_COUNTS.queen <= 3, 'demo queens: 2–3 (Owner #202 provisional ruling)');
  ok(JSON.stringify(demo.individuals.filter((x) => x.source === 'engine')) === JSON.stringify(nat.individuals), 'the engine individuals are identical in both modes');
  ok(JSON.stringify(roster('demo', f, 5)) === JSON.stringify(demo) && JSON.stringify(demoFeed(6, missingCastes(f)).individuals()) !== JSON.stringify(demoFeed(5, missingCastes(f)).individuals()), 'demo roster: seeded and reproducible');
  ok(!d.some((x) => f.workers.some((w) => w.id === x.id) || f.larvae.some((l) => l.id === x.id)), 'no demo id collides with an engine id');
  // a frame that supplies queens / majors (a later world kind): the engine individuals are used, the demo ones dropped
  const f2 = { ...f, queens: [{ id: 'q001' }, { id: 'q002' }], workers: [...f.workers.slice(0, 29), { ...f.workers[29], caste: 'major' }] } as unknown as P0a2FrameMsg, r2 = roster('demo', f2, 5);
  ok(r2.counts.queen.engine === 2 && r2.counts.queen.demo === 0 && r2.counts.major.engine === 1 && r2.counts.major.demo === 0 && r2.counts.minor.engine === 29 && r2.counts.egg.demo === DEMO_COUNTS.egg, 'a caste the engine supplies is never duplicated by demo data');
  ok(engineFeed(f).source === 'engine' && demoFeed(1, ['queen']).source === 'demo' && demoFeed(1, ['queen']).individuals().every((x) => x.caste === 'queen'), 'two providers behind one interface');
  ok(DEMO_FOOD_PROPS.every((p) => p.label_zh.includes('示範道具') && p.label_zh.includes('尚未模擬')), 'demo food props are labelled inert');
}

// 4. gait and surface fold
{
  const m = newGait(); stepGait(m, { x: 0, y: 0, z: 0, moving: true, pose: 'walk' }, 0.016, L);
  const p0 = m.phase; stepGait(m, { x: 1, y: 0, z: 0, moving: true, pose: 'walk' }, 0.016, L);
  ok(Math.abs(m.phase - p0 - (1 / (STRIDE_PER_BODY * L)) * Math.PI * 2) < 1e-9, 'gait phase = drawn distance / stride');
  const p1 = m.phase; for (let i = 0; i < 50; i++) stepGait(m, { x: 1, y: 0, z: 0, moving: false, pose: 'rest' }, 0.016, L);
  ok(m.phase === p1 && m.walk < 0.01 && m.crouch > 0.8, 'a standing ant: no phase advance, walk weight eases out, resting pose eases in');
  const snap = JSON.stringify(m); stepGait(m, { x: 1, y: 0, z: 0, moving: false, pose: 'feed' }, 0, L); ok(JSON.stringify(m) === snap, 'paused (dt = 0): nothing changes');
  stepGait(m, { x: 50, y: 0, z: 0, moving: true, pose: 'walk' }, 0.016, L); ok(m.cut && m.phase === p1, 'a jump larger than the cut length is a cut, not a walk');
  ok(POSE_TARGET.feed.pitch > 0.3 && POSE_TARGET.rest.crouch === 1 && POSE_TARGET.troph.antUp > 0.5, 'pose targets: feeding head down, resting crouched, trophallaxis antennae forward');
  for (let y = -30; y <= 30; y += 0.37) { const a = fold({ x: 3, y }, 0.4), b = fold({ x: 3, y: y + 0.001 }, 0.4); ok(a.y >= -FOLD_CM - 1e-9 && Math.abs(a.y - b.y) <= 0.001 + 1e-9, 'fold: behind the cut, continuous'); }
  const { world } = P0a2ExperimentWorld.create('exp-demo2-test', 1); world.advanceTo(9 * 3600); const f = frameOf(world), vis = VisModel.of(f);
  for (const w of f.workers) if (OUTSIDE.has(w.state)) { const s = surfacePose(vis, w, f.t_sim, L); ok(s.z <= FOLD_CM + 1e-9 && Math.abs(s.y - ground(s.x, s.z)) < 1e-9 && s.x > BLOCK.x0 && s.x < BLOCK.x1 && s.z > BLOCK.z0, 'surface pose on the drawn ground, inside the block'); }
  const C = corridor3(vis); ok(C.every((p) => p.x > BLOCK.x0 + 5 && p.x < BLOCK.x1 - 5 && p.z > BLOCK.z0 + 5 && p.z < BLOCK.z1), 'the whole display route lies on the block');
}

// 5. source scans
{
  const dir = 'web/src/demo2', files = fs.readdirSync(path.join(REPO_ROOT, dir)).filter((x) => x.endsWith('.ts')), html = read('web/demo2.html'), main = read(`${dir}/main.ts`);
  ok(['nest-graph.ts', 'stage.ts', 'surface.ts', 'feed.ts', 'places.ts', 'gait.ts', 'ant-rig.ts', 'scene.ts', 'main.ts'].every((x) => files.includes(x)), 'Demo 2 modules present');
  for (const x of files) {
    const code = read(`${dir}/${x}`);
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) ok(m[1] === 'three' || m[1].startsWith('three/addons/') || ((m[1].startsWith('./') || m[1].startsWith('../')) && !/engine\/|cli\/|prototypes\/|worker-dist/.test(m[1]) && !path.posix.normalize(path.posix.join(dir, m[1])).startsWith('web/src/../')), `${x}: imports only viewer modules and vendored three (${m[1]})`);
    ok(!/Math\.random|Date\.now\(\)\s*[*%]|new Worker\(/.test(code), `${x}: no unseeded randomness, no Worker of its own`);
    if (['nest-graph.ts', 'stage.ts', 'surface.ts', 'feed.ts', 'places.ts', 'gait.ts'].includes(x)) ok(!/from 'three|document\.|window\.|performance\.|worker-client|session\.ts|save-store/.test(code), `${x}: pure (no DOM, no three, no Worker client, no save store)`);
  }
  const cmds = new Set([...main.matchAll(/client\.(\w+)\(/g)].map((m) => m[1]));
  ok([...cmds].every((c) => ['init', 'stepUntil', 'start', 'pause', 'resume', 'setSpeed', 'follow', 'snapshot'].includes(c)), `main.ts sends only scheduling / observation commands (${[...cmds].join(', ')})`);
  ok(!/sendRaw|postMessage|client\.send\(|client\.restore\(/.test(main), 'main.ts sends no raw message and restores only through the SAVE-2 session');
  ok(!/(roster|rost|demo|statics)[\w.]*\)?\s*\)?;?\s*$/m.test('') && !/store\.(createWorld|saveSnapshot)/.test(main) && !/session\.(request|newGame|open)\([^)]*(rost|demo|statics|mode)/.test(main), 'demo data, mode and camera never go to the save store or the session');
  for (const s of ['非正式實驗世界', '展示情境', '完整剖面', '地表', '地下', '跟隨螞蟻', '尚未模擬', '資料分類', '存檔']) ok(html.includes(s), `demo2.html shows 「${s}」`);
  for (const s of ['引擎', '顯示插值', '展示假設', '示範資料', '尚未模擬', '費洛蒙：尚未模擬', 'WebGL 2', 'WebGPU']) ok(main.includes(s), `main.ts labels 「${s}」`);
  ok(!/https?:\/\/(?!localhost)/.test(html.replace(/<!--[\s\S]*?-->/g, '')) && html.includes('"three": "./vendor/three/three.module.js"'), 'no CDN: three from the local vendor copy');
  ok(read('package.json').includes('node cli/web-demo2-data.ts') && read('cli/web-demo2-data.ts').includes('parseLayout'), 'web:build copies the validated layout');
}

console.log(JSON.stringify({ test: 'web-demo2', checks, summary }));

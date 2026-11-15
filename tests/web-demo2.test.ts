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
 *     (round 4: 4m. motion quality — foot slip, turning rate, body overlap, irregular resting, frame-rate invariance)
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
import { ColonyStage, OUTSIDE, CATCHUP_MAX_S, TROPH_HOLD_S, ABSORB_MAX_CM, DRAWN_SPEED_BOUND, STAGE_DISCONTINUITIES, CLASS_LABEL, YAW_RATE_BOUND, TURN_RATE, MEET_GAP_BODY, MEET_ANTENNA, lateral, LANE_BODY, MEANDER_BODY, type DrawnAnt } from '../web/src/demo2/stage.ts';
import { BLOCK, FOLD_CM, fold, ground, surfacePose, corridor3 } from '../web/src/demo2/surface.ts';
import { roster, colonyOf, engineFeed, demoFeed, missingCastes, engineCastes, DEMO_COUNTS, DEMO_BADGE, NATURAL_BADGE, DEMO_FOOD_PROPS } from '../web/src/demo2/feed.ts';
import { larvaSpot, carerSpot, queenSpot, queenPlace, eggSpot, pupaSpot, majorSpot, chamberPlaces, placeFrame, BODY } from '../web/src/demo2/places.ts';
import { separate, penetration, axisDistance, type Body } from '../web/src/demo2/separate.ts';
import { STRIDE_PER_BODY, STRIDE_SPREAD, MODEL_LEN, POSE_TARGET, strideCm, phase0, gaitPhase, stanceAmp, poseValues, footTip, legCycle, tripodGroup, HIPS } from '../web/src/demo2/gait.ts';
import { placeLabels, anyOverlap, type LabelBox } from '../web/src/demo2/labels.ts';
import { RIG, glf } from '../web/src/demo2/rig-params.ts';
/** the night grade of hd2d.ts is the identity tint with saturation 1 (read from the source: the module needs three) */
const HD2D_GRADE_NIGHT_NEUTRAL = (src: string) => /night: \{ tint: \[1\.0, 1\.0, 1\.0\], sat: 1\.0,/.test(src);
/** the GLSL rig text, taken from ant-rig.ts without loading three in Node: the template is evaluated with the shared table */
const RIG_GLSL_TEXT = (): string => { const src = fs.readFileSync(path.join(REPO_ROOT, 'web/src/demo2/ant-rig.ts'), 'utf8'), a = src.indexOf('export const RIG_GLSL = /* glsl */ `') + 'export const RIG_GLSL = /* glsl */ `'.length, b = src.indexOf('`;', a); return new Function('K', 'f', 'return `' + src.slice(a, b) + '`;')(RIG, glf) as string; };

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
  let n = 0, exits = 0, entries = 0, trace = '', maxLag = 0, restMoves = 0, maxAbs = 0, troph = 0, brood = 0, odoStill = 0;
  const steps = Math.round((t1 - t0) / dt);
  for (let i = 0; i <= steps; i++) {
    const t = t0 + i * dt;
    if (i % every === 0) { const before = JSON.stringify(f); stage.onEvents(world.advanceTo(t).events as unknown as EventMsg[]); f = frameOf(world); if (i % 200 === 0) { const copy = JSON.stringify(f); stage.update(f, vis, t, 0); ok(JSON.stringify(f) === copy && typeof before === 'string', 'the frame is not mutated'); } }
    const ants = stage.update(f, vis, t, 0.016);
    if (ants.length !== 30 || new Set(ants.map((a) => a.id)).size !== 30) ok(false, 'always the same 30 workers, one drawn point each');
    for (const a of ants) {
      n++; const w = f.workers.find((x) => x.id === a.id)!, p = prev.get(a.id), pw = prevW.get(a.id);
      maxAbs = Math.max(maxAbs, a.absorbed); if (a.pose === 'troph') troph++; if (a.pose === 'brood') brood++;
      // the odometer never runs backward, never jumps (a cut of the drawn point is not a walk), and stands still for a standing ant
      if (p) { const d = a.odo - p.odo; if (d < -1e-9 || d > DRAWN_SPEED_BOUND * v * dt + 0.6 * L * TURN_RATE * 1.5 * dt + 0.05) ok(false, `${a.id}: odometer step ${d.toFixed(3)} cm at t=${t.toFixed(1)}`); if (!a.moving && !p.moving && !a.turning && !p.turning && a.pose === p.pose && Math.abs(d) > 1e-9 && a.realm === 'nest') odoStill++; }
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
  ok(odoStill === 0, `seed ${seed}: a standing worker's odometer (and so its gait phase) does not advance`);
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
  // the candidate world 'p0a2-colony' (PR #263): its frame carries `colony`; those castes become ENGINE individuals
  // (with their own 尚未模擬 labels) and the demo provider stops supplying them — also in 展示情境
  const item = (id: string) => ({ id, state: 'in_nest', alive: true, not_simulated: ['feeding', 'x'] });
  const colony = { world_kind: 'p0a2-colony', queens: [item('q01'), item('q02'), item('q03')], majors: [item('m01'), item('m02')], eggs: Array.from({ length: 8 }, (_, i) => item(`e0${i + 1}`)), pupae: [item('p01'), { ...item('p02'), alive: false }], not_simulated_fields: { feeding: '進食：尚未模擬' } };
  const f2 = { ...f, colony } as unknown as P0a2FrameMsg, n2 = roster('natural', f2, 5), r2 = roster('demo', f2, 5);
  ok(colonyOf(f) === null && colonyOf(f2) !== null && colonyOf({ ...f, colony: { ...colony, world_kind: 'x' } } as unknown as P0a2FrameMsg) === null, 'the colony roster is read only from a p0a2-colony frame');
  ok(missingCastes(f2).length === 0 && n2.counts.queen.engine === 3 && n2.counts.major.engine === 2 && n2.counts.egg.engine === 8 && n2.counts.pupa.engine === 1 && n2.counts.minor.engine === 30 && n2.individuals.every((x) => x.source === 'engine'), 'candidate world: queens, majors, eggs, pupae are engine individuals in natural mode (a dead one is not drawn)');
  ok(r2.individuals.every((x) => x.source === 'engine') && JSON.stringify(r2.individuals) === JSON.stringify(n2.individuals), 'a caste the engine supplies is never duplicated by demo data');
  const q1 = n2.individuals.find((x) => x.id === 'q01')!; ok(q1.caste === 'queen' && JSON.stringify(q1.notes) === JSON.stringify(['進食：尚未模擬', 'x']) && q1.state!.includes('尚未模擬'), 'an engine queen carries its own 尚未模擬 labels');
  ok(engineFeed(f).source === 'engine' && demoFeed(1, ['queen']).source === 'demo' && demoFeed(1, ['queen']).individuals().every((x) => x.caste === 'queen'), 'two providers behind one interface');
  ok(DEMO_FOOD_PROPS.every((p) => p.label_zh.includes('示範道具') && p.label_zh.includes('尚未模擬')), 'demo food props are labelled inert');
}

// 4. gait and surface fold
{
  // gait (round 4): every value is a function of the odometer / of simulated time — nothing is integrated per frame
  const ids = Array.from({ length: 30 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`), st = strideCm('w007', L);
  ok(Math.abs(gaitPhase('w007', 4, L) - gaitPhase('w007', 3, L) - (1 / st) * Math.PI * 2) < 1e-9 && gaitPhase('w007', 3, L) === gaitPhase('w007', 3, L), 'gait phase = drawn distance / stride (a function of the odometer: the same distance gives the same phase)');
  ok(ids.every((id) => strideCm(id, L) >= STRIDE_PER_BODY * L * (1 - STRIDE_SPREAD) - 1e-9 && strideCm(id, L) <= STRIDE_PER_BODY * L * (1 + STRIDE_SPREAD) + 1e-9) && new Set(ids.map((id) => strideCm(id, L).toFixed(4))).size >= 28 && new Set(ids.map((id) => phase0(id).toFixed(3))).size >= 28, 'stride and starting phase vary per individual within the stated spread (no lockstep)');
  const far = poseValues('walk', 'rest', 60), at0 = poseValues('walk', 'rest', 0);
  ok(far.crouch === 1 && far.legs === 0 && far.scan === 0 && JSON.stringify(at0) === JSON.stringify(POSE_TARGET.walk) && JSON.stringify(poseValues('walk', 'rest', 0.2)) === JSON.stringify(poseValues('walk', 'rest', 0.2)), 'a pose change blends from the previous pose (continuous at the change) to the new one; a function of simulated time');
  ok(POSE_TARGET.walk.scan === 1 && POSE_TARGET.rest.scan === 0 && POSE_TARGET.troph.conv === 1 && POSE_TARGET.brood.conv > 0.5 && POSE_TARGET.stand.scan > 0 && POSE_TARGET.stand.scan < 1, 'antennae: scanning while walking, less while standing, still at rest, toward the partner / larva in a contact');
  for (let y = -30; y <= 30; y += 0.37) { const a = fold({ x: 3, y }, 0.4), b = fold({ x: 3, y: y + 0.001 }, 0.4); ok(a.y >= -FOLD_CM - 1e-9 && Math.abs(a.y - b.y) <= 0.001 + 1e-9, 'fold: behind the cut, continuous'); }
  const { world } = P0a2ExperimentWorld.create('exp-demo2-test', 1); world.advanceTo(9 * 3600); const f = frameOf(world), vis = VisModel.of(f);
  for (const w of f.workers) if (OUTSIDE.has(w.state)) { const s = surfacePose(vis, w, f.t_sim, L); ok(s.z <= FOLD_CM + 1e-9 && Math.abs(s.y - ground(s.x, s.z)) < 1e-9 && s.x > BLOCK.x0 && s.x < BLOCK.x1 && s.z > BLOCK.z0, 'surface pose on the drawn ground, inside the block'); }
  const C = corridor3(vis); ok(C.every((p) => p.x > BLOCK.x0 + 5 && p.x < BLOCK.x1 - 5 && p.z > BLOCK.z0 + 5 && p.z < BLOCK.z1), 'the whole display route lies on the block');
}

// 4m. motion quality (round 4; display only — the world has no kinematics, body contact or antennation: M21 / M22)
{
  const pct = (a: number[], q: number) => { if (!a.length) return 0; const srt = [...a].sort((x, y) => x - y); return srt[Math.min(srt.length - 1, Math.floor(q * srt.length))]; };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  // --- the leg rule (gait.ts footTip = the CPU form of what both shader rigs compute from rig-params.ts) ---
  const legsSrc = read('web/src/three/ant-model.ts'), rows = [...legsSrc.matchAll(/\{ hip: \[([^\]]+)\], knee: \[[^\]]+\], foot: \[[^\]]+\], tip: \[([^\]]+)\] \}/g)].map((m) => ({ hip: m[1].split(',').map(Number), tip: m[2].split(',').map(Number) }));
  ok(rows.length === 3 && rows.every((r, i) => r.hip.every((v, k) => v === HIPS[i][k]) && Math.abs(r.tip[0] - r.hip[0] - RIG.leg.reach[i][0]) < 1e-12 && Math.abs(r.tip[2] - r.hip[2] - RIG.leg.reach[i][1]) < 1e-12) && new RegExp(`MODEL_LEN = ${MODEL_LEN}\\b`).test(legsSrc), 'the leg rule uses the hips and the neutral reach of the drawn ant model (ant-model.ts LEGS)');
  ok([0, 2, 4].every((l) => tripodGroup(l) === 0) && [1, 3, 5].every((l) => tripodGroup(l) === 1), 'alternating tripod: fore + hind of one side with the mid leg of the other');
  let worstSlip = 0, tripod = true, lifts = true, fwd = true;
  for (const id of ['w001', 'w013', 'w027']) {
    const stride = strideCm(id, L), A = stanceAmp(stride, L), strideModel = (stride / L) * MODEL_LEN, down = new Map<number, number>();
    ok(Math.abs(4 * A - strideModel) < 1e-12, 'stance amplitude: the stance sweep (2A) is half a stride');
    for (let i = 0; i <= 4000; i++) {
      const odoModel = (i / 4000) * strideModel * 5, ph = phase0(id) + (odoModel / strideModel) * Math.PI * 2; let inStance = 0;
      for (let leg = 0; leg < 6; leg++) {
        const tp = footTip(leg, ph, A), world = odoModel + tp.x, c = legCycle(leg, ph).cyc;
        if (tp.stance) { inStance++; if (tp.y !== 0) lifts = false; const at = down.get(leg); if (at === undefined) down.set(leg, world); else worstSlip = Math.max(worstSlip, Math.abs(world - at)); }
        else { down.delete(leg); if (tp.y < 0 || (c > 0.55 && c < 0.95 && tp.y <= 0)) lifts = false; const nx = footTip(leg, ph + 1e-4, A); if (!nx.stance && nx.x < tp.x - 1e-12) fwd = false; }
      }
      if (inStance !== 3 && Math.min(...[0, 1, 2, 3, 4, 5].map((l) => { const c = legCycle(l, ph).cyc; return Math.min(Math.abs(c - 0.5), c, 1 - c); })) > 1e-6) tripod = false;
    }
  }
  ok(worstSlip < 1e-9, `walking straight, a stance foot does not move over the ground at all (worst ${worstSlip.toExponential(1)} model units, at any speed: phase follows distance)`);
  ok(tripod && lifts && fwd, 'three feet on the ground at every instant; a swinging foot is lifted and only moves forward');
  ok(JSON.stringify(footTip(2, 1.3, 0)) === JSON.stringify(footTip(2, 4.4 + Math.PI * 2 * 7, 0, 0)) || footTip(2, 1.3, 0).x === HIPS[2][0] + RIG.leg.reach[2][0], 'no stride reach (turning in place) or no stride pose (resting): the foot is at its neutral place');
  const rigSrc = read('web/src/demo2/ant-rig.ts'), tslSrc = read('web/src/demo2/ant-rig-tsl.ts');
  ok(/D = A \* \(1\.0 - 4\.0 \* cyc\)/.test(rigSrc) && /K\.leg\.reach\[0\]/.test(rigSrc) && /aMore/.test(rigSrc) && /aMore/.test(tslSrc) && /leg\.reach/.test(tslSrc) && /uTime\.value = tNow % CLOCK_WRAP_S/.test(read('web/src/demo2/main.ts')), 'both rigs take the stance sweep, the reach and the stride amplitude from the shared table / the per-instance values; the micro-motion clock is simulated time');

  // --- display separation of bodies (separate.ts) ---
  const B = (id: string, x: number, z: number, fx: number, mob = 1, realm: 'nest' | 'surface' = 'nest'): Body => ({ id, realm, x, y: 0, z, fx, fy: 0, fz: 0, len: L, mob, zLo: -2.5, zHi: 1.8, partner: null });
  const pair = [B('a', 0, 0.02, 1), B('b', 1.2, 0, -1)], S1 = separate(pair), S2 = separate([...pair].reverse());
  const moved = (bs: Body[], m: Map<string, { x: number; z: number }>) => bs.map((b) => ({ ...b, x: b.x + (m.get(b.id)?.x ?? 0), z: b.z + (m.get(b.id)?.z ?? 0) }));
  ok(penetration(pair[0], pair[1]) > 0.5 && penetration(...(moved(pair, S1) as [Body, Body])) <= 1e-6 && [...S1.values()].every((o) => o.x === 0) && JSON.stringify([...S1].sort()) === JSON.stringify([...S2].sort()), 'two bodies meeting head-on in the nest are moved apart along the cavity depth only; the result does not depend on the order of the list');
  const withRest = [B('a', 0, 0, 1), B('r', 0.6, 0.1, 1, 0)], S3 = separate(withRest);
  ok(!S3.has('r') && penetration(...(moved(withRest, S3) as [Body, Body])) <= 1e-6, 'a resting body is never moved: the walker gives way');
  ok(separate([B('a', 0, 0, 1), B('b', 5, 0, -1)]).size === 0 && separate([B('a', 0, 1.7, 1), B('b', 0.3, 1.75, 1)]).get('b')!.z + 1.75 <= 1.8 + 1e-9, 'bodies apart are not touched; a correction stays inside the cavity depth');
  let steep = 0; { let prevO = 0; for (let gx = 4; gx >= -4; gx -= 0.01) { const o = separate([B('a', 0, 0.05, 1), B('b', gx, 0, -1)]).get('a')?.z ?? 0; steep = Math.max(steep, Math.abs(o - prevO)); prevO = o; } }
  ok(steep < 0.03, `the correction changes continuously as two bodies pass each other (largest change per 0.01 cm of travel: ${steep.toFixed(4)} cm)`);
  const sf = separate([B('a', 0, 0, 1, 1, 'surface'), B('b', 1.0, 0.05, -1, 1, 'surface')]);
  ok(sf.size === 2 && Math.abs(sf.get('a')!.x) < 1e-9 && Math.abs(sf.get('a')!.z) > 0.1, 'on the surface a body is moved sideways to its heading');
  ok(Math.abs(axisDistance(B('a', 0, 0, 1), B('b', 3, 0, 1)).d - (3 - 2 * BODY.half * L)) < 1e-9, 'body model: a capsule along the heading');
  ok(MEET_ANTENNA === 0 && POSE_TARGET.troph.conv === 1 && POSE_TARGET.brood.conv > 0 && POSE_TARGET.walk.conv === 0 && POSE_TARGET.stand.conv === 0, 'the forward-antenna pose exists only in poses staged from an engine event (trophallaxis, larva contact); not for display-only meetings');
  ok(MEET_GAP_BODY * L - 2 * BODY.half * L >= 2 * BODY.r * L, 'two ants meeting head to head stop where their bodies do not overlap');
  for (let d = 0; d < 200; d += 3.7) { const lat = lateral('w004', 100, d, Math.min(d, 200 - d), L); ok(lat >= 0 && lat <= (LANE_BODY + MEANDER_BODY) * L + 1e-9 && (Math.min(d, 200 - d) < 4 || lat >= (LANE_BODY - MEANDER_BODY) * L - 1e-9), 'surface trips keep to the right of the display path (bounded, none at the two ends)'); }
  ok(lateral('w004', 100, 0, 0, L) === 0 && 2 * (LANE_BODY - MEANDER_BODY) * L >= 2 * BODY.r * L - 0.3 && new Set([10, 20, 30, 40, 50].map((d) => lateral('w004', 100, d, 50, L).toFixed(3))).size >= 4, 'the lane vanishes at the nest and at the source (engine instants unchanged); it meanders; opposite directions pass on opposite sides');

  // --- irregular places (places.ts) ---
  const restChambers = [...g.chambersOf('rest'), ...g.chambersOf('exchange')].map((c) => c.id), all = restChambers.flatMap((c) => chamberPlaces(g, c, L, true));
  const bodyAt = (pl: ReturnType<typeof chamberPlaces>[number], id = pl.id): Body => { const p = g.point(pl.pos), fr = placeFrame(pl); return { id, realm: 'nest', x: p.x, y: p.y + pl.lift, z: p.z, fx: fr.f.x, fy: fr.f.y, fz: fr.f.z, len: L, mob: 0, zLo: p.z, zHi: p.z, partner: null }; };
  ok(all.length >= 31, `irregular resting places for all 30 workers (${all.length}: ${all.filter((x) => !x.wall).length} on the floor, ${all.filter((x) => x.wall).length} on the back wall)`);
  let frontOv = 0, pen3 = 0, sameFace = 0, sameRow = 0, prs = 0, inside = true; const cvs: number[] = [];
  for (const c of restChambers) {
    const P = chamberPlaces(g, c, L, true), bs = P.map((x) => bodyAt(x)), ex = (b: Body) => L * (BODY.half * Math.abs(b.fx) + BODY.r), ey = (b: Body) => L * (BODY.half * Math.abs(b.fy) + BODY.r);
    for (const b of bs) if (!(g.sdf(b.x, b.y + 0.3) < 0) || b.z < g.backZ || b.z > g.faceZ) inside = false;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      prs++; if (Math.abs(bs[i].x - bs[j].x) < ex(bs[i]) + ex(bs[j]) && Math.abs(bs[i].y - bs[j].y) < ey(bs[i]) + ey(bs[j])) frontOv++;
      if (penetration(bs[i], bs[j]) > 0) pen3++; if (bs[i].fx * bs[j].fx + bs[i].fy * bs[j].fy + bs[i].fz * bs[j].fz > Math.cos((5 * Math.PI) / 180)) sameFace++; if (Math.abs(bs[i].z - bs[j].z) < 0.05 && Math.abs(bs[i].y - bs[j].y) < 0.05) sameRow++;
    }
    const nn = bs.map((a) => Math.min(...bs.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)))); cvs.push(Math.sqrt(mean(nn.map((d) => (d - mean(nn)) ** 2))) / mean(nn));
    for (let i = 0; i < 4; i++) { const m = majorSpot(g, i, 1, L); if (g.edges[m.pos.edge].chamber !== c) continue; const mp = g.point(m.pos), mb: Body = { id: 'm', realm: 'nest', x: mp.x, y: mp.y, z: mp.z, fx: Math.cos(m.yaw), fy: 0, fz: Math.sin(m.yaw), len: L * 1.45, mob: 0, zLo: 0, zHi: 0, partner: null }; for (const b of bs) if (penetration(b, mb) > 0) pen3++; }
  }
  ok(inside && frontOv === 0 && pen3 === 0, 'resting places: inside the cavity; no two overlap when seen from the front; none overlaps another or a major');
  // the round-3 arrangement for comparison: the slot grid of nest-graph.ts (rows and columns, two facings)
  const gridCv = restChambers.map((c) => { const S = g.slots(c, L).map((x) => g.point(x.pos)), nn = S.map((a) => Math.min(...S.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.z - b.z)))); return Math.sqrt(mean(nn.map((d) => (d - mean(nn)) ** 2))) / mean(nn); });
  ok(sameFace / prs < 0.06 && sameRow / prs < 0.05 && Math.min(...cvs) >= 0.15 && cvs.every((x, i) => x > 2 * gridCv[i]), `resting places are irregular: ${(100 * sameFace / prs).toFixed(1)}% of pairs face the same way (±5°), ${sameRow} of ${prs} pairs level with each other (two wall places at the same height), nearest-neighbour spacing CV ${cvs.map((x) => x.toFixed(2)).join(' / ')} (the round-3 slot grid: ${gridCv.map((x) => x.toFixed(2)).join(' / ')})`);
  summary.rest_places = { grid_nn_spacing_cv_round3: gridCv.map((x) => Number(x.toFixed(3))), capacity: all.length, same_facing_pct: Number((100 * sameFace / prs).toFixed(2)), nn_spacing_cv: cvs.map((x) => Number(x.toFixed(3))) };
  const entry = chamberPlaces(g, g.chambersOf('entry')[0].id, L, false), eb = entry.map((x) => bodyAt(x));
  ok(entry.length >= 4 && eb.every((a, i) => eb.every((b, j) => j <= i || penetration(a, b) <= 0)) && new Set(entry.map((x) => x.yaw.toFixed(2))).size === entry.length, `standing places in the entry chamber: ${entry.length}, no overlap, every heading different`);
  for (const [name, spot, n, dmin] of [['larvae', larvaSpot, 8, 0.45 * L], ['larvae (many)', larvaSpot, 24, 0.25 * L], ['pupae', pupaSpot, 10, 0.35 * L]] as const) {
    const pts = Array.from({ length: n }, (_, i) => g.point(spot(g, i, n, L))); let dm = Infinity; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) dm = Math.min(dm, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
    ok(dm >= dmin && new Set(pts.map((q) => q.x.toFixed(3))).size === n && new Set(pts.map((q) => q.z.toFixed(3))).size === n && JSON.stringify(pts) === JSON.stringify(Array.from({ length: n }, (_, i) => g.point(spot(g, i, n, L)))), `${name}: an irregular pile (no rows or columns, nearest pair ${dm.toFixed(2)} cm apart), deterministic`);
  }
  for (const n of [2, 3]) { const qs = Array.from({ length: n }, (_, i) => queenPlace(g, i, n, L)), qb = qs.map((q, i): Body => { const p = g.point(q.pos); return { id: `q${i}`, realm: 'nest', x: p.x, y: p.y, z: p.z, fx: Math.cos(q.yaw), fy: 0, fz: Math.sin(q.yaw), len: L * 2.5, mob: 0, zLo: 0, zHi: 0, partner: null }; });
    ok(qb.every((a, i) => qb.every((b, j) => j <= i || penetration(a, b) <= 0)) && new Set(qs.map((q) => q.yaw.toFixed(2))).size === n && qs.every((q) => g.edges[q.pos.edge].chamber === g.chambersOf('queen')[0].id), `${n} queens: in the queen chamber, not overlapping, not facing the same way`); }

  // --- the display director over real worlds: turning, slip, overlap, resting arrangement ---
  function motion(seed: number, h0: number, minutes: number, every = 4) {
    const { world, events } = P0a2ExperimentWorld.create('exp-demo2-test', seed), stage = new ColonyStage(g, L), dt = 0.05, T0 = h0 * 3600, steps = Math.round((minutes * 60) / dt);
    stage.onEvents(events as unknown as EventMsg[]); stage.onEvents(world.advanceTo(T0).events as unknown as EventMsg[]); let f = frameOf(world); const vis = VisModel.of(f), v = f.layout.source_distance_cm / f.layout.travel_s;
    const prev = new Map<string, DrawnAnt>(), stance = new Map<string, { x: number; y: number; z: number; m: number; w: boolean }>(), slips: number[] = [], yaws: number[] = [], startSp: number[] = [], walkSp: number[] = [], since = new Map<string, number>(), walkRun = new Map<string, number>();
    let maxYaw = 0, close = 0, pen = 0, deep = 0, restPairs = 0, front = 0, same = 0, row = 0, turnSamples = 0, turnMoved = 0, meet = 0, restScan = 0, tilt = true; const cv: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = T0 + i * dt; if (i % every === 0) { stage.onEvents(world.advanceTo(t).events as unknown as EventMsg[]); f = frameOf(world); }
      const ants = stage.update(f, vis, t, 0);
      if (i === 100) ok(JSON.stringify(stage.at(t)) === JSON.stringify(ants) && JSON.stringify(stage.at(t)) === JSON.stringify(ants), 'paused: the same instant drawn again is identical (nothing advances without simulated time)');
      for (const a of ants) {
        const p = prev.get(a.id), jump = p ? Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) : 0, cut = !p || p.realm !== a.realm || jump > DRAWN_SPEED_BOUND * v * dt + 0.05;
        if (Math.abs(Math.hypot(a.fx, a.fy, a.fz) - 1) > 1e-6 || Math.abs(Math.hypot(a.ux, a.uy, a.uz) - 1) > 1e-6 || Math.abs(a.fx * a.ux + a.fy * a.uy + a.fz * a.uz) > 1e-6) ok(false, `${a.id}: the drawn body frame is not orthonormal`);
        if (p && !cut) {
          const w = Math.max(Math.acos(Math.max(-1, Math.min(1, a.fx * p.fx + a.fy * p.fy + a.fz * p.fz))), Math.acos(Math.max(-1, Math.min(1, a.ux * p.ux + a.uy * p.uy + a.uz * p.uz)))) / dt; yaws.push(w); maxYaw = Math.max(maxYaw, w);
          if (a.turning && p.turning) { turnSamples++; if (a.sep === 0 && p.sep === 0 && a.absorbed === 0 && p.absorbed === 0 && jump > 1e-9) turnMoved++; }
          if (a.moving && a.realm === 'nest' && a.sep === 0 && p.sep === 0) { if (!p.moving) since.set(a.id, 0); const k = since.get(a.id); if (k !== undefined && k < 3) { startSp.push(jump / dt); since.set(a.id, k + 1); } else walkSp.push(jump / dt); }
        }
        // (the pose of an engine contact fades out over POSE_BLEND_S after it ends: only ants that have been walking for a second count)
        walkRun.set(a.id, a.pose === 'walk' ? (walkRun.get(a.id) ?? 0) + 1 : 0); if (a.pose === 'walk' && walkRun.get(a.id)! > 20 && a.pv.conv > 0.02) meet++;
        if (a.pose === 'rest' && !a.moving && p && p.pose === 'rest' && a.pv.crouch === 1 && a.pv.scan !== 0) restScan++;
        // foot slip: how far a stance tarsus moves over the ground between touch-down and lift-off (walking stances only)
        const zx = a.fy * a.uz - a.fz * a.uy, zy = a.fz * a.ux - a.fx * a.uz, zz = a.fx * a.uy - a.fy * a.ux, sc = L / MODEL_LEN;
        for (let leg = 0; leg < 6; leg++) {
          const key = `${a.id}|${leg}`, tp = footTip(leg, a.phase, a.amp, a.pv.legs), st = stance.get(key), wx = a.x + (a.fx * tp.x + a.ux * tp.y + zx * tp.z) * sc, wy = a.y + (a.fy * tp.x + a.uy * tp.y + zy * tp.z) * sc, wz = a.z + (a.fz * tp.x + a.uz * tp.y + zz * tp.z) * sc;
          if (cut || !tp.stance) { if (st && !cut && st.w) slips.push(st.m); stance.delete(key); if (tp.stance && !cut) stance.set(key, { x: wx, y: wy, z: wz, m: 0, w: a.moving }); continue; }
          if (!st) { stance.set(key, { x: wx, y: wy, z: wz, m: 0, w: a.moving }); continue; }
          st.w = st.w && a.moving; st.m = Math.max(st.m, Math.hypot(wx - st.x, wy - st.y, wz - st.z));
        }
        prev.set(a.id, a);
      }
      if (i % 20 === 0) {
        const bs = ants.map((a): Body => ({ id: a.id, realm: a.realm, x: a.x, y: a.y, z: a.z, fx: a.fx, fy: a.fy, fz: a.fz, len: L, mob: 1, zLo: 0, zHi: 0, partner: null }));
        for (let x = 0; x < bs.length; x++) for (let y = x + 1; y < bs.length; y++) { if (bs[x].realm !== bs[y].realm || Math.hypot(bs[x].x - bs[y].x, bs[x].y - bs[y].y, bs[x].z - bs[y].z) > L * 1.2) continue; close++; const d = penetration(bs[x], bs[y]); if (d > 0.02 * L) pen++; if (d > 0.3) deep++; }
        const by = new Map<string, DrawnAnt[]>(); for (const a of ants) if (a.pose === 'rest' && !a.moving && a.partner === null) by.set(a.place, [...(by.get(a.place) ?? []), a]);
        for (const l of by.values()) {
          const ex = (a: DrawnAnt) => L * (BODY.half * Math.abs(a.fx) + BODY.r), ey = (a: DrawnAnt) => L * (BODY.half * Math.abs(a.fy) + BODY.r);
          for (let x = 0; x < l.length; x++) for (let y = x + 1; y < l.length; y++) { restPairs++; if (Math.abs(l[x].x - l[y].x) < ex(l[x]) + ex(l[y]) && Math.abs(l[x].y - l[y].y) < ey(l[x]) + ey(l[y])) front++; if (l[x].fx * l[y].fx + l[x].fy * l[y].fy + l[x].fz * l[y].fz > Math.cos((5 * Math.PI) / 180)) same++; if (Math.abs(l[x].z - l[y].z) < 0.05 && Math.abs(l[x].y - l[y].y) < 0.05) row++; }
          if (l.length >= 4) { const nn = l.map((a) => Math.min(...l.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)))); cv.push(Math.sqrt(mean(nn.map((d) => (d - mean(nn)) ** 2))) / mean(nn)); }
        }
        for (const a of ants) if (a.realm === 'surface' && a.sep === 0 && a.absorbed === 0) { const s2 = Math.hypot(a.x, a.z) > 6; if (s2 && Math.abs(a.y - ground(a.x, a.z)) > 1e-6) tilt = false; }
      }
    }
    return { seed, h0, minutes, max_turn_rate: Number(maxYaw.toFixed(2)), turn_rate_p999: Number(pct(yaws, 0.999).toFixed(2)), walk_stances: slips.length, walk_slip_mean_cm: Number(mean(slips).toFixed(3)), walk_slip_p95_cm: Number(pct(slips, 0.95).toFixed(3)), walk_slip_max_cm: Number(pct(slips, 1).toFixed(3)), stride_cm: STRIDE_PER_BODY * L,
      close_pairs: close, overlapping_pct: Number((100 * pen / Math.max(1, close)).toFixed(2)), deep_overlaps: deep, rest_pairs: restPairs, rest_front_overlap_pct: Number((100 * front / Math.max(1, restPairs)).toFixed(3)), rest_same_facing_pct: Number((100 * same / Math.max(1, restPairs)).toFixed(2)), rest_same_row_pct: Number((100 * row / Math.max(1, restPairs)).toFixed(2)), rest_nn_spacing_cv: Number(mean(cv).toFixed(3)),
      turn_in_place_samples: turnSamples, turnMoved, start_speed: Number(mean(startSp).toFixed(2)), walk_speed: Number(mean(walkSp).toFixed(2)), meet, restScan, tilt };
  }
  const M = [motion(1, 9, 12), motion(3, 22, 12)]; summary.motion = M;
  for (const m of M) {
    ok(m.max_turn_rate <= YAW_RATE_BOUND, `seed ${m.seed}: the drawn body never turns faster than ${YAW_RATE_BOUND} rad/s — no heading flip (max ${m.max_turn_rate}, 99.9th percentile ${m.turn_rate_p999}; turn rate ${TURN_RATE} rad/s, eased peak × 1.5)`);
    ok(m.walk_stances > 12000 && m.walk_slip_mean_cm <= 0.1 * m.stride_cm && m.walk_slip_p95_cm <= 0.32 * m.stride_cm, `seed ${m.seed}: walking stance feet stay planted (slip mean ${m.walk_slip_mean_cm} cm, 95th percentile ${m.walk_slip_p95_cm} cm, stride ${m.stride_cm} cm; ${m.walk_stances} stances; bends, lane changes and give-way moves are what is left)`);
    ok(m.close_pairs > 5000 && m.overlapping_pct <= 2.5, `seed ${m.seed}: bodies are kept apart (${m.overlapping_pct}% of ${m.close_pairs} close pairs overlap by more than 2% of a body length; ${m.deep_overlaps} deeper than 0.3 cm)`);
    ok(m.rest_pairs > 1000 && m.rest_front_overlap_pct <= 0.2 && m.rest_same_facing_pct <= 6 && m.rest_same_row_pct <= 5 && m.rest_nn_spacing_cv >= 0.15, `seed ${m.seed}: resting workers are arranged irregularly (front-view overlap ${m.rest_front_overlap_pct}% of pairs, same facing ${m.rest_same_facing_pct}%, same row ${m.rest_same_row_pct}%, nearest-neighbour spacing CV ${m.rest_nn_spacing_cv})`);
    ok(m.turn_in_place_samples > 200 && m.turnMoved === 0, `seed ${m.seed}: large heading changes are turned in place (${m.turn_in_place_samples} samples; the body does not travel while it turns)`);
    ok(m.start_speed < 0.75 * m.walk_speed, `seed ${m.seed}: a walk starts with a speed ramp (first 0.15 s: ${m.start_speed} cm/s, walking: ${m.walk_speed} cm/s)`);
    ok(m.meet === 0 && m.restScan === 0 && m.tilt, `seed ${m.seed}: a walking ant never shows an antennation pose (two ants that merely pass on screen are not an engine contact: ${m.meet} samples), a settled resting ant does not scan, surface ants stand on the drawn ground`);
  }
  // --- frame-rate invariance: the same frames sampled at different rates give the same drawn ants at the same instant ---
  {
    const mk = () => { const { world, events } = P0a2ExperimentWorld.create('exp-demo2-test', 5), stage = new ColonyStage(g, L); stage.onEvents(events as unknown as EventMsg[]); stage.onEvents(world.advanceTo(11 * 3600).events as unknown as EventMsg[]); return { world, stage }; };
    const A = mk(), Bq = mk(), C = mk(), T0 = 11 * 3600, at: string[][] = [[], [], []]; let fA = frameOf(A.world), fB = frameOf(Bq.world), fC = frameOf(C.world); const vis = VisModel.of(fA);
    for (let i = 0; i <= 900 * 4; i++) { // A: 20 samples per simulated second
      const t = T0 + i * 0.05; if (i % 4 === 0) { A.stage.onEvents(A.world.advanceTo(t).events as unknown as EventMsg[]); fA = frameOf(A.world); } const d = A.stage.update(fA, vis, t, 0.05); if (i % 20 === 0) at[0].push(JSON.stringify(d));
    }
    for (let i = 0; i <= 900; i++) { // B: 5 samples per second (one per frame), and a different "wall dt"
      const t = T0 + i * 0.2; Bq.stage.onEvents(Bq.world.advanceTo(t).events as unknown as EventMsg[]); fB = frameOf(Bq.world); const d = Bq.stage.update(fB, vis, t, 0.2); if (i % 5 === 0) at[1].push(JSON.stringify(d));
    }
    for (let i = 0; i <= 900; i++) { // C: frames ingested as they come; drawn only once per simulated second, plus irregular extra instants
      const t = T0 + i * 0.2; C.stage.onEvents(C.world.advanceTo(t).events as unknown as EventMsg[]); fC = frameOf(C.world); C.stage.ingest(fC, vis); if (i % 7 === 3) C.stage.at(t + 0.137); if (i % 5 === 0) at[2].push(JSON.stringify(C.stage.at(t)));
    }
    const diff = (x: string[], y: string[]) => x.findIndex((v, i) => v !== y[i]);
    ok(at[0].length === 181 && diff(at[0], at[1]) === -1 && diff(at[0], at[2]) === -1, `the same frames drawn at 20 / 5 / 1 samples per simulated second give identical ants at the same instants (first difference at second ${diff(at[0], at[1])} / ${diff(at[0], at[2])})`);
    // a different FRAME cadence (a higher playback speed delivers fewer frames per simulated second) is a different input: the
    // engine instants still hold (checked by run() above at two cadences); the display walk between them may differ
    const D = mk(); let fD = frameOf(D.world), worst = 0; const prevD = new Map<string, DrawnAnt>();
    for (let i = 0; i <= 3600; i++) { const t = T0 + i * 0.05; if (i % 40 === 0) { D.stage.onEvents(D.world.advanceTo(t).events as unknown as EventMsg[]); fD = frameOf(D.world); }
      for (const a of D.stage.update(fD, vis, t, 0)) { const p = prevD.get(a.id); if (p && p.realm === a.realm && Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) < 0.4) worst = Math.max(worst, Math.max(Math.acos(Math.max(-1, Math.min(1, a.fx * p.fx + a.fy * p.fy + a.fz * p.fz))), Math.acos(Math.max(-1, Math.min(1, a.ux * p.ux + a.uy * p.uy + a.uz * p.uz)))) / 0.05); prevD.set(a.id, a); } }
    ok(worst <= YAW_RATE_BOUND, `with one frame per 2 simulated seconds (a high playback speed) the turning bound still holds (max ${worst.toFixed(2)} rad/s)`);
  }
}

// 4b. label placement: placed labels never overlap, stay inside the area, deterministic; crowded anchors are separated
{
  const area = { left: 2, top: 130, right: 410, bottom: 800 }, rnd = (i: number) => ((Math.imul(i + 1, 2654435761) >>> 0) / 4294967296);
  for (let k = 0; k < 40; k++) {
    const items: LabelBox[] = Array.from({ length: 14 }, (_, i) => ({ key: `l${i}`, x: 20 + rnd(k * 31 + i) * 380, y: 300 + rnd(k * 57 + i * 3) * 120, w: 50 + rnd(k + i * 7) * 110, h: 16, prio: i % 3 }));
    const P = placeLabels(items, area), Q = placeLabels([...items].reverse(), area);
    ok(!anyOverlap(P) && P.every((p) => p.left >= area.left - 1e-9 && p.left + p.w <= area.right + 1e-9 && p.top >= area.top - 1e-9 && p.bottom <= area.bottom + 1e-9), 'placed labels do not overlap and stay inside the area');
    ok(JSON.stringify(P) === JSON.stringify(Q) && P.length >= 10, `label placement is order-independent and keeps most labels (${P.length} of 14)`);
  }
  const same = placeLabels([{ key: 'a', x: 200, y: 400, w: 80, h: 16, prio: 2 }, { key: 'b', x: 200, y: 400, w: 80, h: 16, prio: 1 }, { key: 'c', x: 205, y: 401, w: 80, h: 16, prio: 1 }], area);
  ok(same.length === 3 && !anyOverlap(same) && same[0].key === 'a' && same[0].bottom === 400, 'labels with the same anchor are moved apart; the highest priority keeps its place');
  ok(placeLabels([{ key: 'wide', x: 5, y: 10, w: 100, h: 16, prio: 1 }], area)[0].left === area.left && placeLabels([{ key: 'big', x: 5, y: 10, w: 999, h: 16, prio: 1 }], area).length === 0, 'a label is clamped into the area; one that cannot fit is dropped');
  ok(anyOverlap([{ left: 0, top: 0, w: 10, h: 10 }, { left: 5, top: 5, w: 10, h: 10 }]) && !anyOverlap([{ left: 0, top: 0, w: 10, h: 10 }, { left: 10, top: 0, w: 10, h: 10 }]), 'overlap test');
}

// 4c. one rig, two shader languages; the renderer never reaches the display director
{
  const glsl = RIG_GLSL_TEXT(), tsl = read('web/src/demo2/ant-rig-tsl.ts'), params = read('web/src/demo2/rig-params.ts');
  const nums: number[] = []; const walk = (v: unknown) => { if (typeof v === 'number') nums.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(RIG);
  ok(nums.length > 40 && nums.every((v) => glsl.includes(glf(v))), `every rig number of rig-params.ts appears in the GLSL rig (${nums.length} numbers)`);
  ok(/import \{ RIG, CUTICLE \} from '\.\/rig-params\.ts'/.test(tsl) && /import \{ RIG, CUTICLE, glf \} from '\.\/rig-params\.ts'/.test(read('web/src/demo2/ant-rig.ts')), 'both rigs import the one parameter table');
  // the TSL rig holds no amplitude / frequency of its own: its only numeric literals are structural (0, 1, 2, 3, 0.5, part-kind thresholds)
  const lits = [...tsl.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').matchAll(/(?<![\w.\]])(\d+\.\d+|\d+)(?![\w.])/g)].map((m) => Number(m[1]));
  const structural = new Set([0, 1, 2, 3, 4, 0.5, 1.5, 2.5, 3.5]);
  ok(lits.length > 10 && lits.every((v) => structural.has(v)), `the TSL rig has no constants of its own (literals: ${[...new Set(lits)].join(', ')})`);
  ok(glf(1) === '1.0' && glf(0.42) === '0.42' && /qn: \{ amp:/.test(params), 'GLSL float literals');
  for (const x of ['nest-graph.ts', 'stage.ts', 'surface.ts', 'feed.ts', 'places.ts', 'gait.ts', 'separate.ts', 'labels.ts', 'rig-params.ts']) ok(!/renderer|webgpu|webgl/i.test(read(`web/src/demo2/${x}`).replace(/\/\*[\s\S]*?\*\//g, '')), `${x}: no reference to any renderer (the director's output cannot depend on it)`);
  const main = read('web/src/demo2/main.ts');
  ok(/stage\.update\(frame, vis, tNow, dtAnim\)/.test(main) && !/stage\.update\([^)]*(renderer|rendererKind|rigNode)/.test(main) && !/new ColonyStage\([^)]*(renderer|rendererKind)/.test(main), 'main.ts passes only the frame, the display model and time to the director');
  ok(/isWebGPUBackend === true/.test(main) && /不是 WebGPU/.test(main) && /已改用 WebGL 2/.test(main) && /待 Owner 實機確認/.test(main), 'main.ts reports the ACTUAL backend, says when it fell back, and states what is not verified');
}

// 4d. HD-2D picture style: rendering only
{
  const hd = read('web/src/demo2/hd2d.ts'), scene = read('web/src/demo2/scene.ts'), main = read('web/src/demo2/main.ts');
  ok([...hd.matchAll(/from\s+'([^']+)'/g)].every((m) => m[1] === 'three'), 'hd2d.ts imports only three');
  for (const x of ['nest-graph.ts', 'stage.ts', 'surface.ts', 'feed.ts', 'places.ts', 'gait.ts', 'separate.ts', 'labels.ts', 'rig-params.ts']) ok(!/hd2d|pixelat|bloom|vignette|\bstyle\b/i.test(read(`web/src/demo2/${x}`)), `${x}: no reference to the picture style (the director's output cannot depend on it)`);
  ok(/hd2d!\.render\(scene, camera, focus, frame\?\.env\.light \?\? 'day', fx\)/.test(main) && !/client\.\w+\([^)]*(style|pxFactor|fx\b)/.test(main) && !/session\.(request|newGame|open)\([^)]*(style|pxFactor)/.test(main), 'the style reaches only the renderer: never the Worker, the session or the director');
  ok(/world\.setAtmosphere\(frame\.env\.light,/.test(main) && /HD2D_GRADE\[light\]/.test(hd), 'light shafts, dust and the colour grade take the ENGINE light state');
  ok(HD2D_GRADE_NIGHT_NEUTRAL(hd), 'night: no warm grade (the style does not invent a time of day)');
  const a = scene.indexOf('const buildHd = () => {'), b = scene.indexOf('let tris = 0;', a), extras = scene.slice(a, b);
  ok(a > 0 && b > a && !/petal|flower|butterfl|firefl|insect|aphid|nectar|beetle/i.test(extras.replace(/\/\/.*$/gm, '')), 'the HD-2D scenery adds foliage, dust and light only: no flower, no insect, nothing that reads as an individual or a food source');
  ok(/hd\.shafts\.visible = k > 0/.test(scene) && /light === 'civil_twilight' \? 0\.7 : 0/.test(scene), 'light shafts are hidden at night');
  ok(main.includes('HD-2D 目前僅 WebGL 2') && /if \(st === 'hd2d' && rendererKind !== 'webgl2'\)/.test(main), 'HD-2D is refused, with a message, on the WebGPU renderer');
  ok(/if \(hd2dActive\(\) && fx\.dof\) \{ fx\.dof = false;[\s\S]{0,200}else if \(hd2dActive\(\) && fx\.bloom\) \{ fx\.bloom = false;/.test(main), 'auto quality drops depth of field first, then bloom, then the quality level');
  ok(main.includes('畫面效果（HD-2D 風格，選用）') && main.includes('不是生物、不是食物來源'), 'the legend lists the style as display-only');
}

// 5. source scans
{
  const dir = 'web/src/demo2', files = fs.readdirSync(path.join(REPO_ROOT, dir)).filter((x) => x.endsWith('.ts')), html = read('web/demo2.html'), main = read(`${dir}/main.ts`);
  ok(['nest-graph.ts', 'stage.ts', 'surface.ts', 'feed.ts', 'places.ts', 'gait.ts', 'separate.ts', 'ant-rig.ts', 'ant-rig-tsl.ts', 'rig-params.ts', 'labels.ts', 'hd2d.ts', 'scene.ts', 'main.ts'].every((x) => files.includes(x)), 'Demo 2 modules present');
  for (const x of files) {
    const code = read(`${dir}/${x}`);
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) ok(m[1] === 'three' || m[1].startsWith('three/addons/') || (x === 'ant-rig-tsl.ts' && (m[1] === 'three/webgpu' || m[1] === 'three/tsl')) || ((m[1].startsWith('./') || m[1].startsWith('../')) && !/engine\/|cli\/|prototypes\/|worker-dist/.test(m[1]) && !path.posix.normalize(path.posix.join(dir, m[1])).startsWith('web/src/../')), `${x}: imports only viewer modules and vendored three (${m[1]})`);
    ok(!/Math\.random|Date\.now\(\)\s*[*%]|new Worker\(/.test(code), `${x}: no unseeded randomness, no Worker of its own`);
    if (['nest-graph.ts', 'stage.ts', 'surface.ts', 'feed.ts', 'places.ts', 'gait.ts', 'separate.ts', 'labels.ts', 'rig-params.ts'].includes(x)) ok(!/from 'three|document\.|window\.|performance\.|worker-client|session\.ts|save-store/.test(code), `${x}: pure (no DOM, no three, no Worker client, no save store)`);
  }
  const cmds = new Set([...main.matchAll(/client\.(\w+)\(/g)].map((m) => m[1]));
  ok([...cmds].every((c) => ['init', 'stepUntil', 'start', 'pause', 'resume', 'setSpeed', 'follow', 'snapshot'].includes(c)), `main.ts sends only scheduling / observation commands (${[...cmds].join(', ')})`);
  ok(!/sendRaw|postMessage|client\.send\(|client\.restore\(/.test(main), 'main.ts sends no raw message and restores only through the SAVE-2 session');
  ok(!/(roster|rost|demo|statics)[\w.]*\)?\s*\)?;?\s*$/m.test('') && !/store\.(createWorld|saveSnapshot)/.test(main) && !/session\.(request|newGame|open)\([^)]*(rost|demo|statics|mode)/.test(main), 'demo data, mode and camera never go to the save store or the session');
  for (const s of ['非正式實驗世界', '展示情境', '完整剖面', '地表', '地下', '跟隨螞蟻', '尚未模擬', '資料分類', '存檔']) ok(html.includes(s), `demo2.html shows 「${s}」`);
  for (const s of ['引擎', '顯示插值', '展示假設', '示範資料', '尚未模擬', '費洛蒙：尚未模擬', 'WebGL 2', 'WebGPU']) ok(main.includes(s), `main.ts labels 「${s}」`);
  ok(!/https?:\/\/(?!localhost)/.test(html.replace(/<!--[\s\S]*?-->/g, '')) && html.includes('"three": "./vendor/three/three.module.js"') && html.includes('"three/webgpu": "./vendor/three/three.webgpu.js"') && read('cli/web-vendor-three.ts').includes("'build/three.webgpu.js'") && read('cli/web-vendor-three.ts').includes("'build/three.tsl.js'"), 'no CDN: three from the local vendor copy');
  ok(read('package.json').includes('node cli/web-demo2-data.ts') && read('cli/web-demo2-data.ts').includes('parseLayout'), 'web:build copies the validated layout');
}

console.log(JSON.stringify({ test: 'web-demo2', checks, summary }));

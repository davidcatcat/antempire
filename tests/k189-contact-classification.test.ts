/**
 * #189 / #193 ruling 1 — contact_episode (geometric) vs constraint_active (mechanical), one record format for PH-3b,
 * WP4, KIN-2D freeze / project and ANTENNA-GEO (engine/physics/contact-classification.ts). Blocking.
 *  - the same head-on encounter classified from four solvers: one body_body episode each, the same contact time, every
 *    in-contact constraint inside a contact episode;
 *  - the biological gate: antennal signals start only from antenna_body / antenna_antenna episodes of the receiver's
 *    own antenna; COUNTEREXAMPLES: body contact with an active constraint but no antennal contact (the leader of a
 *    rear-end, and any body-only classification) triggers nothing; a constraint_active record passed to the gate is refused;
 *  - antennal contact without body contact and without any constraint can trigger (the two kinds are independent).
 * Physics only. No recognition, transfer or decision is modelled; triggers are permissions, labelled 遊戲假設.
 */
import assert from 'node:assert/strict';
import { solve2D, type Solver2DInput } from '../engine/physics/solver2d.ts';
import { steer2D } from '../engine/physics/local-steer.ts';
import { PlanBuilder, runKinematics, type Track } from '../engine/physics/kinematics2d.ts';
import { runKinematicsWithContactMode } from '../engine/physics/kinematics2d-contact.ts';
import { detectAntennaContacts } from '../engine/physics/antenna-geometry.ts';
import { classifyPh3b, classifySteer, classifyKin, classifyKinProject, classifyAntenna, constraintsOutsideContact, biologicalTriggers, BIO_CONTACT_RULES, ClassificationRefused, type ContactClassification, type ContactEpisode, type ConstraintActive } from '../engine/physics/contact-classification.ts';
import { candidateModel, candidateBody } from '../prototypes/antenna-geometry/lib.ts';
import { permutationsOf } from '../engine/physics/destinations.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const json = (x: unknown) => JSON.stringify(x);
const refuses = (f: () => unknown, why: string) => { try { f(); } catch (e) { ok(e instanceof ClassificationRefused, `${why} (${(e as Error).message.slice(0, 140)})`); return; } ok(false, `${why}: no refusal`); };
const bodyOf = (c: ContactClassification) => c.contact_episodes.filter((e) => e.geometry === 'body_body');

// ---------------------------------------------------------------- one head-on encounter, four solvers
const BODY = { length_mm: 2.5, width_mm: 0.8 }, H = 2;
const lanes = [{ id: 'E', centerline_mm: [{ x: 0, y: 0 }, { x: 40, y: 0 }], width_mm: 4, layer: 'g' }, { id: 'W', centerline_mm: [{ x: 40, y: 0 }, { x: 0, y: 0 }], width_mm: 4, layer: 'g' }];
const ph3bIn: Solver2DInput = { lanes, obstacles: [], horizon_s: H, agents: [
  { id: 'a', lane: 'E', s_mm: 5, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: 35, free_speed_mm_s: 10, body: BODY },
  { id: 'b', lane: 'W', s_mm: 15, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: 35, free_speed_mm_s: 10, body: BODY } ] };
// a at x 5 → E, b at x 25 → W; fronts 20 − 2.5 = 17.5 mm apart at 20 mm/s closing → contact at 0.875 s
const tContact = (25 - 5 - 2.5) / 20;
const steerParams = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: null, p_back: null, p_reroute: null, wait_s: null, back_distance_mm: null, reroute_max_s: null };
const kinTracks = (): Track[] => [new PlanBuilder('a', BODY, { x: 5, y: 0, th: 0 }).straight(30, 10).build(), new PlanBuilder('b', BODY, { x: 25, y: 0, th: Math.PI }).straight(30, 10).build()];
const kinIn = { tracks: kinTracks(), statics: [], horizon_s: H };
const classes: ContactClassification[] = [
  classifyPh3b(solve2D(ph3bIn), H),
  classifySteer(steer2D({ ...ph3bIn, policy: 'none', params: steerParams, seed: 1 }), H),
  classifySteer(steer2D({ ...ph3bIn, policy: 'N_no_yield', params: steerParams, seed: 1 }), H),
  classifyKin(runKinematics(kinIn), H),
  classifyKinProject(runKinematicsWithContactMode(kinIn, 'project'), H),
];
for (const c of classes) {
  const b = bodyOf(c);
  ok(b.length === 1 && b[0].ids.join() === 'a,b' && b[0].antenna === null && b[0].end_is_physical, `${c.source}: one body_body contact_episode a|b (${json(b)})`);
  ok(Math.abs(b[0].start_t_s - tContact) <= 1e-6, `${c.source}: contact at ${tContact} s (${b[0].start_t_s})`);
  ok(c.constraint_active.length > 0 && c.constraint_active.every((k) => k.kind === 'constraint_active'), `${c.source}: the mechanical action is recorded as constraint_active (${c.constraint_active.length})`);
  ok(constraintsOutsideContact(c, 1e-9).length === 0, `${c.source}: every in-contact constraint starts inside a contact episode`);
  ok(c.contact_episodes.every((e) => e.kind === 'contact_episode') && !('cause' in c.contact_episodes[0]), `${c.source}: episodes carry no mechanical field`);
  ok(biologicalTriggers(c.contact_episodes, 'antennation', ['a', 'b']).length === 0 && biologicalTriggers(c.contact_episodes, 'chc_contact', ['a', 'b']).length === 0, `${c.source}: body contact + active constraint, no antenna model → no antennal signal (counterexample)`);
}
ok(new Set(classes.map((c) => c.source)).size === 4 && classes[1].source === 'WP4' && classes[2].source === 'WP4', 'WP4 none is PH-3b re-labelled; N is the WP4 decision grid');
// counterexample: a constraint record is not an episode
refuses(() => biologicalTriggers(classes[0].constraint_active as unknown as ContactEpisode[], 'antennation', ['a', 'b']), 'a constraint_active record passed to the biological gate is refused');
refuses(() => biologicalTriggers([...classes[3].contact_episodes, ...classes[3].constraint_active], 'chc_contact', ['a', 'b']), 'a mixed list with a constraint record is refused (no silent filtering)');
// a constraint that claims contact but lies outside any episode is caught by the consistency check
{
  const bad: ContactClassification = { ...classes[0], constraint_active: [{ kind: 'constraint_active', bodies: ['a', 'b'], partners: ['a', 'b'], start_t_s: 0.1, end_t_s: 0.2, in_contact: true, cause: 'synthetic', source: 'PH-3b' } as ConstraintActive] };
  ok(constraintsOutsideContact(bad, 1e-9).length === 1, 'synthetic in-contact constraint before any contact is flagged');
}
// determinism / input order
for (const p of permutationsOf([0, 1])) {
  const r = classifyPh3b(solve2D({ ...ph3bIn, agents: p.map((i) => ph3bIn.agents[i]) }), H);
  ok(json(r) === json(classes[0]), 'PH-3b classification independent of agent input order');
}

// ---------------------------------------------------------------- biological gate on executed motion with antenna geometry
{
  const m = candidateModel(), body = candidateBody(), Hr = 1.2;
  // rear-end: leader L walks slowly, follower F fast from behind (KIN-2D project: F is slowed by the constraint)
  const L = new PlanBuilder('L', body, { x: 6, y: 0, th: 0 }).straight(3, 2).build();
  const F = new PlanBuilder('F', body, { x: 0, y: 0, th: 0 }).straight(20, 10).build();
  const run = runKinematicsWithContactMode({ tracks: [L, F], statics: [], horizon_s: Hr }, 'project');
  const mech = classifyKinProject(run, Hr);
  const exec = (id: string, tr: Track): Track => ({ id, body: tr.body, layer: tr.layer, segs: run.executed[id].segs });
  const ant = detectAntennaContacts({ agents: [{ id: 'L', track: exec('L', L), model: m }, { id: 'F', track: exec('F', F), model: m }], statics: [], t0_s: 0, horizon_s: Hr, targets: { statics: false, bodies: true, antennae: true } });
  const geo = classifyAntenna(ant, Hr);
  const bb = bodyOf(mech), fc = mech.constraint_active.filter((k) => k.bodies.includes('F'));
  ok(bb.length === 1 && fc.length >= 1 && fc[0].partners.includes('L'), `rear-end: body contact F|L and F constrained by L (${json(fc.map((k) => k.cause))})`);
  ok(mech.constraint_active.every((k) => !k.bodies.includes('L')), 'rear-end: the leader is not constrained (no push)');
  const all = [...mech.contact_episodes, ...geo.contact_episodes];
  const tr = biologicalTriggers(all, 'antennation', ['L', 'F']);
  ok(tr.length >= 1 && tr.every((x) => x.receiver === 'F' && x.partner === 'L' && x.from === 'contact_episode' && x.tags[0].assumption === true), `rear-end: only the follower's antenna touching the leader triggers (${json(tr.map((x) => `${x.receiver}:${x.side}@${x.t_s.toFixed(4)}`))})`);
  ok(tr[0].t_s < bb[0].start_t_s, `rear-end: the antenna touches before the bodies do (${tr[0].t_s} < ${bb[0].start_t_s})`);
  // COUNTEREXAMPLE: the leader is in body contact and in the pair's mechanics, but its antennae point away → no signal for L
  ok(!tr.some((x) => x.receiver === 'L') && geo.contact_episodes.every((e) => e.antenna!.owner !== 'L'), 'counterexample: body contact + constraint on the pair, no antennal contact of L → no signal for L');
  ok(json(biologicalTriggers(mech.contact_episodes, 'antennation', ['L', 'F'])) === '[]', 'counterexample: body-only episodes (with constraint_active present) → no trigger');
  ok(json(biologicalTriggers(all, 'chc_contact', ['L', 'F']).map((x) => [x.receiver, x.partner, x.t_s])) === json(tr.map((x) => [x.receiver, x.partner, x.t_s])), 'chc_contact uses the same antennal condition');
  for (const p of permutationsOf(all)) ok(json(biologicalTriggers(p, 'antennation', ['L', 'F'])) === json(tr), 'triggers independent of record order');
  ok(json(biologicalTriggers(all, 'antennation', ['F'])) === '[]', 'a partner that is not a listed agent cannot be a signal partner');

  // antennal contact WITHOUT body contact and without any constraint: an ant passing a stationary one sideways
  const P = new PlanBuilder('P', body, { x: 0, y: 0, th: 0 }).straight(12, 8).build(), S = new PlanBuilder('S', body, { x: 7, y: 1.6, th: Math.PI / 2 }).stop(2).build();
  const kp = runKinematics({ tracks: [P, S], statics: [], horizon_s: Hr }), mp = classifyKin(kp, Hr);
  const ap = classifyAntenna(detectAntennaContacts({ agents: [{ id: 'P', track: { ...P, segs: kp.executed.P.segs }, model: m }, { id: 'S', track: { ...S, segs: kp.executed.S.segs }, model: m }], statics: [], t0_s: 0, horizon_s: Hr, targets: { statics: false, bodies: true, antennae: true } }), Hr);
  const tp = biologicalTriggers([...mp.contact_episodes, ...ap.contact_episodes], 'antennation', ['P', 'S']);
  ok(mp.contact_episodes.length === 0 && mp.constraint_active.length === 0 && tp.length >= 1, `pass-by: no body contact, no constraint, yet ${tp.length} antennal trigger(s) (the kinds are independent)`);
  // antenna touching a static object is not a signal with another agent
  const wallRun = runKinematics({ tracks: [new PlanBuilder('w', body, { x: 0, y: 0, th: 0 }).straight(5, 5).build()], statics: [{ id: 'wall', kind: 'segment', a: { x: 4, y: -5 }, b: { x: 4, y: 5 } }], horizon_s: Hr });
  const aw = classifyAntenna(detectAntennaContacts({ agents: [{ id: 'w', track: { id: 'w', body, segs: wallRun.executed.w.segs }, model: m }], statics: [{ id: 'wall', kind: 'segment', a: { x: 4, y: -5 }, b: { x: 4, y: 5 } }], t0_s: 0, horizon_s: Hr, targets: { statics: true, bodies: true, antennae: true } }), Hr);
  const kw = classifyKin(wallRun, Hr, ['wall']);
  ok(aw.contact_episodes.some((e) => e.geometry === 'antenna_static') && kw.contact_episodes.every((e) => e.geometry === 'body_static') && biologicalTriggers([...aw.contact_episodes, ...kw.contact_episodes], 'antennation', ['w']).length === 0, 'antenna and body touching a wall: geometric episodes, no social signal');
}
ok(Object.values(BIO_CONTACT_RULES).every((r) => r.assumption === true && r.basis === '遊戲假設' && !r.geometries.includes('body_body')), 'the biological contact rules are labelled assumptions and never accept body_body');
console.log(JSON.stringify({ k189_contact_classification: 'pass', checks }, null, 2));

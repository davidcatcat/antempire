/**
 * #189 / #193 ruling 4 — arrivals leave the lane and register in the #162 destination capacity ledger
 * (engine/physics/lane-flow.ts on KIN-2D bodies; engine/physics/destinations.ts). Blocking.
 *  - leave_to_ledger: every arrival leaves the lane at its exact arrival instant (no sample, no obstacle afterwards)
 *    and is ONE 'arrive' request; the ledger stream passes validateSiteEvents; conservation (in lane + queued + at the
 *    destination + released + turned away = all agents, allowed edges only) after every transition; ledger summary =
 *    arrivals (no leak);
 *  - counterexample stay_as_obstacle (PH-3b / WP4 baseline): the first arrival blocks every follower with the same goal;
 *  - a follower behind a leader that leaves resumes and arrives (slow: follow rule; stop: KIN-2D freeze baseline holds);
 *  - contacts ended by a removal are end_is_physical false; independent gap audit: 0 penetration, 0 missed contacts;
 *  - determinism and agent-order independence; both contact responses.
 * Physics and bookkeeping only; every capacity / dwell is a candidate boundary value (assumption: true).
 */
import assert from 'node:assert/strict';
import { laneFlow, poseAtFlow, LaneFlowRefused, type LaneFlowInput, type FlowAgentSpec, type LaneFlowResult } from '../engine/physics/lane-flow.ts';
import { validateSiteEvents, permutationsOf, DestinationRefused, type SiteSpec } from '../engine/physics/destinations.ts';
import { checkConservation, auditContacts, type GapSample, type Threshold } from '../engine/physics/candidate-metrics.ts';
import { capsuleAt, capGap, dimsOf, CONTACT_TOL_MM } from '../engine/physics/kinematics2d.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const json = (x: unknown) => JSON.stringify(x);
const T = (value: number): Threshold => ({ value, assumption: true, basis: '遊戲假設', note: 'observer threshold (test)' });
const BODY = { length_mm: 2.5, width_mm: 0.8 };
const prov = { assumption: true as const, basis: '遊戲假設' as const, candidate_boundary: true as const, source_ids: [], note: 'test candidate boundary value' };
const site = (over: Partial<SiteSpec> = {}): SiteSpec => ({ id: 'nest', kind: 'nest_mouth', capacity: 2, dwell_s: 0.5, queue_max: 1, on_release: 'off_plane', provenance: prov, ...over });
const ag = (id: string, s: number, v = 10, over: Partial<FlowAgentSpec> = {}): FlowAgentSpec => ({ id, dir: 1, s_mm: s, u_mm: 0, goal_s_mm: 50, start_t_s: 0, free_speed_mm_s: v, body: BODY, site: 'nest', ...over });
const base = (over: Partial<LaneFlowInput> = {}): LaneFlowInput => ({ lane: { length_mm: 60, width_mm: 2 }, agents: [0, 1, 2, 3, 4, 5].map((k) => ag(`a${k}`, 30 - 3.5 * k)), horizon_s: 8, contact_response: 'slow', arrival: 'leave_to_ledger', sites: [site()], ...over });

/** independent gap audit from the executed pieces (closed form), at a time grid plus every recorded event time */
function audit(r: LaneFlowResult, H: number) {
  const ids = Object.keys(r.agents).sort(), gaps: GapSample[] = [];
  const ts = new Set<number>(Array.from({ length: 401 }, (_, i) => (H * i) / 400));
  for (const e of r.classification.contact_episodes) { ts.add(e.start_t_s); if (e.end_t_s !== null) ts.add(e.end_t_s); }
  for (const t of [...ts].sort((a, b) => a - b)) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = r.agents[ids[i]], b = r.agents[ids[j]], pa = poseAtFlow(a, t), pb = poseAtFlow(b, t);
    if (!pa || !pb || (a.removed_t_s !== null && t >= a.removed_t_s) || (b.removed_t_s !== null && t >= b.removed_t_s)) continue;
    gaps.push({ t, a: ids[i], b: ids[j], gap_mm: capGap(capsuleAt(pa, dimsOf(BODY, 'x')), capsuleAt(pb, dimsOf(BODY, 'x'))).g });
  }
  return auditContacts(gaps, r.classification.contact_episodes.filter((e) => e.geometry === 'body_body').map((e) => ({ agents: e.ids, start_t_s: e.start_t_s, end_t_s: e.end_t_s })), { contact_tol_mm: T(CONTACT_TOL_MM), penetration_tol_mm: T(1e-9), time_slack_s: T(1e-9), episode_gap_slack_mm: T(1e-3) });
}
function ledgerChecks(r: LaneFlowResult, inp: LaneFlowInput, tag: string) {
  ok(validateSiteEvents(inp.sites, r.ledger.events).length === 0, `${tag}: the ledger stream is valid (${json(validateSiteEvents(inp.sites, r.ledger.events).slice(0, 2))})`);
  const arrivedIds = Object.entries(r.agents).filter(([, a]) => a.arrival_t_s !== null).map(([id]) => id).sort();
  const arriveEv = r.ledger.events.filter((e) => e.kind === 'arrive');
  ok(json(arriveEv.map((e) => e.agent).sort()) === json(arrivedIds) && arriveEv.every((e) => e.t === r.agents[e.agent].arrival_t_s), `${tag}: one ledger arrival per lane arrival, at the arrival instant`);
  const sum = Object.values(r.ledger.summary), tot = (k: 'arrived' | 'entered' | 'turned_away' | 'abandoned') => sum.reduce((x, y) => x + y[k], 0);
  const stillQueued = Object.values(r.agents).filter((a) => a.final_state === 'queued').length;
  ok(tot('arrived') === arrivedIds.length && tot('arrived') === tot('entered') + tot('turned_away') + tot('abandoned') + stillQueued, `${tag}: ledger summary: arrived = entered + turned away + still queued (no leak)`);
  const c = checkConservation(Object.keys(r.agents), r.transitions, r.initial_states);
  ok(c.ok, `${tag}: conservation after every transition (${c.violations.slice(0, 2).join('; ')})`);
  const fc = c.final_census;
  ok(fc.in_lane + fc.queued + fc.at_destination + fc.released + fc.turned_away + fc.scheduled + fc.waiting_entry === Object.keys(r.agents).length && fc.in_lane === Object.values(r.agents).filter((a) => a.arrival_t_s === null).length, `${tag}: final census = agents; in lane = not arrived (${json(fc)})`);
  for (const [id, a] of Object.entries(r.agents)) {
    if (a.arrival_t_s === null) continue;
    ok(a.removed_t_s === a.arrival_t_s && a.final_pose === null && a.samples.every((x) => x[0] <= a.arrival_t_s!) && a.pieces.every((p) => p.t1 <= a.arrival_t_s!), `${tag}: ${id} leaves the lane at its arrival ${a.arrival_t_s} (no later sample or motion)`);
    ok(Math.abs(poseAtFlow(a, a.arrival_t_s)!.x - 50) <= 1e-9, `${tag}: ${id} reached the goal x = 50 (${poseAtFlow(a, a.arrival_t_s)!.x})`);
  }
}

// ---------------------------------------------------------------- one-way queue: everybody arrives, ledger decides
for (const mode of ['slow', 'stop'] as const) {
  const inp = base({ contact_response: mode, sites: [site({ capacity: 1, dwell_s: 1 })] }), r = laneFlow(inp);
  const tag = `free flow (${mode})`;
  ok(r.stats.arrived === 6, `${tag}: all 6 arrive and leave the lane (${r.stats.arrived})`);
  ledgerChecks(r, inp, tag);
  // arrivals 2.0, 2.35, 2.7, …: capacity 1, dwell 1, queue 1 → a0 admitted, a1 queued (admitted at 3), a2 turned away, …
  const k = Object.fromEntries(r.ledger.events.filter((e) => e.kind !== 'arrive').map((e) => [`${e.agent}:${e.kind}`, e.t]));
  ok(k['a0:admit'] === r.agents.a0.arrival_t_s && 'a1:queue' in k && k['a1:admit'] === k['a0:release'] && k['a0:release'] === 3 && 'a2:turn_away' in k, `${tag}: capacity 1 / dwell 1 / queue 1 decide admit / queue / turn away (${json(k)})`);
  ok(r.ledger.events.some((e) => e.kind === 'turn_away'), `${tag}: a full queue turns arrivals away (accounted, not leaked)`);
  ok(r.classification.contact_episodes.length === 0 && audit(r, inp.horizon_s).penetration.count === 0, `${tag}: equal speeds: no contact, no penetration`);
}

// ---------------------------------------------------------------- follower behind a slow leader that leaves
{
  const agents = [ag('L', 30, 5), ag('F', 20, 10)];
  const slow = laneFlow(base({ agents, contact_response: 'slow', sites: [site({ queue_max: 5 })] }));
  const tL = slow.agents.L.arrival_t_s!, tF = slow.agents.F.arrival_t_s!;
  ok(Math.abs(tL - 4) < 1e-9, `slow: leader arrives at (50 − 30)/5 = 4 s (${tL})`);
  // contact at (30 − 20 − 2.5)/(10 − 5) = 1.5 s; then follows at 5 mm/s; leader leaves at 4 → F at 50 − 2.5 − θ.. walks 2.5 mm at 10
  ok(Math.abs(tF - (tL + 2.5 / 10)) < 1e-6, `slow: follower slowed to the leader's speed, then free once the leader left (${tF} vs ${tL + 0.25})`);
  const ep = slow.classification.contact_episodes.filter((e) => e.geometry === 'body_body');
  ok(ep.length === 1 && Math.abs(ep[0].start_t_s - 1.5) < 1e-6 && ep[0].end_t_s === tL && ep[0].end_is_physical === false, `slow: the contact ends because the leader LEFT the lane (not physical) (${json(ep)})`);
  ok(slow.classification.constraint_active.some((c) => c.bodies.join() === 'F' && c.partners.includes('L')), 'slow: the follower is the constrained body (constraint_active)');
  const au = audit(slow, 8);
  ok(au.penetration.count === 0 && au.missed_contacts.count === 0, `slow: independent audit 0 penetration, 0 missed (${json(au)})`);
  ledgerChecks(slow, base({ agents, sites: [site({ queue_max: 5 })] }), 'slow follower');
  const stop = laneFlow(base({ agents, contact_response: 'stop', sites: [site({ queue_max: 5 })] }));
  ok(stop.agents.L.arrival_t_s === 4 || Math.abs(stop.agents.L.arrival_t_s! - 4) < 1e-9, 'stop: the leader is not frozen (it moves away) and arrives');
  ok(stop.agents.F.arrival_t_s === null && stop.agents.F.final_state === 'in_lane', 'stop: KIN-2D freeze baseline — the follower holds until the horizon (no decision clock in this run)');
  ok(audit(stop, 8).penetration.count === 0, 'stop: no penetration');
}

// ---------------------------------------------------------------- counterexample: the arrived body stays as an obstacle
for (const mode of ['slow', 'stop'] as const) {
  const r = laneFlow(base({ contact_response: mode, arrival: 'stay_as_obstacle', agents: [ag('a0', 30, 10), ag('a1', 20, 10)] }));
  ok(r.agents.a0.arrival_t_s !== null && r.agents.a1.arrival_t_s === null && r.agents.a0.removed_t_s === null, `stay_as_obstacle (${mode}): the arrived a0 stays on the lane; a1 never reaches the goal`);
  ok(r.ledger.events.length === 0 && r.classification.contact_episodes.some((e) => e.ids.join() === 'a0,a1' && e.end_t_s === null), `stay_as_obstacle (${mode}): no ledger registration; a1 stays in contact with the permanent obstacle`);
  const l = laneFlow(base({ contact_response: mode, agents: [ag('a0', 30, 10), ag('a1', 20, 10)], sites: [site({ queue_max: 5 })] }));
  ok(l.agents.a1.arrival_t_s !== null && Math.abs(l.agents.a1.arrival_t_s - 3) < 1e-9 && l.classification.contact_episodes.length === 0, `leave_to_ledger (${mode}): the same follower reaches the goal at 3 s — the arrived body is gone (${l.agents.a1.arrival_t_s})`);
}

// ---------------------------------------------------------------- two directions: head-on deadlock is still conserved
{
  const inp = base({ agents: [ag('e', 10, 10), ag('w', 10, 10, { dir: -1 }), ag('e2', 0, 10, { u_mm: 0.5 })] });
  const r = laneFlow(inp);
  ok(r.agents.e.arrival_t_s === null && r.agents.w.arrival_t_s === null, 'head-on on one line: both stop (mutual) — no arrival, no invented give-way');
  ledgerChecks(r, inp, 'head-on');
  ok(audit(r, inp.horizon_s).penetration.count === 0, 'head-on: no penetration');
}

// ---------------------------------------------------------------- determinism, refusals
{
  const inp = base({ agents: [ag('L', 30, 5), ag('F', 20, 10), ag('G', 12, 9, { u_mm: 0.3 })] });
  const ref = json(laneFlow(inp));
  ok(json(laneFlow(inp)) === ref, 'rerun: bitwise identical');
  for (const p of permutationsOf(inp.agents)) ok(json(laneFlow({ ...inp, agents: p })) === ref, 'agent input order does not matter');
  const bad = (f: () => unknown, why: string) => { try { f(); ok(false, why); } catch (e) { ok(e instanceof LaneFlowRefused || e instanceof DestinationRefused, `${why} (${(e as Error).message.slice(0, 100)})`); } };
  bad(() => laneFlow(base({ agents: [ag('x', 10), ag('y', 11)] })), 'overlapping start poses refused');
  bad(() => laneFlow(base({ sites: [site({ capacity: null })] })), 'unknown capacity refused (never defaulted)');
  bad(() => laneFlow(base({ agents: [ag('x', 10, 10, { site: 'nowhere' })] })), 'unknown destination refused');
  bad(() => laneFlow(base({ agents: [ag('x', 10, 10, { body: { length_mm: null, width_mm: 0.8 } })] })), 'unknown body size refused');
}
console.log(JSON.stringify({ k189_arrivals_ledger: 'pass', checks }, null, 2));

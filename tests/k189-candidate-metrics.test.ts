/**
 * #189 / #193 ruling 6 — reusable candidate metrics (engine/physics/candidate-metrics.ts). Blocking.
 * Known-answer cases for every metric (no-penetration / missed contact, throughput, waiting time, head-on collisions,
 * position conservation, chunk determinism, turning statistics), refusal of unlabelled thresholds, input-order
 * independence, and one real producer: a KIN-2D head-on run whose episodes and independently sampled gaps give
 * 0 penetration and 0 missed contacts, while deleting the reported episode makes the audit report the contact as missed.
 * Physics only: no biological conclusion is drawn.
 */
import assert from 'node:assert/strict';
import { auditContacts, throughput, admissionsOf, waitingTimes, classifyEncounters, headingAt, checkConservation, checkNoTeleport, compareOutputs, turningStatistics, resampleByArc, evaluateCandidate, MetricsRefused, ALLOWED_EDGES, AGENT_STATES, type Threshold, type PoseSample, type EpisodeRec, type GapSample, type MetricOptions } from '../engine/physics/candidate-metrics.ts';
import { PlanBuilder, runKinematics, advancePose, capsuleAt, capGap, dimsOf, CONTACT_TOL_MM } from '../engine/physics/kinematics2d.ts';
import { runSiteLedger, type SiteSpec } from '../engine/physics/destinations.ts';
import { permutationsOf } from '../engine/physics/destinations.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const T = (value: number, note = 'observer threshold for the test'): Threshold => ({ value, assumption: true, basis: '遊戲假設', note });
const refuses = (f: () => unknown, why: string) => { try { f(); } catch (e) { ok(e instanceof MetricsRefused, `${why} (${(e as Error).message.slice(0, 120)})`); return; } ok(false, `${why}: no refusal`); };
const json = (x: unknown) => JSON.stringify(x);
const audOpt = { contact_tol_mm: T(1e-7), penetration_tol_mm: T(1e-9), time_slack_s: T(1e-9), episode_gap_slack_mm: T(1e-6) };

// ---------------------------------------------------------------- 1. penetration / missed contact (known answers)
{
  const eps: EpisodeRec[] = [{ agents: ['A', 'B'], start_t_s: 1, end_t_s: 2 }, { agents: ['C', 'D'], start_t_s: 5, end_t_s: 6 }, { agents: ['E', 'F'], start_t_s: 7, end_t_s: null }];
  const gaps: GapSample[] = [
    { t: 1.5, a: 'B', b: 'A', gap_mm: 0 },        // inside A|B (reversed pair order)
    { t: 1.2, a: 'A', b: 'B', gap_mm: 0.5 },      // inside the episode but far apart: phantom sample
    { t: 3, a: 'A', b: 'B', gap_mm: 5e-8 },       // contact outside any episode: missed
    { t: 4, a: 'A', b: 'B', gap_mm: -0.01 },      // penetration (and missed)
    { t: 9, a: 'E', b: 'F', gap_mm: 0 },          // inside the open episode
    { t: 3, a: 'G', b: 'H', gap_mm: 2 },          // far apart, no episode: fine
  ];
  const r = auditContacts(gaps, eps, audOpt);
  ok(r.penetration.count === 1 && r.penetration.max_depth_mm === 0.01, `one penetration of 0.01 mm (${json(r.penetration)})`);
  ok(r.missed_contacts.count === 2 && r.missed_contacts.pairs.join() === 'A|B' && r.missed_contacts.first?.t === 3, `two missed contacts on A|B, first at 3 (${json(r.missed_contacts)})`);
  ok(r.unsampled_episodes === 1 && r.phantom_samples === 1, `C|D unsampled, one phantom sample (${r.unsampled_episodes}, ${r.phantom_samples})`);
  for (const p of permutationsOf(gaps)) ok(json(auditContacts(p, [...eps].reverse(), audOpt)) === json(r), 'audit independent of input order');
  refuses(() => auditContacts(gaps, eps, { ...audOpt, contact_tol_mm: { value: 1e-7 } as unknown as Threshold }), 'an unlabelled threshold is refused');
  refuses(() => auditContacts(gaps, eps, { ...audOpt, time_slack_s: { ...T(0), assumption: false } as unknown as Threshold }), 'assumption: false threshold is refused');
}

// ---------------------------------------------------------------- 1b. a real producer: KIN-2D head-on (freeze)
{
  const body = { length_mm: 2.5, width_mm: 0.8 };
  const a = new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(20, 10).build();
  const b = new PlanBuilder('b', body, { x: 10, y: 0, th: Math.PI }).straight(20, 10).build();
  const res = runKinematics({ tracks: [a, b], statics: [], horizon_s: 1 });
  const eps: EpisodeRec[] = [];
  for (const e of res.events) if (e.kind === 'contact_start') eps.push({ agents: [e.ids[0], e.ids[1]], start_t_s: e.t_s, end_t_s: null });
  for (const e of res.events) if (e.kind === 'contact_end') { const x = eps.find((q) => q.agents.join() === e.ids.join() && q.end_t_s === null); if (x) x.end_t_s = e.t_s; }
  ok(eps.length === 1, `KIN-2D head-on: one reported contact episode (${eps.length})`);
  // independent observer: closed-form poses from the executed record, capsule gap at many instants (incl. the contact)
  const poseOf = (id: string, t: number) => { const s = res.executed[id].segs.filter((q) => q.t0 <= t).at(-1)!; return advancePose(s.p0, s.tw, Math.min(t, s.t1) - s.t0); };
  const d = dimsOf(body, 'x'), gaps: GapSample[] = [], samples: PoseSample[] = [];
  const ts = [...Array.from({ length: 101 }, (_, i) => i / 100), eps[0].start_t_s].sort((x, y) => x - y);
  for (const t of ts) {
    const pa = poseOf('a', t), pb = poseOf('b', t);
    gaps.push({ t, a: 'a', b: 'b', gap_mm: capGap(capsuleAt(pa, d), capsuleAt(pb, d)).g });
    samples.push({ agent: 'a', t, x_mm: pa.x, y_mm: pa.y, th: pa.th }, { agent: 'b', t, x_mm: pb.x, y_mm: pb.y, th: pb.th });
  }
  const r = auditContacts(gaps, eps, { ...audOpt, contact_tol_mm: T(CONTACT_TOL_MM) });
  ok(r.penetration.count === 0 && r.missed_contacts.count === 0 && r.phantom_samples === 0, `KIN-2D head-on: 0 penetration, 0 missed, 0 phantom (${json(r)})`);
  const miss = auditContacts(gaps, [], { ...audOpt, contact_tol_mm: T(CONTACT_TOL_MM) });
  ok(miss.missed_contacts.count > 0, `deleting the reported episode → the independent audit reports the contact as missed (${miss.missed_contacts.count})`);
  const enc = classifyEncounters(eps, samples, { head_on_min_deg: T(135), same_direction_max_deg: T(45) });
  ok(enc.head_on === 1 && enc.same_direction === 0 && enc.crossing === 0, `KIN-2D head-on is classified head_on (${json(enc.episodes)})`);
}

// ---------------------------------------------------------------- 2. throughput
{
  const ev = [{ agent: 'a', t: 1 }, { agent: 'b', t: 2 }, { agent: 'c', t: 3 }, { agent: 'd', t: 5 }];
  const r = throughput(ev, [0, 4]);
  ok(r.count === 3 && r.per_s === 0.75, `throughput 3 in [0, 4] = 0.75 /s (${json(r)})`);
  ok(throughput(ev, [2, 2]).per_s === null && throughput(ev, [2, 2]).count === 1, 'zero-length window: count, no rate');
  refuses(() => throughput(ev, [3, 1]), 'reversed window refused');
  const site: SiteSpec = { id: 'x', kind: 'road_exit', capacity: 1, dwell_s: 1, queue_max: 5, on_release: 'off_plane', provenance: { assumption: true, basis: '遊戲假設', candidate_boundary: true, source_ids: [], note: 'test' } };
  const led = runSiteLedger([site], [{ t: 0, agent: 'a', site: 'x', kind: 'arrive' }, { t: 0.5, agent: 'b', site: 'x', kind: 'arrive' }, { t: 0.6, agent: 'c', site: 'x', kind: 'arrive' }]);
  const adm = admissionsOf(led.events);
  ok(json(adm) === json([{ agent: 'a', t: 0 }, { agent: 'b', t: 1 }, { agent: 'c', t: 2 }]), `ledger admissions a@0, b@1, c@2 (${json(adm)})`);
  const w = waitingTimes([], { stall_speed_mm_s: T(0.1) }, led.events, [{ agent: 'a', scheduled_t: 0, entered_t: 0.25 }, { agent: 'b', scheduled_t: 1, entered_t: null }]);
  ok(w.queue_wait_s.n === 3 && w.queue_wait_s.max === 1.4 && Math.abs(w.queue_wait_s.mean! - (0 + 0.5 + 1.4) / 3) < 1e-15, `queue waits 0, 0.5, 1.4 s (${json(w.queue_wait_s)})`);
  ok(w.entry_wait_s.n === 1 && w.entry_wait_s.max === 0.25, 'entry wait 0.25 s; a never-entered agent is not a wait sample');
}

// ---------------------------------------------------------------- 3. waiting (stall) time
{
  const s: PoseSample[] = [{ agent: 'a', t: 0, x_mm: 0, y_mm: 0 }, { agent: 'a', t: 1, x_mm: 10, y_mm: 0 }, { agent: 'a', t: 2, x_mm: 10, y_mm: 0 }, { agent: 'a', t: 3, x_mm: 20, y_mm: 0 }];
  const w = waitingTimes(s, { stall_speed_mm_s: T(0.5) });
  ok(w.stall_s.max === 1 && Math.abs(w.stall_fraction.max! - 1 / 3) < 1e-15, `stall 1 s of 3 s (${json(w.stall_s)})`);
  ok(json(waitingTimes([...s].reverse(), { stall_speed_mm_s: T(0.5) })) === json(w), 'stall independent of sample order');
}

// ---------------------------------------------------------------- 4. head-on / same direction / crossing
{
  const s = (agent: string, th: number): PoseSample[] => [{ agent, t: 0, x_mm: 0, y_mm: 0, th }, { agent, t: 1, x_mm: Math.cos(th), y_mm: Math.sin(th), th }];
  const samples = [...s('E', 0), ...s('W', Math.PI), ...s('E2', 0.1), ...s('N', Math.PI / 2)];
  const eps: EpisodeRec[] = [{ agents: ['E', 'W'], start_t_s: 0.5, end_t_s: 0.6 }, { agents: ['E', 'E2'], start_t_s: 0.5, end_t_s: 0.6 }, { agents: ['E', 'N'], start_t_s: 0.5, end_t_s: 0.6 }, { agents: ['E', 'ghost'], start_t_s: 0.5, end_t_s: 0.6 }];
  const r = classifyEncounters(eps, samples, { head_on_min_deg: T(135), same_direction_max_deg: T(45) });
  ok(r.head_on === 1 && r.same_direction === 1 && r.crossing === 1 && r.unknown_heading === 1, `head-on 1, same 1, crossing 1, unknown 1 (${json(r)})`);
  // heading from displacement when the producer has no θ
  const nd: PoseSample[] = [{ agent: 'q', t: 0, x_mm: 0, y_mm: 0 }, { agent: 'q', t: 1, x_mm: 0, y_mm: -2 }];
  ok(Math.abs(headingAt(nd, 'q', 0.5)! + Math.PI / 2) < 1e-15, 'heading from the displacement direction when θ is absent');
  refuses(() => classifyEncounters(eps, samples, { head_on_min_deg: T(30), same_direction_max_deg: T(45) }), 'inconsistent class thresholds refused');
}

// ---------------------------------------------------------------- 5. position conservation and no teleport
{
  const ag = ['a', 'b', 'c'];
  const good = [
    { t: 0, agent: 'a', to: 'in_lane' }, { t: 0.5, agent: 'b', to: 'waiting_entry' }, { t: 1, agent: 'b', to: 'in_lane' },
    { t: 2, agent: 'a', to: 'at_destination' }, { t: 2.5, agent: 'b', to: 'queued' }, { t: 3, agent: 'a', to: 'released' },
    { t: 3, agent: 'b', to: 'at_destination' }, { t: 3.5, agent: 'c', to: 'in_lane' }, { t: 4, agent: 'c', to: 'turned_away' },
  ] as const;
  const r = checkConservation(ag, [...good]);
  ok(r.ok && r.final_census.released === 1 && r.final_census.at_destination === 1 && r.final_census.turned_away === 1 && r.max_in_lane === 2, `valid log conserves agents (${json(r)})`);
  const leak = checkConservation(ag, [{ t: 0, agent: 'a', to: 'in_lane' }, { t: 1, agent: 'a', to: 'released' }]);
  ok(!leak.ok && /in_lane → released/.test(leak.violations[0]), `skipping the destination ledger is flagged (${leak.violations[0]})`);
  const ghost = checkConservation(ag, [{ t: 0, agent: 'z', to: 'in_lane' }]);
  ok(!ghost.ok && /unknown agent/.test(ghost.violations[0]), 'an agent outside the census is flagged');
  const twice = checkConservation(['a', 'a'], []);
  ok(!twice.ok, 'duplicate ids flagged');
  ok(AGENT_STATES.every((s) => ALLOWED_EDGES[s].every((x) => (AGENT_STATES as readonly string[]).includes(x))) && ALLOWED_EDGES.released.length === 0, 'edge table closed over the states; released is terminal');
  const s: PoseSample[] = [{ agent: 'a', t: 0, x_mm: 0, y_mm: 0 }, { agent: 'a', t: 1, x_mm: 10, y_mm: 0 }, { agent: 'a', t: 1.1, x_mm: 30, y_mm: 0 }];
  const tp = checkNoTeleport(s, { v_max_mm_s: 10, tol_mm: T(1e-9) });
  ok(!tp.ok && tp.violations === 1 && Math.abs(tp.worst_excess_mm - 19) < 1e-12, `a 20 mm jump in 0.1 s at 10 mm/s is a teleport (${json(tp)})`);
  ok(checkNoTeleport(s.slice(0, 2), { v_max_mm_s: 10, tol_mm: T(1e-9) }).ok, 'walking at v_max is not a teleport');
}

// ---------------------------------------------------------------- 6. chunk determinism comparator
{
  const x = { a: [1, 2, { b: 0.30000000000000004 }], c: 'k', d: null };
  ok(compareOutputs(x, JSON.parse(json(x))).bitwise_equal, 'identical outputs are bitwise equal');
  const y = { a: [1, 2, { b: 0.3 }], c: 'k', d: null }, r = compareOutputs(x, y);
  ok(!r.bitwise_equal && r.first_difference === '$.a[2].b' && r.max_abs_numeric_diff > 0 && r.max_abs_numeric_diff < 1e-16 && !r.structural_difference, `one-ulp difference located, not hidden (${json(r)})`);
  const z = compareOutputs({ a: [1, 2] }, { a: [1, 2, 3] });
  ok(!z.bitwise_equal && z.structural_difference, 'length difference is structural');
  ok(!compareOutputs(0, -0).bitwise_equal, '0 and −0 differ bitwise (Object.is)');
}

// ---------------------------------------------------------------- 7. turning statistics (proxy, own definition)
{
  const def = { resample_ds_mm: T(0.5), turn_threshold_rad: T(0.2) };
  const straight: PoseSample[] = Array.from({ length: 31 }, (_, i) => ({ agent: 's', t: i, x_mm: i * 5, y_mm: 0 }));
  const dense: PoseSample[] = Array.from({ length: 301 }, (_, i) => ({ agent: 's', t: i / 10, x_mm: i * 0.5, y_mm: 0 }));
  const r0 = turningStatistics(straight, def);
  ok(r0.total_rad.max === 0 && r0.turns_per_150mm.max === 0 && r0.same_measure_as_R133 === false, 'straight path: 0 rad, 0 turns; labelled not the R133 measure');
  ok(Math.abs(r0.path_mm.max! - 150) < 1e-9 && json(turningStatistics(dense, def).turns_per_150mm) === json(r0.turns_per_150mm), 'straight path: count independent of sampling density');
  // zigzag: 10 mm legs alternating ±45°: each corner turns 90° (> threshold); 15 legs → 14 corners
  const zz: PoseSample[] = []; let x = 0, y = 0;
  for (let k = 0; k <= 15; k++) { zz.push({ agent: 'z', t: k, x_mm: x, y_mm: y }); const a = (k % 2 ? -1 : 1) * Math.PI / 4; x += 10 * Math.cos(a); y += 10 * Math.sin(a); }
  const rz = turningStatistics(zz.slice(0, 16), def);
  const L = rz.path_mm.max!;
  ok(Math.abs(L - 150) <= 0.5 && Math.abs(rz.turns_per_150mm.max! - 14 * 150 / L) < 1e-9, `zigzag: 14 corners on ~150 mm (${rz.turns_per_150mm.max}, L ${L})`);
  ok(Math.abs(rz.total_rad.max! - 14 * Math.PI / 2) < 1e-6, `zigzag: total 14 × π/2 rad (${rz.total_rad.max})`);
  const pts = resampleByArc(straight, 0.5);
  ok(pts.length === 301 && pts.every((p, i) => Math.abs(p.x - i * 0.5) < 1e-9), 'resampling every 0.5 mm of arc');
  refuses(() => turningStatistics(straight, { ...def, resample_ds_mm: T(0) }), 'zero resample spacing refused');
}

// ---------------------------------------------------------------- bundle
{
  const o: MetricOptions = { ...audOpt, stall_speed_mm_s: T(0.1), head_on_min_deg: T(135), same_direction_max_deg: T(45), teleport_tol_mm: T(1e-9), turning: { resample_ds_mm: T(0.5), turn_threshold_rad: T(0.2) } };
  const samples: PoseSample[] = [{ agent: 'a', t: 0, x_mm: 0, y_mm: 0 }, { agent: 'a', t: 1, x_mm: 10, y_mm: 0 }];
  const rec = { candidate: 'test', seed: 1, family: 'timed_inflow_comparison' as const, agents: ['a'], samples, episodes: [], gaps: [], arrivals: [{ agent: 'a', t: 1 }], transitions: [{ t: 0, agent: 'a', to: 'in_lane' as const }, { t: 1, agent: 'a', to: 'at_destination' as const }], v_max_mm_s: 10, window_s: [0, 1] as [number, number] };
  const r = evaluateCandidate(rec, o);
  ok(r.behavioural_conclusions_allowed && r.conservation?.ok && r.throughput.per_s === 1 && r.no_teleport.ok, `bundle: timed inflow allows comparison, conserved, 1 /s (${json(r.throughput)})`);
  ok(!evaluateCandidate({ ...rec, family: 'simultaneous_entry_stress' }, o).behavioural_conclusions_allowed, 'stress family: no behavioural conclusion (#158)');
}
console.log(JSON.stringify({ k189_candidate_metrics: 'pass', checks }, null, 2));

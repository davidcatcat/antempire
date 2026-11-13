/**
 * #189 / #193 ruling 5 — normal benchmark = time-based inflow with a plausible initial spatial distribution; the
 * 1,000-at-one-point start is kept as an explicit extreme / counterexample (engine/physics/lane-flow-benchmarks.ts,
 * engine/physics/lane-flow.ts entry control). Blocking.
 *  - generator: seeded and deterministic, initial bodies non-overlapping inside the walls, inflow instants exact decimals
 *    (t0 + k·interval), every number carries provenance (inflow interval = game assumption; speed = R133 本種 input);
 *  - entry control: an agent enters at exactly its scheduled instant when its entry pose is free, else waits OFF the
 *    lane and retries at scheduled + k·retry (exact); waiting agents are no obstacle;
 *  - normal benchmark runs (both contact responses, several seeds): conservation, valid ledger, 0 penetration,
 *    0 missed contacts, behavioural comparison allowed (#158 family);
 *  - extreme: 1,000 agents at one point and one instant — with entry control they enter one at a time (never two at one
 *    pose), conservation of all 1,000, family stress → no behavioural conclusion; WITHOUT entry control the start
 *    poses overlap and the run is refused (counterexample).
 */
import assert from 'node:assert/strict';
import { laneFlow, LaneFlowRefused, type LaneFlowResult } from '../engine/physics/lane-flow.ts';
import { timedInflowScenario, BenchmarkRefused, INFLOW_PROVENANCE_KEYS } from '../engine/physics/lane-flow-benchmarks.ts';
import { validateSiteEvents, decStr, dec } from '../engine/physics/destinations.ts';
import { evaluateCandidate, checkConservation, type MetricOptions, type Threshold } from '../engine/physics/candidate-metrics.ts';
import { capsuleAt, capGap, dimsOf, CONTACT_TOL_MM } from '../engine/physics/kinematics2d.ts';
import { loadBenchmarkFile, inflowSpec, normalBenchmark, stressBenchmark, benchmarkInput, benchmarkSite, recordsOf } from '../prototypes/lane-flow/lib.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const json = (x: unknown) => JSON.stringify(x);
const T = (value: number): Threshold => ({ value, assumption: true, basis: '遊戲假設', note: 'observer threshold (test)' });
const MO: MetricOptions = { contact_tol_mm: T(CONTACT_TOL_MM), penetration_tol_mm: T(1e-9), time_slack_s: T(1e-9), episode_gap_slack_mm: T(1e-3), stall_speed_mm_s: T(0.5), head_on_min_deg: T(135), same_direction_max_deg: T(45), teleport_tol_mm: T(1e-9), turning: { resample_ds_mm: T(0.5), turn_threshold_rad: T(0.05) } };
const C = loadBenchmarkFile();

// ---------------------------------------------------------------- generator
{
  ok(C.synthetic === true && INFLOW_PROVENANCE_KEYS.every((k) => C.provenance[k].assumption === true), 'benchmark file: synthetic, every value labelled assumption: true');
  ok(C.provenance.inflow_interval_s.basis === '遊戲假設' && C.provenance.speed_mm_s.source_ids.includes('R133') && /本種/.test(C.provenance.speed_mm_s.note), 'inflow interval is a game assumption; speed is the R133 本種 input');
  const a = normalBenchmark(1), b = normalBenchmark(1), c = normalBenchmark(2);
  ok(json(a) === json(b) && json(a) !== json(c), 'seeded: same seed identical, another seed differs');
  ok(a.family === 'timed_inflow_comparison', 'normal benchmark family: timed_inflow_comparison');
  const init = a.agents.filter((x) => x.start_t_s === 0 && x.id.startsWith('i')), flow = a.agents.filter((x) => x.id.startsWith('f'));
  ok(init.length === C.initial.count_per_direction && flow.length === C.inflow.count_per_direction, `${init.length} initial + ${flow.length} inflow agents`);
  const d = dimsOf(C.body, 'x'), pose = (x: typeof init[number]) => ({ x: x.s_mm, y: x.u_mm, th: 0 });
  let minGap = Infinity;
  for (let i = 0; i < init.length; i++) for (let j = i + 1; j < init.length; j++) minGap = Math.min(minGap, capGap(capsuleAt(pose(init[i]), d), capsuleAt(pose(init[j]), d)).g);
  ok(minGap > C.initial.min_gap_mm && init.every((x) => Math.abs(x.u_mm) <= C.lateral_half_band_mm && x.s_mm > C.body.length_mm && x.s_mm < C.goal_s_mm), `initial distribution: no overlap (min gap ${minGap.toFixed(3)} mm > ${C.initial.min_gap_mm}), inside the band, clear of the entry pose`);
  ok(flow.every((x, k) => decStr(dec(x.start_t_s)) === decStr(dec(k * 0.5)) && x.s_mm === C.body.length_mm / 2), 'inflow instants exact: k × 0.5 s at the entry pose');
  ok(new Set(flow.map((x) => x.u_mm)).size === flow.length, 'inflow lateral offsets drawn per agent (seeded)');
  const two = normalBenchmark(1, { directions: [1, -1] });
  ok(two.agents.filter((x) => x.dir === -1).length === C.initial.count_per_direction + C.inflow.count_per_direction, 'two-direction benchmark generated');
  const bad = (f: () => unknown, why: string) => { try { f(); ok(false, why); } catch (e) { ok(e instanceof BenchmarkRefused, `${why} (${(e as Error).message.slice(0, 90)})`); } };
  bad(() => timedInflowScenario({ ...inflowSpec(1), provenance: { ...C.provenance, inflow_interval_s: { ...C.provenance.inflow_interval_s, assumption: false } } }), 'an unlabelled inflow interval is refused');
  bad(() => timedInflowScenario({ ...inflowSpec(1), provenance: { ...C.provenance, speed_mm_s: { ...C.provenance.speed_mm_s, source_ids: [] } } }), '文獻支持 without a source is refused');
  bad(() => timedInflowScenario(inflowSpec(1, { initial: { count_per_direction: 200, min_gap_mm: 0.5, mean_extra_gap_mm: 3 } })), 'an initial distribution that does not fit is refused, not overlapped');
}

// ---------------------------------------------------------------- entry control semantics
{
  const site = benchmarkSite(), body = C.body;
  const A = (id: string, t: number) => ({ id, dir: 1 as const, s_mm: 1.25, u_mm: 0, goal_s_mm: 40, start_t_s: t, free_speed_mm_s: 10, body, site: 'nest' });
  const r = laneFlow({ lane: { length_mm: 50, width_mm: 3 }, agents: [A('x', 0), A('y', 0.05)], horizon_s: 6, contact_response: 'slow', arrival: 'leave_to_ledger', sites: [site], entry: { control: true, retry_interval_s: 0.1 } });
  // x enters at 0 and has moved 2.5 mm + θ (pose free) after 0.25 s; y tries 0.05, 0.15, 0.25 (blocked), enters at 0.35
  ok(r.agents.x.present_from_t_s === 0 && r.agents.y.present_from_t_s === 0.35, `blocked entry retried at 0.05 + k·0.1, entered at exactly 0.35 (${r.agents.y.present_from_t_s})`);
  ok(r.stats.entry_blocked_attempts === 3 && r.transitions.filter((x) => x.agent === 'y').map((x) => x.to).join() === 'waiting_entry,in_lane,at_destination,released', `y: waiting_entry → in_lane → ledger (${r.stats.entry_blocked_attempts} blocked attempts)`);
  ok(r.agents.y.samples[0][0] === 0.35 && r.agents.y.pieces.every((p) => p.t0 >= 0.35), 'y has no pose and no motion before it entered (not an obstacle while waiting)');
  const mid = laneFlow({ lane: { length_mm: 50, width_mm: 3 }, agents: [A('m', 0.25)], horizon_s: 1, contact_response: 'stop', arrival: 'leave_to_ledger', sites: [site], entry: { control: true, retry_interval_s: 0.1 } });
  ok(mid.agents.m.present_from_t_s === 0.25 && Math.abs(mid.agents.m.final_pose!.x - (1.25 + 7.5)) < 1e-9, 'free entry pose: enters at exactly 0.25 and walks from there');
  const late = laneFlow({ lane: { length_mm: 50, width_mm: 3 }, agents: [A('z', 3)], horizon_s: 1, contact_response: 'slow', arrival: 'leave_to_ledger', sites: [site], entry: { control: true, retry_interval_s: 0.1 } });
  ok(late.agents.z.present_from_t_s === null && late.agents.z.final_state === 'scheduled' && late.transitions.length === 0, 'scheduled after the horizon: never enters, stays scheduled (accounted)');
}

// ---------------------------------------------------------------- normal benchmark runs
const H = 12;
const runs: { mode: string; seed: number; r: LaneFlowResult }[] = [];
for (const mode of ['slow', 'stop'] as const) for (const seed of [1, 2, 3]) {
  const sc = normalBenchmark(seed), inp = benchmarkInput(sc, { horizon_s: H, contact_response: mode }), r = laneFlow(inp);
  runs.push({ mode, seed, r });
  const tag = `normal benchmark ${mode} seed ${seed}`;
  ok(validateSiteEvents(inp.sites, r.ledger.events).length === 0, `${tag}: ledger valid`);
  const rec = recordsOf(r, sc, { candidate: `lane-flow ${mode}`, seed, horizon_s: H, dt_obs: 0.05, v_max_mm_s: C.speed_mm_s });
  const m = evaluateCandidate(rec, MO);
  ok(m.conservation!.ok && m.no_teleport.ok, `${tag}: conservation + no teleport (${m.conservation!.violations.slice(0, 1)})`);
  ok(m.contacts.penetration.count === 0 && m.contacts.missed_contacts.count === 0, `${tag}: independent audit 0 penetration, 0 missed (${json(m.contacts.penetration)}, missed ${m.contacts.missed_contacts.count}, samples ${m.contacts.samples})`);
  ok(m.behavioural_conclusions_allowed === true, `${tag}: timed inflow → candidate comparison allowed`);
  ok(r.stats.arrived > 0 && m.throughput.count === r.stats.arrived, `${tag}: arrivals ${r.stats.arrived}, throughput ${m.throughput.per_s?.toFixed(3)} /s`);
  ok(Object.values(r.agents).every((a) => a.present_from_t_s === null || a.present_from_t_s >= a.scheduled_t_s), `${tag}: nobody enters before its scheduled instant`);
}
ok(json(laneFlow(benchmarkInput(normalBenchmark(1), { horizon_s: H, contact_response: 'slow' }))) === json(runs[0].r), 'normal benchmark rerun bitwise identical');

// ---------------------------------------------------------------- extreme: 1,000 agents at one point at one instant
{
  const sc = stressBenchmark(1000), H2 = 6, t0 = Date.now();
  ok(sc.family === 'simultaneous_entry_stress' && sc.agents.length === 1000 && new Set(sc.agents.map((a) => `${a.s_mm}|${a.u_mm}|${a.start_t_s}`)).size === 1, 'stress: 1,000 agents, one pose, one instant');
  const r = laneFlow(benchmarkInput(sc, { horizon_s: H2, contact_response: 'slow' }));
  const entered = Object.values(r.agents).filter((a) => a.present_from_t_s !== null).map((a) => a.present_from_t_s!).sort((x, y) => x - y);
  ok(entered.length > 1 && entered.every((t, i) => i === 0 || t > entered[i - 1]), `stress: agents enter one at a time (${entered.length} entered by ${H2} s; never two at one instant)`);
  const cons = checkConservation(Object.keys(r.agents), r.transitions, r.initial_states);
  const fc = cons.final_census;
  ok(cons.ok && Object.values(fc).reduce((x, y) => x + y, 0) === 1000 && fc.waiting_entry > 900, `stress: all 1,000 accounted (${json(fc)})`);
  const rec = recordsOf(r, sc, { candidate: 'lane-flow slow', seed: null, horizon_s: H2, dt_obs: 0.05, v_max_mm_s: C.speed_mm_s });
  const m = evaluateCandidate(rec, MO);
  ok(m.behavioural_conclusions_allowed === false && m.contacts.penetration.count === 0, `stress family: no behavioural conclusion; 0 penetration (wall ${Date.now() - t0} ms)`);
  try { laneFlow(benchmarkInput(sc, { horizon_s: H2, contact_response: 'slow', entry: false })); ok(false, 'stress without entry control should be refused'); }
  catch (e) { ok(e instanceof LaneFlowRefused && /overlapping/.test((e as Error).message), `counterexample: 1,000 bodies at one point without entry control → refused (${(e as Error).message.slice(0, 80)})`); }
}
console.log(JSON.stringify({ k189_inflow_benchmark: 'pass', checks, arrivals: runs.map((x) => `${x.mode}/${x.seed}: ${x.r.stats.arrived}`) }, null, 2));

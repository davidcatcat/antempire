/**
 * Issue #158 — destinations / capacity ledger / traffic metrics (isolated; BLOCKING).
 * Program tests + math invariants only. No biological claim: every capacity, dwell and queue limit below is a
 * synthetic candidate boundary value (assumption: true, 遊戲假設), not P. megacephala data.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import {
  dec, decAdd, decStr, decNum, timeCmp, runSiteLedger, validateSiteEvents, validateSites, isOrderIndependent, permutationsOf,
  OUTCOME_REQUIREMENTS, FAMILY_SCOPE, simultaneousEntry, timedInflow, DestinationRefused,
  type SiteSpec, type SiteRequest, type SiteEvent, type Provenance, type ViolationKind,
} from '../engine/physics/destinations.ts';
import { computeTrafficMetrics, timeStepSensitivity, diskGaps, dist, METRIC_EVIDENCE, type MetricOptions, type TrafficRun, type TrajSample } from '../engine/physics/traffic-metrics.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const eq = (a: unknown, b: unknown, why: string) => { assert.deepEqual(a, b, why); checks++; };
const throwsRefused = (f: () => unknown, re: RegExp, why: string) => { assert.throws(f, (e: unknown) => e instanceof DestinationRefused && re.test((e as Error).message), why); checks++; };

const P: Provenance = { assumption: true, basis: '遊戲假設', candidate_boundary: true, source_ids: [], note: 'synthetic test boundary value' };
const site = (id: string, o: Partial<SiteSpec> = {}): SiteSpec => ({ id, kind: 'road_exit', capacity: 2, dwell_s: 1, queue_max: 3, on_release: 'off_plane', provenance: P, ...o });
const kinds = (es: SiteEvent[]) => es.map((e) => `${e.t_exact}:${e.kind}:${e.agent}@${e.site}`);
const vk = (sites: SiteSpec[], es: SiteEvent[]): ViolationKind[] => [...new Set(validateSiteEvents(sites, es).map((v) => v.kind))];

// ---------------------------------------------------------------- 1. exact decimal time
eq(decStr(decAdd(dec(0.1), dec(0.2))), '0.3', '0.1 + 0.2 = 0.3 exactly on the decimals');
eq(decNum(decAdd(dec(0.1), dec(0.2))), 0.3, 'one rounding gives the double 0.3, not 0.30000000000000004');
eq(decStr(dec(1e-7)), '0.0000001', 'exponent form parsed'); eq(decStr(dec(2.5e21)), '2500000000000000000000', 'large exponent parsed');
eq(decStr(dec(-1.25)), '-1.25', 'negative'); ok(timeCmp(0.3, 0.1 + 0.2) !== 0, 'the double 0.1+0.2 is a different instant from 0.3 (producer must sum exactly)');
eq(timedInflow(['E'], 4, 0.1, 0).map((x) => x.t), [0, 0.1, 0.2, 0.3], 'timed inflow k·0.1 exact (0.3 not 0.30000000000000004)');
eq(timedInflow(['N', 'E'], 2, 0.5, 1).map((x) => `${x.agent}@${x.t}`), ['E#0@1', 'E#1@1.5', 'N#0@1', 'N#1@1.5'], 'inflow 2/s per arm, arms sorted');
eq(simultaneousEntry(['b', 'a'], 0.25).map((x) => `${x.agent}@${x.t}`), ['a@0.25', 'b@0.25'], 'simultaneous entry at one exact instant');

// ---------------------------------------------------------------- 2. taxonomy and refusals
eq(Object.keys(OUTCOME_REQUIREMENTS).sort(), ['arrived_at_food', 'arrived_at_nest_mouth', 'continue_moving', 'entered_nest', 'left_road', 'temporary_stay'], 'six destination outcomes of #158');
ok(OUTCOME_REQUIREMENTS.continue_moving.site_kind === null && !OUTCOME_REQUIREMENTS.continue_moving.needs_capacity, 'continue_moving: no ledger');
ok(OUTCOME_REQUIREMENTS.entered_nest.removes_from_plane && OUTCOME_REQUIREMENTS.left_road.removes_from_plane && !OUTCOME_REQUIREMENTS.arrived_at_food.removes_from_plane, 'which outcomes leave the 2D plane');
throwsRefused(() => validateSites([site('x', { capacity: null })]), /capacity is unknown/, 'unknown capacity is refused, never invented');
throwsRefused(() => validateSites([site('x', { queue_max: null })]), /queue_max is unknown/, 'unknown queue limit refused');
throwsRefused(() => validateSites([site('x', { capacity: 1.5 })]), /integer/, 'non-integer capacity refused');
throwsRefused(() => validateSites([site('x', { dwell_s: 0 })]), /dwell_s/, 'zero dwell refused');
throwsRefused(() => validateSites([site('x', { provenance: { ...P, assumption: false as unknown as true } })]), /provenance/, 'unlabelled value refused');
throwsRefused(() => validateSites([site('x', { on_release: { site: 'nope' } })]), /release target/, 'dangling transfer refused');
throwsRefused(() => validateSites([site('x'), site('x')]), /duplicate/, 'duplicate site refused');

// ---------------------------------------------------------------- 3. capacity / queue / dwell (WP4-like exit: capacity 2, dwell 1 s)
{
  const S = [site('exit')];
  const req: SiteRequest[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((agent) => ({ t: 0, agent, site: 'exit', kind: 'arrive' }));
  const r = runSiteLedger(S, req);
  eq(validateSiteEvents(S, r.events), [], 'reference ledger stream has no violations');
  eq(kinds(r.events.filter((e) => e.t === 0 && e.kind !== 'arrive')), ['0:admit:a@exit', '0:admit:b@exit', '0:queue:c@exit', '0:queue:d@exit', '0:queue:e@exit', '0:turn_away:f@exit'], 'cap 2 admitted, queue 3, 1 turned away (agent_id tie)');
  eq(kinds(r.events.filter((e) => e.t === 1)), ['1:release:a@exit', '1:release:b@exit', '1:admit:c@exit', '1:admit:d@exit'], 'release before admission at the same instant');
  eq(r.summary.exit, { arrived: 6, entered: 5, exited: 5, present: 0, queued: 3, turned_away: 1, abandoned: 0 }, 'summary');
  ok(Math.max(...r.events.map((e) => e.occupancy_after)) === 2, 'occupancy never exceeds capacity');
}
{ // 0.1 + 0.2 frees the slot at exactly 0.3
  const S = [site('x', { capacity: 1, dwell_s: 0.2, queue_max: 1 })];
  const r = runSiteLedger(S, [{ t: 0.1, agent: 'a', site: 'x', kind: 'arrive' }, { t: 0.3, agent: 'b', site: 'x', kind: 'arrive' }]);
  eq(kinds(r.events), ['0.1:arrive:a@x', '0.1:admit:a@x', '0.3:release:a@x', '0.3:arrive:b@x', '0.3:admit:b@x', '0.5:release:b@x'], 'exact dwell expiry 0.1+0.2 = 0.3 frees the slot before the 0.3 arrival');
  eq(r.events[2].t, 0.3, 'release time is the double 0.3');
}
{ // nest mouth → nest interior transfer (entered nest), queue_max 0
  const S = [site('mouth', { kind: 'nest_mouth', capacity: 1, dwell_s: 0.5, queue_max: 0, on_release: { site: 'nest' } }), site('nest', { kind: 'nest_interior', capacity: 1000, dwell_s: null, queue_max: 0, on_release: 'road' })];
  const r = runSiteLedger(S, [{ t: 0, agent: 'a', site: 'mouth', kind: 'arrive' }, { t: 0, agent: 'b', site: 'mouth', kind: 'arrive' }, { t: 0.5, agent: 'c', site: 'mouth', kind: 'arrive' }]);
  eq(validateSiteEvents(S, r.events), [], 'transfer stream valid');
  eq(kinds(r.events), ['0:arrive:a@mouth', '0:admit:a@mouth', '0:arrive:b@mouth', '0:turn_away:b@mouth', '0.5:release:a@mouth', '0.5:arrive:a@nest', '0.5:admit:a@nest', '0.5:arrive:c@mouth', '0.5:admit:c@mouth', '1:release:c@mouth', '1:arrive:c@nest', '1:admit:c@nest'], 'mouth releases into the nest at the same instant; queue_max 0 turns b away');
  eq([r.summary.nest.present, r.summary.mouth.present], [2, 0], 'a and c inside the nest (entered_nest), mouth empty');
}
{ // behaviour-driven dwell (food site): explicit depart; abandon from queue; refusals
  const S = [site('food', { kind: 'food_site', capacity: 1, dwell_s: null, queue_max: 2, on_release: 'road' })];
  const r = runSiteLedger(S, [
    { t: 0, agent: 'a', site: 'food', kind: 'arrive' }, { t: 1, agent: 'b', site: 'food', kind: 'arrive' },
    { t: 2, agent: 'b', site: 'food', kind: 'depart' }, { t: 3, agent: 'a', site: 'food', kind: 'depart' }]);
  eq(kinds(r.events), ['0:arrive:a@food', '0:admit:a@food', '1:arrive:b@food', '1:queue:b@food', '2:abandon:b@food', '3:release:a@food'], 'queue abandon and explicit depart');
  eq(validateSiteEvents(S, r.events), [], 'valid');
  throwsRefused(() => runSiteLedger(S, [{ t: 1, agent: 'a', site: 'food', kind: 'depart' }]), /release before admission/, 'depart before admission refused');
  throwsRefused(() => runSiteLedger([...S, site('rest', { kind: 'stay_spot' })], [{ t: 0, agent: 'a', site: 'food', kind: 'arrive' }, { t: 1, agent: 'a', site: 'rest', kind: 'arrive' }]), /double occupancy/, 'arriving elsewhere while present refused');
  throwsRefused(() => runSiteLedger([...S, site('rest', { kind: 'stay_spot' })], [{ t: 0, agent: 'a', site: 'food', kind: 'arrive' }, { t: 0, agent: 'a', site: 'rest', kind: 'arrive' }]), /two sites/, 'two arrivals at one instant refused');
  throwsRefused(() => runSiteLedger([site('x')], [{ t: 0, agent: 'a', site: 'x', kind: 'arrive' }, { t: 0.5, agent: 'a', site: 'x', kind: 'depart' }]), /fixed-dwell/, 'depart from fixed-dwell site refused');
}

// ---------------------------------------------------------------- 4. order independence and tie policy
{
  const S = [site('A', { capacity: 2, dwell_s: 0.7, queue_max: 2 }), site('B', { capacity: 1, dwell_s: 0.3, queue_max: 1, on_release: { site: 'A' } })];
  const req: SiteRequest[] = [];
  for (let i = 0; i < 40; i++) req.push({ t: [0, 0.1, 0.3, 0.7, 1][i % 5] + Math.floor(i / 10) * 0.5, agent: `w${String(i).padStart(2, '0')}`, site: i % 3 ? 'A' : 'B', kind: 'arrive' });
  for (const tie of [{ kind: 'agent_id' } as const, { kind: 'seeded_hash', seed: 7 } as const, { kind: 'seeded_hash', seed: 8 } as const]) {
    const o = isOrderIndependent((xs: SiteRequest[]) => runSiteLedger(S, xs, tie).events, req);
    ok(o.ok, `ledger output identical under ${permutationsOf(req).length} permutations (${JSON.stringify(tie)})`);
    const r = runSiteLedger(S, req, tie);
    eq(validateSiteEvents(S, r.events), [], `no violations (${tie.kind})`);
    for (const s of ['A', 'B']) {
      const x = r.summary[s];
      ok(x.entered === x.present + x.exited, `${s}: entered = present + exited`);
      const stillQ = r.events.filter((e) => e.site === s).at(-1)?.queue_after ?? 0;
      // arrived = admitted directly + queued (later admitted, abandoned or still waiting) + turned away
      const direct = x.entered - (x.queued - x.abandoned - stillQ);
      ok(x.arrived === direct + x.queued + x.turned_away, `${s}: arrived = admitted on arrival + queued + turned away`);
    }
  }
  const a = runSiteLedger(S, req, { kind: 'seeded_hash', seed: 7 }).events, b = runSiteLedger(S, req, { kind: 'seeded_hash', seed: 8 }).events;
  ok(JSON.stringify(a) !== JSON.stringify(b), 'tie seed changes who wins a same-instant tie (tie policy is a stated rule, not array order)');
  // counterexample: a naive producer that admits in ARRAY order is detected as order dependent
  const naive = (xs: SiteRequest[]) => xs.filter((r) => r.site === 'A').slice(0, 2).map((r) => r.agent);   // 'first two in the array get the slots'
  ok(!isOrderIndependent(naive, req).ok, 'array-order admission is detected as order dependent');
}

// ---------------------------------------------------------------- 5. validator counterexamples (hand-made bad streams)
{
  const S = [site('x', { capacity: 1, dwell_s: 1, queue_max: 1 }), site('y', { capacity: 1, dwell_s: null, queue_max: 0, on_release: 'road' })];
  const E = (t: number, agent: string, s: string, kind: SiteEvent['kind'], occ: number, q = 0, to?: string): SiteEvent => ({ t, t_exact: decStr(dec(t)), agent, site: s, kind, occupancy_after: occ, queue_after: q, ...(to ? { to } : {}) });
  const good = [E(0, 'a', 'x', 'arrive', 0), E(0, 'a', 'x', 'admit', 1), E(1, 'a', 'x', 'release', 0, 0, 'off_plane')];
  eq(vk(S, good), [], 'good stream passes');
  eq(vk(S, [E(0, 'a', 'x', 'arrive', 0), E(0, 'a', 'x', 'admit', 1), E(0, 'b', 'x', 'arrive', 1), E(0, 'b', 'x', 'admit', 2)]), ['over_capacity'], 'over-capacity admission flagged');
  eq(vk(S, [E(0, 'a', 'x', 'arrive', 0), E(0, 'a', 'x', 'admit', 1), E(0.5, 'a', 'y', 'arrive', 0), E(0.5, 'a', 'y', 'admit', 1)]), ['double_occupancy'], 'double occupancy flagged');
  ok(vk(S, [E(0, 'a', 'x', 'release', 0, 0, 'off_plane')]).includes('release_before_admission'), 'release before admission flagged');
  eq(vk(S, [E(0, 'a', 'x', 'admit', 1)]), ['admit_without_arrival'], 'admit without arrival flagged');
  eq(vk(S, [...good.slice(0, 2), E(0.9, 'a', 'x', 'release', 0, 0, 'off_plane')]), ['dwell_mismatch'], 'early release (dwell) flagged');
  eq(vk(S, [...good.slice(0, 2), { ...E(1, 'a', 'x', 'release', 0, 0, 'off_plane'), t: 1.0000000000000002, t_exact: '1.0000000000000002' }]), ['dwell_mismatch'], 'float-drifted release time (not the exact due instant 0+1) flagged');
  eq(vk(S, [good[0], { ...good[1], occupancy_after: 0 }]), ['ledger_mismatch'], 'misreported occupancy flagged');
  eq(vk(S, [E(1, 'a', 'x', 'arrive', 0), E(0, 'b', 'y', 'arrive', 0)]), ['time_not_monotone'], 'time going backwards flagged');
  eq(vk(S, [E(0, 'a', 'x', 'arrive', 0), E(0, 'a', 'x', 'admit', 1), E(0, 'b', 'x', 'arrive', 1), E(0, 'b', 'x', 'queue', 1, 1), E(0, 'c', 'x', 'arrive', 1, 1), E(0, 'c', 'x', 'queue', 1, 2)]), ['queue_overflow'], 'queue overflow flagged');
  eq(vk(S, [E(0, 'a', 'x', 'arrive', 0), E(0, 'a', 'x', 'admit', 1), E(0, 'b', 'x', 'arrive', 1), E(0, 'b', 'x', 'queue', 1, 1), E(1, 'a', 'x', 'release', 0, 1, 'off_plane'), E(1, 'c', 'x', 'arrive', 0, 1), E(1, 'c', 'x', 'admit', 1, 1)]), ['queue_jump'], 'new arrival admitted ahead of the queue flagged');
  eq(vk(S, [...good.slice(0, 2), E(1, 'a', 'x', 'release', 0, 0, 'road')]), ['release_target'], 'wrong release target flagged');
  eq(vk(S, [E(0, 'a', 'z', 'arrive', 0)]), ['unknown_site'], 'unknown site flagged');
}

// ---------------------------------------------------------------- 6. stress: many agents, conservation everywhere
{
  const S = [site('mouth', { kind: 'nest_mouth', capacity: 2, dwell_s: 1, queue_max: 5, on_release: { site: 'nest' } }), site('nest', { kind: 'nest_interior', capacity: 10000, dwell_s: 3, queue_max: 0, on_release: 'off_plane' }), site('food', { kind: 'food_site', capacity: 3, dwell_s: 2.5, queue_max: 4, on_release: { site: 'mouth' } })];
  const req: SiteRequest[] = [];
  const inflow = timedInflow(['N', 'S'], 150, 0.5, 0); // 2 agents/s per arm (WP4 K2/K3 control value, game assumption)
  inflow.forEach((x, i) => req.push({ t: x.t, agent: x.agent, site: i % 2 ? 'food' : 'mouth', kind: 'arrive' }));
  const r = runSiteLedger(S, req, { kind: 'seeded_hash', seed: 3 });
  eq(validateSiteEvents(S, r.events), [], `300-agent timed inflow: ${r.events.length} events, no violations`);
  for (const s of S) ok(r.summary[s.id].entered === r.summary[s.id].present + r.summary[s.id].exited, `${s.id}: entered = present + exited at the end`);
  const stress = runSiteLedger(S, simultaneousEntry(Array.from({ length: 300 }, (_, i) => `s${i}`), 0).map((x) => ({ t: x.t, agent: x.agent, site: 'mouth', kind: 'arrive' as const })));
  eq(validateSiteEvents(S, stress.events), [], 'simultaneous-entry stress stream valid');
  eq([stress.summary.mouth.entered, stress.summary.mouth.queued, stress.summary.mouth.turned_away], [7, 5, 293], 'stress: 2 admitted + 5 queued, 293 turned away (setup artefact, not behaviour)');
}

// ---------------------------------------------------------------- 7. metrics over generic trajectories
const OPT: MetricOptions = { contact_tol_mm: 0.1, stall_speed_mm_s: 0.5, provenance: { assumption: true, basis: '遊戲假設', note: 'observer thresholds for tests' } };
{
  const samples: TrajSample[] = [];
  for (let k = 0; k <= 10; k++) {
    samples.push({ agent: 'a', t: k * 0.1, x_mm: 2 * k, y_mm: 0 });                         // straight, 20 mm/s
    samples.push({ agent: 'b', t: k * 0.1, x_mm: k <= 5 ? k : 5, y_mm: k <= 5 ? 3 : 3 + (k - 5) }); // L turn, 10 mm/s
  }
  samples.push({ agent: 'c', t: 0, x_mm: 50, y_mm: 50 }, { agent: 'c', t: 1, x_mm: 50, y_mm: 50 });   // stalled
  const S = [site('exit')];
  const led = runSiteLedger(S, [{ t: 0, agent: 'a', site: 'exit', kind: 'arrive' }, { t: 0, agent: 'b', site: 'exit', kind: 'arrive' }, { t: 0, agent: 'c', site: 'exit', kind: 'arrive' }]);
  const run: TrafficRun = { family: 'timed_inflow_comparison', candidate: 'synthetic', seed: 1, dt_s: 0.1, samples, disk_radius_mm: 0.5, site_events: led.events, agents_expected: ['a', 'b', 'c', 'd'] };
  const m = computeTrafficMetrics(run, OPT);
  ok(m.penetration.approximate, 'disk fallback is flagged approximate');
  ok(Math.abs(m.speed_mm_s.max! - 20) < 1e-9, 'max segment speed 20 mm/s (float sample times)'); ok(Math.abs(m.speed_mm_s.min!) === 0, 'stalled agent speed 0');
  eq(m.route_length_mm.max, 20, 'route length of a = 20 mm');
  ok(Math.abs(m.straightness.max! - 1) < 1e-12, 'straight path straightness 1');
  ok(m.turning.total_rad.max !== null && Math.abs(m.turning.total_rad.max - Math.PI / 2) < 1e-12, 'L path turns π/2');
  ok(Math.abs(m.waiting.stall_time_s - 1) < 1e-12, 'stall time 1 s (agent c)');
  eq(m.waiting.queue_wait_s.max, 1, 'c queued 0 → admitted 1 s');
  eq(m.arrival, { arrived: 3, expected: 4, rate: 0.75, not_a_selection_criterion: true }, 'arrival rate reported, not a criterion');
  eq(m.cost, { cpu_ms: null, heap_bytes: null, measured_outside_engine: true }, 'cost is passthrough, never invented');
  ok(m.individual_variation.cv_mean_speed !== null && m.individual_variation.cv_mean_speed > 0, 'individual variation computed');
  ok(m.behavioural_conclusions_allowed, 'timed-inflow family allows (candidate) comparison');
  eq(Object.keys(m.literature_support).sort(), Object.keys(METRIC_EVIDENCE).sort(), 'every metric has a literature-support entry');
  // order independence of the metric calculator
  const shuffled = permutationsOf(samples).map((p) => computeTrafficMetrics({ ...run, samples: p }, OPT));
  ok(shuffled.every((x) => JSON.stringify(x) === JSON.stringify(m)), 'metrics identical under sample permutations');
  // stress family is never usable for behavioural conclusions
  const st = computeTrafficMetrics({ ...run, family: 'simultaneous_entry_stress' }, OPT);
  ok(!st.behavioural_conclusions_allowed && !FAMILY_SCOPE.simultaneous_entry_stress.behavioural_conclusions_allowed, 'stress family: no behavioural conclusions');
  // exact gaps from a solver: penetration, min spacing and contact episodes
  const gaps = [{ t: 0, a: 'a', b: 'b', gap_mm: 0.5 }, { t: 0.1, a: 'b', b: 'a', gap_mm: 0.05 }, { t: 0.2, a: 'a', b: 'b', gap_mm: -0.01 }, { t: 0.3, a: 'a', b: 'b', gap_mm: 0.3 }, { t: 0.4, a: 'a', b: 'b', gap_mm: 0 }];
  const g = computeTrafficMetrics({ ...run, gaps }, OPT);
  eq([g.penetration.count, g.penetration.max_depth_mm, g.penetration.approximate, g.min_spacing_mm, g.contact.episodes], [1, 0.01, false, -0.01, 2], 'exact gaps: 1 penetration, 2 contact episodes');
  ok(Math.abs(g.contact.pair_time_s - 0.2) < 1e-12, 'contact time 0.2 s (left rectangle)');
  eq(diskGaps([{ agent: 'p', t: 0, x_mm: 0, y_mm: 0 }, { agent: 'q', t: 0, x_mm: 3, y_mm: 4 }], 1)[0].gap_mm, 3, 'disk gap = distance − 2r');
  assert.throws(() => computeTrafficMetrics({ ...run, samples: [...samples, { agent: 'a', t: 0, x_mm: 9, y_mm: 9 }] }, OPT), /two places/); checks++;
  assert.throws(() => computeTrafficMetrics(run, { ...OPT, provenance: undefined as unknown as MetricOptions['provenance'] }), /assumption/); checks++;
  // time-step sensitivity
  const coarse = computeTrafficMetrics({ ...run, dt_s: 0.2, samples: samples.filter((s) => Math.round(s.t * 10) % 2 === 0) }, OPT);
  const ts = timeStepSensitivity([coarse, m]);
  eq(ts.dts, [0.1, 0.2], 'dts sorted');
  // b's L path: fine 10 mm; coarse cuts the corner (8 + √2 mm). Mean over a, b, c: 10 vs (28 + √2)/3 → spread (2 − √2)/3/10.
  ok(Math.abs(ts.keys['route_length_mm.mean'].rel_spread! - (2 - Math.SQRT2) / 3 / 10) < 1e-12, 'coarser sampling cuts the L corner: route-length step sensitivity detected');
  ok(ts.keys['turning.rad_per_mm.mean'].values.every((v) => v !== null), 'turning compared across steps');
  assert.throws(() => timeStepSensitivity([m, { ...m, candidate: 'other', dt_s: 0.2 }]), /share/); checks++;
  assert.throws(() => timeStepSensitivity([m, m]), /distinct/); checks++;
  eq(dist([]).mean, null, 'empty distribution is null, not 0');
}

// ---------------------------------------------------------------- 8. isolation of the new modules
for (const f of ['destinations.ts', 'traffic-metrics.ts']) {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'engine/physics', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/from\s+['"]\.\/(local-steer|solver2d|kinematics2d)\.ts['"]/.test(src), `${f} does not import a solver (solver-agnostic)`);
  ok(!/Math\.random|Date\.now|new Date\(/.test(src), `${f}: no unseeded randomness or wall clock`);
}

// ---------------------------------------------------------------- 9. candidate boundary values stay null + assumption
{
  const c = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scenarios/physics/destinations.candidates.json'), 'utf8'));
  ok(c.synthetic === true, 'candidates file is synthetic');
  for (const [k, v] of Object.entries(c.parameters as Record<string, { value: unknown; assumption: unknown; basis: unknown; unknown_reason: unknown }>)) {
    ok(v.value === null, `${k}: value stays null (no species data)`);
    ok(v.assumption === true && v.basis === '遊戲假設' && typeof v.unknown_reason === 'string', `${k}: labelled assumption with a reason`);
  }
}

console.log(JSON.stringify({ physics_destinations: 'pass', checks }, null, 2));

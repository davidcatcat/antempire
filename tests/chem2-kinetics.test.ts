/**
 * CHEM-2 (#133) tests: environment-coupled kinetics (engine/chemistry/kinetics.ts + the opt-in hook in core.ts), the
 * environment trace built from the P0-A1 clock (prototypes/chem2/env-trace.ts), the kinetics bench
 * (prototypes/chem2/bench.ts) and the CHEM-3 sensing contract (engine/chemistry/sense-contract.ts). Groups:
 *  (1) refusals: every term without evidence stays null; diffusion is refused (CHEM-0 contract); unknown / uncovered
 *      environment refuses instead of guessing; a refused advance changes nothing;
 *  (2) OFF == CHEM-1 bitwise (no kinetics, all-null kinetics, Q10 null);
 *  (3) partition invariance (bitwise): one advance vs many random partitions; historical reconstruction == real-time;
 *      input order invariance;
 *  (4) analytic accuracy: exact hazard integral vs quadrature; constant T_ref and Q10 = 1 reduce to CHEM-1; a stepped
 *      (time-step) scheme converges to the analytic value; ledger closes; non-negative;
 *  (5) environment trace == the clock's environment events (exact);
 *  (6) CHEM-3 contract: own-position, latest-commit, bounded local reads only; negative fixtures refused;
 *      response slots OFF while null;
 *  (7) bench: deterministic, λ = 0 baseline present, Q10 OFF makes weather irrelevant, rain with wash-off null == dry.
 * Every number is synthetic (遊戲假設 D) unless labelled otherwise; nothing here is a species value.
 */
import assert from 'node:assert/strict';
import { ChemRefused, ChemStore, createDiagnosticCapability, type StoreConfig } from '../engine/chemistry/core.ts';
import type { ChemTime, DepositEvent, Domain, SampleQuery } from '../engine/chemistry/contract.ts';
import { CHEM_KINETICS_VERSION, KineticsRuntime, kineticsOff, validateKinetics, type EnvTrace, type KineticsSpec } from '../engine/chemistry/kinetics.ts';
import { createLocalSense, evaluateResponse, responseSlotsOff, validateResponseSlots, type AgentPose, type PoseSource } from '../engine/chemistry/sense-contract.ts';
import { WeatherSeries, planRain } from '../engine/clock/weather-input.ts';
import { environmentSpecs } from '../engine/clock/environment.ts';
import { CLOCK, COVER, PROBES_S, T, TRAIL, PLANE, channel, clockCfg, crossing, envOf, kinetics, singleTrail, weatherInputs, HALF_LIVES_MIN } from '../prototypes/chem2/bench.ts';
import { chemSecondsOf, envTraceFromClock } from '../prototypes/chem2/env-trace.ts';
import { rng, shuffle } from '../prototypes/chem1/scenarios.ts';

const diag: Record<string, string> = {};
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refused = (f: () => unknown, code: string, why: string) => {
  try { f(); } catch (e) { ok(e instanceof ChemRefused && e.codes.some((c) => c.includes(code)), `${why}: refused with ${code} (got ${(e as ChemRefused).codes ?? e})`); return; }
  ok(false, `${why}: expected refusal ${code}`);
};
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
const U = { quantity: 'normalized_activity' as const, length: 'mm' as const, time: 's' as const };
const dep = (id: string, signal_id: string, t_s: number, where: DepositEvent['where'], amount = 1, round = 0): DepositEvent =>
  ({ deposit_id: id, signal_id, origin_agent: `a:${id}`, source_worker_id: null, origin_event_id: `e:${id}`, time: T(t_s, round), layer: 'surface', substrate: null, where, amount, cause: 'synthetic', units: U });
const ENV_HOT = envOf('hot'), ENV_COOL = envOf('cool');
const synthTrace = (knots: [number, number | null][], rain: [number, number][] = [], timing_known = true): EnvTrace => ({
  clock: CLOCK.name, t0_s: knots[0][0], t1_s: knots[knots.length - 1][0],
  zones: [{ zone_id: 'z', selector: { kind: 'all' }, temperature: { quantity: 'air_temp_c_surrogate', knots: knots.map(([t_s, value]) => ({ t_s, value })), provenance: { kind: 'synthetic_test', synthetic: true, assumption: true, source: 'test', method: 'test knots' } }, rain: { timing_known, intervals: rain.map(([a, b], i) => ({ event_id: `r${i}`, t0_s: a, t1_s: b })), provenance: { kind: 'synthetic_test', synthetic: true, assumption: true, source: 'test', method: 'test' } } }],
});
const edgeCfg = (half: number | null, k?: KineticsSpec, env: EnvTrace | null = ENV_HOT): StoreConfig => ({ clock: CLOCK, ...(env ? { environment: env } : {}), channels: [{ spec: channel('m1', 'surface_edge', half), domain: TRAIL, ...(k ? { kinetics: k } : {}) }] });
const planeCfg = (half: number | null, k?: KineticsSpec, env: EnvTrace | null = ENV_HOT): StoreConfig => ({ clock: CLOCK, ...(env ? { environment: env } : {}), channels: [{ spec: channel('x', 'sparse_2d', half), domain: PLANE, ...(k ? { kinetics: k } : {}) }] });
const sEdge = (t: number, s_mm = 300): SampleQuery => ({ signal_id: 'm1', agent_id: 'probe', layer: 'surface', time: T(t), phase: 'local_sensing', sensor: { kind: 'edge', edge_id: 'trail', s_mm, radius_mm: 3 } });
const sDisc = (t: number, x = 200, y = 200, r = 3): SampleQuery => ({ signal_id: 'x', agent_id: 'probe', layer: 'surface', time: T(t), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: x, y_mm: y, radius_mm: r } });
const prov = (value: number | null, extra: Partial<{ assumption: boolean; evidence_level: 'A' | 'B' | 'C' | 'D'; sources: string[] }> = {}) => ({ value, assumption: true, basis: '遊戲假設' as const, evidence_level: 'D' as const, sources: [] as string[], note: 'test', ...extra });
/** random deposits on the trail edge or plane within [t0, t1] (synthetic) */
function randomDeposits(seed: number, backend: 'edge' | 'plane', n: number, t0: number, t1: number): DepositEvent[] {
  const g = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const t = Math.round(t0 + g() * (t1 - t0)), a = g() * 600, b = g() * 600;
    const where: DepositEvent['where'] = backend === 'edge' ? (g() < 0.5 ? { kind: 'edge_point', edge_id: 'trail', s_mm: a } : { kind: 'edge_segment', edge_id: 'trail', s0_mm: Math.min(a, b), s1_mm: Math.max(a, b) + 1e-3 })
      : { kind: 'segment2d', x0_mm: 150 + g() * 100, y0_mm: 150 + g() * 100, x1_mm: 150 + g() * 100, y1_mm: 150 + g() * 100 };
    return dep(`d${seed}-${i}`, backend === 'edge' ? 'm1' : 'x', t, where, 0.1 + g(), g() < 0.2 ? 1 : 0);
  });
}
const digest = (s: ChemStore, sig: string) => JSON.stringify({ snap: s.snapshot(), ledger: s.ledger(sig) });

// ======================= (1) refusals
{
  const k = kinetics(2);
  ok(validateKinetics(kineticsOff(), false).length === 0, 'all-null kinetics is valid');
  ok(validateKinetics({ ...k, diffusion_mm2_per_s: prov(1e-3) }, false).includes('DIFFUSION_NOT_IN_CHEM0_CONTRACT'), 'a diffusion value is refused: CHEM-0 fixes isotropic_diffusion false');
  ok(validateKinetics({ ...k, humidity: prov(0.5) }, false).includes('NO_FUNCTIONAL_FORM:humidity'), 'a humidity value is refused (no evidence-backed form)');
  ok(validateKinetics({ ...k, substrate: prov(0.5) }, false).includes('NO_FUNCTIONAL_FORM:substrate'), 'a substrate value is refused (no evidence-backed form)');
  ok(validateKinetics({ ...k, temperature: { ...k.temperature!, q10: prov(0) } }, false).includes('BAD:q10'), 'Q10 <= 0 refused');
  ok(validateKinetics({ ...k, temperature: { ...k.temperature!, q10: prov(2, { assumption: false }) } }, false).some((x) => x.startsWith('UNSUPPORTED_NON_ASSUMPTION')), 'a Q10 claimed as non-assumption without A-level species evidence is refused');
  ok(validateKinetics({ ...k, temperature: { ...k.temperature!, t_ref_c: prov(null) } }, false).includes('MISSING:t_ref_c'), 'Q10 without a reference temperature refused');
  ok(validateKinetics({ ...k, rain_washoff_per_s: prov(-1) }, false).includes('BAD:rain_washoff_per_s'), 'negative wash-off refused');
  ok(validateKinetics(k, true).includes('SINKS_NOT_SEPARATED_FOR_TRUE_AMOUNT'), 'a true-amount channel cannot lump its sinks into one hazard');
  ok(validateKinetics({ ...k, version: 'x' } as unknown as KineticsSpec, false)[0] === 'BAD:kinetics_version', 'version checked');
  refused(() => new ChemStore(edgeCfg(17, kinetics(2), null)), 'KINETICS_WITHOUT_ENVIRONMENT', 'active kinetics without an environment');
  refused(() => new ChemStore(edgeCfg(17, kinetics(2), { ...ENV_HOT, clock: 'other' })), 'ENV_WRONG_CLOCK', 'environment on another clock');
  const subst = kinetics(2); subst.temperature!.input = 'substrate_temp_c';
  refused(() => new ChemStore(edgeCfg(17, subst)), 'ENV_QUANTITY_MISMATCH', 'a channel reading substrate temperature cannot be fed the air-temperature surrogate');
  refused(() => new ChemStore(edgeCfg(17, kinetics(2), { ...ENV_HOT, zones: [] })), 'MISSING:env_zones', 'no zones');
  const two = { ...ENV_HOT, zones: [ENV_HOT.zones[0], { ...ENV_HOT.zones[0], zone_id: 'dup' }] };
  refused(() => new ChemStore(edgeCfg(17, kinetics(2), two)), 'ENV_ZONE_AMBIGUOUS', 'a cell in two zones');
  const rect = { ...ENV_HOT, zones: [{ ...ENV_HOT.zones[0], selector: { kind: 'rect' as const, x0_mm: 0, y0_mm: 0, x1_mm: 200, y1_mm: 400 } }] };
  refused(() => new ChemStore(planeCfg(17, kinetics(2), rect)), 'ENV_ZONE_MISSING', 'a plane cell outside every zone');
  refused(() => new ChemStore(edgeCfg(17, kinetics(2), synthTrace([[0, 25], [100, 25], [50, 25]]))), 'KNOTS_NOT_INCREASING', 'unsorted knots');
  refused(() => new ChemStore(edgeCfg(17, kinetics(2), { ...synthTrace([[0, 25], [100, 25]]), t1_s: 200 })), 'TEMPERATURE_DOES_NOT_COVER', 'trace shorter than the declared coverage');
  refused(() => new ChemStore(edgeCfg(17, kinetics(null, 1e-3), synthTrace([[0, 25], [1000, 25]], [], false))), 'ENV_RAIN_TIMING_UNKNOWN', 'wash-off on a wet period with unknown timing (never treated as dry)');
  refused(() => new ChemStore(edgeCfg(17, kinetics(null, 1e-3), synthTrace([[0, 25], [1000, 25]], [[10, 50], [40, 60]]))), 'RAIN_OVERLAP', 'overlapping rain intervals');
  const unlabelled = synthTrace([[0, 25], [10, 25]]); unlabelled.zones[0].temperature!.provenance = { ...unlabelled.zones[0].temperature!.provenance, kind: 'forecast', synthetic: false, assumption: false };
  refused(() => new ChemStore(edgeCfg(17, kinetics(2), unlabelled)), 'UNLABELLED_NON_OBSERVATION', 'a forecast trace must be labelled');
  // an uncovered or unknown environment refuses the advance, and the refused advance changes nothing
  const s = new ChemStore(edgeCfg(17, kinetics(2), synthTrace([[0, 25], [600, 30], [1200, null], [1800, 28]])));
  s.deposit([dep('a', 'm1', 100, { kind: 'edge_point', edge_id: 'trail', s_mm: 300 })]);
  s.advance(T(500)); const before = digest(s, 'm1');
  refused(() => s.advance(T(900)), 'ENV_VALUE_UNKNOWN', 'a null temperature on the way to the horizon');
  ok(digest(s, 'm1') === before && s.horizon!.t_s === 500, 'refused advance left the store unchanged');
  refused(() => s.advance(T(5000)), 'ENV_TRACE_NOT_COVERED', 'horizon beyond the trace');
  const s2 = new ChemStore(edgeCfg(17, kinetics(2), synthTrace([[100, 25], [1000, 25]])));
  s2.deposit([dep('early', 'm1', 50, { kind: 'edge_point', edge_id: 'trail', s_mm: 300 })]);
  refused(() => s2.advance(T(200)), 'ENV_TRACE_NOT_COVERED', 'a deposit before the trace starts');
  // kinetics present but OFF does not need an environment
  ok(new ChemStore(edgeCfg(17, kineticsOff(), null)).channels().length === 1, 'OFF kinetics needs no environment');
}

// ======================= (2) OFF == CHEM-1, bitwise
for (const backend of ['edge', 'plane'] as const) for (const half of [null, 5, 17, 60]) for (const seed of [1, 2, 3]) {
  const evs = randomDeposits(seed, backend, 60, 10, 20000);
  const run = (k: KineticsSpec | undefined) => {
    const s = new ChemStore(backend === 'edge' ? edgeCfg(half, k) : planeCfg(half, k));
    s.deposit(evs); const reads: number[] = [];
    for (const t of [5000, 12000, 20000, 30000]) { s.advance(T(t)); reads.push(backend === 'edge' ? s.sampleLocal(sEdge(t)).exposure : s.sampleLocal(sDisc(t)).mean_density_per_mm2!); }
    return JSON.stringify({ d: digest(s, backend === 'edge' ? 'm1' : 'x'), reads });
  };
  const base = run(undefined);
  ok(run(kineticsOff()) === base, `${backend} half ${half} seed ${seed}: all-null kinetics == CHEM-1 bitwise`);
  ok(run(kinetics(null)) === base, `${backend} half ${half} seed ${seed}: Q10 null == CHEM-1 bitwise`);
}

// ======================= (3) partition invariance, historical == real-time, order invariance
{
  const env = synthTrace([[0, 21], [3600, 27.5], [7200, 33], [10000, 31], [20000, 24], [30000, 22]], [[4000, 5200], [9000, 9050]]);
  for (const backend of ['edge', 'plane'] as const) for (const seed of [4, 5, 6, 7, 8, 9]) {
    const k = kinetics(seed % 2 ? 2 : 3, 2e-3), cfg = backend === 'edge' ? edgeCfg(17, k, env) : planeCfg(17, k, env), sig = backend === 'edge' ? 'm1' : 'x';
    const evs = randomDeposits(seed, backend, 80, 0, 25000);
    const one = new ChemStore(cfg); one.deposit(evs); one.advance(T(30000));
    const g = rng(100 + seed), cuts = [...new Set(Array.from({ length: 40 }, () => Math.round(g() * 30000)))].sort((a, b) => a - b);
    const many = new ChemStore(cfg); many.deposit(shuffle(evs, g));
    const seen: { t: number; v: number }[] = [];
    for (const t of [...cuts, 30000]) {
      if (many.horizon && t <= many.horizon.t_s) continue;
      many.advance(T(t));
      seen.push({ t, v: backend === 'edge' ? many.sampleLocal(sEdge(t)).exposure : many.sampleLocal(sDisc(t)).mean_density_per_mm2! });
    }
    ok(JSON.stringify(one.snapshot()) === JSON.stringify(many.snapshot()), `${backend} seed ${seed}: one advance == ${cuts.length} random advances (shuffled input): snapshot bitwise`);
    { const la = one.ledger(sig), lb = many.ledger(sig);
      // accepted_amount is summed in INPUT order (CHEM-1 ledger, unchanged): equal up to float summation order only
      ok(JSON.stringify({ ...la, accepted_amount: 0, residual: 0 }) === JSON.stringify({ ...lb, accepted_amount: 0, residual: 0 }) && rel(la.accepted_amount, lb.accepted_amount) < 1e-14, `${backend} seed ${seed}: ledger present / decayed / integrated bitwise (accepted_amount up to input-order summation)`); }
    const cap = createDiagnosticCapability('reconstruction');
    const sensor = backend === 'edge' ? sEdge(0).sensor : sDisc(0).sensor;
    ok(seen.every(({ t, v }) => { const h = one.sampleHistorical(cap, { signal_id: sig, layer: 'surface', at: T(t), sensor, purpose: 'reconstruction' }); return Object.is(backend === 'edge' ? h.exposure : h.mean_density_per_mm2!, v); }), `${backend} seed ${seed}: every real-time reading == historical reconstruction from the one-step store, bitwise`);
    const L = one.ledger(sig);
    ok(Math.abs(L.residual) <= 1e-9 * L.integrated_amount && L.present_amount >= 0 && L.decayed_amount >= 0, `${backend} seed ${seed}: ledger integrated = present + decayed (residual ${L.residual.toExponential(1)})`);
    ok(one.snapshot().channels[0].cells.every((c) => c.value >= 0 && Number.isFinite(c.value)), `${backend} seed ${seed}: non-negative, finite`);
  }
}

// ======================= (4) analytic accuracy
{
  const env = synthTrace([[0, 18], [1800, 26], [5400, 35], [9000, 30], [14400, 20]], [[2000, 2600]]);
  const k = kinetics(2.5, 5e-4), rt = new KineticsRuntime(k, Math.LN2 / 600, env);
  // composite Simpson on each linear piece (the integrand is smooth inside a knot interval)
  const quad = (a: number, b: number) => { const n = 20000, h = (b - a) / n; let s = rt.rateAt(0, a) + rt.rateAt(0, b - 1e-9); for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * rt.rateAt(0, a + i * h); return (s * h) / 3; };
  const pieces = [0, 1800, 2000, 2600, 5400, 9000, 14400];
  let worst = 0;
  for (const [a, b] of [[0, 14400], [100, 7000], [2100, 2500], [5400, 9000]] as const) {
    const cuts = [a, ...pieces.filter((p) => p > a && p < b), b]; let q = 0; for (let i = 0; i + 1 < cuts.length; i++) q += quad(cuts[i], cuts[i + 1]);
    worst = Math.max(worst, rel(rt.hazard(0, a, b), q));
  }
  diag.quadrature_worst_rel = worst.toExponential(2);
  ok(worst < 1e-9, `exact hazard integral == Simpson quadrature (worst rel ${worst.toExponential(2)})`);
  // constant T = T_ref and Q10 = 1 reduce to CHEM-1 (not bitwise: different expression; float tolerance)
  for (const [name, kk, e] of [['T = T_ref', kinetics(3), synthTrace([[0, 25], [40000, 25]])], ['Q10 = 1', kinetics(1), ENV_HOT]] as const) {
    let w = 0;
    for (const seed of [11, 12]) {
      const evs = randomDeposits(seed, 'edge', 40, 100, 20000);
      const a = new ChemStore(edgeCfg(17, kk, e)), b = new ChemStore(edgeCfg(17));
      a.deposit(evs); b.deposit(evs); a.advance(T(30000)); b.advance(T(30000));
      for (const s of [50, 300, 550]) w = Math.max(w, rel(a.sampleLocal(sEdge(30000, s)).exposure, b.sampleLocal(sEdge(30000, s)).exposure));
    }
    diag[`reduces_to_chem1 ${name}`] = w.toExponential(2);
    ok(w < 1e-10, `${name}: equals the CHEM-1 constant-λ value (worst rel ${w.toExponential(2)})`);
  }
  // a time-stepped scheme (hazard frozen at the left end of each step) converges to the analytic value
  const exact = Math.exp(-rt.hazard(0, 0, 14400));
  const errs = [600, 60, 6].map((dt) => { let H = 0; for (let t = 0; t < 14400; t += dt) H += rt.rateAt(0, t) * dt; return Math.abs(Math.exp(-H) - exact) / exact; });
  diag.stepped_rel_err_dt600_60_6 = errs.map((x) => x.toExponential(2)).join(' ');
  ok(errs[0] > errs[1] && errs[1] > errs[2] && errs[2] < 1e-2, `stepped scheme converges to the analytic value as Δt -> 0 (rel err ${errs.map((x) => x.toExponential(1)).join(' > ')})`);
  // monotone: a uniformly hotter trace decays faster (Q10 > 1); colder slower
  const at = (shift: number) => { const s = new ChemStore(edgeCfg(17, kinetics(2), synthTrace([[0, 20 + shift], [7200, 30 + shift], [20000, 22 + shift]]))); s.deposit([dep('m', 'm1', 10, { kind: 'edge_point', edge_id: 'trail', s_mm: 300 })]); s.advance(T(15000)); return s.sampleLocal(sEdge(15000)).exposure; };
  ok(at(-5) > at(0) && at(0) > at(5), 'hotter trace -> lower remaining activity (direction of R35/R36, other species; the size is a grid assumption)');
  // wash-off acts only while raining
  const rr = new KineticsRuntime(kinetics(null, 1e-3), 0, synthTrace([[0, 25], [5000, 25]], [[1000, 2000]]));
  ok(rr.hazard(0, 0, 1000) === 0 && Math.abs(rr.hazard(0, 0, 5000) - 1) < 1e-12 && Math.abs(rr.hazard(0, 1500, 4000) - 0.5) < 1e-12, 'wash-off integrates only the raining time');
}

// ======================= (5) environment trace == clock environment events
{
  for (const step of [60, 10]) {
    const cfg = clockCfg(step), inputs = weatherInputs('hot'), env = envTraceFromClock(cfg, inputs, CLOCK, COVER);
    const series = new WeatherSeries(cfg.anchor, cfg.site, inputs, cfg.temperature_shape), plan = planRain(series, cfg.first_day, cfg.last_day, cfg.seed, cfg.rain_timing);
    const samples = environmentSpecs(cfg, series, plan).filter((s) => s.kind === 'weather_sample');
    const knots = env.zones[0].temperature!.knots;
    ok(knots.every((k) => { const day = CLOCK.anchor.day + Math.floor((k.t_s / 60 + CLOCK.anchor.minute) / 1440), minute = ((k.t_s / 60 + CLOCK.anchor.minute) % 1440 + 1440) % 1440; return Object.is(series.temperature(day, minute).value, k.value); }), `step ${step}: every knot == WeatherSeries.temperature at that instant (exact)`);
    ok(knots.length > 0 && knots.every((k) => samples.some((s) => chemSecondsOf(CLOCK, s.native!.anchor.day, s.native!.t) === k.t_s)), `step ${step}: every knot is a weather_sample event time`);
    ok(env.zones[0].temperature!.quantity === 'air_temp_c_surrogate' && env.zones[0].temperature!.provenance.synthetic === true && env.zones[0].temperature!.provenance.assumption === true, `step ${step}: trace labelled air surrogate, synthetic, assumption`);
  }
  const wet = envTraceFromClock(clockCfg(10, true), weatherInputs('hot', 5), CLOCK, COVER), r = wet.zones[0].rain!;
  ok(r.timing_known && r.intervals.length === 1 && r.intervals[0].t1_s - r.intervals[0].t0_s === 3600, 'rain events become one [start, end) interval of the scenario length');
  const unknown = envTraceFromClock(clockCfg(10, false), weatherInputs('hot', 5), CLOCK, COVER);
  ok(unknown.zones[0].rain!.timing_known === false, 'a wet day without a timing scenario -> rain timing unknown (never dry)');
}

// ======================= (6) CHEM-3 behaviour-coupling contract
{
  const store = new ChemStore(planeCfg(17, kinetics(2)));
  store.deposit([dep('p1', 'x', 100, { kind: 'segment2d', x0_mm: 100, y0_mm: 200, x1_mm: 300, y1_mm: 200 })]);
  store.advance(T(200));
  const poses: PoseSource = { poseAt: (id, t) => (id === 'w1' && t.t_s >= 0 ? { kind: 'point', layer: 'surface', x_mm: 150, y_mm: 201 } as AgentPose : null) };
  const reader = store.realtimeReader();
  refused(() => createLocalSense(store as never, poses, 'w1'), 'GLOBAL_ACCESS_REFUSED', 'a ChemStore (global field, snapshot, ledger, history) cannot be handed to an individual');
  refused(() => createLocalSense({ kind: 'chem_realtime_reader', latestCommitted: () => null, sampleLocal: () => null } as never, poses, 'w1'), 'NOT_A_REALTIME_READER', 'a hand-made (unfrozen) reader is refused');
  refused(() => createLocalSense(Object.freeze({ ...reader, snapshot: () => store.snapshot() }) as never, poses, 'w1'), 'GLOBAL_ACCESS_REFUSED', 'a reader with a snapshot member is refused');
  const sense = createLocalSense(reader, poses, 'w1');
  ok(Object.isFrozen(sense) && Object.keys(sense).sort().join() === 'agent_id,kind,read', 'the sense is frozen and has only agent_id, kind, read');
  const r = sense.read({ signal_id: 'x', time: T(200), radius_mm: 3, measure: 'mean_density_per_mm2' });
  const direct = store.sampleLocal({ signal_id: 'x', agent_id: 'w1', layer: 'surface', time: T(200), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: 150, y_mm: 201, radius_mm: 3 } });
  ok(Object.is(r.value, direct.mean_density_per_mm2) && r.state_commit.seq === direct.state_commit.seq, 'the reading is the CHEM-1b real-time sample at the individual\'s OWN pose');
  ok(!('cells' in r) && Object.keys(r).sort().join() === 'agent_id,detectable,measure,read_kind,sensing_time,signal_id,state_commit,value,view', 'the reading is scalar: no cells, keys or provenance');
  refused(() => sense.read({ signal_id: 'x', time: T(200), radius_mm: 3, measure: 'mean_density_per_mm2', x_mm: 300, y_mm: 200 } as never), 'REQUEST_KEY_NOT_ALLOWED:x_mm', 'a request naming a position (remote read) is refused');
  refused(() => sense.read({ signal_id: 'x', time: T(200), radius_mm: 3, measure: 'exposure', sensor: { kind: 'disc', x_mm: 300, y_mm: 200, radius_mm: 3 } } as never), 'REQUEST_KEY_NOT_ALLOWED:sensor', 'a request carrying its own sensor is refused');
  refused(() => sense.read({ signal_id: 'x', time: T(200), radius_mm: 3, measure: 'exposure', agent_id: 'w2' } as never), 'REQUEST_KEY_NOT_ALLOWED:agent_id', 'reading as another individual is refused');
  refused(() => sense.read({ signal_id: 'x', time: T(200), radius_mm: 3, measure: 'exposure', at: T(100) } as never), 'REQUEST_KEY_NOT_ALLOWED:at', 'a historical instant in the request is refused');
  refused(() => sense.read({ signal_id: 'x', time: T(250), radius_mm: 3, measure: 'mean_density_per_mm2' }), 'FUTURE_SAMPLE', 'a future-time read (after the latest commit) is refused');
  store.advance(T(300));
  refused(() => sense.read({ signal_id: 'x', time: T(200), radius_mm: 3, measure: 'mean_density_per_mm2' }), 'STALE_SAMPLE', 'a read of an older committed state is refused');
  refused(() => sense.read({ signal_id: 'x', time: T(300), radius_mm: 1e6, measure: 'mean_density_per_mm2' }), 'RADIUS_ABOVE_BOUND', 'a whole-field radius is refused');
  refused(() => sense.read({ signal_id: 'x', time: T(300), radius_mm: Infinity, measure: 'mean_density_per_mm2' }), 'UNBOUNDED_RADIUS', 'an infinite radius is refused');
  refused(() => sense.read({ signal_id: 'x', time: T(300), radius_mm: 0, measure: 'exposure' }), 'EXPOSURE_AT_ZERO_RADIUS', 'a point read must use the mean density');
  ok(sense.read({ signal_id: 'x', time: T(300), radius_mm: 0, measure: 'mean_density_per_mm2' }).value > 0, 'a point read with the mean density works');
  refused(() => createLocalSense(reader, poses, 'w9').read({ signal_id: 'x', time: T(300), radius_mm: 3, measure: 'exposure' }), 'NO_POSE', 'an individual without a physics pose cannot sense');
  const es = new ChemStore(edgeCfg(null)); es.deposit([dep('e1', 'm1', 1, { kind: 'edge_point', edge_id: 'trail', s_mm: 300 })]); es.advance(T(2));
  const eSense = createLocalSense(es.realtimeReader(), { poseAt: () => ({ kind: 'edge', layer: 'surface', edge_id: 'trail', s_mm: 300 }) }, 'w1');
  refused(() => eSense.read({ signal_id: 'm1', time: T(2), radius_mm: 3, measure: 'mean_density_per_mm2' }), 'MEASURE_UNAVAILABLE_ON_BACKEND', 'edges have no area density');
  ok(eSense.read({ signal_id: 'm1', time: T(2), radius_mm: 3, measure: 'exposure' }).value === 1, 'edge read at the own pose');
  // response slots: OFF while null; provenance enforced; forms evaluate only with every parameter given
  const off = responseSlotsOff();
  ok(validateResponseSlots(off).length === 0 && evaluateResponse(off, { value: 1 }).value === null, 'all-null slots are valid and OFF (null, never a guessed number)');
  ok(evaluateResponse(off, { value: 1 }).off.join() === 'OFF:threshold,OFF:gain', 'OFF reasons are listed');
  ok(validateResponseSlots({ ...off, gain: prov(1, { assumption: false }) }).some((x) => x.startsWith('UNSUPPORTED_NON_ASSUMPTION')), 'a gain claimed as measured without species evidence is refused');
  ok(validateResponseSlots({ ...off, exponent: prov(2) }).includes('EXPONENT_NOT_IN_FORM'), 'an exponent on the linear form is refused');
  ok(validateResponseSlots({ ...off, form_evidence: 'C' }).includes('BAD:form_evidence'), 'the linear-threshold form is D, not C');
  ok(evaluateResponse({ ...off, threshold: prov(0.2), gain: prov(2) }, { value: 0.5 }).value === 0.6000000000000001 || Math.abs(evaluateResponse({ ...off, threshold: prov(0.2), gain: prov(2) }, { value: 0.5 }).value! - 0.6) < 1e-12, 'linear above threshold evaluates with candidate values');
  const den = responseSlotsOff('deneubourg_power');
  ok(den.form_evidence === 'C' && den.sources.includes('R102') && evaluateResponse(den, { value: 1 }).value === null, 'Deneubourg-type slot (C) is OFF by default');
  ok(evaluateResponse({ ...den, threshold: prov(1), gain: prov(1), exponent: prov(2) }, { value: 1 }).value === 4, '(k + x)^n with candidate values');
}

// ======================= (7) bench
{
  const a = singleTrail(17, 2, 'hot', 'laden'), b = singleTrail(17, 2, 'hot', 'laden');
  ok(JSON.stringify(a) === JSON.stringify(b), 'bench is deterministic');
  ok(HALF_LIVES_MIN.includes(null), 'the λ = 0 baseline is part of the grid');
  const z = singleTrail(null, null, 'cool', 'laden');
  ok(z.values.every((v) => v === z.values[0]) && Math.abs(z.values[0] - 0.75) < 1e-12, 'λ = 0: no within-day decay (45 passes × 2 bins × 5/600)');
  ok(JSON.stringify(singleTrail(17, null, 'hot', 'laden').values) === JSON.stringify(singleTrail(17, null, 'cool', 'laden').values), 'Q10 OFF: the weather does not act (bitwise)');
  const hot = singleTrail(17, 2, 'hot', 'laden').values, cool = singleTrail(17, 2, 'cool', 'laden').values;
  ok(hot.every((v, i) => v < cool[i]), 'Q10 2: the hot afternoon is below the cool one at every probe');
  ok(JSON.stringify(singleTrail(17, 2, 'hot', 'laden', envOf('hot', 10, 5)).values) === JSON.stringify(hot), 'rain with wash-off null == rain-free (bitwise)');
  const c = crossing(null, null, 'cool');
  ok(Math.abs(c.crossing[0] - (c.on_A[0] + c.on_B[0])) / c.crossing[0] < 0.05, 'λ = 0 crossing ≈ sum of the two trails (linear field, both trails pass the probe disc)');
  ok(PROBES_S.length === 6 && ENV_COOL.zones[0].temperature!.knots.length > 0, 'bench probes and cool trace exist');
}

console.log(JSON.stringify({ test: 'chem2-kinetics', checks, kinetics_version: CHEM_KINETICS_VERSION, diag }));

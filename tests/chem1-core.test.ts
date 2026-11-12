/**
 * CHEM-1 (#132) core tests. Four groups, reported separately:
 *  (1) counterexamples of #132 injected -> each must be refused / have no effect; correct cases pass;
 *  (2) math invariants: non-negativity, no signal from nothing, analytic == stepped reference, advance-partition
 *      invariance (bitwise), input-order invariance (bitwise), id-renaming invariance, multi-seed, ledger closure;
 *  (3) synthetic examples (two ants, Y-maze, overlap / far apart, sparse space) are deterministic and behave as the
 *      model says (these are NOT biology checks: every number is synthetic);
 *  (4) the official engine is untouched (no import; see chemistry-isolation, golden).
 */
import assert from 'node:assert/strict';
import { ChemRefused, ChemStore, canonicalCompare, replayChem, type ChemOp, type StoreConfig } from '../engine/chemistry/core.ts';
import type { DepositEvent, SampleQuery } from '../engine/chemistry/contract.ts';
import { CHEM_PHASES } from '../engine/chemistry/contract.ts';
import { CLOCK, PLANE, T, Y_EDGES, dep, rng, shuffle, sparseSpace, synthChannel, twoAnts, yMaze } from '../prototypes/chem1/scenarios.ts';
import { GRID_CELLS_MM, gridSensitivity, gridTableRows } from '../prototypes/chem1/grid-sensitivity.ts';
import fs from 'node:fs';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refused = (f: () => unknown, code: string, why: string) => {
  try { f(); } catch (e) { ok(e instanceof ChemRefused && e.codes.some((c) => c.includes(code)), `${why}: refused with ${code} (got ${(e as ChemRefused).codes ?? e})`); return; }
  ok(false, `${why}: expected refusal ${code}`);
};
const close = (a: number, b: number, rel = 1e-12) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const edgeCfg = (lambda = 0): StoreConfig => ({ clock: CLOCK, channels: [{ spec: synthChannel('trail', 'surface_edge', { lambda_per_s: lambda }), domain: Y_EDGES }] });
const planeCfg = (lambda = 0, layers = ['surface', 'underground']): StoreConfig => ({ clock: CLOCK, channels: [{ spec: synthChannel('p', 'sparse_2d', { lambda_per_s: lambda }), domain: PLANE(200, layers) }] });
const eq = (q: Partial<SampleQuery> & { s_mm?: number; edge?: string; t?: number; r?: number } = {}): SampleQuery => ({ signal_id: 'trail', agent_id: 'w', layer: q.layer ?? 'surface', time: T(q.t ?? 10), phase: 'local_sensing', sensor: { kind: 'edge', edge_id: q.edge ?? 'stem', s_mm: q.s_mm ?? 10, radius_mm: q.r ?? 2 } });

// ======================= (1) counterexamples
{ // correct case
  const s = new ChemStore(edgeCfg());
  const r = s.deposit([dep('d1', 'trail', 'w1', T(5), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 }, 2)]);
  ok(r[0].accepted, 'correct deposit accepted');
  s.advance(T(10));
  ok(s.sampleLocal(eq()).exposure === 2, 'correct sample sees the deposit (lambda = 0)');
}
{ // sensing beyond the horizon / the future
  const s = new ChemStore(edgeCfg());
  s.deposit([dep('d1', 'trail', 'w1', T(5), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 })]);
  refused(() => s.sampleLocal(eq({ t: 5 })), 'FUTURE_SAMPLE', 'sample before any horizon is closed');
  s.advance(T(4));
  refused(() => s.sampleLocal(eq({ t: 5 })), 'FUTURE_SAMPLE', 'sample beyond the closed horizon');
  ok(s.sampleLocal(eq({ t: 4 })).exposure === 0, 'a deposit at t=5 is invisible at t=4 (deposit-before-sense)');
  s.advance(T(6));
  refused(() => s.sampleLocal(eq({ t: 4 })), 'STALE_SAMPLE', 'sample at an earlier time than the horizon');
  ok(s.sampleLocal(eq({ t: 6 })).exposure === 1, 'visible once the horizon passes it');
}
{ // same-instant policy: (t, round) <= (t', round'), set-based
  const s = new ChemStore(edgeCfg());
  s.deposit([dep('r1', 'trail', 'w1', T(5, 1), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 })]);
  s.advance(T(5, 0));
  ok(s.sampleLocal({ ...eq(), time: T(5, 0) }).exposure === 0, 'round-1 deposit invisible to a round-0 sample at the same instant');
  s.advance(T(5, 1));
  ok(s.sampleLocal({ ...eq(), time: T(5, 1) }).exposure === 1, 'visible to a sample in the same round');
  ok(s.deposit([dep('r0', 'trail', 'w2', T(5, 1), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 })])[0].reason === 'LATE_DEPOSIT', 'a deposit into a closed (t, round) is late (no back-dating)');
  ok(s.deposit([dep('r2', 'trail', 'w2', T(5, 2), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 })])[0].accepted, 'the next round of the same instant is open');
  refused(() => s.advance(T(5, 0)), 'HORIZON_BACKWARDS', 'horizon never moves backwards');
}
{ // cross-layer sensing and deposits
  const s = new ChemStore(planeCfg());
  s.deposit([dep('u', 'p', 'w1', T(1), { kind: 'point2d', x_mm: 50, y_mm: 50 }, 1, 'underground')]);
  s.advance(T(1));
  const q: SampleQuery = { signal_id: 'p', agent_id: 'w2', layer: 'surface', time: T(1), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: 50, y_mm: 50, radius_mm: 3 } };
  ok(s.sampleLocal(q).exposure === 0 && s.sampleLocal({ ...q, layer: 'underground' }).exposure === 1, 'a surface sensor does not read the underground layer at the same x,y');
  refused(() => s.sampleLocal({ ...q, layer: 'canopy' }), 'CROSS_LAYER_SAMPLE', 'sampling a layer the domain does not have');
  refused(() => s.deposit([dep('c', 'p', 'w1', T(2), { kind: 'point2d', x_mm: 1, y_mm: 1 }, 1, 'canopy')]), 'CROSS_LAYER_DEPOSIT', 'depositing into a missing layer');
  const e = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('trail', 'surface_edge'), domain: { backend: 'surface_edge', edges: [{ id: 'stem', length_mm: 60, layer: 'surface' }, { id: 'tunnel', length_mm: 60, layer: 'underground' }] } }] });
  e.advance(T(10));
  refused(() => e.sampleLocal(eq({ edge: 'tunnel' })), 'CROSS_LAYER_SAMPLE', 'a surface agent cannot read an underground edge');
}
{ // global / unbounded reads
  const s = new ChemStore(edgeCfg()); s.advance(T(10));
  refused(() => s.sampleLocal(eq({ r: Infinity })), 'UNBOUNDED_RADIUS', 'infinite radius (whole-map read)');
  refused(() => s.sampleLocal(eq({ r: 3.0001 })), 'RADIUS_ABOVE_BOUND', 'radius above the channel bound');
  refused(() => s.sampleLocal({ ...eq(), sensor: undefined as never }), 'MISSING:sensor', 'a read without a position');
  refused(() => s.sampleLocal(eq({ edge: 'nowhere' })), 'OUT_OF_BOUNDS:sensor', 'a sensor off the domain');
  // and a correct bounded read only returns cells that intersect the interval
  const t = new ChemStore(edgeCfg());
  t.deposit([dep('n', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 12 }), dep('f', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 40 }, 5)]);
  t.advance(T(10));
  const r = t.sampleLocal(eq({ s_mm: 12, r: 3 }));
  ok(r.exposure === 1 && r.cells.every((c) => Math.abs((c.center_mm as number) - 12) <= 3 + 2.5) && r.view === 'agent_local', 'a local read does not include a far cell (40 mm)');
  // 2D: a cell inside the bounding square but outside the disc is not read
  const p = new ChemStore(planeCfg());
  p.deposit([dep('in', 'p', 'w', T(1), { kind: 'point2d', x_mm: 51, y_mm: 52.5 }), dep('corner', 'p', 'w', T(1), { kind: 'point2d', x_mm: 55, y_mm: 55 }, 7)]);
  p.advance(T(1));
  const pr = p.sampleLocal({ signal_id: 'p', agent_id: 'w', layer: 'surface', time: T(1), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: 51, y_mm: 51, radius_mm: 3 } });
  // CHEM-1b area weighting: the 'in' cell [50,52)x[52,54) is partly inside the disc -> its value times the covered fraction
  ok(pr.cells.length === 1 && pr.cells[0].key === 'surface|25,26' && pr.cells[0].cover > 0.5 && pr.cells[0].cover < 1 && close(pr.exposure, pr.cells[0].cover), 'the disc excludes a diagonal cell 4.2 mm away (bounding-square read would include it); the partly covered cell is area-weighted');
}
{ // duplicate deposits of the same source event
  const s = new ChemStore(edgeCfg());
  const a = dep('d1', 'trail', 'w1', T(5), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 }, 1, 'surface', 'ph3b:w1:seg7');
  const res = s.deposit([a, { ...a, deposit_id: 'd2' }, { ...a, origin_event_id: 'ph3b:w1:seg8' }]);
  ok(res[0].accepted && res[1].reason === 'DUPLICATE_ORIGIN_EVENT' && res[2].reason === 'DUPLICATE_DEPOSIT_ID', 'same origin event and same deposit id are each recorded once');
  ok(s.deposit([{ ...a, deposit_id: 'd3' }])[0].reason === 'DUPLICATE_ORIGIN_EVENT', 'duplicate detected across batches too');
  s.advance(T(10));
  const L = s.ledger('trail');
  ok(s.sampleLocal(eq()).exposure === 1 && L.rejected.DUPLICATE_ORIGIN_EVENT.count === 2 && L.rejected.DUPLICATE_DEPOSIT_ID.count === 1, 'duplicates do not reach the field and are counted');
}
{ // negatives, zero, NaN, signal from nothing
  const s = new ChemStore(edgeCfg());
  for (const amount of [-1, 0, NaN, Infinity]) refused(() => s.deposit([dep('x', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 1 }, amount)]), 'BAD:amount', `amount ${amount}`);
  refused(() => new ChemStore(edgeCfg(-0.1)), 'BAD:lambda_per_s', 'negative decay rate');
  s.advance(T(100));
  const r = s.sampleLocal(eq({ t: 100 }));
  ok(r.exposure === 0 && r.cells.length === 0 && s.snapshot().channels[0].cells.length === 0, 'no deposits -> no cells, zero exposure (no signal from nothing)');
}
{ // atomic batch: one bad event refuses the batch and changes nothing
  const s = new ChemStore(edgeCfg());
  refused(() => s.deposit([dep('ok', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 1 }), dep('bad', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 1 }, -1)]), 'BAD:amount', 'batch with a bad event');
  s.advance(T(2));
  ok(s.ledger('trail').accepted_count === 0 && s.deposit([dep('ok', 'trail', 'w', T(3), { kind: 'edge_point', edge_id: 'stem', s_mm: 1 })])[0].accepted, 'nothing of the refused batch was recorded');
}
{ // edge vs mm/s and minute unit confusion
  const s = new ChemStore(edgeCfg());
  refused(() => s.deposit([{ ...dep('m', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 1 }), time: { clock: CLOCK.name, unit: 'min' as 's', t_s: 1, round: 0 } }]), 'BAD_UNITS:time', 'a deposit timed in minutes');
  refused(() => s.deposit([{ ...dep('m', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 1 }), units: { quantity: 'normalized_activity', length: 'edge' as 'mm', time: 's' } }]), 'BAD_UNITS:length_or_time', 'a deposit in edge-length units');
  ok(s.deposit([dep('frac', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 0.5 * 600 })])[0].reason === 'OUT_OF_BOUNDS', 'an edge-fraction mistaken for mm lands off the 60 mm edge and is rejected');
  refused(() => s.advance({ clock: CLOCK.name, unit: 'min' as 's', t_s: 1, round: 0 }), 'BAD_UNITS:time', 'advance in minutes');
  const bad = synthChannel('trail', 'surface_edge'); (bad.time_rule as { unit: string }).unit = 'min';
  refused(() => new ChemStore({ clock: CLOCK, channels: [{ spec: bad, domain: Y_EDGES }] }), 'BAD_UNITS:time_rule', 'a per-minute decay rule');
  refused(() => s.deposit([{ ...dep('wc', 'trail', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 1 }), time: { clock: 'world', unit: 's', t_s: 1, round: 0 } }]), 'WRONG_CLOCK', 'a time on another clock');
  ok(s.ledger('trail').rejected.OUT_OF_BOUNDS.count === 1 && s.ledger('trail').rejected.OUT_OF_BOUNDS.amount === 1, 'out-of-bounds amount is accounted');
}
{ // non-field channels cannot be used by this core; channels never mix
  const chc = synthChannel('chc', 'surface_edge'); chc.mechanism = 'chc_recognition';
  refused(() => new ChemStore({ clock: CLOCK, channels: [{ spec: chc, domain: Y_EDGES }] }), 'MECHANISM_BACKEND_MISMATCH', 'CHC as an edge field');
  const s = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('E', 'surface_edge', { variant: 'M2', role: 'E', lambda_per_s: 0.001 }), domain: Y_EDGES }, { spec: synthChannel('F', 'surface_edge', { variant: 'M2', role: 'F', lambda_per_s: 0.002 }), domain: Y_EDGES }] });
  s.deposit([dep('e1', 'E', 'w', T(1), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 }, 3)]); s.advance(T(10));
  ok(s.sampleLocal({ ...eq(), signal_id: 'F' }).exposure === 0 && s.sampleLocal({ ...eq(), signal_id: 'E' }).exposure > 0, 'multi-channel: a deposit on E is not seen on F');
}

// ======================= (2) math invariants
type Rnd = () => number;
const randomOps = (g: Rnd, n: number, plane: boolean): DepositEvent[] => Array.from({ length: n }, (_, i) => {
  const t = Math.floor(g() * 20) * 0.5, round = g() < 0.2 ? 1 : 0, amount = [0.1, 0.2, 0.3, 1 / 3, 0.7][Math.floor(g() * 5)];
  const where = plane
    ? (g() < 0.5 ? { kind: 'point2d' as const, x_mm: g() * 40, y_mm: g() * 40 } : { kind: 'segment2d' as const, x0_mm: g() * 40, y0_mm: g() * 40, x1_mm: g() * 40, y1_mm: g() * 40 })
    : (g() < 0.5 ? { kind: 'edge_point' as const, edge_id: ['stem', 'left', 'right'][Math.floor(g() * 3)], s_mm: g() * 60 } : { kind: 'edge_segment' as const, edge_id: 'stem', s0_mm: g() * 60, s1_mm: g() * 60 });
  return dep(`d${i}`, plane ? 'p' : 'trail', `w${Math.floor(g() * 7)}`, T(t, round), where, amount, plane && g() < 0.3 ? 'underground' : 'surface');
}).filter((d) => d.where.kind !== 'segment2d' || d.where.x0_mm !== d.where.x1_mm || d.where.y0_mm !== d.where.y1_mm).filter((d) => d.where.kind !== 'edge_segment' || d.where.s0_mm !== d.where.s1_mm);
const fieldOf = (cfg: StoreConfig, evs: DepositEvent[], stops: number[]) => {
  const s = new ChemStore(cfg); s.deposit(evs);
  for (const t of stops) s.advance(T(t, 2));
  return s;
};
const LAMBDA = 0.05; // synthetic, 1/s
for (let seed = 1; seed <= 20; seed++) {
  for (const plane of [false, true]) {
    const g = rng(seed * 97 + (plane ? 1 : 0)), evs = randomOps(g, 120, plane), cfg = plane ? planeCfg(LAMBDA) : edgeCfg(LAMBDA), id = plane ? 'p' : 'trail';
    const base = fieldOf(cfg, evs, [10]), snap = JSON.stringify(base.snapshot());
    // non-negativity
    ok(base.snapshot().channels[0].cells.every((c) => c.value >= 0 && Number.isFinite(c.value)), `seed ${seed} ${plane ? '2d' : 'edge'}: all values non-negative`);
    // partition invariance (bitwise)
    const parts = [...new Set(Array.from({ length: 6 }, () => Math.floor(g() * 20) * 0.5))].sort((a, b) => a - b).concat(10);
    ok(JSON.stringify(fieldOf(cfg, evs, parts).snapshot()) === snap, `seed ${seed}: advance partition ${parts.join(',')} gives a bitwise-identical field`);
    // input-order invariance (bitwise), whole batch and split batches
    ok(JSON.stringify(fieldOf(cfg, shuffle(evs, g), [10]).snapshot()) === snap, `seed ${seed}: shuffled input is bitwise identical`);
    { const s = new ChemStore(cfg), sh = shuffle(evs, g); s.deposit(sh.slice(0, 50)); s.deposit(sh.slice(50)); s.advance(T(10, 2)); ok(JSON.stringify(s.snapshot()) === snap, `seed ${seed}: split, shuffled batches are bitwise identical`); }
    // id renaming: agents and ids permuted -> same values (tolerance; ties are equal amounts so identical in practice)
    const ren = evs.map((d) => ({ ...d, deposit_id: `z${d.deposit_id.split('').reverse().join('')}`, origin_agent: `x${d.origin_agent}`, origin_event_id: `o${d.origin_event_id}` }));
    const rs = fieldOf(cfg, ren, [10]).snapshot().channels[0].cells, bs = base.snapshot().channels[0].cells;
    ok(rs.length === bs.length && rs.every((c, i) => c.key === bs[i].key && close(c.value, bs[i].value)), `seed ${seed}: renamed ids give the same field`);
    // analytic == direct sum and ledger closure
    const L = base.ledger(id), direct = evs.reduce((x, d) => x + d.amount * Math.exp(-LAMBDA * (10 - d.time.t_s)), 0);
    ok(close(L.present_amount, direct, 1e-11) && close(L.integrated_amount, L.present_amount + L.decayed_amount, 1e-11) && Math.abs(L.residual) <= 1e-9, `seed ${seed}: present = Σ q·exp(-λΔt), integrated = present + decayed`);
    ok(L.balance_kind === 'activity_audit', 'normalized activity is audited, not called a mass balance');
  }
}
{ // analytic vs a stepped reference (explicit per-step multiplication), lambda > 0 and lambda = 0
  for (const lambda of [0, 0.01, 0.2]) {
    const g = rng(4242), evs = randomOps(g, 60, false).map((d) => ({ ...d, time: T(d.time.t_s, 0), where: { kind: 'edge_point' as const, edge_id: 'stem', s_mm: 22 } }));
    const s = fieldOf(edgeCfg(lambda), evs, [10]);
    let v = 0; const dt = 0.5;
    for (let k = 0; k <= 20; k++) { const t = k * dt; if (k > 0) v *= Math.exp(-lambda * dt); for (const d of evs) if (d.time.t_s === t) v += d.amount; }
    ok(close(s.sampleLocal({ ...eq({ s_mm: 22, r: 0 }), time: T(10, 2) }).exposure, v, 1e-12), `analytic equals stepped reference (lambda ${lambda})`);
    if (lambda === 0) ok(close(s.ledger('trail').present_amount, s.ledger('trail').integrated_amount, 1e-14) && s.ledger('trail').decayed_amount === 0, 'lambda = 0 baseline: nothing decays');
  }
}
{ // sensitivity of the order check: a naive store that adds in input order (no canonical sort) is caught
  const g = rng(9), evs = randomOps(g, 200, false).map((d) => ({ ...d, where: { kind: 'edge_point' as const, edge_id: 'stem', s_mm: 1 } }));
  const naive = (xs: DepositEvent[]) => xs.reduce((a, d) => a + d.amount * Math.exp(-LAMBDA * (10 - d.time.t_s)), 0);
  let differs = false; for (let k = 0; k < 20 && !differs; k++) differs = naive(shuffle(evs, g)) !== naive(evs);
  ok(differs, 'a naive input-order summation is NOT bitwise order-invariant (so the bitwise test above has power)');
  ok([...evs].sort(canonicalCompare).map((d) => d.deposit_id).join() === shuffle(evs, g).sort(canonicalCompare).map((d) => d.deposit_id).join(), 'canonical order is independent of input order');
}
{ // replay is pure and refusals are recorded
  const g = rng(5), evs = randomOps(g, 40, true);
  const ops: ChemOp[] = [{ op: 'deposit', events: evs }, { op: 'advance', to: T(5) }, { op: 'sample', query: { signal_id: 'p', agent_id: 'w', layer: 'surface', time: T(6), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: 20, y_mm: 20, radius_mm: 3 } } }, { op: 'advance', to: T(10) }, { op: 'sample', query: { signal_id: 'p', agent_id: 'w', layer: 'surface', time: T(10), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: 20, y_mm: 20, radius_mm: 3 } } }];
  const a = JSON.stringify(replayChem(planeCfg(LAMBDA), ops)), b = JSON.stringify(replayChem(planeCfg(LAMBDA), ops));
  ok(a === b && a.includes('FUTURE_SAMPLE'), 'replay deterministic; a future sample is recorded as refused');
}

// ======================= (2b) layered same-instant contract (Owner decision): sources -> commit -> update -> sense -> behave
const at = (sv: ChemStore, t: number, round = 0, phase: SampleQuery['phase'] = 'local_sensing', s_mm = 10, r = 3) =>
  sv.sampleLocal({ signal_id: 'trail', agent_id: 'w', layer: 'surface', time: T(t, round), phase, sensor: { kind: 'edge', edge_id: 'stem', s_mm, radius_mm: r } });
const P = (id: string, t: number, round = 0, s_mm = 10, amount = 1, agent = 'w1') => dep(id, 'trail', agent, T(t, round), { kind: 'edge_point', edge_id: 'stem', s_mm }, amount);
{ // causality
  ok(CHEM_PHASES.join() === 'physics_and_sources,chemistry_commit,chemistry_update,local_sensing,behaviour_decision', 'contract fixes the five phases in order');
  const s = new ChemStore(edgeCfg(0.05));
  s.deposit([P('a', 4), P('b', 4, 0, 11)]); s.advance(T(4));
  // phase 1 of t=5: sources submitted, not yet committed
  s.deposit([P('c', 5, 0, 10, 2), P('d', 5, 0, 9, 3)]);
  refused(() => at(s, 5), 'FUTURE_SAMPLE', 'phase-4 sample at t=5 before the t=5 commit (horizon still 4)');
  for (const ph of ['physics_and_sources', 'chemistry_commit', 'chemistry_update'] as const) refused(() => at(s, 5, 0, ph), 'SAMPLE_BEFORE_COMMIT', `sample declared in phase ${ph}`);
  const before = at(s, 4);
  ok(close(before.exposure, 2) && before.cells.every((c) => !s.provenance('trail', c.key).some((x) => x === 'c' || x === 'd')), 'the last committed instant does not see the pending t=5 sources');
  s.advance(T(5)); // phases 2+3 of t=5
  const now = at(s, 5);
  ok(now.exposure === 2 * Math.exp(-0.05) + 2 + 3, 'phase-4 sample at t=5 sees the deposits committed in phase 2 of the same instant');
  for (const ph of ['physics_and_sources', 'chemistry_commit', 'chemistry_update'] as const) refused(() => at(s, 5, 0, ph), 'SAMPLE_BEFORE_COMMIT', `even after the commit, a sample declared in ${ph} is refused`);
  refused(() => at(s, 5, 0, 'behaviour_decision'), 'SAMPLE_OUTSIDE_SENSING_PHASE', 'phase 5 does not re-read the field');
  { const { phase: _drop, ...noPhase } = { ...eq({ t: 5 }) }; refused(() => s.sampleLocal(noPhase as SampleQuery), 'MISSING:phase', 'a sample without a phase'); }
  refused(() => at(s, 5, 0, 'whenever' as never), 'BAD:phase', 'an unknown phase');
  // future deposits never visible: later round of the same t, later t, an epsilon later
  s.deposit([P('r1', 5, 1, 10, 7), P('t6', 6, 0, 10, 11), P('eps', 5 + 1e-9, 0, 10, 13)]);
  ok(Object.is(at(s, 5).exposure, now.exposure) && s.ledger('trail').pending_count === 3, 'pending future deposits (round+1, t+ε, t+1) do not change the phase-4 reading');
  // behaviour (phase 5) at t=5 emits a deposit: it must carry a later (t, round)
  ok(s.deposit([P('beh', 5, 0, 10, 1, 'w2')])[0].reason === 'LATE_DEPOSIT', 'a phase-5 deposit stamped with the committed instant is late (no same-instant feedback)');
  s.advance(T(5, 1));
  ok(at(s, 5, 1).exposure === now.exposure + 7 && Object.is(at(s, 5, 1).exposure, at(s, 5, 1).exposure), 'the round-1 deposit becomes visible in round 1 of the same t only after its own commit');
}
{ // committed events are immutable
  const s = new ChemStore(edgeCfg(0.02));
  const orig = P('k', 3, 0, 10, 2, 'w9');
  s.deposit([orig]); s.advance(T(3));
  const ref = JSON.stringify(at(s, 3)), prov = s.provenance('trail', 'stem#2');
  ok(s.deposit([{ ...orig, amount: 50 }])[0].reason === 'LATE_DEPOSIT', 'replacing a committed deposit at its own instant is refused (LATE_DEPOSIT)');
  ok(s.deposit([{ ...orig, time: T(4), amount: 50 }])[0].reason === 'DUPLICATE_DEPOSIT_ID', 're-sending a committed deposit_id at a later time is refused (DUPLICATE_DEPOSIT_ID)');
  ok(s.deposit([{ ...orig, deposit_id: 'k2', time: T(4), amount: 50 }])[0].reason === 'DUPLICATE_ORIGIN_EVENT', 're-deriving a deposit from the same origin event is refused (DUPLICATE_ORIGIN_EVENT)');
  (orig as { amount: number }).amount = 1e6; (orig.where as { s_mm: number }).s_mm = 40; orig.time.t_s = 0;
  prov.push('forged'); s.snapshot().channels[0].cells.forEach((c) => { c.value = 1e9; });
  s.advance(T(4)); s.advance(T(4));
  const later = at(s, 4);
  ok(JSON.stringify(at(s, 3 + 1)) === JSON.stringify(later) && close(later.exposure, JSON.parse(ref).exposure * Math.exp(-0.02)) && s.provenance('trail', 'stem#2').join() === 'k', 'mutating the caller event, a provenance copy or a snapshot copy edits nothing that was committed');
  ok(s.ledger('trail').rejected.LATE_DEPOSIT.count === 1 && s.ledger('trail').rejected.DUPLICATE_DEPOSIT_ID.count === 1 && s.ledger('trail').rejected.DUPLICATE_ORIGIN_EVENT.count === 1, 'every edit attempt is counted in the ledger');
}
{ // permutation invariance at one instant: deposit order, agent / deposit ids, batch splits -> bitwise identical samples
  for (let seed = 1; seed <= 20; seed++) for (const plane of [false, true]) {
    const g = rng(7000 + seed * 2 + (plane ? 1 : 0)), id = plane ? 'p' : 'trail', cfg = plane ? planeCfg(LAMBDA) : edgeCfg(LAMBDA);
    const W = (): DepositEvent['where'] => plane
      ? (g() < 0.5 ? { kind: 'point2d', x_mm: 10 + 10 * g(), y_mm: 10 + 10 * g() } : { kind: 'segment2d', x0_mm: 10 + 10 * g(), y0_mm: 10 + 10 * g(), x1_mm: 10 + 10 * g(), y1_mm: 10 + 10 * g() })
      : (g() < 0.5 ? { kind: 'edge_point', edge_id: 'stem', s_mm: 5 + 15 * g() } : { kind: 'edge_segment', edge_id: 'stem', s0_mm: 5 + 15 * g(), s1_mm: 5 + 15 * g() });
    const prior = Array.from({ length: 15 }, (_, i) => dep(`p${i}`, id, `w${i % 4}`, T(2), W(), [0.1, 0.3, 1 / 3][i % 3]));
    const now: DepositEvent[] = [];
    for (let i = 0; i < 40; i++) {
      const w = W(), amount = [0.1, 0.2, 1 / 3, 0.7][Math.floor(g() * 4)];
      now.push(dep(`n${i}`, id, `w${Math.floor(g() * 9)}`, T(7), w, amount));
      if (i % 5 === 0) now.push(dep(`n${i}tie`, id, `w${Math.floor(g() * 9)}`, T(7), { ...w }, amount)); // exact ties: only ids differ
    }
    const valid = (d: DepositEvent) => !(d.where.kind === 'segment2d' && d.where.x0_mm === d.where.x1_mm && d.where.y0_mm === d.where.y1_mm) && !(d.where.kind === 'edge_segment' && d.where.s0_mm === d.where.s1_mm);
    const sensors = Array.from({ length: 6 }, () => plane ? { kind: 'disc' as const, x_mm: 10 + 10 * g(), y_mm: 10 + 10 * g(), radius_mm: 3 } : { kind: 'edge' as const, edge_id: 'stem', s_mm: 5 + 15 * g(), radius_mm: 3 });
    const run = (batches: DepositEvent[][]) => {
      const s = new ChemStore(cfg); s.deposit(prior.filter(valid)); s.advance(T(2));
      for (const b of batches) s.deposit(b.filter(valid));
      s.advance(T(7));
      return JSON.stringify(sensors.map((sensor) => s.sampleLocal({ signal_id: id, agent_id: 'reader', layer: 'surface', time: T(7), phase: 'local_sensing', sensor })));
    };
    const base = run([now]);
    ok(base === run([shuffle(now, g)]), `seed ${seed} ${plane ? '2d' : 'edge'}: shuffled same-instant deposits -> bitwise identical samples`);
    const perm = shuffle(now.map((_, i) => i), g);
    const renamed = now.map((d, i) => ({ ...d, deposit_id: `q${perm[i]}`, origin_agent: `ant${(perm[i] * 7) % 13}`, origin_event_id: `e${perm[i]}` }));
    ok(base === run([renamed]), `seed ${seed} ${plane ? '2d' : 'edge'}: permuted agent and deposit ids -> bitwise identical samples`);
    const sh = shuffle(now, g), cuts = [...new Set([0, Math.floor(g() * sh.length), Math.floor(g() * sh.length), Math.floor(g() * sh.length), sh.length])].sort((a, b) => a - b);
    const batches = cuts.slice(1).map((e, k) => sh.slice(cuts[k], e));
    ok(batches.reduce((n, b) => n + b.length, 0) === sh.length && base === run(batches), `seed ${seed} ${plane ? '2d' : 'edge'}: same instant split into ${batches.length} batches -> bitwise identical samples`);
  }
}
{ // no global propagation: a same-instant deposit outside the effective sensing range contributes exactly 0
  for (const amount of [1, 1e9]) {
    const e = new ChemStore(edgeCfg()), e0 = new ChemStore(edgeCfg());
    // edge bins of 5 mm, sensor at 10 +/- 3 -> bins [7, 13] -> cells 1..2 (5..15 mm); 15.0 lands in bin 3 (outside)
    for (const st of [e, e0]) st.deposit([P('near', 9, 0, 12)]);
    e.deposit([P('far1', 9, 0, 15, amount), P('far2', 9, 0, 59, amount), dep('other', 'trail', 'w', T(9), { kind: 'edge_point', edge_id: 'left', s_mm: 0 }, amount)]);
    e.advance(T(9)); e0.advance(T(9));
    ok(Object.is(at(e, 9).exposure, at(e0, 9).exposure) && at(e, 9).exposure === 1, `edge: same-instant deposits beyond the bins of the interval (same edge, other edge) add exactly 0 (amount ${amount})`);
    const p = new ChemStore(planeCfg()), p0 = new ChemStore(planeCfg());
    for (const st of [p, p0]) st.deposit([dep('near', 'p', 'w', T(9), { kind: 'point2d', x_mm: 51, y_mm: 51 })]);
    // sensor (51, 51) r = 3 with 2 mm cells: cell [54,56)x[50,52) is 3 mm away (touches) -> read; [56,58) is 5 mm -> not;
    // diagonal cell [54,56)x[54,56) is 3*sqrt2 mm away -> not; another layer and the far corner -> not
    p.deposit([dep('ring', 'p', 'w', T(9), { kind: 'point2d', x_mm: 56.5, y_mm: 51 }, amount), dep('diag', 'p', 'w', T(9), { kind: 'point2d', x_mm: 54.5, y_mm: 54.5 }, amount),
      dep('corner', 'p', 'w', T(9), { kind: 'point2d', x_mm: 199, y_mm: 199 }, amount), dep('under', 'p', 'w', T(9), { kind: 'point2d', x_mm: 51, y_mm: 51 }, amount, 'underground')]);
    p.advance(T(9)); p0.advance(T(9));
    const q = (st: ChemStore) => st.sampleLocal({ signal_id: 'p', agent_id: 'r', layer: 'surface', time: T(9), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: 51, y_mm: 51, radius_mm: 3 } });
    ok(Object.is(q(p).exposure, q(p0).exposure) && q(p).exposure === 1, `2d: same-instant deposits outside every cell that intersects the disc add exactly 0 (amount ${amount})`);
    const touch = new ChemStore(planeCfg()); touch.deposit([dep('t', 'p', 'w', T(9), { kind: 'point2d', x_mm: 55.9, y_mm: 51 }, amount)]); touch.advance(T(9));
    // CHEM-1 read this deposit in full (whole cell touching the disc); CHEM-1b: the cell meets the disc in zero area -> exactly 0
    ok(q(touch).exposure === 0 && q(touch).cells.length === 0, `2d: a deposit 4.9 mm away in a cell that only touches the 3 mm disc is NOT read (zero intersection area; CHEM-1b overreach removed)`);
  }
}
{ // grid / cell-size sensitivity and convergence of sparse_2d sampling (Owner decisions 4 and 30: report, do not tune)
  const rows = gridSensitivity();
  ok(JSON.stringify(rows) === JSON.stringify(gridSensitivity()), 'grid sensitivity is deterministic');
  ok(rows.every((r) => r.bound_violations === 0), 'every area-weighted sample (aligned and half-cell-shifted grid) lies in [exact(r − cell·√2), exact(r + cell·√2)]');
  ok(rows.every((r, i) => i === 0 || (r.mean_abs_err < rows[i - 1].mean_abs_err && r.mean_band < rows[i - 1].mean_band && r.mean_leak < rows[i - 1].mean_leak)), 'mean error, provable band and sub-cell leak all shrink monotonically with the cell (convergence)');
  ok(rows.every((r) => r.mean_abs_err < r.legacy_mean_abs_err && Math.abs(r.rel_bias) < Math.abs(r.legacy_rel_bias)), 'area weighting is closer to the continuous reference than the CHEM-1 whole-cell rule at every cell size');
  const doc = fs.readFileSync(new URL('../docs/chemical-ecology-engine.md', import.meta.url), 'utf8');
  ok(gridTableRows(rows).every((row) => doc.includes(row)) && GRID_CELLS_MM.length === rows.length, 'docs §14.6 records the computed grid table verbatim');
}

// ======================= (3) synthetic examples
{
  const y0 = yMaze(0), y1 = yMaze(Math.LN2 / 600);
  ok(close(y0.left, 10 * (5 / 60)) && y0.right === 0, 'Y-maze lambda=0: the marked branch reads the summed deposits of 10 ants, the unmarked one 0');
  ok(y1.left > 0 && y1.left < y0.left && y1.right === 0, 'Y-maze with decay: lower, still only on the walked branch');
  ok(JSON.stringify(yMaze(0)) === JSON.stringify(y0), 'Y-maze deterministic');
  const near = twoAnts(0), far = twoAnts(50);
  ok(near.readings.every((r, i) => close(r.a, 2 * far.readings[i].a)) && far.readings.every((r) => close(r.a, r.b)), 'two ants: overlapping paths read the sum of both marks, 50 mm apart each reads only its own');
  const sp = sparseSpace(14, 30);
  ok(sp.cells_stored > 0 && sp.cells_stored < 0.02 * sp.cells_possible && JSON.stringify(sparseSpace(14, 30)) === JSON.stringify(sp), `sparse space: ${sp.cells_stored} of ${sp.cells_possible} cells stored, deterministic`);
}

console.log(JSON.stringify({ test: 'chem1-core', checks }));

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
import { CLOCK, PLANE, T, Y_EDGES, dep, rng, shuffle, sparseSpace, synthChannel, twoAnts, yMaze } from '../prototypes/chem1/scenarios.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refused = (f: () => unknown, code: string, why: string) => {
  try { f(); } catch (e) { ok(e instanceof ChemRefused && e.codes.some((c) => c.includes(code)), `${why}: refused with ${code} (got ${(e as ChemRefused).codes ?? e})`); return; }
  ok(false, `${why}: expected refusal ${code}`);
};
const close = (a: number, b: number, rel = 1e-12) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const edgeCfg = (lambda = 0): StoreConfig => ({ clock: CLOCK, channels: [{ spec: synthChannel('trail', 'surface_edge', { lambda_per_s: lambda }), domain: Y_EDGES }] });
const planeCfg = (lambda = 0, layers = ['surface', 'underground']): StoreConfig => ({ clock: CLOCK, channels: [{ spec: synthChannel('p', 'sparse_2d', { lambda_per_s: lambda }), domain: PLANE(200, layers) }] });
const eq = (q: Partial<SampleQuery> & { s_mm?: number; edge?: string; t?: number; r?: number } = {}): SampleQuery => ({ signal_id: 'trail', agent_id: 'w', layer: q.layer ?? 'surface', time: T(q.t ?? 10), sensor: { kind: 'edge', edge_id: q.edge ?? 'stem', s_mm: q.s_mm ?? 10, radius_mm: q.r ?? 2 } });

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
  const q: SampleQuery = { signal_id: 'p', agent_id: 'w2', layer: 'surface', time: T(1), sensor: { kind: 'disc', x_mm: 50, y_mm: 50, radius_mm: 3 } };
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
  const pr = p.sampleLocal({ signal_id: 'p', agent_id: 'w', layer: 'surface', time: T(1), sensor: { kind: 'disc', x_mm: 51, y_mm: 51, radius_mm: 3 } });
  ok(pr.exposure === 1 && pr.cells.length === 1, 'the disc excludes a diagonal cell 4.2 mm away (bounding-square read would include it)');
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
  const ops: ChemOp[] = [{ op: 'deposit', events: evs }, { op: 'advance', to: T(5) }, { op: 'sample', query: { signal_id: 'p', agent_id: 'w', layer: 'surface', time: T(6), sensor: { kind: 'disc', x_mm: 20, y_mm: 20, radius_mm: 3 } } }, { op: 'advance', to: T(10) }, { op: 'sample', query: { signal_id: 'p', agent_id: 'w', layer: 'surface', time: T(10), sensor: { kind: 'disc', x_mm: 20, y_mm: 20, radius_mm: 3 } } }];
  const a = JSON.stringify(replayChem(planeCfg(LAMBDA), ops)), b = JSON.stringify(replayChem(planeCfg(LAMBDA), ops));
  ok(a === b && a.includes('FUTURE_SAMPLE'), 'replay deterministic; a future sample is recorded as refused');
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

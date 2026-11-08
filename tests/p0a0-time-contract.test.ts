/**
 * P0-A0 time contract (docs/p0a0-time-contract.md): world time vs native (physics) time.
 * Owner review of #116: a 60 µs tick can merge events < 60 µs apart and change their causal order. This test proves:
 *  1. quantisation error bound native → tick, with the native time kept on every event (provenance);
 *  2. counterexample regressions: ± half-tick, midnight, many events at one instant, changed step size (delay grouping,
 *     physics broadphase window), seed / id / input-order invariance;
 *  3. candidate contracts (60 µs, 1 µs, 1 ns ticks, layered) compared on REAL PH-2 sequences and synthetic pairs — the
 *     doc tables are recomputed here and must match verbatim;
 *  4. rounding never silently merges or reorders: under 'tick' every merge / inversion is detected and reported (or
 *     refused); under 'layered' distinct native instants never share a batch and the order is the exact order.
 * Plus: truly simultaneous events still get no contest rule; day boundaries; several colonies on one world time;
 * stable ids and named RNG streams. All event times here are synthetic or come from synthetic physics scenes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { simulate } from '../engine/physics/collision.ts';
import { hash32, rng } from '../engine/rng.ts';
import { WorldScheduler, SchedulerError, verifyLog, addMinutes, addNative, checkTime, exactOf, exactOfWorld, compareExact, labelOf, quantisationErrorUs, nearestDiv, rngStreamName, TICKS_PER_MINUTE, TICK_US, US_PER_DAY, type NativeTime, type EventSpec, type WorldEvent, type TimeOrder } from '../engine/scheduler/world-events.ts';
import { CANDIDATE_CONTRACTS, evaluateContract, tickContract } from '../engine/scheduler/time-contract.ts';
import { ph2Configs, itemsOf, physIds, nativeOfPhys, ph2Table, sweepTable, syntheticTable, ANCHOR } from '../prototypes/p0a0-time-contract/measure.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refuses = (f: () => unknown, re: RegExp, why: string) => { assert.throws(f, (e: unknown) => e instanceof SchedulerError && re.test((e as Error).message), why); checks++; };
const W = 'W';
const ref = (colony: string | null = null, individual: string | null = null) => ({ world: W, colony, individual });
const nat = (t: number, unit: 's' | 'min' = 's', anchor = { day: 0, minute: 0 }, clock = 'c'): NativeTime => ({ clock, unit, anchor, t });
const spec = (key: string, native: NativeTime, kind = 'e'): EventSpec => ({ kind, key, native, scope: ref(), source: null, target: null });
const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer);
const ulpStep = (x: number, n: number) => { f64[0] = x; i64[0] += BigInt(n); return f64[0]; };
const runAll = (s: WorldScheduler) => { const batches: Readonly<WorldEvent>[][] = []; s.runUntil({ day: 30, minute: 0 }, (b) => { batches.push([...b]); }); return batches; };
const ticksOf = (t_s: number) => (t_s * 1e6) / TICK_US;

// ---------------------------------------------------------------- 1. quantisation error bound, provenance
{
  const g = rng(1107);
  let maxErr = 0, n = 0;
  for (const order of ['tick', 'layered'] as TimeOrder[]) {
    const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order });
    for (let i = 0; i < 4000; i++) {
      const unit = i % 2 ? 's' : 'min', anchor = { day: Math.floor(g() * 3), minute: Math.floor(g() * 1439e6) / 1e6 };
      const t = unit === 's' ? g() * 3600 : g() * 60;
      const native = nat(t, unit, anchor, `k${i % 5}`);
      let id: string; try { id = s.schedule(spec(`q${i}`, native)); } catch (e) { if (/rounds to 24:00/.test(String(e))) continue; throw e; }
      const e = s.get(id)!;
      ok(JSON.stringify(e.native) === JSON.stringify(native) && e.native.t === t, `provenance: the event keeps its native time bit for bit (${order} #${i})`);
      const err = quantisationErrorUs(e.at, e.exact);
      maxErr = Math.max(maxErr, Math.abs(err)); n++;
      // the label is the correctly rounded tick of the exact instant: check against an independent exact computation
      ok(Math.round(checkTime(e.at).minute * TICKS_PER_MINUTE) === nearestDiv(e.exact.us, e.exact.us_lo, 1, TICK_US) || (order === 'layered' && e.at.minute === 1439.999999), `label = nearest tick of the exact instant (#${i})`);
    }
  }
  ok(maxErr <= TICK_US / 2 + 1e-6, `|label − native| ≤ 30 µs (half a tick) over ${n} random native times: max ${maxErr.toFixed(6)} µs`);
  // exact ties go up; one ulp either side goes to the nearer tick (t = 0.09375 s = 1562.5 ticks exactly)
  const tie = 0.09375;
  ok(ticksOf(tie) === 1562.5, 'the tie instant is exactly 1562.5 ticks');
  const lab = (t: number) => Math.round(labelOf(exactOf(nat(t)), 'tick').minute * TICKS_PER_MINUTE);
  ok(lab(tie) === 1563 && lab(ulpStep(tie, -1)) === 1562 && lab(ulpStep(tie, 1)) === 1563, `half-tick: exact tie → up (1563), one ulp below → 1562, one ulp above → 1563`);
  // #116 rounded the double product minute*1e6; the bound now holds for the REAL value (deliberate contract change)
  ok(Math.round(5e-7 * 1e6) === 1 && checkTime({ day: 0, minute: 5e-7 }).minute === 0 && (5e-7 * 1e6) === 0.5, '5e-7 min is 0.49999999999999998 ticks (binary): the naive product rounded it to 1, the exact rule to 0');
  // the exact instant keeps what the double conversion would lose: two native seconds 1 ulp apart at t = 1000 s
  const a = exactOf(nat(1000)), b = exactOf(nat(ulpStep(1000, 1)));
  ok(compareExact(a, b) < 0 && (600 + 1000 / 60) === (600 + ulpStep(1000, 1) / 60), 'two seconds values 1 ulp apart: equal after a naive minute conversion, distinct as exact instants');
  // exact instants are monotone in t, and equal iff the native values are equal (same clock)
  for (let i = 0; i < 2000; i++) { const t = g() * 1e5, u = ulpStep(t, 1 + Math.floor(g() * 3)); ok(compareExact(exactOf(nat(t)), exactOf(nat(u))) < 0, `exact order = native order (t=${t})`); }
  ok(compareExact(exactOf(nat(0.5, 'min')), exactOf(nat(30, 's'))) === 0, 'the same real instant on two clocks (0.5 min, 30 s) is one exact instant');
  ok(compareExact(exactOf(nat(0.025, 'min')), exactOf(nat(1.5, 's'))) > 0, 'decimal 0.025 min is not 1.5 s in binary: the exact instants differ (producers must give the same value for one instant)');
  refuses(() => exactOf(nat(-1)), /t must be finite and >= 0/, 'negative native time refused');
  refuses(() => exactOf(nat(1, 's', { day: 0, minute: 0.1234567 })), /anchor must lie on the tick grid/, 'an anchor off the tick grid is refused');
  refuses(() => exactOf({ ...nat(1), extra: 1 } as never), /exactly clock, unit, anchor, t/, 'extra native fields refused');
  refuses(() => new WorldScheduler(W).schedule({ ...spec('x', nat(1)), at: { day: 0, minute: 0 } }), /both at and native/, 'giving both at and native is refused');
}

// ---------------------------------------------------------------- 2a. ± half-tick boundaries
{
  const k = 1562;
  // A: 0.49 tick after k; B: 0.01 tick after k (29 µs apart, same tick); C, D one ulp either side of k + 0.5
  const tA = ((k + 0.49) * TICK_US) / 1e6, tB = ((k + 0.01) * TICK_US) / 1e6, tC = ulpStep(((k + 0.5) * TICK_US) / 1e6, -1), tD = ulpStep(((k + 0.5) * TICK_US) / 1e6, 1);
  for (const order of ['tick', 'layered'] as TimeOrder[]) {
    const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order });
    for (const [key, t] of [['a', tA], ['b', tB], ['c', tC], ['d', tD]] as const) s.schedule(spec(key, nat(t)));
    const bs = runAll(s).map((b) => b.map((e) => e.key).sort().join(''));
    if (order === 'tick') {
      ok(JSON.stringify(bs) === JSON.stringify(['abc', 'd']), `tick: b, a (29 µs apart) and c share a batch, while c and d (2 ulps ≈ 3e-17 s apart) are split: ${JSON.stringify(bs)}`);
      const rep = s.timeReport();
      ok(rep.merges.length === 1 && rep.merges[0].distinct_instants === 3 && Math.abs(rep.merges[0].span_us - 0.49 * TICK_US) < 1e-6, `tick: the merge is DETECTED and reported (3 distinct instants, span ${rep.merges[0]?.span_us.toFixed(3)} µs)`);
    } else ok(JSON.stringify(bs) === JSON.stringify(['b', 'a', 'c', 'd']), `layered: four batches in the exact order b < a < c < d: ${JSON.stringify(bs)}`);
  }
  // refuse policy: the batch is refused before the handler runs, state unchanged
  const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'tick', on_conflict: 'refuse' });
  s.schedule(spec('a', nat(tA))); s.schedule(spec('b', nat(tB)));
  const before = JSON.stringify(s.snapshot()); let ran = false;
  refuses(() => s.step(() => { ran = true; }), /would merge 2 distinct exact instants/, 'tick + refuse: a merging batch is refused');
  ok(!ran && JSON.stringify(s.snapshot()) === before && s.timeReport().merges.length === 0, 'refused: the handler did not run and the state is unchanged');
}

// ---------------------------------------------------------------- 2b. midnight
{
  // the last half tick of a day: an exact instant before 24:00 whose nearest tick is 24:00
  const anchor = { day: 0, minute: 1439.999999 }, t = 45e-6;   // 23:59:59.99994 + 45 µs = 15 µs before midnight
  refuses(() => new WorldScheduler(W).schedule(spec('late', nat(t, 's', anchor))), /rounds to 24:00/, 'tick: an instant in the last half tick before midnight is refused (#116 rule), never moved into the next day');
  const L = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
  L.schedule(spec('late', nat(t, 's', anchor))); L.schedule(spec('next', nat(0, 'min', { day: 1, minute: 0 })));
  const e = L.get('e:late')!;
  ok(e.at.day === 0 && e.at.minute === 1439.999999 && e.exact.day === 0 && Math.abs(quantisationErrorUs(e.at, e.exact) + 45) < 1e-6, 'layered: kept in day 0 on the last tick (error 45 µs < 1 tick), its day decided by the exact instant');
  ok(L.runDay(0, () => {}) === 1 && L.pending().length === 1 && L.runDay(1, () => {}) === 1, 'layered: runDay(0) runs it, the 00:00 event waits for runDay(1)');
  // a child crossing midnight in native seconds; day-by-day with snapshot / restore = continuous, nothing lost or doubled
  const cfgs = ph2Configs().find((g) => g.group.startsWith('traffic'))!.runs.slice(0, 3);
  for (const order of ['tick', 'layered'] as TimeOrder[]) for (const r of cfgs) {
    const ev = simulate(r.cfg).events, ids = physIds(ev), anchorM = { day: 0, minute: 1439.75 };   // 23:59:45: the run crosses midnight
    const mk = () => { const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order }); let refused = 0; ev.forEach((x, i) => { try { s.schedule(spec(ids[i], nativeOfPhys(`ph2.${r.name}`, anchorM, x.t_s), 'phys')); } catch (er) { if (/rounds to 24:00/.test(String(er))) refused++; else throw er; } }); return { s, refused }; };
    const h = (b: readonly Readonly<WorldEvent>[]) => ({ children: b.filter((x) => x.native.t < 50 && x.key.endsWith('.1')).map((x) => ({ cause: x.id, spec: spec('echo', addNative(x.native, 30), 'echo') })) });
    const cont = mk(); cont.s.runDay(0, h); cont.s.runDay(1, h);
    const split = mk(); split.s.runDay(0, h); const logs = [...split.s.log]; const r2 = WorldScheduler.restore(JSON.parse(JSON.stringify(split.s.snapshot()))); r2.runDay(1, h); logs.push(...r2.log);
    ok(JSON.stringify(logs) === JSON.stringify(cont.s.log) && JSON.stringify(r2.snapshot()) === JSON.stringify(cont.s.snapshot()), `${order} ${r.name} across midnight: day by day with snapshot/restore = continuous`);
    const a = cont.s.audit(), crossed = cont.s.log.filter((l) => l.exact.day === 1).length;
    ok(a.pending === 0 && a.executed + cont.refused === ev.length + cont.s.log.filter((l) => l.kind === 'echo').length && new Set(cont.s.log.map((l) => l.id)).size === cont.s.log.length && crossed > 0, `${order} ${r.name}: every event once (${a.executed} executed, ${crossed} after midnight, ${cont.refused} refused in the last half tick)`);
    ok(verifyLog(cont.s.log, [], { order }).ok, `${order} ${r.name}: verifyLog passes`);
  }
}

// ---------------------------------------------------------------- 2c. many events at one instant / in one tick
{
  for (const order of ['tick', 'layered'] as TimeOrder[]) {
    const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order });
    for (let i = 0; i < 1000; i++) s.schedule(spec(`s${String(i).padStart(4, '0')}`, nat(12.5)));
    let ctx: { distinct_instants: number } | null = null;
    const b = s.step((_, c) => { ctx = c; });
    ok(b.length === 1000 && ctx!.distinct_instants === 1 && s.timeReport().merges.length === 0, `${order}: 1000 events at ONE native instant form one batch; not a merge`);
  }
  const g = rng(5), ts = Array.from({ length: 1000 }, (_, i) => (60 * 1000 - 29 + i * 0.05 + g() * 0.01) / 1e6);   // 1000 distinct instants inside tick 1000 = [59970, 60030) µs
  const T = new WorldScheduler(W);
  ts.forEach((t, i) => T.schedule(spec(`m${String(i).padStart(4, '0')}`, nat(t))));
  let seen = 0; const bt = T.step((_, c) => { seen = c.distinct_instants; });
  ok(bt.length === 1000 && seen === 1000 && T.timeReport().merges[0].distinct_instants === 1000, 'tick: 1000 distinct instants in one tick → ONE batch, and the handler and the report both say 1000 distinct instants');
  const Ly = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
  [...ts.keys()].reverse().forEach((i) => Ly.schedule(spec(`m${String(i).padStart(4, '0')}`, nat(ts[i]))));
  const bl = runAll(Ly);
  ok(bl.length === 1000 && bl.every((b, i) => b.length === 1 && b[0].native.t === [...ts].sort((x, y) => x - y)[i]), 'layered: 1000 batches in exact order (scheduled in reverse)');
}

// ---------------------------------------------------------------- 2d. changed step size
{
  const q = (x: number) => (x * TICK_US) / 1e6;  // ticks → seconds
  // (i) delay grouping: #116 addMinutes rounds the delay separately → the child lands before an event that truly came first
  const s = new WorldScheduler(W);
  s.schedule(spec('cause', nat(q(0.4)))); s.schedule(spec('x', nat(q(0.7))));
  const order116: string[] = [];
  s.runUntil({ day: 1, minute: 0 }, (b) => { order116.push(...b.map((e) => e.key)); return { children: b.filter((e) => e.key === 'cause').map((e) => ({ cause: e.id, spec: { kind: 'e', key: 'child', at: addMinutes(e.at, (0.4 * TICK_US) / 6e7), scope: ref(), source: null, target: null } })) }; });
  ok(order116.join() === 'cause,child,x', `legacy addMinutes: child (true time 0.8 tick) runs before x (0.7 tick): ${order116} — the true time was never given, so nothing can detect it (why producers must use addNative)`);
  for (const order of ['tick', 'layered'] as TimeOrder[]) {
    const t = new WorldScheduler(W, { day: 0, minute: 0 }, { order }), seq: string[] = [];
    t.schedule(spec('cause', nat(q(0.4)))); t.schedule(spec('x', nat(q(0.7))));
    t.runUntil({ day: 1, minute: 0 }, (b) => { seq.push(b.map((e) => e.key).sort().join('+')); return { children: b.filter((e) => e.key === 'cause').map((e) => ({ cause: e.id, spec: spec('child', addNative(e.native, q(0.4))) })) }; });
    if (order === 'tick') ok(seq.join() === 'cause,child+x' && t.timeReport().merges.length === 1, `tick + addNative: child and x merged into one tick — reported (${seq})`);
    else ok(seq.join() === 'cause,x,child' && t.timeReport().merges.length === 0, `layered + addNative: true order cause < x < child (${seq})`);
  }
  // a child with an earlier exact instant than its cause but the same tick: accepted by 'tick' (#116 rule), and DETECTED
  const u = new WorldScheduler(W);
  u.schedule(spec('cause', nat(q(0.4))));
  u.runUntil({ day: 1, minute: 0 }, (b) => ({ children: b.filter((e) => e.key === 'cause').map((e) => ({ cause: e.id, spec: spec('early', nat(q(0.2))) })) }));
  const inv = u.timeReport().inversions;
  ok(inv.length === 1 && inv[0].earlier_than === 'e:cause' && Math.abs(inv[0].by_us - 0.2 * TICK_US) < 1e-6, `tick: a child truly 12 µs before its cause is executed after it — DETECTED as an inversion (${JSON.stringify(inv[0])})`);
  const v = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' }); v.schedule(spec('cause', nat(q(0.4))));
  refuses(() => v.step((b) => ({ children: [{ cause: b[0].id, spec: spec('early', nat(q(0.2))) }] })), /before its cause/, 'layered: a child before its cause is refused');
  // (ii) the physics broadphase window: batch structure under every contract does not depend on window_s
  let compared = 0, timesDiffer = 0, seqDiffer: string[] = [];
  const sig = (items: ReturnType<typeof itemsOf>, ev: ReturnType<typeof simulate>['events'], c: (typeof CANDIDATE_CONTRACTS)[number]) => { const m = evaluateContract(items, c); return `${m.batches}|${m.merged_pairs}|${m.id_order_flips}|${ev.map((e) => `${e.kind}.${e.agent}`).join()}`; };
  for (const { runs } of ph2Configs()) for (const r of runs) {
    const base = simulate(r.cfg).events, bi = itemsOf('w', base);
    for (const H of [0.05, 0.5, 7]) {
      const ev = simulate({ ...r.cfg, window_s: H }).events;
      if (ev.map((e) => `${e.kind}.${e.agent}.${e.other}`).join() !== base.map((e) => `${e.kind}.${e.agent}.${e.other}`).join()) { seqDiffer.push(`${r.name}@${H}`); continue; }
      compared++; if (ev.some((e, i) => e.t_s !== base[i].t_s)) timesDiffer++;
      const ei = itemsOf('w', ev);
      for (const c of CANDIDATE_CONTRACTS) ok(sig(ei, ev, c) === sig(bi, base, c), `${r.name} window ${H} s, ${c.name}: same batches`);
    }
  }
  console.error(`window_s: ${compared} comparable runs (${timesDiffer} with bit-different times, max ≈ 7e-13 s), batch structure identical under every contract; physics event sequence itself differs in: ${seqDiffer.join(', ') || 'none'}`);
  // the PH-2 window dependence recorded here before (traffic-7 @ window 0.5 s: 158 vs 194 events) was fixed by #98
  // (physics-event-fixes); from now on ANY physics event sequence that depends on window_s fails this test
  ok(seqDiffer.length === 0, `physics event sequence independent of window_s (was traffic-7@0.5 before #98): ${seqDiffer.join() || 'none'}`);
}

// ---------------------------------------------------------------- 2e. seed / id / input-order invariance (real PH-2)
{
  const r = ph2Configs().find((g) => g.group.startsWith('traffic'))!.runs[0];
  const ev = simulate(r.cfg).events, ids = physIds(ev);
  const shape = (order: TimeOrder, perm: number[], rename: (id: string) => string) => {
    const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order });
    for (const i of perm) s.schedule(spec(rename(ids[i]), nativeOfPhys('ph2', ANCHOR, ev[i].t_s), 'phys'));
    const batches = runAll(s);
    return { times: batches.map((b) => b.map((e) => e.native.t).sort((x, y) => x - y).join('/')).join(','), byId: batches.map((b) => b.map((e) => e.native.t).join('/')).join(','), merges: s.timeReport().merges.length };
  };
  const g = rng(77), idPerm = (seed: number) => { const h = rng(seed); const m = new Map(ids.map((id) => [id, `r${Math.floor(h() * 1e9).toString(36)}.${id.length}`])); return (id: string) => m.get(id)! + '.' + hash32(id).toString(36); };
  const base = { tick: shape('tick', [...ids.keys()], (x) => x), layered: shape('layered', [...ids.keys()], (x) => x) };
  let tickByIdChanged = 0;
  for (let k = 0; k < 20; k++) {
    const perm = [...ids.keys()]; for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(g() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    const ren = idPerm(1000 + k);
    for (const order of ['tick', 'layered'] as TimeOrder[]) {
      const x = shape(order, perm, ren);
      ok(x.times === base[order].times && x.merges === base[order].merges, `${order} perm ${k}: shuffled input order + renamed ids → the same batches (as sets of native instants)`);
      if (order === 'layered') ok(x.byId === base.layered.byId, `layered perm ${k}: even walking each batch by id gives the same sequence (a batch holds one instant)`);
      else if (x.byId !== base.tick.byId) tickByIdChanged++;
    }
  }
  console.error(`id renaming: tick by-id order changed in ${tickByIdChanged}/20 permutations (${base.tick.merges} merged batches)`);
  ok(base.tick.merges > 0 && tickByIdChanged === 20, `control: under 'tick' a consumer walking merged batches by id sees a different event order after renaming ids in ${tickByIdChanged}/20 permutations (${base.tick.merges} merged batches) — the order would depend on names, not on time`);
  // the scheduler draws nothing; a producer's draw for an event depends on its stream name, not on when it is processed
  const draw = (seed: number, id: string) => rng(hash32(`${seed}|${rngStreamName(W, id, 'encounter')}`))();
  const d1 = ids.map((id) => draw(3, id)), d2 = [...ids].reverse().map((id) => draw(3, id)).reverse();
  ok(JSON.stringify(d1) === JSON.stringify(d2) && d1.some((x, i) => x !== draw(4, ids[i])), 'named RNG streams: draws per event id are independent of processing order and change with the seed');
  ok(rngStreamName(W, 'a:x/b:y', 'encounter') === 'rng/W/a:x/b:y#encounter', 'stream name format rng/<world>/<event id>#<purpose>');
  refuses(() => rngStreamName(W, 'a b', 'encounter'), /plain ids/, 'stream names refuse ids with spaces');
}

// ---------------------------------------------------------------- 3. candidate contracts vs real PH-2 + synthetic; doc tables
{
  // cross-check two implementations: the scheduler's own detector vs the analysis kernel, on every PH-2 run
  let mergedBatches = 0, layeredBatches = 0, kernelMerged = 0, kernelDistinct = 0;
  for (const { runs } of ph2Configs()) for (const r of runs) {
    const ev = simulate(r.cfg).events, ids = physIds(ev), items = itemsOf(`ph2.${r.name}`, ev);
    const T = new WorldScheduler(W), Ly = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
    ev.forEach((x, i) => { for (const s of [T, Ly]) s.schedule(spec(ids[i], nativeOfPhys(`ph2.${r.name}`, ANCHOR, x.t_s), 'phys')); });
    runAll(T); const lb = runAll(Ly);
    mergedBatches += T.timeReport().merges.length; layeredBatches += lb.length;
    kernelMerged += evaluateContract(items, CANDIDATE_CONTRACTS[0]).merged_batches; kernelDistinct += evaluateContract(items, CANDIDATE_CONTRACTS[3]).batches;
    // layered order = the physics' own time order; each batch = one physics instant
    const flat = lb.flat();
    ok(flat.every((e, i) => i === 0 || e.native.t >= flat[i - 1].native.t) && lb.every((b) => b.every((e) => e.native.t === b[0].native.t)) && lb.length === new Set(ev.map((e) => e.t_s)).size, `${r.name}: layered batches = physics instants, in physics time order`);
    ok(Ly.timeReport().merges.length === 0 && Ly.timeReport().inversions.length === 0 && T.timeReport().inversions.length === 0, `${r.name}: no inversion (pure quantisation is monotone); no merge under layered`);
    ok(verifyLog(Ly.log, [], { order: 'layered' }).ok && verifyLog(T.log).ok, `${r.name}: both logs verify`);
  }
  ok(mergedBatches === kernelMerged && layeredBatches === kernelDistinct && mergedBatches > 0, `scheduler detector = analysis kernel: ${mergedBatches} merged 60 µs batches, ${layeredBatches} layered batches`);
  // tick size sweep is monotone in the merged pairs (finer never merges more) and reaches 0 only at 0.1 ns on these data
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/p0a0-time-contract.md'), 'utf8');
  for (const [name, tbl] of [['PH-2', ph2Table()], ['sweep', sweepTable()], ['synthetic', syntheticTable()]] as const) ok(doc.includes(tbl), `docs/p0a0-time-contract.md contains the recomputed ${name} table verbatim`);
  // synthetic pairs: the merge rate of a tick T at gap δ < T is about 1 − δ/T (random phase)
  const { syntheticPairs } = await import('../prototypes/p0a0-time-contract/measure.ts');
  for (const [gap, c, expect] of [[3e-5, CANDIDATE_CONTRACTS[0], 0.5], [1e-5, CANDIDATE_CONTRACTS[0], 1 - 1 / 6], [1e-7, CANDIDATE_CONTRACTS[1], 0.9]] as const) {
    const m = evaluateContract(syntheticPairs(gap).items, c);
    ok(Math.abs(m.merged_pairs / 1000 - expect) < 0.05, `${c.name}, δ = ${gap} s: merge rate ${m.merged_pairs / 1000} ≈ 1 − δ/T = ${expect.toFixed(3)}`);
  }
  for (const gap of [1e-4, 1e-6, 1e-9, 1e-12]) ok(evaluateContract(syntheticPairs(gap).items, CANDIDATE_CONTRACTS[3]).merged_pairs === 0, `layered: no merge at δ = ${gap} s`);
  refuses(() => nearestDiv(2 ** 53, 0, 1, 1), /exactly representable/, 'kernel refuses values beyond the exact range');
  assert.throws(() => tickContract('1 ps', 1e6, 1), /more ticks per day/); checks++;   // 8.64e16 ticks/day: an integer 1 ps world tick is not representable
}

// ---------------------------------------------------------------- 4. several colonies on one world time; simultaneous
{
  // colony A's physics clock (s, anchored 10:00) and colony B's (min, anchored 10:00:00.00006): one world order
  const A = (t: number) => nat(t, 's', { day: 0, minute: 600 }, 'ph2.colA'), B = (t: number) => nat(t, 'min', { day: 0, minute: 600.000001 }, 'ph2.colB');
  const evs: [string, string, NativeTime][] = [['A', 'a1', A(0.5)], ['B', 'b1', B(0.5 / 60 - 1e-6)], ['A', 'a2', A(30.00006)], ['B', 'b2', B(0.5)], ['A', 'a0', A(0.25)]];
  const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
  for (const [c, k, n] of [...evs].reverse()) s.schedule({ kind: 'e', key: k, native: n, scope: ref(`col${c}`), source: null, target: null });
  const bs = runAll(s).map((b) => b.map((e) => e.key).sort().join('+'));
  // expected: the events sorted by their exact world instant, equal instants grouped (computed independently here)
  const sorted = [...evs].sort((x, y) => compareExact(exactOf(x[2]), exactOf(y[2])));
  const expected: string[] = []; sorted.forEach((x, i) => { if (i > 0 && compareExact(exactOf(x[2]), exactOf(sorted[i - 1][2])) === 0) expected[expected.length - 1] = [...expected[expected.length - 1].split('+'), x[1]].sort().join('+'); else expected.push(x[1]); });
  const exA1 = exactOf(A(0.5)), exB1 = exactOf(B(0.5 / 60 - 1e-6));
  console.error(`colonies: batches ${JSON.stringify(bs)}; b1 − a1 = ${(exB1.us - exA1.us) + (exB1.us_lo - exA1.us_lo)} µs (decimal minutes are not exact in binary)`);
  ok(JSON.stringify(bs) === JSON.stringify(expected) && bs[0] === 'a0' && bs.length >= 4, `two colonies' clocks (s and min, different anchors) interleave by exact world time, independent of scheduling order: ${JSON.stringify(bs)}`);
  ok(s.timeReport().merges.length === 0, 'colonies: no merge');
  // a truly simultaneous instant across colonies (dyadic values): one batch, delivered as a set, no contest decided
  const t = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
  t.schedule({ kind: 'e', key: 'x', native: nat(30, 's', { day: 0, minute: 600 }, 'ph2.colA'), scope: ref('colA'), source: null, target: null });
  t.schedule({ kind: 'e', key: 'y', native: nat(0.5, 'min', { day: 0, minute: 600 }, 'ph2.colB'), scope: ref('colB'), source: null, target: null });
  let ctxN = 0; const b = t.step((_, c) => { ctxN = c.distinct_instants; });
  ok(b.length === 2 && ctxN === 1 && t.timeReport().merges.length === 0, 'colony A at 30 s and colony B at 0.5 min (same real instant): ONE batch, one instant, not a merge');
  const u = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
  u.schedule(spec('x', nat(1))); u.schedule(spec('y', nat(1)));
  refuses(() => u.step((bb) => ({ cancel: [{ id: bb[1].id, reason: 'won' }] })), /by its own batch/, 'simultaneous: a batch cannot decide its own contest (open rule, Owner decision)');
  refuses(() => u.schedule({ ...spec('z', nat(2)), priority: 1 } as never), /unknown field priority/, 'no priority field');
}

// ---------------------------------------------------------------- 5. snapshot / restore under the layered contract
{
  const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
  for (let i = 0; i < 30; i++) s.schedule(spec(`k${i}`, nat(i * 0.37e-6 + Math.floor(i / 3) * 1e-3)));
  s.runUntil({ day: 0, minute: 0.0001 }, (b) => ({ children: b.filter((e) => e.cause === null).slice(0, 1).map((e) => ({ cause: e.id, spec: spec('c', addNative(e.native, 1e-7)) })) }));
  const snap = s.snapshot(), r = WorldScheduler.restore(JSON.parse(JSON.stringify(snap)));
  ok(JSON.stringify(r.snapshot()) === JSON.stringify(snap) && r.order === 'layered', 'layered snapshot round-trips (order kept)');
  const rest = (x: WorldScheduler) => { const l: string[] = []; x.runUntil({ day: 1, minute: 0 }, (b) => { l.push(b.map((e) => e.id).join('+')); }); return l.join(); };
  const s2 = WorldScheduler.restore(JSON.parse(JSON.stringify(snap)));
  ok(rest(r) === rest(s2) && rest(WorldScheduler.restore(JSON.parse(JSON.stringify(snap)))).length > 0, 'restored schedulers continue identically');
  ok(verifyLog(r.log, snap.events, { order: 'layered' }).ok, 'post-restore layered log verifies with the snapshot events');
  const bad = (f: (x: typeof snap) => void, re: RegExp, why: string) => { const x = JSON.parse(JSON.stringify(snap)); f(x); refuses(() => WorldScheduler.restore(x), re, why); };
  bad((x) => { const e = x.events.find((v) => v.state === 'scheduled')!; e.native.t += 1e-9; }, /exact instant does not follow/, 'restore refuses a native time changed after the fact');
  bad((x) => { const e = x.events.find((v) => v.state === 'scheduled')!; e.exact.us_lo = 1e-12; }, /exact instant does not follow|not after|before its cause/, 'restore refuses a forged exact instant');
  bad((x) => { const e = x.events.find((v) => v.state === 'scheduled')!; e.at = { day: 0, minute: 0.5 }; }, /tick label does not follow/, 'restore refuses a tick label that does not follow from the native time');
  bad((x) => { x.time.order = 'fuzzy' as never; }, /time order/, 'restore refuses an unknown time order');
  bad((x) => { delete (x as unknown as Record<string, unknown>).time; }, /exactly schema, world, time/, 'restore refuses a snapshot without the time contract');
  bad((x) => { x.schema = 'antempire.world-scheduler.v1'; }, /schema/, 'a v1 snapshot (no native times) is refused, not guessed');
  // a tampered layered log is caught
  const tam = JSON.parse(JSON.stringify(s.log)); const i = tam.findIndex((l: { state: string }, k: number) => k > 0 && l.state === 'executed'); [tam[i - 1], tam[i]] = [tam[i], tam[i - 1]];
  refuses(() => verifyLog(tam, [], { order: 'layered' }), /out of order|before its cause|not after/, 'verifyLog (layered) refuses two swapped entries');
  refuses(() => new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'tick', extra: 1 } as never), /time options/, 'unknown time options refused');
}

// ---------------------------------------------------------------- 6. world inputs at an exact instant already processed
{
  const s = new WorldScheduler(W, { day: 0, minute: 0 }, { order: 'layered' });
  s.schedule(spec('a', nat(1))); s.step(() => {});
  refuses(() => s.schedule(spec('same', nat(1))), /already being processed/, 'layered: a world input at the exact instant just processed is refused');
  ok(s.schedule(spec('later', nat(ulpStep(1, 1)))) === 'e:later', 'layered: one ulp later is a new instant and accepted');
  ok(exactOfWorld({ day: 2, minute: 0 }).day === 2 && exactOfWorld({ day: 2, minute: 0 }).us === 0 && US_PER_DAY === 864e8, 'world 00:00 is exact instant 0 µs of its day');
}

console.log(JSON.stringify({ test: 'p0a0-time-contract', passed: true, checks }));

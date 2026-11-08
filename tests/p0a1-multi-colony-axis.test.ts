/**
 * Issue #9 option A on the P0-A1 clock (isolated, non-official): several colonies on ONE world event axis with the
 * environment clock, sharing resources (prototypes/p0a1-24h-clock/shared-resource.ts).
 *  1. events of all colonies interleave by exact time — no colony's day runs before another's;
 *  2. the outcome is invariant to the colonies[] order, the order events are scheduled in and to renaming every id;
 *  3. arrivals at one resource at the SAME exact instant (even from a seconds clock and a minute clock) reach the model as
 *     one batch and are recorded as an explicit contest_unresolved event — participants as a set, no winner;
 *  4. a near-simultaneous pair that a float conversion cannot make exactly equal stays two instants (refused by
 *     nativeOnClock, never rounded together); under 'tick' it is merged into one batch and REPORTED, and the model still
 *     does not call it a contest;
 *  5. both contracts ('layered' default, 'tick' compatibility); every event exactly once; snapshot/restore = continuous.
 * All arrival times are synthetic test fixtures; no behaviour, no contest rule, no consumption is modelled.
 */
import assert from 'node:assert/strict';
import { hash32, rng } from '../engine/rng.ts';
import { type ExactTime, type NativeTime, type TimeOrder, WorldScheduler, compareExact, exactOf, verifyLog } from '../engine/scheduler/world-events.ts';
import { DEFAULT_ORDER, nativeOnClock, requireNativeOnClock, type CalendarAnchor } from '../engine/clock/time-frames.ts';
import { type ClockWorldConfig, ClockRun, environmentSpecs } from '../engine/clock/environment.ts';
import type { DailyWeatherInput } from '../engine/clock/weather-input.ts';
import { type Arrival, SharedResourceObserver, arrivalSpec } from '../prototypes/p0a1-24h-clock/shared-resource.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const ANCHOR: CalendarAnchor = { day0_date: '2027-03-20', utc_offset_minutes: 480, zone: 'Asia/Taipei' };
const inputs: DailyWeatherInput[] = [0, 1, 2, 3].map((d) => {
  const date = `2027-03-${20 + d}`;
  return { date, t_min_c: 16, t_max_c: 25, t_mean_c: 20, rh_mean_percent: 75, rain_mm: 0, hourly: null, provenance: { kind: 'synthetic_climatology', synthetic: true, assumption: true, source: 'test fixture', station_id: null, source_url: null, issued_at: null, valid_from: null, valid_to: null, generator: 'fixture', rng_stream: null } };
});
const cfg = (order: TimeOrder): ClockWorldConfig => ({ world: 'p0a1multi', official: false, anchor: ANCHOR, site: { latitude_deg: 24.17, longitude_deg: 120.64 }, order, sample_step_min: 60, first_day: 1, last_day: 2, seed: 3, temperature_shape: null, rain_timing: null });

// three colonies, each with its own native clock (seconds or minutes, its own anchor)
interface Col { id: string; unit: 's' | 'min'; anchor: { day: number; minute: number }; workers: string[] }
const COLONIES: Col[] = [
  { id: 'A', unit: 's', anchor: { day: 1, minute: 360 }, workers: ['a1', 'a2', 'a3'] },
  { id: 'B', unit: 'min', anchor: { day: 1, minute: 0 }, workers: ['b1', 'b2'] },
  { id: 'C', unit: 's', anchor: { day: 1, minute: 330 }, workers: ['c1', 'c2', 'c3', 'c4'] },
];
const clockOf = (c: Col) => `colony.${c.id}.${c.unit}`;
const nat = (c: Col, t: number): NativeTime => ({ clock: clockOf(c), unit: c.unit, anchor: c.anchor, t });
/** arrivals: random times on each colony's own clock over ~30 h (crossing midnight), plus constructed ties */
function arrivals(): Arrival[] {
  const out: Arrival[] = [];
  for (const c of COLONIES) {
    const g = rng(hash32(`arrivals|${c.id}`));
    c.workers.forEach((w, wi) => { for (let k = 0; k < 25; k++) { const h = g() * 30; out.push({ colony: c.id, individual: w, resource: g() < 0.5 ? 'R1' : 'R2', seq: k, native: nat(c, c.unit === 's' ? h * 3600 : h * 60 + wi * 1e-3) }); } });
  }
  const [A, B, C] = COLONIES;
  // tie 1: A (06:00 + 30 s, seconds clock) and B (360.5 min, minute clock) — one exact instant
  out.push({ colony: 'A', individual: 'a1', resource: 'R1', seq: 100, native: nat(A, 30) });
  out.push({ colony: 'B', individual: 'b1', resource: 'R1', seq: 100, native: nat(B, 360.5) });
  // tie 2: three colonies at 14:07:15 (847.25 min, exact in binary) — C and B obtain THE SAME instant through nativeOnClock (single time source)
  const x: ExactTime = exactOf(nat(A, 8 * 3600 + 7 * 60 + 15));
  out.push({ colony: 'A', individual: 'a2', resource: 'R2', seq: 101, native: nat(A, 8 * 3600 + 7 * 60 + 15) });
  out.push({ colony: 'C', individual: 'c2', resource: 'R2', seq: 101, native: requireNativeOnClock(x, clockOf(C), 's', C.anchor) });
  out.push({ colony: 'B', individual: 'b2', resource: 'R2', seq: 101, native: requireNativeOnClock(x, clockOf(B), 'min', B.anchor) });
  // same instant, DIFFERENT resources: not a contest
  out.push({ colony: 'C', individual: 'c3', resource: 'R1', seq: 102, native: requireNativeOnClock(x, clockOf(C), 's', C.anchor) });
  // near pair: A at 06:00 + 40 s; B "meant" the same but 40/60 min has no exact binary value — naive conversion
  out.push({ colony: 'A', individual: 'a3', resource: 'R1', seq: 103, native: nat(A, 40) });
  out.push({ colony: 'B', individual: 'b2', resource: 'R1', seq: 103, native: nat(B, 360 + 40 / 60) });
  return out;
}
const ARR = arrivals();

/** run the environment clock + all colonies; colonies in `colOrder`, events scheduled in `perm` order, ids renamed by `ren` */
function run(order: TimeOrder, colOrder: string[], seedPerm: number, ren: (s: string) => string, cut?: { day: number; minute: number }) {
  const c = cfg(order), r = new ClockRun(c, inputs), obs = new SharedResourceObserver();
  r.foreign = obs.hook;
  const specs = [...environmentSpecs(c, r.series, r.plan)];
  for (const cid of colOrder) for (const a of ARR.filter((x) => x.colony === cid)) specs.push(arrivalSpec(c.world, { ...a, colony: ren(a.colony), individual: ren(a.individual), resource: ren(a.resource), native: { ...a.native, clock: ren(a.native.clock) } }));
  const g = rng(seedPerm); for (let i = specs.length - 1; i > 0 && seedPerm; i--) { const j = Math.floor(g() * (i + 1)); [specs[i], specs[j]] = [specs[j], specs[i]]; }
  r.scheduler = new WorldScheduler(c.world, { day: c.first_day, minute: 0 }, { order });
  for (const s of specs) r.scheduler.schedule(s);
  if (cut) {
    for (let d = c.first_day; d < cut.day; d++) r.closeDay(d);
    r.runUntil(cut);
    const snap = JSON.parse(JSON.stringify(r.snapshot())), r2 = new ClockRun(c, inputs, snap);
    const obs2 = new SharedResourceObserver(); obs2.visits = JSON.parse(JSON.stringify(obs.visits)); obs2.contests = JSON.parse(JSON.stringify(obs.contests));
    r2.foreign = obs2.hook;
    for (let d = cut.day; d <= c.last_day; d++) r2.closeDay(d);
    return { r: r2, obs: obs2, log: [...r.scheduler.log, ...r2.scheduler.log] };
  }
  for (let d = c.first_day; d <= c.last_day; d++) r.closeDay(d);
  return { r, obs, log: [...r.scheduler.log] };
}
/** order- and name-free summary: visits as (exact, resource, colony, individual) in exact order; contests as sets */
const xk = (x: ExactTime) => `${x.day}|${x.us}|${x.us_lo}`;
function canon(o: SharedResourceObserver, back: (s: string) => string) {
  const visits = o.visits.map((v) => `${xk(v.exact)} ${back(v.resource)} ${back(v.colony)}/${back(v.individual)} +${v.simultaneous_with}`).sort();
  const contests = o.contests.map((c) => `${xk(c.exact)} ${back(c.resource)} {${c.participants.map((p) => `${back(p.colony)}/${back(p.individual)}`).sort().join(',')}} ${c.resolution}`).sort();
  return JSON.stringify({ visits, contests });
}
const id = (s: string) => s;
const RENAME: Record<string, string> = { A: 'Zeta', B: 'Alpha', C: 'Mid', a1: 'z9', a2: 'z1', a3: 'q5', b1: 'k0', b2: 'aa', c1: 'y1', c2: 'b7', c3: 'm3', c4: 'x0', R1: 'Rz', R2: 'Ra' };
const BACK = Object.fromEntries(Object.entries(RENAME).map(([k, v]) => [v, k]));
const ren = (s: string) => s.replace(/^colony\.([ABC])\./, (_m, c) => `colony.${RENAME[c]}.`).replace(/^[A-Za-z0-9]+$/, (m) => RENAME[m] ?? m);
const back = (s: string) => BACK[s] ?? s;

ok(DEFAULT_ORDER === 'layered', 'layered is the default contract of the isolated clock');
const x40 = exactOf(nat(COLONIES[0], 40));
ok(nativeOnClock(x40, clockOf(COLONIES[1]), 'min', COLONIES[1].anchor) === null, '06:00:40 has no exact value on colony B\'s minute clock: the single-source contract refuses it');
ok(compareExact(exactOf(nat(COLONIES[1], 360 + 40 / 60)), x40) !== 0, 'the naive conversion 360 + 40/60 min is a DIFFERENT instant (a fake order a float conversion created)');

for (const order of ['layered', 'tick'] as TimeOrder[]) {
  const base = run(order, ['A', 'B', 'C'], 0, id);
  const audit = base.r.scheduler.audit();
  ok(audit.pending === 0 && audit.cancelled === 0 && audit.executed === audit.total, `${order}: every event (environment, arrivals, contests) executed exactly once (${audit.total})`);
  verifyLog(base.log, [], { order }); ok(true, `${order}: independent log check`);
  ok(base.obs.visits.length === ARR.length, `${order}: every arrival reached the resource model (${ARR.length})`);
  // 1. one axis: arrivals execute in exact-time order across colonies, interleaved, not colony by colony
  const arrLog = base.log.filter((l) => l.kind === 'resource_arrival');
  let sorted = true; for (let i = 1; i < arrLog.length; i++) if (compareExact(arrLog[i].exact, arrLog[i - 1].exact) < 0) sorted = false;
  const seq = arrLog.map((l) => l.id.split('.')[0].split(':')[1]); let switches = 0; for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
  ok(sorted && switches > 100, `${order}: colonies interleave on one exact-time axis (${switches} colony switches in ${seq.length} arrivals), no colony runs its day first`);
  const envAndArr = base.log.filter((l) => l.kind === 'resource_arrival' || l.kind.startsWith('light_'));
  ok(envAndArr.findIndex((l) => l.kind === 'light_sunset') > envAndArr.findIndex((l) => l.kind === 'resource_arrival') && envAndArr.findLastIndex((l) => l.kind === 'resource_arrival') > envAndArr.findIndex((l) => l.kind === 'light_sunset'), `${order}: colony events and environment events share the axis`);
  // 3. true ties → one batch → explicit unresolved contest, no winner
  const cs = base.obs.contests;
  ok(cs.length === 2, `${order}: exactly the two constructed ties are contests (got ${cs.length})`);
  const c2 = cs.find((c) => c.participants.length === 2)!, c3 = cs.find((c) => c.participants.length === 3)!;
  ok(c2 && c2.resource === 'R1' && c2.participants.map((p) => p.colony).sort().join() === 'A,B', `${order}: seconds-clock A and minute-clock B at one instant at R1 → one contest`);
  ok(c3 && c3.resource === 'R2' && c3.participants.map((p) => p.colony).sort().join() === 'A,B,C', `${order}: three colonies at one instant at R2 → one three-way contest`);
  ok(cs.every((c) => c.resolution === 'unresolved' && c.rule === null && !('winner' in c)), `${order}: contests carry no winner and no rule`);
  const cev = base.log.filter((l) => l.kind === 'contest_unresolved');
  ok(cev.length === 2 && cev.every((l) => base.r.scheduler.get(l.id)!.round === 1 && !('winner' in (base.r.scheduler.get(l.id)!.payload as object)) && (base.r.scheduler.get(l.id)!.payload as Record<string, unknown>).resolution === 'unresolved'), `${order}: the contest is an explicit event in the next round of the same instant, with no winner field`);
  const c3x = base.obs.visits.find((v) => v.individual === 'c3' && v.resource === 'R1' && compareExact(v.exact, c3.exact) === 0)!;
  ok(c3x && c3x.simultaneous_with === 0, `${order}: the same instant at a DIFFERENT resource is not part of the contest`);
  // 4. the near pair is never a contest; under tick it is merged and reported
  const near = base.obs.visits.filter((v) => (v.individual === 'a3' || v.individual === 'b2') && v.resource === 'R1' && Math.abs(v.exact.us - x40.us) < 1);
  ok(near.length === 2 && near.every((v) => v.simultaneous_with === 0), `${order}: the near-simultaneous pair is two instants, not a contest`);
  const tr = base.r.scheduler.timeReport();
  if (order === 'tick') ok(tr.merges.length >= 1 && base.obs.mergedBatches >= 1, `tick: the near pair shares one tick batch and the merge is reported (${tr.merges.length} merges)`);
  else ok(tr.merges.length === 0 && tr.inversions.length === 0 && base.obs.mergedBatches === 0, 'layered: no batch ever merges distinct instants');
  // 2. invariance: colonies[] order, scheduling order, id renaming
  const ref = canon(base.obs, id);
  for (const [k, perm] of [['C', 'A', 'B'], ['B', 'C', 'A'], ['C', 'B', 'A']].entries()) {
    const o = run(order, perm, 17 + k, id);
    ok(canon(o.obs, id) === ref, `${order}: colonies[] = ${perm.join('')} with shuffled scheduling (${k}) → identical visits and contests`);
  }
  const rn = run(order, ['B', 'A', 'C'], 99, ren);
  ok(canon(rn.obs, back) === ref, `${order}: renaming every colony, worker, resource and clock id → the same outcome (ids carry no priority)`);
  // 5. snapshot / restore mid-day = continuous
  for (const cut of [{ day: 1, minute: 360.5 }, { day: 2, minute: 0 }, { day: 1, minute: 847 }]) {
    const s = run(order, ['A', 'B', 'C'], 0, id, cut);
    ok(canon(s.obs, id) === ref && JSON.stringify(s.log.map((l) => [l.id, l.exact, l.round])) === JSON.stringify(base.log.map((l) => [l.id, l.exact, l.round])), `${order}: snapshot at d${cut.day}+${cut.minute}min and restore = continuous`);
  }
}
console.log(JSON.stringify({ test: 'p0a1-multi-colony-axis', checks, arrivals: ARR.length }));

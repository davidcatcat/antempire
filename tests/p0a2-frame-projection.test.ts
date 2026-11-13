/**
 * Issue #225 — the P0-A2 Worker frame / follow card must show each individual's own physiology AT the frame's t_sim.
 * Blocking. The core settles metabolism lazily (an individual's crop / gut / consumed / debt are booked only at its own
 * events or real contacts); before the fix the adapter's frame() and antView() read the last-settlement values while the
 * frame carried the current t_sim and the page labelled the fill 「自身生理，引擎」.
 *  1. reproduction of the issue numbers (seed 7, t = 86400 s): l01 0.927 (stale) -> 0.92056 (at t_sim); w002
 *     800000 -> 799503 µP; every larva and worker equals World.hunger()'s projection.
 *  2. the projection is the core's own rule: an individual later booked by the core without receiving or giving food
 *     shows exactly the gut / crop / consumed / debt the projection predicted for that instant (ground truth); chained
 *     projection is additive (exact integer carry).
 *  3. many arbitrary instants between events (two days): frame == hunger() for all individuals; follow card fields
 *     (crop, consumed, debt) projected; food conserved per individual (held + consumed unchanged by projection).
 *  4. empty pools: individuals already empty show 0 and a growing unmet need; a pool running dry between bookings
 *     (synthetic pool) shows 0 and the unmet part; larvae with no contact for hours are projected too.
 *  5. observation changes nothing: payload hash and the whole later event sequence are identical with and without
 *     frame() / antView() calls, including across snapshot -> restore; the official state is not settled.
 */
import assert from 'node:assert/strict';
import { P0a2ExperimentWorld, type P0a2Event } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import { drainPool, projectPool } from '../prototypes/p0a2-24h/world.ts';

let n = 0;
const ok = (c: boolean, msg: string) => { assert.ok(c, msg); n++; };
type Fr = { t_sim: number; workers: { id: string; crop_fill: number }[]; larvae: { id: string; gut_fill: number }[] };
type Card = { crop: number; consumed: number; debt: number; last: number; settled_s: number; physiology_at_s: number; kind: string };
const frameOf = (x: P0a2ExperimentWorld) => x.frame() as unknown as Fr;
const cardOf = (x: P0a2ExperimentWorld, id: string) => x.antView(id) as Card;

// ---------------------------------------------------------------- 1. the issue's reproduction
{
  const { world } = P0a2ExperimentWorld.create('exp-review', 7);
  world.advanceTo(86400);
  const before = world.snapshot().payload_sha256;
  const f = frameOf(world), v = world.world.view(), h = world.world.hunger(), m = world.world.m;
  const l01 = f.larvae.find((x) => x.id === 'l01')!;
  ok(f.t_sim === 86400 && v.larvae.l01.last === 85_844_783, 'issue setting: t_sim 86400 s, l01 last booked at 85844.783 s');
  ok(v.larvae.l01.gut / m.gut_cap === 0.927, 'the official (last-settlement) l01 gut fill is 0.927');
  ok(l01.gut_fill === 0.92056, `frame l01 gut_fill is the value at t_sim, 0.92056 (got ${l01.gut_fill}; 0.927 = stale settlement value, issue #225)`);
  for (const r of h.larvae) ok(f.larvae.find((x) => x.id === r.id)!.gut_fill === r.held / m.gut_cap, `frame ${r.id} gut_fill == hunger() projection at t_sim`);
  ok(h.larvae.every((r) => v.larvae[r.id].gut !== r.held), 'all 8 larvae differ between settlement and t_sim here (so the check above has teeth)');
  ok(v.workers.w002.crop === 800000 && f.workers.find((x) => x.id === 'w002')!.crop_fill === 799503 / m.crop_cap, 'w002: official crop 800000 µP, frame shows 799503 µP (projected)');
  for (const r of h.workers) ok(f.workers.find((x) => x.id === r.id)!.crop_fill === r.held / m.crop_cap, `frame ${r.id} crop_fill == hunger() projection at t_sim`);
  const c = cardOf(world, 'w002'), hw = h.workers.find((x) => x.id === 'w002')!;
  ok(c.crop === 799503 && c.debt === hw.unmet && c.consumed === v.workers.w002.consumed + 497 && c.last === 86_400_000, 'follow card w002: crop, consumed and debt projected to t_sim');
  ok(c.physiology_at_s === 86400 && c.settled_s === v.workers.w002.last / 1000 && c.kind === 'p0a2_worker', 'follow card states the projection instant and the official settlement instant');
  ok(world.snapshot().payload_sha256 === before, 'frame() / antView() leave the snapshot payload hash unchanged');
  ok(JSON.stringify(world.world.view()) === JSON.stringify(v), 'and the official state is not settled by observation (last / gut / crop unchanged)');
}

// ---------------------------------------------------------------- 2. ground truth: the core's own later booking
{
  const { world } = P0a2ExperimentWorld.create('exp-gt', 7);
  let checkedL = 0, checkedW = 0;
  for (let t = 3000; t <= 2 * 86400; t += 3000) {
    world.advanceTo(t);
    const A = world.world.view(), m = world.world.m;
    world.advanceTo(t + 1500);
    const B = world.world.view();
    for (const id of Object.keys(B.larvae)) {
      const a = A.larvae[id], b = B.larvae[id];
      if (b.last > a.last && b.received === a.received) {
        const p = projectPool(a, a.gut, m.larva_rate, b.last);
        assert.ok(p.held === b.gut && p.copy.consumed === b.consumed && a.deficit + p.short === b.deficit && p.copy.carry === b.carry, `${id} @${b.last}: projection == core booking`);
        checkedL++;
      }
    }
    for (const id of Object.keys(B.workers)) {
      const a = A.workers[id], b = B.workers[id];
      if (b.last > a.last && a.crop + a.consumed === b.crop + b.consumed && b.crop <= a.crop) {
        // no food entered or left except by its own metabolism up to its booking instant b.last
        const p = projectPool(a, a.crop, m.worker_rate, b.last);
        if (p.held === b.crop) { assert.ok(p.copy.consumed === b.consumed && a.debt + p.short === b.debt && p.copy.carry === b.carry, `${id} @${b.last}: projection == core booking`); checkedW++; }
      }
    }
  }
  ok(checkedL > 50, `projection equals what the core later books for larvae not fed in between (${checkedL} cases)`);
  ok(checkedW > 50, `and for workers with no transfer in between (${checkedW} cases)`);
  const x = world.world.view().workers.w001, r = world.world.m.worker_rate;
  const one = projectPool(x, x.crop, r, x.last + 7_777_777), mid = projectPool(x, x.crop, r, x.last + 1_234_567);
  const two = projectPool(mid.copy, mid.held, r, x.last + 7_777_777);
  ok(one.held === two.held && one.copy.consumed === two.copy.consumed && one.copy.carry === two.copy.carry && one.short === mid.short + two.short, 'projection is additive over a split interval (exact integer carry)');
}

// ---------------------------------------------------------------- 3. arbitrary instants between events
{
  const { world } = P0a2ExperimentWorld.create('exp-many', 7);
  let s = 12345, t = 0, inBetween = 0, frames = 0;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  while (t < 2 * 86400) {
    t = Math.round((t + 1 + rnd() * 5400) * 1000) / 1000; world.advanceTo(t);
    const f = frameOf(world), h = world.world.hunger(), v = world.world.view(), m = world.world.m, T = world.world.t_now;
    assert.ok(f.t_sim === T / 1000, 'frame t_sim is the world time');
    for (const r of h.larvae) { const l = v.larvae[r.id]; if (l.last < T) inBetween++; assert.ok(f.larvae.find((x) => x.id === r.id)!.gut_fill === r.held / m.gut_cap, `t=${t} ${r.id}`); }
    for (const r of h.workers) {
      const w = v.workers[r.id]; if (w.last < T) inBetween++;
      assert.ok(f.workers.find((x) => x.id === r.id)!.crop_fill === r.held / m.crop_cap, `t=${t} ${r.id}`);
      const c = cardOf(world, r.id);
      assert.ok(c.crop === r.held && c.debt === r.unmet && c.crop + c.consumed === w.crop + w.consumed && c.last === T && c.settled_s === w.last / 1000, `t=${t} ${r.id} card`);
    }
    frames++;
  }
  ok(frames > 50 && inBetween > 1000, `frame == hunger() and follow card projected at ${frames} arbitrary instants (${inBetween} individual-instants strictly between its bookings)`);
}

// ---------------------------------------------------------------- 4. empty pools, larvae without contacts
{
  const { world } = P0a2ExperimentWorld.create('exp-empty', 7);
  world.advanceTo(86400 + 3 * 3600 + 17.25);
  const v = world.world.view(), f = frameOf(world), T = world.world.t_now;
  const dry = Object.keys(v.workers).filter((id) => v.workers[id].crop === 0 && v.workers[id].last < T);
  ok(dry.length > 0, `some workers have an empty crop between bookings here (${dry.length})`);
  for (const id of dry) {
    const c = cardOf(world, id);
    assert.ok(f.workers.find((x) => x.id === id)!.crop_fill === 0 && c.crop === 0 && c.consumed === v.workers[id].consumed && c.debt > v.workers[id].debt, `${id}: empty crop shows 0 and the unmet need grows to t_sim`);
  }
  const idle = Object.keys(v.larvae).sort((a, b) => v.larvae[a].last - v.larvae[b].last)[0];
  ok(T - v.larvae[idle].last > 0 && f.larvae.find((x) => x.id === idle)!.gut_fill < v.larvae[idle].gut / world.world.m.gut_cap, `larva ${idle} (no contact for ${(T - v.larvae[idle].last) / 1000} s) is projected, not shown at its last contact`);
  // a pool running dry between bookings (synthetic pool: the seeds' larvae are fed before running dry)
  const pool = { last: 1000, carry: 0, consumed: 0, empty_since: null, empty_ms: 0, max_empty_ms: 0 };
  const p = projectPool(pool, 500, 86_400_000, 10_000);
  const ref = { ...pool }, d = drainPool(ref, 500, 86_400_000, 10_000);
  ok(p.held === 0 && p.take === 500 && p.short === 8500 && p.short === d.short && p.copy.empty_ms === ref.empty_ms && p.copy.empty_ms === 8500 && pool.last === 1000 && pool.consumed === 0, 'a pool running dry inside the interval: held 0, unmet part and empty time as drainPool books them; the input pool is untouched');
}

// ---------------------------------------------------------------- 5. observation changes nothing (incl. save / restore)
{
  const ser = (e: P0a2Event[]) => JSON.stringify(e);
  const cuts = [600.5, 7200, 30000.123, 43200, 86400, 100000, 129600];
  const run = (observe: boolean, restoreAt: number | null) => {
    let { world } = P0a2ExperimentWorld.create('exp-obs', 11);
    const evs: P0a2Event[] = [], hashes: string[] = [];
    for (const c of cuts) {
      if (observe) { world.frame(); for (const id of world.antIds()) world.antView(id); world.frame(); }
      evs.push(...world.advanceTo(c).events);
      if (observe) { world.frame(); world.antView('w001'); }
      hashes.push(world.snapshot().payload_sha256);
      if (restoreAt === c) {
        const snap = structuredClone(world.snapshot());
        world = P0a2ExperimentWorld.restore(snap);
        if (observe) { world.frame(); for (const id of world.antIds()) world.antView(id); }
        assert.ok(world.snapshot().payload_sha256 === snap.payload_sha256, 'restore + observation keeps the payload hash');
      }
    }
    return { evs: ser(evs), hashes, log: world.world.logHash };
  };
  const plain = run(false, null), watched = run(true, null), watchedRestored = run(true, 43200), plainRestored = run(false, 43200);
  ok(plain.evs === watched.evs && plain.log === watched.log, 'frame()/antView() at every cut: identical event sequence and log hash');
  ok(JSON.stringify(plain.hashes) === JSON.stringify(watched.hashes), 'and identical snapshot payload hashes at every cut');
  ok(watchedRestored.evs === plain.evs && JSON.stringify(watchedRestored.hashes) === JSON.stringify(plain.hashes) && plainRestored.evs === plain.evs, 'observation before and after snapshot -> restore changes no later event or hash');
  const { world } = P0a2ExperimentWorld.create('exp-obs2', 11);
  world.advanceTo(50000);
  ok(JSON.stringify(world.frame()) === JSON.stringify(world.frame()) && JSON.stringify(cardOf(world, 'w003')) === JSON.stringify(cardOf(world, 'w003')), 'repeated observation at one instant returns the same copy (no hidden settlement)');
}

console.log(`p0a2-frame-projection: ${n} checks passed (issue #225)`);

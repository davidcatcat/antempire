/**
 * P0-A0 shared world event scheduler (engine/scheduler/world-events.ts; docs/p0a0-world-event-scheduler.md).
 * Engineering checks only: the producer below is a TEST HARNESS that schedules synthetic events with seeded draws; it
 * is not a behaviour model and none of its delays or kinds is a biological claim.
 *  1. same input + same seed -> byte-identical log and snapshot (and a different seed changes it: the check is live);
 *  2. permuting colonies[], workers[], root-scheduling order and the handler's output order changes nothing; a FIFO
 *     control (insertion-order tie-break, as in engine/activity.ts) DOES change, so the test can detect the dependency;
 *  3. causality: verifyLog on every run; children at the same instant run in a later round; scheduling before a cause
 *     or the clock, and cancelling an event of the running batch, are refused; tampered logs are refused;
 *  4. cross-day: events cross midnight; day-by-day runs with snapshot/restore between days equal one continuous run;
 *     pending events are not reset at 24:00; days must run in order;
 *  5. exactly once: every id ends executed or cancelled or pending, once; an invalid batch output changes nothing;
 *  6. illegal times, ids, kinds, references, payloads, transitions and snapshots are refused;
 *  8. (Codex R9-01 / R10) no re-entry while the handler OUTPUT or any caller object is read (getters, proxies, toString).
 *  7. (Claude subagent review, not Codex) handlers cannot re-enter the scheduler; readers get frozen copies; time is on
 *     an integer tick grid (0.1 + 0.2 = 0.3 is one instant); a world input cannot join an instant already processed;
 *     24:00 belongs to the next day; restore refuses each inconsistency found by mutation; verifyLog checks a post-restore
 *     log on its own given the snapshot; a runaway run stops in a consistent state.
 */
import assert from 'node:assert/strict';
import { WorldScheduler, SchedulerError, verifyLog, addMinutes, compareTime, checkTime, MINUTES_PER_DAY, TICKS_PER_MINUTE, type EventSpec, type WorldEvent, type StepOutput, type EntityRef } from '../engine/scheduler/world-events.ts';
import { rng, hash32 } from '../engine/rng.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refuses = (f: () => unknown, re: RegExp, why: string) => { assert.throws(f, (e: unknown) => e instanceof SchedulerError && re.test(String(e)), why); checks++; };
const W = 'w1';
const ref = (colony: string | null, individual: string | null): EntityRef => ({ world: W, colony, individual });
const shuffle = <T>(xs: T[], seed: number): T[] => { const g = rng(seed), a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(g() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ------------------------------------------------------------------ test harness producer (synthetic, seeded)
interface Colony { id: string; workers: string[] }
const world = (nCol: number, nW: number): Colony[] => Array.from({ length: nCol }, (_, c) => ({ id: `C${c}`, workers: Array.from({ length: nW }, (_, w) => `C${c}-W${String(w).padStart(2, '0')}`) }));
/** a draw stream keyed by seed and event id only: independent of processing and array order (as engine/rng dice) */
const drawFor = (seed: number, id: string, purpose: string) => rng(hash32(`${seed}|${id}|${purpose}`));

function harness(seed: number, colonies: Colony[], days: number, opts: { permuteOutput?: number; split?: boolean } = {}) {
  let s = new WorldScheduler(W, { day: 0, minute: 0 });
  // roots: one 'wake' per worker, in WHATEVER order the arrays give
  for (const c of colonies) for (const w of c.workers) { const g = drawFor(seed, w, 'start'); s.schedule({ kind: 'wake', key: w, at: { day: 0, minute: Math.floor(g() * 6) * 30 }, scope: ref(c.id, w), source: null, target: null, payload: { n: 0 } }); }
  const all = colonies.flatMap((c) => c.workers.map((w) => ({ c: c.id, w }))).sort((a, b) => (a.w < b.w ? -1 : 1));
  let outCount = 0;
  const handler = (batch: readonly Readonly<WorldEvent>[]): StepOutput => {
    const out: StepOutput = { children: [], cancel: [] };
    for (const e of batch) {
      const g = drawFor(seed, e.id, 'h');
      if (e.kind === 'wake') {
        const n = (e.payload as { n: number }).n, who = e.scope.individual as string;
        // next wake: a delay on a coarse grid so that many events coincide (same instant, different individuals)
        const next = addMinutes(e.at, (1 + Math.floor(g() * 8)) * 45);
        out.children!.push({ cause: e.id, spec: { kind: 'wake', key: `n${n + 1}`, at: next, scope: e.scope, source: null, target: null, payload: { n: n + 1 } } });
        // a same-instant contact notice to another individual (runs in the next round of this instant)
        if (g() < 0.4) { const o = all[Math.floor(g() * all.length)]; out.children!.push({ cause: e.id, spec: { kind: 'contact_notice', key: o.w, at: e.at, scope: e.scope, source: e.scope, target: ref(o.c, o.w), payload: null } }); }
        // a timer that a later event may cancel
        if (g() < 0.5) out.children!.push({ cause: e.id, spec: { kind: 'timer', key: 't', at: addMinutes(e.at, 600 + g() * 900), scope: e.scope, source: null, target: null, payload: { who } } });
      } else if (e.kind === 'contact_notice') {
        // cancel the target's oldest pending timer, if any (an engineering use of cancel, not a behaviour)
        const tgt = (e.target as EntityRef).individual;
        const t = s.pending().find((p) => p.kind === 'timer' && (p.payload as { who: string }).who === tgt && !out.cancel!.some((c) => c.id === p.id));
        if (t && g() < 0.5) out.cancel!.push({ id: t.id, reason: `test: cancelled by ${e.id}` });
      }
    }
    if (opts.permuteOutput !== undefined) { out.children = shuffle(out.children!, opts.permuteOutput + outCount); out.cancel = shuffle(out.cancel!, opts.permuteOutput + outCount + 7); outCount++; }
    return out;
  };
  const logs: unknown[] = [];
  for (let d = 0; d < days; d++) {
    s.runDay(d, handler);
    // a restored scheduler starts a new in-memory log (its log_seq continues): keep each segment's log
    if (opts.split) { logs.push(...s.log); s = WorldScheduler.restore(JSON.parse(JSON.stringify(s.snapshot()))); }
  }
  if (!opts.split) logs.push(...s.log);
  return { s, log: JSON.stringify(logs), snap: JSON.stringify(s.snapshot()) };
}

// 1. determinism
const base = harness(42, world(3, 12), 3);
ok(base.log === harness(42, world(3, 12), 3).log && base.snap === harness(42, world(3, 12), 3).snap, 'same input and seed: identical log and snapshot');
ok(base.log !== harness(43, world(3, 12), 3).log, 'a different seed gives a different log (the comparison is live)');
const a0 = base.s.audit();
ok(a0.executed > 500 && a0.cancelled > 10 && a0.pending > 0, `harness exercises the scheduler: ${a0.executed} executed, ${a0.cancelled} cancelled, ${a0.pending} pending after 3 days`);
const batchSizes = new Map<string, number>(); for (const l of base.s.log) if (l.state === 'executed') { const k = `${l.at.day}|${l.at.minute}|${l.round}`; batchSizes.set(k, (batchSizes.get(k) ?? 0) + 1); }
ok([...batchSizes.values()].some((n) => n >= 5), `simultaneous events occur (largest batch ${Math.max(...batchSizes.values())} events at one instant and round)`);
ok(base.s.log.some((l) => l.state === 'executed' && l.round > 0), 'same-instant children run in a later round');

// 2. permutation invariance
for (let k = 0; k < 20; k++) {
  const perm = shuffle(world(3, 12), 1000 + k).map((c, i) => ({ ...c, workers: shuffle(c.workers, 2000 + k * 10 + i) }));
  const r = harness(42, perm, 3, { permuteOutput: 3000 + k });
  assert.equal(r.log, base.log, `permutation ${k}: log identical`); assert.equal(r.snap, base.snap, `permutation ${k}: snapshot identical`);
}
ok(true, '20 permutations of colonies[], workers[], root order and handler output order: log and snapshot byte-identical'); checks += 40;
{
  // FIFO control: a queue that breaks ties by insertion order (engine/activity.ts style) depends on array order
  const fifo = (cols: Colony[]) => { const q: { t: number; id: string; ins: number }[] = []; let ins = 0; for (const c of cols) for (const w of c.workers) q.push({ t: 0, id: w, ins: ins++ }); return q.sort((x, y) => x.t - y.t || x.ins - y.ins).map((e) => e.id).join(); };
  const sched = (cols: Colony[]) => { const s = new WorldScheduler(W); for (const c of cols) for (const w of c.workers) s.schedule({ kind: 'wake', key: w, at: { day: 0, minute: 0 }, scope: ref(c.id, w), source: null, target: null }); const ids: string[] = []; s.step((b) => { for (const e of b) ids.push(e.key); }); return ids.join(); };
  const A = world(2, 3), Bp = [...A].reverse();
  ok(fifo(A) !== fifo(Bp), 'control: an insertion-order (FIFO) tie-break changes with colonies[] order');
  ok(sched(A) === sched(Bp), 'the scheduler: the same batch content and order for either colonies[] order');
}

// 3. causality
verifyLog(base.s.log); checks++;
{
  const s = new WorldScheduler(W);
  s.schedule({ kind: 'a', key: 'x', at: { day: 0, minute: 10 }, scope: ref(null, null), source: null, target: null });
  refuses(() => s.step((b) => ({ children: [{ cause: b[0].id, spec: { kind: 'b', key: 'y', at: { day: 0, minute: 9.999 }, scope: ref(null, null), source: null, target: null } }] })), /before its cause/, 'a child before its cause is refused');
  ok(s.pending().length === 1 && s.log.length === 0, 'refused batch: nothing executed, the event is still pending');
  s.step((b) => ({ children: [{ cause: b[0].id, spec: { kind: 'b', key: 'y', at: { day: 0, minute: 10 }, scope: ref(null, null), source: null, target: null } }] }));
  ok(s.pending()[0].round === 1 && s.clock.round === 0, 'a child at its cause\'s instant is queued in the next round');
  refuses(() => s.schedule({ kind: 'c', key: 'z', at: { day: 0, minute: 5 }, scope: ref(null, null), source: null, target: null }), /not after the clock/, 'a root before the clock is refused');
  refuses(() => s.step((b) => ({ children: [{ cause: 'a:x', spec: { kind: 'b', key: 'q', at: { day: 0, minute: 11 }, scope: ref(null, null), source: null, target: null } }] })), /cause in the current batch/, 'a child naming a cause outside the batch is refused');
  const two = new WorldScheduler(W);
  for (const k of ['p', 'q']) two.schedule({ kind: 'a', key: k, at: { day: 0, minute: 1 }, scope: ref(null, null), source: null, target: null });
  refuses(() => two.step(() => ({ cancel: [{ id: 'a:q', reason: 'x' }] })), /own batch/, 'cancelling an event of the running batch (a same-instant contest) is refused');
  const tam = [...base.s.log]; const i = tam.findIndex((l, j) => j > 0 && l.state === 'executed' && compareTime(l.at, tam[j - 1].at) > 0); [tam[i - 1], tam[i]] = [tam[i], tam[i - 1]];
  refuses(() => verifyLog(tam), /out of order|before its cause|not after/, 'verifyLog refuses a log with two events swapped');
  const child = base.s.log.findIndex((l) => l.cause !== null && l.state === 'executed'); const noCause = base.s.log.filter((l) => l.id !== base.s.log[child].cause);
  refuses(() => verifyLog(noCause), /before its cause/, 'verifyLog refuses a log in which a child runs without its cause');
}

// 4. cross-day
{
  ok(JSON.stringify(addMinutes({ day: 0, minute: 1439.5 }, 1)) === JSON.stringify({ day: 1, minute: 0.5 }) && JSON.stringify(addMinutes({ day: 2, minute: 100 }, 3 * MINUTES_PER_DAY + 5)) === JSON.stringify({ day: 5, minute: 105 }), 'addMinutes carries across midnight (and several days)');
  const split = harness(42, world(3, 12), 3, { split: true });
  ok(split.log === base.log && split.snap === base.snap, 'running day by day with snapshot/restore between days equals one continuous run');
  const s = new WorldScheduler(W);
  s.schedule({ kind: 'late', key: 'x', at: { day: 0, minute: 1439.75 }, scope: ref('C0', 'C0-W00'), source: null, target: null, payload: { v: 1 } });
  s.runDay(0, (b) => ({ children: [{ cause: b[0].id, spec: { kind: 'after', key: 'y', at: addMinutes(b[0].at, 30), scope: b[0].scope, source: null, target: null, payload: { carried: true } } }] }));
  const p = s.pending();
  ok(p.length === 1 && p[0].at.day === 1 && p[0].at.minute === 29.75 && (p[0].payload as { carried: boolean }).carried === true, 'an event crossing midnight stays pending with its payload after day 0 (no reset at 24:00)');
  const r = WorldScheduler.restore(s.snapshot()); let seen = 0; r.runDay(1, () => { seen++; });
  ok(seen === 1 && r.audit().executed === 2 && r.audit().finished_before_restore === 1 && r.audit().logged === 1, 'after restore, day 1 executes the carried event exactly once; the audit counts the event finished before the snapshot');
  const s2 = new WorldScheduler(W); s2.schedule({ kind: 'a', key: 'x', at: { day: 0, minute: 3 }, scope: ref(null, null), source: null, target: null });
  refuses(() => s2.runDay(1, () => {}), /still pending/, 'running day 1 while day-0 events are pending is refused');
}

// 5. exactly once, atomic batches
const split3 = harness(42, world(3, 12), 3, { split: true });
{
  const a = base.s.audit();
  ok(a.total === a.executed + a.cancelled + a.pending && a.logged + a.finished_before_restore === a.executed + a.cancelled && split3.s.audit().logged + split3.s.audit().finished_before_restore === a.executed + a.cancelled, `every event once: total ${a.total} = executed ${a.executed} + cancelled ${a.cancelled} + pending ${a.pending}`);
  const ids = base.s.log.map((l) => l.id); ok(new Set(ids).size === ids.length, 'no id executed or cancelled twice');
  ok(base.s.log.filter((l) => l.state === 'cancelled').every((l) => base.s.get(l.id)!.state === 'cancelled' && !base.s.log.some((m) => m.id === l.id && m.state === 'executed')), 'cancelled events never execute');
  const s = new WorldScheduler(W);
  s.schedule({ kind: 'a', key: 'x', at: { day: 0, minute: 1 }, scope: ref(null, null), source: null, target: null });
  s.schedule({ kind: 'a', key: 'y', at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null });
  const before = JSON.stringify(s.snapshot());
  refuses(() => s.step((b) => ({ children: [{ cause: b[0].id, spec: { kind: 'b', key: 'ok', at: { day: 0, minute: 5 }, scope: ref(null, null), source: null, target: null } }, { cause: b[0].id, spec: { kind: 'b', key: 'ok', at: { day: 0, minute: 6 }, scope: ref(null, null), source: null, target: null } }] })), /duplicate event id/, 'two children with the same id are refused');
  ok(JSON.stringify(s.snapshot()) === before, 'refused batch output: scheduler state unchanged (atomic)');
  assert.throws(() => s.step(() => { throw new Error('handler failed'); }), /handler failed/); checks++;
  ok(JSON.stringify(s.snapshot()) === before, 'a throwing handler: state unchanged, the batch is still pending');
  s.step(() => ({ cancel: [{ id: 'a:y', reason: 'test' }] }));
  refuses(() => s.cancel('a:y', 'again'), /state cancelled/, 'cancel of a cancelled event is refused');
  refuses(() => s.cancel('a:x', 'late'), /state executed/, 'cancel of an executed event is refused');
  refuses(() => s.cancel('nope:z', 'x'), /unknown event/, 'cancel of an unknown event is refused');
  refuses(() => s.schedule({ kind: 'a', key: 'x', at: { day: 0, minute: 9 }, scope: ref(null, null), source: null, target: null }), /duplicate event id/, 'reusing an executed id is refused');
  ok(s.step(() => {}).length === 0 && s.audit().pending === 0, 'nothing left: step returns an empty batch');
}

// 6. illegal inputs
{
  const s = new WorldScheduler(W);
  const spec = (over: Partial<EventSpec> & Record<string, unknown>): EventSpec => ({ kind: 'a', key: 'k', at: { day: 0, minute: 1 }, scope: ref(null, null), source: null, target: null, ...over }) as EventSpec;
  for (const at of [{ day: -1, minute: 0 }, { day: 0.5, minute: 0 }, { day: 0, minute: 1440 }, { day: 0, minute: -0.1 }, { day: 0, minute: NaN }, { day: 0, minute: Infinity }, { day: Number.MAX_SAFE_INTEGER + 2, minute: 0 }, null])
    refuses(() => s.schedule(spec({ at: at as never })), /day must be|minute must be|not a world time/, `illegal time ${JSON.stringify(at)} refused`);
  refuses(() => checkTime({ day: 0, minute: '5' as never }), /minute must be/, 'a string minute is refused');
  for (const kind of ['', 'Wake', '1a', 'a b', 'a'.repeat(65)]) refuses(() => s.schedule(spec({ kind })), /kind/, `illegal kind "${kind.slice(0, 10)}" refused`);
  for (const key of ['', 'a/b', 'a b', 'x'.repeat(129)]) refuses(() => s.schedule(spec({ key })), /key/, `illegal key "${key.slice(0, 10)}" refused`);
  refuses(() => s.schedule(spec({ scope: { world: 'other', colony: null, individual: null } })), /not this world/, 'a reference to another world is refused');
  refuses(() => s.schedule(spec({ scope: { world: W, colony: null, individual: 'x' } })), /must belong to a colony/, 'an individual without a colony is refused');
  refuses(() => s.schedule(spec({ source: { world: W, colony: 'c', individual: null, extra: 1 } as never })), /exactly world, colony, individual/, 'a reference with extra fields is refused');
  refuses(() => s.schedule(spec({ scope: null as never })), /scope is required/, 'a missing scope is refused');
  for (const payload of [{ x: NaN }, { f: (() => 1) as never }, { d: new Date(0) as never }, [Infinity]]) refuses(() => s.schedule(spec({ payload: payload as never })), /payload/, `a non-JSON payload is refused (${Object.keys(payload)})`);
  refuses(() => s.schedule(spec({ priority: 1 })), /unknown field priority/, 'an unknown spec field (e.g. a priority) is refused: the scheduler takes no ordering hints');
  refuses(() => new WorldScheduler('bad world'), /world id/, 'an illegal world id is refused');
  refuses(() => addMinutes({ day: 0, minute: 0 }, -1), /delay/, 'a negative delay is refused');
  refuses(() => s.runDay(-1, () => {}), /runDay/, 'runDay of a negative day is refused');
  const id = s.schedule(spec({ payload: { b: 2, a: [1, { d: 4, c: 3 }] } }));
  const pl = s.get(id)!.payload as Record<string, unknown>; ok(JSON.stringify(pl) === '{"a":[1,{"c":3,"d":4}],"b":2}' && Object.isFrozen(pl), 'payload is copied, key-sorted and frozen (no aliasing with the producer)');
  // snapshots
  const snap = base.s.snapshot();
  const bad = (f: (x: typeof snap) => void, re: RegExp, why: string) => { const x = JSON.parse(JSON.stringify(snap)); f(x); refuses(() => WorldScheduler.restore(x), re, why); };
  bad((x) => { x.schema = 'v0'; }, /schema/, 'snapshot with an unknown schema refused');
  bad((x) => { x.events[0].id = 'forged'; }, /not canonical/, 'snapshot with a non-canonical id refused');
  bad((x) => { const p = x.events.find((e) => e.state === 'scheduled')!; p.at = { ...x.clock.at }; p.round = x.clock.round; p.id = WorldScheduler.idOf(p.cause, p.kind, p.key); }, /not after the clock/, 'snapshot with a pending event at or before the clock refused');
  bad((x) => { const c = x.events.find((e) => e.cause !== null)!; x.events = x.events.filter((e) => e.id !== c.cause); }, /cause .* missing/, 'snapshot with a missing cause refused');
  bad((x) => { x.events[1].state = 'done' as never; }, /state done unknown/, 'snapshot with an unknown state refused');
  bad((x) => { x.events.push(x.events[0]); }, /duplicate id/, 'snapshot with a duplicate id refused');
}

// 7. review findings (Claude subagent review, not Codex)
{
  const mk = () => { const s = new WorldScheduler(W); for (const [k, m] of [['x', 1], ['y', 5]] as const) s.schedule({ kind: 'a', key: k, at: { day: 0, minute: m }, scope: ref(null, null), source: null, target: null }); return s; };
  // re-entry
  for (const [what, f] of [['cancel', (s: WorldScheduler) => s.cancel('a:x', 'r')], ['cancel other', (s: WorldScheduler) => s.cancel('a:y', 'r')], ['schedule', (s: WorldScheduler) => s.schedule({ kind: 'b', key: 'z', at: { day: 0, minute: 0.5 }, scope: ref(null, null), source: null, target: null })], ['step', (s: WorldScheduler) => s.step(() => {})], ['runDay', (s: WorldScheduler) => s.runDay(0, () => {})], ['snapshot', (s: WorldScheduler) => s.snapshot()]] as const) {
    const s = mk(), before = JSON.stringify(s.snapshot());
    refuses(() => s.step(() => { f(s); }), /inside a batch handler/, `re-entry refused: ${what} from inside a handler`);
    ok(JSON.stringify(s.snapshot()) === before && s.audit().executed === 0, `re-entry (${what}): state unchanged, batch still pending`);
  }
  { const s = mk(); let n = 0; s.step(() => { n = s.pending().length; }); ok(n === 2, 'a handler may read the scheduler (frozen copies)'); }
  // frozen readers
  {
    const s = mk(); s.step(() => {});
    const strictThrows = (f: () => void, why: string) => { assert.throws(f, TypeError, why); checks++; };
    strictThrows(() => { (s.get('a:y') as WorldEvent).at.minute = 0.1; }, 'get(): the returned event is frozen');
    strictThrows(() => { (s.get('a:x') as WorldEvent).state = 'scheduled'; }, 'get(): state cannot be reset through the copy');
    strictThrows(() => { (s.log as unknown as unknown[]).push({}); }, 'log is a frozen copy');
    strictThrows(() => { (s.pending()[0] as WorldEvent).round = 9; }, 'pending() entries are frozen');
    let thrown = false; s.step((b) => { try { (b[0] as WorldEvent).at.minute = 0; } catch (e) { thrown = e instanceof TypeError; } });
    ok(thrown, 'batch events given to the handler are frozen');
    ok(s.audit().executed === 2 && s.get('a:y')!.at.minute === 5, 'nothing leaked into internal state');
  }
  // tick grid
  {
    ok(compareTime(addMinutes({ day: 0, minute: 0.1 }, 0.2), { day: 0, minute: 0.3 }) === 0 && addMinutes({ day: 0, minute: 0.1 }, 0.2).minute === 0.3, '0.1 + 0.2 and 0.3 are the same instant (integer ticks), and the result is the canonical 0.3');
    ok(JSON.stringify(addMinutes(addMinutes({ day: 0, minute: 1439.9 }, 0.2), 0.1)) === JSON.stringify(addMinutes({ day: 0, minute: 1439.9 }, 0.3)) && addMinutes({ day: 0, minute: 1439.9 }, 0.3).minute === 0.2, 'grouping of delays does not change the instant across midnight (d1 + 0.2 either way)');
    const s = new WorldScheduler(W);
    s.schedule({ kind: 'a', key: 'p', at: { day: 0, minute: 0.1 + 0.2 }, scope: ref(null, null), source: null, target: null });
    s.schedule({ kind: 'a', key: 'q', at: { day: 0, minute: 0.3 }, scope: ref(null, null), source: null, target: null });
    ok(s.step(() => {}).length === 2, 'events at 0.1+0.2 and 0.3 form ONE batch');
    refuses(() => checkTime({ day: 0, minute: 1440 - 0.4 / TICKS_PER_MINUTE }), /rounds to 24:00/, 'a minute that rounds to 24:00 is refused, not wrapped');
    ok(checkTime({ day: 0, minute: 1439.9999994 }).minute === 1439.999999, 'times are snapped to the tick grid');
  }
  // world inputs at an instant already processed; 24:00 boundary
  {
    const s = mk(); s.step(() => {});
    refuses(() => s.schedule({ kind: 'b', key: 'same', at: { day: 0, minute: 1 }, scope: ref(null, null), source: null, target: null }), /already being processed/, 'a world input at the instant just processed is refused (not silently put in a later round)');
    const d = new WorldScheduler(W); d.schedule({ kind: 'a', key: 'mid', at: { day: 1, minute: 0 }, scope: ref(null, null), source: null, target: null });
    ok(d.runDay(0, () => {}) === 0 && d.pending().length === 1 && d.runDay(1, () => {}) === 1, '24:00 is day+1 minute 0: not run by runDay(0), run by runDay(1)');
  }
  // runaway run stops consistent
  {
    const s = new WorldScheduler(W); s.schedule({ kind: 'a', key: 'r', at: { day: 0, minute: 0 }, scope: ref(null, null), source: null, target: null });
    const loop = (b: readonly Readonly<WorldEvent>[]): StepOutput => ({ children: [{ cause: b[0].id, spec: { kind: 'a', key: 'r', at: addMinutes(b[0].at, 1), scope: ref(null, null), source: null, target: null } }] });
    refuses(() => s.runDay(0, loop, 50), /more than 50 batches/, 'a runaway schedule is stopped');
    s.audit(); verifyLog(s.log); ok(s.audit().executed === 50 && s.audit().pending === 1, 'after the stop: 50 batches done, one pending, audit and verifyLog pass');
  }
  // verifyLog: post-restore segment and same-instant rounds
  {
    const one = harness(42, world(3, 12), 1);
    const snap = one.s.snapshot(), r = WorldScheduler.restore(snap);
    const h = (b: readonly Readonly<WorldEvent>[]): StepOutput => ({ children: b.filter((e) => e.kind === 'wake').map((e) => ({ cause: e.id, spec: { kind: 'wake', key: `n${(e.payload as { n: number }).n + 1}`, at: addMinutes(e.at, 300), scope: e.scope, source: null, target: null, payload: { n: (e.payload as { n: number }).n + 1 } } })) });
    r.runDay(1, h);
    refuses(() => verifyLog(r.log), /before its cause/, 'a post-restore log alone: causes from before the snapshot are unknown');
    ok(verifyLog(r.log, snap.events).ok, 'a post-restore log verifies on its own given the snapshot events');
    const tam = JSON.parse(JSON.stringify(base.s.log)); const i = tam.findIndex((l: { cause: string | null; round: number; state: string }) => l.cause !== null && l.round > 0 && l.state === 'executed');
    tam[i].round = 0;
    refuses(() => verifyLog(tam), /not after its cause|out of order/, 'verifyLog refuses a same-instant child whose round is not after its cause');
  }
  // round-2 review (Claude subagent review, not Codex)
  {
    // a cancelled event in the very slot of the next batch is never pulled into it
    const s = new WorldScheduler(W);
    for (const k of ['p', 'q', 'r']) s.schedule({ kind: 'a', key: k, at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null });
    s.cancel('a:q', 'test');
    const b = s.step(() => {}); ok(b.map((e) => e.id).join() === 'a:p,a:r' && s.get('a:q')!.state === 'cancelled', 'a cancelled event in the same instant and round is not executed with its batch');
    // handler output type
    const s2 = new WorldScheduler(W); s2.schedule({ kind: 'a', key: 'x', at: { day: 0, minute: 1 }, scope: ref(null, null), source: null, target: null });
    refuses(() => s2.step(() => 'oops' as never), /must be undefined or a plain object/, 'handler output that is not an object is refused');
    refuses(() => s2.step(() => ({ children: 'x' as never })), /children must be an array/, 'children that is not an array is refused');
    ok(s2.pending().length === 1, 'refused output: batch still pending');
    // closed days
    const s3 = new WorldScheduler(W); s3.runDay(0, () => {});
    refuses(() => s3.schedule({ kind: 'a', key: 'late', at: { day: 0, minute: 700 }, scope: ref(null, null), source: null, target: null }), /already closed/, 'a world input on a day already closed by runDay is refused');
    refuses(() => s3.runDay(0, () => {}), /already closed/, 'a closed day cannot be run again');
    // restore: pending before the start of a scheduler that never started
    const s4 = new WorldScheduler(W, { day: 5, minute: 0 }); s4.schedule({ kind: 'a', key: 'x', at: { day: 5, minute: 1 }, scope: ref(null, null), source: null, target: null });
    const sn = s4.snapshot(); sn.events[0].at = { day: 0, minute: 0 };
    refuses(() => WorldScheduler.restore(sn), /pending but not after the clock/, 'restore refuses a pending event before the start of an unstarted scheduler');
    // quantisation is documented, not hidden
    ok(addMinutes({ day: 0, minute: 0 }, 4e-7).minute === 0 && checkTime({ day: 0, minute: 1e-7 }).minute === 0, 'quantisation: below half a tick rounds to 0 (documented normalisation)');
    // verifyLog same-instant round, constructed directly
    const at = { day: 0, minute: 3 };
    const L = [{ seq: 0, id: 'a:x', kind: 'a', at, round: 0, cause: null, state: 'executed' as const, by: null, reason: null }, { seq: 1, id: 'a:x/b:y', kind: 'b', at, round: 0, cause: 'a:x', state: 'executed' as const, by: null, reason: null }];
    refuses(() => verifyLog(L), /not after its cause/, 'verifyLog refuses a child at its cause\'s instant in the same round');
    ok(verifyLog([L[0], { ...L[1], round: 1 }]).ok, 'the same log with the child in the next round verifies');
    // audit detects a corrupted instance (internal fields reached only by this test)
    const s5 = new WorldScheduler(W); s5.schedule({ kind: 'a', key: 'x', at: { day: 0, minute: 1 }, scope: ref(null, null), source: null, target: null }); s5.step(() => {});
    const internals = s5 as unknown as { logEntries: unknown[]; finishedAtRestore: number };
    internals.logEntries.push({ ...(internals.logEntries[0] as object) }); refuses(() => s5.audit(), /logged twice/, 'audit detects an event logged twice');
    internals.logEntries.pop(); internals.finishedAtRestore = 1; refuses(() => s5.audit(), /disagree/, 'audit detects log and states disagreeing');
  }
  // Owner P2 (2026-11-07, #116): output validation failed but the batch was already partly committed. Cause: the
  // handler's output was read twice (validate, then commit); a getter / proxy could change in between.
  {
    const mk2 = () => { const s = new WorldScheduler(W); for (const [k, m] of [['x', 1], ['y', 5]] as const) s.schedule({ kind: 'a', key: k, at: { day: 0, minute: m }, scope: ref(null, null), source: null, target: null }); return s; };
    // each field of the output is read exactly once
    const reads: Record<string, number> = {}; const count = (k: string) => { reads[k] = (reads[k] ?? 0) + 1; };
    const s = mk2();
    s.step((b) => { const spec = { kind: 'b', key: 'k', get at() { count('at'); return { day: 0, minute: 2 }; }, get scope() { count('scope'); return ref(null, null); }, source: null, target: null, get payload() { count('payload'); return { v: 1 }; } }; return { get children() { count('children'); return [{ get cause() { count('cause'); return b[0].id; }, spec }]; }, get cancel() { count('cancel'); return [{ id: 'a:y', get reason() { count('reason'); return 'test'; } }]; } }; });
    ok(Object.values(reads).every((n) => n === 1) && Object.keys(reads).length === 7, `every output field is read exactly once (${JSON.stringify(reads)})`);
    ok(s.get('a:y')!.state === 'cancelled' && s.get('a:x/b:k')!.at.minute === 2, 'the single read is what is committed');
    // a getter that would turn valid -> invalid on a second read cannot split validation from commit
    for (const [what, out] of [
      ['cancel getter', (b: readonly Readonly<WorldEvent>[]) => { let n = 0; void b; return { get cancel() { return n++ === 0 ? [{ id: 'nope', reason: 'r' }] : []; } }; }],
      ['scope getter', (b: readonly Readonly<WorldEvent>[]) => { let n = 0; return { children: [{ cause: b[0].id, spec: { kind: 'b', key: 'k', at: { day: 0, minute: 2 }, get scope() { return n++ === 0 ? { world: 'other', colony: null, individual: null } : ref(null, null); }, source: null, target: null } }] }; }],
      ['payload getter', (b: readonly Readonly<WorldEvent>[]) => { let n = 0; return { children: [{ cause: b[0].id, spec: { kind: 'b', key: 'k', at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null, payload: { get v() { return n++ === 0 ? NaN : 1; } } } }] }; }],
      ['throwing proxy', (b: readonly Readonly<WorldEvent>[]) => { let n = 0; return new Proxy({ children: [{ cause: b[0].id, spec: { kind: 'b', key: 'k', at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null } }], cancel: [{ id: 'nope', reason: 'r' }] }, { get(t, k) { if (n++ > 3) throw new Error('second read'); return (t as Record<string | symbol, unknown>)[k]; } }); }],
    ] as const) {
      const t = mk2(), before = JSON.stringify(t.snapshot());
      assert.throws(() => t.step(out as never), (e: unknown) => e instanceof SchedulerError || /second read/.test(String(e)), `${what}: invalid output refused`); checks++;
      ok(JSON.stringify(t.snapshot()) === before && t.audit().executed === 0 && t.log.length === 0, `${what}: nothing committed (batch still pending, no log entry)`);
    }
    // schedule() also reads its spec once
    const u = new WorldScheduler(W); let n = 0;
    refuses(() => u.schedule({ kind: 'a', key: 'g', at: { day: 0, minute: 1 }, get scope() { return n++ === 0 ? { world: 'other', colony: null, individual: null } : ref(null, null); }, source: null, target: null } as EventSpec), /not this world/, 'schedule(): a spec whose getter is invalid on its single read is refused');
    ok(u.pending().length === 0, 'schedule(): nothing added');
  }
  // review (Claude subagent, not Codex) of e49deb9: regressions of the copy rewrite and output-shape contract
  {
    const one = () => { const s = new WorldScheduler(W); s.schedule({ kind: 'a', key: 'x', at: { day: 0, minute: 1 }, scope: ref(null, null), source: null, target: null }); return s; };
    const sp = (over: Record<string, unknown> = {}) => ({ kind: 'b', key: 'k', at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null, ...over });
    { const s = one(); s.step((b) => ({ children: [{ cause: b[0].id, spec: sp({ payload: undefined }) as EventSpec }] })); ok(s.get('a:x/b:k')!.payload === null, 'an explicit payload: undefined is no payload (null), as before'); }
    { const s = one(), pl = JSON.parse('{"__proto__": 5, "a": {"__proto__": {"z": 1}}}'); s.step((b) => ({ children: [{ cause: b[0].id, spec: sp({ payload: pl }) as EventSpec }] }));
      const got = s.get('a:x/b:k')!.payload as Record<string, unknown>; ok(Object.prototype.hasOwnProperty.call(got, '__proto__') && JSON.stringify(got) === '{"__proto__":5,"a":{"__proto__":{"z":1}}}', 'a payload key named __proto__ is kept as an ordinary key (not dropped, not a prototype)');
      const r = WorldScheduler.restore(s.snapshot()); ok(JSON.stringify(r.get('a:x/b:k')!.payload) === JSON.stringify(got), '__proto__ key survives snapshot / restore'); }
    for (const [what, f, re] of [
      ['async handler (Promise)', () => Promise.resolve({ children: [] }), /async handler is not allowed/],
      ['misspelt field', () => ({ childs: [] }), /unknown field childs/],
      ['extra field in a child', (b: readonly Readonly<WorldEvent>[]) => ({ children: [{ cause: b[0].id, spec: sp() as EventSpec, priority: 1 }] }), /exactly cause, spec/],
      ['extra field in a cancel', () => ({ cancel: [{ id: 'a:x', reason: 'r', when: 1 }] }), /exactly id, reason/],
      ['non-enumerable unknown field', () => Object.defineProperty({}, 'kids', { value: [], enumerable: false }), /unknown field kids/],
      ['symbol key', () => ({ [Symbol('x')]: 1 }), /symbol keys/],
      ['huge array-like length', () => ({ children: new Proxy([], { get: (t, k) => (k === 'length' ? 1e12 : (t as unknown as Record<string | symbol, unknown>)[k]) }) }), /more than/],
      ['huge payload (shared subtree)', (b: readonly Readonly<WorldEvent>[]) => { let v: unknown = 1; for (let i = 0; i < 30; i++) v = [v, v]; return { children: [{ cause: b[0].id, spec: sp({ payload: v }) as EventSpec }] }; }, /more than 100000 values/],
      ['sparse payload array', (b: readonly Readonly<WorldEvent>[]) => ({ children: [{ cause: b[0].id, spec: sp({ payload: [1, , 3] }) as EventSpec }] }), /hole/],
    ] as const) {
      const s = one(), before = JSON.stringify(s.snapshot()), t0 = Date.now();
      refuses(() => s.step(f as never), re, `refused: ${what}`);
      ok(JSON.stringify(s.snapshot()) === before && Date.now() - t0 < 2000, `${what}: nothing committed, refused promptly`);
    }
    { const s = one(); s.step((b) => ({ children: [{ cause: b[0].id, spec: Object.defineProperty(sp(), 'payload', { value: { v: 1 }, enumerable: false }) as EventSpec }] })); ok(JSON.stringify(s.get('a:x/b:k')!.payload) === '{"v":1}', 'a non-enumerable payload is read, not silently dropped'); }
  }
  // restore refuses each inconsistency
  {
    const snap = base.s.snapshot();
    type E = (typeof snap)['events'][number];
    const bad = (f: (x: typeof snap) => void, re: RegExp, why: string) => { const x = JSON.parse(JSON.stringify(snap)); f(x); refuses(() => WorldScheduler.restore(x), re, why); };
    const firstChild = (x: typeof snap, pred: (e: E, c: E) => boolean = () => true) => x.events.find((e) => e.cause !== null && pred(e, x.events.find((c) => c.id === e.cause)!))!;
    for (const r of [-7, 0.5, 'zz']) bad((x) => { x.events[0].round = r as never; }, /round must be/, `restore refuses round ${JSON.stringify(r)}`);
    bad((x) => { const c = firstChild(x, (e, c) => compareTime(e.at, c.at) === 0); c.round = 0; }, /round 0 inconsistent with its cause/, 'restore refuses a same-instant child not in the next round');
    bad((x) => { const c = firstChild(x); const cause = x.events.find((e) => e.id === c.cause)!; cause.state = 'cancelled'; cause.cancel_reason = 'x'; }, /was not executed/, 'restore refuses a child whose cause was not executed');
    bad((x) => { const c = firstChild(x, (e, c) => compareTime(e.at, c.at) > 0); const cause = x.events.find((e) => e.id === c.cause)!; c.at = cause.at.minute >= 1 ? { day: cause.at.day, minute: cause.at.minute - 1 } : { day: cause.at.day - 1, minute: 1439 }; }, /before its cause|not after the clock/, 'restore refuses a child before its cause');
    bad((x) => { x.clock.started = false; x.clock.round = -1; }, /executed but after the clock|never started/, 'restore refuses executed events with a clock that never started');
    bad((x) => { const e = x.events.find((v) => v.state === 'executed')!; e.at = { day: 9, minute: 0 }; }, /executed but after the clock|before its cause/, 'restore refuses an executed event after the clock');
    bad((x) => { const e = x.events.find((v) => v.state === 'executed')!; e.cancelled_by = 'z'; }, /cancel fields inconsistent/, 'restore refuses cancel fields on an executed event');
    bad((x) => { (x.events[0] as unknown as Record<string, unknown>).priority = 1; }, /exactly/, 'restore refuses extra event fields (e.g. a priority)');
    bad((x) => { x.events[0].kind = 'Bad'; }, /illegal kind or key/, 'restore refuses an illegal kind');
    bad((x) => { x.log_seq = 0; }, /log_seq/, 'restore refuses a log_seq below the finished events');
    bad((x) => { x.log_seq = 999999; }, /log_seq/, 'restore refuses a log_seq above the finished events');
    bad((x) => { x.clock.round = -1; }, /clock round invalid/, 'restore refuses a started clock with round -1');
    bad((x) => { const r = x.events.find((e) => e.cause === null)!; r.round = 1; }, /round 1 inconsistent|world input must be in round 0|pending but not after/, 'restore refuses a world input not in round 0');
    bad((x) => { x.events[0].scope = { world: 'other', colony: null, individual: null }; }, /not this world/, 'restore checks references');
    bad((x) => { x.events[0].payload = { d: { e: [1, { f: undefined as never }] } } as never; (x.events[0].payload as Record<string, unknown>).g = (() => 1) as never; }, /payload/, 'restore checks payloads');
    bad((x) => { x.clock.closed_day = 5; }, /closed day/, 'restore refuses pending events on a closed day');
    bad((x) => { x.events = null as never; }, /must be an array/, 'restore refuses events: null with a SchedulerError');
    bad((x) => { x.events[0].at = { day: x.events[0].at.day, minute: x.events[0].at.minute + 1e-9 }; }, /tick grid|not after|before its cause|executed but/, 'restore refuses a time off the tick grid');
  }
}

// 8. Codex R9-01 / R10 §4: re-entry while the OUTPUT (or any caller object) is read, not only inside the handler body
{
  const root = (s: WorldScheduler, key: string, minute: number) => s.schedule({ kind: 'a', key, at: { day: 0, minute }, scope: ref(null, null), source: null, target: null });
  const mk = () => { const s = new WorldScheduler(W); root(s, 'now', 1); root(s, 'future', 10); return s; };
  const same = (s: WorldScheduler, snap: string, logN: number, why: string) => ok(JSON.stringify(s.snapshot()) === snap && s.log.length === logN && s.audit().executed === 0 && s.audit().cancelled === 0, why);
  // (1) Codex case: the cancel getter cancels another pending event, then throws -> nothing changes
  {
    const s = mk(), snap = JSON.stringify(s.snapshot()), n = s.log.length; let inner: unknown = null;
    assert.throws(() => s.step(() => ({ get cancel() { try { s.cancel('a:future', 'sneak'); } catch (e) { inner = e; } throw new Error('getter fails'); } }) as unknown as StepOutput));
    ok(inner instanceof SchedulerError && /while its output is read/.test(String(inner)), 'R10-1: cancel() from an output getter is refused');
    same(s, snap, n, 'R10-1: after the failed step both events are still scheduled, log and snapshot unchanged');
    ok(s.get('a:future')!.state === 'scheduled' && s.get('a:now')!.state === 'scheduled', 'R10-1: future not cancelled, now not executed');
  }
  // (2) Codex case: the getter schedules an EARLIER root (minute 0.5) and returns [] -> refused; the clock never goes back
  {
    const s = mk(); let inner: unknown = null;
    s.step(() => ({ get cancel() { try { root(s, 'early', 0.5); } catch (e) { inner = e; } return []; } }) as unknown as StepOutput);
    ok(inner instanceof SchedulerError, 'R10-2: schedule() from an output getter is refused');
    ok(s.get('a:early') === undefined, 'R10-2: the earlier event was not created');
    const clock: number[] = []; s.runUntil({ day: 1, minute: 0 }, (b, ctx) => { clock.push(ctx.at.minute); });
    ok(clock.length === 1 && clock[0] === 10 && verifyLog(s.log).ok, 'R10-2: later batches never run before the committed minute 1 (no clock reversal)');
  }
  // (3) every mutating API from every read path of step output is refused, and the batch stays atomic
  const mutators: [string, (s: WorldScheduler) => unknown][] = [['cancel', (s) => s.cancel('a:future', 'r')], ['schedule', (s) => root(s, 'z', 0.5)], ['step', (s) => s.step(() => {})], ['runUntil', (s) => s.runUntil({ day: 1, minute: 0 }, () => {})], ['runDay', (s) => s.runDay(0, () => {})], ['snapshot', (s) => s.snapshot()]];
  const paths: [string, (f: () => void) => unknown][] = [
    ['children getter', (f) => ({ get children() { f(); return []; } })],
    ['children array index getter', (f) => ({ children: Object.defineProperty([], 0, { get() { f(); return { cause: 'a:now', spec: { kind: 'b', key: 'k', at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null } }; }, enumerable: true }) })],
    ['spec at getter', (f) => ({ children: [{ cause: 'a:now', spec: { kind: 'b', key: 'k', get at() { f(); return { day: 0, minute: 2 }; }, scope: ref(null, null), source: null, target: null } }] })],
    ['payload getter', (f) => ({ children: [{ cause: 'a:now', spec: { kind: 'b', key: 'k', at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null, payload: { get v() { f(); return 1; } } } }] })],
    ['cause toString', (f) => ({ children: [{ cause: { toString() { f(); return 'a:now'; } }, spec: { kind: 'b', key: 'k', at: { day: 0, minute: 2 }, scope: ref(null, null), source: null, target: null } }] })],
    ['cancel id toString', (f) => ({ cancel: [{ id: { toString() { f(); return 'a:future'; } }, reason: 'r' }] })],
    ['Proxy ownKeys trap', (f) => new Proxy({ cancel: [] }, { ownKeys(t) { f(); return Reflect.ownKeys(t); } })],
    ['Proxy get trap', (f) => new Proxy({ cancel: [] }, { get(t, k, r) { f(); return Reflect.get(t, k, r); } })],
  ];
  for (const [pw, mkOut] of paths) for (const [mw, m] of mutators) {
    const s = mk(), snap = JSON.stringify(s.snapshot()), n = s.log.length; let inner: unknown = null;
    try { s.step(() => mkOut(() => { try { m(s); } catch (e) { inner = e; } throw new Error('stop'); }) as StepOutput); } catch { /* the step itself fails (or rejects the shape) */ }
    ok(inner === null || (inner instanceof SchedulerError && /while its output is read/.test(String(inner))), `${pw} -> ${mw}: re-entry refused (or never reached)`);
    same(s, snap, n, `${pw} -> ${mw}: state, log and snapshot unchanged after the failed step`);
  }
  // (4) a getter that swallows the refusal and returns a VALID output: the step commits only its own output
  {
    const s = mk();
    s.step(() => ({ get cancel() { try { s.cancel('a:future', 'sneak'); } catch { /* refused */ } return []; } }) as unknown as StepOutput);
    ok(s.get('a:now')!.state === 'executed' && s.get('a:future')!.state === 'scheduled' && s.log.length === 1, 'swallowed re-entry: only the batch itself was committed');
  }
  // (5) the same guard covers schedule()/cancel()/runUntil() reading THEIR caller objects
  {
    const s = mk(), snap = JSON.stringify(s.snapshot()); let inner: unknown = null;
    assert.throws(() => s.schedule({ kind: 'b', key: 'g', get at() { try { s.cancel('a:future', 'sneak'); } catch (e) { inner = e; } throw new Error('stop'); }, scope: ref(null, null), source: null, target: null } as unknown as EventSpec));
    ok(inner instanceof SchedulerError && /while schedule is reading its input/.test(String(inner)), 'schedule(): a spec getter cannot cancel');
    ok(JSON.stringify(s.snapshot()) === snap, 'schedule(): state unchanged');
    let inner2: unknown = null;
    const id2 = s.schedule({ kind: 'b', key: 'h', get at() { try { root(s, 'other', 3); } catch (e) { inner2 = e; } return { day: 0, minute: 2 }; }, scope: ref(null, null), source: null, target: null } as unknown as EventSpec);
    ok(inner2 instanceof SchedulerError && s.get('a:other') === undefined && s.get(id2)!.state === 'scheduled', 'schedule(): a spec getter cannot schedule another event');
    let inner3: unknown = null;
    assert.throws(() => s.cancel({ toString() { try { root(s, 'x2', 3); } catch (e) { inner3 = e; } return 'a:future'; } } as unknown as string, 'r'));
    ok((inner3 === null || inner3 instanceof SchedulerError) && s.get('a:x2') === undefined && s.get('a:future')!.state === 'scheduled', 'cancel(): a non-string id is refused and its toString cannot schedule');
    let inner4: unknown = null;
    const s4 = mk(); const n4 = s4.runUntil({ day: 0, get minute() { try { root(s4, 'r4', 0.5); } catch (e) { inner4 = e; } return 5; } } as unknown as { day: number; minute: number }, () => {});
    ok(inner4 instanceof SchedulerError && s4.get('a:r4') === undefined && n4 === 1, 'runUntil(): an end getter cannot schedule');
  }
  // (6) the guard is always released: after every refusal above the scheduler works normally
  { const s = mk(); try { s.step(() => { throw new Error('x'); }); } catch { /* */ } s.runUntil({ day: 1, minute: 0 }, () => {}); ok(s.audit().executed === 2 && verifyLog(s.log).ok, 'guard released in finally: later steps run'); }
}

console.log(JSON.stringify({ test: 'p0a0-world-scheduler', passed: true, checks, harness: base.s.audit() }));

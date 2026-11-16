/**
 * Demo 2 — D2E-1 RECONCILIATION (docs/demo2-engine-gap.md): the page's event counts by class equal an INDEPENDENT
 * Node replay of the same world over the same span. BLOCKING. NON-OFFICIAL experiment world; nothing here changes one.
 *
 * Two sides, sharing no counting code:
 *  PAGE    web/src/demo2/events.ts (EventLedger) fed with the protocol events of the Worker's world adapter, in the
 *          batches a page would get (several chunkings);
 *  REPLAY  the prototype core itself (prototypes/p0a2-24h/world.ts runTo, captureLog) from the same seed, counted
 *          straight from its canonical log lines by tests/lib/demo2-replay.ts (written apart from events.ts on purpose;
 *          the browser check tests/browser/demo2-events.check.cjs uses the same replay against the real page).
 *
 *  1. counts by class and by raw kind are equal for 3 seeds × 26 h (crossing midnight), for every chunking;
 *  2. a page that opens on a world already running (events from seq S on) equals the replay over the same seq span;
 *  3. the candidate world 'p0a2-colony' (Demo 2's default): the roster events are counted and the base counts are the
 *     same as the plain world's;
 *  4. the cue budget cannot change a count: cueMax 0, 3 and 6 give identical counts; shown + dropped cues add up;
 *  5. every event is listed (ticker window = the last TICKER_MAX events, in order) and totals are complete; no event
 *     is left without a class; classes that never occur stay visible with 0;
 *  6. observing does not change the world (#144): the ledger never mutates an event and the world's payload hash is the
 *     same with and without it; the module imports nothing but the protocol types and names no Worker command;
 *  7. exported helper `reconcile` for later work packages (D2E-2, D2E-3).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { runTo } from '../prototypes/p0a2-24h/world.ts';
import { P0a2ExperimentWorld, P0A2_SCENARIO } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import { P0a2ColonyWorld } from '../prototypes/continuous-world/worker/p0a2-colony-world.ts';
import type { EventMsg } from '../web/src/experimental/worker-protocol.ts';
import { replayCounts, type Counts } from './lib/demo2-replay.ts';
import { CLASSES, CUE_FRESH_S, CUE_HOLD_S, EventLedger, TICKER_MAX, classify, classOf } from '../web/src/demo2/events.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const RAW = JSON.parse(read('prototypes/p0a2-24h/params.json'));
const sorted = (o: Counts): Counts => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/** PAGE side: the ledger fed with the adapter's protocol events in chunks of `chunkS` seconds (cueMax as given) */
function pageCounts(make: () => { world: { advanceTo(t: number): { events: unknown[] } }; events: unknown[] }, T: number, chunkS: number, cueMax = 6, fromT = 0): EventLedger {
  const { world, events } = make(), L = new EventLedger(cueMax); let wall = 0;
  if (fromT > 0) world.advanceTo(fromT); else L.onEvents(events as EventMsg[], wall);
  for (let t = fromT; t < T;) { t = Math.min(T, t + chunkS); wall += 0.016; L.onEvents(world.advanceTo(t).events as EventMsg[], wall); }
  return L;
}
/** the reconciliation later packages reuse: page ledger vs replay, by class and by kind; returns the numbers */
export function reconcile(seed: number, T: number, chunkS: number): { page: Counts; replay: Counts; kinds: Counts; total: number } {
  const page = pageCounts(() => P0a2ExperimentWorld.create('exp-demo2-events', seed), T, chunkS);
  const core = runTo(RAW, P0A2_SCENARIO, seed, Math.floor(T * 1000), { captureLog: true }), rep = replayCounts(core.lines!);
  assert.deepEqual(sorted(page.countsObject()), rep.classes, `seed ${seed}, chunk ${chunkS} s: counts by class`);
  assert.deepEqual(sorted(page.kindsObject()), rep.kinds, `seed ${seed}, chunk ${chunkS} s: counts by raw kind`);
  assert.equal(page.total, rep.total); assert.equal(page.total, core.logCount); assert.equal(page.gaps, 0);
  return { page: sorted(page.countsObject()), replay: rep.classes, kinds: rep.kinds, total: page.total };
}

const T = 26 * 3600, summary: Record<string, unknown> = {};
// 1. three seeds, several chunkings (a page at 1× gets small batches, at 60× or while fast-forwarding large ones)
for (const seed of [20261113, 1, 7]) {
  let first: Counts | null = null, kinds: Counts = {};
  for (const chunk of [0.25 * 3600, 61, 26 * 3600]) { // 15 min, 61 s (not aligned with anything), everything at once
    const r = reconcile(seed, T, chunk); checks += 5;
    kinds = r.kinds; if (!first) first = r.page; else ok(JSON.stringify(first) === JSON.stringify(r.page), `seed ${seed}: chunking does not change a count`);
    if (chunk === 61) summary[`seed_${seed}`] = { total: r.total, ...r.page };
  }
  const p = first!;
  ok(p.exit > 500 && p.source_empty > p.source_take && p.contact_only > 0 && p.contact_transfer > 0 && p.idle_larva_touch > 0 && p.larva_fed > 0 && p.produce > 90 && p.env_sample === 27 && p.env_light === 4, `seed ${seed}: the classes the audit lists all occur (futile trips included, not hidden)`);
  ok(p.choice_forage + p.choice_brood + p.choice_idle + p.choice_rest === kinds.bout_end + (kinds.wake ?? 0) + kinds.arrive_nest, `seed ${seed}: every arrival, bout end and wake carries exactly one in-nest choice`);
}

// 2. a page opened on a running world (restored save / continued world): only events from seq S on
{
  const seed = 1, from = 9 * 3600, to = 13 * 3600;
  const L = pageCounts(() => P0a2ExperimentWorld.create('exp-demo2-events', seed), to, 30, 6, from);
  const core = runTo(RAW, P0A2_SCENARIO, seed, to * 1000, { captureLog: true }), rep = replayCounts(core.lines!, L.first_seq!);
  ok(L.first_seq! > 0 && L.first_t! > from && L.last_seq === core.logCount - 1, 'the ledger saw exactly the events after the page opened');
  assert.deepEqual(sorted(L.countsObject()), rep.classes); assert.deepEqual(sorted(L.kindsObject()), rep.kinds); checks += 2;
  ok(L.total === rep.total && L.gaps === 0, 'partial span: totals equal, no sequence gap');
  summary.partial_span = { seed, from_h: 9, to_h: 13, total: L.total };
}

// 3. the candidate world (Demo 2's default kind): roster events + the same base counts
{
  const seed = 20261113, t = 6 * 3600;
  const col = pageCounts(() => P0a2ColonyWorld.create('exp-demo2-events', seed), t, 300), plain = pageCounts(() => P0a2ExperimentWorld.create('exp-demo2-events', seed), t, 300);
  const cw = P0a2ColonyWorld.create('exp-demo2-events', seed).world.frame() as { colony: { counts: { queens: number; major_workers: number; eggs: number; pupae: number } } };
  const a = col.countsObject(), b = plain.countsObject(), n = cw.colony.counts;
  ok(a.queen_added === n.queens && a.worker_added === n.major_workers && a.brood_item_added === n.eggs + n.pupae, `candidate world: roster events counted (${a.queen_added} queens, ${a.worker_added} majors, ${a.brood_item_added} eggs + pupae)`);
  for (const k of ['queen_added', 'worker_added', 'brood_item_added']) delete a[k];
  assert.deepEqual(a, b); checks++;
  ok(col.total === plain.total + n.queens + n.major_workers + n.eggs + n.pupae && col.gaps === 0, 'candidate world: every other event is the plain world\'s');
  ok(![...col.counts.keys()].some((k) => k.startsWith('kind:')), 'candidate world: no event without a class');
}

// 4 + 5. cue budget, ticker, completeness
{
  const seed = 7, t = 3 * 3600, mk = () => P0a2ExperimentWorld.create('exp-demo2-events', seed);
  const L0 = pageCounts(mk, t, 5, 0), L3 = pageCounts(mk, t, 5, 3), L6 = pageCounts(mk, t, 5, 6), big = pageCounts(mk, t, t, 6);
  ok(JSON.stringify(L0.countsObject()) === JSON.stringify(L3.countsObject()) && JSON.stringify(L3.countsObject()) === JSON.stringify(L6.countsObject()) && JSON.stringify(L6.countsObject()) === JSON.stringify(big.countsObject()), 'the cue budget (0 / 3 / 6) and the batch size never change a count');
  ok(L0.cues_shown === 0 && L0.cues_dropped > 0 && L0.activeCues(0).length === 0, 'cueMax 0: every cue is dropped from display (and counted as dropped)');
  ok(L3.cues_shown + L3.cues_dropped === L0.cues_dropped && L6.cues_shown + L6.cues_dropped === L0.cues_dropped && L6.cues_shown >= L3.cues_shown && L3.cues_shown > 0, `cues shown + dropped = cues offered (${L0.cues_dropped}); a larger budget shows at least as many`);
  ok(big.cues_dropped > L6.cues_dropped || big.cues_shown <= 6 + L6.cues_shown, 'one huge batch (a fast-forward) drops display cues, not counts');
  // a burst inside one instant: at most cueMax cues show, one per individual, highest priority kept
  const { world } = mk(), evs = world.advanceTo(2 * 3600).events as unknown as EventMsg[], B = new EventLedger(3); B.onEvents(evs, 10);
  const act = B.activeCues(10.1);
  ok(act.length <= 3 && new Set(act.map((c) => c.on)).size === act.length && act.every((c) => Math.abs(c.t1 - c.t0 - CUE_HOLD_S) < 1e-9), 'a burst shows at most cueMax cues, one per individual, each held CUE_HOLD_S of WALL time');
  ok(act.every((c) => { const e = evs.find((x) => x.event_id === c.event_id)!; return evs[evs.length - 1].t_sim - e.t_sim <= CUE_FRESH_S; }) && B.cues_dropped > 100, 'a batch spanning hours cues only its last CUE_FRESH_S simulated seconds (no label on an individual for something it did long ago); the rest is counted as not shown');
  { const C = new EventLedger(3); C.onEvents(evs, 10); const n = C.activeCues(10.1).length, tEnd = evs[evs.length - 1].t_sim; ok(C.activeCues(10.1, tEnd + 5, CUE_FRESH_S + 5).length === n && C.activeCues(10.1, tEnd + 600, CUE_FRESH_S + 5).length === 0, 'a cue is gone once the world has moved on past it in simulated time (stepping a paused page leaves no stale label)'); }
  ok(B.activeCues(10 + CUE_HOLD_S + 0.01).length === 0, 'cues expire by wall time (legible at any simulation speed; nothing is held in simulated time)');
  ok(B.ticker.length === Math.min(TICKER_MAX, evs.length) && B.ticker[B.ticker.length - 1].seq === evs[evs.length - 1].seq && B.ticker.every((x, i) => i === 0 || x.seq === B.ticker[i - 1].seq + 1), 'the ticker is the last TICKER_MAX events, in order, none skipped');
  ok(B.ticker.every((x) => x.text.length > 0 && x.event_id.length > 0), 'every listed line names its engine event');
  ok(B.total === evs.length && [...B.kinds.values()].reduce((a, b) => a + b, 0) === evs.length, 'every event is counted once by raw kind');
  for (const e of evs.slice(0, 4000)) { const c = classify(e); if (!(c.inc.length > 0 && c.inc.every(([, n]) => n > 0))) ok(false, `event ${e.event_id} (${e.kind}) has no class`); }
  ok(![...B.counts.keys()].some((k) => k.startsWith('kind:')), 'no P0-A2 event kind is left unclassified');
  const rows = B.rows();
  ok(rows.length >= CLASSES.length && rows.find((r) => r.def.key === 'exit_refused')!.n === 0 && rows.find((r) => r.def.key === 'source_heat')!.n === 0, 'classes that did not occur stay listed with 0 (e.g. no refusal at the entrance in the reference variant)');
  // an event kind this page does not know is still counted and listed, under its raw kind
  const U = new EventLedger(); U.onEvents([{ ...evs[0], seq: 0, kind: 'future_kind', data: {} } as EventMsg], 0);
  ok(U.count('kind:future_kind') === 1 && U.total === 1 && U.ticker[0].text.includes('future_kind') && classOf('kind:future_kind').group === 'other' && U.rows().some((r) => r.def.key === 'kind:future_kind' && r.n === 1), 'an unknown engine event kind is counted and listed, never dropped');
  summary.cues = { offered: L0.cues_dropped, shown_budget_3: L3.cues_shown, shown_budget_6: L6.cues_shown };
}

// 6. observation only (#144)
{
  const seed = 1, t = 2 * 3600;
  const a = P0a2ExperimentWorld.create('exp-demo2-events', seed), b = P0a2ExperimentWorld.create('exp-demo2-events', seed), L = new EventLedger();
  const deepFreeze = (o: unknown): unknown => { if (o && typeof o === 'object') { for (const v of Object.values(o as object)) deepFreeze(v); Object.freeze(o); } return o; };
  for (let s = 600; s <= t; s += 600) { const evs = a.world.advanceTo(s).events, before = JSON.stringify(evs); L.onEvents(deepFreeze(evs) as EventMsg[], s); ok(JSON.stringify(evs) === before, 'the ledger does not mutate the events it is given'); b.world.advanceTo(s); }
  ok(L.total > 0 && a.world.snapshot().payload_sha256 === b.world.snapshot().payload_sha256 && JSON.stringify(a.world.chainState()) === JSON.stringify(b.world.chainState()), 'the world observed by the ledger is identical to the unobserved one (payload hash, event chain)');
  const src = read('web/src/demo2/events.ts'), imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  ok(imports.length === 1 && imports[0] === '../experimental/worker-protocol.ts' && /^import type /m.test(src) && !/^import \{/m.test(src), 'events.ts imports only the protocol TYPES');
  ok(!/Math\.random|Date\.now|performance\.|postMessage|\bclient\b|localStorage|indexedDB|fetch\(/.test(src) && !/p0a2-24h/.test(src) && !/from '(\.\.\/)+(engine|cli|prototypes)\//.test(src), 'events.ts has no clock, no randomness, no storage, no Worker command, no engine / cli / Worker import');
  const main = read('web/src/demo2/main.ts');
  ok(/ledger\.onEvents\(evs, /.test(main) && /ledger\.reset\(\)/.test(main), 'main.ts feeds every event batch to the ledger and resets it with the world');
  const sent = [...main.matchAll(/\bclient\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
  ok(sent.every((c) => ['init', 'stepUntil', 'start', 'pause', 'resume', 'setSpeed', 'follow', 'snapshot'].includes(c)), `main.ts still sends only scheduling / observation commands (${[...new Set(sent)].join(', ')})`);
}

console.log(JSON.stringify({ test: 'web-demo2-events', checks, ...summary }));

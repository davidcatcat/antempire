/**
 * v2-review.26 (Issue #80; docs/design-source-flows-v26.md): world food-source flows.
 *  - BEFORE (switch off, = v2-review.25): the ecology step changes source food with no event — capacity clamp, carcass
 *    expiry, rain washoff, daily decomposition. The independent reader makes each of them visible (the failure is
 *    reproducible on real days).
 *  - AFTER (switch on): every change is a source_flow event with a cause, an origin and a destination; the engine check
 *    (engine/ecology.ts checkSourceFlows) and the independent reader (cli/lib/source-flow-replay.ts, which recomputes
 *    each flow from the parameters and rebuilds each source from the events alone) both accept every real day:
 *    Day0 A1–A5 × four seasons × three seeds, the Day14 fixture with two seeds, continuous rain, sources starting at
 *    capacity, carcass batches past their lifetime, both capacity interpretations.
 *  - CONSERVATIVE: the switch changes no stock, no draw and no colony result (state and colony output identical except
 *    the event log); food availability is exactly the old model's.
 *  - Counterexamples: each is rejected by the engine check AND by the reader (the reader alone recomputes values, so a
 *    flow with a wrong amount whose stock still closes is a reader-only rejection; stated, not hidden).
 * Engineering/mathematical correctness only; not a scientific validation of any ecological quantity.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay, legacyToWorldState, legacyColonyMeta, resolveBundle, type WorldState } from '../engine/index.ts';
import { checkSourceFlows, growEcology, sourceSum } from '../engine/ecology.ts';
import { calcWeather } from '../engine/weather.ts';
import { replaySourceFlows } from '../cli/lib/source-flow-replay.ts';
import { fixture } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const throws = (f: () => void, re: RegExp) => { try { f(); return false; } catch (e) { return re.test(String(e)); } };
const OFF: Any = loadBundle();
const withFlows = (honeydewWithheld = false, nectarWithheld = true, edit?: (b: Any) => void) => { const b: Any = structuredClone(OFF); Object.assign(b.world.source_flows, { record_source_flows_v26: true, honeydew_capacity_limits_secretion: honeydewWithheld, nectar_capacity_limits_secretion: nectarWithheld }); edit?.(b); return b; };
const ON = withFlows();
const alwaysWet = (b: Any) => { const c = b.world.climate; c.annual_rain_days.value = 365; c.rain_probability_daily_cap.value = 1; c.wet_persistence.value = 0; };
const strip = (s: Any) => { const c = structuredClone(s); delete c.last_world_events; for (const m of c.migration_log ?? []) delete m.warmup_event_count; return JSON.stringify(c); };

// ---------------------------------------------------------------- BEFORE: the defect, reproduced (switch off)
{
  const wp = resolveBundle(OFF).world, unev = { overflow: 0, expired: 0, washoff: 0, decay: 0 };
  const before = (s0: Any, n: number) => { let s = s0; for (let d = 0; d < n; d++) { const o: Any = simulateWorldDay(s, OFF), r = replaySourceFlows(s, o.state, o.result, wp); ok(r.ok && r.flows === 0, `switch off day ${o.day}: no flow events, the reader still closes the ledger (${r.errors[0] ?? ''})`); for (const k of Object.keys(unev) as (keyof typeof unev)[]) unev[k] += r.unevented[k]; s = o.state; } };
  before(legacyToWorldState(fixture() as Any, legacyColonyMeta(OFF.world.scenario_colonies as Any)), 60);
  for (const sc of ['A1', 'A5']) for (const season of ['2027-03-21', '2027-09-23']) before(buildDay0(sc as Any, 1, season, OFF).state, 40);
  ok(unev.overflow > 0 && unev.expired > 0 && unev.washoff > 0 && unev.decay > 0, `BEFORE (switch off; Day14 fixture 60 days, Day0 A1/A5 spring/autumn 40 days): food changed with NO event — capacity clamp ${unev.overflow.toFixed(3)}, carcass expiry ${unev.expired.toFixed(3)}, rain washoff ${unev.washoff.toFixed(3)}, decomposition ${unev.decay.toFixed(3)} game portions`);
}

// ---------------------------------------------------------------- AFTER: real days, many conditions
interface Sample { start: Any; end: Any; result: Any; wp: Any }
const samples: Sample[] = [], causes: Record<string, number> = {};
let realDays = 0, identical = 0, compared = 0;
const run = (s0on: Any, s0off: Any | null, bon: Any, boff: Any | null, n: number, label: string) => {
  const wp = resolveBundle(bon).world;
  let a = s0on, b = s0off;
  for (let d = 0; d < n; d++) {
    const o: Any = simulateWorldDay(a, bon), r = replaySourceFlows(a, o.state, o.result, wp);
    ok(r.ok, `${label} day ${o.day}: the reader rejects a real day (${r.errors.slice(0, 2).join(' | ')})`);
    realDays++; for (const [k, v] of Object.entries(r.by_cause)) causes[k] = (causes[k] ?? 0) + v;
    if (samples.length < 60 && r.flows > 0 && (d % 7 === 3 || Object.keys(r.by_cause).some((k) => k.startsWith('capacity') || k === 'expired_remains'))) samples.push({ start: structuredClone(a), end: o.state, result: o.result, wp });
    if (b && boff) {
      const ob: Any = simulateWorldDay(b, boff); compared++;
      const same = strip(o.state) === strip(ob.state) && JSON.stringify(o.result.colonies) === JSON.stringify(ob.result.colonies) && JSON.stringify(o.result.world_events.filter((e: Any) => e.type !== 'source_flow')) === JSON.stringify(ob.result.world_events);
      if (same) identical++; else ok(false, `${label} day ${o.day}: the switch changed a stock, a draw or a colony result`);
      b = ob.state;
    }
    a = o.state;
  }
};
for (const sc of ['A1', 'A2', 'A3', 'A4', 'A5']) for (const season of ['2027-03-21', '2027-06-21', '2027-09-23', '2027-12-22']) for (const seed of [1, 2, 3]) {
  const days = sc === 'A1' || sc === 'A5' ? 40 : 20;
  run(buildDay0(sc as Any, seed, season, ON).state, buildDay0(sc as Any, seed, season, OFF).state, ON, OFF, days, `Day0 ${sc} ${season} seed ${seed}`);
}
const meta = legacyColonyMeta(OFF.world.scenario_colonies as Any);
for (const seed of [15032026, 15032027]) { const lg: Any = fixture(); lg.seed = seed; run(legacyToWorldState(structuredClone(lg), meta), legacyToWorldState(structuredClone(lg), meta), ON, OFF, 60, `Day14 seed ${seed}`); }
// extremes
const wetOn = withFlows(false, true, alwaysWet), wetOff: Any = structuredClone(OFF); alwaysWet(wetOff);
run(buildDay0('A1' as Any, 1, '2027-09-23', wetOn).state, buildDay0('A1' as Any, 1, '2027-09-23', wetOff).state, wetOn, wetOff, 30, 'continuous rain');
const atCapacity = (s: Any) => { for (const src of Object.values(s.sources) as Any[]) if (src.type !== 'carcass') { src.sugar = src.capacity; if (src.type === 'nectar') src.bloom_days_left = Math.max(5, src.bloom_days_left); } return s; };
const oldBatches = (s: Any) => { for (const src of Object.values(s.sources) as Any[]) if (src.type === 'carcass') { const c = OFF.world.carcasses.carcass_max_lifetime_days.value; src.batches.push({ event_id: 'TEST-OLD-' + src.id, original_day: s.sim_day + 1 - c - 1, protein: 0.7, age_days: c + 1, origin: 'test: a batch past its edible lifetime' }, { event_id: 'TEST-LAST-' + src.id, original_day: s.sim_day + 1 - c, protein: 0.4, age_days: c, origin: 'test: a batch on its last edible day' }); src.protein = sourceSum(src); } return s; };
const stress = (b: Any) => oldBatches(atCapacity(legacyToWorldState(fixture() as Any, legacyColonyMeta(b.world.scenario_colonies as Any))));
run(stress(ON), stress(OFF), ON, OFF, 20, 'sources at capacity, old carcass batches (honeydew runoff, nectar withheld)');
const flip = withFlows(true, false), flipOff: Any = structuredClone(OFF);
run(stress(flip), stress(flipOff), flip, flipOff, 20, 'sources at capacity (honeydew withheld, nectar runoff)');
ok(realDays > 1500 && compared === realDays && identical === compared, `AFTER: ${realDays} real world-days — engine check and reader accept every one; with the switch on every stock, draw and colony result equals the switch-off run (${identical}/${compared})`);
ok(['secretion', 'rival_harvest', 'rain_washoff', 'capacity_runoff', 'capacity_withheld', 'decomposition', 'expired_remains'].every((k) => (causes[k] ?? 0) > 0), `every cause occurs on real days: ${JSON.stringify(Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, +v.toFixed(3)])))}`);

// ---------------------------------------------------------------- fixed-seed replay and order independence
{
  const s0 = buildDay0('A5' as Any, 2, '2027-09-23', ON).state, a: Any = simulateWorldDay(structuredClone(s0), ON), b: Any = simulateWorldDay(structuredClone(s0), ON);
  ok(JSON.stringify(a) === JSON.stringify(b), 'fixed seed: the same input replays to the same events and state');
  const rev: Any = structuredClone(s0); rev.sources = Object.fromEntries(Object.entries(rev.sources).reverse());
  const c: Any = simulateWorldDay(rev, ON);
  const flows = (o: Any) => o.result.world_events.filter((e: Any) => e.type === 'source_flow').map((e: Any) => `${e.site}|${e.cause}|${e.batch_event_id ?? ''}|${e.portions}`).sort();
  const stocks = (s: Any) => JSON.stringify(Object.keys(s.sources).sort().map((k) => [k, s.sources[k].sugar, s.sources[k].protein]));
  ok(JSON.stringify(flows(a)) === JSON.stringify(flows(c)) && stocks(a.state) === stocks(c.state), 'order: reversing the source order gives the same flows (by source, cause, batch) and the same stocks');
}

// ---------------------------------------------------------------- counterexamples: engine check AND reader
// The engine check sees the ecology step alone: rerun it on a sample day's start state.
const ecologyStep = (sm: Sample) => {
  const w: Any = structuredClone(sm.start), events: Any[] = [], weather = calcWeather(w, sm.wp, sm.result.date);
  const start = Object.fromEntries(Object.entries(w.sources).map(([id, s]: [string, Any]) => [id, { type: s.type, food: sourceSum(s), batches: s.type === 'carcass' ? s.batches.map((x: Any) => x.event_id) : [] }]));
  growEcology(w, sm.wp, weather, events);
  const flows = events.filter((e) => e.type === 'source_flow');
  // stocks right after the source loop (before insect deaths add new remains)
  const after: Any = structuredClone(w.sources);
  for (const e of events) if (e.type === 'new_food_source') { const src = after[e.site]; src.batches = src.batches.filter((x: Any) => x.event_id !== e.id); }
  return { start, after, flows, mode: { honeydew_withheld: sm.wp.source_flows.honeydew_capacity_limits_secretion, nectar_withheld: sm.wp.source_flows.nectar_capacity_limits_secretion }, day: sm.start.sim_day + 1 };
};
const engineAccepts = (sm: Sample, edit: (f: Any[]) => Any[], editAfter?: (a: Any) => void) => { const e = ecologyStep(sm), f = edit(structuredClone(e.flows)); editAfter?.(e.after); try { checkSourceFlows(e.start, e.after, f, e.mode, e.day); return true; } catch (x) { return String(x); } };
const readerAccepts = (sm: Sample, edit: (f: Any[]) => Any[], editEnd?: (s: Any) => void) => { const res: Any = structuredClone(sm.result), end: Any = structuredClone(sm.end); const others = res.world_events.filter((e: Any) => e.type !== 'source_flow'); res.world_events = [...others, ...edit(res.world_events.filter((e: Any) => e.type === 'source_flow'))]; editEnd?.(end); const r = replaySourceFlows(sm.start, end, res, sm.wp); return r.ok ? true : r.errors[0]; };
const pick = (pred: (f: Any) => boolean) => { const sm = samples.find((x) => x.result.world_events.some((e: Any) => e.type === 'source_flow' && pred(e))); assert.ok(sm, 'no sample day for a counterexample'); return sm!; };
const idx = (f: Any[], pred: (e: Any) => boolean) => { const i = f.findIndex(pred); assert.ok(i >= 0); return i; };
for (const sm of samples.slice(0, 8)) ok(engineAccepts(sm, (f) => f) === true && readerAccepts(sm, (f) => f) === true, `control: an untouched sample day (${sm.result.day}) is accepted by both`);
const both = (name: string, sm: Sample, edit: (f: Any[]) => Any[], opts: { engineToo?: boolean; afterEdit?: (a: Any) => void; endEdit?: (s: Any) => void } = {}) => {
  const e = opts.engineToo === false ? 'not checked by the engine (values are recomputed by the reader only)' : engineAccepts(sm, edit, opts.afterEdit), r = readerAccepts(sm, edit, opts.endEdit);
  if (opts.engineToo !== false) ok(e !== true, `${name}: the engine check rejects it (${e})`);
  ok(r !== true, `${name}: the reader rejects it (${r})`);
};
const isCause = (c: string) => (e: Any) => e.cause === c;
both('N1 a capacity runoff with its event removed (food deleted without an event)', pick(isCause('capacity_runoff')), (f) => f.filter((e) => e.cause !== 'capacity_runoff'));
both('N2 an expired carcass batch with its event removed', pick(isCause('expired_remains')), (f) => f.filter((e) => e.cause !== 'expired_remains'));
both('N3 a washoff event repeated (counted twice)', pick(isCause('rain_washoff')), (f) => { const i = idx(f, isCause('rain_washoff')); return [...f, { ...f[i], id: f[i].id + 'x' }]; });
both('N4 a decomposition flow sent to another source (food moved, not lost)', pick(isCause('decomposition')), (f) => { const i = idx(f, isCause('decomposition')); f[i].to = 'source:F01'; return f; });
both('N5 a runoff relabelled as never existing while the parameter says runoff', pick(isCause('capacity_runoff')), (f) => { const i = idx(f, isCause('capacity_runoff')); Object.assign(f[i], { cause: 'capacity_withheld', from: null, to: null, never_existed: true }); return f; });
both('N6 the same batch both decayed and expired', pick(isCause('decomposition')), (f) => { const i = idx(f, isCause('decomposition')); return [...f, { ...f[i], id: f[i].id + 'x', cause: 'expired_remains' }]; });
both('N7 negative portions', pick(isCause('secretion')), (f) => { const i = idx(f, isCause('secretion')); f[i].portions = -f[i].portions; return f; });
both('N8 a protein flow at a honeydew source', pick((e) => e.cause === 'secretion' && e.site.startsWith('F0')), (f) => { const i = idx(f, isCause('secretion')); f[i].food = 'protein'; return f; });
both('N9 a flow dated another day', pick(isCause('secretion')), (f) => { const i = idx(f, isCause('secretion')); f[i].day += 1; return f; });
both('N10 a stock changed with no flow at all', pick(isCause('secretion')), (f) => f, { afterEdit: (a) => { const k = Object.keys(a).find((id) => a[id].type !== 'carcass')!; a[k].sugar = +(a[k].sugar + 0.1).toFixed(6); }, endEdit: (s) => { const k = Object.keys(s.sources).find((id) => s.sources[id].type !== 'carcass')!; s.sources[k].sugar = +(s.sources[k].sugar + 0.1).toFixed(6); } });
both('N11 a flow at a batch that did not exist', pick(isCause('decomposition')), (f) => { const i = idx(f, isCause('decomposition')); f[i].batch_event_id = 'NAT-NOWHERE'; return f; });
both('N12 secretion inflated and the excess hidden as extra runoff (stock still closes)', pick(isCause('secretion')), (f) => { const i = idx(f, isCause('secretion')); f[i].portions = +(f[i].portions + 0.2).toFixed(6); return [...f, { ...f[i], id: f[i].id + 'r', cause: 'capacity_runoff', from: f[i].to, to: 'loss:capacity_runoff', portions: 0.2 }]; }, { engineToo: false });
{
  const sm = pick(isCause('rain_washoff'));
  ok(readerAccepts(sm, (f) => f.map((e) => e.cause === 'rain_washoff' ? { ...e, portions: +(e.portions * 1.5).toFixed(6) } : e)) !== true, 'N13 a washoff amount that the parameters do not give: the reader rejects it');
}

console.log(JSON.stringify({ test: 'source-flows-v26', checks, real_world_days: realDays, identical_with_switch: `${identical}/${compared}`, flows_by_cause: Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, +v.toFixed(3)])), note: 'engineering checks only; no ecological quantity is validated; all values game portions (assumption: true)' }, null, 2));

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
import { carcassPiles, checkCarcassTakes, checkSourceFlows, growEcology, sourceSum } from '../engine/ecology.ts';
import { calcWeather } from '../engine/weather.ts';
import { replaySourceFlows } from '../cli/lib/source-flow-replay.ts';
import { fixture } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const throws = (f: () => void, re: RegExp) => { try { f(); return false; } catch (e) { return re.test(String(e)); } };
const OFF: Any = loadBundle();
const withFlows = (honeydewWithheld = false, nectarWithheld = false, edit?: (b: Any) => void) => { const b: Any = structuredClone(OFF); Object.assign(b.world.source_flows, { record_source_flows_v26: true, honeydew_capacity_limits_secretion: honeydewWithheld, nectar_capacity_limits_secretion: nectarWithheld }); edit?.(b); return b; };
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
const samples: Sample[] = [], killSamples: Sample[] = [], takeSamples: Sample[] = [], causes: Record<string, number> = {};
let realDays = 0, identical = 0, compared = 0;
const run = (s0on: Any, s0off: Any | null, bon: Any, boff: Any | null, n: number, label: string) => {
  const wp = resolveBundle(bon).world;
  let a = s0on, b = s0off;
  for (let d = 0; d < n; d++) {
    const o: Any = simulateWorldDay(a, bon), r = replaySourceFlows(a, o.state, o.result, wp);
    ok(r.ok, `${label} day ${o.day}: the reader rejects a real day (${r.errors.slice(0, 2).join(' | ')})`);
    realDays++; for (const [k, v] of Object.entries(r.by_cause)) causes[k] = (causes[k] ?? 0) + v;
    if (killSamples.length < 3 && o.result.colonies.some((c: Any) => c.events.some((e: Any) => e.type === 'food_transfer' && e.cause === 'prey_kill'))) killSamples.push({ start: structuredClone(a), end: o.state, result: o.result, wp });
    if (takeSamples.length < 12 && o.result.colonies.some((c: Any) => c.events.some((e: Any) => e.type === 'source_batch_consumed' && a.sources[e.location]?.batches.filter((b: Any) => b.protein > 0.2).length >= 2))) takeSamples.push({ start: structuredClone(a), end: o.state, result: o.result, wp });
    if ((samples.length < 60 || label.startsWith('stock 1.5') && d === 0) && r.flows > 0 && (d % 7 === 3 || Object.keys(r.by_cause).some((k) => k.startsWith('capacity') || k === 'expired_remains'))) samples.push({ start: structuredClone(a), end: o.state, result: o.result, wp });
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
const wetOn = withFlows(false, false, alwaysWet), wetOff: Any = structuredClone(OFF); alwaysWet(wetOff);
run(buildDay0('A1' as Any, 1, '2027-09-23', wetOn).state, buildDay0('A1' as Any, 1, '2027-09-23', wetOff).state, wetOn, wetOff, 30, 'continuous rain');
const atCapacity = (s: Any) => { for (const src of Object.values(s.sources) as Any[]) if (src.type !== 'carcass') { src.sugar = src.capacity; if (src.type === 'nectar') src.bloom_days_left = Math.max(5, src.bloom_days_left); } return s; };
const oldBatches = (s: Any) => { for (const src of Object.values(s.sources) as Any[]) if (src.type === 'carcass') { const c = OFF.world.carcasses.carcass_max_lifetime_days.value; src.batches.push({ event_id: 'TEST-OLD-' + src.id, original_day: s.sim_day + 1 - c - 1, protein: 0.7, age_days: c + 1, origin: 'test: a batch past its edible lifetime' }, { event_id: 'TEST-LAST-' + src.id, original_day: s.sim_day + 1 - c, protein: 0.4, age_days: c, origin: 'test: a batch on its last edible day' }); src.protein = sourceSum(src); } return s; };
const stress = (b: Any) => oldBatches(atCapacity(legacyToWorldState(fixture() as Any, legacyColonyMeta(b.world.scenario_colonies as Any))));
run(stress(ON), stress(OFF), ON, OFF, 20, 'sources at capacity, old carcass batches (honeydew runoff, nectar withheld)');
const flip = withFlows(true, true), flipOff: Any = structuredClone(OFF);
run(stress(flip), stress(flipOff), flip, flipOff, 20, 'sources at capacity (alternative assumption: both withheld)');
// Codex review of 290c440 P2-2: a stock ALREADY above the capacity (e.g. a state written under another capacity) must not
// stop the day when the switch is on; the switch-off run of the same input runs. No washoff, so the excess exceeds the production.
const above = (s: Any) => { for (const src of Object.values(s.sources) as Any[]) if (src.type !== 'carcass') { src.sugar = +(src.capacity * 1.5).toFixed(6); if (src.type === 'nectar') src.bloom_days_left = Math.max(5, src.bloom_days_left); } return s; };
const dry = (b: Any) => { b.world.nectar.nectar_washoff_per_rain_mm.value = 0; b.world.honeydew.honeydew_washoff_per_rain_mm.value = 0; };
for (const [hw, nw] of [[false, false], [true, true]] as const) {
  const bon = withFlows(hw, nw, dry), boff: Any = structuredClone(OFF); dry(boff);
  run(above(buildDay0('A1' as Any, 1, '2027-03-21', bon).state), above(buildDay0('A1' as Any, 1, '2027-03-21', boff).state), bon, boff, 5, `stock 1.5× above capacity, ${hw ? 'withheld' : 'default'} interpretation`);
}
ok(realDays > 1500 && compared === realDays && identical === compared, `AFTER: ${realDays} real world-days — engine check and reader accept every one; with the switch on every stock, draw and colony result equals the switch-off run (${identical}/${compared})`);
ok(['secretion', 'rival_harvest', 'rain_washoff', 'capacity_runoff', 'capacity_resorbed', 'capacity_withheld', 'decomposition', 'expired_remains'].every((k) => (causes[k] ?? 0) > 0), `every cause occurs on real days: ${JSON.stringify(Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, +v.toFixed(3)])))}`);

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
  const start = Object.fromEntries(Object.entries(w.sources).map(([id, s]: [string, Any]) => [id, { type: s.type, food: sourceSum(s), batches: s.type === 'carcass' ? s.batches.map((x: Any) => ({ id: x.event_id, protein: x.protein, original_day: x.original_day })) : [] }]));
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
// Codex review of 290c440 P2-1: carcass totals stay the same, but the next days' supply changes
const carcassSite = (s: Any) => Object.keys(s).find((k) => s[k].type === 'carcass' && s[k].batches.filter((b: Any) => b.protein > 0.05).length >= 2);
const twoBatches = samples.find((x) => carcassSite(x.end.sources) && carcassSite(x.start.sources) === carcassSite(x.end.sources));
assert.ok(twoBatches, 'no sample with two carcass batches');
const moveProtein = (src: Any) => { const bs = src.batches.filter((b: Any) => b.protein > 0.05); bs[0].protein = +(bs[0].protein - 0.05).toFixed(6); bs[1].protein = +(bs[1].protein + 0.05).toFixed(6); };
const redate = (src: Any) => { src.batches.find((b: Any) => b.protein > 0.05).original_day -= 3; };
{
  const k = carcassSite(twoBatches!.end.sources)!;
  for (const [name, edit] of [['N14 protein moved from one carcass batch to another (total unchanged)', moveProtein], ['N15 a carcass batch re-dated three days older (total unchanged)', redate]] as const) {
    const e = engineAccepts(twoBatches!, (f) => f, (a) => { if (a[k].batches.filter((b: Any) => b.protein > 0.05).length >= 2) edit(a[k]); else edit(a[carcassSite(a)!]); }), r = readerAccepts(twoBatches!, (f) => f, (s) => edit(s.sources[k]));
    ok(e !== true, `${name}: the engine check rejects it (${e})`); ok(r !== true, `${name}: the reader rejects it (${r})`);
  }
}
{
  const sm = samples.find((x) => x.wp.source_flows.honeydew_capacity_limits_secretion && x.result.world_events.some((e: Any) => e.cause === 'capacity_withheld') && x.result.world_events.some((e: Any) => e.cause === 'capacity_runoff' || e.cause === 'capacity_resorbed'));
  assert.ok(sm, 'no withheld-mode sample with food above the capacity');
  const lostCause = (e: Any) => e.cause === 'capacity_runoff' || e.cause === 'capacity_resorbed';
  const site = sm!.result.world_events.find((e: Any) => lostCause(e) && sm!.result.world_events.some((x: Any) => x.cause === 'capacity_withheld' && x.site === e.site)).site;
  both('N16 food already above the capacity relabelled as never secreted (Codex P2-2)', sm!, (f) => { const i = idx(f, (e) => lostCause(e) && e.site === site); Object.assign(f[i], { cause: 'capacity_withheld', from: null, to: null, never_existed: true }); return f; });
  both('N17 withheld mode: part of the production kept as secretion while existing food is said to run off', sm!, (f) => { const w0 = f.find((e) => e.cause === 'capacity_withheld' && e.site === site); if (!f.some((e) => e.cause === 'secretion' && e.site === site)) f.push({ ...w0, id: w0.id + 's', cause: 'secretion', from: site.startsWith('F08') || f.some((e) => e.site === site && e.cause === 'capacity_resorbed') ? `producer:flowers:${site}` : `producer:hemipterans:${site}`, to: 'source:' + site, never_existed: undefined, portions: 0 }); const s = idx(f, (e) => e.cause === 'secretion' && e.site === site), w = idx(f, (e) => e.cause === 'capacity_withheld' && e.site === site), l = idx(f, (e) => lostCause(e) && e.site === site); const x = Math.min(0.05, f[w].portions / 2); f[s].portions = +(f[s].portions + x).toFixed(6); f[w].portions = +(f[w].portions - x).toFixed(6); f[l].portions = +(f[l].portions + x).toFixed(6); return f; });
}
// Codex review of ece3bc2 P2: protein moved between batches hidden by forged take records (+0.1 on one batch, −0.1 on another)
{
  assert.ok(takeSamples.length, 'no sample day with a carcass take');
  const takeEngine = (sm: Sample, editEvents: (ev: Any[][]) => void, editEnd: (src: Any) => void) => {
    const w: Any = structuredClone(sm.start); growEcology(w, sm.wp, calcWeather(w, sm.wp, sm.result.date), []);
    const ev: Any[][] = sm.result.colonies.map((c: Any) => structuredClone(c.events)); editEvents(ev); // the per-colony arrays themselves (Codex P3 on 2d25ee8: a splice on a flattened copy was never checked)
    const end: Any = structuredClone(sm.end.sources); editEnd(end);
    try { checkCarcassTakes(carcassPiles(w.sources), ev, end, sm.start.sim_day + 1); return true; } catch (x) { return String(x); }
  };
  const takeReader = (sm: Sample, editEvents: (ev: Any[][]) => void, editEnd: (src: Any) => void) => {
    const res: Any = structuredClone(sm.result), end: Any = structuredClone(sm.end); editEvents(res.colonies.map((c: Any) => c.events)); editEnd(end.sources);
    const r = replaySourceFlows(sm.start, end, res, sm.wp); return r.ok ? true : r.errors[0];
  };
  for (const sm of takeSamples.slice(0, 4)) ok(takeEngine(sm, () => {}, () => {}) === true && takeReader(sm, () => {}, () => {}) === true, `control: a real day with carcass takes (${sm.result.day}) is accepted by both`);
  const sm = takeSamples[0], take = sm.result.colonies.flatMap((c: Any) => c.events).find((e: Any) => e.type === 'source_batch_consumed' && sm.start.sources[e.location].batches.filter((b: Any) => b.protein > 0.2).length >= 2);
  const site = take.location, other = (src: Any) => src[site].batches.find((b: Any) => b.event_id !== take.source_event_id && b.protein > 0.1);
  // edit inside the colony's own event array, so an inserted record is really sent to the checks (Codex P3 on 2d25ee8)
  const inColony = (evs: Any[][], pred: (e: Any) => boolean) => { for (const ev of evs) { const k = ev.findIndex(pred); if (k >= 0) return { ev, k }; } throw Error('record not found'); };
  const isTake = (e: Any) => e.type === 'source_batch_consumed' && e.source_event_id === take.source_event_id && e.worker === take.worker;
  const forge = (evs: Any[][]) => { const { ev, k } = inColony(evs, isTake); ev[k].quantity_portions = +(ev[k].quantity_portions + 0.1).toFixed(6); ev.splice(k + 1, 0, { ...ev[k], source_event_id: other(sm.end.sources).event_id, quantity_portions: -0.1 }); };
  const moveEnd = (src: Any) => { const a = src[site].batches.find((b: Any) => b.event_id === take.source_event_id), b = src[site].batches.find((x: Any) => x.event_id === other(sm.end.sources).event_id); a.protein = +(a.protein - 0.1).toFixed(6); b.protein = +(b.protein + 0.1).toFixed(6); };
  let e = takeEngine(sm, forge, moveEnd), r = takeReader(sm, forge, moveEnd);
  ok(e !== true, `N18 protein moved between batches, hidden by forged take records +0.1 / −0.1 (Codex ece3bc2): the engine check rejects it (${e})`);
  ok(r !== true, `N18 … the reader rejects it (${r})`);
  const relabel = (evs: Any[][]) => { const { ev, k } = inColony(evs, isTake); ev[k].source_event_id = other(sm.end.sources).event_id; };
  const relabelEnd = (src: Any) => { const a = src[site].batches.find((b: Any) => b.event_id === take.source_event_id), b = src[site].batches.find((x: Any) => x.event_id === other(sm.end.sources).event_id); a.protein = +(a.protein + take.quantity_portions).toFixed(6); b.protein = +(b.protein - take.quantity_portions).toFixed(6); };
  e = takeEngine(sm, relabel, relabelEnd); r = takeReader(sm, relabel, relabelEnd);
  ok(e !== true, `N19 a take recorded against another batch than the stored-order rule gives (no negative amount): the engine check rejects it (${e})`);
  ok(r !== true, `N19 … the reader rejects it (${r})`);
}
// independent review of 2d25ee8 (a read-only Claude reviewer, not Codex): records the recomputation depends on
{
  const rd = (sm: Sample, edit: (res: Any, end: Any) => void) => { const res: Any = structuredClone(sm.result), end: Any = structuredClone(sm.end); edit(res, end); const r = replaySourceFlows(sm.start, end, res, sm.wp); return r.ok ? true : r.errors[0]; };
  const eng = (sm: Sample, edit: (res: Any, end: Any) => void) => {
    const w: Any = structuredClone(sm.start); growEcology(w, sm.wp, calcWeather(w, sm.wp, sm.result.date), []);
    const res: Any = structuredClone(sm.result), end: Any = structuredClone(sm.end); edit(res, end);
    try { checkCarcassTakes(carcassPiles(w.sources), res.colonies.map((c: Any) => c.events), end.sources, sm.start.sim_day + 1, sm.wp.prey); return true; } catch (x) { return String(x); }
  };
  const runoff = pick(isCause('capacity_runoff')), rf = runoff.result.world_events.find((e: Any) => e.cause === 'capacity_runoff');
  ok(rd(runoff, (res, end) => { res.world_events = res.world_events.filter((e: Any) => e !== res.world_events.find((x: Any) => x.cause === 'capacity_runoff')); const s = end.sources[rf.site]; s.capacity = +(s.capacity + rf.portions).toFixed(6); s.sugar = +(s.sugar + rf.portions).toFixed(6); s.ecological_record.stock_after = +(s.ecological_record.stock_after + rf.portions).toFixed(6); }) !== true, 'N20 capacity raised in the end state to hide a runoff (the reader must not trust state fields as parameters): the reader rejects it');
  const hd = samples.find((x) => Object.values(x.end.sources).some((s: Any) => s.type === 'honeydew' && s.host_alive && s.hemipteran_colonies > 0))!;
  ok(rd(hd, (_res, end) => { const s: Any = Object.values(end.sources).find((v: Any) => v.type === 'honeydew' && v.host_alive && v.hemipteran_colonies > 0); s.hemipteran_colonies += 1; }) !== true, 'N21 an extra hemipteran colony with no hemipteran_colony_change event: the reader rejects it');
  const nat = samples.find((x) => x.result.world_events.some((e: Any) => e.type === 'new_food_source'))!;
  ok(rd(nat, (res, end) => { const e = res.world_events.find((x: Any) => x.type === 'new_food_source'); e.protein_portions = +(e.protein_portions + 0.5).toFixed(6); const b = end.sources[e.site].batches.find((x: Any) => x.event_id === e.id); b.protein = +(b.protein + 0.5).toFixed(6); end.sources[e.site].protein = +(end.sources[e.site].protein + 0.5).toFixed(6); }) !== true, 'N22 natural remains raised by 0.5 inside the parameter range, with their batch: the reader re-draws the day\'s stream and rejects it');
  assert.ok(killSamples.length, 'no sample day with a kill');
  const kill = killSamples[0], kEdit = (res: Any, end: Any) => { const ev = res.colonies.flatMap((c: Any) => c.events), k = ev.find((e: Any) => e.cause === 'prey_kill'), n = ev.find((e: Any) => e.type === 'new_food_source' && e.id === k.source.id); k.portions = +(k.portions + 0.5).toFixed(6); n.protein_portions = +(n.protein_portions + 0.5).toFixed(6); const b = end.sources[n.site].batches.find((x: Any) => x.event_id === n.id); if (b) b.protein = +(b.protein + 0.5).toFixed(6); };
  let e = eng(kill, kEdit); ok(e !== true, `N23 kill remains, prey_kill transfer and batch all raised by 0.5: the engine check rejects it (${e})`); ok(rd(kill, kEdit) !== true, 'N23 … the reader rejects it');
  const sug = samples.find((x) => x.result.colonies.some((c: Any) => c.events.some((t: Any) => t.cause === 'collect' && t.food_type === 'sugar')) && Object.values(x.start.sources).some((s: Any) => s.type === 'carcass'))!;
  const carc = Object.keys(sug.start.sources).find((k) => sug.start.sources[k].type === 'carcass')!;
  const sEdit = (res: Any) => { const t = res.colonies.flatMap((c: Any) => c.events).find((x: Any) => x.cause === 'collect' && x.food_type === 'sugar'); t.source.id = carc; };
  e = eng(sug, sEdit); ok(e !== true, `N24 a sugar collect relabelled to a carcass source: the engine check rejects it (${e})`); ok(rd(sug, sEdit) !== true, 'N24 … the reader rejects it');
  const tk = takeSamples[0], other = Object.keys(tk.start.sources).find((k) => tk.start.sources[k].type === 'carcass' && !tk.result.colonies.some((c: Any) => c.events.some((x: Any) => x.cause === 'collect' && x.source?.id === k)))!;
  const mEdit = (res: Any) => { const t = res.colonies.flatMap((c: Any) => c.events).find((x: Any) => x.cause === 'collect' && x.food_type === 'protein'); t.source.id = other; };
  e = eng(tk, mEdit); ok(e !== true, `N25 a carcass collect moved to another carcass source (no food_collected there): the engine check rejects it (${e})`); ok(rd(tk, mEdit) !== true, 'N25 … the reader rejects it');
  const aEdit = (_res: Any, end: Any) => { const s: Any = Object.values(end.sources).find((v: Any) => v.type === 'carcass' && v.batches.length); s.batches[0].age_days = 0; };
  e = eng(tk, aEdit); ok(e !== true, `N26 a carcass batch's age_days rewritten: the engine check rejects it (${e})`); ok(rd(tk, aEdit) !== true, 'N26 … the reader rejects it');
}
{
  const sm = pick(isCause('rain_washoff'));
  ok(readerAccepts(sm, (f) => f.map((e) => e.cause === 'rain_washoff' ? { ...e, portions: +(e.portions * 1.5).toFixed(6) } : e)) !== true, 'N13 a washoff amount that the parameters do not give: the reader rejects it');
}

console.log(JSON.stringify({ test: 'source-flows-v26', checks, real_world_days: realDays, identical_with_switch: `${identical}/${compared}`, flows_by_cause: Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, +v.toFixed(3)])), note: 'engineering checks only; no ecological quantity is validated; all values game portions (assumption: true)' }, null, 2));

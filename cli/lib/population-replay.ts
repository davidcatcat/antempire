/**
 * ME-1 independent reader (Issue #66): re-derives the population flow, lifetimes and numeric domains of one colony-day
 * from (start state, end state, events, parameters) WITHOUT the engine's checks (engine/invariants.ts). It is written
 * differently on purpose: it counts per ID how often each kind of event touches it and compares multisets, instead of
 * building the expected end set. Returns located errors; never throws on malformed input. Engineering/mathematical
 * correctness only, not biological validity.
 */
import type { ColonyState, SimEvent } from '../../engine/types.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const isNum = (v: unknown): v is number => typeof v === 'number';
const MINUTES_PER_DAY = 1440;
const STAGES = ['egg', 'larva', 'pupa'];

export interface PopulationReplay { ok: boolean; errors: string[]; flow: { workers: { start: number; deaths: number; eclosions: number; immigration: number; emigration: number; end: number }; brood: { start: number; laid: number; deaths: number; eclosed: number; end: number } } }

/** ID-POP-FLOW, ID-LIFETIME (reader side). */
export function replayPopulationDay(start: ColonyState, end: ColonyState, events: SimEvent[]): PopulationReplay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  // Codex review of 1224744 (C1): malformed input is a located error, never a silent default or an exception
  const zero = { workers: { start: 0, deaths: 0, eclosions: 0, immigration: 0, emigration: 0, end: 0 }, brood: { start: 0, laid: 0, deaths: 0, eclosed: 0, end: 0 } };
  const shapeOk = (c: Any, name: string) => { if (!c || typeof c !== 'object' || !c.population || !Array.isArray(c.population.workers) || !Array.isArray(c.population.brood) || typeof c.population.queen_alive !== 'boolean') { err(`${name}: not a colony state (population.workers/brood arrays and queen_alive required)`); return false; } return true; };
  const okStart = shapeOk(start, 'start'), okEnd = shapeOk(end, 'end');
  if (!Array.isArray(events)) err('events: not an array');
  else events.forEach((e, i) => { if (!e || typeof e !== 'object' || Array.isArray(e)) err(`event ${i}: not an event object`); });
  if (errors.length || !okStart || !okEnd) return { ok: false, errors, flow: zero };
  try { return replayChecked(start, end, events, errors, err); } catch (x) { err(`reader could not replay the input: ${String(x).slice(0, 200)}`); return { ok: false, errors, flow: zero }; }
}
function replayChecked(start: ColonyState, end: ColonyState, events: SimEvent[], errors: string[], err: (m: string) => void): PopulationReplay {
  const ev: Any[] = events as Any[];
  const touches = new Map<string, Record<string, number>>(), bump = (id: unknown, k: string) => { const key = String(id); const r = touches.get(key) ?? {}; r[k] = (r[k] ?? 0) + 1; touches.set(key, r); };
  let queenDeaths = 0;
  // causal order (ID-EVENT-TIME), checked here by position: an ID's first event must be the one that creates it, unless it
  // existed at the start; nothing follows its death; no egg after a queen death
  const firstAt = new Map<string, string>(), endedAt = new Set<string>();
  const order = (id: unknown, k: string) => {
    const key = String(id), existed = start.population.workers.some((w) => w.id === key) || start.population.brood.some((b) => b.id === key);
    if (!firstAt.has(key)) { firstAt.set(key, k); if (!existed && k !== 'eclosed_to' && k !== 'laid') err(`${key}: ${k} before the event that creates it`); }
    if (endedAt.has(key) && k !== 'eclosed_to') err(`${key}: ${k} after it died or eclosed`);
    if (k === 'died' || k === 'brood_died' || k === 'eclosed_from') endedAt.add(key);
  };
  for (const e of ev) {
    if (e.type === 'worker_death') { order(e.id, 'died'); bump(e.id, 'died'); }
    else if (e.type === 'brood_death') { order(e.id, 'brood_died'); bump(e.id, 'brood_died'); }
    else if (e.type === 'eclosion') { order(e.source_brood_id, 'eclosed_from'); order(e.new_worker_id, 'eclosed_to'); bump(e.source_brood_id, 'eclosed_from'); bump(e.new_worker_id, 'eclosed_to'); }
    else if (e.type === 'egg_laid') { if (queenDeaths || !start.population.queen_alive) err(`egg ${e.id} laid by a dead queen`); if (e.queen !== undefined && e.queen !== start.queen_id) err(`egg ${e.id} attributed to ${e.queen}, not to queen ${start.queen_id}`); order(e.id, 'laid'); bump(e.id, 'laid'); }
    else if (e.type === 'hatch') { order(e.id, 'hatched'); bump(e.id, 'hatched'); }
    else if (e.type === 'pupation') { order(e.id, 'pupated'); bump(e.id, 'pupated'); }
    else if (e.type === 'queen_death') { if (String(e.id) !== start.queen_id || end.queen_id !== start.queen_id) err(`queen_death names ${e.id}; this colony's queen is ${start.queen_id}`); queenDeaths++; }
    else if (/migrat|immigr|emigr/.test(String(e.type)) && /worker|brood|ant|queen/.test(JSON.stringify(e))) err(`event ${e.type} moves ants across the colony boundary: not supported by the flow identity yet (D7-A)`);
  }
  const startW = new Map(start.population.workers.map((w) => [w.id, w])), endW = new Map(end.population.workers.map((w) => [w.id, w]));
  const startB = new Map(start.population.brood.map((b) => [b.id, b])), endB = new Map(end.population.brood.map((b) => [b.id, b]));
  if (endW.size !== end.population.workers.length) err('duplicate worker IDs at the end of the day');
  if (endB.size !== end.population.brood.length) err('duplicate brood IDs at the end of the day');
  for (const [id, t] of touches) {
    for (const [k, n] of Object.entries(t)) if (n > 1) err(`${id}: ${k} ${n} times in one day`);
    const was = startW.has(id) || t.eclosed_to === 1, isBrood = startB.has(id) || t.laid === 1;
    if (t.died && !was) err(`${id} dies as a worker but was not one this day`);
    if (t.brood_died && !isBrood) err(`${id} dies as brood but was not brood this day`);
    if (t.eclosed_from && !startB.has(id)) err(`${id} ecloses but was not brood at the start`);
    if (t.eclosed_from && t.brood_died) err(`${id} both ecloses and dies as brood`);
    if ((t.eclosed_to || t.laid) && (startW.has(id) || startB.has(id))) err(`${id} is created but already existed`);
    // where it must be at the end
    const shouldBeWorker = (startW.has(id) || t.eclosed_to === 1) && !t.died, shouldBeBrood = (startB.has(id) || t.laid === 1) && !t.brood_died && !t.eclosed_from;
    if (shouldBeWorker !== endW.has(id)) err(`${id}: worker at the end is ${endW.has(id)}, the events say ${shouldBeWorker}`);
    if (shouldBeBrood !== endB.has(id)) err(`${id}: brood at the end is ${endB.has(id)}, the events say ${shouldBeBrood}`);
  }
  // IDs not touched by any event must be exactly where they were
  for (const id of new Set([...startW.keys(), ...endW.keys()])) if (!touches.has(id) && startW.has(id) !== endW.has(id)) err(`worker ${id} ${endW.has(id) ? 'appears' : 'disappears'} without an event`);
  for (const id of new Set([...startB.keys(), ...endB.keys()])) if (!touches.has(id) && startB.has(id) !== endB.has(id)) err(`brood ${id} ${endB.has(id) ? 'appears' : 'disappears'} without an event`);
  for (const id of endW.keys()) if (endB.has(id)) err(`${id} is both a worker and brood`);
  // fresh IDs: the number of a created ID lies in [counter_start, counter_end)
  const fresh = (prefix: string, id: string, a: number, b: number) => { const m = id.startsWith(prefix) ? id.slice(prefix.length) : ''; const n = /^\d+$/.test(m) ? Number(m) : NaN; return n >= a && n < b; };
  for (const [id, t] of touches) {
    if (t.eclosed_to && !fresh(end.worker_id_prefix, id, start.next_worker_number, end.next_worker_number)) err(`new worker ${id} does not use a fresh number`);
    if (t.laid && !fresh(end.egg_id_prefix, id, start.next_egg_number, end.next_egg_number)) err(`new egg ${id} does not use a fresh number`);
  }
  if (end.next_worker_number < start.next_worker_number || end.next_egg_number < start.next_egg_number) err('an ID counter decreased');
  if (queenDeaths > (start.population.queen_alive ? 1 : 0)) err(`${queenDeaths} queen deaths for a queen that was ${start.population.queen_alive ? 'alive' : 'dead'}`);
  if (end.population.queen_alive !== (start.population.queen_alive && queenDeaths === 0)) err('queen_alive does not follow from the queen_death events');
  for (const [id, b] of endB) { const b0 = startB.get(id); if (b0 && STAGES.indexOf(b.stage) < STAGES.indexOf(b0.stage)) err(`brood ${id}: ${b0.stage} -> ${b.stage}`); }
  // brood lifecycle, by counting: a brood item takes at most one step a day; hatch needs an egg, pupation a larva and
  // eclosion a pupa at the start; the end stage is the start stage moved by the steps it has events for (new eggs: egg)
  for (const [id, t] of touches) {
    const s0 = startB.get(id)?.stage, n = (t.hatched ?? 0) + (t.pupated ?? 0) + (t.eclosed_from ?? 0);
    if (n > 1) err(`brood ${id}: ${n} stage steps in one day`);
    if (t.hatched && s0 !== 'egg') err(`brood ${id}: hatch from ${s0 ?? 'nothing'}`);
    if (t.pupated && s0 !== 'larva') err(`brood ${id}: pupation from ${s0 ?? 'nothing'}`);
    if (t.eclosed_from && s0 !== 'pupa') err(`brood ${id}: eclosion from ${s0 ?? 'nothing'}`);
  }
  for (const [id, b] of endB) {
    const t = touches.get(id) ?? {}, s0 = startB.get(id)?.stage;
    const want = s0 === undefined ? 'egg' : STAGES[Math.min(2, STAGES.indexOf(s0) + (t.hatched ?? 0) + (t.pupated ?? 0))];
    if (b.stage !== want) err(`brood ${id}: ${b.stage} at the end, ${want} from its events`);
  }
  for (const [id, w] of endW) { const w0 = startW.get(id); if (w0 && w.age_days - w0.age_days !== 1) err(`worker ${id}: age ${w0.age_days} -> ${w.age_days}`); }
  // flow totals (reported; the identity is the per-ID check above)
  const cnt = (k: string) => [...touches.values()].reduce((a, t) => a + (t[k] ?? 0), 0);
  const flow = { workers: { start: startW.size, deaths: cnt('died'), eclosions: cnt('eclosed_to'), immigration: 0, emigration: 0, end: endW.size }, brood: { start: startB.size, laid: cnt('laid'), deaths: cnt('brood_died'), eclosed: cnt('eclosed_from'), end: endB.size } };
  if (flow.workers.end !== flow.workers.start - flow.workers.deaths + flow.workers.eclosions + flow.workers.immigration - flow.workers.emigration) err(`worker flow: ${JSON.stringify(flow.workers)}`);
  if (flow.brood.end !== flow.brood.start + flow.brood.laid - flow.brood.deaths - flow.brood.eclosed) err(`brood flow: ${JSON.stringify(flow.brood)}`);
  return { ok: errors.length === 0, errors, flow };
}

/** ID-STATE-DOMAIN, ID-EVENT-DOMAIN, ID-EVENT-TIME (reader side): returns located errors. */
export function domainErrors(colony: ColonyState, events: SimEvent[], cropCapacity: number): string[] {
  const c = colony as Any;
  if (!c || typeof c !== 'object' || !c.population || !Array.isArray(c.population.workers) || !Array.isArray(c.population.brood) || !c.stores || typeof c.stores !== 'object' || !c.trail_by_edge || typeof c.trail_by_edge !== 'object') return ['colony: not a colony state'];
  if (!Array.isArray(events)) return ['events: not an array'];
  try { return domainChecked(colony, events, cropCapacity); } catch (x) { return [`reader could not check the input: ${String(x).slice(0, 200)}`]; }
}
function domainChecked(colony: ColonyState, events: SimEvent[], cropCapacity: number): string[] {
  const out: string[] = [], add = (m: string) => { if (out.length < 50) out.push(m); };
  const stack: [unknown, string][] = [[colony.population, 'population'], [colony.stores, 'stores'], [colony.trail_by_edge, 'trail_by_edge']];
  while (stack.length) {
    const [v, p] = stack.pop()!;
    if (isNum(v)) { if (Number.isNaN(v) || !Number.isFinite(v)) add(`${p} = ${v}`); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stack.push([x, `${p}.${k}`]);
  }
  if (!(colony.stores.sugar >= 0) || !(colony.stores.protein >= 0)) add('a colony store is negative');
  for (const w of colony.population.workers) {
    if (!Number.isInteger(w.age_days) || w.age_days < 0) add(`${w.id}: age ${w.age_days}`);
    const c = w.crop_cargo_sugar ?? 0;
    if (!(c >= 0) || c - cropCapacity > 1e-9) add(`${w.id}: crop ${c} (capacity ${cropCapacity})`);
  }
  for (const b of colony.population.brood) { if (b.age_days !== null && b.age_days !== undefined && !(Number.isInteger(b.age_days) && (b.age_days as number) >= 0)) add(`${b.id}: brood age ${b.age_days}`); if (!STAGES.includes(b.stage)) add(`${b.id}: stage ${b.stage}`); if (!(isNum(b.progress) && b.progress >= 0 && Number.isFinite(b.progress))) add(`${b.id}: progress ${b.progress}`); }
  for (const [e, v] of Object.entries(colony.trail_by_edge)) if (!(v >= 0)) add(`trail ${e} = ${v}`);
  for (const [k, v] of Object.entries(colony.stores)) if (/_days$/.test(k) && !(Number.isInteger(v) && (v as number) >= 0)) add(`stores.${k} = ${v}`);
  (Array.isArray(events) ? events : []).forEach((e: Any, i) => {
    const st: [unknown, string, string, string][] = Object.entries(e ?? {}).map(([k, v]) => [v, k, '', k]);
    while (st.length) {
      const [v, k, parent, p] = st.pop()!;
      if (isNum(v)) {
        const base = k.replace(/_assumption$/, '');
        const prob = ['probability', 'risk', 'p', 'fraction', 'fill'].some((w) => base === w || base.endsWith('_' + w)) || (parent === 'hazards' && !k.endsWith('_days'));
        if (!Number.isFinite(v)) add(`event ${i} ${p} = ${v}`);
        else if (prob && (v < 0 || v > 1)) add(`event ${i} ${p} = ${v} not in [0,1]`);
        else if ((k === 'portions' || k.endsWith('_portions')) && v < 0) add(`event ${i} ${p} = ${v} negative portions`);
        else if (['minute', 'start', 'end', 'walked_from'].includes(k) && (v < 0 || v > MINUTES_PER_DAY)) add(`event ${i} ${p} = ${v} outside the day`);
      } else if (Array.isArray(v)) v.forEach((x, j) => st.push([x, k, parent, `${p}[${j}]`]));
      else if (v && typeof v === 'object') for (const [k2, x] of Object.entries(v)) st.push([x, k2, k, `${p}.${k2}`]);
    }
  });
  return out;
}

/** ID-PARAM-DOMAIN (reader side), on the resolved parameter object, by declared unit/kind (name suffix). */
export function paramDomainErrors(label: string, params: unknown): string[] {
  const out: string[] = [], add = (m: string) => { if (out.length < 50) out.push(m); };
  const kindOf = (path: string, key: string): 'weight' | 'unit' | 'nonneg' | 'any' => {
    if (path.includes('task_allocation') && key.endsWith('_baseline_probability')) return 'weight'; // relative task weights, misnamed
    if (['probability', 'fraction', '_cap', 'hazard', 'persistence', 'retention', 'threshold', 'penalty'].some((s) => key.endsWith(s))) return 'unit';
    if (['_days', '_day', '_minutes', '_portions', '_cost', '_daily', '_capacity', '_store', 'multiplier', 'weight', '_min', '_max', '_initial', '_protein', '_mm', '_mm_s', '_s', 'q10', '_slope', '_base', 'boost'].some((s) => key.endsWith(s))) return 'nonneg';
    return 'any';
  };
  const visit = (v: unknown, path: string, key: string, parent: Any) => {
    if (isNum(v)) {
      if (!Number.isFinite(v)) { add(`${path} = ${v}`); return; }
      const k = kindOf(path, key);
      if (k === 'unit' && (v < 0 || v > 1)) add(`${path} = ${v} outside [0,1]`);
      if ((k === 'nonneg' || k === 'weight') && v < 0) add(`${path} = ${v} negative`);
      if (key.endsWith('q10') && v <= 0) add(`${path} = ${v}: Q10 ≤ 0`);
      if (key.endsWith('_minutes') && v > MINUTES_PER_DAY) add(`${path} = ${v} minutes > one day`);
      if (key.endsWith('_min') && parent && isNum(parent[key.replace(/_min$/, '_max')]) && v > parent[key.replace(/_min$/, '_max')]) add(`${path} = ${v} > its _max`);
      if (key === 'rainfall_gamma_shape' && v < 1) add(`${path} = ${v}: Gamma sampler needs shape ≥ 1`);
    } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}[${i}]`, key, null));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`, k, v);
  };
  visit(params, label, '', null);
  return out;
}

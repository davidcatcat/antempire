/**
 * ME-1 (Issue #66; docs/math-ecology-architecture.md §6): engine-side invariants, an extension of the C2 food checks
 * (engine/transfers.ts). They only CHECK: no state or event is changed, so a valid day's output is byte-identical. A
 * violation throws and the day is not produced. Engineering and mathematical correctness only — passing says nothing
 * about the biology. Registry IDs (docs/math-ecology-model-registry.md §7): ID-POP-FLOW, ID-LIFETIME, ID-EVENT-TIME,
 * ID-STATE-DOMAIN, ID-EVENT-DOMAIN, ID-PARAM-DOMAIN, ID-RNG-INPUT. The independent reader (cli/lib/population-replay.ts)
 * implements the same rules separately.
 */
import type { ColonyState, SimEvent, WorldState, BroodStage } from './types.ts';

/** Minutes in a day: the largest legal `minute` of an event (the activity clock runs inside one day). */
export const DAY_MINUTES = 1440;
const STAGE_ORDER: Record<string, number> = { egg: 0, larva: 1, pupa: 2 };

export interface PopulationSnapshot {
  workers: Map<string, number>; // id -> age_days at the start of the day
  brood: Map<string, BroodStage>;
  queen_alive: boolean;
  queen_id: string;
  next_worker_number: number;
  next_egg_number: number;
}
export function populationSnapshot(c: ColonyState): PopulationSnapshot {
  return {
    workers: new Map(c.population.workers.map((w) => [w.id, w.age_days])),
    brood: new Map(c.population.brood.map((b) => [b.id, b.stage])),
    queen_alive: c.population.queen_alive, queen_id: c.queen_id, next_worker_number: c.next_worker_number, next_egg_number: c.next_egg_number,
  };
}

const idNumber = (prefix: string, id: string): number | null => (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)) ? Number(id.slice(prefix.length)) : null);

/**
 * ID-POP-FLOW and ID-LIFETIME. Population flow identity from the day's own events, independent of the summary counters:
 *   workers_end = workers_start − deaths + eclosions + immigration − emigration     (immigration = emigration = 0:
 *   brood_end   = brood_start − brood deaths − eclosed pupae + eggs laid               no such events exist yet, D7-A)
 *   queen_end   = queen_start ∧ ¬queen_death
 * as exact ID sets, not only counts. Lifetimes: a worker dies at most once, only if it was alive (at the start, or
 * eclosed earlier this day); a new ID was never used (its number ≥ the colony counter at the start, the counter advances
 * past it); brood stages never go backwards; a surviving worker ages exactly one day.
 */
export function checkPopulationDay(start: PopulationSnapshot, colony: ColonyState, events: SimEvent[]): void {
  const fail = (m: string) => { throw Error(`POPULATION ${colony.id}: ${m}`); };
  const deaths = new Set<string>(), broodDeaths = new Set<string>(), eclosedFrom = new Set<string>(), eclosedTo = new Set<string>(), laid = new Set<string>();
  let queenDeaths = 0;
  // causal order (ID-EVENT-TIME): an ID must be created before any later event about it, and no egg is laid by a queen
  // that was dead at the start or died earlier in the list. (The full phase order is not checked; only these.)
  // Brood lifecycle: one stage step at most per brood item and day, each with its event — hatch from an egg, pupation
  // from a larva, eclosion from a pupa (stages as at the start of the day; engine/brood.ts).
  const steps = new Map<string, string>();
  const step = (id: string, kind: string, from: string) => {
    if (steps.has(id)) fail(`brood ${id} changes stage twice in one day (${steps.get(id)}, ${kind})`);
    // Codex review of 1224744 (F2): no stage event after the item's life ended
    if (broodDeaths.has(id)) fail(`brood ${id}: ${kind} after it died`);
    const s0 = start.brood.get(id);
    if (s0 === undefined) fail(`brood ${id}: ${kind} of brood that did not exist at the start of the day`);
    else if (s0 !== from) fail(`brood ${id}: ${kind} from stage ${s0} (needs ${from})`);
    steps.set(id, kind);
  };
  for (const e of events) {
    if (e.type === 'hatch') step(String(e.id), 'hatch', 'egg');
    else if (e.type === 'pupation') step(String(e.id), 'pupation', 'larva');
    if (e.type === 'worker_death') { const id = String(e.id); if (deaths.has(id)) fail(`worker ${id} dies twice`); if (!start.workers.has(id) && !eclosedTo.has(id)) fail(`worker ${id} dies before it exists (no earlier eclosion this day)`); deaths.add(id); }
    else if (e.type === 'brood_death') { const id = String(e.id); if (broodDeaths.has(id)) fail(`brood ${id} dies twice`); if (!start.brood.has(id) && !laid.has(id)) fail(`brood ${id} dies before it exists (no earlier egg_laid this day)`); broodDeaths.add(id); }
    else if (e.type === 'eclosion') {
      const from = String(e.source_brood_id), to = String(e.new_worker_id);
      if (eclosedFrom.has(from)) fail(`brood ${from} ecloses twice`); if (eclosedTo.has(to)) fail(`worker ID ${to} is created twice`);
      if (broodDeaths.has(from)) fail(`brood ${from} ecloses after it died`);
      step(from, 'eclosion', 'pupa');
      eclosedFrom.add(from); eclosedTo.add(to);
    } else if (e.type === 'egg_laid') { const id = String(e.id); if (laid.has(id)) fail(`egg ID ${id} is laid twice`); if (!start.queen_alive || queenDeaths > 0) fail(`egg ${id} is laid by a dead queen`); if (e.queen !== undefined && e.queen !== start.queen_id) fail(`egg ${id} is attributed to queen ${e.queen}, the colony's queen is ${start.queen_id}`); laid.add(id); }
    // Codex review of 1224744 (F1): a queen death is evidence only for the colony's own queen
    else if (e.type === 'queen_death') { if (String(e.id) !== start.queen_id) fail(`queen_death of ${e.id}: the colony's queen is ${start.queen_id}`); queenDeaths++; }
  }
  // Codex review of 852155d (R6-04): the colony's queen keeps her identity on every day (no queen immigration, emigration or
  // replacement event exists yet, D7-A), whether or not she died
  if (colony.queen_id !== start.queen_id) fail(`queen_id changed from ${start.queen_id} to ${colony.queen_id} without any event`);
  // lifetimes: who can die, what can be created
  for (const id of deaths) if (!start.workers.has(id) && !eclosedTo.has(id)) fail(`worker ${id} dies but was not alive this day`);
  for (const id of broodDeaths) if (!start.brood.has(id) && !laid.has(id)) fail(`brood ${id} dies but did not exist this day`);
  for (const id of broodDeaths) if (eclosedFrom.has(id)) fail(`brood ${id} both dies and ecloses`);
  for (const id of eclosedFrom) if (!start.brood.has(id)) fail(`brood ${id} ecloses but was not brood at the start of the day`);
  for (const id of eclosedTo) {
    if (start.workers.has(id) || start.brood.has(id)) fail(`new worker ID ${id} was already in use`);
    const n = idNumber(colony.worker_id_prefix, id);
    if (n === null || n < start.next_worker_number || n >= colony.next_worker_number) fail(`new worker ID ${id} is not a fresh number (counter ${start.next_worker_number} -> ${colony.next_worker_number})`);
  }
  for (const id of laid) {
    if (start.brood.has(id) || start.workers.has(id)) fail(`new egg ID ${id} was already in use`);
    const n = idNumber(colony.egg_id_prefix, id);
    if (n === null || n < start.next_egg_number || n >= colony.next_egg_number) fail(`new egg ID ${id} is not a fresh number (counter ${start.next_egg_number} -> ${colony.next_egg_number})`);
  }
  if (colony.next_worker_number < start.next_worker_number || colony.next_egg_number < start.next_egg_number) fail('an ID counter went backwards');
  if (queenDeaths > 1) fail('the queen dies more than once');
  if (queenDeaths === 1 && !start.queen_alive) fail('a dead queen dies');
  // the flow identity, as ID sets
  const expectWorkers = new Set([...start.workers.keys(), ...eclosedTo].filter((id) => !deaths.has(id)));
  const endWorkers = colony.population.workers.map((w) => w.id), endW = new Set(endWorkers);
  if (endW.size !== endWorkers.length) fail('a worker ID appears twice at the end of the day');
  for (const id of expectWorkers) if (!endW.has(id)) fail(`worker ${id} vanished without a death event`);
  for (const id of endW) if (!expectWorkers.has(id)) fail(`worker ${id} appeared without an eclosion event`);
  const expectBrood = new Set([...start.brood.keys(), ...laid].filter((id) => !broodDeaths.has(id) && !eclosedFrom.has(id)));
  const endBrood = colony.population.brood.map((b) => b.id), endB = new Set(endBrood);
  if (endB.size !== endBrood.length) fail('a brood ID appears twice at the end of the day');
  for (const id of expectBrood) if (!endB.has(id)) fail(`brood ${id} vanished without a death or eclosion event`);
  for (const id of endB) if (!expectBrood.has(id)) fail(`brood ${id} appeared without an egg_laid event`);
  for (const id of endW) if (endB.has(id)) fail(`ID ${id} is both a worker and brood`);
  if (colony.population.queen_alive !== (start.queen_alive && queenDeaths === 0)) fail(`queen_alive is ${colony.population.queen_alive}, the events give ${start.queen_alive && queenDeaths === 0}`);
  // stages never go backwards; survivors age exactly one day
  for (const b of colony.population.brood) {
    const s0 = start.brood.get(b.id), k = steps.get(b.id);
    const expected = s0 === undefined ? 'egg' : k === 'hatch' ? 'larva' : k === 'pupation' ? 'pupa' : s0;
    if (s0 !== undefined && STAGE_ORDER[b.stage] < STAGE_ORDER[s0]) fail(`brood ${b.id} went back from ${s0} to ${b.stage}`);
    if (b.stage !== expected) fail(`brood ${b.id} is ${b.stage} at the end of the day, its events give ${expected}`);
  }
  for (const w of colony.population.workers) { const a0 = start.workers.get(w.id); if (a0 !== undefined && w.age_days !== a0 + 1) fail(`worker ${w.id} aged from ${a0} to ${w.age_days} in one day`); }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** ID-STATE-DOMAIN: every number in a colony's state is finite; counts, ages and stores are non-negative; crops within capacity. */
export function checkColonyDomain(colony: ColonyState, cropCapacity: number): void {
  const fail = (m: string) => { throw Error(`DOMAIN ${colony.id}: ${m}`); };
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail(`${path} is ${v}`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(colony.population, 'population'); walk(colony.stores, 'stores'); walk(colony.trail_by_edge, 'trail_by_edge');
  for (const k of ['sugar', 'protein'] as const) if (!(colony.stores[k] >= 0)) fail(`stores.${k} is ${colony.stores[k]}`);
  for (const k of ['sugar_gap_days', 'protein_gap_days', 'stress_days', 'no_worker_days'] as const) { const v = (colony.stores as unknown as Record<string, unknown>)[k]; if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) fail(`stores.${k} is ${v}, not a count of days`); }
  for (const w of colony.population.workers) {
    if (!(Number.isInteger(w.age_days) && w.age_days >= 0)) fail(`worker ${w.id} age_days ${w.age_days}`);
    const crop = (w.crop_cargo_sugar ?? 0) + (w.crop_cargo_protein_liquid ?? 0); // C3a: one shared crop
    if (!(finite(crop) && crop >= 0 && crop <= cropCapacity + 1e-9)) fail(`worker ${w.id} crop ${crop} outside [0, ${cropCapacity}]`);
  }
  for (const b of colony.population.brood) {
    if (!(b.stage in STAGE_ORDER)) fail(`brood ${b.id} stage ${b.stage}`);
    // Codex review of 1224744 (F3): a known brood age is a non-negative integer; null (unknown, e.g. Day0/migrated) stays allowed
    if (b.age_days !== null && b.age_days !== undefined && !(Number.isInteger(b.age_days) && b.age_days >= 0)) fail(`brood ${b.id} age_days ${b.age_days}`);
    if (!(finite(b.progress) && b.progress >= 0)) fail(`brood ${b.id} progress ${b.progress}`);
  }
  for (const [e, v] of Object.entries(colony.trail_by_edge)) if (!(v >= 0)) fail(`trail ${e} is ${v}`);
}

/**
 * ID-EVENT-DOMAIN and ID-EVENT-TIME: every number in an event is finite; probability-like fields are in [0, 1];
 * portions are ≥ 0; a minute is a time of the day, 0..DAY_MINUTES.
 */
/** Event fields that are probabilities by their name (the engine's own names: risk_assumption, probability_assumption,
 * hazards.*) or fractions in [0, 1]; event fields that are minutes of the day. */
const isProbabilityKey = (key: string, parent: string) => /(^|_)(probability|risk|p|fraction|fill)(_assumption)?$/.test(key) || (parent === 'hazards' && !/_days$/.test(key));
const MINUTE_KEYS: ReadonlySet<string> = new Set(['minute', 'start', 'end', 'walked_from']);
export function checkEventDomain(owner: string, events: SimEvent[]): void {
  const fail = (m: string) => { throw Error(`EVENT_DOMAIN ${owner}: ${m}`); };
  events.forEach((e, i) => {
    const at = `event ${i} (${e.type})`;
    const walk = (v: unknown, key: string, parent: string, path: string): void => {
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) fail(`${at} ${path} is ${v}`);
        if (isProbabilityKey(key, parent) && !(v >= 0 && v <= 1)) fail(`${at} ${path} = ${v} is not a probability`);
        if (/(^|_)portions$/.test(key) && !(v >= 0)) fail(`${at} ${path} = ${v} portions is negative`);
        if (MINUTE_KEYS.has(key) && !(v >= 0 && v <= DAY_MINUTES)) fail(`${at} ${path} = ${v} is outside the day (0..${DAY_MINUTES} minutes)`);
        return;
      }
      if (Array.isArray(v)) { v.forEach((x, j) => walk(x, key, parent, `${path}[${j}]`)); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, key, `${path}.${k}`);
    };
    for (const [k, v] of Object.entries(e)) walk(v, k, '', k);
  });
}

/**
 * ID-PARAM-DOMAIN: resolved parameters by the unit their name declares (species and world parameter files name the
 * unit or kind in the suffix): every number finite; probabilities, fractions, hazard caps, persistence and retention in
 * [0, 1]; days, minutes, portions, costs, capacities, multipliers, weights and Q10 non-negative (Q10 > 0); minutes at most
 * one day; a `_min` never above its `_max`. The rainfall Gamma shape is ≥ 1 (the Marsaglia–Tsang sampler as implemented
 * in engine/rng.ts is valid only there). Throws on the first violation.
 */
export function checkParamDomain(label: string, params: unknown): void {
  const fail = (m: string) => { throw Error(`PARAMS ${label}: ${m}`); };
  const unit = /(probability|fraction|_cap|hazard|persistence|retention|threshold|penalty)$/;
  const nonneg = /(_days|_day|_minutes|_portions|_cost|_daily|_capacity|_store|multiplier|weight|_min|_max|_initial|_protein|_mm|_mm_s|_s|q10|_slope|_base|boost)$/;
  const walk = (v: unknown, path: string, parent: Record<string, unknown> | null, key: string): void => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail(`${path} is ${v}`);
      // declared exceptions to the name rule: the task_allocation *_baseline_probability values are RELATIVE WEIGHTS
      // normalised among the tasks (engine/workers.ts selectTask), not probabilities — misnamed (registry ID-PARAM-DOMAIN)
      if (/_baseline_probability$/.test(key) && path.includes('task_allocation')) { if (!(v >= 0)) fail(`${path} = ${v}: a task weight is negative`); return; }
      if (unit.test(key) && !(v >= 0 && v <= 1)) fail(`${path} = ${v} is outside [0, 1]`);
      if (nonneg.test(key) && !(v >= 0)) fail(`${path} = ${v} is negative`);
      if (/q10$/.test(key) && !(v > 0)) fail(`${path} = ${v}: Q10 must be positive`);
      if (/_minutes$/.test(key) && v > DAY_MINUTES) fail(`${path} = ${v} minutes is longer than a day`);
      if (key.endsWith('_min') && parent) { const mx = parent[key.slice(0, -4) + '_max']; if (typeof mx === 'number' && v > mx) fail(`${path} = ${v} is above ${key.slice(0, -4)}_max = ${mx}`); }
      if (key === 'rainfall_gamma_shape' && !(v >= 1)) fail(`${path} = ${v}: the Gamma sampler needs a shape ≥ 1`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, null, key)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, v as Record<string, unknown>, k);
  };
  walk(params, label, null, '');
}

/** ID-RNG-INPUT: the named streams hash `${seed}|${day}|${tag}`; seed and day must be safe integers for that to be a function of the state. */
export function checkRngInputs(w: WorldState): void {
  if (!Number.isSafeInteger(w.seed)) throw Error(`RNG: seed ${w.seed} is not a safe integer`);
  if (!(Number.isSafeInteger(w.sim_day) && w.sim_day >= 0)) throw Error(`RNG: sim_day ${w.sim_day} is not a non-negative integer`);
}

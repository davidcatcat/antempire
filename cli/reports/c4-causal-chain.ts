/**
 * C4 causal-chain analysis (Owner finding from #114: 68.3% of larva-days have no feeding contact, larval protein intake ≈ 19.4%
 * of need, while large protein stores overflow). REPORT ONLY: no engine change, no parameter change, nothing switched on in
 * the shipped files, no official world. Day0 experiment worlds (非正式), A1 / A3 / A5 × spring / autumn × seeds 1–5 × 60 days,
 * every variant on the same seeds (no seed selection). Every number is a model output under game assumptions — not a field
 * value and not a target (CLAUDE.md §7).
 *
 * The chain, every stage read from the engine's own records (food_transfer ledger, nest_move, larva_contact, larva_nutrition,
 * larva_development, brood_death, discovery) and from the start / end state of each day:
 *   source (state + prey_kill) → discovery → collect (source→in_transit) → carry (in_transit) → unload (in_transit→crop|cache)
 *   → nest store (cache) → nurse obtains (take_from_cache) → queen leg (feed_queen) → nurse contacts larva (larva_contact)
 *   → larva ingests (feed_larva) → larval metabolism (larva_metabolism) → development (larva_development | old colony rule)
 *   and death (brood_death).
 * Each tracked compartment is closed numerically per colony-day: opening + in = out + closing (aggregate and per individual).
 *
 * This module is a READER: it never writes the state it hands to the engine, and it never feeds anything back into a
 * simulation input (tests/c4-causal-chain.test.ts checks both).
 * Usage: node cli/reports/c4-causal-chain.ts   -> reports/c4-causal-chain.json + reports/c4-causal-chain.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDay0 } from '../lib/day0.ts';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { ENGINE_VERSION, simulateWorldDay } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Food = 'sugar' | 'protein';
export const FOUNDINGS = ['A1', 'A3', 'A5'] as const;
export const SEASONS: Record<string, string> = { spring: '2027-03-21', autumn: '2027-09-23' };
export const SEEDS = [1, 2, 3, 4, 5];
export const DAYS = 60;
const FOODS: Food[] = ['sugar', 'protein'];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6, ratio = (a: number, b: number) => (b > 0 ? r6(a / b) : null);
const TRACKED = new Set(['in_transit', 'crop', 'cache', 'nest_unlocated', 'queen_body', 'larva_body']);
const TOL = 2e-5;

/** The compared model variants (each a separate row; all on top of C3a + C4a). v30 forms use TEST values, none is chosen. */
export const VARIANTS: { id: string; label: string; set: (sp: Any) => void }[] = [
  { id: 'base_c3a_c4a', label: 'C3a + C4a (v2-review.28 rules)', set: () => {} },
  { id: 'v29_first_seen_prior', label: 'C3a + C4a + v29 first-seen begging prior', set: (sp) => { sp.larval_feeding.first_seen_begging_prior_v29 = true; } },
  { id: 'v30_c4b_clamp_linear_TEST', label: 'C3a + C4a + v30 C4b clamp_linear (TEST, form not chosen)', set: (sp) => { sp.larval_development.individual_development_c4b = true; sp.larval_development.nutrition_response = 'clamp_linear'; } },
  { id: 'v30_c4b_threshold_0.5_TEST', label: 'C3a + C4a + v30 C4b threshold θ = 0.5 (TEST value, form not chosen)', set: (sp) => { sp.larval_development.individual_development_c4b = true; sp.larval_development.nutrition_response = 'threshold'; sp.larval_development.threshold_theta.value = 0.5; } },
  { id: 'v30_c4b_saturating_K0.5_TEST', label: 'C3a + C4a + v30 C4b saturating K = 0.5 (TEST value, form not chosen)', set: (sp) => { sp.larval_development.individual_development_c4b = true; sp.larval_development.nutrition_response = 'saturating'; sp.larval_development.saturation_k.value = 0.5; } },
  { id: 'v31_nurse_cue_same_place', label: 'C3a + C4a + v31 nurse cue same place', set: (sp) => { sp.local_signals.nurse_cue_same_place_v31 = true; } },
];

export function variantBundle(variant: string): Any {
  const b: Any = structuredClone(loadBundle()), sp = b.species[Object.keys(b.species)[0]];
  sp.queen_feeding.individual_queen_body_c3a = true; sp.larval_feeding.individual_larva_body_c4a = true;
  const v = VARIANTS.find((x) => x.id === variant);
  if (!v) throw Error(`unknown variant ${variant}`);
  v.set(sp);
  return b;
}

/** file:line of a unique anchor in the source (the citation stays correct when the code moves; refuses ambiguous anchors). */
export function cite(file: string, needle: string): string {
  const lines = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n'), hits = lines.flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
  if (hits.length !== 1) throw Error(`cite ${file}: anchor ${JSON.stringify(needle)} found ${hits.length} times`);
  return `${file}:${hits[0]}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// compartments of one colony-day (state → map key kind:id:food)
const k = (kind: string, id: string, f: string) => `${kind}:${id}:${f}`;
function holdings(c: Any): Map<string, number> {
  const m = new Map<string, number>();
  let cropSugar = 0;
  for (const w of c.population.workers) {
    m.set(k('crop', w.id, 'sugar'), w.crop_cargo_sugar || 0); m.set(k('crop', w.id, 'protein'), w.crop_cargo_protein_liquid || 0); cropSugar += w.crop_cargo_sugar || 0;
  }
  m.set(k('cache', c.nest_node, 'protein'), c.stores.protein);
  m.set(k('nest_unlocated', c.id, 'sugar'), c.stores.sugar - cropSugar);
  const q = c.population.queens?.[0];
  if (q) for (const f of FOODS) m.set(k('queen_body', q.id, f), q.body.known_balance[f]);
  for (const b of c.population.brood) if (b.body) for (const f of FOODS) m.set(k('larva_body', b.id, f), b.body.fed_balance[f]);
  return m;
}

interface Closure { compartment_days: number; individual_compartments: number; max_abs_residual: number; failures: string[] }
/** opening + in − out − closing for every tracked compartment of the day, aggregate per kind and per individual. */
function closeDay(start: Any, end: Any, ev: Any[], day: number, acc: Record<string, Closure & { opening: number; in: number; out: number; closing: number }>): void {
  const open = holdings(start), close = holdings(end), flow = new Map<string, { in: number; out: number }>();
  const add = (key: string, side: 'in' | 'out', a: number) => { const x = flow.get(key) ?? { in: 0, out: 0 }; x[side] += a; flow.set(key, x); };
  for (const e of ev) {
    if (e.type === 'queen_body_initialized') for (const f of FOODS) add(k('queen_body', e.queen, f), 'in', e.known_balance[f]); // creation (k × need; 0 here)
    if (e.type !== 'food_transfer') continue;
    if (TRACKED.has(e.source.kind)) add(k(e.source.kind, e.source.id, e.food_type), 'out', e.portions);
    if (TRACKED.has(e.recipient.kind)) add(k(e.recipient.kind, e.recipient.id, e.food_type), 'in', e.portions);
  }
  const keys = new Set([...open.keys(), ...close.keys(), ...flow.keys()]);
  const agg = new Map<string, { opening: number; in: number; out: number; closing: number }>();
  for (const key of [...keys].sort()) {
    const [kind, , f] = key.split(':'), o = open.get(key) ?? 0, c = close.get(key) ?? 0, fl = flow.get(key) ?? { in: 0, out: 0 }, res = o + fl.in - fl.out - c;
    const ak = `${kind}:${f}`, a = agg.get(ak) ?? { opening: 0, in: 0, out: 0, closing: 0 };
    a.opening += o; a.in += fl.in; a.out += fl.out; a.closing += c; agg.set(ak, a);
    const t = (acc[ak] ??= { compartment_days: 0, individual_compartments: 0, max_abs_residual: 0, failures: [], opening: 0, in: 0, out: 0, closing: 0 });
    t.individual_compartments++;
    if (Math.abs(res) > TOL && t.failures.length < 5) t.failures.push(`day ${day} ${key}: residual ${r6(res)}`);
  }
  for (const [ak, a] of agg) {
    const t = acc[ak], res = Math.abs(a.opening + a.in - a.out - a.closing);
    t.compartment_days++; t.max_abs_residual = Math.max(t.max_abs_residual, res); t.opening += a.opening; t.in += a.in; t.out += a.out; t.closing += a.closing;
    if (res > TOL && t.failures.length < 5) t.failures.push(`day ${day} ${ak} aggregate: residual ${r6(res)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
const LARVA_CLASSES = ['fed_protein_need_met', 'fed_protein_partial', 'no_nurse_task_in_colony', 'nurses_not_in_nest_round', 'not_contacted', 'contacted_begging_below_threshold', 'eligible_nurse_no_protein_cache_empty', 'eligible_nurse_no_protein_crop_full', 'eligible_nurse_no_protein_given_to_queen_first', 'eligible_nurse_no_protein_other'] as const;
const NURSE_TAKE = ['took_protein', 'cache_empty', 'crop_full', 'route_b1_off', 'other'] as const;

function emptyTotals(): Any {
  return {
    colony_days: 0,
    source: { protein_standing_at_sources_start_sum: 0, prey_kill_protein: 0 },
    discovery: { discovery_events: 0, scouted_empty_events: 0, by_food_kind: {} as Record<string, number> },
    collect: { sugar: 0, protein: 0, events: { sugar: 0, protein: 0 }, worker_days: { sugar: 0, protein: 0 } },
    carry: { in_transit_residual_max: 0, collect_minus_unload_per_worker_max: 0 },
    unload: { sugar_to_crop: 0, protein_to_cache: 0 },
    cache: { at_round_start_sum: 0, days_with_cache_above_bolus_at_round_start: 0, storage_overflow: 0, days_with_overflow: 0, metabolism_from_cache: 0, lay_egg_from_cache: 0, queen_self_feed: 0, take_from_cache: 0, return_to_cache: 0 },
    nurses: { nurse_task_worker_days: 0, in_round_worker_days: 0, task_nurse_not_in_round: 0, days_with_no_nurse_task: 0, days_with_nurse_task_none_in_round: 0, take: Object.fromEntries(NURSE_TAKE.map((x) => [x, 0])) as Record<string, number>, take_hit_per_nurse_cap: 0, take_cap_sum: 0 },
    queen_leg: { feed_queen_protein: 0, feed_queen_sugar: 0, nurses_gave_all_taken_protein_to_queen: 0, refused: 0 },
    brood_leg: { contacts: 0, contacts_eligible: 0, eligible_nurse_held_protein: 0, eligible_nurse_held_sugar: 0, protein_held_at_contacts: 0, feed_larva_protein: 0, feed_larva_sugar: 0, bolus_capped_protein_feeds: 0, contacts_per_nurse_max: 0, one_bolus_per_nurse_ceiling_protein: 0 },
    larva_days: { total: 0, classes: Object.fromEntries(LARVA_CLASSES.map((x) => [x, 0])) as Record<string, number>, protein_need: 0, protein_intake: 0, sugar_need: 0, sugar_intake: 0, protein_paid: 0, sugar_paid: 0, fed_but_need_above_bolus: 0, on_overflow_days_unfed_protein: 0, with_cache_above_bolus_unfed_protein: 0 },
    development: { c4b_records: 0, c4b_nutrition_factor_sum: 0, old_rule_larva_days: 0, old_rule_full_rate_while_own_protein_paid_below_half: 0, own_protein_shortfall_at_least_half: 0, of_those_colony_protein_gap_reaches_hazard: 0 },
    fate: { pupations: 0, eclosions: 0, larva_deaths: {} as Record<string, number>, larvae_max_consecutive_protein_unfed_days_ge_5: 0, of_those_died_chronic_protein: 0 },
  };
}
const addInto = (a: Any, b: Any) => { for (const [x, v] of Object.entries(b)) { if (typeof v === 'number') a[x] = (a[x] ?? 0) + v; else if (v && typeof v === 'object') addInto((a[x] ??= {}), v); } };
const maxKeys = new Set(['in_transit_residual_max', 'collect_minus_unload_per_worker_max', 'contacts_per_nurse_max']);
function pool(list: Any[]): Any {
  const t = emptyTotals();
  for (const x of list) {
    const y = structuredClone(x);
    for (const kk of maxKeys) { for (const sec of ['carry', 'brood_leg']) if (kk in y[sec]) { t[sec][kk] = Math.max(t[sec][kk], y[sec][kk]); delete y[sec][kk]; } }
    addInto(t, y);
  }
  return t;
}
function roundAll(x: Any): Any { if (typeof x === 'number') return r6(x); if (Array.isArray(x)) return x.map(roundAll); if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([a, b]) => [a, roundAll(b)])); return x; }

/** Analyse one day (read only): start state, engine events, end state. */
function analyseDay(start: Any, end: Any, ev: Any[], summary: Any, sp: Any, t: Any, life: Map<string, { run: number; max: number; died?: string }>, closure: Any, day: number, traces: Any[] | null, discoveredAt: Map<string, Any>): void {
  const c0 = start.colonies[0], c1 = end.colonies[0], nest = c0.nest_node, cap = sp.trophallaxis.crop_capacity.value, takeMax = sp.queen_feeding.take_from_cache_max_portions.value;
  const bolusP = sp.larval_feeding.feed_bolus_protein_portions.value, gapStart = sp.starvation.larva_mortality_starts_days.value, b1 = sp.queen_feeding.route_b1;
  t.colony_days++;
  for (const s of Object.values(start.sources) as Any[]) if (typeof s.protein === 'number') t.source.protein_standing_at_sources_start_sum += s.protein;
  closeDay(c0, c1, ev, day, closure);
  // replay the ledger in event order; snapshot the crops and the cache when the nest round begins
  const bal = holdings(c0), get = (key: string) => bal.get(key) ?? 0;
  for (const e of ev) if (e.type === 'queen_body_initialized') for (const f of FOODS) bal.set(k('queen_body', e.queen, f), get(k('queen_body', e.queen, f)) + e.known_balance[f]);
  let roundStart: Map<string, number> | null = null;
  const firstMove = new Map<string, number>(), took = new Map<string, number>(), toQueenP = new Map<string, number>(), contacts: Any[] = [], perNurse = new Map<string, number>();
  const collectW: Record<Food, Set<string>> = { sugar: new Set(), protein: new Set() }, transit = new Map<string, number>();
  const unloadsToday: Any[] = [], collectsToday: Any[] = [];
  for (const e of ev) {
    const roundish = e.type === 'nest_move' || e.type === 'larva_contact' || e.type === 'queen_contact' || (e.type === 'food_transfer' && e.phase === 'nest_round');
    if (roundish && !roundStart) roundStart = new Map(bal);
    if (e.type === 'discovery') { t.discovery.discovery_events++; t.discovery.by_food_kind[e.food_kind] = (t.discovery.by_food_kind[e.food_kind] ?? 0) + 1; if (!discoveredAt.has(e.site)) discoveredAt.set(e.site, { day, worker: e.worker, minute: e.minute ?? null }); }
    if (e.type === 'scouted_empty') t.discovery.scouted_empty_events++;
    if (e.type === 'nest_move' && !firstMove.has(e.worker)) firstMove.set(e.worker, r6(e.depart_ordinal - 0.5));
    if (e.type === 'queen_feeding_refused') t.queen_leg.refused++;
    if (e.type === 'larva_contact') {
      perNurse.set(e.worker, (perNurse.get(e.worker) ?? 0) + 1);
      contacts.push({ id: e.contact_event_id, worker: e.worker, larva: e.larva, begging: e.begging_signal, threshold: e.feed_threshold_assumption, ordinal: e.ordinal, held: { sugar: get(k('crop', e.worker, 'sugar')), protein: get(k('crop', e.worker, 'protein')) }, fed: { sugar: 0, protein: 0 } });
    }
    if (e.type !== 'food_transfer') continue;
    const a = e.portions;
    if (TRACKED.has(e.source.kind)) bal.set(k(e.source.kind, e.source.id, e.food_type), get(k(e.source.kind, e.source.id, e.food_type)) - a);
    if (TRACKED.has(e.recipient.kind)) bal.set(k(e.recipient.kind, e.recipient.id, e.food_type), get(k(e.recipient.kind, e.recipient.id, e.food_type)) + a);
    switch (e.cause) {
      case 'prey_kill': t.source.prey_kill_protein += a; break;
      case 'collect': t.collect[e.food_type as Food] += a; t.collect.events[e.food_type as Food]++; collectW[e.food_type as Food].add(e.recipient.id); transit.set(e.recipient.id, (transit.get(e.recipient.id) ?? 0) + a); collectsToday.push(e); break;
      case 'unload': if (e.food_type === 'sugar') t.unload.sugar_to_crop += a; else t.unload.protein_to_cache += a; transit.set(e.source.id, (transit.get(e.source.id) ?? 0) - a); unloadsToday.push(e); break;
      case 'storage_overflow': if (e.food_type === 'protein') t.cache.storage_overflow += a; break;
      case 'metabolism': if (e.source.kind === 'cache') t.cache.metabolism_from_cache += a; break;
      case 'lay_egg': if (e.source.kind === 'cache') t.cache.lay_egg_from_cache += a; break;
      case 'queen_self_feed': t.cache.queen_self_feed += a; break;
      case 'take_from_cache': t.cache.take_from_cache += a; took.set(e.recipient.id, (took.get(e.recipient.id) ?? 0) + a); break;
      case 'return_to_cache': t.cache.return_to_cache += a; break;
      case 'feed_queen': if (e.food_type === 'protein') { t.queen_leg.feed_queen_protein += a; toQueenP.set(e.source.id, (toQueenP.get(e.source.id) ?? 0) + a); } else t.queen_leg.feed_queen_sugar += a; break;
      case 'feed_larva': { const cc = contacts.find((x) => x.id === e.contact.contact_event_id); if (cc) cc.fed[e.food_type as Food] += a; if (e.food_type === 'protein') { t.brood_leg.feed_larva_protein += a; if (Math.abs(a - bolusP) < 1e-9) t.brood_leg.bolus_capped_protein_feeds++; } else t.brood_leg.feed_larva_sugar += a; break; }
    }
  }
  for (const f of FOODS) t.collect.worker_days[f] += collectW[f].size;
  t.carry.collect_minus_unload_per_worker_max = Math.max(t.carry.collect_minus_unload_per_worker_max, ...[...transit.values()].map((x) => Math.abs(x)), 0);
  // the nest round: who took part, why a nurse took no protein
  const tasksNurse = summary.tasks?.nurse ?? 0, nurses = [...firstMove.entries()].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  t.nurses.nurse_task_worker_days += tasksNurse; t.nurses.in_round_worker_days += nurses.length; t.nurses.task_nurse_not_in_round += Math.max(0, tasksNurse - nurses.length);
  if (tasksNurse === 0) t.nurses.days_with_no_nurse_task++; else if (nurses.length === 0) t.nurses.days_with_nurse_task_none_in_round++;
  const rs = roundStart ?? bal, cacheAtRound = rs.get(k('cache', nest, 'protein')) ?? 0;
  t.cache.at_round_start_sum += cacheAtRound; if (cacheAtRound >= bolusP) t.cache.days_with_cache_above_bolus_at_round_start++;
  if ((ev.some((e) => e.type === 'food_transfer' && e.cause === 'storage_overflow' && e.food_type === 'protein'))) t.cache.days_with_overflow++;
  let cacheLeft = cacheAtRound;
  const whyNoTake = new Map<string, string>();
  for (const [w] of nurses) {
    const a = took.get(w) ?? 0, held = (rs.get(k('crop', w, 'sugar')) ?? 0) + (rs.get(k('crop', w, 'protein')) ?? 0);
    t.nurses.take_cap_sum += takeMax;
    const why = a > 0 ? 'took_protein' : !b1 ? 'route_b1_off' : cacheLeft <= 1e-9 ? 'cache_empty' : cap - held <= 1e-9 ? 'crop_full' : 'other';
    t.nurses.take[why]++; whyNoTake.set(w, why); if (a > 0 && Math.abs(a - takeMax) < 1e-9) t.nurses.take_hit_per_nurse_cap++;
    if (a > 0 && (toQueenP.get(w) ?? 0) >= a - 1e-9) t.queen_leg.nurses_gave_all_taken_protein_to_queen++;
    cacheLeft -= a;
  }
  // the brood leg: contacts
  t.brood_leg.contacts += contacts.length; t.brood_leg.contacts_per_nurse_max = Math.max(t.brood_leg.contacts_per_nurse_max, ...perNurse.values(), 0);
  const reason = (c: Any): string => {
    if (c.held.protein > 1e-9) return 'eligible_nurse_no_protein_other';
    const w = whyNoTake.get(c.worker);
    if (w === 'took_protein') return 'eligible_nurse_no_protein_given_to_queen_first';
    if (w === 'cache_empty') return 'eligible_nurse_no_protein_cache_empty';
    if (w === 'crop_full') return 'eligible_nurse_no_protein_crop_full';
    return 'eligible_nurse_no_protein_other';
  };
  for (const c of contacts) {
    t.brood_leg.protein_held_at_contacts += c.held.protein;
    if (c.begging >= c.threshold) { t.brood_leg.contacts_eligible++; if (c.held.protein > 1e-9) t.brood_leg.eligible_nurse_held_protein++; if (c.held.sugar > 1e-9) t.brood_leg.eligible_nurse_held_sugar++; }
  }
  // larva-days: the first stage at which the protein chain stopped
  if (ev.some((e) => e.type === 'larva_nutrition')) t.brood_leg.one_bolus_per_nurse_ceiling_protein += nurses.length * bolusP;
  const overflowDay = ev.some((e) => e.type === 'food_transfer' && e.cause === 'storage_overflow' && e.food_type === 'protein');
  const devOf = new Map(ev.filter((e) => e.type === 'larva_development').map((e) => [e.larva, e]));
  const gapEnd = c1.stores.protein_gap_days, ratios = summary.ratios ?? { sugar: 1, protein: 1 };
  for (const e of ev.filter((x) => x.type === 'larva_nutrition')) {
    const L = t.larva_days; L.total++;
    L.protein_need += e.need_portions.protein; L.protein_intake += e.intake_portions.protein; L.sugar_need += e.need_portions.sugar; L.sugar_intake += e.intake_portions.sugar; L.protein_paid += e.paid_portions.protein; L.sugar_paid += e.paid_portions.sugar;
    const mine = contacts.filter((c) => c.larva === e.larva);
    let cls: string;
    if (e.intake_portions.protein > 0) { cls = e.intake_portions.protein >= e.need_portions.protein - 1e-9 ? 'fed_protein_need_met' : 'fed_protein_partial'; if (e.need_portions.protein > bolusP + 1e-9) L.fed_but_need_above_bolus++; }
    else if (tasksNurse === 0) cls = 'no_nurse_task_in_colony';
    else if (nurses.length === 0) cls = 'nurses_not_in_nest_round';
    else if (!mine.length) cls = 'not_contacted';
    else { const el = mine.find((c) => c.begging >= c.threshold); cls = el ? reason(el) : 'contacted_begging_below_threshold'; }
    L.classes[cls]++;
    if (e.intake_portions.protein <= 0) { if (overflowDay) L.on_overflow_days_unfed_protein++; if (cacheAtRound >= bolusP) L.with_cache_above_bolus_unfed_protein++; }
    const paidFrac = e.need_portions.protein > 0 ? e.paid_portions.protein / e.need_portions.protein : 1, D = t.development;
    const dv = devOf.get(e.larva);
    if (dv) { D.c4b_records++; D.c4b_nutrition_factor_sum += dv.nutrition_factor; }
    else { D.old_rule_larva_days++; const mult = Math.max(sp.development.larva_min_nutrition_growth_factor.value, Math.min(ratios.protein, ratios.sugar)); if (mult >= 0.995 && paidFrac < 0.5) D.old_rule_full_rate_while_own_protein_paid_below_half++; }
    if (e.own_protein_shortfall_fraction >= 0.5) { D.own_protein_shortfall_at_least_half++; if (gapEnd >= gapStart) D.of_those_colony_protein_gap_reaches_hazard++; }
    const lf = life.get(e.larva) ?? { run: 0, max: 0 }; lf.run = e.intake_portions.protein > 0 ? 0 : lf.run + 1; lf.max = Math.max(lf.max, lf.run); life.set(e.larva, lf);
  }
  for (const e of ev) {
    if (e.type === 'pupation') t.fate.pupations++;
    if (e.type === 'eclosion') t.fate.eclosions++;
    if (e.type === 'brood_death' && e.stage === 'larva') { t.fate.larva_deaths[e.reason] = (t.fate.larva_deaths[e.reason] ?? 0) + 1; const lf = life.get(e.id); if (lf) lf.died = e.reason; }
  }
  // example chains (protein that reached a larva): every link with its record id; the cache is a POOL, so the link from an
  // unload to a take is pool-level (no parcel identity in the engine), never a claimed individual parcel
  if (traces && traces.length < 3 && unloadsToday.some((e) => e.food_type === 'protein')) for (const c of contacts) {
    if (traces.length >= 3 || c.fed.protein <= 0) continue;
    const takeEv = ev.find((e) => e.type === 'food_transfer' && e.cause === 'take_from_cache' && e.recipient.id === c.worker);
    const feedEv = ev.find((e) => e.type === 'food_transfer' && e.cause === 'feed_larva' && e.food_type === 'protein' && e.contact.contact_event_id === c.id);
    const metab = ev.filter((e) => e.type === 'food_transfer' && e.cause === 'larva_metabolism' && e.source.id === c.larva).map((e) => ({ transfer_id: e.transfer_id, food: e.food_type, portions: e.portions }));
    const nut = ev.find((e) => e.type === 'larva_nutrition' && e.larva === c.larva), dv = devOf.get(c.larva);
    const unl = unloadsToday.filter((e) => e.food_type === 'protein').slice(0, 4).map((e) => { const col = collectsToday.find((x) => x.recipient.id === e.source.id && x.food_type === 'protein' && (x.minute ?? -1) <= (e.minute ?? Infinity)); return { unload: { transfer_id: e.transfer_id, worker: e.source.id, minute: e.minute, site: e.contact?.site, portions: e.portions }, collect: col ? { transfer_id: col.transfer_id, worker: col.recipient.id, minute: col.minute, site: col.source.id, portions: col.portions } : null, site_first_discovery_in_run: discoveredAt.get(e.contact?.site) ?? null }; });
    traces.push({ day, larva: c.larva, nurse: c.worker,
      stages: {
        source_to_unload_today_pool_level: unl, cache_at_round_start: r6(cacheAtRound), cache_opening: r6(c0.stores.protein),
        nurse_obtains: takeEv ? { transfer_id: takeEv.transfer_id, ordinal: takeEv.ordinal, portions: takeEv.portions, location: takeEv.contact?.location } : null,
        queen_leg_protein_from_this_nurse: r6(toQueenP.get(c.worker) ?? 0),
        nurse_contacts_larva: { contact_event_id: c.id, ordinal: c.ordinal, begging: c.begging, threshold: c.threshold, nurse_crop_protein_at_contact: r6(c.held.protein) },
        larva_ingests: feedEv ? { transfer_id: feedEv.transfer_id, ordinal: feedEv.ordinal, portions: feedEv.portions } : null,
        larval_metabolism: metab, larva_nutrition: nut ? { need: nut.need_portions, intake: nut.intake_portions, paid: nut.paid_portions, shortfall: nut.shortfall_portions } : null,
        development: dv ? { rule: 'C4b own account', own_paid_fraction: dv.own_paid_fraction, nutrition_factor: dv.nutrition_factor, progress_after: dv.progress_after } : { rule: 'old colony-wide factor (brood.ts L2)', colony_ratios: ratios },
      },
      provenance_note: 'unload -> cache -> take is pool-level: the cache holds one undifferentiated amount (engine/nutrition.ts handoff), so which unload a taken portion came from is not recorded by the engine and is not inferred here' });
  }
}

/** One world (read only). `onDay` (tests): sees the day's input state before and after the analysis, and the next state. */
export function runOne(variant: string, founding: string, season: string, seed: number, withTraces = false, onDay?: (inputBefore: string, inputAfter: string, next: Any) => void): Any {
  const b = variantBundle(variant), sp = b.species[Object.keys(b.species)[0]];
  let s: Any = buildDay0(founding as Any, seed, SEASONS[season], b).state;
  if (s.colonies.length !== 1) throw Error('Day0 experiment world with one colony expected');
  const t = emptyTotals(), life = new Map<string, { run: number; max: number; died?: string }>(), closure: Any = {}, traces: Any[] | null = withTraces ? [] : null, discoveredAt = new Map<string, Any>();
  for (let d = 0; d < DAYS; d++) {
    const o: Any = simulateWorldDay(s, b), c = o.result.colonies[0], before = onDay ? JSON.stringify(s) : '';
    analyseDay(s, o.state, c.events, c.summary, sp, t, life, closure, o.day, traces, discoveredAt);
    if (onDay) onDay(before, JSON.stringify(s), o.state);
    s = o.state;
  }
  for (const lf of life.values()) if (lf.max >= 5) { t.fate.larvae_max_consecutive_protein_unfed_days_ge_5++; if (lf.died === 'chronic_protein_shortage_game_scenario') t.fate.of_those_died_chronic_protein++; }
  const cons = Object.fromEntries(Object.entries(closure).sort().map(([kk, v]: [string, Any]) => [kk, { compartment_days: v.compartment_days, individual_compartment_days: v.individual_compartments, opening_plus_in: r6(v.opening + v.in), out_plus_closing: r6(v.out + v.closing), max_abs_residual_per_day: v.max_abs_residual < 1e-9 ? 0 : r6(v.max_abs_residual), failures: v.failures }]));
  return { totals: t, conservation: cons, traces, end: { workers: s.colonies[0].population.workers.length, larvae: s.colonies[0].population.brood.filter((x: Any) => x.stage === 'larva').length, queen_alive: s.colonies[0].population.queen_alive } };
}

function derived(t: Any): Any {
  const L = t.larva_days, cl = L.classes;
  return {
    share_larva_days_no_feeding_contact: ratio(cl.no_nurse_task_in_colony + cl.nurses_not_in_nest_round + cl.not_contacted, L.total),
    larval_protein_intake_over_need: ratio(L.protein_intake, L.protein_need), larval_sugar_intake_over_need: ratio(L.sugar_intake, L.sugar_need),
    share_larva_days_fed_protein: ratio(cl.fed_protein_need_met + cl.fed_protein_partial, L.total),
    protein_unloaded_over_larval_need: ratio(t.unload.protein_to_cache, L.protein_need), protein_overflow_over_larval_need: ratio(t.cache.storage_overflow, L.protein_need),
    protein_to_larvae_over_unloaded: ratio(t.brood_leg.feed_larva_protein, t.unload.protein_to_cache), protein_to_larvae_over_taken: ratio(t.brood_leg.feed_larva_protein, t.cache.take_from_cache),
    taken_given_to_queen_share: ratio(t.queen_leg.feed_queen_protein, t.cache.take_from_cache), taken_returned_share: ratio(t.cache.return_to_cache, t.cache.take_from_cache),
    nurse_take_ceiling_over_larval_need: ratio(t.nurses.take_cap_sum, L.protein_need), one_contact_one_bolus_ceiling_over_larval_need: ratio(t.brood_leg.one_bolus_per_nurse_ceiling_protein, L.protein_need),
    mean_nurses_in_round_per_day: ratio(t.nurses.in_round_worker_days, t.colony_days), contacts_per_larva_day: ratio(t.brood_leg.contacts, L.total),
    share_eligible_contacts_nurse_held_protein: ratio(t.brood_leg.eligible_nurse_held_protein, t.brood_leg.contacts_eligible),
    share_unfed_larva_days_with_cache_above_one_bolus: ratio(L.with_cache_above_bolus_unfed_protein, L.total - cl.fed_protein_need_met - cl.fed_protein_partial),
    old_rule_full_rate_share_while_underfed: ratio(t.development.old_rule_full_rate_while_own_protein_paid_below_half, t.development.old_rule_larva_days),
    c4b_mean_nutrition_factor: ratio(t.development.c4b_nutrition_factor_sum, t.development.c4b_records),
    underfed_larva_days_with_colony_hazard_share: ratio(t.development.of_those_colony_protein_gap_reaches_hazard, t.development.own_protein_shortfall_at_least_half),
  };
}

/** The protein bottleneck table: stage → portions or counts, pooled (one variant). */
function bottleneck(t: Any): Any {
  const L = t.larva_days, cl = L.classes, fed = cl.fed_protein_need_met + cl.fed_protein_partial;
  const portions = [
    ['1 source: prey killed into a source (prey_kill)', t.source.prey_kill_protein],
    ['2 collect: source → in_transit (collect)', t.collect.protein],
    ['3 carry + 4 unload: in_transit → cache (unload)', t.unload.protein_to_cache],
    ['5 nest store at round start (Σ over days, state replay)', t.cache.at_round_start_sum],
    ['6 nurse obtains: cache → crop (take_from_cache)', t.cache.take_from_cache],
    ['6a queen leg first: crop → queen_body (feed_queen protein)', t.queen_leg.feed_queen_protein],
    ['7 held by nurses at larva contacts (replay)', t.brood_leg.protein_held_at_contacts],
    ['8 larva ingests: crop → larva_body (feed_larva protein)', t.brood_leg.feed_larva_protein],
    ['9 larval metabolism paid (larva_metabolism protein)', L.protein_paid],
    ['   larval need (larva_nutrition need)', L.protein_need],
    ['   put back: crop → cache (return_to_cache)', t.cache.return_to_cache],
    ['   lost: cache → loss:storage_overflow', t.cache.storage_overflow],
    ['   aggregate metabolism from cache (workers, F01)', t.cache.metabolism_from_cache],
    ['   eggs from cache (lay_egg, A08)', t.cache.lay_egg_from_cache],
  ].map(([stage, v]) => ({ stage, protein_portions: r6(v as number) }));
  const larvaDays = [
    ['larva-days (larva_nutrition records)', L.total],
    ['  a colony with no nurse task that day', cl.no_nurse_task_in_colony],
    ['  nurse task but no nurse in the nest round (not at the nest)', cl.nurses_not_in_nest_round],
    ['  nurses in the round but this larva not drawn', cl.not_contacted],
    ['  contacted, begging below threshold', cl.contacted_begging_below_threshold],
    ['  eligible contact, nurse holds no protein: the cache was empty at its turn', cl.eligible_nurse_no_protein_cache_empty],
    ['  eligible contact, nurse holds no protein: its crop was full (sugar)', cl.eligible_nurse_no_protein_crop_full],
    ['  eligible contact, nurse holds no protein: it gave all to the queen first', cl.eligible_nurse_no_protein_given_to_queen_first],
    ['  eligible contact, nurse holds no protein: other', cl.eligible_nurse_no_protein_other],
    ['  fed protein, less than need', cl.fed_protein_partial],
    ['  fed protein, need met', cl.fed_protein_need_met],
  ].map(([stage, v]) => ({ stage, larva_days: v, share: ratio(v as number, L.total) }));
  return { protein_portions: portions, larva_days: larvaDays, fed_larva_days: fed };
}

/** Static audit: what each decision or physiology function reads (source text of the function). Reader facts, not a fix. */
export function localityAudit(): Any {
  const fn = (file: string, name: string): string => {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'), i = src.indexOf(`export function ${name}(`);
    if (i < 0) throw Error(`${file}: ${name} not found`);
    const j = src.indexOf('\nexport ', i + 10);
    return src.slice(i, j < 0 ? undefined : j);
  };
  const rows: [string, string, string][] = [
    ['engine/workers.ts', 'selectTask', 'task choice (who nurses)'], ['engine/workers.ts', 'nurseContact', 'nurse begging cue (task signal)'],
    ['engine/queen-feeding.ts', 'nestRound', 'nurse takes protein, queen leg'], ['engine/larva-feeding.ts', 'broodLeg', 'nurse meets and feeds one larva'],
    ['engine/larva-feeding.ts', 'larvaMetabolism', 'larval metabolism and begging'], ['engine/brood.ts', 'developBrood', 'larval development and death'],
  ];
  // colony-wide quantities, and whether the function only WRITES them (ledger bookkeeping) or READS them into a choice
  const TOKENS: [string, RegExp][] = [
    ['colony.stores.protein_gap_days', /colony\.stores\.protein_gap_days/], ['colony.stores.sugar_gap_days', /colony\.stores\.sugar_gap_days/], ['stress_days', /stress_days/],
    ['ratios.pFraction', /ratios\.pFraction/], ['ratios.sFraction', /ratios\.sFraction/],
    ['colony.stores.protein (read)', /colony\.stores\.protein(?![_\w])(?!\s*=[^=])/], ['colony.stores.sugar (read other than its own decrement)', /(?<!colony\.stores\.sugar = round\()colony\.stores\.sugar(?![_\w])(?!\s*=[^=])(?! - a\))/],
    ['population.workers.length', /population\.workers\.length/], ['summary.', /\bsummary\./],
  ];
  const NOTE: Record<string, string> = {
    selectTask: 'own crop fill, own contact impressions (local_sensory), own age and injury, weather; no colony total',
    nurseContact: 'draws one larva (all larvae of the colony when v31 is off; only the brood place when on); no colony total',
    nestRound: 'the amount taken is min(cap, own crop room, colony.stores.protein): the nurse perceives the store it stands at; with ONE store per nest that store IS the colony protein total (stated equivalence, design C3a); stores.sugar is only decremented (bookkeeping)',
    broodLeg: 'larva begging, threshold, own crop; here.length is the denominator of the uniform draw among larvae at the same place (D7 dilution, local); stores.sugar only decremented',
    larvaMetabolism: 'own fed_balance, own intake, own need; no colony total',
    developBrood: 'READS colony totals into individual development (ratios, L2 without C4b) and death (protein_gap_days, L3); care = whether the colony had any worker (C4b §4) — known defects Issue #43 A08 / C4c',
  };
  return rows.map(([file, name, role]) => { const body = fn(file, name); return { function: `${file} ${name}`, role, colony_quantities_read: TOKENS.filter(([, re]) => re.test(body)).map(([x]) => x), note: NOTE[name] }; });
}

/** Code facts with file:line (anchors resolved against the current source). */
export function codeFacts(): Any[] {
  return [
    { fact: 'one nest round per colony per day (the only route by which food reaches a larva)', where: cite('engine/day.ts', 'if (q3) q3.round = nestRound(s, colony, sp, events);'), kind: 'fixed count' },
    { fact: "only workers with task 'nurse' whose last_location is the nest node take part", where: cite('engine/queen-feeding.ts', "const nurses = colony.population.workers.filter((w) => w.task === 'nurse' && w.last_location === nest)"), kind: 'eligibility' },
    { fact: 'a nurse takes at most take_from_cache_max_portions (0.28, game assumption) once per round, limited by its crop room', where: cite('engine/queen-feeding.ts', 'const a = round(Math.min(qf.take_from_cache_max_portions, Math.max(0, cap - cropHeld(w)), colony.stores.protein));'), kind: 'per-day cap' },
    { fact: 'one take per nurse per round is enforced by the engine check', where: cite('engine/queen-feeding.ts', 'takes from the store twice'), kind: 'fixed count' },
    { fact: 'the queen leg comes BEFORE the brood leg; up to feed_max_portions_per_contact (0.28) liquid protein goes to the queen first', where: cite('engine/queen-feeding.ts', 'const a = round(Math.min(held, qf.feed_max_portions_per_contact));'), kind: 'order' },
    { fact: 'the brood leg runs after the queen leg', where: cite('engine/queen-feeding.ts', 'if (c4a) out.larvae = broodLeg('), kind: 'order' },
    { fact: 'each nurse meets exactly ONE larva per round (uniform draw among larvae at the brood place)', where: cite('engine/larva-feeding.ts', "larva = here[Math.floor(colonyDice(world, colony, 'c4a_larva_contact:' + w.id)() * here.length)]"), kind: 'per-day cap' },
    { fact: 'at most one fixed bolus per food per contact (protein bolus 0.08 = larva_protein_daily at the reference temperature)', where: cite('engine/larva-feeding.ts', 'a = round(Math.min(held, bolus[f]));'), kind: 'per-contact cap' },
    { fact: 'larval need scales with the metabolic factor (Q10) while the bolus is fixed: one feeding cannot meet need above the reference temperature', where: cite('engine/larva-feeding.ts', 'const larvaNeed = (sp: SpeciesParams, factor: number): Food =>'), kind: 'mismatch' },
    { fact: 'liquid protein still held at the end of the round goes back to the store (crops hold none overnight)', where: cite('engine/queen-feeding.ts', 'w.crop_cargo_protein_liquid = 0; colony.stores.protein = round(colony.stores.protein + a);'), kind: 'rule' },
    { fact: 'one task per worker per day from a weighted lottery; nurse weight 0.25 × (1 + 0.65 × own begging cue) (game assumptions)', where: cite('engine/workers.ts', 'const care = t.nurse_baseline_probability * (1 + t.brood_begging_nurse_boost * v.broodBegging)'), kind: 'task choice' },
    { fact: 'the task lottery is drawn for every worker every day (no persistence)', where: cite('engine/foraging.ts', 'worker.task = selectTask(world, colony, sp, worker, weather); worker.age_days++;'), kind: 'task choice' },
    { fact: 'the begging CUE contact is a second, independent draw (probability 0.75) — not the feeding contact; the larva that sets the cue need not be the larva fed', where: cite('engine/workers.ts', 'if (larvae.length && g() < sp.local_signals.nurse_larva_contact_probability) {'), kind: 'two contact systems' },
    { fact: 'protein store capacity 12 + 0.3 per worker above 14 (game assumptions); the excess is lost', where: cite('engine/nutrition.ts', 'protein: round(Math.max(0, colony.stores.protein - (n.max_protein_store + extra * n.protein_store_per_extra_worker))),'), kind: 'sink' },
    { fact: 'under C4a the colony protein fraction no longer includes the larvae (servedLarvae = 0)', where: cite('engine/nutrition.ts', 'servedLarvae = workers > 0 && !c4a ? larvae.length : 0;'), kind: 'decoupling' },
    { fact: 'without C4b a larva develops from the COLONY fractions min(pFraction, sFraction) (L2, colony total into an individual)', where: cite('engine/brood.ts', 'Math.max(dev.larva_min_nutrition_growth_factor, Math.min(ratios.pFraction, ratios.sFraction))'), kind: 'colony total (known defect L2)' },
    { fact: 'larval starvation death uses the COLONY protein_gap_days (L3, colony total into an individual; C4c pending)', where: cite('engine/brood.ts', "if (b.stage === 'larva' && colony.stores.protein_gap_days >= st.larva_mortality_starts_days) {"), kind: 'colony total (known defect L3)' },
    { fact: 'care for brood = whether the colony had ANY worker at the start of the step (not individual contact)', where: cite('engine/brood.ts', 'const noCare = () => (snapshot ? workersAtStart : pop.workers.length) === 0;'), kind: 'colony total (known limit, C4b §4)' },
  ];
}

export function generate(): Any {
  const rows: Any[] = [];
  for (const v of VARIANTS) for (const founding of FOUNDINGS) for (const season of Object.keys(SEASONS)) for (const seed of SEEDS) {
    const withTraces = v.id === 'base_c3a_c4a' && season === 'spring' && seed === 1;
    const r = runOne(v.id, founding, season, seed, withTraces);
    rows.push({ variant: v.id, founding, season, seed, totals: roundAll(r.totals), derived: derived(r.totals), conservation: r.conservation, end: r.end, ...(withTraces ? { example_chains: roundAll(r.traces) } : {}) });
  }
  const pooled: Any = {};
  for (const v of VARIANTS) {
    const sel = rows.filter((r) => r.variant === v.id), t = pool(sel.map((r) => r.totals));
    pooled[v.id] = { label: v.label, runs: sel.length, totals: roundAll(t), derived: derived(t), bottleneck: bottleneck(t), by_founding: Object.fromEntries(FOUNDINGS.map((f) => [f, derived(pool(sel.filter((r) => r.founding === f).map((r) => r.totals)))])), by_season: Object.fromEntries(Object.keys(SEASONS).map((se) => [se, derived(pool(sel.filter((r) => r.season === se).map((r) => r.totals)))])) };
  }
  const base = rows.filter((r) => r.variant === 'base_c3a_c4a'), same = (r: Any) => { const b0 = base.find((x) => x.founding === r.founding && x.season === r.season && x.seed === r.seed); return JSON.stringify(b0.totals) === JSON.stringify(r.totals); };
  const identical_totals_to_base = Object.fromEntries(VARIANTS.map((v) => [v.id, rows.filter((r) => r.variant === v.id && same(r)).length + ' / ' + rows.filter((r) => r.variant === v.id).length]));
  const conservation = { compartment_kinds: [...new Set(rows.flatMap((r) => Object.keys(r.conservation)))].sort(), compartment_days_checked: rows.reduce((a, r) => a + Object.values(r.conservation).reduce((b: number, c: Any) => b + c.compartment_days, 0), 0), individual_compartment_days_checked: rows.reduce((a, r) => a + Object.values(r.conservation).reduce((b: number, c: Any) => b + c.individual_compartment_days, 0), 0), max_abs_residual: Math.max(...rows.flatMap((r) => Object.values(r.conservation).map((c: Any) => c.max_abs_residual_per_day))), failures: rows.flatMap((r) => Object.values(r.conservation).flatMap((c: Any) => c.failures)).length, tolerance: TOL, rule: 'per colony-day and per compartment (aggregate per kind and per individual id): opening (start state) + in (food_transfer to it) = out (food_transfer from it) + closing (end state); in_transit opens and closes at 0; sinks (metabolized, loss, egg) only receive; world sources are closed by the engine check checkSources (ecology growth is not a food_transfer)' };
  return {
    schema: 'antempire.c4-causal-chain.v1', engine_version: ENGINE_VERSION, official: false, experiment_label: '非正式 Day0 experiment worlds — not the official world, not history',
    design: { foundings: FOUNDINGS, seasons: SEASONS, seeds: SEEDS, days: DAYS, variants: VARIANTS.map((v) => ({ id: v.id, label: v.label })), note: 'report only; no engine or parameter change; every variant on the same seeds; model outputs under game assumptions, not field values, not targets (CLAUDE.md §7); v30 forms use TEST values (no form is chosen, Owner D4)' },
    definitions: { larva_day: 'one larva_nutrition record', larva_day_class: 'the first stage at which the protein chain stopped for that larva on that day (mutually exclusive, in chain order)', eligible_contact: 'larva_contact with begging_signal ≥ feed_threshold_assumption', nurse_in_round: 'a worker with a nest_move event in the nest round', cache_at_round_start: 'stores.protein replayed from the start state through the foraging-phase transfers to the first nest-round record' },
    conservation, identical_totals_to_base, pooled, code_facts: codeFacts(), locality_audit: localityAudit(), rows,
  };
}

export function markdown(doc: Any): string {
  const p = doc.pooled, ids = Object.keys(p), pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
  const out = [`# C4 因果鏈分析（自動產生；非正式 Day0 實驗世界）`, '', `由 \`node cli/reports/c4-causal-chain.ts\` 產生；引擎 \`${doc.engine_version}\`。${doc.design.foundings.join('/')} × 春／秋 × 種子 ${doc.design.seeds.join(',')} × ${doc.design.days} 日。所有數字是遊戲假設下的模型輸出，不是野外值，也不是目標。說明見 docs/c4-causal-chain.md。`, '',
    `守恆：${doc.conservation.compartment_days_checked} 個區室日（${doc.conservation.individual_compartment_days_checked} 個個體區室日）逐日檢查，最大殘差 ${doc.conservation.max_abs_residual}，失敗 ${doc.conservation.failures}。`, '',
    '| 變體 | 無餵食接觸的幼蟲日 | 蛋白攝取／需求 | 卸貨蛋白／幼蟲需求 | 溢出／幼蟲需求 | 到達幼蟲／卸貨 | 取出的蛋白給蟻后 | 達門檻接觸中工蟻帶蛋白 |', '|---|---|---|---|---|---|---|---|',
    ...ids.map((id) => { const d = p[id].derived; return `| ${id} | ${pct(d.share_larva_days_no_feeding_contact)} | ${pct(d.larval_protein_intake_over_need)} | ${d.protein_unloaded_over_larval_need} | ${d.protein_overflow_over_larval_need} | ${pct(d.protein_to_larvae_over_unloaded)} | ${pct(d.taken_given_to_queen_share)} | ${pct(d.share_eligible_contacts_nurse_held_protein)} |`; }),
    '', '## 基準變體（base_c3a_c4a）的幼蟲日瓶頸', '', '| 階段 | 幼蟲日 | 比例 |', '|---|---|---|', ...p.base_c3a_c4a.bottleneck.larva_days.map((r: Any) => `| ${r.stage.trim()} | ${r.larva_days} | ${pct(r.share)} |`),
    '', '## 基準變體的蛋白流（份）', '', '| 階段 | 蛋白（份） |', '|---|---|', ...p.base_c3a_c4a.bottleneck.protein_portions.map((r: Any) => `| ${r.stage.trim()} | ${r.protein_portions} |`), ''];
  return out.join('\n');
}

if (import.meta.main) {
  const doc = generate();
  fs.writeFileSync(path.join(REPO_ROOT, 'reports/c4-causal-chain.json'), JSON.stringify(doc, null, 1) + '\n');
  fs.writeFileSync(path.join(REPO_ROOT, 'reports/c4-causal-chain.md'), markdown(doc));
  console.log(JSON.stringify({ conservation: doc.conservation, base: doc.pooled.base_c3a_c4a.derived }, null, 2));
}

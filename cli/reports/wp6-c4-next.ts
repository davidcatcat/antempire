/**
 * WP6 — C4 larval nutrition, next-stage structural candidates (docs/wp6-c4-next-stage.md). REPORT ONLY, OFFLINE REPLAY:
 * no engine change, no parameter change, nothing switched on in the shipped files, no official world.
 *
 * Design. The engine runs the Day0 experiment worlds (非正式) under C3a + C4a (the v2-review.28 rules, exactly the
 * `base_c3a_c4a` variant of cli/reports/c4-causal-chain.ts): A1 / A3 / A5 × spring / autumn × seeds 1–5 × 60 days, every
 * seed kept. For every colony-day the report rebuilds the state AT THE START OF THE NEST ROUND from the engine's own
 * records (start state + food_transfer ledger replayed up to the first nest-round record; larval begging, need and balance
 * from larva_nutrition; nurse arrival ordinals from the engine's named streams) and replays the nest round under each
 * structural candidate (a ONE-DAY COUNTERFACTUAL):
 *   S0  the engine's own structure (must reproduce the engine's nest-round transfers exactly — fidelity check);
 *   P1  larvae before the queen (R346, this species: labelled yolk reached queens only after the larvae were fed);
 *   Tk  a time budget of k larval contacts per nurse-day (k is a TEST grid, NOT a contact frequency: species value null);
 *   R   refill trips: a nurse whose crop holds no protein goes back to the store (one contact slot per trip);
 *   B   solid protein carried in the mandibles (not the crop) and placed on a larva able to eat it (R346 this species:
 *       pieces placed near the larval head; which larvae can eat solids: null — TEST cut on own progress).
 * Nothing is fed back: the next day starts from the engine's own trajectory. The extra protein a candidate takes from the
 * store is compared with the same day's storage overflow (food that the engine would have lost anyway) to show how much of
 * it could come without drawing the store down; the rest is a feedback the replay does not model (stated limit).
 *
 * Every number is a model output under game assumptions — not a field value, not a target, not a calibration (CLAUDE.md §7).
 * Usage: node cli/reports/wp6-c4-next.ts  -> reports/wp6-c4-next/results.json + reports/wp6-c4-next/summary.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDay0 } from '../lib/day0.ts';
import { REPO_ROOT } from '../lib/load.ts';
import { ENGINE_VERSION, simulateWorldDay } from '../../engine/index.ts';
import { colonyDice } from '../../engine/workers.ts';
import { round } from '../../engine/math.ts';
import { nutritionFactor, ownPaidFraction } from '../../engine/larva-development.ts';
import { FOUNDINGS, SEASONS, SEEDS, DAYS, variantBundle, holdings, closeDay } from './c4-causal-chain.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Food = { sugar: number; protein: number };
const FOODS = ['sugar', 'protein'] as const;
const EPS = 1e-9, TOL = 2e-5;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6, ratio = (a: number, b: number) => (b > 0 ? r6(a / b) : null);
const v = (x: Any) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const OUT_DIR = 'reports/wp6-c4-next';
/** Analysis-side safety cap for the "unlimited time" upper bound (not a nurse behaviour, not a parameter). */
const UNBOUNDED_CAP = 400;

export interface Candidate { id: string; label: string; order: 'queen_first' | 'brood_first'; contacts: number; refill: boolean; satiation: boolean; solid: null | { min_progress: number } }
/** The compared structures. k and the solid cut are TEST values, not species values (all null in the species). */
export const CANDIDATES: Candidate[] = [
  { id: 'S0_engine_structure', label: 'engine structure: store → queen → one larva per nurse, one bolus (replay of v2-review.28)', order: 'queen_first', contacts: 1, refill: false, satiation: false, solid: null },
  { id: 'P1_larvae_before_queen', label: 'store → larvae → queen (R346 order), one contact', order: 'brood_first', contacts: 1, refill: false, satiation: false, solid: null },
  { id: 'T2_TEST', label: 'time budget: 2 contacts per nurse-day (TEST), own-satiation stop', order: 'queen_first', contacts: 2, refill: false, satiation: true, solid: null },
  { id: 'T4_TEST', label: 'time budget: 4 contacts (TEST)', order: 'queen_first', contacts: 4, refill: false, satiation: true, solid: null },
  { id: 'T8_TEST', label: 'time budget: 8 contacts (TEST)', order: 'queen_first', contacts: 8, refill: false, satiation: true, solid: null },
  { id: 'T8R_TEST', label: 'time budget: 8 slots (TEST), refill trips to the store allowed', order: 'queen_first', contacts: 8, refill: true, satiation: true, solid: null },
  { id: 'TinfR_UPPER_BOUND', label: 'unlimited nurse time with refills (analysis upper bound, not a model)', order: 'queen_first', contacts: Infinity, refill: true, satiation: true, solid: null },
  { id: 'B_solid_all_TEST', label: 'solid path: one piece per store visit, any larva may eat it (TEST), one contact', order: 'queen_first', contacts: 1, refill: false, satiation: true, solid: { min_progress: 0 } },
  { id: 'B_solid_late_TEST', label: 'solid path: only larvae with own progress ≥ 2/3 may eat it (TEST proxy for the last of three instars), one contact', order: 'queen_first', contacts: 1, refill: false, satiation: true, solid: { min_progress: 2 / 3 } },
  { id: 'P1_T8R_TEST', label: 'P1 + T8R', order: 'brood_first', contacts: 8, refill: true, satiation: true, solid: null },
  { id: 'P1_T8R_B_late_TEST', label: 'P1 + T8R + solid path (late larvae)', order: 'brood_first', contacts: 8, refill: true, satiation: true, solid: { min_progress: 2 / 3 } },
];

/** C4b forms compared on the one-day own paid fraction x (TEST values from docs/design-c4b §10; no form is chosen). */
const FORMS: { id: string; ld: Any }[] = [
  { id: 'N-a clamp_linear', ld: { nutrition_response: 'clamp_linear' } },
  { id: 'N-b threshold θ=0.5 TEST', ld: { nutrition_response: 'threshold', threshold_theta: 0.5 } },
  { id: 'N-c saturating K=0.5 TEST', ld: { nutrition_response: 'saturating', saturation_k: 0.5 } },
];

// ---------------------------------------------------------------------------------------------------------------------------
export interface Nurse { id: string; u: number; crop: Food }
export interface Larva { id: string; begging: number; need: Food; balance: Food; progress: number }
export interface RoundCtx { world: Any; colony: Any; cache: number; nurses: Nurse[]; queen: null | { id: string; balance: Food }; larvae: Larva[]; P: Any }
interface Tr { cause: string; src: string; dst: string; food: 'sugar' | 'protein'; portions: number }

/** Parameters the round reads (from the species file of the run; game assumptions there). */
export function roundParams(sp: Any): Any {
  const qf = sp.queen_feeding, lf = sp.larval_feeding, n = sp.nutrition;
  if (qf.store_is_queen_location !== false || qf.route_b1 !== true) throw Error('replay assumes the shipped store layout (store ≠ queen place) and route B1');
  return {
    cap: v(sp.trophallaxis.crop_capacity), take: v(qf.take_from_cache_max_portions), feedMax: v(qf.feed_max_portions_per_contact),
    qSat: { sugar: v(qf.queen_satiation_days_of_need) * v(n.queen_sugar_daily), protein: v(qf.queen_satiation_days_of_need) * v(n.queen_protein_daily) },
    thr: v(lf.feed_begging_threshold), bolus: { sugar: v(lf.feed_bolus_sugar_portions), protein: v(lf.feed_bolus_protein_portions) },
    // the solid piece size has no species value (null); TEST: the same size as the liquid take cap, so B differs from S0 only by the path
    piece: v(qf.take_from_cache_max_portions), nmin: v(sp.development.larva_min_nutrition_growth_factor),
  };
}

/**
 * One nest round under a candidate (pure: it copies everything it touches). Returns the transfers (a closed mini-ledger:
 * cache, crop:<w>, mandible:<w>, queen_body, larva_body:<id>), every contact, each larva's intake and why each nurse stopped.
 */
export function replayRound(c: Candidate, x: RoundCtx): Any {
  // arrival order from the engine's own streams (u), ties by ID — never the order of the input arrays (Issue #56)
  x = { ...x, nurses: [...x.nurses].sort((p, q) => p.u - q.u || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)), larvae: [...x.larvae].sort(byId) };
  const P = x.P, T: Tr[] = [], bal = new Map<string, number>(), contacts: Any[] = [], refusals = { n: 0 };
  const g = (kk: string) => bal.get(kk) ?? 0;
  bal.set('cache:protein', x.cache);
  for (const w of x.nurses) { bal.set(`crop:${w.id}:sugar`, w.crop.sugar); bal.set(`crop:${w.id}:protein`, w.crop.protein); }
  if (x.queen) for (const f of FOODS) bal.set(`queen:${f}`, x.queen.balance[f]);
  const open = new Map(bal);
  const cropHeld = (w: string) => g(`crop:${w}:sugar`) + g(`crop:${w}:protein`);
  const mv = (cause: string, src: string, dst: string, food: 'sugar' | 'protein', a: number) => {
    if (a <= 0) return 0;
    bal.set(src, round(g(src) - a)); bal.set(dst, round(g(dst) + a)); T.push({ cause, src, dst, food, portions: a });
    for (const kk of [src, dst]) if (g(kk) < -EPS) throw Error(`replay ${c.id}: ${kk} negative`);
    for (const kk of [src, dst]) if (kk.startsWith('crop:')) { const w = kk.split(':')[1]; if (cropHeld(w) > P.cap + EPS) throw Error(`replay ${c.id}: crop ${w} over capacity`); }
    return a;
  };
  const intake = new Map(x.larvae.map((l) => [l.id, { sugar: 0, protein: 0 } as Food]));
  const took = new Map<string, number>(), toQueen = new Map<string, number>();
  const visitStore = (w: Nurse) => {
    const a = round(Math.min(P.take, Math.max(0, P.cap - cropHeld(w.id)), g('cache:protein')));
    mv('take_from_cache', 'cache:protein', `crop:${w.id}:protein`, 'protein', a); took.set(w.id, round((took.get(w.id) ?? 0) + a));
    let s = 0;
    if (c.solid && g(`mandible:${w.id}:protein`) <= EPS) s = mv('pick_solid_piece', 'cache:protein', `mandible:${w.id}:protein`, 'protein', round(Math.min(P.piece, g('cache:protein'))));
    return a + s;
  };
  const queenLeg = () => {
    if (!x.queen) return;
    for (const w of x.nurses) for (const f of FOODS) {
      const held = g(`crop:${w.id}:${f}`);
      if (held <= 0) continue;
      if (g(`queen:${f}`) >= P.qSat[f]) { refusals.n++; continue; }
      const a = round(Math.min(held, P.feedMax));
      mv('feed_queen', `crop:${w.id}:${f}`, `queen:${f}`, f, a);
      if (f === 'protein') toQueen.set(w.id, round((toQueen.get(w.id) ?? 0) + a));
    }
  };
  const larvae = [...x.larvae].sort(byId), hungry = (l: Larva) => l.begging >= P.thr && (intake.get(l.id) as Food).protein < l.need.protein - EPS;
  const holdsProtein = (w: Nurse) => g(`crop:${w.id}:protein`) + g(`mandible:${w.id}:protein`) > EPS;
  const canRefill = (w: Nurse) => c.refill && g('cache:protein') > EPS && (P.cap - cropHeld(w.id) > EPS || !!c.solid);
  const contactOnce = (w: Nurse, j: number) => {
    const stream = j === 0 ? 'c4a_larva_contact:' + w.id : `wp6_c4next_contact:${w.id}:${j}`;
    const L = larvae[Math.floor(colonyDice(x.world, x.colony, stream)() * larvae.length)], got = intake.get(L.id) as Food;
    const held = r6(g(`crop:${w.id}:protein`) + g(`mandible:${w.id}:protein`)), eligible = L.begging >= P.thr;
    let fedP = 0;
    if (eligible) {
      if (c.solid && L.progress >= c.solid.min_progress - EPS && got.protein < L.need.protein - EPS) {
        const a = round(Math.min(g(`mandible:${w.id}:protein`), L.need.protein - got.protein));
        if (mv('larva_ingest_solid', `mandible:${w.id}:protein`, `larva:${L.id}:protein`, 'protein', a)) { got.protein = round(got.protein + a); fedP += a; }
      }
      for (const f of FOODS) {
        if (c.satiation && got[f] >= L.need[f] - EPS) continue;
        const a = round(Math.min(g(`crop:${w.id}:${f}`), P.bolus[f]));
        if (mv('feed_larva', `crop:${w.id}:${f}`, `larva:${L.id}:${f}`, f, a)) { got[f] = round(got[f] + a); if (f === 'protein') fedP += a; }
      }
    }
    contacts.push({ nurse: w.id, larva: L.id, j, eligible, held_protein: held, fed_protein: r6(fedP) });
  };
  // store phase (every nurse at the store, in arrival order)
  for (const w of x.nurses) visitStore(w);
  if (c.order === 'queen_first') queenLeg();
  // brood phase: slot j of every nurse in arrival order, then slot j + 1 (interleaved time)
  const used = new Map(x.nurses.map((w) => [w.id, 0])), done = new Set<string>();
  if (larvae.length) for (let j = 0; j < Math.min(c.contacts, UNBOUNDED_CAP); j++) {
    let any = false;
    for (const w of x.nurses) {
      if (done.has(w.id)) continue;
      // the unlimited bound stops a nurse when nothing more can be delivered (analysis bound, not a nurse decision)
      if (c.contacts === Infinity && (!larvae.some(hungry) || (!holdsProtein(w) && !canRefill(w)))) { done.add(w.id); continue; }
      any = true; used.set(w.id, j + 1);
      if (j > 0 && c.refill && g(`crop:${w.id}:protein`) <= EPS && canRefill(w)) { visitStore(w); continue; } // a refill trip (liquid gone) uses the slot
      contactOnce(w, j);
    }
    if (!any) break;
  }
  // why each nurse stopped delivering protein (first matching reason)
  const ends: string[] = [];
  for (const w of x.nurses) {
    const t = took.get(w.id) ?? 0;
    let why: string;
    if (!larvae.length) why = 'no_larvae_at_place';
    else if (!larvae.some(hungry)) why = 'larval_cue_or_satiation';
    else if (holdsProtein(w)) why = 'contact_budget';
    else if (c.refill) why = g('cache:protein') <= EPS ? 'store_empty' : canRefill(w) ? 'contact_budget' : 'crop_full_of_sugar';
    else if (t <= EPS && !c.solid) why = g('cache:protein') <= EPS ? 'store_empty' : 'crop_full_of_sugar';
    else if ((toQueen.get(w.id) ?? 0) >= t - EPS && t > EPS) why = 'given_to_queen_first';
    else why = 'one_store_visit_per_day';
    ends.push(why);
  }
  if (c.order === 'brood_first') queenLeg();
  // put back: liquid protein in crops and uneaten solid pieces go back to the store (nothing held overnight)
  for (const w of x.nurses) {
    mv('return_to_cache', `crop:${w.id}:protein`, 'cache:protein', 'protein', round(g(`crop:${w.id}:protein`)));
    mv('return_solid_to_cache', `mandible:${w.id}:protein`, 'cache:protein', 'protein', round(g(`mandible:${w.id}:protein`)));
  }
  // closure of the mini-ledger: opening + in − out = closing for every compartment; total protein and sugar unchanged
  const flow = new Map<string, number>();
  for (const t of T) { flow.set(t.src, (flow.get(t.src) ?? 0) - t.portions); flow.set(t.dst, (flow.get(t.dst) ?? 0) + t.portions); }
  let maxRes = 0;
  for (const kk of new Set([...open.keys(), ...bal.keys(), ...flow.keys()])) maxRes = Math.max(maxRes, Math.abs((open.get(kk) ?? 0) + (flow.get(kk) ?? 0) - g(kk)));
  const total = (m: Map<string, number>, f: string) => [...m].filter(([kk]) => kk.endsWith(':' + f)).reduce((a, [, y]) => a + y, 0);
  const totalRes = Math.max(...FOODS.map((f) => Math.abs(total(open, f) - total(bal, f))));
  const sum = (cause: string, f = 'protein') => r6(T.filter((t) => t.cause === cause && t.food === f).reduce((a, t) => a + t.portions, 0));
  return { transfers: T, contacts, intake, ends, used, refusals: refusals.n, ledger: { compartments: new Set([...open.keys(), ...bal.keys()]).size, max_residual: maxRes, total_residual: totalRes },
    protein: { taken: sum('take_from_cache'), solid_picked: sum('pick_solid_piece'), to_queen: sum('feed_queen'), to_larvae_liquid: sum('feed_larva'), to_larvae_solid: sum('larva_ingest_solid'), returned: r6(sum('return_to_cache') + sum('return_solid_to_cache')) } };
}

// ---------------------------------------------------------------------------------------------------------------------------
/** The state at the start of the nest round, rebuilt from the engine's records of the day (read only). */
export function roundContext(s: Any, end: Any, ev: Any[], P: Any): RoundCtx & { larvaDays: Any[]; nurseCheck: string[] } {
  const c0 = s.colonies[0], bal = holdings(c0), get = (kk: string) => bal.get(kk) ?? 0, kOf = (kind: string, id: string, f: string) => `${kind}:${id}:${f}`;
  for (const e of ev) if (e.type === 'queen_body_initialized') for (const f of FOODS) bal.set(kOf('queen_body', e.queen, f), get(kOf('queen_body', e.queen, f)) + e.known_balance[f]);
  let rs: Map<string, number> | null = null;
  for (const e of ev) {
    const roundish = e.type === 'nest_move' || e.type === 'larva_contact' || e.type === 'queen_contact' || (e.type === 'food_transfer' && e.phase === 'nest_round');
    if (roundish) { rs = new Map(bal); break; }
    if (e.type !== 'food_transfer') continue;
    bal.set(kOf(e.source.kind, e.source.id, e.food_type), get(kOf(e.source.kind, e.source.id, e.food_type)) - e.portions);
    bal.set(kOf(e.recipient.kind, e.recipient.id, e.food_type), get(kOf(e.recipient.kind, e.recipient.id, e.food_type)) + e.portions);
  }
  const at = rs ?? bal, nest = c0.nest_node, first = new Map<string, number>(), nurseCheck: string[] = [];
  for (const e of ev) if (e.type === 'nest_move' && !first.has(e.worker)) first.set(e.worker, e.depart_ordinal);
  const nurses: Nurse[] = [...first.keys()].map((id) => {
    const u = round(colonyDice(s, c0, 'c3a_nest_round:' + id)());
    if (Math.abs((first.get(id) as number) - 0.5 - u) > 1e-6) nurseCheck.push(`${id}: arrival ordinal ${first.get(id)} ≠ engine stream u ${u} + 0.5`);
    return { id, u, crop: { sugar: at.get(kOf('crop', id, 'sugar')) ?? 0, protein: at.get(kOf('crop', id, 'protein')) ?? 0 } };
  }).sort((a, b) => a.u - b.u || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const q = c0.population.queens?.[0] ?? end.colonies[0].population.queens?.[0];
  const queen = c0.population.queen_alive && q ? { id: q.id, balance: { sugar: at.get(kOf('queen_body', q.id, 'sugar')) ?? 0, protein: at.get(kOf('queen_body', q.id, 'protein')) ?? 0 } } : null;
  const prog = new Map(c0.population.brood.map((b: Any) => [b.id, b.progress ?? 0]));
  const larvaDays = ev.filter((e) => e.type === 'larva_nutrition');
  const larvae: Larva[] = larvaDays.map((e) => ({ id: e.larva, begging: e.begging_before, need: { ...e.need_portions }, progress: prog.get(e.larva) as number ?? 0,
    balance: { sugar: round(e.fed_balance.sugar + e.paid_portions.sugar - e.intake_portions.sugar), protein: round(e.fed_balance.protein + e.paid_portions.protein - e.intake_portions.protein) } }));
  return { world: s, colony: c0, cache: at.get(kOf('cache', nest, 'protein')) ?? 0, nurses, queen, larvae, P, larvaDays, nurseCheck };
}

const ENGINE_ROUND_CAUSES = new Set(['take_from_cache', 'feed_queen', 'feed_larva', 'return_to_cache', 'queen_self_feed']);
const key = (cause: string, src: string, dst: string, food: string, a: number) => `${cause}|${src}|${dst}|${food}|${r6(a)}`;
/** S0 fidelity: the replay of the engine structure gives exactly the engine's nest-round transfers and contacts. */
function fidelity(ev: Any[], x: RoundCtx, rep: Any): string[] {
  const nest = x.colony.nest_node, eng = ev.filter((e) => e.type === 'food_transfer' && ENGINE_ROUND_CAUSES.has(e.cause)).map((e) => {
    const name = (r: Any) => (r.kind === 'cache' ? 'cache:protein' : r.kind === 'crop' ? `crop:${r.id}:${e.food_type}` : r.kind === 'queen_body' ? `queen:${e.food_type}` : r.kind === 'larva_body' ? `larva:${r.id}:${e.food_type}` : `${r.kind}:${r.id}`);
    return key(e.cause, name(e.source), name(e.recipient), e.food_type, e.portions);
  }).sort();
  const mine = rep.transfers.map((t: Tr) => key(t.cause, t.src, t.dst, t.food, t.portions)).sort();
  const out: string[] = [];
  if (JSON.stringify(eng) !== JSON.stringify(mine)) out.push(`transfers differ: engine ${eng.length}, replay ${mine.length}; first engine-only ${eng.find((z: string) => !mine.includes(z))} replay-only ${mine.find((z: string) => !eng.includes(z))}`);
  const ec = ev.filter((e) => e.type === 'larva_contact').map((e) => `${e.worker}>${e.larva}`).sort(), rc = rep.contacts.map((cc: Any) => `${cc.nurse}>${cc.larva}`).sort();
  if (JSON.stringify(ec) !== JSON.stringify(rc)) out.push(`contacts differ: ${ec.join(',')} vs ${rc.join(',')}`);
  void nest;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
const CLASSES = ['no_nurse_in_round', 'not_contacted', 'contacted_begging_below_threshold', 'eligible_contact_nurse_held_no_protein', 'fed_protein_partial', 'fed_protein_need_met'] as const;
const ENDS = ['no_larvae_at_place', 'larval_cue_or_satiation', 'contact_budget', 'store_empty', 'crop_full_of_sugar', 'given_to_queen_first', 'one_store_visit_per_day'] as const;
const XB = ['x=0', '0<x<0.5', '0.5≤x<1', 'x=1'] as const;
function emptyAcc(): Any {
  return { colony_days: 0, larva_days: 0, protein_need: 0, protein_intake: 0, sugar_need: 0, sugar_intake: 0, classes: Object.fromEntries(CLASSES.map((z) => [z, 0])),
    nurse_days: 0, ends: Object.fromEntries(ENDS.map((z) => [z, 0])), contacts: 0, eligible_contacts: 0, slots_used: 0,
    protein: { taken: 0, solid_picked: 0, to_queen: 0, to_larvae_liquid: 0, to_larvae_solid: 0, returned: 0 }, queen_refusals: 0,
    extra_net_take_vs_S0: 0, extra_covered_by_same_day_overflow: 0, days_extra_exceeds_overflow: 0, uncovered_extra_cumulative: 0, days_store_bound_below_one_bolus: 0, queen_protein_need: 0,
    x_buckets: Object.fromEntries(XB.map((z) => [z, 0])), n_sum: Object.fromEntries(FORMS.map((f) => [f.id, 0])), known_protein_unmet_larva_days: 0,
    replay_ledger: { compartment_days: 0, max_residual: 0, max_total_residual: 0, failures: 0 } };
}
const addInto = (a: Any, b: Any) => { for (const [kk, y] of Object.entries(b)) { if (kk.startsWith('max_')) a[kk] = Math.max(a[kk] ?? 0, y as number); else if (typeof y === 'number') a[kk] = (a[kk] ?? 0) + y; else if (y && typeof y === 'object') addInto((a[kk] ??= {}), y); } };

function accumulate(A: Any, c: Candidate, x: RoundCtx, rep: Any, larvaDays: Any[], overflowP: number, s0NetTake: number | null, queenNeedP: number): void {
  A.colony_days++; A.queen_protein_need += queenNeedP;
  const byLarva = new Map<string, Any[]>();
  for (const cc of rep.contacts) { const l = byLarva.get(cc.larva) ?? []; l.push(cc); byLarva.set(cc.larva, l); }
  for (const e of larvaDays) {
    const L = x.larvae.find((l) => l.id === e.larva) as Larva, got = rep.intake.get(e.larva) as Food;
    A.larva_days++; A.protein_need += L.need.protein; A.protein_intake += got.protein; A.sugar_need += L.need.sugar; A.sugar_intake += got.sugar;
    const mine = byLarva.get(e.larva) ?? [];
    let cls: string;
    if (got.protein > EPS) cls = got.protein >= L.need.protein - EPS ? 'fed_protein_need_met' : 'fed_protein_partial';
    else if (!x.nurses.length) cls = 'no_nurse_in_round';
    else if (!mine.length) cls = 'not_contacted';
    else if (!mine.some((m: Any) => m.eligible)) cls = 'contacted_begging_below_threshold';
    else cls = 'eligible_contact_nurse_held_no_protein';
    A.classes[cls]++;
    const paid = { sugar: Math.min(L.need.sugar, L.balance.sugar + got.sugar), protein: Math.min(L.need.protein, L.balance.protein + got.protein) }, xi = ownPaidFraction(paid, L.need);
    if (paid.protein < L.need.protein - EPS) A.known_protein_unmet_larva_days++;
    A.x_buckets[xi <= EPS ? 'x=0' : xi < 0.5 ? '0<x<0.5' : xi < 1 - EPS ? '0.5≤x<1' : 'x=1']++;
    for (const f of FORMS) A.n_sum[f.id] += nutritionFactor(xi, { larval_development: f.ld, development: { larva_min_nutrition_growth_factor: x.P.nmin } } as Any);
  }
  A.nurse_days += x.nurses.length;
  for (const z of rep.ends) A.ends[z]++;
  A.contacts += rep.contacts.length; A.eligible_contacts += rep.contacts.filter((m: Any) => m.eligible).length;
  for (const n of rep.used.values()) A.slots_used += n;
  addInto(A.protein, rep.protein); A.queen_refusals += rep.refusals;
  const net = rep.protein.taken + rep.protein.solid_picked - rep.protein.returned;
  // conservative bound with feedback: the store can be lower than the engine's by at most the extra not covered by overflow so far
  if (x.cache - A.uncovered_extra_cumulative < x.P.bolus.protein - EPS && x.cache >= x.P.bolus.protein - EPS) A.days_store_bound_below_one_bolus++;
  if (s0NetTake !== null) { const extra = Math.max(0, net - s0NetTake); A.extra_net_take_vs_S0 += extra; A.extra_covered_by_same_day_overflow += Math.min(extra, overflowP); A.uncovered_extra_cumulative += Math.max(0, extra - overflowP); if (extra > overflowP + EPS) A.days_extra_exceeds_overflow++; }
  const RL = A.replay_ledger; RL.compartment_days += rep.ledger.compartments; RL.max_residual = Math.max(RL.max_residual, rep.ledger.max_residual); RL.max_total_residual = Math.max(RL.max_total_residual, rep.ledger.total_residual);
  if (rep.ledger.max_residual > TOL || rep.ledger.total_residual > TOL) RL.failures++;
}

function derived(A: Any): Any {
  const L = A.larva_days, cl = A.classes;
  return {
    protein_intake_over_need: ratio(A.protein_intake, A.protein_need), sugar_intake_over_need: ratio(A.sugar_intake, A.sugar_need),
    share_larva_days_fed_protein: ratio(cl.fed_protein_partial + cl.fed_protein_need_met, L), share_larva_days_need_met: ratio(cl.fed_protein_need_met, L),
    share_no_nurse_in_round: ratio(cl.no_nurse_in_round, L), share_not_contacted: ratio(cl.not_contacted, L), share_below_threshold: ratio(cl.contacted_begging_below_threshold, L), share_eligible_no_protein: ratio(cl.eligible_contact_nurse_held_no_protein, L),
    protein_to_larvae_over_taken: ratio(A.protein.to_larvae_liquid + A.protein.to_larvae_solid, A.protein.taken + A.protein.solid_picked), queen_protein: r6(A.protein.to_queen),
    queen_protein_intake_over_need: ratio(A.protein.to_queen, A.queen_protein_need), contacts_per_nurse_day: ratio(A.contacts, A.nurse_days), share_colony_days_store_bound_below_one_bolus: ratio(A.days_store_bound_below_one_bolus, A.colony_days), share_of_extra_take_covered_by_same_day_overflow: ratio(A.extra_covered_by_same_day_overflow, A.extra_net_take_vs_S0),
    nurse_end_shares: Object.fromEntries(ENDS.map((z) => [z, ratio(A.ends[z], A.nurse_days)])),
    x_bucket_shares: Object.fromEntries(XB.map((z) => [z, ratio(A.x_buckets[z], L)])), mean_N_one_day_TEST: Object.fromEntries(FORMS.map((f) => [f.id, ratio(A.n_sum[f.id], L)])),
    'N-d accumulated (Q null)': null, share_known_protein_unmet: ratio(A.known_protein_unmet_larva_days, L),
  };
}
function roundAll(x: Any): Any { if (typeof x === 'number') return r6(x); if (Array.isArray(x)) return x.map(roundAll); if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([a, b]) => [a, roundAll(b)])); return x; }

/** One world: the engine's own trajectory (read only) + every candidate replayed on every day. `onDay` (tests) sees the input state before/after. */
export function runWorld(founding: string, season: string, seed: number, onDay?: (before: string, after: string, next: Any) => void): Any {
  const b = variantBundle('base_c3a_c4a'), sp = b.species[Object.keys(b.species)[0]], P = roundParams(sp);
  let s: Any = buildDay0(founding as Any, seed, SEASONS[season], b).state;
  if (s.colonies.length !== 1) throw Error('one colony expected');
  const acc: Record<string, Any> = Object.fromEntries(CANDIDATES.map((c) => [c.id, emptyAcc()])), closure: Any = {};
  const fid = { days: 0, mismatches: [] as string[] }, unmetRun = new Map<string, { run: number; max: number }>();
  const engine = { overflow_protein: 0, larva_days: 0, protein_need: 0, protein_intake: 0 };
  for (let d = 0; d < DAYS; d++) {
    const before = onDay ? JSON.stringify(s) : '';
    const o: Any = simulateWorldDay(s, b), cr = o.result.colonies[0], ev = cr.events;
    closeDay(s.colonies[0], o.state.colonies[0], ev, o.day, closure);
    const overflowP = ev.filter((e: Any) => e.type === 'food_transfer' && e.cause === 'storage_overflow' && e.food_type === 'protein').reduce((a: number, e: Any) => a + e.portions, 0);
    engine.overflow_protein += overflowP;
    const x = roundContext(s, o.state, ev, P), queenNeedP = ev.filter((e: Any) => e.type === 'queen_nutrition').reduce((a: number, e: Any) => a + e.need_portions.protein, 0);
    fid.mismatches.push(...x.nurseCheck.map((m) => `day ${o.day}: ${m}`));
    for (const e of x.larvaDays) {
      engine.larva_days++; engine.protein_need += e.need_portions.protein; engine.protein_intake += e.intake_portions.protein;
      const r = unmetRun.get(e.larva) ?? { run: 0, max: 0 }; r.run = e.paid_portions.protein < e.need_portions.protein - EPS ? r.run + 1 : 0; r.max = Math.max(r.max, r.run); unmetRun.set(e.larva, r);
    }
    let s0Net: number | null = null;
    for (const c of CANDIDATES) {
      const rep = replayRound(c, x);
      if (c.id === 'S0_engine_structure') { fid.days++; fid.mismatches.push(...fidelity(ev, x, rep).map((m) => `day ${o.day}: ${m}`)); s0Net = rep.protein.taken + rep.protein.solid_picked - rep.protein.returned; }
      accumulate(acc[c.id], c, x, rep, x.larvaDays, overflowP, c.id === 'S0_engine_structure' ? null : s0Net, queenNeedP);
    }
    if (onDay) onDay(before, JSON.stringify(s), o.state);
    s = o.state;
  }
  const cons = { compartment_days: 0, individual_compartment_days: 0, max_abs_residual: 0, failures: 0 };
  for (const t of Object.values(closure) as Any[]) { cons.compartment_days += t.compartment_days; cons.individual_compartment_days += t.individual_compartments; cons.max_abs_residual = Math.max(cons.max_abs_residual, t.max_abs_residual); cons.failures += t.failures.length; }
  const runs = [...unmetRun.values()].map((r) => r.max);
  return { acc, engine_c2_conservation: { ...cons, max_abs_residual: cons.max_abs_residual < 1e-9 ? 0 : r6(cons.max_abs_residual) }, s0_fidelity: { days: fid.days, mismatches: fid.mismatches.length, first: fid.mismatches.slice(0, 3) },
    engine: { ...engine, larvae_tracked: runs.length, larvae_max_known_unmet_run_ge_5: runs.filter((r) => r >= 5).length, larvae_max_known_unmet_run_ge_14: runs.filter((r) => r >= 14).length, max_known_unmet_run: Math.max(0, ...runs) } };
}

export function generate(): Any {
  const rows: Any[] = [];
  for (const founding of FOUNDINGS) for (const season of Object.keys(SEASONS)) for (const seed of SEEDS) {
    const r = runWorld(founding, season, seed);
    rows.push({ founding, season, seed, engine_c2_conservation: r.engine_c2_conservation, s0_fidelity: r.s0_fidelity, engine: roundAll(r.engine), candidates: Object.fromEntries(CANDIDATES.map((c) => [c.id, { totals: roundAll(r.acc[c.id]), derived: derived(r.acc[c.id]) }])) });
  }
  const pool = (sel: Any[], id: string) => { const t = emptyAcc(); for (const r of sel) addInto(t, r.candidates[id].totals); return t; };
  const pooled = Object.fromEntries(CANDIDATES.map((c) => { const t = pool(rows, c.id); return [c.id, { label: c.label, structure: { order: c.order, contacts_per_nurse_day: c.contacts === Infinity ? 'unbounded (analysis bound)' : c.contacts, refill: c.refill, own_satiation_stop: c.satiation, solid: c.solid }, totals: roundAll(t), derived: derived(t),
    by_season: Object.fromEntries(Object.keys(SEASONS).map((se) => [se, derived(pool(rows.filter((r) => r.season === se), c.id))])), by_founding: Object.fromEntries(FOUNDINGS.map((f) => [f, derived(pool(rows.filter((r) => r.founding === f), c.id))])),
    per_seed_protein_intake_over_need: rows.map((r) => r.candidates[c.id].derived.protein_intake_over_need) }]; }));
  const conservation = { worlds: rows.length, engine_c2: { compartment_days: rows.reduce((a, r) => a + r.engine_c2_conservation.compartment_days, 0), individual_compartment_days: rows.reduce((a, r) => a + r.engine_c2_conservation.individual_compartment_days, 0), max_abs_residual: Math.max(...rows.map((r) => r.engine_c2_conservation.max_abs_residual)), failures: rows.reduce((a, r) => a + r.engine_c2_conservation.failures, 0) },
    replay_ledger: { compartment_days: Object.values(pooled).reduce((a: number, p: Any) => a + p.totals.replay_ledger.compartment_days, 0), max_residual: Math.max(...Object.values(pooled).map((p: Any) => p.totals.replay_ledger.max_residual)), failures: Object.values(pooled).reduce((a: number, p: Any) => a + p.totals.replay_ledger.failures, 0) },
    s0_fidelity: { days: rows.reduce((a, r) => a + r.s0_fidelity.days, 0), mismatches: rows.reduce((a, r) => a + r.s0_fidelity.mismatches, 0) }, tolerance: TOL };
  const E = rows.reduce((a, r) => { addInto(a, r.engine); return a; }, {} as Any);
  return {
    schema: 'antempire.wp6-c4-next.v1', engine_version: ENGINE_VERSION, official: false, experiment_label: '非正式 Day0 experiment worlds — offline one-day counterfactual replay; not the official world, not history, not a rules update',
    design: { foundings: FOUNDINGS, seasons: SEASONS, seeds: SEEDS, days: DAYS, engine_rules: 'base_c3a_c4a (C3a + C4a, v2-review.28) — the trajectory every replay starts from', candidates: CANDIDATES.map((c) => ({ id: c.id, label: c.label })), c4b_forms_TEST: FORMS.map((f) => f.id),
      note: 'one-day counterfactual: each candidate replays only the nest round from the engine\'s round-start state; nothing is fed back to the next day. k, the solid piece size and the solid cut are TEST values (species values null); no candidate is adopted; no C4b form is chosen.' },
    conservation,
    engine_baseline: { larva_days: E.larva_days, protein_intake_over_need: ratio(E.protein_intake, E.protein_need), overflow_protein: r6(E.overflow_protein), overflow_over_larval_need: ratio(E.overflow_protein, E.protein_need), larvae_tracked: E.larvae_tracked, larvae_max_known_unmet_run_ge_5: E.larvae_max_known_unmet_run_ge_5, larvae_max_known_unmet_run_ge_14: E.larvae_max_known_unmet_run_ge_14, max_known_unmet_run: Math.max(...rows.map((r) => r.engine.max_known_unmet_run)) },
    pooled, rows,
  };
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
/** The summary block (the doc quotes it verbatim; tests check that). */
export function markdownBlock(doc: Any): string {
  const p = doc.pooled, ids = Object.keys(p), C = doc.conservation, E = doc.engine_baseline;
  return [
    `守恆：引擎 C2 帳 ${C.engine_c2.individual_compartment_days} 個個體區室日，最大殘差 ${C.engine_c2.max_abs_residual}，失敗 ${C.engine_c2.failures}；重播小帳 ${C.replay_ledger.compartment_days} 個區室回合，最大殘差 ${C.replay_ledger.max_residual}，失敗 ${C.replay_ledger.failures}；S0 重播與引擎紀錄逐筆相同：${C.s0_fidelity.days} 個群體日，不符 ${C.s0_fidelity.mismatches}。`,
    '',
    `引擎基準（${C.worlds} 個世界，${E.larva_days} 幼蟲日）：蛋白攝取／需求 ${pct(E.protein_intake_over_need)}；溢出／幼蟲需求 ${E.overflow_over_larval_need}；${E.larvae_tracked} 隻幼蟲中，已知蛋白不足連續 ≥ 5 日 ${E.larvae_max_known_unmet_run_ge_5} 隻、≥ 14 日 ${E.larvae_max_known_unmet_run_ge_14} 隻，最長 ${E.max_known_unmet_run} 日。`,
    '',
    '| 候選 | 蛋白攝取／需求 | 糖攝取／需求 | 餵到蛋白的幼蟲日 | 無保育工蟻 | 沒被接觸 | 求食低於門檻 | 達門檻但工蟻無蛋白 | 蟻后得到蛋白（份） | 蟻后蛋白／需求 | 額外取出量由當日溢出抵銷 | 回饋上界：store 可能低於一口的群體日 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...ids.map((id) => { const d = p[id].derived; return `| ${id} | ${pct(d.protein_intake_over_need)} | ${pct(d.sugar_intake_over_need)} | ${pct(d.share_larva_days_fed_protein)} | ${pct(d.share_no_nurse_in_round)} | ${pct(d.share_not_contacted)} | ${pct(d.share_below_threshold)} | ${pct(d.share_eligible_no_protein)} | ${d.queen_protein} | ${pct(d.queen_protein_intake_over_need)} | ${pct(d.share_of_extra_take_covered_by_same_day_overflow)} | ${pct(d.share_colony_days_store_bound_below_one_bolus)} |`; }),
    '',
    '| 候選 | 春 | 秋 | 種子間最小～最大 | 保育工蟻停在：接觸時間用完 | 幼蟲線索／已飽 | 一日只取一次 | 先給蟻后 | 嗉囊被糖佔滿 | store 空 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...ids.map((id) => { const d = p[id].derived, ps = p[id].per_seed_protein_intake_over_need.filter((z: number | null) => z !== null), e = d.nurse_end_shares; return `| ${id} | ${pct(p[id].by_season.spring.protein_intake_over_need)} | ${pct(p[id].by_season.autumn.protein_intake_over_need)} | ${pct(Math.min(...ps))}～${pct(Math.max(...ps))} | ${pct(e.contact_budget)} | ${pct(e.larval_cue_or_satiation)} | ${pct(e.one_store_visit_per_day)} | ${pct(e.given_to_queen_first)} | ${pct(e.crop_full_of_sugar)} | ${pct(e.store_empty)} |`; }),
    '',
    '| 候選 | x = 0 | 0 < x < 0.5 | 0.5 ≤ x < 1 | x = 1 | 平均 N：N-a | N-b θ=0.5 TEST | N-c K=0.5 TEST | 已知蛋白不足的幼蟲日 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...ids.map((id) => { const d = p[id].derived, b = d.x_bucket_shares, n = d.mean_N_one_day_TEST; return `| ${id} | ${pct(b['x=0'])} | ${pct(b['0<x<0.5'])} | ${pct(b['0.5≤x<1'])} | ${pct(b['x=1'])} | ${n['N-a clamp_linear']} | ${n['N-b threshold θ=0.5 TEST']} | ${n['N-c saturating K=0.5 TEST']} | ${pct(d.share_known_protein_unmet)} |`; }),
    '',
  ].join('\n');
}
export function markdown(doc: Any): string {
  return [`# WP6 C4 下一階段：結構候選的離線重播（自動產生；非正式 Day0 實驗世界）`, '', `由 \`node cli/reports/wp6-c4-next.ts\` 產生；引擎 \`${doc.engine_version}\`。${doc.design.foundings.join('/')} × 春／秋 × 種子 ${doc.design.seeds.join(',')} × ${doc.design.days} 日，引擎規則 C3a＋C4a（v2-review.28）。每個候選只重播當日巢內回合，不回饋到隔日（一日反事實）。k、固體塊大小、固體門檻都是測試值，不是本種數值；沒有採用任何候選，沒有選定 C4b 形式。說明見 docs/wp6-c4-next-stage.md。`, '', markdownBlock(doc)].join('\n');
}

if (import.meta.main) {
  const doc = generate();
  fs.mkdirSync(path.join(REPO_ROOT, OUT_DIR), { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, OUT_DIR, 'results.json'), JSON.stringify(doc, null, 1) + '\n');
  fs.writeFileSync(path.join(REPO_ROOT, OUT_DIR, 'summary.md'), markdown(doc));
  console.log(markdownBlock(doc));
}

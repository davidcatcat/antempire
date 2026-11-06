/**
 * C4b independent reader of one colony-day's larval development (docs/design-c4b-larval-development.md §7 B4): written
 * separately from engine/larva-development.ts, shares no code with the engine. From the species parameters (raw file) and
 * the day's nest temperature it recomputes, for every larva that had an account at the start of the day:
 *   need = larval daily need × metabolic Q10 factor; x = min over foods of (its larva_metabolism records / need), in [0, 1];
 *   N = the chosen form of x; Δ = clamp(q10^((T − ref)/10), min, max) / larva_days × N;
 * and requires one larva_development record with these values and an end state that follows (larva, or a pupa with the
 * remainder, or dead). On a day with no worker at the start there is no development. Never throws; at most 50 messages.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface LarvaDevelopmentReplay { ok: boolean; errors: string[]; larvae: number }
const r6 = (x: number) => Math.round((x + Number.EPSILON) * 1e6) / 1e6; // the engine's published rounding contract
const val = (x: Any) => (typeof x === 'object' && x !== null ? Number(x.value) : Number(x));
const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function replayLarvaDevelopment(start: Any, end: Any, events: Any[], species: Any, nestTempC: number): LarvaDevelopmentReplay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  const ev: Any[] = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const dev = species?.development ?? {}, met = species?.metabolism ?? {}, nut = species?.nutrition ?? {}, ld = species?.larval_development ?? {};
  const form = ld.nutrition_response, nmin = val(dev.larva_min_nutrition_growth_factor), theta = val(ld.threshold_theta), k = val(ld.saturation_k);
  const N = (x: number) => form === 'clamp_linear' ? clip(x, nmin, 1) : form === 'threshold' ? (x >= theta ? 1 : nmin) : form === 'saturating' ? clip(nmin + (1 - nmin) * x * (1 + k) / (k + x), nmin, 1) : NaN;
  const mf = r6(Math.pow(val(met.q10), (nestTempC - val(met.reference_c)) / 10)), need = { sugar: r6(val(nut.larva_sugar_daily) * mf), protein: r6(val(nut.larva_protein_daily) * mf) };
  const tf = clip(Math.pow(val(dev.q10), (nestTempC - val(dev.reference_c)) / 10), val(dev.min_temp_factor), val(dev.max_temp_factor)), days = val(dev.larva_days);
  const paid = new Map<string, { sugar: number; protein: number }>();
  for (const e of ev) if (e.type === 'food_transfer' && e.cause === 'larva_metabolism') { const p = paid.get(e.source.id) ?? { sugar: 0, protein: 0 }; p[e.food_type as 'sugar' | 'protein'] = r6(p[e.food_type as 'sugar' | 'protein'] + Number(e.portions)); paid.set(e.source.id, p); }
  const rec = new Map<string, Any>();
  for (const e of ev) if (e.type === 'larva_development') { if (rec.has(e.larva)) err(`${e.larva}: two development records`); rec.set(e.larva, e); }
  const care = (start?.population?.workers ?? []).length > 0;
  const init = new Set(ev.filter((e) => e.type === 'brood_nutrition_record_initialized' && e.stage === 'larva').map((e) => String(e.id)));
  const endB = new Map<string, Any>((end?.population?.brood ?? []).map((b: Any) => [b.id, b]));
  const dead = new Set(ev.filter((e) => e.type === 'brood_death').map((e) => String(e.id)));
  const pupatedNow = new Set(ev.filter((e) => e.type === 'pupation').map((e) => String(e.id)));
  let n = 0;
  for (const b of start?.population?.brood ?? []) {
    const r = rec.get(b.id), accounted = b.stage === 'larva' && (b.body || init.has(b.id));
    if (!accounted) { if (r) err(`${b.id}: a development record for something that was not a larva with an account`); continue; }
    if (!care) { if (r) err(`${b.id}: developed on a day without any worker`); const e0 = endB.get(b.id); if (e0 && (e0.stage !== 'larva' || e0.progress !== b.progress)) err(`${b.id}: no worker today, yet ${b.stage}/${b.progress} -> ${e0.stage}/${e0.progress}`); if (pupatedNow.has(b.id)) err(`${b.id}: pupated without any worker`); continue; }
    if (!r) { if (!dead.has(b.id) || endB.has(b.id)) err(`${b.id}: no development record`); continue; }
    n++;
    const p = paid.get(b.id) ?? { sugar: 0, protein: 0 }, x = clip(Math.min(need.sugar > 0 ? p.sugar / need.sugar : 1, need.protein > 0 ? p.protein / need.protein : 1), 0, 1);
    const nn = N(x), after = r6(Number(b.progress) + tf / days * nn);
    if (r.own_paid_fraction !== r6(x) || r.nutrition_factor !== r6(nn) || r.progress_before !== b.progress || r.progress_after !== after || r.nutrition_response !== form) err(`${b.id}: record x ${r.own_paid_fraction} N ${r.nutrition_factor} ${r.progress_before}->${r.progress_after}; its own records give x ${r6(x)} N ${r6(nn)} ${b.progress}->${after}`);
    const e = endB.get(b.id);
    if (after >= 1 && !(e === undefined ? dead.has(b.id) : e.stage === 'pupa' && pupatedNow.has(b.id))) err(`${b.id}: progress ${after} ≥ 1 without pupation`);
    if (after < 1 && (pupatedNow.has(b.id) || e?.stage === 'pupa')) err(`${b.id}: pupated at progress ${after} < 1`);
    if (e?.stage === 'larva' && e.progress !== after) err(`${b.id}: end progress ${e.progress}, replay ${after}`);
    if (e?.stage === 'pupa' && e.progress !== r6(Math.max(0, after - 1))) err(`${b.id}: pupated with ${e.progress}, replay ${r6(Math.max(0, after - 1))}`);
  }
  for (const id of rec.keys()) if (!(start?.population?.brood ?? []).some((b: Any) => b.id === id)) err(`${id}: development record for something not brood at the start`);
  return { ok: errors.length === 0, errors, larvae: n };
}

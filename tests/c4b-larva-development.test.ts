/**
 * C4b (docs/design-c4b-larval-development.md §7): individual larval development from what the larva itself paid for.
 * The nutrition-response FORM is an Owner decision: the shipped parameter is null and switching on is refused (B6). The
 * tests below use each candidate form with TEST-ONLY parameters (θ = 0.5, K = 0.5) to exercise the engineering; these are not
 * choices of a model and are not proposed as values.
 *   B0 before (C4b off, C4a on): every larva develops by the same colony-wide factor, whatever it was fed;
 *   B1 after: Δprogress = r(T)/larva_days × N(xᵢ) from the larva's own record; colony fractions have no effect;
 *   B2 far-larva counterfactual; B3 array order; B4 engine check + independent reader reject forged records;
 *   B5 switch off = previous version (golden / rules-isolation; here: no larva_development record when off);
 *   B6 parameter refusals; B7 Yuan 2026 observation operator (report only); B8 Phillips 1933 starvation direction (report only).
 * Engineering correctness, not biological validation.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { resolveBundle } from '../engine/params.ts';
import { developBrood } from '../engine/brood.ts';
import { checkLarvaDevelopment, nutritionFactor } from '../engine/larva-development.ts';
import { ensureBroodRecords, larvaRoundStart } from '../engine/larva-feeding.ts';
import { replayLarvaDevelopment } from '../cli/lib/larva-development-replay.ts';
import { MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const evidence: Record<string, unknown> = {};
const mk = (c4b: boolean, form: string | null = null, extra: Record<string, number> = {}) => {
  const b: Any = structuredClone(loadBundle()), s = b.species[MAIN_SPECIES];
  s.queen_feeding.individual_queen_body_c3a = true; s.larval_feeding.individual_larva_body_c4a = true; s.larval_development.individual_development_c4b = c4b; s.larval_development.nutrition_response = form;
  if (extra.theta !== undefined) s.larval_development.threshold_theta.value = extra.theta; if (extra.k !== undefined) s.larval_development.saturation_k.value = extra.k;
  return b;
};
const FORMS: [string, Record<string, number>][] = [['clamp_linear', {}], ['threshold', { theta: 0.5 }], ['saturating', { k: 0.5 }]];

// ---------------------------------------------------------------- B6 parameters
const refused = (b: Any) => { try { resolveBundle(b); return ''; } catch (e) { return String(e); } };
ok(/nutrition_response is null/.test(refused(mk(true, null))), 'B6: C4b with no chosen form (null, as shipped) is refused');
ok(/threshold form needs/.test(refused(mk(true, 'threshold'))) && /saturating form needs/.test(refused(mk(true, 'saturating'))), 'B6: a form whose parameter is null is refused');
ok(/not clamp_linear, threshold or saturating/.test(refused(mk(true, 'cumulative'))), 'B6: an unimplemented form (N-d needs a unit conversion) is refused');
{ const b: Any = mk(true, 'clamp_linear'); b.species[MAIN_SPECIES].larval_feeding.individual_larva_body_c4a = false; ok(/requires larval_feeding\.individual_larva_body_c4a/.test(refused(b)), 'B6: C4b without C4a is refused'); }
ok(resolveBundle(loadBundle()).species[MAIN_SPECIES].larval_development.individual_development_c4b === false, 'B5: the switch is off by default');

// ---------------------------------------------------------------- unit-level: developBrood with controlled inputs
const dayWith = (b: Any, s0: Any, own: Map<string, number> | undefined, ratios: { pFraction: number; sFraction: number }, reverse = false) => {
  const s = structuredClone(s0), c = s.colonies[0], sp = resolveBundle(b).species[MAIN_SPECIES] as Any;
  if (reverse) { c.population.brood.reverse(); c.population.workers.reverse(); }
  const ev: Any[] = [], summary: Any = { brood_deaths: 0, hatchings: 0, pupations: 0, eclosions: 0 };
  developBrood(s, c, sp, { nest_temp_model_c: 27 } as Any, ratios, ev, summary, own);
  return { c, ev, prog: new Map(c.population.brood.map((x: Any) => [x.id, x.progress])) };
};
const base = (() => { let s: Any = buildDay0('A1' as Any, 3, '2027-03-21', mk(false)).state; for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva' && b.body).length < 3; k++) s = simulateWorldDay(s, mk(false)).state; s.colonies[0].population.brood = s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva').map((b: Any) => ({ ...b, progress: 0.2 })); return s; })();
const ids: string[] = base.colonies[0].population.brood.map((b: Any) => b.id);
const own = new Map(ids.map((id, i) => [id, [0, 0.4, 1][i % 3]]));
ok(ids.length >= 3, `setup: ${ids.length} larvae with accounts`);
{
  const a = dayWith(mk(false), base, own, { pFraction: 1, sFraction: 1 }), z = dayWith(mk(false), base, own, { pFraction: 0.2, sFraction: 1 });
  ok(new Set(ids.map((id) => a.prog.get(id))).size === 1, 'B0 BEFORE (C4b off): larvae with own paid fractions 0, 0.4 and 1 all advance by the same amount');
  ok(ids.every((id) => a.prog.get(id) !== z.prog.get(id)), 'B0 BEFORE: changing only the COLONY fraction changes every larva\'s development');
}
for (const [form, extra] of FORMS) {
  const b = mk(true, form, extra), sp = resolveBundle(b).species[MAIN_SPECIES] as Any;
  const a = dayWith(b, base, own, { pFraction: 1, sFraction: 1 }), z = dayWith(b, base, own, { pFraction: 0.05, sFraction: 0.05 }), r = dayWith(b, base, own, { pFraction: 1, sFraction: 1 }, true);
  ok(ids.every((id) => a.prog.get(id) === z.prog.get(id)), `B1 ${form}: the colony fraction has no effect on any larva`);
  ok(ids.every((id) => r.prog.get(id) === a.prog.get(id)), `B3 ${form}: reversed brood and worker arrays give every larva the same development by ID`);
  const f = Math.min(1.9, Math.max(0.48, Math.pow(sp.development.q10, (27 - sp.development.reference_c) / 10)));
  ok(ids.every((id) => a.prog.get(id) === Math.round((0.2 + f / sp.development.larva_days * nutritionFactor(own.get(id) as number, sp) + Number.EPSILON) * 1e6) / 1e6), `B1 ${form}: each larva advances by r(T)/larva_days × N(own x) (x = 0, 0.4, 1 -> N = ${[0, 0.4, 1].map((x) => nutritionFactor(x, sp).toFixed(3)).join(', ')})`);
}

// ---------------------------------------------------------------- real C4b days: engine accepts, reader agrees; far larvae; counterexamples
for (const [form, extra] of FORMS) {
  const b = mk(true, form, extra), raw = b.species[MAIN_SPECIES], sp = resolveBundle(b).species[MAIN_SPECIES] as Any;
  let s: Any = buildDay0('A5' as Any, 5, '2027-03-21', b).state, days = 0, recs = 0, bad = 0;
  const kept: Any[] = [];
  for (let d = 0; d < 80; d++) { const o: Any = simulateWorldDay(s, b), ev = o.result.colonies[0].events; const r = replayLarvaDevelopment(s.colonies[0], o.state.colonies[0], ev, raw, o.result.weather.nest_temp_model_c); if (!r.ok) bad++; recs += r.larvae; days++; if (r.larvae > 0) kept.push({ s, o }); s = o.state; }
  ok(bad === 0 && recs > 0, `B4 ${form}: the reader accepts all ${days} real days (${recs} larva-development records); the engine checked them while running`);
  // B2: far larvae (another place) leave the originals' development bit-identical
  const s0 = kept[0]?.s;
  if (s0) {
    const far = structuredClone(s0); for (let i = 0; i < 15; i++) far.colonies[0].population.brood.push({ id: `ZZFAR${i}`, stage: 'larva', laid_on_day: null, age_days: null, progress: 0.1, begging_signal: 0.9, location: 'brood_far', origin: 'test' });
    let x: Any = s0, y: Any = far, firstDiff: number | null = null, sameDay1 = false;
    const orig = s0.colonies[0].population.brood.filter((q: Any) => q.stage === 'larva').map((q: Any) => q.id);
    for (let d = 0; d < 8; d++) { const ox: Any = simulateWorldDay(x, b), oy: Any = simulateWorldDay(y, b); const pick = (o: Any) => JSON.stringify(o.result.colonies[0].events.filter((e: Any) => e.type === 'larva_development' && orig.includes(e.larva))); if (d === 0) sameDay1 = pick(ox) === pick(oy); if (pick(ox) !== pick(oy) && firstDiff === null) firstDiff = d + 1; x = ox.state; y = oy.state; }
    ok(sameDay1, `B2 ${form}: on the day they are added, 15 larvae at another place leave every original larva's development record bit-identical`);
    // stated, not hidden: over several days the originals can differ (first on day ${firstDiff}) through two EXISTING colony-wide
    // paths outside C4b — the old nurse begging cue (engine/workers.ts W-NURSECONTACT) samples larvae at ANY place and steers
    // foraging, and queen laying reads the colony brood count (C3b, paused). Reported in the PR as a new locality defect.
    (evidence.B2_multi_day ??= {} as Any)[form] = { first_day_with_a_difference: firstDiff, mechanism: 'old nurse cue samples larvae at any place (workers.ts:79) -> foraging and crops; queen laying reads the colony brood count' };
  }
  // B4 counterexamples on a day with development records
  const k0 = kept.find((k) => k.o.result.colonies[0].events.some((e: Any) => e.type === 'larva_development' && e.progress_after < 1 && k.o.state.colonies[0].population.brood.some((x: Any) => x.id === e.larva && x.stage === 'larva')));
  if (k0) {
    const engine = (ev: Any[], after: Any) => { const pre = structuredClone(k0.s.colonies[0]), had = ensureBroodRecords(pre, false, []); try { checkLarvaDevelopment(larvaRoundStart(pre, sp, had, false), after, ev, sp, k0.o.result.weather.nest_temp_model_c, Number(after.last_report.metabolic_factor), k0.s.colonies[0].population.workers.length); return ''; } catch (e) { return String(e); } };
    const reader = (ev: Any[], after: Any) => replayLarvaDevelopment(k0.s.colonies[0], after, ev, raw, k0.o.result.weather.nest_temp_model_c).errors;
    const ev0 = k0.o.result.colonies[0].events, a0 = k0.o.state.colonies[0];
    ok(engine(ev0, a0) === '' && reader(ev0, a0).length === 0, `B4 ${form}: the unmodified day is accepted`);
    const forge = (name: string, edit: (ev: Any[], after: Any) => void) => { const ev = structuredClone(ev0), after = structuredClone(a0); edit(ev, after); ok(engine(ev, after) !== '' && reader(ev, after).length > 0, `B4 ${form} ${name}: rejected by the engine and the reader`); };
    const rec = (ev: Any[]) => ev.find((e: Any) => e.type === 'larva_development' && e.progress_after < 1 && a0.population.brood.some((x: Any) => x.id === e.larva && x.stage === 'larva'));
    forge('D1 faster development than its own record allows (record and state edited)', (ev, after) => { const r = rec(ev); r.progress_after = Math.round((r.progress_after + 0.05) * 1e6) / 1e6; after.population.brood.find((x: Any) => x.id === r.larva).progress = r.progress_after; });
    forge('D2 a nutrition factor not from its own paid fraction', (ev) => { const r = rec(ev); r.nutrition_factor = 1; r.own_paid_fraction = 1; });
    forge('D3 a larva with no development record', (ev) => { const r = rec(ev); ev.splice(ev.indexOf(r), 1); });
    forge('D4 two development records for one larva', (ev) => { const r = rec(ev); ev.splice(ev.indexOf(r) + 1, 0, structuredClone(r)); });
    forge('D5 end progress that does not follow the record', (_ev, after) => { const r = rec(ev0); after.population.brood.find((x: Any) => x.id === r.larva).progress = 0.999; });
    // Codex review (2026-11-07): pupation exactly at progress ≥ 1, and none on a day without care
    forge('D6 a pupation although the progress is below 1', (ev, after) => { const r = rec(ev), l = after.population.brood.find((x: Any) => x.id === r.larva); l.stage = 'pupa'; l.progress = 0; l.age_days = 0; ev.push({ type: 'pupation', id: r.larva }); });
  } else ok(true, `B4 ${form}: no suitable day (not exercised; stated)`);
}
{ const o: Any = simulateWorldDay(buildDay0('A1' as Any, 3, '2027-03-21', mk(false)).state, mk(false)); ok(!o.result.colonies[0].events.some((e: Any) => e.type === 'larva_development'), 'B5: with C4b off no larva_development record is written'); }
// D7 (Codex review 2026-11-07): a day without any worker — no larva may gain progress, with or without a record
for (const [form, extra] of FORMS) {
  const b = mk(true, form, extra), raw = b.species[MAIN_SPECIES], sp = resolveBundle(b).species[MAIN_SPECIES] as Any;
  let s: Any = buildDay0('A1' as Any, 3, '2027-03-21', b).state;
  for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((x: Any) => x.stage === 'larva' && x.body).length < 2; k++) s = simulateWorldDay(s, b).state;
  const lone = structuredClone(s); lone.colonies[0].population.workers = [];
  const o: Any = simulateWorldDay(lone, b), ev = o.result.colonies[0].events, a0 = o.state.colonies[0];
  const target = a0.population.brood.find((x: Any) => x.stage === 'larva' && x.body);
  const engine = (after: Any) => { const pre = structuredClone(lone.colonies[0]), had = ensureBroodRecords(pre, false, []); try { checkLarvaDevelopment(larvaRoundStart(pre, sp, had, false), after, ev, sp, o.result.weather.nest_temp_model_c, Number(after.last_report.metabolic_factor), 0); return ''; } catch (e) { return String(e); } };
  const reader = (after: Any) => replayLarvaDevelopment(lone.colonies[0], after, ev, raw, o.result.weather.nest_temp_model_c).errors;
  ok(!ev.some((e: Any) => e.type === 'larva_development') && engine(a0) === '' && reader(a0).length === 0, `D7 ${form}: a no-care day has no development record and is accepted`);
  if (target) { const forged = structuredClone(a0); forged.population.brood.find((x: Any) => x.id === target.id).progress = Math.round((target.progress + 0.1) * 1e6) / 1e6; ok(engine(forged) !== '' && reader(forged).length > 0, `D7 ${form}: progress gained on a no-care day without any record is rejected by the engine and the reader`); }
  else ok(true, `D7 ${form}: no larva survived the no-care day (not exercised; stated)`);
}

// ---------------------------------------------------------------- B7 Yuan 2026 observation operator (report only)
{
  // one day-cohort of 200 eggs, nest fixed at 28 °C, every larva paid its full need daily (ad libitum), workers present
  const sp = resolveBundle(mk(true, 'clamp_linear')).species[MAIN_SPECIES] as Any;
  const s: Any = structuredClone(base); s.colonies[0].population.brood = Array.from({ length: 200 }, (_, i) => ({ id: `Y${String(i).padStart(3, '0')}`, stage: 'egg', laid_on_day: 0, age_days: 0, progress: 0, origin: 'test cohort', reserve_basis: 'day0_scenario', egg_investment: null }));
  const milestone: Record<string, number[]> = { hatch: [], pupation: [], eclosion: [] };
  for (let day = 1; day <= 60 && s.colonies[0].population.brood.length; day++) {
    const ev: Any[] = [], summary: Any = { brood_deaths: 0, hatchings: 0, pupations: 0, eclosions: 0 };
    const full = new Map<string, number>(s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva').map((b: Any) => [b.id as string, 1] as [string, number]));
    developBrood(s, s.colonies[0], sp, { nest_temp_model_c: 28 } as Any, { pFraction: 1, sFraction: 1 }, ev, summary, full);
    for (const e of ev) { if (e.type === 'hatch') milestone.hatch.push(day); if (e.type === 'pupation') milestone.pupation.push(day); if (e.type === 'eclosion') milestone.eclosion.push(day); }
  }
  const stat = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return { n: xs.length, mean: +m.toFixed(2), sd: +Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)).toFixed(2) }; };
  const sim = { hatch: stat(milestone.hatch), pupation: stat(milestone.pupation), eclosion: stat(milestone.eclosion) };
  ok(sim.eclosion.n === 200, `B7: the cohort ecloses (operator ran; ${JSON.stringify(sim)})`);
  evidence.B7_yuan_operator = { conditions: '28 °C fixed, ad libitum (x = 1), daily census, one 200-egg cohort; deterministic development, no individual factor', simulated: sim, observed_yuan_2026: { hatch: '7.69 ± 0.63 d (n 227)', pupa: '23.68 d (n 80)', adult_non_reproductive: '28.73 ± 2.83 d (n 52)' }, note: 'report only, not a fit; the simulated SD is 0 because development is deterministic and the cohort is synchronous — an expected mismatch, not tuned (P0-B decides individual variation)' };
}

// ---------------------------------------------------------------- B8 Phillips 1933 direction: 2 weeks unfed at 25 °C, then fed (report only)
{
  const out: Record<string, unknown> = {};
  for (const [form, extra] of FORMS) {
    const sp = resolveBundle(mk(true, form, extra)).species[MAIN_SPECIES] as Any;
    const run = (starve: boolean) => { const s: Any = structuredClone(base); s.colonies[0].population.brood = [{ ...structuredClone(base.colonies[0].population.brood[0]), progress: 0 }]; for (let day = 1; day <= 80; day++) { const ev: Any[] = []; const id = s.colonies[0].population.brood[0]?.id; developBrood(s, s.colonies[0], sp, { nest_temp_model_c: 25 } as Any, { pFraction: 1, sFraction: 1 }, ev, { brood_deaths: 0, hatchings: 0, pupations: 0, eclosions: 0 } as Any, new Map<string, number>([[id as string, starve && day <= 14 ? 0 : 1]])); if (ev.some((e: Any) => e.type === 'pupation')) return day; } return null; };
    out[form] = { fed: run(false), unfed_first_14_days: run(true) };
    ok((out[form] as Any).unfed_first_14_days > (out[form] as Any).fed, `B8 ${form}: two unfed weeks prolong the larval stage (${JSON.stringify(out[form])} days to pupation) — the direction Phillips 1933 reports; no quantity compared`);
  }
  evidence.B8_phillips_direction = out;
}

console.log(JSON.stringify({ test: 'c4b-larva-development', checks, evidence, note: 'engineering checks with TEST-ONLY forms; the nutrition-response form is an Owner decision (null as shipped)' }, null, 2));

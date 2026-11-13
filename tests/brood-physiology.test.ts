/**
 * #214 Q2/Q3 brood physiology — design phase (docs/p0a2-brood-physiology-design.md). Checks:
 *  1. the candidates file: schema, units, evidence labels, assumption flags, sensitivity ranges, source IDs that exist in
 *     docs/references.md, the Yuan 2026 (R94) anchor recorded with its limits, 3 instars, stage sum = 28.73 d;
 *  2. the reference calculation (prototypes/brood-physiology/reference-model.ts): per-larva conservation, determinism,
 *     chunk (booking) invariance, locality (signature + static), 28 °C anchor reproduction (calibration, by construction),
 *     sugar-vs-protein limitation distinguishable at the low, central and high demand corners WITHOUT any demand scaling,
 *     predicted own-event times consistent with booking, hazard families (H1 mechanics; #226: R167 recorded as a
 *     constraint on R + τ, not on τ — the 14–30 d τ interval is a game assumption);
 *  3. every table quoted in the design doc equals the analysis output verbatim;
 *  4. isolation: nothing official, the P0-A2 prototype or the experiment Worker imports the brood-physiology folder.
 * Design-phase only: no value is a target; failures mean the candidates and the doc disagree, not that biology failed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { DIETS, renderAll, runAdLib, runDiet, tables } from '../prototypes/brood-physiology/analysis.ts';
import { DEMAND_DIRECTION, advance, constantEnv, demand, devRate, feed, ledger, model, newEgg, params, predictNext } from '../prototypes/brood-physiology/reference-model.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DIR = path.join(REPO_ROOT, 'prototypes/brood-physiology');
const FILE = path.join(DIR, 'brood-physiology.candidates.json');
const DOC = path.join(REPO_ROOT, 'docs/p0a2-brood-physiology-design.md');
const refs = fs.readFileSync(path.join(REPO_ROOT, 'docs/references.md'), 'utf8');
const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// ---------- 1. candidates file ----------
ok(c.schema === 'antempire.brood-physiology.candidates.v1' && c.official === false, 'schema v1, non-official');
ok(/非正式/.test(c.status) && /assumption: true/.test(c.status), 'status says non-official and that all values are model priors');
const CLASSES = ['this_species', 'other_species_extrapolated', 'general_physiology', 'game_assumption'];
ok(JSON.stringify(Object.keys(c.evidence_classes)) === JSON.stringify(CLASSES), 'four evidence classes, as defined');
const UNITS = new Set(['d', '°C', 'µg', 'mg', '無因次', '無因次（CV）', '無因次（每齡末體重比）', '比例', '比例（相對成蟲蛋白）', '比例（同化／攝入）', '比例（沉積／同化）', '比例（蛹／幼蟲）',
  'g 蛋白／g 乾重', 'mL O₂ g⁻¹（鮮重）h⁻¹', '倍數', 'mg／mL', 'mg 蔗糖／mg O₂', 'µg 糖當量／µg 沉積蛋白', 'µg 液體／遊戲份', 'g 糖／g 液體', 'g 蛋白／g 液體', 'd（參考 25°C）', '比例（未付維持量／成蟲蛋白當量）']);
const refIds = new Set([...refs.matchAll(/^\|\s*(R\d+)\s*\|/gm)].map((m) => m[1]));
const params0 = Object.entries(c.parameters) as [string, any][]; // eslint-disable-line @typescript-eslint/no-explicit-any
ok(params0.length >= 40, `parameters listed (${params0.length})`);
for (const [k, e] of params0) {
  ok(/^[a-z0-9_]+$/.test(k), `${k}: id format`);
  ok(e.value === null || (typeof e.value === 'number' && Number.isFinite(e.value)), `${k}: value is a finite number or null`);
  ok(typeof e.unit === 'string' && UNITS.has(e.unit), `${k}: unit "${e.unit}" is a declared unit`);
  ok(CLASSES.includes(e.evidence_class), `${k}: evidence class`);
  ok(e.assumption === true, `${k}: assumption: true (every value is a model prior, CLAUDE.md §3)`);
  ok(Array.isArray(e.sources) && e.sources.every((s: string) => refIds.has(s)), `${k}: every source ID is a row in docs/references.md (${e.sources.join(',')})`);
  ok(e.evidence_class === 'game_assumption' || e.evidence_class === 'general_physiology' || e.sources.length > 0, `${k}: literature classes cite at least one source`);
  ok(e.evidence_class !== 'other_species_extrapolated' || (typeof e.species_of_source === 'string' && e.species_of_source.length > 3 && /非本種|外推/.test(e.note + c.evidence_classes.other_species_extrapolated)), `${k}: other-species value names its species`);
  ok(e.sensitivity && Number.isFinite(e.sensitivity.min) && Number.isFinite(e.sensitivity.max) && e.sensitivity.min <= e.sensitivity.max, `${k}: sensitivity range`);
  ok(e.value === null || (e.value >= e.sensitivity.min - 1e-12 && e.value <= e.sensitivity.max + 1e-12), `${k}: candidate value inside its sensitivity range`);
  ok(typeof e.note === 'string' && e.note.length > 8, `${k}: note`);
}
ok(!JSON.stringify(c).includes('R930'), 'does not cite R930 (only on open PR branches, not on main)');
// unknown quantities stay null (no invented numbers)
for (const k of ['dev_cv_egg', 'dev_cv_larva', 'dev_cv_pupa', 'temp_tmax_c', 'protein_hatch_fraction', 'protein_assim_solid', 'maint_l1_multiplier', 'bridge_sugar_fraction', 'bridge_protein_fraction', 'haz_h1_tau_e_d', 'haz_h2_lambda_d', 'haz_h2_k', 'haz_h3_debt_fraction'])
  ok(c.parameters[k].value === null, `${k}: unknown → null`);
ok(Object.values(c.owner_choices).every((o: any) => o.value === null && Array.isArray(o.options) && o.options.length >= 2), 'every Owner choice is open (value null)'); // eslint-disable-line @typescript-eslint/no-explicit-any
// the Yuan anchor and its limits
const a = c.anchor;
ok(a.source === 'R94' && refIds.has('R94') && /10\.3390\/insects17100992/.test(a.citation) && a.species === 'Pheidole megacephala', 'anchor is R94 (Yuan 2026, doi recorded)');
ok(a.conditions.temperature_c === 28 && a.conditions.temperature_tolerance_c === 1 && a.larval_instars === 3, 'anchor: 28 ± 1 °C, three larval instars');
ok(a.egg_to_adult_non_reproductive_days.mean === 28.73 && a.egg_to_adult_non_reproductive_days.sd === 2.83 && a.egg_to_adult_non_reproductive_days.n === 52, 'anchor: 28.73 ± 2.83 d (n 52)');
const LIMITS = ['single_temperature', 'no_starvation_threshold', 'not_taichung_field', 'sd_not_individual', 'n_decline_not_survival', 'castes_merged', 'stage_lengths_are_mean_differences'];
ok(LIMITS.every((id) => a.limits.some((l: { id: string; text: string }) => l.id === id && l.text.length > 10)), 'anchor limits recorded: temperature, starvation, Taichung field, SD, n decline, castes, mean differences');
ok(JSON.stringify(c.stage_order) === JSON.stringify(['egg', 'L1', 'L2', 'L3', 'prepupa', 'pupa']) && JSON.stringify(c.feeding_stages) === JSON.stringify(['L1', 'L2', 'L3']), 'stage order: egg, 3 instars, prepupa, pupa');
const D = ['egg', 'l1', 'l2', 'l3', 'prepupa', 'pupa'].map((s) => c.parameters[`dev_d28_${s}`].value as number);
ok(Math.abs(D.reduce((x, y) => x + y, 0) - 28.73) < 1e-9, 'stage durations at 28 °C sum to the Yuan egg→adult mean');
const ms = a.milestones_days_from_oviposition.map((m: { mean: number }) => m.mean);
ok([ms[0], ms[1] - ms[0], ms[2] - ms[1], ms[3] - ms[2], ms[5] - ms[4]].every((x: number, i: number) => Math.abs(x - [D[0], D[1], D[2], D[3], D[5]][i]) < 0.005), 'stage durations = differences of the recorded milestone means');
// new R-IDs: present once each on main, no collision
for (const id of ['R940', 'R941', 'R942', 'R943', 'R944']) ok([...refs.matchAll(new RegExp(`^\\|\\s*${id}\\s*\\|`, 'gm'))].length === 1, `${id}: exactly one row in references.md`);
ok(Object.keys(DEMAND_DIRECTION).every((k) => k in c.parameters), 'demand-direction keys are candidate parameters');

// ---------- 2. reference calculation ----------
const p = params(c), H0 = { family: 'H0' as const }, M = model(p, H0), env28 = constantEnv('flat', 28);
// 2a. 28 °C anchor (calibration by construction: φ_s(28) = 1 and D28_s from R94)
for (const tm of ['flat', 'linear_dd_A', 'q10_refit'] as const) {
  const L = runAdLib(c, tm, 28);
  ok(L.stage === 'adult' && Math.abs((L.stage_entry.adult as number) - 28.73) < 1e-6, `${tm}: ad-lib egg→adult at 28 °C = 28.73 d`);
  ok(L.limit_time.P === 0 && L.limit_time.E_growth === 0 && L.limit_time.E_deficit === 0, `${tm}: ad-lib larva is never nutrient-limited (absorption capacity ≥ Yuan-rate demand)`);
}
ok(devRate(p, 'linear_dd_A', 'L2', 21) < devRate(p, 'linear_dd_A', 'L2', 28) && devRate(p, 'linear_dd_A', 'L2', 13) === 0, 'linear degree-day: slower at 21 °C, zero at/below T0');
// 2b. conservation, determinism
const scenario = (bookEveryMin: number | null) => {
  const L = newEgg('E0042', 7), env = constantEnv('linear_dd_A', 26.5), R = [[8.0, 2.0, 1.5], [9.0, 0.5, 3.0], [11.5, 3.0, 0.0], [13.0, 0.0, 4.0], [16.0, 6.0, 6.0], [19.0, 10.0, 12.0], [21.0, 0.0, 9.0]];
  const times = new Set<number>(R.map((r) => r[0]));
  if (bookEveryMin !== null) for (let t = 0; t < 45; t += bookEveryMin / 1440) times.add(t);
  for (const t of [...times].sort((x, y) => x - y)) { const r = R.find((x) => x[0] === t); if (r) feed(L, t, r[1], r[2], env, M2); else advance(L, t, env, M2); }
  advance(L, 45, env, M2); return L;
};
const M2 = model(p, { family: 'H2', lambda_d: c.reference_test_grid.haz_h2_lambda_d, k: c.reference_test_grid.haz_h2_k });
const s1 = scenario(null), s2 = scenario(null), s3 = scenario(17);
ok(JSON.stringify(s1) === JSON.stringify(s2), 'determinism: same inputs → identical larva');
for (const L of [s1, s3]) { const g = ledger(L); ok(Math.abs(g.sugar) < 1e-8 && Math.abs(g.protein) < 1e-8, `per-larva ledgers closed (sugar ${g.sugar.toExponential(1)}, protein ${g.protein.toExponential(1)})`); }
const close = (x: number, y: number) => Math.abs(x - y) <= 1e-7 * Math.max(1, Math.abs(x), Math.abs(y));
ok(s1.stage === s3.stage && ['gutS', 'gutP', 'resE', 'resP', 'struct', 'respired', 'unmet', 'egestaS', 'egestaP', 'corpseS', 'corpseP'].every((k) => close((s1 as any)[k], (s3 as any)[k])), 'chunk invariance: extra bookings every 17 min change no pool (float tolerance; implementation must be bit-exact)'); // eslint-disable-line @typescript-eslint/no-explicit-any
ok(Object.keys(s1.stage_entry).every((k) => close((s1.stage_entry as any)[k], (s3.stage_entry as any)[k])), 'chunk invariance: identical stage-entry / death times'); // eslint-disable-line @typescript-eslint/no-explicit-any
const sh = newEgg('E0042', 7), sh2 = newEgg('E0042', 7), sh3 = newEgg('E0043', 7);
ok(sh.hazardDraw === sh2.hazardDraw && sh.hazardDraw !== sh3.hazardDraw && sh.hazardDraw > 0, 'hazard draw: one own draw per larva, from (seed, id), never re-drawn');
// 2c. locality: the API has no colony / other-larva input, and the module names none
const src = fs.readFileSync(path.join(DIR, 'reference-model.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/colony|stores|workers|brood\b|larvae\b|population|protein_gap|pFraction|sFraction/.test(src), 'reference model reads no colony-level quantity (static)');
ok([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).every((m) => m === '../../engine/rng.ts'), 'reference model imports only engine/rng.ts');
ok(advance.length === 4 && feed.length === 6, 'advance(larva, t, env, model) / feed(larva, t, sugar, protein, env, model): one larva at a time');
const other = newEgg('E0099', 7); advance(other, 30, env28, M); const lone = newEgg('E0042', 7); advance(lone, 30, env28, M); const lone2 = newEgg('E0042', 7); advance(lone2, 30, env28, M);
ok(JSON.stringify(lone) === JSON.stringify(lone2), 'a larva\'s result does not depend on any other larva having been simulated');
// 2d. sugar vs protein limitation, at three demand corners of the SAME box (no scale factor exists in the API)
const rendered = tables(c);
for (const k of ['value', 'demand_low', 'demand_high'] as const) {
  const r = Object.fromEntries(DIETS.map((d) => [d, runDiet(c, k, d)]));
  ok(r.balanced.stage === 'adult' && r.balanced.limit_time.P === 0 && r.balanced.limit_time.E_deficit === 0, `${k}: demand-matched ration → no limitation`);
  ok(r.protein_half.limit_time.P > 1 && r.protein_half.limit_time.E_deficit === 0 && (r.protein_half.stage_entry.adult as number) > (r.balanced.stage_entry.adult as number), `${k}: protein-poor ration (same mass) → protein-limited delay, no energy deficit`);
  ok(r.sugar_half.limit_time.E_deficit > 1 && r.sugar_half.limit_time.P === 0 && (r.sugar_half.stage_entry.adult as number) > (r.balanced.stage_entry.adult as number), `${k}: sugar-poor ration (same mass) → energy-deficit delay, no protein limitation`);
  ok(r.sugar_only.limit_time.P > 30 && r.protein_only.limit_time.E_deficit > 30, `${k}: single-nutrient rations are stopped by different constraints`);
}
ok(JSON.stringify(params(c, 'demand_low')) !== JSON.stringify(params(c, 'demand_high')) && demand(params(c, 'demand_low'), 28)[3].protein_ingest_ug < demand(p, 28)[3].protein_ingest_ug && demand(p, 28)[3].protein_ingest_ug < demand(params(c, 'demand_high'), 28)[3].protein_ingest_ug, 'demand corners bracket the candidate demand');
// 2e. own-event prediction = what booking later observes
{
  const L = newEgg('E0007', 3), e = constantEnv('linear_dd_A', 27);
  advance(L, 7.0, e, M); const nx = predictNext(L, e, M, 2)!; advance(L, 10, e, M);
  ok(nx.what === 'stage:L1' && Math.abs(nx.t - (L.stage_entry.L1 as number)) < 1e-9, 'predicted hatch time = booked hatch time');
  feed(L, 10, 0.5, 0, e, M); const ny = predictNext(L, e, M, 3);
  ok(ny !== null && ny.what === 'reserve_empty', 'unfed larva: next own event is reserve exhaustion (start of the starvation clock)');
}
// 2f. hazard families
{
  const run = (h: any, T: number) => { const L = newEgg('E0001', 1), m = model(p, h), e = constantEnv('flat', T); advance(L, 60, e, m); return L; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(run({ family: 'H0' }, 25).stage === 'L1', 'H0: an unfed larva never dies (diagnostic only) and does not develop (feeding-stage gate)');
  // H1 mechanics only (model contract, not a scientific bound): death exactly τ after the deficit starts
  const tau0 = c.parameters.haz_h1_tau_e_d.sensitivity.min;
  const h1 = run({ family: 'H1', tau_d: tau0 }, 25);
  ok(h1.stage === 'dead' && Math.abs((h1.stage_entry.dead as number) - (7.69 + tau0)) < 1e-6, 'H1 mechanics: death exactly τ after the deficit starts (hatch, reserve_at_hatch = 0)');
  // #226: R167 constrains (unfed time to death) = R + τ, not τ. In the reference model a larva with τ = 5 d (< 14) that
  // had some reserve when feeding stopped still outlives Phillips' 14 and 21 d withholding windows → τ is not identifiable.
  {
    const m5 = model(p, { family: 'H1', tau_d: 5 }), e25 = constantEnv('flat', 25), L = newEgg('E0001', 1);
    advance(L, 7.69, e25, m5); feed(L, 7.69, 5, 0, e25, m5);
    const empty = predictNext(L, e25, m5, 100)!; advance(L, 60, e25, m5);
    const unfedToDeath = (L.stage_entry.dead as number) - 7.69, R_d = empty.t - 7.69;
    ok(empty.what === 'reserve_empty' && L.stage === 'dead' && unfedToDeath > 21 && Math.abs(unfedToDeath - (R_d + 5)) < 2 / 1440, 'H1 with τ = 5 d still survives > 21 d unfed when it had a reserve: unfed-to-death time = R + τ (R167 cannot bound τ alone)');
  }
  const h2 = run({ family: 'H2', lambda_d: 21, k: 2 }, 25), g2 = ledger(h2);
  ok(h2.stage === 'dead' && Math.abs(g2.protein) < 1e-9 && h2.corpseP === 0 && h2.corpseS === 0, 'H2: death moves the (empty) body to the corpse pools; ledgers stay closed');
}
// #226: the R167 observation is recorded as a constraint on R + τ for the observed larvae, kept apart from the model's τ
{
  const ob = c.literature_observations?.r167_phillips_1933_food_withholding;
  ok(ob && ob.source === 'R167' && ob.species === 'Pheidole megacephala' && /p\. 29/.test(ob.citation) && /10125\/13477/.test(ob.citation), 'R167 observation recorded with page and stable handle');
  ok(ob.conditions.temperature_c === 25 && /整巢/.test(ob.conditions.deprivation_unit), 'R167: 25 °C, colony-level food withholding (larva-level unfed time not recorded)');
  for (const k of ['instar_at_start', 'deprivation_start_relative_to_hatch_d', 'n_colonies_per_group', 'n_larvae', 'survival_fraction']) ok(ob.conditions[k] === null, `R167: ${k} not stated in the source → null`);
  const g = Object.fromEntries(ob.groups.map((x: any) => [x.id, x])); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(g.repeat_2wk.withheld_d === 14 && JSON.stringify(g.repeat_2wk.larval_period_d) === '[32,36]' && g.repeat_2wk.refeed_to_pupation_d === null, 'R167 2-week group: larval period 32–36 d; refeed→pupation not recorded');
  ok(g.accidental_3wk.withheld_d === 21 && g.accidental_3wk.refeed_to_pupation_d === 8, 'R167 accidental 3-week group: pupated 8 d after refeeding (kept separate from the 2-week group)');
  ok(g.repeat_3wk.larval_period_d === null && g.repeat_4wk.larval_period_d === null && /吃掉幼蟲/.test(g.repeat_3wk.observed), 'R167 repeated 3/4-week groups: workers died, larvae eaten → no larval tolerance data');
  ok(/R \+ τ/.test(ob.constrains) && /τ 本身/.test(ob.does_not_constrain) && ob.not_a_hard_bound_for === 'haz_h1_tau_e_d', 'R167 constrains R + τ only, not τ');
  ok(ob.non_identifiable.some((s: string) => s.startsWith('initial_reserve')) && ob.non_identifiable.some((s: string) => s.startsWith('deficit_start_time')), 'initial reserve and deficit start are listed as non-identifiable');
  const h = c.parameters.haz_h1_tau_e_d;
  ok(h.evidence_class === 'game_assumption' && h.sensitivity_basis === 'game_assumption' && h.assumption === true && /遊戲假設/.test(h.note) && /不是文獻下限/.test(h.note), 'τ candidate interval 14–30 d is labelled a game assumption, not a literature bound');
  ok(!h.sources.includes('R167') && h.related_observation === 'r167_phillips_1933_food_withholding', 'τ does not cite R167 as its source; it points to the separate observation record');
}

// ---------- 3. the doc quotes the analysis output verbatim ----------
const doc = fs.readFileSync(DOC, 'utf8');
for (const [k, v] of Object.entries(rendered)) ok(doc.includes(`<!-- bp:${k} -->\n${v}\n<!-- /bp:${k} -->`), `doc: table "${k}" equals the analysis output`);
ok([...doc.matchAll(/<!-- bp:([a-z_0-9]+) -->/g)].every((m) => m[1] in rendered), 'doc quotes no table the analysis does not produce');
ok(renderAll(c) === renderAll(c), 'analysis is deterministic');
for (const id of ['R94', 'R167', 'R940', 'R941', 'R942', 'R943', 'R944']) ok(doc.includes(id), `doc cites ${id}`);
ok(/28\.73/.test(doc) && /不得外推|不可外推/.test(doc), 'doc records the anchor and its extrapolation limits');
// #226: the inference boundary for R167 is documented; the old "R167 proves τ ≥ 14" claim is gone
ok(/R \+ τ/.test(doc) && /不可辨識/.test(doc) && /#226/.test(doc), 'doc: R167 constrains R + τ; initial reserve / deficit start non-identifiable (#226)');
ok(!/下限 14 d 來自 R167|H1 下限 ≥ 14 d（R167）|唯一的本種約束是 R167/.test(doc), 'doc no longer claims R167 gives a τ lower bound');
ok(/p\.29|p\. 29/.test(doc) && /意外 3 週組/.test(doc) && /重複試驗 2 週組/.test(doc), 'doc §9 cites the 2-week and accidental 3-week groups separately');
ok(/#222 Q6/.test(doc), 'doc notes that the #222 Q6 ruling stands but the τ range basis changed');
ok(/R167 更正（2026-11-13，#226/.test(refs), 'references.md: dated R167 correction note appended (#226)');

// ---------- 4. isolation ----------
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
// T13 (design §7, implementation phase, BP-1): the isolated, default-off candidate lives in prototypes/p0a2-24h/brood/
// (outside the experiment Worker graph; tests/bp1-brood.test.ts). That folder may NAME the candidate file (its schema
// and documentation) but imports nothing from the design folder: the caller passes the candidate data in. Everything
// else — official engine, cli, web, the P0-A2 core and the Worker — does not even mention the folder, as before.
const BROOD = path.join(REPO_ROOT, 'prototypes/p0a2-24h/brood') + path.sep;
const consumers = [...walk(path.join(REPO_ROOT, 'engine')), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src')), ...walk(path.join(REPO_ROOT, 'prototypes/p0a2-24h')), ...walk(path.join(REPO_ROOT, 'prototypes/continuous-world'))];
ok(consumers.filter((f) => !f.startsWith(BROOD)).every((f) => !fs.readFileSync(f, 'utf8').includes('brood-physiology')), 'no official, P0-A2 core or Worker code imports (or names) the brood-physiology design folder');
const broodFiles = consumers.filter((f) => f.startsWith(BROOD));
ok(broodFiles.length >= 2 && broodFiles.every((f) => !/(from\s+|import\s*\(\s*|import\s+)['"][^'"]*brood-physiology/.test(fs.readFileSync(f, 'utf8'))), 'the BP-1 candidate folder imports nothing from the design folder (candidate data is passed in by the caller)');

console.log(`brood-physiology: ${checks} checks passed`);

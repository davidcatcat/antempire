/**
 * BP-1 (Owner #222 Q1–Q8 all A, #219 Q1): brood physiology as an ISOLATED, DEFAULT-OFF research candidate inside P0-A2
 * (prototypes/p0a2-24h/brood/, docs/p0a2-brood-physiology-design.md §5 / §10, reports/bp1-brood/). Checks:
 *  1. configuration: labelled variants, Owner-ruled choices, refusals (briere, N-a..N-c, protein catabolism, a hazard /
 *     variance / solid-protein candidate whose parameter is null), linear_dd_B read from the candidate notes;
 *  2. one larva (module level): 28 °C anchor (calibration) and other temperatures vs the design table, integer
 *     conservation at every step, event-split and save / restore byte identity, own random streams, sugar-vs-protein
 *     limitation, zero supply, low protein, high temperature, hazard families H0..H3 with retain / reset, solid protein
 *     L3-only candidate, stage-mean maintenance comparison;
 *  3. inside the P0-A2 world: the default path is untouched (no option = the pinned reference), the candidate is a
 *     different variant (state + log), µP and mass / energy books close, chunking and snapshot / restore give identical
 *     logs and states, restore refuses a mismatched candidate, feeds log raw µP + converted ng with the bridge, the
 *     carer still sees only {begging, room}, and without a protein source every larva is protein-limited in L1;
 *  4. isolation: the experiment Worker graph never contains the brood folder; the P0-A2 core imports it nowhere.
 * No value here is a target: the anchor reproduces by construction (calibration), the rest are mechanism checks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import raw from '../prototypes/p0a2-24h/params.json' with { type: 'json' };
import cand from '../prototypes/brood-physiology/brood-physiology.candidates.json' with { type: 'json' };
import variants from '../prototypes/p0a2-24h/brood/bp1-variants.json' with { type: 'json' };
import { BP1_VERSION, bp1Config, bp1Hook, physModelOf, variantsProblems } from '../prototypes/p0a2-24h/brood/bp1.ts';
import { type BpLarva, PROG, advance, contactOf, feedLiquid, feedMass, feedSolid, ledgerProblem, newLarva, summary, thresholdOf } from '../prototypes/p0a2-24h/brood/physiology.ts';
import { World } from '../prototypes/p0a2-24h/world.ts';
import { canon } from '../prototypes/p0a2-24h/canon.ts';
import { P0A2_CODE_FILES } from '../prototypes/continuous-world/worker/p0a2-code-hash.ts';

const T0 = Date.now();
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const D = 86_400_000, H = 3_600_000, SC = 'taichung-march-ref';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** a variants file with one extra test variant (choices / values over the base) */
function withVariant(choices: Record<string, unknown>, values: Record<string, unknown>) {
  const v = clone(variants) as any;
  v.variants.t = { group: 'test', label: 'test', status: 'test', choices: Object.fromEntries(Object.entries(choices).map(([k, x]) => [k, { value: x, ruling: 'test' }])), values: Object.fromEntries(Object.entries(values).map(([k, x]) => [k, { ...v.base.values[k], value: x }])) };
  return v;
}
const modelOf = (choices: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => physModelOf(bp1Config(cand, withVariant(choices, values), 't'));
const days = (ms: number | undefined) => (ms === undefined ? NaN : ms / D);

// ------------------------------------------------------------------ 1. configuration
{
  ok(variantsProblems(variants).length === 0, `variants file labelled: ${variantsProblems(variants).join('; ')}`);
  const base = bp1Config(cand, variants, 'bp1-ref') as any;
  ok(base.choices.temperature_model === 'linear_dd_A' && base.choices.nutrition_gate === 'N-d' && base.choices.protein_catabolism === false && base.choices.maintenance_mass === 'actual'
    && base.choices.hazard_family === 'H0' && base.choices.hazard_recovery === 'retain' && base.choices.variance_model === 'S0' && base.choices.solid_protein_enabled === false, 'base choices = Owner #222 Q1–Q8 A');
  ok(base.values.liquid_protein_mg_per_portion === null, 'P0-A2 liquid carries no protein (no protein source; not patched)');
  for (const k of ['h1_tau_d', 'h2_lambda_d', 'h2_k', 'h3_debt_fraction', 'cv_egg', 'cv_larva', 'cv_pupa', 'protein_assim_solid']) ok(base.values[k] === null, `${k} stays null in the base`);
  ok(base.candidate_values.temp_ld_b_t0_egg_c === 17.74 && base.candidate_values.temp_ld_b_t0_larva_c === 13.84 && base.candidate_values.temp_ld_b_t0_pupa_c === 19.56, 'linear_dd_B thresholds read from the candidate notes (17.74 / 13.84 / 19.56)');
  ok(base.official === false && base.assumption === true && base.version === BP1_VERSION, 'config non-official, assumption, versioned');
  ok(canon(bp1Config(cand, variants, 'bp1-ref')) === canon(base), 'config deterministic');
  const refuse = (choices: Record<string, unknown>, values: Record<string, unknown>, re: RegExp, why: string) => { assert.throws(() => bp1Config(cand, withVariant(choices, values), 't'), re, why); checks++; };
  refuse({ temperature_model: 'briere' }, {}, /briere/, 'briere refused (Tmax null)');
  for (const g of ['N-a', 'N-b', 'N-c']) refuse({ nutrition_gate: g }, {}, /not implemented/, `${g} refused`);
  refuse({ protein_catabolism: true }, {}, /protein_catabolism/, 'protein catabolism refused (#222 Q5)');
  refuse({ hazard_family: 'H1' }, {}, /h1_tau_d.*null/, 'H1 with τ null refuses to activate');
  refuse({ hazard_family: 'H2' }, { h2_lambda_d: 21 }, /h2_k.*null/, 'H2 with k null refuses');
  refuse({ hazard_family: 'H3' }, {}, /h3_debt_fraction.*null/, 'H3 with threshold null refuses');
  refuse({ variance_model: 'M1' }, {}, /cv_egg.*null/, 'M1 with CV null refuses');
  refuse({ variance_model: 'M2' }, { cv_egg: 0.1, cv_larva: 0.1 }, /cv_pupa.*null/, 'M2 with a CV null refuses');
  refuse({ solid_protein_enabled: true }, {}, /protein_assim_solid.*null/, 'solid protein with assimilation null refuses');
  refuse({}, { sugar_bridge_mg_per_portion: null }, /sugar_bridge/, 'no sugar bridge → refused');
  assert.throws(() => bp1Config(cand, variants, 'nope'), /unknown BP-1 variant/); checks++;
  const bad = clone(variants) as any; bad.variants['bp1-t25'].values.nest_temp_c.assumption = false;
  ok(variantsProblems(bad).some((x) => /assumption/.test(x)), 'an unlabelled value is a variants problem');
  for (const n of Object.keys(variants.variants)) ok(bp1Hook(cand, variants, n).config_sha.length === 64, `variant ${n} builds`);
  // the sugar bridge: versioned PortionBridge inside the audit candidate range; only explicit factors
  const m = physModelOf(base);
  ok(m.sugar_bridge!.version === 'antempire.portion-bridge.v1' && m.sugar_bridge!.assumption === true && m.sugar_bridge!.per_portion.num / m.sugar_bridge!.per_portion.den === 16_200, 'sugar bridge 0.0162 mg / portion = 16 200 ng, versioned, assumption');
  ok(m.protein_bridge === null, 'no protein bridge in the P0-A2 food');
}

// ------------------------------------------------------------------ 2. one larva
/** ad-lib from the egg: every hour a feeding larva gets twice its hourly absorption capacity of sugar and protein */
function adlib(m: ReturnType<typeof modelOf>, seed = 1, id = 'l01', until = 120 * D, split?: (t: number) => number[]): BpLarva {
  const L = newLarva(m, id, seed, 0, 'egg');
  for (let t = 0; t < until && L.stage !== 'adult' && L.stage !== 'dead'; t += H) {
    for (const x of split?.(t) ?? []) advance(L, m, x, seed);
    advance(L, m, t, seed);
    if (['L1', 'L2', 'L3'].includes(L.stage)) { const k = m.stages[L.stage]; feedMass(L, m, t, seed, Math.ceil(k.abs_s / 12), Math.ceil(k.abs_p / 12), 'test:adlib'); }
    const p = ledgerProblem(L); if (p) assert.fail(p);
  }
  return L;
}
{
  // anchor (calibration, not validation) and other temperatures vs the design's reference table (§3.3): ≤ 0.03 d
  // difference from the 1-min grid (stage-entry steps before the first hourly feed, excess progress not carried)
  const table: [string, number, number][] = [['flat', 28, 28.73], ['linear_dd_A', 28, 28.73], ['q10_refit', 28, 28.73], ['linear_dd_A', 25, 38.16], ['linear_dd_A', 21, 73.0], ['q10_refit', 21, 72.0]];
  for (const [tm, T, want] of table) {
    const L = adlib(modelOf({ temperature_model: tm }, { nest_temp_c: T }));
    const got = days(L.stage_entry.adult);
    ok(L.stage === 'adult' && Math.abs(got - want) <= 0.03, `${tm} ${T} °C egg→adult ${got.toFixed(3)} d vs design ${want} d`);
    ok(L.limit_ms.P + L.limit_ms.E_growth + L.limit_ms.E_deficit <= 2 * H, `${tm} ${T} °C ad-lib: nutrition limits only at stage-entry steps before the first hourly feed`);
  }
  const ldB = adlib(modelOf({ temperature_model: 'linear_dd_B' }, { nest_temp_c: 25 })), ldA = adlib(modelOf({}, { nest_temp_c: 25 }));
  ok(days(ldB.stage_entry.adult) > days(ldA.stage_entry.adult), 'linear_dd_B (higher thresholds) is slower than A at 25 °C');
  // high temperature (32 °C, extrapolated): faster development and higher maintenance than at 28 °C
  const hot = adlib(modelOf({}, { nest_temp_c: 32 })), ref = adlib(modelOf());
  ok(days(hot.stage_entry.adult) < days(ref.stage_entry.adult) && hot.energy.sinks.maintenance / days(hot.stage_entry.adult) > ref.energy.sinks.maintenance / days(ref.stage_entry.adult), 'high temperature: faster, higher maintenance per day (extrapolation; no upper limit in linear_dd_A)');
  // mass balance: the deposited structure = the design's larval deposit; fed protein ≈ design 74.7 µg (ad-lib surplus aside)
  ok(Math.abs(ref.protein.pools.structure - physModelOf(bp1Config(cand, variants, 'bp1-ref')).dep_total) <= 3, `structure ${ref.protein.pools.structure} ng = larval deposit`);

  // event-split and save / restore byte identity: extra bookings at odd instants, and a JSON round trip, change nothing
  const m = modelOf();
  const a = adlib(m), b = adlib(m, 1, 'l01', 120 * D, (t) => [t - 1, t - 37_123, t - 59_999].filter((x) => x > 0));
  ok(canon(a) === canon(b), 'extra bookings between events: bit-identical larva');
  const c = newLarva(m, 'l01', 1, 0, 'egg');
  let cc: BpLarva = c;
  for (let t = 0; t < 120 * D && cc.stage !== 'adult'; t += H) {
    advance(cc, m, t, 1);
    if (['L1', 'L2', 'L3'].includes(cc.stage)) { const k = m.stages[cc.stage]; feedMass(cc, m, t, 1, Math.ceil(k.abs_s / 12), Math.ceil(k.abs_p / 12), 'test:adlib'); }
    if (t % (7 * D) === 0) cc = JSON.parse(JSON.stringify(cc)); // snapshot / restore
  }
  ok(canon(cc) === canon(a), 'snapshot / restore every 7 days: bit-identical larva');
  ok(Object.values(a.sugar.pools).every(Number.isSafeInteger) && Object.values(a.protein.pools).every(Number.isSafeInteger) && Object.values(a.energy.sinks).every(Number.isSafeInteger), 'every pool is an integer (ng / µJ)');
  ok(a.energy.sources['oxidation:sugar_energy_density@v1'] === a.energy.sinks.maintenance + a.energy.sinks.growth_cost, 'energy (µJ): oxidation = maintenance + growth cost');

  // own random streams: a larva's thresholds and hazard draw depend only on (seed, own id, stage)
  const m1 = modelOf({ variance_model: 'M1' }, { cv_egg: 0.15, cv_larva: 0.15, cv_pupa: 0.15 });
  const th = (id: string) => ['egg', 'L1', 'L2', 'L3', 'prepupa', 'pupa'].map((s) => thresholdOf(m1, 7, id, s as never));
  ok(canon(th('l03')) === canon(th('l03')) && canon(th('l03')) !== canon(th('l04')) && th('l03').every((x) => x !== PROG), 'M1: own reproducible thresholds per larva and stage');
  const lone = newLarva(m1, 'l05', 7, 0, 'egg'), crowd = ['l01', 'l02', 'l03', 'l04', 'l05'].map((id) => newLarva(m1, id, 7, 0, 'egg'))[4];
  ok(canon(lone) === canon(crowd), 'creating other larvae does not change this larva');
  const m2 = modelOf({ variance_model: 'M2' }, { cv_egg: 0.15, cv_larva: 0.15, cv_pupa: 0.15 });
  const spread = (mm: typeof m1) => { const x = Array.from({ length: 40 }, (_, i) => days(adlib(mm, 3, `x${i}`).stage_entry.adult)); return [Math.min(...x), Math.max(...x)]; };
  const s1 = spread(m1), s2 = spread(m2), s0 = spread(m);
  ok(s0[0] === s0[1] && s1[1] - s1[0] > 1 && s2[1] - s2[0] > 1, `S0: same day for every larva (known disagreement with R94, reported); M1 / M2 spread ${s1.map((x) => x.toFixed(2))} / ${s2.map((x) => x.toFixed(2))} d`);

  // sugar vs protein limitation through the N-d gate (same delivered mass, composition differs)
  const diet = (sugarShare: number) => {
    const L = newLarva(m, 'l01', 1, 0, 'L1');
    for (let t = 0; t < 20 * D; t += H) { advance(L, m, t, 1); if (['L1', 'L2', 'L3'].includes(L.stage)) { const k = m.stages[L.stage], tot = Math.ceil((k.abs_s + k.abs_p) / 24); feedMass(L, m, t, 1, Math.round(tot * sugarShare), tot - Math.round(tot * sugarShare), 'test:diet'); } }
    return L;
  };
  const sugarOnly = diet(1), proteinOnly = diet(0);
  ok(sugarOnly.stage === 'L1' && sugarOnly.limit_ms.P > 19 * D && sugarOnly.unmet_ng === 0, 'sugar only: stays in L1, protein-limited, maintenance paid');
  ok(proteinOnly.stage === 'L1' && proteinOnly.limit_ms.E_deficit > 19 * D && (proteinOnly.protein.pools.structure ?? 0) === 0, 'protein only: maintenance unpaid (no protein catabolism), no growth');

  // zero supply from hatch: H0 never kills; H1 kills exactly τ after the deficit starts; H2 / H3 kill; corpse closes the books
  const starve = (mm: ReturnType<typeof modelOf>, sugar0 = 0) => { const L = newLarva(mm, 'l01', 1, 0, 'L1'); if (sugar0) feedMass(L, mm, 0, 1, sugar0, 0, 'test:once'); advance(L, mm, 60 * D, 1); return L; };
  const h0 = starve(m);
  ok(h0.stage === 'L1' && h0.deficit_ms > 59 * D && h0.death === null && ledgerProblem(h0) === null, 'H0: zero supply → deficit recorded, never dead');
  const h1 = starve(modelOf({ hazard_family: 'H1' }, { h1_tau_d: 5 }), 5_000);
  const empty = h1.stage_entry.dead! - 5 * D;
  ok(h1.stage === 'dead' && h1.max_bout_ms === 5 * D && empty > D && ledgerProblem(h1) === null && (h1.sugar.pools.reserve ?? 0) === 0, `H1 τ 5 d (test value): dead exactly 5 d after its reserve ran out (day ${days(h1.stage_entry.dead).toFixed(3)}); body → corpse; books closed`);
  const h2 = starve(modelOf({ hazard_family: 'H2' }, { h2_lambda_d: 21, h2_k: 2 }));
  ok(h2.stage === 'dead' && Math.abs(h2.lambda - h2.hazard_draw) < 1e-3, 'H2: dies when its own Λ reaches its own Exp(1) draw');
  const h3 = starve(modelOf({ hazard_family: 'H3' }, { h3_debt_fraction: 0.1 }));
  ok(h3.stage === 'dead' && h3.debt_ng >= physModelOf(bp1Config(cand, withVariant({ hazard_family: 'H3' }, { h3_debt_fraction: 0.1 }), 't')).h3_debt_ng!, 'H3: dies when its unpaid maintenance reaches the threshold');
  // intermittent feeding: retain keeps Λ across bouts, reset forgets it (Owner #222 Q6: retain is the conservative default)
  const intermittent = (rec: string) => {
    const mm = modelOf({ hazard_family: 'H2', hazard_recovery: rec }, { h2_lambda_d: 21, h2_k: 2 }), L = newLarva(mm, 'l01', 1, 0, 'L1');
    for (let d = 0; d < 40 && L.stage !== 'dead'; d += 8) { advance(L, mm, d * D, 1); if (L.stage === 'L1') feedMass(L, mm, d * D, 1, 300, 0, 'test:pulse'); }
    advance(L, mm, 40 * D, 1); return L;
  };
  const ret = intermittent('retain'), rst = intermittent('reset');
  ok(ret.lambda_prev > 0 && (ret.stage === 'dead' || ret.lambda > rst.lambda) && canon(ret) !== canon(rst), `hazard retain vs reset differ under intermittent feeding (retain Λ ${ret.lambda.toFixed(3)}, reset Λ ${rst.lambda.toFixed(3)})`);

  // solid protein: refused when off; L3 only when on (isolated candidate, non-species source R620)
  assert.throws(() => feedSolid(newLarva(m, 'l01', 1, 0, 'L1'), m, 0, 1, 1000, 'test:solid'), /solid protein candidate is off/); checks++;
  const ms = modelOf({ solid_protein_enabled: true }, { protein_assim_solid: 0.6 });
  const l1 = newLarva(ms, 'l01', 1, 0, 'L1'), l3 = newLarva(ms, 'l02', 1, 0, 'L3');
  ok(feedSolid(l1, ms, 0, 1, 1000, 'test:solid') === false && Object.keys(l1.protein.sources).length === 0, 'solid protein not accepted by L1 (nothing created)');
  ok(feedSolid(l3, ms, 0, 1, 1000, 'test:solid') === true && l3.protein.pools.gut_solid === 1000, 'solid protein accepted by L3');
  advance(l3, ms, D, 1); ok(l3.protein.pools.gut_solid < 1000 && ledgerProblem(l3) === null, 'solid protein absorbed with its own assimilation; books closed');

  // stage-mean maintenance comparison differs from the actual-mass candidate
  const sm = adlib(modelOf({ maintenance_mass: 'stage_mean' })), am = adlib(m);
  ok(sm.energy.sinks.maintenance !== am.energy.sinks.maintenance, `maintenance: actual-mass ${am.energy.sinks.maintenance} µJ vs stage-mean ${sm.energy.sinks.maintenance} µJ`);

  // non-feeding stages do not ingest; contact signal from own gut only; adults / dead are not brood
  const egg = newLarva(m, 'e1', 1, 0, 'egg');
  assert.throws(() => feedMass(egg, m, 0, 1, 10, 0, 'x'), /cannot ingest/); checks++;
  ok(canon(contactOf(egg, m, 25_000)) === canon({ begging: 0, room: 0, contactable: true }), 'an egg is touched but does not beg');
  const lf = newLarva(m, 'l1', 1, 0, 'L1');
  ok(contactOf(lf, m, 25_000).begging === 1 && contactOf(lf, m, 25_000).room === 25_000, 'empty L1: begging 1, room = the whole legacy gut capacity');
  const fed = feedLiquid(lf, m, 0, 1, 25_000);
  ok(fed.raw_up === 25_000 && fed.sugar_ng === 405 && fed.protein_ng === 0 && fed.assumption === true && /bp1-sugar-0\.0162@antempire\.portion-bridge\.v1/.test(String(fed.sugar_bridge)), 'liquid feed: 0.025 portion → 405 ng sugar (raw + converted + bridge id)');
  ok(contactOf(lf, m, 25_000).begging === 0 && contactOf(lf, m, 25_000).room === 0, 'full gut: no begging, no room');
  ok(canon(contactOf(h1, m, 25_000)) === canon({ begging: 0, room: 0, contactable: false }), 'a dead larva is not brood');
}

// ------------------------------------------------------------------ 3. inside the P0-A2 world
{
  const hook = bp1Hook(cand, variants, 'bp1-ref');
  // default path untouched: no option and an explicit undefined give the same world as before (pins in p0a2-24h-proto)
  const ref = World.create(raw, SC, 1, { captureLog: true }); ref.advanceTo(6 * H);
  const ref2 = World.create(raw, SC, 1, { brood: undefined }); ref2.advanceTo(6 * H);
  ok(ref.stateHash() === ref2.stateHash() && ref.logHash === ref2.logHash && !('brood' in JSON.parse(ref.snapshot())), 'no brood option: reference world (no brood key, same hashes)');
  ok(!ref.lines!.some((l) => /brood_day|"bp"/.test(l)), 'reference log has no candidate entries');

  const run = (chunks: number[], restoreAt?: number) => {
    let w = World.create(raw, SC, 1, { captureLog: true, brood: hook }); const lines: string[] = [];
    for (const t of chunks) {
      w.advanceTo(t); lines.push(...w.lines!.splice(0));
      if (t === restoreAt) w = World.restore(raw, w.snapshot(), { captureLog: true, brood: hook });
      ok(w.conservation().ok, `conservation at ${t}`);
    }
    return { w, lines };
  };
  const end = 3 * D;
  const one = run([end]), many = run([1, 999, 3 * H + 7, D, D + 1, 2 * D - 1, end]), rest = run([D + 12_345, end], D + 12_345);
  ok(one.w.logHash === many.w.logHash && one.w.stateHash() === many.w.stateHash(), 'candidate world: chunking gives identical log and state');
  ok(one.w.logHash === rest.w.logHash && one.w.stateHash() === rest.w.stateHash() && canon(one.lines) === canon(rest.lines), 'candidate world: snapshot / restore mid-run gives identical log and state');
  ok(one.w.logHash !== ref.logHash, 'the candidate is a different variant (its log differs)');
  const st = JSON.parse(one.w.snapshot());
  ok(st.brood.version === BP1_VERSION && st.brood.config_sha === hook.config_sha && Object.values(st.larvae).every((l: any) => l.bp && l.gut === 0), 'state records the candidate version and config; larvae carry their own physiology');
  // refusals
  assert.throws(() => World.restore(raw, one.w.snapshot()), /restores only with that candidate/); checks++;
  assert.throws(() => World.restore(raw, ref.snapshot(), { brood: hook }), /restores only with that candidate/); checks++;
  assert.throws(() => World.restore(raw, one.w.snapshot(), { brood: bp1Hook(cand, variants, 'bp1-t25') }), /differs from the snapshot/); checks++;
  // feed log: raw µP + converted ng + bridge; census lines
  const feeds = one.lines.map((l) => JSON.parse(l)).flatMap((e) => (Array.isArray(e.p.larvae) ? e.p.larvae : []).filter((x: any) => x.fed > 0));
  ok(feeds.length > 0 && feeds.every((x: any) => x.bp && x.bp.raw_up === x.fed && x.bp.sugar_ng >= 0 && x.bp.protein_ng === 0 && x.bp.assumption === true), `every feed logs raw µP and converted ng (${feeds.length} feeds)`);
  const census = one.lines.map((l) => JSON.parse(l)).filter((e) => e.k === 'brood_day');
  ok(census.length === 4 && census.every((e) => e.p.larvae.length === 8 && /研究候選/.test(e.p.label)), 'daily census logged (days 0..3), labelled research candidate');
  // without any protein source every larva stays in L1, protein-limited (honest; nothing patched)
  const last = census[census.length - 1].p.larvae;
  ok(last.every((x: any) => x.stage === 'L1' && x.fed_protein_ng === 0 && x.limit_ms.P > 2.9 * D), 'P0-A2 food (sugar only): every larva protein-limited in L1');
  // the carer's view of a larva is still {begging, room} only
  const seen = new Set<string>();
  const wi = World.create(raw, SC, 2, { brood: hook, inspectViews: (name, _a, _t, v) => { if (name === 'larva') seen.add(Object.keys(v).sort().join()); } }); wi.advanceTo(6 * H);
  ok(seen.size === 1 && seen.has('begging,room'), 'carer sees only begging and room of the larva it touched');
  // observation projection does not change the world
  const p1 = World.create(raw, SC, 3, { brood: hook }), p2 = World.create(raw, SC, 3, { brood: hook });
  for (let t = H; t <= D; t += H) { p1.advanceTo(t); p2.advanceTo(t); p2.projectedView(); p2.hunger(); }
  ok(p1.stateHash() === p2.stateHash() && p1.logHash === p2.logHash, 'projectedView / hunger with the candidate: observation only');
  // counterfactual protein (not a P0-A2 food): the gate opens through real carer contacts
  const cf = World.create(raw, SC, 1, { brood: bp1Hook(cand, variants, 'cf-protein') }); cf.advanceTo(5 * D);
  const cfl = Object.values(cf.projectedView().larvae).map((l: any) => l.bp);
  ok(cfl.every((x: any) => x.fed_protein_ng > 0 && x.protein_ng.structure > 0) && cf.conservation().ok, 'counterfactual liquid protein: structure deposited through actual feeds; books closed');
}

// ------------------------------------------------------------------ 4. isolation
{
  ok(!P0A2_CODE_FILES.some((f) => f.includes('/brood/')), 'the experiment Worker graph does not contain prototypes/p0a2-24h/brood/');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'prototypes/p0a2-24h')).filter((x) => x.endsWith('.ts'))) ok(!/\.\/brood\//.test(strip(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/p0a2-24h', f), 'utf8'))), `prototypes/p0a2-24h/${f} does not import the brood folder`);
  const wb = fs.readFileSync(path.join(REPO_ROOT, 'prototypes/continuous-world/worker-boundary.json'), 'utf8');
  ok(!/brood|engine\/units/.test(wb), 'Worker allowlist unchanged (no brood module, no mass-energy module)');
  const ALLOWED = ['../../../engine/clock/detmath.ts', '../../../engine/rng.ts', '../../../engine/sha256.ts', '../../../engine/units/mass-energy.ts', '../canon.ts', '../types.ts', './physiology.ts', './bp1.ts'];
  for (const f of ['physiology.ts', 'bp1.ts']) {
    const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/p0a2-24h/brood', f), 'utf8'));
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) ok(ALLOWED.includes(m[1]), `brood/${f} imports ${m[1]}`);
    ok(!/Math\.(exp|log|pow|sin|cos|tan|random|cbrt|hypot|expm1|log1p|log2|log10)\b|Date\.now|new Date\(|performance\./.test(src), `brood/${f}: deterministic math only, no clock`);
    // (`.sources` of a mass ledger and of a labelled value are the contract's / file's own fields, not food sources)
    ok(!/\b(larvae|workers|colony|colonies|stats|stock|queue)\b|(?<![.?])\bsources\b(?!\?)/.test(src.replace(/'[^']*'|`[^`]*`/g, '').replace(/\bsources\??:/g, '')), `brood/${f} names no colony-side collection`);
  }
}

console.log(JSON.stringify({ test: 'bp1-brood', checks, seconds: (Date.now() - T0) / 1000 }));

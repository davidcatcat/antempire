/**
 * P0-A2 phase 2 — isolated 24-hour individual-behaviour prototype (prototypes/p0a2-24h, docs/p0a2-24h-prototype.md).
 * NON-OFFICIAL experiment world; nothing here touches saves/, journal/ or the official engine.
 *
 *  1. parameters: every value carries an evidence class, assumption flag, sources that exist in docs/references.md,
 *     and other-species values name the species (negative fixtures prove the check bites)
 *  2. import allowlist (experiment-Worker allowlist): own directory, engine/clock/, engine/scheduler/, engine/rng.ts,
 *     engine/sha256.ts only; no platform API, no hidden randomness or wall clock; nothing official imports the prototype
 *  3. locality: static check of decision.ts (type-only imports; no colony-level identifier; only local view types) and
 *     the runtime guard (a decision that reads anything but its local view throws) — with negative fixtures
 *  4. chunk invariance: 1 s, 37 s, 1 h, one 24 h call and splits at event instants / 23:59:59.5 give byte-identical
 *     event logs and state hashes (FPS / speed / camera cannot change results)
 *  5. snapshot / restore: 48 h == 24 h + snapshot / restore + 24 h (and at an arbitrary mid instant), byte-identical
 *  6. fixed-seed replay; different seeds differ
 *  7. conservation: food (exact integers) and individual counts reconcile with the event log
 *  8. time contract: the log is in layered order and no batch merges distinct instants
 *  7b. Q2 retention candidate (Owner #188 / #193): default OFF (the reference log is byte-identical to the former
 *     ft-flat variant), food conserved exactly with it on, the reserve rule holds in the event log, locality-guarded
 *  7c. the three food processes kept apart (Owner #188 supplementary ruling, 2026-11-12): (1) own metabolism,
 *     (2) adult–adult trophallaxis, (3) adult→brood feeding — separate parameters, separate guarded decision functions,
 *     per-individual mass balance from the event log, brood decisions read no colony total (negative fixtures),
 *     default-off brood candidates keep the reference log byte-identical, hunger diagnostics never feed back
 *  8b. Q4 same-instant tie-break hash32(seed|t|id) — a transitional ENGINEERING arbitration, not a natural rule:
 *     (a) fairness: first-served position is not biased by id (chi-square / binomial tests at p = 0.001, deterministic;
 *     negative fixtures prove the tests bite), (b) chunk / snapshot invariance at same-instant batch instants,
 *     (c) replay determinism of every batch's order
 *  9. diagnostic (NOT a target): activity by hour, virtual entrance trap in 3-hour bins, for every sensitivity variant
 *     (reference ft-flat = f_T anchors null, Owner #193 Q1 = B, provisional and UNCALIBRATED; ft-r190 / ft-peak-30
 *     sensitivity; give-up-2 default-off assumption variant)
 * 10. pinned log / state hashes for seed 1 (update DELIBERATELY when behaviour changes)
 *
 * The heavy multi-seed sensitivity analyses are NOT here: prototypes/p0a2-24h/tools/q2-retention-sensitivity.ts and
 * prototypes/p0a2-24h/tools/brood-feeding-sensitivity.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { sha256Hex } from '../engine/sha256.ts';
import { hash32, rng } from '../engine/rng.ts';
import { evaluateContract } from '../engine/scheduler/time-contract.ts';
import { World, type WorldOptions, guardView, LocalityError, exactOfMs, tieOf, WORKER_KINDS, WORLD_KINDS, SOURCE_ID } from '../prototypes/p0a2-24h/world.ts';
import { evidenceProblems, valueEntries, buildModel, variantNames } from '../prototypes/p0a2-24h/params.ts';
import { canon } from '../prototypes/p0a2-24h/canon.ts';
import { broodGivable, chooseInNest, decideFeedLarva, decideTransfer, ownNeed, ownReserve } from '../prototypes/p0a2-24h/decision.ts';
import { activityReport } from '../prototypes/p0a2-24h/observer.ts';

const T0 = Date.now();
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DIR = path.join(REPO_ROOT, 'prototypes/p0a2-24h');
const RAW = JSON.parse(fs.readFileSync(path.join(DIR, 'params.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(RAW));
const SC = 'taichung-march-ref', DAY = 86_400_000, H = 3_600_000;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const noStrings = (s: string) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
const run = (seed: number, steps: number[], opts: WorldOptions = { captureLog: true }) => { const w = World.create(RAW, SC, seed, opts); for (const t of steps) w.advanceTo(t); return w; };
const stepsOf = (end: number, dt: number) => { const out: number[] = []; for (let t = dt; t < end; t += dt) out.push(t); out.push(end); return out; };
const logSha = (lines: readonly string[]) => sha256Hex(lines.join('\n'));

// ------------------------------------------------------------------ 1. parameters and evidence classes
{
  ok(evidenceProblems(RAW).length === 0, `params.json evidence labels complete: ${evidenceProblems(RAW).join('; ')}`);
  const refs = fs.readFileSync(path.join(REPO_ROOT, 'docs/references.md'), 'utf8');
  const entries = valueEntries(RAW);
  ok(entries.length >= 40, `every parameter is a labelled entry (${entries.length})`);
  const classes = new Set(entries.map(([, e]) => e.evidence_class));
  for (const c of ['this_species', 'other_species_extrapolated', 'game_assumption']) ok(classes.has(c), `evidence class ${c} is used`);
  for (const [p, e] of entries) for (const id of e.sources) ok(new RegExp(`^\\| ${id} \\|`, 'm').test(refs), `${p}: source ${id} exists in docs/references.md`);
  for (const [p, e] of entries) if (e.evidence_class !== 'this_species') ok(e.assumption === true || e.basis === '定義', `${p}: non-measured value is assumption: true`);
  for (const sc of Object.values(RAW.weather_scenarios) as any[]) ok(sc.synthetic === true && sc.assumption === true, 'synthetic weather is labelled synthetic: true');
  // negative fixtures: the check bites
  const a = clone(); delete a.parameters.hill_n.evidence_class; ok(evidenceProblems(a).some((x) => x.includes('hill_n')), 'missing evidence_class is reported');
  const b = clone(); delete b.sensitivity_variants['ft-r190'].overrides.forage_temp_peak_c.species; ok(evidenceProblems(b).some((x) => x.includes('ft-r190.forage_temp_peak_c')), 'other-species value without a species name is reported');
  const c = clone(); c.parameters.rest_bout_mean_s.assumption = false; ok(evidenceProblems(c).some((x) => x.includes('rest_bout_mean_s')), 'a game assumption without assumption: true is reported');
  const d = clone(); d.weather_scenarios[SC].synthetic = false; ok(evidenceProblems(d).some((x) => x.includes('synthetic')), 'synthetic weather without synthetic: true is reported');
  const v1 = clone(); delete v1.sensitivity_variants['give-up-2'].overrides.give_up_empty_trips.evidence_class; ok(evidenceProblems(v1).some((x) => x.includes('give-up-2')), 'a sensitivity-variant override without evidence_class is reported');
  for (const sec of ['sensitivity_variants', 'q2_retention_variants', 'brood_feeding_variants'] as const) for (const vn of variantNames(RAW, sec)) ok(buildModel(RAW, SC, vn).variant === vn, `${sec} ${vn} builds`);
  // Owner #188 / #193 decisions
  const refM = buildModel(RAW, SC);
  ok(RAW.reference_variant === 'ft-flat' && refM.variant === 'ft-flat' && refM.reference_variant === 'ft-flat', 'Q1 = B: the reference scenario is ft-flat');
  ok(refM.consts.f_t === null && ['forage_temp_zero_low_c', 'forage_temp_peak_c', 'forage_temp_zero_high_c'].every((k) => RAW.parameters[k].value === null && RAW.parameters[k].evidence_class === 'game_assumption'), 'Q1: reference f_T anchors are null (f_T = 1)');
  ok(RAW.parameters.ctmax_c.value === 42 && RAW.parameters.ctmax_c.evidence_class === 'this_species' && RAW.parameters.ctmax_c.sources.includes('R145') && refM.ctmax_c === 42, 'Q1: only the this-species CTmax 42 °C (R145) is kept in the reference');
  ok(/未校準/.test(refM.variant_status) && /不代表實測的日夜活動相同/.test(refM.variant_status) && /未經科學驗證/.test(refM.variant_status), 'Q1: the reference status says provisional / uncalibrated, not equal measured day-night activity, distribution not validated');
  for (const vn of ['ft-r190', 'ft-peak-30']) {
    const va = RAW.sensitivity_variants[vn], m = buildModel(RAW, SC, vn);
    ok(m.consts.f_t !== null && /敏感度情境（非參考/.test(va.status), `${vn}: temperature anchors only as a labelled sensitivity scenario`);
    for (const k of ['forage_temp_zero_low_c', 'forage_temp_zero_high_c']) ok(va.overrides[k].evidence_class === 'other_species_extrapolated' && va.overrides[k].species === 'Pheidole pallidula' && va.overrides[k].sources.includes('R190'), `${vn}.${k}: R190 anchor labelled other-species (Pheidole pallidula)`);
  }
  ok(buildModel(RAW, SC, 'ft-r190').consts.f_t!.peak === 24 && buildModel(RAW, SC, 'ft-peak-30').consts.f_t!.peak === 30, 'ft-r190 peak 24 °C (R190), ft-peak-30 peak 30 °C (game assumption)');
  ok(refM.give_up_empty_trips === null && buildModel(RAW, SC, 'give-up-2').give_up_empty_trips === 2 && /預設關/.test(RAW.sensitivity_variants['give-up-2'].status), 'Q3: give-up stays a default-off assumption variant');
  ok(RAW.parameters.transfer_max_portions.value === 0.28 && refM.consts.trophallaxis.transfer_max === 280_000, 'Q2: the official transfer_max is unchanged (0.28 portions)');
  ok(RAW.parameters.forager_retention.value === null && refM.consts.trophallaxis.retention === null, 'Q2: the retention candidate is OFF by default');
  // Owner #188 supplementary ruling (2026-11-12): the three processes have separate parameters, all brood candidates OFF
  ok(refM.consts.brood.retention === null && refM.consts.brood.min_own_crop_fill === null && refM.consts.brood.trigger === 'threshold' && refM.consts.brood.feed_bolus === 25_000 && refM.consts.brood.begging_threshold === 0.3, '#188b: the reference brood feeding is unchanged (threshold 0.3, bolus 0.025, no carer reserve, no own-fill condition)');
  ok((refM.consts.brood as object) !== (refM.consts.trophallaxis as object) && !('transfer_max' in refM.consts.brood) && !('feed_bolus' in refM.consts.trophallaxis), '#188b: trophallaxis (2) and brood feeding (3) have separate caps');
  ok(buildModel(RAW, SC, 'q2-h6').consts.brood.retention === null && buildModel(RAW, SC, 'b-res-h6').consts.trophallaxis.retention === null && buildModel(RAW, SC, 'b-res-h6').consts.brood.retention !== null, '#188b: the forager (2) and carer (3) retention settings are independent (switching one leaves the other off)');
  for (const vn of variantNames(RAW, 'brood_feeding_variants')) {
    const va = RAW.brood_feeding_variants[vn];
    ok(/預設關/.test(va.status) && /非參考/.test(va.status), `${vn}: labelled default-off, not the reference`);
    for (const [k, e] of Object.entries(va.overrides) as [string, any][]) {
      ok(e.evidence_class === 'game_assumption' && e.assumption === true && !/ratio|fraction|half|share/i.test(JSON.stringify(e.value)), `${vn}.${k}: game assumption, no fixed hand-over ratio`);
      if (e.sources.length) ok(e.sources.every((x: string) => x !== 'R346' && x !== 'R367') && typeof e.species_of_mechanism === 'string' && /非本種/.test(e.basis), `${vn}.${k}: an other-species mechanism source is labelled 非本種 with its species (never the species reference)`);
    }
  }
  const rb = clone(); rb.parameters.brood_carer_retention.value = { kind: 'fraction', value: 0.5 }; assert.throws(() => buildModel(rb, SC), /brood_carer_retention/); checks++; // a fixed carer ratio is refused
  const rt = clone(); rt.parameters.brood_feed_trigger.value = 'colony_need'; assert.throws(() => buildModel(rt, SC), /brood_feed_trigger/); checks++;
  const rbv = clone(); rbv.reference_variant = 'b-res-h6'; ok(evidenceProblems(rbv).some((x) => x.includes('reference_variant')), 'the reference cannot be a brood experiment variant');
  for (const vn of variantNames(RAW, 'q2_retention_variants')) {
    const e = RAW.q2_retention_variants[vn].overrides.forager_retention;
    ok(e.evidence_class === 'game_assumption' && e.assumption === true && e.sources.join() === 'R147' && e.species_of_mechanism === 'Camponotus sanctus' && /非本種/.test(e.basis), `${vn}: game assumption, mechanism direction R147 (Camponotus sanctus, other species) only`);
    ok(['horizon', 'own_interval'].includes(e.value.kind) && !/ratio|fraction|half|share/i.test(JSON.stringify(e.value)), `${vn}: an own-need formulation, not a fixed hand-over ratio`);
  }
  const rr = clone(); rr.parameters.forager_retention.value = { kind: 'fraction', value: 0.5 }; assert.throws(() => buildModel(rr, SC), /forager_retention/); checks++; // a fixed ratio is refused
  const rv = clone(); rv.reference_variant = 'q2-h6'; ok(evidenceProblems(rv).some((x) => x.includes('reference_variant')), 'the reference cannot be a Q2 experiment variant');
  const rs = clone(); delete rs.sensitivity_variants['ft-r190'].status; ok(evidenceProblems(rs).some((x) => x.includes('ft-r190: status')), 'every variant must carry its status text (negative fixture)');
  const e = clone(); e.weather_scenarios[SC].hourly_temp_c[5] = null; assert.throws(() => buildModel(e, SC), /24 finite hourly/); checks++; // temperature null: refused, never filled
  const f = clone(); f.mechanisms.M5_rest_debt.enabled = true; assert.throws(() => buildModel(f, SC), /M5_rest_debt/); checks++;
  const g = clone(); g.parameters.light_factor_night.value = 0; assert.throws(() => buildModel(g, SC), /light_factor_night/); checks++;
  // no fixed diel schedule anywhere in the parameters
  ok(!/diurnal|nocturnal|activity_by_hour|daytime_only|night_only|hour_to_/i.test(JSON.stringify(RAW.parameters)), 'no hour-to-activity table or diel label in the parameters');
}

// ------------------------------------------------------------------ 2. import allowlist and isolation
const ALLOW_DIRS = ['prototypes/p0a2-24h/', 'engine/clock/', 'engine/scheduler/'], ALLOW_FILES = ['engine/rng.ts', 'engine/sha256.ts'];
function importProblems(src: string, fileRel: string): string[] {
  const p: string[] = [], code = strip(src);
  for (const m of code.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) { p.push(`${fileRel}: non-relative import ${spec}`); continue; }
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), spec));
    if (!(ALLOW_FILES.includes(rel) || ALLOW_DIRS.some((d) => rel.startsWith(d)))) p.push(`${fileRel}: import ${rel} outside the experiment-Worker allowlist`);
  }
  const c = noStrings(code);
  if (/\b(process|window|document|localStorage|globalThis|Buffer|self\.postMessage)\s*\./.test(c) || /\brequire\s*\(|\bfetch\s*\(/.test(c)) p.push(`${fileRel}: platform API`);
  if (/Math\.random|Date\.now|new Date\(|performance\./.test(c)) p.push(`${fileRel}: hidden randomness or wall clock`);
  if (/pheidole|megacephala/i.test(c)) p.push(`${fileRel}: species-name branch`);
  return p;
}
{
  ok(importProblems("import fs from 'node:fs';", 'prototypes/p0a2-24h/x.ts').length > 0, 'allowlist check catches node: imports');
  ok(importProblems("import { simulateWorldDay } from '../../engine/day.ts';", 'prototypes/p0a2-24h/x.ts').length > 0, 'allowlist check catches official engine imports');
  ok(importProblems("const m = await import('../../cli/lib/load.ts');", 'prototypes/p0a2-24h/x.ts').length > 0, 'allowlist check catches dynamic imports');
  ok(importProblems("const x = Math.random();", 'prototypes/p0a2-24h/x.ts').length > 0, 'allowlist check catches Math.random');
  ok(importProblems("if (sp === 'Pheidole megacephala') {}", 'prototypes/p0a2-24h/x.ts').length === 0 && importProblems("if (sp.id.includes(megacephala)) {}", 'prototypes/p0a2-24h/x.ts').length > 0, 'species-name branch check works on code, not strings');
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'));
  ok(files.length >= 7, `prototype files present (${files.join(', ')})`);
  for (const f of files) { const pr = importProblems(fs.readFileSync(path.join(DIR, f), 'utf8'), `prototypes/p0a2-24h/${f}`); ok(pr.length === 0, pr.join('; ') || f); }
  // Node-only analysis tools (Owner #193 Q2 / Q4 sensitivity runs): node:fs / node:path / node:url plus the same
  // allowlist; they run the prototype core unchanged, write only prototypes/p0a2-24h/out/, and nothing imports them
  const TOOL_NODE = ['node:fs', 'node:path', 'node:url'];
  const tools = fs.readdirSync(path.join(DIR, 'tools')).filter((f) => f.endsWith('.ts'));
  ok(tools.length >= 2, `analysis tools present (${tools.join(', ')})`);
  for (const f of tools) {
    const src = fs.readFileSync(path.join(DIR, 'tools', f), 'utf8'), code = strip(src);
    const pr = importProblems(src, `prototypes/p0a2-24h/tools/${f}`).filter((x) => !(x.includes('platform API') || TOOL_NODE.some((n) => x.endsWith(`non-relative import ${n}`))));
    ok(pr.length === 0, pr.join('; ') || `tools/${f} imports stay in the allowlist (+ ${TOOL_NODE.join(', ')})`);
    ok(!/\b(saves|journal)\//.test(src) && !/\.(write|append)FileSync\(\s*(?!path\.join\(OUT|path\.join\(DIR, 'out')/.test(code), `tools/${f} writes only prototypes/p0a2-24h/out/`);
  }
  for (const f of files) ok(!/tools\//.test(strip(fs.readFileSync(path.join(DIR, f), 'utf8'))), `${f} does not import the analysis tools`);
  ok(!/p0a2-24h\/tools|q2-retention|q4-tiebreak|brood-feeding/.test(fs.readFileSync(path.join(REPO_ROOT, 'tests/run-all.ts'), 'utf8')), 'the heavy sensitivity tools are not in the blocking test list');
  // the allowlisted engine modules themselves stay inside the allowlist (transitive closure)
  for (const d of ['engine/clock', 'engine/scheduler']) for (const f of fs.readdirSync(path.join(REPO_ROOT, d)).filter((x) => x.endsWith('.ts'))) {
    const pr = importProblems(fs.readFileSync(path.join(REPO_ROOT, d, f), 'utf8'), `${d}/${f}`).filter((x) => x.includes('import'));
    ok(pr.length === 0, pr.join('; ') || `${d}/${f} imports stay in the allowlist`);
  }
  // nothing official imports the prototype
  const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
  const official = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)), ...walk(path.join(REPO_ROOT, 'engine/clock')), ...walk(path.join(REPO_ROOT, 'engine/scheduler')), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))];
  for (const f of official) ok(!/p0a2-24h/.test(strip(fs.readFileSync(f, 'utf8'))), `${path.relative(REPO_ROOT, f)} does not import the P0-A2 prototype`);
  // the environment module reads no colony-side state (CLAUDE.md §2.2)
  const env = noStrings(strip(fs.readFileSync(path.join(DIR, 'environment.ts'), 'utf8')));
  ok(!/colon(y|ies)|worker|brood|larva|\bcrop\b|forag|nestmate|\btask|stats|ledger/i.test(env), 'environment.ts names no colony-side state');
}

// ------------------------------------------------------------------ 3. locality (static + runtime)
const VIEW_FIELDS: Record<string, string[]> = {
  SelfView: ['begging_recent', 'crop', 'crop_fill', 'crop_room', 'ctmax_c', 'forage_interval_ms', 'gain', 'has_route', 'recruit_contacts_recent', 'theta_brood', 'theta_forage', 'thermal_offset_c'],
  SiteView: ['light', 'temp_c'], SourceView: ['food_here', 'temp_c'], PartnerView: ['crop_room'], LarvaView: ['begging', 'room'],
  // Owner #188 supplementary ruling: the giving processes see only the giver's own crop (+ own fill) and own experience
  DonorView: ['crop', 'forage_interval_ms'], CarerView: ['crop', 'crop_fill', 'forage_interval_ms'], NeedView: ['forage_interval_ms'],
};
const VIEW_OF_NAME: Record<string, string> = { self: 'SelfView', site: 'SiteView', source: 'SourceView', partner: 'PartnerView', larva: 'LarvaView', donor: 'DonorView', carer: 'CarerView' };
const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();
const viewJson = (v: object) => canon(Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as any)[k]])));
const FORBIDDEN = /\b(world|World|workers|larvae|sources|ledger|stats|colony|colonies|queue|stock|totals?|t_now|hourOfDay|Date|env|Environment|this|globalThis)\b/;
function decisionProblems(src: string): string[] {
  const p: string[] = [], code = strip(src);
  for (const m of code.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)) if (!m[1] || m[2] !== './types.ts') p.push(`decision imports ${m[2]}${m[1] ? '' : ' (not type-only)'}`);
  const c = noStrings(code).replace(/^\s*import[^;]*;/gm, '');
  const hit = c.match(FORBIDDEN); if (hit) p.push(`decision code names colony-level / global state: ${hit[0]}`);
  if (/^(export\s+)?(let|var)\s/m.test(c)) p.push('decision module has module-level mutable state (top-level let / var)');
  for (const m of c.matchAll(/export function \w+\(([^)]*)\)/g)) for (const prm of m[1].split(',')) {
    const ty = prm.split(':')[1]?.trim().replace(/\[''\]$/, '');
    if (ty && !['SelfView', 'SiteView', 'SourceView', 'PartnerView', 'LarvaView', 'DonorView', 'CarerView', 'NeedView', 'Retention', 'DecisionConsts', 'number'].includes(ty)) p.push(`decision parameter type ${ty} is not a local view`);
  }
  return p;
}
{
  const src = fs.readFileSync(path.join(DIR, 'decision.ts'), 'utf8');
  ok(decisionProblems(src).length === 0, `decision.ts is local-only: ${decisionProblems(src).join('; ')}`);
  ok(/export function chooseInNest\(self: SelfView/.test(src) && /export function decideExit\(self: SelfView, site: SiteView/.test(src), 'decisions take an individual view and a local view');
  // negative fixtures: a decision that reads a colony total, or imports the world, fails the check
  for (const bad of [
    "import type { SelfView } from './types.ts';\nexport function bad(self: SelfView): number { return world.workers.length; }",
    "import type { SelfView } from './types.ts';\nexport function bad(self: SelfView, colony: { sugar: number }): number { return colony.sugar; }",
    "import { World } from './world.ts';\nexport function bad(self: SelfView): number { return 0; }",
    "import type { WorldState } from './types.ts';\nexport function bad(self: SelfView, s: WorldState): number { return 0; }",
    "export function bad(self: SelfView): number { return new Date().getHours(); }",
    "let seen = 0;\nexport function bad(self: SelfView): number { return ++seen; }",
    "export var memo: number[] = [];\nexport function bad(self: SelfView): number { return memo.length; }",
    // Owner #188 supplementary ruling: brood decisions never read colony stores, the larvae count or other larvae
    "import type { CarerView } from './types.ts';\nexport function bad(self: CarerView, colony: { sugar: number }): number { return Math.min(self.crop, colony.sugar); }",
    "import type { CarerView, LarvaView } from './types.ts';\nexport function bad(self: CarerView, larva: LarvaView, larvae: LarvaView[]): number { return larvae.length; }",
    "import type { CarerView } from './types.ts';\nexport function bad(self: CarerView): number { return self.crop - stats.larva_feeds; }",
    "import type { CarerView } from './types.ts';\nexport function bad(self: CarerView, totals: number): number { return totals; }",
  ]) ok(decisionProblems(bad).length > 0, `static locality check catches: ${bad.split('\n').pop()}`);
  // the view types carry only individual / local fields
  const types = strip(fs.readFileSync(path.join(DIR, 'types.ts'), 'utf8'));
  const fieldsOf = (src: string, v: string): string[] => { const m = src.match(new RegExp(`export interface ${v} \\{([\\s\\S]*?)\\n?\\}`)); return m ? [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]).sort() : []; };
  for (const v of Object.keys(VIEW_FIELDS)) ok(sameSet(fieldsOf(types, v), VIEW_FIELDS[v]), `${v} interface has exactly the pinned local fields (${fieldsOf(types, v).join(',')})`);
  // negative fixture: Mutation A (a colony aggregate added to SelfView) fails the pin
  const mutA = types.replace('  begging_recent: number;', '  begging_recent: number;\n  nest_mood: number;');
  ok(mutA !== types && !sameSet(fieldsOf(mutA, 'SelfView'), VIEW_FIELDS.SelfView), 'pin check catches a field added to SelfView (nest_mood)');
  const mutB = types.replace('export interface CarerView { crop: number;', 'export interface CarerView { colony_larval_need: number; crop: number;');
  ok(mutB !== types && !sameSet(fieldsOf(mutB, 'CarerView'), VIEW_FIELDS.CarerView), 'pin check catches a colony aggregate added to CarerView (colony_larval_need, negative fixture)');
  const mutC = types.replace('export interface DonorView { crop: number;', 'export interface DonorView { colony_sugar: number; crop: number;');
  ok(mutC !== types && !sameSet(fieldsOf(mutC, 'DonorView'), VIEW_FIELDS.DonorView), 'pin check catches a colony store added to DonorView (colony_sugar, negative fixture)');
  // deep-frozen constants
  const deepFrozen = (o: unknown): boolean => o === null || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o as object).every(deepFrozen));
  const mc = buildModel(RAW, SC).consts;
  ok(deepFrozen(mc), 'decision constants are deep-frozen');
  assert.throws(() => { (mc as any).hill_n = 9; }, TypeError); checks++;
  assert.throws(() => { (mc.f_t as any).peak = 9; }, TypeError); checks++;
  ok(!deepFrozen(Object.freeze({ f_t: { peak: 1 } })), 'deep-freeze check catches a shallow freeze (negative fixture)');
  // runtime guard: reading anything that is not a local signal throws
  const selfV = guardView({ crop: 0, crop_room: 1, crop_fill: 0, theta_forage: 0.5, theta_brood: 1, gain: 1, thermal_offset_c: 0, ctmax_c: 42, has_route: false, recruit_contacts_recent: 0, begging_recent: 0, forage_interval_ms: null }, 'self');
  assert.throws(() => (selfV as any).colony_sugar, LocalityError); checks++;
  assert.throws(() => (selfV as any).workers, LocalityError); checks++;
  assert.throws(() => { (selfV as any).crop = 5; }, LocalityError); checks++;
  const missing = guardView({ crop: 0, crop_fill: 0, gain: 1, theta_forage: 0.5 } as any, 'self');
  assert.throws(() => chooseInNest(missing, buildModel(RAW, SC).consts, 0.1, 0.1, 0.1), LocalityError); checks++; // a decision reaching beyond what it was handed fails
  const badDecision = (s: unknown) => (s as { colony_crop_total: number }).colony_crop_total;
  assert.throws(() => badDecision(selfV), LocalityError); checks++;
}

// ------------------------------------------------------------------ 4. chunk invariance (the FPS / speed proof)
const ref = run(1, [DAY]);
const refLog = logSha(ref.lines!), refState = ref.stateHash();
ok(ref.lines!.length > 5000, `a 24 h run produces many events (${ref.lines!.length})`);
{
  const workerEvents = ref.lines!.map((l) => JSON.parse(l)).filter((e) => (WORKER_KINDS as readonly string[]).includes(e.k));
  const evT = workerEvents[Math.floor(workerEvents.length / 2)].t;
  const variants: [string, number[]][] = [
    ['1 s steps', stepsOf(DAY, 1000)], ['37 s steps', stepsOf(DAY, 37_000)], ['1 h steps', stepsOf(DAY, H)], ['one 24 h call', [DAY]],
    ['splits at an event instant, just before it, noon and 23:59:59.5', [evT - 1, evT, 12 * H, DAY - 500, DAY].sort((x, y) => x - y)],
    ['zero-length and repeated calls', [0, 0, 5 * H, 5 * H, DAY, DAY]],
  ];
  for (const [name, steps] of variants) {
    const w = run(1, steps);
    ok(logSha(w.lines!) === refLog && w.logHash === ref.logHash, `chunking (${name}) gives a byte-identical event log`);
    ok(w.stateHash() === refState, `chunking (${name}) gives a byte-identical state`);
  }
  assert.throws(() => ref.advanceTo(DAY - 1), /advanceTo/); checks++; // time never goes back
  const quiet = run(1, [DAY], { captureLog: false });
  ok(quiet.logHash === ref.logHash && quiet.stateHash() === refState, 'capturing the log for an observer does not change the world (observation does not feed back)');
}

// ------------------------------------------------------------------ 4b. locality at run time (the views world.ts really builds)
{
  const seen: Record<string, Set<string>> = {};
  const insp = run(1, [DAY], { captureLog: false, inspectViews: (name: string, _a: string, _t: number, v: object) => { (seen[name] ??= new Set()).add(Object.keys(v).sort().join()); } });
  ok(insp.logHash === ref.logHash && insp.stateHash() === refState, 'the view inspector does not change the world');
  ok(Object.keys(seen).sort().join() === 'carer,donor,larva,partner,self,site,source', `every view kind is built in 24 h (${Object.keys(seen).join(',')})`);
  for (const [name, sets] of Object.entries(seen)) ok(sets.size === 1 && sameSet([...sets][0].split(','), VIEW_FIELDS[VIEW_OF_NAME[name]]), `world.ts builds ${name} views with exactly the pinned fields (${[...sets].join(' | ')})`);
  const keysCheck = (keys: string[], view: string) => sameSet(keys, VIEW_FIELDS[view]);
  ok(!keysCheck([...VIEW_FIELDS.SelfView, 'nest_mood'], 'SelfView'), 'runtime pin catches an extra key in a built view (negative fixture)');

  // behavioural independence: change a worker the decider never contacted and the source stock while the decider is in
  // the nest; the decider's view at its next decision must not change
  const NEST = new Set(['resting', 'idle', 'brood_care']);
  let w = run(1, [6 * H], { captureLog: false }), pick: { snap: string; actor: string; t: number; other: string } | null = null;
  for (let i = 0; i < 200 && !pick; i++) {
    const sn = JSON.parse(w.snapshot()), first = sn.queue.find((e: any) => e.a in sn.workers)!;
    const X = sn.workers[first.a];
    const others = Object.values(sn.workers).filter((y: any) => y.id !== X.id && !X.contacts.some((c: any) => c.from === y.id) && sn.queue.find((e: any) => e.a === y.id).t > first.t);
    if ((first.k === 'bout_end' || first.k === 'wake') && NEST.has(X.state) && others.length) pick = { snap: w.snapshot(), actor: X.id, t: first.t, other: (others[0] as any).id };
    else w.advanceTo(first.t);
  }
  ok(pick !== null, 'found a nest decision to probe');
  const mutate = (snap: string): string => { const sn = JSON.parse(snap), y = sn.workers[pick!.other]; y.crop = y.crop > 400_000 ? 0 : 800_000; sn.sources[SOURCE_ID].stock += 777_777; return canon(sn); };
  const probeReal = (snap: string): string => { let h = ''; const x = World.restore(RAW, snap, { inspectViews: (name, a, t, v) => { if (!h && name === 'self' && a === pick!.actor && t === pick!.t) h = viewJson(v); } }); x.advanceTo(pick!.t); return h; };
  const leaks = (probe: (snap: string) => string) => { const a = probe(pick!.snap), b = probe(mutate(pick!.snap)); assert.ok(a.length > 0 && b.length > 0, 'probe captured the view'); return a !== b; };
  ok(!leaks(probeReal), `decider ${pick!.actor}'s view is unchanged when an uncontacted worker (${pick!.other}) and the source stock change`);
  // negative fixture: a view builder that leaks a colony aggregate (Mutation A, nest_mood) is caught by the same probe
  const probeLeaky = (snap: string): string => { const sn = JSON.parse(snap), X = sn.workers[pick!.actor], ws = Object.values(sn.workers) as any[]; return canon({ crop: X.crop, nest_mood: ws.reduce((s2, y) => s2 + y.crop, 0) / (ws.length * 800_000) }); };
  ok(leaks(probeLeaky), 'behavioural probe catches a view that reads all workers (negative fixture)');
}

// ------------------------------------------------------------------ 5. snapshot / restore
let cont48: World, restored48: World;
{
  cont48 = run(1, [2 * DAY]);
  const a = run(1, [DAY]), snap = a.snapshot();
  const b = World.restore(RAW, snap, { captureLog: true }); restored48 = b;
  ok(b.snapshot() === snap, 'restore(snapshot).snapshot() is byte-identical');
  b.advanceTo(2 * DAY);
  ok(b.stateHash() === cont48.stateHash() && b.logHash === cont48.logHash, '48 h == 24 h + snapshot / restore + 24 h (state and log hash chain)');
  ok(logSha([...a.lines!, ...b.lines!]) === logSha(cont48.lines!), '48 h == 24 h + restore + 24 h (concatenated event log byte-identical)');
  const mid = 30 * H + 123, c = run(1, [mid]);
  const d = World.restore(RAW, c.snapshot()); d.advanceTo(2 * DAY);
  ok(d.stateHash() === cont48.stateHash(), 'snapshot at an arbitrary instant (30:00:00.123) and restore gives the same 48 h state');
  const other = clone(); other.parameters.rest_bout_mean_s.value = 601;
  assert.throws(() => World.restore(other, snap), /another parameter file/); checks++;
  assert.throws(() => World.restore(RAW, snap.replace('"seed":1', '"seed": 1')), /canonical/); checks++;
}

// ------------------------------------------------------------------ 6. seed replay
let again!: World, s2!: World, s3!: World;
{
  again = run(1, [DAY]);
  ok(again.logHash === ref.logHash && again.stateHash() === refState, 'same seed + parameters => identical sha256 of the event log and state');
  s2 = run(2, [DAY]); s3 = run(3, [DAY]);
  ok(s2.logHash !== ref.logHash && s3.logHash !== ref.logHash && s2.logHash !== s3.logHash, 'different seeds give different event logs');
}

// ------------------------------------------------------------------ 7. conservation and individual counts
{
  const w = cont48, c = w.conservation(), v = w.view();
  ok(c.ok, `food conserved exactly (µP): held ${c.held} + used ${c.used} == initial ${c.initial} + produced ${c.produced}`);
  const evs = w.lines!.map((l) => JSON.parse(l));
  const produced = evs.filter((e) => e.k === 'produce').reduce((s, e) => s + e.p.amount, 0);
  ok(produced === c.produced && produced === v.sources[SOURCE_ID].produced, 'produced food = sum of produce events in the log (food only from a recorded, sourced world event)');
  const taken = evs.filter((e) => (e.k === 'arrive_source' || e.k === 'search_end') && typeof e.p.take === 'number').reduce((s, e) => s + e.p.take, 0);
  ok(taken === v.sources[SOURCE_ID].taken, 'food taken at the source = sum of takes in the log');
  const fedLarvae = evs.flatMap((e) => (Array.isArray(e.p.larvae) ? e.p.larvae : [])).reduce((s: number, x: any) => s + x.fed, 0);
  const larvaIn = Object.values(v.larvae).reduce((s: number, l: any) => s + l.gut + l.consumed, 0);
  const W = World.create(RAW, SC, 1), larvaInit = Object.values(W.view().larvae).reduce((s: number, l: any) => s + l.gut, 0);
  ok(larvaIn === larvaInit + fedLarvae, 'larval food = initial + feeds in the log (a larva is fed only by a worker that touched it)');
  const kinds = new Set(evs.map((e) => e.k));
  ok([...kinds].every((k) => (WORKER_KINDS as readonly string[]).includes(k) || (WORLD_KINDS as readonly string[]).includes(k)), `only known event kinds (no birth / death events): ${[...kinds].join(',')}`);
  ok(c.workers === 30 && c.larvae === 8, 'individual counts unchanged (no birth or death is modelled, and none is logged)');
  const actors = new Set(evs.filter((e) => (WORKER_KINDS as readonly string[]).includes(e.k)).map((e) => e.a));
  ok([...actors].every((a) => a in v.workers), 'every worker event belongs to an existing worker');
  const snap = JSON.parse(w.snapshot());
  const live = new Map<string, number>(); for (const e of snap.queue) if (e.a in v.workers) live.set(e.a, (live.get(e.a) ?? 0) + 1);
  ok(Object.keys(v.workers).every((id) => live.get(id) === 1), 'every worker has exactly one live pending event (no lost or doubled individual)');
  // a worker that declines at the entrance walks back (nest_transit) and is in the nest only on arrival (back_in)
  // reference ft-flat (f_T = 1): in March (max 25.2 °C < CTmax 42 °C) no exit is ever declined; the walk-back rule is
  // checked on the ft-r190 sensitivity run in §9 (where f_T < 1 produces declines)
  const declines = evs.filter((e) => e.k === 'at_entrance' && e.p.choice !== 'exit').length, backIns = evs.filter((e) => e.k === 'back_in').length;
  ok(declines === 0 && backIns === 0, `reference ft-flat / March: no declines and no walk-backs (${declines}, ${backIns})`);
  ok(evs.filter((e) => e.k === 'env_sample').every((e) => e.p.synthetic === true && e.p.rain === null), 'every weather sample is labelled synthetic and rain stays unknown (null), never 0');
}


// ------------------------------------------------------------------ 7b. Q2 retention candidate (Owner #188 / #193; default OFF)
// Former pins (PR #186, before the Owner's #193 rulings), seed 1, March, 24 h: the former reference (R190 anchors) log and
// the former ft-flat variant log. Q1 = B makes ft-flat the reference, so the new reference log must equal the former
// ft-flat log byte for byte (proves the switched-off Q2 code changes no event), and ft-r190 must reproduce the former
// reference log (the R190 behaviour survives unchanged as a sensitivity scenario; checked in §9).
const FORMER = { reference_r190_log: '7d6e43afca735b6416faf0b2a2e868284b485ae50734a65e9f1ab4b496187d85', ft_flat_log: '0ca01939dbb611871e6bc14b41ea58a1a3bdefc17659e3ea0422ec129d1ef2db' };
const BASE_SELF = { crop: 0, crop_room: 800_000, crop_fill: 0, theta_forage: 0.5, theta_brood: 1, gain: 1, thermal_offset_c: 0, ctmax_c: 42, has_route: true, recruit_contacts_recent: 0, begging_recent: 0, forage_interval_ms: null as number | null };
const selfOf = (o: Partial<typeof BASE_SELF>) => guardView({ ...BASE_SELF, ...o }, 'self');
{
  ok(ref.logHash === FORMER.ft_flat_log, 'Q2 off + Q1: the new reference log is byte-identical to the former ft-flat variant log (the switched-off candidate changes no event)');
  ok(!ref.lines!.some((l) => l.includes('"reserve"') || l.includes('"crop_left"') || l.includes('"carer_reserve"')), 'reference log carries no retention fields (trophallaxis or brood)');
  // isolated run with the candidate on (fixed 6 h horizon), with the view inspector
  const selfKeys = new Set<string>();
  const q = World.create(RAW, SC, 1, { captureLog: true, variant: 'q2-h6', inspectViews: (name, _a, _t, v) => { if (name === 'self') selfKeys.add(Object.keys(v).sort().join()); } });
  q.advanceTo(DAY);
  const qc = q.conservation();
  ok(qc.ok, `Q2 on (q2-h6): food conserved exactly (µP): held ${qc.held} + used ${qc.used} == initial ${qc.initial} + produced ${qc.produced}`);
  ok(q.logHash !== ref.logHash, 'Q2 on changes behaviour (isolated variant only)');
  ok(selfKeys.size === 1 && sameSet([...selfKeys][0].split(','), VIEW_FIELDS.SelfView), `Q2 on: every self view has exactly the pinned local fields (${[...selfKeys].join(' | ')})`);
  const nests = q.lines!.map((l) => JSON.parse(l)).filter((e) => e.k === 'arrive_nest');
  ok(nests.length > 50 && nests.every((e) => e.p.reserve === 25_000 && typeof e.p.crop_left === 'number'), 'q2-h6: reserve = own rate 0.1 portion/day × 6 h = 25 000 µP on every return');
  const gave = nests.filter((e) => e.p.touched.some((x: any) => x.amount > 0));
  ok(gave.length > 0 && gave.every((e) => e.p.crop_left >= e.p.reserve), `q2-h6: every forager that gave food kept at least its own reserve (${gave.length} returns with transfers)`);
  ok(gave.some((e) => e.p.crop_left === e.p.reserve), 'q2-h6: the reserve actually bounds some transfers');
  // every Q2 formulation: conserved and builds (short isolated runs)
  for (const vn of variantNames(RAW, 'q2_retention_variants')) { const w = World.create(RAW, SC, 7, { variant: vn }); w.advanceTo(4 * H); ok(w.conservation().ok, `${vn}: food conserved exactly over 4 h (seed 7)`); }
  // the rule itself, on guarded views (own state only)
  const cH = buildModel(RAW, SC, 'q2-h6').consts, cI = buildModel(RAW, SC, 'q2-int1').consts, c2 = buildModel(RAW, SC, 'q2-int2').consts, c0 = buildModel(RAW, SC).consts;
  const partner = guardView({ crop_room: 800_000 }, 'partner');
  ok(ownReserve(selfOf({ crop: 500_000 }), c0) === 0 && decideTransfer(selfOf({ crop: 500_000 }), partner, c0) === 280_000, 'retention off: reserve 0, transfer = min(transfer_max, crop, room) as before');
  ok(ownReserve(selfOf({ crop: 500_000, forage_interval_ms: null }), cI) === 0, 'own_interval: no experienced interval yet => reserve 0 (unknown is not filled)');
  ok(ownReserve(selfOf({ forage_interval_ms: 3 * H }), cI) === 12_500 && ownReserve(selfOf({ forage_interval_ms: 3 * H }), c2) === 25_000, 'own_interval: reserve = factor × own interval × own rate');
  ok(decideTransfer(selfOf({ crop: 300_000, forage_interval_ms: 12 * H }), partner, cI) === 250_000 && decideTransfer(selfOf({ crop: 20_000 }), partner, cH) === 0, 'transfer never takes the crop below the own reserve');
  // locality: the candidate reads only the forager's own view; a view without its own interval cannot be read around
  assert.throws(() => ownReserve(guardView({ crop: 1 } as any, 'self'), cI), LocalityError); checks++;
  assert.throws(() => decideTransfer(guardView({ crop: 1, forage_interval_ms: H } as any, 'self'), guardView({} as any, 'partner'), cI), LocalityError); checks++;
}

// ------------------------------------------------------------------ 7c. three food processes (Owner #188 supplementary ruling 2026-11-12)
// (1) own metabolism / own need, (2) adult–adult trophallaxis, (3) adult→brood feeding: separate parameters and separate
// guarded decisions. Checked: per-individual mass balance from the event log (no food created because a larva needs
// it), every transfer bounded by the giver's own crop and the receiver's room, brood candidates default OFF (reference
// log unchanged, see §7b), the carer never feeds below its own brood reserve, brood views carry no colony total
// (runtime pin + behavioural probe + negative fixtures), hunger diagnostics never feed back.
/** per-individual food balance from the event log: for every worker, initial + taken + received − given − fed to
 *  larvae − consumed == crop; for every larva, initial + fed == gut + consumed and fed == received. Returns problems */
function individualBalance(w: World, variant?: string): string[] {
  const p: string[] = [], v = w.view(), init = World.create(RAW, SC, w.seed, { variant }).view();
  const flow: Record<string, number> = {}, add = (id: string, x: number) => { flow[id] = (flow[id] ?? 0) + x; };
  for (const l of w.lines!) {
    const e = JSON.parse(l);
    if ((e.k === 'arrive_source' || e.k === 'search_end') && typeof e.p.take === 'number') add(e.a, e.p.take);
    if (e.k === 'arrive_nest') for (const x of e.p.touched) { add(e.a, -x.amount); add(x.worker, x.amount); }
    if ((e.k === 'bout_end' || e.k === 'wake' || e.k === 'arrive_nest') && Array.isArray(e.p.larvae)) for (const x of e.p.larvae) { add(e.a, -x.fed); add(x.larva, x.fed); }
  }
  for (const [id, x] of Object.entries(v.workers)) if (init.workers[id].crop + (flow[id] ?? 0) - x.consumed !== x.crop) p.push(`${id}: ${init.workers[id].crop} + ${flow[id] ?? 0} - ${x.consumed} != ${x.crop}`);
  for (const [id, x] of Object.entries(v.larvae)) if (init.larvae[id].gut + (flow[id] ?? 0) !== x.gut + x.consumed || (flow[id] ?? 0) !== x.received) p.push(`${id}: larval balance`);
  return p;
}
{
  // per-individual balance: reference 48 h (seed 1) and the brood candidates on (isolated, 12 h)
  const pr = individualBalance(cont48);
  ok(pr.length === 0, `#188b: reference 48 h — every worker's and larva's food balances from the event log (${pr.slice(0, 3).join('; ')})`);
  const carerKeys = new Set<string>(), donorKeys = new Set<string>();
  const runs: Record<string, World> = {};
  for (const vn of ['b-res-h6', 'b-graded', 'b-minfill-25']) {
    const w = World.create(RAW, SC, 1, { captureLog: true, variant: vn, inspectViews: (name, _a, _t, v) => { if (name === 'carer') carerKeys.add(Object.keys(v).sort().join()); if (name === 'donor') donorKeys.add(Object.keys(v).sort().join()); } });
    w.advanceTo(8 * H); runs[vn] = w;
    const c = w.conservation(), b = individualBalance(w, vn);
    ok(c.ok && b.length === 0, `#188b ${vn}: food conserved exactly and every individual balances from the log over 8 h (${b.slice(0, 2).join('; ')})`);
  }
  ok(carerKeys.size === 1 && sameSet([...carerKeys][0].split(','), VIEW_FIELDS.CarerView) && donorKeys.size === 1 && sameSet([...donorKeys][0].split(','), VIEW_FIELDS.DonorView), `#188b: with brood candidates on, carer / donor views keep exactly the pinned fields (${[...carerKeys].join('|')} / ${[...donorKeys].join('|')})`);
  // the carer never feeds below its own brood reserve (b-res-h6: 0.1 portion/day × 6 h = 25 000 µP), from the log
  const bouts = runs['b-res-h6'].lines!.map((l) => JSON.parse(l)).filter((e) => e.p.choice === 'brood');
  const fedBouts = bouts.filter((e) => e.p.larvae.some((x: any) => x.fed > 0));
  ok(bouts.length > 20 && bouts.every((e) => e.p.carer_reserve === 25_000 && e.p.carer_crop > 25_000), `b-res-h6: brood care is chosen only by a carer whose own crop exceeds its own reserve (${bouts.length} bouts)`);
  ok(fedBouts.length > 0 && fedBouts.every((e) => e.p.carer_crop_left >= e.p.carer_reserve && e.p.carer_crop - e.p.carer_crop_left === e.p.larvae.reduce((a: number, x: any) => a + x.fed, 0)), `b-res-h6: in every bout that fed, the carer kept its own reserve and lost exactly what the larvae received (${fedBouts.length} bouts)`);
  const mf = runs['b-minfill-25'].lines!.map((l) => JSON.parse(l)).filter((e) => e.p.choice === 'brood');
  ok(mf.length > 0 && mf.every((e) => e.p.carer_crop >= 200_000), `b-minfill-25: only carers with own crop fill >= 0.25 choose brood care (${mf.length} bouts)`);
  // decisions on guarded views: the larva's begging never creates food; caps and reserves are separate
  const cR = buildModel(RAW, SC).consts, cB = buildModel(RAW, SC, 'b-res-h6').consts, cG = buildModel(RAW, SC, 'b-graded').consts, cM = buildModel(RAW, SC, 'b-minfill-25').consts, cQ = buildModel(RAW, SC, 'q2-h6').consts;
  const carer = (crop: number, iv: number | null = null) => guardView({ crop, crop_fill: crop / 800_000, forage_interval_ms: iv }, 'carer');
  const larva = (begging: number, room = 25_000) => guardView({ begging, room }, 'larva');
  ok(decideFeedLarva(carer(0), larva(1), cR, 0) === 0 && decideFeedLarva(carer(0), larva(1), cG, 0) === 0, '(3) an empty carer gives nothing however hungry the larva (no food is created for a need)');
  ok(decideFeedLarva(carer(500_000), larva(0.29), cR, 0) === 0 && decideFeedLarva(carer(500_000), larva(0.3), cR, 0) === 25_000 && decideFeedLarva(carer(10_000), larva(1), cR, 0) === 10_000 && decideFeedLarva(carer(500_000), larva(1, 7), cR, 0) === 7, '(3) reference: threshold 0.3 on the perceived signal; bolus = min(0.025, own crop, larva room)');
  ok(decideFeedLarva(carer(20_000), larva(1), cB, 0) === 0 && decideFeedLarva(carer(30_000), larva(1), cB, 0) === 5_000 && broodGivable(carer(30_000), cB) === 5_000, '(3) b-res-h6: never below the carer\'s own reserve (25 000 µP)');
  ok(decideFeedLarva(carer(500_000), larva(0.2), cG, 0.19) === 25_000 && decideFeedLarva(carer(500_000), larva(0.2), cG, 0.2) === 0, '(3) b-graded: feeds with probability = perceived signal (no threshold)');
  ok(decideFeedLarva(carer(199_999), larva(1), cM, 0) === 0 && decideFeedLarva(carer(200_000), larva(1), cM, 0) === 25_000, '(3) b-minfill-25: the carer\'s own crop fill must reach 0.25');
  ok(ownNeed(carer(1), cQ.trophallaxis.retention, cQ) === 25_000 && broodGivable(carer(30_000), cQ) === 30_000 && ownNeed(carer(1), cB.brood.retention, cB) === 25_000 && decideTransfer(guardView({ crop: 30_000, forage_interval_ms: null }, 'donor'), guardView({ crop_room: 800_000 }, 'partner'), cB) === 30_000, '(1)/(2)/(3) separate: the forager reserve does not bind brood feeding and the carer reserve does not bind trophallaxis');
  ok(ownNeed(carer(1, 3 * H), { kind: 'own_interval', factor: 2 }, cR) === 25_000 && ownNeed(carer(1, null), { kind: 'own_interval', factor: 2 }, cR) === 0, '(1) own need: factor × own interval × own rate; unknown interval => 0 (not filled)');
  // runtime guard: a brood decision cannot read past the carer's own view (negative fixtures)
  assert.throws(() => decideFeedLarva(guardView({ crop: 1, crop_fill: 0 } as any, 'carer'), larva(1), buildModel(RAW, SC, 'b-res-int2').consts, 0), LocalityError); checks++; // own_interval needs its own interval: not handed => throws
  const leakyBrood = (v: unknown) => (v as { colony_larval_need: number }).colony_larval_need;
  assert.throws(() => leakyBrood(carer(1)), LocalityError); checks++;
  assert.throws(() => (carer(1) as any).workers, LocalityError); checks++;
  // behavioural probe: at a brood decision, change every OTHER worker's crop, the source stock and every larva's gut;
  // the carer's own view must not change (a view leaking the larvae's total need is caught — negative fixture)
  let w = run(1, [3 * H], { captureLog: false }), probe: { snap: string; actor: string; t: number } | null = null;
  for (let i = 0; i < 400 && !probe; i++) {
    const sn = JSON.parse(w.snapshot()), first = sn.queue.find((e: any) => e.a in sn.workers)!;
    if (first.k === 'bout_end' || first.k === 'wake') {
      let hit = false; const x = World.restore(RAW, w.snapshot(), { inspectViews: (name, a, t) => { if (name === 'carer' && a === first.a && t === first.t) hit = true; } }); x.advanceTo(first.t);
      if (hit) { probe = { snap: w.snapshot(), actor: first.a, t: first.t }; break; }
    }
    w.advanceTo(first.t);
  }
  ok(probe !== null, 'found a brood decision to probe');
  const mutateAll = (snap: string): string => { const sn = JSON.parse(snap); for (const y of Object.values(sn.workers) as any[]) if (y.id !== probe!.actor) y.crop = y.crop > 400_000 ? 0 : 800_000; for (const l of Object.values(sn.larvae) as any[]) l.gut = 0; sn.sources[SOURCE_ID].stock += 555_555; return canon(sn); };
  const carerAt = (snap: string, leak: boolean): string => {
    let h = ''; const sn = JSON.parse(snap);
    const need = (Object.values(sn.larvae) as any[]).reduce((a, l) => a + (25_000 - l.gut), 0);
    const x = World.restore(RAW, snap, { inspectViews: (name, a, t, v) => { if (!h && name === 'carer' && a === probe!.actor && t === probe!.t) h = leak ? canon({ ...JSON.parse(viewJson(v)), larval_need: need }) : viewJson(v); } });
    x.advanceTo(probe!.t); return h;
  };
  ok(carerAt(probe!.snap, false) === carerAt(mutateAll(probe!.snap), false) && carerAt(probe!.snap, false).length > 0, `carer ${probe!.actor}'s view is unchanged when other workers, the source and every larva change`);
  ok(carerAt(probe!.snap, true) !== carerAt(mutateAll(probe!.snap), true), 'behavioural probe catches a carer view that sums the larvae\'s need (negative fixture)');
  // hunger diagnostics: statistics only (books nothing, never fed back), consistent with the conserved state
  const before = cont48.stateHash(), hu = cont48.hunger();
  ok(cont48.stateHash() === before, 'World.hunger() changes nothing (diagnostic copy)');
  ok(hu.workers.length === 30 && hu.larvae.length === 8 && hu.workers.every((x) => x.max_empty_ms <= x.empty_ms && x.empty_ms <= 2 * DAY && x.unmet >= cont48.view().workers[x.id].debt) && hu.larvae.every((x) => x.received === cont48.view().larvae[x.id].received), 'hunger rows: longest empty spell <= total empty time <= run length; unmet need >= booked debt; larval received = state');
  ok(canon(restored48.hunger()) === canon(hu), 'hunger diagnostics survive snapshot / restore unchanged (48 h == 24 h + restore + 24 h; state fields, chunk-invariant)');
}

// ------------------------------------------------------------------ 8. time contract
{
  const evs = cont48.lines!.map((l) => JSON.parse(l));
  let mono = true; for (let i = 1; i < evs.length; i++) { const a = evs[i - 1], b = evs[i]; if (a.t > b.t || (a.t === b.t && (a.r > b.r || (a.r === b.r && (a.q > b.q || (a.q === b.q && a.id >= b.id)))))) mono = false; }
  ok(mono, 'the log is in layered order (exact instant, round, seeded tie-break, canonical id), each id once');
  ok(evs.every((e) => e.q === tieOf(1, e.t, e.id)), 'every tie-break is hash32(seed|t|id) (deterministic, chunk-invariant)');
  // same-instant batches of several workers: fairness of the first-served position is tested in §8b (pooled over seeds)
  const r = evaluateContract(evs.map((e) => ({ id: e.id, exact: exactOfMs(e.t), entities: [e.a] })), { name: 'layered', kind: 'layered', ticks_per_us: null });
  ok(r.merged_batches === 0, 'no batch merges distinct exact instants (engine/scheduler/time-contract.ts, layered)');
  ok(evs.some((e) => e.t % 1000 !== 0), 'events fall between whole seconds (continuous time, not frame ticks)');
}


// ------------------------------------------------------------------ 8b. Q4: the seeded same-instant tie-break (ENGINEERING arbitration)
// hash32(seed|t|id) orders events of different actors at the same exact instant and round. Owner #193 Q4: it stays as a
// transitional engineering rule, NOT a claimed natural competition rule. Verified here: (a) fairness, (b) chunk /
// snapshot invariance at same-instant batch instants, (c) replay determinism of each batch's order.
// Threshold: every fairness test must NOT reject uniformity at p = 0.001 (chi-square critical values below; binomial
// |z| < 3.291). Everything is deterministic (fixed seeds, no wall clock), so the outcome is a fixed fact, not a flaky draw.
const CHI2_CRIT_P001: Record<number, number> = { 1: 10.828, 2: 13.816, 3: 16.266, 29: 58.301 };
const chi2 = (obs: number[]) => { const n = obs.reduce((a, b) => a + b, 0), e = n / obs.length; return obs.reduce((a, o) => a + (o - e) ** 2 / e, 0); };
/** same-instant, same-round batches of worker events with more than one actor: actors in processing order */
const batchesOf = (lines: readonly string[]): { t: number; actors: string[] }[] => {
  const out: { t: number; r: number; actors: string[] }[] = [];
  for (const l of lines) {
    const e = JSON.parse(l); if (!(WORKER_KINDS as readonly string[]).includes(e.k)) continue;
    const last = out[out.length - 1];
    if (last && last.t === e.t && last.r === e.r) last.actors.push(e.a); else out.push({ t: e.t, r: e.r, actors: [e.a] });
  }
  return out.filter((b) => new Set(b.actors).size > 1).map(({ t, actors }) => ({ t, actors }));
};
const fairness: Record<string, unknown> = {};
{
  const ids = Array.from({ length: 30 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`);
  type Tie = (seed: number, t: number, id: string) => number;
  /** synthetic batches: first-served rank among the batch's sorted ids, per batch size k (2..4), and the winner of
   *  full 30-worker batches (event ids with sequence 0, so the id alone cannot vary) */
  const synth = (tie: Tie) => {
    const byK: Record<number, number[]> = { 2: [0, 0], 3: [0, 0, 0], 4: [0, 0, 0, 0] }, full = new Array(30).fill(0);
    for (let i = 0; i < 12_000; i++) {
      const g = rng(hash32(`q4-fair|${i}`)), seed = 1 + (i % 50), t = Math.floor(g() * 2 * DAY), k = 2 + (i % 3);
      const pick = new Set<string>(); while (pick.size < k) pick.add(ids[Math.floor(g() * 30)]);
      const evs = [...pick].map((a) => ({ a, id: `${a}#${String(Math.floor(g() * 5000)).padStart(8, '0')}` })).map((x) => ({ ...x, q: tie(seed, t, x.id) }));
      evs.sort((x, y) => x.q - y.q || (x.id < y.id ? -1 : 1));
      byK[k][[...pick].sort().indexOf(evs[0].a)]++;
    }
    for (let i = 0; i < 3000; i++) {
      const seed = 1 + (i % 50), t = 1000 * (i + 1) + (i % 7);
      let best = 0, bq = Infinity; ids.forEach((a, j) => { const q = tie(seed, t, `${a}#00000000`); if (q < bq) { bq = q; best = j; } });
      full[best]++;
    }
    return { byK, full, chi: { 2: chi2(byK[2]), 3: chi2(byK[3]), 4: chi2(byK[4]), 30: chi2(full) } };
  };
  const passes = (r: ReturnType<typeof synth>) => r.chi[2] < CHI2_CRIT_P001[1] && r.chi[3] < CHI2_CRIT_P001[2] && r.chi[4] < CHI2_CRIT_P001[3] && r.chi[30] < CHI2_CRIT_P001[29];
  const real = synth(tieOf);
  ok(passes(real), `(a) tie-break fairness on 12 000 synthetic batches + 3 000 full 30-worker batches: chi-square k=2 ${real.chi[2].toFixed(2)}, k=3 ${real.chi[3].toFixed(2)}, k=4 ${real.chi[4].toFixed(2)}, 30 workers ${real.chi[30].toFixed(2)} (all below p=0.001 critical values)`);
  // negative fixtures: the test bites on id-order and on an id-only hash
  ok(!passes(synth(() => 0)), '(a) negative fixture: an id-ordered tie-break (q constant) is rejected');
  ok(!passes(synth((_s, _t, id) => hash32(id))), '(a) negative fixture: a tie-break of the id alone (no seed / instant) is rejected');
  // empirical: batches that really occurred, seeds 1 (48 h), 2, 3 (24 h) and 4..7 (12 h)
  const runs: World[] = [cont48, s2, s3];
  for (let sd = 4; sd <= 7; sd++) runs.push(run(sd, [12 * H]));
  const batches = runs.flatMap((w) => batchesOf(w.lines!));
  const binom = (bs: { actors: string[] }[], firstOf: (b: { actors: string[] }) => string) => {
    let L = 0, E = 0, V = 0; for (const b of bs) { const k = b.actors.length, p = 1 / k; E += p; V += p * (1 - p); if (firstOf(b) === [...b.actors].sort()[0]) L++; }
    return { lowest_first: L, expected: E, z: (L - E) / Math.sqrt(V) };
  };
  const emp = binom(batches, (b) => b.actors[0]);
  const k2 = batches.filter((b) => b.actors.length === 2), k2first = [0, 0]; for (const b of k2) k2first[[...b.actors].sort().indexOf(b.actors[0])]++;
  ok(batches.length >= 15 && Math.abs(emp.z) < 3.291, `(a) simulated batches (${batches.length} over 7 seeds; low power here — the multi-seed run is tools/q4-tiebreak-fairness.ts): lowest id served first ${emp.lowest_first} vs expected ${emp.expected.toFixed(1)}, z = ${emp.z.toFixed(2)} (|z| < 3.291)`);
  ok(k2.length >= 8 && chi2(k2first) < CHI2_CRIT_P001[1], `(a) simulated two-worker batches: first-served rank ${k2first.join('/')} chi-square ${chi2(k2first).toFixed(2)} < ${CHI2_CRIT_P001[1]}`);
  ok(Math.abs(binom(batches, (b) => [...b.actors].sort()[0]).z) >= 3.291, '(a) negative fixture: the same batches served in id order are rejected');
  fairness.synthetic_chi2 = real.chi; fairness.simulated = { batches: batches.length, two_worker: k2first, ...emp };

  // (b) chunk and snapshot invariance at same-instant batch instants: the 24 h run (seed 2 or 3) with more batches
  const [bSeed, bRun] = ([[2, s2], [3, s3]] as [number, World][]).sort((x, y) => batchesOf(y[1].lines!).length - batchesOf(x[1].lines!).length || x[0] - y[0])[0];
  const bLog = bRun.logHash, bState = bRun.stateHash(), bLogSha = logSha(bRun.lines!);
  const refB = batchesOf(bRun.lines!), inst = [...new Set(refB.map((b) => b.t))];
  ok(inst.length >= 3, `seed ${bSeed} has same-instant batches in 24 h (${refB.length} batches at ${inst.length} instants)`);
  // one fresh run from the seed, cut just before and at every batch instant, with a snapshot / restore at every cut
  let w = World.create(RAW, SC, bSeed, { captureLog: true }); const lines: string[] = [];
  for (const at of [...new Set(inst.flatMap((t) => [t - 1, t]))].sort((x, y) => x - y)) { w.advanceTo(at); lines.push(...w.lines!); w = World.restore(RAW, w.snapshot(), { captureLog: true }); }
  w.advanceTo(DAY); lines.push(...w.lines!);
  ok(w.logHash === bLog && w.stateHash() === bState && logSha(lines) === bLogSha, `(b) seed ${bSeed}: chunk boundaries with snapshot / restore just before and at every same-instant batch instant give a byte-identical log and state`);
  // (c) replay determinism of every batch's order (that run is an independent replay of the same seed)
  const sig = (bs: { t: number; actors: string[] }[]) => canon(bs);
  ok(sig(batchesOf(lines)) === sig(refB), `(c) seed ${bSeed} replay: every same-instant batch has the same members in the same order`);
  ok(sig(batchesOf(cont48.lines!).filter((b) => b.t <= DAY)) === sig(batchesOf(ref.lines!)) && sig(batchesOf(again.lines!)) === sig(batchesOf(ref.lines!)), '(c) seed 1 replay (fresh 24 h, 48 h prefix): identical batch orders');
  const bEvs = bRun.lines!.map((l) => JSON.parse(l));
  ok(refB.every((b) => { const qs = bEvs.filter((e) => e.t === b.t && b.actors.includes(e.a) && (WORKER_KINDS as readonly string[]).includes(e.k)); return qs.every((e, i) => i === 0 || qs[i - 1].r < e.r || qs[i - 1].q <= e.q); }), '(c) within each batch the processing order is the tie-break order (q ascending)');
  fairness.chunk_replay_seed = bSeed; fairness.chunk_replay_batches_24h = refB.length;
}

// ------------------------------------------------------------------ 9. diagnostic (NOT a target, CLAUDE.md §7)
const diag: Record<string, unknown> = {};
for (const variant of Object.keys(RAW.sensitivity_variants).filter((k) => k !== '_note')) for (const sc of ['taichung-march-ref', 'taichung-may-ref']) {
  // the reference / March / seed 1 / 2-day run is exactly cont48 (same parameters, scenario, seed and span): reuse it
  const isRef = variant === RAW.reference_variant && sc === SC, w = isRef ? cont48 : World.create(RAW, sc, 1, { captureLog: true, variant });
  if (!isRef) w.advanceTo(DAY);
  if (variant === 'ft-r190' && sc === SC) ok(w.logHash === FORMER.reference_r190_log, 'Q1: the former reference (R190 anchors) survives byte-identically as the ft-r190 sensitivity scenario');
  if (!isRef) w.advanceTo(2 * DAY);
  if (variant === 'ft-r190' && sc === SC) {
    const evs = w.lines!.map((l) => JSON.parse(l)), declines = evs.filter((e) => e.k === 'at_entrance' && e.p.choice !== 'exit').length, backIns = evs.filter((e) => e.k === 'back_in').length;
    ok(declines > 0 && backIns > 0 && backIns <= declines, `ft-r190: declines walk back before entering the nest (${declines} declines, ${backIns} back_in)`);
    ok(w.stats().occ.from_entrance.some((x) => x > 0), 'ft-r190: walking-back time is booked as its own state');
  }
  const r = activityReport(w.stats(), w.lines!, `${variant} / ${sc} seed 1, 2 days (diagnostic, synthetic weather)`, w.m.variant_status);
  ok(r.variant_status === w.m.variant_status && (variant !== RAW.reference_variant || /未校準/.test(r.variant_status)), `${variant} / ${sc}: report carries the variant status`);
  ok(r.outside_share_by_hour.length === 24 && r.trap_3h.length === 8 && w.conservation().ok, `${variant} / ${sc}: diagnostic report built, food conserved`);
  const evs = w.lines!.map((l) => JSON.parse(l));
  diag[`${variant} / ${sc}`] = { status: r.variant_status, trap_3h: r.trap_3h, exits_by_hour: r.exits_by_hour, outside_share_by_hour: r.outside_share_by_hour, exits_day: r.exits_day, exits_twilight_or_night: r.exits_twilight_or_night, empty_arrivals: evs.filter((e) => e.p.take === 0).length, routes_forgotten: evs.filter((e) => e.p.forgot_route).length, same_instant_events: w.stats().same_instant_events };
}
// ------------------------------------------------------------------ 10. pinned hashes (seed 1, March reference, 24 h)
// Update these DELIBERATELY (and say why in the PR) whenever behaviour changes; an unexplained change is a regression.
// Re-pinned for Owner #188 / #193 (2026-11-12): the reference became ft-flat (Q1 = B).
//   log   7d6e43af…7d85 -> 0ca01939…f2db  = exactly the former ft-flat variant log (behaviour of the reference changed
//         because the reference changed; no event of ft-flat changed; the former reference log is now ft-r190, see §9)
//   state eeae295c…582f -> 60f5e6e7…ccb2  (parameter file sha, variant name 'ft-flat', and the two own-experience fields
//         last_intake_t / forage_interval_ms read only by the default-off Q2 candidate)
// Re-pinned for the Owner #188 supplementary ruling (2026-11-12, three food processes kept apart): the LOG is unchanged
// (0ca01939…f2db: the default-off brood candidates change no event); only the state:
//   state 60f5e6e7…ccb2 -> 86c354e8…d93b  (parameter file sha: three new default-off brood parameters and the
//         brood_feeding_variants section; new diagnostic-only state fields: workers empty_since / empty_ms / max_empty_ms,
//         larvae received / empty_since / empty_ms / max_empty_ms — statistics, never in any decision view)
const PINNED = { log: '0ca01939dbb611871e6bc14b41ea58a1a3bdefc17659e3ea0422ec129d1ef2db', state: '86c354e8cb1f1840b5f3622d03d6c5e49302725d1443ceb44d7141bbb8cad93b' };
ok(ref.logHash === PINNED.log, `pinned 24 h log hash (got ${ref.logHash})`);
ok(refState === PINNED.state, `pinned 24 h state hash (got ${refState})`);
console.log(JSON.stringify({ test: 'p0a2-24h-proto', checks, seconds: (Date.now() - T0) / 1000, events_24h_seed1: ref.lines!.length, log_sha_24h_seed1: ref.logHash, q4_fairness: fairness, diagnostic_not_a_target: diag }));

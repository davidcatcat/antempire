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
 *  9. diagnostic (NOT a target): activity by hour, virtual entrance trap in 3-hour bins, for every sensitivity variant
 *     (f_T anchors null / R190 / alternative peak; give-up on) — the Owner decides which becomes the reference
 * 10. pinned log / state hashes for seed 1 (update DELIBERATELY when behaviour changes)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { sha256Hex } from '../engine/sha256.ts';
import { evaluateContract } from '../engine/scheduler/time-contract.ts';
import { World, type WorldOptions, guardView, LocalityError, exactOfMs, tieOf, WORKER_KINDS, WORLD_KINDS, SOURCE_ID } from '../prototypes/p0a2-24h/world.ts';
import { evidenceProblems, valueEntries, buildModel } from '../prototypes/p0a2-24h/params.ts';
import { canon } from '../prototypes/p0a2-24h/canon.ts';
import { chooseInNest } from '../prototypes/p0a2-24h/decision.ts';
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
  const b = clone(); delete b.parameters.forage_temp_peak_c.species; ok(evidenceProblems(b).some((x) => x.includes('forage_temp_peak_c')), 'other-species value without a species name is reported');
  const c = clone(); c.parameters.rest_bout_mean_s.assumption = false; ok(evidenceProblems(c).some((x) => x.includes('rest_bout_mean_s')), 'a game assumption without assumption: true is reported');
  const d = clone(); d.weather_scenarios[SC].synthetic = false; ok(evidenceProblems(d).some((x) => x.includes('synthetic')), 'synthetic weather without synthetic: true is reported');
  const v1 = clone(); delete v1.sensitivity_variants['give-up-2'].overrides.give_up_empty_trips.evidence_class; ok(evidenceProblems(v1).some((x) => x.includes('give-up-2')), 'a sensitivity-variant override without evidence_class is reported');
  for (const vn of Object.keys(RAW.sensitivity_variants).filter((k) => k !== '_note')) ok(buildModel(RAW, SC, vn).variant === vn, `sensitivity variant ${vn} builds`);
  ok(buildModel(RAW, SC).give_up_empty_trips === null && buildModel(RAW, SC).consts.f_t !== null, 'reference: give-up off, M1 temperature gate on (design §5)');
  ok(buildModel(RAW, SC, 'ft-flat').consts.f_t === null, 'ft-flat: no temperature anchors');
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
  SelfView: ['begging_recent', 'crop', 'crop_fill', 'crop_room', 'ctmax_c', 'gain', 'has_route', 'recruit_contacts_recent', 'theta_brood', 'theta_forage', 'thermal_offset_c'],
  SiteView: ['light', 'temp_c'], SourceView: ['food_here', 'temp_c'], PartnerView: ['crop_room'], LarvaView: ['begging', 'room'],
};
const VIEW_OF_NAME: Record<string, string> = { self: 'SelfView', site: 'SiteView', source: 'SourceView', partner: 'PartnerView', larva: 'LarvaView' };
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
    if (ty && !['SelfView', 'SiteView', 'SourceView', 'PartnerView', 'LarvaView', 'DecisionConsts', 'number'].includes(ty)) p.push(`decision parameter type ${ty} is not a local view`);
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
  ]) ok(decisionProblems(bad).length > 0, `static locality check catches: ${bad.split('\n').pop()}`);
  // the view types carry only individual / local fields
  const types = strip(fs.readFileSync(path.join(DIR, 'types.ts'), 'utf8'));
  const fieldsOf = (src: string, v: string): string[] => { const m = src.match(new RegExp(`export interface ${v} \\{([\\s\\S]*?)\\n?\\}`)); return m ? [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]).sort() : []; };
  for (const v of Object.keys(VIEW_FIELDS)) ok(sameSet(fieldsOf(types, v), VIEW_FIELDS[v]), `${v} interface has exactly the pinned local fields (${fieldsOf(types, v).join(',')})`);
  // negative fixture: Mutation A (a colony aggregate added to SelfView) fails the pin
  const mutA = types.replace('  begging_recent: number;', '  begging_recent: number;\n  nest_mood: number;');
  ok(mutA !== types && !sameSet(fieldsOf(mutA, 'SelfView'), VIEW_FIELDS.SelfView), 'pin check catches a field added to SelfView (nest_mood)');
  // deep-frozen constants
  const deepFrozen = (o: unknown): boolean => o === null || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o as object).every(deepFrozen));
  const mc = buildModel(RAW, SC).consts;
  ok(deepFrozen(mc), 'decision constants are deep-frozen');
  assert.throws(() => { (mc as any).hill_n = 9; }, TypeError); checks++;
  assert.throws(() => { (mc.f_t as any).peak = 9; }, TypeError); checks++;
  ok(!deepFrozen(Object.freeze({ f_t: { peak: 1 } })), 'deep-freeze check catches a shallow freeze (negative fixture)');
  // runtime guard: reading anything that is not a local signal throws
  const selfV = guardView({ crop: 0, crop_room: 1, crop_fill: 0, theta_forage: 0.5, theta_brood: 1, gain: 1, thermal_offset_c: 0, ctmax_c: 42, has_route: false, recruit_contacts_recent: 0, begging_recent: 0 }, 'self');
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
  ok(Object.keys(seen).sort().join() === 'larva,partner,self,site,source', `every view kind is built in 24 h (${Object.keys(seen).join(',')})`);
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
let cont48: World;
{
  cont48 = run(1, [2 * DAY]);
  const a = run(1, [DAY]), snap = a.snapshot();
  const b = World.restore(RAW, snap, { captureLog: true });
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
{
  const again = run(1, [DAY]);
  ok(again.logHash === ref.logHash && again.stateHash() === refState, 'same seed + parameters => identical sha256 of the event log and state');
  const s2 = run(2, [DAY]), s3 = run(3, [DAY]);
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
  const declines = evs.filter((e) => e.k === 'at_entrance' && e.p.choice !== 'exit').length, backIns = evs.filter((e) => e.k === 'back_in').length;
  ok(declines > 0 && backIns > 0 && backIns <= declines, `declines walk back before entering the nest (${declines} declines, ${backIns} back_in)`);
  ok(w.stats().occ.from_entrance.some((x) => x > 0), 'walking-back time is booked as its own state');
  ok(evs.filter((e) => e.k === 'env_sample').every((e) => e.p.synthetic === true && e.p.rain === null), 'every weather sample is labelled synthetic and rain stays unknown (null), never 0');
}

// ------------------------------------------------------------------ 8. time contract
{
  const evs = cont48.lines!.map((l) => JSON.parse(l));
  let mono = true; for (let i = 1; i < evs.length; i++) { const a = evs[i - 1], b = evs[i]; if (a.t > b.t || (a.t === b.t && (a.r > b.r || (a.r === b.r && (a.q > b.q || (a.q === b.q && a.id >= b.id)))))) mono = false; }
  ok(mono, 'the log is in layered order (exact instant, round, seeded tie-break, canonical id), each id once');
  ok(evs.every((e) => e.q === tieOf(1, e.t, e.id)), 'every tie-break is hash32(seed|t|id) (deterministic, chunk-invariant)');
  // same-instant batches of several workers: the first processed is not always the lowest id (no systematic w001 bias)
  const groups = new Map<string, any[]>(); for (const e of evs) if ((WORKER_KINDS as readonly string[]).includes(e.k)) { const k = `${e.t}|${e.r}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
  const multi = [...groups.values()].filter((g) => new Set(g.map((e) => e.a)).size > 1);
  const lowestFirst = multi.filter((g) => g[0].a === [...g.map((e) => e.a)].sort()[0]).length;
  ok(multi.length >= 5 && lowestFirst < multi.length, `same-instant worker batches are not ordered by id (${lowestFirst}/${multi.length} start with the lowest id)`);
  const r = evaluateContract(evs.map((e) => ({ id: e.id, exact: exactOfMs(e.t), entities: [e.a] })), { name: 'layered', kind: 'layered', ticks_per_us: null });
  ok(r.merged_batches === 0, 'no batch merges distinct exact instants (engine/scheduler/time-contract.ts, layered)');
  ok(evs.some((e) => e.t % 1000 !== 0), 'events fall between whole seconds (continuous time, not frame ticks)');
}

// ------------------------------------------------------------------ 9. diagnostic (NOT a target, CLAUDE.md §7)
const diag: Record<string, unknown> = {};
for (const variant of Object.keys(RAW.sensitivity_variants).filter((k) => k !== '_note')) for (const sc of ['taichung-march-ref', 'taichung-may-ref']) {
  const w = World.create(RAW, sc, 1, { captureLog: true, variant }); w.advanceTo(2 * DAY);
  const r = activityReport(w.stats(), w.lines!, `${variant} / ${sc} seed 1, 2 days (diagnostic, synthetic weather)`);
  ok(r.outside_share_by_hour.length === 24 && r.trap_3h.length === 8 && w.conservation().ok, `${variant} / ${sc}: diagnostic report built, food conserved`);
  const evs = w.lines!.map((l) => JSON.parse(l));
  diag[`${variant} / ${sc}`] = { trap_3h: r.trap_3h, exits_by_hour: r.exits_by_hour, outside_share_by_hour: r.outside_share_by_hour, exits_day: r.exits_day, exits_twilight_or_night: r.exits_twilight_or_night, empty_arrivals: evs.filter((e) => e.p.take === 0).length, routes_forgotten: evs.filter((e) => e.p.forgot_route).length, same_instant_events: w.stats().same_instant_events };
}
// ------------------------------------------------------------------ 10. pinned hashes (seed 1, March reference, 24 h)
// Update these DELIBERATELY (and say why in the PR) whenever behaviour changes; an unexplained change is a regression.
const PINNED = { log: '7d6e43afca735b6416faf0b2a2e868284b485ae50734a65e9f1ab4b496187d85', state: 'eeae295c98db19c524b9dce2ef82b5f66b21b384838a1346873797f676e8582f' };
ok(ref.logHash === PINNED.log, `pinned 24 h log hash (got ${ref.logHash})`);
ok(refState === PINNED.state, `pinned 24 h state hash (got ${refState})`);
console.log(JSON.stringify({ test: 'p0a2-24h-proto', checks, seconds: (Date.now() - T0) / 1000, events_24h_seed1: ref.lines!.length, log_sha_24h_seed1: ref.logHash, diagnostic_not_a_target: diag }));

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
 *  9. diagnostic (NOT a target): activity by hour, virtual entrance trap in 3-hour bins
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { sha256Hex } from '../engine/sha256.ts';
import { evaluateContract } from '../engine/scheduler/time-contract.ts';
import { World, guardView, LocalityError, exactOfMs, WORKER_KINDS, WORLD_KINDS, SOURCE_ID } from '../prototypes/p0a2-24h/world.ts';
import { evidenceProblems, valueEntries, buildModel } from '../prototypes/p0a2-24h/params.ts';
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
const run = (seed: number, steps: number[], opts = { captureLog: true }) => { const w = World.create(RAW, SC, seed, opts); for (const t of steps) w.advanceTo(t); return w; };
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
const FORBIDDEN = /\b(world|World|workers|larvae|sources|ledger|stats|colony|colonies|queue|stock|totals?|t_now|hourOfDay|Date|env|Environment|this|globalThis)\b/;
function decisionProblems(src: string): string[] {
  const p: string[] = [], code = strip(src);
  for (const m of code.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)) if (!m[1] || m[2] !== './types.ts') p.push(`decision imports ${m[2]}${m[1] ? '' : ' (not type-only)'}`);
  const c = noStrings(code).replace(/^\s*import[^;]*;/gm, '');
  const hit = c.match(FORBIDDEN); if (hit) p.push(`decision code names colony-level / global state: ${hit[0]}`);
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
  ]) ok(decisionProblems(bad).length > 0, `static locality check catches: ${bad.split('\n').pop()}`);
  // the view types carry only individual / local fields
  const types = strip(fs.readFileSync(path.join(DIR, 'types.ts'), 'utf8'));
  for (const v of ['SelfView', 'SiteView', 'SourceView', 'PartnerView', 'LarvaView']) {
    const body = types.match(new RegExp(`export interface ${v} \\{([\\s\\S]*?)\\n\\}`))![1];
    ok(!/colony|total|workers|larvae|queue|hour|time_of_day|clock/i.test(body), `${v} has no colony-level or time-of-day field`);
  }
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
  ok(evs.filter((e) => e.k === 'env_sample').every((e) => e.p.synthetic === true && e.p.rain === null), 'every weather sample is labelled synthetic and rain stays unknown (null), never 0');
}

// ------------------------------------------------------------------ 8. time contract
{
  const evs = cont48.lines!.map((l) => JSON.parse(l));
  let mono = true; for (let i = 1; i < evs.length; i++) { const a = evs[i - 1], b = evs[i]; if (a.t > b.t || (a.t === b.t && (a.r > b.r || (a.r === b.r && a.id >= b.id)))) mono = false; }
  ok(mono, 'the log is in layered order (exact instant, round, canonical id), each id once');
  const r = evaluateContract(evs.map((e) => ({ id: e.id, exact: exactOfMs(e.t), entities: [e.a] })), { name: 'layered', kind: 'layered', ticks_per_us: null });
  ok(r.merged_batches === 0, 'no batch merges distinct exact instants (engine/scheduler/time-contract.ts, layered)');
  ok(evs.some((e) => e.t % 1000 !== 0), 'events fall between whole seconds (continuous time, not frame ticks)');
}

// ------------------------------------------------------------------ 9. diagnostic (NOT a target, CLAUDE.md §7)
const diag: Record<string, unknown> = {};
for (const sc of ['taichung-march-ref', 'taichung-may-ref']) {
  const w = World.create(RAW, sc, 1, { captureLog: true }); w.advanceTo(3 * DAY);
  const r = activityReport(w.stats(), w.lines!, `${sc} seed 1, 3 days (diagnostic, synthetic weather)`);
  ok(r.outside_share_by_hour.length === 24 && r.trap_3h.length === 8 && w.conservation().ok, `${sc}: diagnostic report built`);
  diag[sc] = { outside_share_by_hour: r.outside_share_by_hour, exits_by_hour: r.exits_by_hour, declines_by_hour: r.declines_by_hour, trap_3h: r.trap_3h, exits_day: r.exits_day, exits_twilight_or_night: r.exits_twilight_or_night, same_instant_events: w.stats().same_instant_events };
}
console.log(JSON.stringify({ test: 'p0a2-24h-proto', checks, seconds: (Date.now() - T0) / 1000, events_24h_seed1: ref.lines!.length, log_sha_24h_seed1: ref.logHash, diagnostic_not_a_target: diag }));

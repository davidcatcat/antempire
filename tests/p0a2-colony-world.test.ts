/**
 * P0-A2 colony-members CANDIDATE world (docs/colony-candidate-world.md; world kind p0a2-colony / save kind
 * p0a2-colony-v1; opt-in, default off): queens, major workers, eggs and pupae as engine individuals next to the
 * unchanged P0-A2 world. Rules update (CLAUDE.md §6); non-official.
 *
 *  1. the DEFAULT path is unchanged: the default world's code graph, code hash, rules fingerprint and engine version are
 *     the pinned values of before this rules update; no file of the default graph is a candidate file; the default
 *     runtime kind still creates the default world
 *  2. generated files are current (scenario extract, colony code hash); the extract copies the scenario (no own number)
 *  3. initial conditions = the scenario's own sampler rules: draws equal engine/day0/founding-sampler.ts on the FULL
 *     scenario for many seeds; applied counts follow the documented mapping; a scenario without a major fraction → 0
 *     majors; nothing is invented
 *  4. determinism: same seed → identical events, frames and snapshot; another seed differs
 *  5. independence: the candidate's base events / frame / base snapshot are EXACTLY the default world's for the same
 *     seed (the roster individuals interact with nothing); the roster events come first
 *  6. event-split invariance: chunked advancing (any chunking, with a work budget) == one advance
 *  7. snapshot / restore: byte-identical round trip; split + restore + continue == one run; every tampering is refused;
 *     the two kinds refuse each other's snapshots
 *  8. nothing invented: after 24 h no roster individual changed (no eggs laid, no food, no metabolism, no death, no
 *     development); every CQ-1 candidate port is null; conservation holds (base food integers + roster ledgers)
 *  9. locality (§2.1 / §2.1b): a roster record depends only on its own id and time (other individuals change no byte of
 *     it); engine/colony/roster.ts cannot see the world; the P0-A2 core cannot see the roster
 * 10. assumption switches: major_behaviour as_minor is declared but refused; a major needs the caste enabled by the
 *     parameter object (never a species name); every parameter is labelled assumption:true with a basis and existing sources
 * 11. Worker runtime round trip (init kind, pacing ticks, snapshot, restore, follow) and the frame shape + labels
 * 12. save / verify: the Node verifier recomputes a candidate save (node_verified); altered saves are never verified;
 *     a default save still verifies under its own kind
 * 13. Worker boundary: the candidate graph passes (allowlist, purity, deterministic maths); negative samples
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { verifySaveText } from '../cli/verify-save.ts';
import { checkBoundary, type Boundary } from './lib/worker-boundary.ts';
import { Runtime } from '../prototypes/continuous-world/worker/runtime.ts';
import { WORLD_KINDS as REGISTRY } from '../prototypes/continuous-world/worker/world-kinds.ts';
import { WORLD_KINDS as PROTOCOL_KINDS, isP0a2ColonyFrame, isP0a2Frame, type AnyFrameMsg, type ColonyIndividualMsg, type P0a2ColonyMsg, type Reply } from '../prototypes/continuous-world/worker/protocol.ts';
import { P0A2_CODE_FILES, P0A2_CODE_SHA256 } from '../prototypes/continuous-world/worker/p0a2-code-hash.ts';
import { P0A2_COLONY_CODE_FILES, P0A2_COLONY_CODE_SHA256 } from '../prototypes/continuous-world/worker/p0a2-colony-code-hash.ts';
import { COLONY_SCENARIO } from '../prototypes/continuous-world/worker/p0a2-colony-scenario.ts';
import { COLONY_CONST_FILE, COLONY_ENTRY, COLONY_SCENARIO_CONST_FILE, COLONY_SCENARIO_FILE, codeHash, colonyConstFileText, colonyScenarioExtract, colonyScenarioFileText } from '../prototypes/continuous-world/tools/p0a2-code-hash.ts';
import { LABEL_ZH, P0A2_ENGINE_VERSION, P0A2_RULES_FINGERPRINT, P0A2_SAVE_WORLD_KIND, P0a2ExperimentWorld, P0a2Refused, p0a2SaveMetaOf, type P0a2Event } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import {
  P0A2_COLONY_ENGINE_FAMILY, P0A2_COLONY_ENGINE_HISTORY, P0A2_COLONY_ENGINE_VERSION, P0A2_COLONY_PARAMS_SHA, P0A2_COLONY_RULES_FINGERPRINT, P0A2_COLONY_SAVE_WORLD_KIND, P0A2_COLONY_STATUS_ZH, P0A2_COLONY_WORLD_KIND,
  P0a2ColonyWorld, colonyCompositionOf, colonyNotSimulatedOf, compositionFrom, type ColonyScenarioExtract, type P0a2ColonySnapshot,
} from '../prototypes/continuous-world/worker/p0a2-colony-world.ts';
import { hashJson } from '../prototypes/continuous-world/worker/sha256.ts';
import { sampleInitialConditions, scenarioChecksum } from '../engine/day0/founding-sampler.ts';
import { notSimulatedOf, summaryOf } from '../web/src/experimental/save-format.ts';
import { NULL_PORTS, oviposit, bookMetabolism, memberParams } from '../engine/colony/members.ts';
import { INDIVIDUAL_NOT_SIMULATED, ROSTER_PARAMS_SCHEMA, ROSTER_PORTS, buildRoster, restoreRoster, rosterAudit, rosterIndividuals, rosterParams, rosterSnapshot } from '../engine/colony/roster.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const eq = (a: unknown, b: unknown, why: string) => { assert.deepEqual(a, b, why); checks++; };
const throws = (f: () => unknown, re: RegExp, why: string) => { assert.throws(f, re, why); checks++; };
const refused = (f: () => unknown, code: string, why: string) => { try { f(); } catch (e) { ok(e instanceof P0a2Refused && e.code === code, `${why} (got ${(e as P0a2Refused).code ?? (e as Error).message})`); return; } assert.fail(`${why}: not refused`); };
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
type J = Record<string, unknown>;
const HOUR = 3600, DAY = 24 * HOUR;
const SEEDS = [0, 1, 7, 20261113, 4294967295];

// ---------------------------------------------------------------- 1. the default path is unchanged
// pinned from origin/main before this rules update (971bd56): none of these may change in a PR that only adds a candidate
ok(P0A2_CODE_SHA256 === '5116a13ea5b111daa457d8610cb90deca3b14bdc7f64cefd5b067371c6c0f262', 'default P0-A2 code hash is the pinned pre-update value');
ok(P0A2_RULES_FINGERPRINT === '45c3e17440ec699c6f6c1b708d9f7bea036d452b127d729e6cd926fa713d6a49', 'default P0-A2 rules fingerprint is the pinned pre-update value');
ok(P0A2_ENGINE_VERSION === 'experiment-p0a2-24h/3', 'default engine version is not bumped (its stored content did not change)');
eq(codeHash(), { files: [...P0A2_CODE_FILES], sha256: P0A2_CODE_SHA256 }, 'default code hash constant is current');
ok(P0A2_CODE_FILES.length === 17 && !P0A2_CODE_FILES.some((f) => /colony|day0/.test(f)), 'the default world\'s code graph contains no colony / day0 module');
for (const f of P0A2_CODE_FILES) ok(!/p0a2-colony|engine\/colony|founding-sampler/.test(stripComments(read(f))), `${f} (default graph) does not mention the candidate`);
ok(P0A2_COLONY_RULES_FINGERPRINT !== P0A2_RULES_FINGERPRINT && !P0A2_COLONY_ENGINE_VERSION.startsWith('experiment-p0a2-24h/') && P0A2_COLONY_ENGINE_VERSION.startsWith(P0A2_COLONY_ENGINE_FAMILY) && P0A2_COLONY_ENGINE_VERSION in P0A2_COLONY_ENGINE_HISTORY, 'the candidate has its own engine family, version history entry and fingerprint');
{
  const rt = new Runtime(() => 0);
  const f = (rt.handle({ type: 'init', req: 1, world_id: 'exp-default', seed: 7, kind: 'p0a2' }).at(-1) as { frame: AnyFrameMsg }).frame;
  ok(isP0a2Frame(f) && !isP0a2ColonyFrame(f) && !('colony' in f) && f.engine_version === P0A2_ENGINE_VERSION && f.workers.every((w) => !('caste' in w)), 'init kind p0a2 still creates the default world (no colony, no caste field)');
  const f0 = (new Runtime(() => 0).handle({ type: 'init', req: 1, world_id: 'exp-default', seed: 7 }).at(-1) as { frame: AnyFrameMsg }).frame;
  ok(!isP0a2Frame(f0), 'init without a kind still creates the synthetic world (the candidate is never a default)');
  eq([...PROTOCOL_KINDS], ['synthetic', 'p0a2', 'p0a2-colony'], 'protocol world kinds: the candidate is an added, named kind');
  eq(Object.keys(REGISTRY), ['synthetic-v1', P0A2_SAVE_WORLD_KIND, P0A2_COLONY_SAVE_WORLD_KIND], 'verifier registry: the candidate is an added kind');
}

// ---------------------------------------------------------------- 2. generated files
ok(read(COLONY_SCENARIO_CONST_FILE) === colonyScenarioFileText(colonyScenarioExtract()), 'scenario extract is current (regenerate: node prototypes/continuous-world/tools/p0a2-code-hash.ts --write)');
ok(read(COLONY_CONST_FILE) === colonyConstFileText(codeHash(REPO_ROOT, COLONY_ENTRY)), 'colony code hash constant is current (regenerate: node prototypes/continuous-world/tools/p0a2-code-hash.ts --write)');
eq(codeHash(REPO_ROOT, COLONY_ENTRY), { files: [...P0A2_COLONY_CODE_FILES], sha256: P0A2_COLONY_CODE_SHA256 }, 'colony code hash matches its graph');
ok(P0A2_CODE_FILES.every((f) => P0A2_COLONY_CODE_FILES.includes(f)), 'the candidate graph contains the whole default graph (same core, no second implementation)');
eq(P0A2_COLONY_CODE_FILES.filter((f) => !P0A2_CODE_FILES.includes(f)), ['engine/colony/members.ts', 'engine/colony/roster.ts', 'engine/day0/founding-sampler.ts', 'prototypes/continuous-world/worker/p0a2-colony-scenario.ts', 'prototypes/continuous-world/worker/p0a2-colony-world.ts'], 'the candidate adds exactly these modules');
const FULL = JSON.parse(read(COLONY_SCENARIO_FILE));
const SC = COLONY_SCENARIO as unknown as ColonyScenarioExtract;
ok(SC.checksum === scenarioChecksum(FULL) && SC.id === FULL.id && SC.activated === false && /候選／實驗/.test(SC.status), 'extract carries the checksum of the WHOLE scenario file, its id and its not-activated candidate status');
for (const [k, spec] of Object.entries(SC.fields)) {
  const f = FULL.fields[k]; ok(spec !== null && f && f.assumption === true, `${k}: taken from a scenario field labelled assumption:true`);
  for (const p of ['distribution', 'value', 'min', 'max'] as const) ok((spec as J)[p] === f[p], `${k}.${p} is the scenario's own value (no number defined in the Worker)`);
}
ok(SC.brood_level === FULL.scenario_variants.brood.default_level && SC.brood_level === 'mid' && SC.major_fraction_isolated === true && FULL.fields.major_fraction.isolated === true, 'brood level is the scenario\'s pre-registered default (mid); the major fraction is its isolated candidate');

// ---------------------------------------------------------------- 3. initial conditions = the scenario's sampler rules
for (let seed = 0; seed < 200; seed++) {
  const c = colonyCompositionOf(seed, 30, 8), ic = sampleInitialConditions(FULL, seed);
  for (const k of Object.keys(c.draws)) assert.equal(c.draws[k], ic.draws[k], `seed ${seed}: draw ${k} equals the sampler on the full scenario`);
  const f = c.draws.major_fraction as number;
  assert.ok(c.applied.queens === ic.composition.queens && (c.applied.queens === 2 || c.applied.queens === 3), 'queens 2–3, the sampler\'s value');
  assert.ok(f >= 0.06 && f < 0.25 && c.applied.major_workers === Math.round((f * 30) / (1 - f)), 'majors by the scenario formula on the actual minors');
  assert.deepEqual([c.applied.minor_workers, c.applied.eggs, c.applied.larvae, c.applied.pupae], [30, Math.round(0.25 * 30), 8, Math.round(0.1 * 30)], 'eggs / pupae by the mid ratios on the actual minors; minors and larvae are the base group');
  checks += 3;
}
{
  const c = colonyCompositionOf(7, 30, 8);
  eq(c.not_applied.map((x) => [x.field, x.used]), [['minor_workers', 30], ['larvae_per_minor', 8], ['carried_brood_progress', null]], 'sampled values that are recorded but not applied are listed with what is used instead');
  ok(c.not_applied[0].scenario_value === sampleInitialConditions(FULL, 7).composition.minor_workers && c.not_applied.every((x) => x.reason_zh.length > 10), 'each not-applied value keeps the scenario value and a reason');
  eq(colonyCompositionOf(7, 60, 8).applied, { ...c.applied, minor_workers: 60, major_workers: Math.round(((c.draws.major_fraction as number) * 60) / (1 - (c.draws.major_fraction as number))), eggs: 15, pupae: 6 }, 'counts scale with the actual minors of the base group (rule, not constants)');
  // a scenario that leaves the major fraction out: no majors (no invented ratio)
  const none = compositionFrom({ ...SC, fields: { ...SC.fields, major_fraction: null } }, 7, 30, 8);
  ok(none.applied.major_workers === 0 && none.draws.major_fraction === null && none.applied.queens === c.applied.queens, 'scenario without a major fraction → 0 majors, other draws unchanged');
  const noBrood = compositionFrom({ ...SC, fields: { ...SC.fields, eggs_per_minor: null, pupae_per_minor: null } }, 7, 30, 8);
  ok(noBrood.applied.eggs === 0 && noBrood.applied.pupae === 0, 'scenario without brood ratios → no eggs / pupae');
  throws(() => compositionFrom({ ...SC, fields: { ...SC.fields, queens: null } }, 7, 30, 8), /no queen count/, 'a scenario without a queen count is refused (no default queen number)');
}

// ---------------------------------------------------------------- helpers
const run = (seed: number, upTo: number, id = 'exp-colony') => { const c = P0a2ColonyWorld.create(id, seed); const events = [...c.events, ...c.world.advanceTo(upTo).events]; return { world: c.world, events }; };
const runBase = (seed: number, upTo: number, id = 'exp-colony') => { const c = P0a2ExperimentWorld.create(id, seed); const events = [...c.events, ...c.world.advanceTo(upTo).events]; return { world: c.world, events }; };
const frameOf = (w: P0a2ColonyWorld) => w.frame() as unknown as AnyFrameMsg & { colony: P0a2ColonyMsg };

// ---------------------------------------------------------------- 4. determinism
{
  const a = run(7, 6 * HOUR), b = run(7, 6 * HOUR), c = run(8, 6 * HOUR);
  ok(JSON.stringify(a.events) === JSON.stringify(b.events) && a.events.length > 1000, `same seed → identical events (${a.events.length})`);
  ok(JSON.stringify(a.world.frame()) === JSON.stringify(b.world.frame()), 'same seed → identical frame');
  ok(a.world.snapshot().payload_sha256 === b.world.snapshot().payload_sha256 && JSON.stringify(a.world.snapshot()) === JSON.stringify(b.world.snapshot()), 'same seed → byte-identical snapshot');
  ok(a.world.snapshot().payload_sha256 !== c.world.snapshot().payload_sha256 && a.world.chainState().head !== c.world.chainState().head, 'another seed → another world');
  ok(a.events.every((e, i) => e.seq === i && e.official === false && e.label === LABEL_ZH && e.rules_fingerprint === P0A2_COLONY_RULES_FINGERPRINT && e.engine_version === P0A2_COLONY_ENGINE_VERSION), 'events: contiguous seq, non-official label, this kind\'s fingerprint and version');
  ok(a.world.chainState().count === a.events.length && a.world.seqNo() === a.events.length, 'event chain counts every event');
}

// ---------------------------------------------------------------- 5. independence from the base world
for (const seed of SEEDS) {
  const c = run(seed, DAY), b = runBase(seed, DAY);
  const k = c.events.findIndex((e) => !e.event_id.startsWith('colony:'));
  const roster = c.events.slice(0, k), rest = c.events.slice(k);
  const comp = colonyCompositionOf(seed, 30, 8).applied;
  ok(k === comp.queens + comp.major_workers + comp.eggs + comp.pupae && roster.every((e) => e.t_sim === 0 && e.event_id.startsWith('colony:')) && rest.every((e) => !e.event_id.startsWith('colony:')), `seed ${seed}: the ${k} roster events come first, all at t = 0`);
  const asBase = (e: P0a2Event): P0a2Event => ({ ...e, seq: e.seq - k, rules_fingerprint: P0A2_RULES_FINGERPRINT, engine_version: P0A2_ENGINE_VERSION });
  ok(rest.length === b.events.length && JSON.stringify(rest.map(asBase)) === JSON.stringify(b.events), `seed ${seed}: the 30 minors' and 8 larvae's 24 h event stream is exactly the default world's (${rest.length} events)`);
  eq(roster.map((e) => e.kind), [...Array(comp.queens).fill('queen_added'), ...Array(comp.major_workers).fill('worker_added'), ...Array(comp.eggs + comp.pupae).fill('brood_item_added')], `seed ${seed}: roster events in the fixed order queens, majors, eggs, pupae`);
  ok(roster.every((e) => e.data.assumption === true && e.data.scenario_id === 'BUD-CAND-2' && e.data.initial_reserve_known === false), `seed ${seed}: roster events are labelled assumption / scenario / reserve unknown`);
  const fc = c.world.frame() as J, fb = b.world.frame() as J;
  const { colony: _c, status_zh: _s, rules_fingerprint: _r, engine_version: _e, seq: _q, workers: wc, ...restC } = fc;
  const { status_zh: _s2, rules_fingerprint: _r2, engine_version: _e2, seq: _q2, workers: wb, ...restB } = fb;
  eq(restC, restB, `seed ${seed}: frame fields of the base world are identical`);
  eq((wc as J[]).map(({ caste, ...w }) => { assert.equal(caste, 'minor'); return w; }), wb, `seed ${seed}: frame workers are the default world's workers (+ caste minor)`);
  ok(fc.world_kind === 'p0a2' && fc.seq === (fb.seq as number) + k, 'frame family p0a2; seq shifted by the roster events');
  eq(c.world.snapshot().payload.base, b.world.snapshot(), `seed ${seed}: the base snapshot inside the candidate save is byte-for-byte the default world's snapshot`);
}

// ---------------------------------------------------------------- 6. event-split invariance
{
  const one = run(7, 12 * HOUR);
  for (const [name, steps, budget] of [['1 s … 1 h mixed', [1, 0.5, 59.5, 600, 0.001, 3599.999, 7200, 1, 10800, 20736.5, 0, 3.5], Infinity], ['60 s slices', Array(720).fill(60), Infinity], ['budgeted (40 events per call)', [12 * HOUR], 40]] as [string, number[], number][]) {
    const c = P0a2ColonyWorld.create('exp-colony', 7), ev = [...c.events]; let t = 0;
    for (const dt of steps) { t = Math.min(12 * HOUR, t + dt); for (;;) { const r = c.world.advanceTo(t, budget); ev.push(...r.events); if (r.done) break; } }
    ev.push(...c.world.advanceTo(12 * HOUR).events);
    ok(JSON.stringify(ev) === JSON.stringify(one.events) && c.world.snapshot().payload_sha256 === one.world.snapshot().payload_sha256, `chunking "${name}" gives the same events and state as one advance`);
  }
}

// ---------------------------------------------------------------- 7. snapshot / restore
const mid = run(7, 5 * HOUR), snapMid = mid.world.snapshot();
{
  const back = P0a2ColonyWorld.restore(structuredClone(snapMid));
  ok(JSON.stringify(back.snapshot()) === JSON.stringify(snapMid), 'restore → snapshot is byte-identical');
  ok(JSON.stringify(back.frame()) === JSON.stringify(mid.world.frame()), 'restore → frame identical');
  const full = run(7, 11 * HOUR), cont = back.advanceTo(11 * HOUR).events;
  ok(JSON.stringify([...mid.events, ...cont]) === JSON.stringify(full.events) && JSON.stringify(back.snapshot()) === JSON.stringify(full.world.snapshot()), 'split + restore + continue == one run (events, chain, state)');
  const before = JSON.stringify(snapMid); mid.world.snapshot(); mid.world.frame(); mid.world.antView('q01');
  ok(JSON.stringify(mid.world.snapshot()) === before, 'snapshot / frame / follow are pure reads');
  // tampering: every altered copy is refused (hashes recomputed so that only the content check can catch it)
  const tamper = (why: string, code: string, f: (s: P0a2ColonySnapshot) => void, reseal = true) => {
    const s = structuredClone(snapMid); f(s); if (reseal) s.payload_sha256 = hashJson(s.payload);
    refused(() => P0a2ColonyWorld.restore(s), code, `restore refuses ${why}`);
  };
  tamper('an edited payload without a new hash', 'HASH_MISMATCH', (s) => { (s.payload.colony.items as J)['e99'] = {}; }, false);
  tamper('an added egg', 'BAD_COLONY', (s) => { const it = s.payload.colony.items as Record<string, J>; it.e09 = { ...it.e01, id: 'e09' }; });
  tamper('an added egg with a placement', 'COLONY_MISMATCH', (s) => { const it = s.payload.colony.items as Record<string, J>, pl = s.payload.colony.placement as Record<string, J>; it.e09 = { ...it.e01, id: 'e09' }; pl.e09 = { ...pl.e01 }; });
  tamper('a removed queen', 'BAD_COLONY', (s) => { delete ((s.payload.colony.members as J).queens as J).q02; });
  tamper('a pupa turned into an egg', 'COLONY_MISMATCH', (s) => { (s.payload.colony.items as Record<string, J>).p01.stage = 'egg'; });
  tamper('a brood item with an invented stage', 'BAD_COLONY', (s) => { (s.payload.colony.items as Record<string, J>).p01.stage = 'larva'; });
  tamper('food credited to a queen from nowhere', 'BAD_COLONY', (s) => { ((((s.payload.colony.members as J).queens as Record<string, J>).q01.ledger as J).have as J).sugar_ug = 5; });
  tamper('a queen that laid eggs', 'BAD_COLONY', (s) => { ((s.payload.colony.members as J).queens as Record<string, J>).q01.eggs_laid = 3; });
  tamper('a major re-labelled as a minor', 'COLONY_MISMATCH', (s) => { ((s.payload.colony.members as J).workers as Record<string, J>).m01.caste = 'minor'; });
  tamper('a major that left the nest', 'BAD_COLONY', (s) => { (s.payload.colony.placement as Record<string, J>).m01.loc = 'outside'; });
  tamper('another major behaviour', 'BAD_COLONY', (s) => { s.payload.colony.major_behaviour = 'as_minor'; });
  tamper('another rules fingerprint', 'FINGERPRINT_MISMATCH', (s) => { s.rules_fingerprint = 'f'.repeat(64); s.payload.rules_fingerprint = 'f'.repeat(64); });
  tamper('an older / other engine version', 'ENGINE_MISMATCH', (s) => { s.engine_version = 'experiment-p0a2-colony/0'; s.payload.engine_version = 'experiment-p0a2-colony/0'; });
  tamper('an official flag', 'NOT_EXPERIMENT', (s) => { (s as unknown as J).official = true; }, false);
  tamper('a base world of another time', 'BASE_MISMATCH', (s) => { s.payload.base = run(7, 4 * HOUR).world.snapshot().payload.base; });
  tamper('a base world of another seed', 'BASE_MISMATCH', (s) => { s.payload.base = run(8, 5 * HOUR).world.snapshot().payload.base; });
  tamper('an edited base world state', 'HASH_MISMATCH', (s) => { ((s.payload.base.payload.state as J).workers as Record<string, J>).w001.crop = 1; });
  tamper('edited save metadata (applied counts)', 'META_MISMATCH', (s) => { s.payload.save_meta.colony.composition.applied.queens = 9; });
  tamper('a removed 尚未模擬 entry', 'META_MISMATCH', (s) => { (s.payload.save_meta.not_simulated as unknown as { items: unknown[] }).items.pop(); });
  tamper('a fork record', 'FORK_UNSUPPORTED', (s) => { (s.payload.save_meta as unknown as { lineage: unknown[] }).lineage = [{}]; });
  tamper('a chain of another count', 'CHAIN_MISMATCH', (s) => { s.payload.chain.count += 1; });
  tamper('a shifted seq', 'BAD_STATE', (s) => { s.seq += 1; s.payload.seq += 1; });
  tamper('an extra payload field', 'BAD_SNAPSHOT', (s) => { (s.payload as unknown as J).verified = true; });
  // the two kinds refuse each other's snapshots
  refused(() => P0a2ColonyWorld.restore(runBase(7, HOUR).world.snapshot() as unknown as P0a2ColonySnapshot), 'ENGINE_MISMATCH', 'the candidate refuses a default-world snapshot');
  refused(() => P0a2ExperimentWorld.restore(snapMid as never), 'ENGINE_MISMATCH', 'the default world refuses a candidate snapshot');
}

// ---------------------------------------------------------------- 8. nothing invented: the roster does not change
for (const seed of [7, 0]) {
  const c = P0a2ColonyWorld.create('exp-colony', seed), s0 = c.world.snapshot(), f0 = frameOf(c.world);
  c.world.advanceTo(DAY);
  const s1 = c.world.snapshot(), f1 = frameOf(c.world);
  eq(s1.payload.colony, s0.payload.colony, `seed ${seed}: after 24 h the roster state is unchanged (no laying, feeding, metabolism, development or death)`);
  eq(f1.colony, f0.colony, `seed ${seed}: after 24 h the colony part of the frame is unchanged`);
  ok(f1.colony.queens.every((q) => q.eggs_laid === 0 && q.last_oviposition_s === null && q.alive && q.state === 'in_nest') && f1.colony.eggs.length === f0.colony.eggs.length && f1.colony.pupae.every((p) => p.stage === 'pupa'), `seed ${seed}: no egg was laid, no brood item changed stage`);
  const cons = c.world.conservation();
  ok(cons.ok && cons.base.ok && cons.roster.ok && cons.base.workers === 30 && cons.base.larvae === 8, `seed ${seed}: conservation holds (base food integers, roster ledgers, individual counts)`);
  ok(cons.base.held + cons.base.used === cons.base.initial + cons.base.produced, `seed ${seed}: base food: held + used = initial + produced (exact integers) — the roster took nothing`);
  ok(s1.payload.save_meta.colony.roster_sha256 === hashJson(s1.payload.colony), `seed ${seed}: the roster hash in save_meta is the roster's`);
}
{
  ok(ROSTER_PORTS === NULL_PORTS && ROSTER_PORTS.oviposition === null && ROSTER_PORTS.egg_cost === null && ROSTER_PORTS.caste_fate === null && Object.values(ROSTER_PORTS.metabolism).every((p) => p === null), 'every CQ-1 physiology candidate of the roster is null (尚未模擬)');
  const P = rosterParams(JSON.parse(read('prototypes/continuous-world/worker/p0a2-colony-params.json')).roster);
  const r = buildRoster(7, P, { queens: 2, majors: 4, eggs: 8, pupae: 3 }, 0), before = rosterSnapshot(r.state);
  ok(oviposit(r.state.members, ROSTER_PORTS, 'q01', DAY * 1000) === null && bookMetabolism(r.state.members, ROSTER_PORTS, 'q01', DAY * 1000) === null && bookMetabolism(r.state.members, ROSTER_PORTS, 'm01', DAY * 1000) === null && rosterSnapshot(r.state) === before, 'an oviposition / metabolism opportunity with the roster ports creates and books nothing');
  ok(rosterAudit(r.state).ok && rosterSnapshot(restoreRoster(before)) === before, 'roster audit holds; roster snapshot round trip is byte-identical');
}

// ---------------------------------------------------------------- 9. locality
{
  const P = rosterParams(JSON.parse(read('prototypes/continuous-world/worker/p0a2-colony-params.json')).roster);
  const small = buildRoster(7, P, { queens: 2, majors: 1, eggs: 1, pupae: 1 }, 0).state, big = buildRoster(7, P, { queens: 3, majors: 9, eggs: 40, pupae: 12 }, 0).state;
  for (const id of ['q01', 'q02']) eq(big.members.queens[id], small.members.queens[id], `${id}: adding a queen, majors and brood changes no byte of this queen's record (own chain, own ledger)`);
  eq(big.members.workers.m01, small.members.workers.m01, 'm01: unchanged by the other individuals');
  eq([big.items.e01, big.items.p01, big.placement.q01], [small.items.e01, small.items.p01, small.placement.q01], 'brood items and placements: unchanged by the other individuals');
  const rosterSrc = read('engine/colony/roster.ts');
  eq([...rosterSrc.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort(), ['../sha256.ts', './members.ts'], 'engine/colony/roster.ts imports only ./members.ts and ../sha256.ts (it cannot see a world, a store or a total)');
  const code = stripComments(rosterSrc);
  ok(!/\b(rng|hash32|unitDraw)\s*\(/.test(code), 'the roster draws no random number');
  ok(!/pheidole|megacephala|species_id|speciesId/i.test(code) && !/pheidole|megacephala|species_id|speciesId/i.test(stripComments(read('prototypes/continuous-world/worker/p0a2-colony-world.ts'))), 'no species name in the roster or the adapter code (§4)');
  // the P0-A2 core (every decision of the 30 minors) cannot reach the roster: its graph has no colony module (item 1),
  // and the adapter gives the base world nothing but time targets
  const adapter = stripComments(read('prototypes/continuous-world/worker/p0a2-colony-world.ts'));
  const baseCalls = [...new Set([...adapter.matchAll(/\b(?:this\.base|base|b\.world|x\.base)\.([A-Za-z]+)/g)].map((m) => m[1]))].sort();
  eq(baseCalls, ['advanceTo', 'advanceToExact', 'antIds', 'antView', 'frame', 'nowExact', 'seed', 'seqNo', 'snapshot', 'tSim', 'world', 'worldId'], 'the adapter only advances and READS the base world (no call passes roster data into it)');
  ok([...adapter.matchAll(/this\.base\.(advanceTo|advanceToExact)\(([^)]*)\)/g)].every((m) => /^(t|end), maxEvents$/.test(m[2])), 'the only inputs to the base world are the time target and the work budget');
  ok(!/colony\.(sugar|protein)|colony_total|total_food|deficit_days/.test(adapter + code), 'no colony-total identifier in the roster or the adapter');
}

// ---------------------------------------------------------------- 10. assumption switches and labels
{
  const raw = JSON.parse(read('prototypes/continuous-world/worker/p0a2-colony-params.json')), refs = read('docs/references.md');
  ok(raw.roster.schema === ROSTER_PARAMS_SCHEMA && /預設關閉/.test(raw.status) && /非正式/.test(raw.label_zh), 'parameter file: schema, default-off status, non-official label');
  const mb = raw.roster.major_behaviour;
  ok(mb.value === 'in_nest_only' && mb.assumption === true && mb.basis === '遊戲假設' && JSON.stringify(mb.allowed) === '["in_nest_only","as_minor"]' && JSON.stringify(mb.implemented) === '["in_nest_only"]' && /尚未模擬/.test(mb.note_zh), 'major_behaviour: explicit labelled assumption switch, default in_nest_only (the conservative value)');
  throws(() => rosterParams({ ...raw.roster, major_behaviour: { value: 'as_minor' } }), /declared but NOT implemented/, 'major_behaviour as_minor is refused (majors do not silently follow the minor rules)');
  throws(() => rosterParams({ ...raw.roster, major_behaviour: { value: 'forage' } }), /must be one of/, 'an unknown major_behaviour is refused');
  const noMajor = rosterParams({ ...raw.roster, members: { ...raw.roster.members, worker_castes: { minor: { enabled: true }, major: { enabled: false } } } });
  throws(() => buildRoster(7, noMajor, { queens: 2, majors: 1, eggs: 0, pupae: 0 }, 0), /not enabled/, 'a major needs the major caste enabled in the parameter object (monomorphic parameters refuse it)');
  ok(Object.keys(buildRoster(7, noMajor, { queens: 2, majors: 0, eggs: 2, pupae: 0 }, 0).state.members.workers).length === 0, 'with the major caste disabled the same code builds a roster without majors (parameter switch, no species name)');
  ok(memberParams(raw.roster.members).worker_castes.major.enabled, 'this candidate\'s parameters enable the major caste');
  for (const [k, p] of Object.entries(raw.parameters as Record<string, J>)) {
    ok(p.assumption === true && ['文獻支持', '一般生理學', '遊戲假設'].includes(p.basis as string) && typeof p.note_zh === 'string' && (p.note_zh as string).length > 20, `parameter ${k}: assumption:true with one of the three bases and a note`);
    for (const r of p.sources as string[]) ok(new RegExp(`\\| ${r}\\b`).test(refs), `parameter ${k}: source ${r} exists in docs/references.md`);
  }
  ok(raw.parameters.initial_reserve.value === null && raw.parameters.carried_brood_progress.value === null, 'unknown quantities stay null (initial reserve, applied brood progress)');
  ok(raw.parameters.major_fraction.isolated === true && raw.parameters.major_fraction.basis === '遊戲假設', 'the major fraction is the isolated candidate and a game assumption (not a measured initial ratio)');
  // the candidate's 尚未模擬 list: the base list with reworded rows, NO status change
  const base = p0a2SaveMetaOf('exp-x', 7).not_simulated, mine = colonyNotSimulatedOf(base);
  eq(mine.items.map((x) => [x.row, x.status]), base.items.map((x) => [x.row, x.status]), 'the candidate\'s 尚未模擬 list has the same rows and statuses as the default world\'s (no status is upgraded)');
  eq(mine.items.filter((x, i) => x.label_zh !== base.items[i].label_zh).map((x) => x.row), ['M09', 'M15', 'M16', 'M18'], 'only the rows this candidate touches are reworded');
  for (const row of ['M09', 'M15', 'M16', 'M18']) { const it = mine.items.find((x) => x.row === row)!; ok(it.status === '未接入' && /尚未模擬/.test(it.label_zh), `${row}: still 未接入 and says 尚未模擬`); }
}

// ---------------------------------------------------------------- 11. Worker runtime round trip, frame shape and labels
{
  let wall = 0; const rt = new Runtime(() => wall), events: P0a2Event[] = [];
  const take = (rs: Reply[]) => { for (const r of rs) if (r.type === 'events') events.push(...(r.events as unknown as P0a2Event[])); return rs; };
  const init = take(rt.handle({ type: 'init', req: 1, world_id: 'exp-colony', seed: 7, kind: 'p0a2-colony' })).at(-1) as Extract<Reply, { type: 'ack' }>;
  ok(init.type === 'ack' && init.official === false && init.label === LABEL_ZH && isP0a2ColonyFrame(init.frame), 'init kind p0a2-colony → ack with a colony frame, labelled non-official');
  take(rt.handle({ type: 'set_speed', req: 2, speed: 3600 })); take(rt.handle({ type: 'start', req: 3 }));
  for (let i = 0; i < 40; i++) { wall += 137; take(rt.tick()); }
  take(rt.handle({ type: 'pause', req: 4 }));
  const snap = (rt.handle({ type: 'snapshot', req: 5 })[0] as { snapshot: P0a2ColonySnapshot }).snapshot;
  const direct = run(7, snap.t_sim);
  ok(JSON.stringify(events) === JSON.stringify(direct.events) && JSON.stringify(snap) === JSON.stringify(direct.world.snapshot()), `paced Worker run == direct run at the same world time (${events.length} events, t = ${snap.t_sim} s)`);
  const rt2 = new Runtime(() => 0), ack = rt2.handle({ type: 'restore', req: 1, snapshot: structuredClone(snap) })[0] as Extract<Reply, { type: 'ack' }>;
  ok(ack.type === 'ack' && isP0a2ColonyFrame(ack.frame) && JSON.stringify(ack.frame) === JSON.stringify((rt.handle({ type: 'follow', req: 6, id: null })[0] as { frame: unknown }).frame), 'restore in a new Worker runtime → the same frame (kind routed by the engine family)');
  ok(JSON.stringify((rt2.handle({ type: 'snapshot', req: 2 })[0] as { snapshot: unknown }).snapshot) === JSON.stringify(snap), 'restore → snapshot byte-identical through the runtime');
  const bad = structuredClone(snap); bad.payload.colony.major_behaviour = 'as_minor'; bad.payload_sha256 = hashJson(bad.payload);
  const refusedReply = rt2.handle({ type: 'restore', req: 3, snapshot: bad })[0] as Extract<Reply, { type: 'error' }>;
  ok(refusedReply.type === 'error' && refusedReply.code === 'BAD_COLONY' && JSON.stringify((rt2.handle({ type: 'snapshot', req: 4 })[0] as { snapshot: unknown }).snapshot) === JSON.stringify(snap), 'a refused restore changes nothing');
  ok((rt.handle({ type: 'init', req: 9, world_id: 'exp-x', seed: 1, kind: 'p0a2-colony-v2' })[0] as { code: string }).code === 'BAD_WORLD_KIND', 'an unknown kind is refused');
  // follow: a queen, a major, an egg, a base worker
  for (const id of ['q01', 'm01', 'e01', 'p01']) { const f = (rt2.handle({ type: 'follow', req: 10, id })[0] as { followed: J }).followed; ok(f && f.id === id && f.kind === 'p0a2_colony_member' && Array.isArray(f.not_simulated) && f.state === 'in_nest', `follow ${id}: roster record with its 尚未模擬 keys`); }
  const fw = (rt2.handle({ type: 'follow', req: 11, id: 'w001' })[0] as { followed: J }).followed;
  ok(fw && fw.kind === 'p0a2_worker' && fw.caste === 'minor' && fw.caste_source === 'p0a2_prototype', 'follow w001: the base worker record, marked caste minor');
  ok((rt2.handle({ type: 'follow', req: 12, id: 'q99' })[0] as { code: string }).code === 'UNKNOWN_INDIVIDUAL', 'follow of an id that does not exist is refused');

  // frame shape (the viewer contract)
  const f = ack.frame as AnyFrameMsg & { colony: P0a2ColonyMsg }; assert.ok(isP0a2ColonyFrame(f));
  const col = f.colony, comp = colonyCompositionOf(7, 30, 8).applied;
  eq(Object.keys(col), ['world_kind', 'save_world_kind', 'candidate', 'status_zh', 'scenario', 'assumptions', 'counts', 'queens', 'majors', 'eggs', 'pupae', 'not_simulated_fields'], 'colony frame fields');
  ok(col.world_kind === P0A2_COLONY_WORLD_KIND && col.save_world_kind === P0A2_COLONY_SAVE_WORLD_KIND && col.candidate === true && col.status_zh === P0A2_COLONY_STATUS_ZH && f.status_zh === P0A2_COLONY_STATUS_ZH && /候選／實驗世界，非正式/.test(col.status_zh) && /尚未模擬/.test(col.status_zh) && /預設關閉/.test(col.status_zh), 'colony frame: kind, candidate flag and a status line that says candidate / non-official / default off / 尚未模擬');
  ok(f.official === false && f.label === LABEL_ZH && f.engine_version === P0A2_COLONY_ENGINE_VERSION && f.rules_fingerprint === P0A2_COLONY_RULES_FINGERPRINT, 'frame: non-official label, this kind\'s version and fingerprint');
  eq(col.counts, { queens: comp.queens, minor_workers: 30, major_workers: comp.major_workers, eggs: comp.eggs, larvae: 8, pupae: comp.pupae }, 'colony counts (player-view statistics) match the composition');
  eq([col.queens.length, col.majors.length, col.eggs.length, col.pupae.length, f.workers.length, f.larvae.length], [comp.queens, comp.major_workers, comp.eggs, comp.pupae, 30, 8], 'every counted individual is listed as an individual');
  ok(col.assumptions.major_behaviour === 'in_nest_only' && col.assumptions.major_fraction_isolated === true && col.assumptions.all_counts_are_assumptions === true && typeof col.assumptions.major_fraction === 'number', 'colony assumptions are stated in the frame');
  ok(col.scenario.id === 'BUD-CAND-2' && col.scenario.checksum === SC.checksum && col.scenario.brood_level === 'mid', 'colony frame names the scenario, its checksum and the brood level');
  const FIELDS = ['id', 'kind', 'caste', 'caste_source', 'stage', 'state', 'loc', 'since_s', 'until_s', 'alive', 'origin', 'mother_queen_id', 'caste_fate', 'stage_progress', 'crop_fill', 'initial_reserve', 'eggs_laid', 'last_oviposition_s', 'ledger', 'not_simulated'];
  const all: ColonyIndividualMsg[] = [...col.queens, ...col.majors, ...col.eggs, ...col.pupae];
  for (const x of all) {
    eq(Object.keys(x), FIELDS, `${x.id}: individual fields`);
    ok(x.state === 'in_nest' && x.loc === 'nest' && x.since_s === 0 && x.until_s === null && x.alive === true && x.origin === 'initial_scenario', `${x.id}: engine state in_nest since 0, no scheduled end`);
    ok(x.not_simulated.length >= 6 && x.not_simulated.every((k) => typeof col.not_simulated_fields[k] === 'string' && /尚未模擬|未知|未套用|未決定/.test(col.not_simulated_fields[k])), `${x.id}: every not_simulated key has a label`);
    ok(x.crop_fill === null && x.initial_reserve === null && x.stage_progress === null && x.mother_queen_id === null, `${x.id}: unknown quantities are null`);
  }
  ok(new Set([...all.map((x) => x.id), ...f.workers.map((w) => w.id), ...f.larvae.map((l) => l.id)]).size === all.length + 38, 'ids are unique across the roster and the base world');
  ok(col.queens.every((q) => q.kind === 'queen' && q.caste === null && q.stage === null && q.eggs_laid === 0 && q.ledger !== null && Object.values(q.ledger.have).every((v) => v === 0) && ['oviposition', 'feeding', 'metabolism', 'death'].every((k) => q.not_simulated.includes(k))), 'queens: own ledger slot, no eggs laid, oviposition / feeding / metabolism / death flagged 尚未模擬');
  ok(col.majors.every((m) => m.kind === 'worker' && m.caste === 'major' && m.caste_source === 'initial_scenario' && m.eggs_laid === null && m.ledger !== null && m.not_simulated.includes('behaviour')), 'majors: caste major from the initial scenario, behaviour flagged 尚未模擬');
  ok(col.eggs.every((e) => e.kind === 'brood' && e.stage === 'egg' && e.caste_fate === 'undetermined' && e.ledger === null && e.not_simulated.includes('development')) && col.pupae.every((p) => p.kind === 'brood' && p.stage === 'pupa' && p.not_simulated.includes('development')), 'eggs / pupae: inert items with stage and provenance, development flagged 尚未模擬');
  ok(f.workers.every((w) => w.caste === 'minor'), 'every base worker carries caste minor in the candidate frame');
  eq(Object.keys(col.not_simulated_fields), Object.keys(INDIVIDUAL_NOT_SIMULATED), 'the frame carries the roster\'s label table');
}

// ---------------------------------------------------------------- 12. save / verify (Node recomputation with the same core)
{
  const text = JSON.stringify(snapMid), rep = verifySaveText(text);
  ok(rep.status === 'node_verified' && rep.save.world_kind === P0A2_COLONY_SAVE_WORLD_KIND && rep.recomputed!.chain_head === snapMid.payload.chain.head && rep.recomputed!.payload_sha256 === snapMid.payload_sha256 && rep.recomputed!.differing_fields.length === 0, `the Node verifier recomputes a candidate save from (world id, seed): node_verified (${rep.recomputed!.events} events)`);
  ok(rep.verifier.world_kinds.some((k) => k.id === P0A2_COLONY_SAVE_WORLD_KIND && k.rules_fingerprint === P0A2_COLONY_RULES_FINGERPRINT) && REGISTRY[P0A2_COLONY_SAVE_WORLD_KIND].params_sha256 === P0A2_COLONY_PARAMS_SHA, 'the verifier registry has the candidate kind with the runtime\'s rules and parameters');
  ok(rep.save.not_simulated !== null && rep.save.not_simulated.items.some((i) => i.row === 'M15' && /蟻后是引擎個體/.test(i.label_zh)), 'the report shows the candidate\'s 尚未模擬 list');
  ok(verifySaveText(text, { recompute: false }).status === 'integrity_ok', '--no-recompute is never reported as verified');
  const m = snapMid.payload.save_meta;
  ok(m.world_kind === P0A2_COLONY_SAVE_WORLD_KIND && m.initial.seed === 7 && m.initial.t_sim === 0 && m.initial.params_sha256 === P0A2_COLONY_PARAMS_SHA && m.colony.scenario.checksum === SC.checksum && m.colony.scenario.id === 'BUD-CAND-2' && m.colony.prng.id === SC.prng.id && m.colony.prng.seed === 7 && m.colony.candidate === true && m.colony.default_off === true && m.colony.scenario.activated === false, 'save_meta: world kind, trusted initial conditions, scenario id + checksum, PRNG + seed, candidate / default-off / not-activated flags');
  eq(m.colony.composition, colonyCompositionOf(7, 30, 8), 'save_meta records the seed\'s draws, the applied counts and the not-applied values');
  ok(Object.values(m.colony.assumptions as Record<string, J>).every((p) => p.assumption === true), 'save_meta carries the labelled assumptions');
  // the save list summary of the viewer's save module: the individuals this snapshot holds, and its 尚未模擬 list
  const sum = summaryOf(snapMid), comp = colonyCompositionOf(7, 30, 8).applied, ns = notSimulatedOf(snapMid);
  ok(sum.queens === comp.queens && sum.workers === 30 + comp.major_workers && sum.larvae === 8 && sum.individuals === comp.queens + 30 + comp.major_workers + 8 + comp.eggs + comp.pupae && /候選/.test(sum.note!) && /尚未模擬/.test(sum.note!) && /預設關閉/.test(sum.note!), `save summary counts the queens, workers, larvae and brood items of a candidate save (${sum.note})`);
  ok(ns.ok && ns.unwired.some((i) => i.row === 'M15') && sum.not_simulated !== null, 'the viewer reads the candidate\'s 尚未模擬 list from the save metadata');
  const sd = summaryOf(runBase(7, HOUR).world.snapshot());
  ok(sd.queens === null && sd.workers === 30 && sd.larvae === 8 && /沒有蟻后/.test(sd.note!), 'the default world\'s save summary is unchanged (no queen: null)');
  // altered saves: all hashes recomputed — never verified
  const forge = (why: string, f: (s: P0a2ColonySnapshot) => void, want: string) => { const s = structuredClone(snapMid); f(s); s.payload_sha256 = hashJson(s.payload); const r = verifySaveText(JSON.stringify(s)); ok(r.status !== 'node_verified' && r.status !== 'integrity_ok' && r.diagnostics.some((d) => d.code === want), `forged save (${why}) is not verified (${r.status}: ${r.diagnostics.map((d) => d.code).join()})`); };
  forge('an extra queen with consistent records', (s) => { const q = (s.payload.colony.members as J).queens as Record<string, J>, pl = s.payload.colony.placement as Record<string, J>; q.q09 = { ...q.q01, id: 'q09' }; pl.q09 = { ...pl.q01 }; }, 'RESTORE_REFUSED');
  forge('a queen that laid an egg', (s) => { ((s.payload.colony.members as J).queens as Record<string, J>).q01.eggs_laid = 1; }, 'RESTORE_REFUSED');
  forge('an invented event in the chain', (s) => { s.payload.chain.head = 'a'.repeat(64); }, 'CHAIN_MISMATCH');
  forge('another world kind name', (s) => { (s.payload.save_meta as unknown as J).world_kind = P0A2_SAVE_WORLD_KIND; }, 'UNSUPPORTED_ENGINE');
  forge('another scenario checksum', (s) => { s.payload.save_meta.colony.scenario.checksum = `sha256:${'0'.repeat(64)}`; }, 'RESTORE_REFUSED');
  forge('other initial parameters', (s) => { s.payload.save_meta.initial.params_sha256 = '0'.repeat(64); }, 'UNSUPPORTED_PARAMS');
  // a default-world save still verifies under its own kind, with its own (unchanged) rules
  const d = verifySaveText(JSON.stringify(runBase(7, 5 * HOUR).world.snapshot()));
  ok(d.status === 'node_verified' && d.save.world_kind === P0A2_SAVE_WORLD_KIND && d.save.rules_fingerprint === P0A2_RULES_FINGERPRINT, 'a default P0-A2 save still verifies under p0a2-24h-v1');
}

// ---------------------------------------------------------------- 13. Worker boundary
{
  const B: Boundary & Record<string, unknown> = JSON.parse(read('prototypes/continuous-world/worker-boundary.json'));
  const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|js|mjs|json)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
  const files = new Map<string, string>();
  for (const d of ['engine', B.worker_entry_dir, 'prototypes/p0a2-24h']) for (const f of walk(path.join(REPO_ROOT, d))) files.set(path.relative(REPO_ROOT, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8'));
  const r = checkBoundary(files, B);
  ok(r.violations.length === 0, `the Worker graph with the candidate respects the boundary (${JSON.stringify(r.violations.slice(0, 3))})`);
  for (const f of ['engine/colony/roster.ts', 'engine/colony/members.ts', 'engine/day0/founding-sampler.ts', 'prototypes/continuous-world/worker/p0a2-colony-params.json']) ok(r.reached.includes(f), `the Worker graph reaches ${f}`);
  ok(B.allowed_import_prefixes.includes('engine/colony/') && B.allowed_import_prefixes.includes('engine/day0/founding-sampler.ts') && !B.allowed_import_prefixes.some((p) => p === 'engine/day0/' || p === 'scenarios/' || p.startsWith('scenarios/')), 'allowlist: engine/colony/ and the single sampler file — not engine/day0/ as a whole, not scenarios/');
  ok(!r.reached.some((f) => f.startsWith('scenarios/') || f.startsWith('prototypes/colony-members/') || f.startsWith('prototypes/p0a2-24h/brood/')), 'the Worker graph reaches no scenario file, no CQ-1 research parameter file and no BP-1 module');
  const neg = (why: string, mutate: (m: Map<string, string>) => void, rule: string) => { const m = new Map(files); mutate(m); const v = checkBoundary(m, B).violations; ok(v.some((x) => x.rule === rule), `negative sample "${why}" is caught as ${rule} (got ${JSON.stringify(v.map((x) => x.rule).slice(0, 4))})`); };
  const ROSTER = 'engine/colony/roster.ts', ADAPTER = `${B.worker_entry_dir}/p0a2-colony-world.ts`;
  neg('roster uses Math.random', (m) => m.set(ROSTER, `${m.get(ROSTER)}\nexport const bad = () => Math.random();`), 'engine-impurity');
  neg('roster reads the wall clock', (m) => m.set(ROSTER, `${m.get(ROSTER)}\nexport const bad = () => Date.now();`), 'engine-impurity');
  neg('roster uses Math.exp', (m) => m.set(ROSTER, `${m.get(ROSTER)}\nexport const bad = (x: number) => Math.exp(x);`), 'approximated-math');
  neg('roster imports the official day loop', (m) => { m.set('engine/day.ts', 'export const d = 1;'); m.set(ROSTER, `import { d } from '../day.ts';\n${m.get(ROSTER)}`); }, 'denied-module');
  neg('roster imports a non-allowlisted engine module', (m) => { m.set('engine/queen.ts', 'export const q = 1;'); m.set(ROSTER, `import { q } from '../queen.ts';\n${m.get(ROSTER)}`); }, 'not-allowlisted');
  neg('adapter imports the scenario file itself', (m) => { m.set('scenarios/day0-budding-candidate.json', '{}'); m.set(ADAPTER, `import s from '../../../scenarios/day0-budding-candidate.json' with { type: 'json' };\n${m.get(ADAPTER)}`); }, 'not-allowlisted');
  neg('adapter imports the BP-1 brood module', (m) => m.set(ADAPTER, `import { x } from '../../p0a2-24h/brood/bp1.ts';\n${m.get(ADAPTER)}`), 'not-allowlisted');
  neg('adapter imports another engine/day0 module', (m) => { m.set('engine/day0/other.ts', 'export const o = 1;'); m.set(ADAPTER, `import { o } from '../../../engine/day0/other.ts';\n${m.get(ADAPTER)}`); }, 'not-allowlisted');
  neg('adapter uses fetch', (m) => m.set(ADAPTER, `${m.get(ADAPTER)}\nfetch('/x');`), 'forbidden-global');
  neg('adapter names an official save path', (m) => m.set(ADAPTER, `${m.get(ADAPTER)}\nconst p = 'saves/main.json';`), 'official-path-string');
  neg('sampler uses Math.log', (m) => m.set('engine/day0/founding-sampler.ts', `${m.get('engine/day0/founding-sampler.ts')}\nexport const bad = (x: number) => Math.log(x);`), 'approximated-math');
  checks += r.checks;
}

console.log(JSON.stringify({ test: 'p0a2-colony-world', checks, rules_fingerprint: P0A2_COLONY_RULES_FINGERPRINT, code_sha256: P0A2_COLONY_CODE_SHA256, scenario_checksum: SC.checksum, default_rules_fingerprint: P0A2_RULES_FINGERPRINT, payload_sha256_5h_seed7: snapMid.payload_sha256, chain_head_5h_seed7: snapMid.payload.chain.head }));

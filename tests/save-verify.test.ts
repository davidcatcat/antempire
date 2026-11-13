/**
 * Owner ruling #200 (option C): event-chain commitment in the experiment Worker core and the Node verifier
 * (cli/verify-save.ts). Blocking. docs/save-format-v2.md.
 *  1. chain definition = node:crypto over the documented text form; vectors file reproduces.
 *  2. behaviour unchanged: events and state (without the version fields and the new payload fields) equal the pinned
 *     digests of the payload-schema-1 core (origin/main 198d359), seed 7, 48 h.
 *  3. the core's chain equals an independent recomputation over the emitted events; restore checks it; schema 1
 *     snapshots, forks and foreign metadata are refused with a reason and the input is not changed.
 *  4. chunking, work budgets, same-instant batches and save -> restore -> continue give the continuous chain.
 *  5. verifier: honest saves -> node_verified (export file, bare snapshot, t = 0, budget-stopped instant, after a
 *     restart); --no-recompute -> integrity_ok; tampered payload / event / seed / fingerprint / chain / world kind /
 *     container -> mismatch or invalid; self-consistent forged hashes and a self-declared status are never accepted;
 *     the CLI never modifies its input.
 *  6. the P0-A2 24 h world (world kind p0a2-24h-v1): behaviour pinned to the pre-chain adapter (PR #209 branch
 *     a9c5d4e, seed 7, 48 h), chain = node:crypto recomputation, save_meta, restore checks, schema-1 refusal, chunking /
 *     budgets / save -> restore -> continue, and the verifier (honest -> node_verified, tampered -> mismatch / invalid),
 *     including an export built by the viewer's own buildExport and the CLI.
 *  6b. an older P0-A2 rules version (Owner #214 Q4): a genuine /1 export (tests/fixtures/p0a2-rules-v1/) stays identifiable
 *     as /1 and is never replayed or re-hashed under /2 (verifier UNSUPPORTED_ENGINE, Worker ENGINE_MISMATCH, viewer
 *     rules_mismatch); the file is not changed.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { ExperimentWorld, ExperimentRefused, SCHEMA_VERSION, WORLD_KIND, type ExperimentEvent, type ExperimentSnapshot } from '../prototypes/continuous-world/worker/core.ts';
import { CHAIN_ALGO, chainAppend, chainStart } from '../prototypes/continuous-world/worker/chain.ts';
import { WORLD_KINDS } from '../prototypes/continuous-world/worker/world-kinds.ts';
import { canonicalJson, hashJson } from '../prototypes/continuous-world/worker/sha256.ts';
import { verifySaveText, type Report } from '../cli/verify-save.ts';
import { P0a2ExperimentWorld, P0a2Refused, P0A2_ENGINE_HISTORY, P0A2_ENGINE_VERSION, P0A2_PARAMS_SHA, P0A2_RULES_FINGERPRINT, P0A2_SAVE_WORLD_KIND, P0A2_SCENARIO, P0A2_SCHEMA_VERSION, type P0a2Event, type P0a2Snapshot } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import { canon as p0canon } from '../prototypes/p0a2-24h/canon.ts';
import { buildExport, compatibility, defaultMigrations, notSimulatedOf, parseImport, summaryOf, type SnapshotEnvelope } from '../web/src/experimental/save-format.ts';
import { P0A2_NOT_SIMULATED } from '../prototypes/continuous-world/worker/not-simulated.ts';
import { Runtime } from '../prototypes/continuous-world/worker/runtime.ts';
import { P0A2_CODE_FILES, P0A2_CODE_SHA256 } from '../prototypes/continuous-world/worker/p0a2-code-hash.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const H = 3600, DAY = 86400;
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const refusedWith = (f: () => unknown, code: string, re?: RegExp) => { try { f(); return false; } catch (e) { return e instanceof ExperimentRefused && e.code === code && (!re || re.test(e.message)); } };
const run = (seed: number, t: number, id = 'exp-test') => { const c = ExperimentWorld.create(id, seed); const r = c.world.advanceTo(t); return { world: c.world, events: [...c.events, ...r.events] }; };
/** independent recomputation of the chain with node:crypto over the documented text form */
const nodeChain = (ctx: { world_kind: string; world_id: string; seed: number; rules_fingerprint: string }, events: unknown[]) => {
  const g = sha(`antempire.event-chain.v1\n${canonicalJson({ world_kind: ctx.world_kind, world_id: ctx.world_id, seed: ctx.seed, rules_fingerprint: ctx.rules_fingerprint })}`);
  let h = g; for (const e of events) h = sha(`${h}\n${canonicalJson(e)}`);
  return { genesis: g, head: h, count: events.length };
};
/** an export file exactly as the viewer builds it (web/src/experimental/save-format.ts buildExport) */
const exportOf = (s: ExperimentSnapshot, name = '測試世界') => {
  const body = { schema: 'antempire.experiment-world-export.v1', label: s.label, official: false, exported_at: '2026-11-12T00:00:00.000Z', world: { world_id: s.world_id, name, seed: s.seed, created_at: '2026-11-12T00:00:00.000Z', summary: { queens: null, workers: null, individuals: 6, note: '合成世界：沒有蟻后，個體不分階級' } }, snapshot: s };
  return { ...body, export_sha256: hashJson(body) };
};
const reseal = (f: ReturnType<typeof exportOf>) => { f.snapshot.payload_sha256 = hashJson(f.snapshot.payload); const { export_sha256: _x, ...body } = f; f.export_sha256 = hashJson(body); return f; };
const verify = (x: unknown, recompute = true): Report => verifySaveText(typeof x === 'string' ? x : JSON.stringify(x), { recompute });
const codes = (r: Report) => r.diagnostics.map((d) => d.code);

// ---------------------------------------------------------------- 1. chain definition
const V = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/continuous-world/save/event-chain-vectors.v1.json'), 'utf8'));
{
  const n = nodeChain(V.context, []);
  ok(V.algo === CHAIN_ALGO && n.genesis === V.genesis && chainStart(V.context).genesis === V.genesis, 'chain vectors: genesis = node:crypto over the documented text');
  let h = V.genesis as string; V.events.forEach((e: unknown, i: number) => { h = sha(`${h}\n${canonicalJson(e)}`); ok(h === V.heads[i], `chain vectors: head ${i + 1} = node:crypto`); });
  const w = ExperimentWorld.create('exp-vector', 1);
  ok(canonicalJson(w.events.slice(0, 3)) === canonicalJson(V.events), 'chain vectors: events are the first three events of create("exp-vector", 1)');
}

// ---------------------------------------------------------------- 2. behaviour unchanged (pinned from the schema-1 core)
const A = run(7, 48 * H);
{
  const strip = (e: Record<string, unknown>) => { const { schema_version: _a, rules_fingerprint: _b, ...r } = e; return r; };
  const p = strip(A.world.payload() as unknown as Record<string, unknown>); delete p.save_meta; delete p.chain;
  ok(A.events.length === 6084 && hashJson(A.events.map((e) => strip(e as unknown as Record<string, unknown>))) === 'd7b0cc58ec545e0e952f005570fc9bf30dec5b724abd3be640c4605d2233655b', 'events (without schema_version / rules_fingerprint) are byte-identical to the schema-1 core');
  ok(hashJson(p) === '3444f2f7ce48f5073ceefc1d859eea5b2dba4dd6a174e925c7fe8dd4916e1afd', 'state (without version fields, save_meta and chain) is byte-identical to the schema-1 core');
  ok(SCHEMA_VERSION === 2 && A.events.every((e) => e.schema_version === 2), 'payload schema is 2 and every event says so');
}

// ---------------------------------------------------------------- 3. the chain in the core; restore checks
const snapA = A.world.snapshot();
const ctxA = { world_kind: WORLD_KIND, world_id: 'exp-test', seed: 7, rules_fingerprint: snapA.rules_fingerprint };
{
  const n = nodeChain(ctxA, A.events), c = A.world.chainState();
  ok(c.algo === CHAIN_ALGO && c.genesis === n.genesis && c.head === n.head && c.count === n.count && c.count === A.world.seqNo(), `chain head/count = independent node:crypto recomputation over the ${n.count} emitted events`);
  ok(canonicalJson(chainAppend(chainStart(ctxA), A.events)) === canonicalJson(c), 'chainAppend over the emitted events = the live chain');
  ok(canonicalJson(snapA.payload.chain) === canonicalJson(c), 'the snapshot carries the chain head and count');
  const m = snapA.payload.save_meta;
  ok(m.world_kind === WORLD_KIND && m.initial.world_id === 'exp-test' && m.initial.seed === 7 && m.initial.t_sim === 0 && m.initial.params_sha256 === hashJson(snapA.payload.params) && m.species.id === null && m.species.fingerprint === null && m.environment.synthetic === true && m.environment.fingerprint.length === 64 && m.lineage.length === 0, 'save_meta: world kind, trusted initial conditions, species (none) and environment fingerprints, empty lineage');
}
const s24 = (() => { const c = ExperimentWorld.create('exp-test', 7); c.world.advanceTo(24 * H); return c.world.snapshot(); })();
const tamper = (f: (s: ExperimentSnapshot) => void) => { const s = clone(s24); f(s); s.payload_sha256 = hashJson(s.payload); return s; };
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.chain.count += 1; })), 'CHAIN_MISMATCH'), 'restore refuses: chain count != seq');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.chain.genesis = '0'.repeat(64); })), 'CHAIN_MISMATCH'), 'restore refuses: foreign genesis');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.chain.head = 'X'; })), 'CHAIN_MISMATCH'), 'restore refuses: malformed head');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { delete (s.payload as Partial<typeof s.payload>).chain; })), 'BAD_STATE'), 'restore refuses: chain missing');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.save_meta.initial.seed = 8; })), 'META_MISMATCH'), 'restore refuses: initial conditions that do not match the world');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.save_meta.environment.fingerprint = 'f'.repeat(64); })), 'META_MISMATCH'), 'restore refuses: foreign environment fingerprint');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { (s.payload.save_meta.lineage as unknown[]).push({ parent_rules_fingerprint: 'x' }); })), 'FORK_UNSUPPORTED'), 'restore refuses: a fork record (no fork implemented)');
// a forged head that is well formed is NOT detectable by restore (only by recomputation, section 5)
ok(ExperimentWorld.restore(tamper((s) => { s.payload.chain.head = 'a'.repeat(64); })).chainState().head === 'a'.repeat(64), 'restore cannot detect a well-formed forged head (documented: only Node recomputation can)');
const v1 = (() => { const s = clone(s24) as unknown as Record<string, any>; delete s.payload.save_meta; delete s.payload.chain; s.schema_version = s.payload.schema_version = 1; s.payload_sha256 = hashJson(s.payload); return s as unknown as ExperimentSnapshot; })();
const v1Text = canonicalJson(v1);
ok(refusedWith(() => ExperimentWorld.restore(v1), 'SCHEMA_MISMATCH', /no event-chain commitment/), 'a payload-schema-1 snapshot is refused with a clear reason');
ok(canonicalJson(v1) === v1Text, 'and the schema-1 snapshot is not changed');

// ---------------------------------------------------------------- 4. chunking, budget, same instant, restart recovery
{
  const c = ExperimentWorld.create('exp-test', 7); let t = 0, k = 1;
  while (t < 48 * H) { t = Math.min(48 * H, t + ((k * 7919) % 5000) + 0.25); k++; c.world.advanceTo(t, 1 + (k % 4)); }
  while (!c.world.advanceTo(48 * H, 2).done) { /* tiny budget: stops between instants only */ }
  ok(canonicalJson(c.world.chainState()) === canonicalJson(A.world.chainState()), `${k - 1} irregular chunks with work budgets -> the continuous chain`);
  const midnight = A.events.filter((e) => e.exact.day === 1 && e.exact.us === 0 && e.exact.us_lo === 0);
  ok(midnight.length === 2 && midnight[0].event_id < midnight[1].event_id && midnight[1].seq === midnight[0].seq + 1, 'same-instant batch (day 1 00:00) is committed in canonical event-id order');
  for (const tc of [DAY, DAY - 0.5, A.events[2000].t_sim]) {
    const w = ExperimentWorld.create('exp-test', 7).world; w.advanceTo(tc);
    const s = JSON.parse(JSON.stringify(w.snapshot()));
    const w2 = ExperimentWorld.restore(s); w2.advanceTo(48 * H);
    ok(canonicalJson(w2.chainState()) === canonicalJson(A.world.chainState()) && w2.snapshot().payload_sha256 === snapA.payload_sha256, `save at ${tc} s -> restore (JSON round trip) -> continue to 48 h: chain and state = continuous`);
  }
  // restart twice (24 h -> 36 h -> 48 h), each through the JSON text a store would keep
  let w = ExperimentWorld.create('exp-test', 7).world; w.advanceTo(24 * H);
  w = ExperimentWorld.restore(JSON.parse(JSON.stringify(w.snapshot()))); w.advanceTo(36 * H);
  w = ExperimentWorld.restore(JSON.parse(JSON.stringify(w.snapshot()))); w.advanceTo(48 * H);
  ok(canonicalJson(w.chainState()) === canonicalJson(A.world.chainState()), 'two restarts (24 h, 36 h) -> the continuous chain at 48 h');
}

// ---------------------------------------------------------------- 5. the Node verifier
ok(WORLD_KINDS[WORLD_KIND] && WORLD_KINDS[WORLD_KIND].rules_fingerprint === snapA.rules_fingerprint, 'world-kind registry has the synthetic world with the runtime\'s rules');
const honest = exportOf(snapA);
{
  const r = verify(honest);
  ok(r.status === 'node_verified' && r.recomputed && r.recomputed.chain_head === snapA.payload.chain.head && r.recomputed.payload_sha256 === snapA.payload_sha256 && r.recomputed.differing_fields.length === 0, `honest 48 h export -> node_verified (${codes(r)})`);
  ok(r.official === false && r.schema === 'antempire.save-verify-report.v1' && /未簽章/.test(r.note) && r.verifier.arch === process.arch, 'report is labelled, unsigned and names the platform it ran on');
  ok(verify(snapA).status === 'node_verified', 'a bare snapshot envelope -> node_verified');
  const ni = verify(honest, false);
  ok(ni.status === 'integrity_ok' && ni.recomputed === null && codes(ni).includes('NOT_RECOMPUTED'), '--no-recompute -> integrity_ok, never node_verified');
  ok(verify(ExperimentWorld.create('exp-zero', 3).world.snapshot()).status === 'node_verified', 'a new world at t = 0 -> node_verified');
  const b = ExperimentWorld.create('exp-budget', 11).world; const st = b.advanceTo(30 * H, 5);
  ok(!st.done && verify(b.snapshot()).status === 'node_verified', `a save at a budget-stopped instant (t = ${b.tSim().toFixed(3)} s) -> node_verified`);
  const w = ExperimentWorld.create('exp-test', 7).world; w.advanceTo(10 * H + 0.125);
  const w2 = ExperimentWorld.restore(JSON.parse(JSON.stringify(w.snapshot()))); w2.advanceTo(30 * H + 0.5);
  ok(verify(exportOf(w2.snapshot())).status === 'node_verified', 'save -> restore -> continue -> save -> node_verified');
}
const mustNot = (name: string, f: (x: any) => void, want: 'mismatch' | 'invalid', code?: string) => {
  const x = clone(honest); f(x); const r = verify(x);
  ok(r.status === want && (!code || codes(r).includes(code)), `${name} -> ${want}${code ? ` (${code})` : ''} (got ${r.status}: ${codes(r)})`);
};
mustNot('payload edited, hashes NOT updated', (x) => { x.snapshot.payload.ants[0].pos.x += 1; }, 'invalid', 'EXPORT_HASH_MISMATCH');
{ const s = clone(snapA); s.payload.ants[0].pos.x += 1; ok(codes(verify(s)).includes('HASH_MISMATCH') && verify(s).status === 'invalid', 'bare snapshot edited without its hash -> invalid (HASH_MISMATCH)'); }
mustNot('payload edited, every hash recomputed (forged)', (x) => { x.snapshot.payload.ants[0].pos.x += 1; reseal(x); }, 'mismatch', 'STATE_MISMATCH');
mustNot('ledger edited consistently, hashes recomputed', (x) => { x.snapshot.payload.ledgers.ants.w01.walked_cm += 1; reseal(x); }, 'mismatch', 'STATE_MISMATCH');
mustNot('chain head forged, hashes recomputed', (x) => { x.snapshot.payload.chain.head = 'b'.repeat(64); reseal(x); }, 'mismatch', 'CHAIN_MISMATCH');
{
  const forgedEvents = clone(A.events) as ExperimentEvent[]; forgedEvents[1234] = { ...forgedEvents[1234], data: { ...forgedEvents[1234].data, in_nest: !forgedEvents[1234].data.in_nest } };
  mustNot('one committed event altered (head over the altered events), hashes recomputed', (x) => { x.snapshot.payload.chain.head = nodeChain(ctxA, forgedEvents).head; reseal(x); }, 'mismatch', 'CHAIN_MISMATCH');
  mustNot('an event dropped (count and seq lowered consistently)', (x) => { const p = x.snapshot.payload; p.chain.count -= 1; p.seq -= 1; x.snapshot.seq -= 1; p.ledgers.events_by_kind.env_hour -= 1; p.chain.head = nodeChain(ctxA, A.events.slice(0, -1)).head; reseal(x); }, 'mismatch');
}
mustNot('seed changed everywhere (header, payload, initial conditions, export)', (x) => { x.snapshot.seed = x.snapshot.payload.seed = x.snapshot.payload.save_meta.initial.seed = x.world.seed = 8; x.snapshot.payload.chain.genesis = chainStart({ ...ctxA, seed: 8 }).genesis; reseal(x); }, 'mismatch');
mustNot('seed changed in the header only', (x) => { x.snapshot.seed = x.world.seed = 8; reseal(x); }, 'invalid', 'HEADER_MISMATCH');
mustNot('rules fingerprint changed (header + payload)', (x) => { x.snapshot.rules_fingerprint = x.snapshot.payload.rules_fingerprint = 'f'.repeat(64); reseal(x); }, 'invalid', 'UNSUPPORTED_RULES');
mustNot('parameters changed (fingerprint left)', (x) => { x.snapshot.payload.params.walk_speed_cm_s = 2; reseal(x); }, 'invalid', 'RESTORE_REFUSED');
mustNot('initial parameters hash changed', (x) => { x.snapshot.payload.save_meta.initial.params_sha256 = 'c'.repeat(64); reseal(x); }, 'invalid', 'UNSUPPORTED_PARAMS');
mustNot('unknown world kind', (x) => { x.snapshot.payload.save_meta.world_kind = 'p0a2-v9'; reseal(x); }, 'invalid', 'UNSUPPORTED_WORLD_KIND');
mustNot('chain count != seq', (x) => { x.snapshot.payload.chain.count += 1; reseal(x); }, 'invalid', 'RESTORE_REFUSED');
mustNot('export edited without its hash', (x) => { x.world.name = '改過'; }, 'invalid', 'EXPORT_HASH_MISMATCH');
mustNot('self-declared verification status in the export', (x) => { x.verification = { status: 'node_verified', report_sha256: 'd'.repeat(64) }; const { export_sha256: _e, ...body } = x; x.export_sha256 = hashJson(body); }, 'invalid', 'BAD_EXPORT');
mustNot('official:true', (x) => { x.snapshot.official = true; reseal(x); }, 'invalid', 'NOT_EXPERIMENT');
ok(verify(v1).status === 'invalid' && codes(verify(v1)).includes('NO_CHAIN'), 'payload-schema-1 snapshot -> invalid (NO_CHAIN), never node_verified');
ok(verify(JSON.stringify(honest).slice(0, 5000)).status === 'invalid', 'truncated file -> invalid');
ok(verify('[]').status === 'invalid' && verify('{"schema":"x"}').status === 'invalid', 'not a save -> invalid');

// the CLI: exit codes, report on stdout, input never modified
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-verify-'));
  try {
    const good = path.join(dir, 'good.json'), bad = path.join(dir, 'bad.json');
    fs.writeFileSync(good, JSON.stringify(honest)); const forged = reseal(clone(honest)); forged.snapshot.payload.ants[1].pos.y -= 1; reseal(forged); fs.writeFileSync(bad, JSON.stringify(forged));
    const before = [fs.readFileSync(good), fs.readFileSync(bad)].map((b) => crypto.createHash('sha256').update(b).digest('hex')), mtimes = [good, bad].map((f) => fs.statSync(f).mtimeMs);
    const cli = (f: string, ...a: string[]) => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO_ROOT, 'cli/verify-save.ts'), f, ...a], { encoding: 'utf8' }) }; } catch (e) { const x = e as { status: number; stdout: string }; return { code: x.status, out: x.stdout }; } };
    const g = cli(good), b = cli(bad), n = cli(good, '--no-recompute');
    ok(g.code === 0 && JSON.parse(g.out).status === 'node_verified', 'CLI: honest save -> exit 0, node_verified');
    ok(b.code === 1 && JSON.parse(b.out).status === 'mismatch', 'CLI: forged save -> exit 1, mismatch');
    ok(n.code === 3 && JSON.parse(n.out).status === 'integrity_ok', 'CLI: --no-recompute -> exit 3, integrity_ok');
    ok(JSON.stringify([fs.readFileSync(good), fs.readFileSync(bad)].map((x) => crypto.createHash('sha256').update(x).digest('hex'))) === JSON.stringify(before) && JSON.stringify([good, bad].map((f) => fs.statSync(f).mtimeMs)) === JSON.stringify(mtimes) && fs.readdirSync(dir).length === 2, 'CLI never modifies its input and writes no file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- 6. the P0-A2 24 h world (world kind p0a2-24h-v1)
const P0RAW = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/p0a2-24h/params.json'), 'utf8'));
const p0refused = (f: () => unknown, code: string, re?: RegExp) => { try { f(); return false; } catch (e) { return e instanceof P0a2Refused && e.code === code && (!re || re.test(e.message)); } };
const p0run = (seed: number, t: number, id = 'exp-test') => { const c = P0a2ExperimentWorld.create(id, seed); const r = c.world.advanceTo(t); return { world: c.world, events: [...c.events, ...r.events] }; };
const X = p0run(7, 48 * H), snapX = X.world.snapshot();
const ctxX = { world_kind: P0A2_SAVE_WORLD_KIND, world_id: 'exp-test', seed: 7, rules_fingerprint: P0A2_RULES_FINGERPRINT };
{
  // behaviour unchanged: pinned from the adapter without the chain (PR #209 branch a9c5d4e, payload schema 1).
  // Owner #214 Q4 (2026-11-13, rules version experiment-p0a2-24h/2): the idle-walk contacts of a bout_end are logged as
  // `idle_larvae` instead of being overwritten (tests/p0a2-24h-proto.test.ts §7d). The former pins are kept and checked
  // on the events projected back to the /1 form (v1) and on the state / payload without the P0-A2 log hash chain and
  // the engine version — the only things this rules update changes; the new full values are pinned alongside.
  const strip = (e: Record<string, unknown>) => { const { schema_version: _a, rules_fingerprint: _b, ...r } = e; return r; };
  const v1 = (e: Record<string, unknown>) => { const d = { ...(e.data as Record<string, unknown>) }; if ('idle_larvae' in d) { const il = d.idle_larvae; delete d.idle_larvae; if (!('larvae' in d)) d.larvae = il; } return { ...e, data: d, engine_version: 'experiment-p0a2-24h/1' }; };
  const p = strip(X.world.payload() as unknown as Record<string, unknown>); delete p.save_meta; delete p.chain; delete p.code_sha256;
  const noLog = (st: unknown) => { const c = clone(st) as { log: { hash?: string } }; delete c.log.hash; return c; };
  const pNoVer = { ...p, state: noLog(p.state) } as Record<string, unknown>; delete pNoVer.engine_version;
  ok(X.events.length === 18595 && hashJson(X.events.map((e) => strip(v1(e as unknown as Record<string, unknown>)))) === '1107894ca43944f340a894a12e14ecbfd3e07cface6898ac32c7fadee3c3db2f', 'P0-A2 events (without schema_version / rules_fingerprint), projected to the /1 log form, are byte-identical to the pre-chain adapter (seed 7, 48 h, 18 595 events)');
  // version /3 (2026-11-13, Owner #212 Q2 a, matrix M43) only adds save_meta.not_simulated: events and payload projected
  // back to the /2 engine_version are the /2 pins; the /3 full values are pinned alongside
  const v2 = (e: Record<string, unknown>) => ({ ...e, engine_version: 'experiment-p0a2-24h/2' });
  ok(hashJson(X.events.map((e) => strip(v2(e as unknown as Record<string, unknown>)))) === '3ff0b35ab790588da2dc75bf2b8c4db16ed47c1ab52386893786298e062d14aa', 'P0-A2 events (without schema_version / rules_fingerprint), projected to the /2 engine_version, are byte-identical to rules version /2');
  ok(hashJson(X.events.map((e) => strip(e as unknown as Record<string, unknown>))) === '054f051c8ff013fa73b13c312f9d016f6d3ca099cc80e5ef31788542eed4d5b3', 'P0-A2 events (without schema_version / rules_fingerprint), version /3: pinned (only engine_version differs from /2)');
  ok(hashJson(noLog(snapX.payload.state) as never) === 'f854d308b2199923a8bdc71fc82de963a52fb8814c8d56ac19acab37552cfae9', 'P0-A2 world state without the log hash chain is byte-identical to rules version /1 and the pre-chain adapter');
  ok(hashJson(snapX.payload.state as never) === '18cc59506ac97bec7217eeb7a7fabe170bfdffb03ae7df6e2bbb3b9ab7b8daf3', 'P0-A2 world state (World.snapshot), rules version /2: pinned (was 292c59fa…5ec4 under /1; only state.log.hash differs)');
  ok(hashJson(pNoVer as never) === 'ad627b99038faf5b72ae15eeb473aebbf1ca09b850bb0592b77b4a98e3e23d26', 'P0-A2 payload without version / fingerprint / code hash / save_meta / chain / log hash chain is byte-identical to rules version /1');
  ok(hashJson(v2(p) as never) === '4ab7edec5a317d7ae58b7b8129e7d3ade608f849fd1c472f88c354fd20057215', 'P0-A2 payload without version fields / fingerprint / code hash / save_meta / chain, engine_version projected to /2: byte-identical to rules version /2 (was 672229a6…1428 under /1; only engine_version and state.log.hash differ)');
  ok(hashJson(p as never) === '219d97546a5bb5feb67281aee3b6996b1b0b2577a363b262086a10001b9da6fb', 'P0-A2 payload without version fields / fingerprint / code hash / save_meta / chain, version /3: pinned (only engine_version differs from /2)');
  ok(P0A2_SCHEMA_VERSION === 2 && X.events.every((e) => e.schema_version === 2) && snapX.schema_version === 2, 'P0-A2 payload schema is 2 and every event says so');
  // chain = independent node:crypto recomputation over the emitted events
  const n = nodeChain(ctxX, X.events), c = X.world.chainState();
  ok(c.algo === CHAIN_ALGO && c.genesis === n.genesis && c.head === n.head && c.count === n.count && c.count === X.world.seqNo(), `P0-A2 chain head/count = node:crypto recomputation over the ${n.count} emitted events`);
  ok(canonicalJson(chainAppend(chainStart(ctxX), X.events)) === canonicalJson(c) && canonicalJson(snapX.payload.chain) === canonicalJson(c), 'P0-A2: chainAppend = live chain = the snapshot\'s chain');
  const m = snapX.payload.save_meta;
  ok(m.world_kind === 'p0a2-24h-v1' && m.initial.world_id === 'exp-test' && m.initial.seed === 7 && m.initial.t_sim === 0 && m.initial.scenario === P0A2_SCENARIO && m.initial.variant === P0RAW.reference_variant
    && m.initial.params_sha256 === P0A2_PARAMS_SHA && P0A2_PARAMS_SHA === sha(p0canon(P0RAW)) && m.lineage.length === 0, 'P0-A2 save_meta: world kind, trusted initial conditions (world id, seed, t = 0, scenario, reference variant, params.json SHA-256 by node:crypto), empty lineage');
  ok(m.species.id === null && m.species.fingerprint === null && /沒有正式物種參數檔/.test(m.species.note), 'P0-A2 species: null with the reason (no official species file; not fabricated)');
  // Owner #212 Q2 a (matrix M43): the 「尚未模擬／簡化代理」 list generated from the R2 matrix is part of the save metadata
  ok(canonicalJson(m.not_simulated as never) === canonicalJson(P0A2_NOT_SIMULATED as never) && m.not_simulated.format === 'antempire.not-simulated.v1' && m.not_simulated.items.length > 0, 'P0-A2 save_meta.not_simulated = the generated list (not-simulated.ts)');
  const nv = notSimulatedOf(snapX), sm = summaryOf(snapX);
  ok(nv.ok && nv.unwired.length + nv.proxies.length === P0A2_NOT_SIMULATED.items.length && sm.not_simulated?.unwired === nv.unwired.length && sm.not_simulated?.proxies === nv.proxies.length, 'the viewer reads the list from the snapshot (notSimulatedOf, summaryOf)');
  ok(!('not_simulated' in snapA.payload.save_meta) && !notSimulatedOf(snapA).ok && summaryOf(snapA).not_simulated === null, 'the synthetic world has no list (not an ant model) and the viewer does not fill one in');
  ok(m.environment.synthetic === true && m.environment.id === `p0a2-weather/${P0A2_SCENARIO}` && m.environment.fingerprint === hashJson({ scenario: P0A2_SCENARIO, site: P0RAW.site, weather_scenario: P0RAW.weather_scenarios[P0A2_SCENARIO] }), 'P0-A2 environment: synthetic weather scenario, fingerprint = SHA-256 of its params.json definition');
  ok(WORLD_KINDS[P0A2_SAVE_WORLD_KIND]?.rules_fingerprint === snapX.rules_fingerprint && WORLD_KINDS[P0A2_SAVE_WORLD_KIND].params_sha256 === P0A2_PARAMS_SHA, 'world-kind registry has the P0-A2 world with the runtime\'s rules and parameters');
}
const sX24 = (() => { const c = P0a2ExperimentWorld.create('exp-test', 7); c.world.advanceTo(24 * H); return c.world.snapshot(); })();
const tamperX = (f: (s: P0a2Snapshot) => void) => { const s = clone(sX24); f(s); s.payload_sha256 = hashJson(s.payload as never); return s; };
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.chain.count += 1; })), 'CHAIN_MISMATCH'), 'P0-A2 restore refuses: chain count != seq');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.chain.genesis = '0'.repeat(64); })), 'CHAIN_MISMATCH'), 'P0-A2 restore refuses: foreign genesis');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.chain.head = 'X'; })), 'CHAIN_MISMATCH'), 'P0-A2 restore refuses: malformed head');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { delete (s.payload as Partial<typeof s.payload>).chain; })), 'BAD_SNAPSHOT'), 'P0-A2 restore refuses: chain missing');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.save_meta.initial.seed = 8; })), 'META_MISMATCH'), 'P0-A2 restore refuses: initial conditions that do not match the world');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.save_meta.initial.variant = 'other'; })), 'META_MISMATCH'), 'P0-A2 restore refuses: another variant in the initial conditions');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.save_meta.environment.fingerprint = 'f'.repeat(64); })), 'META_MISMATCH'), 'P0-A2 restore refuses: foreign environment fingerprint');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { (s.payload.save_meta.lineage as unknown[]).push({ parent_rules_fingerprint: 'x' }); })), 'FORK_UNSUPPORTED'), 'P0-A2 restore refuses: a fork record (no fork implemented)');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { delete (s.payload.save_meta as { not_simulated?: unknown }).not_simulated; })), 'META_MISMATCH'), 'P0-A2 restore refuses: save_meta without the 尚未模擬 list (not silently filled in)');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.save_meta.not_simulated.items = s.payload.save_meta.not_simulated.items.filter((i) => i.status !== '未接入'); })), 'META_MISMATCH'), 'P0-A2 restore refuses: a list with the unwired mechanisms removed');
ok(p0refused(() => P0a2ExperimentWorld.restore(tamperX((s) => { (s.payload.save_meta.not_simulated.items[0] as { label_zh: string }).label_zh = '已完整模擬'; })), 'META_MISMATCH'), 'P0-A2 restore refuses: an edited list entry');
ok(P0a2ExperimentWorld.restore(tamperX((s) => { s.payload.chain.head = 'a'.repeat(64); })).chainState().head === 'a'.repeat(64), 'P0-A2 restore cannot detect a well-formed forged head (documented: only Node recomputation can)');
const v1X = (() => { const s = clone(sX24) as unknown as Record<string, any>; delete s.payload.save_meta; delete s.payload.chain; s.schema_version = s.payload.schema_version = 1; s.payload_sha256 = hashJson(s.payload); return s as unknown as P0a2Snapshot; })();
const v1XText = canonicalJson(v1X as never);
ok(p0refused(() => P0a2ExperimentWorld.restore(v1X), 'SCHEMA_MISMATCH', /no event-chain commitment.*no migration path/), 'a P0-A2 payload-schema-1 snapshot is refused with a clear reason (no chain, no migration path)');
ok(canonicalJson(v1X as never) === v1XText, 'and the P0-A2 schema-1 snapshot is not changed');
{
  const c = P0a2ExperimentWorld.create('exp-test', 7); let t = 0, k = 1;
  while (t < 48 * H) { t = Math.min(48 * H, t + ((k * 7919) % 5000) + 0.25); k++; c.world.advanceTo(t, 1 + (k % 40)); }
  while (!c.world.advanceTo(48 * H, 3).done) { /* tiny budget: stops at slice ends only */ }
  ok(canonicalJson(c.world.chainState()) === canonicalJson(X.world.chainState()) && c.world.snapshot().payload_sha256 === snapX.payload_sha256, `P0-A2: ${k - 1} irregular chunks with work budgets -> the continuous chain and state`);
  for (const tc of [DAY, DAY - 0.5, X.events[5000].t_sim, 37 * H + 0.0004]) {
    const w = P0a2ExperimentWorld.create('exp-test', 7).world; w.advanceTo(tc);
    const w2 = P0a2ExperimentWorld.restore(JSON.parse(JSON.stringify(w.snapshot()))); w2.advanceTo(48 * H);
    ok(canonicalJson(w2.chainState()) === canonicalJson(X.world.chainState()) && w2.snapshot().payload_sha256 === snapX.payload_sha256, `P0-A2: save at ${tc} s -> restore (JSON round trip) -> continue to 48 h: chain and state = continuous`);
  }
  let w = P0a2ExperimentWorld.create('exp-test', 7).world; w.advanceTo(24 * H);
  w = P0a2ExperimentWorld.restore(JSON.parse(JSON.stringify(w.snapshot()))); w.advanceTo(36 * H);
  w = P0a2ExperimentWorld.restore(JSON.parse(JSON.stringify(w.snapshot()))); w.advanceTo(48 * H);
  ok(canonicalJson(w.chainState()) === canonicalJson(X.world.chainState()), 'P0-A2: two restarts (24 h, 36 h) -> the continuous chain at 48 h');
  ok(p0refused(() => P0a2ExperimentWorld.create('exp-test', 7).world.advanceToExact({ day: 0, us: 1500, us_lo: 0 }), 'BAD_TIME'), 'P0-A2 advanceToExact refuses an instant off the millisecond grain');
}
// the verifier on P0-A2 saves; the export is built by the viewer's own buildExport (web/src/experimental/save-format.ts)
const p0export = async (s: P0a2Snapshot) => JSON.parse(JSON.stringify(await buildExport({ world_id: s.world_id, name: 'P0-A2 測試', seed: s.seed, created_at: '2026-11-12T00:00:00.000Z', summary: summaryOf(s) }, s as unknown as SnapshotEnvelope, '2026-11-12T00:00:00.000Z')));
const honestX = await p0export(snapX);
{
  const r = verify(honestX);
  ok(r.status === 'node_verified' && r.save.world_kind === 'p0a2-24h-v1' && r.recomputed!.chain_head === snapX.payload.chain.head && r.recomputed!.chain_count === 18595 && r.recomputed!.payload_sha256 === snapX.payload_sha256 && r.recomputed!.differing_fields.length === 0, `honest P0-A2 48 h export (viewer buildExport) -> node_verified (${codes(r)})`);
  ok(r.verifier.world_kinds.some((k) => k.id === 'p0a2-24h-v1' && k.rules_fingerprint === P0A2_RULES_FINGERPRINT), 'the report lists the P0-A2 world kind the verifier implements');
  ok(canonicalJson(r.save.not_simulated as never) === canonicalJson({ format: P0A2_NOT_SIMULATED.format, items: P0A2_NOT_SIMULATED.items } as never), 'the report lists the save\'s 尚未模擬 list (save.not_simulated)');
  ok(verify(snapX).status === 'node_verified', 'a bare P0-A2 snapshot envelope -> node_verified');
  const ni = verify(honestX, false);
  ok(ni.status === 'integrity_ok' && ni.recomputed === null, 'P0-A2 --no-recompute -> integrity_ok, never node_verified');
  ok(verify(P0a2ExperimentWorld.create('exp-zero', 3).world.snapshot()).status === 'node_verified', 'a new P0-A2 world at t = 0 -> node_verified');
  const b = P0a2ExperimentWorld.create('exp-budget', 11).world; const st = b.advanceTo(30 * H, 5);
  ok(!st.done && verify(b.snapshot()).status === 'node_verified', `a P0-A2 save at a budget-stopped instant (t = ${b.tSim()} s) -> node_verified`);
  const w = P0a2ExperimentWorld.create('exp-test', 7).world; w.advanceTo(10 * H + 0.125);
  const w2 = P0a2ExperimentWorld.restore(JSON.parse(JSON.stringify(w.snapshot()))); w2.advanceTo(30 * H + 0.5);
  ok(verify(await p0export(w2.snapshot())).status === 'node_verified', 'P0-A2 save -> restore -> continue -> save -> node_verified');
}
const resealX = (f: any) => { f.snapshot.payload_sha256 = hashJson(f.snapshot.payload); const { export_sha256: _x, ...body } = f; f.export_sha256 = hashJson(body); return f; };
const mustNotX = (name: string, f: (x: any) => void, want: 'mismatch' | 'invalid', code?: string) => {
  const x = clone(honestX); f(x); const r = verify(x);
  ok(r.status === want && (!code || codes(r).includes(code)), `P0-A2 ${name} -> ${want}${code ? ` (${code})` : ''} (got ${r.status}: ${codes(r)})`);
};
mustNotX('state edited, hashes NOT updated', (x) => { x.snapshot.payload.state.stats.heat_refusals += 1; }, 'invalid', 'EXPORT_HASH_MISMATCH');
mustNotX('state statistic edited, every hash recomputed (forged)', (x) => { x.snapshot.payload.state.stats.heat_refusals += 1; resealX(x); }, 'mismatch', 'STATE_MISMATCH');
mustNotX('worker trait edited, every hash recomputed (forged)', (x) => { x.snapshot.payload.state.workers.w001.ctmax_c += 1; resealX(x); }, 'mismatch', 'STATE_MISMATCH');
mustNotX('food not conserved, hashes recomputed', (x) => { x.snapshot.payload.state.workers.w001.crop += 1; resealX(x); }, 'invalid', 'RESTORE_REFUSED');
mustNotX('chain head forged, hashes recomputed', (x) => { x.snapshot.payload.chain.head = 'b'.repeat(64); resealX(x); }, 'mismatch', 'CHAIN_MISMATCH');
{
  const forged = clone(X.events) as P0a2Event[]; forged[4321] = { ...forged[4321], data: { ...forged[4321].data, tie_q: (forged[4321].data.tie_q as number) + 1 } };
  mustNotX('one committed event altered (head over the altered events), hashes recomputed', (x) => { x.snapshot.payload.chain.head = nodeChain(ctxX, forged).head; resealX(x); }, 'mismatch', 'CHAIN_MISMATCH');
  const dropped = X.events.filter((_, i) => i !== 777);
  mustNotX('one committed event dropped (head and count over the rest), hashes recomputed', (x) => { const c = nodeChain(ctxX, dropped); x.snapshot.payload.chain.head = c.head; x.snapshot.payload.chain.count = c.count; resealX(x); }, 'invalid', 'RESTORE_REFUSED');
}
mustNotX('seed changed in the header only', (x) => { x.snapshot.seed = x.world.seed = 8; resealX(x); }, 'invalid', 'HEADER_MISMATCH');
mustNotX('rules fingerprint changed (header + payload)', (x) => { x.snapshot.rules_fingerprint = x.snapshot.payload.rules_fingerprint = 'f'.repeat(64); resealX(x); }, 'invalid', 'UNSUPPORTED_RULES');
mustNotX('initial parameters hash changed', (x) => { x.snapshot.payload.save_meta.initial.params_sha256 = 'c'.repeat(64); resealX(x); }, 'invalid', 'UNSUPPORTED_PARAMS');
mustNotX('scenario changed (fingerprint left)', (x) => { x.snapshot.payload.scenario = 'taichung-may-ref'; resealX(x); }, 'invalid', 'RESTORE_REFUSED');
mustNotX('尚未模擬 list emptied, hashes recomputed', (x) => { x.snapshot.payload.save_meta.not_simulated.items = []; resealX(x); }, 'invalid', 'RESTORE_REFUSED');
mustNotX('world kind claimed as synthetic', (x) => { x.snapshot.payload.save_meta.world_kind = 'synthetic-v1'; resealX(x); }, 'invalid', 'UNSUPPORTED_ENGINE');
mustNotX('self-declared verification status in the export', (x) => { x.verification = { status: 'node_verified' }; const { export_sha256: _e, ...body } = x; x.export_sha256 = hashJson(body); }, 'invalid', 'BAD_EXPORT');
ok(verify(v1X).status === 'invalid' && codes(verify(v1X)).includes('NO_CHAIN'), 'P0-A2 payload-schema-1 snapshot -> invalid (NO_CHAIN), never node_verified');

// ---------------------------------------------------------------- 6b. an older P0-A2 RULES version (Owner #214 Q4, 2026-11-13)
// tests/fixtures/p0a2-rules-v1/exp-v1-fixture-6h.export.json is a GENUINE rules-version /1 export (payload schema 2,
// engine experiment-p0a2-24h/1, seed 7, 6 h), produced by the /1 code (adapter + prototypes/p0a2-24h before the
// `idle_larvae` log fix) with the viewer's buildExport. A /1 record must stay identifiable as /1 and must never be
// replayed, re-hashed or rewritten under /2: the verifier reports it unsupported (no recomputation), the Worker refuses
// to continue it (ENGINE_MISMATCH naming the older P0-A2 rules version), the viewer reports rules_mismatch, and the
// file is not changed.
{
  const f = path.join(REPO_ROOT, 'tests/fixtures/p0a2-rules-v1/exp-v1-fixture-6h.export.json');
  const text = fs.readFileSync(f, 'utf8'), before = sha(text), x = JSON.parse(text);
  const V1_CODE_SHA = 'b5645457db966d145929e48aa8f021e0125a2c59c3f84c0b8213f8c84e835d5b'; // P0A2_CODE_SHA256 of rules version /1 (main 688ca9e)
  // the /1 module graph = today's minus the 「尚未模擬」 list module added in version /3 (P0A2_CODE_FILES of main 688ca9e)
  const V1_CODE_FILES = P0A2_CODE_FILES.filter((f) => f !== 'prototypes/continuous-world/worker/not-simulated.ts');
  const v1Fp = hashJson({ engine_version: 'experiment-p0a2-24h/1', schema_version: 2, world_kind: 'p0a2', params_sha256: P0A2_PARAMS_SHA, code_sha256: V1_CODE_SHA, code_files: V1_CODE_FILES, scenario: P0A2_SCENARIO, variant: P0RAW.reference_variant });
  ok(x.snapshot.engine_version === 'experiment-p0a2-24h/1' && x.snapshot.rules_fingerprint === v1Fp && x.snapshot.payload.code_sha256 === V1_CODE_SHA && hashJson(x.snapshot.payload) === x.snapshot.payload_sha256, 'fixture is a genuine, intact /1 record (its fingerprint is the /1 fingerprint recomputed from the /1 code hash)');
  ok(P0A2_ENGINE_VERSION === 'experiment-p0a2-24h/3' && P0A2_RULES_FINGERPRINT !== v1Fp && (P0A2_CODE_SHA256 as string) !== V1_CODE_SHA && ['experiment-p0a2-24h/1', 'experiment-p0a2-24h/2'].every((v) => v in P0A2_ENGINE_HISTORY) && P0A2_ENGINE_VERSION in P0A2_ENGINE_HISTORY, 'the current P0-A2 version is /3 (save_meta.not_simulated) with another fingerprint; every version is listed in the version history');
  const r = verify(text);
  ok(r.status === 'invalid' && codes(r).includes('UNSUPPORTED_ENGINE') && r.recomputed === null && r.save.engine_version === 'experiment-p0a2-24h/1' && r.save.world_kind === P0A2_SAVE_WORLD_KIND, `Node verifier: /1 save -> invalid (UNSUPPORTED_ENGINE), not recomputed under /2, the report names engine /1 (got ${r.status}: ${codes(r)})`);
  ok(p0refused(() => P0a2ExperimentWorld.restore(clone(x.snapshot)), 'ENGINE_MISMATCH', /older P0-A2 rules version.*cannot be continued or re-hashed/), 'Worker core: /1 snapshot refused (ENGINE_MISMATCH, names the older rules version)');
  const rt = new Runtime(() => 0), out = rt.handle({ type: 'restore', req: 1, snapshot: clone(x.snapshot) }) as { type: string; code?: string; message?: string }[];
  const last = out[out.length - 1];
  ok(last.type === 'error' && last.code === 'ENGINE_MISMATCH' && /older P0-A2 rules version/.test(String(last.message)) && rt.current() === null, `Worker runtime: a /1 snapshot is routed to the P0-A2 core and refused there (not to another world kind); no world is started (got ${last.code})`);
  const rtInfo = { rules_fingerprint: P0A2_RULES_FINGERPRINT, engine_version: P0A2_ENGINE_VERSION, schema_version: P0A2_SCHEMA_VERSION };
  const imp = await parseImport(text, rtInfo, defaultMigrations());
  ok(imp.ok && imp.value.compat === 'rules_mismatch' && compatibility(x.snapshot, rtInfo, defaultMigrations()) === 'rules_mismatch', 'viewer: a /1 export imports as data with compatibility rules_mismatch (cannot be continued; can be kept and exported)');
  ok(sha(fs.readFileSync(f, 'utf8')) === before, 'the /1 fixture is not changed by any of these checks');
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-verify-p0a2-'));
  try {
    const good = path.join(dir, 'p0a2.json'); fs.writeFileSync(good, JSON.stringify(honestX)); const before = sha(fs.readFileSync(good, 'utf8'));
    let out = '', code = 0; try { out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'cli/verify-save.ts'), good], { encoding: 'utf8' }); } catch (e) { code = (e as { status: number }).status; }
    ok(code === 0 && JSON.parse(out).status === 'node_verified' && JSON.parse(out).save.world_kind === 'p0a2-24h-v1' && sha(fs.readFileSync(good, 'utf8')) === before && fs.readdirSync(dir).length === 1, 'CLI: honest P0-A2 export -> exit 0, node_verified; input unchanged, no file written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ test: 'save-verify', checks, events_48h: A.events.length, chain_head_48h: A.world.chainState().head, payload_sha256_48h: snapA.payload_sha256, p0a2_events_48h: X.events.length, p0a2_chain_head_48h: X.world.chainState().head, p0a2_payload_sha256_48h: snapX.payload_sha256 }));

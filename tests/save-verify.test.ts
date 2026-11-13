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
console.log(JSON.stringify({ test: 'save-verify', checks, events_48h: A.events.length, chain_head_48h: A.world.chainState().head, payload_sha256_48h: snapA.payload_sha256 }));

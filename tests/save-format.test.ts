/**
 * SAVE-1 pure logic (web/src/experimental/save-format.ts), run in Node. IndexedDB behaviour is tested in real Chromium
 * by tests/browser/save-store.check.cjs. Payloads here are SYNTHETIC: the Worker runtime is not merged yet.
 *  1. canonical JSON + SHA-256 reproduce the SAVE-0 vectors; the store's envelope check agrees with the JSON Schema.
 *  2. the store never mutates the payload it is given (deep-frozen inputs, deep-equal before/after).
 *  3. compatibility and explicit migrations: v1 identity, a test v1->v2 step, failing steps leave the original intact.
 *  4. retention keeps >=2 verified snapshots, excludes quarantined ones; stored-record checks catch corruption.
 *  5. export/import: round trip; tampering, truncation, official flag and foreign snapshots are rejected.
 *  6. autosave policy: 30 s check only when the world changed, pause/menu/manual always, coalescing, "已儲存" only
 *     after the save resolved, failure shows "儲存失敗" and keeps the world dirty.
 *  7. constants agree with prototypes/continuous-world/save/save-db.v1.json; the store literal DB name is the same.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { validate, type Schema } from './lib/json-schema-lite.ts';
import { canonicalJson as refCanonical } from './lib/canonical-json.ts';
import {
  canonicalJson, sha256Hex, envelopeErrors, verifyEnvelope, sealEnvelope, MigrationRegistry, defaultMigrations, compatibility, planPromote, sweepable,
  recordProblem, buildExport, parseImport, AutosaveController, simDayTime, newWorldId, newSeed, headerOf, LABEL, RETAIN_VERIFIED, AUTOSAVE_INTERVAL_S, LOCK_PREFIX,
  CURRENT_SCHEMA_VERSION, verificationOf, VERIFICATION_TEXT, NOT_NODE_VERIFIED, type SnapshotEnvelope, type SnapshotRecord, type Result, type SaveReason,
} from '../web/src/experimental/save-format.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DIR = 'prototypes/continuous-world/save';
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
const SNAP: Schema = json(`${DIR}/experiment-world-snapshot.v1.schema.json`), DB = json(`${DIR}/save-db.v1.json`), VEC = json(`${DIR}/canonical-vectors.v1.json`);
const RT = { rules_fingerprint: 'rules-A', engine_version: 'worker-0', schema_version: 1 };
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const synthPayload = (n: number) => ({ world: { t_sim: n * 10, weather: { rain_mm: 0.5 } }, colony: { ants: Array.from({ length: 5 }, (_, i) => ({ id: `W${i}`, x: i * 1.5 + n, heading: 0.25 * i })) }, continuity: { rng: { streams: { weather: { s: [1, 2, 3, n] } } }, queue: [{ t: n * 10 + 1, kind: 'synthetic' }] } });
const env = (n: number, over: Partial<SnapshotEnvelope> = {}) => sealEnvelope({ world_id: 'exp-test-A', seed: 7, rules_fingerprint: 'rules-A', engine_version: 'worker-0', schema_version: 1, t_sim: n * 10, seq: n, ...over }, synthPayload(n));

// 1. canonical JSON and envelope shape
for (const v of VEC.vectors) { ok(canonicalJson(v.input) === v.canonical && refCanonical(v.input) === v.canonical, `canonical vector ${v.canonical}`); ok(await sha256Hex(v.canonical) === v.sha256, `sha256 vector ${v.sha256.slice(0, 10)}`); }
const e0 = await env(0);
ok(envelopeErrors(e0).length === 0 && validate(SNAP, e0).length === 0, 'sealed envelope passes both the store check and the JSON Schema');
const muts: [string, (e: Record<string, unknown>) => void][] = [
  ['official', (e) => { e.official = true; }], ['label', (e) => { e.label = 'x'; }], ['schema', (e) => { e.schema = 'x'; }], ['extra', (e) => { e.more = 1; }],
  ['t_sim', (e) => { e.t_sim = -1; }], ['seq', (e) => { e.seq = 0.5; }], ['schema_version', (e) => { e.schema_version = 0; }], ['payload', (e) => { e.payload = [1]; }],
  ['hash', (e) => { e.payload_sha256 = 'zz'; }], ['world_id', (e) => { e.world_id = 'a/b'; }], ['world_id prefix', (e) => { e.world_id = 'world-1'; }], ['seed', (e) => { e.seed = 1.5; }], ['seed string', (e) => { e.seed = 'abc'; }], ['seed 2^32', (e) => { e.seed = 2 ** 32; }], ['engine_version', (e) => { e.engine_version = ''; }],
  ['missing seq', (e) => { delete e.seq; }],
];
for (const [n, m] of muts) { const x = structuredClone(e0) as unknown as Record<string, unknown>; m(x); ok(envelopeErrors(x).length > 0 && validate(SNAP, x).length > 0, `store check and JSON Schema both reject: ${n}`); }
ok(!(await verifyEnvelope({ ...e0, payload: { ...e0.payload, extra: 1 } })).ok, 'verifyEnvelope detects a payload that does not match its hash');
ok(!(await verifyEnvelope({ ...e0, payload: { x: Number.NaN } })).ok, 'non-JSON payload values are refused');

// 2. no mutation of the payload
const frozen = deepFreeze(await env(3)), before = JSON.stringify(frozen);
const v3 = await verifyEnvelope(frozen);
ok(v3.ok && JSON.stringify(frozen) === before, 'verifying a deep-frozen snapshot neither throws nor changes it');
ok(v3.ok && JSON.parse(v3.value.payload_json) !== frozen.payload && canonicalJson(JSON.parse(v3.value.payload_json)) === canonicalJson(frozen.payload), 'stored text round-trips to an equal payload');

// 3. compatibility and migrations
const reg1 = defaultMigrations();
ok(reg1.current === CURRENT_SCHEMA_VERSION && CURRENT_SCHEMA_VERSION === 1, 'current payload schema is v1');
const id = await reg1.migrate(e0);
ok(id.ok && canonicalJson(id.value.envelope) === canonicalJson(e0) && id.value.envelope !== e0, 'v1 -> v1 is the identity on a copy');
ok(compatibility(e0, RT, reg1) === 'compatible', 'same rules and schema: compatible');
ok(compatibility(e0, { ...RT, rules_fingerprint: 'rules-B' }, reg1) === 'rules_mismatch', 'different rules fingerprint: rules_mismatch (cannot continue)');
ok(compatibility({ ...e0, schema_version: 2 }, RT, reg1) === 'newer_schema', 'snapshot from a newer viewer: newer_schema');
ok(compatibility({ ...e0, schema: 'other' as never }, RT, reg1) === 'unknown_schema', 'unknown envelope schema');
const reg2 = new MigrationRegistry(2).register(1, (e) => ({ ...e, schema_version: 2, payload: { ...e.payload, migrated: { from: 1 } } }));
const RT2 = { ...RT, schema_version: 2 };
ok(compatibility(e0, RT2, reg2) === 'migratable' && compatibility(e0, RT2, new MigrationRegistry(2)) === 'no_migration_path', 'older schema: migratable only with a registered step');
// Owner ruling #200: an old payload schema without a path is reported as such even when its rules fingerprint differs
// (the Worker's fingerprint includes the payload schema; schema 1 has no event-chain commitment and cannot be migrated)
ok(compatibility(e0, { rules_fingerprint: 'rules-v2', engine_version: 'worker-0', schema_version: 2 }, reg1) === 'no_migration_path', 'payload schema 1 under a schema-2 runtime: no_migration_path (not rules_mismatch)');
// verification status (#200): the browser never claims Node verification
{
  const all = [true, false].flatMap((l) => [true, false].map((i) => verificationOf({ loadable: l, integrity_checked: i })));
  ok(all.every((v) => v.level !== 'node_verified' && v.text.includes(NOT_NODE_VERIFIED)), 'verificationOf never yields node_verified and always says 未經 Node 驗證');
  ok(verificationOf({ loadable: true, integrity_checked: false }).text.startsWith(VERIFICATION_TEXT.local_playable) && verificationOf({ loadable: true, integrity_checked: true }).text.startsWith(VERIFICATION_TEXT.integrity_ok) && verificationOf({ loadable: false, integrity_checked: true }).level === null, 'list = 本機可玩, after a checked load = 完整性檢查通過, unloadable = no level');
  ok(VERIFICATION_TEXT.local_playable === '本機可玩' && VERIFICATION_TEXT.integrity_ok === '完整性檢查通過' && VERIFICATION_TEXT.node_verified === 'Node 已重算驗證', 'the three status names of #200');
}
const orig = deepFreeze(await env(4)), origText = canonicalJson(orig);
const m2 = await reg2.migrate(orig);
ok(m2.ok && m2.value.envelope.schema_version === 2 && (m2.value.envelope.payload as Record<string, unknown>).migrated !== undefined && m2.value.from === 1, 'test migration v1 -> v2 applied');
ok(m2.ok && (await verifyEnvelope(m2.value.envelope)).ok, 'migrated envelope carries a recomputed, valid hash');
ok(canonicalJson(orig) === origText, 'migration leaves the original snapshot unchanged');
const bad1 = await new MigrationRegistry(2).register(1, () => { throw new Error('boom'); }).migrate(orig);
ok(!bad1.ok && bad1.code === 'migration_failed' && canonicalJson(orig) === origText, 'throwing migration: migration_failed, original intact');
const bad2 = await new MigrationRegistry(2).register(1, (e) => ({ ...e })).migrate(orig);
ok(!bad2.ok && bad2.code === 'migration_failed', 'a step that does not raise the version is refused');
const bad3 = await new MigrationRegistry(2).register(1, (e) => ({ ...e, schema_version: 2, official: true as never })).migrate(orig);
ok(!bad3.ok && bad3.code === 'migration_failed', 'a step that produces an invalid (official) envelope is refused');
const newer = await reg1.migrate({ ...orig, schema_version: 5 });
ok(!newer.ok && newer.code === 'newer_schema', 'never downgrade a newer snapshot');
assert.throws(() => reg2.register(1, (e) => e)); checks++;

// 4. retention and record checks
ok(JSON.stringify(planPromote([5, 4, 3], [], 6).slots) === '[6,5,4]', 'retention keeps the 3 newest verified');
ok(JSON.stringify(planPromote([5, 4, 3], [5], 6).slots) === '[6,4,3]', 'quarantined generations are not recovery points');
ok(planPromote([], [], 1).slots.length === 1 && planPromote([1], [], 2).slots.length === 2, 'two saves give two recovery points');
assert.throws(() => planPromote([1], [], 2, 1)); checks++;
ok(JSON.stringify(sweepable([1, 2, 3, 4, 5, 6, 7], [6, 5, 4], [2], 6)) === '[1,3]', 'sweep removes unkept older records, keeps quarantined and newer ones');
const v5 = await verifyEnvelope(await env(5)); assert.ok(v5.ok);
const rec: SnapshotRecord = { world_id: 'exp-test-A', gen: 9, status: 'verified', written_at: 'x', header: headerOf(v5.value.envelope), payload_json: v5.value.payload_json, payload_sha256: v5.value.envelope.payload_sha256 };
ok(await recordProblem(rec, 'exp-test-A', 9) === null, 'intact record passes');
ok(await recordProblem(undefined, 'exp-test-A', 9) === 'missing', 'missing record');
ok(await recordProblem({ ...rec, payload_json: rec.payload_json.replace('"W1"', '"W9"') }, 'exp-test-A', 9) === 'checksum mismatch', 'one changed byte is a checksum mismatch');
ok(await recordProblem({ ...rec, payload_json: rec.payload_json.slice(0, 20) }, 'exp-test-A', 9) === 'checksum mismatch', 'truncated payload detected');
ok(await recordProblem({ ...rec, gen: 8 }, 'exp-test-A', 9) === 'identity mismatch', 'record under the wrong key detected');
ok(/envelope invalid/.test(await recordProblem({ ...rec, header: { ...rec.header, official: true as never } }, 'exp-test-A', 9) ?? ''), 'header tampered to official detected');
ok(await recordProblem({ ...rec, header: { ...rec.header, world_id: 'exp-test-B' } }, 'exp-test-A', 9) === 'world_id mismatch', 'snapshot of another world detected');

// 5. export / import
const meta = { world_id: 'exp-test-A', name: '測試世界', seed: 7, created_at: '2026-11-08T00:00:00.000Z', summary: { queens: 1, workers: 5 } };
const ex = await buildExport(meta, v5.value.envelope, '2026-11-08T01:00:00.000Z'), text = JSON.stringify(ex);
const imp = await parseImport(text, RT, reg1);
ok(imp.ok && imp.value.compat === 'compatible' && canonicalJson(imp.value.file.snapshot) === canonicalJson(v5.value.envelope), 'export -> import round trip');
const impB = await parseImport(text, { ...RT, rules_fingerprint: 'rules-B' }, reg1);
ok(impB.ok && impB.value.compat === 'rules_mismatch', 'import reports rules incompatibility instead of hiding it');
const tamper = async (f: (o: Record<string, any>) => void, why: string) => { const o = JSON.parse(text); f(o); const r = await parseImport(JSON.stringify(o), RT, reg1); ok(!r.ok && r.code === 'invalid_import', `import rejects: ${why}`); };
await tamper((o) => { o.snapshot.payload.colony.ants[0].x = 99; }, 'altered payload');
await tamper((o) => { o.world.name = 'x'; }, 'altered metadata (file hash)');
await tamper((o) => { o.official = true; }, 'official flag');
await tamper((o) => { o.snapshot.official = true; }, 'official snapshot');
await tamper((o) => { o.schema = 'antempire.save'; }, 'wrong schema');
await tamper((o) => { o.world.world_id = 'exp-other'; }, 'snapshot from another world');
await tamper((o) => { o.extra = 1; }, 'extra field');
ok(!(await parseImport(text.slice(0, text.length / 2), RT, reg1)).ok, 'import rejects a truncated file');

// 6. autosave policy
{
  let now = 0; const calls: SaveReason[] = []; const states: string[] = []; let resolveSave: ((r: Result<unknown>) => void) | null = null;
  const c = new AutosaveController({ now: () => now, save: (r) => { calls.push(r); return new Promise((res) => { resolveSave = res; }); }, onState: (s) => states.push(s.text) });
  ok(c.intervalMs === AUTOSAVE_INTERVAL_S * 1000 && AUTOSAVE_INTERVAL_S === 30, 'default interval 30 s');
  now = 60_000; ok(c.tick() === null && calls.length === 0, 'no interval save while the world did not change');
  c.markDirty(); now = 61_000; const p1 = c.tick();
  ok(p1 && calls.join() === 'interval' && c.state.text === '正在儲存', 'interval save after 30 s with changes; UI shows 正在儲存');
  c.markDirty(); void c.request('hidden'); void c.request('pause');
  ok(calls.length === 1, 'triggers during a save do not start a second concurrent save');
  ok(c.state.text !== '已儲存', 'not 已儲存 before the store resolved');
  now = 62_000; resolveSave!({ ok: true, value: 1 }); await p1; await Promise.resolve();
  ok(states.includes('已儲存') && c.state.last_success_ms === 62_000, '已儲存 and the last success time only after the save resolved');
  ok(calls.join() === 'interval,pause', 'coalesced triggers run exactly one follow-up save (the non-optional pause)');
  resolveSave!({ ok: false, code: 'quota_exceeded', message: 'full' }); await new Promise((r) => setTimeout(r, 0));
  ok(c.state.text === '儲存失敗' && /quota_exceeded/.test(c.state.last_error ?? '') && c.isDirty, 'failure shows 儲存失敗 with the reason and keeps the world dirty');
  ok(c.state.last_success_ms === 62_000, 'last success time is kept after a failure');
  now = 63_000; ok(c.tick() === null, 'interval check waits a full period after the last attempt');
  now = 92_001; const p3 = c.tick(); ok(p3 !== null, 'retried on the next period'); resolveSave!({ ok: true, value: 1 }); await p3;
  ok(c.request('hidden') === null && c.request('pagehide') === null, 'hidden/pagehide skip when nothing changed');
  const pm = c.request('manual'); ok(pm !== null, 'manual 立即存檔 always saves'); resolveSave!({ ok: true, value: 1 }); await pm;
  const pp = c.request('menu'); ok(pp !== null, 'returning to the menu always saves first'); resolveSave!({ ok: true, value: 1 }); await pp;
  // review finding (#179): a menu request while an interval autosave is in flight must resolve with the follow-up save
  {
    const calls3: SaveReason[] = []; const res3: ((r: Result<unknown>) => void)[] = [];
    const c3 = new AutosaveController({ now: () => 100_000, save: (r) => { calls3.push(r); return new Promise((res) => { res3.push(res); }); } });
    c3.markDirty(); const pi = c3.request('interval');
    c3.markDirty(); const pmenu = c3.request('menu');
    ok(pi && pmenu && pmenu !== pi, 'a menu request during an in-flight save does not return the older in-flight promise');
    let menuDone = false; void pmenu!.then(() => { menuDone = true; });
    res3[0]({ ok: true, value: 'interval' }); await pi; await new Promise((r) => setTimeout(r, 0));
    ok(!menuDone && calls3.join() === 'interval,menu', 'the menu promise is still pending while the follow-up menu save runs');
    let settledDone = false; void c3.settled().then(() => { settledDone = true; }); await new Promise((r) => setTimeout(r, 0));
    ok(!settledDone, 'settled() waits for the queued follow-up save');
    res3[1]({ ok: false, code: 'write_failed', message: 'disk' }); const rm = await pmenu!; await new Promise((r) => setTimeout(r, 0));
    ok(rm && !rm.ok && rm.code === 'write_failed', 'the menu request reports the follow-up save result (here its failure), never the older success');
    ok(settledDone && c3.state.text === '儲存失敗', 'settled() resolves after the follow-up save, and the UI shows its failure');
  }
  const c2 = new AutosaveController({ now: () => 0, save: async () => { throw new Error('crash'); } }); c2.markDirty();
  const r2 = await c2.request('manual'); ok(r2 && !r2.ok && c2.state.text === '儲存失敗', 'a thrown save error becomes 儲存失敗, never 已儲存');
}

// 7. constants, helpers
ok(RETAIN_VERIFIED === DB.retain_verified.value && AUTOSAVE_INTERVAL_S === DB.autosave_interval_s.value && LOCK_PREFIX === DB.lock_name_prefix, 'constants equal save-db.v1.json');
ok(LABEL === json('prototypes/continuous-world/worker-boundary.json').label_zh, 'label equals the boundary label');
const store = fs.readFileSync(path.join(REPO_ROOT, 'web/src/experimental/save-store.ts'), 'utf8');
ok(store.includes(`indexedDB.open('${DB.database_name}'`) && store.includes(`DB_NAME = '${DB.database_name}'`), 'store opens exactly the contract database name');
ok(/^exp-[0-9a-f-]{36}$/.test(newWorldId()) && newWorldId() !== newWorldId(), 'new world ids are fresh');
ok(Number.isInteger(newSeed()) && newSeed() >= 0, 'new seeds are 32-bit integers');
ok(JSON.stringify(simDayTime(86400 * 2 + 4559.9)) === '{"day":2,"clock":"01:15:59"}' && JSON.stringify(simDayTime(0)) === '{"day":0,"clock":"00:00:00"}' && simDayTime(null) === null, 'sim day/time display from t_sim in seconds');

console.log(JSON.stringify({ test: 'save-format', checks, payloads: 'synthetic (Worker runtime not merged)' }));

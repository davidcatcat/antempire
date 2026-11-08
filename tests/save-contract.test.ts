/**
 * SAVE-0 contract for non-official experiment-world saves (docs/experimental-save-system.md).
 *  1. The snapshot envelope schema has exactly the agreed fields, the non-official label and official:false.
 *  2. The schema validator accepts a well-formed envelope and rejects every malformed one (negative fixtures).
 *  3. The export schema embeds the snapshot schema and is also non-official.
 *  4. The DB layout uses the boundary file's experiment prefix; retention keeps at least 2 verified snapshots; product
 *     values (retention, autosave interval) are labelled assumptions.
 *  5. The content manifest lists every category the Owner requires; any "rebuildable" omission names an existing test.
 *  6. Canonical JSON + SHA-256 test vectors are reproducible (both the Worker and the store must match them).
 *  7. The design document and roadmap carry the required rules (atomicity, recovery, no silent new world, UI states,
 *     locks, offline time not simulated, acceptance A-E, SAVE-0..3 with their dependencies).
 *  8. Isolation: the contract files name no official save / journal path; nothing in the official pipeline reads them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { validate, unknownKeywords, type Schema } from './lib/json-schema-lite.ts';
import { canonicalJson } from './lib/canonical-json.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DIR = 'prototypes/continuous-world/save';
const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
const json = (f: string) => JSON.parse(read(f));
const LABEL = '非正式實驗世界／不屬於正式遊戲歷史';
const B = json('prototypes/continuous-world/worker-boundary.json');
const SNAP: Schema = json(`${DIR}/experiment-world-snapshot.v1.schema.json`);
const EXP: Schema = json(`${DIR}/experiment-world-export.v1.schema.json`);
const DB = json(`${DIR}/save-db.v1.json`);
const CONTENT = json(`${DIR}/snapshot-content.v1.json`);
const VEC = json(`${DIR}/canonical-vectors.v1.json`);
const refs = { [SNAP.$id as string]: SNAP };

// 1. envelope fields (fixed contract shared with the Worker runtime)
const FIELDS = ['schema', 'label', 'official', 'world_id', 'seed', 'rules_fingerprint', 'engine_version', 'schema_version', 't_sim', 'seq', 'payload', 'payload_sha256'];
ok(JSON.stringify(SNAP.required) === JSON.stringify(FIELDS), 'snapshot envelope requires exactly the agreed fields, in order');
ok(JSON.stringify(Object.keys(SNAP.properties as object)) === JSON.stringify(FIELDS) && SNAP.additionalProperties === false, 'no extra envelope fields allowed');
const P = SNAP.properties as Record<string, Schema>;
ok(P.schema.const === 'antempire.experiment-world-snapshot.v1' && SNAP.$id === P.schema.const, 'schema id');
ok(P.label.const === LABEL && P.label.const === B.label_zh, 'label equals the boundary file label');
ok(P.official.const === false, 'official is the constant false');
for (const s of [SNAP, EXP]) ok(unknownKeywords(s).length === 0, `${s.$id} uses only keywords the validator understands`);

// 2. positive and negative envelopes
const payload = { world: { t_sim: 0 }, colony: {}, continuity: { rng: { streams: {} } } };
const good = () => ({ schema: 'antempire.experiment-world-snapshot.v1', label: LABEL, official: false, world_id: 'exp-0001', seed: 42, rules_fingerprint: 'r1', engine_version: 'w0', schema_version: 1, t_sim: 0, seq: 0, payload, payload_sha256: crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex') });
ok(validate(SNAP, good()).length === 0, `well-formed envelope validates (${validate(SNAP, good()).join('; ')})`);
ok(validate(SNAP, { ...good(), seed: 'user-seed' }).length === 0, 'string seed is allowed');
const bad: [string, (e: Record<string, unknown>) => void][] = [
  ['official true', (e) => { e.official = true; }], ['missing label', (e) => { delete e.label; }], ['wrong label', (e) => { e.label = '正式'; }],
  ['wrong schema', (e) => { e.schema = 'antempire.experiment-world-snapshot.v2'; }], ['extra field', (e) => { e.extra = 1; }],
  ['negative t_sim', (e) => { e.t_sim = -1; }], ['fractional seq', (e) => { e.seq = 1.5; }], ['schema_version 0', (e) => { e.schema_version = 0; }],
  ['payload array', (e) => { e.payload = []; }], ['short hash', (e) => { e.payload_sha256 = 'abc'; }], ['upper-case hash', (e) => { e.payload_sha256 = 'A'.repeat(64); }],
  ['world_id with slash', (e) => { e.world_id = '../saves'; }], ['empty fingerprint', (e) => { e.rules_fingerprint = ''; }], ['missing payload', (e) => { delete e.payload; }],
  ['seed float', (e) => { e.seed = 0.5; }], ['t_sim NaN', (e) => { e.t_sim = Number.NaN; }],
];
for (const [name, mutate] of bad) { const e = good() as Record<string, unknown>; mutate(e); ok(validate(SNAP, e).length > 0, `malformed envelope rejected: ${name}`); }

// 3. export file
const EP = EXP.properties as Record<string, Schema>;
ok(EP.label.const === LABEL && EP.official.const === false, 'export is labelled non-official');
ok((EP.snapshot as Schema).$ref === SNAP.$id, 'export embeds the snapshot schema');
const exp = { schema: 'antempire.experiment-world-export.v1', label: LABEL, official: false, exported_at: '2026-11-08T00:00:00Z', world: { world_id: 'exp-0001', name: '測試', seed: 42, created_at: '2026-11-08T00:00:00Z' }, snapshot: good(), export_sha256: '0'.repeat(64) };
ok(validate(EXP, exp, refs).length === 0, `well-formed export validates (${validate(EXP, exp, refs).join('; ')})`);
ok(validate(EXP, { ...exp, snapshot: { ...good(), official: true } }, refs).length > 0, 'export with an official snapshot is rejected');
ok(validate(EXP, { ...exp, official: true }, refs).length > 0, 'export marked official is rejected');

// 4. database layout
ok(DB.database_name.startsWith(B.experimental_save_store.database_name_prefix), 'database name uses the experiment prefix from the boundary file');
ok(DB.lock_name_prefix.startsWith('antempire-experiment-'), 'lock names are experiment-prefixed');
ok(JSON.stringify(DB.stores.snapshots.keyPath) === '["world_id","gen"]' && DB.stores.worlds.keyPath === 'world_id', 'snapshots keyed by world and store-assigned generation');
ok(DB.retain_verified.value >= DB.retain_verified.minimum && DB.retain_verified.minimum >= 2, 'at least two verified snapshots are kept');
for (const k of ['retain_verified', 'autosave_interval_s']) ok(DB[k].assumption === true && /遊戲假設/.test(DB[k].basis), `${k} is labelled a product assumption`);
for (const c of ['quota_exceeded', 'aborted', 'verify_failed', 'conflict', 'not_writer', 'no_valid_snapshot', 'newer_schema', 'rules_mismatch', 'migration_failed']) ok(DB.error_codes.includes(c), `typed error code listed: ${c}`);

// 5. content manifest
const need: Record<string, string[]> = {
  world: ['world_id', 'seed', 'world_settings', 'species_settings', 'rules_fingerprint', 't_sim', 'weather_environment_state', 'ecological_resources', 'production_ledger', 'consumption_ledger', 'migration_ledger', 'food_ledger'],
  colony: ['stable_ids', 'life_state', 'age', 'stage', 'hunger', 'nutrition', 'injury', 'position', 'heading', 'current_activity', 'memory', 'nest', 'nest_resources'],
  physics_chemistry: ['body_state', 'velocities', 'pending_physics_events', 'chemical_field', 'chemical_decay_state', 'local_sensing_state'],
  continuity: ['prng_seeds', 'named_rng_streams', 'rng_draw_progress', 'event_queue', 'pending_behaviours', 'timers'],
};
for (const [sec, items] of Object.entries(need)) for (const it of items) ok(CONTENT.sections[sec]?.items.includes(it), `content manifest ${sec} includes ${it}`);
ok(CONTENT.sections.physics_chemistry.required_when === 'integrated' && ['world', 'colony', 'continuity'].every((s) => CONTENT.sections[s].required_when === 'always'), 'physics/chemistry required once integrated; the rest always');
ok(CONTENT.never_resample_on_load === true, 'loading never resamples fates');
for (const r of CONTENT.rebuildable as { item: string; identity_test: string }[]) ok(fs.existsSync(path.join(REPO_ROOT, r.identity_test)), `rebuildable ${r.item} has an identity test`);

// 6. canonical JSON vectors
for (const v of VEC.vectors) {
  const c = canonicalJson(v.input);
  ok(c === v.canonical, `canonical JSON vector ${v.canonical}`);
  ok(crypto.createHash('sha256').update(c, 'utf8').digest('hex') === v.sha256, `SHA-256 vector ${v.sha256.slice(0, 12)}`);
}
for (const [name, x] of [['NaN', { a: Number.NaN }], ['Infinity', { a: Infinity }], ['undefined', { a: undefined }], ['bigint', { a: 1n }], ['typed array', { a: new Float64Array(2) }], ['Date', { a: new Date(0) }]] as [string, unknown][]) {
  let threw = false; try { canonicalJson(x); } catch { threw = true; } ok(threw, `canonical JSON rejects ${name}`);
}

// 7. design document and roadmap
const doc = read('docs/experimental-save-system.md');
for (const f of ['experiment-world-snapshot.v1.schema.json', 'experiment-world-export.v1.schema.json', 'snapshot-content.v1.json']) ok(doc.includes(f) && fs.existsSync(path.join(REPO_ROOT, DIR, f)), `doc links ${f}`);
for (const s of ['antempire-experiment-worlds', 'pending', 'verified', '樂觀並行', '不會默默建立新世界', '絕不重新抽樣', '一致事件邊界', '正在儲存', '已儲存', '上次成功儲存時間', '儲存失敗', '`complete`', 'visibilitychange', 'pagehide', '不能是唯一機制', '立即存檔', '離線時間不模擬', 'Web Lock', '唯讀', 'persist()', '不保證', '兩步確認', '`confirm()`', '繼續遊戲', '開始新遊戲', '讀取存檔', '存檔管理', 'migration_failed', '原快照不變', 'rules_mismatch', LABEL]) ok(doc.includes(s), `doc states: ${s}`);
for (const a of ['| A |', '| B |', '| C |', '| D |', '| E |']) ok(doc.includes(a), `doc lists acceptance test ${a}`);
const road = read('docs/roadmap.md');
ok(/SAVE-0/.test(road) && /SAVE-1/.test(road) && /SAVE-2/.test(road) && /SAVE-3/.test(road), 'roadmap lists SAVE-0..3');
ok(/SAVE-2[^\n]*PR 2/.test(road) && /SAVE-3[^\n]*PR 3/.test(road), 'roadmap ties SAVE-2 to the Worker runtime (PR 2) and SAVE-3 to V6-2 (PR 3)');
const bdoc = read('docs/experimental-worker-boundary.md');
ok(bdoc.includes('experimental-save-system.md') && B.experimental_save_store.files.includes('web/src/experimental/save-store.ts'), 'boundary doc points to this design; the store file is the listed one');

// 8. isolation
for (const f of fs.readdirSync(path.join(REPO_ROOT, DIR))) { const t = read(`${DIR}/${f}`); for (const p of ['saves/', 'journal/', 'commit-log', '.advance-tmp']) ok(!t.includes(p), `${f} names no official path (${p})`); }
const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|js)$/.test(e.name) ? [path.join(d, e.name)] : []) : [];
for (const f of [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((x) => x.endsWith('.ts')).map((x) => path.join(REPO_ROOT, 'engine', x)), ...walk(path.join(REPO_ROOT, 'cli'))]) ok(!fs.readFileSync(f, 'utf8').includes('continuous-world/save'), `${path.relative(REPO_ROOT, f)} does not read the save contract`);

console.log(JSON.stringify({ test: 'save-contract', checks }));

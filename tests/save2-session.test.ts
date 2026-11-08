/**
 * SAVE-2 (menu and resume) — Node checks of the parts that need no browser storage. Non-official experiment worlds.
 *  1. the store's canonical round trip (sorted keys, as IndexedDB holds it) restores a Worker world that then continues
 *     bit-identically (events incl. random draws, full payload) to the continuous world, at several cut points;
 *     taking a snapshot after every pacing tick changes nothing.
 *  2. snapshot metadata for the save list: individuals counted from the snapshot; the synthetic world has no queen
 *     (null, never 0 or an invented number).
 *  3. seed input (SAVE-0 §2): empty → random uint32; decimal integer in [0, 2^32) → itself; out of range → refused;
 *     text → first 4 bytes of SHA-256 (cross-checked with node:crypto).
 *  4. import limits (decision 57): oversized text refused before parsing; copy record ids; a copy's snapshots are
 *     verified against the source world id (recordProblem with sim id).
 *  5. static: the menu never uses window.confirm, escapes stored names before innerHTML, and the session/menu touch no
 *     storage API directly (only save-store.ts does; tests/worker-boundary.test.ts); manual saves are never swept.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { ExperimentWorld } from '../prototypes/continuous-world/worker/core.ts';
import { Runtime } from '../prototypes/continuous-world/worker/runtime.ts';
import { canonicalJson, sha256Hex, seedFromInput, parseImport, defaultMigrations, recordProblem, newCopyId, MAX_IMPORT_BYTES, MANUAL_KEEP_MAX, sweepable, type SnapshotRecord } from '../web/src/experimental/save-format.ts';
import { summaryOf } from '../web/src/experimental/session.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const H = 3600;

// 1. canonical round trip → restore → continue = continuous
{
  const { world: cont, events: e0 } = ExperimentWorld.create('exp-save2-node', 4242);
  const all = [...e0, ...cont.advanceTo(48 * H).events].map((e) => JSON.stringify(e)), contHash = cont.snapshot().payload_sha256;
  for (const cut of [1, 24 * H, 24 * H + 0.5, 37 * H + 123.456]) {
    const { world: a, events: ea } = ExperimentWorld.create('exp-save2-node', 4242);
    const first = [...ea, ...a.advanceTo(cut).events];
    const snap = a.snapshot();
    const stored = JSON.parse(JSON.stringify({ ...snap, payload: JSON.parse(canonicalJson(snap.payload)) })); // as the store keeps and returns it
    ok(await sha256Hex(canonicalJson(stored.payload)) === snap.payload_sha256, `cut ${cut}: store hash = Worker payload_sha256`);
    const b = ExperimentWorld.restore(stored);
    const second = b.advanceTo(48 * H).events, split = [...first, ...second].map((e) => JSON.stringify(e));
    ok(split.length === all.length && split.every((x, i) => x === all[i]), `cut ${cut}: events after canonical restore identical (${split.length})`);
    ok(b.snapshot().payload_sha256 === contHash, `cut ${cut}: 48 h payload identical`);
  }
  // snapshot after every tick (autosave / pause / manual saves) changes nothing
  const run = (snapEvery: boolean) => { let wall = 0, req = 0; const rt = new Runtime(() => wall); rt.handle({ type: 'init', req: ++req, world_id: 'exp-save2-node', seed: 7 }); rt.handle({ type: 'set_speed', req: ++req, speed: 3600 }); rt.handle({ type: 'start', req: ++req });
    for (let i = 0; i < 500; i++) { wall += 37; rt.tick(); if (snapEvery) rt.handle({ type: 'snapshot', req: ++req }); }
    rt.handle({ type: 'pause', req: ++req }); rt.handle({ type: 'step_until', req: ++req, t_sim: 30 * H }); return rt.current()!.snapshot().payload_sha256; };
  ok(run(true) === run(false), 'a snapshot after every pacing tick does not change the world');
}

// 2. save-list metadata
{
  const { world } = ExperimentWorld.create('exp-save2-meta', 1); const s = summaryOf(world.snapshot());
  ok(s.individuals === 6 && s.queens === null && s.workers === null && /沒有蟻后/.test(s.note ?? ''), 'individuals counted from the snapshot; no queen invented');
  ok(summaryOf({}).individuals === null, 'unknown stays null');
}

// 3. seed input
{
  for (let i = 0; i < 20; i++) { const r = (await seedFromInput(''))!; ok(r.how === 'random' && Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 0xffffffff, 'empty → random uint32'); }
  ok((await seedFromInput(' 42 '))!.seed === 42 && (await seedFromInput('4294967295'))!.seed === 4294967295 && (await seedFromInput('0'))!.how === 'integer', 'decimal integers kept');
  ok(await seedFromInput('4294967296') === null && await seedFromInput('99999999999999999999') === null, 'integers out of range refused');
  for (const t of ['螞蟻', 'garden-1', '-5', '3.5']) { const d = crypto.createHash('sha256').update(t, 'utf8').digest(); const r = (await seedFromInput(t))!; ok(r.how === 'text' && r.seed === d.readUInt32BE(0), `text "${t}" → SHA-256 first 4 bytes (${r.seed})`); }
}

// 4. import limits, copies
{
  const big = ' '.repeat(MAX_IMPORT_BYTES + 1);
  const r = await parseImport(big, { rules_fingerprint: 'x', engine_version: 'y', schema_version: 1 }, defaultMigrations());
  ok(!r.ok && r.code === 'import_too_large', 'oversized import refused before parsing');
  ok(/^exp-copy-[0-9a-f-]{36}$/.test(newCopyId()) && newCopyId().length <= 64, 'copy ids are exp- ids within the world-id length');
  const { world } = ExperimentWorld.create('exp-src', 3); const snap = world.snapshot();
  const payload_json = canonicalJson(snap.payload), { payload: _p, ...header } = snap;
  const rec: SnapshotRecord = { world_id: 'exp-copy-1', gen: 1, status: 'verified', written_at: 'x', header: header as SnapshotRecord['header'], payload_json, payload_sha256: snap.payload_sha256 };
  ok(await recordProblem(rec, 'exp-copy-1', 1, 'exp-src') === null, 'a copy record verifies against the source world id');
  ok(await recordProblem(rec, 'exp-copy-1', 1) === 'world_id mismatch', 'without the sim id the mismatch is detected');
  ok(MANUAL_KEEP_MAX >= 1 && sweepable([1, 2, 3, 4, 5, 6], [6, 5, 4, 2], [], 6).join() === '1,3', 'kept generations (recovery points + manual saves) are never swept');
}

// 5. static
{
  const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
  const menu = read('web/src/v62-menu.ts'), session = read('web/src/experimental/session.ts'), page = read('web/src/v62.ts');
  for (const [f, src] of [['v62-menu.ts', menu], ['session.ts', session], ['v62.ts', page]] as const) {
    ok(!/\bconfirm\s*\(|\balert\s*\(|\bprompt\s*\(/.test(src), `${f}: no window.confirm / alert / prompt (in-page confirmation only)`);
    ok(!/indexedDB|navigator\s*\.\s*(storage|locks)|localStorage/.test(src), `${f}: no storage API outside save-store.ts`);
    ok(!/\beval\s*\(|new Function/.test(src), `${f}: never executes imported data`);
  }
  ok(!/\$\{w\.name\}|\$\{w\.provenance\.source_name\}|\$\{r\.message\}/.test(menu), 'menu: stored names and messages are escaped before innerHTML');
  ok(/save-store\.ts/.test(read('prototypes/continuous-world/worker-boundary.json')), 'the store stays the only persistence module');
}
console.log(JSON.stringify({ test: 'save2-session', checks }));

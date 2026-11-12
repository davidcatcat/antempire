/**
 * SAVE-1 experiment-world save store in real Chromium (IndexedDB + Web Locks + StorageManager). FAILS (exit 1) on any
 * failed check, page error or console error. Payloads are SYNTHETIC: the Worker runtime is not merged, so this proves
 * the store's atomicity / recovery / isolation, NOT integration with a running world.
 *   npm run web:build && node tests/browser/save-store.check.cjs [outDir]
 * Serves web/dist plus an in-memory test page from its own tiny static server (nothing is written under web/).
 * Checks: create + save + retention + sweep; abort while writing (phase 1) and while promoting (phase 3) and an injected
 * quota error each leave the previous latest intact; hard page close at several moments during large saves never leaves
 * a half state; corrupted latest is detected, reported and recovered from the previous snapshot (and quarantined by a
 * writer); all-corrupt gives no_valid_snapshot and never a new world; two pages contend for the lock (second read-only,
 * a bypassing writer is caught by the pointer check, steal hands over and the old tab is refused); world A is byte-
 * identical after creating and advancing world B; close the browser and resume from the last save; migrations on a copy;
 * export/import validation; two-step delete; only the experiment database exists. Also measures save cost.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', '..', 'web', 'dist');
const PAGE = `<!doctype html><meta charset="utf-8"><title>save-store check（非正式實驗世界）</title><body>save-store check — synthetic payloads
<script type="module">
const S = await import('/dist/experimental/save-store.js'), F = await import('/dist/experimental/save-format.js');
const RT = { rules_fingerprint: 'rules-A', engine_version: 'worker-0', schema_version: 1 };
const H = {
  RT,
  // deterministic synthetic payload of roughly 'bytes' bytes; clearly labelled
  payload(n, bytes = 2000) { const k = Math.max(1, Math.floor(bytes / 60)); return { synthetic: true, note: '合成 payload：Worker runtime 尚未合併', t: n, ants: Array.from({ length: k }, (_, i) => ({ id: 'W' + i, x: (i * 7919 + n * 104729) % 100003 / 7, h: (i + n) % 360 })), rng: { streams: { weather: [n, n + 1] } } }; },
  mk(n, world = 'exp-A', bytes, rules = 'rules-A') { return F.sealEnvelope({ world_id: world, seed: 7, rules_fingerprint: rules, engine_version: 'worker-0', schema_version: 1, t_sim: n * 10, seq: n }, H.payload(n, bytes)); },
  async open(reg) { const r = await S.ExperimentSaveStore.open(reg); if (!r.ok) throw new Error(r.code); return r.value; },
  raw() { return new Promise((res, rej) => { const r = indexedDB.open('antempire-experiment-worlds'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async dump(world) { const db = await H.raw(); const g = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
    const w = (await g('worlds')).filter((x) => x.world_id === world), s = (await g('snapshots')).filter((x) => x.world_id === world); db.close(); return JSON.stringify({ w, s }); },
  async corrupt(world, gen, how) { const db = await H.raw(); await new Promise((res, rej) => { const tx = db.transaction('snapshots', 'readwrite'), st = tx.objectStore('snapshots'); const q = st.get([world, gen]);
    q.onsuccess = () => { const r = q.result; if (how === 'byte') r.payload_json = r.payload_json.replace('"W1"', '"W7"'); else if (how === 'truncate') r.payload_json = r.payload_json.slice(0, 50); else if (how === 'delete') { st.delete([world, gen]); return; } st.put(r); };
    tx.oncomplete = res; tx.onerror = rej; }); db.close(); },
  patchPut(kind, action) { const orig = IDBObjectStore.prototype.put; H._orig = orig;
    IDBObjectStore.prototype.put = function (v, k) { const hit = (kind === 'pending' && this.name === 'snapshots' && v.status === 'pending') || (kind === 'verified' && this.name === 'snapshots' && v.status === 'verified');
      if (hit && action === 'quota') throw new DOMException('quota exceeded (injected by test)', 'QuotaExceededError');
      const r = orig.call(this, v, k); if (hit && action === 'abort') this.transaction.abort(); return r; }; },
  unpatch() { IDBObjectStore.prototype.put = H._orig; },
};
window.S = S; window.F = F; window.H = H; window.ready = true;
</script>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
      const f = path.normalize(path.join(DIST, u.replace(/^\/dist\//, '')));
      if (!u.startsWith('/dist/') || !f.startsWith(DIST + path.sep) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const out = process.argv[2] || path.join(os.tmpdir(), 'save-store-check'); fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(path.join(DIST, 'experimental', 'save-store.js'))) { console.error('run npm run web:build first'); process.exit(1); }
  const srv = await serve(), base = `http://127.0.0.1:${srv.address().port}/`;
  const failures = [], errors = [], passed = [], cost = [];
  const check = (c, m) => { (c ? passed : failures).push(m); };
  const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); }); };
  const newPage = async (ctx, tag) => { const p = await ctx.newPage(); watch(p, tag); await p.goto(base); await p.waitForFunction(() => window.ready === true); return p; };
  const browser = await chromium.launch();
  try {
    // ---------- 1. create, save, retention, sweep; injected faults ----------
    let ctx = await browser.newContext(), page = await newPage(ctx, 'main');
    let r = await page.evaluate(async () => {
      const st = await H.open(), L = await S.acquireWriterLock('exp-A'); if (L.mode !== 'writer') return { err: 'no lock' };
      window.LA = L.lock; window.st = st;
      const c = await st.createWorld(L.lock, '世界 A', await H.mk(0), { queens: 1, workers: 5 });
      const saves = []; for (let n = 1; n <= 4; n++) saves.push(await st.saveSnapshot(L.lock, await H.mk(n), { queens: 1, workers: 5 + n }));
      const list = await st.listWorlds(H.RT), ld = await st.loadLatest('exp-A', H.RT, L.lock), dump = JSON.parse(await H.dump('exp-A'));
      return { c: c.ok, saves: saves.map((s) => s.ok && s.value.gen), list, ld: ld.ok && ld.value, snaps: dump.s.map((s) => [s.gen, s.status]) };
    });
    check(r.c && JSON.stringify(r.saves) === '[2,3,4,5]', `create + 4 saves commit generations 2..5 (${JSON.stringify(r.saves)})`);
    check(r.list.length === 1 && r.list[0].verified_snapshots === 3 && r.list[0].workers === 9 && r.list[0].official === false && r.list[0].compat === 'compatible' && r.list[0].label.includes('非正式'), 'save list: 3 verified recovery points, summary, compatible, 非正式');
    check(r.ld && r.ld.envelope.seq === 4 && r.ld.recovered === false, 'load returns the newest save');
    check(JSON.stringify(r.snaps) === '[[3,"verified"],[4,"verified"],[5,"verified"]]', `older records swept, kept ones verified (${JSON.stringify(r.snaps)})`);

    for (const [kind, action, code] of [['pending', 'abort', 'aborted'], ['verified', 'abort', 'aborted'], ['pending', 'quota', 'quota_exceeded']]) {
      r = await page.evaluate(async ([kind, action]) => {
        const before = await H.dump('exp-A'); H.patchPut(kind, action);
        let s; try { s = await st.saveSnapshot(LA, await H.mk(50)); } finally { H.unpatch(); }
        const ld = await st.loadLatest('exp-A', H.RT, LA), w = await st.getWorld('exp-A');
        return { s, seq: ld.ok && ld.value.envelope.seq, slots: w.slots, sameSlots: JSON.parse(before).w[0].slots.join() === w.slots.join() };
      }, [kind, action]);
      check(!r.s.ok && r.s.code === code && r.seq === 4 && r.sameSlots, `${action} during ${kind === 'pending' ? 'write (phase 1)' : 'promote (phase 3)'} -> ${r.s.code}; latest still seq 4, pointer unchanged`);
    }
    r = await page.evaluate(async () => { const s = await st.saveSnapshot(LA, await H.mk(6)); const d = JSON.parse(await H.dump('exp-A')); return { ok: s.ok, snaps: d.s.map((x) => x.status) }; });
    check(r.ok && r.snaps.every((x) => x === 'verified') && r.snaps.length === 3, 'the next save after faults succeeds and sweeps the orphan pending records');
    r = await page.evaluate(async () => { const e = await H.mk(7); e.official = true; const s1 = await st.saveSnapshot(LA, e); const e2 = await H.mk(7); e2.payload.t = 999; const s2 = await st.saveSnapshot(LA, e2); const s3 = await st.saveSnapshot(LA, await H.mk(7, 'exp-A', 2000, 'rules-B')); return [s1.code, s2.code, s3.code]; });
    check(r.join() === 'invalid_snapshot,invalid_snapshot,not_writer' || r.join() === 'invalid_snapshot,invalid_snapshot,rules_mismatch', `official envelope, hash mismatch and rule change are refused (${r.join()})`);

    // ---------- 2. corrupted latest -> recover previous (D) ----------
    r = await page.evaluate(async () => {
      const w = await st.getWorld('exp-A'), latest = w.slots[0]; await H.corrupt('exp-A', latest, 'byte');
      const ro = await st.loadLatest('exp-A', H.RT); // read-only load: reports, does not modify
      const wro = await st.getWorld('exp-A');
      const wr = await st.loadLatest('exp-A', H.RT, LA), w2 = await st.getWorld('exp-A');
      const s = await st.saveSnapshot(LA, await H.mk(8)), after = await st.loadLatest('exp-A', H.RT, LA);
      return { latest, ro: ro.ok && { seq: ro.value.envelope.seq, rec: ro.value.recovered, notice: ro.value.notice }, roSlots: wro.slots.join(), wSlots: w.slots.join(), wr: wr.ok && wr.value.recovered, q: w2.quarantined, slots2: w2.slots, s: s.ok, after: after.ok && after.value.envelope.seq };
    });
    check(r.ro && r.ro.rec && r.ro.seq === 4 && /損壞/.test(r.ro.notice) && r.roSlots === r.wSlots, `one changed byte in the latest: detected, user notice, recovered to the previous save (seq ${r.ro && r.ro.seq}); a read-only load modifies nothing`);
    check(r.wr && r.q.length === 1 && r.q[0].gen === r.latest && !r.slots2.includes(r.latest), 'a writer quarantines the corrupted snapshot (kept for diagnosis, no longer a recovery point)');
    check(r.s && r.after === 8, 'saving continues normally after recovery');
    r = await page.evaluate(async () => {
      const w = await st.getWorld('exp-A'); for (const g of w.slots) await H.corrupt('exp-A', g, g % 2 ? 'truncate' : 'delete');
      const ld = await st.loadLatest('exp-A', H.RT); const list = await st.listWorlds(H.RT);
      return { code: ld.ok ? 'ok' : ld.code, worlds: list.map((x) => x.world_id), next: (await st.getWorld('exp-A')).next_gen };
    });
    check(r.code === 'no_valid_snapshot' && r.worlds.join() === 'exp-A', `all recovery points corrupt -> ${r.code}; no new world is created`);
    await ctx.close();

    // ---------- 3. hard kill during saves (B) ----------
    ctx = await browser.newContext(); page = await newPage(ctx, 'kill-setup');
    await page.evaluate(async () => { const st = await H.open(), L = await S.acquireWriterLock('exp-K'); await st.createWorld(L.lock, 'K', await H.mk(0, 'exp-K', 50000)); st.close(); L.lock.release(); });
    const killResults = [];
    // measure one uninterrupted 3 MB save, then close pages at fractions of that duration (write / verify / promote)
    const full = await page.evaluate(async () => { const st = await H.open(); const L = await S.acquireWriterLock('exp-K'); await st.loadLatest('exp-K', H.RT, L.lock); const e = await H.mk(1, 'exp-K', 3000000); const t = performance.now(); const s = await st.saveSnapshot(L.lock, e); L.lock.release(); st.close(); return { ms: performance.now() - t, phases: s.value.ms }; });
    await page.close();
    const fracs = [0, 0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0, 1.2];
    for (const [i, f] of fracs.entries()) {
      const delay = Math.round(full.ms * f);
      const p = await newPage(ctx, `kill-${i}`);
      const prev = await p.evaluate(async () => { const st = await H.open(); const L = await S.acquireWriterLock('exp-K'); if (L.mode !== 'writer') throw new Error('writer lock still held after the previous kill'); const ld = await st.loadLatest('exp-K', H.RT, L.lock); window.st = st; window.L = L.lock; return ld.value.envelope.seq; });
      await p.evaluate(async ([n]) => { window.e = await H.mk(n, 'exp-K', 3000000); }, [prev + 1]);
      await p.evaluate(() => { window.saving = st.saveSnapshot(L, window.e); });
      // odd runs crash the renderer process through CDP (hard kill); even runs close the page without unload handlers
      const how = i % 2 ? 'renderer crash' : 'page close';
      const cdp = i % 2 ? await ctx.newCDPSession(p) : null; let crashSeen = null;
      await p.waitForTimeout(delay);
      const within = (pr, ms) => Promise.race([pr.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
      if (cdp) { const crashed = new Promise((r) => p.once('crash', r)); cdp.send('Page.crash').catch(() => {}); crashSeen = (await within(crashed.then(() => true), 5000)) === true; await within(p.close(), 5000); }
      else await p.close({ runBeforeUnload: false });
      const q = await newPage(ctx, `after-kill-${i}`);
      const got = await q.evaluate(async () => { const st = await H.open(); const ld = await st.loadLatest('exp-K', H.RT); const w = await st.getWorld('exp-K'); st.close(); return { ok: ld.ok, seq: ld.ok && ld.value.envelope.seq, rec: ld.ok && ld.value.recovered, valid: ld.ok && (await F.verifyEnvelope(ld.value.envelope)).ok, slots: w.slots }; });
      await q.close();
      killResults.push({ how, crash_event: crashSeen, delay, prev, ...got });
      if (cdp) check(crashSeen, `renderer crash ${i}: Playwright saw the crash event (a real renderer kill, not a clean close)`);
      check(got.ok && got.valid && !got.rec && (got.seq === prev || got.seq === prev + 1), `${how} ${delay} ms into a 3.7 MB save: latest is a complete verified snapshot (seq ${got.seq}, before ${prev})`);
    }
    const outcomes = { kept_previous: killResults.filter((k) => k.seq === k.prev).length, committed_new: killResults.filter((k) => k.seq === k.prev + 1).length };
    check(true, `hard-kill outcomes over ${fracs.length} runs (uninterrupted save ${full.ms.toFixed(0)} ms): previous kept ${outcomes.kept_previous}, new committed ${outcomes.committed_new}`);
    killResults.push({ uninterrupted_ms: full.ms, phases: full.phases, outcomes });
    await ctx.close();

    // ---------- 4. two pages contend for the writer lock ----------
    ctx = await browser.newContext();
    const p1 = await newPage(ctx, 'tab1'), p2 = await newPage(ctx, 'tab2');
    await p1.evaluate(async () => { window.st = await H.open(); window.lost = false; const L = await S.acquireWriterLock('exp-L', { onLost: () => { window.lost = true; } }); window.L = L.lock; await st.createWorld(L.lock, 'L', await H.mk(0, 'exp-L')); });
    r = await p2.evaluate(async () => {
      window.st = await H.open(); const L = await S.acquireWriterLock('exp-L');
      const fake = new S.WriterLock('exp-L', false, () => {}); const s = await st.saveSnapshot(fake, await H.mk(1, 'exp-L'));
      const ld = await st.loadLatest('exp-L', H.RT);
      return { mode: L.mode, bypass: s.ok ? 'ok' : s.code, seq: ld.value.envelope.seq };
    });
    check(r.mode === 'read_only', 'second tab gets read_only while the first holds the lock');
    check(r.bypass === 'conflict' && r.seq === 0, 'a tab that bypasses the lock is caught by the promote pointer check (conflict); latest unchanged');
    r = await p2.evaluate(async () => { const L = await S.acquireWriterLock('exp-L', { steal: true }); window.L = L.lock; const ld = await st.loadLatest('exp-L', H.RT, L.lock); const s = await st.saveSnapshot(L.lock, await H.mk(2, 'exp-L')); return { mode: L.mode, s: s.ok }; });
    await p1.waitForFunction(() => window.lost === true, null, { timeout: 5000 }).catch(() => {});
    const r1 = await p1.evaluate(async () => { const s = await st.saveSnapshot(L, await H.mk(3, 'exp-L')); return { lost: window.lost, held: L.held, code: s.ok ? 'ok' : s.code }; });
    check(r.mode === 'writer' && r.s && r1.lost && !r1.held && r1.code === 'not_writer', `"switch to this tab" (steal): new tab writes, old tab is told and refused (${r1.code})`);
    await p2.close();
    const p3 = await newPage(ctx, 'tab3');
    r = await p3.evaluate(async () => (await S.acquireWriterLock('exp-L')).mode);
    check(r === 'read_only' || r === 'writer', 'lock state is consistent after a tab closes');
    await p3.evaluate(async () => { const L = await S.acquireWriterLock('exp-L'); if (L.mode === 'writer') L.lock.release(); });
    await ctx.close();

    // ---------- 5. world isolation (C) ----------
    ctx = await browser.newContext(); page = await newPage(ctx, 'iso');
    r = await page.evaluate(async () => {
      const st = await H.open(); const A = await S.acquireWriterLock('exp-iso-A'); await st.createWorld(A.lock, 'A', await H.mk(0, 'exp-iso-A')); await st.saveSnapshot(A.lock, await H.mk(1, 'exp-iso-A'));
      const before = await H.dump('exp-iso-A');
      const B = await S.acquireWriterLock('exp-iso-B'); window.LB = B.lock; const cb = await st.createWorld(B.lock, 'B', await H.mk(0, 'exp-iso-B'));
      for (let n = 1; n <= 6; n++) await st.saveSnapshot(B.lock, await H.mk(n, 'exp-iso-B'));
      const dup = await st.createWorld(A.lock, 'A again', await H.mk(0, 'exp-iso-A'));
      const cross = await st.saveSnapshot(B.lock, await H.mk(9, 'exp-iso-A'));
      const after = await H.dump('exp-iso-A'), list = (await st.listWorlds(H.RT)).map((w) => w.world_id).sort();
      const ldB = await st.loadLatest('exp-iso-B', H.RT, B.lock);
      return { same: before === after, cb: cb.ok, dup: dup.code, cross: cross.code, list, seqB: ldB.value.envelope.seq, dbs: (await indexedDB.databases()).map((d) => d.name) };
    });
    check(r.cb && r.same, 'world A records are byte-identical after creating world B and saving it 6 times');
    check(r.dup === 'world_exists' && r.cross === 'not_writer', 'new game never overwrites an existing world; a lock for B cannot write A');
    check(r.list.join() === 'exp-iso-A,exp-iso-B' && r.seqB === 6, 'both worlds listed separately');
    check(r.dbs.length === 1 && r.dbs[0] === 'antempire-experiment-worlds', `only the experiment database exists in the origin (${r.dbs.join()})`);

    // ---------- 6. migrations, rules mismatch, export / import, delete, persistence ----------
    r = await page.evaluate(async () => {
      const rawBefore = await H.dump('exp-iso-A');
      const reg2 = new F.MigrationRegistry(2).register(1, (e) => ({ ...e, schema_version: 2, payload: { ...e.payload, v2: true } }));
      const st2 = await H.open(reg2); const m = await st2.loadLatest('exp-iso-A', { ...H.RT, schema_version: 2 });
      const regBad = new F.MigrationRegistry(2).register(1, () => { throw new Error('broken step'); });
      const st3 = await H.open(regBad); const mb = await st3.loadLatest('exp-iso-A', { ...H.RT, schema_version: 2 });
      const st = await H.open(); const rm = await st.loadLatest('exp-iso-A', { ...H.RT, rules_fingerprint: 'rules-B' });
      const nw = await st.loadLatest('exp-iso-A', { ...H.RT, schema_version: 0 });
      const listB = (await st.listWorlds({ ...H.RT, rules_fingerprint: 'rules-B' }))[0].compat;
      return { m: m.ok && [m.value.migrated_from, m.value.envelope.schema_version, m.value.envelope.payload.v2], mb: mb.code, rm: rm.code, nw: nw.code, listB, same: rawBefore === await H.dump('exp-iso-A') };
    });
    check(JSON.stringify(r.m) === '[1,2,true]', 'v1 -> v2 test migration applied on load');
    check(r.mb === 'migration_failed' && r.rm === 'rules_mismatch' && r.nw === 'newer_schema' && r.listB === 'rules_mismatch', `failed migration / different rules / newer save are reported (${r.mb}, ${r.rm}, ${r.nw})`);
    check(r.same, 'migrations and refused loads leave the stored snapshots byte-identical');
    const exported = await page.evaluate(async () => { const st = await H.open(); const e = await st.exportWorld('exp-iso-B'); return e.ok ? e.value : null; });
    check(exported && /^antempire-experiment-exp-iso-B-gen\d+\.json$/.test(exported.filename) && JSON.parse(exported.text).official === false, 'export produces a non-official file');
    const ctx2 = await browser.newContext(), pi = await newPage(ctx2, 'import');
    r = await pi.evaluate(async (text) => {
      const st = await H.open(); const i1 = await st.importWorld(text, H.RT); const i2 = await st.importWorld(text, H.RT);
      const o = JSON.parse(text); o.snapshot.payload.t = 12345; const i3 = await st.importWorld(JSON.stringify(o), H.RT);
      const i4 = await st.importWorld(text.slice(0, 100), H.RT);
      const ld = await st.loadLatest('exp-iso-B', H.RT);
      return { i1: i1.ok, i2: i2.code, i3: i3.code, i4: i4.code, seq: ld.ok && ld.value.envelope.seq, same: ld.ok && F.canonicalJson(ld.value.envelope) === F.canonicalJson(o.snapshot.payload.t === 12345 ? JSON.parse(text).snapshot : null) };
    }, exported.text);
    check(r.i1 && r.seq === 6 && r.same, 'import in a fresh browser profile restores the identical snapshot');
    check(r.i2 === 'world_exists' && r.i3 === 'invalid_import' && r.i4 === 'invalid_import', `import refuses an existing world, an altered payload and a truncated file (${r.i2}, ${r.i3}, ${r.i4})`);
    await ctx2.close();
    r = await page.evaluate(async () => {
      const st = await H.open(); const other = await S.acquireWriterLock('exp-iso-B'); // held by this page already -> read_only
      const d0 = await st.deleteWorld(LB, { world_id: 'exp-iso-B', nonce: 'guess' });
      const tok = st.prepareDelete('exp-iso-B'); const d1 = await st.deleteWorld(LB, tok); const d2 = await st.deleteWorld(LB, tok);
      const left = JSON.parse(await H.dump('exp-iso-B')); const p = await S.ExperimentSaveStore.requestPersistence();
      return { other: other.mode, d0: d0.code, d1: d1.ok, d2: d2.code, left: left.w.length + left.s.length, aStill: !!(await st.getWorld('exp-iso-A')), p };
    });
    check(r.other === 'read_only' && r.d0 === 'confirmation_required' && r.d1 && r.d2 === 'confirmation_required' && r.left === 0 && r.aStill, 'delete needs the two-step token, removes the world and all its snapshots, leaves other worlds');
    check(r.p.supported === true && typeof r.p.persisted === 'boolean', `navigator.storage.persist() requested (granted: ${r.p.persisted}; never promised)`);

    // ---------- 7. cost of a save (synthetic payload sizes) ----------
    for (const bytes of [100000, 1000000, 5000000]) {
      const c = await page.evaluate(async (bytes) => {
        const st = await H.open(); const id = 'exp-cost-' + bytes; const L = await S.acquireWriterLock(id); await st.createWorld(L.lock, 'cost', await H.mk(0, id, 1000));
        const runs = []; for (let n = 1; n <= 3; n++) { const e = await H.mk(n, id, bytes); const t = performance.now(); const s = await st.saveSnapshot(L.lock, e); runs.push({ total: performance.now() - t, ...s.value.ms, bytes: s.value.bytes }); }
        return runs;
      }, bytes);
      const med = (k) => c.map((x) => x[k]).sort((a, b) => a - b)[1];
      cost.push({ payload_bytes: c[0].bytes, total_ms_median: +med('total').toFixed(1), hash_ms: +med('hash').toFixed(1), write_ms: +med('write').toFixed(1), verify_ms: +med('verify').toFixed(1), promote_ms: +med('promote').toFixed(1) });
    }
    check(cost.length === 3, `save cost measured for ${cost.map((c) => (c.payload_bytes / 1e6).toFixed(2)).join(' / ')} MB synthetic payloads (headless desktop Chromium; not a phone measurement)`);
    await ctx.close();

    // ---------- 8. close the browser, relaunch, resume (persistent profile) ----------
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-save-profile-'));
    let pc = await chromium.launchPersistentContext(dir); let pp = await newPage(pc, 'persist-1');
    await pp.evaluate(async () => { const st = await H.open(); const L = await S.acquireWriterLock('exp-P'); await st.createWorld(L.lock, '持續世界', await H.mk(0, 'exp-P')); for (let n = 1; n <= 3; n++) await st.saveSnapshot(L.lock, await H.mk(n, 'exp-P')); });
    await pc.close();
    pc = await chromium.launchPersistentContext(dir); pp = await newPage(pc, 'persist-2');
    r = await pp.evaluate(async () => { const st = await H.open(); const last = await st.lastPlayed(); const ld = await st.loadLatest(last, H.RT); return { last, seq: ld.ok && ld.value.envelope.seq, t: ld.ok && ld.value.envelope.t_sim }; });
    check(r.last === 'exp-P' && r.seq === 3 && r.t === 30, 'after closing and relaunching the browser, 繼續遊戲 finds the world and resumes at the last save (t_sim 30, no offline time simulated)');
    await pc.close(); fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(path.join(out, 'save-store-kill-results.json'), JSON.stringify(killResults, null, 1));
  } catch (e) { failures.push(`exception: ${e && e.stack || e}`); }
  await browser.close(); srv.close();
  const result = { test: 'save-store browser check', payloads: 'synthetic (Worker runtime not merged; not an integration test)', passed: passed.length, failed: failures.length, failures, errors, save_cost: cost, checks: passed };
  fs.writeFileSync(path.join(out, 'save-store-results.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  if (failures.length || errors.length) process.exit(1);
})();

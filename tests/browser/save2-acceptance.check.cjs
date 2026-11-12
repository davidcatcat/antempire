/**
 * SAVE-2 / SAVE-3-style acceptance of the experiment-world menu, autosave and resume in REAL Chromium (Playwright,
 * persistent profiles = real IndexedDB on disk). NON-OFFICIAL worlds only. FAILS (exit 1) on any failed check, page
 * error or console error.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/save2-acceptance.check.cjs <outDir> http://localhost:8781/
 * Covers:
 *  - Owner minimal flow 1–10 (desktop, and the flow screens on the Pixel 7 profile): open → new game → world runs →
 *    a 30 s real-time autosave completes → close the browser context → reopen → 繼續遊戲 → resumes exactly at the
 *    last committed save → create a second world → the first world still loads independently.
 *  - A: 48 h continuous (independent Worker) vs 24 h → save → page closed (Worker terminated) → new page / new Worker
 *       → load → 24 h: every event (ids, times, data, random draws) and the full 48 h payload identical.
 *  - B: hard kill (SIGKILL of the browser processes) while saving at 3600× → reopen → the latest committed snapshot
 *       loads; every slot is a verified snapshot; no half-written state (3 kills).
 *  - C: new-game isolation: world A's stored records are byte-identical after creating, running and saving world B.
 *  - D: corrupt the latest snapshot → load warns and recovers the previous one (t > 0, never a silent Day0); all
 *       snapshots corrupt → refused with no_valid_snapshot, no world created.
 *  - E: frame-rate cap, zoom, drag, follow, speed changes, manual / pause saves → same event stream and payload hash at
 *       the same t_sim as an untouched independent run.
 *  - multi-tab: a second tab is offered 切換到此分頁 / 唯讀開啟; read-only never writes; taking over turns the first
 *    tab read-only. Rules mismatch (decision 53): refused, version difference shown, export still works. Import as copy
 *    (decision 54): new id, provenance, source unchanged, same state.
 *  - saves/ and journal/ unchanged.
 * World kind: the P0-A2 24 h individual-behaviour world (the menu's default; candidate / experiment world, non-official)
 * unless SAVE2_WORLD=synthetic selects the synthetic test world. Every reference run uses the same kind.
 * Not covered (stated, not claimed): a real phone's OS killing the page; Pixel 7 here is an emulated viewport + touch.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const LABEL = '非正式實驗世界／不屬於正式遊戲歷史';
const H = 3600;
const KIND = process.env.SAVE2_WORLD === 'synthetic' ? 'synthetic' : 'p0a2';
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);
const dirHash = (d) => { const h = crypto.createHash('sha256'); const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); } } }; walk(path.join(ROOT, d)); return h.digest('hex'); };

(async () => {
  const out = process.argv[2] || 'save2-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], info = {}, shots = [];
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const formalBefore = { saves: dirHash('saves'), journal: dirHash('journal') };
  const url = (p) => new URL(p, base).href;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-save2-'));
  const DESKTOP = { viewport: { width: 1280, height: 800 }, acceptDownloads: true }, PIXEL = { ...devices['Pixel 7'], acceptDownloads: true };

  const launch = async (dir, opts = DESKTOP) => chromium.launchPersistentContext(dir, { ...opts });
  const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${tag}: ${m.text()}`); }); };
  const openMenu = async (ctx, tag) => {
    const page = await ctx.newPage(); watch(page, tag);
    await page.goto(url('experiment.html'));
    await page.waitForSelector('#menu:not([hidden])'); await page.waitForFunction(() => document.querySelector('#mStorage').textContent.length > 0);
    // the menu has rendered the save list (it probes the Worker for each world kind's runtime first)
    await page.waitForFunction(() => document.querySelector('#mContinueInfo').textContent.length > 0, null, { timeout: 30000 });
    await page.evaluate(() => { window.__ev = []; const c = window.__v62.client, o = c.onEvents; c.onEvents = (e) => { if (e[0] && e[0].world_id !== 'exp-runtime-probe') window.__ev.push(...e.map((x) => JSON.stringify(x))); o(e); }; });
    return page;
  };
  const shot = async (page, name) => { const f = path.join(out, `save2-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };
  const newGame = async (page, name, seed) => {
    await page.click('#mNew'); await page.fill('#nName', name); await page.fill('#nSeed', String(seed)); await page.selectOption('#nWorld', KIND);
    await page.click('[data-act=create]'); await page.waitForFunction(() => window.__v62.active() && window.__v62.frame() && window.__v62.session().current);
    return page.evaluate(() => window.__v62.session().current);
  };
  const S = (page) => page.evaluate(() => ({ cur: window.__v62.session().current, save: window.__v62.saveUi(), receipt: window.__v62.session().lastReceipt, load: window.__v62.session().lastLoad, t: window.__v62.frame() && window.__v62.frame().t_sim, text: document.querySelector('#saveStatus').textContent }));
  const toMenu = async (page) => { await page.click('#menuBtn'); await page.waitForSelector('#menu:not([hidden])'); await page.waitForTimeout(300); };
  const list = (page) => page.evaluate(async () => (await window.__v62.session().list()));
  const pauseNow = async (page) => { await page.evaluate(async () => { const V = window.__v62; if (V.pacing().running) await V.client.pause(); }); };
  // independent reference run in a separate Worker (same world id and seed), never saved
  const reference = (page, world_id, seed, T) => page.evaluate(async ({ world_id, seed, T, KIND }) => {
    const { ExperimentWorkerClient } = await import('./dist/experimental/worker-client.js');
    const c = new ExperimentWorkerClient(), ev = []; c.onEvents = (e) => ev.push(...e.map((x) => JSON.stringify(x)));
    await c.init(world_id, seed, KIND); await c.stepUntil(T); const s = (await c.snapshot()).snapshot; c.terminate();
    return { events: ev, hash: s.payload_sha256, payload: JSON.stringify(s.payload) };
  }, { world_id, seed, T, KIND });
  const idbDump = (page, world_id) => page.evaluate((id) => new Promise((res, rej) => {
    const r = indexedDB.open('antempire-experiment-worlds'); r.onerror = () => rej(r.error);
    r.onsuccess = () => { const db = r.result, tx = db.transaction(['worlds', 'snapshots']); const w = tx.objectStore('worlds').get(id), s = tx.objectStore('snapshots').getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity])); tx.oncomplete = () => { db.close(); res(JSON.stringify({ w: w.result, s: s.result })); }; };
  }), world_id);
  const idbEdit = (page, world_id, fn) => page.evaluate(({ id, fn }) => new Promise((res, rej) => {
    const edit = new Function(`return (${fn})`)();
    const r = indexedDB.open('antempire-experiment-worlds'); r.onerror = () => rej(r.error);
    r.onsuccess = () => { const db = r.result, tx = db.transaction(['worlds', 'snapshots'], 'readwrite'), ws = tx.objectStore('worlds'), ss = tx.objectStore('snapshots');
      const g = ws.get(id); g.onsuccess = () => { const a = ss.getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity])); a.onsuccess = () => { const w = g.result, snaps = a.result; const o = edit(w, snaps) || {}; if (o.w) ws.put(o.w); for (const x of o.snaps || []) ss.put(x); }; };
      tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); };
  }), { id: world_id, fn: fn.toString() });

  // ======================= Owner minimal flow 1–10 (desktop) =======================
  const dirF = path.join(tmp, 'flow');
  let ctx = await launch(dirF), page = await openMenu(ctx, 'flow');
  check((await page.textContent('#menu')).includes(LABEL) && (await page.textContent('#menu')).includes('非正式'), 'flow 1: menu shows the non-official label');
  check(await page.isDisabled('#mContinue'), 'flow 1: 繼續遊戲 disabled with no save');
  check(/持久儲存：/.test(await page.textContent('#mStorage')) && /可能讓存檔消失/.test(await page.textContent('#mStorage')), 'flow 1: persistent-storage status shown; never claims saves cannot be lost');
  await shot(page, 'flow-01-menu');
  await page.click('#mNew'); await page.fill('#nName', '世界 A'); await page.fill('#nSeed', '20261108'); await page.selectOption('#nWorld', KIND); await shot(page, 'flow-02-new-game');
  const tCreate = Date.now();
  await page.click('[data-act=create]'); await page.waitForFunction(() => window.__v62.active() && window.__v62.frame() && window.__v62.session().current);
  let s = await S(page);
  const A = s.cur;
  check(/^exp-[0-9a-f-]{36}$/.test(A.world_id) && A.seed === 20261108 && A.writer, `flow 2: new world ${A.world_id}, seed 20261108, writer`);
  check(s.receipt && s.receipt.t_sim < 1 && s.save.status === 'saved', `flow 2: initial snapshot committed immediately (t=${s.receipt && s.receipt.t_sim})`);
  await page.selectOption('#speed', '60');
  await page.waitForTimeout(2500); const tRun = (await S(page)).t;
  check(tRun > 30, `flow 3: world runs (t=${tRun.toFixed(1)} s)`);
  await shot(page, 'flow-03-running');
  await page.waitForFunction(() => { const u = window.__v62.saveUi(); return u && u.reason === 'interval' && u.status === 'saved'; }, null, { timeout: 45000 });
  s = await S(page);
  check(Date.now() - tCreate >= 29000 && s.receipt.kind === 'auto' && /已儲存/.test(s.text), `flow 4: 30 s real-time autosave completed (${((Date.now() - tCreate) / 1000).toFixed(1)} s after the new game; "${s.text}")`);
  info.autosave_receipt = s.receipt;
  await shot(page, 'flow-04-autosaved');
  await ctx.close(); // flow 5: close the page / browser context (pagehide save attempt may or may not finish)
  ctx = await launch(dirF); page = await openMenu(ctx, 'flow-reopen');
  const lst = await list(page), recA = lst.find((w) => w.world_id === A.world_id);
  check(!(await page.isDisabled('#mContinue')) && (await page.textContent('#mContinueInfo')).includes('世界 A'), 'flow 6: reopened; 繼續遊戲 offers 世界 A');
  await shot(page, 'flow-05-reopened-menu');
  await page.click('#mContinue'); await page.waitForFunction(() => window.__v62.active() && window.__v62.session().lastLoad);
  s = await S(page);
  check(s.load.world_id === A.world_id && s.load.t_sim === recA.t_sim && s.load.t_sim >= info.autosave_receipt.t_sim && !s.load.recovered, `flow 7: 繼續遊戲 resumed exactly at the last committed save (t=${s.load.t_sim.toFixed(2)} s, autosave was ${info.autosave_receipt.t_sim.toFixed(2)})`);
  await shot(page, 'flow-06-resumed');
  await toMenu(page);
  const B = await newGame(page, '世界 B', '第二個世界');
  check(B.world_id !== A.world_id && B.seed !== A.seed, `flow 8: second world ${B.world_id} (text seed → ${B.seed})`);
  await page.waitForTimeout(1500); await toMenu(page);
  await page.click('#mLoad'); await page.waitForTimeout(500); await shot(page, 'flow-07-save-list');
  const lst2 = await list(page);
  check(lst2.length === 2 && lst2.every((w) => w.official === false && w.compat === 'compatible'), 'flow 9: two independent worlds listed, both non-official and compatible');
  const recA2 = lst2.find((w) => w.world_id === A.world_id);
  await page.click(`[data-act=load][data-id="${A.world_id}"]`); await page.waitForFunction((id) => window.__v62.active() && window.__v62.session().lastLoad && window.__v62.session().lastLoad.world_id === id, A.world_id);
  s = await S(page);
  check(s.load.t_sim === recA2.t_sim && s.cur.seed === A.seed, `flow 10: the first world still loads independently (t=${s.load.t_sim.toFixed(2)})`);
  await shot(page, 'flow-08-first-world-again');
  const rowText = lst2.map((w) => `${w.name}|${w.seed}|${w.sim_day}|${w.sim_clock}|${w.summary.individuals}`).join(' ; ');
  check(lst2.every((w) => (KIND === 'p0a2' ? w.summary.workers === 30 && w.summary.larvae === 8 && w.summary.individuals === 38 : w.summary.individuals === 6) && w.queens === null), `save list: individuals from snapshot metadata, no invented queen (${rowText})`);
  info.world_kind = KIND;
  if (KIND === 'p0a2') check(await page.evaluate(() => window.__v62.frame() && window.__v62.frame().world_kind === 'p0a2' && document.querySelector('#badge').textContent.includes('候選／實驗世界，非正式')), 'P0-A2 world loaded from the save list, labelled 候選／實驗世界，非正式');
  await toMenu(page);

  // ======================= C: new-game isolation =======================
  const beforeA = await idbDump(page, A.world_id);
  const C2 = await newGame(page, '世界 C', 77);
  await page.selectOption('#speed', '3600'); await page.waitForTimeout(1500);
  for (let i = 0; i < 4; i++) { await page.click('#saveBtn'); await page.waitForFunction(() => window.__v62.saveUi().status === 'saved'); await page.waitForTimeout(300); }
  await toMenu(page);
  check(await idbDump(page, A.world_id) === beforeA, `C: world A's records byte-identical after creating, running and saving world C (${C2.world_id})`);

  // ======================= D: corrupt latest → recover previous; all corrupt → refused =======================
  const wC = JSON.parse(await idbDump(page, C2.world_id)).w;
  const prevGen = wC.slots[1], prevT = JSON.parse(await idbDump(page, C2.world_id)).s.find((x) => x.gen === prevGen).header.t_sim;
  await idbEdit(page, C2.world_id, (w, snaps) => { const s0 = snaps.find((x) => x.gen === w.slots[0]); s0.payload_json = s0.payload_json.replace('"seed":', '"seed" :'); return { snaps: [s0] }; });
  await page.click('#mLoad'); await page.waitForTimeout(300);
  await page.click(`[data-act=load][data-id="${C2.world_id}"]`); await page.waitForFunction(() => window.__v62.active() && !document.querySelector('#notice').hidden);
  s = await S(page);
  const notice = await page.textContent('#notice');
  check(s.load.recovered && s.load.gen === prevGen && s.load.t_sim === prevT && s.load.t_sim > 0 && /最新存檔損壞/.test(notice), `D: corrupt latest detected, user warned, previous snapshot (gen ${prevGen}, t=${prevT.toFixed(1)}) recovered — not Day0`);
  await shot(page, 'D-recovered-notice');
  await toMenu(page);
  const nWorlds = (await list(page)).length;
  await idbEdit(page, C2.world_id, (w, snaps) => ({ snaps: snaps.map((x) => ({ ...x, payload_json: x.payload_json + ' ' })) }));
  await page.click('#mLoad'); await page.waitForTimeout(300);
  await page.click(`[data-act=load][data-id="${C2.world_id}"]`); await page.waitForTimeout(1200);
  const msg = await page.textContent('#mMsg');
  check(/no_valid_snapshot/.test(msg) && !(await page.evaluate(() => window.__v62.active())) && (await list(page)).length === nWorlds, 'D: all snapshots corrupt → refused (no_valid_snapshot), no silent Day0, no world created');
  await shot(page, 'D-all-corrupt-refused');

  // ======================= rules mismatch (decision 53) and import as copy (decision 54) =======================
  const RM = 'exp-rules-mismatch-demo';
  await page.evaluate(async ({ src, id }) => {
    const r = indexedDB.open('antempire-experiment-worlds'); await new Promise((ok) => { r.onsuccess = ok; });
    const db = r.result, tx = db.transaction(['worlds', 'snapshots'], 'readwrite'), ws = tx.objectStore('worlds'), ss = tx.objectStore('snapshots');
    const w = await new Promise((ok) => { const g = ws.get(src); g.onsuccess = () => ok(g.result); });
    const sn = await new Promise((ok) => { const g = ss.getAll(IDBKeyRange.bound([src, -Infinity], [src, Infinity])); g.onsuccess = () => ok(g.result); });
    ws.put({ ...w, world_id: id, sim_world_id: src, name: '規則不同的舊世界（測試）', rules_fingerprint: 'f'.repeat(64), engine_version: 'experiment-world-OLD' });
    for (const x of sn) ss.put({ ...x, world_id: id, header: { ...x.header, rules_fingerprint: 'f'.repeat(64), engine_version: 'experiment-world-OLD' } });
    await new Promise((ok) => { tx.oncomplete = ok; }); db.close();
  }, { src: A.world_id, id: RM });
  await page.click('#mLoad'); await page.waitForTimeout(400);
  const rmRow = await page.textContent(`.mrow[data-world="${RM}"]`);
  check(/規則不同，無法繼續/.test(rmRow) && /experiment-world-OLD/.test(rmRow) && /目前：規則指紋/.test(rmRow) && await page.isDisabled(`[data-act=load][data-id="${RM}"]`), 'decision 53: rules mismatch refused in the list with the version difference shown');
  await shot(page, 'rules-mismatch');
  await page.click('#mManage'); await page.waitForTimeout(400);
  let dl = page.waitForEvent('download'); await page.click(`[data-act=export][data-id="${A.world_id}"]`); let d = await dl;
  const exportPath = path.join(tmp, 'exportA.json'); await d.saveAs(exportPath);
  check(JSON.parse(fs.readFileSync(exportPath, 'utf8')).official === false, 'export downloads a non-official backup file');
  dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null); await page.click(`[data-act=export][data-id="${RM}"]`); d = await dl;
  check(!!d || /匯出/.test(await page.textContent('#mMsg')), 'decision 53: an incompatible world can still be exported');
  const beforeA2 = await idbDump(page, A.world_id);
  await page.setInputFiles('#importFile', exportPath); await page.click('[data-act=import]'); await page.waitForTimeout(800);
  check(/已存在/.test(await page.textContent('#mMsg')), 'import of an existing world refused (never overwrites) and 匯入為副本 offered');
  await shot(page, 'import-exists-offer-copy');
  await page.click('[data-act=importcopy]'); await page.waitForTimeout(1000);
  const lst3 = await list(page), copy = lst3.find((w) => w.provenance && w.provenance.source_world_id === A.world_id);
  check(!!copy && /^exp-copy-/.test(copy.world_id) && copy.sim_world_id === A.world_id && copy.provenance.source_payload_sha256.length === 64 && /不是真實性證明/.test(copy.provenance.verification), `decision 54: imported as copy ${copy && copy.world_id} with provenance`);
  check(await idbDump(page, A.world_id) === beforeA2, 'import as copy left the source world unchanged');
  await shot(page, 'manage-with-copy');
  await page.click('#mLoad'); await page.waitForTimeout(300);
  await page.click(`[data-act=load][data-id="${copy.world_id}"]`); await page.waitForFunction((id) => window.__v62.active() && window.__v62.session().lastLoad && window.__v62.session().lastLoad.world_id === id, copy.world_id);
  s = await S(page);
  check(s.load.t_sim === lst3.find((w) => w.world_id === A.world_id).t_sim && s.cur.sim_world_id === A.world_id, 'the copy loads the same state as the source (world state unchanged)');
  await toMenu(page);
  // two-step delete (in-page)
  await page.click('#mManage'); await page.waitForTimeout(300);
  await page.click(`[data-act=delete1][data-id="${RM}"]`); await page.waitForTimeout(300);
  check(/確定刪除/.test(await page.textContent(`.mrow[data-world="${RM}"]`)) && (await list(page)).some((w) => w.world_id === RM), 'delete step 1 shows an in-page confirmation and deletes nothing');
  await shot(page, 'delete-confirm');
  await page.click(`[data-act=delete2][data-id="${RM}"]`); await page.waitForTimeout(500);
  check(!(await list(page)).some((w) => w.world_id === RM), 'delete step 2 removes the world');
  // rename
  await page.fill(`input.rename[data-id="${B.world_id}"]`, '世界 B（改名）'); await page.click(`[data-act=rename][data-id="${B.world_id}"]`); await page.waitForTimeout(400);
  check((await list(page)).find((w) => w.world_id === B.world_id).name === '世界 B（改名）', 'rename');

  // ======================= multi-tab =======================
  await page.click('#mLoad'); await page.waitForTimeout(300);
  await page.click(`[data-act=load][data-id="${A.world_id}"]`); await page.waitForFunction(() => window.__v62.active());
  const p2 = await openMenu(ctx, 'tab2');
  await p2.click('#mLoad'); await p2.waitForTimeout(300); await p2.click(`[data-act=load][data-id="${A.world_id}"]`); await p2.waitForTimeout(800);
  check(/另一個分頁正在使用/.test(await p2.textContent('#mMsg')), 'multi-tab: second tab is told another tab is writing and offered switch / read-only');
  await shot(p2, 'tab2-offer');
  await p2.click('[data-act=readonly]'); await p2.waitForFunction(() => window.__v62.active());
  check(!(await p2.isHidden('#roBanner')) && await p2.isDisabled('#saveBtn') && !(await p2.evaluate(() => window.__v62.session().current.writer)), 'multi-tab: read-only tab shows the banner and cannot save');
  await shot(p2, 'tab2-read-only');
  await p2.evaluate(async () => { await window.__v62.session().leave(true); });
  await p2.goto(url('experiment.html')); await p2.waitForSelector('#menu:not([hidden])');
  await p2.click('#mLoad'); await p2.waitForTimeout(300); await p2.click(`[data-act=load][data-id="${A.world_id}"]`); await p2.waitForTimeout(600);
  await p2.click('[data-act=steal]'); await p2.waitForFunction(() => window.__v62.active() && window.__v62.session().current.writer);
  await page.waitForFunction(() => !document.querySelector('#roBanner').hidden, null, { timeout: 5000 }).catch(() => {});
  const t1 = await page.evaluate(() => ({ writer: window.__v62.session().current && window.__v62.session().current.writer, ro: !document.querySelector('#roBanner').hidden }));
  check(!t1.writer && t1.ro, 'multi-tab: 切換到此分頁 takes over; the first tab turns read-only');
  await shot(page, 'tab1-lost-lock');
  await p2.close(); await page.close(); await ctx.close();

  // ======================= A: 24 h → save → new Worker → load → 24 h = 48 h continuous =======================
  const dirA = path.join(tmp, 'A');
  ctx = await launch(dirA); page = await openMenu(ctx, 'A1');
  const WA = await newGame(page, '測試 A', 4242);
  await pauseNow(page);
  await page.evaluate(async (T) => { await window.__v62.client.stepUntil(T); }, 24 * H);
  await page.click('#saveBtn'); await page.waitForFunction(() => window.__v62.saveUi().status === 'saved' && window.__v62.session().lastReceipt.kind === 'manual');
  const r24 = (await S(page)).receipt;
  const evFirst = await page.evaluate(() => window.__ev.slice());
  await page.close(); // the page and its Worker are gone
  page = await openMenu(ctx, 'A2');
  await page.click('#mContinue'); await page.waitForFunction(() => window.__v62.active() && window.__v62.session().lastLoad);
  await pauseNow(page);
  const loadA = (await S(page)).load;
  await page.evaluate(async (T) => { await window.__v62.client.stepUntil(T); }, 48 * H);
  const resumed = await page.evaluate(async () => { const s = (await window.__v62.client.snapshot()).snapshot; return { ev: window.__ev.slice(), hash: s.payload_sha256, payload: JSON.stringify(s.payload) }; });
  const ref = await reference(page, WA.world_id, 4242, 48 * H);
  const split = [...evFirst.filter((e) => JSON.parse(e).seq < loadA.seq), ...resumed.ev];
  const sameEv = split.length === ref.events.length && split.every((e, i) => e === ref.events[i]);
  check(r24.t_sim === 24 * H && loadA.t_sim === 24 * H, `A: saved and loaded at exactly 24 h (gen ${loadA.gen}, seq ${loadA.seq})`);
  check(sameEv, `A: event stream (ids, exact times, data, random draws) identical — ${split.length} vs ${ref.events.length} events`);
  check(resumed.hash === ref.hash && canon(JSON.parse(resumed.payload)) === canon(JSON.parse(ref.payload)), `A: full 48 h state identical (payload incl. random streams, queue, ledgers; sha256 ${ref.hash.slice(0, 12)}…)`);
  info.testA = { events: ref.events.length, payload_sha256: ref.hash, save_bytes: r24.bytes, save_ms: r24.ms };
  await page.close(); await ctx.close();

  // ======================= E: UI operations and saving do not change results =======================
  ctx = await launch(path.join(tmp, 'E')); page = await openMenu(ctx, 'E');
  const WE = await newGame(page, '測試 E', 9001);
  await page.selectOption('#speed', '3600'); await page.waitForTimeout(600);
  await page.mouse.move(640, 400); await page.mouse.wheel(0, -300); await page.mouse.down(); await page.mouse.move(760, 460, { steps: 5 }); await page.mouse.up();
  await page.selectOption('#fpsCap', '15'); await page.selectOption('#follow', KIND === 'p0a2' ? 'w004' : 'w04');
  for (let i = 0; i < 3; i++) { await page.click('#saveBtn'); await page.waitForTimeout(400); }
  await page.click('#play'); await page.waitForTimeout(500); await page.click('#play'); // pause (saves) and resume
  await page.selectOption('#speed', '600'); await page.selectOption('#fpsCap', '30'); await page.click('#zoomIn'); await page.waitForTimeout(700);
  await page.selectOption('#speed', '3600'); await page.waitForTimeout(800); await page.selectOption('#follow', '');
  await page.click('#play'); await page.waitForFunction(() => window.__v62.saveUi().status !== 'saving');
  const eRes = await page.evaluate(async () => { const V = window.__v62; await new Promise((r) => setTimeout(r, 300)); const t0 = V.frame().t_sim; const T = Math.ceil(t0 / 3600) * 3600 + 3600.25; await V.client.stepUntil(T); const s = (await V.client.snapshot()).snapshot; return { t0, T, ev: window.__ev.slice(), hash: s.payload_sha256, saves: V.session().lastReceipt }; });
  const refE = await reference(page, WE.world_id, 9001, eRes.T);
  check(eRes.ev.length === refE.events.length && eRes.ev.every((e, i) => e === refE.events[i]) && eRes.hash === refE.hash, `E: zoom, drag, follow, FPS cap, speeds, pause and ${eRes.saves ? 'manual/pause' : ''} saves → identical events (${eRes.ev.length}) and payload hash at t=${eRes.T}`);
  await page.close(); await ctx.close();

  // ======================= B: hard kill while saving =======================
  const dirB = path.join(tmp, 'B');
  ctx = await launch(dirB); page = await openMenu(ctx, 'B0');
  const WB = await newGame(page, '測試 B', 31337); await page.selectOption('#speed', '3600');
  await page.close(); await ctx.close();
  const killed = [];
  for (let k = 0; k < 3; k++) {
    ctx = await launch(dirB); page = await openMenu(ctx, `B${k + 1}`);
    await page.click('#mContinue'); await page.waitForFunction(() => window.__v62.active() && window.__v62.session().lastLoad);
    const ld = (await S(page)).load;
    const okLoad = await page.evaluate(async (id) => { const st = window.__v62.session().store; const w = await st.getWorld(id); const d = await new Promise((res) => { const r = indexedDB.open('antempire-experiment-worlds'); r.onsuccess = () => { const db = r.result, g = db.transaction('snapshots').objectStore('snapshots').getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity])); g.onsuccess = () => { db.close(); res(g.result); }; }; }); return { slotsVerified: w.slots.every((g) => d.find((x) => x.gen === g && x.status === 'verified')), t: w.t_sim, latest: w.slots[0] }; }, WB.world_id);
    check(okLoad.slotsVerified && ld.gen === okLoad.latest && ld.t_sim === okLoad.t && !ld.recovered, `B${k + 1}: after ${k ? 'SIGKILL' : 'close'} the latest committed snapshot loads (gen ${ld.gen}, t=${ld.t_sim.toFixed(0)}); every slot verified`);
    await page.selectOption('#speed', '3600');
    // save repeatedly and kill the whole browser at a random moment (possibly mid-transaction)
    await page.evaluate(() => { window.__spam = setInterval(() => { void window.__v62.session().request('manual'); }, 120); });
    await page.waitForTimeout(800 + Math.floor(Math.random() * 1500));
    const pids = execSync(`pgrep -f -- "${dirB}" || true`).toString().trim().split(/\s+/).filter(Boolean);
    for (const p of pids) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } }
    killed.push(pids.length);
    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  }
  ctx = await launch(dirB); page = await openMenu(ctx, 'B-final');
  await page.click('#mContinue'); await page.waitForFunction(() => window.__v62.active() && window.__v62.session().lastLoad);
  const ldB = (await S(page)).load;
  check(ldB.world_id === WB.world_id && ldB.t_sim > 0 && !ldB.recovered, `B: after 3 hard kills (${killed.join('/')} processes) the world resumes from its last committed snapshot (t=${ldB.t_sim.toFixed(0)})`);
  // the manual-save cap (decision 55: manual saves are kept, never rotated; the cap refuses instead)
  const ms = await page.evaluate(async () => { const st = window.__v62.session(); const w = await st.store.getWorld(st.current.world_id); return { manual: (w.manual || []).length, slots: w.slots.length }; });
  check(ms.slots <= 3 && ms.manual >= 1, `decision 55: 3 rotating recovery points kept separately from ${ms.manual} manual saves`);
  await page.close(); await ctx.close();

  // ======================= Pixel 7 screens =======================
  ctx = await launch(path.join(tmp, 'pixel'), PIXEL); page = await openMenu(ctx, 'pixel7');
  await shot(page, 'pixel7-01-menu');
  await page.tap('#mNew'); await page.fill('#nName', '手機世界'); await page.selectOption('#nWorld', KIND); await shot(page, 'pixel7-02-new-game');
  await page.tap('[data-act=create]'); await page.waitForFunction(() => window.__v62.active() && window.__v62.frame());
  await page.selectOption('#speed', '600'); await page.waitForTimeout(2000); await page.tap('#saveBtn'); await page.waitForFunction(() => window.__v62.saveUi().status === 'saved' && window.__v62.session().lastReceipt.kind === 'manual');
  await shot(page, 'pixel7-03-world-saved');
  await page.tap('#menuBtn'); await page.waitForSelector('#menu:not([hidden])'); await page.tap('#mManage'); await page.waitForTimeout(500);
  await shot(page, 'pixel7-04-manage');
  check((await list(page)).length === 1, 'pixel7: new game, manual save and menu work with touch');
  await page.close(); await ctx.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  check(dirHash('saves') === formalBefore.saves && dirHash('journal') === formalBefore.journal, 'saves/ and journal/ unchanged');
  check(errors.length === 0, `no page or console errors (${errors.slice(0, 3).join(' | ')})`);
  console.log(JSON.stringify({ test: 'save2-acceptance-browser', passed: passed.length, failed: failures, info, screenshots: shots.map((x) => path.basename(x)), passed_checks: passed }, null, 1));
  if (failures.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });

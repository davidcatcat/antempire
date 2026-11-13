/**
 * Issue #224 browser check (real Chromium, persistent profile; non-official experiment worlds only):
 *  A. a saved world exists; the page is reopened with the Worker script answering 404 (fault injection: e.g. a missing
 *     asset or an offline first load). The menu must show an error state within seconds (not wait forever), keep the
 *     save listed and exportable (download contains the world), refuse 繼續遊戲, and 開始新遊戲 must end with
 *     worker_failed without creating a world.
 *  B. a working world whose Worker is terminated while playing: 回到選單 must return to the menu with the failed save
 *     reported (worker_failed), the lock released, and the earlier save kept.
 * saves/ and journal/ stay byte-identical.
 * Usage: node tests/browser/worker-fatal.check.cjs <out-dir> <base-url>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const dirHash = (d) => { const h = crypto.createHash('sha256'); const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); } } }; walk(path.join(ROOT, d)); return h.digest('hex'); };
const WORKER_SCRIPT = '**/worker-dist/prototypes/continuous-world/worker/entry.js';

(async () => {
  const out = process.argv[2] || 'worker-fatal-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], info = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const formalBefore = { saves: dirHash('saves'), journal: dirHash('journal') };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-worker-fatal-'));
  const contexts = [];
  const launch = async (dir) => { const c = await chromium.launchPersistentContext(dir, { viewport: { width: 1280, height: 800 }, acceptDownloads: true }); contexts.push(c); return c; };
  const msg = (page) => page.evaluate(() => ({ text: document.querySelector('#mMsg').textContent, kind: document.querySelector('#mMsg').dataset.kind }));
  try {
    const dir = path.join(tmp, 'profile');
    // a saved synthetic world (fast) with a working Worker
    let ctx = await launch(dir), page = await ctx.newPage();
    await page.goto(new URL('experiment.html', base).href);
    await page.waitForSelector('#menu:not([hidden])');
    await page.click('#mNew'); await page.fill('#nName', '致命錯誤測試'); await page.fill('#nSeed', '7'); await page.selectOption('#nWorld', 'synthetic');
    await page.click('[data-act=create]');
    await page.waitForFunction(() => window.__v62.active() && window.__v62.session().current && window.__v62.session().lastReceipt, null, { timeout: 30000 });
    const worldId = await page.evaluate(() => window.__v62.session().current.world_id);

    // B. terminate the Worker while playing, then 回到選單
    await page.evaluate(() => window.__v62.client.terminate());
    const t0 = Date.now();
    await page.click('#menuBtn');
    const backB = await page.waitForSelector('#menu:not([hidden])', { timeout: 15000 }).then(() => true, () => false);
    // the menu then finds the Worker down; the failed-save message must stay visible alongside
    await page.waitForFunction(() => document.querySelector('#menu').dataset.workerDown === 'true', null, { timeout: 15000 }).catch(() => {});
    const mB = await msg(page);
    info.B = { ms: Date.now() - t0, message: mB };
    check(backB, `B: 回到選單 returns after the Worker was terminated (${Date.now() - t0} ms)`);
    check(mB.kind === 'error' && /worker_failed/.test(mB.text) && /WORKER_TERMINATED/.test(mB.text), `B: the failed save is reported (${mB.text.slice(0, 120)})`);
    check(/離開前的儲存失敗/.test(mB.text) && /無法開始新遊戲或讀取存檔/.test(mB.text), 'B: the menu keeps the failed-save message and adds the Worker-down state');
    check(await page.evaluate(() => window.__v62.session().current === null), 'B: the session is cleared (lock released)');
    await page.screenshot({ path: path.join(out, 'worker-fatal-B-menu.png') });
    await ctx.close();

    // A. reopen with the Worker script answering 404
    ctx = await launch(dir);
    let workerRequests = 0;
    await ctx.route(WORKER_SCRIPT, (r) => { workerRequests++; return r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found (fault injection)' }); });
    page = await ctx.newPage();
    const t1 = Date.now();
    await page.goto(new URL('experiment.html', base).href);
    await page.waitForSelector('#menu:not([hidden])');
    const shown = await page.waitForFunction(() => document.querySelector('#menu').dataset.workerDown === 'true' && document.querySelector('#mMsg').dataset.kind === 'error', null, { timeout: 15000 }).then(() => true, () => false);
    const mA = await msg(page);
    info.A = { ms: Date.now() - t1, worker_requests_404: workerRequests, message: mA, protocolErrors: await page.evaluate(() => window.__v62.protocolErrors.slice()) };
    check(workerRequests >= 1, `A: the Worker script request was intercepted (${workerRequests})`);
    check(shown && /Worker/.test(mA.text), `A: the menu shows an error state instead of waiting (${Date.now() - t1} ms: ${mA.text.slice(0, 120)})`);
    check(await page.evaluate(() => document.querySelector('#mContinue').disabled), 'A: 繼續遊戲 is disabled');
    await page.screenshot({ path: path.join(out, 'worker-fatal-A-menu.png') });
    // save management: the world is listed (not loadable) and exportable
    await page.click('#mManage');
    await page.waitForSelector(`[data-world="${worldId}"]`, { timeout: 15000 });
    const row = await page.evaluate((id) => document.querySelector(`[data-world="${id}"]`).textContent, worldId);
    check(/模擬 Worker 已停止/.test(row) && !/規則不同/.test(row), 'A: the stored world is listed with unknown compatibility (never 規則不同)');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click(`[data-act=export][data-id="${worldId}"]`)]);
    const text = fs.readFileSync(await dl.path(), 'utf8'), exp = JSON.parse(text);
    info.A.export = { filename: dl.suggestedFilename(), bytes: text.length };
    check(exp.world && exp.world.world_id === worldId && exp.snapshot && exp.snapshot.official === false, 'A: the stored world is exported intact while the Worker is down');
    await page.screenshot({ path: path.join(out, 'worker-fatal-A-manage.png') });
    // 開始新遊戲 ends with worker_failed; no world is created
    const before = await page.evaluate(async () => (await window.__v62.session().store.listWorlds({ rules_fingerprint: '-', engine_version: '-', schema_version: 1 })).length);
    await page.click('#mNew'); await page.fill('#nName', '不應建立'); await page.selectOption('#nWorld', 'synthetic');
    await page.click('[data-act=create]');
    const failedNew = await page.waitForFunction(() => /worker_failed/.test(document.querySelector('#mMsg').textContent), null, { timeout: 15000 }).then(() => true, () => false);
    const after = await page.evaluate(async () => (await window.__v62.session().store.listWorlds({ rules_fingerprint: '-', engine_version: '-', schema_version: 1 })).length);
    check(failedNew && after === before && await page.evaluate(() => window.__v62.session().current === null && !window.__v62.active()), `A: 開始新遊戲 ends with worker_failed, no world created (${before} → ${after})`);
    await page.screenshot({ path: path.join(out, 'worker-fatal-A-new.png') });
    await ctx.close();
  } catch (e) {
    failures.push(`exception: ${e.stack || e}`);
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const formalAfter = { saves: dirHash('saves'), journal: dirHash('journal') };
  check(formalAfter.saves === formalBefore.saves && formalAfter.journal === formalBefore.journal, 'saves/ and journal/ unchanged');
  console.log(JSON.stringify({ check: 'worker-fatal', passed: passed.length, failures, info }, null, 1));
  process.exit(failures.length ? 1 : 0);
})();

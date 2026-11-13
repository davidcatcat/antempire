/**
 * SAVE-2 regression (session list race): worlds of BOTH kinds saved in one browser profile stay listed as compatible and
 * resumable after the page is reopened. Non-official experiment worlds; real Chromium, persistent profile.
 * A fresh page has no cached runtime info, so the menu's first list() probes the Worker for every world kind; before the
 * fix the two probes overlapped on the single Worker and both read the world created last, so a saved synthetic world
 * showed 「規則不同，無法繼續」 and 繼續遊戲 was disabled (tests/save2-session.test.ts section 6 is the Node-level test).
 * Short by design (seconds): the full Owner flow stays in save2-acceptance.check.cjs (p0a2 in CI; SAVE2_WORLD=synthetic).
 * Usage: node tests/browser/save2-world-kinds.check.cjs <out-dir> <base-url>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const KINDS = ['synthetic', 'p0a2'];
const dirHash = (d) => { const h = crypto.createHash('sha256'); const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); } } }; walk(path.join(ROOT, d)); return h.digest('hex'); };

(async () => {
  const out = process.argv[2] || 'save2-kinds-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], info = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const formalBefore = { saves: dirHash('saves'), journal: dirHash('journal') };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-save2-kinds-'));
  const contexts = [];
  const launch = async (dir) => { const c = await chromium.launchPersistentContext(dir, { viewport: { width: 1280, height: 800 } }); contexts.push(c); return c; };
  const openMenu = async (ctx, tag) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${tag}: ${m.text()}`); });
    await page.goto(new URL('experiment.html', base).href);
    await page.waitForSelector('#menu:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#mContinueInfo').textContent.length > 0, null, { timeout: 30000 });
    return page;
  };
  const newGame = async (page, name, kind) => {
    await page.click('#mNew'); await page.fill('#nName', name); await page.fill('#nSeed', '7'); await page.selectOption('#nWorld', kind);
    await page.click('[data-act=create]'); await page.waitForFunction(() => window.__v62.active() && window.__v62.session().current && window.__v62.session().lastReceipt, null, { timeout: 30000 });
    const cur = await page.evaluate(() => window.__v62.session().current);
    await page.click('#menuBtn'); await page.waitForSelector('#menu:not([hidden])'); await page.waitForFunction(() => !window.__v62.session().current);
    return cur;
  };
  try {
    // one profile per creation order: the world created last is the one 繼續遊戲 offers
    for (const order of [KINDS, [...KINDS].reverse()]) {
      const tag = order.join('-then-'), dir = path.join(tmp, tag);
      let ctx = await launch(dir), page = await openMenu(ctx, `${tag} first`);
      const ids = {};
      for (const k of order) ids[k] = (await newGame(page, `世界 ${k}`, k)).world_id;
      await ctx.close();
      // a fresh page: empty runtime-info cache, the menu probes both kinds
      ctx = await launch(dir); page = await openMenu(ctx, `${tag} reopened`);
      const rt = await page.evaluate(async (ks) => { const S = window.__v62.session(), o = {}; for (const k of ks) o[k] = await S.runtimeInfo(k); return o; }, KINDS);
      info[`${tag}_engine_versions`] = Object.fromEntries(KINDS.map((k) => [k, rt[k].engine_version]));
      check(rt.synthetic.engine_version !== rt.p0a2.engine_version && rt.synthetic.rules_fingerprint !== rt.p0a2.rules_fingerprint, `${tag}: reopened page probed each kind from its own world (${rt.synthetic.engine_version} / ${rt.p0a2.engine_version})`);
      const lst = await page.evaluate(async () => (await window.__v62.session().list()).map((w) => ({ world_id: w.world_id, t_sim: w.t_sim, compat: w.compat, engine_version: w.engine_version, official: w.official })));
      for (const k of KINDS) {
        const w = lst.find((x) => x.world_id === ids[k]);
        check(!!w && w.compat === 'compatible' && w.official === false && w.engine_version === rt[k].engine_version, `${tag}: saved ${k} world listed as compatible after reopening (${w && w.compat})`);
      }
      const last = order[order.length - 1];
      check(!(await page.isDisabled('#mContinue')) && (await page.textContent('#mContinueInfo')).includes(`世界 ${last}`), `${tag}: 繼續遊戲 enabled and offers the last world (${last}): "${await page.textContent('#mContinueInfo')}"`);
      for (const k of KINDS) {
        const r = await page.evaluate(async (id) => { const r = await window.__v62.session().open(id); return r.ok ? { ok: true, load: window.__v62.session().lastLoad } : { ok: false, code: r.code, message: r.message }; }, ids[k]);
        check(r.ok && r.load.world_id === ids[k] && r.load.t_sim === lst.find((x) => x.world_id === ids[k]).t_sim && !r.load.recovered, `${tag}: saved ${k} world opens at its last save (${r.ok ? `t=${r.load.t_sim}` : `${r.code}: ${r.message}`})`);
        await page.evaluate(() => window.__v62.session().leave(false));
      }
      await page.screenshot({ path: path.join(out, `save2-kinds-${tag}-reopened.png`) });
      await ctx.close();
    }
  } catch (e) { check(false, `unexpected error: ${e && e.stack || e}`); }
  for (const c of contexts) await c.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  check(dirHash('saves') === formalBefore.saves && dirHash('journal') === formalBefore.journal, 'saves/ and journal/ unchanged');
  check(errors.length === 0, `no page or console errors (${errors.slice(0, 3).join(' | ')})`);
  console.log(JSON.stringify({ test: 'save2-world-kinds-browser', passed: passed.length, failed: failures, info, passed_checks: passed }, null, 1));
  process.exit(failures.length ? 1 : 0);
})();

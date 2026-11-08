/**
 * Natural-walk display animation: browser checks, close-up screenshots and frame rates (desktop 1280x800, Pixel 7).
 *   npm run natural:shoot        (builds the page and web/, serves both read-only, writes screenshots/ + results.json)
 * Part 1 — viewing page (prototypes/natural-walk): four scenes load, data source labelled (PR A physics or 示意
 *   placeholder), display animation labelled, same time → same display state, zoomed close-ups per scene.
 * Part 2 — game view (web/): micro-motion state present for on-screen ants, the data panel names the display
 *   animation, close-up of a followed ant at 1× speed, frame rate at the default view and in close-up.
 * FAILS (exit 1) on page errors, console errors (other than the optional data/ probes answering 404) or failed checks.
 * Headless Chromium (software rendering): frame rates are indicative, not a real device.
 */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const { chromium, devices } = require('playwright');
const REPO = path.resolve(__dirname, '../..'), OUT = path.join(__dirname, 'screenshots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
fs.mkdirSync(OUT, { recursive: true });
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]), f = path.normalize(path.join(REPO, u));
  if (!u.startsWith('/prototypes/natural-walk/') || !f.startsWith(REPO) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const failures = [], passed = [], results = { page: {}, game: {} };
const check = (c, m) => (c ? passed : failures).push(m);
const profiles = [['desktop', { viewport: { width: 1280, height: 800 } }], ['pixel7', { ...devices['Pixel 7'] }]];
const watch = (page, tag, errors) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(`${tag}: ${m.text()}`); }); };

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/prototypes/natural-walk/index.html`;
  const gamePort = Number(process.env.GAME_PORT || 8793), game = spawn(process.execPath, [path.join(REPO, 'cli/web-serve.ts'), String(gamePort)], { cwd: REPO, stdio: 'ignore' });
  const browser = await chromium.launch(), errors = [];
  try {
    // ---------------------------------------------------------------- part 1: viewing page
    for (const [tag, opt] of process.env.SKIP_PAGE ? [] : profiles) {
      const ctx = await browser.newContext(opt), page = await ctx.newPage(); watch(page, tag, errors);
      await page.goto(base); await page.waitForFunction(() => window.__nw && window.__nw.ready(), null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => window.__nw.info());
      check(info.length === 4 && info.every((p) => p.file), `${tag}: four scenes, each with a pose stream`);
      const text = await page.textContent('body');
      check(/物理資料/.test(text) && /顯示動畫（示意）/.test(text) && /不是感覺事件/.test(text), `${tag}: physics data and display animation labelled separately; display ≠ perception`);
      if (info.some((p) => p.source === 'placeholder')) check(/示意・待 PR A 物理資料/.test(text), `${tag}: placeholder trajectories labelled 示意・待 PR A 物理資料`);
      await page.evaluate(() => { window.__nw.resetFps(); }); await page.waitForTimeout(4000);
      results.page[tag] = { fps: await page.evaluate(() => window.__nw.fps()), sources: info.map((p) => `${p.slot}:${p.source}`) };
      // determinism: pause, set the same time twice → identical display state
      await page.evaluate(() => { window.__nw.pause(); window.__nw.setTime(4.37); });
      await page.waitForTimeout(150); const a = await page.evaluate(() => JSON.stringify(window.__nw.info().map((p) => p.last)));
      await page.evaluate(() => window.__nw.setTime(1.0)); await page.waitForTimeout(150);
      await page.evaluate(() => window.__nw.setTime(4.37)); await page.waitForTimeout(150); const b = await page.evaluate(() => JSON.stringify(window.__nw.info().map((p) => p.last)));
      check(a === b, `${tag}: same time → identical body pose and display state (any frame history)`);
      await page.evaluate(() => window.__nw.setTime(3.2)); await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${tag}-page-overview.png`), fullPage: true });
      // close-ups: each scene zoomed on its ant at a moment of interest
      for (const [slot, tt, z] of [['straight', 4.0, 4], ['trail', 3.1, 5], ['explore', 5.6, 4], ['obstacle', 1.3, 4]]) {
        await page.evaluate(([s, x, zz]) => { window.__nw.setZoom(s, zz); window.__nw.setTime(x); }, [slot, tt, z]); await page.waitForTimeout(250);
        const el = await page.$(`section[data-slot="${slot}"]`); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: path.join(OUT, `${tag}-page-${slot}-closeup.png`) });
      }
      await ctx.close();
    }
    // ---------------------------------------------------------------- part 2: game view
    for (const [tag, opt] of profiles) {
      const ctx = await browser.newContext(opt), page = await ctx.newPage(); watch(page, `game-${tag}`, errors);
      await page.goto(`http://localhost:${gamePort}/`);
      await page.waitForFunction(() => window.__game && window.__game.ants().some((a) => a.vis === 'walking' && a.moving && a.sx !== null), null, { timeout: 30000 });
      // frame rate at the default (opening) view while playing
      await page.waitForTimeout(1000); await page.evaluate(() => window.__game.resetFps()); await page.waitForTimeout(6000);
      const fpsDefault = await page.evaluate(() => window.__game.fps());
      await page.screenshot({ path: path.join(OUT, `${tag}-game-default.png`) });
      // the next recorded walk, paused while ants are on screen
      await page.click('#nextWalkBtn'); const tJump = await page.evaluate(() => window.__game.state().t);
      await page.waitForFunction((t0) => window.__game.state().t > t0 + 1e-4, tJump); // frames drawn after the jump
      // pause in the same tick that sees a walking ant on screen (no race with the ant reaching the nest)
      await page.waitForFunction(() => { const ok = window.__game.ants().some((a) => a.vis === 'walking' && a.moving && a.sx !== null && a.sx > 40 && a.sx < innerWidth - 40 && a.sy > 150 && a.sy < innerHeight - 220); if (ok && window.__game.state().playing) document.getElementById('play').click(); return ok; }, null, { timeout: 30000, polling: 'raf' });
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => window.__game.micro()), onScreen = await page.evaluate(() => window.__game.ants().filter((a) => a.sx !== null && (a.vis === 'walking' || a.vis === 'at_site')).length);
      if (!m.ants.length) console.log('debug', tag, JSON.stringify(await page.evaluate(() => [window.__game.state(), window.__game.ants().filter((a) => a.vis === 'walking')])).slice(0, 1500));
      check(m.ants.length > 0 && m.ants.length >= onScreen, `${tag}: micro-motion state for every on-screen ant (${m.ants.length} ≥ ${onScreen})`);
      check(m.ants.every((a) => Math.abs(a.headYaw) <= 0.25 && ['sweep', 'probe', 'tap', 'rest'].includes(a.L.mode) && ['sweep', 'probe', 'tap', 'rest'].includes(a.R.mode)), `${tag}: head yaw bounded, antenna modes valid`);
      check(m.ants.some((a) => JSON.stringify(a.L) !== JSON.stringify(a.R)), `${tag}: left and right antennae differ`);
      await page.click('#infoBtn'); const about = await page.textContent('#about');
      check(/顯示動畫（示意）/.test(about) && /不是感覺事件/.test(about), `${tag}: the data panel names the display animation and that it is not perception`);
      await page.click('#infoBtn');
      // close-up of a walking ant at 1× speed: select it, follow it, zoom in
      await page.selectOption('#speed', '1');
      const target = await page.evaluate(() => { const v = window.__game.ants().filter((a) => a.sx !== null && (a.vis === 'walking' || a.vis === 'at_site') && a.sy > 150 && a.sy < innerHeight - 220); return v.find((a) => a.moving) || v[0]; });
      check(!!target, `${tag}: an ant is on screen for the close-up`); if (!target) { await ctx.close(); continue; }
      await page.mouse.click(target.sx, target.sy); await page.waitForTimeout(100);
      const sel = await page.evaluate(() => window.__game.state().selected);
      if (sel) await page.click('#followBtn');
      // zoom about the ant itself (it stays under the zoom centre even if the follow click missed)
      for (let i = 0; i < 9; i++) { await page.evaluate((id) => { const a = window.__game.ants().find((x) => x.id === id), cv = document.getElementById('scene'), r = cv.getBoundingClientRect(); const x = a && a.sx !== null ? a.sx : cv.clientWidth / 2, y = a && a.sy !== null ? a.sy : cv.clientHeight / 2; cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true })); }, target.id); await page.waitForTimeout(60); }
      await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, `${tag}-game-closeup.png`) }); // paused, chunks baked
      await page.click('#play');
      await page.waitForTimeout(1000); await page.evaluate(() => window.__game.resetFps()); await page.waitForTimeout(4000);
      const fpsClose = await page.evaluate(() => window.__game.fps()), m2 = await page.evaluate(() => window.__game.micro());
      await page.click('#play'); await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(OUT, `${tag}-game-closeup-after-play.png`) });
      results.game[tag] = { fps_default: fpsDefault, fps_closeup: fpsClose, detail_path_in_closeup: m2.detail, followed: sel, micro_ants_checked: m.ants.length };
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); game.kill(); }
  if (errors.length) failures.push(...errors);
  results.meta = { measured: 'headless Chromium via Playwright (software rendering); not a real device', node: process.version, passed: passed.length, failed: failures.length };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 1) + '\n');
  for (const p of passed) console.log('ok   ' + p);
  console.log(JSON.stringify(results, null, 1));
  if (failures.length) { console.error('FAILURES\n' + failures.join('\n')); process.exit(1); }
});

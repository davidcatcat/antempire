/**
 * Demo 2 — the OPT-IN WebGPU renderer (`?renderer=webgpu`; default stays WebGL 2). Playwright Chromium, NON-OFFICIAL
 * P0-A2 experiment world. FAILS (exit 1) on a failed check or an unexpected page / console error.
 *   npm run web:build && node cli/web-serve.ts 8787 &  node tests/browser/demo2-webgpu.check.cjs <outDir> http://localhost:8787/
 * What can and cannot be verified in a headless container (stated in the report, the 效能 tab and docs/demo2.md):
 *  A. no WebGPU (default Chromium flags): `?renderer=webgpu` falls back to WebGL 2 and SAYS so (never reports WebGPU);
 *     the 效能 tab toggle adds / removes the parameter.
 *  B. the node-material (TSL) path on three's WebGPURenderer with ITS WebGL 2 backend (`&backend=webgl2`), on screen:
 *     labelled "not WebGPU"; 30 workers drawn, selection and follow work, draw calls / triangles reported.
 *  C. a REAL WebGPU backend on a software adapter (Chromium --enable-unsafe-webgpu, SwiftShader), drawn OFFSCREEN into a
 *     texture and read back (`&present=offscreen`): backend.isWebGPUBackend, pipelines compile, the scene and the rigged
 *     ants are drawn (image saved), draw calls / triangles reported, no error. Headless Chromium's software WebGPU cannot
 *     present to a canvas (the GPU instance is dropped), so ON-SCREEN WebGPU and real GPUs are NOT verified here; the
 *     page must then say the device was lost instead of showing a blank scene (checked).
 *     If the browser gives no adapter at all, part C is reported as SKIPPED (not passed).
 *  D. the display director's output (every worker's drawn point, pose, place) is identical under WebGL 2, the
 *     node-material path and real WebGPU at the same simulated instant.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2] || 'demo2-webgpu-shots', base = process.argv[3] || 'http://localhost:8787/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], files = [], report = { webgpu_adapter: false, webgpu_offscreen_verified: false, webgpu_onscreen_verified: false };
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const ready = (page) => page.waitForFunction(() => window.__demo2 && window.__demo2.ready && window.__demo2.state().ants > 0, null, { timeout: 120000 });
  const watch = (page, tag, allow = () => false) => { page.on('pageerror', (e) => { if (!allow(String(e))) errors.push(`${tag}: ${e.stack || e}`); }); page.on('console', (m) => { if (m.type() === 'error' && !allow(m.text())) errors.push(`${tag}: ${m.text()}`); }); };
  const T = 9 * 3600 + 240, sample = (page) => page.evaluate(async (t) => { const D = window.__demo2; await D.setRunning(false); await D.stepUntil(t); return JSON.stringify(D.sampleNow()); }, T);
  const open = async (browser, query, tag, allow) => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage(); watch(page, tag, allow); await page.goto(new URL(`demo2.html?${query}`, base).href); await ready(page); return { ctx, page }; };

  // ---- A + B + reference: default Chromium (no WebGPU) ----
  let ref;
  {
    const browser = await chromium.launch();
    const gl = await open(browser, 'seed=1&quality=medium&autostart=0', 'webgl2');
    const s0 = await gl.page.evaluate(() => ({ s: window.__demo2.state(), b: window.__demo2.backend() }));
    check(s0.s.renderer === 'webgl2' && s0.b.startsWith('WebGL 2') && s0.s.rendererNote === '', `default: WebGL 2 renderer (${s0.b.slice(0, 44)}…)`);
    ref = await sample(gl.page);
    // reference picture of the rigged queens (paused, fixed camera) for the pixel comparison with the node-material path
    const CLIP = { x: 240, y: 380, width: 780, height: 190 }, closeUp = async (page) => { await page.evaluate(() => window.__demo2.view([4, -27.5, 26], [1, -28.6, 0])); await page.waitForTimeout(1500); return (await page.screenshot({ type: 'png', clip: CLIP })).toString('base64'); };
    const refPng = await closeUp(gl.page); await gl.page.evaluate(() => window.__demo2.setView('full'));
    await gl.page.click('#sideBtn'); await gl.page.click('#tabs button[data-tab="perf"]'); await gl.page.waitForTimeout(500);
    const perf0 = await gl.page.textContent('#pane-perf');
    check(['WebGL 2', 'draw calls', '三角形', 'FPS', '幀時間', 'WebGPU（實驗）', '未在真實 GPU 的 WebGPU 上驗證'].every((x) => perf0.includes(x)), '效能 tab: backend, FPS, frame times, draw calls, triangles, the renderer toggle and the verification status');
    await Promise.all([gl.page.waitForNavigation(), gl.page.click('#pane-perf button[data-r="webgpu"]')]); await ready(gl.page);
    const fb = await gl.page.evaluate(() => ({ s: window.__demo2.state(), b: window.__demo2.backend(), url: location.search, perf: document.querySelector('#pane-perf').textContent, hasGpu: 'gpu' in navigator }));
    check(fb.url.includes('renderer=webgpu') && fb.s.renderer === 'webgl2' && /已改用 WebGL 2/.test(fb.s.rendererNote) && fb.b.startsWith('WebGL 2') && !/backend＝WebGPU/.test(fb.b) && fb.perf.includes(fb.s.rendererNote) && fb.s.ants === 30, `no WebGPU in this browser (navigator.gpu ${fb.hasGpu}): ?renderer=webgpu falls back to WebGL 2 and says so (「${fb.s.rendererNote}」)`);
    await Promise.all([gl.page.waitForNavigation(), gl.page.click('#pane-perf button[data-r="webgl2"]')]); await ready(gl.page);
    check(!(await gl.page.evaluate(() => location.search)).includes('renderer='), 'the toggle back to WebGL 2 removes the parameter');
    await gl.ctx.close();

    // (the director's output depends on the frames it has seen, so every renderer is sampled the same way: a paused page, straight after loading)
    const nm = await open(browser, 'seed=1&quality=medium&renderer=webgpu&backend=webgl2&speed=5&autostart=0', 'node-webgl2');
    check(await sample(nm.page) === ref, 'display director output is identical under WebGL 2 and the node-material path (same instant)');
    // the two rigs must draw the same ants: same paused instant, same camera, pixel comparison of the queen chamber
    // (a rig that bends joints about the wrong pivot moves whole heads / gasters: many strongly different pixels)
    const nmPng = await closeUp(nm.page);
    const diff = await nm.page.evaluate(async ([a, b]) => { const load = async (d) => { const im = new Image(); im.src = 'data:image/png;base64,' + d; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; }; const A = await load(a), B = await load(b); let big = 0, sum = 0; const n = A.length / 4; for (let i = 0; i < A.length; i += 4) { const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]); sum += d; if (d > 150) big++; } return { strongly_different: big / n, mean_abs: sum / n / 3 }; }, [refPng, nmPng]);
    report.rig_pixel_diff = diff;
    check(diff.strongly_different < 0.02, `the TSL rig draws the same queens as the GLSL rig (pixels differing strongly: ${(diff.strongly_different * 100).toFixed(2)}% < 2%; mean abs diff ${diff.mean_abs.toFixed(1)} / 255)`);
    const fq = path.join(out, 'demo2-webgpu-nodepath-webgl2-queens.jpg'); await nm.page.screenshot({ path: fq, type: 'jpeg', quality: 70 }); files.push(fq);
    await nm.page.evaluate(() => window.__demo2.setView('full'));
    await nm.page.evaluate(() => window.__demo2.setRunning(true)); await nm.page.waitForTimeout(2500);
    const n1 = await nm.page.evaluate(() => ({ s: window.__demo2.state(), b: window.__demo2.backend(), p: window.__demo2.perf() }));
    check(n1.s.renderer === 'webgpu-webgl2' && n1.b.includes('不是 WebGPU') && !/backend＝WebGPU/.test(n1.b), `node-material path on three's WebGL 2 backend is labelled as such (${n1.b})`);
    check(n1.s.ants === 30 && n1.s.hi + n1.s.lo === 30 && n1.p.calls > 20 && n1.p.triangles > 50000 && n1.p.frames > 3, `node-material path: 30 workers drawn, ${n1.p.calls} draw calls, ${n1.p.triangles} triangles, FPS ${n1.p.fps_mean}`);
    const f = path.join(out, 'demo2-webgpu-nodepath-webgl2-full.jpg'); await nm.page.screenshot({ path: f, type: 'jpeg', quality: 70 }); files.push(f);
    await nm.page.click('#followBtn'); await nm.page.waitForTimeout(2500);
    const fo = await nm.page.evaluate(() => { const s = window.__demo2.state(), a = window.__demo2.ants().find((x) => x.id === s.following); return { s, a, card: document.querySelector('#card').textContent }; });
    check(!!fo.s.following && fo.a && Math.hypot(fo.s.target[0] - fo.a.x, fo.s.target[1] - fo.a.y, fo.s.target[2] - fo.a.z) < 3 && fo.card.includes('引擎個體'), 'node-material path: follow and the selection card work');
    const f2 = path.join(out, 'demo2-webgpu-nodepath-webgl2-follow.jpg'); await nm.page.screenshot({ path: f2, type: 'jpeg', quality: 70 }); files.push(f2);
    report.node_path = { calls: n1.p.calls, triangles: n1.p.triangles, fps: n1.p.fps_mean, gl: n1.p.gl, measurement_class: n1.p.measurement_class };
    await nm.ctx.close(); await browser.close();
  }

  // ---- C + D: real WebGPU backend on a software adapter ----
  // One browser per page: after a texture read-back the software WebGPU process of headless Chromium stops answering
  // (a second read-back, or opening another page in the same browser, never returns), so every step gets a fresh one.
  {
    const gpuBrowser = () => chromium.launch({ args: ['--enable-unsafe-webgpu'] });
    const grab = (page) => Promise.race([page.evaluate(() => window.__demo2.grab(0.72)), new Promise((r) => setTimeout(() => r(null), 90000))]);
    const save = (name, g) => { const f = path.join(out, name); fs.writeFileSync(f, Buffer.from(g.url.split(',')[1], 'base64')); files.push(f); };
    let browser = await gpuBrowser();
    const probe = await browser.newPage(); await probe.goto(new URL('demo2.html?seed=1&autostart=0&quality=low', base).href);
    report.webgpu_adapter = await probe.evaluate(async () => { try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; } });
    await probe.close();
    if (!report.webgpu_adapter) { process.stderr.write('SKIP real WebGPU backend: this Chromium gives no WebGPU adapter even with --enable-unsafe-webgpu (NOT verified)\n'); await browser.close(); }
    else {
      const gp = await open(browser, 'seed=1&quality=medium&renderer=webgpu&present=offscreen&speed=5&autostart=0', 'webgpu-offscreen');
      check(await sample(gp.page) === ref, 'display director output is identical under WebGL 2 and the real WebGPU backend (same instant)');
      await gp.page.evaluate(() => window.__demo2.setRunning(true)); await gp.page.waitForTimeout(2500);
      const g1 = await gp.page.evaluate(() => ({ s: window.__demo2.state(), b: window.__demo2.backend(), gl: window.__demo2.gl(), p: window.__demo2.perf() }));
      check(g1.s.renderer === 'webgpu' && /backend＝WebGPU/.test(g1.b) && g1.s.rendererNote === '', `real WebGPU backend (${g1.gl}): ${g1.b}`);
      const img = await grab(gp.page);
      check(g1.s.ants === 30 && g1.p.calls > 20 && g1.p.triangles > 50000 && !!img && img.lit_fraction > 0.6, `real WebGPU backend, offscreen: scene and 30 rigged workers drawn (${g1.p.calls} draw calls, ${g1.p.triangles} triangles, ${img ? (img.lit_fraction * 100).toFixed(0) : '?'}% of the image lit)`);
      if (img) save('demo2-webgpu-offscreen-full.jpg', img);
      report.webgpu_offscreen_verified = !!img; report.webgpu = { adapter: g1.gl, calls: g1.p.calls, triangles: g1.p.triangles, fps: g1.p.fps_mean, measurement_class: g1.p.measurement_class };
      await browser.close().catch(() => {});
      // a close-up of the rigged queens and workers
      browser = await gpuBrowser();
      const cu = await open(browser, 'seed=1&quality=medium&renderer=webgpu&present=offscreen&autostart=0', 'webgpu-offscreen-closeup');
      await cu.page.evaluate(() => window.__demo2.view([4, -27.5, 26], [1, -28.6, 0])); await cu.page.waitForTimeout(2000);
      const g2 = await grab(cu.page);
      check(!!g2 && g2.lit_fraction > 0.6, 'real WebGPU backend, offscreen: close-up of the queen chamber read back');
      if (g2) save('demo2-webgpu-offscreen-queens.jpg', g2);
      await browser.close().catch(() => {});
      // on-screen WebGPU: headless software WebGPU cannot present to a canvas. The page must say so, not show a silent blank.
      browser = await gpuBrowser();
      const dropped = (t) => /Instance|popErrorScope|Device Lost|createBuffer|external Instance|WebGPU|GPUDevice|destroyed/i.test(t);
      const on = await open(browser, 'seed=1&quality=low&renderer=webgpu&autostart=0', 'webgpu-onscreen', dropped).catch(() => null);
      if (on) {
        await on.page.waitForTimeout(4000);
        const o = await on.page.evaluate(() => ({ s: window.__demo2.state(), toast: document.querySelector('#toast').textContent, fatal: document.querySelector('#fatal').hidden ? '' : document.querySelector('#fatal').textContent }));
        report.webgpu_onscreen = { renderer: o.s.renderer, calls: o.s.calls, note: o.s.rendererNote };
        if (o.s.calls > 20 && !o.s.rendererNote) { report.webgpu_onscreen_verified = true; const f = path.join(out, 'demo2-webgpu-onscreen-full.jpg'); await on.page.screenshot({ path: f, type: 'jpeg', quality: 70 }); files.push(f); check(true, 'real WebGPU backend presents on screen in this browser'); }
        else check(/WebGPU 裝置遺失/.test(o.s.rendererNote) && /WebGPU 裝置遺失/.test(o.fatal + o.toast) && /改用 WebGL 2 重新載入/.test(o.fatal), `on-screen WebGPU could not present here: the page says so and offers WebGL 2 (「${o.s.rendererNote.slice(0, 50)}…」) — NOT verified on screen`);
      } else check(false, 'the on-screen WebGPU page did not load');
      await browser.close().catch(() => {});
    }
  }
  check(errors.length === 0, `no unexpected page or console errors${errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''}`);
  console.log(JSON.stringify({ check: 'demo2-webgpu', passed: passed.length, failures, errors, files: files.map((f) => path.basename(f)), report, note: 'software rendering under automation: NOT device results; on-screen WebGPU and real GPUs are verified only where webgpu_onscreen_verified is true' }, null, 1));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

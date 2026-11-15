// Demo 2 round 4 — before / after clips of the drawn ant motion (manual tool, NOT a CI check and not a test).
//
// The same world, the same instants and the same camera for both builds, so the clips can be compared side by side:
//   junction  a close follow of a worker walking through the tunnel junctions on its way to the entrance
//   meet      a follow of a worker going up the entrance tunnel while a returning worker comes in
//   rest      a resting chamber at night
//   surface   a close follow of a worker on its trip along the display route
// The world is PAUSED and stepped (scheduling only: step_until) 0.1 simulated seconds per captured frame, so a clip
// plays at 1× simulated time whatever the rendering speed of the machine. Software rendering: the pictures show poses,
// turning and arrangement — not the frame rate of a real device.
//
//   npm run web:build && node cli/web-serve.ts 8787 &
//   node tests/browser/demo2-motion-clips.cjs <outDir> http://localhost:8787/ <before|after> [desktop|pixel7|both] [clip,clip]
// Needs ffmpeg on PATH (frames → WebM).
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');

const [outDir, base = 'http://localhost:8787/', tag = 'after', which = 'both', only = ''] = process.argv.slice(2);
if (!outDir) { console.error('usage: demo2-motion-clips.cjs <outDir> <baseUrl> <before|after> [desktop|pixel7|both]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const FRAMES = 80, STEP = 0.1, WARM = 30;

/** each clip: t0 = world time to start looking from; pick = runs in the page, returns { id } to follow or { fixed } or null (not yet) */
const CLIPS = [
  { name: 'junction', t0: 9 * 3600 + 120, delay: 8, cam: { desktop: [0, 1.3, 8.5], pixel7: [0, 1.6, 11] },
    pick: () => { const a = window.__demo2.ants().filter((x) => x.state === 'to_entrance' && x.realm === 'nest' && x.y < -14).sort((p, q) => (p.id < q.id ? -1 : 1))[0]; return a ? { id: a.id } : null; } },
  { name: 'meet', t0: 9 * 3600 + 300, delay: 0, cam: { desktop: [0, 0.4, 12], pixel7: [0, 0.4, 14] },
    // a worker on its way up the entrance tunnel, at a moment when another one is about to come in from the surface
    pick: () => { const A = window.__demo2.ants(), out = A.filter((x) => x.state === 'to_entrance' && x.realm === 'nest' && x.y > -8.5 && x.y < -3).sort((p, q) => (p.id < q.id ? -1 : 1))[0], back = A.some((x) => x.state === 'returning' && x.realm === 'surface' && Math.hypot(x.x, x.z) < 7); return out && back ? { id: out.id } : null; } },
  { name: 'rest', t0: 22 * 3600 + 300, delay: 0, cam: { desktop: [0, 0.9, 17], pixel7: [0, 0.9, 21] }, pick: () => ({ fixed: [39, -26.4, 0] }) },
  { name: 'surface', t0: 10 * 3600 + 60, delay: 0, cam: { desktop: [-2.5, 5, 7.5], pixel7: [-2.5, 6, 9.5] },
    pick: () => { const a = window.__demo2.ants().filter((x) => x.state === 'outbound' && x.realm === 'surface' && Math.hypot(x.x, x.z) > 12 && Math.hypot(x.x, x.z) < 60).sort((p, q) => (p.id < q.id ? -1 : 1))[0]; return a ? { id: a.id } : null; } },
];

(async () => {
  const browser = await chromium.launch();
  const log = [];
  for (const dev of which === 'both' ? ['desktop', 'pixel7'] : [which]) {
    for (const clip of CLIPS.filter((c) => !only || only.split(',').includes(c.name))) {
      const ctx = await browser.newContext(dev === 'pixel7' ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage(), errs = []; page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(`${base}demo2.html?autostart=0&quality=medium&t=${clip.t0 - WARM}`);
      await page.waitForFunction(() => window.__demo2 && window.__demo2.ready, null, { timeout: 120000 });
      // while only stepping (no picture needed) the GPU draw is skipped: software rendering is slow
      await page.evaluate(() => window.__demo2.setRender(false));
      // warm up: the display director sees the frames of the half minute before (it only observes; nothing is skipped in the world)
      let t = clip.t0 - WARM; for (let i = 0; i < WARM * 2; i++) { t += 0.5; await page.evaluate(async (x) => { await window.__demo2.stepUntil(x); window.__demo2.sampleNow(); }, t); }
      let sel = null; for (let i = 0; i < 2400 && !sel; i++) { sel = await page.evaluate(clip.pick); if (!sel) { t += 0.5; await page.evaluate(async (x) => { await window.__demo2.stepUntil(x); window.__demo2.sampleNow(); }, t); } }
      if (!sel) { log.push({ dev, clip: clip.name, error: 'no moment found' }); await ctx.close(); continue; }
      for (let i = 0; i < clip.delay / 0.5; i++) { t += 0.5; await page.evaluate(async (x) => { await window.__demo2.stepUntil(x); window.__demo2.sampleNow(); }, t); }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2-clip-')), off = clip.cam[dev], tStart = t;
      for (let f = 0; f < FRAMES; f++) {
        t += STEP;
        await page.evaluate(async ({ x, sel, off }) => {
          const D = window.__demo2; await D.stepUntil(x); D.sampleNow();
          const a = sel.id ? D.ants().find((q) => q.id === sel.id) : null, c = a ? [a.x, a.y, a.z] : sel.fixed;
          D.view([c[0] + off[0], c[1] + off[1], c[2] + off[2]], c); D.setRender(true);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))); D.setRender(false);
        }, { x: t, sel, off });
        await page.screenshot({ path: path.join(tmp, `f-${String(f).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 82 });
      }
      const stem = `${tag}-${clip.name}-${dev}`;
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(Math.round(1 / STEP)), '-i', path.join(tmp, 'f-%04d.jpg'), '-vf', `scale=${dev === 'pixel7' ? 412 : 800}:-2`, '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-an', path.join(outDir, `${stem}.webm`)]);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(tmp, `f-${String(Math.floor(FRAMES * 0.6)).padStart(4, '0')}.jpg`), '-vf', `scale=${dev === 'pixel7' ? 412 : 960}:-2`, '-q:v', '5', path.join(outDir, `${stem}.jpg`)]);
      fs.rmSync(tmp, { recursive: true, force: true });
      log.push({ dev, clip: clip.name, follow: sel.id ?? null, t_start: Number(tStart.toFixed(1)), frames: FRAMES, step_s: STEP, errors: errs.slice(0, 3) });
      await ctx.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify({ tool: 'demo2-motion-clips', tag, note: 'software rendering; stepped 0.1 simulated s per frame (1× playback); NOT a device result', clips: log }, null, 1));
})();

/**
 * V3 browser E2E (Issue #99): individual follow camera and event-timeline jumps, in Chromium on a desktop window
 * (1280x800, mouse) and on an Android phone profile (Playwright "Pixel 7": 412x915, DPR 2.625, isMobile, real touch
 * events via CDP). A phone-size emulation is NOT a test on a physical phone. FAILS (exit 1) when any check fails.
 * Every expectation is computed from the exported engine data (web/data), read here independently of the page:
 *  - select a worker (click / touch tap) -> its panel shows ID, task, action and position (interpolation labelled);
 *  - 「追蹤個體」: during playback the camera keeps the followed worker at the canvas centre; the note says when the
 *    camera follows a display-interpolated position; speed changes keep following; the day boundary keeps following;
 *  - cancel: the button, and a manual drag (mouse / one-finger touch drag); a pinch is not a cancel;
 *  - death: following ends at the settlement of the recorded death day, with the reason; eclosion: the new worker
 *    can be selected only from its eclosion settlement; unknown position: 「位置未知」, the camera does not move;
 *  - event jump: a timed event -> the recorded minute exactly, camera on the recorded place, actor selected; an event
 *    without a clock time -> that day's settlement step (no minute shown); an event without a recorded place, or at a
 *    place without recorded coordinates -> 「位置未知」 and the camera stays; clicking a row while playing works;
 *  - official Day14 vs experimental Day0: the official snapshot cannot be followed or jumped, and switching worlds
 *    clears following, selection and the jump (nothing of one world remains in the other);
 *  - no page errors; no horizontal page scroll on the phone.
 * Writes screenshots and results.json to <outDir>.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/web-follow.check.cjs <outDir> http://localhost:8781/
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const DATA = path.join(__dirname, '..', '..', 'web', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const KNOWN = (exp) => new Set(exp.map.places.filter((p) => p.layout).map((p) => p.id));

(async () => {
  const out = process.argv[2], base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const index = read('index.json'), exps = index.experiments.map((m) => ({ meta: m, exp: read(m.file) }));
  const failures = [], errors = [], passed = [], results = {};
  const check = (cond, msg) => { (cond ? passed : failures).push(msg); };
  // cases from the data: first worker death, first eclosion, first event at a place without coordinates
  const find = (pred) => { for (const { meta, exp } of exps) for (const d of exp.days) { const i = d.events.findIndex(pred); if (i >= 0) return { meta, exp, d, i, e: d.events[i] }; } return null; };
  const deathCase = find((e) => e.type === 'worker_death'), eclCase = find((e) => e.type === 'eclosion');
  const unknownCase = find((e) => e.type === 'exploration_found_nothing'), timedCase = find((e) => e.type === 'food_collected');
  const noPlaceCase = find((e) => e.type === 'forager_stopped');
  if (!deathCase || !eclCase || !unknownCase || !timedCase || !noPlaceCase) { console.error('the exported data lack a required case'); process.exit(1); }
  const browser = await chromium.launch();
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 } }], ['android', { ...devices['Pixel 7'] }]];
  for (const [name, opts] of profiles) {
    const ctx = await browser.newContext(opts), page = await ctx.newPage(), touch = !!opts.hasTouch;
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
    const cdp = touch ? await ctx.newCDPSession(page) : null;
    const V = (fn, ...a) => page.evaluate(fn, ...a);
    // touch: pause between gestures like a person (Chromium absorbs a tap that follows a gesture within its double-tap window)
    const settle = () => (touch ? page.waitForTimeout(450) : null);
    const tap = async (x, y) => { if (touch) { await page.touchscreen.tap(x, y); await settle(); } else await page.mouse.click(x, y); };
    const press = async (sel) => { if (touch) { await page.locator(sel).first().tap(); await settle(); } else await page.locator(sel).first().click(); };
    const drag = async (x, y, dx, dy) => {
      if (!touch) { await page.mouse.move(x, y); await page.mouse.down(); for (let k = 1; k <= 5; k++) await page.mouse.move(x + (dx * k) / 5, y + (dy * k) / 5); await page.mouse.up(); return; }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let k = 1; k <= 5; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * k) / 5, y: y + (dy * k) / 5 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle();
    };
    const setDay = async (d, m) => { await page.$eval('#day', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, d); await page.$eval('#minute', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, m); };
    // wait for the viewer's own state (a re-selected option can still fire an async world switch that resets the day)
    const mode = async (id) => { if ((await V(() => window.antempireViewer.state().mode)) === id) return; await page.selectOption('#mode', id); await page.waitForFunction((x) => window.antempireViewer.state().mode === x && !document.getElementById('badge').textContent.includes('載入'), id); };
    const centred = async (id, tol = 2) => { const a = (await V(() => window.antempireViewer.antsOnScreen())).find((x) => x.id === id), c = await V(() => window.antempireViewer.canvasCentre()); return !!a && Math.hypot(a.x - c.x, a.y - c.y) <= tol; };
    /** select a worker: tap/click it; when other ants overlap it (the nest ring on a phone), use the 選擇個體 picker */
    const choose = async (id, at) => { if (at) await tap(at.x, at.y); if ((await V(() => window.antempireViewer.selected())) === id) return 'tap'; await page.selectOption('#who', id); return (await V(() => window.antempireViewer.selected())) === id ? 'picker' : 'failed'; };
    const play = async (ms) => { await press('#play'); await page.waitForTimeout(ms); await press('#play'); };
    const st = () => V(() => ({ ...window.antempireViewer.state(), following: window.antempireViewer.following(), note: window.antempireViewer.followNote(), cam: window.antempireViewer.camera(), jump: window.antempireViewer.lastJump(), selected: window.antempireViewer.selected() }));
    await page.goto(base); await page.waitForFunction(() => document.getElementById('badge').textContent.includes('Day14'));

    // official snapshot: can be selected, cannot be followed, has no event timeline
    const off = await V(() => window.antempireViewer.antsOnScreen());
    await tap(off[0].x, off[0].y);
    check((await page.$eval('#follow', (b) => b.disabled)) && (await page.$eval('#followMsg', (e) => e.textContent)).includes('無法追蹤'), `${name}: an official Day14 ant cannot be followed (no minute-level positions)`);
    check((await page.$$('#events button.ev')).length === 0, `${name}: the official snapshot has no clickable engine events`);

    // ── select + follow during playback (A1, day 2, an ant walking between recorded points) ──
    const A = exps[0];
    await mode(A.meta.id);
    let walker = null;
    for (let m = 1; m <= 120 && !walker; m++) { await setDay(2, m); walker = (await V(() => window.antempireViewer.antsOnScreen())).find((a) => a.interpolated); if (walker) walker.m = m; }
    check(!!walker, `${name}: a worker between two recorded points was found`);
    await tap(walker.x, walker.y);
    let s = await st();
    const info = await page.$eval('#info', (e) => e.textContent);
    check(s.selected === walker.id && info.includes(walker.id) && info.includes('今日紀錄任務') && info.includes('現在：') && info.includes('位置：'), `${name}: selected ${walker.id}; panel shows ID, task, action and position`);
    check(info.includes('位置為顯示插值') && info.includes('不是實際量到的位置'), `${name}: the interpolated position is labelled, not presented as a measured position`);
    await press('#follow'); s = await st();
    check(s.following === walker.id && (await page.$eval('#follow', (b) => b.textContent)).includes('取消追蹤'), `${name}: 「追蹤個體」 starts following ${walker.id}`);
    check(await centred(walker.id), `${name}: the followed worker is at the canvas centre`);
    check(s.note.includes('顯示插值'), `${name}: the note says the camera follows a display-interpolated position`);
    await page.selectOption('#speed', '5'); await play(900); s = await st();
    check(s.following === walker.id && s.minute > walker.m && (await centred(walker.id)), `${name}: after playing (minute ${walker.m} -> ${s.minute.toFixed(2)}) the camera still follows ${walker.id}`);
    await page.selectOption('#speed', '60'); await play(500); s = await st();
    check(s.following === walker.id && (await centred(walker.id)), `${name}: a speed change keeps following`);
    await page.screenshot({ path: `${out}/${name}-follow.png`, fullPage: !touch });
    // manual cancel: drag the map (mouse / one-finger touch)
    await page.locator('#map').scrollIntoViewIfNeeded(); // on the phone the follow button sits below the map
    const c0 = await V(() => window.antempireViewer.canvasCentre());
    await drag(c0.x - 60, c0.y + 40, 80, -30); s = await st();
    check(s.following === null && s.note.includes('手動取消'), `${name}: dragging the map cancels following (${s.note})`);
    // button cancel
    await press('#follow'); check((await st()).following === walker.id, `${name}: following can be restarted`);
    await press('#follow'); check((await st()).following === null, `${name}: the button cancels following`);

    // ── day crossing while following: a worker alive on day 3 and day 4 ──
    const d3 = A.exp.days[2], w3 = d3.window_minutes ?? 360, survivor = d3.end_state.workers.find((w) => A.exp.days[1].end_state.workers.some((x) => x.id === w.id)).id;
    await setDay(3, w3 - 1);
    const sa = (await V(() => window.antempireViewer.antsOnScreen())).find((a) => a.id === survivor);
    const how3 = await choose(survivor, sa); s = await st();
    check(how3 !== 'failed', `${name}: ${survivor} selected (${how3})`);
    if (s.selected === survivor) {
      await press('#follow'); await page.selectOption('#speed', '60'); await play(700); s = await st();
      check(s.day === 4 && s.following === survivor && (await centred(survivor)), `${name}: following ${survivor} continues across the day boundary (now day ${s.day} minute ${s.minute.toFixed(1)}; ${s.note})`);
      if (s.following) await press('#follow');
    } else check(false, `${name}: could not tap ${survivor} for the day-crossing check (got ${s.selected})`);

    // ── death: following ends at the settlement of the recorded death day ──
    await mode(deathCase.meta.id);
    const dd = deathCase.d, dw = dd.window_minutes ?? 360, victim = deathCase.e.id;
    await setDay(dd.day, dw);
    const va = (await V(() => window.antempireViewer.antsOnScreen())).find((a) => a.id === victim);
    check(!!va, `${name}: ${victim} is drawn at the end of the window of its death day ${dd.day}`);
    // select via its event row (worker_death names it), then go back into the window and follow it
    await page.click('#events button[data-ev="' + deathCase.i + '"]'); s = await st();
    check(s.minute === dw + 1 && s.jump && s.jump.timed === false && (await page.$eval('#jump', (e) => e.textContent)).includes('日終結算') && (await page.$eval('#jump', (e) => e.textContent)).includes('位置未知'), `${name}: the death event (no clock time, no place) jumps to the day-${dd.day} settlement and says 位置未知`);
    check(s.selected !== victim && (await page.$eval('#jump button[data-w="' + victim + '"]', (b) => b.disabled)), `${name}: ${victim} is not selectable after its death settlement`);
    await setDay(dd.day, dw); const howD = await choose(victim, va);
    if ((await st()).selected === victim) {
      await press('#follow'); await setDay(dd.day, dw + 1); s = await st();
      check(s.following === null && s.note.includes('死亡') && s.note.includes(`Day${dd.day}`), `${name}: following ${victim} ends at its death settlement (${s.note})`);
    } else check(false, `${name}: could not select ${victim} before its death`);

    // ── eclosion: selectable only from its eclosion settlement ──
    await mode(eclCase.meta.id);
    await setDay(eclCase.d.day, 0);
    await page.click('#events button[data-ev="' + eclCase.i + '"]'); s = await st();
    const newW = eclCase.e.new_worker_id;
    check(s.minute === (eclCase.d.window_minutes ?? 360) + 1 && s.selected === newW && (await V(() => window.antempireViewer.antsOnScreen())).some((a) => a.id === newW), `${name}: the eclosion of ${newW} jumps to the day-${eclCase.d.day} settlement, where ${newW} exists and is selected`);
    await setDay(eclCase.d.day, 10);
    check((await page.$eval('#info', (e) => e.textContent)).includes('羽化'), `${name}: before its eclosion settlement ${newW} is reported as not present yet`);
    check(await page.$eval('#follow', (b) => b.disabled), `${name}: a worker not yet eclosed cannot be followed`);

    // ── event jumps: timed with a place; no place; unknown coordinates; click while playing ──
    await mode(timedCase.meta.id);
    await setDay(timedCase.d.day, 0);
    await press('#play');
    await page.click('#events button[data-ev="' + timedCase.i + '"]'); s = await st();
    const tp = await V((id) => window.antempireViewer.placeOnScreen(id), timedCase.e.location), cc = await V(() => window.antempireViewer.canvasCentre());
    check(s.minute === timedCase.e.minute && s.day === timedCase.d.day, `${name}: a timed event jumps to its recorded minute exactly (${timedCase.e.minute})`);
    check((await page.$eval('#play', (e) => e.textContent)) === '播放', `${name}: clicking an event row while playing works and pauses playback`);
    check(tp && tp.known && Math.hypot(tp.x - cc.x, tp.y - cc.y) <= 2, `${name}: the camera is on the recorded place ${timedCase.e.location}`);
    check(s.selected === timedCase.e.worker, `${name}: the event's worker ${timedCase.e.worker} is selected`);
    check((await page.$eval('#jump', (e) => e.textContent)).includes('引擎紀錄的時刻') && (await page.$eval('#jump', (e) => e.textContent)).includes('示意位置'), `${name}: the jump panel names the recorded time and the schematic place`);
    await page.screenshot({ path: `${out}/${name}-jump.png`, fullPage: !touch });
    await mode(noPlaceCase.meta.id); await setDay(noPlaceCase.d.day, 0);
    const camA = (await st()).cam;
    await page.click('#events button[data-ev="' + noPlaceCase.i + '"]'); s = await st();
    check(s.minute === noPlaceCase.e.minute && s.cam.x === camA.x && s.cam.y === camA.y && (await page.$eval('#jump', (e) => e.textContent)).includes('位置未知'), `${name}: an event without a recorded place: recorded minute, 位置未知, the camera does not move`);
    await mode(unknownCase.meta.id); await setDay(unknownCase.d.day, 0);
    const camB = (await st()).cam;
    await page.click('#events button[data-ev="' + unknownCase.i + '"]'); s = await st();
    check(s.minute === unknownCase.e.minute && s.cam.x === camB.x && s.cam.y === camB.y && (await page.$eval('#jump', (e) => e.textContent)).includes(`位置未知：${unknownCase.e.node}`), `${name}: an event at ${unknownCase.e.node} (no recorded coordinates): 位置未知, the camera does not move`);
    // following a worker at the unknown place: the camera holds still
    if (s.selected === unknownCase.e.worker) {
      await press('#follow'); s = await st();
      check(s.following === unknownCase.e.worker && s.note.includes('位置未知') && s.cam.x === camB.x && s.cam.y === camB.y, `${name}: following ${unknownCase.e.worker} at ${unknownCase.e.node}: 位置未知, the camera holds`);
      await press('#follow');
    } else check(false, `${name}: ${unknownCase.e.worker} was not selected by the jump`);
    // filter: only the selected worker's events
    await page.check('#evMine'); const mine = await page.$$eval('#events button.ev', (bs) => bs.map((b) => Number(b.dataset.ev)));
    const names = (e) => ['worker', 'by', 'to', 'from', 'id', 'new_worker_id', 'team', 'participants', 'co_located_team'].some((k) => (Array.isArray(e[k]) ? e[k].includes(unknownCase.e.worker) : e[k] === unknownCase.e.worker && !(e.type === 'exploration_step' && k === 'to')));
    check(mine.length > 0 && mine.every((i) => names(unknownCase.d.events[i])), `${name}: 「只看所選個體」 lists only ${unknownCase.e.worker}'s events`);
    await page.uncheck('#evMine');

    // ── official vs experiment isolation: switching clears follow, selection and jump ──
    await press('#follow'); await mode('official'); s = await st();
    check(s.official && s.following === null && s.selected === null && s.jump === null && (await page.$eval('#jump', (e) => e.hidden)) && (await page.$eval('#timeline', (e) => e.hidden)), `${name}: switching to the official snapshot clears following, selection and the event jump`);
    if (touch) check(await V(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no horizontal page scroll on the phone`);
    if (touch) { await mode(A.meta.id); await setDay(2, walker.m); await page.screenshot({ path: `${out}/${name}-experiment.png` }); }
    results[name] = { viewport: opts.viewport, isMobile: !!opts.isMobile, hasTouch: touch, userAgent: opts.userAgent ?? null };
    await ctx.close();
  }
  await browser.close();
  const summary = { suite: 'web-follow (V3, Issue #99)', profiles: results, passed: passed.length, failures, errors };
  fs.writeFileSync(path.join(out, 'web-follow-results.json'), JSON.stringify({ ...summary, checks: passed }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (errors.length || failures.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

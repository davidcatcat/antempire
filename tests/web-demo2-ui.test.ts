/**
 * Demo 2 phone UI and 自動導覽 (idle camera tour) — Node checks (Owner directive 2026-11-15, item 4 and the final goal:
 * a world that can be watched without touching anything). NON-OFFICIAL experiment world. BLOCKING. Nothing here
 * changes a world.
 *  1. tour.ts with real P0-A2 Worker frames: the shot is a pure function of (shot number, seed, frame, received
 *     events); overviews and follows alternate; a followed worker is always one whose ENGINE state or event matches
 *     the stated reason; nothing is followed when no worker is active; the frame is not mutated; observing does not
 *     change the world.
 *  2. tourMayRun: only while running, idle long enough, and the user is not following / reading.
 *  3. source scans: tour.ts is pure; main.ts never sends anything to the Worker on behalf of the tour (the tour's
 *     follow is camera only); the phone layout keeps both markings in the bar and 44 px controls; the tour is off
 *     under automation unless asked for.
 * The browser side (layout numbers, taps, the Worker message log with the tour on / off) is tests/browser/demo2-ui.check.cjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import type { EventMsg, P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { nextShot, tourMayRun, tourHash, TOUR_REASONS, TOUR_REASON_ZH, TOUR_CUE_WINDOW_S, TOUR_IDLE_S, TOUR_VIEW_HOLD_S, TOUR_FOLLOW_HOLD_S, type TourCue, type TourShot, type TourWorker } from '../web/src/demo2/tour.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
const summary: Record<string, unknown> = {};

// 1. shots over real worlds
{
  const reasonsSeen = new Set<string>(); let follows = 0, views = 0;
  for (const seed of [1, 20261113]) {
    const mk = () => P0a2ExperimentWorld.create(`exp-tour-${seed}`, seed), made = mk(), w = made.world, ref = mk().world;
    const cues: TourCue[] = []; let last: string | null = null, k = 0; void made.events;
    for (let t = 9 * 3600; t <= 9 * 3600 + 3600; t += 60) {
      const evs = w.advanceTo(t).events as unknown as EventMsg[]; ref.advanceTo(t);
      for (const e of evs) { const d = e.data as { touched?: { amount: number }[]; larvae?: { fed: number }[] }; if (!e.entity) continue; if (Array.isArray(d.touched) && d.touched.some((x) => x.amount > 0)) cues.push({ id: e.entity, kind: 'troph', t_sim: e.t_sim }); if (Array.isArray(d.larvae) && d.larvae.some((x) => x.fed > 0)) cues.push({ id: e.entity, kind: 'larva_feed', t_sim: e.t_sim }); }
      const f = w.frame() as unknown as P0a2FrameMsg, before = JSON.stringify(f);
      const a = nextShot(k, seed, f.t_sim, f.workers, cues, last), b = nextShot(k, seed, f.t_sim, f.workers, [...cues], last);
      ok(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(f) === before, `seed ${seed} shot ${k}: same inputs → same shot; the frame is not mutated`);
      if (k % 2 === 0) ok(a.kind === 'view' && a.hold_s === TOUR_VIEW_HOLD_S, `seed ${seed} shot ${k}: even shots are overviews`);
      if (a.kind === 'view') { views++; if (a.view === 'surface') ok(f.workers.some((x) => ['outbound', 'searching', 'feeding', 'returning'].includes(x.state)), '地表 is shown only while a worker is outside'); }
      else {
        follows++; reasonsSeen.add(a.reason);
        const fw = f.workers.find((x) => x.id === a.id);
        ok(!!fw && a.hold_s === TOUR_FOLLOW_HOLD_S, `seed ${seed} shot ${k}: the followed id is a worker of the frame`);
        if (a.reason === 'troph' || a.reason === 'larva_feed') ok(cues.some((c) => c.id === a.id && c.kind === a.reason && f.t_sim - c.t_sim <= TOUR_CUE_WINDOW_S && c.t_sim <= f.t_sim), `seed ${seed} shot ${k}: ${a.id} really has a recent ${a.reason} engine event`);
        else ok(fw!.state === a.reason, `seed ${seed} shot ${k}: ${a.id} is in engine state ${a.reason}`);
        last = a.id;
      }
      k++;
    }
    ok(JSON.stringify(w.frame()) === JSON.stringify(ref.frame()) && JSON.stringify(w.snapshot()) === JSON.stringify(ref.snapshot()), `seed ${seed}: planning shots from the frames did not change the world (same frame and snapshot as an unobserved run)`);
  }
  ok(follows >= 20 && views >= 40 && reasonsSeen.size >= 3, `the tour followed workers ${follows} times for ${reasonsSeen.size} different reasons (${[...reasonsSeen].join(', ')})`);
  summary.real_worlds = { follows, views, reasons: [...reasonsSeen] };
}

// 1b. hand-made frames: ordering, variety, nothing invented
{
  const W = (id: string, state: string, since_s = 0): TourWorker => ({ id, state, since_s });
  const resting = [W('w001', 'resting'), W('w002', 'idle'), W('w003', 'resting')];
  for (let k = 0; k < 8; k++) ok(nextShot(k, 7, 100, resting, [], null).kind === 'view', `no active worker → shot ${k} is an overview (nothing is invented)`);
  ok((nextShot(2, 7, 100, resting, [], null) as { view: string }).view === 'under', 'nobody outside → the 地表 overview is replaced by 地下');
  ok([0, 2, 4].map((k) => (nextShot(k, 7, 100, [W('a', 'outbound')], [], null) as { view: string }).view).join() === 'full,surface,under', 'overviews cycle 完整剖面 → 地表 → 地下');
  const ws = [W('w001', 'to_entrance', 50), W('w002', 'to_entrance', 90), W('w003', 'feeding', 10), W('w004', 'resting', 99)];
  const s1 = nextShot(1, 7, 100, ws, [], null) as Extract<TourShot, { kind: 'follow' }>;
  ok(s1.kind === 'follow' && s1.id === 'w002' && s1.reason === 'to_entrance', 'the most recent state change of the first reason wins (w002 left later than w001)');
  ok((nextShot(1, 7, 100, ws, [], 'w002') as { id: string }).id === 'w001', 'the worker followed last time is skipped while another candidate exists');
  ok((nextShot(1, 7, 100, [W('w002', 'to_entrance', 90), W('w004', 'resting')], [], 'w002') as { id: string }).id === 'w002', '… and followed again when it is the only active one');
  const s3 = nextShot(3, 7, 100, ws, [{ id: 'w004', kind: 'troph', t_sim: 80 }], null) as Extract<TourShot, { kind: 'follow' }>;
  ok(s3.id === 'w004' && s3.reason === 'troph', 'the next follow starts one reason further: a recent trophallaxis event');
  ok((nextShot(3, 7, 100 + TOUR_CUE_WINDOW_S + 1, ws, [{ id: 'w004', kind: 'troph', t_sim: 80 }], null) as { reason: string }).reason === 'feeding', 'an old event is not "just happened": the next reason with a candidate is used');
  ok((nextShot(3, 7, 100, ws, [{ id: 'gone', kind: 'troph', t_sim: 99 }], null) as { reason: string }).reason === 'feeding', 'an event of an individual that is not in the frame is ignored');
  const tie = [W('a', 'feeding', 5), W('b', 'feeding', 5), W('c', 'feeding', 5)];
  const pick = (seed: number, k: number) => (nextShot(k, seed, 100, tie, [], null) as { id: string }).id;
  ok(pick(1, 5) === pick(1, 5) && new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => pick(s, 5))).size > 1, 'ties are broken by a hash of (seed, shot, id): reproducible, and not always the first id');
  ok(tourHash('a') === 0xe40c292c && TOUR_REASONS.length === Object.keys(TOUR_REASON_ZH).length && Object.values(TOUR_REASON_ZH).every((s) => /引擎(狀態|事件)/.test(s)), 'every reason is labelled as an engine state or an engine event');
}

// 2. when the tour may run
{
  const base = { on: true, idle_s: TOUR_IDLE_S, need_idle_s: TOUR_IDLE_S, running: true, userFollowing: false, userSelected: false, sheetOpen: false };
  ok(tourMayRun(base), 'runs when idle long enough');
  for (const [k, v] of [['on', false], ['idle_s', TOUR_IDLE_S - 0.1], ['running', false], ['userFollowing', true], ['userSelected', true], ['sheetOpen', true]] as const) ok(!tourMayRun({ ...base, [k]: v }), `does not run when ${k} = ${v}`);
}

// 3. source scans
{
  const tour = read('web/src/demo2/tour.ts'), main = read('web/src/demo2/main.ts'), html = read('web/demo2.html');
  ok(!/from '/.test(tour.replace(/\/\*[\s\S]*?\*\//g, '')) && !/Math\.random|Date\.now|performance\.|document\.|window\.|worker-client|postMessage/.test(tour), 'tour.ts is pure: no import, no clock, no randomness, no DOM, no Worker');
  // everything the tour does in main.ts: no Worker command, no session call
  const a = main.indexOf('// ---------- 自動導覽: idle camera tour'), b = main.indexOf('// ---------- per frame ----------');
  ok(a > 0 && b > a && !/client\.|session\.|postMessage/.test(main.slice(a, b)), 'the tour code in main.ts never talks to the Worker or the session');
  // D2E-2: the one place is observe() (a user selection also asks for the worker's own record); setFollow reaches it only when
  // the call is not the tour's, and nothing between the tour banner and the per-frame banner calls it (checked above: no client.)
  ok(/function observe\(id: string \| null\) \{ if \(observed === id\) return; observed = id; void client\.follow\(id\)/.test(main) && (main.match(/client\.follow\(/g) ?? []).length === 1 && /if \(!byTour\) observe\(/.test(main) && !/observe\(/.test(main.slice(a, b)), 'client.follow is sent from ONE place and never for a tour follow');
  ok(/setFollow\(shot\.id, true\)/.test(main) && /if \(following\) setFollow\(null, true\)/.test(main) && /if \(wasFollow\) setFollow\(null, true\)/.test(main), 'the tour starts and ends its follow with byTour = true');
  ok(/nextShot\(k, frame\.seed, frame\.t_sim, frame\.workers, tourCues, tourLast\)/.test(main), 'the shot comes from the frame (seed, time, worker states) and the received engine events only');
  ok(/let tourOn = tourParam !== null \? tourParam !== '0' : !automated;/.test(main), 'on by default; ?tour=0 switches it off; under automation it runs only when asked for');
  ok(/for \(const ev of \['pointerdown', 'wheel', 'keydown', 'touchstart'\] as const\) addEventListener\(ev, userInput, \{ capture: true, passive: true \}\)/.test(main), 'any input hands the camera back');
  for (const s of ['自動導覽中・點一下接手', 'id="tourBtn"', 'id="moreBtn"', 'id="peek"', 'id="grip"', 'id="statusRow"', 'data-tab="ant"', 'env(safe-area-inset-bottom', 'env(safe-area-inset-top', 'viewport-fit=cover']) ok(html.includes(s), `demo2.html has ${s}`);
  const narrowCss = html.slice(html.indexOf('@media (max-width: 760px)'), html.indexOf('@media (max-width: 380px)'));
  ok(/select, button, a\.btn, input\[type=text\] \{ min-height: 44px; min-width: 44px;/.test(narrowCss) && /#tabs button \{ min-height: 44px;/.test(narrowCss), 'phone: controls are at least 44 CSS px');
  // the two markings are children of the bar itself, never of the 更多 menu or the sheet
  const top = html.slice(html.indexOf('<div id="top">'), html.indexOf('<button id="tourChip"')), more = top.slice(top.indexOf('<div id="more">'), top.indexOf('<div id="statusRow">'));
  ok(top.includes('id="flag" class="chip">非正式實驗世界') && top.includes('id="modeBadge"') && !more.includes('id="flag"') && !more.includes('id="modeBadge"') && !/#flag[^{}]*\{[^}]*display:\s*none/.test(html) && !/#modeBadge[^{}]*\{[^}]*display:\s*none/.test(html), 'the 非正式實驗世界 and mode markings live in the bar and are never hidden by CSS');
  ok(read('.github/workflows/ci.yml').includes('tests/browser/demo2-ui.check.cjs') && read('tests/browser/demo2-ui.check.cjs').includes('scene_fraction >= 0.8'), 'the browser check runs in CI and asserts the ≥ 80 % scene height');
}

console.log(JSON.stringify({ test: 'web-demo2-ui', checks, summary }));

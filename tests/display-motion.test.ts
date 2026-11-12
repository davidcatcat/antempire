/**
 * Display micro-motion (PR B: head, antennae and gait animation) — pure display, BLOCKING:
 *  1. web/src/display-motion.ts imports only viewer modules, has no unseeded randomness / clock / storage / network,
 *     never touches the engine and creates no events;
 *  2. determinism: same ant ID + display time + context → identical state, across fresh and long-lived instances;
 *  3. frame-rate independence: different frame-step sequences (incl. backward jumps) give the identical state at the
 *     same display time; the walk ↔ stand blend of planAnts depends only on elapsed time, not on how it is split;
 *  4. left / right antennae are independent (not synchronized wipers): low correlation, different mode sequences;
 *     different individuals differ;
 *  5. non-periodicity guard: no single dominant frequency in the head-yaw (and antenna) spectrum;
 *  6. bounded angles; context coupling in the documented direction (stopped / exploring / near → more probing);
 *  7. no walking animation while stationary; gait continuous in the distance-driven phase;
 *  8. display never mutates inputs; the game view keeps positions = planAnts (= affine image of model.poseAt) and
 *     takes display time from simulated time;
 *  (also) the game view's persistent bottom legend labels head/antenna motion as display-only (引擎尚未模擬);
 *  9. the natural-walk page: placeholder pose streams are valid antempire.pose-stream.v1, deterministic and labelled
 *     示意・待 PR A 物理資料; interpolation helpers; docs list every display parameter as 示意／假設.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { DisplayMotion, MICRO, NEUTRAL_MICRO, bspline, playbackDamp, smoothedContext, type ContextSampler, type MicroContext, type MicroState } from '../web/src/display-motion.ts';
import { antPoseAt, antPose, WALK_FRAMES, walkCycles } from '../web/src/art-ant.ts';
import { planAnts, WALK_BLEND_S, type AntInput, type AntLook, type Camera } from '../web/src/render-scene.ts';
import { POSE_SCHEMA, SCENES, cumulativeDistance, distanceAt, rawFromStream, sampleAt, slotOf, validatePoseStream, type PoseStream } from '../prototypes/natural-walk/pose-stream.ts';

const metrics: Record<string, number> = { lr_abs_corr_max: 0, spectrum_peak_share_max: 0, autocorr_2_60s_max: -1 };
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const SRC = path.join(REPO_ROOT, 'web', 'src');

// 1. isolation
{
  const code = fs.readFileSync(path.join(SRC, 'display-motion.ts'), 'utf8'), body = code.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) ok(m[1].startsWith('./'), `display-motion imports only viewer modules (${m[1]})`);
  ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(code), 'display-motion: no unseeded randomness, no clock');
  ok(!/localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket|document\.|window\./.test(body), 'display-motion: no DOM, storage or network');
  ok(!/engine\/|cli\/|simulateWorldDay|simulateDay|initializeDay0|events\.push/.test(body), 'display-motion: does not touch the engine, creates no events');
}

const ctxConst = (c: Partial<MicroContext> = {}): ContextSampler => () => Object.freeze({ motion: 1, turn: 0, near: 0, explore: 0, ...c });
const step = (raw: (t: number) => { moving: number; heading: number; near: number; explore: number }) => smoothedContext((t) => Object.freeze(raw(t)));
// a context with departures, stops, a recorded turn and a near-place stretch (built like the game view's sampler)
const ctxMixed = step((t) => ({ moving: (t % 40) < 26 ? 1 : 0, heading: t > 55 ? 1.1 : t > 18 ? 0.4 : 0, near: (t % 40) > 22 && (t % 40) < 30 ? 0.8 : 0, explore: t > 80 && t < 110 ? 1 : 0 }));
const J = (s: MicroState) => JSON.stringify(s);

// 2. determinism
{
  const a = new DisplayMotion(), b = new DisplayMotion();
  for (const tau of [0, 0.013, 5.99, 6, 6.0001, 47.3, 123.456, 600.5]) ok(J(a.state('W017', tau, ctxMixed)) === J(b.state('W017', tau, ctxMixed)), `same ID + τ=${tau} → identical state (fresh instances)`);
  // a long-lived instance that has seen lots of other times / ants agrees with a fresh one
  for (let t = 0; t < 200; t += 0.37) { a.state('W001', t, ctxMixed); a.state('W017', 300 - t, ctxMixed); }
  for (const tau of [3.3, 77.7, 199.2]) ok(J(a.state('W017', tau, ctxMixed)) === J(new DisplayMotion().state('W017', tau, ctxMixed)), `memo is transparent at τ=${tau}`);
  ok(J(a.state('W017', 50, ctxMixed)) !== J(a.state('W018', 50, ctxMixed)), 'different individuals → different display state');
}

// 3. frame-rate independence
{
  const targets = [10, 33.3, 61.25, 90.0, 140.5];
  const seqs: number[][] = [Array(9000).fill(1 / 60), Array(3600).fill(1 / 24), Array.from({ length: 6000 }, (_, i) => 0.004 + ((i * 7919) % 97) / 97 * 0.04)];
  const ref = targets.map((t) => J(new DisplayMotion().state('W042', t, ctxMixed)));
  for (const [k, steps] of seqs.entries()) {
    const m = new DisplayMotion(); let t = 0, ti = 0; const got: string[] = [];
    for (const dt of steps) { // advance frame by frame; whenever a target time lies inside the frame, ask at it exactly
      while (ti < targets.length && targets[ti] <= t + dt) { m.state('W042', t, ctxMixed); got.push(J(m.state('W042', targets[ti], ctxMixed))); ti++; }
      t += dt; m.state('W042', t, ctxMixed);
      if (ti >= targets.length) break;
    }
    ok(JSON.stringify(got) === JSON.stringify(ref), `frame sequence ${k}: identical state at the same display time`);
  }
  // backward jump (scrubbing) then forward again
  const m = new DisplayMotion(); m.state('W042', 140.5, ctxMixed); m.state('W042', 2, ctxMixed);
  ok(J(m.state('W042', 61.25, ctxMixed)) === ref[2], 'after a backward jump the state at τ is unchanged');
  // walk ↔ stand blend in planAnts: same elapsed time split differently → same weight
  const cam: Camera = { cx: 0, cy: 0, s: 10, w: 400, h: 400 };
  const run = (dts: number[], moving: boolean[]) => { let look: ReadonlyMap<string, AntLook> = new Map([['A', { h: 0, phase: 0, sx: 200, sy: 200, w: 1 }]]), x = 0; for (const [i, dt] of dts.entries()) { const plan = planAnts(cam, [{ id: 'A', x, y: 0, vis: 'walking', moving: moving[i], heading: 0 }], look, dt, walkCycles); look = plan.look; } return (look.get('A') as AntLook).w as number; };
  const w1 = run(Array(30).fill(0.01), Array(30).fill(false)), w2 = run(Array(10).fill(0.03), Array(10).fill(false)), w3 = run([0.3], [false]);
  ok(Math.abs(w1 - w2) < 1e-12 && Math.abs(w1 - w3) < 1e-12 && Math.abs(w1 - Math.exp(-0.3 / WALK_BLEND_S)) < 1e-12, `walk blend depends only on elapsed time (${w1.toFixed(6)})`);
}

// 4. independence of left / right antennae, and of individuals
const corr = (a: number[], b: number[]) => { const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };
const series = (id: string, ctx: ContextSampler, T = 300, hz = 20) => { const m = new DisplayMotion(), out: MicroState[] = []; for (let i = 0; i < T * hz; i++) out.push(m.state(id, i / hz, ctx)); return out; };
{
  let worst = 0;
  for (const id of ['W001', 'W017', 'W123', 'X9']) for (const ctx of [ctxConst(), ctxConst({ motion: 0 }), ctxConst({ explore: 1, motion: 0.6 })]) {
    const s = series(id, ctx, 200);
    const rs = corr(s.map((x) => x.L.scape), s.map((x) => x.R.scape)), rf = corr(s.map((x) => x.L.fun), s.map((x) => x.R.fun)), rr = corr(s.map((x) => x.L.reach), s.map((x) => x.R.reach));
    worst = Math.max(worst, Math.abs(rs), Math.abs(rf), Math.abs(rr));
    const sameMode = s.filter((x) => x.L.mode === x.R.mode).length / s.length;
    ok(sameMode < 0.75, `${id}: left and right antennae are in the same mode only ${(sameMode * 100).toFixed(0)}% of the time`);
    ok(s.some((x) => x.L.mode !== x.R.mode) && J(s[100]) !== J(s[101]), `${id}: left / right modes differ at times, state changes over time`);
  }
  metrics.lr_abs_corr_max = worst;
  ok(worst < 0.3, `left / right antenna angles weakly correlated (max |r| = ${worst.toFixed(3)} < 0.3)`);
  const a = series('W001', ctxConst(), 120).map((x) => x.headYaw), b = series('W002', ctxConst(), 120).map((x) => x.headYaw);
  ok(Math.abs(corr(a, b)) < 0.3, `two individuals' head yaw is uncorrelated (r = ${corr(a, b).toFixed(3)})`);
  // a turn leans both antennae and the head the same way (the only intended common mode)
  const lt = new DisplayMotion().state('W5', 30, ctxConst({ turn: 0.6 })), ln = new DisplayMotion().state('W5', 30, ctxConst({ turn: 0 }));
  ok(lt.headYaw > ln.headYaw && lt.R.scape > ln.R.scape && lt.L.scape < ln.L.scape, 'a recorded right turn: head and both antennae lean right');
}

// 5. non-periodicity: no dominant frequency
const peakShare = (x: number[]) => { const n = x.length, m = x.reduce((s, v) => s + v, 0) / n; let tot = 0, peak = 0; for (let k = 1; k <= n / 2; k++) { let re = 0, im = 0; for (let i = 0; i < n; i++) { const a = (2 * Math.PI * k * i) / n; re += (x[i] - m) * Math.cos(a); im -= (x[i] - m) * Math.sin(a); } const p = re * re + im * im; tot += p; peak = Math.max(peak, p); } return peak / tot; };
const maxAutocorr = (x: number[], lo: number, hi: number) => { const n = x.length, m = x.reduce((s, v) => s + v, 0) / n, v0 = x.reduce((s, v) => s + (v - m) ** 2, 0) / n; let best = -1; for (let L = lo; L <= hi; L++) { let c = 0; for (let i = 0; i + L < n; i++) c += (x[i] - m) * (x[i + L] - m); best = Math.max(best, c / (n - L) / v0); } return best; };
{
  const hz = 10, n = 2048, sine = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1.3 * i) / hz));
  ok(peakShare(sine) > 0.5 && maxAutocorr(sine, 2 * hz, 60 * hz) > 0.9, 'guard self-check: a fixed sine has one dominant frequency and recurs');
  for (const id of ['W001', 'W077']) for (const [name, ctx] of [['walking', ctxConst()], ['stopped', ctxConst({ motion: 0 })], ['mixed', ctxMixed]] as const) {
    const s = series(id, ctx, n / hz, hz), hy = s.map((x) => x.headYaw), sc = s.map((x) => x.L.scape), hs = peakShare(hy), as = peakShare(sc), ac = Math.max(maxAutocorr(hy, 2 * hz, 60 * hz), maxAutocorr(sc, 2 * hz, 60 * hz));
    metrics.spectrum_peak_share_max = Math.max(metrics.spectrum_peak_share_max, hs, as); metrics.autocorr_2_60s_max = Math.max(metrics.autocorr_2_60s_max, ac);
    ok(hs < 0.12 && as < 0.12, `${id} ${name}: spectrum peak share head ${hs.toFixed(4)}, antenna ${as.toFixed(4)} (< 0.12; a fixed sine ≈ 1)`);
    ok(ac < 0.5, `${id} ${name}: no recurring period — max autocorrelation at lags 2–60 s = ${ac.toFixed(3)} (< 0.5; a sine ≈ 1)`);
  }
  ok(Math.abs(bspline(7, 3.25) - bspline(7, 3.25)) === 0 && bspline(7, 3.25) !== bspline(8, 3.25), 'noise is seeded and deterministic');
}

// 6. bounds and context coupling
{
  const rms = (x: number[]) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const frac = (s: MicroState[], ...m: string[]) => s.reduce((a, x) => a + (m.includes(x.L.mode) ? 1 : 0) + (m.includes(x.R.mode) ? 1 : 0), 0) / (2 * s.length);
  const trail = series('W9', ctxConst({ motion: 1 }), 300, 10), still = series('W9', ctxConst({ motion: 0 }), 300, 10), expl = series('W9', ctxConst({ motion: 0.7, explore: 1 }), 300, 10), near = series('W9', ctxConst({ motion: 1, near: 1 }), 300, 10);
  for (const s of [trail, still, expl, near, series('W9', ctxMixed, 300, 10)]) ok(s.every((x) => Math.abs(x.headYaw) <= MICRO.head.max + 1e-12 && x.L.scape >= 0.35 && x.L.scape <= 1.5 && x.R.fun >= -0.45 && x.R.fun <= 1 && x.L.reach >= 0.45 && x.L.reach <= 1), 'angles bounded');
  ok(rms(still.map((x) => x.headYaw)) > rms(trail.map((x) => x.headYaw)) && rms(expl.map((x) => x.headYaw)) > rms(trail.map((x) => x.headYaw)), `head scans more when stopped / exploring than walking on a trail (rms ${rms(trail.map((x) => x.headYaw)).toFixed(3)} / ${rms(still.map((x) => x.headYaw)).toFixed(3)} / ${rms(expl.map((x) => x.headYaw)).toFixed(3)} rad)`);
  ok(frac(trail, 'probe') > frac(still, 'probe') && frac(still, 'rest') > frac(trail, 'rest'), 'walking → more forward probing; stopped → more resting');
  ok(frac(expl, 'sweep', 'tap') > frac(trail, 'sweep', 'tap') && frac(near, 'tap', 'probe') > frac(trail, 'tap', 'probe'), 'exploring → more sweeping / tapping; near a place → more tapping / probing');
  ok(playbackDamp(1) === 1 && playbackDamp(5) < 1 && playbackDamp(60) < playbackDamp(5), 'fast playback damps the amplitude');
  const d = new DisplayMotion().state('Q', 12, ctxMixed, 0); ok(J({ ...d, tauS: 0 }) === J({ ...NEUTRAL_MICRO(0), L: { ...NEUTRAL_MICRO().L, mode: d.L.mode }, R: { ...NEUTRAL_MICRO().R, mode: d.R.mode } }), 'damp 0 → neutral pose');
}

// 7. gait: no animation while stationary; continuous in phase
{
  const still = [0, 0.13, 0.5, 0.77].map((p) => JSON.stringify(antPoseAt('idle', p, { walkW: 0 }).legs));
  ok(still.every((x) => x === still[0]) && antPoseAt('idle', 0.3, { walkW: 0 }).legs.every((l) => l.stance && l.lift === 0), 'stationary (w = 0): legs planted and identical at any phase');
  const cam: Camera = { cx: 0, cy: 0, s: 10, w: 400, h: 400 };
  let look: ReadonlyMap<string, AntLook> = new Map(), cyc = new Set<number>();
  for (let i = 0; i < 50; i++) { const p = planAnts(cam, [{ id: 'S', x: 1, y: 1, vis: 'at_site', moving: false, heading: null, displayOffset: { dx: 0, dy: 0, heading: 0.4 } }], look, 1 / 60, walkCycles); look = p.look; cyc.add(p.draws[0].cycles); ok(p.draws[0].gait === 'idle', 'stationary → idle gait'); }
  ok(cyc.size === 1, 'stationary → gait phase does not advance');
  let worst = 0;
  for (const kind of ['walk', 'curveL', 'pivotR'] as const) for (let i = 0; i < 2000; i++) { const a = antPoseAt(kind, i / 2000), b = antPoseAt(kind, (i + 1) / 2000); for (let k = 0; k < 6; k++) worst = Math.max(worst, Math.hypot(a.legs[k].pts[4][0] - b.legs[k].pts[4][0], a.legs[k].pts[4][1] - b.legs[k].pts[4][1])); }
  ok(worst < 0.2, `feet move continuously with the distance-driven phase (max step ${worst.toFixed(3)} units per 1/2000 cycle)`);
  const half = [0.1, 0.4].map((w) => antPoseAt('walk', 0.3, { walkW: w }).legs.reduce((s, l) => s + l.lift, 0));
  ok(half[0] < half[1], 'walk ↔ stand blend scales foot lift');
  ok(JSON.stringify(antPose('walk', 3).legs) === JSON.stringify(antPose('walk', 3).legs) && WALK_FRAMES === 12, 'baked atlas frames unchanged');
}

// 8. inputs never mutated; game view wiring
{
  const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  const ants: AntInput[] = deepFreeze([{ id: 'A', x: 1, y: 2, vis: 'walking', moving: true, heading: 0.3, displayOffset: { dx: 1, dy: 2 } }]);
  const prev = deepFreeze(new Map([['A', { h: 0, phase: 0.2, sx: 0, sy: 0, w: 0.5 }]]));
  const before = JSON.stringify(ants); planAnts({ cx: 0, cy: 0, s: 10, w: 100, h: 100 }, ants, prev, 0.02, walkCycles); ok(JSON.stringify(ants) === before, 'planAnts does not mutate frozen inputs');
  new DisplayMotion().state('A', 3, ctxMixed); ok(true, 'display-motion works on frozen context objects (it never writes them)');
  const canvas = fs.readFileSync(path.join(SRC, 'render-canvas.ts'), 'utf8'), game = fs.readFileSync(path.join(SRC, 'game.ts'), 'utf8');
  ok(/plan = planAnts\(/.test(canvas) && /this\.motion\.state\(d\.id, mo\.tauS/.test(canvas) && !/\bd\.(sx|sy|ex|ey|heading)\s*=[^=]/.test(canvas), 'renderer: micro-motion is computed after planAnts and never writes a drawn position / heading');
  ok(/micro: \{ tauS: t \* 60, damp: playbackDamp\(speed\), context: contextOf \}/.test(game), 'game view: display time = simulated seconds (t × 60), not a frame count');
  ok(/function rawSample\(id: string, tauS: number\): RawSample \{[\s\S]*?antFrame\(idx, d, id/.test(game) && /顯示動畫（示意）/.test(game) && /不是感覺事件/.test(game), 'game view: context only from the engine record (antFrame = model.poseAt); data panel labels the display animation and that it is not perception');
}

// 9. natural-walk page: placeholder data, helpers, docs
{
  const DIR = path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'data', 'placeholder');
  const files = ['straight', 'trail', 'explore', 'obstacle'].map((k) => path.join(DIR, `${k}.json`)), before = files.map((f) => fs.readFileSync(f, 'utf8'));
  for (const [i, f] of files.entries()) {
    const s = JSON.parse(before[i]) as PoseStream;
    ok(validatePoseStream(s).length === 0 && s.schema === POSE_SCHEMA, `${path.basename(f)}: valid ${POSE_SCHEMA}`);
    ok(s.params.placeholder === true && /示意・待 PR A 物理資料/.test(s.label), `${path.basename(f)}: labelled 示意・待 PR A 物理資料`);
    ok(slotOf(s) === SCENES[i].slot, `${path.basename(f)}: maps to scene ${SCENES[i].slot}`);
  }
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'make-placeholder.ts')], { encoding: 'utf8' });
  ok(r.status === 0 && files.every((f, i) => fs.readFileSync(f, 'utf8') === before[i]), 'placeholder generation is deterministic (regenerated files are byte-identical)');
  ok(validatePoseStream({ schema: POSE_SCHEMA, scenario_id: 'x', label: 'x', seed: 1, model: 'B', dt_record_s: 0.1, params: {}, agents: [{ id: 'a', samples: [{ t: 1, x_mm: 0, y_mm: 0, theta: 0, v_mm_s: 0, omega_rad_s: 0 }, { t: 1, x_mm: 0, y_mm: 0, theta: 0, v_mm_s: 0, omega_rad_s: 0 }], events: [] }], obstacles: [], chem_field: null }).length > 0, 'validator rejects non-increasing time');
  const tr = JSON.parse(before[1]) as PoseStream, ag = tr.agents[0], mid = sampleAt(ag, (ag.samples[10].t + ag.samples[11].t) / 2);
  ok(mid.interpolated && Math.abs(mid.x_mm - (ag.samples[10].x_mm + ag.samples[11].x_mm) / 2) < 1e-9 && !sampleAt(ag, ag.samples[10].t).interpolated, 'sampleAt: recorded samples exact, linear between them (labelled interpolation)');
  const cum = cumulativeDistance(ag); ok(Math.abs(distanceAt(ag, cum, ag.samples[ag.samples.length - 1].t) - cum[cum.length - 1]) < 1e-9 && cum.every((x, i) => !i || x >= cum[i - 1]), 'distance travelled is monotone (drives the gait phase)');
  const ob = JSON.parse(before[3]) as PoseStream, closest = Math.max(...ob.agents[0].samples.map((s) => rawFromStream(ob, ob.agents[0], s.t).near));
  ok(closest > 0.5, 'obstacle scene: nearness context comes from the physics obstacle geometry');
  // PR A physics exports (copied byte-identically from the kinematics2d branch): valid, each fills one scene
  const idx = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'data', 'index.json'), 'utf8')) as { files: string[] };
  const slots = new Set<string>();
  for (const f of idx.files) { const s = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'data', f), 'utf8')) as PoseStream; ok(validatePoseStream(s).length === 0 && s.params.placeholder !== true, `PR A ${f}: valid ${POSE_SCHEMA}, not a placeholder`); slots.add(String(slotOf(s))); }
  ok(SCENES.every((x) => slots.has(x.slot)), 'PR A data fills all four scenes');
  // side-by-side model comparison (Owner decision on #163 item 8): same scene per model, produced by PR A's code
  for (const sc of SCENES) {
    const s = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'data', 'compare', `${sc.slot}.json`), 'utf8')) as PoseStream & { notes: string[] };
    const models = s.agents.map((a) => a.model);
    ok(validatePoseStream(s).length === 0 && slotOf(s) === sc.slot && s.model === 'mixed', `compare ${sc.slot}: valid, maps to its scene`);
    ok(models[0] === 'A' && models[1] === 'B' && (sc.slot === 'trail' ? models[2] === 'C' && models.length === 3 : models.length === 2), `compare ${sc.slot}: models ${models.join('/')} (C only where a chemical field exists)`);
    ok(s.notes.some((x) => /6fe6f26/.test(x)) && (sc.slot === 'trail' || s.notes.some((x) => /拒絕執行 C/.test(x))), `compare ${sc.slot}: provenance and the missing-C reason recorded`);
    ok(new Set(s.agents.map((a) => a.samples[0].x_mm + ',' + a.samples[0].y_mm)).size <= 2, `compare ${sc.slot}: models start from the same place`);
  }
  const page = fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'index.html'), 'utf8') + fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'natural-walk.ts'), 'utf8');
  ok(/物理資料/.test(page) && /美術插值/.test(page) && /未驗證候選模型/.test(page) && /R810/.test(page) && /R133/.test(page), 'page labels the three element classes (物理資料／美術插值／未驗證候選模型) and cites R810 / R133');
  ok(/物理資料/.test(page) && /顯示動畫/.test(page) && /示意・待 PR A 物理資料/.test(page) && /不是感覺事件/.test(page), 'page labels physics vs display animation, placeholder and non-perception');
  ok(!/Math\.random/.test(page), 'page: no unseeded randomness');
  ok(/^prototypes\/natural-walk\/screenshots\/$/m.test(fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')) && /mkdirSync\(OUT/.test(fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'natural-walk', 'shoot.cjs'), 'utf8')), 'natural-walk screenshots are generated (npm run natural:shoot) into the git-ignored screenshots/ folder, not committed');
  const gameHtml = fs.readFileSync(path.join(REPO_ROOT, 'web', 'index.html'), 'utf8'), bottom = gameHtml.slice(gameHtml.indexOf('<div id="bottom"'), gameHtml.indexOf('<script', gameHtml.indexOf('<div id="bottom"')));
  ok(/<span class="legend-tag" id="motionTag">頭與觸角動作＝示意動畫（引擎尚未模擬）<\/span>/.test(bottom) && /#bottom \.legend-tag:not\(#motionTag\) \{ display: none; \}/.test(gameHtml), 'game view: the persistent bottom legend (also on phones) says head/antenna motion is display-only animation, not simulated');
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'game-art-style.md'), 'utf8'), sec = doc.slice(doc.indexOf('## 5b'), doc.indexOf('## 6'));
  ok(sec.length > 200 && /示意/.test(sec) && /R133/.test(sec) && /R810/.test(sec) && /非本種/.test(sec) && /未驗證候選模型/.test(sec) && ['EPOCH_S', 'BLEND_S', 'glanceSlotS', 'turnGain', 'sweep', 'probe', 'tap', 'rest', 'WALK_BLEND_S', 'playbackDamp'].every((k) => sec.includes(k)), 'docs §5b: display micro-motion parameters listed as 示意／假設, R133 body-path stats, carpenter-ant study 非本種');
}

console.log(JSON.stringify({ test: 'display-motion', passed: true, checks, metrics }));

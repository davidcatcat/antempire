/**
 * Three.js 3D prototype (web/three.html, web/src/three/; Owner 2026-11-14, #256 / #257 / #258) — Node checks of the
 * pure display modules and source scans. NON-OFFICIAL experiment world (P0-A2 candidate). BLOCKING. Checks:
 *  1. terrain.ts: seeded scenery PRNG / noise are deterministic and bounded; keep-out geometry; 2-D → 3-D axis map.
 *  2. nest3d.ts: the chambers are exactly the 2-D inset grouping by engine state (INSET_ZONES); outside states have no
 *     chamber; slots lie inside their chamber; the shaft path runs from the surface entrance to the transit chamber.
 *  3. placement.ts over 24 h of two real P0-A2 worlds: 30 workers drawn; every surface pose is the SAME display pose as
 *     the 2-D experiment page (VisModel, vis1-model.ts) mapped to 3-D — exactly at the route ends at the recorded
 *     departure / arrival instants, interpolated strictly between; searching / nest / shaft positions are flagged
 *     schematic; the display corridor has the engine route length and depends only on the frame; frames are never
 *     mutated; benchmark worlds draw their in-nest workers buried.
 *  4. motion.ts: the gait phase advances only with the drawn distance (exactly distance / stride) — not while the drawn
 *     point stands, not across a cut, not while paused; the display turn is rate-limited and only toward a recorded
 *     heading change.
 *  5. perf.ts: quantiles, summaries, the NOT-a-device-result rule (software renderer or automation), bench sizes.
 *  6. source scans: no import of engine/, cli/ or the Worker dir; no Math.random; no Worker / storage / network writes;
 *     the Worker only through worker-client with scheduling / observation commands; no hard-coded route; labels
 *     (原型・非正式, 引擎 / 顯示插值 / 示意, NOT a device result) present; MINOR_LEN_CM equals the 2-D renderer's.
 *  7. dependency: three is pinned exactly (MIT) and vendored for every import-map specifier the page uses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import type { P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { VisModel, drawnPoint } from '../web/src/vis1-model.ts';
import { INSET_ZONES, STATE_LABEL, IN_NEST_STATES, OUTSIDE_STATES } from '../web/src/v62-p0a2-model.ts';
import { DIORAMA, FACE_Z, prng, vnoise, fbm, groundHeight, distToSegment, isClear, to3 } from '../web/src/three/terrain.ts';
import { CHAMBERS, chamberOf, chamberSlot, shaftPath, alongPath, larvaSlot } from '../web/src/three/nest3d.ts';
import { antsOf, ACTIVITY_LEVEL, MAIN_PLACE, corridorOf, place3, segmentsOf, slotSpread, type WorldPlace } from '../web/src/three/placement.ts';
import { newMotion, stepMotion, STRIDE_PER_BODY, TURN_RATE, CUT_CM } from '../web/src/three/motion.ts';
import { quantile, summarise, measurementClass, BENCH_SIZES, worldsFor } from '../web/src/three/perf.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const frameOf = (w: P0a2ExperimentWorld) => w.frame() as unknown as P0a2FrameMsg;

// 1. terrain
{
  const a = prng(42), b = prng(42), xs = Array.from({ length: 2000 }, () => a());
  ok(xs.every((x) => x >= 0 && x < 1) && new Set(xs).size > 1990, 'prng in [0, 1), not degenerate');
  ok(xs.slice(0, 50).every((x) => x === b()), 'prng: same seed → same sequence');
  ok(prng(43)() !== prng(42)(), 'prng: another seed → another sequence');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 4000; i++) { const x = (i % 63) * 0.37, z = Math.floor(i / 63) * 0.41, v = vnoise(x, z, 3); lo = Math.min(lo, v); hi = Math.max(hi, v); ok(v === vnoise(x, z, 3), 'vnoise deterministic'); }
  ok(lo >= 0 && hi <= 1, `vnoise bounded [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
  for (let i = 0; i < 500; i++) { const f = fbm(i * 0.7, -i * 0.3, 4, 5); ok(Math.abs(f) <= 0.5, 'fbm bounded'); }
  for (let i = 0; i < 300; i++) { const x = DIORAMA.x0 + (i * 7.3) % (DIORAMA.x1 - DIORAMA.x0), z = DIORAMA.z0 + (i * 11.1) % (DIORAMA.z1 - DIORAMA.z0); const h = groundHeight(x, z); ok(Number.isFinite(h) && h === groundHeight(x, z) && h > DIORAMA.bottom + 30, 'ground height finite, deterministic, above the block bottom'); }
  ok(distToSegment(5, 3, { x: 0, z: 0 }, { x: 10, z: 0 }) === 3 && distToSegment(-4, 3, { x: 0, z: 0 }, { x: 10, z: 0 }) === 5, 'distance to segment');
  const k = { routes: [{ a: { x: 0, z: 0 }, b: { x: 100, z: 0 } }], nests: [{ x: 0, z: 0 }], routeHalfWidth: 6, nestRadius: 9 };
  ok(!isClear(50, 4, k) && isClear(50, 7, k) && !isClear(-5, -5, k), 'keep-out: route corridor and nest clearing');
  ok(to3({ x: 3, y: 4 }).x === 3 && to3({ x: 3, y: 4 }).z === -4, '2-D (x east, y north) → 3-D (X east, Z south)');
}

// 2. nest chambers = the 2-D inset grouping by engine state
{
  ok(CHAMBERS.length === INSET_ZONES.length, 'one chamber per inset zone');
  for (const z of INSET_ZONES) { const c = CHAMBERS.find((x) => x.key === z.key); ok(c && JSON.stringify([...c.states]) === JSON.stringify([...z.states]) && c.label === z.label, `chamber ${z.key} = inset zone (states, label)`); }
  for (const s of IN_NEST_STATES) ok(chamberOf(s) !== null, `in-nest state ${s} has a chamber`);
  for (const s of OUTSIDE_STATES) ok(chamberOf(s) === null, `outside state ${s} has no chamber`);
  for (const c of CHAMBERS) for (const n of [1, 5, 16, 30]) for (const L of [0.25, 3.5, 4.5, 7.5]) {
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const s = chamberSlot(c, i, n, L, (i * 2654435761) >>> 0);
      ok(Math.abs(s.x - c.x) <= c.rx * 1.1 && s.z < FACE_Z && s.z >= FACE_Z - c.rz - 1e-9 && s.y <= c.y && s.y >= c.y - c.ry, `${c.key}: slot ${i}/${n} inside the chamber (L=${L})`);
      seen.add(`${s.x.toFixed(3)},${s.z.toFixed(3)}`);
    }
    // distinct up to the default magnifications (×14 desktop / ×18 phone); at ×30 a small chamber cannot hold 30 ants
    if (L <= 4.5) ok(seen.size === n, `${c.key}: ${n} distinct slots (L=${L})`);
  }
  const P = shaftPath(groundHeight(0, 0)), a0 = alongPath(P, 0), a1 = alongPath(P, 1);
  ok(a0.x === 0 && a0.z === 0 && a0.y === groundHeight(0, 0), 'shaft starts at the surface entrance');
  const tr = CHAMBERS.find((c) => c.key === 'transit')!;
  ok(Math.hypot((a1.x - tr.x) / tr.rx, (a1.y - tr.y) / tr.ry) <= 1 && a1.z < FACE_Z, 'shaft ends inside the transit chamber, behind the face');
  let prev = -1; for (let k = 0; k <= 1; k += 0.01) { const p = alongPath(P, k), d = Math.hypot(p.x - a0.x, p.y - a0.y, p.z - a0.z); ok(Number.isFinite(d), 'shaft point finite'); prev = d; } void prev;
  for (let i = 0; i < 8; i++) { const s = larvaSlot(i, 8); ok(s.z < FACE_Z && Number.isFinite(s.y), 'larva slot behind the face'); }
}

// 3. placement over 24 h of real P0-A2 worlds (non-official experiment)
const stats = { samples: 0, route: 0, exactEnds: 0, interpolated: 0, search: 0, source: 0, nest: 0, shaft: 0, buried: 0 };
for (const seed of [1, 7]) {
  const { world } = P0a2ExperimentWorld.create(`exp-three-${seed}`, seed), f0 = frameOf(world), vis = VisModel.of(f0);
  // the display corridor: only from the frame (seed + engine route length); its length is the engine route length
  const C = corridorOf(vis, MAIN_PLACE, 1); let len = 0; for (let i = 1; i < C.length; i++) len += Math.hypot(C[i].x - C[i - 1].x, C[i].z - C[i - 1].z);
  ok(Math.abs(len - f0.layout.source_distance_cm) < 1e-6 * f0.layout.source_distance_cm, `seed ${seed}: drawn corridor length = engine route length ${f0.layout.source_distance_cm} cm`);
  ok(JSON.stringify(corridorOf(VisModel.of(f0), MAIN_PLACE)) === JSON.stringify(corridorOf(vis, MAIN_PLACE)), `seed ${seed}: corridor depends only on the frame`);
  ok(segmentsOf(C).length === C.length - 1, 'keep-out segments follow the corridor');
  const bench: WorldPlace = { index: 3, dx: 40, dz: -30, rot: 0.4, cutaway: false };
  for (let t = 0; t <= 86_400; t += 97) {
    world.advanceTo(t); const f = frameOf(world), frozen = JSON.stringify(f), L = 0.25 * 14;
    const ants = antsOf(f, f.t_sim, MAIN_PLACE, L, [{ x: 0, z: 0 }], vis);
    ok(ants.length === f.workers.length && f.workers.length === 30, 'every worker of the frame is drawn (30)');
    for (const a of ants) {
      const w = f.workers.find((x) => x.id === a.id)!, p = vis.pose(w, f.t_sim); stats.samples++;
      ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z), 'finite position');
      if ((IN_NEST_STATES as readonly string[]).includes(w.state)) {
        ok(a.where === 'nest' || a.where === 'shaft', `${w.state}: drawn in the schematic nest`); ok(a.schematic, 'nest position flagged schematic');
        if (a.where === 'shaft') stats.shaft++; else stats.nest++;
        continue;
      }
      ok(a.where === p.where && a.interpolated === p.interpolated && a.schematic === p.schematic && a.moving === p.walking, `${w.state}: flags are the shared display pose's`);
      const s = slotSpread(L), q = place3({ x: p.x + (p.slot?.dx ?? 0) * s, y: p.y + (p.slot?.dy ?? 0) * s }, MAIN_PLACE);
      ok(a.x === q.x && a.z === q.z, `${w.state}: drawn point = the 2-D page's display pose (mapped to 3-D)`);
      if (!p.slot) { const d = drawnPoint(p); ok(a.x === d.x && a.z === -d.y, 'off the source: exactly the 2-D drawn point'); }
      if (w.state === 'searching') { stats.search++; ok(a.schematic, 'searching: schematic'); }
      if (w.state === 'feeding') stats.source++;
      if (w.state === 'outbound' || w.state === 'returning') {
        stats.route++;
        if (w.until_s !== null && f.t_sim > w.since_s && f.t_sim < w.until_s) { ok(a.interpolated, 'between the recorded instants: display interpolation'); stats.interpolated++; }
        // the recorded instants themselves: exactly at the trip ends
        for (const [tt, end] of [[w.since_s, 'from'], [w.until_s, 'to']] as const) {
          if (tt === null) continue;
          const e = vis.pose(w, tt), P = vis.trip(w), want = end === 'from' ? P.from : P.to;
          ok(e.x === want.x && e.y === want.y && !e.interpolated, `${w.id} exactly at the trip ${end} at its recorded instant`); stats.exactEnds++;
        }
      }
    }
    ok(JSON.stringify(f) === frozen, 'the frame is never mutated by the placement');
    const b = antsOf(f, f.t_sim, bench, L, [{ x: 0, z: 0 }, { x: 40, z: -30 }], vis);
    for (const a of b) if ((IN_NEST_STATES as readonly string[]).includes(a.state)) { ok(a.buried && a.y < -5, 'benchmark world: in-nest workers buried (no cut face)'); stats.buried++; }
  }
}
ok(stats.exactEnds > 50 && stats.interpolated > 50 && stats.search > 0 && stats.nest > 1000, `24 h coverage ${JSON.stringify(stats)}`);
for (const s of Object.keys(STATE_LABEL)) ok(typeof ACTIVITY_LEVEL[s] === 'number' && ACTIVITY_LEVEL[s] > 0 && ACTIVITY_LEVEL[s] <= 1, `micro-motion level for ${s}`);
ok(slotSpread(0.25) === 1 && slotSpread(3.6) === 3, 'feeding-spot widening grows only with the drawn body length');

// 4. motion: gait phase from drawn distance only
{
  const bodyLen = 3.5, stride = STRIDE_PER_BODY * bodyLen, m = newMotion();
  stepMotion(m, { x: 0, y: 0, z: 0, yaw: 0, moving: true, act: 0.5 }, 1 / 60, bodyLen);
  ok(m.phase === 0, 'first sample places the ant, no step');
  let x = 0;
  for (let i = 0; i < 200; i++) {
    const d = 0.03 + (i % 7) * 0.01, ph = m.phase; x += d;
    stepMotion(m, { x, y: 0, z: 0, yaw: 0, moving: true, act: 0.5 }, 1 / 60, bodyLen);
    ok(Math.abs((m.phase - ph) - (d / stride) * Math.PI * 2) < 1e-9, 'phase advance = drawn distance / stride');
  }
  for (const dt of [1 / 60, 0.1, 0]) { const ph = m.phase; stepMotion(m, { x, y: 0, z: 0, yaw: 0, moving: false, act: 0.2 }, dt, bodyLen); ok(m.phase === ph, `standing (dt ${dt}): phase unchanged`); }
  { const ph = m.phase; x += CUT_CM + 1; stepMotion(m, { x, y: 0, z: 0, yaw: 1, moving: false, act: 0.2 }, 1 / 60, bodyLen); ok(m.phase === ph && m.yaw === 1, 'a cut (state change jump) is not a walk: no phase, heading snaps'); }
  { const ph = m.phase, y0 = m.yaw; stepMotion(m, { x, y: 0, z: 0, yaw: 2.5, moving: false, act: 0.2 }, 0, bodyLen); ok(m.phase === ph && m.yaw === y0, 'paused (dt 0): no turn, no phase'); }
  { const y0 = m.yaw; stepMotion(m, { x, y: 0, z: 0, yaw: 2.5, moving: false, act: 0.2 }, 0.05, bodyLen); ok(Math.abs(m.yaw - y0) <= TURN_RATE * 0.05 + 1e-12 && m.yaw > y0, 'display turn toward the recorded heading, rate-limited'); }
  { const m2 = newMotion(); stepMotion(m2, { x: 0, y: 0, z: 0, yaw: 0.3, moving: false, act: 0.2 }, 1 / 60, bodyLen); const y0 = m2.yaw; stepMotion(m2, { x: 0, y: 0, z: 0, yaw: null, moving: false, act: 0.2 }, 1, bodyLen); ok(m2.yaw === y0, 'no recorded heading → no turn'); }
}

// 5. perf
{
  ok(quantile([1, 2, 3, 4, 5], 0.5) === 3 && quantile([1, 2, 3, 4, 5], 0.25) === 2 && Number.isNaN(quantile([], 0.5)), 'quantile');
  const s = summarise(Array(120).fill(1000 / 60), Array(120).fill(2));
  ok(s.frames === 120 && Math.abs(s.fps_mean - 60) < 0.01 && Math.abs(s.frame_ms.p50 - 16.67) < 0.01 && s.cpu_ms.p95 === 2, 'summary of a steady 60 fps run');
  const j = summarise([16, 16, 16, 100], [1, 1, 1, 1]); ok(j.frame_ms.max === 100 && j.fps_p5_low < j.fps_mean, 'a hitch lowers the p5-low');
  for (const r of ['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver', null]) ok(measurementClass(r, false) === 'NOT a device result', `software / unknown renderer is NOT a device result (${r})`);
  ok(measurementClass('ANGLE (Apple, Apple M2, OpenGL 4.1)', true) === 'NOT a device result', 'automation is NOT a device result');
  ok(measurementClass('Adreno (TM) 730', false) === 'device', 'hardware renderer, not automated → device');
  ok(JSON.stringify([...BENCH_SIZES]) === '[30,100,1000]' && worldsFor(30) === 1 && worldsFor(100) === 4 && worldsFor(1000) === 34, 'bench sizes 30 / 100 / 1000 → 1 / 4 / 34 independent worlds');
}

// 6. source scans
{
  const dir = 'web/src/three', files = fs.readdirSync(path.join(REPO_ROOT, dir)).filter((f) => f.endsWith('.ts'));
  ok(['ant-model.ts', 'garden.ts', 'main.ts', 'motion.ts', 'nest3d.ts', 'perf.ts', 'placement.ts', 'terrain.ts'].every((f) => files.includes(f)), 'prototype modules present');
  const PURE = ['motion.ts', 'nest3d.ts', 'perf.ts', 'placement.ts', 'terrain.ts'];
  for (const f of files) {
    const code = read(`${dir}/${f}`);
    for (const m of code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const spec = m[1], resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(dir, spec)) : spec;
      ok(!/(^|\/)(engine|cli|prototypes)\//.test(resolved) && !/worker-dist|continuous-world/.test(resolved), `${f}: no engine / cli / Worker import (${spec})`);
      ok(spec.startsWith('.') ? resolved.startsWith('web/src/') : /^three(\/addons\/(controls\/OrbitControls|utils\/BufferGeometryUtils)\.js)?$/.test(spec), `${f}: imports only viewer modules or the vendored three (${spec})`);
    }
    ok(!/Math\.random/.test(code), `${f}: no Math.random (seeded scenery only)`);
    ok(!/new\s+Worker\s*\(|postMessage|indexedDB|localStorage|sessionStorage|caches\.|fetch\s*\(|XMLHttpRequest|navigator\.locks/.test(code), `${f}: no Worker / storage / network access of its own`);
    if (PURE.includes(f)) ok(!/from 'three'|document\.|window\.|performance\.now|Date\.now|requestAnimationFrame/.test(code), `${f}: pure (no Three.js, DOM or clock)`);
  }
  const main = read(`${dir}/main.ts`);
  ok(/from '\.\.\/experimental\/worker-client\.ts'/.test(main), 'main.ts talks to the Worker only through worker-client');
  const used = new Set([...main.matchAll(/client\.(\w+)\s*\(/g)].map((m) => m[1]));
  ok([...used].every((c) => ['init', 'stepUntil', 'setSpeed', 'start', 'pause', 'resume', 'follow', 'terminate'].includes(c)) && used.has('init') && used.has('follow'), `only scheduling / observation commands (${[...used].join(', ')})`);
  ok(!/sendRaw|restore\(|snapshot\(/.test(main), 'no raw messages, no restore / snapshot');
  // no hard-coded route: the route line and keep-out come from the frame through the shared display model
  ok(/course = corridorOf\(f0\.vis!/.test(main) && /garden\.routeLine\(course\)/.test(main) && /VisModel\.of\(fr\)/.test(main), 'route line and keep-out from corridorOf(VisModel.of(frame))');
  for (const f of ['main.ts', 'placement.ts', 'garden.ts']) ok(!/Math\.PI\s*\/\s*7|source_distance_cm\s*[:=]\s*\d|\b200\s*\*\s*Math\.(cos|sin)/.test(read(`${dir}/${f}`)), `${f}: no hard-coded route bearing or length`);
  ok(/seed = SEED \+ i/.test(main) && /cutaway: false/.test(main), 'benchmark worlds: independent seeds, no cut face');
  ok(/if \(running\) uTime\.value \+= dtReal/.test(main) && /running \? dtReal : 0/.test(main), 'micro-motion clock and display turns stop while the world is paused');
  const html = read('web/three.html'), perf = read(`${dir}/perf.ts`);
  for (const s of ['原型・非正式', '引擎', '顯示插值', '示意', '非正式', '位置與路線長度不放大', 'NOT a device result', 'P0-A2 沒有任何 2D 或 3D 座標']) ok(html.includes(s) || main.includes(s), `label present: ${s}`);
  ok(perf.includes("'NOT a device result'"), 'perf.ts names NOT a device result');
  ok(/vendor\/three\/three\.module\.js/.test(html) && !/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'three from the local vendor copy, no CDN / network URL');
  // read as text: vis1-render.ts is a DOM (Canvas 2D) module that the Node type check does not load
  const ant = read(`${dir}/ant-model.ts`), m = /export const MINOR_LEN_CM = ([\d.]+);/.exec(ant), m2 = /export const MINOR_LEN_CM = ([\d.]+);/.exec(read('web/src/vis1-render.ts')), MINOR_LEN_2D = Number(m2?.[1]);
  ok(m && Number(m[1]) === MINOR_LEN_2D, `MINOR_LEN_CM ${m?.[1]} = 2-D renderer ${MINOR_LEN_2D}`);
}

// 7. dependency: pinned, MIT, vendored for every import-map specifier
{
  const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'));
  ok(pkg.devDependencies.three === '0.187.0' && pkg.devDependencies['@types/three'] === '0.187.0', 'three / @types/three pinned exactly');
  ok(lock.packages['node_modules/three']?.version === '0.187.0' && lock.packages['node_modules/three']?.license === 'MIT', 'lockfile: three 0.187.0, MIT');
  const vend = read('cli/web-vendor-three.ts');
  for (const f of ['three.module.js', 'three.core.js', 'addons/controls/OrbitControls.js', 'addons/utils/BufferGeometryUtils.js', 'LICENSE']) ok(vend.includes(`'${f}'`), `vendored: ${f}`);
  ok(/web\/vendor\//.test(read('.gitignore')) && /web-vendor-three\.ts/.test(pkg.scripts['web:build']), 'vendor copy generated by web:build, git-ignored');
}

console.log(JSON.stringify({ test: 'web-three-proto', checks, stats }));

/**
 * V6-2 experiment mode (P0-A2 PR 3) — Node checks of the display model and of the mode isolation. Non-official.
 *  1. drawn = engine at record instants: for three seeds over 24 h, at every ant event instant the display pose
 *     (v62-model.poseAt) of the frame BEFORE the event equals the event's recorded position bit for bit, and the pose
 *     from the frame AFTER the event equals it too; between records the pose is flagged interpolated and stays on the
 *     recorded segment; in-nest ants are never given a drawn position; frames are never mutated.
 *  2. display clock: paused = the frame's t_sim exactly; running lead bounded; no step back within the lead.
 *  3. world time formatting; event digest is order-sensitive and detects gaps.
 *  4. UI operations do not change results: the same Runtime command sequences the page sends (follow, speed changes,
 *     pause / resume, irregular tick sizes) then step_until T give the same event digest and payload hash as a direct
 *     step_until T.
 *  5. isolation (static): the official pages (index.html → game.ts, analysis.html → main.ts) never reach the Worker
 *     client or the experiment page; the experiment page's runtime graph has no fetch / XHR, names no web/data,
 *     saves/ or journal/ path, imports only viewer modules, and the simulation is not run on the main thread.
 *  6. saves/ and journal/ unchanged.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { ExperimentWorld } from '../prototypes/continuous-world/worker/core.ts';
import { Runtime } from '../prototypes/continuous-world/worker/runtime.ts';
import { DEFAULT_SPEED, DISPLAY_LEAD_S, EventDigest, V62_SPEEDS, antInputs, clockOf, displayTime, fmtWorldTime, poseAt, posesAt, worldDay } from '../web/src/v62-model.ts';
import type { EventMsg, FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import type { P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import { P0A2_STATUS_LABEL, P0_LIGHT_LABEL, SOURCE_BEARING_RAD, insetSlots, layoutOf, p0AntInputs, p0Light, p0Pose, p0Poses, stateCounts } from '../web/src/v62-p0a2-model.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const dirHash = (d: string) => { const h = crypto.createHash('sha256'); const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { h.update(path.relative(REPO_ROOT, f)); h.update(fs.readFileSync(f)); } } }; walk(path.join(REPO_ROOT, d)); return h.digest('hex'); };
const formalBefore = { saves: dirHash('saves'), journal: dirHash('journal') };

// 1. drawn = engine at record instants
const stats = { events: 0, exactBefore: 0, exactAfter: 0, interpolatedSamples: 0, inNestSamples: 0 };
for (const seed of [3, 11, 29]) {
  const { world } = ExperimentWorld.create(`exp-v62-${seed}`, seed);
  let f = world.frame() as unknown as FrameMsg;
  while (world.tSim() < 86_400) {
    const next = Math.min(...f.ants.map((a) => a.until_s));
    // samples strictly inside the current segments: interpolated, on the segment
    for (const a of f.ants) for (const u of [0.25, 0.5, 0.75]) {
      const t = f.t_sim + (next - f.t_sim) * u, p = poseAt(a, t);
      if (a.in_nest) { assert.ok(p.vis === 'in_nest' && !p.interpolated, 'in-nest ant: no drawn position'); stats.inNestSamples++; continue; }
      if (a.activity === 'walking' && a.to && t > a.since_s && t < a.until_s) {
        const lo = (v: 'x' | 'y') => Math.min(a.from[v], a.to![v]) - 1e-9, hi = (v: 'x' | 'y') => Math.max(a.from[v], a.to![v]) + 1e-9;
        assert.ok(p.interpolated && p.x >= lo('x') && p.x <= hi('x') && p.y >= lo('y') && p.y <= hi('y'), 'interpolated point stays on the recorded segment');
        stats.interpolatedSamples++;
      } else assert.ok(!p.interpolated, 'outside a walking segment nothing is interpolated');
    }
    const frozen = JSON.stringify(f); posesAt(f, next); antInputs(posesAt(f, next));
    assert.equal(JSON.stringify(f), frozen, 'pose computation never mutates the Worker frame');
    const r = world.advanceTo(next), after = world.frame() as unknown as FrameMsg;
    for (const e of r.events as unknown as EventMsg[]) {
      if (e.kind !== 'ant_bout_end') continue;
      stats.events++;
      const rec = e.data.pos as { x: number; y: number }, before = f.ants.find((a) => a.id === e.entity)!, now = after.ants.find((a) => a.id === e.entity)!;
      const pb = poseAt(before, e.t_sim), pa = poseAt(now, e.t_sim);
      assert.ok(pb.x === rec.x && pb.y === rec.y, `${e.entity} @${e.t_sim}: drawn pose before the event = recorded position`); stats.exactBefore++;
      assert.ok(pa.x === rec.x && pa.y === rec.y, `${e.entity} @${e.t_sim}: drawn pose after the event = recorded position`); stats.exactAfter++;
      assert.ok(!pb.interpolated && !pa.interpolated, 'a record instant is never labelled interpolation');
    }
    f = after;
  }
}
ok(stats.events > 3000 && stats.exactBefore === stats.events && stats.exactAfter === stats.events, `every ant record instant drawn exactly (${JSON.stringify(stats)})`);
ok(stats.interpolatedSamples > 1000 && stats.inNestSamples > 1000, 'interpolation and in-nest cases both exercised');

// 2. display clock
ok(displayTime(1234.5, false, 3600, 999, 1300) === 1234.5, 'paused: display time = the frame t_sim exactly');
ok(displayTime(100, true, 60, 10_000, null) === 100 + 60 * DISPLAY_LEAD_S, 'running: lead capped');
ok(displayTime(100, true, 60, 10, 102) === 102, 'running: no step back within the lead');
ok(displayTime(100, true, 60, 0, 200) === 100 + 60 * DISPLAY_LEAD_S, 'running: never beyond frame + lead');
ok(DEFAULT_SPEED === 1 && V62_SPEEDS[0] === 1, 'default observation speed is 1× (Owner decision 47)');

// 3. formatting and digest
ok(fmtWorldTime(0) === '實驗第 0 天 00:00:00' && clockOf(86_399.9) === '23:59:59' && fmtWorldTime(90_061) === '實驗第 1 天 01:01:01' && worldDay(172_800) === 2, 'world time = ⌊t/86400⌋ and HH:MM:SS');
{
  const { world, events } = ExperimentWorld.create('exp-digest', 5); const evs = [...events, ...world.advanceTo(7200).events] as unknown as EventMsg[];
  const d1 = new EventDigest(), d2 = new EventDigest(), d3 = new EventDigest();
  for (const e of evs) d1.add(e); for (const e of evs) d2.add(e); for (const e of [...evs].reverse()) d3.add(e);
  ok(d1.value() === d2.value() && d1.value() !== d3.value() && d1.gaps === 0 && d3.gaps > 0, 'digest: same stream equal; order and gaps detected');
}

// 4. UI operations do not change results (Runtime with a fake wall clock, the commands the page sends)
type Rep = ReturnType<Runtime['handle']>;
function session(ops: (send: (m: Record<string, unknown>) => void, tick: (ms: number) => void) => void, T: number) {
  let wall = 0, req = 0; const rt = new Runtime(() => wall), dig = new EventDigest();
  const take = (rs: Rep) => { for (const x of rs) if (x.type === 'events') for (const e of x.events) dig.add(e); };
  const send = (m: Record<string, unknown>) => take(rt.handle({ ...m, req: ++req }));
  const tick = (ms: number) => { wall += ms; take(rt.tick()); };
  send({ type: 'init', world_id: 'exp-v62-ui', seed: 17 });
  ops(send, tick);
  if (rt.isRunning()) send({ type: 'pause' });
  send({ type: 'step_until', t_sim: T });
  const snap = rt.current()!.snapshot();
  return { digest: dig.value(), count: dig.count, gaps: dig.gaps, hash: snap.payload_sha256 };
}
const T = 30 * 3600 + 0.5;
const plain = session(() => {}, T);
const variants = {
  speeds_pause_follow: session((send, tick) => { send({ type: 'set_speed', speed: 1 }); send({ type: 'start' }); for (let i = 0; i < 50; i++) tick(16); send({ type: 'follow', id: 'w03' }); send({ type: 'set_speed', speed: 3600 }); for (let i = 0; i < 300; i++) tick(17 + (i % 5)); send({ type: 'pause' }); send({ type: 'follow', id: null }); send({ type: 'resume' }); send({ type: 'set_speed', speed: 600 }); for (let i = 0; i < 200; i++) tick(33); }, T),
  fps_like_ticks: session((send, tick) => { send({ type: 'set_speed', speed: 5 }); send({ type: 'start' }); for (let i = 0; i < 400; i++) tick(i % 3 === 0 ? 66 : 16); send({ type: 'set_speed', speed: 60 }); for (let i = 0; i < 400; i++) tick(250); }, T),
  stepwise: session((send) => { for (let t = 1000; t < T; t += 977.25) send({ type: 'step_until', t_sim: t }); }, T),
};
for (const [k, v] of Object.entries(variants)) ok(v.digest === plain.digest && v.count === plain.count && v.hash === plain.hash && v.gaps === 0, `UI operations (${k}) do not change the event stream or the full state at the same t_sim`);

// 4b. P0-A2 world (#156 phase 3): drawn = engine state at record instants; interpolation only between the recorded
//     ends of a route trip; schematic placements flagged; the light follows the engine light state; UI operations do
//     not change the event stream or the event-log hash.
{
  const st = { travelling: 0, exactEnds: 0, interpolated: 0, schematic: 0, feeding: 0, inNest: 0, frames: 0, lights: new Set<string>() };
  for (const seed of [3, 11]) {
    const { world } = P0a2ExperimentWorld.create(`exp-v62-p0-${seed}`, seed);
    for (let t = 0; t <= 86_400; t += 97) {
      world.advanceTo(t); const f = world.frame() as unknown as P0a2FrameMsg, L = layoutOf(f), frozen = JSON.stringify(f); st.frames++;
      const slots = insetSlots(f), inNest = f.workers.filter((w) => w.loc !== 'outside');
      assert.ok(slots.length === inNest.length && inNest.every((w) => slots.some((s) => s.id === w.id)), 'nest inset shows exactly the workers in the nest (engine location)');
      assert.ok(Object.values(stateCounts(f)).reduce((a, b) => a + b, 0) === f.workers.length, 'state counts cover every worker');
      st.lights.add(`${f.env.light}|${p0Light(f).label}`);
      assert.ok(p0Light(f).label.includes(P0_LIGHT_LABEL[f.env.light]), 'scene light names the engine light state');
      for (const w of f.workers) {
        const p = p0Pose(w, f.t_sim, L);
        if (w.state === 'outbound' || w.state === 'returning') {
          st.travelling++;
          const [a, b] = w.state === 'outbound' ? [L.nest, L.source] : [L.source, L.nest];
          const p0 = p0Pose(w, w.since_s, L), p1 = p0Pose(w, w.until_s!, L), pm = p0Pose(w, (w.since_s + w.until_s!) / 2, L);
          assert.ok(p0.x === a.x && p0.y === a.y && !p0.interpolated && p1.x === b.x && p1.y === b.y && !p1.interpolated, `${w.id}: at its recorded departure / arrival instants drawn exactly at the route ends`); st.exactEnds += 2;
          assert.ok(pm.interpolated && Math.abs((pm.x - a.x) * (b.y - a.y) - (pm.y - a.y) * (b.x - a.x)) < 1e-6, `${w.id}: between the records: display interpolation on the route`); st.interpolated++;
          assert.ok(!p.schematic && p.where === 'route', 'route travel is engine state, not schematic');
        } else if (w.state === 'feeding') { st.feeding++; assert.ok(p.x === L.source.x && p.y === L.source.y && p.where === 'source' && !p.interpolated, 'feeding worker drawn at the source'); }
        else if (w.state === 'searching') { st.schematic++; assert.ok(p.schematic && !p.interpolated && p.where === 'search', 'searching worker: schematic point (search has no spatial model)'); }
        else { st.inNest++; assert.ok(p.vis === 'in_nest' && !p.interpolated, 'worker in the nest has no surface position'); }
      }
      p0AntInputs(p0Poses(f, f.t_sim + 3)); assert.equal(JSON.stringify(f), frozen, 'P0-A2 pose computation never mutates the Worker frame');
    }
  }
  ok(st.travelling > 200 && st.interpolated === st.travelling && st.inNest > 1000, `P0-A2: ${st.travelling} travelling workers drawn exactly at the recorded ends and interpolated only between them; ${st.inNest} in-nest samples (${st.frames} frames)`);
  ok(st.schematic + st.feeding >= 0 && [...st.lights].some((x) => x.startsWith('night')) && [...st.lights].some((x) => x.startsWith('day')), `P0-A2 scene light follows the engine light state through a day (${st.lights.size} light buckets)`);
  ok(SOURCE_BEARING_RAD !== 0 && P0A2_STATUS_LABEL === '候選／實驗世界，非正式', 'P0-A2 labels: candidate / experiment world, route direction schematic');
  // UI operations through the dispatcher: same event digest, count and event-log hash at the same t_sim
  const p0session = (ops: (send: (m: Record<string, unknown>) => void, tick: (ms: number) => void) => void, T: number) => {
    let wall = 0, req = 0; const rt = new Runtime(() => wall), dig = new EventDigest();
    const take = (rs: Rep) => { for (const x of rs) if (x.type === 'events') for (const e of x.events) dig.add(e); };
    const send = (m: Record<string, unknown>) => take(rt.handle({ ...m, req: ++req }));
    send({ type: 'init', world_id: 'exp-v62-p0-ui', seed: 17, kind: 'p0a2' }); ops(send, (ms) => { wall += ms; take(rt.tick()); });
    if (rt.isRunning()) send({ type: 'pause' });
    send({ type: 'step_until', t_sim: T });
    return { digest: dig.value(), count: dig.count, gaps: dig.gaps, log: (rt.current()!.frame() as P0a2FrameMsg).log.hash, hash: rt.current()!.snapshot().payload_sha256 };
  };
  const PT = 20 * 3600 + 0.5, p0plain = p0session(() => {}, PT);
  const p0var = {
    speeds_pause_follow: p0session((send, tick) => { send({ type: 'start' }); for (let i = 0; i < 40; i++) tick(16); send({ type: 'follow', id: 'w003' }); send({ type: 'set_speed', speed: 3600 }); for (let i = 0; i < 300; i++) tick(17 + (i % 5)); send({ type: 'pause' }); send({ type: 'follow', id: null }); send({ type: 'resume' }); send({ type: 'set_speed', speed: 600 }); for (let i = 0; i < 100; i++) tick(33); }, PT),
    fps_cap_like_ticks: p0session((send, tick) => { send({ type: 'set_speed', speed: 60 }); send({ type: 'start' }); for (let i = 0; i < 300; i++) tick(i % 3 === 0 ? 66 : 16); send({ type: 'set_speed', speed: 3600 }); for (let i = 0; i < 50; i++) tick(250); }, PT),
    stepwise: p0session((send) => { for (let t = 1000; t < PT; t += 977.25) send({ type: 'step_until', t_sim: t }); }, PT),
  };
  for (const [k, v] of Object.entries(p0var)) ok(v.digest === p0plain.digest && v.count === p0plain.count && v.log === p0plain.log && v.hash === p0plain.hash && v.gaps === 0, `P0-A2: UI operations (${k}) do not change the event stream, the event-log hash or the full state at the same t_sim`);
}

// 5. isolation (static)
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const runtimeImports = (src: string) => [...strip(src).matchAll(/\bimport\s+(?!type\b)[^'";]*?from\s*'([^']+)'/g)].map((m) => m[1]);
function graph(entry: string): string[] {
  const seen = new Set<string>(), q = [entry];
  while (q.length) { const f = q.shift()!; if (seen.has(f)) continue; seen.add(f); for (const s of runtimeImports(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))) q.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), s))); }
  return [...seen].sort();
}
for (const [page, script] of [['web/index.html', 'web/src/game.ts'], ['web/analysis.html', 'web/src/main.ts']]) {
  const html = fs.readFileSync(path.join(REPO_ROOT, page), 'utf8'), g = graph(script);
  ok(!/v62|experimental\/|worker-dist/.test(html), `${page} loads no experiment script`);
  ok(!g.some((f) => f.includes('experimental/') || f.endsWith('v62.ts') || f.endsWith('v62-model.ts') || f.includes('v62-p0a2')), `${page}: official graph never reaches the Worker client or the experiment page (${g.length} modules)`);
}
const exHtml = fs.readFileSync(path.join(REPO_ROOT, 'web/experiment.html'), 'utf8');
ok(/<script type="module" src="dist\/v62\.js"><\/script>/.test(exHtml) && (exHtml.match(/<script/g) ?? []).length === 1, 'experiment.html loads only dist/v62.js');
ok(exHtml.includes('非正式實驗世界／不屬於正式遊戲歷史') && exHtml.includes('>非正式<') && exHtml.includes('顯示插值') && exHtml.includes('示意'), 'experiment page is labelled non-official and names the three data classes');
const vg = graph('web/src/v62.ts');
ok(vg.includes('web/src/experimental/worker-client.ts') && vg.includes('web/src/render-canvas.ts'), 'experiment page uses the Worker client and the layered renderer');
for (const f of vg) {
  const code = strip(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
  ok(!/\bfetch\s*\(|XMLHttpRequest|['"`]\.?\/?data\/|saves\/|journal\/|localStorage/.test(code), `${f}: no fetch, no web/data / saves / journal path, no localStorage (experiment graph)`);
  // SAVE-2: browser persistence only in the boundary-listed save store (IndexedDB of non-official experiment worlds)
  ok(f === 'web/src/experimental/save-store.ts' || !/indexedDB|navigator\s*\.\s*(storage|locks)/.test(code), `${f}: browser persistence only in the experimental save store`);
  ok(!/prototypes\/|engine\/|cli\//.test(runtimeImports(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).join(' ')), `${f}: no engine / Worker / cli import (the simulation is not run on the main thread)`);
  ok(!/\bnew\s+Worker\s*\(/.test(code) || f === 'web/src/experimental/worker-client.ts', `${f}: only the client creates the Worker`);
}

// 6. official data untouched
ok(dirHash('saves') === formalBefore.saves && dirHash('journal') === formalBefore.journal, 'saves/ and journal/ unchanged');
console.log(JSON.stringify({ test: 'web-v62-experiment', checks, record_instants: stats, ui_variants: Object.keys(variants).length, plain }));

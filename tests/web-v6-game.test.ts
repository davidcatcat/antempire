/**
 * V6 Game View (phase 1) — the animated garden replays the engine record and never invents ecology.
 *  1. every frame position equals model.poseAt on the FULL day (the per-worker index changes nothing), for every
 *     rostered worker, every day of every exported replay, at every recorded boundary and between them;
 *  2. only walks between two places with a recorded garden position are drawn; ants at, or walking to/from, a place
 *     without one are 'unknown_place' (not drawn); ants in the nest are not drawn; heading = the recorded edge direction;
 *     'moving' only strictly between two recorded points;
 *  3. the optional idle skip lands on a recorded walk (no walk is skipped over);
 *  4. display arrangement (lane offset, site slots) and the decorative scenery are deterministic and keep clear of places;
 *  5. the page modules import only viewer modules, use no Math.random, create no events and do not write;
 *     index.html is the game view, analysis.html the V5 analysis view, and both label what is interpolation / schematic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { displayPositions, poseAt, stateAtStart, windowOf, segmentsOf, type Experiment } from '../web/src/model.ts';
import { antFrame, anyWalking, walkIntervals, buildDayIndex, gardenBounds, laneOffset, nextWalkStart, rosterAtStart, sceneDecor, siteSlot, hash32 } from '../web/src/game-model.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const WEB = path.join(REPO_ROOT, 'web'), DATA = path.join(WEB, 'data');
const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
let frames = 0, walking = 0, moving = 0, unknown = 0, skips = 0;

for (const meta of index.experiments) {
  const exp = JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8')) as Experiment, pos = displayPositions(exp.map.places);
  for (const d of exp.days) {
    const idx = buildDayIndex(d), walksD = walkIntervals(d), roster = rosterAtStart(exp, d.day), win = windowOf(d);
    ok(JSON.stringify(roster) === JSON.stringify(stateAtStart(exp, d.day).workers.map((w) => w.id).sort()), `${meta.id} D${d.day}: roster = engine start-of-day workers`);
    for (const id of roster) {
      const ts = new Set<number>([0, win, win / 2]);
      for (const s of segmentsOf(d, id)) { const a = s.start as number, b = s.end as number; for (const x of [a, b, (a + b) / 2, a + (b - a) * 0.1, a + (b - a) * 0.9]) ts.add(x); }
      for (const e of d.events) if (e.type === 'route_step' && e.worker === id) ts.add(e.minute as number);
      for (const t of ts) {
        const f = antFrame(idx, d, id, t, pos), p = poseAt(d, id, t, pos); frames++;
        assert.ok(f.x === p.x && f.y === p.y && f.place === p.place && f.action === p.action && f.interpolated === p.interpolated, `${meta.id} D${d.day} ${id} t=${t}: frame = poseAt on the full day`);
        if (f.vis === 'walking') {
          walking++; const [a, b] = f.place.split('>');
          assert.ok(pos[a].known && pos[b].known && f.heading === Math.atan2(pos[b].y - pos[a].y, pos[b].x - pos[a].x), `${id}: walking only between known places, heading = recorded edge`);
          if (f.moving) { moving++; assert.ok(p.interpolated, 'moving only strictly between recorded points'); }
        } else assert.ok(!f.moving && f.heading === null, `${id}: not walking → not moving, no heading`);
        if (f.vis === 'at_site') assert.ok(pos[f.place].known && f.place !== 'N00', `${id}: at_site only at a known non-nest place`);
        if (f.vis === 'unknown_place') { unknown++; assert.ok(f.place.split('>').some((q) => !pos[q]?.known), `${id}: unknown_place only when a place has no recorded position`); }
        if (f.vis === 'in_nest') assert.ok(f.place === 'N00', `${id}: in_nest only at the nest`);
      }
    }
    checks += 1;
    // idle skip: from every recorded boundary, the landing minute is the start of (or inside) a recorded walk
    const bounds = [0, ...d.events.filter((e) => e.type === 'worker_activity').map((e) => e.end as number)];
    for (const t of bounds) {
      const r = nextWalkStart(walksD, d, t);
      if (r === null) { ok(!d.events.some((e) => e.type === 'worker_activity' && (e.place as string).includes('>') && (e.end as number) > t && (e.start as number) < win), `${meta.id} D${d.day} t=${t}: no walk left → skip to the end is correct`); continue; }
      skips++;
      assert.ok(r >= t && anyWalking(walksD, r + 1e-9) || d.events.some((e) => e.type === 'worker_activity' && (e.place as string).includes('>') && (e.start as number) === r), `${meta.id} D${d.day}: the skip from ${t} lands on a recorded walk at ${r}`);
      const walks = d.events.filter((e) => e.type === 'worker_activity' && (e.place as string).includes('>'));
      if (walks.some((e) => (e.start as number) <= t && t < (e.end as number))) assert.ok(r === t, `${meta.id} D${d.day}: a walk is in progress at ${t}, so nothing is skipped (got ${r})`);
      assert.ok(!walks.some((e) => (e.start as number) > t && (e.start as number) < r), `${meta.id} D${d.day}: no walk starts between ${t} and the landing minute ${r}`);
      checks += 2;
    }
  }
  // scenery: deterministic, kept clear of recorded places
  const known = Object.values(pos).filter((p) => p.known), b = gardenBounds(pos, 90);
  const d1 = sceneDecor(hash32(exp.spec.id), b, known), d2 = sceneDecor(hash32(exp.spec.id), b, known);
  ok(JSON.stringify(d1) === JSON.stringify(d2), `${meta.id}: scenery is deterministic for its seed`);
  ok(d1.pebbles.length > 0 && d1.leaves.length > 0 && d1.tufts.length > 0, `${meta.id}: scenery has pebbles, leaves and grass`);
  ok(d1.pebbles.every((q) => known.every((p) => Math.hypot(p.x - q.x, p.y - q.y) > 5)) && d1.tufts.every((q) => known.every((p) => Math.hypot(p.x - q.x, p.y - q.y) > 7)), `${meta.id}: scenery keeps clear of recorded places`);
}
ok(frames > 1000 && walking > 0 && moving > 0, `frames ${frames}, walking ${walking}, moving ${moving}, unknown ${unknown}, skips ${skips}`);
for (const id of ['W001', 'W002', 'W010', 'Q1']) { const o = laneOffset(id); ok(Number.isInteger(o) && o >= -2 && o <= 2 && o === laneOffset(id), `lane offset of ${id} is a fixed index in -2..2`); const s = siteSlot(id); ok(JSON.stringify(s) === JSON.stringify(siteSlot(id)) && Math.hypot(s.dx, s.dy) <= 22.1, `site slot of ${id} is fixed`); }

// page modules: viewer-only imports, no randomness, no event creation, no writes
for (const f of ['game.ts', 'game-model.ts']) {
  const code = fs.readFileSync(path.join(WEB, 'src', f), 'utf8');
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) ok(m[1].startsWith('./'), `web/src/${f} imports only viewer modules (${m[1]})`);
  ok(!/Math\.random|localStorage\.setItem|method:\s*'(POST|PUT|DELETE)'/.test(code), `web/src/${f}: no randomness, no storage writes, no write requests`);
  ok(!/events\.push|\.events\s*=|type:\s*'(food_collected|trophallaxis|worker_death|insect_predation|food_delivered)'/.test(code), `web/src/${f}: creates no engine events`);
  ok(!/simulateWorldDay|simulateDay|initializeDay0/.test(code), `web/src/${f}: does not run the simulation`);
}
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), ana = fs.readFileSync(path.join(WEB, 'analysis.html'), 'utf8');
ok(html.includes('src="dist/game.js"') && html.includes('href="analysis.html"'), 'index.html is the game view and links to the analysis view');
ok(ana.includes('src="dist/main.js"') && ana.includes('href="index.html"'), 'analysis.html is the V5 analysis view and links back');
ok(/顯示插值/.test(html) && /示意/.test(html), 'the game page labels display interpolation and the schematic scene');
const gameCode = fs.readFileSync(path.join(WEB, 'src', 'game.ts'), 'utf8');
ok(/引擎紀錄/.test(gameCode) && /顯示插值/.test(gameCode) && /示意場景/.test(gameCode) && /非正式/.test(gameCode), 'the about panel names the three data classes and the non-official world');

console.log(JSON.stringify({ test: 'web-v6-game', passed: true, checks, frames, walking, moving, unknown_place: unknown, skips }));

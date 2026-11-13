/**
 * Ants scale with the map when zooming (Owner 2026-11-13) — display only, BLOCKING:
 *  1. web/src/zoom-scale.ts: at the home scale the ant is drawn the home size; at any other scale the drawn length is
 *     proportional to the zoom (constant magnification ×N, within the 1/12-octave quantisation), monotone, never below
 *     the floor; the close-up limit is where the ant reaches the cap;
 *  2. the module is pure (no engine / cli import, no DOM, clock, randomness or storage);
 *  3. both game views use it: the replay (game.ts) and the experiment page (v62.ts) anchor the magnification at their
 *     home camera, take the ant length from antPxAt (no fixed on-screen minimum) and limit zoom-in by maxScaleFor;
 *     the ×N label stays.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { FLOOR_PX, antPxAt, closeUpCapPx, maxScaleFor } from '../web/src/zoom-scale.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const STEP = 2 ** (1 / 24); // half a quantisation step

// 1. proportionality
for (const a of [{ homeS: 17.17, homePx: 36 }, { homeS: 25.5, homePx: 64 }, { homeS: 3.1, homePx: 18 }]) {
  ok(Math.abs(antPxAt(a, a.homeS) / a.homePx - 1) < STEP - 1 + 1e-9, `home: ${a.homePx} px at ${a.homeS} px/cm`);
  let prev = 0;
  for (let s = a.homeS / 8; s <= a.homeS * 8; s *= 1.07) {
    const px = antPxAt(a, s), ideal = (a.homePx * s) / a.homeS;
    ok(px >= prev, `monotone at s=${s.toFixed(2)}`); prev = px;
    if (ideal > FLOOR_PX * STEP) ok(px / ideal <= STEP + 1e-9 && ideal / px <= STEP + 1e-9, `proportional within quantisation at s=${s.toFixed(2)} (${px.toFixed(1)} vs ${ideal.toFixed(1)} px)`);
    else ok(px >= FLOOR_PX, `floor ${FLOOR_PX} px far out`);
  }
  // the magnification relative to the map (px per cm of map per px of ant) is the same zoomed out and zoomed in
  const out = antPxAt(a, a.homeS / 4) / (a.homeS / 4), inn = antPxAt(a, a.homeS * 4) / (a.homeS * 4);
  ok(Math.abs(out / inn - 1) < 2 * (STEP - 1), 'same ×N zoomed out and zoomed in');
  const cap = closeUpCapPx(412, 800, a.homePx), sMax = maxScaleFor(a, cap);
  ok(Math.abs(antPxAt(a, sMax) / cap - 1) < STEP - 1 + 1e-9, 'close-up limit: the ant reaches the cap');
  ok(cap >= a.homePx * 2, 'the close-up is at least twice the home size');
}
ok(antPxAt({ homeS: 1, homePx: 20 }, 0) === FLOOR_PX && antPxAt({ homeS: 1, homePx: 20 }, Number.NaN) === FLOOR_PX, 'degenerate scales give the floor');

// 2. purity
const zs = fs.readFileSync(path.join(REPO_ROOT, 'web/src/zoom-scale.ts'), 'utf8');
ok(!/^import /m.test(zs), 'zoom-scale.ts imports nothing');
ok(!/document|window|performance|Date\.|Math\.random|localStorage|indexedDB|fetch\(/.test(zs.replace(/\/\*\*[\s\S]*?\*\//g, '')), 'no DOM, clock, randomness, storage or network');

// 3. wiring
const game = fs.readFileSync(path.join(REPO_ROOT, 'web/src/game.ts'), 'utf8'), v62 = fs.readFileSync(path.join(REPO_ROOT, 'web/src/v62.ts'), 'utf8');
for (const [name, src] of [['game.ts', game], ['v62.ts', v62]] as const) {
  ok(/from '\.\/zoom-scale\.ts'/.test(src), `${name} imports zoom-scale`);
  ok(/antPxAt\(/.test(src) && /maxScaleFor\(/.test(src), `${name}: ant length from antPxAt, zoom-in limited by maxScaleFor`);
  ok(/放大顯示/.test(src) || name === 'game.ts', `${name}: ×N label`);
}
ok(/antScale = \{ homeS: cam\.s, homePx: homeAntPx\(\) \}/.test(game), 'game.ts anchors the magnification at the home camera');
ok(/surfScale = \{ homeS: cam\.s/.test(v62) && /ugScale = \{ homeS: ucam\.s/.test(v62) && /synScale = \{ homeS: cam\.s/.test(v62), 'v62.ts anchors each view (surface, underground, synthetic) at its home camera');
ok(!/minAntPx: narrow \? 16 : 18/.test(v62) && !/CLOSE_UP_S/.test(v62), 'v62.ts: no fixed on-screen minimum, no true-scale close-up constant');
ok(!/Math\.min\(1\.4, L \/ 26\)/.test(game), 'game.ts: the ring of ants at a site scales with the ants');

console.log(`web-zoom-scale: ${checks} checks passed`);

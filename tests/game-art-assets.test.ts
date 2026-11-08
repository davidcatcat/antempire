/**
 * Game art kit (PR A: assets only) — drawing assets must stay honest, deterministic and isolated:
 *  1. the art modules (web/src/art-*.ts) import only viewer modules ('./'), use no unseeded randomness, no clock, no
 *     storage or network, and never import or run the engine;
 *  2. every generator is deterministic: the same seed gives byte-identical soil pixels and identical vector text;
 *     a different seed gives a different result; every path uses only M/L/Q/C/Z with finite numbers;
 *  3. the soil tile is seamless (the wrap-around seam is no rougher than the tile's own neighbouring columns/rows);
 *  4. the walk cycle has ≥ 8 frames and an alternating tripod gait (L1,R2,L3 vs R1,L2,R3: opposite stance in every
 *     frame), stance feet move backward relative to the body, and the phase-from-distance mapping is slip-free;
 *  5. the antenna has 12 segments with a 3-segment club; no major-worker (soldier) asset exists;
 *  6. hemipteran clusters drawn on a host plant = the engine colony count exactly; a dead host draws differently;
 *  7. lighting is driven by an explicit light state (sun azimuth / elevation); replay mode uses the fixed schematic light;
 *     turning gaits (curved walk with shorter inner strides, pivot with opposite sides) are chosen only from a supplied ω;
 *  8. the licensing note and the art style spec exist and state the magnification and 示意 rules; the preview page is
 *     labelled as a mock and is not wired into the game view.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { digest, ellipse, smoothClosed, light, lightFromSun, withLight, SCHEMATIC_LIGHT, type DrawList } from '../web/src/art-core.ts';
import * as ANT from '../web/src/art-ant.ts';
import { soilTile, soilMacroTile, leaf, twig, pebble, grassTuft, moss, debris, LEAF_KINDS, type Decal } from '../web/src/art-ground.ts';
import { nestEntrance, hostPlant, flower, insectCarcass, aphid, scaleInsect } from '../web/src/art-props.ts';
import { vignette, sunWash, lightGrade, overcast, wetGlints, puddle, rainStreak, splash, wetDarken } from '../web/src/art-fx.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const SRC = path.join(REPO_ROOT, 'web', 'src');

// 1. isolation
const artFiles = fs.readdirSync(SRC).filter((f) => /^art-.*\.ts$/.test(f)).sort();
ok(artFiles.join() === 'art-ant.ts,art-core.ts,art-fx.ts,art-ground.ts,art-props.ts,art-raster.ts', `art modules present: ${artFiles.join()}`);
for (const f of artFiles) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) ok(m[1].startsWith('./'), `${f} imports only viewer modules (${m[1]})`);
  ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(code), `${f}: no unseeded randomness and no clock`);
  ok(!/localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket/.test(code), `${f}: no storage or network`);
  ok(!/engine\/|cli\/|simulateWorldDay|simulateDay|initializeDay0/.test(code.replace(/\/\*[\s\S]*?\*\//g, '')), `${f}: does not touch the engine`);
  ok(!/export\s+(const|function|interface|type)\s+\w*(major|soldier)/i.test(code), `${f}: exports no major-worker / soldier asset`);
}
const game = fs.readFileSync(path.join(SRC, 'game.ts'), 'utf8');
ok(/from '\.\/render-canvas\.ts'/.test(game) && /SCHEMATIC_LIGHT/.test(game), 'the game view draws through the layered renderer with the fixed schematic light (PR C)');

// 2. determinism + path syntax
const PATH_OK = /^(?:[MLQCZ](?:-?\d+(?:\.\d+)?(?:e-?\d+)?(?:\s-?\d+(?:\.\d+)?(?:e-?\d+)?)*)?)*$/;
const shapesOf = (d: Decal | DrawList): DrawList => Array.isArray(d) ? d : [...d.shadow, ...d.body, ...(d.high ?? []), ...(d.highShadow ?? [])];
const checkPaths = (name: string, list: DrawList) => { for (const s of list) { if (!PATH_OK.test(s.d) || /NaN|Infinity/.test(JSON.stringify(s))) assert.fail(`${name}: bad path or paint ${s.d.slice(0, 80)}`); } checks++; };
const gens: [string, (seed: number) => Decal | DrawList][] = [
  ...LEAF_KINDS.map((k) => [`leaf:${k}`, (s: number) => leaf(s, k, 10, 20, 0.7, 32)] as [string, (seed: number) => Decal]),
  ['twig', (s) => twig(s, 0, 0, 0.3, 40)], ['pebble', (s) => pebble(s, 5, 5, 4)], ['grass', (s) => grassTuft(s, 0, 0, 30, 0.3)],
  ['moss', (s) => moss(s, 0, 0, 6)], ['debris', (s) => debris(s, 0, 0, 10, 20)], ['nest', (s) => nestEntrance(s, 0, 0, 20)],
  ['host-alive', (s) => hostPlant(s, 0, 0, { alive: true, colonies: 3, insect: 'aphid' })], ['host-scale', (s) => hostPlant(s, 0, 0, { alive: true, colonies: 2, insect: 'scale' })],
  ['flower', (s) => flower(s, 0, 0, 15)], ['carcass', (s) => insectCarcass(s, 0, 0, 0.4, 8)], ['carcass-fragments', (s) => insectCarcass(s, 0, 0, 0.4, 8, false)],
  ['aphid', (s) => aphid(0, 0, s / 7, 2, 0.5)], ['scale', (s) => scaleInsect(0, 0, s / 7, 2, 0.5)], ['puddle', (s) => puddle(s, 0, 0, 9)], ['splash', (s) => splash(0, 0, 10, (s % 10) / 10)],
  ['fx', (s) => [vignette(400, 300), sunWash(400, 300), ...lightGrade(400, 300), overcast(400, 300), wetGlints(s, 400, 300, 50), wetDarken(400, 300), rainStreak(20)]],
];
for (const [name, g] of gens) {
  const a = g(12345), b = g(12345), c = g(54321);
  ok(JSON.stringify(a) === JSON.stringify(b), `${name}: same seed → identical vector output`);
  if (!/^(fx|aphid|scale|splash)$/.test(name)) ok(JSON.stringify(a) !== JSON.stringify(c), `${name}: a different seed gives a different result`);
  checkPaths(name, shapesOf(a));
}
for (const kind of ANT.GAITS) for (let i = 0; i < ANT.framesOf(kind); i++) {
  const a = ANT.antFrameDrawList(kind, i), b = ANT.antFrameDrawList(kind, i);
  ok(digest(a.body) === digest(b.body) && digest(a.shadow) === digest(b.shadow), `ant ${kind} frame ${i}: deterministic`);
  checkPaths(`ant ${kind} ${i}`, [...a.body, ...a.shadow]);
}
for (const h of [0, 1, 2.5, -2]) checkPaths(`glints ${h}`, ANT.antGlints(h));
ok(PATH_OK.test(ellipse(1, 2, 3, 4, 0.5)) && PATH_OK.test(smoothClosed([[0, 0], [1, 0], [1, 1]])), 'path helpers emit plain path text');

// soil: deterministic bytes, seed-dependent, wet variant darker, seamless
const N = 128, t1 = soilTile({ size: N, seed: 9 }), t2 = soilTile({ size: N, seed: 9 }), t3 = soilTile({ size: N, seed: 10 }), tw = soilTile({ size: N, seed: 9, wet: true });
ok(t1.length === N * N * 4 && Buffer.compare(Buffer.from(t1), Buffer.from(t2)) === 0, 'soil tile: same seed → byte-identical pixels');
ok(Buffer.compare(Buffer.from(t1), Buffer.from(t3)) !== 0, 'soil tile: different seed → different pixels');
const lum = (p: Uint8ClampedArray) => { let s = 0; for (let i = 0; i < p.length; i += 4) s += p[i] + p[i + 1] + p[i + 2]; return s / (p.length / 4) / 3; };
ok(lum(tw) < lum(t1) * 0.8, `wet soil is darker (${lum(tw).toFixed(1)} vs ${lum(t1).toFixed(1)})`);
const px = (p: Uint8ClampedArray, x: number, y: number) => { const q = (y * N + x) * 4; return p[q] + p[q + 1] + p[q + 2]; };
const colDiff = (x0: number, x1: number) => { let s = 0; for (let y = 0; y < N; y++) s += Math.abs(px(t1, x0, y) - px(t1, x1, y)); return s / N; };
const rowDiff = (y0: number, y1: number) => { let s = 0; for (let x = 0; x < N; x++) s += Math.abs(px(t1, x, y0) - px(t1, x, y1)); return s / N; };
let inner = 0; for (let x = 0; x < N - 1; x++) inner += colDiff(x, x + 1); inner /= N - 1;
let innerR = 0; for (let y = 0; y < N - 1; y++) innerR += rowDiff(y, y + 1); innerR /= N - 1;
ok(colDiff(N - 1, 0) < inner * 1.6 && rowDiff(N - 1, 0) < innerR * 1.6, `soil tile is seamless: wrap seam ${colDiff(N - 1, 0).toFixed(1)}/${rowDiff(N - 1, 0).toFixed(1)} vs neighbours ${inner.toFixed(1)}/${innerR.toFixed(1)}`);
const m1 = soilMacroTile(5, 64), m2 = soilMacroTile(5, 64);
ok(Buffer.compare(Buffer.from(m1), Buffer.from(m2)) === 0, 'macro variation tile is deterministic');

// 4. gait
ok(ANT.WALK_FRAMES >= 8 && ANT.IDLE_FRAMES >= 4, `walk cycle has ${ANT.WALK_FRAMES} frames (≥ 8), idle ${ANT.IDLE_FRAMES}`);
ok(ANT.TRIPOD_A.join() === 'L1,R2,L3' && ANT.TRIPOD_B.join() === 'R1,L2,R3', 'tripod sets: L1-R2-L3 vs R1-L2-R3');
for (const gait of ANT.GAITS.filter((g) => g !== 'idle')) for (let i = 0; i < ANT.WALK_FRAMES; i++) {
  const pose = ANT.antPose(gait, i), st = (id: string) => pose.legs.find((l) => l.id === id)!.stance;
  ok(ANT.TRIPOD_A.every((l) => st(l) === st('L1')) && ANT.TRIPOD_B.every((l) => st(l) === st('R1')) && st('L1') !== st('R1'), `${gait} frame ${i}: the two tripods are in opposite phases`);
  ok(pose.legs.length === 6 && pose.legs.every((l) => l.pts.length === 5), `${gait} frame ${i}: six legs with coxa, femur, tibia and tarsus points`);
}
for (const leg of ['L1', 'R2', 'R3'] as ANT.LegId[]) {
  let prev = ANT.legState(leg, 0).offset;
  for (let k = 1; k < 50; k++) { const s = ANT.legState(leg, k / 100); if (s.stance && ANT.legState(leg, (k - 1) / 100).stance) assert.ok(s.offset < prev, `${leg}: a stance foot moves backward relative to the body`); prev = s.offset; }
  checks++;
}
ok(Math.abs(ANT.walkCycles((ANT.CYCLE_ADVANCE / 100) * 60, 60) - 1) < 1e-12 && ANT.CYCLE_ADVANCE === 2 * ANT.STRIDE, 'phase from distance: one cycle per 2 strides travelled (no foot slip)');
ok(ANT.walkFrame(0) === 0 && ANT.walkFrame(1) === 0 && ANT.walkFrame(0.5) === ANT.WALK_FRAMES / 2 && ANT.walkFrame(-0.25) >= 0, 'walk frame index wraps');
ok(Math.abs(ANT.magnification(26, 4) - 26) < 1e-9 && ANT.MINOR_LENGTH_CM === 0.25, 'magnification = drawn length / (2.5 mm × px per mm)');
const idle0 = ANT.antPose('idle', 0), idle3 = ANT.antPose('idle', 3);
ok(idle0.legs.every((l) => l.stance && l.lift === 0) && JSON.stringify(idle0.legs) === JSON.stringify(idle3.legs) && JSON.stringify(idle0.ant) !== JSON.stringify(idle3.ant), 'idle: legs planted and still, only the antennae move');

// turning: curved walk = shorter inner strides; pivot = the two sides sweep in opposite directions; only from ω
const len = (v: [number, number]) => Math.hypot(v[0], v[1]);
for (const n of ['1', '2', '3']) {
  ok(len(ANT.strideVector('curveR', `R${n}` as ANT.LegId)) < len(ANT.strideVector('curveR', `L${n}` as ANT.LegId)) && len(ANT.strideVector('curveL', `L${n}` as ANT.LegId)) < len(ANT.strideVector('curveL', `R${n}` as ANT.LegId)), `curve: inner leg ${n} takes the shorter stride`);
  ok(ANT.strideVector('pivotR', `L${n}` as ANT.LegId)[0] * ANT.strideVector('pivotR', `R${n}` as ANT.LegId)[0] < 0 && ANT.strideVector('pivotL', `L${n}` as ANT.LegId)[0] === -ANT.strideVector('pivotR', `L${n}` as ANT.LegId)[0], `pivot: leg pair ${n} sweeps in opposite directions; L mirrors R`);
}
ok(ANT.selectGait({ moving: true }) === 'walk' && ANT.selectGait({ moving: false }) === 'idle' && ANT.selectGait({ moving: true, omega: null }) === 'walk', 'no authoritative ω (replay) → never a turning gait');
ok(ANT.selectGait({ moving: true, speedBL: 2, omega: 1 }) === 'curveR' && ANT.selectGait({ moving: true, speedBL: 2, omega: -1 }) === 'curveL' && ANT.selectGait({ moving: false, omega: 1 }) === 'pivotR' && ANT.selectGait({ moving: true, speedBL: 2, omega: 0.1 }) === 'walk', 'turning gait from ω sign / magnitude and speed');
ok(Math.abs(ANT.pivotCycles(ANT.PIVOT_RAD_PER_CYCLE) - 1) < 1e-12, 'pivot phase driven by the heading change made');

// lighting: explicit light state
const morning = lightFromSun(90, 30, 'test'), night = lightFromSun(90, -10, 'test night');
ok(Math.abs(Math.hypot(morning.shadow.x, morning.shadow.y) - 1 / Math.tan(Math.PI / 6)) < 1e-9 && morning.shadow.x < 0 && Math.abs(morning.shadow.y) < 1e-9, 'sun in the east at 30°: shadows point west with length 1/tan(30°) per unit height');
ok(night.intensity === 0 && night.shadow.x === 0 && night.shadow.y === 0 && ANT.antGlints.length === 1 && withLight(night, () => ANT.antGlints(0)).length === 0, 'sun below the horizon: no direct light, no cast shadow, no glints');
ok(SCHEMATIC_LIGHT.schematic && /示意/.test(SCHEMATIC_LIGHT.label) && light() === SCHEMATIC_LIGHT, 'replay default = the fixed, labelled schematic light');
const pDef = pebble(5, 0, 0, 4), pM = withLight(morning, () => pebble(5, 0, 0, 4));
ok(JSON.stringify(pDef) !== JSON.stringify(pM) && JSON.stringify(pM) === JSON.stringify(withLight(morning, () => pebble(5, 0, 0, 4))) && light() === SCHEMATIC_LIGHT, 'assets follow the active light deterministically; withLight restores the default');
const sDef = soilTile({ size: 64, seed: 3 }), sM = soilTile({ size: 64, seed: 3, light: morning });
ok(Buffer.compare(Buffer.from(sDef), Buffer.from(sM)) !== 0, 'soil relief shading follows the light state');

// 5. anatomy
ok(ANT.ANTENNA_SEGMENTS === 12 && ANT.ANTENNA_CLUB === 3 && idle0.ant.L.length === 13, 'antenna: 12 segments (scape + 11) with a 3-segment club');
const antSrc = fs.readFileSync(path.join(SRC, 'art-ant.ts'), 'utf8');
ok(/petiole/.test(antSrc) && /postpetiole/.test(antSrc) && /propodeal spines/.test(antSrc) && /mandible/.test(antSrc) && /eyes?/.test(antSrc), 'ant: petiole + postpetiole, propodeal spines, mandibles and eyes are drawn');
ok(!Object.keys(ANT).some((k) => /major|soldier|carry/i.test(k)) && !ANT.GAITS.some((g) => /carry/i.test(g)), 'ant module exposes no major / soldier / carrying variant');

// colour variants: deterministic, within the documented light-to-dark-brown range (variant 0 lightest)
{
  const lum = (h: string) => { const n = parseInt(h.slice(1), 16); return 0.3 * (n >> 16 & 255) + 0.59 * (n >> 8 & 255) + 0.11 * (n & 255); };
  const v = Array.from({ length: ANT.PALETTE_VARIANTS }, (_, i) => ANT.antPalette(i));
  ok(ANT.PALETTE_VARIANTS >= 3 && JSON.stringify(ANT.antPalette(2)) === JSON.stringify(ANT.antPalette(2)), 'palette variants are deterministic');
  ok(v.every((p, i) => i === 0 || lum(p.head[1]) < lum(v[i - 1].head[1])) && v.every((p) => { const n = parseInt(p.head[1].slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255; return r >= g && g >= b; }), 'variants run light → dark and stay brown (R ≥ G ≥ B)');
  ok(digest(ANT.antFrameDrawList('walk', 3, v[0]).body) !== digest(ANT.antFrameDrawList('walk', 3, v[4]).body) && JSON.stringify(ANT.antFrameDrawList('walk', 3, v[0]).shadow) === JSON.stringify(ANT.antFrameDrawList('walk', 3, v[4]).shadow), 'variants change colours only (same silhouette)');
}

// 6. engine-driven variants
for (let c = 0; c <= 6; c++) { const p = hostPlant(77, 0, 0, { alive: true, colonies: c, insect: 'aphid' }); ok(p.colonySites.length === c, `host plant draws exactly ${c} hemipteran cluster(s)`); }
const alive = hostPlant(77, 0, 0, { alive: true, colonies: 0, insect: 'aphid' }), dead = hostPlant(77, 0, 0, { alive: false, colonies: 0, insect: 'aphid' });
ok(JSON.stringify(alive.body) !== JSON.stringify(dead.body), 'a dead host plant (host_alive=false) draws a different (wilted) variant');

// 7. docs and preview
const lic = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'licensing.md'), 'utf8');
ok(/美術資產/.test(lic) && /原創/.test(lic) && /AI/.test(lic) && /web\/src\/art-/.test(lic), 'licensing.md records that the art is original, in-repo, no third-party / AI-generated images');
const style = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'game-art-style.md'), 'utf8');
ok(/放大顯示/.test(style) && /×N/.test(style) && /示意/.test(style) && /大工蟻/.test(style) && /360/.test(style) && /日值/.test(style) && /仿射|affine/i.test(style) && /solar/.test(style) && /ω/.test(style) && /分析/.test(style), 'style spec: magnification label, 示意 rules, no majors, 360-min window, daily rain, affine camera, sun/ω wiring, analysis UI');
const preview = fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'art-preview', 'index.html'), 'utf8');
ok(/示意 mock/.test(preview) && /不是引擎資料/.test(preview), 'preview page is labelled as a mock, not engine data');
const pv = fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'art-preview', 'preview.ts'), 'utf8');
ok(!/Math\.random|fetch\(|data\/experiment/.test(pv), 'preview reads no replay data and uses no unseeded randomness');
for (const f of ['desktop-first-screen.png', 'pixel7-first-screen.png', 'desktop-ant.png', 'desktop-mock-garden.png']) ok(fs.existsSync(path.join(REPO_ROOT, 'prototypes', 'art-preview', 'screenshots', f)), `screenshot ${f} committed`);

console.log(JSON.stringify({ test: 'game-art-assets', passed: true, checks }));

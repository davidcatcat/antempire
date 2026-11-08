/**
 * V6 art scene (PR C): the game view draws the replay through the layered renderer without changing what is drawn.
 *  1. the opening moment comes from the engine record: a recorded walk between two known places is under way within
 *     3 simulated seconds of the opening minute, it is the window with the most walks, and the framed food site is one
 *     those walks go to;
 *  2. game.ts imports only viewer modules, uses the renderer, the fixed schematic light, no ω, no rain streaks, no
 *     unseeded randomness, creates no events;
 *  3. index.html: analysis aids are optional layers, all off by default; the data panel, analysis link and labels
 *     (顯示插值 / 示意 / 放大顯示) are present; ant size and the opening field derive from the screen.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { displayPositions, type Experiment } from '../web/src/model.ts';
import { openingMoment } from '../web/src/game-model.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DATA = path.join(REPO_ROOT, 'web', 'data'), index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
for (const meta of index.experiments) {
  const exp = JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8')) as Experiment, pos = displayPositions(exp.map.places);
  let opened = false;
  for (const d of exp.days) {
    const o = openingMoment(d, pos), walks = d.events.filter((e) => e.type === 'worker_activity' && typeof e.place === 'string' && e.place.includes('>') && (e.place as string).split('>').every((p) => pos[p]?.known));
    if (!walks.length) { ok(o === null, `${meta.id} D${d.day}: no walk between known places → no opening moment`); continue; }
    assert.ok(o, `${meta.id} D${d.day}: opening moment exists`);
    const start = o.walkStart, under = (s: number) => walks.filter((w) => (w.start as number) < s + 3 && (w.end as number) > s).length;
    ok(walks.some((w) => (w.start as number) === start) && o.t <= start && start - o.t <= 3 / 60 + 1e-12, `${meta.id} D${d.day}: opening lands at most 3 s before a recorded walk start`);
    ok(walks.every((w) => under(w.start as number) <= under(start)), `${meta.id} D${d.day}: it is the busiest 3-minute walking window`);
    ok(walks.some((w) => (w.place as string).split('>').includes(o.focus) && (w.start as number) < start + 3 && (w.end as number) > start), `${meta.id} D${d.day}: the framed site ${o.focus} is visited by those walks`);
    opened = true;
  }
  ok(opened, `${meta.id}: some day has an opening moment`);
}
const game = fs.readFileSync(path.join(REPO_ROOT, 'web', 'src', 'game.ts'), 'utf8');
for (const m of game.matchAll(/from\s+'([^']+)'/g)) ok(m[1].startsWith('./'), `game.ts imports only viewer modules (${m[1]})`);
ok(/new LayeredRenderer\(/.test(game) && /SCHEMATIC_LIGHT/.test(game) && /openingMoment\(/.test(game), 'game.ts uses the layered renderer, the schematic light and the record-derived opening');
ok(!/Math\.random|omega|rainStreak|splash\(|events\.push|type:\s*'(food_collected|trophallaxis|worker_death)'/.test(game), 'no randomness, no invented ω, no rain streaks, no events');
ok(/Math\.max\(36, Math\.round\(Math\.min\(canvas\.clientWidth, canvas\.clientHeight\) \* 0\.08\)\)/.test(game) && /MACRO_CM = 24/.test(game), 'ant size and macro opening field derive from the screen (≥ 36 px; 8% of the short side; 24 cm field)');
ok(/displayTurns: true/.test(game) && /colourVariants: true/.test(game) && /nextWalkBtn/.test(game), 'display turning frames (recorded heading changes only), per-ID colour variants, next-walk jump');
const html = fs.readFileSync(path.join(REPO_ROOT, 'web', 'index.html'), 'utf8');
for (const id of ['layerEngine', 'layerLabels', 'layerRoutes', 'layerIds', 'layerChips']) ok(new RegExp(`id="${id}"(?![^>]*checked)`).test(html), `layer ${id} exists and is off by default`);
ok(/<div id="layers" hidden>/.test(html) && /<div id="weather" class="chip" hidden>/.test(html) && /<div id="counts" class="chip" hidden>/.test(html), 'analysis panels do not cover the scene by default');
ok(/id="infoBtn"/.test(html) && /href="analysis\.html"/.test(html) && /顯示插值/.test(html) && /示意/.test(html) && /放大顯示/.test(html), 'data panel, analysis link and data-class labels present');
console.log(JSON.stringify({ test: 'web-v6-art-scene', passed: true, checks }));

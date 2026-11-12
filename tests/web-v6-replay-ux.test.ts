/**
 * V6 Game View replay navigation (Issue #148) — pure helpers in web/src/replay-ux.ts, checked on every day of every
 * exported experiment replay:
 *  1. timelineMarks = walkIntervals exactly (same count, order, start, end), positions are start/window and
 *     (end − start)/window, and every walk interval comes from an engine worker_activity record on an edge;
 *  2. nextActivityJump never jumps over the start of a recorded walk: from every recorded boundary (and from each
 *     landing minute, pressed repeatedly to the end of the day) no walk starts strictly between the current minute and
 *     the landing minute; the landing is ≤ the reported walk start, which is a recorded start; repeated presses visit
 *     every distinct walk start in order; with no later start it returns 'none' (no fabricated target);
 *  3. daySummary puts every event WITHOUT a minute-level record in the day-level list (never with a time), every event
 *     with one in the timed list with its recorded minute range, and counts everything exactly once;
 *  4. the module imports only viewer modules, creates no events, and the page wires it (button, shortcut, marks,
 *     summary label 「日摘要，非連續播放」).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { isTimed, windowOf, type Experiment } from '../web/src/model.ts';
import { walkIntervals } from '../web/src/game-model.ts';
import { JUMP_LEAD_MIN, daySummary, minuteAtFraction, nextActivityJump, summaryHtml, timelineMarks } from '../web/src/replay-ux.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const WEB = path.join(REPO_ROOT, 'web'), DATA = path.join(WEB, 'data');
const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
let days = 0, marks = 0, jumps = 0, presses = 0, dayLevel = 0, timed = 0;

for (const meta of index.experiments) {
  const exp = JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8')) as Experiment;
  for (const d of exp.days) {
    days++;
    const walks = walkIntervals(d), win = windowOf(d);
    const recorded = d.events.filter((e) => e.type === 'worker_activity' && typeof e.place === 'string' && e.place.includes('>'));
    // 1. marks
    const m = timelineMarks(walks, win);
    assert.equal(m.length, walks.length, `${meta.id} D${d.day}: one mark per walk interval`);
    assert.equal(m.length, recorded.length, `${meta.id} D${d.day}: one mark per engine worker_activity walk record`);
    m.forEach((k, i) => {
      assert.ok(k.start === walks[i].start && k.end === walks[i].end, `${meta.id} D${d.day}: mark ${i} = walk interval`);
      assert.ok(Math.abs(k.left - k.start / win) < 1e-12 && Math.abs(k.width - (k.end - k.start) / win) < 1e-12 && k.left >= 0 && k.left + k.width <= 1 + 1e-12, `${meta.id} D${d.day}: mark ${i} position = minutes / window`);
      assert.ok(recorded.some((e) => e.start === k.start && e.end === k.end), `${meta.id} D${d.day}: mark ${i} comes from an engine record`);
      marks++;
    });
    // 2. jump
    const starts = [...new Set(walks.map((w) => w.start).filter((s) => s < win))].sort((a, b) => a - b);
    const noneBetween = (a: number, b: number) => !walks.some((w) => w.start > a && w.start < b);
    const from = [0, ...d.events.filter((e) => e.type === 'worker_activity').flatMap((e) => [e.start as number, e.end as number]), ...walks.map((w) => w.start - JUMP_LEAD_MIN / 2)].filter((x) => x >= 0 && x <= win);
    for (const t of from) {
      const r = nextActivityJump(walks, d, t);
      const later = starts.filter((s) => s > t);
      if (r.kind === 'none') { assert.ok(later.length === 0, `${meta.id} D${d.day} t=${t}: 'none' only when no recorded walk starts later`); continue; }
      jumps++;
      assert.ok(r.walkStart === later[0], `${meta.id} D${d.day} t=${t}: the target walk start is the next recorded start (${r.walkStart} vs ${later[0]})`);
      assert.ok(r.target >= t && r.target <= r.walkStart && r.target > t - 1e-12, `${meta.id} D${d.day} t=${t}: lands between now and the walk start`);
      assert.ok(r.walkStart - r.target <= JUMP_LEAD_MIN + 1e-12, `${meta.id} D${d.day} t=${t}: lands at most the lead before the start`);
      assert.ok(noneBetween(t, r.target), `${meta.id} D${d.day} t=${t}: no recorded walk starts between now and the landing ${r.target}`);
      assert.ok(r.walksStarting === walks.filter((w) => w.start === r.walkStart).length && r.walksStarting > 0, `${meta.id} D${d.day}: walks starting at the target counted from the record`);
    }
    // repeated presses from minute 0 visit every distinct walk start, in order, then report none
    let t = 0; const visited: number[] = [];
    for (let i = 0; i < starts.length * 2 + 2; i++) {
      const r = nextActivityJump(walks, d, t); presses++;
      if (r.kind === 'none') break;
      assert.ok(r.target > t && noneBetween(t, r.target), `${meta.id} D${d.day}: press ${i} progresses and skips no walk start`);
      if (visited[visited.length - 1] !== r.walkStart) visited.push(r.walkStart);
      t = r.target;
    }
    assert.deepEqual(visited, starts.filter((s) => s > 0), `${meta.id} D${d.day}: repeated presses visit every recorded walk start`);
    ok(nextActivityJump(walks, d, t).kind === 'none', `${meta.id} D${d.day}: after the last walk start the jump reports none`);
    // 3. summary
    const s = daySummary(d, walks);
    const other = d.events.filter((e) => e.type !== 'worker_activity' && e.type !== 'route_step');
    const untimed = other.filter((e) => !isTimed(e)), timedEv = other.filter((e) => isTimed(e));
    assert.equal(s.dayLevel.reduce((a, g) => a + g.count, 0), untimed.length, `${meta.id} D${d.day}: every minute-less event is in the day-level list`);
    assert.equal(s.timed.reduce((a, g) => a + g.count, 0), timedEv.length, `${meta.id} D${d.day}: every timed event is in the timed list`);
    for (const g of s.dayLevel) { assert.ok(untimed.filter((e) => e.type === g.type).length === g.count && g.items.length === g.count && !s.timed.some((x) => x.type === g.type && timedEv.filter((e) => e.type === g.type).length === 0), `${meta.id} D${d.day}: day-level group ${g.type}`); dayLevel += g.count; }
    for (const g of s.timed) {
      const ms = timedEv.filter((e) => e.type === g.type).map((e) => (typeof e.minute === 'number' ? e.minute : e.start) as number);
      assert.ok(ms.length === g.count && g.first === Math.min(...ms) && g.last === Math.max(...ms), `${meta.id} D${d.day}: timed group ${g.type} keeps the recorded minutes`);
      timed += g.count;
    }
    assert.ok(s.walks === walks.length && s.settlement.deaths === d.worker_deaths && s.settlement.eggs === d.eggs_laid && s.settlement.eclosions === d.eclosions, `${meta.id} D${d.day}: summary totals copied from the record`);
    const html = summaryHtml(s);
    ok(html.includes('日摘要，非連續播放') && html.includes('日層級事件'), `${meta.id} D${d.day}: summary html carries the non-continuous label`);
  }
}
ok(days > 0 && marks > 0 && jumps > 0 && dayLevel > 0 && timed > 0, `days ${days}, marks ${marks}, jumps ${jumps}, presses ${presses}, day-level ${dayLevel}, timed ${timed}`);
// synthetic edge cases: a walk starting inside the lead; no walks at all
{
  const d = { day: 1, date: 'x', window_minutes: 10, events: [] } as unknown as Experiment['days'][number];
  const w = [{ start: 1, end: 2 }, { start: 1, end: 3 }, { start: 5, end: 6 }];
  const a = nextActivityJump(w, d, 1 - JUMP_LEAD_MIN / 3);
  ok(a.kind === 'jump' && a.target === 1 && a.walksStarting === 2, 'a start within the lead → land exactly on it (progress, no skip)');
  const b = nextActivityJump(w, d, 1);
  ok(b.kind === 'jump' && b.walkStart === 5 && Math.abs(b.target - (5 - JUMP_LEAD_MIN)) < 1e-12, 'from a walk start the next press goes before the next start');
  ok(nextActivityJump(w, d, 5).kind === 'none' && nextActivityJump([], d, 0).kind === 'none', 'no later start → none');
  ok(nextActivityJump([{ start: 12, end: 13 }], d, 0).kind === 'none', 'a start outside the activity window is not a target');
  ok(minuteAtFraction(-1, 360) === 0 && minuteAtFraction(2, 360) === 360 && minuteAtFraction(0.5, 360) === 180, 'strip fraction → minute, clamped');
  ok(timelineMarks([], 360).length === 0, 'no walks → no marks');
}
// module + page wiring
const code = fs.readFileSync(path.join(WEB, 'src', 'replay-ux.ts'), 'utf8');
for (const mm of code.matchAll(/from\s+'([^']+)'/g)) ok(mm[1].startsWith('./'), `replay-ux.ts imports only viewer modules (${mm[1]})`);
ok(!/Math\.random|document\.|window\.|events\.push|\.events\s*=/.test(code), 'replay-ux.ts is DOM-free and creates no events');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), game = fs.readFileSync(path.join(WEB, 'src', 'game.ts'), 'utf8');
ok(html.includes('id="nextAct"') && html.includes('id="modeBtn"') && html.includes('id="marks"') && html.includes('id="summary"') && /引擎紀錄的行走時段/.test(html), 'index.html has the jump button, mode toggle, walk marks with legend, summary panel');
ok(/nextActivityJump/.test(game) && /timelineMarks/.test(game) && /daySummary/.test(game) && /e\.key === 'n'/.test(game), 'game.ts wires the jump (button + N), the marks and the summary');

console.log(JSON.stringify({ test: 'web-v6-replay-ux', passed: true, checks, days, marks, jumps, presses, day_level_events: dayLevel, timed_events: timed }));

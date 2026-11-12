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
import { JUMP_HINT, JUMP_LEAD_MIN, dayRecordSummary, daySummary, figText, jumpNote, minuteAtFraction, nextActivityJump, summaryHtml, timelineMarks } from '../web/src/replay-ux.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const WEB = path.join(REPO_ROOT, 'web'), DATA = path.join(WEB, 'data');
const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
let days = 0, marks = 0, jumps = 0, presses = 0, dayLevel = 0, timed = 0, figures = 0, unrecorded = 0, taskRows = 0, notes = 0;

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
    // 5. Issue #191 Q4: record figures, recomputed here independently from the raw record (no fabricated value)
    const rec = dayRecordSummary(exp, d.day, meta.file), want = expectedFigures(exp, d.day);
    const figs = rec.sections.flatMap((x) => x.figs);
    assert.deepEqual(figs.map((f) => f.key).sort(), [...want.keys()].sort(), `${meta.id} D${d.day}: the summary shows exactly the expected record figures`);
    for (const f of figs) {
      const w = want.get(f.key);
      assert.ok(w !== undefined && (typeof w === 'number' && typeof f.value === 'number' ? Math.abs(w - f.value) < 1e-9 : w === f.value), `${meta.id} D${d.day}: figure ${f.key} = record (${f.value} vs ${w})`);
      assert.ok(f.src.length > 0 && (f.value !== null || /沒有|null/.test(f.src)), `${meta.id} D${d.day}: figure ${f.key} names its source`);
      assert.ok(figText(f.value) === (f.value === null ? '引擎未記錄' : typeof f.value === 'number' ? String(Number(f.value.toFixed(6))) : f.value), `${meta.id} D${d.day}: figure ${f.key} printed as recorded`);
      figures++; if (f.value === null) unrecorded++;
    }
    if (d.tasks) {
      assert.equal(rec.tasks?.length, Object.keys(d.tasks).length, `${meta.id} D${d.day}: one task row per ant in the record`);
      for (const r of rec.tasks ?? []) { const x = d.tasks[r.id]; assert.ok(x && x.task === r.task && x.trips === r.trips && x.successes === r.successes && x.stop_reason === r.stop_reason, `${meta.id} D${d.day}: task row ${r.id} = record`); taskRows++; }
    } else assert.equal(rec.tasks, null, `${meta.id} D${d.day}: no task record → no task rows`);
    const rh = summaryHtml(s, 30, rec);
    for (const f of figs) assert.ok(rh.includes(`data-fig="${f.key}" data-value="${f.value === null ? '' : String(f.value)}"`) && rh.includes(f.src.replace(/"/g, '&quot;')), `${meta.id} D${d.day}: html row ${f.key} carries its value and source`);
    ok((rh.match(/>引擎未記錄<\/td>/g) ?? []).length === figs.filter((f) => f.value === null).length, `${meta.id} D${d.day}: 「引擎未記錄」 cells only for quantities the record does not hold`);
    // jumpNote: walks in progress counted from the record
    for (const w of walks.slice(0, 20)) {
      const tm = (w.start + w.end) / 2, r = nextActivityJump(walks, d, tm);
      if (r.kind !== 'jump') continue;
      const n = jumpNote(walks, tm, r);
      assert.ok(n.inProgress === walks.filter((x) => x.start <= tm && x.end > tm).length && n.inProgress >= (w.end > tm ? 1 : 0) && Math.abs(n.skippedMin - (r.target - tm)) < 1e-12 && n.stage === (r.walkStart - r.target > 1e-9 ? 'lead' : 'start'), `${meta.id} D${d.day}: jumpNote at ${tm}`);
      notes++;
    }
  }
}
ok(figures > 0 && taskRows > 0 && notes > 0, `record figures ${figures} (unrecorded ${unrecorded}), task rows ${taskRows}, jump notes ${notes}`);
{ // the three landing steps (Q1) from a walk start that is not within the lead: before → on the start → before the next
  const d = { day: 1, date: 'x', window_minutes: 10, events: [] } as unknown as Experiment['days'][number], w = [{ start: 2, end: 3 }, { start: 5, end: 6 }];
  const a = nextActivityJump(w, d, 0) as { target: number; walkStart: number }, b = nextActivityJump(w, d, a.target) as { target: number; walkStart: number }, c = nextActivityJump(w, d, b.target) as { target: number; walkStart: number };
  ok(jumpNote(w, 0, a).stage === 'lead' && jumpNote(w, a.target, b).stage === 'start' && b.target === 2 && jumpNote(w, b.target, c).stage === 'lead' && c.walkStart === 5 && jumpNote(w, 2.5, nextActivityJump(w, d, 2.5) as { target: number; walkStart: number }).inProgress === 1, 'three landing steps: lead → start → next lead; a walk in progress is counted');
  ok(/約 3 秒/.test(JUMP_HINT) && /再按一次到行走開始/.test(JUMP_HINT) && /跳轉/.test(JUMP_HINT), 'the inline hint describes the three steps and says it is a jump');
}

/** Independent recomputation of every Q4 figure from the raw record (not using replay-ux). */
function expectedFigures(exp: Experiment, day: number): Map<string, number | string | null> {
  const d = exp.days[day - 1], S = day === 1 ? exp.day0.state : exp.days[day - 2].end_state, E = d.end_state, m = new Map<string, number | string | null>();
  const n = (type: string) => d.events.filter((e) => e.type === type).length, sum = (xs: number[]) => Number(xs.reduce((a, x) => a + x, 0).toFixed(6));
  m.set('workers_start', S.workers.length); m.set('workers_end', E.workers.length);
  m.set('queen_start', S.queen_alive ? '存活' : '未存活'); m.set('queen_end', E.queen_alive ? '存活' : '未存活');
  for (const st of new Set([...S.brood, ...E.brood].map((b) => b.stage))) { m.set(`brood_${st}_start`, S.brood.filter((b) => b.stage === st).length); m.set(`brood_${st}_end`, E.brood.filter((b) => b.stage === st).length); }
  const castes = E.workers.map((w) => (w as unknown as Record<string, unknown>).caste);
  if (castes.length && castes.every((c) => typeof c === 'string')) for (const c of new Set(castes as string[])) m.set(`caste_${c}`, castes.filter((x) => x === c).length); else m.set('caste', null);
  m.set('worker_deaths', d.worker_deaths); m.set('worker_death_events', n('worker_death')); m.set('brood_death_events', n('brood_death')); m.set('queen_death_events', n('queen_death')); m.set('eclosions', d.eclosions); m.set('eclosion_events', n('eclosion'));
  for (const e of d.events) if (e.type === 'eclosion' && typeof e.caste === 'string') m.set(`eclosion_caste_${e.caste}`, ((m.get(`eclosion_caste_${e.caste}`) as number) ?? 0) + 1);
  m.set('eggs_laid', d.eggs_laid); m.set('egg_laid_events', n('egg_laid')); m.set('hatch_events', n('hatch')); m.set('pupation_events', n('pupation'));
  const T = d.tasks ? Object.values(d.tasks) : null;
  m.set('foragers', T ? T.filter((x) => x.task === 'forage').length : null); m.set('trips', T ? T.reduce((a, x) => a + x.trips, 0) : null); m.set('successes', T ? T.reduce((a, x) => a + x.successes, 0) : null);
  for (const t of ['food_collected', 'food_delivered', 'discovery', 'local_recruitment', 'trophallaxis']) m.set(t, n(t));
  for (const t of ['food_collected', 'food_delivered']) for (const mac of new Set(d.events.filter((e) => e.type === t && typeof e.macro === 'string' && typeof e.portions === 'number').map((e) => e.macro as string)))
    m.set(`${t}_${mac}`, sum(d.events.filter((e) => e.type === t && e.macro === mac && typeof e.portions === 'number').map((e) => e.portions as number)));
  m.set('income_sugar', d.income.sugar); m.set('income_protein', d.income.protein);
  for (const mac of ['sugar', 'protein'] as const) { m.set(`store_${mac}_start`, S.stores[mac]); m.set(`store_${mac}_end`, E.stores[mac]); m.set(`store_${mac}_delta`, Number((E.stores[mac] - S.stores[mac]).toFixed(6))); m.set(`consumed_${mac}`, d.consumed[mac]); }
  return m;
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
// Issue #191 wiring: hint (Q1), jump label (Q2), shortcut S without modifiers and not in form controls (Q3), record
// summary (Q4), the narrow-screen 更多 panel (Q5)
ok(html.includes('id="jumpHint"') && /showJumpHintOnce/.test(game) && /跳轉（非連續播放）/.test(game) && /jumpNote/.test(game), 'game.ts shows the first-use hint and labels jumps 跳轉');
ok(/e\.key === 's'/.test(game) && /e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey/.test(game) && /tag === 'INPUT'/.test(game) && html.includes('aria-keyshortcuts="S"'), 'shortcut S: no Ctrl/Cmd/Alt combination, ignored in form controls, declared on the button');
ok(/dayRecordSummary\(exp, day/.test(game), 'game.ts renders the record summary');
ok(html.includes('id="moreBtn"') && html.includes('id="morePanel"') && ['fit', 'homeBtn', 'layersBtn', 'infoBtn', 'world', 'prevDay', 'nextDay'].every((id) => new RegExp(`id="${id}"[^>]*data-more=`).test(html)), 'index.html: 更多 panel and the collapsible controls are marked data-more');

console.log(JSON.stringify({ test: 'web-v6-replay-ux', passed: true, checks, days, marks, jumps, presses, day_level_events: dayLevel, timed_events: timed, record_figures: figures, unrecorded_figures: unrecorded, task_rows: taskRows, jump_notes: notes }));

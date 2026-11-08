/**
 * V5 (Issue #99 follow-up): event categories and filter, cross-day timeline, event map marks, recorded routes, nest
 * highlights and daily flow / biota series of the read-only viewer, on the committed 30-day replays (web/data).
 *  1. categories: every event type in the replays and every engine NATURAL_EVENT_TYPES entry the viewer lists has a
 *     category (none falls into 「其他」); filterRows keeps exactly the matching records;
 *  2. allTimeline: every listed engine event of every day, once; timed rows carry the recorded minute, untimed rows
 *     (no minute / start) are settlement rows (t = Infinity) — never an invented minute;
 *  3. eventMarks: marks + noPlace = the input events; every marked event sits at the place its recorded field names;
 *     events without a place field (deaths, egg laying, development, recruitment contacts) are never marked;
 *  4. recordedRoute: one leg per edge of every recorded walk; t1 is an engine route_step minute or null; the derived
 *     speed equals V4's walkSpeedAt at that arrival; routeSummary sums only completed recorded legs;
 *  5. eventBroodIds: the brood / new worker an event names exists in the engine end-of-day state of that day;
 *  6. daily series V5 fields equal the engine end-of-day states; flow charts and table render every day;
 *  7. purity: frozen input, deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { NATURAL_EVENT_TYPES } from '../engine/day.ts';
import { dailySeries, walkSpeedAt, segmentsOf, displayPositions, dayTimeline, allTimeline, filterRows, categoryOf, categoryCounts, eventMarks, eventPlace, EVENT_PLACE_FIELD, recordedRoute, routeSummary, eventBroodIds, isTimed, type Experiment, type EventCategory } from '../web/src/model.ts';
import { FLOW_CHARTS, FLOW_COLUMNS, chartSvg, tableHtml } from '../web/src/charts.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DATA = path.join(REPO_ROOT, 'web', 'data'), index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const NOT_LISTED = new Set(['worker_activity', 'route_step']);
// engine bookkeeping / trail state types that are not individual events a viewer category is meant for
const BOOKKEEPING = new Set(['route_memory_initialized', 'queen_body_initialized', 'brood_nutrition_record_initialized', 'trail_decay', 'trail_deposited', 'trail_lost', 'local_trail_choice', 'route_timeout', 'source_flow', 'source_batch_consumed', 'physical_scout_visit', 'nest_local_route_learning', 'local_contact_cue', 'local_unloading_feedback', 'local_alarm_signal', 'long_range_recruitment_trail', 'injury_recovery', 'nest_move', 'queen_feeding_refused', 'queen_nutrition', 'larva_hatch_nutrition', 'larva_nutrition']);
let legsAll = 0, legsRecorded = 0, marked = 0, unplaced = 0, rowsAll = 0, broodIds = 0;
for (const meta of index.experiments) {
  const exp = deepFreeze(JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8')) as Experiment), id = exp.spec.id, pos = displayPositions(exp.map.places);
  // 1. categories
  const types = new Set(exp.days.flatMap((d) => d.events.map((e) => e.type)));
  for (const t of types) if (!NOT_LISTED.has(t)) ok(categoryOf({ type: t }) !== 'other', `${id}: event type ${t} has a viewer category`);
  // 2. all days
  const rows = allTimeline(exp);
  const listed = exp.days.reduce((q, d) => q + d.events.filter((e) => !NOT_LISTED.has(e.type)).length, 0);
  ok(rows.length === listed && new Set(rows.map((r) => `${r.day}:${r.i}`)).size === listed, `${id}: allTimeline lists each of the ${listed} engine events once`);
  ok(rows.every((r) => r.e === exp.days[r.day - 1].events[r.i] && (isTimed(r.e) ? r.t === (typeof r.e.minute === 'number' ? r.e.minute : r.e.start) : r.t === Infinity)), `${id}: timed rows carry the recorded minute, untimed rows are settlement rows`);
  ok(exp.days.every((d) => JSON.stringify(dayTimeline(d)) === JSON.stringify(rows.filter((r) => r.day === d.day).map(({ e, i, t }) => ({ e, i, t })))), `${id}: allTimeline = the V3 dayTimeline of every day`);
  rowsAll += rows.length;
  const counts = categoryCounts(rows);
  for (const c of Object.keys(counts) as EventCategory[]) {
    const f = filterRows(rows, new Set([c]), null);
    assert.equal(f.length, counts[c]); assert.ok(f.every((r) => categoryOf(r.e) === c)); checks += 2;
  }
  const w = (rows.find((r) => typeof r.e.worker === 'string')?.e.worker as string), mine = filterRows(rows, new Set(), w);
  ok(mine.length > 0 && mine.every((r) => JSON.stringify(r.e).includes(`"${w}"`)), `${id}: the worker filter keeps only records naming ${w}`);
  // 3. marks
  for (const d of exp.days) {
    const evs = dayTimeline(d).map((r) => r.e), m = eventMarks(evs, pos);
    assert.equal(m.marks.reduce((q, k) => q + k.total, 0) + m.noPlace, evs.length, 'marks + unplaced = input');
    for (const e of evs) {
      const p = eventPlace(e, pos), f = EVENT_PLACE_FIELD[e.type];
      if (!f) assert.equal(p.place, null, `${e.type} has no place field -> never marked`);
      if (['worker_death', 'brood_death', 'queen_death', 'egg_laid', 'hatch', 'pupation', 'eclosion', 'local_recruitment'].includes(e.type)) assert.equal(p.place, null, `${e.type} is never put on the map`);
    }
    for (const k of m.marks) assert.equal(k.total, evs.filter((e) => eventPlace(e, pos).place === k.place).length, 'mark count = events recorded at that place');
    marked += m.marks.reduce((q, k) => q + k.total, 0); unplaced += m.noPlace; checks += 3;
  }
  // 4. routes
  for (const d of exp.days) {
    const ws = new Set(d.events.filter((e) => e.type === 'worker_activity').map((e) => e.worker as string));
    for (const wid of ws) {
      const legs = recordedRoute(d, wid, exp.map.links), walks = segmentsOf(d, wid).filter((s) => String(s.place).includes('>'));
      assert.equal(legs.length, walks.reduce((q, s) => q + String(s.place).split('>').length - 1, 0), 'one leg per recorded edge');
      const steps = d.events.filter((e) => e.type === 'route_step' && e.worker === wid);
      for (const l of legs) {
        if (l.t1 !== null) assert.ok(steps.some((s) => s.minute === l.t1 && s.from === l.from && s.to === l.to), 'arrival = an engine route_step');
        if (l.mm_s !== null) { const v = walkSpeedAt(d, wid, l.t1 as number, exp.map.links); assert.ok(v && v.mm_s === l.mm_s, 'derived speed = V4 walkSpeedAt'); }
        if (l.length_cm === null || !l.recorded) assert.equal(l.mm_s, null, 'no speed without a recorded length and time');
        legsAll++; if (l.recorded) legsRecorded++;
      }
      const sum = routeSummary(legs, Infinity), done = legs.filter((l) => l.t1 !== null);
      assert.equal(sum.legs, done.length);
      if (sum.length_cm !== null) assert.equal(sum.length_cm, done.reduce((q, l) => q + (l.length_cm as number), 0));
      assert.equal(routeSummary(legs, -1).legs, 0); checks += 3;
    }
  }
  // 5. brood ids
  for (const d of exp.days) for (const e of d.events) for (const b of eventBroodIds(e)) {
    const inState = d.end_state.brood.some((x) => x.id === b) || d.end_state.workers.some((x) => x.id === b);
    if (e.type === 'eclosion' && b === e.source_brood_id) assert.ok(!d.end_state.brood.some((x) => x.id === b), 'an eclosed brood is no longer brood');
    else if (e.type !== 'brood_death') assert.ok(inState, `${id} day ${d.day}: ${e.type} ${b} exists in the engine end-of-day state`);
    broodIds++; checks++;
  }
  // 6. series
  const s = dailySeries(exp);
  exp.days.forEach((d) => { const p = s[d.day], src = Object.values(d.end_state.sources);
    assert.equal(p.insects, Object.values(d.end_state.insects).reduce((q, x) => q + x, 0)); assert.equal(p.hemipteran_colonies, src.reduce((q, x) => q + (x.hemipteran_colonies ?? 0), 0)); assert.equal(p.hosts_alive, src.filter((x) => x.host_alive === true).length); checks += 3; });
  for (const c of FLOW_CHARTS) ok(chartSvg(c, s, 5).includes(`data-chart="${c.id}"`), `${id}: flow chart ${c.id} renders`);
  ok((tableHtml(s, FLOW_COLUMNS).match(/<tr>/g) ?? []).length === s.length + 1, `${id}: the flows table lists every day`);
  // 7. determinism
  ok(JSON.stringify(allTimeline(exp)) === JSON.stringify(rows) && JSON.stringify(dailySeries(exp)) === JSON.stringify(s), `${id}: deterministic`);
}
for (const t of NATURAL_EVENT_TYPES) if (!NOT_LISTED.has(t) && !BOOKKEEPING.has(t)) ok(categoryOf({ type: t }) !== 'other', `engine event type ${t} has a viewer category`);
ok(legsAll > 0 && marked > 0 && unplaced > 0 && broodIds > 0, `legs ${legsAll} (recorded ${legsRecorded}), marked ${marked}, unplaced ${unplaced}, brood ids ${broodIds}`);
console.log(JSON.stringify({ passed: true, checks, rows: rowsAll, legs: legsAll, recorded_legs: legsRecorded, marked, unplaced, brood_ids: broodIds }));

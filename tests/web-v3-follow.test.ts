/**
 * V3 (Issue #99): individual follow camera and event-timeline jumps of the read-only viewer, tested on the committed
 * experiment replays (web/data, each a 30-day engine run). The viewer may only point at what the engine recorded:
 *  1. replays: every experiment is a 30-day engine replay (or ends early only because the colony is extinct);
 *  2. event time: a click goes to the event's recorded minute EXACTLY; an event the engine applied at the end of the
 *     day without a clock time goes to the settlement step of that day and is never given a minute;
 *  3. event place: only from the field that records where the event happened (EVENT_PLACE_FIELD); every event type
 *     in the data is either mapped or explicitly listed here as having no place; a place without a recorded
 *     bearing+distance is "unknown" (the camera does not move); no coordinate is ever derived;
 *  4. event workers: only IDs from the event's worker fields, all of them real workers of the replay;
 *  5. replay consistency: at a timed event's minute, the worker it names is drawn at (or arriving at) the recorded
 *     place — the display pose and the engine event agree;
 *  6. the day timeline lists every non-segment event exactly once, timed by minute, settlement events last;
 *  7. follow status across the life cycle: drawn at recorded route_step points, "dead" only after the settlement of
 *     its death day, "not present" before its eclosion settlement, unknown position at unrecorded places;
 *  8. purity: all V3 functions run on deep-frozen data (nothing is written) and are deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { EVENT_PLACE_FIELD, eventJump, eventPlace, eventWorkers, dayTimeline, followStatus, displayPositions, poseAt, stateAt, stateAtStart, windowOf, SETTLEMENT_STEP, isTimed, type Experiment, type SimEvent } from '../web/src/model.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DATA = path.join(REPO_ROOT, 'web', 'data');
const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
/** Event types the engine writes WITHOUT a field saying where they happened. Adding a type to the export forces a decision here. */
const NO_PLACE = new Set(['forager_stopped', 'action_cancelled_no_time', 'local_recruitment', 'hunt_recruitment', 'worker_death', 'brood_death', 'queen_death', 'egg_laid', 'hatch', 'pupation', 'eclosion']);
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

const typesSeen = new Set<string>();
let timedJumps = 0, untimedJumps = 0, knownPlaces = 0, unknownPlaces = 0, noPlace = 0, consistent = 0, deathsFollowed = 0, eclosionsFollowed = 0, unknownFollow = 0;
for (const meta of index.experiments) {
  const exp = deepFreeze(JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8')) as Experiment), id = exp.spec.id;
  const pos = displayPositions(exp.map.places);
  // 1. replay length
  const last = exp.days[exp.days.length - 1].end_state;
  ok(exp.days.length === exp.spec.days || (!last.queen_alive && last.workers.length === 0), `${id}: a ${exp.spec.days}-day engine replay (got ${exp.days.length} days)`);
  ok(exp.official === false && exp.kind === 'experiment', `${id}: experiment, not official`);
  const everWorker = new Set<string>([...exp.day0.state.workers.map((w) => w.id), ...exp.days.flatMap((d) => d.end_state.workers.map((w) => w.id))]);
  for (const d of exp.days) {
    const listed = d.events.filter((e) => e.type !== 'worker_activity' && e.type !== 'route_step');
    // 6. day timeline
    const tl = dayTimeline(d);
    assert.equal(tl.length, listed.length, `${id} day ${d.day}: timeline lists every event once`);
    assert.deepEqual(new Set(tl.map((r) => r.i)).size, listed.length, `${id} day ${d.day}: no event listed twice`);
    for (let k = 1; k < tl.length; k++) assert.ok(tl[k - 1].t <= tl[k].t, `${id} day ${d.day}: timeline in time order, settlement last`);
    for (const r of tl) assert.equal(r.t === Infinity, !isTimed(r.e), `${id} day ${d.day}: only untimed events are in the settlement group`);
    checks += 3;
    for (const e of listed) {
      typesSeen.add(e.type);
      const j = eventJump(d, e, pos), rec = typeof e.minute === 'number' ? e.minute : typeof e.start === 'number' ? e.start : null;
      // 2. time
      if (rec !== null) { assert.ok(j.timed && j.t === rec && j.minute === rec, `${id} day ${d.day} ${e.type}: jump to the recorded minute ${rec} exactly (got ${j.t})`); timedJumps++; }
      else { assert.ok(!j.timed && j.minute === null && j.t === windowOf(d) + SETTLEMENT_STEP, `${id} day ${d.day} ${e.type}: untimed event goes to the settlement step, no minute`); untimedJumps++; }
      assert.equal(j.day, d.day, 'jump stays on the event day');
      // 3. place
      const f = EVENT_PLACE_FIELD[e.type];
      assert.ok(f || NO_PLACE.has(e.type), `${id}: event type ${e.type} must be mapped to a place field or listed as having none`);
      if (!f) { assert.deepEqual(j.place, { place: null, known: false, field: null }, `${id} ${e.type}: no place field -> 位置未知`); noPlace++; }
      else {
        assert.equal(j.place.place, e[f], `${id} ${e.type}: place = recorded ${f}`);
        assert.equal(j.place.known, pos[e[f] as string]?.known === true, `${id} ${e.type}: known only when the place has a recorded bearing+distance`);
        if (j.place.known) knownPlaces++; else unknownPlaces++;
      }
      assert.deepEqual(eventPlace(e, pos), j.place, 'eventPlace = eventJump place');
      // 4. workers
      for (const w of j.workers) assert.ok(everWorker.has(w), `${id} day ${d.day} ${e.type}: ${w} is a worker of this replay`);
      const fieldsWithIds = ['worker', 'by', 'from', 'id', 'new_worker_id', 'team', 'participants', 'co_located_team'];
      if (e.type === 'exploration_step') assert.ok(!j.workers.includes(e.to as string), 'exploration_step `to` is a node, not a worker');
      for (const w of j.workers) assert.ok(fieldsWithIds.concat('to').some((k) => (Array.isArray(e[k]) ? (e[k] as string[]).includes(w) : e[k] === w)), `${id} ${e.type}: ${w} comes from a recorded field`);
      // 5. replay consistency: the actor drawn at the event minute is at the recorded place
      if (rec !== null && f && typeof e.worker === 'string' && j.place.place) {
        const p = poseAt(d, e.worker, rec, pos);
        assert.ok(p.place.split('>').includes(j.place.place), `${id} day ${d.day} ${e.type} at ${rec}: ${e.worker} is drawn at ${p.place}, the event says ${j.place.place}`);
        consistent++;
      }
      checks += 4;
    }
    // 7. follow status
    const start = stateAtStart(exp, d.day), w = windowOf(d);
    for (const st of d.events.filter((e) => e.type === 'route_step') as Any[]) {
      const f = followStatus(exp, d.day, st.minute, st.worker, pos);
      if (pos[st.to].known && pos[st.from].known) assert.ok(f.kind === 'visible' && Math.abs(f.x - pos[st.to].x) < 1e-6 && Math.abs(f.y - pos[st.to].y) < 1e-6, `${id} day ${d.day}: following ${st.worker} at its recorded arrival at ${st.to}`);
      else { assert.equal(f.kind, 'unknown_position', `${id} day ${d.day}: ${st.worker} at an unrecorded place is 位置未知`); unknownFollow++; }
    }
    for (const e of d.events.filter((x) => x.type === 'worker_death')) {
      const wid = e.id as string;
      assert.notEqual(followStatus(exp, d.day, w, wid, pos).kind, 'dead', `${id} day ${d.day}: ${wid} still drawn in the window of its death day`);
      assert.deepEqual(followStatus(exp, d.day, w + SETTLEMENT_STEP, wid, pos), { kind: 'dead', day: d.day }, `${id} day ${d.day}: ${wid} dead after the settlement`);
      if (d.day < exp.days.length) assert.deepEqual(followStatus(exp, d.day + 1, 0, wid, pos), { kind: 'dead', day: d.day }, `${id}: ${wid} dead on the next day`);
      deathsFollowed++; checks += 3;
    }
    for (const e of d.events.filter((x) => x.type === 'eclosion')) {
      const wid = e.new_worker_id as string;
      assert.deepEqual(followStatus(exp, d.day, 0, wid, pos), { kind: 'not_present', eclosion_day: d.day }, `${id} day ${d.day}: ${wid} not present before its eclosion settlement`);
      assert.notEqual(followStatus(exp, d.day, w + SETTLEMENT_STEP, wid, pos).kind, 'not_present', `${id} day ${d.day}: ${wid} present after the settlement`);
      eclosionsFollowed++; checks += 2;
    }
    assert.deepEqual(followStatus(exp, d.day, 0, 'NOT-A-WORKER', pos), { kind: 'not_present', eclosion_day: null }, 'no individual invented');
    for (const wk of start.workers) { const f = followStatus(exp, d.day, w / 2, wk.id, pos); assert.ok(f.kind === 'visible' || f.kind === 'unknown_position', `${id} day ${d.day}: ${wk.id} alive at the start can be followed`); }
    assert.equal(stateAt(exp, d.day, w), start, 'drawn colony inside the window = start of day');
    // 8. determinism
    const e0 = listed[0]; if (e0) assert.deepEqual(eventJump(d, e0, pos), eventJump(d, e0, pos), 'eventJump deterministic');
    checks += 3;
  }
}
ok(timedJumps > 0 && untimedJumps > 0, `timed (${timedJumps}) and untimed (${untimedJumps}) jumps exercised`);
ok(knownPlaces > 0 && noPlace > 0, `known places (${knownPlaces}), unknown places (${unknownPlaces}), events without a place (${noPlace}) exercised`);
ok(consistent > 0, `${consistent} timed events: the drawn actor is at the recorded place`);
ok(deathsFollowed > 0 && eclosionsFollowed > 0 && unknownFollow > 0, `follow across deaths (${deathsFollowed}), eclosions (${eclosionsFollowed}) and unknown positions (${unknownFollow})`);
for (const t of Object.keys(EVENT_PLACE_FIELD)) ok(!NO_PLACE.has(t), `${t} is either placed or unplaced, not both`);
const mixed = { type: 'exploration_step', worker: 'W001', from: 'N00', to: 'W002', minute: 1 } as SimEvent;
ok(JSON.stringify(eventWorkers(mixed)) === '["W001"]', 'a node field is never read as a worker');
console.log(JSON.stringify({ passed: true, checks, types: [...typesSeen].sort(), timedJumps, untimedJumps, knownPlaces, unknownPlaces, noPlace, consistent, deathsFollowed, eclosionsFollowed, unknownFollow }, null, 1));

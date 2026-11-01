/**
 * v2-review.12 injury types. Read-only on the real saves (migration is a pure function; nothing is written).
 *  1. Day15 migration reads the type ONLY from the Day14 injury records: '擦傷' -> abrasion, irreversible_damage
 *     true -> appendage_damage, anything else (e.g. '舊傷') -> unknown; body part and description copied
 *     verbatim; workers without a record get no type; with the switch off nothing is added (v2-review.11).
 *  2. Repair by type (test-only override injury_repair_probability = 1 so every eligible rest day repairs):
 *     abrasion and unknown repair and lose their injury fields; appendage_damage never repairs and keeps the
 *     injury mortality multiplier; a worker without injury_type behaves as unknown (older states).
 */
import assert from 'node:assert/strict';
import { migrationState, simulateDay, type LegacyV2State } from '../engine/index.ts';
import { readJson, loadBundle } from '../cli/lib/load.ts';
import { counter, fixture, MAIN_SPECIES, setParam } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const c = counter(), { ok } = c;
const main = readJson('saves/main.json'), world = readJson('saves/world-state.json'), clim = readJson('data/taichung-climatology-1991-2020.json');
const before = JSON.stringify([main, world]);

// 1. migration
const s = migrationState(main, world, clim, loadBundle());
const byId = (st: LegacyV2State, id: string) => st.population.workers.find((w) => w.id === id) as Any;
const records = world.injuries as Any[];
ok(records.length === 6 && records.every((r) => r.irreversible_damage === null), 'Day14 records: six injuries, none marked irreversible (unknown stays unknown)');
for (const r of records) {
  const w = byId(s, r.worker_id), want = String(r.legacy_description).includes('擦傷') ? 'abrasion' : 'unknown';
  ok(w.injured === true && w.injury_type === want, `${r.worker_id} '${r.legacy_description}' -> ${want}`);
  ok(w.injury_body_part === r.body_part && w.injury_record === r.legacy_description, `${r.worker_id} body part and description copied verbatim`);
}
ok(['W012', 'W013', 'W014'].every((id) => byId(s, id).injury_type === 'abrasion') && ['W007', 'W008', 'W009'].every((id) => byId(s, id).injury_type === 'unknown'), 'three recorded abrasions, three unrecorded old injuries');
ok(s.population.workers.filter((w) => !w.injured).every((w) => !('injury_type' in w)), 'uninjured workers get no injury fields');
{
  const w2 = structuredClone(world); w2.injuries[0].irreversible_damage = true;
  ok(byId(migrationState(main, w2, clim, loadBundle()), w2.injuries[0].worker_id).injury_type === 'appendage_damage', 'a record marked irreversible becomes appendage_damage');
  const off = loadBundle(); (off.world as Any).day15_migration.classify_injuries = false;
  ok(migrationState(main, world, clim, off).population.workers.every((w) => !('injury_type' in w) && !('injury_record' in w)), 'switch off: no injury fields (v2-review.11 migration)');
}
ok(JSON.stringify([main, world]) === before, 'migration does not mutate the saves');

// 2. repair by type
function run(type: string | null, days = 30) {
  const b = loadBundle(); setParam(b, MAIN_SPECIES, 'worker_lifespan.injury_repair_probability', 1);
  let st: LegacyV2State = fixture();
  const target = st.population.workers.find((w) => w.injured) as Any;
  if (type) Object.assign(target, { injury_type: type, injury_body_part: 'test', injury_record: 'test' }); else delete target.injury_type;
  let recovered = 0, restDays = 0, alive = true;
  for (let d = 0; d < days && alive; d++) {
    const o = simulateDay(st, b);
    const w = o.state.population.workers.find((x) => x.id === target.id) as Any;
    if (!w) { alive = false; break; }
    if (w.task === 'rest') restDays++;
    if (o.events.some((e) => e.type === 'injury_recovery' && e.id === target.id)) { recovered = o.day; ok(!w.injured && !('injury_type' in w) && !('injury_record' in w), `${type ?? 'no type'}: recovery clears the injury fields`); break; }
    st = o.state;
  }
  return { recovered, restDays, alive, id: target.id };
}
const ab = run('abrasion'), un = run('unknown'), none = run(null), app = run('appendage_damage', 60);
ok(ab.recovered > 0 && un.recovered > 0 && none.recovered > 0, 'abrasion, unknown and missing type can repair');
ok(ab.recovered === un.recovered && un.recovered === none.recovered, 'abrasion, unknown and missing type follow the same (pre-v12) repair rule');
ok(app.recovered === 0 && (app.restDays > 0 || !app.alive), 'appendage damage never repairs, even with repair probability forced to 1 and rest days available');
{
  // The injury mortality multiplier keeps applying to permanent damage: same risk as any injured worker.
  const b = loadBundle(); const st: LegacyV2State = fixture(); const t = st.population.workers.find((w) => w.injured) as Any; t.injury_type = 'appendage_damage';
  const ref: LegacyV2State = fixture();
  const o1 = simulateDay(st, b), o2 = simulateDay(ref, b);
  ok(JSON.stringify(o1.summary) === JSON.stringify(o2.summary), 'Day15: an appendage-damaged worker is treated exactly like any other injured worker apart from repair');
}
assert.equal(c.checks > 20, true);
console.log(JSON.stringify({ passed: true, checks: c.checks, migrated: Object.fromEntries(records.map((r) => [r.worker_id, byId(s, r.worker_id).injury_type])), repair_day: { abrasion: ab.recovered, unknown: un.recovered, no_type: none.recovered, appendage_damage: app.recovered }, appendage_rest_days_without_repair: app.restDays }, null, 2));

/**
 * v2-review.31 (Owner D5, docs/design-nurse-cue-locality-v31.md): the nurse begging cue (engine/workers.ts nurseContact) may
 * come only from a larva at the nurse's own place (CLAUDE.md §2.1).
 *   L0 defect (switch OFF): 15 larvae at another place ('brood_far') change nurses' begging-cue contacts the same day;
 *   L1 fix (switch ON): the same counterfactual leaves every nurse-cue event, every worker and every original larva
 *      bit-identical, on the day they are added and over 10 days (C3a + C4a on; contact counts reported, not vacuous);
 *   L2 a nurse outside the nest touches no larva; a nurse in the nest reports only larvae in the brood chamber;
 *   L3 ON with every nurse in the nest and every larva in the brood chamber = OFF (same stream, same draw);
 *   L4 OFF = v2-review.30 (golden + rules-isolation; here one Day14 scenario and one Day0 case against the v30 goldens);
 *   N  the new branch reads no colony-wide quantity (static).
 * Engineering correctness of a locality rule, not a species measurement.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle, readJson } from '../cli/lib/load.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { resolveBundle } from '../engine/params.ts';
import { BROOD_PLACE, nurseContact } from '../engine/workers.ts';
import { BROOD_PLACE as BROOD_PLACE_C4A } from '../engine/larva-feeding.ts';
import { SCENARIOS } from './lib/scenarios.ts';
import { traceScenario } from './lib/trace.ts';
import { DAY0_GOLDEN_CASES, traceDay0 } from './lib/day0-trace.ts';
import { codeOnly } from './lib/static.ts';
import { MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const evidence: Record<string, unknown> = {};
const mk = (on: boolean, c4a = true) => {
  const b: Any = structuredClone(loadBundle()), s = b.species[MAIN_SPECIES];
  s.queen_feeding.individual_queen_body_c3a = c4a; s.larval_feeding.individual_larva_body_c4a = c4a; s.local_signals.nurse_cue_same_place_v31 = on;
  return b;
};
const cues = (o: Any) => o.result.colonies[0].events.filter((e: Any) => e.type === 'local_brood_begging_contact');
const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'worker_location' || k === 'larva_location' ? undefined : v));
const addFar = (s: Any) => { const far = structuredClone(s); for (let i = 0; i < 15; i++) far.colonies[0].population.brood.push({ id: `ZZFAR${i}`, stage: 'larva', laid_on_day: null, age_days: null, progress: 0.1, begging_signal: 0.9, location: 'brood_far', origin: 'test' }); return far; };

ok(resolveBundle(loadBundle()).species[MAIN_SPECIES].local_signals.nurse_cue_same_place_v31 === false, 'the switch is off by default');
ok(BROOD_PLACE === 'brood' && BROOD_PLACE_C4A === BROOD_PLACE, 'one brood-chamber place shared by the nurse cue and C4a');

// ---------------------------------------------------------------- L0 / L1: far-larva counterfactual (C3a + C4a on)
for (const [founding, seed] of [['A5', 5], ['A1', 1]] as [string, number][]) {
  // the start day is chosen with the switch OFF (first day with at least 2 nurse contacts) and used for both arms
  const off = mk(false), on = mk(true);
  let s: Any = buildDay0(founding as Any, seed, '2027-03-21', off).state, start: Any = null;
  for (let d = 0; d < 150 && !start; d++) { const o: Any = simulateWorldDay(s, off); if (cues(o).length >= 2 && s.colonies[0].population.brood.some((b: Any) => b.stage === 'larva')) start = s; else s = o.state; }
  ok(start, `${founding} seed ${seed}: a day with nurse contacts exists`);
  const orig = new Set(start.colonies[0].population.brood.map((q: Any) => q.id));
  const larvaeOf = (o: Any) => JSON.stringify(o.state.colonies[0].population.brood.filter((q: Any) => orig.has(q.id)));
  const workersOf = (o: Any) => JSON.stringify(o.state.colonies[0].population.workers);
  const ev: Any = {};
  for (const [arm, b] of [['off', off], ['on', on]] as [string, Any][]) {
    let x: Any = start, y: Any = addFar(start);
    const r = { days: 10, nurse_contacts: 0, day1_contacts: 0, day1_contacts_differing: 0, day1_far_larva_contacts: 0, first_day_cue_differs: null as number | null, first_day_workers_differ: null as number | null, first_day_original_larvae_differ: null as number | null };
    for (let d = 0; d < r.days; d++) {
      const ox: Any = simulateWorldDay(x, b), oy: Any = simulateWorldDay(y, b), cx = cues(ox), cy = cues(oy);
      r.nurse_contacts += cx.length;
      if (d === 0) {
        r.day1_contacts = cx.length; r.day1_far_larva_contacts = cy.filter((e: Any) => String(e.larva).startsWith('ZZFAR')).length;
        const byW = new Map(cx.map((e: Any) => [e.worker, JSON.stringify([e.larva, e.signal])]));
        r.day1_contacts_differing = cy.filter((e: Any) => byW.get(e.worker) !== JSON.stringify([e.larva, e.signal])).length + cx.filter((e: Any) => !cy.some((f: Any) => f.worker === e.worker)).length;
      }
      if (r.first_day_cue_differs === null && JSON.stringify(cx) !== JSON.stringify(cy)) r.first_day_cue_differs = d + 1;
      if (r.first_day_workers_differ === null && workersOf(ox) !== workersOf(oy)) r.first_day_workers_differ = d + 1;
      if (r.first_day_original_larvae_differ === null && larvaeOf(ox) !== larvaeOf(oy)) r.first_day_original_larvae_differ = d + 1;
      x = ox.state; y = oy.state;
    }
    ev[arm] = r;
  }
  ok(ev.off.first_day_cue_differs === 1 && ev.off.day1_contacts_differing > 0 && ev.off.day1_far_larva_contacts > 0, `L0 ${founding}/${seed} (OFF): 15 larvae at 'brood_far' change ${ev.off.day1_contacts_differing} of ${ev.off.day1_contacts} nurse contacts on day 1 (${ev.off.day1_far_larva_contacts} touch a far larva); workers differ from day ${ev.off.first_day_workers_differ}, original larvae from day ${ev.off.first_day_original_larvae_differ}`);
  ok(ev.on.first_day_cue_differs === null && ev.on.day1_far_larva_contacts === 0 && ev.on.first_day_workers_differ === null && ev.on.first_day_original_larvae_differ === null, `L1 ${founding}/${seed} (ON): nurse-cue events, workers and original larvae bit-identical on day 1 and over ${ev.on.days} days`);
  ok(ev.on.nurse_contacts > 0 && ev.on.day1_contacts > 0, `L1 ${founding}/${seed}: not vacuous (${ev.on.nurse_contacts} nurse contacts in ${ev.on.days} days, ${ev.on.day1_contacts} on day 1)`);
  evidence[`L0_L1_${founding}_seed${seed}`] = ev;
}

// ---------------------------------------------------------------- L2: unit level (nurseContact directly)
{
  const b = mk(true), sp = resolveBundle(b).species[MAIN_SPECIES] as Any;
  let s: Any = buildDay0('A5' as Any, 5, '2027-03-21', b).state;
  for (let d = 0; d < 150 && s.colonies[0].population.brood.filter((q: Any) => q.stage === 'larva').length < 2; d++) s = simulateWorldDay(s, b).state;
  const w0 = addFar(s), colony = w0.colonies[0], nest = colony.nest_node;
  ok(colony.population.brood.filter((q: Any) => q.stage === 'larva' && (q.location ?? BROOD_PLACE) === BROOD_PLACE).length >= 2, 'L2 setup: larvae in the brood chamber and 15 at another place');
  let outside = 0, inside = 0, farTouched = 0, outsideTouched = 0;
  for (let i = 0; i < 300; i++) {
    const wk: Any = { ...structuredClone(colony.population.workers[0]), id: `TESTW${i}`, task: 'nurse' }, wk2: Any = { ...structuredClone(wk), last_location: 'not_the_nest' };
    wk.last_location = nest; delete wk.local_sensory; delete wk2.local_sensory;
    const e1: Any[] = [], e2: Any[] = [];
    nurseContact(w0, colony, sp, wk, e1); nurseContact(w0, colony, sp, wk2, e2);
    inside += e1.length; outside += e2.length; if (wk2.local_sensory?.direct_brood_begging !== undefined) outsideTouched++;
    for (const e of e1) { const l = colony.population.brood.find((q: Any) => q.id === e.larva); if ((l.location ?? BROOD_PLACE) !== BROOD_PLACE || e.larva_location !== BROOD_PLACE || e.worker_location !== nest) farTouched++; }
  }
  ok(outside === 0 && outsideTouched === 0, 'L2: a nurse whose last_location is not the nest touches no larva (300 draws: no event, no begging cue)');
  ok(inside > 0 && farTouched === 0, `L2: a nurse in the nest touches only larvae in the brood chamber (${inside} contacts of 300 draws, ${farTouched} elsewhere)`);
  // the same with the switch OFF reaches far larvae (the defect)
  const spOff = resolveBundle(mk(false)).species[MAIN_SPECIES] as Any;
  let offFar = 0;
  for (let i = 0; i < 300; i++) { const wk: Any = { ...structuredClone(colony.population.workers[0]), id: `TESTW${i}`, task: 'nurse', last_location: 'not_the_nest' }; const e: Any[] = []; nurseContact(w0, colony, spOff, wk, e); offFar += e.filter((x: Any) => String(x.larva).startsWith('ZZFAR')).length; }
  ok(offFar > 0, `L0 (unit): with the switch OFF a nurse outside the nest still "touches" far larvae (${offFar} of 300 draws)`);
  evidence.L2 = { draws: 300, in_nest_contacts: inside, outside_contacts: outside, off_outside_far_contacts: offFar };
  // real days with the switch on: every contact names the nest and the brood chamber
  let x: Any = buildDay0('A3' as Any, 3, '2027-03-21', b).state, n = 0, bad = 0;
  for (let d = 0; d < 60; d++) { const o: Any = simulateWorldDay(x, b); for (const e of cues(o)) { n++; const wk = x.colonies[0].population.workers.find((v: Any) => v.id === e.worker); if (e.worker_location !== x.colonies[0].nest_node || e.larva_location !== BROOD_PLACE || wk?.last_location !== x.colonies[0].nest_node) bad++; } x = o.state; }
  ok(n > 0 && bad === 0, `L2 (real days, A3 seed 3, 60 days): all ${n} contacts are by a nurse in the nest with a larva in the brood chamber`);
}

// ---------------------------------------------------------------- L3: ON = OFF when every nurse is in the nest
{
  const off = mk(false), on = mk(true);
  let compared = 0, identical = 0, outsideDays = 0, contacts = 0;
  for (const [founding, seed] of [['A1', 1], ['A3', 2], ['A5', 1]] as [string, number][]) {
    let s: Any = buildDay0(founding as Any, seed, '2027-03-21', off).state;
    for (let d = 0; d < 60; d++) {
      const ox: Any = simulateWorldDay(s, off), oy: Any = simulateWorldDay(s, on), nest = s.colonies[0].nest_node;
      // a nurse outside the nest = a worker present at the start of the day, task nurse, last_location not the nest (workers
      // eclosed during the day carry a task label but did not exist when nurseContact ran)
      const startLoc = new Map(s.colonies[0].population.workers.map((v: Any) => [v.id, v.last_location]));
      const nursesOut = ox.state.colonies[0].population.workers.filter((w: Any) => w.task === 'nurse' && startLoc.has(w.id) && startLoc.get(w.id) !== nest).length;
      const allHere = s.colonies[0].population.brood.every((q: Any) => q.stage !== 'larva' || (q.location ?? BROOD_PLACE) === BROOD_PLACE);
      if (nursesOut === 0 && allHere) { compared++; contacts += cues(ox).length; if (strip(oy) === strip(ox)) identical++; } else outsideDays++;
      s = ox.state;
    }
  }
  ok(compared > 0 && identical === compared && contacts > 0, `L3: ${identical}/${compared} days with every nurse in the nest are identical ON vs OFF apart from the two new event fields (${contacts} contacts; ${outsideDays} days with a nurse outside the nest not compared)`);
  evidence.L3 = { compared_days: compared, identical_days: identical, contacts, days_with_a_nurse_outside_the_nest: outsideDays };
  // pre-C4a larvae (no location) count as in the brood chamber: C4a off, ON = OFF byte for byte on a Day0 world with nurses
  const off0 = mk(false, false), on0 = mk(true, false);
  let a: Any = buildDay0('A5' as Any, 1, '2027-03-21', off0).state, same = 0, days = 0, c0 = 0;
  for (let d = 0; d < 30; d++) { const ox: Any = simulateWorldDay(a, off0), oy: Any = simulateWorldDay(a, on0); const start = new Map(a.colonies[0].population.workers.map((v: Any) => [v.id, v.last_location])), out = ox.state.colonies[0].population.workers.some((w: Any) => w.task === 'nurse' && start.has(w.id) && start.get(w.id) !== a.colonies[0].nest_node); if (!out) { days++; c0 += cues(ox).length; if (strip(ox) === strip(oy)) same++; } a = ox.state; }
  ok(days > 0 && same === days, `L3 (C4a off, larvae without a place): ${same}/${days} days identical ON vs OFF (${c0} contacts)`);
}

// ---------------------------------------------------------------- L4: OFF = v2-review.30
{
  const g30 = readJson('tests/golden/v30-trace-sha256.json'), sc = SCENARIOS[0];
  ok(traceScenario(sc).sha256 === g30.scenarios[sc.name].sha256, `L4: switch OFF, Day14 scenario ${sc.name} equals the v2-review.30 golden`);
  const d30 = readJson('tests/golden/day0-v30-trace-sha256.json'), c = DAY0_GOLDEN_CASES[0], got = traceDay0(c);
  ok(got.sha256 === d30.cases[c.name].sha256 && got.day0_sha256 === d30.cases[c.name].day0_sha256, `L4: switch OFF, Day0 ${c.name} equals the v2-review.30 golden`);
  const o: Any = simulateWorldDay(buildDay0('A5' as Any, 5, '2027-03-21', mk(false)).state, mk(false));
  ok(cues(o).every((e: Any) => !('worker_location' in e) && !('larva_location' in e)), 'L4: with the switch OFF the contact event has no new fields');
}

// ---------------------------------------------------------------- N: no colony-wide quantity in the new branch
{
  const src = codeOnly('engine/workers.ts'), i = src.indexOf('export function nurseContact'), body = src.slice(i, src.indexOf('\n}', i));
  ok(i >= 0 && /nurse_cue_same_place_v31/.test(body), 'N: the switch is read inside nurseContact');
  ok(!/\bstores\b|_gap_days|stress_days|colony\.(sugar|protein)\b|population\.workers|last_report|summary/.test(body), 'N: nurseContact reads no nest ledger, gap days, worker census or summary');
}
console.log(JSON.stringify({ test: 'nurse-cue-local-v31', checks, evidence }, null, 2));

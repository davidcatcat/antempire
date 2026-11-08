/**
 * WP5b (OD-1b, docs/od1b-cohort-life-time.md): background organisms keep living while pooled in a cohort.
 * Counterexample tests for the ISOLATED prototype prototypes/mixed-precision/. Not engine behaviour.
 *   K0. DEFECT on the PR #126 ledger (a689e02): an individual demoted into a cohort keeps a frozen physiology snapshot;
 *       after 10 simulated days in the pool it is promoted back with the same age. This section characterises the
 *       defect (it must stay reproducible) and, once the continuity check exists, shows the check catches it.
 */
import assert from 'node:assert/strict';
import {
  runDay, cohortId, type WorldState,
} from '../prototypes/mixed-precision/ledger.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const trig = (kind: string) => ({ kind, driver_event_ids: [`contact.${kind}`] });

// ---------------------------------------------------------------- K0. frozen life time in the PR #126 cohort
function legacyWorld(): WorldState {
  return {
    schema: 'antempire.wp5-mixed-precision.v1', seed: 'wp5b-k0', day: 1,
    regions: [{ id: 'G', resolution: 'fine', in_garden: true }],
    individuals: [{ id: 'X-moth-1', taxon: 'moth', stage: 'larva', colony_id: null, region: 'G', physio: { age_d: 30 }, comp: { body: 900 } }],
    cohorts: [], stocks: [], sinks: {}, producers: {}, retired: [], scenario_records: [], used_scenario_records: [],
    policy: { non_demotable_colonies: ['FOCAL'] },
  };
}
{
  let s = legacyWorld();
  const pooled = cohortId('G', 'moth', 'larva', null);
  s = runDay(s, [{ day: 1, minute: null, key: 'dem', kind: 'demote', individual: 'X-moth-1', trigger: trig('no_interaction') }]).state;
  for (let d = 2; d <= 10; d++) s = runDay(s, []).state;
  const back = runDay(s, [{ day: 11, minute: null, key: 'pro', kind: 'promote', cohort: pooled, trigger: trig('contact_with_focal') }]).state;
  const x = back.individuals.find((i) => i.id === 'X-moth-1');
  ok(x, 'the known ID comes back from the roster');
  // the defect: 10 days passed (day 1 -> day 11) but nothing about the organism advanced
  ok(x!.physio.age_d === 30, 'DEFECT reproduced: a pooled individual does not age (age_d still 30 after 10 days)');
  ok(x!.stage === 'larva', 'DEFECT reproduced: a pooled larva does not develop');
  ok(back.day - legacyWorld().day === 11, 'eleven days elapsed in the world clock');
}

console.log(JSON.stringify({ wp5_cohort_lifetime: 'pass', checks }, null, 2));

/**
 * v2-review.16 death diagnostics: the recorded cause matches the trigger that actually set the hazard, all
 * active triggers are listed, and the probabilities are unchanged (draw count and applied hazard).
 */
import assert from 'node:assert/strict';
import { queenSurvival } from '../engine/queen.ts';
import { resolveBundle } from '../engine/params.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const bundle = loadBundle(), sp = resolveBundle(bundle).species['pheidole-megacephala'], st = sp.starvation;
const first = (setup: (c: Any) => void) => {
  for (let seed = 1; seed < 5000; seed++) {
    const s = buildDay0('A1', seed, '2027-03-20', bundle).state, c: Any = s.colonies[0]; setup(c);
    const ev: Any[] = []; queenSurvival(s, c, sp, ev);
    if (ev.length) return { ev: ev[0], seed };
  }
  throw Error('no death in 5000 seeds');
};
const cases: [string, (c: Any) => void, string, string[], number][] = [
  ['protein deficit only', (c) => { c.stores.protein_gap_days = 20; c.stores.sugar_gap_days = 0; c.stores.stress_days = 20; }, 'chronic_protein_deficit', ['chronic_protein_deficit'], st.queen_daily_hazard],
  ['sugar deficit only', (c) => { c.stores.sugar_gap_days = 20; c.stores.stress_days = 20; }, 'chronic_sugar_deficit', ['chronic_sugar_deficit'], st.queen_daily_hazard],
  ['both deficits', (c) => { c.stores.sugar_gap_days = 20; c.stores.protein_gap_days = 15; c.stores.stress_days = 20; }, 'chronic_sugar_and_protein_deficit', ['chronic_sugar_and_protein_deficit'], st.queen_daily_hazard],
  ['no workers, fed', (c) => { c.population.workers = []; c.stores.no_worker_days = 5; }, 'no_workers', ['no_workers'], Math.max(st.queen_daily_hazard, st.queen_zero_worker_starved_daily_hazard)],
  ['no workers and sugar deficit', (c) => { c.population.workers = []; c.stores.no_worker_days = 5; c.stores.sugar_gap_days = 14; c.stores.stress_days = 14; }, 'no_workers', ['chronic_sugar_deficit', 'no_workers'], Math.max(st.queen_daily_hazard, st.queen_zero_worker_starved_daily_hazard)],
];
for (const [name, setup, reason, triggers, applied] of cases) {
  const { ev } = first(setup);
  ok(ev.type === 'queen_death' && ev.reason === reason && JSON.stringify(ev.active_triggers) === JSON.stringify(triggers) && ev.hazards.applied === applied && ev.hazards.natural_age === 'not_modelled', `${name}: reason ${ev.reason}, triggers ${ev.active_triggers}, applied ${ev.hazards.applied}`);
}
// No trigger -> no draw, no death (unchanged rule).
{ const s = buildDay0('A1', 7, '2027-03-20', bundle).state, ev: Any[] = []; for (let i = 0; i < 200; i++) queenSurvival(s, s.colonies[0], sp, ev); ok(ev.length === 0 && s.colonies[0].population.queen_alive, 'without a trigger the queen never dies (no natural queen hazard is modelled)'); }
// Empirical death rate equals the applied hazard (probability unchanged).
{ let deaths = 0; const n = 4000; for (let seed = 1; seed <= n; seed++) { const s = buildDay0('A1', seed, '2027-03-20', bundle).state, c: Any = s.colonies[0]; c.stores.protein_gap_days = 20; c.stores.stress_days = 20; const ev: Any[] = []; queenSurvival(s, c, sp, ev); deaths += ev.length; }
  const p = deaths / n, se = Math.sqrt(st.queen_daily_hazard * (1 - st.queen_daily_hazard) / n); ok(Math.abs(p - st.queen_daily_hazard) < 4 * se, `deficit hazard observed ${p} vs ${st.queen_daily_hazard}`); }
console.log(JSON.stringify({ passed: true, checks }, null, 2));

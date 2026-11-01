/** Full-output hash chain of one diagnostic scenario with the current engine. */
import crypto from 'node:crypto';
import { simulateDay } from '../../engine/index.ts';
import { loadBundle, readJson } from '../../cli/lib/load.ts';
import { applyNew, type Scenario } from './scenarios.ts';

export function traceScenario(sc: Scenario): { days: number; final_day: number; sha256: string } {
  let state = readJson('tests/fixtures/day14-projection.json'); if (sc.seed) state.seed = sc.seed; sc.state(state);
  const bundle = loadBundle(); applyNew(bundle, sc.params);
  let chain = '';
  for (let d = 0; d < sc.days; d++) { const o = simulateDay(state, bundle); chain = crypto.createHash('sha256').update(chain + JSON.stringify([o.summary, o.events, o.state])).digest('hex'); state = o.state; }
  return { days: sc.days, final_day: state.sim_day, sha256: chain };
}

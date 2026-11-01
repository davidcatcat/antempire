/**
 * Intentional save-mapping differences between sim/run_day.cjs (v6) and cli/lib/project-day.ts, applied to
 * the OLD output before byte comparison. Anything not listed here must still be byte-identical.
 *  1. engine/params reference strings and the timestamp (TypeScript engine, split parameter files);
 *  2. cumulative counters updated daily (Owner decision, PR #5);
 *  3. stage_ledger.flux.eggs_hatcing -> eggs_hatching (Owner decision, PR #5; key position preserved).
 */
import { DEFAULT_REFS } from '../../cli/lib/project-day.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export function normaliseV6Projection(o: { main: Any; world: Any; report: Any }, now: string): void {
  const m = o.main, r = o.report.summary;
  m.updated_at = now;
  m.simulation.latest_day_summary.engine_ref = DEFAULT_REFS.engine_ref; m.simulation.latest_day_summary.params_ref = DEFAULT_REFS.params_ref;
  o.world.time.last_transition.program_ref = DEFAULT_REFS.engine_ref; o.world.time.last_transition.params_ref = DEFAULT_REFS.params_ref;
  if (m.simulation.next_engine_ref === 'sim/day_engine.cjs') { m.simulation.next_engine_ref = DEFAULT_REFS.engine_ref; m.simulation.v2_params_ref = DEFAULT_REFS.params_ref; }
  for (const e of m.migration_log) if (e.type === 'v2_engine_rules_only_no_clock_advance') e.assumptions_in = DEFAULT_REFS.params_ref;
  m.colony.workers.confirmed_born += r.eclosions; m.colony.workers.cumulative_deaths += r.worker_deaths;
  if (typeof m.colony.worker_deaths_cumulative === 'number') m.colony.worker_deaths_cumulative += r.worker_deaths;
  if (typeof m.colony.brood_deaths_cumulative === 'number') m.colony.brood_deaths_cumulative += r.brood_deaths;
  const flux = m.colony.population_demography.stage_ledger.flux;
  m.colony.population_demography.stage_ledger.flux = Object.fromEntries(Object.entries(flux).map(([k, v]) => [k === 'eggs_hatcing' ? 'eggs_hatching' : k, v]));
}

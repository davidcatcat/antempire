/**
 * CHEM-2 (#133) bridge: build a chemistry EnvTrace from the P0-A1 world clock's ENVIRONMENT EVENTS (engine/clock).
 * Lives outside engine/chemistry so that chemistry imports no clock module (tests/chemistry-isolation.test.ts).
 *
 * Source: environmentSpecs(cfg, series, plan) — the exact weather_sample / rain_start / rain_end events the clock
 * schedules (pure function of config + inputs). Temperature: the weather_sample values (AIR temperature at the site,
 * hence quantity 'air_temp_c_surrogate'), linear between consecutive samples. For a reconstructed (Parton–Logan-type)
 * day this linear interpolation is an approximation of the clock's own curve; tests/chem2-kinetics.test.ts reports its
 * error against finer sample steps. Rain: [rain_start, rain_end) intervals; a wet day with unknown timing makes the
 * rain trace timing_known: false (never treated as dry). No colony / worker state is read anywhere.
 */
import { environmentSpecs, type ClockWorldConfig } from '../../engine/clock/environment.ts';
import { WeatherSeries, planRain, type DailyWeatherInput } from '../../engine/clock/weather-input.ts';
import type { ChemClock } from '../../engine/chemistry/contract.ts';
import type { EnvTrace, EnvTraceProvenance } from '../../engine/chemistry/kinetics.ts';

/** seconds on the chemistry clock of a native eco time (anchor day + t minutes) — exact integer arithmetic */
export const chemSecondsOf = (clock: ChemClock, day: number, minute: number): number => ((day - clock.anchor.day) * 1440 + (minute - clock.anchor.minute)) * 60;

export function envTraceFromClock(cfg: ClockWorldConfig, inputs: readonly DailyWeatherInput[], clock: ChemClock, cover: { t0_s: number; t1_s: number }, zone_id = 'site'): EnvTrace {
  const series = new WeatherSeries(cfg.anchor, cfg.site, inputs, cfg.temperature_shape);
  const plan = planRain(series, cfg.first_day, cfg.last_day, cfg.seed, cfg.rain_timing);
  const specs = environmentSpecs(cfg, series, plan);
  const kinds = new Set(inputs.map((d) => d.provenance.kind)), synthetic = inputs.some((d) => d.provenance.synthetic);
  const prov = (method: string): EnvTraceProvenance => ({
    kind: kinds.size === 1 ? [...kinds][0] as EnvTraceProvenance['kind'] : 'synthetic_test', synthetic, assumption: true,
    source: `P0-A1 environment events (world ${cfg.world}, official false)`, method,
  });
  const knots = specs.filter((s) => s.kind === 'weather_sample').map((s) => ({ t_s: chemSecondsOf(clock, s.native!.anchor.day, s.native!.t), value: (s.payload as { temp_c: number | null }).temp_c }))
    .filter((k) => k.t_s >= cover.t0_s - cfg.sample_step_min * 60 && k.t_s <= cover.t1_s + cfg.sample_step_min * 60).sort((a, b) => a.t_s - b.t_s);
  const starts = new Map<string, number>(), intervals: { event_id: string; t0_s: number; t1_s: number }[] = [];
  for (const s of specs) {
    const id = (s.payload as { rain_event?: string }).rain_event;
    if (s.kind === 'rain_start') starts.set(id!, chemSecondsOf(clock, s.native!.anchor.day, s.native!.t));
  }
  for (const s of specs) if (s.kind === 'rain_end') { const id = (s.payload as { rain_event: string }).rain_event; intervals.push({ event_id: id, t0_s: starts.get(id)!, t1_s: chemSecondsOf(clock, s.native!.anchor.day, s.native!.t) }); }
  const unknownWet = plan.days.some((d) => d.timing === 'unknown' && d.input_nm !== 0);
  return {
    clock: clock.name, t0_s: cover.t0_s, t1_s: cover.t1_s,
    zones: [{
      zone_id, selector: { kind: 'all' },
      temperature: { quantity: 'air_temp_c_surrogate', knots, provenance: prov(`weather_sample every ${cfg.sample_step_min} min; linear between samples (air temperature used as a ground-surface surrogate, 遊戲假設 D)`) },
      rain: { timing_known: !unknownWet, intervals: intervals.sort((a, b) => a.t0_s - b.t0_s), provenance: prov('rain_start / rain_end events, piecewise constant') },
    }],
  };
}

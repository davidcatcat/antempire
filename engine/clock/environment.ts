/**
 * P0-A1 — the 24-hour ENVIRONMENT CLOCK of an isolated, NON-OFFICIAL Day0 experiment world (docs/p0a1-24h-clock.md).
 *
 * It turns the environment inputs into world events on the shared scheduler (engine/scheduler/world-events.ts) and
 * keeps the environment state they imply: light transitions (civil dawn, sunrise, sunset, civil dusk), weather samples
 * on a fixed step (hourly by default), rain starts and ends. It closes days with the scheduler's runDay() and checks
 * the time and conservation invariants at every close. Nothing resets at 24:00: light, rain and pending events carry
 * across midnight; a day close is a settlement point, not a reset.
 *
 * Status: ISOLATED (tests/clock-isolation.test.ts). No colony, worker or brood state is read or written; no behaviour;
 * no species parameter. The scheduler contract is a parameter of the run: 'layered' by default (Owner 2026-11-08 target
 * for the isolated phase), 'tick' as a compatibility mode.
 * Events that are not environment events (e.g. an isolated resource model sharing the world axis) are handed to the
 * `foreign` hook as ONE batch per scheduler batch — the set of everything at that instant — never one by one, and the
 * clock picks no winner among them.
 */
import { type BatchContext, type CellPrepare, CommitCell, type EventSpec, type Handler, type SchedulerSnapshot, type StepOutput, type TimeOrder, type WorldEvent, type WorldTime, WorldScheduler, compareExact, exactOf } from '../scheduler/world-events.ts';
import { type CalendarAnchor, type Resolution, checkAnchor, clockFail, dateOfDay, displayOf, ecoNative } from './time-frames.ts';
import { type LightState, type SolarSite, checkSite, lightStateAt } from './solar.ts';
import { type DailyWeatherInput, type RainPlan, type RainTimingScenario, type TemperatureShape, WeatherSeries, planRain } from './weather-input.ts';

export interface ClockWorldConfig {
  /** world id on the scheduler; the run is an experiment world, never the official one */
  world: string; official: false;
  anchor: CalendarAnchor; site: SolarSite;
  order: TimeOrder;
  /** minutes between weather samples; must divide 1440 (60 = hourly) */
  sample_step_min: number;
  first_day: number; last_day: number; seed: number;
  temperature_shape: TemperatureShape | null;
  rain_timing: RainTimingScenario | null;
}
export const LIGHT_KINDS = { light_civil_dawn: 'civil_twilight', light_sunrise: 'day', light_sunset: 'civil_twilight', light_civil_dusk: 'night' } as const;
const LIGHT_FROM: Record<keyof typeof LIGHT_KINDS, LightState> = { light_civil_dawn: 'night', light_sunrise: 'civil_twilight', light_sunset: 'day', light_civil_dusk: 'civil_twilight' };
export const ENV_KINDS = new Set<string>([...Object.keys(LIGHT_KINDS), 'weather_sample', 'rain_start', 'rain_end']);

export function checkConfig(c: ClockWorldConfig): ClockWorldConfig {
  if (c.official !== false) clockFail('the 24-hour clock runs only in a non-official experiment world (official must be false)');
  checkAnchor(c.anchor); checkSite(c.site);
  if (c.order !== 'tick' && c.order !== 'layered') clockFail(`order must be 'tick' or 'layered'`);
  if (!(Number.isInteger(c.sample_step_min) && c.sample_step_min >= 1 && 1440 % c.sample_step_min === 0)) clockFail('sample_step_min must divide 1440');
  if (!(Number.isSafeInteger(c.first_day) && Number.isSafeInteger(c.last_day) && 0 <= c.first_day && c.first_day <= c.last_day)) clockFail('need 0 <= first_day <= last_day');
  return c;
}

const ENV = (world: string) => ({ world, colony: null, individual: null });
/** every environment event of the run, as scheduler specs (root events; world inputs). Pure function of config + inputs. */
export function environmentSpecs(cfg: ClockWorldConfig, series: WeatherSeries, plan: RainPlan): EventSpec[] {
  const out: EventSpec[] = [], w = cfg.world;
  for (let day = cfg.first_day; day <= cfg.last_day; day++) {
    const date = dateOfDay(cfg.anchor, day), L = series.light(day);
    if (!L) clockFail(`no weather input (and so no light times) for ${date}`);
    for (const [kind, key] of [['light_civil_dawn', L!.civil_dawn], ['light_sunrise', L!.sunrise], ['light_sunset', L!.sunset], ['light_civil_dusk', L!.civil_dusk]] as const) {
      out.push({ kind, key: date, native: ecoNative({ clock: 'eco.light', day, minute: key, resolution: 'exact' }), scope: ENV(w), source: null, target: null, payload: { date, to: LIGHT_KINDS[kind], minute_local: key, display_resolution: 'minute', method: 'NOAA solar equations (R390), general method', accuracy_note: 'model accuracy about 1 min (NOAA); terrain and buildings not modelled' } });
    }
    const input = series.input(day)!, res: Resolution = cfg.sample_step_min % 60 === 0 ? 'hour' : 'minute';
    for (let m = 0; m < 1440; m += cfg.sample_step_min) {
      const T = series.temperature(day, m), RH = series.relativeHumidity(day, m);
      out.push({ kind: 'weather_sample', key: `${date}.m${String(m).padStart(4, '0')}`, native: ecoNative({ clock: 'eco.weather', day, minute: m, resolution: res }), scope: ENV(w), source: null, target: null, payload: {
        date, minute_local: m, display_resolution: res, sample: 'instant',
        temp_c: T.value, temp_source: T.source, temp_reason: T.reason, rh_percent: RH.value, rh_source: RH.source, rh_reason: RH.reason,
        daily_provenance: input.provenance.kind, synthetic: input.provenance.synthetic, assumption: input.provenance.assumption || T.source === 'reconstructed_from_daily' || RH.source === 'reconstructed_from_daily',
      } });
    }
  }
  for (const e of plan.events) {
    const base = { rain_event: e.id, amount_nm: e.amount_nm, segments: e.segments.map((s) => ({ ...s })), timing: e.timing, display_resolution: e.resolution, synthetic: e.synthetic, assumption: e.assumption, provenance_kind: e.provenance_kind, rng_stream: e.rng_stream };
    out.push({ kind: 'rain_start', key: e.id, native: ecoNative({ clock: 'eco.rain', day: e.day, minute: e.start_min, resolution: e.resolution }), scope: ENV(w), source: null, target: null, payload: base });
    out.push({ kind: 'rain_end', key: e.id, native: ecoNative({ clock: 'eco.rain', day: e.day, minute: e.end_min, resolution: e.resolution }), scope: ENV(w), source: null, target: null, payload: base });
  }
  return out;
}

/** the environment state the events imply (plain JSON, snapshot-able) */
export interface EnvState {
  light: LightState;
  /** active rain events (sorted ids); a wet day with unknown timing is NOT represented as dry: see rainingAt() */
  raining: string[];
  /** segments of every rain event that has started (event form), for the daily settlement */
  started_rain: Record<string, { day: number; start_min: number; end_min: number; amount_nm: number }[]>;
  last_sample: { day: number; minute: number; temp_c: number | null; rh_percent: number | null } | null;
  /** executed batches and events per kind, by world day (label day) — kept in the state so a day split by a snapshot
   *  or by runUntil() still settles as one day */
  day_counts: Record<string, { batches: number; by_kind: Record<string, number> }>;
  /** latest executed exact instant, for the monotone-clock check */
  last_exact: { day: number; us: number; us_lo: number } | null;
}
export interface DayRecord {
  day: number; date: string; batches: number; executed_by_kind: Record<string, number>;
  rain: { input_nm: number | null; settled_nm: number | null; from_events_nm: number; timing: string; conserved: boolean | null; rounding_residual_nm: number };
  light_at_close: LightState; raining_at_close: boolean | null; pending_after_close: number;
  light_times: { civil_dawn: string; sunrise: string; sunset: string; civil_dusk: string };
}

/** freeze plain JSON data (the environment state and day records only; never caller objects) */
const freezeData = <T>(v: T): T => { if (v && typeof v === 'object') { for (const x of Object.values(v as object)) freezeData(x); Object.freeze(v); } return v; };

export class ClockRun {
  readonly cfg: ClockWorldConfig; readonly series: WeatherSeries; readonly plan: RainPlan;
  /** batch hook for non-environment events sharing the scheduler: receives all of them of one batch together (a set);
   *  may return children / cancellations like any scheduler handler. Default null: such events are refused. */
  foreign: ((batch: readonly Readonly<WorldEvent>[], ctx: BatchContext) => StepOutput | void) | null = null;

  // Atomicity contract (R13-02; Owner review of #125). ClockRun owns exactly two things: the environment state (a
  // CommitCell attached to the scheduler) and the closed-day records. A batch commits the scheduler and the environment
  // together or neither: the handler builds the next state on a COPY and freezes it; the cell's prepare only checks and
  // returns that frozen value; the scheduler swaps it in after its own commit. The state is deep-frozen, so no foreign
  // hook, getter or caller can change it in place. NOT covered: whatever the foreign hook writes elsewhere.
  #cell: CommitCell<EnvState>;
  #days: readonly DayRecord[] = Object.freeze([]);
  #sched!: WorldScheduler;
  /** the environment state a batch would produce (frozen), staged by the handler for the cell's prepare */
  #staged: { ids: string; next: EnvState } | null = null;

  /** the committed environment state (deep-frozen; replaced, never mutated) */
  get state(): EnvState { return this.#cell.value; }
  /** the closed days (frozen) */
  get days(): readonly DayRecord[] { return this.#days; }
  /** the scheduler of this run; assigning one (e.g. a restored or re-filled scheduler) moves the environment cell to it
   *  — all checks first, so a refused assignment (e.g. from inside a batch) changes nothing */
  get scheduler(): WorldScheduler { return this.#sched; }
  set scheduler(s: WorldScheduler) {
    if (!(s instanceof WorldScheduler)) clockFail('scheduler must be a WorldScheduler');
    s.attachCell(this.#cell as CommitCell<unknown>);
    this.#sched = s; this.#staged = null;
  }

  constructor(cfg: ClockWorldConfig, inputs: readonly DailyWeatherInput[], restoreFrom?: ClockSnapshot) {
    this.cfg = checkConfig(cfg);
    this.series = new WeatherSeries(cfg.anchor, cfg.site, inputs, cfg.temperature_shape);
    this.plan = planRain(this.series, cfg.first_day, cfg.last_day, cfg.seed, cfg.rain_timing);
    if (restoreFrom) {
      if (restoreFrom.schema !== CLOCK_SNAPSHOT_SCHEMA) clockFail('clock snapshot schema mismatch');
      const sch = WorldScheduler.restore(restoreFrom.scheduler);
      if (sch.order !== cfg.order || sch.world !== cfg.world) clockFail('snapshot was taken under another world or time contract');
      this.#cell = new CommitCell<EnvState>(freezeData(JSON.parse(JSON.stringify(restoreFrom.env))), this.#prepare);
      this.#days = freezeData(JSON.parse(JSON.stringify(restoreFrom.days)));
      this.scheduler = sch;
      return;
    }
    this.#cell = new CommitCell<EnvState>(freezeData({ light: lightStateAt(this.series.light(cfg.first_day)!, 0), raining: [], started_rain: {}, last_sample: null, day_counts: {}, last_exact: null }), this.#prepare);
    this.scheduler = new WorldScheduler(cfg.world, { day: cfg.first_day, minute: 0 }, { order: cfg.order });
    for (const s of environmentSpecs(cfg, this.series, this.plan)) this.scheduler.schedule(s);
  }

  /** phase 1 of the environment cell: checks only, no mutation. Environment events may be executed only through this
   *  clock's handler (otherwise the scheduler would advance and the environment would not follow); a batch without
   *  environment events run by another handler leaves the environment unchanged. */
  readonly #prepare: CellPrepare<EnvState> = (batch, handler) => {
    if (handler !== this.#handler) {
      const env = batch.find((e) => ENV_KINDS.has(e.kind));
      if (env) clockFail(`environment event ${env.id} can be executed only by ClockRun.handler (the environment would not follow the scheduler)`);
      return null;
    }
    const st = this.#staged;
    if (!st || st.ids !== batch.map((e) => e.id).join('\n')) clockFail('internal: the environment batch to commit is not the batch the scheduler accepted');
    return { value: st!.next };
  };

  /** the batch handler: applies a batch as a SET (order inside a batch never matters) and checks local invariants.
   *  It works on a COPY of the environment state and stages it frozen; the scheduler commits it (via the cell) only once
   *  the foreign hook returned and the output was accepted. On any failure neither the environment nor the scheduler
   *  changes, and the batch can be retried. */
  get handler(): Handler { return this.#handler; }
  readonly #handler: Handler = (batch, ctx) => {
    this.#staged = null;
    const st: EnvState = JSON.parse(JSON.stringify(this.state)), ends = new Set<string>(), starts: string[] = [], others: Readonly<WorldEvent>[] = [];
    let light: LightState | null = null;
    const dc = (st.day_counts[String(batch[0].at.day)] ??= { batches: 0, by_kind: {} }); dc.batches++;
    for (const e of batch) {
      if (st.last_exact && compareExact(e.exact, st.last_exact) < 0) clockFail(`clock went backwards at ${e.id}`);
      dc.by_kind[e.kind] = (dc.by_kind[e.kind] ?? 0) + 1;
      const p = e.payload as Record<string, unknown>;
      if (e.kind in LIGHT_KINDS) {
        const k = e.kind as keyof typeof LIGHT_KINDS;
        if (st.light !== LIGHT_FROM[k] || light !== null) clockFail(`light transition ${e.id} from ${st.light} (expected ${LIGHT_FROM[k]})`);
        light = LIGHT_KINDS[k];
      } else if (e.kind === 'weather_sample') st.last_sample = { day: e.at.day, minute: p.minute_local as number, temp_c: p.temp_c as number | null, rh_percent: p.rh_percent as number | null };
      else if (e.kind === 'rain_start') { starts.push(p.rain_event as string); st.started_rain[p.rain_event as string] = (p.segments as EnvState['started_rain'][string]).map((s) => ({ ...s })); }
      else if (e.kind === 'rain_end') { if (!st.raining.includes(p.rain_event as string)) clockFail(`rain_end ${e.id} without an active rain event`); ends.add(p.rain_event as string); }
      else if (this.foreign) others.push(e); else clockFail(`unknown event kind ${e.kind} on the environment clock`);
    }
    if (light) st.light = light;
    for (const s of starts) if (st.raining.includes(s)) clockFail(`rain ${s} started twice`);
    // set semantics: (active − ends) ∪ starts; a zero-length event cannot exist (start < end is checked at planning)
    st.raining = [...st.raining.filter((x) => !ends.has(x)), ...starts].sort();
    const hi = batch.reduce((m, e) => (compareExact(e.exact, m) > 0 ? e.exact : m), batch[0].exact);
    st.last_exact = { ...hi };
    // the foreign hook sees the environment as it was before this batch (the batch is a set; nothing is committed yet)
    const out = others.length ? this.foreign!(others, ctx) : undefined;
    this.#staged = { ids: batch.map((e) => e.id).sort().join('\n'), next: freezeData(st) };
    return out;
  };

  /** raining at the current clock: null on a wet day whose timing is unknown (never shown as dry) */
  rainingAt(day: number): boolean | null {
    const d = this.plan.days.find((x) => x.day === day);
    if (d && d.timing === 'unknown' && d.input_nm !== 0) return null;
    return this.state.raining.length > 0;
  }
  runUntil(t: WorldTime): number { return this.#sched.runUntil(t, this.#handler); }

  /** close world day `day` (runs what is left of it) and settle: conservation and ordering checks; returns the record */
  closeDay(day: number): DayRecord {
    this.#sched.runDay(day, this.#handler);
    const counts = this.state.day_counts[String(day)] ?? { batches: 0, by_kind: {} }, batches = counts.batches;
    const executed_by_kind = Object.fromEntries(Object.entries(counts.by_kind).sort(([a], [b]) => (a < b ? -1 : 1)));
    const pd = this.plan.days.find((x) => x.day === day)!, L = this.series.light(day)!;
    let fromEvents = 0;
    for (const segs of Object.values(this.state.started_rain)) for (const s of segs) if (s.day === day) fromEvents += s.amount_nm;
    const conserved = pd.settled_nm === null ? null : pd.settled_nm === fromEvents;
    if (conserved === false) clockFail(`rain on day ${day}: events give ${fromEvents} nm, the day settles ${pd.settled_nm} nm`);
    // every started rain event's segment for this day must lie inside the day and inside the event
    const disp = (m: number) => displayOf(this.cfg.anchor, exactOf(ecoNative({ clock: 'eco.light', day, minute: m, resolution: 'exact' })), 'minute').clock_text;
    const rec: DayRecord = {
      day, date: dateOfDay(this.cfg.anchor, day), batches, executed_by_kind,
      rain: { input_nm: pd.input_nm, settled_nm: pd.settled_nm, from_events_nm: fromEvents, timing: pd.timing, conserved, rounding_residual_nm: pd.rounding_residual_nm },
      light_at_close: this.state.light, raining_at_close: this.rainingAt(day), pending_after_close: this.scheduler.pending().length,
      light_times: { civil_dawn: disp(L.civil_dawn), sunrise: disp(L.sunrise), sunset: disp(L.sunset), civil_dusk: disp(L.civil_dusk) },
    };
    // the settled state is built on a copy; then two assignments (replace() is the only one that can refuse, and it
    // runs first), so a refused close changes nothing
    const next: EnvState = JSON.parse(JSON.stringify(this.state));
    delete next.day_counts[String(day)];
    // forget segments that can no longer be settled (their last day is closed)
    for (const [id, segs] of Object.entries(next.started_rain)) if (segs.every((s) => s.day <= day) && !next.raining.includes(id)) delete next.started_rain[id];
    this.#cell.replace(freezeData(next));
    this.#days = Object.freeze([...this.#days, freezeData(rec)]);
    return rec;
  }
  snapshot(): ClockSnapshot { return JSON.parse(JSON.stringify({ schema: CLOCK_SNAPSHOT_SCHEMA, scheduler: this.scheduler.snapshot(), env: this.state, days: this.days })); }
}
export const CLOCK_SNAPSHOT_SCHEMA = 'antempire.p0a1-clock.v1';
export interface ClockSnapshot { schema: string; scheduler: SchedulerSnapshot; env: EnvState; days: DayRecord[] }

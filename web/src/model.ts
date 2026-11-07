/**
 * Viewer data model: pure functions over the exported files (web/data/*.json). No DOM, no engine import, no
 * randomness, no writes. Everything returned is either copied from the export or a DISPLAY interpolation that is
 * marked as such; nothing here creates an ecological event, an individual or a behaviour.
 */

export interface Layout { x: number; y: number; basis: string }
export interface Place { id: string; name: string; bearing: string | null; distance_cm: number | null; kind: string | null; layout: Layout | null }
export interface Link { from: string; to: string; length_cm?: number | null; approx_cm?: number | null; legacy_minutes_if_unknown?: number | null }
export interface WorkerSnap { id: string; age_days: number; age_origin: string | null; injured: boolean; injury_type: string | null; task: string; crop_sugar: number; known_sources: string[]; route_edges: string[]; location: string }
export interface ColonySnap { queen_alive: boolean; workers: WorkerSnap[]; brood: { id: string; stage: string; progress: number }[]; stores: { sugar: number; protein: number }; trails: Record<string, number>; sources: Record<string, { type: string; sugar: number; protein: number; host_alive: boolean | null; hemipteran_colonies: number | null }>; insects: Record<string, number> }
export interface SimEvent { type: string; worker?: string; minute?: number; start?: number; end?: number; place?: string; action?: string; outcome?: string; from?: string; to?: string; site?: string; [k: string]: unknown }
export interface ExperimentDay { day: number; date: string; weather: { air_temp_c: number; nest_temp_c: number; rain_mm: number; wet: boolean }; window_minutes: number | null; tasks: Record<string, { task: string; trips: number; successes: number; stop_reason: string | null }> | null; income: { sugar: number; protein: number }; consumed: { sugar: number; protein: number }; eggs_laid: number; eclosions: number; worker_deaths: number; events: SimEvent[]; end_state: ColonySnap }
export interface Experiment { schema: string; kind: 'experiment'; official: false; note: string; spec: { id: string; founding: string; season: string; seed: number; days: number }; engine_version: string; map: { places: Place[]; links: Link[]; layout_basis: string }; day0: { day: 0; date: string; state: ColonySnap }; days: ExperimentDay[] }
export interface OfficialWorker { id: string; status: string; cause_of_death: string | null; last_recorded_day: number | null; location_at_day_end: string | null; site_sequence: string[]; activity: string[]; injured_preexisting: boolean | null; new_injury: boolean | null }
export interface Official { schema: string; kind: 'official'; read_only: true; note: string; day: number; calendar_date: string; map: { places: Place[]; links: Link[]; precision: string }; queen: { id: string; status: string }; workers: OfficialWorker[]; brood: { id: string; stage: string; living: boolean }[] }

export const NEST = 'N00';

/** Display positions (cm, x east / y north) for every place; places without a recorded bearing+distance get a slot in an
 *  "unknown position" tray drawn apart from the map (never an invented garden position). */
export function displayPositions(places: Place[]): Record<string, { x: number; y: number; known: boolean }> {
  const out: Record<string, { x: number; y: number; known: boolean }> = {};
  const known = places.filter((p) => p.layout);
  const minX = Math.min(0, ...known.map((p) => (p.layout as Layout).x)), minY = Math.min(0, ...known.map((p) => (p.layout as Layout).y));
  let k = 0;
  for (const p of [...places].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (p.layout) out[p.id] = { x: p.layout.x, y: p.layout.y, known: true };
    else out[p.id] = { x: minX - 20 + 18 * k++, y: minY - 25, known: false };
  }
  return out;
}

/** The colony as it was at the START of experiment day `day` (= end of the previous day). Days outside the
 *  recorded replay (1 … days.length) are refused: the viewer never extrapolates beyond the engine's timeline. */
export function stateAtStart(exp: Experiment, day: number): ColonySnap {
  if (!Number.isInteger(day) || day < 1 || day > exp.days.length) throw new RangeError(`day ${day} is outside the recorded replay 1…${exp.days.length}`);
  return day === 1 ? exp.day0.state : exp.days[day - 2].end_state;
}

/** Minutes after the activity window at which the end-of-day settlement is shown. The engine applies deaths,
 *  eclosions, egg laying and development at the END of the day without a clock time; the viewer shows them as one
 *  explicit "日終結算" step after the window, never at an invented minute. */
export const SETTLEMENT_STEP = 1;
export const windowOf = (d: ExperimentDay) => d.window_minutes ?? 360;
export const isSettled = (d: ExperimentDay, t: number) => t > windowOf(d);

/** The colony to DRAW at minute t of day `day`: the start-of-day state during the activity window, the engine's
 *  end-of-day state after the settlement step (so deaths and eclosions of that day are visible). */
export function stateAt(exp: Experiment, day: number, t: number): ColonySnap {
  const s = stateAtStart(exp, day);
  return isSettled(exp.days[day - 1], t) ? exp.days[day - 1].end_state : s;
}

/** The world kinds are never mixed: a file loaded for one mode must declare that mode. */
export function assertKind<T extends { kind: string; schema: string }>(data: T, kind: 'official' | 'experiment', file: string): T {
  const d = data as unknown as { kind: string; schema: string; official?: boolean; days?: unknown };
  const ok = kind === 'official'
    ? d.kind === 'official' && d.schema === 'antempire.web.official-snapshot.v1' && d.days === undefined
    : d.kind === 'experiment' && d.schema === 'antempire.web.experiment-replay.v1' && d.official === false && Array.isArray(d.days);
  if (!ok) throw new Error(`${file} is not ${kind} data (kind ${d.kind}, schema ${d.schema})`);
  return data;
}

/** Recorded activity segments of one worker on one day, in time order. */
export function segmentsOf(d: ExperimentDay, workerId: string): SimEvent[] {
  return d.events.filter((e) => e.type === 'worker_activity' && e.worker === workerId).sort((a, b) => (a.start as number) - (b.start as number) || (a.end as number) - (b.end as number));
}

export interface DisplayPose { x: number; y: number; place: string; action: string; interpolated: boolean; segment: SimEvent | null }
/**
 * Where to DRAW a worker at minute t of a day. Recorded points: the engine's route_step events (arrival minute at
 * each node of a walk) and activity segment boundaries. Between two recorded points the position is linearly
 * interpolated for display only (`interpolated: true`). Workers with no segment are drawn where the engine last
 * placed them (the nest). This function never produces events.
 */
export function poseAt(d: ExperimentDay, workerId: string, t: number, pos: Record<string, { x: number; y: number }>, nest = NEST): DisplayPose {
  const segs = segmentsOf(d, workerId);
  let here = nest;
  for (const s of segs) {
    const start = s.start as number, end = s.end as number, place = s.place as string;
    if (t < start) break;
    if (place.includes('>')) {
      const route = place.split('>');
      if (t <= end) {
        // arrival minutes at each node, from the engine's route_step events of this walk
        const steps = d.events.filter((e) => e.type === 'route_step' && e.worker === workerId && (e.minute as number) > start - 1e-9 && (e.minute as number) <= end + 1e-9);
        const times = [start];
        for (let i = 1; i < route.length; i++) { const st = steps.find((e) => e.from === route[i - 1] && e.to === route[i] && (e.minute as number) >= times[i - 1] - 1e-9); times.push(st ? (st.minute as number) : start + ((end - start) * i) / (route.length - 1)); }
        for (let i = 1; i < route.length; i++) {
          if (t <= times[i] + 1e-9) {
            const a = pos[route[i - 1]], b = pos[route[i]], f = times[i] > times[i - 1] ? (t - times[i - 1]) / (times[i] - times[i - 1]) : 1;
            if (!a || !b) return { x: (b ?? a ?? { x: 0 }).x, y: (b ?? a ?? { y: 0 }).y, place: route[i], action: s.action as string, interpolated: true, segment: s };
            return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, place: `${route[i - 1]}>${route[i]}`, action: s.action as string, interpolated: f > 0 && f < 1, segment: s };
          }
        }
      }
      here = route[route.length - 1];
    } else {
      if (t <= end) { const p = pos[place] ?? pos[nest]; return { x: p.x, y: p.y, place, action: s.action as string, interpolated: false, segment: s }; }
      here = place;
    }
  }
  const p = pos[here] ?? pos[nest];
  return { x: p.x, y: p.y, place: here, action: here === nest ? 'in_nest' : 'at_site', interpolated: false, segment: null };
}

/** True when the engine gave this event a clock minute. Events without one (deaths, eclosions, egg laying,
 *  ecology) belong to the end-of-day settlement and are never given an invented time. */
export const isTimed = (e: SimEvent) => typeof e.minute === 'number' || typeof e.start === 'number';

/** Events of a day up to minute t: timed events whose minute <= t; untimed (end-of-day) events only once the
 *  settlement step is shown (t > window). */
export function eventsUntil(d: ExperimentDay, t: number): SimEvent[] {
  const settled = isSettled(d, t);
  return d.events.filter((e) => e.type !== 'worker_activity' && e.type !== 'route_step' && (isTimed(e) ? ((typeof e.minute === 'number' ? e.minute : e.start) as number) <= t : settled));
}

/** The task the ENGINE recorded for this worker on this day (one daily draw; recruitment may send a non-forager out).
 *  Falls back to the task in the start-of-day state when the export has no per-day task table. Never inferred. */
export function taskOf(d: ExperimentDay, s: ColonySnap, workerId: string): { task: string | null; source: 'engine_day_task' | 'start_of_day_state' | 'none' } {
  const t = d.tasks?.[workerId]?.task;
  if (t) return { task: t, source: 'engine_day_task' };
  const w = s.workers.find((x) => x.id === workerId);
  return w ? { task: w.task, source: 'start_of_day_state' } : { task: null, source: 'none' };
}

/** Pheromone values to draw: the engine's trail strength per edge at the START of the day (game units, not a
 *  chemical concentration). The viewer does not decay or animate them within the day. */
export function trailScale(s: ColonySnap): { max: number; edges: number } {
  const v = Object.values(s.trails).filter((x) => x > 0);
  return { max: v.length ? Math.max(...v) : 0, edges: v.length };
}

/** Union of the route edges remembered by the workers alive at the start of the day (observer overlay). */
export function exploredEdges(s: ColonySnap): Set<string> { return new Set(s.workers.flatMap((w) => w.route_edges)); }

const EVENT_LABEL: Record<string, string> = {
  discovery: '發現食源', scouted_empty: '到達但沒有食物', exploration_step: '探索新路段', exploration_found_nothing: '探索沒有發現', food_collected: '採集', food_delivered: '回巢卸貨', trophallaxis: '交哺', local_recruitment: '招募同伴', hunt_recruitment: '捕獵招募', live_prey_encounter: '遇到活獵物', insect_predation: '捕獲獵物', prey_escaped: '獵物逃走', joint_prey_transport: '共同搬運', worker_death: '工蟻死亡', brood_death: '幼體死亡', queen_death: '蟻后死亡', egg_laid: '產卵', hatch: '孵化', pupation: '化蛹', eclosion: '羽化', forager_stopped: '停止覓食', action_cancelled_no_time: '時間不足取消', insect_natural_death: '昆蟲自然死亡', host_plant_death: '寄主植物死亡', hemipteran_colony_change: '半翅目族群變化',
};
export const ACTION_LABEL: Record<string, string> = { foraging_depart: '出巢覓食', foraging_return: '回巢', search: '搜尋', collect: '採集', unload: '卸貨', rest: '巢內休息', explore_depart: '出去探索', explore_return: '探索後回巢', trail_follow_depart: '沿費洛蒙出發', recruit_follow_trail: '跟隨招募', hunt_recruit_trail_home: '回巢招募捕獵', hunt_recruit_lead: '帶領捕獵隊', hunt_recruit_follow_trail: '跟隨捕獵隊', prey_handling: '處理獵物', hold_prey: '守住獵物', joint_prey_transport: '共同搬運', in_nest: '在巢內', at_site: '在地點' };
export const TASK_LABEL: Record<string, string> = { forage: '覓食', nurse: '照護', rest: '休息', repair: '修繕', guard: '守衛' };
export const REASON_LABEL: Record<string, string> = { gave_up_after_unsuccessful_trip: '空手而回後放棄', own_motivation_after_unloading: '卸貨後不再出去', no_time_left_in_activity_window: '時間不足', activity_window_closed: '活動時段結束', no_known_route_and_no_exploration: '不知道路也沒去探索', starvation_or_natural_competing_hazards_scenario: '飢餓與自然風險', natural_or_injury_assumed: '自然或傷害', chronic_protein_shortage_game_scenario: '長期蛋白不足', unattended_brood_no_worker_care_game_assumption: '無人照護', no_workers: '沒有工蟻', chronic_sugar_deficit: '長期缺糖', chronic_protein_deficit: '長期缺蛋白', chronic_sugar_and_protein_deficit: '長期缺糖與蛋白', failed_capture: '捕捉失敗', escaped_while_recruiting: '招募時逃走' };
export function describeEvent(e: SimEvent): string {
  const who = e.worker ?? (e.by ? `${e.by}→${e.to}` : e.type === 'trophallaxis' ? `${e.from}→${e.to}` : e.type === 'eclosion' ? `${e.source_brood_id}→${e.new_worker_id}` : e.id ?? '');
  // "@X" is only the place the event HAPPENED (EVENT_PLACE_FIELD); a food source or recruitment target is named as such
  const pf = EVENT_PLACE_FIELD[e.type], at = pf ? e[pf] : undefined, src = typeof e.site === 'string' && e.site !== at ? e.site : '';
  const where = (typeof at === 'string' ? at : '') + (src ? `${at ? ' ' : ''}${e.type === 'food_delivered' ? '來自' : '目標'} ${src}` : '');
  const reason = typeof e.reason === 'string' ? ` ${REASON_LABEL[e.reason] ?? e.reason}` : '';
  const extra = e.type === 'food_collected' || e.type === 'food_delivered' ? ` ${e.macro === 'sugar' ? '糖' : '蛋白'} ${Number(e.portions).toFixed(2)} 份` : reason;
  return `${EVENT_LABEL[e.type] ?? e.type}${who ? ' ' + who : ''}${where ? (typeof at === 'string' ? ' @' : ' ') + where : ''}${extra}`;
}

// ───────────────────────── V3: event jump and individual follow (Issue #99) ─────────────────────────
// Everything below only READS recorded fields. No minute, place or worker is ever inferred from neighbouring events.

/**
 * The field that records WHERE an event happened, per event type, as the engine writes it (engine/activity.ts,
 * foraging.ts, ecology). Types not listed have no place field (local_recruitment's `site` is the food site being
 * recruited TO, not where the contact happened; food_delivered's `site` is the food's source): their place is unknown
 * to the viewer and it says so instead of guessing.
 */
export const EVENT_PLACE_FIELD: Record<string, 'location' | 'site' | 'node' | 'to'> = {
  food_collected: 'location', food_delivered: 'location', trophallaxis: 'location',
  discovery: 'site', scouted_empty: 'site', live_prey_encounter: 'site', insect_predation: 'site', prey_escaped: 'site', joint_prey_transport: 'site', insect_natural_death: 'site', host_plant_death: 'site', hemipteran_colony_change: 'site',
  exploration_found_nothing: 'node',
  exploration_step: 'to', // the engine emits it on arrival at `to` (activity.ts: trip.kind === 'explore' on arrive)
};
/** Fields that hold worker IDs, per event type (never a node: exploration_step's `to` is a node, trophallaxis' is a worker). */
const EVENT_WORKER_FIELDS: Record<string, string[]> = {
  local_recruitment: ['by', 'to'], hunt_recruitment: ['by', 'to'], trophallaxis: ['from', 'to'], worker_death: ['id'], eclosion: ['new_worker_id'],
  insect_predation: ['team'], live_prey_encounter: ['worker', 'co_located_team'], prey_escaped: ['worker', 'participants'], joint_prey_transport: ['worker', 'team', 'participants'],
};

/** Worker IDs an event names (first = the actor), from the recorded fields only, without duplicates. */
export function eventWorkers(e: SimEvent): string[] {
  const out: string[] = [];
  for (const f of EVENT_WORKER_FIELDS[e.type] ?? ['worker']) {
    const v = e[f];
    for (const id of Array.isArray(v) ? v : [v]) if (typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface EventPlace { place: string | null; known: boolean; field: string | null }
/** Where an event happened: the recorded place ID, and whether that place has a (schematic) map position. A place
 *  with no recorded bearing+distance, or no place field at all, is unknown — the camera does not move. */
export function eventPlace(e: SimEvent, pos: Record<string, { known: boolean }>): EventPlace {
  const field = EVENT_PLACE_FIELD[e.type] ?? null, v = field ? e[field] : undefined;
  if (typeof v !== 'string') return { place: null, known: false, field: null };
  return { place: v, known: pos[v]?.known === true, field };
}

export interface EventJump { day: number; t: number; timed: boolean; minute: number | null; place: EventPlace; workers: string[] }
/** Where the timeline goes when an event is clicked: its recorded minute (exactly), or — for an event the engine
 *  applied at the end of the day without a clock time — the settlement step of that day. Never an invented minute. */
export function eventJump(d: ExperimentDay, e: SimEvent, pos: Record<string, { known: boolean }>): EventJump {
  const minute = typeof e.minute === 'number' ? e.minute : typeof e.start === 'number' ? e.start : null;
  return { day: d.day, t: minute ?? windowOf(d) + SETTLEMENT_STEP, timed: minute !== null, minute, place: eventPlace(e, pos), workers: eventWorkers(e) };
}

/** All listed (non-segment) events of a day in timeline order: timed events by minute (stable), then the end-of-day
 *  settlement events in their recorded order. The index in d.events is kept so a click names one exact record. */
export function dayTimeline(d: ExperimentDay): { e: SimEvent; i: number; t: number }[] {
  const out = d.events.map((e, i) => ({ e, i, t: isTimed(e) ? ((typeof e.minute === 'number' ? e.minute : e.start) as number) : Infinity })).filter((x) => x.e.type !== 'worker_activity' && x.e.type !== 'route_step');
  return out.sort((a, b) => a.t - b.t || a.i - b.i);
}

export type FollowStatus =
  | { kind: 'visible'; x: number; y: number; place: string; interpolated: boolean; known: true }
  | { kind: 'unknown_position'; place: string }      // at (or walking to/from) a place with no recorded position
  | { kind: 'dead'; day: number }                     // died at the settlement of `day` (no clock time recorded)
  | { kind: 'not_present'; eclosion_day: number | null }; // not in the colony at this moment (not eclosed yet, or never)
/**
 * What the follow camera can show for worker `id` at (day, t). A worker exists while it is in the drawn colony
 * (stateAt). Dead workers are reported with the day of their recorded death; workers that eclose later with the day of
 * their recorded eclosion. Positions are the same display pose as the map (poseAt), flagged when interpolated.
 */
export function followStatus(exp: Experiment, day: number, t: number, id: string, pos: Record<string, { x: number; y: number; known: boolean }>): FollowStatus {
  const d = exp.days[day - 1], s = stateAt(exp, day, t);
  if (!s.workers.some((w) => w.id === id)) {
    for (let k = 1; k <= day; k++) if (exp.days[k - 1].events.some((e) => e.type === 'worker_death' && e.id === id) && (k < day || isSettled(d, t))) return { kind: 'dead', day: k };
    const ecl = exp.days.find((x) => x.events.some((e) => e.type === 'eclosion' && e.new_worker_id === id));
    return { kind: 'not_present', eclosion_day: ecl ? ecl.day : null };
  }
  const p = poseAt(d, id, t, pos), ends = p.place.split('>');
  if (ends.some((x) => pos[x]?.known === false)) return { kind: 'unknown_position', place: p.place };
  return { kind: 'visible', x: p.x, y: p.y, place: p.place, interpolated: p.interpolated, known: true };
}

// ───────────────────────── V4: derived walking speed and daily ecology series (Issue #99 follow-up) ─────────────────────────

export interface WalkSpeed { edge: string; from: string; to: string; length_cm: number | null; t0: number; t1: number; mm_s: number | null; basis: string }
/**
 * The walking speed on the edge a worker is walking at minute t, DERIVED from engine records only: the recorded edge
 * length (world setting "約距離" — a game assumption and a lower bound of the real path) divided by the engine-recorded time
 * between the two recorded points of that edge (segment start / route_step arrival minutes). An average over the edge,
 * not an instantaneous speed. null when the worker is not walking or the edge has no recorded length (never estimated).
 */
export function walkSpeedAt(d: ExperimentDay, workerId: string, t: number, links: Link[]): WalkSpeed | null {
  for (const s of segmentsOf(d, workerId)) {
    const start = s.start as number, end = s.end as number, place = s.place as string;
    if (t < start || t > end || !place.includes('>')) continue;
    const route = place.split('>');
    const steps = d.events.filter((e) => e.type === 'route_step' && e.worker === workerId && (e.minute as number) > start - 1e-9 && (e.minute as number) <= end + 1e-9);
    const times = [start];
    for (let i = 1; i < route.length; i++) { const st = steps.find((e) => e.from === route[i - 1] && e.to === route[i] && (e.minute as number) >= times[i - 1] - 1e-9); if (!st) return null; times.push(st.minute as number); }
    for (let i = 1; i < route.length; i++) if (t <= times[i] + 1e-9) {
      const a = route[i - 1], b = route[i], l = links.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
      const len = typeof l?.length_cm === 'number' ? l.length_cm : null, dt = times[i] - times[i - 1];
      return { edge: `${a}>${b}`, from: a, to: b, length_cm: len, t0: times[i - 1], t1: times[i], mm_s: len !== null && dt > 0 ? (len * 10) / (dt * 60) : null, basis: len === null ? '路段長度未記錄：速度未知（不推算）' : '路段長度（世界設定的約距離，遊戲假設，實際路徑長度的下限）÷ 引擎記錄的走完時間；整段平均，不是瞬時速度' };
    }
  }
  return null;
}

export interface DayPoint { day: number; date: string; workers: number; eggs: number; larvae: number; pupae: number; store_sugar: number; store_protein: number; garden_sugar: number; garden_protein: number; income_sugar: number | null; income_protein: number | null; air_c: number | null; nest_c: number | null; rain_mm: number | null; deaths: number | null; eclosions: number | null; eggs_laid: number | null; insects: number; hemipteran_colonies: number; hosts_alive: number }
/** One point per recorded state: Day0 (the initial state; no daily flows) and the END of every simulated day. Values are
 *  copied from the export (engine end-of-day state and day summary); nothing is smoothed or interpolated. */
export function dailySeries(exp: Experiment): DayPoint[] {
  const pt = (day: number, date: string, s: ColonySnap, d: ExperimentDay | null): DayPoint => {
    const src = Object.values(s.sources), n = (st: string) => s.brood.filter((b) => b.stage === st).length;
    return { day, date, workers: s.workers.length, eggs: n('egg'), larvae: n('larva'), pupae: n('pupa'), store_sugar: s.stores.sugar, store_protein: s.stores.protein,
      garden_sugar: src.reduce((q, x) => q + x.sugar, 0), garden_protein: src.reduce((q, x) => q + x.protein, 0),
      income_sugar: d ? d.income.sugar : null, income_protein: d ? d.income.protein : null, air_c: d ? d.weather.air_temp_c : null, nest_c: d ? d.weather.nest_temp_c : null, rain_mm: d ? d.weather.rain_mm : null,
      deaths: d ? d.worker_deaths : null, eclosions: d ? d.eclosions : null, eggs_laid: d ? d.eggs_laid : null,
      // V5: garden biota at the end of the day (observer view; copied from the engine state)
      insects: Object.values(s.insects).reduce((q, x) => q + x, 0), hemipteran_colonies: src.reduce((q, x) => q + (x.hemipteran_colonies ?? 0), 0), hosts_alive: src.filter((x) => x.host_alive === true).length };
  };
  return [pt(0, exp.day0.date, exp.day0.state, null), ...exp.days.map((d) => pt(d.day, d.date, d.end_state, d))];
}

// ───────────────────────── V5: event categories, cross-day filter, event map marks, recorded routes ─────────────────────────
// Read-only views over recorded events. A category is a grouping of the engine's event TYPE (a fixed table), never a
// judgement about what an ant "meant"; no event, minute or place is created.

export type EventCategory = 'forage' | 'social' | 'explore' | 'hunt' | 'death' | 'brood' | 'care' | 'ecology' | 'other';
export const EVENT_CATEGORY: Record<string, EventCategory> = {
  discovery: 'forage', scouted_empty: 'forage', food_collected: 'forage', food_delivered: 'forage', forager_stopped: 'forage', action_cancelled_no_time: 'forage', no_route_cannot_depart: 'forage', protein_cached_at_nest: 'forage',
  local_recruitment: 'social', trophallaxis: 'social', recruitment_no_nestmate: 'social', recruitment_failed: 'social', food_transfer: 'social',
  exploration_step: 'explore', exploration_found_nothing: 'explore', exploration_no_new_direction: 'explore',
  live_prey_encounter: 'hunt', insect_predation: 'hunt', prey_escaped: 'hunt', joint_prey_transport: 'hunt', hunt_recruitment: 'hunt', waiting_prey_joined: 'hunt',
  worker_death: 'death', brood_death: 'death', queen_death: 'death',
  egg_laid: 'brood', hatch: 'brood', pupation: 'brood', eclosion: 'brood',
  // individual brood-care contacts exist only in the default-OFF C3a/C4a nest round; the committed replays contain none
  larva_contact: 'care', local_brood_begging_contact: 'care', queen_contact: 'care', queen_encounter_food: 'care',
  insect_natural_death: 'ecology', insect_background_death: 'ecology', insect_population_birth: 'ecology', insect_immigration: 'ecology', host_plant_death: 'ecology', hemipteran_colony_change: 'ecology', new_food_source: 'ecology',
};
export const CATEGORY_LABEL: Record<EventCategory, string> = { forage: '覓食與採集', social: '招募與交哺', explore: '探索', hunt: '捕獵', death: '死亡', brood: '產卵與發育', care: '育幼接觸', ecology: '環境生態', other: '其他' };
export const categoryOf = (e: SimEvent): EventCategory => EVENT_CATEGORY[e.type] ?? 'other';

export interface TimelineRow { day: number; i: number; e: SimEvent; t: number }
/** Every listed event of the replay (all days), each day in dayTimeline order; `t` = recorded minute or Infinity
 *  (end-of-day settlement, no clock time). */
export function allTimeline(exp: Experiment): TimelineRow[] {
  return exp.days.flatMap((d) => dayTimeline(d).map((r) => ({ day: d.day, i: r.i, e: r.e, t: r.t })));
}
/** Filter timeline rows by category set (empty = all) and by a worker named in the record (null = anyone). */
export function filterRows<R extends { e: SimEvent }>(rows: R[], cats: ReadonlySet<EventCategory>, worker: string | null): R[] {
  return rows.filter((r) => (!cats.size || cats.has(categoryOf(r.e))) && (!worker || eventWorkers(r.e).includes(worker)));
}
/** Counts of events per category (for the filter chips). */
export function categoryCounts(rows: { e: SimEvent }[]): Record<EventCategory, number> {
  const out = Object.fromEntries(Object.keys(CATEGORY_LABEL).map((k) => [k, 0])) as Record<EventCategory, number>;
  for (const r of rows) out[categoryOf(r.e)]++;
  return out;
}

export interface PlaceMark { place: string; total: number; byCat: Partial<Record<EventCategory, number>> }
export interface EventMarks { marks: PlaceMark[]; noPlace: number; unknownPlace: number; noPlaceByCat: Partial<Record<EventCategory, number>> }
/**
 * Where the given events HAPPENED, grouped by recorded place (EVENT_PLACE_FIELD only). Events without a place field
 * (deaths, egg laying, development, recruitment contacts …) are only counted (noPlace) — never put on the map;
 * events at a place with no recorded bearing+distance are counted (unknownPlace) and drawn only in the unknown tray.
 */
export function eventMarks(events: SimEvent[], pos: Record<string, { known: boolean }>): EventMarks {
  const by = new Map<string, PlaceMark>(), noPlaceByCat: Partial<Record<EventCategory, number>> = {};
  let noPlace = 0, unknownPlace = 0;
  for (const e of events) {
    const p = eventPlace(e, pos), c = categoryOf(e);
    if (!p.place || !pos[p.place]) { noPlace++; noPlaceByCat[c] = (noPlaceByCat[c] ?? 0) + 1; continue; }
    if (!p.known) unknownPlace++;
    const m = by.get(p.place) ?? { place: p.place, total: 0, byCat: {} };
    m.total++; m.byCat[c] = (m.byCat[c] ?? 0) + 1; by.set(p.place, m);
  }
  return { marks: [...by.values()].sort((a, b) => (a.place < b.place ? -1 : 1)), noPlace, unknownPlace, noPlaceByCat };
}

export interface RouteLeg { from: string; to: string; t0: number | null; t1: number | null; recorded: boolean; length_cm: number | null; mm_s: number | null; segment_action: string; seg_start: number; seg_end: number }
/**
 * The recorded walk of one worker on one day, edge by edge: t0 = the previous recorded point (segment start or the
 * previous route_step arrival; null after an edge whose arrival was not recorded), t1 = the engine's route_step arrival minute at `to`, or null when the engine recorded
 * no arrival for that edge (the map then only interpolates the drawing; the time is NOT shown as recorded).
 * mm_s is DERIVED (recorded length / recorded time) and null whenever either is missing.
 */
export function recordedRoute(d: ExperimentDay, workerId: string, links: Link[]): RouteLeg[] {
  const legs: RouteLeg[] = [];
  for (const s of segmentsOf(d, workerId)) {
    const start = s.start as number, end = s.end as number, place = s.place as string;
    if (!place.includes('>')) continue;
    const route = place.split('>');
    const steps = d.events.filter((e) => e.type === 'route_step' && e.worker === workerId && (e.minute as number) > start - 1e-9 && (e.minute as number) <= end + 1e-9);
    let prev: number | null = start;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i], p0: number | null = prev;
      const st: SimEvent | undefined = p0 === null ? undefined : steps.find((e) => e.from === a && e.to === b && (e.minute as number) >= p0 - 1e-9);
      const t1: number | null = st ? (st.minute as number) : null, l = links.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
      const len = typeof l?.length_cm === 'number' ? l.length_cm : null, t0 = p0;
      legs.push({ from: a, to: b, t0, t1, recorded: t1 !== null && t0 !== null, length_cm: len, mm_s: len !== null && t1 !== null && t0 !== null && t1 > t0 ? (len * 10) / ((t1 - t0) * 60) : null, segment_action: s.action as string, seg_start: start, seg_end: end });
      prev = t1;
    }
  }
  return legs;
}
export interface RouteSummary { legs: number; recorded_legs: number; length_cm: number | null; walk_min: number | null }
/** Totals of the legs completed by minute t (DERIVED): length = sum of recorded edge lengths (null if any is missing);
 *  walking minutes = sum of recorded edge times (null if any arrival is missing). */
export function routeSummary(legs: RouteLeg[], t: number): RouteSummary {
  const done = legs.filter((l) => l.t1 !== null && l.t1 <= t + 1e-9);
  const len = done.every((l) => l.length_cm !== null) ? done.reduce((q, l) => q + (l.length_cm as number), 0) : null;
  const min = done.every((l) => l.recorded) ? done.reduce((q, l) => q + ((l.t1 as number) - (l.t0 as number)), 0) : null;
  return { legs: done.length, recorded_legs: done.filter((l) => l.recorded).length, length_cm: len, walk_min: min };
}

/** Brood / new-worker IDs an event names, for highlighting in the (non-spatial) nest roster. */
export function eventBroodIds(e: SimEvent): string[] {
  if (e.type === 'eclosion') return [e.source_brood_id, e.new_worker_id].filter((x): x is string => typeof x === 'string');
  if (['egg_laid', 'hatch', 'pupation', 'brood_death'].includes(e.type) && typeof e.id === 'string') return [e.id];
  if (e.type === 'larva_contact' && typeof e.larva === 'string') return [e.larva];
  return [];
}

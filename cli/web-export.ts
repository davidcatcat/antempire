/**
 * Read-only data export for the web viewer (web/). Writes ONLY web/data/*.json; never writes saves/, journal/,
 * reports/ or any engine input. The viewer only draws what is in these files.
 *
 *  1. official-day14.json — a snapshot of the OFFICIAL game at its last completed day, copied from
 *     saves/main.json + saves/world-state.json (read-only, with their sha256). The official Day1–14 history has no
 *     minute-level engine timeline, so this is a STATIC snapshot: per-worker status, last recorded site sequence and
 *     narrative activity, queen, brood, map locations and recorded route links.
 *  2. experiment-<id>.json — an EXPERIMENTAL Day0 world (not the official game) simulated by the current engine
 *     with a fixed scenario and seed. Per day: weather, the colony at the end of the day, every worker's activity
 *     segments (start/end minute, place, action) and the ecological / colony events the engine emitted. The viewer
 *     may interpolate positions between recorded segment endpoints for drawing only.
 *
 * Map layout: the world records each place by compass bearing + approximate distance from the nest entrance
 * ("敘事近似值非實測"). Display coordinates are derived from those two values only (layoutOf) and labelled as a
 * schematic; places without a recorded bearing/distance are listed as "位置未知", not given invented positions.
 *   node cli/web-export.ts            (writes web/data/)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { simulateWorldDay, resolveBundle, ENGINE_VERSION, type WorldState, type SimEvent } from '../engine/index.ts';
import { loadBundle, readJson, REPO_ROOT } from './lib/load.ts';
import { buildDay0, seasonStart, type FoundingId, type Season } from './lib/day0.ts';
import { rulesFingerprint } from './lib/fingerprint.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const WEB_DATA_DIR = 'web/data';
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, f))).digest('hex');

/** Compass words used in the world record -> degrees clockwise from north. */
const BEARING_DEG: Record<string, number> = { 北: 0, 東北: 45, 東: 90, 東南: 135, 南: 180, 西南: 225, 西: 270, 西北: 315 };
/** Schematic layout: x east, y north, in cm, from the recorded bearing word + approximate distance only. */
export function layoutOf(bearing: string | null | undefined, distanceCm: number | null | undefined): { x: number; y: number; basis: string } | null {
  if (bearing === '中心' || distanceCm === 0) return { x: 0, y: 0, basis: 'nest entrance = origin' };
  const deg = bearing ? BEARING_DEG[bearing.trim()] : undefined;
  if (deg === undefined || typeof distanceCm !== 'number') return null;
  const rad = (deg * Math.PI) / 180;
  return { x: Math.round(Math.sin(rad) * distanceCm * 100) / 100, y: Math.round(Math.cos(rad) * distanceCm * 100) / 100, basis: `bearing「${bearing}」+ 約 ${distanceCm} cm（敘事近似值，非測量）` };
}

function placesFromWorldRecord(world: Any): Any[] {
  return world.world_map.locations.map((l: Any) => ({ id: l.id, name: l.name ?? l.id, bearing: l.bearing ?? null, distance_cm: l.distance_cm ?? null, kind: l.resource_class ?? null, layout: layoutOf(l.bearing, l.distance_cm) }));
}

export function exportOfficial(root = REPO_ROOT): Any {
  const main = readJson('saves/main.json', root), world = readJson('saves/world-state.json', root);
  const col = main.colony, clock = world.time?.scientific_clock ?? {};
  const workers = col.workers.individuals.map((w: Any) => {
    const v = w.v2_latest ?? {};
    return { id: w.id, status: w.status, cause_of_death: w.cause ?? null, last_recorded_day: v.day ?? null, location_at_day_end: v.current_location_at_day_end ?? (w.status === 'alive' ? null : null), site_sequence: v.site_sequence ?? [], activity: v.activity ?? [], injured_preexisting: v.preexisting_injury_preserved ?? null, new_injury: v.new_injury ?? null };
  });
  return {
    schema: 'antempire.web.official-snapshot.v1', kind: 'official', read_only: true,
    note: '正式遊戲最後完成日的唯讀快照。Day1～14 的正式歷史沒有逐分鐘的引擎時間軸，所以這裡只顯示當日結束時的狀態與紀錄的活動敘述，不顯示動畫。',
    day: main.simulation?.latest_completed_day ?? clock.day ?? null, calendar_date: clock.calendar_date ?? null, elapsed_sim_hours: clock.elapsed_sim_hours ?? null,
    sources: { files: { 'saves/main.json': sha('saves/main.json'), 'saves/world-state.json': sha('saves/world-state.json') } },
    map: { origin: world.world_map.coordinate_origin, unit: world.world_map.distance_unit, precision: world.world_map.precision, places: placesFromWorldRecord(world), links: (world.world_map.route_edges ?? []).map((e: Any) => ({ from: e.from, to: e.to, approx_cm: e.legacy_approx_distance_cm ?? null, verified_cm: e.verified_route_length_cm ?? null, substrate: e.substrate ?? null })) },
    queen: { id: col.queen?.id ?? null, status: col.queen?.status ?? null, latest: col.queen?.v2_latest ?? null },
    workers,
    brood: (col.brood?.individuals ?? []).map((b: Any) => ({ id: b.id, stage: b.stage, living: b.living !== false, laid_on_sim_day: b.laid_on_sim_day ?? null })),
  };
}

const KEEP_EVENTS = new Set(['worker_activity', 'route_step', 'discovery', 'scouted_empty', 'exploration_step', 'exploration_found_nothing', 'food_collected', 'food_delivered', 'trophallaxis', 'local_recruitment', 'hunt_recruitment', 'live_prey_encounter', 'insect_predation', 'prey_escaped', 'joint_prey_transport', 'worker_death', 'brood_death', 'queen_death', 'egg_laid', 'hatch', 'pupation', 'eclosion', 'forager_stopped', 'action_cancelled_no_time', 'insect_natural_death', 'host_plant_death', 'hemipteran_colony_change']);
/** Copy an engine event, dropping only bulky fields the viewer does not draw. Nothing is added. */
function slimEvent(e: SimEvent): Any { const o: Any = { ...e }; delete o.assumption; delete o.hazards; delete o.sampling; return o; }

export interface ExperimentSpec { id: string; founding: FoundingId; season: Season; seed: number; days: number }
/** The first fixed seed of the Day0 evaluation; A1 is the Owner's base scenario, A5 the callow-founder control. Not chosen by outcome. */
export const EXPERIMENTS: ExperimentSpec[] = [
  { id: 'day0-A1-autumn-20270001', founding: 'A1', season: 'autumn', seed: 20270001, days: 30 },
  { id: 'day0-A5-autumn-20270001', founding: 'A5', season: 'autumn', seed: 20270001, days: 30 },
];
export const DEFAULT_EXPERIMENT = EXPERIMENTS[0];

export function exportExperiment(spec: ExperimentSpec = DEFAULT_EXPERIMENT): Any {
  const bundle = loadBundle(), rp = resolveBundle(bundle), init = buildDay0(spec.founding, spec.seed, seasonStart(spec.season), bundle);
  const world = readJson('saves/world-state.json'); // map bearings/distances only (read-only)
  const recorded = new Map(placesFromWorldRecord(world).map((p: Any) => [p.id, p]));
  const nodes = [...new Set(rp.world.routes.edges.flat())].sort();
  const places = nodes.map((id) => { const r = recorded.get(id) as Any; return { id, name: r?.name ?? id, bearing: r?.bearing ?? null, distance_cm: r?.distance_cm ?? null, kind: init.state.sources[id]?.type ?? (id === init.state.colonies[0].nest_node ? 'nest' : null), layout: r?.layout ?? null }; });
  const links = rp.world.routes.edges.map(([a, b]) => { const k = [a, b].sort().join(':'); return { from: a, to: b, length_cm: rp.world.routes.edge_length_cm[k] ?? null, legacy_minutes_if_unknown: rp.world.routes.edge_length_cm[k] === undefined ? rp.world.routes.route_edge_minutes : null }; });
  const snapshot = (s: WorldState) => {
    const c = s.colonies[0];
    return {
      queen_alive: c.population.queen_alive,
      workers: c.population.workers.map((w) => ({ id: w.id, age_days: w.age_days, age_origin: w.age_origin ?? null, injured: w.injured, injury_type: w.injury_type ?? null, task: w.task, crop_sugar: w.crop_cargo_sugar ?? 0, known_sources: [...w.known_sources], route_edges: Object.keys((w.route_memory as Any)?.edges ?? {}).sort(), location: w.last_location })),
      brood: c.population.brood.map((b) => ({ id: b.id, stage: b.stage, progress: b.progress })),
      stores: { sugar: c.stores.sugar, protein: c.stores.protein },
      trails: { ...c.trail_by_edge },
      sources: Object.fromEntries(Object.entries(s.sources).map(([id, x]) => [id, { type: x.type, sugar: x.sugar, protein: x.protein, host_alive: x.host_alive ?? null, hemipteran_colonies: x.hemipteran_colonies ?? null }])),
      insects: Object.fromEntries(Object.entries(s.ecology.insects_by_site).map(([id, x]) => [id, x.living])),
    };
  };
  let s = init.state;
  const day0 = { day: 0, date: s.calendar_date, state: snapshot(s) };
  const days: Any[] = [];
  for (let d = 1; d <= spec.days; d++) {
    const out = simulateWorldDay(s, bundle), c = out.result.colonies[0], sm = c.summary as Any;
    days.push({
      day: out.state.sim_day, date: out.state.calendar_date,
      weather: { air_temp_c: out.result.weather.air_temp_c, nest_temp_c: (out.result.weather as Any).nest_temp_model_c, rain_mm: out.result.weather.rain_mm, wet: (out.result.weather as Any).wet },
      window_minutes: sm.activity?.window_minutes ?? null,
      tasks: sm.activity ? Object.fromEntries(Object.entries(sm.activity.workers as Record<string, Any>).map(([id, w]) => [id, { task: w.task, trips: w.trips, successes: w.successes, stop_reason: w.stop_reason }])) : null,
      income: sm.income, consumed: sm.consumed, eggs_laid: sm.eggs_laid, eclosions: sm.eclosions, worker_deaths: sm.worker_deaths,
      events: [...out.result.world_events, ...c.events].filter((e) => KEEP_EVENTS.has(e.type)).map(slimEvent),
      end_state: snapshot(out.state),
    });
    s = out.state;
    if (!s.colonies[0].population.queen_alive && !s.colonies[0].population.workers.length) break;
  }
  const fp = rulesFingerprint();
  return {
    schema: 'antempire.web.experiment-replay.v1', kind: 'experiment', official: false,
    note: '實驗世界（Day0 科學初始化），不是正式遊戲，也不會寫入正式存檔。所有個體、行動與事件都由目前的模擬引擎產生；畫面上兩個記錄點之間的移動是顯示用插值。',
    spec, engine_version: ENGINE_VERSION, rules_fingerprint: { engine: fp.engine, params: fp.params },
    map: { unit: 'cm', layout_basis: '方位文字＋約距離（世界設定的敘事近似值），非測量；沒有記錄的地點列為位置未知', places, links },
    day0, days,
  };
}

if (import.meta.main) {
  const dir = path.join(REPO_ROOT, WEB_DATA_DIR); fs.mkdirSync(dir, { recursive: true });
  const off = exportOfficial();
  fs.writeFileSync(path.join(dir, 'official-day14.json'), JSON.stringify(off) + '\n');
  const list: Any[] = [];
  for (const spec of EXPERIMENTS) {
    const exp = exportExperiment(spec);
    fs.writeFileSync(path.join(dir, `experiment-${spec.id}.json`), JSON.stringify(exp) + '\n');
    list.push({ id: spec.id, file: `experiment-${spec.id}.json`, title: `實驗世界：Day0 ${spec.founding} 秋季 種子 ${spec.seed}（${exp.days.length} 日）`, founding: spec.founding, season: spec.season, seed: spec.seed });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: 'antempire.web.index.v1', official: 'official-day14.json', experiments: list }) + '\n');
  for (const f of fs.readdirSync(dir)) console.log(f, (fs.statSync(path.join(dir, f)).size / 1024).toFixed(0) + ' KB');
}

/**
 * Read-only data export for the web viewer (web/). Writes ONLY web/data/*.json; never writes saves/, journal/,
 * reports/ or any engine input. The viewer only draws what is in these files.
 *
 *  experiment-<id>.json — an EXPERIMENTAL Day0 world (not an official game) simulated by the current engine
 *  with a fixed scenario and seed. Per day: weather, the colony at the end of the day, every worker's activity
 *  segments (start/end minute, place, action) and the ecological / colony events the engine emitted. The viewer
 *  may interpolate positions between recorded segment endpoints for drawing only.
 *
 * There is NO official world today: the legacy Day14 game saves were retired by the Owner on 2026-11-12 (#194),
 * so the former official-day14.json snapshot is no longer exported. index.json says so (official: null) until a new
 * official Day0 world passes its integration gate (R2).
 *
 * Map layout: the garden scenario records each place by compass bearing + approximate distance from the nest
 * entrance ("敘事近似值非實測"; data/xitun-garden-geography.json). Display coordinates are derived from those two
 * values only (layoutOf) and labelled as a schematic; places without a recorded bearing/distance are listed as
 * "位置未知", not given invented positions.
 *   node cli/web-export.ts            (writes web/data/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulateWorldDay, resolveBundle, ENGINE_VERSION, type WorldState, type SimEvent } from '../engine/index.ts';
import { loadBundle, readJson, REPO_ROOT } from './lib/load.ts';
import { buildDay0, seasonStart, type FoundingId, type Season } from './lib/day0.ts';
import { rulesFingerprint } from './lib/fingerprint.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const WEB_DATA_DIR = 'web/data';

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

/** Garden scenario geography (place names, bearing words, approximate distances); read-only, no colony data. */
export const GEOGRAPHY_FILE = 'data/xitun-garden-geography.json';
function placesFromGeography(geo: Any): Any[] {
  return geo.locations.map((l: Any) => ({ id: l.id, name: l.name ?? l.id, bearing: l.bearing ?? null, distance_cm: l.distance_cm ?? null, layout: layoutOf(l.bearing, l.distance_cm) }));
}

const KEEP_EVENTS = new Set(['worker_activity', 'route_step', 'discovery', 'scouted_empty', 'exploration_step', 'exploration_found_nothing', 'food_collected', 'food_delivered', 'trophallaxis', 'local_recruitment', 'hunt_recruitment', 'live_prey_encounter', 'insect_predation', 'prey_escaped', 'joint_prey_transport', 'worker_death', 'brood_death', 'queen_death', 'egg_laid', 'hatch', 'pupation', 'eclosion', 'forager_stopped', 'action_cancelled_no_time', 'insect_natural_death', 'host_plant_death', 'hemipteran_colony_change']);
/** Copy an engine event, dropping only bulky fields the viewer does not draw. Nothing is added. */
function slimEvent(e: SimEvent): Any { const o: Any = { ...e }; delete o.assumption; delete o.hazards; delete o.sampling; return o; }

export interface ExperimentSpec { id: string; founding: FoundingId; season: Season; seed: number; days: number }
/** The first fixed seed of the Day0 evaluation; A1 is the Owner's base scenario, A5 the callow-founder control. Not chosen by outcome. */
export const EXPERIMENTS: ExperimentSpec[] = [
  { id: 'day0-A1-autumn-20270001', founding: 'A1', season: 'autumn', seed: 20270001, days: 30 },
  { id: 'day0-A5-autumn-20270001', founding: 'A5', season: 'autumn', seed: 20270001, days: 30 },
  // A4 (queen + carried pupae): the carried pupae eclose within the first days, so this replay covers eclosions
  { id: 'day0-A4-autumn-20270001', founding: 'A4', season: 'autumn', seed: 20270001, days: 30 },
];
export const DEFAULT_EXPERIMENT = EXPERIMENTS[0];
/** Shown by the viewer: there is no official world (#194). */
export const OFFICIAL_NOTE = '目前沒有正式世界：舊版 Day14 存檔已依 Owner 裁示退役（#194）；新版 Day0 通過正式化門檻前，所有世界都是非正式實驗。';

export function exportExperiment(spec: ExperimentSpec = DEFAULT_EXPERIMENT): Any {
  const bundle = loadBundle(), rp = resolveBundle(bundle), init = buildDay0(spec.founding, spec.seed, seasonStart(spec.season), bundle);
  // Garden GEOGRAPHY only (place names, bearing words, approximate distances), read-only from the scenario geography
  // file. It was copied verbatim from the retired legacy Day14 world record (#194); NO colony, individual, store or
  // event data of that record enters an experiment file (tests/web.test.ts checks this).
  const recorded = new Map(placesFromGeography(readJson(GEOGRAPHY_FILE)).map((p: Any) => [p.id, p]));
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
    map: { unit: 'cm', layout_basis: '方位文字＋約距離（世界設定的敘事近似值），非測量；沒有記錄的地點列為位置未知', geography_source: 'data/xitun-garden-geography.json#locations（只讀花園情境地理：名稱、方位、約距離；逐字取自已退役舊版 Day14 的 world_map.locations，不含其蟻群、個體、存糧或事件）', places, links },
    day0, days,
  };
}

if (import.meta.main) {
  const dir = path.join(REPO_ROOT, WEB_DATA_DIR); fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, 'official-day14.json'), { force: true }); // retired with the legacy Day14 saves (#194)
  const list: Any[] = [];
  for (const spec of EXPERIMENTS) {
    const exp = exportExperiment(spec);
    fs.writeFileSync(path.join(dir, `experiment-${spec.id}.json`), JSON.stringify(exp) + '\n');
    list.push({ id: spec.id, file: `experiment-${spec.id}.json`, title: `實驗世界：Day0 ${spec.founding} 秋季 種子 ${spec.seed}（${exp.days.length} 日）`, founding: spec.founding, season: spec.season, seed: spec.seed });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: 'antempire.web.index.v2', official: null, official_note: OFFICIAL_NOTE, experiments: list }) + '\n');
  for (const f of fs.readdirSync(dir)) console.log(f, (fs.statSync(path.join(dir, f)).size / 1024).toFixed(0) + ' KB');
}

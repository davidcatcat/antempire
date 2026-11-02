/**
 * Day0 extreme scenarios (Owner 6.4; corrected in v2-review.19) — to find the limits of the model, NOT to make
 * colonies survive. Each scenario edits a Day0 world or a parameter copy ONLY inside this diagnostic run (never
 * the official files), runs the 20 fixed seeds × 60 days from an autumn Day0 (founding A1 unless stated).
 *
 * v2-review.19 corrections (the v18 results stay in reports/day0-v18/extremes.*):
 *  - E2 "far food" now really moves the food: the recorded path lengths are multiplied (×5, ×20, ×100) at the
 *    species walking speed. The v18 E2 only replaced the recorded lengths by the 25-minute legacy edges (time,
 *    not distance); it is re-run here as E2-v18 and labelled as the defective design.
 *  - E5 "continuous rain" now forces a block of consecutive wet days through the WORLD climate parameters that
 *    the weather generator actually reads (annual_rain_days, rain_probability_daily_cap, wet_persistence), and
 *    verifies the realised rain days, longest wet spell, rainfall, soil wetness and the colony's activity on wet
 *    vs dry days. The v18 E5 changed a field the generator never reads; it is re-run as E5-v18 (defective).
 *  - Every scenario reports queen survival, worker survival, "own-worker eclosion within the horizon" (renamed from "effective reproduction"; eclosions from eggs laid in
 *    the run) and growth/decline separately.
 *   node cli/reports/day0-extremes.ts [outFile]     (default reports/day0-<tag>/extremes.json + .md)
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulateWorldDay, initializeDay0, resolveBundle, type ParamBundle, type WorldState } from '../../engine/index.ts';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { buildDay0, seasonStart, day0Inputs } from '../lib/day0.ts';
import { DAY0_SEEDS } from './day0-evaluation.ts';
import { RULES_TAG } from './winter-multiseed.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SP = 'pheidole-megacephala', DAYS = 60, START = seasonStart('autumn');
const r3 = (x: number) => +x.toFixed(3);
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return r3(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const mean = (xs: number[]) => (xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const knowF01 = (s: WorldState) => { for (const w of s.colonies[0].population.workers) { w.known_sources = ['F01']; (w as Any).route_memory = { origin: 'extreme scenario: told the route', edges: { 'F01:N00': { acquired: 'walked', first_day: 0, last_day: 0 } }, empty_sites: {} }; } };
const scaleLengths = (k: number) => (b: ParamBundle) => { const el = (b.world as Any).routes.edge_length_cm; for (const v of Object.values(el)) if (v && typeof v === 'object' && 'value' in (v as Any)) (v as Any).value *= k; };
/** World climate settings that make EVERY day wet (the generator's own parameters, see engine/weather.ts). */
const alwaysWet = (b: ParamBundle) => { const c = (b.world as Any).climate; c.annual_rain_days.value = 365; c.rain_probability_daily_cap.value = 1; c.wet_persistence.value = 0; };
const RAIN_BLOCK = { from: 10, to: 23 }; // 14 consecutive days

interface Scenario {
  id: string; title: string; founding?: string; defective?: string;
  bundle?: (b: ParamBundle) => void;
  /** a second parameter set used only on the listed days (e.g. a rain block) */
  dayBundle?: { edit: (b: ParamBundle) => void; from: number; to: number };
  init?: (s: WorldState) => void; daily?: (s: WorldState, day: number, ctx: { origRain: number[] }) => void; foundingEdit?: (f: Any) => void; notImplemented?: string;
}
const heavyRainDaily = (s: WorldState, d: number, ctx: { origRain: number[] }) => {
  // heavy-rain block: the generator draws wet-day rain from the monthly climatology; during the block the
  // monthly totals are set to 600 mm (≈ 20 mm per wet day on average); restored after the block. The original
  // values are kept outside the world state (the engine rejects unknown state keys: NO_GOD_MODE).
  if (d >= RAIN_BLOCK.from && d <= RAIN_BLOCK.to) for (const m of s.climate.monthly) m.mean_monthly_precipitation_mm = 600;
  if (d === RAIN_BLOCK.to + 1) s.climate.monthly.forEach((m, i) => { m.mean_monthly_precipitation_mm = ctx.origRain[i]; });
};
const SCENARIOS: Scenario[] = [
  { id: 'E0', title: '基準（A1，秋，無修改）' },
  { id: 'E1', title: '巢口附近充足食物：F01 蜜露存量與上限 50 份，全部工蟻一開始就知道 N00–F01', init: (s) => { const f = s.sources.F01; f.capacity = 50; f.sugar = 50; knowF01(s); }, daily: (s) => { s.sources.F01.capacity = 50; } },
  { id: 'E2-v18', title: '【v18 原設計，有缺陷】把已記錄的路段長度刪除（變回每段 25 分鐘）：只改時間、沒有改距離', defective: '只改變步行時間，沒有改變路徑距離', bundle: (b) => { delete (b.world as Any).routes.edge_length_cm; } },
  { id: 'E2a', title: '遠距離食物：已記錄的路徑長度 ×5（主巢到 F01／F07／F08／F11 為 2.4／1.6／4.2／1.8 m）', bundle: scaleLengths(5) },
  { id: 'E2b', title: '遠距離食物：已記錄的路徑長度 ×20（9.6／6.2／16.6／7.0 m）', bundle: scaleLengths(20) },
  { id: 'E2c', title: '遠距離食物：已記錄的路徑長度 ×100（48／31／83／35 m）', bundle: scaleLengths(100) },
  { id: 'E3', title: '食源突然枯竭：第 20 日起所有蜜露寄主死亡、花蜜與屍體歸零', daily: (s, d) => { if (d >= 20) for (const src of Object.values(s.sources)) { src.sugar = 0; if (src.type === 'carcass') { src.protein = 0; src.batches = []; } if (src.type === 'honeydew') { src.host_alive = false; src.hemipteran_colonies = 0; } if (src.type === 'nectar') src.bloom_days_left = 0; } } },
  { id: 'E4', title: '費洛蒙消失：路徑訊號每日保留 0（招募與沿跡都無法使用）', bundle: (b) => { (b.species[SP] as Any).recruitment.trail_daily_retention.value = 0; }, daily: (s) => { s.colonies[0].trail_by_edge = {}; } },
  { id: 'E5-v18', title: '【v18 原設計，有缺陷】月雨量 ×10、改存檔中不會被讀取的 rain_days_per_year：雨日數不變，只有雨量變大', defective: '雨日頻率由 world climate.annual_rain_days 決定；改的是不被讀取的欄位', init: (s) => { for (const m of s.climate.monthly) m.mean_monthly_precipitation_mm *= 10; s.climate.rain_days_per_year = Math.min(365, (s.climate.rain_days_per_year ?? 100) * 3); } },
  { id: 'E5a', title: '連續 14 日降雨（第 10～23 日每天下雨；引擎把月平均雨量平均分到每個雨日，總量期望不變，所以是連續小雨）', dayBundle: { edit: alwaysWet, ...RAIN_BLOCK } },
  { id: 'E5b', title: '連續 14 日強降雨（第 10～23 日每天下雨，月雨量設為 600 mm，平均約 20 mm／雨日）', dayBundle: { edit: alwaysWet, ...RAIN_BLOCK }, daily: heavyRainDaily },
  { id: 'E5c', title: '連續 30 日降雨（第 10～39 日；同上，連續小雨）', dayBundle: { edit: alwaysWet, from: 10, to: 39 } },
  { id: 'E6', title: '工蟻嗉囊全部滿載（A3）', founding: 'A3' },
  { id: 'E7', title: '只有一隻能覓食的工蟻（蟻后＋1 工蟻）', foundingEdit: (f) => { f.workers.value = 1; } },
  { id: 'E8', title: '多隻工蟻同時前往一個食源：10 隻都知道 F01 並且全部覓食', init: knowF01, bundle: (b) => { (b.species[SP] as Any).task_allocation.forage_baseline_probability.value = 1000; } },
  { id: 'E9', title: '母巢通路中斷', notImplemented: '母巢連結尚未實作（docs/research-design-2026-11.md §1）；無法測試，不偽造結果' },
  { id: 'E10', title: '蟻后存活但沒有工蟻（單獨蟻后，無幼體）', foundingEdit: (f) => { f.workers.value = 0; } },
];

function longestRun(flags: boolean[]): number { let best = 0, cur = 0; for (const f of flags) { cur = f ? cur + 1 : 0; best = Math.max(best, cur); } return best; }

function run(sc: Scenario): Any {
  if (sc.notImplemented) return { id: sc.id, title: sc.title, not_implemented: sc.notImplemented };
  const b = loadBundle(); sc.bundle?.(b);
  const bBlock = sc.dayBundle ? (() => { const x = structuredClone(b); sc.dayBundle.edit(x); return x; })() : null;
  const rp = resolveBundle(b), lengths = rp.world.routes.edge_length_cm, speed = rp.species[SP].activity.trail_walking_speed_mm_s;
  const rows: Any[] = [];
  for (const seed of DAY0_SEEDS) {
    const inp = day0Inputs((sc.founding ?? 'A1') as Any); sc.foundingEdit?.(inp.founding);
    let s = sc.foundingEdit ? initializeDay0({ ...inp, seed, start_date: START }, b).state : buildDay0((sc.founding ?? 'A1') as Any, seed, START, b).state;
    sc.init?.(s);
    const ctx = { origRain: s.climate.monthly.map((m) => m.mean_monthly_precipitation_mm) };
    const pop0 = s.colonies[0].population, n0 = pop0.workers.length + pop0.brood.filter((x) => x.stage === 'pupa').length, initialBrood = new Set(pop0.brood.map((x) => x.id));
    const days: Any[] = [];
    let queenDeath: Any = null, end: number | null = null, ownEclosions = 0, eggs = 0, travel = 0, trips = 0;
    for (let d = 1; d <= DAYS; d++) {
      sc.daily?.(s, d, ctx);
      const bd = bBlock && d >= (sc.dayBundle as Any).from && d <= (sc.dayBundle as Any).to ? bBlock : b;
      const o = simulateWorldDay(s, bd), c = o.result.colonies[0], sm = c.summary as Any, w = o.result.weather as Any;
      const active = sm.activity ? (Object.values(sm.activity.workers) as Any[]).filter((x) => x.trips > 0).length : 0;
      days.push({ day: d, wet: w.wet, rain_mm: w.rain_mm, soil: w.soil_index, workers: sm.workers_before, forage_task: sm.tasks.forage, active_foragers: active, trips: sm.foraging_trips, income: r3(sm.income.sugar + sm.income.protein) });
      travel += sm.activity?.travel_minutes ?? 0; trips += sm.foraging_trips;
      for (const e of c.events as Any[]) { if (e.type === 'eclosion' && !initialBrood.has(e.source_brood_id)) ownEclosions++; if (e.type === 'egg_laid') eggs++; if (e.type === 'queen_death') queenDeath = { day: d, reason: e.reason, triggers: e.active_triggers }; }
      s = o.state;
      if (!s.colonies[0].population.queen_alive && !s.colonies[0].population.workers.length) { end = d; break; }
    }
    const pop = s.colonies[0].population, wk = pop.workers.length;
    const wet = days.filter((x) => x.wet), dry = days.filter((x) => !x.wet);
    const perWorker = (xs: Any[], k: string) => mean(xs.filter((x) => x.workers > 0).map((x) => x[k] / x.workers));
    rows.push({
      seed, queen_alive: pop.queen_alive, workers: wk, brood: pop.brood.length, colony_end_day: end, queen_death: queenDeath,
      eggs_laid: eggs, own_eclosions: ownEclosions, reference_adults_day0: n0,
      growth: !pop.queen_alive && !wk ? 'extinct' : !wk ? 'no_workers_queen_alive' : wk > n0 ? 'grew' : wk === n0 ? 'held' : 'declined',
      weather: { rain_days: wet.length, longest_wet_spell: longestRun(days.map((x) => x.wet)), rain_mm: r3(days.reduce((a, x) => a + x.rain_mm, 0)), mean_soil_wet_days: mean(wet.map((x) => x.soil)), mean_soil_dry_days: mean(dry.map((x) => x.soil)) },
      activity_wet_vs_dry: { forage_task_share_wet: perWorker(wet, 'forage_task'), forage_task_share_dry: perWorker(dry, 'forage_task'), trips_per_worker_wet: perWorker(wet, 'trips'), trips_per_worker_dry: perWorker(dry, 'trips'), income_per_worker_wet: perWorker(wet, 'income'), income_per_worker_dry: perWorker(dry, 'income') },
      mean_travel_minutes_per_trip: trips ? r3(travel / trips) : null,
      days,
    });
  }
  const R = rows;
  const pathCm = Object.fromEntries(Object.entries(lengths).map(([k, v]) => [k, r3(v * rp.world.routes.path_tortuosity)]));
  return {
    id: sc.id, title: sc.title, ...(sc.defective ? { defective_design: sc.defective } : {}), seeds: R.length,
    recorded_path_lengths_cm: pathCm, one_way_minutes_on_trail: Object.fromEntries(Object.entries(pathCm).map(([k, v]) => [k, r3((v as number) * 10 / speed / 60)])),
    queen_alive_day60: R.filter((r) => r.queen_alive).length,
    colonies_with_workers_day60: R.filter((r) => r.workers > 0).length,
    any_own_worker_eclosion: R.filter((r) => r.own_eclosions > 0).length,
    growth_classes: R.reduce((o: Any, r) => { o[r.growth] = (o[r.growth] ?? 0) + 1; return o; }, {}),
    colony_end: R.filter((r) => r.colony_end_day !== null).length,
    workers_day60_median: med(R.map((r) => r.workers)), own_eclosions_median: med(R.map((r) => r.own_eclosions)), eggs_laid_median: med(R.map((r) => r.eggs_laid)),
    queen_death_day_median: med(R.filter((r) => r.queen_death).map((r) => r.queen_death.day)), queen_death_reasons: R.filter((r) => r.queen_death).reduce((o: Any, r) => { o[r.queen_death.reason] = (o[r.queen_death.reason] ?? 0) + 1; return o; }, {}),
    mean_travel_minutes_per_trip_median: med(R.map((r) => r.mean_travel_minutes_per_trip).filter((x) => x !== null)),
    weather: { rain_days_median: med(R.map((r) => r.weather.rain_days)), longest_wet_spell_median: med(R.map((r) => r.weather.longest_wet_spell)), longest_wet_spell_min: Math.min(...R.map((r) => r.weather.longest_wet_spell)), rain_mm_median: med(R.map((r) => r.weather.rain_mm)), soil_wet_days_median: med(R.map((r) => r.weather.mean_soil_wet_days).filter((x) => x !== null)), soil_dry_days_median: med(R.map((r) => r.weather.mean_soil_dry_days).filter((x) => x !== null)) },
    activity_wet_vs_dry_median: Object.fromEntries(['forage_task_share_wet', 'forage_task_share_dry', 'trips_per_worker_wet', 'trips_per_worker_dry', 'income_per_worker_wet', 'income_per_worker_dry'].map((k) => [k, med(R.map((r) => r.activity_wet_vs_dry[k]).filter((x) => x !== null))])),
    rows: R,
  };
}

if (import.meta.main) {
  const dir = path.join(REPO_ROOT, `reports/day0-${RULES_TAG}`); fs.mkdirSync(dir, { recursive: true });
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dir, 'extremes.json');
  const results = SCENARIOS.map((sc) => { const r = run(sc); console.error(sc.id, r.queen_alive_day60 ?? r.not_implemented); return r; });
  fs.writeFileSync(out, JSON.stringify({ schema: 'antempire.day0-extremes.v2', diagnostic_not_target: true, rules_tag: RULES_TAG, start: START, days: DAYS, seeds: DAY0_SEEDS, note: 'all 20 seeds kept for every scenario; per-day rows in rows[].days', results }, null, 1) + '\n');
  const L = [`# Day0 極端情境 ${RULES_TAG}（診斷，不是目標；秋季 Day0、20 種子 × ${DAYS} 日；四項存活指標分開）`, '',
    '| 情境 | 說明 | Day60 蟻后存活 | Day60 有工蟻 | 60 日內曾有自產工蟻羽化 | 成長／持平／衰退／只剩蟻后／全滅 | Day60 工蟻中位 | 自產羽化中位 | 每趟平均步行分鐘中位 | 蟻后死亡日中位（原因） |', '|---|---|---:|---:|---:|---|---:|---:|---:|---|'];
  for (const r of results) {
    if (r.not_implemented) { L.push(`| ${r.id} | ${r.title} | — | — | — | — | — | — | — | 未實作：${r.not_implemented} |`); continue; }
    const g = r.growth_classes;
    L.push(`| ${r.id} | ${r.title} | ${r.queen_alive_day60}/20 | ${r.colonies_with_workers_day60}/20 | ${r.any_own_worker_eclosion}/20 | ${g.grew ?? 0}／${g.held ?? 0}／${g.declined ?? 0}／${g.no_workers_queen_alive ?? 0}／${g.extinct ?? 0} | ${r.workers_day60_median} | ${r.own_eclosions_median} | ${r.mean_travel_minutes_per_trip_median ?? '—'} | ${r.queen_death_day_median ?? '—'}（${Object.entries(r.queen_death_reasons).map(([k, v]) => k + ' ' + v).join('、') || '—'}） |`);
  }
  L.push('', '## 降雨情境的實際天氣與活動（20 種子中位數）', '', '| 情境 | 雨日數（60 日） | 最長連續雨日（中位／最少） | 總雨量 mm | 土壤濕度（雨日／晴日） | 覓食任務比例（雨日／晴日） | 每隻工蟻每日趟數（雨日／晴日） | 每隻工蟻每日收入（雨日／晴日） |', '|---|---:|---|---:|---|---|---|---|');
  for (const r of results.filter((x) => !x.not_implemented && (x.id.startsWith('E5') || x.id === 'E0'))) { const w = r.weather, a = r.activity_wet_vs_dry_median; L.push(`| ${r.id} | ${w.rain_days_median} | ${w.longest_wet_spell_median}／${w.longest_wet_spell_min} | ${w.rain_mm_median} | ${w.soil_wet_days_median}／${w.soil_dry_days_median} | ${a.forage_task_share_wet}／${a.forage_task_share_dry} | ${a.trips_per_worker_wet}／${a.trips_per_worker_dry} | ${a.income_per_worker_wet}／${a.income_per_worker_dry} |`); }
  L.push('', '## 遠距離情境的實際路徑（已記錄長度的路段；其餘路段長度未知，仍為每段 25 分鐘）', '', '| 情境 | 主巢—F01／F07／F08／F11 路徑長度 cm | 沿跡單程分鐘 | 每趟平均步行分鐘中位 |', '|---|---|---|---:|');
  for (const r of results.filter((x) => !x.not_implemented && (x.id.startsWith('E2') || x.id === 'E0'))) L.push(`| ${r.id} | ${['F01:N00', 'F07:N00', 'F08:N00', 'F11:N00'].map((k) => r.recorded_path_lengths_cm[k] ?? '未知').join('／')} | ${['F01:N00', 'F07:N00', 'F08:N00', 'F11:N00'].map((k) => r.one_way_minutes_on_trail[k] ?? '25（舊規則）').join('／')} | ${r.mean_travel_minutes_per_trip_median ?? '—'} |`);
  fs.writeFileSync(out.replace(/\.json$/, '.md'), L.join('\n') + '\n');
  console.log(out);
}

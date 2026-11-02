/**
 * Day0 extreme scenarios (Owner 6.4) — to find the limits of the model, NOT to make colonies survive.
 * Each scenario edits a Day0 world or a parameter copy ONLY inside this diagnostic run (never the official
 * files), runs 20 fixed seeds × 60 days from an autumn Day0 (founding A1 unless stated), and records outcomes.
 *   node cli/reports/day0-extremes.ts [outFile]     (default reports/day0-<tag>/extremes.json + .md)
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulateWorldDay, type ParamBundle, type WorldState } from '../../engine/index.ts';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { buildDay0, seasonStart, day0Inputs } from '../lib/day0.ts';
import { initializeDay0 } from '../../engine/index.ts';
import { DAY0_SEEDS } from './day0-evaluation.ts';
import { RULES_TAG } from './winter-multiseed.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SP = 'pheidole-megacephala', DAYS = 60, START = seasonStart('autumn');
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(3); };
const knowF01 = (s: WorldState) => { for (const w of s.colonies[0].population.workers) { w.known_sources = ['F01']; (w as Any).route_memory = { origin: 'extreme scenario: told the route', edges: { 'F01:N00': { acquired: 'walked', first_day: 0, last_day: 0 } }, empty_sites: {} }; } };

interface Scenario { id: string; title: string; founding?: string; bundle?: (b: ParamBundle) => void; init?: (s: WorldState) => void; daily?: (s: WorldState, day: number) => void; foundingEdit?: (f: Any) => void; notImplemented?: string }
const SCENARIOS: Scenario[] = [
  { id: 'E0', title: '基準（A1，秋，無修改）' },
  { id: 'E1', title: '巢口附近充足食物：F01 蜜露存量與上限 50 份，全部工蟻一開始就知道 N00–F01', init: (s) => { const f = s.sources.F01; f.capacity = 50; f.sugar = 50; knowF01(s); }, daily: (s) => { const f = s.sources.F01; f.capacity = 50; } },
  { id: 'E2', title: '食物全部在遠方：所有路段長度改為未知（每段 25 分鐘）', bundle: (b) => { delete (b.world as Any).routes.edge_length_cm; } },
  { id: 'E3', title: '食源突然枯竭：第 20 日起所有蜜露寄主死亡、花蜜與屍體歸零', daily: (s, d) => { if (d >= 20) for (const src of Object.values(s.sources)) { src.sugar = 0; if (src.type === 'carcass') { src.protein = 0; src.batches = []; } if (src.type === 'honeydew') { src.host_alive = false; src.hemipteran_colonies = 0; } if (src.type === 'nectar') src.bloom_days_left = 0; } } },
  { id: 'E4', title: '費洛蒙消失：路徑訊號每日保留 0（招募與沿跡都無法使用）', bundle: (b) => { (b.species[SP] as Any).recruitment.trail_daily_retention.value = 0; }, daily: (s) => { s.colonies[0].trail_by_edge = {}; } },
  { id: 'E5', title: '連續降雨：月雨量 ×10、雨日數 ×3（氣候先驗，只在此診斷）', init: (s) => { for (const m of s.climate.monthly) m.mean_monthly_precipitation_mm *= 10; s.climate.rain_days_per_year = Math.min(365, (s.climate.rain_days_per_year ?? 100) * 3); } },
  { id: 'E6', title: '工蟻嗉囊全部滿載（A3）', founding: 'A3' },
  { id: 'E7', title: '只有一隻能覓食的工蟻（蟻后＋1 工蟻）', foundingEdit: (f) => { f.workers.value = 1; } },
  { id: 'E8', title: '多隻工蟻同時前往一個食源：10 隻都知道 F01 並且全部覓食', init: knowF01, bundle: (b) => { (b.species[SP] as Any).task_allocation.forage_baseline_probability.value = 1000; } },
  { id: 'E9', title: '母巢通路中斷', notImplemented: '母巢連結尚未實作（docs/research-design-2026-11.md §1）；無法測試，不偽造結果' },
  { id: 'E10', title: '蟻后存活但沒有工蟻（單獨蟻后，無幼體）', foundingEdit: (f) => { f.workers.value = 0; } },
];

function run(sc: Scenario): Any {
  if (sc.notImplemented) return { id: sc.id, title: sc.title, not_implemented: sc.notImplemented };
  const b = loadBundle(); sc.bundle?.(b);
  const rows: Any[] = [];
  for (const seed of DAY0_SEEDS) {
    const inp = day0Inputs((sc.founding ?? 'A1') as Any); sc.foundingEdit?.(inp.founding);
    let s = sc.foundingEdit ? initializeDay0({ ...inp, seed, start_date: START }, b).state : buildDay0((sc.founding ?? 'A1') as Any, seed, START, b).state;
    sc.init?.(s);
    let trips = 0, active = 0, sugar = 0, protein = 0, queenDeath: Any = null, end: number | null = null, maxTrips = 0, cancelled = 0;
    for (let d = 1; d <= DAYS; d++) {
      sc.daily?.(s, d);
      const o = simulateWorldDay(s, b), sm = o.result.colonies[0].summary as Any;
      sugar += sm.income.sugar; protein += sm.income.protein;
      if (sm.activity) { for (const w of Object.values(sm.activity.workers) as Any[]) if (w.trips) { trips += w.trips; active++; maxTrips = Math.max(maxTrips, w.trips); } cancelled += sm.activity.cancelled_no_time; }
      const qd = (o.result.colonies[0].events as Any[]).find((e) => e.type === 'queen_death'); if (qd) queenDeath = { day: d, reason: qd.reason, triggers: qd.active_triggers };
      s = o.state;
      if (!s.colonies[0].population.queen_alive && !s.colonies[0].population.workers.length) { end = d; break; }
    }
    const pop = s.colonies[0].population;
    rows.push({ seed, queen_alive: pop.queen_alive, workers: pop.workers.length, brood: pop.brood.length, colony_end_day: end, queen_death: queenDeath, sugar: +sugar.toFixed(2), protein: +protein.toFixed(2), trips_per_active_forager_day: active ? +(trips / active).toFixed(2) : null, max_trips_one_worker_day: maxTrips, cancelled_no_time: cancelled });
  }
  return {
    id: sc.id, title: sc.title, seeds: rows.length,
    queen_alive_day60: rows.filter((r) => r.queen_alive).length, colony_end: rows.filter((r) => r.colony_end_day !== null).length,
    workers_day60_median: med(rows.map((r) => r.workers)), sugar_income_median: med(rows.map((r) => r.sugar)), protein_income_median: med(rows.map((r) => r.protein)),
    trips_per_active_forager_day_median: med(rows.map((r) => r.trips_per_active_forager_day).filter((x) => x !== null)), max_trips_one_worker_day: Math.max(...rows.map((r) => r.max_trips_one_worker_day)),
    queen_death_day_median: med(rows.filter((r) => r.queen_death).map((r) => r.queen_death.day)), queen_death_reasons: rows.filter((r) => r.queen_death).reduce((o: Any, r) => { o[r.queen_death.reason] = (o[r.queen_death.reason] ?? 0) + 1; return o; }, {}),
    rows,
  };
}

if (import.meta.main) {
  const dir = path.join(REPO_ROOT, `reports/day0-${RULES_TAG}`); fs.mkdirSync(dir, { recursive: true });
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dir, 'extremes.json');
  const results = SCENARIOS.map((sc) => { const r = run(sc); console.error(sc.id, r.queen_alive_day60 ?? r.not_implemented); return r; });
  fs.writeFileSync(out, JSON.stringify({ schema: 'antempire.day0-extremes.v1', diagnostic_not_target: true, rules_tag: RULES_TAG, start: START, days: DAYS, seeds: DAY0_SEEDS, results }, null, 1) + '\n');
  const L = [`# Day0 極端情境 ${RULES_TAG}（診斷，不是目標；秋季 Day0、20 種子 × ${DAYS} 日）`, '', '| 情境 | 說明 | Day60 蟻后存活 | 全滅 | Day60 工蟻中位 | 糖／蛋白收入中位 | 每隻出巢工蟻每日趟數中位 | 單隻單日最多趟 | 蟻后死亡日中位（原因） |', '|---|---|---:|---:|---:|---|---:|---:|---|'];
  for (const r of results) L.push(r.not_implemented ? `| ${r.id} | ${r.title} | — | — | — | — | — | — | 未實作：${r.not_implemented} |` : `| ${r.id} | ${r.title} | ${r.queen_alive_day60}/20 | ${r.colony_end}/20 | ${r.workers_day60_median} | ${r.sugar_income_median}／${r.protein_income_median} | ${r.trips_per_active_forager_day_median ?? '—'} | ${r.max_trips_one_worker_day} | ${r.queen_death_day_median ?? '—'}（${Object.entries(r.queen_death_reasons).map(([k, v]) => k + ' ' + v).join('、') || '—'}） |`);
  fs.writeFileSync(out.replace(/\.json$/, '.md'), L.join('\n') + '\n');
  console.log(out);
}

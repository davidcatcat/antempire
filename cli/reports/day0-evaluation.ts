/**
 * Day0 lifecycle evaluation (diagnostic, NOT a target). For every engine-supported founding scenario
 * (scenarios/day0/founding-A*.json), every season start (scenarios/day0/seasons.json, never mixed) and 20 fixed
 * world seeds, builds the Day0 world with engine/initialization.ts and runs 365 days with the current engine.
 * Checkpoints: Day 1, 7, 30, 60, 90, 120, 180, 365. Unsupported foundings (B, C) are listed with their missing
 * mechanisms and are not run.
 *   node cli/reports/day0-evaluation.ts [outDir]     (default reports/day0-<rules tag>; the v15 results stay in reports/day0/)
 * Writes ONLY to outDir; never reads or writes saves/ or journal/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_VERSION, simulateWorldDay, FoundingNotSupported, type ParamBundle, type WorldState, type SimEvent } from '../../engine/index.ts';
import { loadBundle, readJson, REPO_ROOT } from '../lib/load.ts';
import { buildDay0, day0Inputs, seasonStart, SEASONS, SUPPORTED_FOUNDINGS, type FoundingId, type Season } from '../lib/day0.ts';
import { rulesFingerprint } from '../lib/fingerprint.ts';
import { RULES_TAG } from './winter-multiseed.ts';
import { BIN_DAYS, binOf, reproductionMeasures, SUSTAINED_REPRODUCTION } from './reproduction-measures.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- report rows
export const DAY0_SEEDS = Array.from({ length: 20 }, (_, i) => 20270001 + i);
export const CHECKPOINTS = [1, 7, 30, 60, 90, 120, 180, 365];
export const HORIZON = 365;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : r3((s[m - 1] + s[m]) / 2); };
const inc = (o: Record<string, number>, k: string, v = 1) => { o[k] = r3((o[k] ?? 0) + v); };
const KEY_EVENTS = new Set(['queen_death', 'worker_death', 'brood_death', 'egg_laid', 'eclosion', 'discovery']);

function edgesKnown(state: WorldState): number[] {
  return state.colonies[0].population.workers.map((w) => Object.keys((w.route_memory as Any)?.edges ?? {}).length);
}

/** One founding × season × seed run. Pure apart from the inputs; returns a summary (no daily dump). */
export function runDay0(founding: FoundingId, season: Season, seed: number, bundle: ParamBundle, days = HORIZON): Any {
  const start = seasonStart(season), init = buildDay0(founding, seed, start, bundle);
  let s = init.state;
  const c0 = s.colonies[0];
  // v2-review.19: separate measures. Reference adults at Day0 = founding workers + carried pupae (A4 starts
  // with pupae only). Own-worker eclosion counts ONLY adults eclosed from eggs laid during the run (renamed from
  // "effective reproduction", Owner 2026-11-02: the measure only says a worker of the queen's own eggs eclosed).
  const initialBrood = new Set(c0.population.brood.map((b) => b.id)), n0 = c0.population.workers.length + c0.population.brood.filter((b) => b.stage === 'pupa').length;
  const founders = new Set(c0.population.workers.map((w) => w.id));
  const nBins = Math.ceil(days / BIN_DAYS), ownBy30 = new Array<number>(nBins).fill(0), eggsBy30 = new Array<number>(nBins).fill(0);
  let lastOwnEclosionDay: number | null = null, lastEggDay: number | null = null;
  let ownEclosions = 0, maxWorkers = c0.population.workers.length, maxWorkersDay = 0;
  const day0 = { date: s.calendar_date, workers: c0.population.workers.length, brood: c0.population.brood.length, sugar: c0.stores.sugar, protein: c0.stores.protein, worker_ages: c0.population.workers.map((w) => w.age_days), warmup_events: init.warmup.events.length, warmup_carcass_protein: r3(Object.values(s.sources).filter((x) => x.type === 'carcass').reduce((a, x) => a + x.protein, 0)), honeydew_hosts_alive: Object.values(s.sources).filter((x) => x.type === 'honeydew' && x.host_alive).map((x) => x.id) };
  const cum = { income: { sugar: 0, protein: 0 }, consumed: { sugar: 0, protein: 0 }, demand: { sugar: 0, protein: 0 }, eggs_laid: 0, hatch: 0, pupation: 0, eclosion: 0, worker_deaths: 0, brood_deaths: 0, trips: 0, successes: 0, explorations: 0, exploration_found_nothing: 0, discoveries: 0, recruitment: 0, trail_choices: 0, trophallaxis: 0, predation: 0, repair_worker_days: 0, forage_worker_days: 0, nurse_worker_days: 0 };
  const act: Any = { outside_minutes: 0, travel_minutes: 0, search_minutes: 0, handling_minutes: 0, prey_holding_minutes: 0, unload_minutes: 0, cancelled_no_time: 0, no_route: 0, active_worker_days: 0, worker_days: 0, rest_minutes_active_foragers: 0, recruitment_failed: 0, trips_hist: {}, stop_reasons: {} };
  const garden = { sugar: 0, protein: 0 }, gardenKnown = { sugar: 0, protein: 0 }; let gardenDays = 0;
  const bySite: Record<string, number> = {}, workerDeath: Record<string, number> = {}, broodDeath: Record<string, number> = {}, firstDiscovery: Record<string, number> = {};
  const checkpoints: Record<number, Any> = {}, chain: Any[] = [], seasonTemps: { air: number[]; nest: number[] } = { air: [], nest: [] };
  let queenDeath: Any = null;
  let queenDeathDay: number | null = null, queenDeathReason: string | null = null, zeroWorkerDay: number | null = null, endDay: number | null = null, firstEggDay: number | null = null, firstEclosionDay: number | null = null, sugarGapMax = 0, proteinGapMax = 0;
  for (let d = 1; d <= days; d++) {
    const out = simulateWorldDay(s, bundle); s = out.state;
    const cr = out.result.colonies[0], sm = cr.summary as Any, ev = cr.events as SimEvent[], w = out.result.weather as Any;
    seasonTemps.air.push(w.air_temp_c); seasonTemps.nest.push(w.nest_temp_model_c);
    for (const k of ['sugar', 'protein'] as const) { cum.income[k] = r3(cum.income[k] + sm.income[k]); cum.consumed[k] = r3(cum.consumed[k] + (sm.consumed?.[k] ?? 0)); cum.demand[k] = r3(cum.demand[k] + (sm.demand?.[k] ?? 0)); }
    cum.eggs_laid += sm.eggs_laid; cum.hatch += sm.hatchings; cum.pupation += sm.pupations; cum.eclosion += sm.eclosions; cum.worker_deaths += sm.worker_deaths; cum.brood_deaths += sm.brood_deaths; cum.trips += sm.foraging_trips; cum.successes += sm.foraging_successes;
    cum.repair_worker_days += sm.tasks.repair; cum.forage_worker_days += sm.tasks.forage; cum.nurse_worker_days += sm.tasks.nurse;
    // v2-review.17 activity timeline (absent in earlier versions)
    if (sm.activity) {
      const A = sm.activity, per = Object.values(A.workers as Record<string, Any>), out = per.filter((w) => w.trips > 0);
      for (const k of ['outside_minutes', 'travel_minutes', 'search_minutes', 'handling_minutes', 'prey_holding_minutes', 'unload_minutes', 'cancelled_no_time', 'no_route'] as const) act[k] = r3((act[k] ?? 0) + A[k]);
      act.active_worker_days += out.length; act.worker_days += per.length;
      act.rest_minutes_active_foragers = r3((act.rest_minutes_active_foragers ?? 0) + out.reduce((x, w) => x + (A.window_minutes - w.outside_minutes - w.unload_minutes), 0));
      for (const w of out) act.trips_hist[Math.min(w.trips, 20)] = (act.trips_hist[Math.min(w.trips, 20)] ?? 0) + 1;
      for (const w of per) if (w.stop_reason) act.stop_reasons[w.stop_reason] = (act.stop_reasons[w.stop_reason] ?? 0) + 1;
    }
    for (const e of ev as Any[]) if (e.type === 'recruitment_failed' || e.type === 'recruitment_no_nestmate') act.recruitment_failed++;
    // garden food standing at day end (world), and the part at sites some living worker has itself walked to
    const known = new Set(s.colonies[0].population.workers.flatMap((w) => Object.keys((w.route_memory as Any)?.edges ?? {}).flatMap((k) => k.split(':'))));
    for (const src of Object.values(s.sources)) { const m = src.type === 'carcass' ? 'protein' : 'sugar', v = src.type === 'carcass' ? src.protein : src.sugar; garden[m] = r3(garden[m] + v); if (known.has(src.id)) gardenKnown[m] = r3(gardenKnown[m] + v); }
    gardenDays++;
    sugarGapMax = Math.max(sugarGapMax, s.colonies[0].stores.sugar_gap_days); proteinGapMax = Math.max(proteinGapMax, s.colonies[0].stores.protein_gap_days);
    if (sm.eggs_laid && firstEggDay === null) firstEggDay = d;
    if (sm.eggs_laid) { eggsBy30[binOf(d)] += sm.eggs_laid; lastEggDay = d; }
    if (sm.eclosions && firstEclosionDay === null) firstEclosionDay = d;
    for (const e of ev as Any[]) {
      if (e.type === 'eclosion' && !initialBrood.has(e.source_brood_id)) { ownEclosions++; ownBy30[binOf(d)]++; lastOwnEclosionDay = d; }
      if (e.type === 'food_collected') inc(bySite, `${e.site}:${e.macro}`, e.portions);
      else if (e.type === 'exploration_step') cum.explorations++;
      else if (e.type === 'exploration_found_nothing') cum.exploration_found_nothing++;
      else if (e.type === 'discovery') { cum.discoveries++; if (firstDiscovery[e.site] === undefined) firstDiscovery[e.site] = d; }
      else if (e.type === 'local_recruitment' || e.type === 'hunt_recruitment' || e.type === 'long_range_recruitment_trail') cum.recruitment++;
      else if (e.type === 'local_trail_choice') cum.trail_choices++;
      else if (e.type === 'trophallaxis') cum.trophallaxis++;
      else if (e.type === 'insect_predation') cum.predation++;
      else if (e.type === 'worker_death') inc(workerDeath, e.reason);
      else if (e.type === 'brood_death') inc(broodDeath, `${e.stage}:${e.reason}`);
      else if (e.type === 'queen_death') { queenDeathDay = d; queenDeathReason = e.reason; queenDeath = { day: d, reason: e.reason, active_triggers: e.active_triggers ?? null, hazards: e.hazards ?? null, sugar_gap_days: e.sugar_gap_days ?? null, protein_gap_days: e.protein_gap_days ?? null, no_worker_days: e.no_worker_days ?? null }; }
      if (KEY_EVENTS.has(e.type)) { chain.push({ day: d, type: e.type, ...(e.reason ? { reason: e.reason } : {}), ...(e.stage ? { stage: e.stage } : {}), ...(e.site ? { site: e.site } : {}), sugar_gap_days: s.colonies[0].stores.sugar_gap_days, protein_gap_days: s.colonies[0].stores.protein_gap_days }); if (chain.length > 12) chain.shift(); }
    }
    const pop = s.colonies[0].population;
    if (pop.workers.length > maxWorkers) { maxWorkers = pop.workers.length; maxWorkersDay = d; }
    if (!pop.workers.length && zeroWorkerDay === null) zeroWorkerDay = d;
    if (!pop.queen_alive && !pop.workers.length && endDay === null) endDay = d;
    if (CHECKPOINTS.includes(d)) {
      const k = edgesKnown(s);
      const wk = pop.workers.length;
      checkpoints[d] = { growth: !pop.queen_alive && !wk ? 'extinct' : !wk ? 'no_workers_queen_alive' : wk > n0 ? 'grew' : wk === n0 ? 'held' : 'declined', founders_alive: pop.workers.filter((w) => founders.has(w.id)).length, own_eclosions_so_far: ownEclosions, date: s.calendar_date, queen: pop.queen_alive, workers: pop.workers.length, minor_workers: pop.workers.length, major_workers: null, eggs: pop.brood.filter((b) => b.stage === 'egg').length, larvae: pop.brood.filter((b) => b.stage === 'larva').length, pupae: pop.brood.filter((b) => b.stage === 'pupa').length, stock: { ...s.colonies[0].stores }, cumulative: structuredClone(cum), mean_edges_known_per_worker: k.length ? r3(k.reduce((a, b) => a + b, 0) / k.length) : null, workers_with_any_route: k.filter((x) => x > 0).length, sites_discovered: Object.keys(firstDiscovery).length };
    }
    if (endDay !== null) { for (const cp of CHECKPOINTS) if (cp > d && !checkpoints[cp]) checkpoints[cp] = { extinct: true }; break; }
  }
  const mean = (xs: number[]) => (xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const out = {
    founding, season, seed, start_date: start, day0,
    reference_adults_day0: n0, own_eclosions: ownEclosions, own_eclosions_by_30d: ownBy30, eggs_laid_by_30d: eggsBy30, last_own_eclosion_day: lastOwnEclosionDay, last_egg_day: lastEggDay, max_workers: maxWorkers, max_workers_day: maxWorkersDay,
    queen_death_day: queenDeathDay, queen_death_reason: queenDeathReason, queen_death: queenDeath, zero_worker_day: zeroWorkerDay, colony_end_day: endDay,
    first_egg_day: firstEggDay, first_eclosion_day: firstEclosionDay, max_sugar_gap_days: sugarGapMax, max_protein_gap_days: proteinGapMax,
    totals: cum, income_by_site: bySite, first_discovery_day_by_site: firstDiscovery, worker_death_reasons: workerDeath, brood_death_reasons: broodDeath,
    activity: act, garden_food_mean: { sugar: gardenDays ? r3(garden.sugar / gardenDays) : null, protein: gardenDays ? r3(garden.protein / gardenDays) : null }, garden_food_at_sites_known_by_workers_mean: { sugar: gardenDays ? r3(gardenKnown.sugar / gardenDays) : null, protein: gardenDays ? r3(gardenKnown.protein / gardenDays) : null },
    temperature: { mean_air_c: mean(seasonTemps.air), mean_nest_c: mean(seasonTemps.nest), min_nest_c: seasonTemps.nest.length ? r3(Math.min(...seasonTemps.nest)) : null, days: seasonTemps.air.length },
    checkpoints, last_key_events: endDay !== null ? chain : undefined,
  };
  return days === HORIZON ? { ...out, reproduction: reproductionMeasures(out) } : out;
}

function aggregate(runs: Any[]): Any {
  const out: Any = { runs: runs.length, colony_end: runs.filter((r) => r.colony_end_day !== null).length, colony_end_day_median: median(runs.filter((r) => r.colony_end_day !== null).map((r) => r.colony_end_day)), queen_dead_by_365: runs.filter((r) => r.queen_death_day !== null).length, laid_any_egg: runs.filter((r) => r.first_egg_day !== null).length, any_eclosion: runs.filter((r) => r.first_eclosion_day !== null).length, checkpoints: {} };
  for (const cp of CHECKPOINTS) {
    const at = runs.map((r) => r.checkpoints[cp] ?? { extinct: true }), alive = at.filter((x) => !x.extinct);
    const ws = at.map((x) => (x.extinct ? 0 : x.workers));
    out.checkpoints[cp] = {
      queen_alive: alive.filter((x) => x.queen).length, colonies_with_workers: ws.filter((x) => x > 0).length,
      any_own_worker_eclosion: runs.filter((r) => (r.checkpoints[cp]?.own_eclosions_so_far ?? r.own_eclosions) > 0).length,
      growth: at.reduce((o: Any, x) => { const k = x.extinct ? 'extinct' : x.growth; o[k] = (o[k] ?? 0) + 1; return o; }, {}),
      founders_alive_median: median(at.map((x) => (x.extinct ? 0 : x.founders_alive ?? 0))),
      workers_min: Math.min(...ws), workers_median: median(ws), workers_max: Math.max(...ws),
      brood_median: median(at.map((x) => (x.extinct ? 0 : x.eggs + x.larvae + x.pupae))),
      eggs_laid_median: median(runs.map((r) => (r.checkpoints[cp]?.cumulative ?? r.totals).eggs_laid)),
      eclosions_median: median(runs.map((r) => (r.checkpoints[cp]?.cumulative ?? r.totals).eclosion)),
      sugar_income_median: median(runs.map((r) => (r.checkpoints[cp]?.cumulative ?? r.totals).income.sugar)),
      protein_income_median: median(runs.map((r) => (r.checkpoints[cp]?.cumulative ?? r.totals).income.protein)),
      discoveries_median: median(runs.map((r) => (r.checkpoints[cp]?.cumulative ?? r.totals).discoveries)),
      mean_edges_known_median: median(alive.map((x) => x.mean_edges_known_per_worker).filter((x) => x !== null)),
    };
  }
  const sumObj = (k: string) => { const o: Record<string, number> = {}; for (const r of runs) for (const [a, v] of Object.entries(r[k] as Record<string, number>)) inc(o, a, v); return o; };
  out.income_by_site_total = sumObj('income_by_site');
  out.worker_death_reasons_total = sumObj('worker_death_reasons');
  out.brood_death_reasons_total = sumObj('brood_death_reasons');
  out.queen_death_reasons = sumObj('_qd');
  const t = (k: string) => r3(runs.reduce((a, r) => a + r.totals[k], 0));
  const A = (k: string) => r3(runs.reduce((a, r) => a + (r.activity?.[k] ?? 0), 0));
  const hist: Record<string, number> = {}, stops: Record<string, number> = {};
  for (const r of runs) { for (const [k, v] of Object.entries(r.activity?.trips_hist ?? {})) hist[k] = (hist[k] ?? 0) + (v as number); for (const [k, v] of Object.entries(r.activity?.stop_reasons ?? {})) stops[k] = (stops[k] ?? 0) + (v as number); }
  out.activity = { active_forager_days: A('active_worker_days'), worker_days: A('worker_days'), trips_per_active_forager_day: A('active_worker_days') ? r3(t('trips') / A('active_worker_days')) : null, outside_min_per_active_forager_day: A('active_worker_days') ? r3(A('outside_minutes') / A('active_worker_days')) : null, travel_minutes: A('travel_minutes'), search_minutes: A('search_minutes'), handling_minutes: A('handling_minutes'), prey_holding_minutes: A('prey_holding_minutes'), unload_minutes: A('unload_minutes'), rest_minutes_active_foragers: A('rest_minutes_active_foragers'), cancelled_no_time: A('cancelled_no_time'), no_route: A('no_route'), recruitment_failed: A('recruitment_failed'), trips_per_forager_day_histogram: hist, stop_reasons: stops };
  out.garden_food_mean_median = { sugar: median(runs.map((r) => r.garden_food_mean?.sugar).filter((x) => x !== null && x !== undefined)), protein: median(runs.map((r) => r.garden_food_mean?.protein).filter((x) => x !== null && x !== undefined)) };
  out.garden_food_known_mean_median = { sugar: median(runs.map((r) => r.garden_food_at_sites_known_by_workers_mean?.sugar).filter((x) => x !== null && x !== undefined)), protein: median(runs.map((r) => r.garden_food_at_sites_known_by_workers_mean?.protein).filter((x) => x !== null && x !== undefined)) };
  out.totals = { trips: t('trips'), successes: t('successes'), explorations: t('explorations'), exploration_found_nothing: t('exploration_found_nothing'), discoveries: t('discoveries'), recruitment: t('recruitment'), trail_choices: t('trail_choices'), trophallaxis: t('trophallaxis'), predation: t('predation'), eggs_laid: t('eggs_laid'), hatch: t('hatch'), pupation: t('pupation'), eclosion: t('eclosion'), repair_worker_days: t('repair_worker_days') };
  out.mean_nest_temperature_c_median = median(runs.map((r) => r.temperature.mean_nest_c));
  const rm = runs.map((r) => r.reproduction).filter(Boolean);
  out.reproduction_365 = rm.length ? { definition: SUSTAINED_REPRODUCTION.id, sustained_reproduction_candidate: rm.filter((x) => x.sustained_reproduction_candidate).length, own_eclosion_windows_median: median(rm.map((x) => x.own_eclosion_windows)), own_eclosions_second_half_median: median(rm.map((x) => x.own_eclosions_second_half)) } : null;
  return out;
}

export function generateDay0Evaluation(outDir: string, bundle: ParamBundle = loadBundle()): Any {
  fs.mkdirSync(outDir, { recursive: true });
  const runs: Any[] = [];
  for (const f of SUPPORTED_FOUNDINGS) for (const season of SEASONS) for (const seed of DAY0_SEEDS) { const r = runDay0(f, season, seed, bundle); r._qd = r.queen_death_reason ? { [r.queen_death_reason + (r.queen_death?.active_triggers ? ' [' + r.queen_death.active_triggers.join('+') + ']' : '')]: 1 } : {}; runs.push(r); }
  const groups: Any = {};
  for (const f of SUPPORTED_FOUNDINGS) { groups[f] = {}; for (const season of SEASONS) groups[f][season] = aggregate(runs.filter((r) => r.founding === f && r.season === season)); }
  const unsupported: Any = {};
  for (const f of ['B', 'C'] as FoundingId[]) {
    const inp = day0Inputs(f);
    try { buildDay0(f, DAY0_SEEDS[0], seasonStart('spring'), bundle); unsupported[f] = { error: 'UNEXPECTEDLY RAN' }; } catch (e) { unsupported[f] = { title: inp.founding.title, refused: e instanceof FoundingNotSupported, missing_mechanisms: (e as FoundingNotSupported).missing ?? null }; }
  }
  for (const r of runs) delete r._qd;
  const fp = rulesFingerprint();
  const doc = { schema: 'antempire.day0-evaluation.v1', diagnostic_not_target: true, rules_tag: RULES_TAG, engine_version: ENGINE_VERSION, rules_fingerprint: { engine: fp.engine, params: fp.params }, official_saves_used: false, seeds: DAY0_SEEDS, horizon_days: HORIZON, checkpoints: CHECKPOINTS, seasons: readJson('scenarios/day0/seasons.json').starts, foundings_run: SUPPORTED_FOUNDINGS, foundings_not_supported: unsupported, groups, runs };
  fs.writeFileSync(path.join(outDir, 'evaluation.json'), JSON.stringify(doc, null, 1) + '\n');
  fs.writeFileSync(path.join(outDir, 'evaluation-tables.md'), tables(doc));
  return doc;
}

export function tables(doc: Any): string {
  const L: string[] = [`# Day0 評估表 ${doc.rules_tag}（自動產生：\`node cli/reports/day0-evaluation.ts\`）`, '', `> 診斷，不是目標。引擎 ${doc.engine_version}；20 固定種子（${doc.seeds[0]}～${doc.seeds.at(-1)}）× 365 日；四季分開。所有數值都是遊戲模型。`, ''];
  for (const f of doc.foundings_run) {
    L.push(`## 情境 ${f}`, '');
    L.push('| 季節 | 檢查日 | 蟻后存活 | 有工蟻 | 工蟻 min/中位/max | 幼體中位 | 累計產卵中位 | 累計羽化中位 | 累計糖收入中位 | 累計蛋白收入中位 | 個體發現中位 | 每隻記得路段中位 |', '|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const season of Object.keys(doc.groups[f])) {
      const g = doc.groups[f][season];
      for (const cp of doc.checkpoints) { const x = g.checkpoints[cp]; L.push(`| ${season} | ${cp} | ${x.queen_alive}/20 | ${x.colonies_with_workers}/20 | ${x.workers_min}/${x.workers_median}/${x.workers_max} | ${x.brood_median} | ${x.eggs_laid_median} | ${x.eclosions_median} | ${x.sugar_income_median} | ${x.protein_income_median} | ${x.discoveries_median} | ${x.mean_edges_known_median ?? '—'} |`); }
    }
    L.push('');
    L.push('| 季節 | 滅巢（蟻后與工蟻皆無） | 滅巢日中位 | 曾產卵 | 曾羽化 | 外出趟／成功 | 探索步／空手 | 招募 | 交哺 | 捕食 | 修繕工日 | 巢溫平均中位 °C |', '|---|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---:|');
    for (const season of Object.keys(doc.groups[f])) { const g = doc.groups[f][season], t = g.totals; L.push(`| ${season} | ${g.colony_end}/20 | ${g.colony_end_day_median ?? '—'} | ${g.laid_any_egg}/20 | ${g.any_eclosion}/20 | ${t.trips}/${t.successes} | ${t.explorations}/${t.exploration_found_nothing} | ${t.recruitment} | ${t.trophallaxis} | ${t.predation} | ${t.repair_worker_days} | ${g.mean_nest_temperature_c_median} |`); }
    L.push('');
    L.push('| 季節 | 各地點收入（份，20 種子合計） | 工蟻死因 | 幼體死因 | 蟻后死因 |', '|---|---|---|---|---|');
    for (const season of Object.keys(doc.groups[f])) { const g = doc.groups[f][season], j = (o: Any) => Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join('；') || '—'; L.push(`| ${season} | ${j(g.income_by_site_total)} | ${j(g.worker_death_reasons_total)} | ${j(g.brood_death_reasons_total)} | ${j(g.queen_death_reasons)} |`); }
    L.push('');
  }
  L.push('## 四項指標分開（v2-review.19 起）：蟻后存活／有工蟻／截至該日曾有自產工蟻羽化／成長分類（成長·持平·衰退·只剩蟻后·全滅）', '');
  L.push('> 蟻后存活、有工蟻、成長分類是**該檢查日當天的狀態**；「曾有自產工蟻羽化」（2026-11-02 起的名稱，原稱「有效繁殖」）是**從 Day1 到該檢查日累積的事件**：只要曾有一隻這次模擬中蟻后產下的卵羽化成工蟻就算（不計創巢時帶來的幼體），該檢查日時蟻群可能已滅亡；它不表示繁殖能持續。持續繁殖見下一節。成長分類以 Day0 的「工蟻＋帶來的蛹」為參考數。', '');
  L.push('| 情境 | 季節 | Day30 | Day90 | Day180 | Day365 |', '|---|---|---|---|---|---|');
  for (const f of doc.foundings_run) for (const season of Object.keys(doc.groups[f])) { const g = doc.groups[f][season]; L.push(`| ${f} | ${season} | ${[30, 90, 180, 365].map((cp) => { const x = g.checkpoints[cp], gr = x.growth; return `${x.queen_alive}／${x.colonies_with_workers}／${x.any_own_worker_eclosion}／${gr.grew ?? 0}·${gr.held ?? 0}·${gr.declined ?? 0}·${gr.no_workers_queen_alive ?? 0}·${gr.extinct ?? 0}`; }).join(' | ')} |`); }
  L.push('');
  L.push(`## 持續繁殖（${SUSTAINED_REPRODUCTION.label}；評估定義，不是生物學門檻，也不是調參目標）`, '');
  L.push(`> ${SUSTAINED_REPRODUCTION.rule}。${SUSTAINED_REPRODUCTION.caveat}`, '');
  L.push('| 情境 | 季節 | 符合候選定義（/20） | 有自產工蟻羽化的 30 日區間數中位（共 13 格，最後一格為 Day361～365 的 5 日；2026-11-03 起計入，Issue #43 F07） | 後半年自產工蟻羽化數中位 |', '|---|---|---:|---:|---:|');
  for (const f of doc.foundings_run) for (const season of Object.keys(doc.groups[f])) { const x = doc.groups[f][season].reproduction_365; if (x) L.push(`| ${f} | ${season} | ${x.sustained_reproduction_candidate} | ${x.own_eclosion_windows_median} | ${x.own_eclosions_second_half_median} |`); }
  L.push('');
  L.push('## 個體行動（v2-review.17 起；20 種子合計）', '');
  L.push('| 情境 | 季節 | 有出巢的工蟻日 | 每隻出巢工蟻每日趟數 | 每隻出巢工蟻每日外出分鐘 | 步行／搜尋／採集／守獵物／卸貨（分鐘） | 出巢工蟻巢內時間（分鐘） | 因時間不足取消 | 沒有路線而未出勤 | 招募失敗 | 停止原因 |', '|---|---|---:|---:|---:|---|---:|---:|---:|---:|---|');
  for (const f of doc.foundings_run) for (const season of Object.keys(doc.groups[f])) { const a = doc.groups[f][season].activity; L.push(`| ${f} | ${season} | ${a.active_forager_days} | ${a.trips_per_active_forager_day ?? '—'} | ${a.outside_min_per_active_forager_day ?? '—'} | ${a.travel_minutes}／${a.search_minutes}／${a.handling_minutes}／${a.prey_holding_minutes}／${a.unload_minutes} | ${a.rest_minutes_active_foragers} | ${a.cancelled_no_time} | ${a.no_route} | ${a.recruitment_failed} | ${Object.entries(a.stop_reasons).sort().map(([k, v]) => k + ' ' + v).join('；') || '—'} |`); }
  L.push('');
  L.push('| 情境 | 季節 | 每隻出巢工蟻每日趟數分布（趟:工蟻日） | 花園每日食物存量中位（糖／蛋白，份） | 其中在工蟻走過的地點（糖／蛋白） |', '|---|---|---|---|---|');
  for (const f of doc.foundings_run) for (const season of Object.keys(doc.groups[f])) { const g = doc.groups[f][season]; L.push(`| ${f} | ${season} | ${Object.entries(g.activity.trips_per_forager_day_histogram).sort((x, y) => +x[0] - +y[0]).map(([k, v]) => k + ':' + v).join(' ') || '—'} | ${g.garden_food_mean_median.sugar}／${g.garden_food_mean_median.protein} | ${g.garden_food_known_mean_median.sugar}／${g.garden_food_known_mean_median.protein} |`); }
  L.push('');
  L.push('## 未執行的創巢方式', '');
  for (const [f, u] of Object.entries(doc.foundings_not_supported as Any)) L.push(`- **${f}**（${(u as Any).title}）：引擎拒絕（${(u as Any).refused ? 'FOUNDING_NOT_SUPPORTED' : '未拒絕！'}）；缺少：${((u as Any).missing_mechanisms ?? []).join('；')}`);
  return L.join('\n') + '\n';
}

if (import.meta.main) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, `reports/day0-${RULES_TAG}`);
  const t = Date.now(), doc = generateDay0Evaluation(outDir);
  console.log(JSON.stringify({ wrote: outDir, runs: doc.runs.length, seconds: (Date.now() - t) / 1000 }, null, 2));
}

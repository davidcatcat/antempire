/**
 * WP4 comparison runner (docs/wp4-local-avoidance.md): every candidate local-behaviour policy (engine/physics/local-steer.ts)
 * and the PH-3b baseline ('none') on the synthetic scenarios, ALL metrics side by side — arrivals are one column among
 * many, never the selection criterion. Measurements only; nothing is tuned.
 *   node prototypes/local-steer/compare.ts                 # all (1000-agent runs included, judge skipped for 1000)
 *   node prototypes/local-steer/compare.ts --no-1000       # without the 1000-agent scenario
 *   node prototypes/local-steer/compare.ts --only head-on-2,stone
 * Writes prototypes/local-steer/out/compare.json and prints a Markdown table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEER_POLICIES, type SteerPolicyId, type SteerParams } from '../../engine/physics/local-steer.ts';
import { loadScenario, type Scenario, type ScenarioFile } from '../solver-compare/lib/spec.ts';
import { judge } from '../solver-compare/lib/judge.ts';
import { HERE, runSteer, toTrajectory, verify, runHash, deadlockClusters, steerParams } from './lib.ts';
import { checkContacts, motionFromSamples } from './contact-check.ts';

/** independent contact_end check of a run (prototypes/local-steer/contact-check.ts), summary without the episode list */
export function contactCheck(sc: Scenario, res: ReturnType<typeof runSteer>['res']) {
  const c = checkContacts(motionFromSamples(res.agents, res.events, { length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value }, sc.horizon_s));
  const { list, ...summary } = c;
  return { ...summary, outside_bracket: list.filter((e) => e.inside === false).length };
}

const PLAYBACK_SCEN = path.join(HERE, '..', 'physics-playback', 'scenarios');
export const SCENARIOS = ['head-on-2', 'offset-block', 'pass-clear', 'crossing', 'crossing-flank', 'stone', 'corridor-8', 'crossing-traffic-100', 'crossing-traffic-1000'];
export function scenarioById(id: string): Scenario {
  const f = path.join(PLAYBACK_SCEN, `${id}.json`);
  return loadScenario(fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as ScenarioFile) : id);
}

export function measure(sc: Scenario, policy: SteerPolicyId, o: { seed?: number; over?: Partial<SteerParams>; judge?: boolean; perm?: 'full' | 'reversed' | 'none'; rerun?: boolean } = {}) {
  const N = sc.agents.length, seed = o.seed ?? sc.seed;
  const r = runSteer(sc, policy, { seed, over: o.over }), res = r.res, h = runHash(res);
  const again = o.rerun === false ? null : runHash(runSteer(sc, policy, { seed, over: o.over }).res) === h;
  const perm = o.perm ?? 'full';
  const reversed = perm === 'none' ? null : runHash(runSteer(sc, policy, { seed, over: o.over, order: 'reversed' }).res) === h;
  const shuffled = perm === 'full' ? runHash(runSteer(sc, policy, { seed, over: o.over, order: 'shuffled' }).res) === h : null;
  const v = verify(sc, res), ck = contactCheck(sc, res);
  const j = o.judge ? judge(sc, toTrajectory(sc, res), { occupancy2d: N <= 24 }) : null;
  const arr = Object.values(res.agents).map((a) => a.arrival_t_s).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const byClass: Record<string, number> = {}, byKind: Record<string, number> = {};
  for (const e of res.events) { byClass[e.class] = (byClass[e.class] ?? 0) + 1; byKind[e.kind] = (byKind[e.kind] ?? 0) + 1; }
  const rho = steerParams(sc).params.sensing_radius_mm!;
  return {
    scenario: sc.id, policy, seed, agents: N, horizon_s: sc.horizon_s, overrides: o.over ?? null,
    arrived: arr.length, arrival_median_s: arr.length ? arr[Math.floor((arr.length - 1) / 2)] : null, arrival_last_s: arr.at(-1) ?? null,
    stalled: res.stats.stalled, deadlock: deadlockClusters(sc, res, rho), blocked_reports: res.stats.blocked_reports, geometry_halts: res.stats.geometry_halts,
    final_modes: Object.values(res.agents).reduce((m: Record<string, number>, a) => { m[a.final_mode] = (m[a.final_mode] ?? 0) + 1; return m; }, {}),
    events: res.events.length, events_by_class: byClass, events_by_kind: byKind, decisions: res.stats.decisions, contacts: res.stats.contacts,
    stops_contact: res.stats.stops_contact, stops_conservative: res.stats.stops_conservative, contact_end_check: ck,
    cpu_ms: r.cost.cpu_ms, wall_ms: r.cost.wall_ms, fallback_intervals: res.stats.fallback_intervals, unresolved: res.stats.unresolved,
    verify: v,
    judge: j ? { overlap_pair_instants: j.overlap_pair_instants, overlap_between_instants: j.overlap_between_instants, max_penetration_mm: j.max_penetration_mm, max_penetration_between_mm: j.max_penetration_between_mm, out_of_walkable_agent_instants: j.out_of_walkable_agent_instants, max_out_of_walkable_mm: j.max_out_of_walkable_mm, obstacle_violation_agent_instants: j.obstacle_violation_agent_instants, max_obstacle_penetration_mm: j.max_obstacle_penetration_mm, occupancy2d: j.occupancy2d, body_contact_episodes: j.body_contact_episodes, judge_wall_ms: j.judge_wall_ms } : 'not run',
    replay: { hash: h, rerun_identical: again, reversed_input_identical: reversed, shuffled_input_identical: shuffled },
  };
}

const fmt = (x: number | null, d = 2) => (x === null ? '—' : x === Infinity ? '∞' : Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
export function table(rows: ReturnType<typeof measure>[]) {
  const head = '| 情境 | 候選 | 種子 | N | 抵達 | 中位抵達 s | 卡住 | 互卡群（隻） | 受阻回報 窄／擋／靜／空／封 | 最小間距 mm | 穿透（成對／靜態） | 裁判最大重疊 mm | 事件 | 決策事件 | 接觸（精確結束／區間外／最大誤差界 s） | 保守停止 | CPU ms | 重跑／反序／打亂 |';
  const lines = [head, '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|'];
  for (const r of rows) {
    const br = r.blocked_reports as Record<string, number>;
    const jd = typeof r.judge === 'string' ? '未跑' : fmt(Math.max(r.judge.max_penetration_mm, r.judge.max_penetration_between_mm, r.judge.max_obstacle_penetration_mm), 3);
    const rp = [r.replay.rerun_identical, r.replay.reversed_input_identical, r.replay.shuffled_input_identical].map((x) => (x === null ? '—' : x ? '同' : '異')).join('／');
    lines.push(`| ${r.scenario} | ${r.policy} | ${r.seed}${r.overrides ? ` ${JSON.stringify(r.overrides)}` : ''} | ${r.agents} | ${r.arrived} | ${fmt(r.arrival_median_s)} | ${r.stalled} | ${r.deadlock.clusters}（${r.deadlock.agents_in_clusters}） | ${br.too_narrow_for_two ?? 0}／${br.blocked_by_nestmates ?? 0}／${br.static_ahead ?? 0}／${br.way_ahead_free ?? 0}／${br.static_closed ?? 0} | ${fmt(r.verify.min_pair_gap_mm, 3)} | ${r.verify.pair_penetrations}／${r.verify.static_penetrations} | ${jd} | ${r.events} | ${r.events_by_class.behavioural_response ?? 0} | ${r.contacts}（${r.contact_end_check.exact}／${r.contact_end_check.outside_bracket}／${fmt(r.contact_end_check.max_err_s)}） | ${r.stops_conservative} | ${fmt(r.cpu_ms, 0)} | ${rp} |`);
  }
  return lines.join('\n');
}

const me = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === me) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  const only = arg('--only')?.split(',') ?? null, no1000 = process.argv.includes('--no-1000');
  const ids = SCENARIOS.filter((s) => (!only || only.includes(s)) && !(no1000 && s.endsWith('1000')));
  const rows: ReturnType<typeof measure>[] = [];
  for (const id of ids) {
    const sc = scenarioById(id), big = sc.agents.length >= 1000;
    // stochastic candidates: seeds 1–5 (seed 1 only at 1000 agents); the baseline is deterministic without draws
    const seeds = big ? [1] : [1, 2, 3, 4, 5];
    for (const p of STEER_POLICIES) for (const seed of p === 'none' ? [sc.seed] : seeds) {
      const row = measure(sc, p, { seed, judge: !big, perm: big ? 'reversed' : seed === seeds[0] ? 'full' : 'none', rerun: !big });
      rows.push(row); console.error(`${id} ${p} seed ${seed}: arrived ${row.arrived}/${row.agents}, stalled ${row.stalled}, pen ${row.verify.pair_penetrations}/${row.verify.static_penetrations}, cpu ${row.cpu_ms.toFixed(0)} ms`);
    }
  }
  // sensitivity of the sensing radius (candidate range ends 0.5 / 1.5 mm) on the 100-agent crossing, seed 1
  if (!only || only.includes('sensitivity')) {
    const sc = scenarioById('crossing-traffic-100');
    for (const p of STEER_POLICIES.filter((x) => x !== 'none')) for (const rho of [0.5, 1.5]) { const row = measure(sc, p, { seed: 1, over: { sensing_radius_mm: rho }, judge: false, perm: 'none' }); rows.push(row); console.error(`sensitivity ${p} ρ=${rho}: arrived ${row.arrived}`); }
  }
  fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
  const outFile = path.join(HERE, 'out', only ? `compare-${only.join('_')}.json` : no1000 ? 'compare-no1000.json' : 'compare.json');
  fs.writeFileSync(outFile, JSON.stringify({ schema: 'antempire.wp4-compare.v1', label: '隔離物理實驗・候選行為規則（非本種/假設）', node: process.version, note: 'CPU 時間是單次量測，機器同時有其他工作，只看數量級；arrivals 不是選擇標準', rows }, null, 1) + '\n');
  console.log(table(rows));
}

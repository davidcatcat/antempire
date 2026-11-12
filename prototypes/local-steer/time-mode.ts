/**
 * Owner decision 40 (docs/wp4-individual-time.md): the common-grid decision clock (baseline, PR #142) vs the EXPERIMENTAL
 * individual decision clock (every agent decides at its own start_t_s + k·dt) of engine/physics/local-steer.ts, side by
 * side on the same scenarios, policies, seeds and decision intervals. ISOLATED: not imported by the day loop, cli/ or web/.
 * Measurements only; nothing is tuned; every failure is kept in the output.
 *
 * Per run: time slicing (time-line instants, decision instants, decisions), decision-time check (every decision event at
 * an allowed instant of its mode), physics invariants (independent sample verifier: pair / static penetration; independent
 * contact_end checker; the solver-compare judge for <= 24 agents), determinism (rerun) and input-order invariance
 * (reversed, shuffled), horizon effects (agents whose last own period is cut by H, final modes), and the outcome columns
 * (arrivals, stalls) which are NOT a selection criterion.
 *   node prototypes/local-steer/time-mode.ts                 # all scenarios, seeds 1-3 (100-agent crossing and K2: seed 1), dt 0.1 / 0.05
 *   node prototypes/local-steer/time-mode.ts --only head-on-2,stone --seeds 1
 * Writes prototypes/local-steer/out/time-mode.json (or --out) and prints a Markdown table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { steer2D, type DecisionClock, type SteerControl, type SteerInput, type SteerPolicyId, type SteerResult } from '../../engine/physics/local-steer.ts';
import { exactSum, gridTime } from '../../engine/physics/exact-time.ts';
import type { Scenario } from '../solver-compare/lib/spec.ts';
import { judge } from '../solver-compare/lib/judge.ts';
import { HERE, steerInput, verify, runHash, toTrajectory, deadlockClusters } from './lib.ts';
import { scenarioById, contactCheck } from './compare.ts';
import { controlScenario } from './controls.ts';

export const TM_SCENARIOS = ['head-on-2', 'offset-block', 'pass-clear', 'crossing', 'crossing-flank', 'stone', 'corridor-8', 'crossing-traffic-100', 'K2_inflow_stay', 'K3_inflow_exit'];
export const TM_POLICIES: Exclude<SteerPolicyId, 'none'>[] = ['A_free_direction', 'B_contact_decision', 'C_sidestep', 'N_no_yield'];
export const TM_DT = [0.1, 0.05];
export const TM_CLOCKS: DecisionClock[] = ['common_grid', 'individual'];

/** a scenario id or a control variant of the 100-agent crossing */
export function tmScenario(id: string): { sc: Scenario; control: SteerControl | undefined } {
  if (/^K\d_/.test(id)) { const c = controlScenario(scenarioById('crossing-traffic-100'), id); return { sc: c.sc, control: c.control }; }
  return { sc: scenarioById(id), control: undefined };
}
export function tmInput(id: string, policy: Exclude<SteerPolicyId, 'none'>, seed: number, dt: number, clock: DecisionClock, order: 'canonical' | 'reversed' | 'shuffled' = 'canonical'): { sc: Scenario; input: SteerInput } {
  const { sc, control } = tmScenario(id);
  // the common grid is the solver default: the baseline input carries NO decision_clock field (bit-identical to PR #142)
  const input = { ...steerInput(sc, policy, { seed, order, over: { decision_interval_s: dt }, clock: clock === 'individual' ? 'individual' : undefined }), ...(control ? { control } : {}) };
  return { sc, input };
}

/** every decision event lies on an allowed instant of its clock: common = exact grid k·dt or the agent's own start / entry
 *  instant; individual = the agent's own start_t_s + k·dt (exact decimals). Returns the offending events. */
export function decisionTimeViolations(input: SteerInput, res: SteerResult, clock: DecisionClock): string[] {
  const dt = input.params.decision_interval_s!, spec = new Map(input.agents.map((a) => [a.id, a])), bad: string[] = [];
  for (const e of res.events) {
    if (e.class !== 'behavioural_response') continue;
    const id = e.agents[0], a = spec.get(id)!, st = a.start_t_s, entered = res.agents[id].present_from_t_s ?? null;
    if (clock === 'individual') {
      const k = Math.round((e.t_s - st) / dt);
      if (!(k >= 0 && Object.is(exactSum([1, st], [k, dt]), e.t_s))) bad.push(`${id}@${e.t_s} not at ${st} + k·${dt}`);
    } else {
      const k = Math.round(e.t_s / dt);
      if (!(Object.is(gridTime(k, dt), e.t_s) || Object.is(e.t_s, st) || (entered !== null && Object.is(e.t_s, entered)))) bad.push(`${id}@${e.t_s} not on the grid nor at its start`);
    }
  }
  return bad;
}

/** horizon effects: agents whose own last decision period is cut by H (their next own instant lies after H) */
function horizonCut(input: SteerInput, clock: DecisionClock): number {
  const dt = input.params.decision_interval_s!, H = input.horizon_s;
  if (clock === 'common_grid') { const k = Math.ceil(H / dt - 1e-9); return Object.is(gridTime(k, dt), H) ? 0 : input.agents.filter((a) => a.start_t_s < H).length; }
  return input.agents.filter((a) => { if (!(a.start_t_s < H)) return false; let k = Math.floor((H - a.start_t_s) / dt) - 1; while (exactSum([1, a.start_t_s], [k + 1, dt]) <= H) k++; return !Object.is(exactSum([1, a.start_t_s], [k, dt]), H); }).length;
}
/** time-line instants of the common grid (the solver counts them only in the individual mode): grid instants and
 *  distinct off-grid start / entry instants before H */
function commonTimeline(input: SteerInput, res: SteerResult): number {
  const dt = input.params.decision_interval_s!, H = input.horizon_s, set = new Set<number>();
  for (let k = 0; gridTime(k, dt) < H; k++) set.add(gridTime(k, dt));
  for (const id of Object.keys(res.agents)) { const a = res.agents[id], st = a.present_from_t_s ?? input.agents.find((x) => x.id === id)!.start_t_s; if (st !== null && st < H) set.add(st); }
  return set.size;
}

export function tmRow(id: string, policy: Exclude<SteerPolicyId, 'none'>, seed: number, dt: number, clock: DecisionClock, o: { perm?: boolean; judge?: boolean } = {}) {
  const { sc, input } = tmInput(id, policy, seed, dt, clock);
  const c0 = process.cpuUsage(); const res = steer2D(input); const cpu = process.cpuUsage(c0);
  const h = runHash(res);
  const same = (order: 'canonical' | 'reversed' | 'shuffled') => runHash(steer2D(tmInput(id, policy, seed, dt, clock, order).input)) === h;
  const v = verify(sc, res), ck = contactCheck(sc, res);
  const N = input.agents.length;
  const j = o.judge !== false && N <= 24 ? judge(sc, toTrajectory(sc, res), { occupancy2d: true }) : null;
  const modes: Record<string, number> = {}; for (const a of Object.values(res.agents)) modes[a.final_mode] = (modes[a.final_mode] ?? 0) + 1;
  const dv = decisionTimeViolations(input, res, clock);
  return {
    scenario: id, policy, seed, dt, clock, agents: N, horizon_s: input.horizon_s,
    timeline_instants: clock === 'individual' ? res.stats.timeline_instants ?? 0 : commonTimeline(input, res),
    decision_instants: res.stats.decision_instants, decisions: Object.values(res.stats.decisions).reduce((a, b) => a + b, 0), decisions_by_kind: res.stats.decisions,
    decision_time_violations: dv.length, decision_time_examples: dv.slice(0, 3),
    events: res.events.length, contacts: res.stats.contacts, arrived: res.stats.arrived, stalled: res.stats.stalled,
    deadlock: deadlockClusters(sc, res, input.params.sensing_radius_mm!), final_modes: modes, horizon_cut_agents: horizonCut(input, clock),
    verify: { pair_penetrations: v.pair_penetrations, static_penetrations: v.static_penetrations, min_pair_gap_mm: v.min_pair_gap_mm, max_pair_penetration_mm: v.max_pair_penetration_mm },
    contact_check: { episodes: ck.episodes, violations: ck.violations, outside_bracket: ck.outside_bracket, max_err_s: ck.max_err_s },
    judge: j ? { max_penetration_mm: Math.max(j.max_penetration_mm, j.max_penetration_between_mm, j.max_obstacle_penetration_mm), out_of_walkable_agent_instants: j.out_of_walkable_agent_instants, obstacle_violation_agent_instants: j.obstacle_violation_agent_instants } : 'not run (> 24 agents)',
    fallback_intervals: res.stats.fallback_intervals, unresolved: res.stats.unresolved,
    replay: { hash: h, rerun_identical: same('canonical'), reversed_identical: o.perm === false ? null : same('reversed'), shuffled_identical: o.perm === false ? null : same('shuffled') },
    cpu_ms: (cpu.user + cpu.system) / 1000,
  };
}
export type TmRow = ReturnType<typeof tmRow>;

const fmt = (x: number | null, d = 2) => (x === null ? '—' : x === Infinity ? '∞' : Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
export function tmTable(rows: TmRow[]) {
  const head = '| 情境 | 規則 | 種子 | dt | 時鐘 | 時間線時刻 | 決策時刻 | 決策數 | 決策時刻違規 | 穿透（成對／靜態） | 裁判最大重疊 mm | 接觸（區間外） | 被 H 截斷 | 抵達 | 卡住 | 重跑／反序／打亂 | CPU ms |';
  const lines = [head, '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|'];
  for (const r of rows) {
    const rp = [r.replay.rerun_identical, r.replay.reversed_identical, r.replay.shuffled_identical].map((x) => (x === null ? '—' : x ? '同' : '異')).join('／');
    lines.push(`| ${r.scenario} | ${r.policy} | ${r.seed} | ${r.dt} | ${r.clock === 'individual' ? '個體' : '共同'} | ${r.timeline_instants} | ${r.decision_instants} | ${r.decisions} | ${r.decision_time_violations} | ${r.verify.pair_penetrations}／${r.verify.static_penetrations} | ${typeof r.judge === 'string' ? '未跑' : fmt(r.judge.max_penetration_mm, 3)} | ${r.contacts}（${r.contact_check.outside_bracket}） | ${r.horizon_cut_agents} | ${r.arrived} | ${r.stalled} | ${rp} | ${fmt(r.cpu_ms, 0)} |`);
  }
  return lines.join('\n');
}

const me = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === me) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  const only = arg('--only')?.split(',') ?? null, seeds = (arg('--seeds') ?? '1,2,3').split(',').map(Number);
  const rows: TmRow[] = [];
  // heavy runs (25–55 s each at 100 agents with a 20–30 s horizon): first seed only, no permutation reruns (rerun kept)
  const HEAVY = new Set(['crossing-traffic-100', 'K2_inflow_stay']);
  for (const id of TM_SCENARIOS.filter((s) => !only || only.includes(s))) for (const p of TM_POLICIES) for (const dt of TM_DT) for (const seed of HEAVY.has(id) ? seeds.slice(0, 1) : seeds) for (const clock of TM_CLOCKS) {
    const row = tmRow(id, p, seed, dt, clock, { perm: !HEAVY.has(id) && seed === seeds[0] });
    rows.push(row);
    console.error(`${id} ${p} dt ${dt} seed ${seed} ${clock}: instants ${row.timeline_instants}, decisions ${row.decisions}, dtv ${row.decision_time_violations}, pen ${row.verify.pair_penetrations}/${row.verify.static_penetrations}, ck ${row.contact_check.outside_bracket}, replay ${Object.values(row.replay).slice(1).join('/')}, cpu ${row.cpu_ms.toFixed(0)} ms`);
  }
  const out = arg('--out') ?? path.join(HERE, 'out', 'time-mode.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ schema: 'antempire.wp4-time-mode.v1', label: '隔離物理實驗・候選行為規則（非本種/假設）・非正式・個體時間為實驗模式', node: process.version, note: 'dt 是模型假設（離散化），不是真實螞蟻的決策間隔；CPU 時間是單次量測，只看數量級；抵達數不是選擇標準', seeds, rows }, null, 1) + '\n');
  console.log(tmTable(rows));
}

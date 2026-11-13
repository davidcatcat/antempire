/**
 * #189 / #193 ruling 11 — A/B experiment on the follower after a contact: "slow to the leader's speed" (shared
 * contact constraint, LANE-FLOW contact_response 'slow') vs "stop" (KIN-2D freeze response held to the agent's next own
 * decision instant, 'stop'). Same scenarios, same decision layer, same seeds; metrics from
 * engine/physics/candidate-metrics.ts. No winner is chosen here: the report lists both and the differences.
 *   node prototypes/lane-flow/ab-follower.ts           → writes prototypes/lane-flow/out/ab-follower.json and prints the table
 * Isolated physics experiment, NOT official; nothing here is a species behaviour (no follower data for the species).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { laneFlow, poseAtFlow, type LaneFlowInput, type LaneFlowResult, type ContactResponse } from '../../engine/physics/lane-flow.ts';
import { evaluateCandidate, compareOutputs, mergeEpisodes, type MetricOptions, type Threshold } from '../../engine/physics/candidate-metrics.ts';
import { CONTACT_TOL_MM } from '../../engine/physics/kinematics2d.ts';
import { normalBenchmark, stressBenchmark, benchmarkInput, recordsOf } from './lib.ts';
import type { Scenario } from '../../engine/physics/lane-flow-benchmarks.ts';

const T = (value: number, note: string): Threshold => ({ value, assumption: true, basis: '遊戲假設', note });
export const AB_METRIC_OPTIONS: MetricOptions = {
  contact_tol_mm: T(CONTACT_TOL_MM, 'KIN-2D contact band θ'), penetration_tol_mm: T(1e-9, 'float noise'), time_slack_s: T(1e-9, 'event time rounding'), episode_gap_slack_mm: T(1e-3, 'KIN-2D release band'),
  stall_speed_mm_s: T(0.5, 'observer: below 3% of the free speed counts as waiting'), head_on_min_deg: T(135, 'observer class'), same_direction_max_deg: T(45, 'observer class'), teleport_tol_mm: T(1e-9, 'float noise'),
  turning: { resample_ds_mm: T(0.5, 'observer resampling'), turn_threshold_rad: T(0.05, 'observer turn threshold') },
};
export const AB_DESIGN = {
  variants: ['slow', 'stop'] as ContactResponse[],
  seeds: [1, 2, 3, 4, 5],
  horizon_s: 20,
  decision: { interval_s: 0.1, sensing_radius_mm: 1.0, rule: 'go_unless_oncoming' as const },
  speed_variation: { sd_mm_s: 2.5, provenance: { assumption: true as const, basis: '遊戲假設' as const, source_ids: [], note: '個體自由速度差異 SD 2.5 mm/s（約 15%）：本種沒有個體速度差異資料；只為讓追撞發生，A/B 兩組相同' } },
  stress: { n: 1000, horizon_s: 6 },
  chunk_cut_every_s: 0.37,
};
const SCEN: Record<string, (seed: number) => Scenario> = {
  one_way: (seed) => normalBenchmark(seed, { speed_variation: AB_DESIGN.speed_variation }),
  two_way: (seed) => normalBenchmark(seed, { directions: [1, -1], speed_variation: AB_DESIGN.speed_variation }),
};

export interface AbRow {
  scenario: string; variant: ContactResponse; seed: number | null; family: string; behavioural_conclusions_allowed: boolean;
  arrived: number; admitted: number; throughput_per_s: number | null;
  contacts: number; contacts_merged: number; same_direction: number; head_on: number; crossing: number; constraint_intervals: number;
  penetration: number; max_depth_mm: number; missed_contacts: number; min_gap_mm: number | null;
  stall_fraction_mean: number | null; entry_wait_mean_s: number | null; queue_wait_mean_s: number | null;
  waiting_entry_at_H: number; in_lane_at_H: number; conservation_ok: boolean; no_teleport_ok: boolean;
  rerun_bitwise: boolean; chunk_bitwise: boolean | null;
  /** largest numeric difference of the partition-independent view with extra epoch cuts; −1 = structural difference (e.g. an arrival or ledger event that differs) */
  chunk_max_diff: number | null;
}
const round = (x: number | null, k = 6) => (x === null ? null : Number(x.toPrecision(k)));
/** a partition-independent view of a run: what an observer sees (poses on a fixed time grid, presence, arrivals,
 *  ledger), not how the producer cut its epochs (pieces / samples are cut-dependent by construction) */
export function partitionView(r: LaneFlowResult, H: number, dt = 0.05) {
  const ts = Array.from({ length: Math.round(H / dt) + 1 }, (_, i) => Math.min(H, i * dt));
  return Object.fromEntries(Object.keys(r.agents).sort().map((id) => {
    const a = r.agents[id];
    return [id, { present_from: a.present_from_t_s, removed: a.removed_t_s, arrival: a.arrival_t_s, state: a.final_state, poses: ts.map((t) => { const p = poseAtFlow(a, t); return p && (a.removed_t_s === null || t < a.removed_t_s) ? [p.x, p.y] : null; }) }];
  }).concat([['__ledger', r.ledger.events.map((e) => [e.t, e.agent, e.kind]) as never]]));
}
function runOne(scenario: string, sc: Scenario, variant: ContactResponse, seed: number | null, H: number, chunk: boolean): AbRow {
  const inp: LaneFlowInput = { ...benchmarkInput(sc, { horizon_s: H, contact_response: variant }), decision: AB_DESIGN.decision };
  const r = laneFlow(inp);
  const rec = recordsOf(r, sc, { candidate: `lane-flow ${variant}`, seed, horizon_s: H, dt_obs: 0.05, v_max_mm_s: Math.max(...sc.agents.map((a) => a.free_speed_mm_s)) });
  const m = evaluateCandidate(rec, AB_METRIC_OPTIONS);
  const rerun = compareOutputs(r, laneFlow(inp)).bitwise_equal;
  let cb: boolean | null = null, cd: number | null = null;
  if (chunk) { const cuts = Array.from({ length: Math.floor(H / AB_DESIGN.chunk_cut_every_s) }, (_, k) => (k + 1) * AB_DESIGN.chunk_cut_every_s); const c = compareOutputs(partitionView(r, H), partitionView(laneFlow({ ...inp, chunk_boundaries_s: cuts }), H)); cb = c.bitwise_equal; cd = c.structural_difference ? -1 : c.max_abs_numeric_diff; }
  const minGap = rec.gaps.length ? Math.min(...rec.gaps.map((g) => g.gap_mm)) : null;
  return {
    scenario, variant, seed, family: sc.family, behavioural_conclusions_allowed: m.behavioural_conclusions_allowed,
    arrived: r.stats.arrived, admitted: r.ledger.events.filter((e) => e.kind === 'admit').length, throughput_per_s: round(m.throughput.per_s),
    contacts: rec.episodes.length, contacts_merged: mergeEpisodes(rec.episodes, rec.gaps, { max_gap_mm: T(1e-3, 'KIN-2D release band: chatter around θ is one contact'), max_pause_s: T(0.05, 'observer sampling interval') }).length, same_direction: m.encounters.same_direction, head_on: m.encounters.head_on, crossing: m.encounters.crossing, constraint_intervals: r.classification.constraint_active.length,
    penetration: m.contacts.penetration.count, max_depth_mm: m.contacts.penetration.max_depth_mm, missed_contacts: m.contacts.missed_contacts.count, min_gap_mm: round(minGap, 4),
    stall_fraction_mean: round(m.waiting.stall_fraction.mean, 4), entry_wait_mean_s: round(m.waiting.entry_wait_s.mean, 4), queue_wait_mean_s: round(m.waiting.queue_wait_s.mean, 4),
    waiting_entry_at_H: m.conservation!.final_census.waiting_entry, in_lane_at_H: m.conservation!.final_census.in_lane, conservation_ok: m.conservation!.ok, no_teleport_ok: m.no_teleport.ok,
    rerun_bitwise: rerun, chunk_bitwise: cb, chunk_max_diff: cd === null ? null : round(cd, 3),
  };
}
export function runAb(o: { seeds?: number[]; scenarios?: string[]; stress?: boolean } = {}): { design: typeof AB_DESIGN; rows: AbRow[]; label: string; note: string } {
  const seeds = o.seeds ?? AB_DESIGN.seeds, rows: AbRow[] = [];
  for (const name of o.scenarios ?? Object.keys(SCEN)) for (const seed of seeds) for (const v of AB_DESIGN.variants) rows.push(runOne(name, SCEN[name](seed), v, seed, AB_DESIGN.horizon_s, seed === seeds[0]));
  if (o.stress !== false) for (const v of AB_DESIGN.variants) rows.push(runOne('stress_1000_one_point', stressBenchmark(AB_DESIGN.stress.n), v, null, AB_DESIGN.stress.horizon_s, false));
  return { design: AB_DESIGN, rows, label: '隔離物理實驗・整合候選・非正式（非本種／假設）', note: 'no winner is selected; both variants stay available (Owner ruling 11)' };
}
const fmt = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)); if (!v.length) return '—'; const lo = Math.min(...v), hi = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length; const f = (x: number) => (x !== 0 && Math.abs(x) < 1e-3 ? x.toExponential(1) : Math.abs(x) >= 100 || Number.isInteger(x) ? String(Math.round(x * 10) / 10) : x.toFixed(3)); return lo === hi ? f(lo) : `${f(mean)}（${f(lo)}–${f(hi)}）`; };
/** markdown table: per scenario × variant, mean (min–max) over seeds */
export function abTable(rows: AbRow[]): string {
  const keys: [keyof AbRow, string][] = [['arrived', '抵達'], ['throughput_per_s', '吞吐 /s'], ['contacts', '接觸段'], ['contacts_merged', '接觸段（合併）'], ['same_direction', '同向'], ['head_on', '迎面'], ['constraint_intervals', '約束區間'], ['penetration', '穿透'], ['missed_contacts', '漏接觸'], ['min_gap_mm', '最小間距 mm'], ['stall_fraction_mean', '停滯比例'], ['entry_wait_mean_s', '進場等待 s'], ['queue_wait_mean_s', '排隊等待 s'], ['in_lane_at_H', '終點時在路上'], ['waiting_entry_at_H', '終點時等進場']];
  const out = [`| 情境 | 變體 | ${keys.map((k) => k[1]).join(' | ')} |`, `|---|---|${keys.map(() => '---').join('|')}|`];
  for (const sc of [...new Set(rows.map((r) => r.scenario))]) for (const v of AB_DESIGN.variants) {
    const g = rows.filter((r) => r.scenario === sc && r.variant === v);
    out.push(`| ${sc} | ${v === 'slow' ? '減速（slow）' : '停下（stop）'} | ${keys.map(([k]) => fmt(g.map((r) => r[k] as number | null))).join(' | ')} |`);
  }
  return out.join('\n');
}
export const AB_OUT = 'prototypes/lane-flow/out/ab-follower.json';
if (process.argv[1]?.endsWith('ab-follower.ts')) {
  const res = runAb();
  fs.mkdirSync(path.join(REPO_ROOT, 'prototypes/lane-flow/out'), { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, AB_OUT), JSON.stringify(res, null, 1) + '\n');
  console.log(abTable(res.rows));
}

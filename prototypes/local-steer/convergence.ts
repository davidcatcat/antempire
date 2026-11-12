/**
 * WP4 decision-interval convergence (docs/wp4-local-avoidance.md §6.2): the key scenarios rerun with decision_interval_s
 * halved and doubled (0.025 / 0.05 / 0.1 s; candidate value 0.05 s, assumption) for A, B, C and the no-yield control N,
 * seeds 1–5. Reports how the contact count and the contact_end timing change, and checks every contact_end with the
 * independent checker. The interval is a behavioural parameter (an agent stopped by a body waits until the next decision
 * instant), so contact durations are NOT expected to converge; this measures by how much they move. Nothing is tuned.
 *   node prototypes/local-steer/convergence.ts [--only head-on-2,corridor-8] [--seeds 1,2,3] [--out file]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SteerPolicyId } from '../../engine/physics/local-steer.ts';
import { HERE, runSteer } from './lib.ts';
import { scenarioById, contactCheck } from './compare.ts';

export const CONV_SCENARIOS = ['head-on-2', 'crossing', 'crossing-flank', 'stone', 'corridor-8', 'crossing-traffic-100'];
export const CONV_DT = [0.025, 0.05, 0.1];
export const CONV_POLICIES: Exclude<SteerPolicyId, 'none'>[] = ['A_free_direction', 'B_contact_decision', 'C_sidestep', 'N_no_yield'];

export function convergenceRow(id: string, policy: Exclude<SteerPolicyId, 'none'>, dt: number, seed: number) {
  const sc = scenarioById(id), r = runSteer(sc, policy, { seed, over: { decision_interval_s: dt } }), res = r.res;
  const open = new Map<string, number>(), dur: number[] = [];
  for (const e of res.events) {
    const k = [...e.agents].sort().join('|');
    if (e.kind === 'contact_start') open.set(k, e.t_s);
    else if (e.kind === 'contact_end' || e.kind === 'contact_end_estimated') { dur.push(e.t_s - open.get(k)!); open.delete(k); }
  }
  dur.sort((a, b) => a - b);
  const ends = res.events.filter((e) => e.kind === 'contact_end').map((e) => e.t_s), ck = contactCheck(sc, res);
  return {
    scenario: id, policy, dt, seed, agents: sc.agents.length, contacts: res.stats.contacts, ends_exact: res.stats.contact_ends_exact, ends_estimated: res.stats.contact_ends_estimated,
    open_at_end: open.size, first_contact_end_s: ends.length ? Math.min(...ends) : null, duration_median_s: dur.length ? dur[(dur.length - 1) >> 1] : null, duration_max_s: dur.at(-1) ?? null,
    contact_time_total_s: dur.reduce((a, b) => a + b, 0), stops_conservative: res.stats.stops_conservative, arrived: res.stats.arrived, stalled: res.stats.stalled,
    check_violations: ck.violations, check_outside: ck.outside_bracket, check_max_err_s: ck.max_err_s, cpu_ms: r.cost.cpu_ms,
  };
}

const fmt = (x: number | null, d = 3) => (x === null ? '—' : Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
export function convergenceTable(rows: ReturnType<typeof convergenceRow>[]) {
  const head = '| 情境 | 規則 | dt s | 接觸數（種子 1–5） | 結束精確／估計／未結束（合計） | 第一個 contact_end s（種子 1） | 接觸時長中位 s（各種子） | 抵達（各種子） | 檢查違規 | 最大誤差界 s |';
  const out = [head, '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|'];
  const keys = [...new Set(rows.map((r) => `${r.scenario}|${r.policy}|${r.dt}`))];
  for (const k of keys) {
    const g = rows.filter((r) => `${r.scenario}|${r.policy}|${r.dt}` === k).sort((a, b) => a.seed - b.seed), r0 = g[0];
    const sum = (f: (r: (typeof g)[number]) => number) => g.reduce((a, r) => a + f(r), 0);
    const errs = g.map((r) => r.check_max_err_s).filter((x): x is number => x !== null);
    out.push(`| ${r0.scenario} | ${r0.policy} | ${r0.dt} | ${g.map((r) => r.contacts).join(',')} | ${sum((r) => r.ends_exact)}／${sum((r) => r.ends_estimated)}／${sum((r) => r.open_at_end)} | ${fmt(r0.first_contact_end_s)} | ${g.map((r) => fmt(r.duration_median_s)).join(',')} | ${g.map((r) => r.arrived).join(',')} | ${sum((r) => r.check_violations + r.check_outside)} | ${errs.length ? fmt(Math.max(...errs), 1) : '—'} |`);
  }
  return out.join('\n');
}

const me = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === me) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  const only = arg('--only')?.split(',') ?? CONV_SCENARIOS, seeds = (arg('--seeds') ?? '1,2,3,4,5').split(',').map(Number);
  const rows: ReturnType<typeof convergenceRow>[] = [];
  for (const id of only) for (const p of CONV_POLICIES) for (const dt of CONV_DT) for (const seed of p === 'N_no_yield' ? [1] : seeds) {
    const r = convergenceRow(id, p, dt, seed); rows.push(r);
    console.error(`${id} ${p} dt ${dt} seed ${seed}: contacts ${r.contacts}, ends ${r.ends_exact}, check ${r.check_violations}/${r.check_outside}, cpu ${r.cpu_ms.toFixed(0)} ms`);
  }
  const outFile = arg('--out') ?? path.join(HERE, 'out', 'convergence.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ schema: 'antempire.wp4-convergence.v1', label: '隔離物理實驗・決策間隔收斂（非本種/假設）・非正式', node: process.version, decision_intervals_s: CONV_DT, note: 'N 沒有亂數抽取，各種子結果相同（測試確認），只跑種子 1；決策間隔是行為參數（停下的個體等到下一個決策時刻），接觸時長不預期收斂', rows }, null, 1) + '\n');
  console.log(convergenceTable(rows));
}

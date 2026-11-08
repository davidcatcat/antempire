/**
 * WP4 control scenarios (docs/wp4-local-avoidance.md §5b; parameters in control-scenarios.json, every value assumption:
 * true, chosen before any run). They test how much of the dense benchmark's outcome (crossing-traffic-*: dense lattice
 * start, arrivers stay on the road forever) comes from the scenario design rather than the candidate rules:
 *   K0 lattice + stay (the benchmark, longer horizon)   K1 lattice + finite-capacity exit
 *   K2 time-staggered inflow + stay                     K3 inflow + exit
 * across the candidates A, B, C and the no-yield control N, seeds 1–5. Arrivals are ONE column; nothing is tuned.
 *   node prototypes/local-steer/controls.ts                          # 100 agents, all variants/policies, seeds 1–5
 *   node prototypes/local-steer/controls.ts --n 1000 --variants K2_inflow_stay,K3_inflow_exit --seeds 1
 *   options: --policies A_free_direction,... --out <file>
 * Writes prototypes/local-steer/out/controls-<n>.json (or --out) and prints a Markdown table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { steer2D, type SteerPolicyId, type SteerResult, type SteerControl } from '../../engine/physics/local-steer.ts';
import type { Scenario } from '../solver-compare/lib/spec.ts';
import { HERE, steerInput, verify, deadlockClusters, steerParams } from './lib.ts';
import { scenarioById, contactCheck } from './compare.ts';

interface Entry<T> { value: T; assumption: boolean; basis: string; why: string }
export interface ControlFile {
  schema: string; status: string; variants: Record<string, { inflow: boolean; exit: boolean; why: string }>;
  params: { inflow_rate_per_arm_per_s: Entry<number>; entry_gap_mm: Entry<number>; exit_capacity: Entry<number>; exit_dwell_s: Entry<number>; horizon_s: Entry<Record<string, number>> };
}
export const loadControls = (): ControlFile => {
  const f = JSON.parse(fs.readFileSync(path.join(HERE, 'control-scenarios.json'), 'utf8')) as ControlFile;
  for (const [k, e] of Object.entries(f.params)) if (e.assumption !== true) throw Error(`control-scenarios: ${k} must be labelled assumption: true`);
  return f;
};
export const CONTROL_POLICIES: Exclude<SteerPolicyId, 'none'>[] = ['A_free_direction', 'B_contact_decision', 'C_sidestep', 'N_no_yield'];

/** the control version of a crossing-lattice scenario: same geometry, bodies, speeds and goals; only start poses / times,
 *  the horizon and the boundary rules change */
export function controlScenario(base: Scenario, variant: string): { sc: Scenario; control: SteerControl } {
  const C = loadControls(), v = C.variants[variant];
  if (!v) throw Error(`unknown control variant ${variant}`);
  const gen = base.file.generator;
  if (!gen || gen.kind !== 'crossing-lattice') throw Error('control scenarios are built from a crossing-lattice scenario');
  const n = base.agents.length, H = C.params.horizon_s.value[String(n)];
  if (!(H > 0)) throw Error(`no control horizon for ${n} agents`);
  const L = base.body.length_mm.value, rate = C.params.inflow_rate_per_arm_per_s.value, gap = C.params.entry_gap_mm.value;
  const agents = [...base.agents].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)).map((a) => ({ ...a }));
  if (v.inflow) {
    const arms = new Map<string, typeof agents>();
    for (const a of agents) { const k = `${a.passage}|${a.dir}`; if (!arms.has(k)) arms.set(k, []); arms.get(k)!.push(a); }
    let armIdx = 0;
    for (const arm of arms.values()) {
      const dir = arm[0].dir, front = Math.max(...arm.map((a) => a.s_mm * dir)) * dir, cross = front + dir * (gen.front_gap_mm + L / 2), sEntry = cross - dir * (gap + L / 2);
      arm.forEach((a, i) => { a.s_mm = sEntry; a.start_t_s = i / rate + armIdx / (4 * rate); });
      armIdx++;
    }
  }
  const sc: Scenario = { ...base, id: `${base.id}~${variant}`, horizon_s: H, agents };
  const control: SteerControl = { spawn: v.inflow, exit: v.exit ? { capacity: C.params.exit_capacity.value, dwell_s: C.params.exit_dwell_s.value } : null };
  return { sc, control };
}

export function runControl(sc: Scenario, control: SteerControl, policy: Exclude<SteerPolicyId, 'none'>, seed: number, over = {}) {
  const input = { ...steerInput(sc, policy, { seed, over }), control };
  const c0 = process.cpuUsage(), w0 = performance.now();
  const res = steer2D(input);
  const cpu = process.cpuUsage(c0);
  return { input, res, cpu_ms: (cpu.user + cpu.system) / 1000, wall_ms: performance.now() - w0 };
}

const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))] : null);
export function controlMetrics(sc: Scenario, control: SteerControl, res: SteerResult, cpu_ms: number) {
  const spec = new Map(sc.agents.map((a) => [a.id, a])), ids = Object.keys(res.agents).sort();
  const arr: number[] = [], transit: number[] = [];
  for (const id of ids) {
    const a = res.agents[id]; if (a.arrival_t_s === null) continue;
    arr.push(a.arrival_t_s);
    const t0 = a.present_from_t_s ?? Math.max(0, spec.get(id)!.start_t_s);
    transit.push(a.arrival_t_s - t0);
  }
  arr.sort((x, y) => x - y); transit.sort((x, y) => x - y);
  const N = ids.length, removed = ids.map((id) => res.agents[id].removed_t_s).filter((t): t is number => typeof t === 'number');
  const entered = ids.filter((id) => typeof res.agents[id].present_from_t_s === 'number'), delays = entered.map((id) => res.agents[id].present_from_t_s! - res.agents[id].scheduled_start_t_s!).sort((x, y) => x - y);
  const clear = control.exit ? (removed.length === N ? Math.max(...removed) : null) : (arr.length === N ? arr[arr.length - 1] : null);
  const v = verify(sc, res), ck = contactCheck(sc, res), rho = steerParams(sc).params.sensing_radius_mm!;
  const modes = ids.reduce((m: Record<string, number>, id) => { const k = res.agents[id].final_mode; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return {
    agents: N, horizon_s: sc.horizon_s, arrived: arr.length,
    arrival_s: { min: arr[0] ?? null, p10: q(arr, 0.1), median: q(arr, 0.5), p90: q(arr, 0.9), max: arr.at(-1) ?? null },
    transit_s: { min: transit[0] ?? null, median: q(transit, 0.5), p90: q(transit, 0.9), max: transit.at(-1) ?? null },
    time_to_clear_s: clear, exited: removed.length, never_entered: control.spawn ? N - entered.length : 0,
    entry_delay_s: control.spawn ? { median: q(delays, 0.5), max: delays.at(-1) ?? null } : null,
    stalled: res.stats.stalled, deadlock: deadlockClusters(sc, res, rho), final_modes: modes, blocked_reports: res.stats.blocked_reports,
    contacts: res.stats.contacts, contact_ends_exact: res.stats.contact_ends_exact, contact_ends_estimated: res.stats.contact_ends_estimated,
    stops_contact: res.stats.stops_contact, stops_conservative: res.stats.stops_conservative,
    contact_end_check: ck, verify: v, fallback_intervals: res.stats.fallback_intervals, unresolved: res.stats.unresolved, events: res.events.length, cpu_ms,
  };
}

const fmt = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '—' : x === Infinity ? '∞' : Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(1) : x.toFixed(d));
export function controlTable(rows: { variant: string; policy: string; seed: number; m: ReturnType<typeof controlMetrics> }[]) {
  const head = '| 對照 | 規則 | 種子 | N | 抵達 | 抵達時刻 s 中位（p10–p90） | 行程 s 中位／p90 | 清空 s | 離開 | 未進場 | 入口延遲 s 中位／最大 | 卡住 | 互卡 | 接觸（精確／估計） | 區間外 | 穿透 | 最小間距 mm | CPU ms |';
  const out = [head, '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|'];
  for (const r of rows) {
    const m = r.m;
    out.push(`| ${r.variant} | ${r.policy} | ${r.seed} | ${m.agents} | ${m.arrived} | ${fmt(m.arrival_s.median)}（${fmt(m.arrival_s.p10)}–${fmt(m.arrival_s.p90)}） | ${fmt(m.transit_s.median)}／${fmt(m.transit_s.p90)} | ${fmt(m.time_to_clear_s)} | ${m.exited} | ${m.never_entered} | ${m.entry_delay_s ? `${fmt(m.entry_delay_s.median)}／${fmt(m.entry_delay_s.max)}` : '—'} | ${m.stalled} | ${m.deadlock.agents_in_clusters} | ${m.contacts}（${m.contact_ends_exact}／${m.contact_ends_estimated}） | ${m.contact_end_check.outside_bracket + m.contact_end_check.violations} | ${m.verify.pair_penetrations}／${m.verify.static_penetrations} | ${fmt(m.verify.min_pair_gap_mm, 3)} | ${fmt(m.cpu_ms, 0)} |`);
  }
  return out.join('\n');
}

const me = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === me) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  const n = Number(arg('--n') ?? 100), C = loadControls();
  const variants = arg('--variants')?.split(',') ?? Object.keys(C.variants);
  const policies = (arg('--policies')?.split(',') ?? CONTROL_POLICIES) as Exclude<SteerPolicyId, 'none'>[];
  const seeds = (arg('--seeds') ?? '1,2,3,4,5').split(',').map(Number);
  const base = scenarioById(`crossing-traffic-${n}`);
  const rows: { variant: string; policy: string; seed: number; m: ReturnType<typeof controlMetrics> }[] = [];
  for (const variant of variants) {
    const { sc, control } = controlScenario(base, variant);
    for (const p of policies) for (const seed of seeds) {
      const r = runControl(sc, control, p, seed), m = controlMetrics(sc, control, r.res, r.cpu_ms);
      rows.push({ variant, policy: p, seed, m });
      console.error(`${variant} ${p} seed ${seed}: arrived ${m.arrived}/${m.agents}, exited ${m.exited}, clear ${m.time_to_clear_s}, pen ${m.verify.pair_penetrations}/${m.verify.static_penetrations}, check ${m.contact_end_check.violations}, cpu ${m.cpu_ms.toFixed(0)} ms`);
    }
  }
  const outFile = arg('--out') ?? path.join(HERE, 'out', `controls-${n}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ schema: 'antempire.wp4-controls.v1', label: '隔離物理實驗・對照情境（遊戲假設，非本種）・非正式', node: process.version, params: C.params, variants: C.variants, note: 'CPU 是單次量測（機器同時有其他工作，只看數量級）；抵達只是一欄，不是選擇標準；沒有調參', rows }, null, 1) + '\n');
  console.log(controlTable(rows));
}

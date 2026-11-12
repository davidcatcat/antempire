/**
 * Natural-walk validation against R133 (Vázquez, Koehler & Pereira 2020) on the straight 150 mm artificial trail.
 * Deterministic tables for docs/physics-kinematics2d.md §8 (tests assert the document contains them verbatim).
 * Parameters are those of the candidate file, fixed BEFORE these numbers were produced; nothing here is fitted.
 */
import { loadCandidates } from '../kinematics2d/lib.ts';
import { trailAnt, trailMetrics, type TrailMetrics } from './lib.ts';
import type { WalkModel } from '../../engine/physics/natural-walk.ts';

const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const q = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
/** "mean ± 95% CI of the mean (p10–p90)" — the CI is comparable with R133's figure statistic for speed and amplitude */
const stat = (a: number[], d = 2) => (a.length ? `${mean(a).toFixed(d)} ± ${((1.96 * sd(a)) / Math.sqrt(a.length)).toFixed(d)}（${q(a, 0.1).toFixed(d)}–${q(a, 0.9).toFixed(d)}）` : '—');

export function runSet(model: WalkModel, dir: 'out' | 'ret', opts: { control_dt?: number; offset_mm?: number } = {}): TrailMetrics[] {
  const ts = loadCandidates().natural_walk.trail_scenario, speed = dir === 'out' ? ts.speed_outbound_mm_s.value : ts.speed_return_mm_s.value;
  const out: TrailMetrics[] = [];
  for (const seed of ts.seeds as number[]) for (let i = 0; i < ts.ants_per_seed; i++) {
    const { plan, res } = trailAnt(model, seed * 10 + (dir === 'out' ? 0 : 1), i, { speed, ...opts });
    out.push(trailMetrics(res.executed[plan.track.id].segs, plan.arrival_t_s, 2.5));
  }
  return out;
}

export function validationTable(): string {
  const out = [row(['模型', '方向', 'n', '完成率', '沿跡速度 150/T (mm/s)', '抵達時刻 T (s)', '行走距離 (mm)', '平均偏離 (mm)', '最大偏離 (mm)', '忠實度 ≤1 mm (%)', '轉向數 δ=0.5 mm', '轉向數 δ=0.1／1.0 mm（平均）', '每體長轉角 |Δθ| p50／p90 (rad)']), row(Array(13).fill('---'))];
  for (const m of ['A', 'B', 'C'] as const) for (const dir of ['out', 'ret'] as const) {
    const r = runSet(m, dir), ok = r.filter((x) => x.arrived);
    out.push(row([m, dir === 'out' ? '去程' : '回程', r.length, `${ok.length}/${r.length}`, stat(ok.map((x) => x.along_speed_mm_s as number)), stat(ok.map((x) => x.arrival_s as number)), stat(r.map((x) => x.path_mm), 1), stat(r.map((x) => x.amp_mean_mm)), stat(r.map((x) => x.amp_max_mm)), stat(r.map((x) => x.fidelity_pct), 1), stat(r.map((x) => x.turns['0.5']), 1), `${mean(r.map((x) => x.turns['0.1'])).toFixed(1)}／${mean(r.map((x) => x.turns['1'])).toFixed(1)}`, `${mean(r.map((x) => x.dtheta_p50)).toFixed(3)}／${mean(r.map((x) => x.dtheta_p90)).toFixed(3)}`]));
  }
  out.push(row(['**R133 本種**', '去程', '≤75（未報告）', '未單獨報告', '18.5 ± 0.53', '—', '—', '1.1 ± 0.03', '—', '去程較高（數值在圖中，未讀）', '12.8 ± 0.25（雙向合計，± 為 sem）', '—', '—']));
  out.push(row(['**R133 本種**', '回程', '≤75（未報告）', '未單獨報告', '15.5 ± 0.54', '—', '—', '1.7 ± 0.11', '—', '回程較低', '（同上；去回無顯著差異）', '—', '—']));
  return out.join('\n');
}

export function dtTable(): string {
  const out = [row(['模型', '控制間隔 Δc (s)', '平均偏離 (mm)', '忠實度 (%)', '轉向數 δ=0.5 mm', '|Δθ| p50 (rad)', '完成率']), row(Array(7).fill('---'))];
  for (const m of ['B', 'C'] as const) for (const dt of [0.01, 0.02, 0.05, 0.1]) {
    const r = runSet(m, 'out', { control_dt: dt });
    out.push(row([m, dt, stat(r.map((x) => x.amp_mean_mm)), stat(r.map((x) => x.fidelity_pct), 1), stat(r.map((x) => x.turns['0.5']), 1), mean(r.map((x) => x.dtheta_p50)).toFixed(3), `${r.filter((x) => x.arrived).length}/${r.length}`]));
  }
  return out.join('\n');
}

export function offsetTable(): string {
  const out = [row(['模型', '起點橫向偏移 (mm)', '平均偏離 (mm)', '忠實度 (%)', '轉向數 δ=0.5 mm']), row(Array(5).fill('---'))];
  for (const m of ['A', 'C'] as const) for (const off of [1, 5]) {
    const r = runSet(m, 'out', { offset_mm: off });
    out.push(row([m, `U(−${off}, ${off})`, stat(r.map((x) => x.amp_mean_mm)), stat(r.map((x) => x.fidelity_pct), 1), stat(r.map((x) => x.turns['0.5']), 1)]));
  }
  return out.join('\n');
}

export function allWalkTables(): Record<string, string> { return { validation: validationTable(), dt: dtTable(), offset: offsetTable() }; }
if (import.meta.url === `file://${process.argv[1]}`) for (const [k, v] of Object.entries(allWalkTables())) console.log(`<!-- ${k} -->\n${v}\n`);

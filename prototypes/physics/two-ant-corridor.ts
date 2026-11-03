/**
 * Work C (Owner instruction, Issues #68/#69): two Pheidole megacephala minor workers start at the two ends of a narrow
 * corridor and walk towards each other, on the PH-1 synthetic corridor with the MV-1/MV-2 kinematics and the PH-2
 * collision layer. Control: the same corridor without the walls. Experimental world only (synthetic, not official; no
 * save, no journal, no game day). Run directly to print the report:  node prototypes/physics/two-ant-corridor.ts
 *
 * Every number that is not computed here comes from the candidate files in scenarios/physics/ with its evidence label.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhysicsGeometry } from '../../engine/physics/geometry.ts';
import { summarize, passageOf, legSpeed, type SpeedModel } from '../../engine/physics/kinematics.ts';
import { simulate, checkExclusion, narrowSections, type SimAgentSpec, type SimConfig, type SimResult } from '../../engine/physics/collision.ts';
import { sha256, utf8 } from '../../engine/sha256.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
export const SOURCES = {
  geometry: 'scenarios/physics/narrow-corridor.geometry.json',
  body: 'scenarios/physics/pheidole-megacephala.body-candidates.json',
  motion: 'scenarios/physics/pheidole-megacephala.motion-candidates.json',
  interaction: 'scenarios/physics/pheidole-megacephala.interaction-candidates.json',
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const hashOf = (x: unknown) => hex(sha256(utf8(JSON.stringify(x)))).slice(0, 16);

export interface RunSummary {
  label: string; width_mm: number; reach_mm: number; walls: boolean;
  contact: { t_s: number; s_mm: number; certain: boolean | null } | null;
  obstruction_t_s: number | null; yielder: string | null; back_out_mm: number | null;
  ants: Record<string, { arrive_s: number | null; alone_s: number; added_s: number | null; path_mm: number; displacement_mm: number; moving_s: number; waiting_s: number; mean_moving_speed: number | null; trip_speed: number | null }>;
  exclusion_violations: number; result_hash: string; replay_identical: boolean; order_identical: boolean;
}

export function setup() {
  const geom = read(SOURCES.geometry) as PhysicsGeometry, body = read(SOURCES.body), motion = read(SOURCES.motion), inter = read(SOURCES.interaction);
  const model: SpeedModel = {
    trail_speed_mm_s: { outbound: motion.trail_speed_mm_s.outbound.value, returning: motion.trail_speed_mm_s.returning.value, pooled: motion.trail_speed_mm_s.pooled.value },
    off_trail_factor: motion.off_trail_factor.value, individual_cv: motion.individual_cv.value,
  };
  return { geom, body, motion, inter, model, L: body.castes.minor.body_length_mm.value as number, widths: body.castes.minor.effective_collision_width_mm.candidate_range as [number, number], reaches: inter.contact_reach_mm.candidate_range as [number, number] };
}

/** Two workers: W1 leaves the nest end (s=2 mm) outbound, W2 returns from the far end (s=98 mm). Speeds: Vázquez 2020 by leg. */
export function agents(width: number, reach: number, speeds?: [number, number]): SimAgentSpec[] {
  const { L, model } = setup();
  const v1 = speeds?.[0] ?? legSpeed(model, 'outbound', true)!, v2 = speeds?.[1] ?? legSpeed(model, 'returning', true)!;
  const body = { length_mm: L, width_mm: width, contact_reach_mm: reach };
  return [
    { id: 'W1', passage: 'P-corridor', s_mm: 2, dir: 1, start_t_s: 0, free_speed_mm_s: v1, goal_s_mm: 98, body, load: null },
    { id: 'W2', passage: 'P-corridor', s_mm: 98, dir: -1, start_t_s: 0, free_speed_mm_s: v2, goal_s_mm: 2, body, load: null },
  ];
}

export function runOne(label: string, width: number, reach: number, walls: boolean, seed = 1, speeds?: [number, number]): { summary: RunSummary; res: SimResult; cfg: SimConfig } {
  const { geom } = setup();
  const g = walls ? geom : { ...structuredClone(geom), world_id: 'synthetic-narrow-corridor-control', obstacles: [] };
  const ags = agents(width, reach, speeds), cfg: SimConfig = { geometry: g, agents: ags, horizon_s: 60, seed };
  const res = simulate(cfg);
  const replay = simulate(cfg), reordered = simulate({ ...cfg, agents: [...ags].reverse() });
  const alone = (a: SimAgentSpec) => simulate({ ...cfg, agents: [a] }).events.find((e) => e.kind === 'arrive')!.t_s;
  const c = res.events.find((e) => e.kind === 'contact_start') ?? null, o = res.events.find((e) => e.kind === 'obstruction') ?? null, y = res.events.find((e) => e.kind === 'yield_start') ?? null;
  const ants: RunSummary['ants'] = {};
  for (const a of ags) {
    const arr = res.events.find((e) => e.kind === 'arrive' && e.agent === a.id)?.t_s ?? null, al = alone(a);
    const ivs = res.intervals[a.id].filter((r) => r.cause !== 'not_started'), sm = summarize(ivs.filter((r) => arr === null || r.t_end_s <= arr + 1e-9), a.free_speed_mm_s);
    ants[a.id] = { arrive_s: arr, alone_s: al, added_s: arr === null ? null : arr - al, path_mm: sm.path_length_mm, displacement_mm: sm.displacement_mm, moving_s: sm.moving_time_s, waiting_s: sm.waiting_time_s + sm.stopped_time_s, mean_moving_speed: sm.mean_moving_speed_mm_s, trip_speed: sm.trip_speed_mm_s };
  }
  const summary: RunSummary = {
    label, width_mm: width, reach_mm: reach, walls,
    contact: c ? { t_s: c.t_s, s_mm: (c.position_mm[0]), certain: c.certain } : null,
    obstruction_t_s: o?.t_s ?? null, yielder: y?.agent ?? null,
    back_out_mm: y ? Number(/backs out ([0-9.]+) mm/.exec(y.detail ?? '')?.[1] ?? NaN) : null,
    ants, exclusion_violations: checkExclusion(cfg, res, 0.005).length, result_hash: hashOf(res),
    replay_identical: JSON.stringify(replay) === JSON.stringify(res), order_identical: JSON.stringify(reordered) === JSON.stringify(res),
  };
  return { summary, res, cfg };
}

/**
 * Independent fixed-time-step reference for the same two-ant protocol (different algorithm, same rules), used only to
 * show that the event-driven engine is the Δt → 0 limit. Positions advance by v·Δt; a rule fires at the first step where
 * its condition holds. Returns arrival times.
 */
export function fixedStepReference(width: number, reach: number, dt: number, speeds?: [number, number]): { W1: number; W2: number; yielder: string } {
  const { geom, L } = setup(), p = passageOf(geom, 'P-corridor');
  const [a, b] = agents(width, reach, speeds), M = L, eps = 1e-6;
  const sec = narrowSections(geom, p, 2 * width)[0] ?? null;
  let s1 = a.s_mm, s2 = b.s_mm, t = 0, mode1 = 'free', mode2 = 'free', yielder = '', target = NaN, arr1 = NaN, arr2 = NaN;
  const narrowAt = (x: number) => !!sec && sec[0] <= x && x <= sec[1];
  while ((isNaN(arr1) || isNaN(arr2)) && t < 60) {
    const v1 = a.free_speed_mm_s, v2 = b.free_speed_mm_s;
    let d1 = 0, d2 = 0;
    // velocities by mode (W1 moves +, W2 moves −; a backing-out ant moves the other way; a waiting ant stands)
    const vel = (who: 1 | 2) => { const m = who === 1 ? mode1 : mode2, v = who === 1 ? v1 : v2, dir = who === 1 ? 1 : -1; return m === 'free' ? dir * v : m === 'retreat' ? -dir * v : 0; };
    d1 = vel(1) * dt; d2 = vel(2) * dt;
    // a passer pressing on a backing-out ant cannot be faster than it (single file)
    if (mode1 === 'free' && mode2 === 'retreat' && s2 - s1 <= M + 1e-9 && narrowAt(s1 + L / 2)) d1 = Math.min(d1, d2);
    if (mode2 === 'free' && mode1 === 'retreat' && s2 - s1 <= M + 1e-9 && narrowAt(s2 - L / 2)) d2 = Math.max(d2, d1);
    s1 += d1; s2 += d2; t += dt;
    if (mode1 === 'free' && mode2 === 'free' && s2 - s1 <= M && narrowAt(s1 + L / 2)) {
      // touch in single file: the one with the shorter way back backs out to just outside the narrow section
      const back1 = Math.abs(s1 - (sec![0] - eps - L / 2)), back2 = Math.abs(s2 - (sec![1] + eps + L / 2));
      if (back1 < back2) { mode1 = 'retreat'; yielder = 'W1'; target = sec![0] - eps - L / 2; } else { mode2 = 'retreat'; yielder = 'W2'; target = sec![1] + eps + L / 2; }
      // keep bodies apart after the overshoot of this step
      if (s2 - s1 < M) { const over = M - (s2 - s1); if (yielder === 'W1') s1 -= over; else s2 += over; }
    }
    if (mode1 === 'retreat' && s1 <= target) { s1 = target; mode1 = 'wait'; }
    if (mode2 === 'retreat' && s2 >= target) { s2 = target; mode2 = 'wait'; }
    if (mode1 === 'wait' && s2 <= s1 - M) mode1 = 'free';
    if (mode2 === 'wait' && s1 >= s2 + M) mode2 = 'free';
    if (isNaN(arr1) && s1 >= a.goal_s_mm) { arr1 = t - (s1 - a.goal_s_mm) / Math.max(1e-12, a.free_speed_mm_s); s1 = a.goal_s_mm; mode1 = 'done'; }
    if (isNaN(arr2) && s2 <= b.goal_s_mm) { arr2 = t - (b.goal_s_mm - s2) / Math.max(1e-12, b.free_speed_mm_s); s2 = b.goal_s_mm; mode2 = 'done'; }
  }
  return { W1: arr1, W2: arr2, yielder };
}

/**
 * Closed-form arrival times of the main run, worked out by hand from the rules (no simulation): touch when the gap is
 * one body length; W2 (shorter way back) backs out to just outside the single-file section; W1 walks behind it at W2's
 * speed; W2 resumes when W1's centre is one body length past it.
 */
export function analyticMain(width: number): { W1: number; W2: number; touch_s: number } {
  const { geom, L, model } = setup(), sec = narrowSections(geom, passageOf(geom, 'P-corridor'), 2 * width)[0];
  const v1 = legSpeed(model, 'outbound', true)!, v2 = legSpeed(model, 'returning', true)!, s10 = 2, s20 = 98, eps = 1e-6;
  const tTouch = (s20 - s10 - L) / (v1 + v2), s1t = s10 + v1 * tTouch, s2t = s20 - v2 * tTouch;
  const target = sec[1] + eps + L / 2, tBack = tTouch + (target - s2t) / v2, s1b = s1t + v2 * (tBack - tTouch);
  const W1 = tBack + (98 - s1b) / v1, tResume = tBack + (target + L + eps - s1b) / v1, W2 = tResume + (target - 2) / v2;
  return { W1, W2, touch_s: tTouch };
}

export interface Experiment {
  sources: Record<string, string>;
  main: RunSummary; control: RunSummary;
  analytic: { W1: number; W2: number; touch_s: number; engine_minus_analytic_s: [number, number] };
  sensitivity: RunSummary[];
  tie: { seeds: number; yielder_counts: Record<string, number>; same_speed_mm_s: number };
  convergence: { dt_s: number; W1_err_s: number; W2_err_s: number; yielder: string }[];
}

export function runExperiment(): Experiment {
  const { widths, reaches, model } = setup(), wHi = widths[1], rMid = (reaches[0] + reaches[1]) / 2;
  const main = runOne('main: walls, width high candidate', wHi, rMid, true).summary;
  const control = runOne('control: no walls', wHi, rMid, false).summary;
  const sensitivity: RunSummary[] = [];
  for (const w of [widths[0], (widths[0] + widths[1]) / 2, widths[1]]) for (const r of [reaches[0], rMid, reaches[1]]) sensitivity.push(runOne(`w=${w} r=${r}`, w, r, true).summary);
  const vSame = legSpeed(model, 'unknown', true)!, counts: Record<string, number> = {};
  for (let seed = 1; seed <= 40; seed++) { const y = runOne('tie', wHi, rMid, true, seed, [vSame, vSame]).summary.yielder ?? 'none'; counts[y] = (counts[y] ?? 0) + 1; }
  const exact = main.ants;
  const convergence = [0.1, 0.01, 0.001, 0.0001, 0.00001].map((dt) => { const r = fixedStepReference(wHi, rMid, dt); return { dt_s: dt, W1_err_s: r.W1 - exact.W1.arrive_s!, W2_err_s: r.W2 - exact.W2.arrive_s!, yielder: r.yielder }; });
  const an = analyticMain(wHi);
  return { sources: SOURCES, main, control, analytic: { ...an, engine_minus_analytic_s: [exact.W1.arrive_s! - an.W1, exact.W2.arrive_s! - an.W2] }, sensitivity, tie: { seeds: 40, yielder_counts: counts, same_speed_mm_s: vSame }, convergence };
}

const f = (x: number | null | undefined, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));
export function report(e: Experiment): string {
  const row = (r: RunSummary) => `| ${r.label} | ${r.contact ? `${f(r.contact.t_s)} s @ ${f(r.contact.s_mm, 2)} mm (${r.contact.certain ? '確定' : '可能'})` : '無'} | ${r.obstruction_t_s === null ? '無' : f(r.obstruction_t_s)} | ${r.yielder ?? '—'} | ${f(r.back_out_mm, 2)} | ${f(r.ants.W1.arrive_s)} (+${f(r.ants.W1.added_s)}) | ${f(r.ants.W2.arrive_s)} (+${f(r.ants.W2.added_s)}) | ${r.exclusion_violations} | ${r.replay_identical && r.order_identical ? '是' : '否'} |`;
  const ant = (r: RunSummary, id: string) => { const a = r.ants[id]; return `| ${r.label} | ${id} | ${f(a.path_mm, 2)} | ${f(a.displacement_mm, 2)} | ${f(a.moving_s)} | ${f(a.waiting_s)} | ${f(a.mean_moving_speed, 2)} | ${f(a.trip_speed, 2)} |`; };
  return `# 雙工蟻窄道實驗（Work C）— 實驗世界，非正式

> 由 \`prototypes/physics/two-ant-corridor.ts\` 產生；\`tests/physics-two-ant.test.ts\` 會重跑並比對本檔末的 JSON。合成場景，不是臺中西屯花園，不產生任何存檔、日誌或遊戲日。所有回應規則是**候選規則**（見 \`${SOURCES.interaction}\`），不是本種實測行為。

## 設定
- 場景：\`${SOURCES.geometry}\`。通路長 100 mm、寬 20 mm；x=20～80 mm 兩側有牆，可用寬度 1.0 mm。
- W1：從 s=2 mm（巢端）往外走，速度是 Vázquez 2020 的離巢速度 18.5 mm/s。W2：從 s=98 mm 回巢，速度是回巢速度 15.5 mm/s。兩隻同時出發。
- 身體：體長 2.5 mm（Yuan 2026，文獻支持）。碰撞寬度與觸角可及距離是候選範圍（遊戲假設），主實驗取寬度上限 0.8 mm、可及距離 1.0 mm，另做敏感度。
- 對照組：同一通路拿掉兩側的牆。

## 主實驗與對照
| 情境 | 接觸 | 阻擋（s） | 讓路者 | 退後（mm） | W1 抵達 s（比單獨多） | W2 抵達 s（比單獨多） | 互斥違反 | 重播／換順序相同 |
|---|---|---|---|---|---|---|---|---|
${row(e.main)}
${row(e.control)}

| 情境 | 個體 | 路線長 mm | 位移 mm | 移動 s | 等待 s | 移動中速度 mm/s | 整趟速度 mm/s |
|---|---|---|---|---|---|---|---|
${ant(e.main, 'W1')}
${ant(e.main, 'W2')}
${ant(e.control, 'W1')}
${ant(e.control, 'W2')}

解讀（只限本模型）：
- 有牆時，兩隻在單行段迎面相碰。回頭路較短的 W2 退出窄段，在寬處等待；W1 跟在退後的 W2 後面，速度被限制為 W2 的速度，直到 W2 退出窄段。兩隻都比單獨行走晚到，讓路者晚得多。
- W2 的移動中速度不變（15.5 mm/s），整趟速度下降，因為它多走了退後與回來的路，還等了一下。
- W1 沒有停下，但有一段被限制在 W2 的速度，所以移動中平均速度降到 ${f(e.main.ants.W1.mean_moving_speed, 2)} mm/s。
- 延遲都來自實際的讓路與跟隨，不是固定減速比例。
- **解析解核對**：照規則手算的抵達時間 W1 ${f(e.analytic.W1, 9)} s、W2 ${f(e.analytic.W2, 9)} s，引擎差 ${e.analytic.engine_minus_analytic_s.map((x) => x.toExponential(1)).join('、')} s。
- 沒有牆時只有一次「可能」的接觸，抵達時間與單獨行走相同：**接觸本身不改變任何事**。
- 路線長 > 位移：讓路者多走了退後與回來的距離。

## 敏感度（碰撞寬度 × 觸角可及距離，均為遊戲假設的候選）
| 情境 | 接觸 | 阻擋（s） | 讓路者 | 退後（mm） | W1 抵達 s（比單獨多） | W2 抵達 s（比單獨多） | 互斥違反 | 重播／換順序相同 |
|---|---|---|---|---|---|---|---|---|
${e.sensitivity.map(row).join('\n')}

- 寬度 0.5 mm 時兩隻可並排通過牆間（1.0 ≥ 2×0.5），沒有阻擋。寬度 ≥ 0.65 mm 時一定要讓路。**結果取決於本種沒有量測的碰撞寬度。**
- 觸角可及距離只改變接觸發生的時刻，不改變阻擋與抵達。

## 平手（兩隻同速 ${f(e.tie.same_speed_mm_s, 1)} mm/s、位置對稱，${e.tie.seeds} 個種子）
讓路者次數：${Object.entries(e.tie.yielder_counts).map(([k, v]) => `${k} ${v}`).join('、')}。平手由命名亂數流 \`physics.yield\` 決定，與輸入順序無關。

## 時間解析度收斂（獨立的固定步長參考實作，同一套規則）
| Δt (s) | W1 抵達誤差 (s) | W2 抵達誤差 (s) | 讓路者 |
|---|---|---|---|
${e.convergence.map((c) => `| ${c.dt_s} | ${c.W1_err_s.toExponential(2)} | ${c.W2_err_s.toExponential(2)} | ${c.yielder} |`).join('\n')}

- 固定步長版本的誤差隨 Δt 縮小，收斂到事件驅動引擎的結果。
- 下降不完全單調：相碰時刻是否剛好落在格點上，會讓誤差忽大忽小。
- 大 Δt（0.1 s）會讓相碰時的位置誤差到 1 mm 量級，抵達誤差也到 0.07 s。
- 事件驅動引擎本身沒有時間步，與解析解一致。

## 與科學觀察的比較（Owner 指定項目）與驗證限制
| 項目 | 本模型 | 本種資料 | 可否驗證 |
|---|---|---|---|
| 步行速度 | 18.5／15.5／17 mm/s | Vázquez 2020：實驗室人工路線（R133） | 只能對照輸入值；野外速度未知 |
| 速度分布 | 個體差異 CV = null（不加入） | 只有平均與 95% CI，沒有個體分布 | 不可 |
| 接觸頻率 | 本實驗 1 次／相遇 | 沒有本種窄道接觸頻率資料 | 不可 |
| 通過時間 | 見主實驗 | 沒有 | 不可 |
| 交通（雙向） | 多隻雙向單行交通常卡住（見 #73 壓力測試） | 沒有 | 不可；顯示本版缺少整列退讓 |
| 搬運成功 | 3 mm 獵物無法通過 1.6 mm 巢口 | 本種有搬運與合作搬運的文獻（Dejean 2007 等），但沒有巢口尺寸對照 | 只驗證幾何邏輯 |
| 障礙效果 | 有牆：讓路與延遲；沒牆：無延遲 | 沒有 | 不可 |

**結論**：這是可重播、可反駁的工程實驗。它證明空間、速度與碰撞機制真的在運作，而且會改變抵達時間與先後；但它**不是**對本種行為的驗證。窄道相遇時誰讓路、等多久，都需要本種觀察資料。

## 原始結果（JSON；測試比對用）
\`\`\`json
${JSON.stringify(e, null, 1)}
\`\`\`
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(report(runExperiment()));

/**
 * Model C scientific diagnosis (docs/kin2d-model-c-diagnosis.md). Runs the pre-registered O-R133 v1 operator
 * (observe-r133.ts, settings fixed in docs/kin2d-r133-observation-operator.md BEFORE this script existed) on models
 * A/B/C, and diagnoses model C WITHOUT changing it: operator consistency, Δc (control interval) bias, linear-loop
 * analysis, signal loss, causal attribution of corrections, and a pre-declared one-at-a-time sensitivity grid
 * (diagnostic only: nothing here is calibrated or adopted). Isolated physics experiment, NOT official.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCandidates } from '../kinematics2d/lib.ts';
import { DATA_DIR } from './export.ts';
import { trailAnt, trailField, walkParams, body, countReversals, TRAIL_MM } from './lib.ts';
import { observe, V1, type CentroidSample, type Observation } from './observe-r133.ts';
import { planWalk, antennaTips, type WalkModel, type WalkParams, type WalkPlan, type WalkSpec, type SyntheticField } from '../../engine/physics/natural-walk.ts';
import { runKinematics, poseAt, type Seg, type Track, type KinResult } from '../../engine/physics/kinematics2d.ts';
import { hash32, rng } from '../../engine/rng.ts';

const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const ci = (a: number[], d = 2) => (a.length ? `${mean(a).toFixed(d)} ± ${((1.96 * sd(a)) / Math.sqrt(a.length)).toFixed(d)}` : '—');
const H = V1.thresholds_mm.map(String);

/** body-centroid samples of the EXECUTED motion (analytic pose), every dt seconds plus the end point */
export function centroids(segs: Seg[], dt = 0.005): CentroidSample[] {
  const tr: Track = { id: 'c', body: { length_mm: 1, width_mm: 1 }, segs }, tEnd = segs[segs.length - 1].t1, out: CentroidSample[] = [];
  const n = Math.ceil(tEnd / dt - 1e-9);
  for (let k = 0; k <= n; k++) { const t = Math.min(k * dt, tEnd), p = poseAt(tr, t); out.push({ t, x_mm: p.x, y_mm: p.y }); }
  return out;
}

export interface Run { spec: WalkSpec; plan: WalkPlan; res: KinResult; obs: Observation }
/** the trail scenario of docs/physics-kinematics2d.md §8 (same seeds, ids, starts), with optional overrides */
export function runSet(model: WalkModel, dir: 'out' | 'ret', over: { params?: Partial<WalkParams>; sigma_mm?: number; control_dt?: number } = {}): Run[] {
  const ts = loadCandidates().natural_walk.trail_scenario, speed = dir === 'out' ? ts.speed_outbound_mm_s.value : ts.speed_return_mm_s.value, out: Run[] = [];
  for (const seed of ts.seeds as number[]) for (let i = 0; i < ts.ants_per_seed; i++) {
    const s = seed * 10 + (dir === 'out' ? 0 : 1);
    let { plan, res, spec } = trailAnt(model, s, i, { speed, ...(over.control_dt ? { control_dt: over.control_dt } : {}) });
    if (over.params || over.sigma_mm !== undefined) {
      const f: SyntheticField | null = spec.field ? { ...(spec.field as SyntheticField), ...(over.sigma_mm !== undefined ? { sigma_mm: over.sigma_mm } : {}) } : null;
      spec = { ...spec, params: { ...spec.params, ...(over.params ?? {}) }, field: f };
      plan = planWalk(spec); res = runKinematics({ tracks: [plan.track], statics: [], horizon_s: plan.arrival_t_s ?? 60 });
    }
    out.push({ spec, plan, res, obs: observe(centroids(res.executed[plan.track.id].segs)) });
  }
  return out;
}

const cache = new Map<string, Run[]>();
const runs = (m: WalkModel, d: 'out' | 'ret') => { const k = `${m}|${d}`; if (!cache.has(k)) cache.set(k, runSet(m, d)); return cache.get(k) as Run[]; };

/** Table 1: operator results on A/B/C under every pre-declared threshold (primary resolution C05, no smoothing) */
export function operatorTable(): string {
  const out = [row(['模型', '方向', 'n', '速度 150/T (mm/s)', '平均 |d| (mm)', '峰值幅度 (mm，h=1)', '忠實度 ≤1 mm (%)', ...H.map((h) => `轉向（代理）h=${h}`), 'h=1：轉回／轉離／線上', '越線數']), row(Array(9 + H.length).fill('---'))];
  for (const m of ['A', 'B', 'C'] as const) for (const d of ['out', 'ret'] as const) {
    const r = runs(m, d).map((x) => x.obs), p = r.map((o) => o.turns.C05.S0['1']);
    out.push(row([m, d === 'out' ? '去程' : '回程', r.length, ci(r.filter((o) => o.speed_mm_s !== null).map((o) => o.speed_mm_s as number)), ci(r.map((o) => o.mean_abs_d_mm)),
      `${ci(r.filter((o) => o.peak_amp_mm !== null).map((o) => o.peak_amp_mm as number))}（n=${r.filter((o) => o.peak_amp_mm !== null).length}）`, ci(r.map((o) => o.fidelity_pct), 1),
      ...H.map((h) => ci(r.map((o) => o.turns.C05.S0[h].total), 1)), `${mean(p.map((x) => x.toward)).toFixed(1)}／${mean(p.map((x) => x.away)).toFixed(1)}／${mean(p.map((x) => x.on_line)).toFixed(1)}`, ci(p.map((x) => x.crossings), 1)]));
  }
  out.push(row(['**R133 本種**', '去程', '未報告', '18.5 ± 0.53（95% CI）', '幅度 1.1 ± 0.03（定義未明）', '（同左）', '約 42（讀圖）', '人工判讀 12.8 ± 0.25（雙向合計，sem）；讀圖約 13.0（不同量測）', '同左', '同左', '同左', '同左', '—', '—']));
  out.push(row(['**R133 本種**', '回程', '未報告', '15.5 ± 0.54', '幅度 1.7 ± 0.11', '（同左）', '約 23（讀圖）', '人工判讀，讀圖約 12.6（不同量測）', '同左', '同左', '同左', '同左', '—', '—']));
  return out.join('\n');
}

/** Table 2: observation-resolution and smoothing variants (all thresholds; model B/C, both directions) */
export function variantTable(): string {
  const out = [row(['模型', '方向', '解析度／平滑', ...H.map((h) => `h=${h}`)]), row(Array(3 + H.length).fill('---'))];
  for (const m of ['B', 'C'] as const) for (const d of ['out', 'ret'] as const) for (const [res, sm] of [['C05', 'S0'], ['C05', 'S1'], ['G5s', 'S0'], ['G5s', 'S1'], ['G5q', 'S0']] as const) {
    const r = runs(m, d).map((x) => x.obs);
    out.push(row([m, d === 'out' ? '去程' : '回程', `${res}／${sm}`, ...H.map((h) => ci(r.map((o) => o.turns[res][sm][h].total), 1))]));
  }
  return out.join('\n');
}

/** Table 3: operator consistency: old proxy (§8, δ on the 1 mm first-crossing grid) vs O-R133 at the same δ = h;
 *  and the committed 0.02 s pose stream vs the 0.005 s analytic sampling of the same run */
export function consistencyTable(): string {
  const out = [row(['比較', '模型／方向', '一致的個體數', '差值（平均）', '說明']), row(Array(5).fill('---'))];
  for (const m of ['B', 'C'] as const) for (const d of ['out', 'ret'] as const) for (const h of [0.5, 1]) {
    const r = runs(m, d);
    const old = r.map((x) => { const segs = x.res.executed[x.plan.track.id].segs, c = centroids(segs, 0.0005), ys: number[] = []; let k = 0; for (let X = 0; X <= TRAIL_MM; X++) { while (k + 1 < c.length && c[k + 1].x_mm < X) k++; const a = c[k], b = c[Math.min(k + 1, c.length - 1)], f = b.x_mm === a.x_mm ? 0 : Math.min(1, Math.max(0, (X - a.x_mm) / (b.x_mm - a.x_mm))); ys.push(a.y_mm + f * (b.y_mm - a.y_mm)); } return countReversals(ys, h); });
    const neu = r.map((x) => x.obs.turns.C05.S0[String(h)].total);
    out.push(row([`§8 舊代理 δ=${h} vs O-R133 h=${h}`, `${m}／${d === 'out' ? '去程' : '回程'}`, `${old.filter((v, i) => v === neu[i]).length}/${r.length}`, (mean(neu) - mean(old)).toFixed(2), '舊代理：1 mm 格、無死區、無合併規則、起點規則不同']));
  }
  // the committed 0.02 s pose stream (trail-following-C) vs 0.005 s analytic sampling of the same plan
  const ps = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'trail-following-C.json'), 'utf8')), ag = ps.agents[0];
  const spec: WalkSpec = { id: 'ant-1', body: body(), start: { x: 0, y: 0.8, th: 0.15 }, t0_s: 0, seed: ps.seed, params: walkParams('C'), goal_heading_rad: 0, end_x_mm: TRAIL_MM, max_duration_s: 20, statics: [], field: trailField() };
  const plan = planWalk(spec), res = runKinematics({ tracks: [plan.track], statics: [], horizon_s: Math.min(20, plan.arrival_t_s ?? 20) });
  const a = observe(ag.samples.map((q: { t: number; x_mm: number; y_mm: number }) => ({ t: q.t, x_mm: q.x_mm, y_mm: q.y_mm }))), b = observe(centroids(res.executed['ant-1'].segs));
  out.push(row(['姿態串流 0.02 s vs 解析取樣 0.005 s', 'C／trail-following-C', H.filter((h) => a.turns.C05.S0[h].total === b.turns.C05.S0[h].total).length + `/${H.length} 個門檻相同`, H.map((h) => a.turns.C05.S0[h].total - b.turns.C05.S0[h].total).join('、'), `串流 max step ${a.max_step_mm.toFixed(3)} mm；串流走完=${a.finished}、解析走完=${b.finished}；平均 |d| 差 ${(a.mean_abs_d_mm - b.mean_abs_d_mm).toExponential(1)} mm`]));
  return out.join('\n');
}

/** Table 4: control interval Δc (model C and B, outbound): numerical bias of the sampled-and-held feedback */
export function dtTable(): string {
  const out = [row(['模型', 'Δc (s)', '平均 |d| (mm)', '峰值幅度 (mm)', '忠實度 (%)', '轉向（代理）h=1', '轉向 h=0.25', '截斷次數（平均）']), row(Array(8).fill('---'))];
  for (const m of ['B', 'C'] as const) for (const dt of [0.0025, 0.005, 0.01, 0.02, 0.05, 0.1]) {
    const r = runSet(m, 'out', { control_dt: dt }), o = r.map((x) => x.obs);
    out.push(row([m, dt, ci(o.map((x) => x.mean_abs_d_mm)), ci(o.filter((x) => x.peak_amp_mm !== null).map((x) => x.peak_amp_mm as number)), ci(o.map((x) => x.fidelity_pct), 1), ci(o.map((x) => x.turns.C05.S0['1'].total), 1), ci(o.map((x) => x.turns.C05.S0['0.25'].total), 1), mean(r.map((x) => x.plan.clamps.turn_rate + x.plan.clamps.curvature)).toFixed(1)]));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- linear-loop analysis (small-signal, continuous time)
/** Lyapunov solve A P + P Aᵀ + Q = 0 (n ≤ 4) by Gaussian elimination on the vectorised system */
function lyap(A: number[][], Q: number[][]): number[][] {
  const n = A.length, N = n * n, M: number[][] = Array.from({ length: N }, () => Array(N + 1).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const r = i * n + j;
    for (let k = 0; k < n; k++) { M[r][k * n + j] += A[i][k]; M[r][i * n + k] += A[j][k]; }
    M[r][N] = -Q[i][j];
  }
  for (let c = 0; c < N; c++) {
    let p = c; for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < N; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k]; }
  }
  const P: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i][j] = M[i * n + j][N] / M[i * n + j][i * n + j];
  return P;
}
export interface LinearLoop { G: number; ell: number; a: number; omega_n: number; zeta: number; sd_y: number; mean_abs_y: number; extrema_per_150mm: number; sat_mm: number; lost_mm: number }
/** small-signal model of C around the ridge: state (y, θ, ζ); chem term −g_c·tanh(a·y_c/σ²) ≈ −G·(y + ℓθ) */
export function linearLoop(p: WalkParams, sigma: number, v: number, L: number): LinearLoop {
  const a = p.antenna_len_mm * Math.sin(p.antenna_half_angle_rad), ell = L / 2 + p.antenna_len_mm * Math.cos(p.antenna_half_angle_rad);
  const G = (p.chem_gain_rad_s * a) / (sigma * sigma), kh = p.heading_gain_per_s, tau = p.ou_tau_s, s2 = p.ou_sigma_rad_s ** 2;
  const A = [[0, v, 0], [-G, -(kh + G * ell), 1], [0, 0, -1 / tau]], Q = [[0, 0, 0], [0, 0, 0], [0, 0, (2 * s2) / tau]];
  const P = lyap(A, Q), sdy = Math.sqrt(P[0][0]);
  // Rice: extrema rate of y = (1/π)·sqrt(var(ÿ)/var(ẏ)); ẏ = vθ, ÿ = v·θ̇ with θ̇ = ζ − Gy − (kh + Gℓ)θ
  const c = [-G, -(kh + G * ell), 1], varThdot = c.reduce((s, ci, i) => s + c.reduce((t, cj, j) => t + ci * cj * P[i][j], 0), 0);
  const rate = Math.sqrt(varThdot / P[1][1]) / Math.PI, T = TRAIL_MM / v;
  const wn = Math.sqrt(G * v), z = (kh + G * ell) / (2 * wn);
  // chem term saturates (tanh = 0.96) at |y_c| = 2σ²/a; the floor dominates (cL + cR < floor) beyond σ·sqrt(2 ln(2/floor))
  return { G, ell, a, omega_n: wn, zeta: z, sd_y: sdy, mean_abs_y: sdy * Math.sqrt(2 / Math.PI), extrema_per_150mm: rate * T, sat_mm: (2 * sigma * sigma) / a, lost_mm: sigma * Math.sqrt(2 * Math.log(2 / p.chem_floor)) };
}
/** the same small-signal loop with the controller's sample-and-hold of interval Δc (exact discrete map; OU exact AR(1)):
 *  stationary SD of y at the control instants, by iterating the covariance to convergence */
export function heldLoopSdY(p: WalkParams, sigma: number, v: number, L: number, dt: number): number {
  const q = linearLoop(p, sigma, v, L), a = Math.exp(-dt / p.ou_tau_s), b2 = p.ou_sigma_rad_s ** 2 * (1 - a * a);
  // u = ζ − kh·θ − G·(y + ℓθ); θ' = θ + Δ·u; y' = y + vΔθ + vΔ²/2·u; ζ' = aζ + b·N
  const c = [-q.G, -(p.heading_gain_per_s + q.G * q.ell), 1];
  const F = [[1 + (v * dt * dt / 2) * c[0], v * dt + (v * dt * dt / 2) * c[1], (v * dt * dt / 2) * c[2]], [dt * c[0], 1 + dt * c[1], dt * c[2]], [0, 0, a]];
  let P = [[0, 0, 0], [0, 0, 0], [0, 0, p.ou_sigma_rad_s ** 2]];
  const mul = (X: number[][], Y: number[][]) => X.map((r) => Y[0].map((_, j) => r.reduce((s, x, k) => s + x * Y[k][j], 0)));
  const T = (X: number[][]) => X[0].map((_, j) => X.map((r) => r[j]));
  for (let it = 0; it < 200000; it++) {
    const N = mul(mul(F, P), T(F)); N[2][2] += b2;
    const diff = Math.abs(N[0][0] - P[0][0]); P = N;
    if (!Number.isFinite(P[0][0])) return Infinity;
    if (diff < 1e-15 && it > 100) break;
  }
  return Math.sqrt(P[0][0]);
}
export function heldTable(): string {
  const p = walkParams('C'), f = trailField(), L = body().length_mm as number, v = loadCandidates().natural_walk.trail_scenario.speed_outbound_mm_s.value;
  const out = [row(['Δc (s)', '線性迴路（取樣保持）SD(y) (mm)', '相對連續時間', '平均 |y| (mm，高斯)']), row(Array(4).fill('---'))];
  const c0 = linearLoop(p, f.sigma_mm, v, L).sd_y;
  out.push(row(['0（連續）', c0.toFixed(3), '1.000', (c0 * Math.sqrt(2 / Math.PI)).toFixed(3)]));
  for (const dt of [0.0025, 0.005, 0.01, 0.02, 0.05, 0.1]) { const s = heldLoopSdY(p, f.sigma_mm, v, L, dt); out.push(row([dt, s.toFixed(3), (s / c0).toFixed(3), (s * Math.sqrt(2 / Math.PI)).toFixed(3)])); }
  return out.join('\n');
}
export function linearTable(): string {
  const p = walkParams('C'), f = trailField(), L = body().length_mm as number, ts = loadCandidates().natural_walk.trail_scenario;
  const out = [row(['方向', 'v (mm/s)', '有效橫向增益 G (rad/s/mm)', '觸角前伸 ℓ (mm)', '半間距 a (mm)', 'ω_n (rad/s)', '阻尼比', '線性預測 SD(y) (mm)', '線性預測平均 |y| (mm)', 'Rice 極值數／150 mm', '飽和 |y_c| (mm)', '訊號消失 |y_c| (mm)']), row(Array(12).fill('---'))];
  for (const [d, v] of [['去程', ts.speed_outbound_mm_s.value], ['回程', ts.speed_return_mm_s.value]] as const) {
    const q = linearLoop(p, f.sigma_mm, v, L);
    out.push(row([d, v, q.G.toFixed(3), q.ell.toFixed(3), q.a.toFixed(3), q.omega_n.toFixed(2), q.zeta.toFixed(2), q.sd_y.toFixed(2), q.mean_abs_y.toFixed(2), q.extrema_per_150mm.toFixed(1), q.sat_mm.toFixed(2), q.lost_mm.toFixed(2)]));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- signal loss and causal attribution (model C)
function normal(r: () => number): number { const u1 = 1 - r(), u2 = r(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); }
const wrapPi = (x: number) => { let y = x % (2 * Math.PI); if (y <= -Math.PI) y += 2 * Math.PI; if (y > Math.PI) y -= 2 * Math.PI; return y; };
export interface Decomp { t0: number; t1: number; noise: number; heading: number; chem: number; w: number; clamped: boolean; cl: number; cr: number }
/** re-derive the three terms of every control interval from the plan's own record and the agent's named stream.
 *  Returns null components if the reconstruction does not reproduce the executed ω (it must, bit for bit, when unclamped). */
export function decompose(run: Run): { d: Decomp[]; mismatches: number } {
  const p = run.spec.params, R = rng(hash32(`${run.spec.seed}|kin2d.walk|${run.spec.id}`)), a = Math.exp(-p.control_dt_s / p.ou_tau_s), b = p.ou_sigma_rad_s * Math.sqrt(1 - a * a);
  let zeta = p.ou_sigma_rad_s * normal(R), mism = 0;
  const out: Decomp[] = [], segs = run.plan.track.segs.filter((s) => Number.isFinite(s.t1));
  segs.forEach((s, k) => {
    const sm = run.plan.sensor_samples[k], hd = -p.heading_gain_per_s * wrapPi(s.p0.th - run.spec.goal_heading_rad);
    const ch = (p.chem_gain_rad_s * (sm.left.c - sm.right.c)) / (sm.left.c + sm.right.c + p.chem_floor), raw = zeta + hd + ch;
    const cap = Math.min(p.max_turn_rate_rad_s, p.max_curvature_per_mm * s.tw.v), clamped = Math.abs(raw) > cap;
    if ((clamped ? Math.sign(raw) * cap : raw) !== s.tw.w || sm.t !== s.t0) mism++;
    out.push({ t0: s.t0, t1: s.t1, noise: zeta, heading: hd, chem: ch, w: s.tw.w, clamped, cl: sm.left.c, cr: sm.right.c });
    zeta = a * zeta + b * normal(R);
  });
  return { d: out, mismatches: mism };
}
export function mechanismTable(): string {
  const out = [row(['方向', '控制區間數', '重建不一致', 'RMS 雜訊項 (rad/s)', 'RMS 方向記憶項', 'RMS 化學項', '截斷比例 (%)', '訊號消失比例 (%)：c_L + c_R < floor', '每隻消失比例 vs 平均 |d| 的相關係數', 'h=1 轉回事件：化學項同號且最大 (%)', '雜訊項最大 (%)', '方向記憶項最大 (%)', '轉離事件：雜訊項最大 (%)']), row(Array(13).fill('---'))];
  for (const d of ['out', 'ret'] as const) {
    const r = runs('C', d); let n = 0, mism = 0, sN = 0, sH = 0, sC = 0, cl = 0, lost = 0; const perLost: number[] = [], perDev: number[] = [];
    const tw = { chem: 0, noise: 0, heading: 0, n: 0 }, aw = { noise: 0, n: 0 };
    for (const x of r) {
      const { d: dc, mismatches } = decompose(x); mism += mismatches; let l = 0;
      for (const q of dc) { n++; sN += q.noise ** 2; sH += q.heading ** 2; sC += q.chem ** 2; if (q.clamped) cl++; if (q.cl + q.cr < x.spec.params.chem_floor) { lost++; l++; } }
      perLost.push(l / dc.length); perDev.push(x.obs.mean_abs_d_mm);
      // events: control interval that contains the extremum time
      const segs = x.res.executed[x.plan.track.id].segs, c = centroids(segs);
      for (const e of x.obs.turns.C05.S0['1'].events) {
        if (e.cls === 'on_line') continue;
        const k = c.findIndex((q) => q.x_mm >= e.s_mm), te = c[Math.max(0, k)].t, q = dc.find((z) => z.t0 <= te && te < z.t1) ?? dc[dc.length - 1];
        const want = e.cls === 'toward' ? -Math.sign(e.d_mm) : Math.sign(e.d_mm); // the sign of ω that turns toward (away from) the centre
        const terms = { chem: q.chem * want, noise: q.noise * want, heading: q.heading * want };
        const top = (Object.entries(terms) as [keyof typeof terms, number][]).sort((u, v) => v[1] - u[1])[0][0];
        if (e.cls === 'toward') { tw.n++; tw[top]++; } else { aw.n++; if (top === 'noise') aw.noise++; }
      }
    }
    const mx = mean(perLost), my = mean(perDev), cov = perLost.reduce((s, v, i) => s + (v - mx) * (perDev[i] - my), 0), corr = cov / Math.sqrt(perLost.reduce((s, v) => s + (v - mx) ** 2, 0) * perDev.reduce((s, v) => s + (v - my) ** 2, 0));
    const pc = (k: number, m: number) => (m ? ((100 * k) / m).toFixed(1) : '—');
    out.push(row([d === 'out' ? '去程' : '回程', n, mism, Math.sqrt(sN / n).toFixed(3), Math.sqrt(sH / n).toFixed(3), Math.sqrt(sC / n).toFixed(3), pc(cl, n), pc(lost, n), corr.toFixed(2), pc(tw.chem, tw.n), pc(tw.noise, tw.n), pc(tw.heading, tw.n), `${pc(aw.noise, aw.n)}（n=${aw.n}）`]));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- pre-declared one-at-a-time sensitivity (diagnostic only)
/** grid fixed in docs/kin2d-model-c-diagnosis.md §5 before running; NOT a calibration, nothing is adopted */
export const OAT: { name: string; key: keyof WalkParams | 'sigma_mm'; values: number[] }[] = [
  { name: '合成場寬度 σ (mm)', key: 'sigma_mm', values: [0.15, 0.5, 2.0] },
  { name: '化學增益 g_c (rad/s)', key: 'chem_gain_rad_s', values: [1.5, 6] },
  { name: 'OU 雜訊 σ_ζ (rad/s)', key: 'ou_sigma_rad_s', values: [0.75, 3] },
  { name: 'OU 相關時間 τ (s)', key: 'ou_tau_s', values: [0.1, 1.0] },
  { name: '方向記憶增益 k_h (1/s)', key: 'heading_gain_per_s', values: [0, 4] },
  { name: '觸角半角 (rad)', key: 'antenna_half_angle_rad', values: [0.25, 1.0] },
];
export function oatTable(): string {
  const out = [row(['改變的參數（其餘為基準）', '值', '平均 |d| (mm)', '峰值幅度 (mm)', '忠實度 (%)', '轉向（代理）h=0.5', 'h=1', 'h=2.5', '同時落在 R133 去程區間？']), row(Array(9).fill('---'))];
  const line = (name: string, v: string, o: Observation[]) => {
    const md = mean(o.map((x) => x.mean_abs_d_mm)), fid = mean(o.map((x) => x.fidelity_pct)), t1 = mean(o.map((x) => x.turns.C05.S0['1'].total));
    // R133 outbound reference ranges for this check (stated, not targets): amplitude 1.1 ± 0.03 → [0.5, 2] mm loose band; fidelity ≈ 42 % → [30, 55] %; turns 12.8 → [10, 16]
    const inside = md >= 0.5 && md <= 2 && fid >= 30 && fid <= 55 && t1 >= 10 && t1 <= 16;
    out.push(row([name, v, ci(o.map((x) => x.mean_abs_d_mm)), ci(o.filter((x) => x.peak_amp_mm !== null).map((x) => x.peak_amp_mm as number)), ci(o.map((x) => x.fidelity_pct), 1), ci(o.map((x) => x.turns.C05.S0['0.5'].total), 1), ci(o.map((x) => x.turns.C05.S0['1'].total), 1), ci(o.map((x) => x.turns.C05.S0['2.5'].total), 1), inside ? '是（僅診斷）' : '否']));
  };
  line('基準（未改）', '—', runs('C', 'out').map((x) => x.obs));
  for (const g of OAT) for (const v of g.values) {
    const r = g.key === 'sigma_mm' ? runSet('C', 'out', { sigma_mm: v }) : runSet('C', 'out', { params: { [g.key]: v } as Partial<WalkParams> });
    line(g.name, String(v), r.map((x) => x.obs));
  }
  return out.join('\n');
}

export function allDiagnosisTables(): Record<string, string> {
  return { operator: operatorTable(), variants: variantTable(), consistency: consistencyTable(), dt: dtTable(), held: heldTable(), linear: linearTable(), mechanism: mechanismTable(), oat: oatTable() };
}
export { antennaTips };
if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  const all: Record<string, () => string> = { operator: operatorTable, variants: variantTable, consistency: consistencyTable, dt: dtTable, held: heldTable, linear: linearTable, mechanism: mechanismTable, oat: oatTable };
  for (const [k, f] of Object.entries(all)) if (!only || only === k) { const t0 = Date.now(); console.log(`<!-- ${k} -->\n${f()}\n`); console.error(`${k}: ${Date.now() - t0} ms`); }
}

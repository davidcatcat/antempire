/**
 * KIN-2D numeric tables for docs/physics-kinematics2d.md. Deterministic (no timings). `node prototypes/kinematics2d/measure.ts`
 * prints them; tests/kin2d-kinematics.test.ts asserts the document contains them verbatim.
 */
import { advancePose, capsuleAt, capGap, dimsOf, PlanBuilder, poseAt, runKinematics, type Pose, type Static, type Track, type Twist, type KinInput } from '../../engine/physics/kinematics2d.ts';
import { solve2D } from '../../engine/physics/solver2d.ts';
import { laneBoundary } from '../../engine/physics/body2d.ts';
import { bodies, corridor, integrate, sampledFirstContact, sampledMinGap, toRecord } from './lib.ts';
import { checkRecord } from '../kinematics2d-check/check.ts';

const e = (x: number | null, d = 1) => (x === null ? '—' : x === 0 ? '0' : x.toExponential(d).replace('e', '×10^'));
const f = (x: number | null, d = 3) => (x === null ? '—' : x.toFixed(d));
const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`;

export function convergenceTable(): string {
  const p0: Pose = { x: 0, y: 0, th: 0 }, tw: Twist = { v: 17, vl: 0, w: 3 }, T = 2, ex = advancePose(p0, tw, T);
  const out = [row(['Δt (s)', 'Euler 位置誤差 (mm)', 'Euler 階數', 'RK4 位置誤差 (mm)', 'RK4 階數']), row(['---', '---', '---', '---', '---'])];
  let pe: number | null = null, pr: number | null = null, pd: number | null = null;
  for (const dt of [0.1, 0.01, 0.001, 0.0001]) {
    const a = integrate(p0, tw, T, dt, 'euler'), b = integrate(p0, tw, T, dt, 'rk4');
    const ee = Math.hypot(a.x - ex.x, a.y - ex.y), er = Math.hypot(b.x - ex.x, b.y - ex.y);
    const oe = pe && pd ? Math.log10(pe / ee) / Math.log10(pd / dt) : null, or = pr && pd ? Math.log10(pr / er) / Math.log10(pd / dt) : null;
    out.push(row([dt, e(ee), oe === null ? '—' : oe.toFixed(2), e(er), or === null || er < 1e-12 ? '—（捨入）' : or.toFixed(2)]));
    pe = ee; pr = er; pd = dt;
  }
  return out.join('\n');
}

export function uTurnTable(): string {
  const { L, widths } = bodies(), out = [row(['寬 w (mm)', '通道 W (mm)', '解析接觸角 φc (rad)', 'KIN-2D 停止角 (rad)', 'φc − 停止角 (rad)', '獨立檢查：違規／未證', '平移模型（PH-3b）']), row(['---', '---', '---', '---', '---', '---', '---'])];
  for (const w of widths) for (const W of [1.6, 2.0, 2.4, 2.6]) {
    const body = { length_mm: L, width_mm: w }, h = (L - w) / 2, r = w / 2, om = 3;
    const tr = new PlanBuilder('A', body, { x: 0, y: 0, th: 0 }).pivot(Math.PI, om).build(), input: KinInput = { tracks: [tr], statics: corridor(W), horizon_s: 2 };
    const res = runKinematics(input), st = res.executed.A.stopped_at_s, chk = checkRecord(toRecord(input, res));
    const phi = W / 2 - r < h ? Math.asin((W / 2 - r) / h) : null;
    out.push(row([w, W, phi === null ? '無接觸（W ≥ L）' : phi.toFixed(9), st === null ? '完成 π' : (st * om).toFixed(9), phi === null || st === null ? '—' : e(phi - st * om), `${chk.violations.length}／${chk.uncertified}`, '不支援（方向固定，無迴轉）']));
  }
  return out.join('\n');
}

export function wallPivotTable(): string {
  const { L, widths } = bodies(), w = widths[1], body = { length_mm: L, width_mm: w }, h = (L - w) / 2, r = w / 2;
  const out = [row(['離牆間隙 (mm)', 'ω (rad/s)', '解析接觸時刻 (s)', 'KIN-2D 停止時刻 (s)', '差 (s)', '固定步長 Δt=0.1 / 0.01 / 0.001 s 偵測時刻 (s)']), row(['---', '---', '---', '---', '---', '---'])];
  for (const gap0 of [0.05, 0.2, 0.5]) for (const om of [1, 3, 10]) {
    const wall: Static[] = [{ id: 'wall', kind: 'segment', a: { x: -10, y: r + gap0 }, b: { x: 10, y: r + gap0 } }];
    const tr = new PlanBuilder('A', body, { x: 0, y: 0, th: 0 }).pivot(Math.PI / 2, om).build(), res = runKinematics({ tracks: [tr], statics: wall, horizon_s: 5 });
    const tc = Math.asin(gap0 / h) / om, st = res.executed.A.stopped_at_s;
    const fs = [0.1, 0.01, 0.001].map((dt) => sampledFirstContact(tr, wall, 0, Math.PI / 2 / om, dt));
    out.push(row([gap0, om, tc.toFixed(9), st === null ? '—' : st.toFixed(9), st === null ? '—' : e(tc - st), fs.map((x) => (x === null ? '漏失' : x.toFixed(4))).join(' / ')]));
  }
  return out.join('\n');
}

/** tunnelling: a thin post (r = 0.02 mm) inside the swept annulus of a fast pivot */
export function tunnelTable(): string {
  const { L, widths } = bodies(), w = widths[1], body = { length_mm: L, width_mm: w }, h = (L - w) / 2, r = w / 2, rho = h + r - 0.05, ang = Math.PI / 4;
  const post: Static[] = [{ id: 'post', kind: 'disc', c: { x: rho * Math.cos(ang), y: rho * Math.sin(ang) }, r: 0.02 }];
  const out = [row(['ω (rad/s)', 'KIN-2D（連續）', ...[0.1, 0.03, 0.01, 0.001].map((d) => `固定步長 Δt=${d} s`)]), row(['---', '---', '---', '---', '---', '---'])];
  for (const om of [3, 10, 30]) {
    const tr = new PlanBuilder('A', body, { x: 0, y: 0, th: 0 }).pivot(Math.PI / 2, om).build(), res = runKinematics({ tracks: [tr], statics: post, horizon_s: 5 });
    const st = res.executed.A.stopped_at_s;
    out.push(row([om, st === null ? '漏失' : `停於 ${(st * om).toFixed(4)} rad`, ...[0.1, 0.03, 0.01, 0.001].map((dt) => { const x = sampledFirstContact(tr, post, 0, Math.PI / 2 / om, dt); return x === null ? '**漏失（穿隧）**' : `${(x * om).toFixed(4)} rad`; })]));
  }
  return out.join('\n');
}

/** two ants turning past each other: rotating collider vs a collider that keeps its initial heading (sprite-only turn) */
export function passTable(): string {
  const { L, widths } = bodies(), w = widths[1], body = { length_mm: L, width_mm: w }, d = dimsOf(body, 'x'), v = 17;
  const out = [row(['情境', '參數 s (mm)', '計畫運動最小間隙：會轉的碰撞體 (mm)', '計畫運動最小間隙：不轉的碰撞體 (mm)', 'KIN-2D 事件', '獨立檢查：違規／未證']), row(['---', '---', '---', '---', '---', '---'])];
  const emit = (name: string, s: number, A: Track, B: Track, thA: number, thB: number, T: number, M: number) => {
    const n = 200000, bound = (M * T) / n / 2;
    const gR = sampledMinGap((t) => poseAt(A, t), d, (t) => poseAt(B, t), d, 0, T, n), gF = sampledMinGap((t) => ({ ...poseAt(A, t), th: thA }), d, (t) => ({ ...poseAt(B, t), th: thB }), d, 0, T, n);
    const input: KinInput = { tracks: [A, B], statics: [], horizon_s: T }, res = runKinematics(input), chk = checkRecord(toRecord(input, res));
    const ev = res.events.filter((x) => x.class !== 'motion').map((x) => `${x.kind}@${x.t_s.toFixed(4)}`).join('，') || '無接觸';
    out.push(row([name, s, `${gR.toFixed(4)}（取樣，±${bound.toExponential(0)}）`, gF.toFixed(4), ev, `${chk.violations.length}／${chk.uncertified}`]));
  };
  // (a) both swerve by piecewise arcs (right a, left 2a, right a; R = 4 mm) while passing head-on; s = initial lateral offset
  for (const s of [-2.6, -2.0, -1.5]) {
    const R = 4, a = 0.6, mk = (id: string, x: number, y: number, th: number) => new PlanBuilder(id, body, { x, y, th }).straight(4, v).arcAngle(-a, R, v).arcAngle(2 * a, R, v).arcAngle(-a, R, v).straight(4, v).build();
    const A = mk('A', -12, -s / 2, 0), B = mk('B', 12, s / 2, Math.PI), T = A.segs[A.segs.length - 1].t0;
    emit('雙方以圓弧閃避（S 形）', s, A, B, 0, Math.PI, T, 2 * (v + (v / R) * d.h));
  }
  // (b) A turns in place by π/2 (ω = 3 rad/s) while B walks past at lateral distance s
  for (const s of [1.0, 1.4, 1.8, 2.2]) {
    const A = new PlanBuilder('A', body, { x: 0, y: 0, th: 0 }).pivot(Math.PI / 2, 3).build(), B = new PlanBuilder('B', body, { x: -8, y: s, th: 0 }).straight(16, v).build(), T = 16 / v;
    emit('A 原地轉身、B 走過', s, A, B, 0, 0, T, v + 3 * d.h);
  }
  return out.join('\n');
}

/** detour arc around a disc vs the same waypoints as a polyline with instant heading changes (PH-3b convention) */
export function detourTable(): string {
  const { L, widths } = bodies(), w = widths[1], body = { length_mm: L, width_mm: w }, d = dimsOf(body, 'x'), v = 17;
  const out = [row(['轉彎半徑 R (mm)', '偏轉角 (rad)', '圓弧路徑：最小間隙 (mm)', '折線＋瞬間轉向：最小間隙 (mm)', '圓弧：KIN-2D 事件']), row(['---', '---', '---', '---', '---'])];
  for (const [R, a] of [[2, 0.5], [4, 0.5], [4, 0.8]] as const) {
    const tr = new PlanBuilder('A', body, { x: 0, y: 0, th: 0 }).straight(3, v).arcAngle(a, R, v).straight(3, v).arcAngle(-2 * a, R, v).straight(3, v).arcAngle(a, R, v).straight(3, v).build();
    const T = tr.segs[tr.segs.length - 1].t0, mid = poseAt(tr, T / 2);
    const cen = { x: mid.x, y: mid.y - 2.2 }, stone = { a: cen, b: cen, r: 1.5 }, disc: Static[] = [{ id: 'stone', kind: 'disc', c: cen, r: 1.5 }];
    // polyline through the arc end points; heading = chord direction, switched instantly at vertices
    const vs = tr.segs.slice(0, -1).map((s) => s.p0).concat([poseAt(tr, T)]);
    let poly = Infinity;
    for (let i = 0; i + 1 < vs.length; i++) { const a0 = vs[i], b0 = vs[i + 1], th = Math.atan2(b0.y - a0.y, b0.x - a0.x); for (let k = 0; k <= 2000; k++) { const u = k / 2000, c = capsuleAt({ x: a0.x + u * (b0.x - a0.x), y: a0.y + u * (b0.y - a0.y), th }, d); poly = Math.min(poly, capGap(c, stone).g); } }
    let arc = Infinity; for (let k = 0; k <= 20000; k++) { const c = capsuleAt(poseAt(tr, (T * k) / 20000), d); arc = Math.min(arc, capGap(c, stone).g); }
    const res = runKinematics({ tracks: [tr], statics: disc, horizon_s: T });
    out.push(row([R, a, arc.toFixed(4), poly.toFixed(4), res.events.filter((x) => x.class !== 'motion').map((x) => `${x.kind}@${x.t_s.toFixed(4)}`).join('，') || '無接觸']));
  }
  return out.join('\n');
}

/** L-shaped lane: PH-3b (instant turn at the joint) vs KIN-2D pivot with finite ω and an arc turn, same lane boundary */
export function cornerTable(): string {
  const { L, widths } = bodies(), w = widths[1], body = { length_mm: L, width_mm: w }, v = 17;
  const out = [row(['車道寬 W (mm)', 'PH-3b：結果／抵達 (s)', 'KIN-2D 轉角原地轉 ω=3：結果／抵達 (s)', 'KIN-2D 轉角原地轉 ω=10', 'KIN-2D 圓弧 R=1.25 mm']), row(['---', '---', '---', '---', '---'])];
  for (const W of [1.0, 1.5, 2.0, 3.0]) {
    const lane = { id: 'P', centerline_mm: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], width_mm: W, layer: 'z=0' };
    const ph = solve2D({ lanes: [lane], obstacles: [], agents: [{ id: 'A', lane: 'P', s_mm: 5, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: 35, free_speed_mm_s: v, body }], horizon_s: 10 });
    const pa = ph.agents.A, phTxt = pa.arrival_t_s !== null ? `抵達／${pa.arrival_t_s.toFixed(4)}` : `${pa.final_mode}（${pa.stop_cause ?? ''}）`;
    // same boundary for KIN-2D: lane-edge segments, arcs as fine chords (the chords cut the outer arc by < 2e-4 mm)
    const statics: Static[] = [];
    laneBoundary(lane).forEach((b, i) => {
      if (b.kind === 'seg') { if (!b.end) statics.push({ id: `e${i}`, kind: 'segment', a: b.p, b: b.q }); return; }
      let t1 = b.th1; while (t1 < b.th0) t1 += 2 * Math.PI;
      const n = 64; for (let k = 0; k < n; k++) { const a0 = b.th0 + ((t1 - b.th0) * k) / n, a1 = b.th0 + ((t1 - b.th0) * (k + 1)) / n; statics.push({ id: `e${i}-${k}`, kind: 'segment', a: { x: b.c.x + b.R * Math.cos(a0), y: b.c.y + b.R * Math.sin(a0) }, b: { x: b.c.x + b.R * Math.cos(a1), y: b.c.y + b.R * Math.sin(a1) } }); }
    });
    const runK = (tr: Track) => { const r = runKinematics({ tracks: [tr], statics, horizon_s: 10 }), ex = r.executed.A, end = r.final.A; return ex.stopped_at_s !== null ? `碰牆停止@${ex.stopped_at_s.toFixed(4)}` : `抵達／${tr.segs[tr.segs.length - 1].t0.toFixed(4)}（終點 ${end.x.toFixed(2)}, ${end.y.toFixed(2)}）`; };
    const piv = (om: number) => new PlanBuilder('A', body, { x: 5, y: 0, th: 0 }).straight(15, v).pivot(Math.PI / 2, om).straight(15, v).build();
    const Rr = 1.25, arc = new PlanBuilder('A', body, { x: 5, y: 0, th: 0 }).straight(15 - Rr, v).arcAngle(Math.PI / 2, Rr, v).straight(15 - Rr, v).build();
    let k3: string, k10: string, ka: string;
    try { k3 = runK(piv(3)); k10 = runK(piv(10)); ka = runK(arc); } catch (err) { k3 = k10 = ka = `拒絕：${(err as Error).message}`; }
    out.push(row([W, phTxt, k3, k10, ka]));
  }
  return out.join('\n');
}

export function allTables(): Record<string, string> {
  return { convergence: convergenceTable(), uturn: uTurnTable(), wallpivot: wallPivotTable(), tunnel: tunnelTable(), pass: passTable(), detour: detourTable(), corner: cornerTable() };
}
if (import.meta.url === `file://${process.argv[1]}`) for (const [k, v] of Object.entries(allTables())) console.log(`<!-- ${k} -->\n${v}\n`);

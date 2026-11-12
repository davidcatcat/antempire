/**
 * KIN-2D ↔ PH-3b shared-scenario comparison harness, phase 2 (docs/physics-shared-contract.md). Isolated physics
 * experiment, NOT official. Runs every scenario both solvers can express through engine/physics/shared-contract.ts
 * adapters (neither solver is modified) and checks agreement within the stated error bounds. Scenarios one solver
 * cannot express are listed, not approximated. CPU time and heap are measured only when run as a script (they are
 * machine-dependent and never part of the verbatim tables).
 */
import { runBoth, sharedPoseAt, toKin2DInput, fromKin2DProjected, ACCELERATION_RESERVED, ERROR_BOUNDS, CAPABILITIES, type SharedScenario, type SharedAgentSpec, type SharedRunRecord, type SharedLane } from '../../engine/physics/shared-contract.ts';
import { runKinematicsWithContactMode } from '../../engine/physics/kinematics2d-contact.ts';

const BODY = { shape: 'capsule' as const, length_mm: 2.5, width_mm: 0.8 }; // R94 length; width = candidate (game assumption), as in KIN-2D
const lane = (id: string, x0: number, y0: number, x1: number, y1: number, w: number): SharedLane => ({ id, layer: 'ground', centerline: [{ x_mm: x0, y_mm: y0 }, { x_mm: x1, y_mm: y1 }], width_mm: w });
const ag = (id: string, ln: string, dir: 1 | -1, s: number, goal: number, v: number, u = 0, start = 0): SharedAgentSpec => ({ id, body: { ...BODY }, lane: ln, dir, s_mm: s, goal_s_mm: goal, u_mm: u, start_t_s: start, speed_mm_s: v });
const scn = (id: string, H: number, lanes: SharedLane[], agents: SharedAgentSpec[], extra: Partial<SharedScenario> = {}): SharedScenario => ({ schema: 'antempire.physics-scenario.v1', id, time: { unit: 's', t0_s: 0, horizon_s: H }, lanes, obstacles: [], agents, lane_edges_as_walls: false, acceleration: { ...ACCELERATION_RESERVED }, ...extra });

export interface ScenarioEntry { id: string; title: string; supported: 'both' | 'kin2d_only' | 'ph3b_only'; expect: 'agree' | 'differ_by_model'; why: string; scenario: SharedScenario | null }
export function scenarios(): ScenarioEntry[] {
  const traffic: SharedAgentSpec[] = [], lanes: SharedLane[] = [];
  for (let k = 0; k < 20; k++) {
    lanes.push(lane(`T${k}`, 0, 5 * k, 80, 5 * k, 4));
    const pass = k % 3 === 0; // every third lane: lateral offsets ±0.6 mm (gap 0.4 mm, no contact)
    traffic.push(ag(`t${String(k).padStart(2, '0')}a`, `T${k}`, 1, 0, 80, 12 + (k % 5), pass ? 0.6 : 0), ag(`t${String(k).padStart(2, '0')}b`, `T${k}`, -1, 80, 0, 10 + (k % 7), pass ? -0.6 : 0, 0.1 * (k % 4)));
  }
  return [
    { id: 'straight', title: '直線單隻', supported: 'both', expect: 'agree', why: '兩者都是等速直線平移', scenario: scn('straight', 8, [lane('L', 0, 0, 100, 0, 4)], [ag('a', 'L', 1, 0, 100, 18.5)]) },
    { id: 'narrow-lane', title: '窄路（寬 1.0 mm，身體寬 0.8 mm）', supported: 'both', expect: 'agree', why: 'PH-3b 用路線邊界；KIN-2D 以兩條牆線段表示同一邊界', scenario: scn('narrow-lane', 8, [lane('L', 0, 0, 100, 0, 1.0)], [ag('a', 'L', 1, 0, 100, 18.5)], { lane_edges_as_walls: true }) },
    { id: 'stone', title: '路線上的石頭（圓）', supported: 'both', expect: 'agree', why: '兩者都在身體首次碰到圓時停下', scenario: scn('stone', 6, [lane('L', 0, 0, 100, 0, 6)], [ag('a', 'L', 1, 0, 100, 18.5)], { obstacles: [{ id: 'stone', layer: 'ground', kind: 'disc', center: { x_mm: 50, y_mm: 0.3 }, radius_mm: 1.0 }] }) },
    { id: 'two-ant-meeting', title: '兩隻對向相遇（同一中線）', supported: 'both', expect: 'agree', why: '接觸時兩者都停（PH-3b：最大速度解為 0；KIN-2D：接觸即停）', scenario: scn('two-ant-meeting', 6, [lane('L', 0, 0, 60, 0, 4)], [ag('a', 'L', 1, 0, 60, 18.5), ag('b', 'L', -1, 60, 0, 15.5)]) },
    { id: 'two-ant-pass', title: '兩隻對向錯身（橫向偏移 ±0.6 mm）', supported: 'both', expect: 'agree', why: '間隙 0.4 mm，不接觸', scenario: scn('two-ant-pass', 6, [lane('L', 0, 0, 60, 0, 4)], [ag('a', 'L', 1, 0, 60, 18.5, 0.6), ag('b', 'L', -1, 60, 0, 15.5, -0.6)]) },
    { id: 'rear-end', title: '追撞（快跟慢）', supported: 'both', expect: 'differ_by_model', why: '接觸後的約束模型不同：PH-3b 跟隨者降到前者速度繼續走；KIN-2D 接觸即凍結（兩者都不是行為模型）', scenario: scn('rear-end', 10, [lane('L', 0, 0, 100, 0, 4)], [ag('lead', 'L', 1, 20, 100, 10), ag('follow', 'L', 1, 0, 100, 18.5)]) },
    { id: 'mass-traffic', title: '大量交通（20 條平行路線 × 對向 2 隻，部分錯身、延遲出發）', supported: 'both', expect: 'agree', why: '同上，逐對比較', scenario: scn('mass-traffic', 10, lanes, traffic) },
    { id: 'arc', title: '圓弧', supported: 'kin2d_only', expect: 'agree', why: 'PH-3b 路線是折線，沒有曲線運動', scenario: null },
    { id: 'in-place-rotation', title: '原地轉身', supported: 'kin2d_only', expect: 'agree', why: 'PH-3b 在折點瞬間轉向，不花時間', scenario: null },
    { id: 'polyline-joint', title: '折線路線的轉角', supported: 'ph3b_only', expect: 'agree', why: 'KIN-2D 沒有「瞬間轉向」；要用原地轉或圓弧，是不同的運動', scenario: null },
    { id: 'lateral-steering', title: '橫向轉向／側移／回頭', supported: 'kin2d_only', expect: 'agree', why: 'PH-3b 的橫向偏移 u 固定、方向固定', scenario: null },
  ];
}

export interface Agreement { scenario: string; agents: number; arrival_max_dt_s: number | null; contact_pairs: number; contact_max_dt_s: number | null; contact_tol_s: number | null; pose_max_dpos_mm: number; pose_tol_mm: number; stop_max_dt_s: number | null; ok: boolean; notes: string[] }
const closing = (s: SharedScenario, ids: string[]) => { const v = ids.map((i) => s.agents.find((a) => a.id === i)?.speed_mm_s ?? 0); return v.length === 2 && ids.every((i) => s.agents.some((a) => a.id === i)) ? Math.abs(v[0] * (s.agents.find((a) => a.id === ids[0])!.dir) - v[1] * (s.agents.find((a) => a.id === ids[1])!.dir)) : v[0]; };
export function compare(s: SharedScenario, r: { kin2d: SharedRunRecord; ph3b: SharedRunRecord }): Agreement {
  const K = r.kin2d, P = r.ph3b, notes: string[] = [];
  const gapTol = ERROR_BOUNDS.kin2d.contact_gap_mm[1] + ERROR_BOUNDS.ph3b.contact_gap_mm[1] + ERROR_BOUNDS.kin2d.position_mm + ERROR_BOUNDS.ph3b.position_mm;
  let arr: number | null = null, cdt: number | null = null, ctol: number | null = null, sdt: number | null = null, dpos = 0, ok = true;
  for (const a of s.agents) {
    const k = K.agents.find((x) => x.id === a.id)!, p = P.agents.find((x) => x.id === a.id)!;
    if ((k.arrival_t_s === null) !== (p.arrival_t_s === null)) { ok = false; notes.push(`${a.id}: arrival ${k.arrival_t_s} vs ${p.arrival_t_s}`); }
    else if (k.arrival_t_s !== null) arr = Math.max(arr ?? 0, Math.abs(k.arrival_t_s - (p.arrival_t_s as number)));
    if ((k.stopped_at_s === null) !== (p.stopped_at_s === null)) { ok = false; notes.push(`${a.id}: stop ${k.stopped_at_s} vs ${p.stopped_at_s}`); }
    else if (k.stopped_at_s !== null) sdt = Math.max(sdt ?? 0, Math.abs(k.stopped_at_s - (p.stopped_at_s as number)));
    for (let i = 0; i <= 200; i++) { const t = (s.time.horizon_s * i) / 200, q1 = sharedPoseAt(k, t), q2 = sharedPoseAt(p, t); dpos = Math.max(dpos, Math.hypot(q1.x_mm - q2.x_mm, q1.y_mm - q2.y_mm)); }
  }
  // contact starts: body–body pairs (KIN ids sorted; PH-3b sorted) and body–static (KIN contact_start with a static id ↔ PH-3b geometry_stop)
  const kc = K.contact_events.filter((e) => e.kind === 'contact_start'), pc = P.contact_events.filter((e) => e.kind === 'contact_start' || e.kind === 'geometry_stop');
  const key = (ids: string[]) => [...ids].sort().join('|');
  if (kc.length !== pc.length) { ok = false; notes.push(`contact count ${kc.length} vs ${pc.length}`); }
  for (const e of kc) {
    const m = pc.find((x) => key(x.ids) === key(e.ids));
    if (!m) { ok = false; notes.push(`no PH-3b match for ${key(e.ids)}`); continue; }
    const v = closing(s, e.ids), tol = gapTol / v + 1e-12 * Math.max(1, e.t_s);
    cdt = Math.max(cdt ?? 0, Math.abs(e.t_s - m.t_s)); ctol = Math.max(ctol ?? 0, tol);
    if (Math.abs(e.t_s - m.t_s) > tol) { ok = false; notes.push(`${key(e.ids)}: contact time differs by ${Math.abs(e.t_s - m.t_s)} > ${tol}`); }
  }
  const vmax = Math.max(...s.agents.map((a) => a.speed_mm_s)), poseTol = gapTol + vmax * (ctol ?? 0) + 1e-9;
  if (dpos > poseTol) { ok = false; notes.push(`姿態差 ${dpos.toPrecision(3)} mm`); }
  if (arr !== null && arr > 1e-9) { ok = false; notes.push(`arrival differs by ${arr} s`); }
  if (sdt !== null && ctol !== null && sdt > ctol) { ok = false; notes.push(`停止時刻差 ${sdt.toPrecision(3)} s`); }
  return { scenario: s.id, agents: s.agents.length, arrival_max_dt_s: arr, contact_pairs: kc.length, contact_max_dt_s: cdt, contact_tol_s: ctol, pose_max_dpos_mm: dpos, pose_tol_mm: poseTol, stop_max_dt_s: sdt, ok, notes };
}

const e = (x: number | null) => (x === null ? '—' : x === 0 ? '0' : x.toExponential(1));
export function comparisonTable(): string {
  const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`;
  const out = [row(['情境', '支援', '預期', '螞蟻數', '接觸數（KIN／PH-3b）', '求解器自身事件計數（定義不同）KIN／PH-3b', '抵達時刻最大差 (s)', '接觸時刻最大差 (s)／容許', '姿態最大差 (mm)／容許', '結果', '說明']), row(Array(11).fill('---'))];
  for (const x of scenarios()) {
    if (!x.scenario) { out.push(row([x.title, x.supported === 'kin2d_only' ? '只有 KIN-2D' : '只有 PH-3b', '—', '—', '—', '—', '—', '—', '—', '不比較', x.why])); continue; }
    const r = runBoth(x.scenario), c = compare(x.scenario, r);
    const kcn = r.kin2d.contact_events.filter((q) => q.kind === 'contact_start').length, pcn = r.ph3b.contact_events.filter((q) => q.kind === 'contact_start' || q.kind === 'geometry_stop').length;
    const verdict = x.expect === 'agree' ? (c.ok ? '一致（在誤差界內）' : '**不一致**') : (c.ok ? '**意外一致**' : '依模型不同（預期）');
    out.push(row([x.title, '兩者', x.expect === 'agree' ? '一致' : '模型不同', c.agents, `${kcn}／${pcn}`, `${r.kin2d.event_count}／${r.ph3b.event_count}`, e(c.arrival_max_dt_s), `${e(c.contact_max_dt_s)}／${e(c.contact_tol_s)}`, `${e(c.pose_max_dpos_mm)}／${e(c.pose_tol_mm)}`, verdict, x.expect === 'agree' ? x.why : `${x.why}；${c.notes.slice(0, 2).join('；')}`]));
  }
  return out.join('\n');
}
export function capabilityTable(): string {
  const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`, keys = Object.keys(CAPABILITIES.kin2d) as (keyof typeof CAPABILITIES.kin2d)[];
  return [row(['能力', 'KIN-2D', 'PH-3b']), row(['---', '---', '---']), ...keys.map((k) => row([k, CAPABILITIES.kin2d[k] ? '有' : '無', CAPABILITIES.ph3b[k] ? '有' : '無']))].join('\n');
}

// ---------------------------------------------------------------- Owner decision 42: contact-response comparison
/** KIN-2D in the opt-in 'project' contact mode (shared physical constraint contract), as a shared record */
export function runKin2DProjected(s: SharedScenario): SharedRunRecord { const ki = toKin2DInput(s); return fromKin2DProjected(s, ki, runKinematicsWithContactMode(ki, 'project')); }
export interface ContactModeEntry { id: string; title: string; scenario: SharedScenario; expect_projected: 'agree' | 'differ_by_model'; why: string }
export function contactModeScenarios(): ContactModeEntry[] {
  const base = scenarios(), get = (id: string) => base.find((x) => x.id === id)!.scenario as SharedScenario;
  return [
    { id: 'rear-end', title: '追撞（快跟慢；終點 100 mm）', scenario: get('rear-end'), expect_projected: 'differ_by_model', why: 'KIN-2D 計畫是「依時間」的指令（直線段在原定時刻結束），被減速的跟隨者不會補回距離；PH-3b 依終點行走' },
    { id: 'rear-end-far', title: '追撞（終點在時限外）', scenario: scn('rear-end-far', 10, [lane('L', 0, 0, 400, 0, 4)], [ag('lead', 'L', 1, 20, 400, 10), ag('follow', 'L', 1, 0, 400, 18.5)]), expect_projected: 'agree', why: '兩者都在時限內行走：跟隨者的速度被約束成前者的速度（同一個物理約束）' },
    { id: 'two-ant-meeting', title: '兩隻對向相遇', scenario: get('two-ant-meeting'), expect_projected: 'agree', why: '兩者都在接近：各自移除自己的接近分量 → 都停' },
    { id: 'stone', title: '路線上的石頭（圓）', scenario: get('stone'), expect_projected: 'differ_by_model', why: 'KIN-2D 可沿圓周側滑（2-D 約束）；PH-3b 的橫向偏移固定（1-D），只能停' },
    { id: 'mass-traffic', title: '大量交通（40 隻）', scenario: get('mass-traffic'), expect_projected: 'agree', why: '同中線對向相遇都停；錯身不接觸' },
  ];
}
export function contactModeTable(): string {
  const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`;
  const out = [row(['情境', 'KIN-2D 凍結（基準）vs PH-3b', 'KIN-2D 投影約束（新，選用）vs PH-3b', '預期（投影）', '投影：接觸數／停止數／側滑段', '說明']), row(Array(6).fill('---'))];
  for (const x of contactModeScenarios()) {
    const both = runBoth(x.scenario), proj = runKin2DProjected(x.scenario);
    const cf = compare(x.scenario, both), cp = compare(x.scenario, { kin2d: proj, ph3b: both.ph3b });
    const verdict = (c: Agreement) => (c.ok ? '一致（在誤差界內）' : `不同：${c.notes.slice(0, 2).join('；')}`);
    const nC = proj.contact_events.filter((e) => e.kind === 'contact_start').length, nS = proj.contact_events.filter((e) => e.kind === 'stop_on_contact').length, nF = proj.motion_events.filter((e) => e.kind === 'follow').length;
    out.push(row([x.title, verdict(cf), verdict(cp), x.expect_projected === 'agree' ? '一致' : '模型不同', `${nC}／${nS}／${nF}`, x.why]));
  }
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(capabilityTable() + '\n\n' + comparisonTable() + '\n\n' + contactModeTable());
  // machine-dependent cost (not in the verbatim tables)
  const mt = scenarios().find((x) => x.id === 'mass-traffic')!.scenario!;
  const g = globalThis as unknown as { gc?: () => void };
  for (let rep = 0; rep < 2; rep++) {
    const h0 = process.memoryUsage().heapUsed, t0 = performance.now(), r = runBoth(mt), t1 = performance.now();
    console.log(`mass-traffic run ${rep}: CPU wall ${(t1 - t0).toFixed(1)} ms (both solvers), heap Δ ${((process.memoryUsage().heapUsed - h0) / 1e6).toFixed(1)} MB, events KIN ${r.kin2d.event_count} / PH-3b ${r.ph3b.event_count}`);
    g.gc?.();
  }
}

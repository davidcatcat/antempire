/**
 * Placeholder pose streams (示意・待 PR A 物理資料) for the natural-walk viewing page, shaped exactly like
 * antempire.pose-stream.v1 so the page can be built before the physics export (PR A) exists. Deterministic (seeded),
 * NOT physics: simple kinematic curves written only so the four scenes have something to draw. Every file is marked
 * params.placeholder = true and its label says 示意・待 PR A 物理資料. Real files dropped into data/ replace them.
 *   node prototypes/natural-walk/make-placeholder.ts
 * Speeds / corrections are only loosely inspired by the P. megacephala lab trail summary (R133: ~15.5–18.5 mm/s,
 * path deviation ~1.1–1.7 mm, ~12.8 corrections per 150 mm); they are NOT a model of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSE_SCHEMA, validatePoseStream, type PoseSample, type PoseStream } from './pose-stream.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'placeholder');
const DT = 0.02;
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** integrate a speed / turn-rate program into samples (unicycle kinematics, explicit Euler at DT) */
function integrate(T: number, x0: number, y0: number, th0: number, ctl: (t: number, s: { x: number; y: number; th: number }) => { v: number; w: number }): PoseSample[] {
  const out: PoseSample[] = []; let x = x0, y = y0, th = th0;
  for (let i = 0; i * DT <= T + 1e-9; i++) {
    const t = i * DT, c = ctl(t, { x, y, th });
    out.push({ t: r4(t), x_mm: r4(x), y_mm: r4(y), theta: r4(th), v_mm_s: r4(c.v), omega_rad_s: r4(c.w) });
    x += c.v * Math.cos(th) * DT; y += c.v * Math.sin(th) * DT; th = wrap(th + c.w * DT);
  }
  return out;
}
const ramp = (t: number, a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const base = (id: string, label: string, seed: number, params: Record<string, unknown>): Omit<PoseStream, 'agents'> => ({
  schema: POSE_SCHEMA, scenario_id: id, label: `${label}（示意・待 PR A 物理資料）`, seed, model: 'A', dt_record_s: DT,
  params: { placeholder: true, note: '示意・待 PR A 物理資料：簡單運動學曲線，不是物理模擬', ...params }, obstacles: [], chem_field: null,
});

const files: Record<string, PoseStream> = {};
// ① straight: start from rest, walk 150 mm in a straight line, stop
{
  const V = 17, T = 11.5;
  files['straight'] = { ...base('placeholder-straight', '直線行走', 1, { speed_mm_s: V }), agents: [{ id: 'P1', samples: integrate(T, 0, 0, 0, (t) => ({ v: V * ramp(t, 0.8, 1.1) * (1 - ramp(t, 10.0, 10.3)), w: 0 })), events: [{ t: 0.8, kind: 'placeholder_start', detail: '示意' }, { t: 10.3, kind: 'placeholder_stop', detail: '示意' }] }] };
}
// ② trail: a gently curving trail; heading corrections as sparse impulses toward the trail centre plus small noise
{
  const r = mulberry32(2), V = 17, T = 12, trail: [number, number][] = [];
  for (let x = -10; x <= 220; x += 5) trail.push([x, 6 * Math.sin(x / 45)]);
  const yAt = (x: number) => 6 * Math.sin(x / 45);
  let nextKick = 0.6, kick = 0, kickUntil = 0;
  const samples = integrate(T, 0, 0.8, 0.05, (t, s) => {
    if (t >= nextKick) { const lateral = s.y - yAt(s.x), want = Math.atan2(Math.cos(s.x / 45) * 6 / 45, 1) - Math.max(-0.3, Math.min(0.3, 0.12 * lateral)); kick = (wrap(want - s.th) + (r() - 0.5) * 0.25) / 0.12; kickUntil = t + 0.12; nextKick = t + 0.45 + r() * 0.5; }
    return { v: V * ramp(t, 0.3, 0.6) * (1 - ramp(t, 11.2, 11.5)), w: t < kickUntil ? kick : 0 };
  });
  files['trail'] = { ...base('placeholder-trail', '沿費洛蒙路徑', 2, { speed_mm_s: V }), agents: [{ id: 'P2', samples, events: [] }], chem_field: { kind: 'trail_polyline', points_mm: trail, half_width_mm: 2.5 } };
}
// ③ explore: correlated random walk with variable speed and two pauses, no trail
{
  const r = mulberry32(3), T = 16; let w = 0, wTarget = 0, nextW = 0;
  const pauses: [number, number][] = [[5.0, 6.3], [11.0, 12.1]];
  const samples = integrate(T, 0, 0, 0.4, (t) => {
    if (t >= nextW) { wTarget = (r() - 0.5) * 3.2; nextW = t + 0.25 + r() * 0.6; }
    w += (wTarget - w) * 0.15;
    const paused = pauses.some(([a, b]) => t >= a && t < b), v = paused ? 0 : 10 * ramp(t, 0.3, 0.6) * (1 + 0.3 * Math.sin(t * 1.3 + 0.7));
    return { v, w: paused ? 0 : w };
  });
  files['explore'] = { ...base('placeholder-explore', '探索未知區域', 3, { mode: 'explore' }), agents: [{ id: 'P3', samples, events: pauses.map(([a]) => ({ t: a, kind: 'placeholder_pause', detail: '示意' })) }] };
}
// ④ obstacle: walk toward a round stone, turn away when close, skirt it, turn back to the original course
{
  const V = 15.5, T = 13, O = { id: 'stone', x_mm: 70, y_mm: 2, r_mm: 12 };
  const samples = integrate(T, 0, 0, 0, (t, s) => {
    const dx = s.x - O.x_mm, dy = s.y - O.y_mm, d = Math.hypot(dx, dy) - O.r_mm;
    let want = 0;
    if (d < 6 && s.x < O.x_mm) { const n = Math.atan2(dy, dx), t1 = n + Math.PI / 2, t2 = n - Math.PI / 2; want = Math.cos(t1) > Math.cos(t2) ? t1 : t2; } // skirt the stone along its tangent
    else if (s.x >= O.x_mm) want = -Math.max(-0.4, Math.min(0.4, 0.04 * s.y)); // back toward the original course
    const w = Math.max(-2.2, Math.min(2.2, wrap(want - s.th) * 3));
    const slow = d < 6 ? 0.65 : 1;
    return { v: V * slow * ramp(t, 0.3, 0.6) * (1 - ramp(t, 12.4, 12.7)), w };
  });
  files['obstacle'] = { ...base('placeholder-obstacle', '接近障礙物並轉向', 4, { speed_mm_s: V }), obstacles: [O], agents: [{ id: 'P4', samples, events: [] }] };
}

fs.mkdirSync(DIR, { recursive: true });
for (const [k, s] of Object.entries(files)) {
  const bad = validatePoseStream(s); if (bad.length) throw Error(`${k}: ${bad.join('; ')}`);
  fs.writeFileSync(path.join(DIR, `${k}.json`), JSON.stringify(s) + '\n');
}
fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({ placeholder: true, note: '示意・待 PR A 物理資料', files: Object.keys(files).map((k) => `${k}.json`) }, null, 1) + '\n');
console.log(`wrote ${Object.keys(files).length} placeholder pose streams to ${path.relative(process.cwd(), DIR)}`);

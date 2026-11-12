/**
 * Side-by-side comparison streams for the natural-walk page: the SAME scene run once per motion model (A straight
 * baseline, B natural candidate, C chemical-field candidate) with PR A's physics code UNCHANGED (#163, 6fe6f26:
 * prototypes/natural-walk/lib.ts, engine/physics/natural-walk.ts, engine/physics/kinematics2d.ts). Each model runs
 * alone (own runKinematics call, same ant ID and seed, so the noise stream is the same draw); C only where a field
 * exists (PR A refuses C without one, and that refusal is recorded instead of invented).
 * This file runs only on a tree that contains PR A (it imports PR A's lib.ts); it is excluded from this branch's
 * typecheck. Output: prototypes/natural-walk/data/compare/<slot>.json (antempire.pose-stream.v1, model 'mixed').
 *   node prototypes/natural-walk/compare/compare-export.ts   (from the PR A tree)
 * Isolated physics experiment, NOT official; writes nothing outside that data folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LABEL, TRAIL_MM, body, paramsDoc, streamAgent, trailField, walkParams } from '../lib.ts';
import { planWalk, type WalkModel, type WalkSpec } from '../../../engine/physics/natural-walk.ts';
import { runKinematics, type Static } from '../../../engine/physics/kinematics2d.ts';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'compare');
const dt = 0.02, seed = 7, b = body();
const scenes: { slot: string; models: WalkModel[]; spec: (m: WalkModel) => WalkSpec; statics: Static[]; field: ReturnType<typeof trailField> | null; set: 'baseline' | 'exploration'; H: number }[] = [
  { slot: 'straight', models: ['A', 'B'], statics: [], field: null, set: 'baseline', H: 20, spec: (m) => ({ id: 'ant-1', body: b, start: { x: 0, y: 0, th: 0 }, t0_s: 0, seed, params: walkParams(m), goal_heading_rad: 0, end_x_mm: TRAIL_MM, max_duration_s: 20, statics: [], field: null }) },
  { slot: 'trail', models: ['A', 'B', 'C'], statics: [], field: trailField(), set: 'baseline', H: 20, spec: (m) => ({ id: 'ant-1', body: b, start: { x: 0, y: 0.8, th: m === 'A' ? 0 : 0.15 }, t0_s: 0, seed, params: walkParams(m), goal_heading_rad: 0, end_x_mm: TRAIL_MM, max_duration_s: 20, statics: [], field: trailField() }) },
  { slot: 'explore', models: ['A', 'B'], statics: [], field: null, set: 'exploration', H: 12, spec: (m) => ({ id: 'ant-1', body: b, start: { x: 0, y: 0, th: 0 }, t0_s: 0, seed, params: walkParams(m, {}, 'exploration'), goal_heading_rad: 0, end_x_mm: null, max_duration_s: 12, statics: [], field: null }) },
  { slot: 'obstacle', models: ['A', 'B'], statics: [{ id: 'stone', kind: 'disc', c: { x: 25, y: 0.6 }, r: 3 }], field: null, set: 'baseline', H: 15, spec: (m) => ({ id: 'ant-1', body: b, start: { x: 0, y: 0, th: 0 }, t0_s: 0, seed, params: walkParams(m), goal_heading_rad: 0, end_x_mm: 60, max_duration_s: 15, statics: [{ id: 'stone', kind: 'disc', c: { x: 25, y: 0.6 }, r: 3 }], field: null }) },
];
fs.mkdirSync(OUT, { recursive: true });
for (const sc of scenes) {
  const agents = [], params: Record<string, unknown> = {};
  for (const m of sc.models) {
    const spec = sc.spec(m), plan = planWalk(spec);
    const res = runKinematics({ tracks: [plan.track], statics: sc.statics, horizon_s: Math.min(sc.H, plan.arrival_t_s ?? sc.H) });
    agents.push({ ...streamAgent(plan, res, m, dt), id: `ant-1-${m}` }); params[m] = paramsDoc(spec.params, sc.set);
  }
  const notes = ['同一場景、同一隻（同 ID 與種子）分別以模型 A／B／C 各跑一次（互不影響），由 PR A 物理程式（6fe6f26）原樣產生。',
    ...(sc.models.includes('C') ? [] : ['模型 C 需要化學場；本場景沒有化學場，PR A 拒絕執行 C（Kin2DRefused），所以沒有 C。'])];
  const s = { schema: 'antempire.pose-stream.v1', scenario_id: `compare-${sc.slot}`, label: LABEL, seed, model: 'mixed', dt_record_s: dt, params, agents, obstacles: sc.statics, chem_field: sc.field ? { ...sc.field, label: '合成濃度場（synthetic: true）；不是費洛蒙模型，CHEM 尚未接入' } : null, notes };
  fs.writeFileSync(path.join(OUT, `${sc.slot}.json`), JSON.stringify(s, null, 1) + '\n');
}
console.log(`wrote ${scenes.length} comparison streams to ${OUT}`);

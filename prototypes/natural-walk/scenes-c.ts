/**
 * Model C in every viewing scene (Owner decision 46; docs/kin2d-model-c-scenes.md). Isolated physics experiment, NOT
 * official. Each scene declares its chemical field EXPLICITLY:
 *  - trail scene: the synthetic Gaussian ridge (signal PRESENT) and, as controls, the explicit ZERO-signal field and NO
 *    field at all (signal ABSENT: model C must refuse, never fall back);
 *  - straight, exploration and obstacle scenes have no chemical signal: model C runs on the explicit ZERO-signal field.
 *    No attractive field is invented so that C can run.
 * Models A and B are kept unchanged and run on the same starts and seeds. Writes prototypes/natural-walk/data/model-c-scenes/
 * (`--check`: regenerate in memory and require byte-identical files). Parameters: the candidate file, unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { loadCandidates } from '../kinematics2d/lib.ts';
import { planWalk, ZERO_SIGNAL_FIELD, type WalkModel, type WalkSpec, type WalkPlan, type WalkParams } from '../../engine/physics/natural-walk.ts';
import { runKinematics, poseAt, type Static, type KinResult, type Track } from '../../engine/physics/kinematics2d.ts';
import type { SyntheticZero } from '../../engine/physics/local-sensing.ts';
import { hash32, rng } from '../../engine/rng.ts';
import { walkParams, trailField, body, LABEL, streamAgent, paramsDoc, TRAIL_MM } from './lib.ts';

export const SCENES_DIR = path.join(REPO_ROOT, 'prototypes/natural-walk/data/model-c-scenes');
export type FieldDecl = { kind: 'gaussian_ridge'; note: string } | { kind: 'zero_signal'; note: string } | { kind: 'absent'; note: string };
export type Variant = { label: string; model: WalkModel; field: FieldDecl };
export interface SceneDef { id: string; title: string; params_set: 'baseline' | 'exploration'; end_x_mm: number | null; max_duration_s: number; statics: Static[]; scene_signal: 'present' | 'none'; variants: Variant[] }

const ZERO: FieldDecl = { kind: 'zero_signal', note: '明確的零訊號對照場（synthetic: true；處處為 0）' };
const RIDGE: FieldDecl = { kind: 'gaussian_ridge', note: '合成高斯脊（synthetic: true；不是費洛蒙模型）' };
const ABSENT: FieldDecl = { kind: 'absent', note: '沒有任何化學場：模型 C 必須拒絕執行（不得退回）' };
const NONE: FieldDecl = { kind: 'absent', note: '模型 A／B 不感測化學' };
export function sceneDefs(): SceneDef[] {
  const ab: Variant[] = [{ label: 'A', model: 'A', field: NONE }, { label: 'B', model: 'B', field: NONE }];
  return [
    { id: 'trail', title: '人工路線（150 mm，R133 幾何）', params_set: 'baseline', end_x_mm: TRAIL_MM, max_duration_s: 60, statics: [], scene_signal: 'present', variants: [...ab, { label: 'C／訊號存在', model: 'C', field: RIDGE }, { label: 'C／零訊號', model: 'C', field: ZERO }, { label: 'C／無訊號', model: 'C', field: ABSENT }] },
    { id: 'straight', title: '直線（150 mm，無化學訊號）', params_set: 'baseline', end_x_mm: TRAIL_MM, max_duration_s: 60, statics: [], scene_signal: 'none', variants: [...ab, { label: 'C／零訊號', model: 'C', field: ZERO }, { label: 'C／無訊號', model: 'C', field: ABSENT }] },
    { id: 'exploration', title: '自由探索（12 s，探索參數，無化學訊號）', params_set: 'exploration', end_x_mm: null, max_duration_s: 12, statics: [], scene_signal: 'none', variants: [...ab, { label: 'C／零訊號', model: 'C', field: ZERO }, { label: 'C／無訊號', model: 'C', field: ABSENT }] },
    { id: 'obstacle', title: '前方障礙（圓石，終點 60 mm，無化學訊號）', params_set: 'baseline', end_x_mm: 60, max_duration_s: 15, statics: [{ id: 'stone', kind: 'disc', c: { x: 25, y: 0.6 }, r: 3 }], scene_signal: 'none', variants: [...ab, { label: 'C／零訊號', model: 'C', field: ZERO }, { label: 'C／無訊號', model: 'C', field: ABSENT }] },
  ];
}

export interface RunOut { refused: string | null; plan: WalkPlan | null; res: KinResult | null; spec: WalkSpec }
export function runOne(sc: SceneDef, v: Variant, seed: number, idx: number): RunOut {
  const ts = loadCandidates().natural_walk.trail_scenario, id = `ant-${String(idx).padStart(2, '0')}`;
  const R = rng(hash32(`${seed}|kin2d.start|${id}`)), y0 = (2 * R() - 1) * ts.start_offset_mm.value, th0 = (2 * R() - 1) * ts.start_heading_rad.value;
  // exploration uses the exploration parameter set for B and C (A is the straight baseline in every scene)
  const p: WalkParams = walkParams(v.model, {}, sc.params_set === 'exploration' && v.model !== 'A' ? 'exploration' : 'baseline');
  const field = v.field.kind === 'gaussian_ridge' ? trailField() : v.field.kind === 'zero_signal' ? (ZERO_SIGNAL_FIELD as SyntheticZero) : null;
  const spec: WalkSpec = { id, body: body(), start: { x: 0, y: y0, th: v.model === 'A' ? 0 : th0 }, t0_s: 0, seed, params: p, goal_heading_rad: 0, end_x_mm: sc.end_x_mm, max_duration_s: sc.max_duration_s, statics: sc.statics, field: v.model === 'C' ? field : null };
  let plan: WalkPlan;
  try { plan = planWalk(spec); } catch (e) { return { refused: (e as Error).message, plan: null, res: null, spec }; }
  const res = runKinematics({ tracks: [plan.track], statics: sc.statics, horizon_s: plan.arrival_t_s ?? sc.max_duration_s });
  return { refused: null, plan, res, spec };
}

interface M { arrived: boolean; along_speed: number | null; mean_abs_y: number; path_mm: number; net_mm: number; pivots: number; body_stops: number; signal_frac: number | null; turn_rate_rms: number; digest: string }
function metrics(sc: SceneDef, r: RunOut): M {
  const plan = r.plan as WalkPlan, res = r.res as KinResult, ex = res.executed[plan.track.id], segs = ex.segs;
  const tr: Track = { id: 'm', body: plan.track.body, segs: [...segs, { t0: segs[segs.length - 1].t1, t1: Infinity, p0: res.final[plan.track.id], tw: { v: 0, vl: 0, w: 0 }, label: 'hold' }] };
  const tEnd = segs[segs.length - 1].t1, n = Math.max(1, Math.ceil(tEnd / 0.005));
  let sy = 0; for (let i = 0; i <= n; i++) sy += Math.abs(poseAt(tr, (tEnd * i) / n).y);
  let path = 0, w2 = 0, dur = 0; for (const s of segs) { path += Math.hypot(s.tw.v, s.tw.vl) * (s.t1 - s.t0); w2 += s.tw.w * s.tw.w * (s.t1 - s.t0); dur += s.t1 - s.t0; }
  const p0 = r.spec.start, p1 = res.final[plan.track.id];
  const ss = plan.sensor_samples, floor = r.spec.params.chem_floor;
  return {
    arrived: plan.arrival_t_s !== null && ex.stopped_at_s === null, along_speed: plan.arrival_t_s !== null && sc.end_x_mm !== null && ex.stopped_at_s === null ? sc.end_x_mm / plan.arrival_t_s : null,
    mean_abs_y: sy / (n + 1), path_mm: path, net_mm: Math.hypot(p1.x - p0.x, p1.y - p0.y),
    pivots: plan.events.filter((e) => e.kind === 'antenna_contact_pivot').length, body_stops: res.events.filter((e) => e.kind === 'stop_on_contact').length,
    signal_frac: plan.sensing ? (ss.length ? ss.filter((s) => s.left.c + s.right.c >= floor).length / ss.length : 0) : null,
    turn_rate_rms: dur > 0 ? Math.sqrt(w2 / dur) : 0,
    digest: crypto.createHash('sha256').update(JSON.stringify(plan.track.segs)).digest('hex').slice(0, 16),
  };
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const ci = (a: number[]) => { const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); return 1.96 * sd / Math.sqrt(a.length); };
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const stat = (a: number[]) => (a.length ? { mean: r4(mean(a)), ci95: r4(ci(a)), n: a.length } : null);

export function buildSummary() {
  const ts = loadCandidates().natural_walk.trail_scenario, seeds = ts.seeds as number[], per = ts.ants_per_seed as number;
  const scenes = sceneDefs().map((sc) => {
    const byVariant: Record<string, { runs: RunOut[]; m: M[] }> = {};
    const variants = sc.variants.map((v) => {
      const runs: RunOut[] = [];
      for (const seed of seeds) for (let i = 0; i < per; i++) runs.push(runOne(sc, v, seed * 100 + hash32(sc.id) % 97, i));
      const okRuns = runs.filter((r) => !r.refused), m = okRuns.map((r) => metrics(sc, r));
      byVariant[v.label] = { runs, m };
      const refusals = [...new Set(runs.filter((r) => r.refused).map((r) => r.refused as string))];
      return {
        label: v.label, model: v.model, field: v.field, runs: runs.length, refused: runs.length - okRuns.length, refusal_messages: refusals,
        metrics: okRuns.length ? {
          arrival_rate: r4(m.filter((x) => x.arrived).length / m.length), along_speed_mm_s: stat(m.filter((x) => x.along_speed !== null).map((x) => x.along_speed as number)),
          mean_abs_y_mm: stat(m.map((x) => x.mean_abs_y)), path_mm: stat(m.map((x) => x.path_mm)), net_displacement_mm: stat(m.map((x) => x.net_mm)),
          turn_rate_rms_rad_s: stat(m.map((x) => x.turn_rate_rms)), antenna_pivots: stat(m.map((x) => x.pivots)), body_contact_stops: stat(m.map((x) => x.body_stops)),
          sensed_signal_fraction: m[0].signal_frac === null ? null : stat(m.map((x) => x.signal_frac as number)),
        } : null,
      };
    });
    // identity of C on the zero-signal field with B (same seeds, same starts): count of bit-identical plans
    const cz = byVariant['C／零訊號'], b = byVariant.B;
    const identical = cz && b ? cz.m.filter((x, i) => x.digest === b.m[i].digest).length : null;
    const ridge = byVariant['C／訊號存在'];
    const diffRidge = ridge && b ? ridge.m.filter((x, i) => x.digest !== b.m[i].digest).length : null;
    return { id: sc.id, title: sc.title, scene_signal: sc.scene_signal, params_set: sc.params_set, end_x_mm: sc.end_x_mm, max_duration_s: sc.max_duration_s, obstacles: sc.statics, variants, c_zero_vs_b_bit_identical: identical === null ? null : `${identical}/${cz.m.length}`, c_signal_vs_b_differs: diffRidge === null ? null : `${diffRidge}/${ridge.m.length}` };
  });
  return {
    schema: 'antempire.model-c-scenes.v1', label: LABEL, generator: 'prototypes/natural-walk/scenes-c.ts',
    notes: ['隔離物理實驗・非正式。', '每個場景的化學場都明確宣告；沒有化學訊號的場景用零訊號對照場，不為了讓 C 能跑而編造吸引訊號。', '所有參數 assumption:true（候選參數檔，未調整）。', '種子：試驗種子 × 100 + 場景代碼；與 §8／診斷的種子集合不同。'],
    scenes,
  };
}
/** one representative C pose stream per scene (seed 7, ant-00), labelled; the field kind is recorded */
export function buildStreams() {
  return sceneDefs().map((sc) => {
    const v = sc.variants.find((x) => x.model === 'C' && x.field.kind !== 'absent') as Variant, r = runOne(sc, v, 7, 0);
    const plan = r.plan as WalkPlan, res = r.res as KinResult;
    return { schema: 'antempire.pose-stream.v1', scenario_id: `model-c-${sc.id}`, label: LABEL, seed: 7, model: 'C', dt_record_s: 0.02, params: paramsDoc(r.spec.params, sc.params_set === 'exploration' ? 'exploration' : 'baseline'), agents: [streamAgent(plan, res, 'C', 0.02)], obstacles: sc.statics, chem_field: v.field.kind === 'gaussian_ridge' ? { ...trailField(), label: '合成濃度場（synthetic: true）；不是費洛蒙模型' } : { synthetic: true, kind: 'zero_signal', label: '零訊號對照場（synthetic: true；處處為 0；本場景沒有化學訊號）' }, notes: [`場景 ${sc.title}；化學場：${v.field.note}`, 'samples 是引擎姿態在格點上的取樣；格點之間的畫面插值不是物理。'] };
  });
}
export function serialised(): Record<string, string> {
  const out: Record<string, string> = { 'summary.json': JSON.stringify(buildSummary(), null, 1) + '\n' };
  for (const s of buildStreams()) out[`${s.scenario_id}.json`] = JSON.stringify(s, null, 1) + '\n';
  return out;
}
const fmt = (s: { mean: number; ci95: number } | null, d = 2) => (s ? `${s.mean.toFixed(d)} ± ${s.ci95.toFixed(d)}` : '—');
export function scenesTable(summary = buildSummary()): string {
  const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`;
  const out = [row(['場景', '變體（化學場）', '執行／拒絕', '完成率', '平均 |y| (mm)', '行走距離 (mm)', '淨位移 (mm)', 'RMS 角速度 (rad/s)', '觸角接觸轉身（次）', '感到訊號的控制區間比例']), row(Array(10).fill('---'))];
  for (const sc of summary.scenes) for (const v of sc.variants) {
    const m = v.metrics;
    out.push(row([sc.title, `${v.label}（${v.field.kind}）`, `${v.runs - v.refused}／${v.refused}`, m ? m.arrival_rate.toFixed(2) : '—', m ? fmt(m.mean_abs_y_mm) : '—', m ? fmt(m.path_mm, 1) : '—', m ? fmt(m.net_displacement_mm, 1) : '—', m ? fmt(m.turn_rate_rms_rad_s) : '—', m ? fmt(m.antenna_pivots) : '—', m && m.sensed_signal_fraction ? fmt(m.sensed_signal_fraction) : '—']));
  }
  return out.join('\n');
}
export function identityTable(summary = buildSummary()): string {
  const row = (c: (string | number)[]) => `| ${c.join(' | ')} |`;
  return [row(['場景', '場景中的化學訊號', 'C（零訊號）與 B 逐位元相同的計畫', 'C（訊號存在）與 B 不同的計畫', 'C（無訊號）']), row(Array(5).fill('---')), ...summary.scenes.map((sc) => {
    const ab = sc.variants.find((v) => v.field.kind === 'absent' && v.model === 'C');
    return row([sc.title, sc.scene_signal === 'present' ? '有（合成脊）' : '無', sc.c_zero_vs_b_bit_identical ?? '—', sc.c_signal_vs_b_differs ?? '—', ab ? `拒絕 ${ab.refused}/${ab.runs}` : '—']);
  })].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = serialised(), check = process.argv.includes('--check');
  let bad = 0;
  if (!check) fs.mkdirSync(SCENES_DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(SCENES_DIR, name);
    if (check) { const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; if (cur !== text) { bad++; console.error(`DIFFERS: ${name}`); } }
    else fs.writeFileSync(p, text);
  }
  const summary = JSON.parse(files['summary.json']);
  console.log(scenesTable(summary) + '\n\n' + identityTable(summary));
  if (check && bad) process.exit(1);
  console.log(check ? `model-C scene data identical (${Object.keys(files).length})` : `wrote ${Object.keys(files).length} files to ${path.relative(REPO_ROOT, SCENES_DIR)}`);
}

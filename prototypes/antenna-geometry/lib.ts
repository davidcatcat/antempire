/**
 * ANTENNA-GEO prototype helpers (docs/antenna-geometry.md): loads the antenna candidate file, builds species-mode and
 * candidate-mode inputs, and the scenarios used by the tests and the sensitivity analysis. Isolated physics experiment,
 * NOT official; nothing here is connected to a biological decision.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { resolveModel, type AntennaModel, type AntennaModelInput, type AntennaParams, type ScanParams, type Param, type MorphologyConstraint, type AntennaContactInput } from '../../engine/physics/antenna-geometry.ts';
import { PlanBuilder, runKinematics, type Static, type Track, type BodyDims, type KinResult } from '../../engine/physics/kinematics2d.ts';

export const LABEL = '隔離物理實驗・非正式・候選參數';
export const CANDIDATES_PATH = 'scenarios/physics/pheidole-megacephala.antenna-candidates.json';
export function loadAntennaCandidates(): any { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CANDIDATES_PATH), 'utf8')); }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** candidate-mode input (explicit), with optional numeric overrides (sensitivity only; labels kept) */
export function candidateInput(over: Partial<Record<string, number>> = {}): AntennaModelInput {
  const c = loadAntennaCandidates(), params = clone(c.candidate_minor.params) as AntennaParams, scan = clone(c.candidate_minor.scan) as ScanParams;
  for (const [k, v] of Object.entries(over)) {
    const p = ((params as Record<string, Param>)[k] ?? (scan as Record<string, Param>)[k]);
    if (!p) throw new Error(`unknown parameter ${k}`);
    p.value = v as number; p.basis = '遊戲假設'; p.note = `${p.note}（敏感度覆寫）`;
  }
  return { mode: 'candidate', params, scan, constraints: c.constraints_minor as MorphologyConstraint[] };
}
/** species-mode input: the species values as recorded (unknowns are null) */
export function speciesInput(): AntennaModelInput {
  const c = loadAntennaCandidates();
  const all = clone(c.species_params) as Record<string, Param>;
  const params = {} as Record<string, Param>, scan = {} as Record<string, Param>;
  for (const [k, v] of Object.entries(all)) (k.startsWith('scan_') ? scan : params)[k] = v;
  return { mode: 'species', params: params as AntennaParams, scan: scan as ScanParams, constraints: c.constraints_minor };
}
export const candidateModel = (over: Partial<Record<string, number>> = {}): AntennaModel => resolveModel(candidateInput(over));
export function candidateBody(): BodyDims { const b = loadAntennaCandidates().candidate_minor.body; return { length_mm: b.length_mm, width_mm: b.width_mm }; }

// ---------------------------------------------------------------- scenarios (geometry tests and sensitivity)
export interface Scenario { name: string; input: AntennaContactInput; note: string; kin: KinResult }
/** standard scenario set: walking toward a wall, walking past a post, two ants head-on, an ant passing a stationary ant */
/** body motion is first resolved by kinematics2d (bodies stop on geometric contact); antenna contacts are then found on
 *  the EXECUTED body motion. Returns the antenna-contact input and the kinematics2d result (geometric_contact source). */
export function executed(tracks: Track[], statics: Static[], horizon: number): { tracks: Track[]; kin: KinResult } {
  const kin = runKinematics({ tracks, statics, horizon_s: horizon });
  return { kin, tracks: tracks.map((t) => ({ id: t.id, body: t.body, layer: t.layer, segs: kin.executed[t.id].segs })) };
}
/** standard scenario set: walking toward a wall, walking past a post, two ants head-on, an ant passing a stationary ant */
export function scenarios(m: AntennaModel, body: BodyDims = candidateBody(), horizon = 1.5): Scenario[] {
  const T = { statics: true, bodies: true, antennae: true };
  const wall: Static = { id: 'wall', kind: 'segment', a: { x: 6, y: -10 }, b: { x: 6, y: 10 } };
  const post: Static = { id: 'post', kind: 'disc', c: { x: 8, y: 1.6 }, r: 0.4 };
  const mk = (name: string, note: string, tracks: Track[], statics: Static[]): Scenario => {
    const ex = executed(tracks, statics, horizon);
    return { name, note, kin: ex.kin, input: { agents: ex.tracks.map((tr) => ({ id: tr.id, track: tr, model: m })), statics, t0_s: 0, horizon_s: horizon, targets: T } };
  };
  return [
    mk('wall_approach', '直行 5 mm/s 向牆（x = 6 mm）', [new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(5, 5).build()], [wall]),
    mk('post_pass', '直行 10 mm/s 經過柱子（中心側向 1.6 mm、半徑 0.4 mm）', [new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(15, 10).build()], [post]),
    mk('head_on', '兩隻對向各 4 mm/s（側向錯開 0.3 mm）', [new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(6, 4).build(), new PlanBuilder('b', body, { x: 9, y: 0.3, th: Math.PI }).straight(6, 4).build()], []),
    mk('pass_by', '8 mm/s 經過靜止個體（側向 1.6 mm）', [new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(12, 8).build(), new PlanBuilder('b', body, { x: 7, y: 1.6, th: Math.PI / 2 }).stop(10).build()], []),
  ];
}

/**
 * Issue #101 (PH-Rapier-2) step 1: common scenario spec for comparing the native analytic solver (engine/physics,
 * PH-1/MV-1/PH-2) with an independent Rapier 2D solve. ISOLATED experiment: not imported by the day loop, cli/ or web/.
 *
 * A scenario file (prototypes/solver-compare/scenarios/<id>.json, schema scenario.schema.json) only REFERS to the common
 * data in scenarios/physics/ (geometry, body / interaction / motion candidate files) and picks values from them by path.
 * It never contains a species number of its own: a body width, contact reach or speed is a `pick` from a candidate file,
 * and a pick that resolves to null (unknown) makes the scenario REFUSE to run (unknowns are never defaulted).
 * Scenario-only values (start positions, start times, horizon, seed) are synthetic and labelled as such.
 * Units: mm, s, mm/s.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhysicsGeometry, Passage, Obstacle } from '../../../engine/physics/geometry.ts';
import { validateGeometry, obstacleReachesLevel } from '../../../engine/physics/geometry.ts';
import { laneLength } from '../../../engine/physics/kinematics.ts';
import type { EncounterRules } from '../../../engine/physics/collision.ts';
import { rng } from '../../../engine/rng.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCENARIO_SCHEMA = 'antempire.solver-compare.scenario.v1';

export class ScenarioRefused extends Error { constructor(m: string) { super(`SCENARIO_REFUSED: ${m}`); this.name = 'ScenarioRefused'; } }

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A value taken from a candidate file: dotted path (array indices as numbers); op 'midpoint' of a [lo, hi] range. */
export interface Pick { file: 'body' | 'interaction' | 'motion'; path: string; op?: 'value' | 'midpoint'; why: string; /** accept a null file value as null (encounter rules only, where the engine documents its null case) */ nullable?: boolean }
export interface Provenanced<T> { value: T; source: string; basis: string; why: string }

export interface AgentSpecIn { id: string; passage: string; s_mm: number; u_mm: number; dir: 1 | -1; start_t_s: number; goal_s_mm: number; speed: Pick | { generated: string } }
export interface ScenarioFile {
  schema: string; id: string; title: string; synthetic: true; units: { length: 'mm'; time: 's'; speed: 'mm/s' };
  refs: { geometry: string; body: string; interaction: string; motion: string };
  body: { length: Pick; width: Pick; contact_reach: Pick };
  encounter: { priority: Pick; entry_yield_probability: Pick; laden_yield_probability: Pick; contact_pause_s: Pick | null; inside_turn_back_probability: Pick | null };
  agents?: AgentSpecIn[];
  generator?: { kind: 'ph2-9b-traffic'; n: number; seed: number; passage: string } | { kind: 'crossing-lattice'; n: number; seed: number; speed: Pick; front_gap_mm: number; col_pitch_mm: number; row_pitch_mm: number; start_spread_s: number; goal_past_crossing_mm: number };
  horizon_s: number; seed: number;
  rapier?: { dt_s?: number; ccd?: boolean };
  provenance: { scenario_values: string; note?: string };
}

export interface Agent {
  id: string; passage: string; layer: string; s_mm: number; u_mm: number; dir: 1 | -1; start_t_s: number; goal_s_mm: number; free_speed_mm_s: number;
  speed_source: string;
}
export interface Scenario {
  id: string; title: string; file: ScenarioFile; geometry: PhysicsGeometry;
  body: { length_mm: Provenanced<number>; width_mm: Provenanced<number>; contact_reach_mm: Provenanced<number> };
  encounter: EncounterRules; encounter_provenance: Record<string, string>;
  agents: Agent[]; horizon_s: number; seed: number;
  /** passages used by agents, with their (single) level and the obstacles reaching that level */
  lanes: { passage: Passage; z_mm: number; layer: string }[];
  obstacles: Obstacle[]; obstacles_not_at_level: string[]; unused_passages: string[];
  rapier: { dt_s: number; ccd: boolean };
}

const readJson = (rel: string): Json => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
function at(doc: Json, p: string): Json { return p.split('.').reduce((o: Json, k) => (o === null || o === undefined ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), doc); }

function resolve(files: Record<string, Json>, refs: ScenarioFile['refs'], pk: Pick, what: string): Provenanced<number | string> {
  const raw = at(files[pk.file], pk.path);
  let value: number | string | null;
  if ((pk.op ?? 'value') === 'midpoint') {
    if (!Array.isArray(raw) || raw.length !== 2 || raw.some((x) => typeof x !== 'number')) throw new ScenarioRefused(`${what}: ${pk.file}:${pk.path} is not a [lo, hi] range`);
    value = (raw[0] + raw[1]) / 2;
  } else value = raw === undefined ? null : raw;
  if (value === null || (typeof value !== 'number' && typeof value !== 'string')) throw new ScenarioRefused(`${what}: ${pk.file}:${pk.path} is ${JSON.stringify(raw)} (unknown values are never defaulted)`);
  // basis label: the nearest object on the path that carries a `basis`
  const parts = pk.path.split('.'); let basis = 'unlabelled';
  for (let i = parts.length; i > 0; i--) { const o = at(files[pk.file], parts.slice(0, i).join('.')); if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.basis === 'string') { basis = o.basis; break; } }
  return { value, source: `${refs[pk.file]}#${pk.path}${pk.op === 'midpoint' ? ' (midpoint)' : ''}`, basis, why: pk.why };
}
const num = (p: Provenanced<number | string>, what: string): Provenanced<number> => { if (typeof p.value !== 'number' || !Number.isFinite(p.value)) throw new ScenarioRefused(`${what} is not a number`); return p as Provenanced<number>; };

export function scenarioPath(id: string): string { return path.join(HERE, 'scenarios', `${id}.json`); }
export function listScenarios(): string[] { return fs.readdirSync(path.join(HERE, 'scenarios')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort(); }

export function loadScenario(idOrFile: string | ScenarioFile): Scenario {
  const f: ScenarioFile = typeof idOrFile === 'string' ? JSON.parse(fs.readFileSync(scenarioPath(idOrFile), 'utf8')) : idOrFile;
  if (f.schema !== SCENARIO_SCHEMA) throw new ScenarioRefused(`schema ${f.schema} ≠ ${SCENARIO_SCHEMA}`);
  if (f.synthetic !== true) throw new ScenarioRefused('only synthetic scenarios are accepted (no invented garden map)');
  if (f.units?.length !== 'mm' || f.units?.time !== 's' || f.units?.speed !== 'mm/s') throw new ScenarioRefused('units must be mm, s, mm/s');
  const geometry = readJson(f.refs.geometry) as PhysicsGeometry;
  const gi = validateGeometry(geometry);
  if (gi.length) throw new ScenarioRefused(`geometry invalid: ${gi.map((i) => i.code).join(',')}`);
  if (!geometry.synthetic || !geometry.world_id.startsWith('synthetic-')) throw new ScenarioRefused('geometry is not a synthetic scenario');
  const files = { body: readJson(f.refs.body), interaction: readJson(f.refs.interaction), motion: readJson(f.refs.motion) };
  const body = { length_mm: num(resolve(files, f.refs, f.body.length, 'body length'), 'body length'), width_mm: num(resolve(files, f.refs, f.body.width, 'collision width'), 'collision width'), contact_reach_mm: num(resolve(files, f.refs, f.body.contact_reach, 'contact reach'), 'contact reach') };
  const encProv: Record<string, string> = {};
  const ep = (k: keyof ScenarioFile['encounter']): number | string | null => {
    const pk = f.encounter[k];
    if (pk === null) { encProv[k] = 'null (no value chosen; the engine treats it as its documented null case)'; return null; }
    if (pk.nullable && at(files[pk.file], pk.path) === null) { encProv[k] = `${f.refs[pk.file]}#${pk.path} = null (file value; engine null case) ${pk.why}`; return null; }
    const r = resolve(files, f.refs, pk, `encounter.${k}`); encProv[k] = `${r.source} [${r.basis}] ${r.why}`; return r.value;
  };
  const encounter: EncounterRules = { priority: ep('priority') as EncounterRules['priority'], entry_yield_probability: ep('entry_yield_probability') as number, laden_yield_probability: ep('laden_yield_probability') as number, contact_pause_s: ep('contact_pause_s') as number | null, inside_turn_back_probability: ep('inside_turn_back_probability') as number | null };

  const passages = new Map(geometry.passages.map((p) => [p.id, p]));
  const agents: Agent[] = [];
  const levelOf = (pid: string) => {
    const p = passages.get(pid); if (!p) throw new ScenarioRefused(`passage ${pid} not in ${f.refs.geometry}`);
    const zs = new Set(p.centerline_mm.map((c) => c[2]));
    if (zs.size !== 1) throw new ScenarioRefused(`passage ${pid} changes height (2.5D): this step does not project layers into one plane`);
    if (typeof p.width_mm !== 'number') throw new ScenarioRefused(`passage ${pid} width unknown`);
    return [...zs][0];
  };
  const pushAgent = (a: AgentSpecIn, speed: number, src: string) => {
    const z = levelOf(a.passage), Lp = laneLength(passages.get(a.passage)!);
    if (!(a.s_mm >= 0 && a.s_mm <= Lp && a.goal_s_mm >= 0 && a.goal_s_mm <= Lp) || (a.goal_s_mm - a.s_mm) * a.dir < 0) throw new ScenarioRefused(`${a.id}: start/goal inconsistent with ${a.passage}`);
    if (!(speed > 0)) throw new ScenarioRefused(`${a.id}: speed must be positive`);
    agents.push({ id: a.id, passage: a.passage, layer: `z=${z}`, s_mm: a.s_mm, u_mm: a.u_mm, dir: a.dir, start_t_s: a.start_t_s, goal_s_mm: a.goal_s_mm, free_speed_mm_s: speed, speed_source: src });
  };
  for (const a of f.agents ?? []) {
    if ('generated' in a.speed) throw new ScenarioRefused(`${a.id}: explicit agents need a speed pick`);
    const sp = num(resolve(files, f.refs, a.speed, `${a.id} speed`), `${a.id} speed`); pushAgent(a, sp.value, `${sp.source} [${sp.basis}]`);
  }
  const gen = f.generator;
  if (gen?.kind === 'ph2-9b-traffic') {
    // exactly the generator of tests/ph2-collision.test.ts §9b (speeds 15 + 4·U, starts 8·U): TEST-GENERATOR values,
    // a game assumption spanning the literature 15.5 / 18.5 mm/s (R133), not species parameters
    const g = rng(gen.seed);
    const Lp = laneLength(passages.get(gen.passage)!);
    for (let k = 0; k < gen.n; k++) {
      const d = (k % 2 ? -1 : 1) as 1 | -1, s = d > 0 ? 2 + Math.floor(k / 2) * 3 : (Lp - 2) - Math.floor(k / 2) * 3, speed = 15 + g() * 4, start = g() * 8;
      pushAgent({ id: `A${k}`, passage: gen.passage, s_mm: s, u_mm: 0, dir: d, start_t_s: start, goal_s_mm: d > 0 ? Lp - 2 : 2, speed: { generated: '' } }, speed, 'tests/ph2-collision.test.ts §9b generator: 15 + 4·U(seed) mm/s [遊戲假設：測試產生器，非量測]');
    }
  } else if (gen?.kind === 'crossing-lattice') {
    // N ants in four blocks, one at each arm of a two-lane crossing, walking towards and past the crossing. Lattice
    // pitches, gap to the crossing and start spread are SCENARIO values (synthetic, game assumption).
    const sp = num(resolve(files, f.refs, gen.speed, 'lattice speed'), 'lattice speed');
    if (geometry.passages.length !== 2) throw new ScenarioRefused('crossing-lattice needs exactly two passages');
    const [P, Q] = geometry.passages, W = P.width_mm as number, cols = Math.floor((W - body.width_mm.value) / gen.col_pitch_mm) + 1;
    const per = Math.ceil(gen.n / 4), r = rng(gen.seed);
    // crossing point arc positions: both lanes are straight (checked by the runners); intersection by line algebra
    const cx = crossingArc(P, Q), cy = crossingArc(Q, P);
    let k = 0;
    for (const [lane, sc] of [[P, cx], [Q, cy]] as const) for (const dir of [1, -1] as const) for (let i = 0; i < per && k < gen.n; i++, k++) {
      const row = Math.floor(i / cols), col = i % cols;
      const s = sc - dir * (gen.front_gap_mm + body.length_mm.value / 2 + row * gen.row_pitch_mm), u = -W / 2 + body.width_mm.value / 2 + col * gen.col_pitch_mm + (W - body.width_mm.value - (cols - 1) * gen.col_pitch_mm) / 2;
      const goal = sc + dir * gen.goal_past_crossing_mm;
      pushAgent({ id: `L${String(k).padStart(4, '0')}`, passage: lane.id, s_mm: s, u_mm: u, dir, start_t_s: r() * gen.start_spread_s, goal_s_mm: goal, speed: { generated: '' } }, sp.value, `${sp.source} [${sp.basis}]`);
    }
  }
  if (!agents.length) throw new ScenarioRefused('no agents');
  if (new Set(agents.map((a) => a.id)).size !== agents.length) throw new ScenarioRefused('duplicate agent ids');
  const used = [...new Set(agents.map((a) => a.passage))].sort();
  const lanes = used.map((pid) => { const z = levelOf(pid); return { passage: passages.get(pid)!, z_mm: z, layer: `z=${z}` }; });
  const levels = new Set(lanes.map((l) => l.z_mm));
  const obstacles = geometry.obstacles.filter((o) => [...levels].some((z) => obstacleReachesLevel(o, z, z)));
  return {
    id: f.id, title: f.title, file: f, geometry, body, encounter, encounter_provenance: encProv, agents, horizon_s: f.horizon_s, seed: f.seed, lanes, obstacles,
    obstacles_not_at_level: geometry.obstacles.filter((o) => !obstacles.includes(o)).map((o) => o.id),
    unused_passages: geometry.passages.filter((p) => !used.includes(p.id)).map((p) => p.id),
    rapier: { dt_s: f.rapier?.dt_s ?? 1 / 120, ccd: f.rapier?.ccd ?? false },
  };
}

/** Arc length on straight passage P where it meets straight passage Q (2D line intersection). */
export function crossingArc(P: Passage, Q: Passage): number {
  const [a, b] = [P.centerline_mm[0], P.centerline_mm[P.centerline_mm.length - 1]], [c, d] = [Q.centerline_mm[0], Q.centerline_mm[Q.centerline_mm.length - 1]];
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
  if (den === 0) throw new ScenarioRefused(`${P.id} and ${Q.id} are parallel`);
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  return t * Math.hypot(rx, ry);
}

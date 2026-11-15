/**
 * Demo 2 — ONE interface for "who is in the colony", two providers. Pure: no DOM, no Three.js, no engine import.
 *
 *  (a) engineFeed(frame): the individuals the experiment Worker reports (truth). P0-A2: 30 minor workers and 8
 *      larvae; the candidate world 'p0a2-colony' adds queens, majors, eggs and pupae. Nothing is added or renamed.
 *  (b) demoFeed(seed, castes): a deterministic, seeded 展示情境 roster for the castes the engine does NOT supply
 *      (queens, major workers, eggs, pupae). Every individual is labelled source: 'demo' and 示範資料; it never
 *      enters a snapshot, a save, an export or any message to the Worker (this module cannot reach the Worker).
 * roster(mode, frame, seed): natural mode = engine individuals only; demo mode = engine individuals + demo individuals
 * for the castes the engine lacks. A caste the engine supplies is NEVER duplicated by demo data.
 *
 * Engine roster of the opt-in candidate world 'p0a2-colony' (PR #263, docs/colony-candidate-world.md): its frame is a
 * P0-A2 frame that also carries `colony` with queens / majors / eggs / pupae as ENGINE individuals (static: none of them
 * eats, lays, develops or moves in the engine; each lists what is 尚未模擬). When `frame.colony` is present those castes
 * come from the engine (ENGINE_CASTE_READERS) and the demo provider stops supplying them; without it (plain P0-A2, or a
 * Worker build that does not know the kind) they stay 「尚未模擬」 / demo. The colony part is read structurally (this
 * module does not depend on the protocol file of that PR).
 */
import type { P0a2FrameMsg } from '../experimental/worker-protocol.ts';
import { hash32 } from '../game-model.ts';

export type Caste = 'minor' | 'major' | 'queen' | 'egg' | 'larva' | 'pupa';
export const CASTES: readonly Caste[] = ['queen', 'major', 'minor', 'egg', 'larva', 'pupa'];
export const CASTE_LABEL: Record<Caste, string> = { minor: '小工蟻', major: '大工蟻（大頭）', queen: '蟻后', egg: '卵', larva: '幼蟲', pupa: '蛹' };
export type DataSource = 'engine' | 'demo';
export const SOURCE_LABEL: Record<DataSource, string> = { engine: '引擎', demo: '示範資料' };
export const DEMO_BADGE = '展示情境・示範資料';
export const NATURAL_BADGE = '自然模式・只有引擎個體';

export interface Individual {
  id: string; caste: Caste; source: DataSource;
  /** engine activity state (engine individuals) or the labelled demo routine (demo individuals) */
  state: string | null;
  /** 0..1: crop fill (workers) / gut fill (larvae); null when the provider has none */
  fill: number | null;
  /** index among the individuals of the same caste and source (stable order) */
  index: number;
  /** engine individuals of the candidate world: what the engine does NOT simulate for this individual (labels) */
  notes?: string[];
}
export interface ColonyFeed { readonly source: DataSource; readonly label_zh: string; individuals(): Individual[] }

/** the fields of the candidate world's colony roster this page reads (subset of P0a2ColonyMsg, PR #263) */
export interface ColonyItem { id: string; state?: string; alive?: boolean; not_simulated?: string[] }
export interface ColonyPart { world_kind: string; status_zh?: string; queens: ColonyItem[]; majors: ColonyItem[]; eggs: ColonyItem[]; pupae: ColonyItem[]; not_simulated_fields?: Record<string, string>; assumptions?: Record<string, unknown> }
/** the colony roster of a frame, or null (plain P0-A2 world) */
export function colonyOf(f: P0a2FrameMsg): ColonyPart | null {
  const c = (f as unknown as { colony?: ColonyPart }).colony;
  return c && c.world_kind === 'p0a2-colony' && Array.isArray(c.queens) && Array.isArray(c.majors) && Array.isArray(c.eggs) && Array.isArray(c.pupae) ? c : null;
}
const STATIC_STATE = '在巢內（引擎；不進食、不產卵、不發育、不移動：尚未模擬）';
const fromColony = (f: P0a2FrameMsg, key: 'queens' | 'majors' | 'eggs' | 'pupae', caste: Caste): Individual[] | null => {
  const c = colonyOf(f); if (!c) return null;
  return c[key].filter((x) => x.alive !== false).map((x, i) => ({ id: x.id, caste, source: 'engine' as const, state: STATIC_STATE, fill: null, index: i, notes: (x.not_simulated ?? []).map((k) => c.not_simulated_fields?.[k] ?? k) }));
};
/** how each caste is read from a Worker frame: workers (minor) and larvae from every P0-A2 frame; queens, majors, eggs
 *  and pupae only from the candidate world's colony roster (nothing is invented when it is absent) */
const ENGINE_CASTE_READERS: Record<Caste, (f: P0a2FrameMsg) => Individual[] | null> = {
  minor: (f) => f.workers.map((w, i) => ({ id: w.id, caste: 'minor', source: 'engine', state: w.state, fill: w.crop_fill, index: i })),
  major: (f) => fromColony(f, 'majors', 'major'),
  larva: (f) => f.larvae.map((l, i) => ({ id: l.id, caste: 'larva', source: 'engine', state: null, fill: l.gut_fill, index: i })),
  queen: (f) => fromColony(f, 'queens', 'queen'),
  egg: (f) => fromColony(f, 'eggs', 'egg'),
  pupa: (f) => fromColony(f, 'pupae', 'pupa'),
};
/** the castes the engine frame supplies (possibly with zero individuals) */
export function engineCastes(f: P0a2FrameMsg): Caste[] { return CASTES.filter((c) => ENGINE_CASTE_READERS[c](f) !== null); }
/** the castes the engine frame does not supply at all: shown as 「尚未模擬」 in natural mode, as demo data in demo mode */
export function missingCastes(f: P0a2FrameMsg): Caste[] { return CASTES.filter((c) => ENGINE_CASTE_READERS[c](f) === null); }

export function engineFeed(f: P0a2FrameMsg): ColonyFeed {
  return { source: 'engine', label_zh: '引擎個體（實驗 Worker 回報）', individuals: () => CASTES.flatMap((c) => ENGINE_CASTE_READERS[c](f) ?? []) };
}

/** how many demo individuals of each caste the 展示情境 shows. Queens: 2 (Owner #202 provisional ruling: default 2–3,
 *  docs/owner-decisions-2026-11-13.md §4). All other counts are 遊戲假設 for the demonstration only. */
export const DEMO_COUNTS: Record<'queen' | 'major' | 'egg' | 'pupa', number> = { queen: 2, major: 4, egg: 36, pupa: 9 };
export const DEMO_ROUTINE_LABEL = '原地待命（示範動作，不是引擎行為）';
/** deterministic demo roster: same seed and castes → the same ids in the same order */
export function demoFeed(seed: number, castes: readonly Caste[]): ColonyFeed {
  const out: Individual[] = [];
  for (const c of ['queen', 'major', 'egg', 'pupa'] as const) {
    if (!castes.includes(c)) continue;
    for (let i = 0; i < DEMO_COUNTS[c]; i++) out.push({ id: `demo-${c}-${String(i + 1).padStart(2, '0')}-${(hash32(`demo2|${seed}|${c}|${i}`) >>> 0).toString(36).slice(0, 4)}`, caste: c, source: 'demo', state: DEMO_ROUTINE_LABEL, fill: null, index: i });
  }
  return { source: 'demo', label_zh: DEMO_BADGE, individuals: () => out.map((x) => ({ ...x })) };
}

export type Mode = 'natural' | 'demo';
export interface Roster {
  mode: Mode; badge: string; individuals: Individual[];
  counts: Record<Caste, { engine: number; demo: number }>;
  /** castes with no engine individuals model at all (尚未模擬) */
  missing: Caste[];
}
/** the roster the page shows. Natural mode never contains a demo individual. */
export function roster(mode: Mode, f: P0a2FrameMsg, demoSeed: number): Roster {
  const missing = missingCastes(f), eng = engineFeed(f).individuals(), demo = mode === 'demo' ? demoFeed(demoSeed, missing).individuals() : [];
  const counts = Object.fromEntries(CASTES.map((c) => [c, { engine: 0, demo: 0 }])) as Roster['counts'];
  for (const x of eng) counts[x.caste].engine++;
  for (const x of demo) counts[x.caste].demo++;
  return { mode, badge: mode === 'demo' ? DEMO_BADGE : NATURAL_BADGE, individuals: [...eng, ...demo], counts, missing };
}
/** inert food props of the 展示情境 (the P0-A2 engine has only the honeydew source; no ant forages on these) */
export const DEMO_FOOD_PROPS = [
  { id: 'demo-food-nectar', kind: 'nectar', label_zh: '花蜜（示範道具・引擎尚未模擬）' },
  { id: 'demo-food-insect', kind: 'dead_insect', label_zh: '昆蟲屍體（示範道具・引擎尚未模擬）' },
] as const;

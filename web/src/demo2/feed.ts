/**
 * Demo 2 — ONE interface for "who is in the colony", two providers. Pure: no DOM, no Three.js, no engine import.
 *
 *  (a) engineFeed(frame): the individuals the experiment Worker reports (truth). Today (P0-A2): 30 minor workers and
 *      8 larvae. Nothing is added, removed or renamed.
 *  (b) demoFeed(seed, castes): a deterministic, seeded 展示情境 roster for the castes the engine does NOT supply
 *      (queens, major workers, eggs, pupae). Every individual is labelled source: 'demo' and 示範資料; it never
 *      enters a snapshot, a save, an export or any message to the Worker (this module cannot reach the Worker).
 * roster(mode, frame, seed): natural mode = engine individuals only; demo mode = engine individuals + demo individuals
 * for the castes the engine lacks. A caste the engine supplies is NEVER duplicated by demo data.
 *
 * Forward compatibility: when a later rules PR lets the Worker frame carry queens / majors / eggs / pupae, only
 * engineFeed() changes (see ENGINE_CASTE_READERS): those castes then leave MISSING and the demo provider stops
 * supplying them.
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
}
export interface ColonyFeed { readonly source: DataSource; readonly label_zh: string; individuals(): Individual[] }

type Frame = P0a2FrameMsg & Partial<Record<'queens' | 'majors' | 'eggs' | 'pupae', { id: string; state?: string }[]>>;
/** how each caste is read from a Worker frame. P0-A2 supplies workers (all minor) and larvae; the optional arrays are
 *  read only if a future world kind sends them (they do not exist today: nothing is invented when they are absent). */
const ENGINE_CASTE_READERS: Record<Caste, (f: Frame) => Individual[] | null> = {
  minor: (f) => f.workers.filter((w) => (w as { caste?: string }).caste !== 'major').map((w, i) => ({ id: w.id, caste: 'minor', source: 'engine', state: w.state, fill: w.crop_fill, index: i })),
  major: (f) => { const m = f.workers.filter((w) => (w as { caste?: string }).caste === 'major'); const extra = f.majors ?? []; return m.length + extra.length === 0 ? null : [...m.map((w) => ({ id: w.id, state: w.state })), ...extra].map((w, i) => ({ id: w.id, caste: 'major' as const, source: 'engine' as const, state: w.state ?? null, fill: null, index: i })); },
  larva: (f) => f.larvae.map((l, i) => ({ id: l.id, caste: 'larva', source: 'engine', state: null, fill: l.gut_fill, index: i })),
  queen: (f) => f.queens ? f.queens.map((q, i) => ({ id: q.id, caste: 'queen', source: 'engine', state: q.state ?? null, fill: null, index: i })) : null,
  egg: (f) => f.eggs ? f.eggs.map((q, i) => ({ id: q.id, caste: 'egg', source: 'engine', state: null, fill: null, index: i })) : null,
  pupa: (f) => f.pupae ? f.pupae.map((q, i) => ({ id: q.id, caste: 'pupa', source: 'engine', state: null, fill: null, index: i })) : null,
};
/** the castes the engine frame supplies (possibly with zero individuals) */
export function engineCastes(f: P0a2FrameMsg): Caste[] { return CASTES.filter((c) => ENGINE_CASTE_READERS[c](f as Frame) !== null); }
/** the castes the engine frame does not supply at all: shown as 「尚未模擬」 in natural mode, as demo data in demo mode */
export function missingCastes(f: P0a2FrameMsg): Caste[] { return CASTES.filter((c) => ENGINE_CASTE_READERS[c](f as Frame) === null); }

export function engineFeed(f: P0a2FrameMsg): ColonyFeed {
  return { source: 'engine', label_zh: '引擎個體（實驗 Worker 回報）', individuals: () => CASTES.flatMap((c) => ENGINE_CASTE_READERS[c](f as Frame) ?? []) };
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

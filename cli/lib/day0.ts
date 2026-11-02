/**
 * Node-side loader for Day0 evaluation scenarios (scenarios/day0/*.json). Reads files and hands plain data
 * to the pure engine initializer. Nothing here reads or writes saves/ or journal/.
 */
import { REPO_ROOT, readJson, loadBundle } from './load.ts';
import { initializeDay0, type Day0Output, type ParamBundle } from '../../engine/index.ts';

export const DAY0_DIR = 'scenarios/day0';
export const CLIMATOLOGY = 'data/taichung-climatology-1991-2020.json';
export type FoundingId = 'A1' | 'A2' | 'A3' | 'B' | 'C';
export const SUPPORTED_FOUNDINGS: FoundingId[] = ['A1', 'A2', 'A3'];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export function seasonStart(season: Season, root = REPO_ROOT): string { return readJson<any>(DAY0_DIR + '/seasons.json', root).starts[season]; } // eslint-disable-line @typescript-eslint/no-explicit-any
export function day0Inputs(founding: FoundingId, root = REPO_ROOT) {
  return { garden: readJson(DAY0_DIR + '/garden.json', root), founding: readJson(`${DAY0_DIR}/founding-${founding}.json`, root), climatology: readJson(CLIMATOLOGY, root) };
}
export function buildDay0(founding: FoundingId, seed: number, startDate: string, bundle: ParamBundle = loadBundle(), root = REPO_ROOT): Day0Output {
  return initializeDay0({ ...day0Inputs(founding, root), seed, start_date: startDate }, bundle);
}

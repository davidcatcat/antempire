/** Node-only loading helpers for the CLI and tests (the engine itself never touches the file system). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParamBundle, ParamFile } from '../../engine/index.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SPECIES_DIR = 'species';
export const WORLD_FILE = 'world/xitun-garden.json';

export const readText = (rel: string, root = REPO_ROOT): string => fs.readFileSync(path.join(root, rel), 'utf8');
export const readJson = <T = any>(rel: string, root = REPO_ROOT): T => JSON.parse(readText(rel, root)); // eslint-disable-line @typescript-eslint/no-explicit-any

/** Load the world file and every species file it references in scenario_colonies. */
export function loadBundle(root = REPO_ROOT, worldRel = WORLD_FILE): ParamBundle {
  const world = readJson<ParamFile>(worldRel, root);
  const species: Record<string, ParamFile> = {};
  for (const c of (world.scenario_colonies as unknown as { species_id: string }[]) ?? []) {
    species[c.species_id] ??= readJson<ParamFile>(`${SPECIES_DIR}/${c.species_id}.json`, root);
  }
  return { world, species };
}

/** The repo-relative files whose content defines the rules (engine source + parameter files). */
export function ruleFiles(root = REPO_ROOT): { engine: string[]; params: string[] } {
  const list = (dir: string, ext: string) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => `${dir}/${f}`);
  return { engine: list('engine', '.ts'), params: [WORLD_FILE, ...list(SPECIES_DIR, '.json')] };
}

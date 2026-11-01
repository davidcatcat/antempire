/** Minimal assertion counter shared by the ported test scripts (each script exits non-zero on failure). */
import assert from 'node:assert/strict';
import { loadBundle, readJson } from '../../cli/lib/load.ts';
import type { LegacyV2State, ParamBundle, ParamFile } from '../../engine/index.ts';

export function counter() {
  let checks = 0;
  const ok = (condition: unknown, why: string) => { assert.ok(condition, why); checks++; };
  const denied = (fn: () => unknown, pattern = /NO_GOD_MODE/) => { assert.throws(fn, pattern); checks++; };
  return { ok, denied, get checks() { return checks; } };
}

export const fixture = (): LegacyV2State => readJson('tests/fixtures/day14-projection.json');
export const bundle = (): ParamBundle => loadBundle();

/** Set a tagged parameter value inside a bundle copy. file: 'world' or a species id. */
export function setParam(b: ParamBundle, file: 'world' | string, path: string, value: number): void {
  let node: any = file === 'world' ? b.world : b.species[file]; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const k of path.split('.')) node = node?.[k];
  if (!node || typeof node !== 'object' || !('value' in node)) throw Error('No parameter ' + file + ':' + path);
  node.value = value;
}

export const MAIN_SPECIES = 'pheidole-megacephala';
export const species = (b: ParamBundle): ParamFile => b.species[MAIN_SPECIES];

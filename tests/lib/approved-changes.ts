/**
 * Approved rules changes since v6 (tests/golden/approved-rule-changes.json) and how to undo each one, so the
 * differential test can prove that the current engine differs from v6 ONLY by these approved changes.
 */
import { readJson } from '../../cli/lib/load.ts';
import type { ParamBundle } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ApprovedChange { rules_version: string; approved_in: string; kind: 'engine' | 'param' | 'param_removed' | 'param_switch' | 'param_added' | string; file?: string; path?: string; legacy_path?: string; from?: number | boolean; to?: number | boolean; neutralise?: { delete_state_path?: string } }

export const approvedChanges = (): ApprovedChange[] => readJson('tests/golden/approved-rule-changes.json').changes;

function fileOf(bundle: ParamBundle, file: string): Any {
  const [kind, id] = file.split(':');
  return kind === 'world' ? bundle.world : bundle.species[id];
}

/** Undo one approved parameter change: a tagged value (kind param) or a boolean model switch (kind param_switch). */
export function revertChange(bundle: ParamBundle, c: ApprovedChange): void {
  // param_removed, and param_added without `from`: unused by the previous rules. A param_added WITH `from` is
  // read by the engine; `from` is the value that reproduces the previous rules.
  if (c.kind !== 'param' && c.kind !== 'param_switch' && !(c.kind === 'param_added' && c.from !== undefined)) return;
  const keys = (c.path as string).split('.'), last = keys.pop() as string;
  let parent = fileOf(bundle, c.file as string);
  for (const k of keys) parent = parent[k];
  if (c.kind === 'param_switch') {
    if (parent[last] !== c.to) throw Error(`approved switch ${c.path}: expected current value ${c.to}, found ${parent[last]}`);
    parent[last] = c.from;
  } else {
    if (parent[last].value !== c.to) throw Error(`approved change ${c.path}: expected current value ${c.to}, found ${parent[last].value}`);
    parent[last].value = c.from;
  }
}

/** Put every approved parameter change back to its v6 value. */
export function revertParams(bundle: ParamBundle): void {
  for (const c of approvedChanges()) revertChange(bundle, c);
}

/** Undo approved engine changes on one day's input state (v7: nest-temperature memory). */
export function neutraliseState(state: Any): void {
  for (const c of approvedChanges()) {
    const p = c.neutralise?.delete_state_path;
    if (!p) continue;
    const parts = p.split('.'); let node = state;
    for (const k of parts.slice(0, -1)) node = node?.[k];
    if (node) delete node[parts.at(-1) as string];
  }
}

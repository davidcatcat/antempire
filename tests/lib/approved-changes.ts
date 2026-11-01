/**
 * Approved rules changes since v6 (tests/golden/approved-rule-changes.json) and how to undo each one, so the
 * differential test can prove that the current engine differs from v6 ONLY by these approved changes.
 */
import { readJson } from '../../cli/lib/load.ts';
import type { ParamBundle } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ApprovedChange { rules_version: string; approved_in: string; kind: 'engine' | 'param' | 'param_removed' | string; file?: string; path?: string; legacy_path?: string; from?: number; to?: number; neutralise?: { delete_state_path?: string } }

export const approvedChanges = (): ApprovedChange[] => readJson('tests/golden/approved-rule-changes.json').changes;

function fileOf(bundle: ParamBundle, file: string): Any {
  const [kind, id] = file.split(':');
  return kind === 'world' ? bundle.world : bundle.species[id];
}

/** Put every approved parameter change back to its v6 value (param_removed entries need no action: unused). */
export function revertParams(bundle: ParamBundle): void {
  for (const c of approvedChanges()) if (c.kind === 'param') {
    let node = fileOf(bundle, c.file as string);
    for (const k of (c.path as string).split('.')) node = node[k];
    if (node.value !== c.to) throw Error(`approved change ${c.path}: expected current value ${c.to}, found ${node.value}`);
    node.value = c.from;
  }
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

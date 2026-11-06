/**
 * Parameters of an EARLIER rules version, rebuilt from the current parameter files by undoing every approved
 * change made after it (tests/golden/approved-rule-changes.json). Used to re-verify archived research data
 * (for example the v2-review.19 sensitivity data after v2-review.20) with the current engine: an engine change
 * is only allowed behind a switch whose old value reproduces the previous version byte for byte
 * (tests/rules-isolation.test.ts), so undoing the switch reproduces the old engine.
 * Read-only: returns a new bundle, never writes parameter files.
 */
import { loadBundle, readJson } from './load.ts';
import type { ParamBundle } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Change { rules_version: string; kind: string; file?: string; path?: string; from?: unknown; introduced?: boolean; day14_output_unchanged?: boolean; diagnostics_only?: boolean }

export function registryVersions(): { rules_version: string; tag: string; fingerprint: { engine: string; params: string } }[] {
  return readJson('rules/registry.json').versions;
}

/** The ordered list of rules versions as recorded in the registry. */
export const versionOrder = () => registryVersions().map((v) => v.rules_version);

/**
 * `forHash`: a switch that did not exist in the target version (`introduced: true`) is REMOVED (with its `_note`),
 * so the bundle equals the target version's parameter files exactly (for parameter hashes). Without it the switch
 * is set to its old value, which the current engine needs in order to run the old behaviour. A section emptied by
 * these removals is removed as well (it did not exist in the target version).
 */
export function bundleAtVersion(target: string, opts: { forHash?: boolean } = {}): ParamBundle {
  const order = versionOrder(), ti = order.indexOf(target);
  if (ti < 0) throw Error(`unknown rules version ${target}`);
  const later = (readJson('tests/golden/approved-rule-changes.json').changes as Change[]).filter((c) => order.indexOf(c.rules_version) > ti);
  const b = loadBundle();
  for (const c of [...later].reverse()) {
    if (c.kind === 'engine' || c.kind === 'param_metadata') {
      if (c.day14_output_unchanged || c.diagnostics_only) continue;
      throw Error(`bundleAtVersion: ${c.rules_version} has an engine change that no parameter switch can undo`);
    }
    if (!c.file || !c.path) throw Error(`bundleAtVersion: change without file/path in ${c.rules_version}`);
    const [kind, id] = c.file.split(':'), root: Any = kind === 'species' ? (b.species as Any)[id] : b.world;
    const keys = c.path.split('.'), last = keys.pop() as string;
    let node: Any = root; for (const k of keys) node = node[k];
    if (c.kind === 'param_switch') { if (opts.forHash && c.introduced) { delete node[last]; delete node[`${last}_note`]; } else node[last] = c.from; }
    else if (c.kind === 'param') node[last].value = c.from;
    // a param_added WITH `from` is read by the current engine (tests/lib/approved-changes.ts): kept for a runnable bundle
    else if (c.kind === 'param_added') { if (opts.forHash || c.from === undefined) delete node[last]; else node[last].value = c.from; }
    else throw Error(`bundleAtVersion: cannot undo change kind ${c.kind} (${c.rules_version} ${c.path})`);
    // a section that held only parameters added later did not exist in the target version (e.g. queen_feeding, v25)
    if (opts.forHash && keys.length && Object.keys(node).length === 0) { let parent: Any = root; for (const k of keys.slice(0, -1)) parent = parent[k]; delete parent[keys[keys.length - 1]]; }
  }
  return b;
}

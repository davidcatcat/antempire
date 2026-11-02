/**
 * Rules version registry (#11): rules/registry.json lists every APPROVED rules version with its rules
 * fingerprint (cli/lib/fingerprint.ts). A save freezes the fingerprint it was activated with; switching it is
 * only possible to the registered version that directly follows the frozen one (`--adopt-rules`), inside the
 * same recoverable transaction as the first day run under the new rules. Nothing here edits a save by itself.
 */
import { readJson, REPO_ROOT } from './load.ts';

export interface Fingerprint { engine: string; params: string }
export interface RulesVersion {
  rules_version: string; tag: string; fingerprint: Fingerprint; approved_in: string; merge_commit?: string;
  golden: { traces: string; reports: string }; previous: string | null; save_schema: string; state_migration: string | null;
}
export interface Registry { schema: string; note?: string; versions: RulesVersion[] }

export const REGISTRY_REL = 'rules/registry.json';
export const readRegistry = (root = REPO_ROOT): Registry => readJson(REGISTRY_REL, root);
const same = (a: Fingerprint | undefined, b: Fingerprint | undefined) => !!a && !!b && a.engine === b.engine && a.params === b.params;

export class RulesError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}

export const byFingerprint = (reg: Registry, fp: Fingerprint): RulesVersion | undefined => reg.versions.find((v) => same(v.fingerprint, fp));
export const byVersion = (reg: Registry, id: string): RulesVersion | undefined => reg.versions.find((v) => v.rules_version === id || v.tag === id);

/** Structural problems of the registry, and whether the current checkout is its latest approved version. */
export function registryProblems(reg: Registry, current: Fingerprint, engineVersion: string, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  if (reg.schema !== 'antempire.rules-registry.v1') out.push('unknown registry schema ' + reg.schema);
  const seen = new Set<string>();
  reg.versions.forEach((v, i) => {
    if (seen.has(v.rules_version) || seen.has(v.tag)) out.push('duplicate version ' + v.rules_version);
    seen.add(v.rules_version); seen.add(v.tag);
    if (!v.approved_in) out.push(`${v.rules_version}: approved_in missing`);
    if (!/^[0-9a-f]{64}$/.test(v.fingerprint?.engine ?? '') || !/^[0-9a-f]{64}$/.test(v.fingerprint?.params ?? '')) out.push(`${v.rules_version}: malformed fingerprint`);
    if (v.previous !== (i === 0 ? null : reg.versions[i - 1].rules_version)) out.push(`${v.rules_version}: previous must be ${i === 0 ? 'null' : reg.versions[i - 1].rules_version}`);
    if (!exists(v.golden.traces)) out.push(`${v.rules_version}: golden traces ${v.golden.traces} missing (old versions' evidence must be kept)`);
  });
  const last = reg.versions.at(-1);
  if (!last) out.push('registry is empty');
  else {
    if (!same(last.fingerprint, current)) out.push(`the current checkout's rules fingerprint is not registered as the latest approved version (${last.rules_version}); a rules update must add its registry entry in the same PR`);
    if (last.rules_version !== engineVersion) out.push(`ENGINE_VERSION ${engineVersion} != latest registered ${last.rules_version}`);
  }
  return out;
}

/**
 * Check that the frozen save may switch to `target`: target is registered, equals the running checkout, and
 * directly follows the frozen version (no skipped approvals). Returns both registry entries.
 */
export function planAdoption(reg: Registry, frozen: Fingerprint | undefined, target: string, current: Fingerprint): { from: RulesVersion; to: RulesVersion } {
  if (!frozen) throw new RulesError('NOT_ACTIVE', 'the save has no frozen rules yet (Day15 activation freezes the current rules; nothing to adopt)');
  const to = byVersion(reg, target);
  if (!to) throw new RulesError('UNREGISTERED', `rules version ${target} is not in ${REGISTRY_REL} (only approved, merged versions can be adopted)`);
  if (!same(to.fingerprint, current)) throw new RulesError('CHECKOUT_MISMATCH', `the running engine/params are not ${to.rules_version} (fingerprint differs); check out the approved version first`);
  const from = byFingerprint(reg, frozen);
  if (!from) throw new RulesError('FROZEN_UNKNOWN', 'the frozen rules of this save are not a registered version; refusing');
  if (same(from.fingerprint, to.fingerprint)) throw new RulesError('ALREADY_ACTIVE', `${to.rules_version} is already the frozen rules version`);
  if (to.previous !== from.rules_version) throw new RulesError('SKIPPED_VERSION', `${to.rules_version} follows ${to.previous}, but the save is frozen at ${from.rules_version}; adopt the versions in order`);
  return { from, to };
}

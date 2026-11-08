/**
 * Rules version registry (#11): rules/registry.json lists every APPROVED rules version with its rules
 * fingerprint (cli/lib/fingerprint.ts). A save freezes the fingerprint it was activated with; switching it is
 * only possible to the registered version that directly follows the frozen one (`--adopt-rules`), inside the
 * same recoverable transaction as the first day run under the new rules. Nothing here edits a save by itself.
 */
import { readJson, REPO_ROOT } from './load.ts';
import { isFingerprintV2, v2RecordProblems, type FingerprintV2 } from './fingerprint-v2.ts';

/** v1 fingerprint (cli/lib/fingerprint.ts): engine/*.ts and parameter files. Saves frozen before v2 keep this form. */
export interface Fingerprint { engine: string; params: string }
/** The running checkout: always its v1 fingerprint, and its v2 fingerprint when computed (docs/rules-fingerprint-v2.md). */
export interface CurrentRules extends Fingerprint { v2?: FingerprintV2 }
/** What a save freezes: v1 ({engine, params}) or v2 (schema antempire.rules-fingerprint.v2). */
export type FrozenFingerprint = Fingerprint | FingerprintV2;
export interface RulesVersion {
  rules_version: string; tag: string; fingerprint: Fingerprint; approved_in: string; merge_commit?: string;
  /** Owner decision 52: v2 fingerprint of this version. Optional for versions registered before v2 existed;
   *  required for every entry after the first one that has it. Adopting such a version freezes v2. */
  fingerprint_v2?: FingerprintV2;
  golden: { traces: string; reports: string }; previous: string | null; save_schema: string; state_migration: string | null;
}
export interface Registry { schema: string; note?: string; versions: RulesVersion[] }

export const REGISTRY_REL = 'rules/registry.json';
export const readRegistry = (root = REPO_ROOT): Registry => readJson(REGISTRY_REL, root);
const same = (a: Fingerprint | undefined, b: Fingerprint | undefined) => !!a && !!b && a.engine === b.engine && a.params === b.params;
const sameV2 = (a: FingerprintV2 | undefined, b: FingerprintV2 | undefined) => isFingerprintV2(a) && isFingerprintV2(b) && a.digest === b.digest && a.engine_version === b.engine_version && a.source === b.source && a.params === b.params && a.data === b.data;
/** Registry entry v is the running checkout: v1 equal, and v2 equal too when the entry records one. */
export const describesCheckout = (v: RulesVersion, cur: CurrentRules) => same(v.fingerprint, cur) && (!v.fingerprint_v2 || sameV2(v.fingerprint_v2, cur.v2));
/** Registry entry v is a frozen save fingerprint, compared in the frozen record's own format (v1 or v2). */
export const describesFrozen = (v: RulesVersion, frozen: FrozenFingerprint) => isFingerprintV2(frozen) ? sameV2(v.fingerprint_v2, frozen) : same(v.fingerprint, frozen);
/** The running checkout seen in the format of a frozen record (undefined: v2 needed but not computed). */
export const frozenMatchesCheckout = (frozen: FrozenFingerprint, cur: CurrentRules) => isFingerprintV2(frozen) ? sameV2(frozen, cur.v2) : same(frozen, cur);

export class RulesError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}

/** The registry entry of the running checkout. */
export const byFingerprint = (reg: Registry, fp: CurrentRules): RulesVersion | undefined => reg.versions.find((v) => describesCheckout(v, fp));
/** The registry entry of a frozen save record (v1 or v2). */
export const byFrozen = (reg: Registry, frozen: FrozenFingerprint): RulesVersion | undefined => reg.versions.find((v) => describesFrozen(v, frozen));
export const byVersion = (reg: Registry, id: string): RulesVersion | undefined => reg.versions.find((v) => v.rules_version === id || v.tag === id);

/** Structural problems of the registry, and whether the current checkout is its latest approved version. */
export function registryProblems(reg: Registry, current: CurrentRules, engineVersion: string, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  if (reg.schema !== 'antempire.rules-registry.v1') out.push('unknown registry schema ' + reg.schema);
  const seen = new Set<string>();
  let firstV2: string | null = null;
  const v1Seen = new Set<string>();
  reg.versions.forEach((v, i) => {
    if (v.fingerprint_v2 !== undefined) {
      for (const p of v2RecordProblems(v.fingerprint_v2)) out.push(`${v.rules_version}: fingerprint_v2 ${p}`);
      if (v.fingerprint_v2?.engine_version !== v.rules_version) out.push(`${v.rules_version}: fingerprint_v2.engine_version must equal rules_version`);
      firstV2 ??= v.rules_version;
      if (v.fingerprint_v2 && reg.versions.slice(0, i).some((u) => u.fingerprint_v2?.digest === v.fingerprint_v2?.digest)) out.push(`${v.rules_version}: duplicate fingerprint_v2`);
    } else if (firstV2) out.push(`${v.rules_version}: fingerprint_v2 missing (required for every version after ${firstV2})`);
    if (seen.has(v.rules_version) || seen.has(v.tag)) out.push('duplicate version ' + v.rules_version);
    seen.add(v.rules_version); seen.add(v.tag);
    const k1 = `${v.fingerprint?.engine}/${v.fingerprint?.params}`;
    if (v1Seen.has(k1)) out.push(`${v.rules_version}: duplicate v1 fingerprint (every approved version must differ in engine/*.ts or parameters)`);
    v1Seen.add(k1);
    if (!v.approved_in) out.push(`${v.rules_version}: approved_in missing`);
    if (!/^[0-9a-f]{64}$/.test(v.fingerprint?.engine ?? '') || !/^[0-9a-f]{64}$/.test(v.fingerprint?.params ?? '')) out.push(`${v.rules_version}: malformed fingerprint`);
    if (v.previous !== (i === 0 ? null : reg.versions[i - 1].rules_version)) out.push(`${v.rules_version}: previous must be ${i === 0 ? 'null' : reg.versions[i - 1].rules_version}`);
    if (!exists(v.golden.traces)) out.push(`${v.rules_version}: golden traces ${v.golden.traces} missing (old versions' evidence must be kept)`);
  });
  const last = reg.versions.at(-1);
  if (!last) out.push('registry is empty');
  else {
    if (!describesCheckout(last, current)) out.push(`the current checkout's rules fingerprint is not registered as the latest approved version (${last.rules_version}); a rules update must add its registry entry in the same PR`);
    if (last.rules_version !== engineVersion) out.push(`ENGINE_VERSION ${engineVersion} != latest registered ${last.rules_version}`);
  }
  return out;
}

/**
 * Check that the frozen save may switch to `target`: target is registered, equals the running checkout, and
 * directly follows the frozen version (no skipped approvals). Returns both registry entries.
 */
export function planAdoption(reg: Registry, frozen: FrozenFingerprint | undefined, target: string, current: CurrentRules): { from: RulesVersion; to: RulesVersion } {
  if (!frozen) throw new RulesError('NOT_ACTIVE', 'the save has no frozen rules yet (Day15 activation freezes the current rules; nothing to adopt)');
  const to = byVersion(reg, target);
  if (!to) throw new RulesError('UNREGISTERED', `rules version ${target} is not in ${REGISTRY_REL} (only approved, merged versions can be adopted)`);
  if (!describesCheckout(to, current)) throw new RulesError('CHECKOUT_MISMATCH', `the running engine/params are not ${to.rules_version} (fingerprint differs); check out the approved version first`);
  const from = byFrozen(reg, frozen);
  if (!from) throw new RulesError('FROZEN_UNKNOWN', 'the frozen rules of this save are not a registered version; refusing');
  if (from === to || same(from.fingerprint, to.fingerprint)) throw new RulesError('ALREADY_ACTIVE', `${to.rules_version} is already the frozen rules version`);
  if (to.previous !== from.rules_version) throw new RulesError('SKIPPED_VERSION', `${to.rules_version} follows ${to.previous}, but the save is frozen at ${from.rules_version}; adopt the versions in order`);
  if (isFingerprintV2(frozen) && !to.fingerprint_v2) throw new RulesError('V2_DOWNGRADE', `the save is frozen with a v2 fingerprint, but ${to.rules_version} has no fingerprint_v2; refusing to go back to v1`);
  return { from, to };
}

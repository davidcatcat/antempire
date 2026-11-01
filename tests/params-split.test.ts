/**
 * The species/world split is LOSSLESS and value-preserving:
 *  - every one of the 157 numeric parameters in sim/params.json appears exactly once (legacy_path) in
 *    species/*.json or world/*.json with the identical value and the original metadata fields;
 *  - every other numeric parameter is a constant moved verbatim out of v6 code (moved_from_code);
 *  - every parameter carries assumption:true and a basis ∈ {文獻支持, 一般生理學, 遊戲假設};
 *  - the ONLY permitted deviations are those listed in tests/golden/approved-rule-changes.json
 *    (approved rules updates: changed values and removed unused parameters).
 * Once sim/params.json is archived, tests/golden/legacy-params-snapshot.json is used instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { validateParamTree, resolveBundle } from '../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { legacyIndex } from './lib/scenarios.ts';
import { approvedChanges } from './lib/approved-changes.ts';

const legacyFile = fs.existsSync(path.join(REPO_ROOT, 'sim/params.json')) ? 'sim/params.json' : 'tests/golden/legacy-params-snapshot.json';
const legacy = readJson(legacyFile), bundle = loadBundle();
const legacyLeaves: [string, any][] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
for (const [sec, group] of Object.entries(legacy)) if (group && typeof group === 'object' && !Array.isArray(group)) for (const [k, item] of Object.entries(group as object)) if (item && typeof item === 'object' && 'value' in item) legacyLeaves.push([`${sec}.${k}`, item]);
const index = legacyIndex(bundle);
const approved = approvedChanges(), removed = new Set(approved.filter((c) => c.kind === 'param_removed').map((c) => c.legacy_path));
const changedLegacy = new Map(approved.filter((c) => c.kind === 'param' && c.legacy_path).map((c) => [c.legacy_path as string, c]));
let checked = 0, moved = 0, total = 0, removedCount = 0;
for (const [p, item] of legacyLeaves) {
  const entry: any = index.get(p); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (removed.has(p)) { assert.ok(!entry, `approved removal ${p} still present`); removedCount++; continue; }
  assert.ok(entry, 'legacy parameter not found in split files: ' + p);
  const ch = changedLegacy.get(p);
  if (ch) { assert.ok(Object.is(item.value, ch.from) && Object.is(entry.value, ch.to), `approved change ${p} must be ${ch.from} -> ${ch.to}`); checked++; continue; }
  assert.ok(Object.is(entry.value, item.value), `value changed for ${p}: ${item.value} -> ${entry.value}`);
  for (const [k, v] of Object.entries(item)) assert.deepEqual(entry[k], v, `metadata field ${k} changed for ${p}`);
  checked++;
}
assert.equal(index.size, legacyLeaves.length - removedCount, 'a legacy_path is used more than once or points nowhere');
const walk = (node: any): void => { if (!node || typeof node !== 'object') return; if ('value' in node) { total++; if (node.legacy_path === null) { assert.ok(typeof node.moved_from_code === 'string' && node.moved_from_code.length > 0, 'new parameter without provenance'); moved++; } return; } for (const v of Object.values(node)) walk(v); }; // eslint-disable-line @typescript-eslint/no-explicit-any
walk(bundle.world); for (const f of Object.values(bundle.species)) walk(f);
assert.equal(total, checked + moved, 'every parameter is either a legacy parameter or a moved code constant');
let tagged = validateParamTree(bundle.world, 'world'); for (const [id, f] of Object.entries(bundle.species)) tagged += validateParamTree(f, id);
assert.equal(tagged, total);
// The route topology (non-numeric) moved verbatim too.
assert.deepEqual((bundle.world as any).routes.topology.edges, legacy.foraging_route_topology.edges); // eslint-disable-line @typescript-eslint/no-explicit-any
resolveBundle(bundle); // every parameter the engine reads resolves
console.log(JSON.stringify({ legacy_source: legacyFile, legacy_parameters: legacyLeaves.length, preserved_identically: checked, removed_by_approved_rules_update: removedCount, moved_code_constants: moved, total_parameters: total, all_tagged_with_basis: tagged }, null, 2));

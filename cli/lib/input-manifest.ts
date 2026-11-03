/**
 * Issue #51 (Issue #49 N3 / #43 R12): an input manifest built from what the evaluation ACTUALLY uses, not from a
 * hand-written list.
 *  - code: the import closure of an entry script, restricted to cli/ (engine/ and the parameter files are covered by
 *    the rules fingerprint, cli/lib/fingerprint.ts);
 *  - data: every file read from disk while loading the parameter bundle and initialising every Day0 founding in every
 *    season (fs.readFileSync is observed while that runs), minus the parameter files the rules fingerprint covers.
 *    Each data file is recorded with its sha256, size, its own `schema` field and its provenance / source block.
 * Missing an input that the initializer really reads is therefore not possible by forgetting to list it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle, ruleFiles } from './load.ts';
import { SEASONS, SUPPORTED_FOUNDINGS, buildDay0, seasonStart } from './day0.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const MANIFEST_SCHEMA = 'antempire.input-manifest.v2';
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const rel = (root: string, f: string) => path.relative(root, path.resolve(f)).split(path.sep).join('/');

/** Runs `fn` and returns the repository files it read (relative paths, sorted). */
export function trackReads<T>(fn: () => T, root = REPO_ROOT): { result: T; files: string[] } {
  const files = new Set<string>(), orig = fs.readFileSync;
  (fs as Any).readFileSync = (p: Any, ...rest: Any[]) => {
    if (typeof p === 'string' || p instanceof URL) { const r = rel(root, p instanceof URL ? p.pathname : p); if (!r.startsWith('..') && !r.startsWith('node_modules/')) files.add(r); }
    return (orig as Any)(p, ...rest);
  };
  try { return { result: fn(), files: [...files].sort() }; } finally { (fs as Any).readFileSync = orig; }
}

/** Relative-import closure of `entry` (repository path), limited to files under `within` (default cli/). */
export function importClosure(entry: string, root = REPO_ROOT, within = 'cli/'): string[] {
  const seen = new Set<string>(), todo = [entry];
  while (todo.length) {
    const f = todo.pop() as string;
    if (seen.has(f) || !f.startsWith(within)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    // every relative module specifier in an import/export ... from '...', a side-effect import or a dynamic import(),
    // including multi-line import lists (independent review of #54)
    const specs = [...src.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
    for (const spec of specs) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      if (target.endsWith('.ts')) todo.push(target);
    }
  }
  return [...seen].sort();
}

/** Data files the Day0 evaluation reads (parameter files excluded: the rules fingerprint covers them). */
export function day0DataInputs(root = REPO_ROOT): string[] {
  const params = new Set(ruleFiles(root).params);
  const { files } = trackReads(() => {
    const b = loadBundle(root);
    for (const f of SUPPORTED_FOUNDINGS) for (const s of SEASONS) buildDay0(f, 1, seasonStart(s, root), b, root);
  }, root);
  return files.filter((f) => !params.has(f) && !f.endsWith('.ts'));
}

export interface DataEntry { sha256: string; bytes: number; schema: string | null; source: Any }
export function dataEntry(f: string, root = REPO_ROOT): DataEntry {
  const buf = fs.readFileSync(path.join(root, f));
  let json: Any = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
  return { sha256: sha(buf), bytes: buf.length, schema: json?.schema ?? null, source: json?.provenance ?? json?.source ?? json?.sources ?? null };
}
export interface InputManifest { schema: typeof MANIFEST_SCHEMA; entry: string; code: Record<string, string>; data: Record<string, DataEntry> }
export function buildInputManifest(entry: string, root = REPO_ROOT): InputManifest {
  return {
    schema: MANIFEST_SCHEMA, entry,
    code: Object.fromEntries(importClosure(entry, root).map((f) => [f, sha(fs.readFileSync(path.join(root, f)))])),
    data: Object.fromEntries(day0DataInputs(root).map((f) => [f, dataEntry(f, root)])),
  };
}

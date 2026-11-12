/**
 * Rules fingerprint v2 (Owner decision 52): a versioned content hash of everything that decides what one official
 * game day computes, so that a code change outside the v1 file list (top-level engine/*.ts) can no longer slip past
 * the frozen-rules check, and a change to UI / docs / tests / tooling never invalidates a save.
 *
 * Fixed rules (docs/rules-fingerprint-v2.md):
 *  - source: the static import closure of the fixed entry points V2_ENTRY_POINTS (every relative `import` /
 *    `export ... from` / `import('...')` with a literal specifier, type-only imports included). A bare package
 *    import inside the closure is refused (its code would be unhashed); `node:` builtins are allowed (the Node
 *    version is covered by the runtime file .nvmrc).
 *  - params: the world file and every species/*.json (the same set as v1).
 *  - data: the fixed list V2_DATA_FILES (input data the official pipeline reads) and V2_RUNTIME_FILES.
 *  - encoding: bytes must be valid UTF-8; one leading BOM is dropped; CRLF and lone CR become LF; the normalised
 *    text is hashed as UTF-8. Paths are repo-relative with '/', ASCII only, sorted by code unit (= byte order).
 *  - group hash = sha256 of "path\0sha256(normalised content)\n" lines in path order;
 *    digest = sha256 of the canonical text built by v2Digest() (schema, engine_version and the three group hashes).
 *  - no self-reference: the registry (which stores expected fingerprints), the fingerprint modules themselves and
 *    saves/journal/tests/docs/web are never hashed; reaching one of them from an entry point is an error.
 * The git commit SHA is never used: the hash depends on file content only, not on history or checkout metadata.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, SPECIES_DIR, WORLD_FILE } from './load.ts';

export const FINGERPRINT_V2_SCHEMA = 'antempire.rules-fingerprint.v2';
/** The official day pipeline: engine entry, the save mapping of one engine day, and parameter loading. */
export const V2_ENTRY_POINTS: readonly string[] = ['engine/index.ts', 'cli/lib/project-day.ts', 'cli/lib/load.ts'];
/** Input data the official pipeline reads besides the parameter files (Day15 migration climatology). */
export const V2_DATA_FILES: readonly string[] = ['data/taichung-climatology-1991-2020.json'];
/** Pinned runtime (CLAUDE.md §8: official advances run on a fixed Node version). */
export const V2_RUNTIME_FILES: readonly string[] = ['.nvmrc'];
/** Never part of the hashed set (self-reference / non-simulation content). Prefixes end with '/'. */
export const V2_NEVER_HASHED: readonly string[] = ['rules/registry.json', 'cli/lib/fingerprint.ts', 'cli/lib/fingerprint-v2.ts', 'cli/lib/rules-registry.ts', 'saves/', 'journal/', 'tests/', 'docs/', 'web/', 'reports/'];

export interface FingerprintV2 { schema: typeof FINGERPRINT_V2_SCHEMA; engine_version: string; source: string; params: string; data: string; digest: string }
export interface FingerprintV2Full extends FingerprintV2 { files: { source: string[]; params: string[]; data: string[] } }

export class FingerprintV2Error extends Error {
  code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}

const sha = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Fixed text encoding: strict UTF-8, no BOM, LF line ends. Invalid UTF-8 is refused, never repaired. */
export function normalizeText(bytes: Uint8Array, rel = '?'): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new FingerprintV2Error('NOT_UTF8', `${rel} is not valid UTF-8`); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

export const contentHash = (bytes: Uint8Array, rel = '?') => sha(normalizeText(bytes, rel));

/** Hash of one group; independent of the order of `entries`. */
export function groupHash(entries: { path: string; bytes: Uint8Array }[]): string {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!SAFE_PATH.test(e.path)) throw new FingerprintV2Error('BAD_PATH', `path ${JSON.stringify(e.path)} is not a plain repo-relative ASCII path`);
    if (seen.has(e.path)) throw new FingerprintV2Error('DUPLICATE_PATH', e.path);
    seen.add(e.path);
  }
  return sha([...entries].sort((a, b) => byCodeUnit(a.path, b.path)).map((e) => `${e.path}\0${contentHash(e.bytes, e.path)}\n`).join(''));
}

/** The digest of the v2 fields (also used to check registry / save records for consistency). */
export function v2Digest(f: Pick<FingerprintV2, 'engine_version' | 'source' | 'params' | 'data'>): string {
  return sha(`${FINGERPRINT_V2_SCHEMA}\nengine_version\0${f.engine_version}\nsource\0${f.source}\nparams\0${f.params}\ndata\0${f.data}\n`);
}

export const isFingerprintV2 = (x: unknown): x is FingerprintV2 => !!x && typeof x === 'object' && (x as { schema?: unknown }).schema === FINGERPRINT_V2_SCHEMA;

/** Structural problems of a stored v2 record (empty = well formed and self-consistent). */
export function v2RecordProblems(x: unknown): string[] {
  if (!isFingerprintV2(x)) return ['not a ' + FINGERPRINT_V2_SCHEMA + ' record'];
  const out: string[] = [];
  for (const k of ['source', 'params', 'data', 'digest'] as const) if (!/^[0-9a-f]{64}$/.test(x[k] ?? '')) out.push(`malformed ${k}`);
  if (typeof x.engine_version !== 'string' || !x.engine_version) out.push('engine_version missing');
  if (!out.length && v2Digest(x) !== x.digest) out.push('digest does not match its fields');
  return out;
}

/** The stored form (no file lists), with a fixed key order. */
export const v2Record = (f: FingerprintV2): FingerprintV2 => ({ schema: FINGERPRINT_V2_SCHEMA, engine_version: f.engine_version, source: f.source, params: f.params, data: f.data, digest: f.digest });

const neverHashed = (rel: string) => V2_NEVER_HASHED.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));

/** Comments are removed so that commented-out imports do not count (URLs such as 'https://' are kept). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** Module specifiers a source file imports (static, re-exports, side-effect and literal dynamic imports). */
export function importSpecifiers(text: string): string[] {
  const src = stripComments(text), out = new Set<string>();
  for (const re of SPECIFIERS) for (const m of src.matchAll(re)) out.add(m[1]);
  return [...out].sort(byCodeUnit);
}

/** The import closure of the entry points, as sorted repo-relative paths. */
export function sourceClosure(root = REPO_ROOT, entries: readonly string[] = V2_ENTRY_POINTS): string[] {
  const seen = new Set<string>(), todo = [...entries];
  while (todo.length) {
    const rel = todo.pop() as string;
    if (seen.has(rel)) continue;
    if (neverHashed(rel)) throw new FingerprintV2Error('SELF_REFERENCE', `${rel} is reached from the official pipeline but must never be hashed`);
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new FingerprintV2Error('MISSING_SOURCE', `${rel} (imported by the official pipeline) does not exist`);
    seen.add(rel);
    const text = normalizeText(fs.readFileSync(abs), rel);
    for (const spec of importSpecifiers(text)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('./') && !spec.startsWith('../')) throw new FingerprintV2Error('UNHASHED_DEPENDENCY', `${rel} imports package ${spec}; its code would not be in the fingerprint`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (target.startsWith('../') || !path.posix.extname(target)) throw new FingerprintV2Error('BAD_IMPORT', `${rel} imports ${spec} (outside the repo or without a file extension)`);
      todo.push(target);
    }
  }
  return [...seen].sort(byCodeUnit);
}

export function v2ParamFiles(root = REPO_ROOT): string[] {
  const species = fs.readdirSync(path.join(root, SPECIES_DIR)).filter((f) => f.endsWith('.json')).map((f) => `${SPECIES_DIR}/${f}`);
  return [WORLD_FILE, ...species].sort(byCodeUnit);
}

/** ENGINE_VERSION as written in the hashed source (so a fingerprint of another root reports that root's version). */
function engineVersionOf(root: string, files: string[]): string {
  const found = files.flatMap((f) => [...normalizeText(fs.readFileSync(path.join(root, f)), f).matchAll(/export const ENGINE_VERSION\s*=\s*'([^'\n]+)'/g)].map((m) => m[1]));
  if (found.length !== 1) throw new FingerprintV2Error('ENGINE_VERSION', `expected exactly one ENGINE_VERSION literal in the hashed source, found ${found.length}`);
  return found[0];
}

export function fingerprintV2(root = REPO_ROOT): FingerprintV2Full {
  const source = sourceClosure(root), params = v2ParamFiles(root), data = [...V2_DATA_FILES, ...V2_RUNTIME_FILES].sort(byCodeUnit);
  for (const f of [...params, ...data]) if (neverHashed(f)) throw new FingerprintV2Error('SELF_REFERENCE', f);
  const group = (files: string[]) => groupHash(files.map((f) => ({ path: f, bytes: fs.readFileSync(path.join(root, f)) })));
  const fields = { engine_version: engineVersionOf(root, source), source: group(source), params: group(params), data: group(data) };
  return { schema: FINGERPRINT_V2_SCHEMA, ...fields, digest: v2Digest(fields), files: { source, params, data } };
}

if (import.meta.main) {
  const fp = fingerprintV2();
  console.log(JSON.stringify({ ...v2Record(fp), files: fp.files }, null, 2));
}

/**
 * Static import-boundary checker for the non-official experiment Worker (Owner decision #39, CLAUDE.md §9 B).
 * Pure function over an in-memory file map so the same code runs on the real repository and on negative fixtures.
 *   - Walks the transitive import graph from every file in the Worker entry directory.
 *   - Every reached module must sit under an allowed prefix and under no denied prefix.
 *   - No `node:` or bare-package imports, no non-literal dynamic import, no nested Worker.
 *   - No storage / network / file-system globals anywhere in the graph (no bypass of the isolation).
 *   - Reached engine modules (and every module under `pure_module_prefixes`, e.g. the allowlisted P0-A2 core) must not
 *     read wall clocks, frame timers or Math.random (simulation time only).
 *   - No path strings naming official saves / journals in the graph.
 *   - web/src may create a Worker only in the listed client files.
 *   - Nothing official (top-level engine/*.ts, engine/scheduler, engine/clock, cli/, web/src) imports the Worker dir.
 */
import path from 'node:path';

export interface Boundary {
  worker_entry_dir: string; worker_client_files: string[]; allowed_import_prefixes: string[]; denied_import_prefixes: string[];
  forbidden_globals_in_worker_graph: string[]; forbidden_in_engine_modules: string[]; forbidden_path_strings_in_worker_graph: string[];
  experimental_save_store: { files: string[]; database_name_prefix: string };
  /** module prefixes held to forbidden_in_engine_modules (default: engine/ only) */
  pure_module_prefixes?: string[];
}
export interface Violation { file: string; rule: string; detail: string }

export const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const blankStrings = (s: string) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every module specifier a file names: static import/export-from, side-effect import, literal dynamic import. */
export function specifiers(src: string): { spec: string | null; form: string }[] {
  const s = stripComments(src), out: { spec: string | null; form: string }[] = [];
  for (const m of s.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g)) out.push({ spec: m[2], form: 'from' });
  for (const m of s.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) out.push({ spec: m[2], form: 'side-effect' });
  for (const m of s.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const lit = /^\s*(['"])([^'"]+)\1\s*$/.exec(m[1]);
    out.push({ spec: lit ? lit[2] : null, form: 'dynamic' });
  }
  return out;
}

const norm = (p: string) => p.split(path.sep).join('/');
const under = (file: string, prefix: string) => prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix;

export function checkBoundary(files: Map<string, string>, b: Boundary): { violations: Violation[]; reached: string[]; checks: number } {
  const v: Violation[] = []; let checks = 0;
  const bad = (file: string, rule: string, detail: string) => v.push({ file, rule, detail });
  const entry = b.worker_entry_dir.replace(/\/?$/, '/');
  const roots = [...files.keys()].filter((f) => f.startsWith(entry) && /\.(ts|js|mjs)$/.test(f));
  const seen = new Set<string>(), queue = [...roots];
  while (queue.length) {
    const f = queue.shift()!; if (seen.has(f)) continue; seen.add(f);
    const src = files.get(f);
    if (src === undefined) { bad(f, 'missing', 'imported module does not exist'); continue; }
    checks++;
    if (b.denied_import_prefixes.some((p) => under(f, p))) bad(f, 'denied-module', 'module is on the denied list');
    if (!b.allowed_import_prefixes.some((p) => under(f, p))) bad(f, 'not-allowlisted', 'module is outside the import allowlist');
    for (const { spec, form } of specifiers(src)) {
      checks++;
      if (spec === null) { bad(f, 'dynamic-import', 'non-literal dynamic import'); continue; }
      if (spec.startsWith('node:')) { bad(f, 'node-import', spec); continue; }
      if (!spec.startsWith('.')) { bad(f, 'bare-import', `${form} ${spec}`); continue; }
      queue.push(norm(path.posix.normalize(path.posix.join(path.posix.dirname(f), spec))));
    }
    const code = blankStrings(stripComments(src)), text = stripComments(src);
    // Matched as a bare word anywhere (also self.x / globalThis.x) and as a quoted name (self['x']): deliberately strict.
    for (const g of b.forbidden_globals_in_worker_graph) { checks++; if (new RegExp(`(^|[^\\w$])${esc(g)}(?![\\w$])`).test(code) || new RegExp(`['"\`]${esc(g)}['"\`]`).test(text)) bad(f, 'forbidden-global', g); }
    checks++; if (/\bnew\s+(Shared)?Worker\s*\(/.test(code)) bad(f, 'nested-worker', 'Worker graph may not spawn workers');
    for (const p of b.forbidden_path_strings_in_worker_graph) { checks++; if (text.includes(p)) bad(f, 'official-path-string', p); }
    if ((b.pure_module_prefixes ?? ['engine/']).some((p) => under(f, p))) for (const t of b.forbidden_in_engine_modules) { checks++; if (code.includes(t)) bad(f, 'engine-impurity', t); }
  }
  // web/src: Worker creation only in the client files; client files only import viewer modules (checked by web.test).
  for (const [f, src] of files) {
    if (!f.startsWith('web/src/')) continue;
    checks++;
    if (/\bnew\s+(Shared)?Worker\s*\(/.test(blankStrings(stripComments(src))) && !b.worker_client_files.includes(f)) bad(f, 'worker-outside-client', 'only the listed client files may create the experiment Worker');
  }
  // Browser persistence: only the experimental save store may touch IndexedDB / StorageManager / Web Locks, only for
  // databases named with the experiment prefix, and it may not fetch, import non-viewer modules or name official data.
  const store = new Set(b.experimental_save_store.files);
  for (const [f, src] of files) {
    if (!f.startsWith('web/src/')) continue;
    const code = blankStrings(stripComments(src)), text = stripComments(src); checks++;
    const touches = /(^|[^\w$])(indexedDB|IDBFactory|caches)(?![\w$])|navigator\s*\.\s*(storage|locks)\b/.test(code) || /['"`](indexedDB|caches|storage|locks)['"`]/.test(text);
    if (touches && !store.has(f)) bad(f, 'storage-outside-store', 'only the experimental save store may use browser persistence');
    if (!store.has(f)) continue;
    for (const g of ['localStorage', 'sessionStorage', 'caches', 'fetch', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'showSaveFilePicker', 'showDirectoryPicker']) { checks++; if (new RegExp(`(^|[^\\w$])${esc(g)}(?![\\w$])`).test(code)) bad(f, 'store-forbidden-api', g); }
    for (const p of b.forbidden_path_strings_in_worker_graph) { checks++; if (text.includes(p)) bad(f, 'official-path-string', p); }
    for (const { spec } of specifiers(src)) { checks++; if (!spec || !spec.startsWith('./')) bad(f, 'store-import', String(spec)); }
    for (const m of text.matchAll(/\.open\s*\(\s*([^,)]*)/g)) { checks++; const lit = /^\s*(['"`])([^'"`]*)\1\s*$/.exec(m[1]); if (!lit || !lit[2].startsWith(b.experimental_save_store.database_name_prefix)) bad(f, 'store-db-name', `open(${m[1].trim()}) must use a literal name starting with ${b.experimental_save_store.database_name_prefix}`); }
  }
  // Official code must not reach into the Worker dir.
  const official = (f: string) => /^engine\/[^/]+\.ts$/.test(f) || f.startsWith('engine/scheduler/') || f.startsWith('engine/clock/') || f.startsWith('cli/') || f.startsWith('web/src/');
  for (const [f, src] of files) {
    if (!official(f)) continue;
    for (const { spec } of specifiers(src)) {
      if (!spec || !spec.startsWith('.')) continue; checks++;
      const t = norm(path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)));
      if (t.startsWith(entry)) bad(f, 'official-imports-worker', t);
    }
  }
  return { violations: v, reached: [...seen].sort(), checks };
}

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
 *   - Deterministic math (Owner ruling #190 scheme A, extended to exp / log / ** by the detmath-exp rules update): in the
 *     graph, Math only as Math.<allowed member> and ** only with a non-negative integer literal exponent; exempt
 *     functions (official-engine samplers in a shared module) must be unreachable: never imported by a graph module,
 *     never called by the rest of their own module, and their module never imported as a namespace / re-exported.
 *   - web/src may create a Worker only in the listed client files.
 *   - Nothing official (top-level engine/*.ts, engine/scheduler, engine/clock, cli/, web/src) imports the Worker dir,
 *     except the listed Node verifier files (Owner ruling #200, option C: Node recomputes with the SAME core). A verifier
 *     file may only read: no file-system writes, no child processes, no network, no official path strings.
 */
import path from 'node:path';

export interface Boundary {
  worker_entry_dir: string; worker_client_files: string[]; allowed_import_prefixes: string[]; denied_import_prefixes: string[];
  forbidden_globals_in_worker_graph: string[]; forbidden_in_engine_modules: string[]; forbidden_path_strings_in_worker_graph: string[];
  experimental_save_store: { files: string[]; database_name_prefix: string };
  /** module prefixes held to forbidden_in_engine_modules (default: engine/ only) */
  pure_module_prefixes?: string[];
  node_verifier?: { files: string[]; forbidden_in_files: string[] };
  deterministic_math_in_worker_graph?: { allowed_math_members: string[]; exempt_unreached_functions: { file: string; functions: string[] }[] };
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

/** the source text of `export function name(...) {...}` (brace-matched on comment- and string-blanked code), or null */
function functionSpan(code: string, name: string): [number, number] | null {
  const m = new RegExp(`(^|\\n)\\s*export\\s+function\\s+${esc(name)}\\s*\\(`).exec(code); if (!m) return null;
  let depth = 0;
  // skip the parameter list's own braces: the body starts at the first '{' after the closing ')' of the signature
  let paren = 1, j = m.index + m[0].length;
  for (; j < code.length && paren > 0; j++) { if (code[j] === '(') paren++; else if (code[j] === ')') paren--; }
  const i = code.indexOf('{', j);
  for (let k = i; k < code.length; k++) { if (code[k] === '{') depth++; else if (code[k] === '}' && --depth === 0) return [m.index, k + 1]; }
  return null;
}
/** violations of the deterministic-math rule in one module's (comment- and string-blanked) code */
export function approximatedMath(code: string, allowed: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(^|[^\w$.])Math(?![\w$])(\s*\.\s*([\w$]+))?/g)) if (!m[3] || !allowed.includes(m[3])) out.push(m[3] ? `Math.${m[3]}` : 'Math (not as Math.<member>)');
  for (const m of code.matchAll(/\*\*(?!=)\s*([^\s;,)]*)/g)) if (!/^\d+(?![\d.eExXoObBn_])/.test(m[1])) out.push(`** ${m[1].slice(0, 20)}`);
  return out;
}

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
    const dm = b.deterministic_math_in_worker_graph;
    if (dm && /\.(ts|js|mjs)$/.test(f)) {
      let c = code;
      for (const ex of dm.exempt_unreached_functions.filter((e) => e.file === f)) for (const fn of ex.functions) {
        const span = functionSpan(c, fn); checks++;
        if (span) c = c.slice(0, span[0]) + c.slice(span[1]); // absent: nothing exempted (any Math use is then flagged)
      }
      for (const ex of dm.exempt_unreached_functions.filter((e) => e.file === f)) for (const fn of ex.functions) { checks++; if (new RegExp(`(^|[^\\w$])${esc(fn)}(?![\\w$])`).test(c)) bad(f, 'approximated-math', `exempt function ${fn} is used inside its own module`); }
      checks++; for (const x of approximatedMath(c, dm.allowed_math_members)) bad(f, 'approximated-math', x);
    }
  }
  // exempt (official-engine) functions must stay unreachable from the Worker graph
  for (const ex of b.deterministic_math_in_worker_graph?.exempt_unreached_functions ?? []) for (const f of seen) {
    const src = files.get(f); if (src === undefined) continue;
    const code = stripComments(src);
    for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?([^'"`;]*?)\bfrom\s*(['"])([^'"]+)\4/g)) {
      if (norm(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[5]))) !== ex.file || m[2]) continue;
      checks++;
      const names = /\{([^}]*)\}/.exec(m[3])?.[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean) ?? [];
      if (/\*/.test(m[3]) || (m[1] === 'export' && !/\{/.test(m[3]))) bad(f, 'approximated-math', `${m[1]} * from ${ex.file} would expose ${ex.functions.join(', ')}`);
      for (const n of names) if (ex.functions.includes(n)) bad(f, 'approximated-math', `imports ${n} from ${ex.file} (official-engine sampler with implementation-approximated math)`);
    }
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
  const verifiers = new Set(b.node_verifier?.files ?? []);
  for (const [f, src] of files) {
    if (!official(f)) continue;
    const verifier = verifiers.has(f) && f.startsWith('cli/');
    for (const { spec } of specifiers(src)) {
      if (!spec || !spec.startsWith('.')) continue; checks++;
      const t = norm(path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)));
      if (t.startsWith(entry) && !verifier) bad(f, 'official-imports-worker', t);
      if (verifier && !t.startsWith(entry)) bad(f, 'verifier-import', `${t}: a verifier imports only the Worker core`);
    }
    if (!verifier) continue;
    const code = stripComments(src);
    for (const x of b.node_verifier!.forbidden_in_files) { checks++; if (code.includes(x)) bad(f, 'verifier-writes', `${x}: the Node verifier only reads its input`); }
    for (const p of b.forbidden_path_strings_in_worker_graph) { checks++; if (code.includes(p)) bad(f, 'official-path-string', p); }
  }
  return { violations: v, reached: [...seen].sort(), checks };
}

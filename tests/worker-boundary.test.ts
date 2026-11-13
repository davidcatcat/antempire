/**
 * Owner decision #39: limited CLAUDE.md §9 exception. Only the non-official experiment Worker entry
 * (prototypes/continuous-world/worker/) may import approved pure engine modules; web/src talks to it only through the
 * listed client file via postMessage. This blocking test (1) proves the checker catches every forbidden form on
 * negative fixtures and (2) runs it on the real repository. Until PR 2 adds the Worker, the real scan checks that the
 * boundary file is well formed and that nothing official references the Worker directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { checkBoundary, specifiers, type Boundary } from './lib/worker-boundary.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const B: Boundary & Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/continuous-world/worker-boundary.json'), 'utf8'));

// 0. boundary file shape: official tooling is denied, nothing official is allowlisted.
ok(B.schema === 'antempire.worker-boundary.v1' && B.mode === 'non_official_experiment_only', 'boundary file schema and mode');
ok(B.label_zh === '非正式實驗世界／不屬於正式遊戲歷史', 'required non-official label is recorded');
for (const p of ['cli/', 'saves/', 'journal/', 'engine/index.ts', 'engine/day.ts']) ok(B.denied_import_prefixes.includes(p), `denied: ${p}`);
for (const p of B.allowed_import_prefixes) ok(!B.denied_import_prefixes.some((d) => p.startsWith(d) || d.startsWith(p)), `allowlist entry ${p} does not overlap the denied list`);
for (const p of B.allowed_import_prefixes) ok(!/^(cli|saves|journal|web|tests)\//.test(p) && p !== 'engine/' , `allowlist entry ${p} is narrow and not official tooling`);
for (const g of ['indexedDB', 'caches', 'localStorage', 'fetch', 'WebSocket', 'importScripts']) ok(B.forbidden_globals_in_worker_graph.includes(g), `forbidden global listed: ${g}`);
ok(B.worker_client_files.every((f) => f.startsWith('web/src/')), 'client files live in web/src');
// P0-A2 core (Owner 2026-11-12, #156 phase 3): only named core files, never tools/ or out/, all held to the purity rules
const P0 = 'prototypes/p0a2-24h/';
const p0Allowed = B.allowed_import_prefixes.filter((p) => p.startsWith(P0));
ok(p0Allowed.length > 0 && p0Allowed.every((p) => /^prototypes\/p0a2-24h\/[a-z0-9-]+\.(ts|json)$/.test(p)), `P0-A2 allowlist entries are single core files (${p0Allowed.join(', ')})`);
ok(B.denied_import_prefixes.includes(`${P0}tools/`) && B.denied_import_prefixes.includes(`${P0}out/`), 'P0-A2 tools/ and out/ are denied');
ok((B.pure_module_prefixes ?? []).includes('engine/') && (B.pure_module_prefixes ?? []).includes(P0), 'engine/ and the P0-A2 core are held to the purity rules');
ok(/Owner/.test(B.how_to_extend as string) && /2026-11-12/.test(B.how_to_extend as string), 'how_to_extend records the Owner authorisation that replaces the Codex fixed-SHA step');
ok(B.node_verifier !== undefined && JSON.stringify(B.node_verifier.files) === '["cli/verify-save.ts"]' && ['writeFile', 'child_process', 'fetch('].every((x) => B.node_verifier!.forbidden_in_files.includes(x)), 'Node verifier exception (#200): exactly cli/verify-save.ts, read-only');
ok(B.experimental_save_store.files.every((f) => f.startsWith('web/src/experimental/')) && B.experimental_save_store.database_name_prefix === 'antempire-experiment-', 'save store is confined to web/src/experimental and experiment-prefixed databases');

// 1. specifier extraction catches every import form.
const forms: [string, string | null][] = [["import { a } from './a.ts';", './a.ts'], ["import type { T } from '../t.ts';", '../t.ts'], ["export * from './e.ts';", './e.ts'], ["export { x } from './x.ts';", './x.ts'], ["import './side.ts';", './side.ts'], ["const m = await import('./dyn.ts');", './dyn.ts'], ["const m = await import(name);", null], ["import {\n a,\n b\n} from './multi.ts';", './multi.ts']];
for (const [src, want] of forms) ok(specifiers(src).some((s) => s.spec === want), `specifier extraction: ${src.replace(/\n/g, ' ')}`);
ok(specifiers("// import x from '../cli/advance.ts';\n/* import '../saves/main.json' */").length === 0, 'commented-out imports are ignored');

// 2. negative fixtures: each must produce exactly the expected rule.
const W = 'prototypes/continuous-world/worker/';
const base = (): Map<string, string> => new Map([
  [`${W}entry.ts`, "import { step } from './core.ts';\nself.onmessage = (e) => { postMessage(step(e.data)); };"],
  [`${W}core.ts`, "import { makeRng } from '../../../engine/rng.ts';\nimport { schedule } from '../../../engine/scheduler/world-events.ts';\nexport const step = (x: unknown) => x;"],
  ['engine/rng.ts', 'export const makeRng = (s: number) => s;'],
  ['engine/scheduler/world-events.ts', 'export const schedule = 1;'],
  ['web/src/experimental/save-store.ts', "const DB = 'antempire-experiment-worlds';\nexport const open = () => indexedDB.open('antempire-experiment-worlds', 1);\nexport const persist = () => navigator.storage.persist();\nexport const lock = (id: string, f: () => Promise<void>) => navigator.locks.request(`antempire-experiment-world:${id}`, f);"],
  ['web/src/experimental/worker-client.ts', "export const start = () => new Worker(new URL('./continuous-world-worker.js', import.meta.url), { type: 'module' });"],
  ['web/src/game.ts', "import { start } from './experimental/worker-client.ts';"],
  ['cli/advance.ts', "export const advance = 1;"],
]);
const clean = checkBoundary(new Map([...base(), ['cli/verify-save.ts', "import fs from 'node:fs';\nimport { step } from '../prototypes/continuous-world/worker/core.ts';\nconst t = fs.readFileSync(process.argv[2], 'utf8');"]]), B);
ok(clean.violations.length === 0, `clean fixture passes (${JSON.stringify(clean.violations)})`);
{ // allowed forms: exact Math members, integer-literal powers, an exempt sampler that the graph does not import
  const m = base(); m.set(`${W}core.ts`, "import { makeRng } from '../../../engine/rng.ts';\nexport const step = (x: number) => Math.floor(Math.sqrt(Math.abs(x)) * Math.PI) + 2 ** 52 + x ** 2;");
  m.set('engine/rng.ts', 'export const makeRng = (s: number) => s;\nexport function normal(g: () => number): number { return Math.sqrt(-2 * Math.log(g())) * Math.cos(2 * Math.PI * g()); }');
  const r = checkBoundary(m, B); ok(r.violations.length === 0, `deterministic-math rule accepts exact Math members, integer-literal ** and an unreached exempt sampler (${JSON.stringify(r.violations)})`);
}
ok(JSON.stringify(B.deterministic_math_in_worker_graph?.exempt_unreached_functions.map((e) => [e.file, e.functions])) === JSON.stringify([['engine/rng.ts', ['normal', 'gamma']]]) && !['exp', 'log', 'pow', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'sinh', 'cosh', 'tanh', 'cbrt', 'hypot', 'expm1', 'log1p', 'log2', 'log10', 'random'].some((n) => B.deterministic_math_in_worker_graph!.allowed_math_members.includes(n)), 'deterministic-math rule: no approximated member allowed; the only exemption is the unreached official samplers normal / gamma of engine/rng.ts');
ok(clean.reached.includes('engine/rng.ts') && clean.reached.includes('engine/scheduler/world-events.ts'), 'transitive graph reaches the allowlisted engine modules');
const cases: [string, (m: Map<string, string>) => void, string][] = [
  ['cli import', (m) => m.set(`${W}core.ts`, "import { advance } from '../../../cli/advance.ts';"), 'denied-module'],
  ['official day loop', (m) => { m.set('engine/day.ts', 'export const d = 1;'); m.set(`${W}core.ts`, "import { d } from '../../../engine/day.ts';"); }, 'denied-module'],
  ['engine index', (m) => { m.set('engine/index.ts', 'export const s = 1;'); m.set(`${W}core.ts`, "export * from '../../../engine/index.ts';"); }, 'denied-module'],
  ['saves json', (m) => { m.set('saves/main.json', '{}'); m.set(`${W}core.ts`, "import s from '../../../saves/main.json' with { type: 'json' };"); }, 'denied-module'],
  ['non-allowlisted engine module', (m) => { m.set('engine/workers.ts', 'export const w = 1;'); m.set(`${W}core.ts`, "import { w } from '../../../engine/workers.ts';"); }, 'not-allowlisted'],
  ['transitive leak via allowlisted module', (m) => { m.set('engine/rng.ts', "import { advance } from '../cli/advance.ts';\nexport const makeRng = 1;"); }, 'denied-module'],
  ['node builtin', (m) => m.set(`${W}core.ts`, "import fs from 'node:fs';"), 'node-import'],
  ['bare package', (m) => m.set(`${W}core.ts`, "import x from 'idb-keyval';"), 'bare-import'],
  ['computed dynamic import', (m) => m.set(`${W}core.ts`, "const p = '../../../cli/advance.ts'; await import(p);"), 'dynamic-import'],
  ['IndexedDB', (m) => m.set(`${W}core.ts`, "indexedDB.open('w');"), 'forbidden-global'],
  ['Cache API', (m) => m.set(`${W}core.ts`, "caches.open('w');"), 'forbidden-global'],
  ['self.caches', (m) => m.set(`${W}core.ts`, "self.caches.open('w');"), 'forbidden-global'],
  ['globalThis index', (m) => m.set(`${W}core.ts`, "globalThis['indexedDB'].open('w');"), 'forbidden-global'],
  ['localStorage', (m) => m.set(`${W}core.ts`, "localStorage.setItem('k','v');"), 'forbidden-global'],
  ['fetch write', (m) => m.set(`${W}core.ts`, "fetch('/x', { method: 'POST' });"), 'forbidden-global'],
  ['WebSocket', (m) => m.set(`${W}core.ts`, "new WebSocket('wss://x');"), 'forbidden-global'],
  ['importScripts', (m) => m.set(`${W}entry.ts`, "importScripts('x.js');"), 'forbidden-global'],
  ['file system access', (m) => m.set(`${W}core.ts`, "await navigator.storage.getDirectory();"), 'forbidden-global'],
  ['nested worker', (m) => m.set(`${W}core.ts`, "new Worker('x.js');"), 'nested-worker'],
  ['saves path string', (m) => m.set(`${W}core.ts`, "const p = 'saves/main.json';"), 'official-path-string'],
  ['journal path string', (m) => m.set(`${W}core.ts`, "const p = 'journal/v2-day-0015.md';"), 'official-path-string'],
  ['wall clock in engine module', (m) => m.set('engine/rng.ts', 'export const makeRng = () => Date.now();'), 'engine-impurity'],
  ['frame timer in engine module', (m) => m.set('engine/scheduler/world-events.ts', 'export const schedule = requestAnimationFrame;'), 'engine-impurity'],
  ['Math.random in engine module', (m) => m.set('engine/rng.ts', 'export const makeRng = () => Math.random();'), 'engine-impurity'],
  ['worker outside client', (m) => m.set('web/src/game.ts', "const w = new Worker('w.js');"), 'worker-outside-client'],
  ['official imports worker', (m) => m.set('cli/advance.ts', "import { step } from '../prototypes/continuous-world/worker/core.ts';"), 'official-imports-worker'],
  ['other cli file imports worker (only the listed verifier may)', (m) => m.set('cli/check-saves.ts', "import { step } from '../prototypes/continuous-world/worker/core.ts';"), 'official-imports-worker'],
  ['verifier writes a file', (m) => m.set('cli/verify-save.ts', "import fs from 'node:fs';\nimport { step } from '../prototypes/continuous-world/worker/core.ts';\nfs.writeFileSync('r.json', '');"), 'verifier-writes'],
  ['verifier spawns a process', (m) => m.set('cli/verify-save.ts', "import { execFileSync } from 'node:child_process';\nimport { step } from '../prototypes/continuous-world/worker/core.ts';"), 'verifier-writes'],
  ['verifier names official saves', (m) => m.set('cli/verify-save.ts', "import { step } from '../prototypes/continuous-world/worker/core.ts';\nconst p = 'saves/main.json';"), 'official-path-string'],
  ['verifier imports official tooling', (m) => m.set('cli/verify-save.ts', "import { step } from '../prototypes/continuous-world/worker/core.ts';\nimport { advance } from './advance.ts';"), 'verifier-import'],
  ['web/src imports worker dir', (m) => m.set('web/src/game.ts', "import { step } from '../../prototypes/continuous-world/worker/core.ts';"), 'official-imports-worker'],
  ['IndexedDB outside the save store', (m) => m.set('web/src/game.ts', "indexedDB.open('antempire-experiment-x');"), 'storage-outside-store'],
  ['Web Locks outside the save store', (m) => m.set('web/src/game.ts', "navigator.locks.request('w', () => 1);"), 'storage-outside-store'],
  ['save store opens a non-experiment DB', (m) => m.set('web/src/experimental/save-store.ts', "indexedDB.open('antempire-official');"), 'store-db-name'],
  ['save store computed DB name', (m) => m.set('web/src/experimental/save-store.ts', "indexedDB.open(name);"), 'store-db-name'],
  ['save store uses localStorage', (m) => m.set('web/src/experimental/save-store.ts', "localStorage.setItem('k', 'v');"), 'store-forbidden-api'],
  ['save store fetches', (m) => m.set('web/src/experimental/save-store.ts', "fetch('/upload', { method: 'POST' });"), 'store-forbidden-api'],
  ['save store names official saves', (m) => m.set('web/src/experimental/save-store.ts', "const p = 'saves/main.json';"), 'official-path-string'],
  ['save store imports engine', (m) => m.set('web/src/experimental/save-store.ts', "import { x } from '../../../engine/rng.ts';"), 'store-import'],
  ['missing module', (m) => m.set(`${W}core.ts`, "import { q } from './nope.ts';"), 'missing'],
  // P0-A2 core in the Worker graph (Owner 2026-11-12)
  ['P0-A2 tools import', (m) => { m.set('prototypes/p0a2-24h/tools/q4.ts', 'export const q = 1;'); m.set(`${W}p0.ts`, "import { q } from '../../p0a2-24h/tools/q4.ts';"); }, 'denied-module'],
  ['P0-A2 non-allowlisted module (observer)', (m) => { m.set('prototypes/p0a2-24h/observer.ts', 'export const o = 1;'); m.set(`${W}p0.ts`, "import { o } from '../../p0a2-24h/observer.ts';"); }, 'not-allowlisted'],
  ['Math.random in a P0-A2 core module', (m) => { m.set('prototypes/p0a2-24h/world.ts', 'export const w = () => Math.random();'); m.set(`${W}p0.ts`, "import { w } from '../../p0a2-24h/world.ts';"); }, 'engine-impurity'],
  ['wall clock in a P0-A2 core module', (m) => { m.set('prototypes/p0a2-24h/decision.ts', 'export const d = () => Date.now();'); m.set(`${W}p0.ts`, "import { d } from '../../p0a2-24h/decision.ts';"); }, 'engine-impurity'],
  ['P0-A2 core module imports node', (m) => { m.set('prototypes/p0a2-24h/params.ts', "import fs from 'node:fs';\nexport const p = 1;"); m.set(`${W}p0.ts`, "import { p } from '../../p0a2-24h/params.ts';"); }, 'node-import'],
  ['P0-A2 core module leaks to cli', (m) => { m.set('prototypes/p0a2-24h/canon.ts', "import { advance } from '../../cli/advance.ts';\nexport const c = 1;"); m.set(`${W}p0.ts`, "import { c } from '../../p0a2-24h/canon.ts';"); }, 'denied-module'],
  // deterministic math (Owner #190 scheme A, extended to exp / log / ** by the detmath-exp rules update)
  ['Math.exp in an engine/clock module', (m) => { m.set('engine/clock/weather-input.ts', 'export const es = (T: number) => 0.6108 * Math.exp(17.27 * T / (T + 237.3));'); m.set(`${W}p0.ts`, "import { es } from '../../../engine/clock/weather-input.ts';"); }, 'approximated-math'],
  ['Math.log in a P0-A2 core module', (m) => { m.set('prototypes/p0a2-24h/world.ts', 'export const w = (u: number) => -Math.log(1 - u);'); m.set(`${W}p0.ts`, "import { w } from '../../p0a2-24h/world.ts';"); }, 'approximated-math'],
  ['Math.sin in the Worker dir', (m) => m.set(`${W}core.ts`, 'export const step = (x: number) => Math.sin(x);'), 'approximated-math'],
  ['Math["cos"] (computed member)', (m) => m.set(`${W}core.ts`, "export const step = (x: number) => Math['cos'](x);"), 'approximated-math'],
  ['destructured Math', (m) => m.set(`${W}core.ts`, 'const { exp } = Math;\nexport const step = (x: number) => exp(x);'), 'approximated-math'],
  ['Math.pow', (m) => m.set(`${W}core.ts`, 'export const step = (x: number) => Math.pow(x, 2);'), 'approximated-math'],
  ['** with a variable exponent', (m) => m.set(`${W}core.ts`, 'export const hill = (s: number, n: number) => s ** n;'), 'approximated-math'],
  ['** with a fractional literal', (m) => m.set(`${W}core.ts`, 'export const step = (x: number) => x ** 0.5;'), 'approximated-math'],
  ['** with a negative exponent', (m) => m.set(`${W}core.ts`, 'export const step = (x: number) => x ** -2;'), 'approximated-math'],
  ['Worker imports the exempt official sampler', (m) => { m.set('engine/rng.ts', 'export const makeRng = (s: number) => s;\nexport function normal(g: () => number): number { return Math.sqrt(-2 * Math.log(g())) * Math.cos(6.28 * g()); }'); m.set(`${W}core.ts`, "import { normal } from '../../../engine/rng.ts';\nexport const step = normal;"); }, 'approximated-math'],
  ['Worker imports the sampler module as a namespace', (m) => { m.set('engine/rng.ts', 'export const makeRng = (s: number) => s;\nexport function gamma(g: () => number): number { return Math.log(g()); }'); m.set(`${W}core.ts`, "import * as R from '../../../engine/rng.ts';\nexport const step = R.makeRng;"); }, 'approximated-math'],
  ['exempt sampler called by a reached function', (m) => m.set('engine/rng.ts', 'export function normal(g: () => number): number { return Math.log(g()); }\nexport const makeRng = (s: number) => normal(() => s);'), 'approximated-math'],
  ['P0-A2 core module uses fetch', (m) => { m.set('prototypes/p0a2-24h/environment.ts', "export const e = () => fetch('/x');"); m.set(`${W}p0.ts`, "import { e } from '../../p0a2-24h/environment.ts';"); }, 'forbidden-global'],
];
for (const [name, mutate, rule] of cases) {
  const m = base(); mutate(m);
  const r = checkBoundary(m, B);
  ok(r.violations.some((x) => x.rule === rule), `negative fixture "${name}" is caught as ${rule} (got ${JSON.stringify(r.violations.map((x) => x.rule))})`);
}

// 3. the real repository.
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|js|mjs|json)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const real = new Map<string, string>();
for (const d of ['engine', 'cli', 'web/src', B.worker_entry_dir, 'prototypes/p0a2-24h', 'saves', 'journal']) for (const f of walk(path.join(REPO_ROOT, d))) real.set(path.relative(REPO_ROOT, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8'));
const r = checkBoundary(real, B);
ok(r.violations.length === 0, `real repository respects the Worker boundary (${JSON.stringify(r.violations.slice(0, 5))})`);
for (const f of ['prototypes/p0a2-24h/world.ts', 'prototypes/p0a2-24h/decision.ts', 'prototypes/p0a2-24h/params.json']) ok(r.reached.includes(f), `the Worker graph reaches the P0-A2 core (${f})`);
ok(!r.reached.some((f) => f.startsWith('prototypes/p0a2-24h/tools/') || f.startsWith('prototypes/p0a2-24h/out/') || f === 'prototypes/p0a2-24h/observer.ts'), 'the Worker graph reaches no P0-A2 tool, output or observer module');
checks += r.checks;
// 4. the allowlist is closed: every allowlisted engine module's own transitive imports stay inside the allowlist
//    (otherwise an allowlisted module would be unusable or would smuggle in a denied one).
const allowedEngine = [...real.keys()].filter((f) => f.startsWith('engine/') && f.endsWith('.ts') && B.allowed_import_prefixes.some((p) => p.endsWith('/') ? f.startsWith(p) : f === p));
ok(allowedEngine.includes('engine/rng.ts'), 'allowlisted engine modules found');
const probe = new Map(real);
probe.set(`${B.worker_entry_dir}/__allowlist_closure_probe__.ts`, allowedEngine.map((f) => `import '${path.posix.relative(B.worker_entry_dir, f)}';`).join('\n'));
const closure = checkBoundary(probe, B);
ok(closure.violations.length === 0, `allowlist is closed under imports (${JSON.stringify(closure.violations.slice(0, 5))})`);
ok(allowedEngine.every((f) => closure.reached.includes(f)), 'closure probe reached every allowlisted engine module');
checks += closure.checks;
const workerExists = fs.existsSync(path.join(REPO_ROOT, B.worker_entry_dir));
console.log(JSON.stringify({ test: 'worker-boundary', checks, worker_present: workerExists, reached: r.reached.length }));

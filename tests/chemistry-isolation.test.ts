/**
 * CHEM isolation (#130/#131/#132): the chemical-ecology layer (engine/chemistry/*) is NOT part of the official day
 * loop. Nothing official may import it (top-level engine/*.ts incl. engine/day.ts, every cli/ file, web/src); it is
 * outside the rules fingerprint; it obeys the engine platform rules (no Node/DOM API, no randomness, no wall clock);
 * it names no species; it imports only its own modules; and it never reads colony-level state (stores, needs, brood,
 * colony counts): chemistry sees deposits and local sample queries only (CLAUDE.md §2.1, §2.1b, §2.2).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, ruleFiles } from '../cli/lib/load.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const noStrings = (s: string) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const refersTo = (src: string) => /['"`][^'"`\n]*(^|\/)chemistry\/[^'"`\n]*['"`]/.test(strip(src));
for (const form of ["import { x } from './chemistry/contract.ts';", "import '../engine/chemistry/core.ts';", "const m = await import('./chemistry/core.ts');", "export * from './chemistry/contract.ts';", "import type { ChannelSpec } from './chemistry/contract.ts';"]) ok(refersTo(form), `detector catches: ${form}`);
ok(!refersTo("const s = 'docs/chemical-ecology-engine.md';"), 'detector ignores unrelated strings');
const official = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))];
ok(official.some((f) => f.endsWith(path.join('engine', 'day.ts'))), 'engine/day.ts is scanned');
for (const f of official) ok(!refersTo(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not reference engine/chemistry`);
ok(ruleFiles().engine.every((f) => !f.includes('chemistry')), 'engine/chemistry is outside the rules fingerprint (no rules change)');
// the other isolated layers do not depend on chemistry either (chemistry consumes their outputs, CHEM-3)
for (const dir of ['engine/physics', 'engine/scheduler', 'engine/clock']) for (const f of walk(path.join(REPO_ROOT, dir))) ok(!refersTo(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not import chemistry`);
const files = fs.readdirSync(path.join(REPO_ROOT, 'engine/chemistry')).filter((f) => f.endsWith('.ts'));
ok(files.includes('contract.ts') && files.includes('core.ts'), 'engine/chemistry/contract.ts and core.ts exist');
for (const f of files) {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'engine/chemistry', f), 'utf8'), src = strip(raw), code = noStrings(src);
  for (const m of src.matchAll(/from\s+'([^']+)'/g)) ok(/^\.\/[a-z0-9-]+\.ts$/.test(m[1]), `engine/chemistry/${f} imports only chemistry modules (${m[1]})`);
  ok(!/\b(process|window|document|localStorage|globalThis|Buffer)\s*\./.test(code) && !/\brequire\s*\(|\bfetch\s*\(/.test(code), `engine/chemistry/${f}: no platform APIs`);
  ok(!/Math\.random|Date\.now|new Date\(|performance\./.test(code), `engine/chemistry/${f}: no hidden randomness or wall clock`);
  ok(!/pheidole|megacephala|species_id/i.test(code), `engine/chemistry/${f}: no species branch`);
  ok(!/colon(y|ies)|sugar|protein|brood|larva|queen|deficit|days_short|trail_by_edge|\bneeds?\b|\bcrop\b|hunger/i.test(code), `engine/chemistry/${f}: reads no colony-level state, needs or physiology`);
}
console.log(JSON.stringify({ test: 'chemistry-isolation', checks }));

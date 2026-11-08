/**
 * P0-A0 isolation: the shared world event scheduler (engine/scheduler/*) is an engineering foundation and is NOT part
 * of the official day loop. Until a rules-update PR wires it in (with golden equivalence, and adds engine/scheduler to
 * the rules fingerprint, cli/lib/fingerprint.ts, which today covers only engine/*.ts), nothing official may import it:
 * top-level engine/*.ts, every cli/ file and web/src. The scheduler must also obey the engine platform rules, draw no
 * random number, carry no species branch, and not depend on the physics layer (kept separate, CLAUDE.md §9).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, ruleFiles } from '../cli/lib/load.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const refersTo = (src: string) => /['"`][^'"`\n]*(^|\/)scheduler\/[^'"`\n]*['"`]/.test(strip(src));
for (const form of ["import { x } from './scheduler/world-events.ts';", "import '../engine/scheduler/world-events.ts';", "const m = await import('./scheduler/world-events.ts');", "export * from './scheduler/world-events.ts';"]) ok(refersTo(form), `detector catches: ${form}`);
ok(!refersTo("const s = 'reports/scheduler-notes';"), 'detector ignores unrelated strings');
const official = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))];
for (const f of official) ok(!refersTo(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not reference engine/scheduler`);
ok(ruleFiles().engine.every((f) => !f.includes('scheduler')), 'engine/scheduler is outside the rules fingerprint (no rules change)');
const files = fs.readdirSync(path.join(REPO_ROOT, 'engine/scheduler')).filter((f) => f.endsWith('.ts'));
ok(files.length > 0, 'engine/scheduler exists');
for (const f of files) {
  const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'engine/scheduler', f), 'utf8'));
  ok(!/from\s+['"](node:|fs|path|crypto)/.test(src) && !/\b(process|window|document|localStorage|globalThis)\s*\./.test(src) && !/\brequire\s*\(/.test(src), `engine/scheduler/${f}: no platform APIs`);
  ok(!/Math\.random|Date\.now|new Date\(|performance\./.test(src), `engine/scheduler/${f}: no randomness or wall clock`);
  ok(!/\bfrom\s+['"][^'"]*(rng|physics|species|params)[^'"]*['"]/.test(src), `engine/scheduler/${f}: imports no RNG, physics, species or parameters`);
  ok(!/pheidole|megacephala|species_id|trophallaxis|attack|yield|forag/i.test(src.replace(/'[^'\n]*'|`[^`\n]*`/g, '')), `engine/scheduler/${f}: no species branch and no behaviour code`);
}
console.log(JSON.stringify({ test: 'scheduler-isolation', checks }));

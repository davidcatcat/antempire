/**
 * P0-A1 isolation: the 24-hour environment clock (engine/clock/*) runs only in non-official Day0 experiment worlds.
 * Nothing official may import it (top-level engine/*.ts, every cli/ file, web/src), it is outside the rules
 * fingerprint, the scheduler does not depend on it, and it obeys the engine platform rules. Environment modules must
 * not read any colony / worker / brood state (CLAUDE.md §2.2): they import only the scheduler, the RNG and each other,
 * and their code names no colony-side state at all (the only allowed mention is the scope field `colony: null`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, ruleFiles } from '../cli/lib/load.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const noStrings = (s: string) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const refersTo = (src: string) => /['"`][^'"`\n]*(^|\/)clock\/[^'"`\n]*['"`]/.test(strip(src));
for (const form of ["import { x } from './clock/environment.ts';", "import '../engine/clock/solar.ts';", "const m = await import('./clock/time-frames.ts');", "export * from './clock/weather-input.ts';"]) ok(refersTo(form), `detector catches: ${form}`);
ok(!refersTo("const s = 'eco.clock';"), 'detector ignores unrelated strings');
const official = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src')), ...walk(path.join(REPO_ROOT, 'engine/scheduler')), ...walk(path.join(REPO_ROOT, 'engine/physics'))];
for (const f of official) ok(!refersTo(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not reference engine/clock`);
ok(ruleFiles().engine.every((f) => !f.includes('clock')), 'engine/clock is outside the rules fingerprint (no rules change)');
const files = fs.readdirSync(path.join(REPO_ROOT, 'engine/clock')).filter((f) => f.endsWith('.ts'));
ok(files.length >= 4, 'engine/clock exists');
const ALLOWED = new Set(['../scheduler/world-events.ts', '../rng.ts', './time-frames.ts', './solar.ts', './weather-input.ts', './environment.ts', './detmath.ts']); // detmath: #190 cross-environment deterministic trigonometry
for (const f of files) {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'engine/clock', f), 'utf8'), src = strip(raw), code = noStrings(src);
  for (const m of src.matchAll(/from\s+'([^']+)'/g)) ok(ALLOWED.has(m[1]), `engine/clock/${f} imports only the scheduler, the RNG and clock modules (${m[1]})`);
  ok(!/\b(process|window|document|localStorage|globalThis|Buffer)\s*\./.test(code) && !/\brequire\s*\(|\bfetch\s*\(/.test(code), `engine/clock/${f}: no platform APIs`);
  ok(!/Math\.random|Date\.now|new Date\(|performance\./.test(code), `engine/clock/${f}: no hidden randomness or wall clock`);
  ok(!/pheidole|megacephala|species/i.test(code), `engine/clock/${f}: no species branch or species parameter`);
  ok(!/colon(y|ies)|worker|brood|queen|larva|\bcrop\b|forag|nestmate|\btask/i.test(code.replace(/\bcolony:\s*null\b/g, '')), `engine/clock/${f}: names no colony-side state (environment independent of the colony)`);
}
console.log(JSON.stringify({ test: 'clock-isolation', checks }));

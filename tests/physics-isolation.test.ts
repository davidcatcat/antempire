/**
 * Physics isolation (Issues #68, #69): the physics modules (engine/physics/*) are experimental and are NOT part of
 * the official day loop yet. Until a rules-update PR wires them in (and adds engine/physics to the rules fingerprint,
 * cli/lib/fingerprint.ts, which today covers only engine/*.ts), no top-level engine module may import them.
 * The physics modules must also obey the engine platform rules (browser-safe, deterministic, no species branches).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const top = fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts'));
for (const f of top) ok(!/from\s+['"]\.\/physics\//.test(fs.readFileSync(path.join(REPO_ROOT, 'engine', f), 'utf8')), `engine/${f} does not import engine/physics (physics is not in the official day loop)`);
const phys = fs.readdirSync(path.join(REPO_ROOT, 'engine/physics')).filter((f) => f.endsWith('.ts'));
ok(phys.length > 0, 'engine/physics exists');
for (const f of phys) {
  const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics', f), 'utf8'));
  ok(!/from\s+['"](node:|fs|path|crypto)/.test(src) && !/\b(process|window|document|localStorage|globalThis)\s*\./.test(src) && !/\brequire\s*\(/.test(src), `engine/physics/${f}: no platform APIs`);
  ok(!/Math\.random|Date\.now|new Date\(/.test(src), `engine/physics/${f}: no unseeded randomness or wall clock`);
  ok(!/pheidole|megacephala|species_id\s*===/i.test(src), `engine/physics/${f}: no species-specific branch (CLAUDE.md §4)`);
  ok(!/from\s+['"]\.\.\/(day|nutrition|queen|brood|activity|foraging|workers)\.ts/.test(src), `engine/physics/${f}: does not reach into the food or population modules`);
}
console.log(JSON.stringify({ physics_isolation: 'pass', checks, physics_files: phys }, null, 2));

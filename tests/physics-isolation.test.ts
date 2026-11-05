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
// Any reference to the physics modules from the official pipeline counts: static, side-effect-only and dynamic imports,
// relative or via engine/. Scanned: top-level engine/*.ts (the day loop), every cli/ file (advance, web-export, reports),
// and web/src (the viewer). Tests are allowed to import physics.
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const official = [
  ...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)),
  ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src')),
];
const refersToPhysics = (src: string) => /['"`][^'"`\n]*(^|\/)physics\/[^'"`\n]*['"`]/.test(strip(src));
// the detector itself must catch every import form the review listed
for (const form of ["import { x } from './physics/geometry.ts';", "import './physics/geometry.ts';", "const m = await import('./physics/kinematics.ts');", "import { y } from '../engine/physics/vec.ts';", "export * from './physics/collision.ts';"]) ok(refersToPhysics(form), `detector catches: ${form}`);
ok(!refersToPhysics("const s = 'scenarios/physics-notes';") , 'detector ignores unrelated strings');
ok(official.length > 20, `scanned ${official.length} official files`);
for (const f of official) ok(!refersToPhysics(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not reference engine/physics (physics is not in the official pipeline)`);
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

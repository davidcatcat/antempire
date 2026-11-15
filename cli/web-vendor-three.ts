/**
 * Copies the pinned Three.js build (node_modules/three, package.json devDependencies) into web/vendor/three/ so the
 * Three.js 3D prototype page (web/three.html) loads it from the same site through its import map — no CDN, no network.
 * Only the files the page imports are copied. web/vendor/ is generated (git-ignored), like web/dist/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules/three'), OUT = path.join(ROOT, 'web/vendor/three');
export const FILES: [string, string][] = [
  ['build/three.module.js', 'three.module.js'],
  ['build/three.core.js', 'three.core.js'],
  // Demo 2's opt-in WebGPU renderer (?renderer=webgpu): loaded only when asked for
  ['build/three.webgpu.js', 'three.webgpu.js'],
  ['build/three.tsl.js', 'three.tsl.js'],
  ['examples/jsm/controls/OrbitControls.js', 'addons/controls/OrbitControls.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'addons/utils/BufferGeometryUtils.js'],
  ['LICENSE', 'LICENSE'],
];
const version = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version as string;
for (const [from, to] of FILES) {
  const dst = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(SRC, from), dst);
}
fs.writeFileSync(path.join(OUT, 'VERSION'), `three ${version}\n`);
console.log(`web/vendor/three: three ${version}, ${FILES.length} files`);

/**
 * engine/ must load in a browser: no Node APIs, no DOM, no file/clock/network access, no species-specific
 * branches. (Type-level enforcement: engine/tsconfig.json has no DOM lib and no Node types.)
 * Also verifies the pure SHA-256 against node:crypto.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { sha256Hex, hash32 } from '../engine/index.ts';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { codeOnly } from './lib/static.ts';

const files = fs.readdirSync(`${REPO_ROOT}/engine`).filter((f) => f.endsWith('.ts')).map((f) => `engine/${f}`);
let checks = 0;
for (const f of files) {
  const raw = fs.readFileSync(`${REPO_ROOT}/${f}`, 'utf8');
  for (const m of raw.matchAll(/from\s+'([^']+)'/g)) { assert.ok(m[1].startsWith('./'), `${f} imports non-local module ${m[1]}`); checks++; }
  const code = codeOnly(f);
  for (const banned of [/\brequire\s*\(/, /\bprocess\./, /\bBuffer\b/, /\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bfetch\s*\(/, /\bDate\.now\s*\(/, /new Date\(\s*\)/, /Math\.random/]) { assert.ok(!banned.test(code), `${f} uses ${banned}`); checks++; }
  // No species-specific logic: species are selected only through parameter files.
  assert.ok(!/pheidole|megacephala/i.test(code), `${f} names a species in code`); checks++;
  // No hard-coded world node / colony IDs outside the one-time Day14 migration of this world.
  if (f !== 'engine/migration.ts') { assert.ok(!/\b(N00|Q001|F0[1-9]|F1[01]|U0[01])\b/.test(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${f} hard-codes a world node or colony ID`); checks++; }
}
const samples = ['', 'abc', '15032026|15|weather', '15032026|day15_migration_source|F04', '中文 ünïcödé 🐜', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(1000)];
for (let i = 0; i < 2000; i++) samples.push(`${15032026 + i}|${i % 400}|task:W${String(i).padStart(3, '0')}`);
for (const s of samples) {
  const ref = crypto.createHash('sha256').update(s).digest();
  assert.equal(sha256Hex(s), ref.toString('hex')); assert.equal(hash32(s), ref.readUInt32LE(0)); checks += 2;
}
console.log(JSON.stringify({ engine_files: files.length, checks, sha256_samples: samples.length, browser_safe: true }, null, 2));

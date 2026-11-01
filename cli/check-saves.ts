/**
 * Save conservation check (read-only):  npm run check:saves [-- <repo-root>]
 * Exit 1 if any error-level check fails. Warnings are printed but do not fail.
 */
import path from 'node:path';
import { REPO_ROOT, readJson } from './lib/load.ts';
import { checkSaves } from './lib/conservation.ts';

const root = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;
const checks = checkSaves(readJson('saves/main.json', root), readJson('saves/world-state.json', root));
for (const c of checks) console.log(`${c.ok ? 'PASS' : c.level === 'warning' ? 'WARN' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`);
const errors = checks.filter((c) => !c.ok && c.level === 'error'), warnings = checks.filter((c) => !c.ok && c.level === 'warning');
console.log(`\n${checks.length} checks: ${checks.length - errors.length - warnings.length} pass, ${warnings.length} warnings, ${errors.length} errors`);
if (errors.length) process.exitCode = 1;

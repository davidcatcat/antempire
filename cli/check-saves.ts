/**
 * Save consistency check (read-only):  npm run check:saves [-- <repo-root>]
 *  - conservation of the two save documents (population, brood, clock, sugar/protein ledger);
 *  - transaction state: no unfinished save transaction, no leftover temporary files (a held lock is a warning);
 *  - commit log: the saves are the last committed version, and every committed journal is present and unchanged.
 * Exit 1 if any error-level check fails. Warnings are printed but do not fail.
 */
import path from 'node:path';
import { REPO_ROOT, readJson } from './lib/load.ts';
import { checkSaves } from './lib/conservation.ts';
import { commitConsistency } from './lib/save-transaction.ts';

const root = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;
const main = readJson('saves/main.json', root);
const checks = [...checkSaves(main, readJson('saves/world-state.json', root)), ...commitConsistency(root, main)];
for (const c of checks) console.log(`${c.ok ? 'PASS' : c.level === 'warning' ? 'WARN' : 'FAIL'}  ${c.name}${c.ok ? '' : '  ' + JSON.stringify(c.detail)}`);
const errors = checks.filter((c) => !c.ok && c.level === 'error'), warnings = checks.filter((c) => !c.ok && c.level === 'warning');
console.log(`\n${checks.length} checks: ${checks.length - errors.length - warnings.length} pass, ${warnings.length} warnings, ${errors.length} errors`);
if (errors.length) process.exitCode = 1;

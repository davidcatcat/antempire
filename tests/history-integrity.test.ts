/**
 * Day1–14 history is read-only (CLAUDE.md §1): every journal, v1 chronicle, Day9–14 engine output and the
 * Day9–14 replay engine must keep the exact bytes recorded in tests/golden/history-sha256.json, and no file
 * may disappear from journal/. While the official save is still at Day14, the two save files must also be
 * the recorded Day14 bytes. Journals committed later are protected by the commit log (npm run check:saves).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT, readJson } from '../cli/lib/load.ts';

const base = readJson('tests/golden/history-sha256.json');
const sha = (rel: string) => { const abs = path.join(REPO_ROOT, rel); return fs.existsSync(abs) ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : 'MISSING'; };
const failures: string[] = [];
for (const [rel, h] of Object.entries<string>(base.history)) if (sha(rel) !== h) failures.push(`${rel} changed or missing`);
const day = readJson('saves/main.json').simulation.latest_completed_day;
if (day === 14) for (const [rel, h] of Object.entries<string>(base.day14_saves)) if (sha(rel) !== h) failures.push(`${rel} differs from the recorded Day14 save while the game is still at Day14`);
if (day < 14) failures.push(`saves went BACK to Day ${day}`);
console.log(JSON.stringify({ passed: failures.length === 0, history_files: Object.keys(base.history).length, official_day: day, day14_saves_checked: day === 14, failures }, null, 2));
if (failures.length) process.exitCode = 1;

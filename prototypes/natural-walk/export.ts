/**
 * Export the four viewing scenes as `antempire.pose-stream.v1` (docs/physics-kinematics2d.md §9) to
 * prototypes/natural-walk/data/*.json. `--check`: regenerate in memory and require byte-identical files (determinism).
 * Isolated physics experiment, NOT official; nothing here writes saves/ or journal/ or web/data/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { buildStreams } from './lib.ts';

export const DATA_DIR = path.join(REPO_ROOT, 'prototypes/natural-walk/data');
export function serialised(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of buildStreams()) out[`${s.scenario_id}.json`] = JSON.stringify(s, null, 1) + '\n';
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = serialised(), check = process.argv.includes('--check');
  let bad = 0;
  if (!check) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(DATA_DIR, name);
    if (check) { const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; if (cur !== text) { bad++; console.error(`DIFFERS: ${name}`); } }
    else fs.writeFileSync(p, text);
  }
  if (check && bad) process.exit(1);
  console.log(check ? `pose streams identical (${Object.keys(files).length})` : `wrote ${Object.keys(files).length} pose streams to ${path.relative(REPO_ROOT, DATA_DIR)}`);
}

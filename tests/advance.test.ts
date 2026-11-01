/**
 * `npm run advance` tested ONLY on temporary copies (the real saves/ must stay byte-identical):
 *  1. dry run writes nothing;
 *  2. Day14 -> Day15 with --confirm-advance: both saves rewritten in the repo's JSON format, conservation
 *     passes, result identical to the current engine (direct engine call) and — while sim/ exists — to the
 *     v6 runner sim/run_day.cjs after normalising only intentional metadata;
 *  3. Day15 -> Day20 chain with the frozen rules fingerprint, each day checked and compared with v6;
 *  4. a tampered fingerprint is refused and nothing is written;
 *  5. journal/ is never written; the real saves/ are unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { advance } from '../cli/advance.ts';
import { checkSaves } from '../cli/lib/conservation.ts';
import { rulesFingerprint } from '../cli/lib/fingerprint.ts';
import { DEFAULT_REFS } from '../cli/lib/project-day.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { migrationState, simulateDay } from '../engine/index.ts';

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const realSaves = ['saves/main.json', 'saves/world-state.json'].map((f) => [f, sha(path.join(REPO_ROOT, f))]);
const journalBefore = fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(',');
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-advance-'));
for (const d of ['saves', 'data', 'journal']) fs.cpSync(path.join(REPO_ROOT, d), path.join(tmp, d), { recursive: true });
const tmpSha = () => ['saves/main.json', 'saves/world-state.json'].map((f) => sha(path.join(tmp, f))).join();
try {
  const now = '2026-11-01T00:00:00.000Z';
  // 1. dry run
  const h0 = tmpSha(), dry = advance({ root: tmp, confirm: false, now });
  ok(!dry.written && tmpSha() === h0, 'dry run writes nothing');
  ok(dry.day === 15 && dry.checks.every((c) => c.ok), 'dry run computes Day15 and every check passes');

  // 2. Day14 -> Day15
  const m14 = readJson('saves/main.json', tmp), w14 = readJson('saves/world-state.json', tmp);
  const r15 = advance({ root: tmp, confirm: true, now });
  ok(r15.written && r15.files.length === 2, 'Day15 written to both saves');
  const mainText = fs.readFileSync(path.join(tmp, 'saves/main.json'), 'utf8'), worldText = fs.readFileSync(path.join(tmp, 'saves/world-state.json'), 'utf8');
  const m15 = JSON.parse(mainText), w15 = JSON.parse(worldText);
  ok(mainText === JSON.stringify(m15, null, 2) + '\n' && worldText === JSON.stringify(w15, null, 2) + '\n', 'save format: 2-space JSON + trailing newline (same as v6 runner)');
  ok(m15.simulation.latest_completed_day === 15 && m15.simulation.elapsed_sim_hours === 360 && w15.time.scientific_clock.day === 15 && w15.time.scientific_clock.calendar_date === '2026-11-14', 'clock advanced exactly one day to 2026-11-14');
  ok(w15.sim_engine_v2?.schema === 'antempire.engine-v2' && w15.sim_engine_v2.rules_fingerprint.activated_from_day === 15, 'engine state persisted with frozen rules fingerprint');
  const errs = checkSaves(m15, w15).filter((c) => !c.ok && c.level === 'error');
  ok(errs.length === 0, 'conservation of written saves: ' + JSON.stringify(errs));
  ok(!fs.existsSync(path.join(tmp, 'journal/v2-day-0015.md')) && fs.readdirSync(path.join(tmp, 'journal')).sort().join(',') === journalBefore, 'advance never writes a journal file');
  // identical to the current engine called directly
  const direct = simulateDay(migrationState(m14, w14, readJson('data/taichung-climatology-1991-2020.json', tmp), loadBundle()), loadBundle());
  ok(JSON.stringify(w15.day_log_latest.events) === JSON.stringify(direct.events) && JSON.stringify(w15.sim_engine_v2.population) === JSON.stringify(direct.state.population) && JSON.stringify(w15.sim_engine_v2.colony) === JSON.stringify(direct.state.colony), 'saved Day15 = direct engine result');

  // v6 runner reference chain (only while sim/ exists)
  const hasV6 = fs.existsSync(path.join(REPO_ROOT, 'sim/run_day.cjs'));
  const require = createRequire(import.meta.url), fp = rulesFingerprint();
  let vMain = m14, vWorld = w14;
  const v6Step = () => {
    const o = require(path.join(REPO_ROOT, 'sim/run_day.cjs')).projectDaily(vMain, vWorld, vWorld.sim_engine_v2 ? null : readJson('data/taichung-climatology-1991-2020.json', tmp), readJson('sim/params.json'), fp.engine, fp.params);
    o.main.updated_at = now; o.main.simulation.latest_day_summary.engine_ref = DEFAULT_REFS.engine_ref; o.main.simulation.latest_day_summary.params_ref = DEFAULT_REFS.params_ref;
    o.world.time.last_transition.program_ref = DEFAULT_REFS.engine_ref; o.world.time.last_transition.params_ref = DEFAULT_REFS.params_ref;
    if (o.main.simulation.next_engine_ref === 'sim/day_engine.cjs') { o.main.simulation.next_engine_ref = DEFAULT_REFS.engine_ref; o.main.simulation.v2_params_ref = DEFAULT_REFS.params_ref; }
    for (const e of o.main.migration_log) if (e.type === 'v2_engine_rules_only_no_clock_advance') e.assumptions_in = DEFAULT_REFS.params_ref;
    vMain = JSON.parse(JSON.stringify(o.main)); vWorld = JSON.parse(JSON.stringify(o.world));
    return [JSON.stringify(o.main, null, 2) + '\n', JSON.stringify(o.world, null, 2) + '\n'];
  };
  if (hasV6) { const [vm, vw] = v6Step(); ok(vm === mainText && vw === worldText, 'Day15 saves byte-identical to v6 sim/run_day.cjs (metadata normalised)'); }

  // 3. Day16..Day20 with frozen fingerprint
  for (let d = 16; d <= 20; d++) {
    const r = advance({ root: tmp, confirm: true, now });
    ok(r.written && r.day === d && r.checks.every((c) => c.ok || c.level === 'warning'), `Day${d} advanced with all error-level checks passing`);
    if (hasV6) { const [vm, vw] = v6Step(); ok(vm === fs.readFileSync(path.join(tmp, 'saves/main.json'), 'utf8') && vw === fs.readFileSync(path.join(tmp, 'saves/world-state.json'), 'utf8'), `Day${d} saves byte-identical to v6 runner`); }
  }

  // 4. tampered fingerprint -> refused, nothing written
  const w = readJson('saves/world-state.json', tmp); w.sim_engine_v2.rules_fingerprint.params = 'tampered';
  fs.writeFileSync(path.join(tmp, 'saves/world-state.json'), JSON.stringify(w, null, 2) + '\n');
  const h1 = tmpSha(); let refused = false;
  try { advance({ root: tmp, confirm: true, now }); } catch (err) { refused = (err as Error).message.startsWith('RULES FROZEN'); }
  ok(refused && tmpSha() === h1, 'changed engine/params fingerprint is refused and nothing is written');
  console.log(JSON.stringify({ passed: true, checks, days_advanced_on_temp_copy: 6, compared_with_v6_runner: hasV6, real_saves_unchanged: true }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [f, h] of realSaves) assert.equal(sha(path.join(REPO_ROOT, f)), h, 'REAL SAVE CHANGED: ' + f);
  assert.equal(fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(','), journalBefore, 'REAL journal/ changed');
}

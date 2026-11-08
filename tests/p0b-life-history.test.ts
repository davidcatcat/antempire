/**
 * P0-B life-history analysis (cli/reports/p0b-life-history.ts; report only). Checks:
 *  1. deterministic: a fresh run reproduces the committed reports/p0b-life-history/* byte for byte;
 *  2. permutation-invariant: per-individual results do not depend on the order of ids (candidate models and the official
 *     developBrood measurement), and an individual's draws are fixed at creation (no re-draw);
 *  3. every table quoted in docs/p0b-life-history-evidence-matrix.md equals the script output verbatim;
 *  4. isolated: nothing in the official pipeline (engine/*.ts, cli/, web/src) imports the analysis; it writes no
 *     save/journal; running it leaves the species parameters untouched.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../cli/lib/load.ts';
import { resolveBundle } from '../engine/index.ts';
import { rng } from '../engine/rng.ts';
import { OUT_DIR, SPREADS, SEEDS, TEMPS, cohortById, cohortIds, drawIndividual, engineCohort, runAnalysis, seedRun, tempModels } from '../cli/reports/p0b-life-history.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const SCRIPT = 'cli/reports/p0b-life-history.ts', DOC = 'docs/p0b-life-history-evidence-matrix.md';
const speciesFile = path.join(REPO_ROOT, 'species/pheidole-megacephala.json');
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const speciesBefore = sha(speciesFile);
const spBefore = structuredClone(resolveBundle(loadBundle()).species['pheidole-megacephala']);

// 1. determinism against the committed outputs
const { summary, perSeed, tables } = runAnalysis();
ok(fs.readFileSync(path.join(OUT_DIR, 'summary.json'), 'utf8') === JSON.stringify(summary, null, 1) + '\n', 'summary.json reproduces byte for byte');
for (const p of perSeed) ok(fs.readFileSync(path.join(OUT_DIR, `seed-${String(p.seed).padStart(2, '0')}.json`), 'utf8') === JSON.stringify(p) + '\n', `seed ${p.seed} output reproduces byte for byte`);
const tablesMd = Object.entries(tables).map(([k, v]) => `<!-- p0b:${k} -->\n${v}\n<!-- /p0b:${k} -->`).join('\n\n') + '\n';
ok(fs.readFileSync(path.join(OUT_DIR, 'tables.md'), 'utf8') === tablesMd, 'tables.md reproduces byte for byte');
ok(perSeed.length === SEEDS.length && SEEDS.length === 20, 'every seed is kept (20)');
const sp = resolveBundle(loadBundle()).species['pheidole-megacephala'], models = tempModels(sp);
ok(JSON.stringify(seedRun(7, models)) === JSON.stringify(perSeed[6]), 'a second in-process run of seed 7 is identical');

// 2. permutation invariance and no re-draw
const ids = cohortIds(), g = rng(424242), shuffled = [...ids];
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(g() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
for (const tm of [models[0], models[1]]) for (const sm of [SPREADS[0], SPREADS[4], 'erlang' as const]) for (const T of [21, 28]) {
  const a = cohortById(3, ids, tm, sm, T), b = cohortById(3, shuffled, tm, sm, T), c = cohortById(3, [...ids].reverse(), tm, sm, T);
  ok(ids.every((id) => JSON.stringify(a.get(id)) === JSON.stringify(b.get(id)) && JSON.stringify(a.get(id)) === JSON.stringify(c.get(id))), `${tm.id}/${typeof sm === 'string' ? sm : sm.id}/${T}°C: per-id results independent of id order`);
}
ok(JSON.stringify(drawIndividual(5, 'E0042')) === JSON.stringify(drawIndividual(5, 'E0042')), 'an individual\'s draws are a pure function of (seed, id): drawn once, never re-drawn');
ok(JSON.stringify(drawIndividual(5, 'E0042')) !== JSON.stringify(drawIndividual(5, 'E0043')) && JSON.stringify(drawIndividual(5, 'E0042')) !== JSON.stringify(drawIndividual(6, 'E0042')), 'draws differ between ids and between seeds');
const e1 = engineCohort(sp, 2, 28), e2 = engineCohort(sp, 2, 28, [...ids].reverse());
ok(ids.every((id) => JSON.stringify(e1[id]) === JSON.stringify(e2[id])), 'official developBrood measurement: per-egg event days independent of brood array order');
ok(new Set(ids.map((id) => e1[id].eclosion)).size === 1, 'current engine: a same-day cohort ecloses on one day (Issue #84 defect, measured)');
ok(TEMPS.includes(20) && TEMPS.includes(32), 'temperatures cover 20–32 °C');

// 3. doc quotes the script output verbatim
const doc = fs.readFileSync(path.join(REPO_ROOT, DOC), 'utf8');
for (const [k, v] of Object.entries(tables)) ok(doc.includes(`<!-- p0b:${k} -->\n${v}\n<!-- /p0b:${k} -->`), `${DOC}: table "${k}" equals the script output`);
const quoted = [...doc.matchAll(/<!-- p0b:([a-z_A-Z]+) -->/g)].map((m) => m[1]);
ok(quoted.every((k) => k in tables), 'the doc quotes no table the script does not produce');

// 4. isolation
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const official = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))]
  .filter((f) => path.relative(REPO_ROOT, f) !== SCRIPT);
ok(official.length > 20, `scanned ${official.length} official files`);
for (const f of official) ok(!/p0b-life-history/.test(strip(fs.readFileSync(f, 'utf8'))), `${path.relative(REPO_ROOT, f)} does not reference the P0-B analysis`);
const src = strip(fs.readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8'));
ok(!/saves|journal|advance|writeFileSync\([^)]*species/.test(src), 'the analysis never touches saves, journals, advance or species files');
ok(!/Math\.random|Date\.now|new Date\(/.test(src), 'no unseeded randomness or wall clock');
ok(sha(speciesFile) === speciesBefore, 'species parameter file unchanged by the analysis');
ok(JSON.stringify(resolveBundle(loadBundle()).species['pheidole-megacephala']) === JSON.stringify(spBefore), 'resolved species parameters unchanged');
console.log(JSON.stringify({ p0b_life_history: 'pass', checks }, null, 2));

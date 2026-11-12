/**
 * #202 budding candidate (scenarios/day0-budding-candidate.json; 候選／實驗，未經 Owner 啟用批准). Light checks only —
 * the multi-seed sensitivity evaluation is a report (cli/reports/day0-founding-candidate.ts), never a test target.
 *  1. schema + status label; every field is labelled (assumption:true, allowed basis, known distribution, numbers);
 *  2. every source ID resolves to a row of docs/references.md; unlabelled / unknown-source / wrong-status are refused;
 *  3. mother nest outside the scene, fully separated, no simulated exchange, with reason and mass balance;
 *  4. sampling is deterministic per seed, inside the declared ranges, differs between seeds, and a sensitivity
 *     override changes only its own factor (common random numbers);
 *  5. engine projection: one queen, majors neither placed nor converted, minors = sampled; the Day0 state it builds
 *     is valid, its sugar ledger = the workers' crop load (no hidden supply), and saves/ + journal/ are untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { initializeDay0, validateWorld } from '../engine/index.ts';
import { loadBundle, REPO_ROOT } from '../cli/lib/load.ts';
import { day0Inputs, seasonStart } from '../cli/lib/day0.ts';
import { BASES, CANDIDATE_STATUS, engineProjection, loadCandidate, referenceIds, sampleCandidate, sensitivityFactors, validateCandidate } from '../cli/lib/day0-candidate.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, f))).digest('hex');
const saves = ['saves/main.json', 'saves/world-state.json', 'saves/commit-log.json'].filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => [f, sha(f)]);
const journal = fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(',');
const refuses = (fn: () => void, re: RegExp, why: string) => { let msg = ''; try { fn(); } catch (e) { msg = (e as Error).message; } ok(re.test(msg), `${why} (got: ${msg || 'no error'})`); };

const cand = loadCandidate(), refs = referenceIds();

// 1–2 labels and sources
validateCandidate(cand, refs); checks++;
ok(cand.status === CANDIDATE_STATUS && /#201/.test(cand.status_note), '1: candidate is labelled 候選／實驗，未經 Owner 啟用批准');
ok(cand.default_for_new_day0 === true && cand.mode === 'budding_propagule_from_polygynous_population', '1: default direction is the budding propagule (#202)');
ok(cand.alternative_scenarios.some((a: Any) => a.mode === 'independent_single_queen_founding' && a.default === false), '1: independent single-queen founding is kept as a non-default research scenario');
const walk = (o: Any, p: string, out: string[]) => { if (typeof o === 'number') out.push(p); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, p + '.' + k, out); return out; };
for (const [k, f] of Object.entries(cand.fields as Record<string, Any>)) {
  ok(f.assumption === true && (BASES as readonly string[]).includes(f.basis), `1: ${k} is labelled assumption:true with an allowed basis`);
  ok(typeof f.basis_note === 'string' && f.basis_note.length > 0 && typeof f.description === 'string', `1: ${k} explains its basis`);
  for (const s of f.sources) ok(refs.has(s), `2: ${k} source ${s} is in docs/references.md`);
}
// every number in the file sits inside a labelled field, the entry-date rule, or the identity/sampling metadata
const numbers = walk(cand, '', []);
ok(numbers.every((p) => /^\.fields\.[a-z_]+\./.test(p) || /^\.entry_date\.year$/.test(p) || /^\.colony_identity\.id_number_width$/.test(p)), `1: no unlabelled number outside fields (${numbers.filter((p) => !/^\.fields\./.test(p)).join(', ')})`);
ok(cand.entry_date.assumption === true && cand.entry_date.basis === '遊戲假設', '1: entry date rule is labelled');
const bad = (mut: (c: Any) => void) => { const c = structuredClone(cand); mut(c); return () => validateCandidate(c, refs); };
refuses(bad((c) => { delete c.fields.minor_workers.assumption; }), /assumption/, '2: an unlabelled field is refused');
refuses(bad((c) => { c.fields.queens.basis = '實測'; }), /basis/, '2: an unknown basis is refused');
refuses(bad((c) => { c.fields.queens.sources.push('R999999'); }), /not in docs\/references\.md/, '2: an unknown source ID is refused');
refuses(bad((c) => { c.status = '正式'; }), /status/, '2: a candidate claiming official status is refused');
refuses(bad((c) => { c.mother_nest.simulated_exchange = 'daily_supply'; }), /mother_nest/, '3: a hidden mother-nest exchange is refused');

// 3 mother nest
ok(cand.mother_nest.location === 'outside_scene' && cand.mother_nest.fully_separated === true && cand.mother_nest.simulated_exchange === 'none', '3: mother nest outside the scene and fully separated');

// 4 sampling
const seeds = [20270001, 20270002, 20270003, 1, 987654321];
for (const seed of seeds) {
  const a = sampleCandidate(cand, seed), b = sampleCandidate(cand, seed);
  ok(JSON.stringify(a) === JSON.stringify(b), `4: seed ${seed} sampling is deterministic`);
  for (const [k, f] of Object.entries(cand.fields as Record<string, Any>)) {
    const v = a.draws[k];
    ok(f.distribution === 'fixed' ? v === f.value : v >= f.min && v <= f.max, `4: seed ${seed} ${k}=${v} inside the declared range`);
    if (f.distribution.endsWith('_int')) ok(Number.isInteger(v), `4: ${k} is an integer`);
  }
  ok(/^2027-\d{2}-\d{2}$/.test(a.entry_date_default_rule), `4: entry date drawn inside 2027 (${a.entry_date_default_rule})`);
}
ok(new Set(seeds.map((s) => JSON.stringify(sampleCandidate(cand, s).draws))).size === seeds.length, '4: different seeds give different compositions');
const base = sampleCandidate(cand, 20270001);
for (const factor of sensitivityFactors(cand)) for (const v of ['low', 'high'] as const) {
  const s = sampleCandidate(cand, 20270001, { [factor]: v });
  for (const k of Object.keys(cand.fields)) if ((cand.fields[k].sensitivity_group ?? k) !== factor) ok(s.draws[k] === base.draws[k], `4: override ${factor}=${v} leaves ${k} unchanged`);
}

// 5 engine projection
const bundle = loadBundle(), inp = day0Inputs('A1');
for (const seed of seeds.slice(0, 3)) {
  const s = sampleCandidate(cand, seed), p = engineProjection(cand, s);
  ok(p.founding.queens.value === 1 && p.not_simulated.queens === s.composition.queens - 1, `5: seed ${seed} projection keeps one queen and lists ${p.not_simulated.queens} extra as not simulated`);
  ok(p.founding.workers.value === s.composition.minor_workers && p.not_simulated.major_workers === s.composition.major_workers, `5: seed ${seed} majors are not converted into minors`);
  const st = initializeDay0({ garden: inp.garden, climatology: inp.climatology, founding: p.founding, seed, start_date: seasonStart('spring') }, bundle).state;
  validateWorld(st); checks++;
  const col = st.colonies[0], crop = col.population.workers.reduce((a, w) => a + ((w.crop_cargo_sugar as number) || 0), 0);
  ok(col.population.workers.length === s.composition.minor_workers && col.population.brood.length === s.composition.eggs + s.composition.larvae + s.composition.pupae, `5: seed ${seed} Day0 population equals the sample`);
  ok(Math.abs(col.stores.sugar - crop) < 1e-6 && col.stores.protein === 0, `5: seed ${seed} sugar ledger = workers' crop load, protein 0 (no hidden supply)`);
  ok(col.population.workers.every((w) => Object.keys((w.route_memory as Any).edges).length === 0 && w.known_sources.length === 0), `5: seed ${seed} no route memory or known sources`);
}
for (const [f, h] of saves) ok(sha(f) === h, `5: ${f} untouched`);
ok(fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(',') === journal, '5: journal/ untouched');
console.log(`day0-founding-candidate: ${checks} checks passed`);

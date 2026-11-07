/**
 * C4 causal-chain analysis (cli/reports/c4-causal-chain.ts; docs/c4-causal-chain.md). BLOCKING.
 *  R1 the committed report (reports/c4-causal-chain.json and .md) equals a fresh computation;
 *  R2 the chain is conserved: every tracked compartment closes per colony-day (opening + in = out + closing, aggregate and per
 *     individual), and the stage identities hold per world (collect = unload; cache; nurse crops; larva-day classes);
 *  R3 the analysis is a READER: it does not change the state it is handed, the states it sees equal a plain simulation byte
 *     for byte, it writes nothing into saves/ or journal/, uses no clock or Math.random, and the shipped switches stay off;
 *  R4 locality audit: the nurse decision and larval feeding functions read no colony total; the reads of colony totals that
 *     remain (developBrood: L2 / L3, known defects) are stated, so a silent change fails here; every file:line anchor resolves.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { generate, markdown, runOne, variantBundle, codeFacts, localityAudit, SEASONS } from '../cli/reports/c4-causal-chain.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;

// R1
const fresh = JSON.parse(JSON.stringify(generate()));
const committed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'reports/c4-causal-chain.json'), 'utf8'));
ok(JSON.stringify(committed) === JSON.stringify(fresh), 'R1 reports/c4-causal-chain.json equals a fresh computation (node cli/reports/c4-causal-chain.ts)');
ok(fs.readFileSync(path.join(REPO_ROOT, 'reports/c4-causal-chain.md'), 'utf8') === markdown(fresh), 'R1 reports/c4-causal-chain.md equals a fresh rendering');
ok(fresh.official === false && /非正式/.test(fresh.experiment_label), 'R1 the report is labelled 非正式 (Day0 experiment worlds, not the official world)');
ok(fresh.rows.length === 6 * 3 * 2 * 5, 'R1 6 variants × A1/A3/A5 × 2 seasons × 5 seeds, all on the same seeds');

// R2
ok(fresh.conservation.failures === 0 && fresh.conservation.max_abs_residual <= fresh.conservation.tolerance && fresh.conservation.individual_compartment_days_checked > 100000, `R2 ${fresh.conservation.individual_compartment_days_checked} individual compartment-days close (max residual ${fresh.conservation.max_abs_residual})`);
for (const r of fresh.rows) {
  const t = r.totals, id = `${r.variant}/${r.founding}/${r.season}/${r.seed}`;
  for (const [kk, c] of Object.entries(r.conservation) as [string, Any][]) ok(near(c.opening_plus_in, c.out_plus_closing, 1e-3) && c.failures.length === 0, `R2 ${id} ${kk}: opening + in = out + closing`);
  ok(near(t.collect.protein, t.unload.protein_to_cache) && near(t.collect.sugar, t.unload.sugar_to_crop) && t.carry.collect_minus_unload_per_worker_max < 1e-6, `R2 ${id}: carry loses nothing (collect = unload, per worker per day)`);
  ok(near(t.brood_leg.feed_larva_protein, t.larva_days.protein_intake) && near(t.brood_leg.feed_larva_sugar, t.larva_days.sugar_intake), `R2 ${id}: feed_larva = larval intake (larva_nutrition)`);
  ok(Object.values(t.larva_days.classes).reduce((a: number, b: Any) => a + b, 0) === t.larva_days.total, `R2 ${id}: every larva-day is in exactly one chain class`);
  ok(t.cache.take_from_cache + 1e-4 >= t.queen_leg.feed_queen_protein + t.brood_leg.feed_larva_protein + t.cache.return_to_cache, `R2 ${id}: nurse crops pass on no more protein than they took`);
  ok(t.brood_leg.contacts_per_nurse_max <= 1, `R2 ${id}: at most one larva contact per nurse per round (the fixed count reported)`);
}

// R3
const plain: string[] = [];
{ const b = variantBundle('base_c3a_c4a'); let s: Any = buildDay0('A3', 1, SEASONS.spring, b).state; for (let d = 0; d < 60; d++) { s = simulateWorldDay(s, b).state; plain.push(JSON.stringify(s)); } }
const seen: string[] = []; let untouched = true;
runOne('base_c3a_c4a', 'A3', 'spring', 1, true, (before, after, next) => { if (before !== after) untouched = false; seen.push(JSON.stringify(next)); });
ok(untouched, 'R3 the analysis never changes the state it reads (input before = after, every day)');
ok(seen.length === 60 && seen.every((x, i) => x === plain[i]), 'R3 the states the analysis sees equal a plain simulation byte for byte (it feeds nothing back)');
const src = fs.readFileSync(path.join(REPO_ROOT, 'cli/reports/c4-causal-chain.ts'), 'utf8');
ok(!/Math\.random|Date\.now|new Date/.test(src), 'R3 no clock and no Math.random');
ok(!/saves\/|journal\//.test(src) && (src.match(/writeFileSync/g) ?? []).length === 2 && src.includes("'reports/c4-causal-chain.json'"), 'R3 writes only reports/c4-causal-chain.json and .md (never saves/ or journal/)');
ok(!/\b(s|start|end|c0|c1|o\.state)(\.[\w]+|\[[^\]]*\])+\s*(=|\+=|-=|\+\+|--)[^=]/.test(src.replace(/^\s*(const|let)\b.*$/gm, '')), 'R3 the module assigns to no field of a world state');
const sp = loadBundle().species['pheidole-megacephala'] as Any;
ok(sp.queen_feeding.individual_queen_body_c3a === false && sp.larval_feeding.individual_larva_body_c4a === false && sp.larval_feeding.first_seen_begging_prior_v29 === false && sp.larval_development.individual_development_c4b === false && sp.larval_development.nutrition_response === null && sp.local_signals.nurse_cue_same_place_v31 === false, 'R3 the shipped species file keeps every switch off and no C4b form chosen (variants are applied to a copy)');

// R4
const audit = localityAudit(), row = (n: string) => audit.find((a: Any) => a.function.endsWith(' ' + n));
for (const n of ['selectTask', 'nurseContact', 'broodLeg', 'larvaMetabolism']) ok(row(n).colony_quantities_read.length === 0, `R4 ${n} reads no colony total`);
ok(JSON.stringify(row('nestRound').colony_quantities_read) === JSON.stringify(['colony.stores.protein (read)']), 'R4 nestRound reads only the store the nurse stands at (one store per nest: equals the colony protein total — stated)');
ok(['colony.stores.protein_gap_days', 'ratios.pFraction', 'ratios.sFraction'].every((x) => row('developBrood').colony_quantities_read.includes(x)), 'R4 developBrood still reads colony totals into larval development and death (L2 / L3, known defects; reported, not fixed here)');
ok(codeFacts().every((f: Any) => /^engine\/[\w-]+\.ts:\d+$/.test(f.where)) && JSON.stringify(codeFacts()) === JSON.stringify(fresh.code_facts), 'R4 every code fact resolves to one file:line');
console.log(JSON.stringify({ passed: true, checks }));

/**
 * WP6 C4 next-stage structural candidates (cli/reports/wp6-c4-next.ts; docs/wp6-c4-next-stage.md). BLOCKING.
 *  W1 the committed report (reports/wp6-c4-next/results.json, summary.md) equals a fresh computation, every seed kept;
 *  W2 the doc quotes the generated block verbatim, and every decimal / count in its reading notes comes from that block;
 *  W3 conservation: the engine C2 ledger closes in every world, and the replay mini-ledger closes for every candidate;
 *  W4 fidelity: the replay of the engine structure (S0) gives exactly the engine's nest-round transfers and contacts;
 *  W5 determinism: same input → same output; the replay does not depend on the order of its input arrays;
 *     the time budget is respected (contacts + refill trips per nurse ≤ k);
 *  W6 reader / OFF: the report never changes the state it reads, sees a plain simulation byte for byte, writes only
 *     reports/wp6-c4-next/, uses no clock or Math.random; the shipped switches stay off; the engine has no WP6 switch
 *     (no engine change: OFF = byte-identical is the golden test).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { SEASONS, variantBundle } from '../cli/reports/c4-causal-chain.ts';
import { CANDIDATES, generate, markdown, markdownBlock, replayRound, roundContext, roundParams, runWorld, OUT_DIR } from '../cli/reports/wp6-c4-next.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };

// W1
const fresh = JSON.parse(JSON.stringify(generate()));
const committed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, 'results.json'), 'utf8'));
ok(JSON.stringify(committed) === JSON.stringify(fresh), 'W1 reports/wp6-c4-next/results.json equals a fresh computation (node cli/reports/wp6-c4-next.ts)');
ok(fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, 'summary.md'), 'utf8') === markdown(fresh), 'W1 summary.md equals a fresh rendering');
ok(fresh.official === false && /非正式/.test(fresh.experiment_label), 'W1 labelled 非正式');
ok(fresh.rows.length === 3 * 2 * 5 && fresh.rows.every((r: Any) => Object.keys(r.candidates).length === CANDIDATES.length), 'W1 A1/A3/A5 × 2 seasons × 5 seeds, every candidate on every world (no seed selection)');
for (const c of CANDIDATES) ok(fresh.pooled[c.id].per_seed_protein_intake_over_need.length === 30, `W1 ${c.id}: every seed's result kept`);

// W2
const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/wp6-c4-next-stage.md'), 'utf8'), block = markdownBlock(fresh);
const region = (name: string) => { const a = `<!-- wp6-c4-next:${name}:begin -->\n`, b = `<!-- wp6-c4-next:${name}:end -->`, i = doc.indexOf(a), j = doc.indexOf(b); assert.ok(i >= 0 && j > i, `marker ${name}`); return doc.slice(i + a.length, j); };
ok(region('summary') === block, 'W2 docs/wp6-c4-next-stage.md §4 quotes the generated block verbatim');
const outside = doc.replace(region('summary'), '').split('\n').filter((l) => !l.startsWith('#')).join('\n');
// constants that are literature values or the fixed parameters quoted from earlier reports, not outputs of this script
const LITERATURE = new Set(['87.5', '1.9', '2.2', '41.8', '0.28']);
const decimals = [...outside.matchAll(/(?<![§\w.])(\d+\.\d+)(?![\w.])/g)].map((m) => m[1]);
ok(decimals.length > 20, `W2 the doc's reading notes carry numbers (${decimals.length})`);
for (const d of decimals) ok(LITERATURE.has(d) || block.includes(d), `W2 doc number ${d} appears in the generated block (or is a cited literature / parameter value)`);
for (const m of outside.matchAll(/(\d+)／(\d+) 隻|(\d+) 隻/g)) for (const n of [m[1], m[2], m[3]].filter(Boolean)) ok(new RegExp(`(^|\\D)${n} 隻`).test(block), `W2 count ${n} 隻 appears in the generated block`);
for (const c of CANDIDATES) ok(block.includes(`| ${c.id} |`), `W2 ${c.id} is in the quoted table`);

// W3
ok(fresh.conservation.engine_c2.failures === 0 && fresh.conservation.engine_c2.max_abs_residual <= fresh.conservation.tolerance && fresh.conservation.engine_c2.individual_compartment_days > 30000, `W3 engine C2 ledger closes (${fresh.conservation.engine_c2.individual_compartment_days} individual compartment-days)`);
ok(fresh.conservation.replay_ledger.failures === 0 && fresh.conservation.replay_ledger.max_residual <= fresh.conservation.tolerance, `W3 replay mini-ledger closes (${fresh.conservation.replay_ledger.compartment_days} compartment-rounds)`);
for (const r of fresh.rows) {
  ok(r.engine_c2_conservation.failures === 0, `W3 ${r.founding}/${r.season}/${r.seed}: engine C2 ledger closes`);
  for (const c of CANDIDATES) { const t = r.candidates[c.id].totals; ok(t.replay_ledger.failures === 0 && t.replay_ledger.max_total_residual <= 2e-5, `W3 ${r.founding}/${r.season}/${r.seed} ${c.id}: replay closes, total protein and sugar unchanged`);
    const p = t.protein; ok(Math.abs(p.taken + p.solid_picked - p.to_queen - p.to_larvae_liquid - p.to_larvae_solid - p.returned) < 1e-3, `W3 ${r.founding}/${r.season}/${r.seed} ${c.id}: protein taken = to queen + to larvae + put back (no crop holds protein overnight)`); }
}

// W4
ok(fresh.conservation.s0_fidelity.days === 1800 && fresh.conservation.s0_fidelity.mismatches === 0, 'W4 S0 replay equals the engine nest round on every colony-day (transfers and contacts)');
ok(fresh.pooled.S0_engine_structure.derived.protein_intake_over_need === fresh.engine_baseline.protein_intake_over_need, 'W4 S0 larval protein intake / need equals the engine baseline');

// W5
const w1 = JSON.stringify(runWorld('A1', 'autumn', 2)), w2 = JSON.stringify(runWorld('A1', 'autumn', 2));
ok(w1 === w2, 'W5 same world, same seed -> identical results');
{
  const b = variantBundle('base_c3a_c4a'), sp = b.species[Object.keys(b.species)[0]], P = roundParams(sp);
  let s: Any = buildDay0('A1' as Any, 3, SEASONS.spring, b).state, tested = 0;
  for (let d = 0; d < 40; d++) {
    const o: Any = simulateWorldDay(s, b), ev = o.result.colonies[0].events, x = roundContext(s, o.state, ev, P);
    if (x.nurses.length >= 2 && x.larvae.length >= 2) {
      const flipped = { ...x, nurses: [...x.nurses].reverse(), larvae: [...x.larvae].reverse() };
      for (const c of CANDIDATES) {
        const a = replayRound(c, x), z = replayRound(c, flipped), norm = (r: Any) => JSON.stringify({ t: r.transfers, c: r.contacts, i: [...r.intake], e: r.ends });
        ok(norm(a) === norm(z), `W5 day ${d} ${c.id}: replay independent of the input array order`);
        if (c.contacts !== Infinity) ok([...a.used.values()].every((n: number) => n <= c.contacts), `W5 day ${d} ${c.id}: contacts + refill trips per nurse ≤ ${c.contacts}`);
        ok(a.contacts.filter((m: Any) => m.fed_protein > 0).every((m: Any) => m.eligible), `W5 day ${d} ${c.id}: protein only to a larva whose own begging is at or above the threshold`);
      }
      tested++;
    }
    s = o.state;
  }
  ok(tested > 0, `W5 order-independence tested on ${tested} days`);
}

// W6
const plain: string[] = [];
{ const b = variantBundle('base_c3a_c4a'); let s: Any = buildDay0('A3', 1, SEASONS.autumn, b).state; for (let d = 0; d < 60; d++) { s = simulateWorldDay(s, b).state; plain.push(JSON.stringify(s)); } }
const seen: string[] = []; let untouched = true;
runWorld('A3', 'autumn', 1, (before, after, next) => { if (before !== after) untouched = false; seen.push(JSON.stringify(next)); });
ok(untouched, 'W6 the report never changes the state it reads');
ok(seen.length === 60 && seen.every((x, i) => x === plain[i]), 'W6 the states the report sees equal a plain simulation byte for byte (nothing fed back)');
const src = fs.readFileSync(path.join(REPO_ROOT, 'cli/reports/wp6-c4-next.ts'), 'utf8');
ok(!/Math\.random|Date\.now|new Date/.test(src), 'W6 no clock and no Math.random');
ok(!/saves\/|journal\//.test(src) && (src.match(/writeFileSync/g) ?? []).length === 2 && src.includes("'results.json'") && src.includes("'summary.md'") && src.includes("OUT_DIR = 'reports/wp6-c4-next'"), 'W6 writes only reports/wp6-c4-next/results.json and summary.md');
const sp = loadBundle().species['pheidole-megacephala'] as Any;
ok(sp.queen_feeding.individual_queen_body_c3a === false && sp.larval_feeding.individual_larva_body_c4a === false && sp.larval_development.individual_development_c4b === false && sp.larval_development.nutrition_response === null && sp.local_signals.nurse_cue_same_place_v31 === false, 'W6 the shipped species file keeps every switch off and no C4b form chosen');
const engineSrc = fs.readdirSync(path.join(REPO_ROOT, 'engine'), { recursive: true }).filter((f) => String(f).endsWith('.ts')).map((f) => fs.readFileSync(path.join(REPO_ROOT, 'engine', String(f)), 'utf8')).join('\n');
ok(!/wp6|pick_solid_piece|larva_ingest_solid/.test(engineSrc), 'W6 the engine has no WP6 switch or transfer (the candidates live only in the offline replay)');
const reg = fs.readFileSync(path.join(REPO_ROOT, 'rules/registry.json'), 'utf8');
ok(!/wp6/i.test(reg), 'W6 nothing is registered as an adopted rule');

console.log(`wp6-c4-next: ${checks} checks passed`);

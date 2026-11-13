/**
 * #202 item 8 — garden supply vs colony demand audit (tools/garden-supply-demand-audit.ts). Research only.
 *  1. the audit runs on the current parameter files and every food-related parameter is classified
 *     (registered with a unit and time scale, or excluded as not-a-food-quantity with a reason);
 *  2. every registered entry still exists in its file, has a declared unit and time scale, and every game-portion
 *     quantity is flagged UNITLESS_PORTION (no entry claims a mass unit the model does not have);
 *  3. negative samples: a new supply / demand parameter added without registration is reported as unclassified;
 *  4. the literature anchors are labelled (assumption, basis, evidence class, species for non-species data) and their
 *     source IDs resolve to docs/references.md; the anchors file states the no-back-solving rule;
 *  5. spot checks of the arithmetic against the parameter files (independent recomputation);
 *  6. the committed report equals a fresh run; saves/ and journal/ are untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, readJson } from '../cli/lib/load.ts';
import { ANCHORS_FILE, FILES, OUT_DIR, REGISTRY, audit, labelledLeaves, renderMarkdown, stationaryColonies, unclassified } from '../tools/garden-supply-demand-audit.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, f))).digest('hex');
const protectedFiles = ['saves/main.json', 'saves/world-state.json', 'saves/commit-log.json'].filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => [f, sha(f)]);
const journal = fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(',');

// 1
const a = audit();
ok(Array.isArray(a.unclassified) && a.unclassified.length === 0, `1: every food-related parameter is classified (unclassified: ${a.unclassified.join(', ')})`);
ok(a.registry.length >= 100, '1: the registry covers both engines');

// 2
const raw: Record<string, Any> = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readJson(f)]));
for (const e of REGISTRY) {
  const leaves = labelledLeaves(e.file, raw[e.file]).map(([p]) => p);
  const re = new RegExp('^' + e.path.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$');
  ok(leaves.some((p) => re.test(p)), `2: registry entry ${e.file}:${e.path} exists in ${FILES[e.file]}`);
  ok(e.unit.trim().length > 0 && e.time_scale.trim().length > 0, `2: ${e.path} declares a unit and a time scale`);
  ok(e.physical_unit === null || !/mg|µg|mL|J\b/.test(e.physical_unit), `2: ${e.path} does not claim a mass/energy unit the model lacks`);
}
for (const x of a.registry) if (/^game_portion/.test(x.unit)) ok(x.flags.includes('UNITLESS_PORTION'), `2: ${x.path} (game portions) is flagged UNITLESS_PORTION`);
ok(a.registry.some((x: Any) => x.path === 'honeydew.honeydew_daily_replenish' && x.flags.includes('NOT_READ_BY_ENGINE')), '2: the unused honeydew_daily_replenish is flagged (not read by the engine)');
ok(a.registry.some((x: Any) => x.path === 'hemipterans.honeydew_per_colony_per_day.aphid' && !x.flags.includes('NOT_READ_BY_ENGINE')), '2: map entries read through their map name are not falsely flagged');
// RU-1 (v2-review.32): every registered species / world food parameter declares its unit IN the parameter file, equal to
// the registry (one vocabulary); a game-portion unit is never a mass unit
for (const x of a.registry.filter((r: Any) => r.file === FILES.world || r.file === FILES.species)) {
  ok(x.declared_unit === x.unit && !x.flags.includes('UNIT_NOT_DECLARED_IN_FILE') && !x.flags.includes('UNIT_MISMATCH'), `2 (RU-1): ${x.path} declares unit "${x.unit}" in ${x.file} (got ${x.declared_unit})`);
  if (/^game_portion/.test(x.unit)) ok(!/\b(mg|µg|ug|ng|mL|µL|J)\b/.test(x.declared_unit.replace(/^game_portion/, '')), `2 (RU-1): ${x.path} game-portion unit names no mass/energy unit`);
}
ok(a.registry.some((x: Any) => x.path === 'site_choice.score_base_offset' && /^game_portion/.test(x.declared_unit)), '2 (RU-1): the CE1 finding site_choice.score_base_offset is declared a portion quantity');
{ // negative sample: a registered parameter whose file lost its unit (or carries another) is flagged
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-audit-unit-'));
  for (const f of [...Object.values(FILES), ANCHORS_FILE]) { fs.mkdirSync(path.dirname(path.join(tmp2, f)), { recursive: true }); fs.copyFileSync(path.join(REPO_ROOT, f), path.join(tmp2, f)); }
  fs.mkdirSync(path.join(tmp2, 'engine')); for (const f of fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((x) => x.endsWith('.ts'))) fs.copyFileSync(path.join(REPO_ROOT, 'engine', f), path.join(tmp2, 'engine', f));
  const sp = JSON.parse(fs.readFileSync(path.join(tmp2, FILES.species), 'utf8')); delete sp.nutrition.worker_sugar_daily.unit; sp.nutrition.queen_sugar_daily.unit = 'mg sugar / queen / day';
  fs.writeFileSync(path.join(tmp2, FILES.species), JSON.stringify(sp));
  const b = audit(tmp2);
  ok(b.registry.find((x: Any) => x.path === 'nutrition.worker_sugar_daily').flags.includes('UNIT_NOT_DECLARED_IN_FILE'), '2 (RU-1): a missing unit in the file is flagged');
  ok(b.registry.find((x: Any) => x.path === 'nutrition.queen_sugar_daily').flags.includes('UNIT_MISMATCH'), '2 (RU-1): a unit that differs from the registry (here a false mg claim) is flagged');
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// 3 negative samples on a temporary copy of the inputs
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-audit-'));
const copy = (rel: string) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(tmp, rel)); };
for (const f of [...Object.values(FILES), ANCHORS_FILE]) copy(f);
fs.mkdirSync(path.join(tmp, 'engine')); for (const f of fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((x) => x.endsWith('.ts'))) copy(`engine/${f}`);
ok(unclassified(tmp).length === 0, '3: the copy starts clean');
const edit = (rel: string, fn: (j: Any) => void) => { const p = path.join(tmp, rel), j = JSON.parse(fs.readFileSync(p, 'utf8')); fn(j); fs.writeFileSync(p, JSON.stringify(j)); };
edit(FILES.world, (j) => { j.nectar.extrafloral_sugar_per_day = { value: 0.5, assumption: true, basis: '遊戲假設' }; });
ok(unclassified(tmp).some((x) => x.endsWith('nectar.extrafloral_sugar_per_day')), '3: a new unregistered nectar supply parameter is reported');
edit(FILES.world, (j) => { delete j.nectar.extrafloral_sugar_per_day; j.insects.prey_biomass_mg = { value: 3, assumption: true, basis: '遊戲假設' }; });
ok(unclassified(tmp).some((x) => x.endsWith('insects.prey_biomass_mg')), '3: a new unregistered insect parameter is reported');
edit(FILES.world, (j) => { delete j.insects.prey_biomass_mg; });
edit(FILES.species, (j) => { j.nutrition.major_sugar_daily = { value: 0.3, assumption: true, basis: '遊戲假設' }; });
ok(unclassified(tmp).some((x) => x.endsWith('nutrition.major_sugar_daily')), '3: a new unregistered demand parameter is reported');
edit(FILES.species, (j) => { delete j.nutrition.major_sugar_daily; });
edit(FILES.p0a2, (j) => { j.parameters.nectar_amount_portions = { value: 0.1, evidence_class: 'game_assumption', assumption: true, basis: '遊戲假設', sources: [] }; });
ok(unclassified(tmp).some((x) => x.endsWith('parameters.nectar_amount_portions')), '3: a new unregistered P0-A2 supply parameter is reported');
edit(FILES.p0a2, (j) => { delete j.parameters.nectar_amount_portions; });
ok(unclassified(tmp).length === 0, '3: removing the samples makes the copy clean again');
const cli = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools/garden-supply-demand-audit.ts')], { encoding: 'utf8' });
ok(cli.status === 0 && cli.stdout.includes('UNITLESS_PORTION'), '3: the CLI exits 0 on the current files and prints the flags');
fs.rmSync(tmp, { recursive: true, force: true });

// 4 anchors
const anc = readJson(ANCHORS_FILE), refs = new Set(Array.from(fs.readFileSync(path.join(REPO_ROOT, 'docs/references.md'), 'utf8').matchAll(/^\| (R\d+) \|/gm), (m) => m[1]));
ok(/不得用來反推花園供給/.test(anc.use_rule), '4: the anchors file states the no-back-solving rule');
for (const [k, x] of Object.entries(anc.anchors as Record<string, Any>)) {
  ok(x.assumption === true && ['文獻支持', '一般生理學', '遊戲假設'].includes(x.basis), `4: anchor ${k} is labelled assumption:true with an allowed basis`);
  ok(['this_species', 'other_species_extrapolated', 'game_assumption'].includes(x.evidence_class) && typeof x.extrapolation_limit === 'string' && x.extrapolation_limit.length > 0, `4: anchor ${k} has an evidence class and extrapolation limit`);
  if (x.evidence_class !== 'game_assumption') ok(Array.isArray(x.sources) && x.sources.length > 0 && typeof x.species === 'string', `4: literature anchor ${k} names its source and species`);
  if (x.evidence_class === 'other_species_extrapolated') ok(/非本種/.test(x.extrapolation_limit), `4: other-species anchor ${k} is marked 非本種`);
  for (const s of x.sources ?? []) ok(refs.has(s), `4: anchor ${k} source ${s} is a row of docs/references.md`);
}
for (const s of Object.keys(anc.qualitative_sources)) ok(refs.has(s), `4: qualitative source ${s} is a row of docs/references.md`);

// 5 independent spot checks
const W = raw.world, G = raw.garden, S = raw.species, P = raw.p0a2, v = (o: Any) => o.value;
const f01 = a.legacy.supply.honeydew_by_site.find((h: Any) => h.site === 'F01');
ok(Math.abs(f01.net_gp_per_day_census - v(G.honeydew_sites.F01.hemipteran_colonies) * v(W.hemipterans.honeydew_per_colony_per_day.aphid)) < 1e-9, '5: F01 census honeydew = colonies × aphid rate');
const f04 = a.legacy.supply.honeydew_by_site.find((h: Any) => h.site === 'F04');
ok(Math.abs(f04.net_gp_per_day_census - v(G.honeydew_sites.F04.hemipteran_colonies) * v(W.hemipterans.honeydew_per_colony_per_day.scale) * (1 - v(W.background_colonies.F04_rival.honeydew_harvest_fraction))) < 1e-9, '5: F04 net of the background rival share');
ok(Math.abs(stationaryColonies(4, 0.5, 0) - 4) < 1e-9 && Math.abs(stationaryColonies(4, 0, 0.5)) < 1e-9, '5: stationary colony mean goes to the cap without collapse and to 0 without growth');
const d10 = a.legacy.demand.find((d: Any) => d.workers === 10).by_temp_c['25'];
ok(Math.abs(d10.sugar_gp - (10 * v(S.nutrition.worker_sugar_daily) + v(S.nutrition.queen_sugar_daily) + 2 * v(S.nutrition.larva_sugar_daily))) < 1e-9, '5: 25 °C demand of 10 workers, 2 larvae, 1 queen');
ok(a.legacy.supply.nectar_by_site.every((n: Any) => n.gp_per_day_after_day0 === 0 && /BLOOM_ENDS_BEFORE_DAY0/.test(n.flag)) === (v(G.nectar_sites.F08.bloom_days_at_start_of_warmup) <= v(G.warmup_days)), '5: nectar after Day0 follows bloom days vs warm-up');
ok(Math.abs(a.p0a2.supply_gp_per_day - v(P.parameters.honeydew_amount_portions) * 86400 / v(P.parameters.honeydew_interval_s)) < 1e-9, '5: P0-A2 supply per day');
ok(a.legacy.supply.per_insect_yield_gp.ratio_killed_to_natural < 1, '5: the killed-vs-natural per-insect yield inconsistency is reported');

// 6 committed report = fresh run; protected files untouched
ok(fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, 'audit.md'), 'utf8') === renderMarkdown(a), '6: reports/garden-supply-demand-audit/audit.md is current (re-run with --write)');
ok(fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, 'audit.json'), 'utf8') === JSON.stringify(a, null, 2) + '\n', '6: audit.json is current');
for (const [f, h] of protectedFiles) ok(sha(f) === h, `6: ${f} unchanged`);
ok(fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(',') === journal, '6: journal/ unchanged');

console.log(`garden-supply-demand-audit: ${checks} checks passed`);

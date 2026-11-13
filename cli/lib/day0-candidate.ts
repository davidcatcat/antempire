/**
 * #202 candidate Day0 founding (候選／實驗，未經 Owner 啟用批准; NOT the #201 GO): a budding propagule of a polygynous
 * population. Reads scenarios/day0-budding-candidate.json (schema v2, Owner #202 provisional spec of 2026-11-13),
 * validates its labels, draws a reproducible composition per seed with the ONE deterministic sampler
 * (engine/day0/founding-sampler.ts: fixed PRNG, sampling order and scenario checksum) and builds the ENGINE PROJECTION
 * (antempire.day0-founding.v1 document) that the existing Day0 initializer accepts.
 *
 * The projection is NOT the candidate: the engine holds one queen and has no majors, so extra queens and all majors
 * are listed as "not simulated" — never converted into something else. Nothing here reads or writes saves/ or journal/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { factorOf as samplerFactorOf, factorVariants, prepareScenario, sampleInitialConditions, DAY0_PRNG_ID, type Variant } from '../../engine/day0/founding-sampler.ts';
import { REPO_ROOT, readJson } from './load.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- tagged scenario JSON
export const CANDIDATE_FILE = 'scenarios/day0-budding-candidate.json';
export const CANDIDATE_SCHEMA = 'antempire.day0-founding-candidate.v2';
export const CANDIDATE_STATUS = '候選／實驗，未經 Owner 啟用批准';
export const BASES = ['文獻支持', '一般生理學', '遊戲假設'] as const;
export const DISTRIBUTIONS = ['uniform_int', 'log_uniform_int', 'uniform', 'fixed'] as const;
/** Sensitivity factors: a factor is one field, or a group of fields switched together (brood); value = variant name. */
export type Overrides = Variant;
export const BROOD_LEVELS = ['zero', 'low', 'mid', 'high'] as const;

/** The candidate as a deeply frozen canonical copy (checksum computed once; prepareScenario). */
export function loadCandidate(root = REPO_ROOT): Any { return prepareScenario(readJson<Any>(CANDIDATE_FILE, root)); }

/** Reference IDs defined in docs/references.md (table rows `| Rnnn |`). */
export function referenceIds(root = REPO_ROOT): Set<string> {
  const txt = fs.readFileSync(path.join(root, 'docs/references.md'), 'utf8');
  return new Set([...txt.matchAll(/^\|\s*(R\d+)\s*\|/gm)].map((m) => m[1]));
}

/** Throws on any unlabelled number, unknown basis/distribution, unresolved source or missing separation statement. */
export function validateCandidate(c: Any, refs: Set<string>): void {
  const fail = (m: string) => { throw Error('day0 candidate: ' + m); };
  if (c?.schema !== CANDIDATE_SCHEMA) fail('schema');
  if (c.status !== CANDIDATE_STATUS) fail('status must be ' + CANDIDATE_STATUS);
  for (const [k, f] of Object.entries(c.fields as Record<string, Any>)) {
    if (f.assumption !== true) fail(k + ': assumption must be true');
    if (!BASES.includes(f.basis)) fail(k + ': basis');
    if (!DISTRIBUTIONS.includes(f.distribution)) fail(k + ': distribution');
    if (!Array.isArray(f.sources)) fail(k + ': sources');
    for (const s of f.sources) if (!refs.has(s)) fail(`${k}: source ${s} not in docs/references.md`);
    const nums = f.distribution === 'fixed' ? [f.value] : [f.min, f.max];
    if (nums.some((x) => typeof x !== 'number' || !Number.isFinite(x))) fail(k + ': numbers');
    if (f.distribution !== 'fixed' && f.min > f.max) fail(k + ': min > max');
    if (f.distribution === 'log_uniform_int' && f.min <= 0) fail(k + ': log-uniform needs min > 0');
    if (typeof f.engine_representable !== 'boolean') fail(k + ': engine_representable');
    for (const [vn, sv] of Object.entries((f.sensitivity ?? {}) as Record<string, Any>)) {
      const g = { ...f, ...sv }, xs = g.distribution === 'fixed' ? [g.value] : [g.min, g.max];
      if (xs.some((x) => typeof x !== 'number' || !Number.isFinite(x)) || (g.distribution !== 'fixed' && g.min > g.max)) fail(`${k}: sensitivity ${vn} numbers`);
    }
  }
  if (c.activation?.activated !== false || c.activation?.go_issue !== '#201') fail('activation: must be activated:false pending #201');
  // #202 item 2: queens default 2–3 with a 1–3 sensitivity; item 1: minors 50–500 log-uniform; item 3: majors isolated
  const q = c.fields.queens, mw = c.fields.minor_workers, mj = c.fields.major_fraction;
  if (q?.distribution !== 'uniform_int' || q.min !== 2 || q.max !== 3 || q.sensitivity?.range_1_3?.min !== 1 || q.sensitivity?.range_1_3?.max !== 3 || q.simulation_status !== '尚未模擬') fail('queens: #202 default 2–3, sensitivity 1–3, 尚未模擬');
  if (mw?.distribution !== 'log_uniform_int' || mw.min !== 50 || mw.max !== 500) fail('minor_workers: #202 log-uniform 50–500');
  if (mj?.isolated !== true || mj.engine_representable !== false || mj.simulation_status !== '尚未模擬') fail('major_fraction: must be isolated and 尚未模擬');
  // #202 item 4: zero / low / mid / high pre-registered brood scenarios, all labelled
  const bv = c.scenario_variants?.brood;
  if (!bv || bv.levels?.join() !== BROOD_LEVELS.join() || !BROOD_LEVELS.includes(bv.default_level) || bv.assumption !== true || !BASES.includes(bv.basis)) fail('scenario_variants.brood: zero/low/mid/high, labelled');
  const fv = factorVariants(c), others = BROOD_LEVELS.filter((l) => l !== bv.default_level);
  if (fv.brood?.slice().sort().join() !== [...others].sort().join()) fail('brood fields must declare every non-default brood level');
  // #202 item 7: seed is an identifier, PRNG / order fixed
  if (c.seed?.value !== 20261113 || c.seed.role !== 'reproducibility_identifier' || c.seed.not_picked !== true) fail('seed: 20261113 reproducibility identifier, not picked');
  if (c.sampling?.prng?.id !== DAY0_PRNG_ID || !Array.isArray(c.sampling.order)) fail('sampling: fixed PRNG id and order');
  if (!Array.isArray(c.owner_ruling_202?.items) || c.owner_ruling_202.items.length !== 8 || c.owner_ruling_202.items.some((i: Any) => !i.provisional || !i.before_activation || typeof i.met !== 'boolean')) fail('owner_ruling_202: eight items with provisional / before_activation / met');
  if (!Array.isArray(c.simulation_status?.not_simulated) || c.simulation_status.label !== '尚未模擬') fail('simulation_status: 尚未模擬 list');
  for (const a of c.alternative_scenarios ?? []) for (const s of a.sources ?? []) if (!refs.has(s)) fail(`alternative ${a.id}: source ${s}`);
  const m = c.mother_nest;
  if (m?.location !== 'outside_scene' || m.fully_separated !== true || m.simulated_exchange !== 'none' || !m.mass_balance || !m.reason || m.model_boundary !== true || !m.boundary_inflow) fail('mother_nest must be outside the scene, fully separated, a model boundary, with reason, mass balance and boundary inflow');
  const e = c.entry_date;
  if (e?.assumption !== true || !BASES.includes(e.basis) || e.rule !== 'fixed' || e.date !== '2026-11-13' || e.timezone !== 'Asia/Taipei' || !e.not_optimal_season || !Number.isInteger(e.full_year_sensitivity?.span_days)) fail('entry_date: fixed 2026-11-13 Asia/Taipei, not the optimal season, full-year sensitivity separate');
}

/** Factor name of a field for sensitivity (group if present, else the field itself). */
export const factorOf = samplerFactorOf;
export function sensitivityFactors(c: Any): string[] { return Object.keys(factorVariants(c)); }
/** Non-default variant names of a factor (e.g. brood: zero / low / high; queens: range_1_3). */
export const variantsOf = (c: Any, factor: string): string[] => factorVariants(c)[factor] ?? [];

export interface CandidateSample {
  seed: number; variant: Overrides;
  draws: Record<string, number>;
  composition: { queens: number; minor_workers: number; major_workers: number; eggs: number; larvae: number; pupae: number; carried_brood_progress: number; worker_age_days_min: number; worker_age_days_max: number; worker_crop_fill_fraction: number; stores_protein: number };
  entry_date: string; entry_timezone: string; entry_full_year_sensitivity_date: string;
  scenario_checksum: string;
}

/** Reproducible composition for one seed (engine/day0/founding-sampler.ts). Overrides switch a factor to a named
 *  variant; other draws are unchanged (common random numbers). */
export function sampleCandidate(c: Any, seed: number, overrides: Overrides = {}): CandidateSample {
  if (!Number.isInteger(seed)) throw Error('seed must be an integer');
  const ic = sampleInitialConditions(c, seed, overrides);
  return { seed, variant: overrides, draws: ic.draws, composition: ic.composition, entry_date: ic.entry.date, entry_timezone: ic.entry.timezone, entry_full_year_sensitivity_date: ic.entry.full_year_sensitivity_date, scenario_checksum: ic.scenario.checksum };
}

const tag = (value: number, description: string) => ({ value, assumption: true, basis: '遊戲假設', description, origin: CANDIDATE_FILE + '（抽樣值；候選／實驗，未經 Owner 啟用批准）' });

/**
 * Engine projection of a sample: the antempire.day0-founding.v1 document the existing initializer accepts.
 * Extra queens and all majors are NOT simulated (returned in `not_simulated`), never converted to minors.
 */
export function engineProjection(c: Any, s: CandidateSample): { founding: Any; not_simulated: { queens: number; major_workers: number; reason: string } } {
  const x = s.composition;
  return {
    founding: {
      schema: 'antempire.day0-founding.v1', id: 'BUDCAND', title: '候選分巢單位的引擎投影（候選／實驗，未經 Owner 啟用批准）', species_id: c.species_id, mode: 'budding', engine_supported: true,
      nest_node: c.nest_node, colony_identity: c.colony_identity,
      queens: tag(1, '引擎只能表示一隻蟻后'), workers: tag(x.minor_workers, '遷入小工蟻'),
      worker_age_days_min: tag(x.worker_age_days_min, '遷入工蟻年齡下限'), worker_age_days_max: tag(x.worker_age_days_max, '遷入工蟻年齡上限'),
      worker_caste: 'minor', eggs: tag(x.eggs, '隨行卵'), larvae: tag(x.larvae, '隨行幼蟲'), pupae: tag(x.pupae, '隨行蛹'),
      carried_brood_progress: tag(x.carried_brood_progress, '隨行幼體的階段進度'), worker_crop_fill_fraction: tag(x.worker_crop_fill_fraction, '工蟻嗉囊糖填滿比例'), stores_protein: tag(x.stores_protein, '巢內蛋白存量'),
      injuries: 'none', route_memory: 'empty', known_sources: 'none',
    },
    not_simulated: { queens: x.queens - 1, major_workers: x.major_workers, reason: '引擎狀態只有一隻蟻后、沒有大工蟻（#25）；不換算、不改成小工蟻' },
  };
}

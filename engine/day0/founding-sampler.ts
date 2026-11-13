/**
 * Deterministic initial conditions of the Day0 budding candidate (scenarios/day0-budding-candidate.json, schema v2;
 * Owner ruling #202 of 2026-11-13, item 7: fix the PRNG, the sampling order and a scenario checksum).
 * 候選／實驗，未經 Owner 啟用批准 — this is NOT the #201 GO and builds no official world.
 *
 * Contract (also written into the scenario file's `sampling` block and into every sampled record):
 *  - PRNG `antempire.named-stream.sha256-u32.v1`: one named stream per field, drawn exactly once,
 *      u = hash32(`${seed}|${namespace}|${field}`) / 2^32  (hash32 = first 4 bytes of SHA-256, little-endian; engine/rng.ts)
 *    so a value depends only on (seed, namespace, field, declared range) — never on the order or on other fields.
 *  - sampling order: the scenario's `sampling.order` list, which must name every field plus `entry_day_full_year`
 *    exactly once; the sampler iterates in that order and records it.
 *  - scenario checksum: `sha256:` + SHA-256 of the canonical JSON of the whole scenario document (sorted keys, no
 *    whitespace, finite numbers only; the same definition as prototypes/p0a2-24h/canon.ts).
 *  - log-uniform integers use detLog / detExp (engine/clock/detmath.ts, #190), so every conforming ECMAScript engine
 *    gives the same bits; the module otherwise uses only IEEE basic operations and Math.floor / Math.round. It is
 *    written to satisfy the Worker graph rule `deterministic_math_in_worker_graph`, but it is NOT on the Worker
 *    allowlist yet (prototypes/continuous-world/worker-boundary.json): adding it is a separate rules PR together with
 *    the save wiring (save_meta + Node recomputation).
 *
 * Multi-queen colonies, majors and the mother nest are NOT simulated by any engine: the sampled queen count and the
 * isolated major candidate are recorded with simulation status 「尚未模擬」, never converted into anything else.
 * Pure: no platform API, no wall clock, no Math.random.
 */
import { hash32 } from '../rng.ts';
import { sha256Hex } from '../sha256.ts';
import { detExp, detLog } from '../clock/detmath.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- tagged scenario JSON
export const DAY0_PRNG_ID = 'antempire.named-stream.sha256-u32.v1';
export const SCENARIO_CHECKSUM_ALGORITHM = 'sha256(canonical-json.v1)';
export const INITIAL_CONDITIONS_SCHEMA = 'antempire.day0-initial-conditions.v1';
export const FULL_YEAR_FIELD = 'entry_day_full_year';
const TWO_32 = 4294967296;

/** Canonical JSON: sorted keys, no whitespace, finite numbers only (same definition as prototypes/p0a2-24h/canon.ts). */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw Error('day0 sampler: non-finite number in canonical JSON'); return JSON.stringify(v + 0); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw Error(`day0 sampler: ${typeof v} is not JSON data`);
}
export const sha256OfCanonical = (v: unknown): string => 'sha256:' + sha256Hex(canonicalJson(v));
/** Scenario checksum (#202 item 7): independent of key order and whitespace of the file, sensitive to every value. */
export const scenarioChecksum = (scenario: unknown): string => sha256OfCanonical(scenario);
/** Checksums of scenarios frozen by prepareScenario (deeply frozen, so the cached checksum can never go stale). */
const prepared = new WeakMap<object, string>();
const deepFreeze = (v: Any): Any => { if (v && typeof v === 'object') { for (const k of Object.keys(v)) deepFreeze(v[k]); Object.freeze(v); } return v; };
/** A deeply frozen canonical copy of a scenario whose checksum is computed once (for repeated sampling). */
export function prepareScenario<T>(scenario: T): T {
  const text = canonicalJson(scenario), copy = deepFreeze(JSON.parse(text));
  prepared.set(copy, 'sha256:' + sha256Hex(text));
  return copy;
}
const checksumOf = (scenario: Any): string => prepared.get(scenario) ?? scenarioChecksum(scenario);

/** One draw u ∈ [0, 1) from the named stream of a field. */
export function unitDraw(seed: number, namespace: string, field: string): number {
  if (!Number.isSafeInteger(seed)) throw Error('day0 sampler: seed must be a safe integer');
  return hash32(`${seed}|${namespace}|${field}`) / TWO_32;
}

/** Value of a distribution spec at u (deterministic; see the module comment). */
export function drawValue(f: Any, u: number): number {
  switch (f.distribution) {
    case 'fixed': return f.value;
    case 'uniform_int': return f.min + Math.floor(u * (f.max - f.min + 1));
    case 'log_uniform_int': { const a = detLog(f.min), b = detLog(f.max); return Math.round(detExp(a + u * (b - a))); }
    case 'uniform': return f.min + u * (f.max - f.min);
    default: throw Error('day0 sampler: unknown distribution ' + f.distribution);
  }
}

/** Sensitivity factor of a field: its group (e.g. brood) if any, else the field itself. */
export const factorOf = (scenario: Any, field: string): string => scenario.fields[field].sensitivity_group ?? field;
/** Every factor with variants and the names of its non-default variants (in declaration order). */
export function factorVariants(scenario: Any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, f] of Object.entries(scenario.fields as Record<string, Any>)) {
    if (!f.sensitivity) continue;
    const fac = factorOf(scenario, k), names = Object.keys(f.sensitivity);
    if (out[fac] && out[fac].join() !== names.join()) throw Error(`day0 sampler: fields of factor ${fac} declare different variants`);
    out[fac] = names;
  }
  return out;
}
/** Variant map: factor → variant name ('default' = the field's own spec). Unknown factors / names are refused. */
export type Variant = Record<string, string>;
function resolveVariant(scenario: Any, variant: Variant): Record<string, string> {
  const fv = factorVariants(scenario), out: Record<string, string> = {};
  // a factor's pre-registered default level (scenario_variants.<factor>.default_level, e.g. brood 'mid') names its default
  const alias = (fac: string, v: string) => (v === scenario.scenario_variants?.[fac]?.default_level ? 'default' : v);
  for (const [fac, v] of Object.entries(variant)) {
    if (!fv[fac]) throw Error(`day0 sampler: unknown sensitivity factor ${fac}`);
    if (alias(fac, v) !== 'default' && !fv[fac].includes(v)) throw Error(`day0 sampler: factor ${fac} has no variant ${v}`);
  }
  for (const fac of Object.keys(fv).sort()) {
    const v = alias(fac, variant[fac] ?? 'default');
    out[fac] = v === 'default' ? (scenario.scenario_variants?.[fac]?.default_level ?? 'default') : v;
  }
  return out;
}
const specFor = (f: Any, v: string): Any => (f.sensitivity?.[v] ? { ...f, ...f.sensitivity[v] } : f);

/** Civil date (proleptic Gregorian, UTC-free integer arithmetic) `days` after an ISO date. */
export function addDaysIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || !Number.isInteger(days)) throw Error('day0 sampler: bad date ' + iso);
  // days_from_civil / civil_from_days (H. Hinnant), integer only
  let y = Number(m[1]); const mo = Number(m[2]), d = Number(m[3]);
  y -= mo <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400, mp = (mo + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1, doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const z = era * 146097 + doe + days; // days since 0000-03-01 (the epoch shift of 719468 cancels out)
  const era2 = Math.floor(z / 146097), doe2 = z - era2 * 146097;
  const yoe2 = Math.floor((doe2 - Math.floor(doe2 / 1460) + Math.floor(doe2 / 36524) - Math.floor(doe2 / 146096)) / 365);
  const doy2 = doe2 - (365 * yoe2 + Math.floor(yoe2 / 4) - Math.floor(yoe2 / 100)), mp2 = Math.floor((5 * doy2 + 2) / 153);
  const dd = doy2 - Math.floor((153 * mp2 + 2) / 5) + 1, mm = mp2 < 10 ? mp2 + 3 : mp2 - 9, yy = yoe2 + era2 * 400 + (mm <= 2 ? 1 : 0);
  const p = (x: number, w: number) => String(x).padStart(w, '0');
  return `${p(yy, 4)}-${p(mm, 2)}-${p(dd, 2)}`;
}

export interface Day0InitialConditions {
  schema: string; status: string; activated: false; not_go: string;
  scenario: { id: string; schema: string; checksum: string; checksum_algorithm: string };
  prng: { id: string; stream_namespace: string; stream_key: string };
  seed: number; seed_role: string; seed_is_candidate_baseline: boolean;
  variant: Record<string, string>; sampling_order: string[];
  draws: Record<string, number>;
  composition: { queens: number; minor_workers: number; major_workers: number; eggs: number; larvae: number; pupae: number; carried_brood_progress: number; worker_age_days_min: number; worker_age_days_max: number; worker_crop_fill_fraction: number; stores_protein: number };
  entry: { date: string; timezone: string; rule: string; full_year_sensitivity_date: string };
  mother_nest: { location: string; fully_separated: boolean; simulated_exchange: string; boundary_inflow: string };
  not_simulated: { queens: number; major_workers: number; status: string; items: string[] };
}

/**
 * Initial conditions for (scenario, seed, variant) — deterministic and byte-identical for equal inputs.
 * The brood factor defaults to the scenario's pre-registered default level; other factors to their own spec.
 */
export function sampleInitialConditions(scenario: Any, seed: number, variant: Variant = {}): Day0InitialConditions {
  const order: string[] = scenario.sampling?.order, ns: string = scenario.sampling?.prng?.stream_namespace;
  if (scenario.sampling?.prng?.id !== DAY0_PRNG_ID) throw Error('day0 sampler: scenario PRNG must be ' + DAY0_PRNG_ID);
  if (typeof ns !== 'string' || !ns) throw Error('day0 sampler: stream_namespace');
  const fields = Object.keys(scenario.fields);
  if (!Array.isArray(order) || order.length !== fields.length + 1 || new Set(order).size !== order.length || ![...fields, FULL_YEAR_FIELD].every((k) => order.includes(k))) throw Error('day0 sampler: sampling.order must list every field and entry_day_full_year exactly once');
  const v = resolveVariant(scenario, variant), d: Record<string, number> = {};
  let fullYearDay = 0;
  for (const k of order) {
    const u = unitDraw(seed, ns, k);
    if (k === FULL_YEAR_FIELD) { fullYearDay = Math.floor(u * scenario.entry_date.full_year_sensitivity.span_days); continue; }
    const f = scenario.fields[k];
    d[k] = drawValue(specFor(f, v[factorOf(scenario, k)] ?? 'default'), u);
  }
  const minors = d.minor_workers, fr = d.major_fraction;
  if (!(fr >= 0 && fr < 1)) throw Error('day0 sampler: major_fraction must be in [0, 1)');
  const majors = Math.round((fr * minors) / (1 - fr));
  const e = scenario.entry_date;
  if (e.rule !== 'fixed') throw Error('day0 sampler: entry_date.rule must be fixed (#202 item 5)');
  return {
    schema: INITIAL_CONDITIONS_SCHEMA, status: scenario.status, activated: false, not_go: '這不是 #201 GO；候選／實驗世界的初始條件',
    scenario: { id: scenario.id, schema: scenario.schema, checksum: checksumOf(scenario), checksum_algorithm: SCENARIO_CHECKSUM_ALGORITHM },
    prng: { id: DAY0_PRNG_ID, stream_namespace: ns, stream_key: '${seed}|${stream_namespace}|${field}' },
    seed, seed_role: scenario.seed.role, seed_is_candidate_baseline: seed === scenario.seed.value,
    variant: v, sampling_order: [...order], draws: d,
    composition: { queens: d.queens, minor_workers: minors, major_workers: majors, eggs: Math.round(d.eggs_per_minor * minors), larvae: Math.round(d.larvae_per_minor * minors), pupae: Math.round(d.pupae_per_minor * minors), carried_brood_progress: d.carried_brood_progress, worker_age_days_min: d.worker_age_days_min, worker_age_days_max: d.worker_age_days_max, worker_crop_fill_fraction: d.worker_crop_fill_fraction, stores_protein: d.stores_protein },
    entry: { date: e.date, timezone: e.timezone, rule: e.rule, full_year_sensitivity_date: addDaysIso(e.full_year_sensitivity.from, fullYearDay) },
    mother_nest: { location: scenario.mother_nest.location, fully_separated: scenario.mother_nest.fully_separated, simulated_exchange: scenario.mother_nest.simulated_exchange, boundary_inflow: scenario.mother_nest.boundary_inflow },
    not_simulated: { queens: d.queens, major_workers: majors, status: '尚未模擬', items: [...scenario.simulation_status.not_simulated] },
  };
}

/** Hash of a sampled record (the value a save would carry and a verifier would recompute). */
export const initialConditionsHash = (ic: Day0InitialConditions): string => sha256OfCanonical(ic);

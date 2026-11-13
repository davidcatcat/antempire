/**
 * MEC-0 — shared mass / energy contract (Owner ruling #219 Q1, 2026-11-13; used by #222 brood physiology and RU-3..RU-7).
 * Design and rationale: docs/mass-energy-contract.md.
 *
 * What this module is:
 *  - integer fixed-point quantities, one currency per food and one for energy, never mixed:
 *      sugar mass    integer ng   (1 mg = 1 000 000 ng)
 *      protein mass  integer ng
 *      energy        integer µJ   (1 J  = 1 000 000 µJ)
 *      liquid volume integer pL   (1 µL = 1 000 000 pL; a concentration in mg/µL is numerically ng/pL)
 *    branded types, so sugar + protein or mass + energy does not type-check (only `number` arithmetic would, and its
 *    result is a plain number that cannot be assigned back to a quantity);
 *  - exact add / sub (never negative) and a per-currency ledger whose transfers move amounts from one pool to another,
 *    create only from a named source and destroy only into a named sink, so `sources − sinks = Σ pools` holds exactly;
 *  - rate accrual and rational conversions with an explicit integer remainder (carry), so the same amount split into
 *    any number of steps gives bit-identical results (event splitting / replay determinism);
 *  - versioned conversion records (mass → energy) that always return the converted value WITH its provenance;
 *  - the ONLY place a legacy game-portion (份) ↔ mass / volume factor may live: a versioned, assumption:true bridge
 *    whose factor is an explicit argument (never a hidden constant), keeping the raw portion value next to the result;
 *  - exact decimal parsing and display formatting (display only; never fed back into the simulation).
 *
 * What it is NOT: no simulation, no parameter values of any engine, no rule. Nothing in engine/*.ts imports it yet
 * (MEC-0 changes no behaviour; wiring belongs to RU-6 / #222 in their own PRs).
 *
 * Platform rules: pure TypeScript, no imports, no Node / DOM API, no wall clock, no randomness. Math is used only
 * through IEEE-exact members (floor/abs/trunc are not even needed: every operation is integer or BigInt arithmetic),
 * so the module satisfies the Worker deterministic-math rule (prototypes/continuous-world/worker-boundary.json
 * `deterministic_math_in_worker_graph`) without engine/clock/detmath.ts.
 */

export const MASS_ENERGY_CONTRACT_VERSION = 'antempire.mass-energy-contract.v1';

// ------------------------------------------------------------------------------------------------ resolution
/** base units: ng (mass), µJ (energy), pL (volume); µP = 1e-6 legacy game portion */
export const NG_PER_UG = 1_000;
export const NG_PER_MG = 1_000_000;
export const UJ_PER_MJ = 1_000;
export const UJ_PER_J = 1_000_000;
export const PL_PER_NL = 1_000;
export const PL_PER_UL = 1_000_000;
export const MICRO_PORTIONS_PER_PORTION = 1_000_000;
/** 2^53 − 1: the largest exactly representable integer. A quantity above it is refused (thrown), never wrapped. */
export const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;
export const MS_PER_DAY = 86_400_000;

export const BASE_UNIT = { sugar: 'ng', protein: 'ng', energy: 'µJ', volume: 'pL', legacy_portion: 'µP' } as const;

// ------------------------------------------------------------------------------------------------ types
declare const QTY: unique symbol;
export type Food = 'sugar' | 'protein';
/** integer ng of one food */
export type Mass<F extends Food> = number & { readonly [QTY]: `mass:${F}` };
export type SugarMass = Mass<'sugar'>;
export type ProteinMass = Mass<'protein'>;
/** integer µJ */
export type Energy = number & { readonly [QTY]: 'energy' };
/** integer pL of a liquid (its composition is a separate concentration, never implied) */
export type Volume = number & { readonly [QTY]: 'volume' };
/** integer micro-portions (1e-6 份) of the legacy game unit: only for the bridge layer */
export type MicroPortions = number & { readonly [QTY]: 'legacy_micro_portion' };
export type Quantity = SugarMass | ProteinMass | Energy | Volume | MicroPortions;
export type QuantityKind = 'sugar' | 'protein' | 'energy' | 'volume' | 'legacy_portion';
type KindOf<Q> = Q extends Mass<infer F> ? F : Q extends SugarMass ? 'sugar' : Q extends ProteinMass ? 'protein' : Q extends Energy ? 'energy' : Q extends Volume ? 'volume' : 'legacy_portion';

export class MassEnergyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}

function checkQty(n: number, what: string): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new MassEnergyError('NOT_SAFE_INTEGER', `${what} must be a safe integer (got ${String(n)})`);
  if (n < 0) throw new MassEnergyError('NEGATIVE', `${what} must not be negative (got ${n})`);
  return n;
}
const big = (n: number) => BigInt(n);
/** 10^k as BigInt by repeated multiplication (exact; no exponentiation operator, per the Worker math rule) */
const pow10 = (k: number): bigint => { let r = 1n; for (let i = 0; i < k; i++) r *= 10n; return r; };
function toSafe(b: bigint, what: string): number {
  if (b < 0n) throw new MassEnergyError('NEGATIVE', `${what} would be negative`);
  if (b > BigInt(MAX_QUANTITY)) throw new MassEnergyError('OVERFLOW', `${what} exceeds 2^53 − 1 base units`);
  return Number(b);
}

// constructors (validate: safe, non-negative integer in base units)
export const sugarNg = (n: number): SugarMass => checkQty(n, 'sugar ng') as SugarMass;
export const proteinNg = (n: number): ProteinMass => checkQty(n, 'protein ng') as ProteinMass;
export const energyUJ = (n: number): Energy => checkQty(n, 'energy µJ') as Energy;
export const volumePL = (n: number): Volume => checkQty(n, 'volume pL') as Volume;
export const microPortions = (n: number): MicroPortions => checkQty(n, 'legacy µP') as MicroPortions;
export const massNg = <F extends Food>(food: F, n: number): Mass<F> => checkQty(n, `${food} ng`) as Mass<F>;

// ------------------------------------------------------------------------------------------------ exact decimals
/**
 * Exact decimal → integer at `scale` decimal places (e.g. scale 6: '0.016' → 16000). Accepts a decimal string or a
 * number (via its shortest round-trip string, which is deterministic), including exponent notation. Refuses (throws)
 * a value with more decimals than the scale can hold: a quantity is never rounded silently.
 */
export function parseDecimal(x: string | number, scale: number, what = 'value'): number {
  const s = typeof x === 'number' ? String(x) : x.trim();
  const m = /^(\+)?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) throw new MassEnergyError('BAD_DECIMAL', `${what}: not a non-negative decimal (${s})`);
  let digits = m[2] + (m[3] ?? ''), point = m[2].length + Number(m[4] ?? 0);
  digits = digits.replace(/^0+(?=\d)/, (z) => { point -= z.length; return ''; });
  const frac = digits.length - point; // number of digits after the decimal point
  if (frac > scale && /[1-9]/.test(digits.slice(digits.length - (frac - scale)))) throw new MassEnergyError('PRECISION', `${what} ${s} has more than ${scale} decimals: not representable without rounding`);
  const kept = frac > scale ? digits.slice(0, digits.length - (frac - scale)) : digits + '0'.repeat(scale - frac);
  return toSafe(BigInt(kept === '' ? '0' : kept), what);
}
export const sugarFromMg = (mg: string | number): SugarMass => parseDecimal(mg, 6, 'sugar mg') as SugarMass;
export const proteinFromMg = (mg: string | number): ProteinMass => parseDecimal(mg, 6, 'protein mg') as ProteinMass;
export const sugarFromUg = (ug: string | number): SugarMass => parseDecimal(ug, 3, 'sugar µg') as SugarMass;
export const proteinFromUg = (ug: string | number): ProteinMass => parseDecimal(ug, 3, 'protein µg') as ProteinMass;
export const energyFromJ = (j: string | number): Energy => parseDecimal(j, 6, 'energy J') as Energy;
export const volumeFromUL = (ul: string | number): Volume => parseDecimal(ul, 6, 'volume µL') as Volume;
/** legacy portions (份, e.g. 0.025) → exact µP; refuses more than 6 decimals (use legacyPortionsRounded to round explicitly) */
export const legacyPortions = (portions: string | number): MicroPortions => parseDecimal(portions, 6, 'legacy portions') as MicroPortions;
/**
 * A legacy engine float (e.g. a computed store of 0.1234567 份) → µP with an EXPLICIT round-half-up, returning the
 * residual so the caller can record it. Only for the comparison layer; the legacy engine itself keeps its floats.
 */
export function legacyPortionsRounded(portions: number): { value: MicroPortions; raw_portions: number; residual_portions: number } {
  if (!Number.isFinite(portions) || portions < 0) throw new MassEnergyError('BAD_DECIMAL', `legacy portions must be finite and ≥ 0 (got ${portions})`);
  const v = Math.round(portions * MICRO_PORTIONS_PER_PORTION);
  return { value: microPortions(v), raw_portions: portions, residual_portions: portions - v / MICRO_PORTIONS_PER_PORTION };
}

/** exact decimal string of an integer `n` at `scale` decimal places, rounded half away from zero to `decimals` */
function decimalString(n: number, scale: number, decimals: number): string {
  let b = big(n);
  const neg = b < 0n; if (neg) b = -b;
  const d = Math.max(0, Math.min(scale, decimals));
  const drop = pow10(scale - d);
  let q = b / drop; if ((b % drop) * 2n >= drop && drop > 1n) q += 1n;
  const s = q.toString().padStart(d + 1, '0');
  const out = d === 0 ? s : `${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`.replace(/\.?0+$/, '');
  return (neg && out !== '0' ? '-' : '') + out;
}

// ------------------------------------------------------------------------------------------------ arithmetic
/** a + b of the SAME currency (exact; refuses to exceed 2^53 − 1) */
export function add<Q extends Quantity>(a: Q, b: NoInfer<Q>): Q { return toSafe(big(checkQty(a, 'a')) + big(checkQty(b, 'b')), 'sum') as Q; }
/** a − b of the SAME currency; refuses a negative result (a quantity never goes below zero) */
export function sub<Q extends Quantity>(a: Q, b: NoInfer<Q>): Q { return toSafe(big(checkQty(a, 'a')) - big(checkQty(b, 'b')), 'difference') as Q; }
export function sum<Q extends Quantity>(xs: readonly Q[]): Q { let t = 0n; for (const x of xs) t += big(checkQty(x, 'term')); return toSafe(t, 'sum') as Q; }
export const minQ = <Q extends Quantity>(a: Q, b: NoInfer<Q>): Q => (a <= b ? a : b);

/** an exact non-negative rational num/den (both safe integers, den > 0) */
export interface Rational { readonly num: number; readonly den: number }
export function rational(num: number, den: number): Rational {
  if (!Number.isSafeInteger(num) || num < 0 || !Number.isSafeInteger(den) || den <= 0) throw new MassEnergyError('BAD_RATIONAL', `rational ${num}/${den} must have safe integers, num ≥ 0, den > 0`);
  return { num, den };
}
/** a decimal factor as an exact rational ('16.5' → 33/2 after reduction) */
export function rationalFromDecimal(x: string | number, maxDecimals = 9): Rational {
  const n = parseDecimal(x, maxDecimals, 'factor');
  let a = big(n), b = pow10(maxDecimals);
  const g = gcd(a, b); a /= g; b /= g;
  return rational(toSafe(a, 'factor numerator'), toSafe(b, 'factor denominator'));
}
function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a === 0n ? 1n : a; }
export const rationalToDecimal = (r: Rational, decimals = 9): string => decimalString(Number((big(r.num) * pow10(decimals)) / big(r.den)), decimals, decimals);

/**
 * x · num/den with an integer remainder carried between calls: floor((x·num + carry) / den), new carry = the remainder.
 * Calling it on a split of x (x = x1 + x2 + …, threading the carry) gives exactly the same total as one call on x.
 * The carry is part of the state of whoever owns the conversion (save it with that state).
 */
export function scaleWithCarry(x: number, r: Rational, carry = 0): { value: number; carry: number } {
  checkQty(x, 'x');
  if (!Number.isSafeInteger(carry) || carry < 0 || carry >= r.den) throw new MassEnergyError('BAD_CARRY', `carry ${carry} must be an integer in [0, ${r.den})`);
  const t = big(x) * big(r.num) + big(carry), d = big(r.den);
  return { value: toSafe(t / d, 'scaled value'), carry: Number(t % d) };
}

/**
 * Accrue a constant rate (base units per day) over dt ms, carrying the remainder in base-unit·ms (< 86 400 000).
 * Accruing over any split of an interval gives bit-identical totals to accruing it at once (brood design §5.3).
 */
export function accrue<Q extends Quantity>(ratePerDay: Q, dtMs: number, carry = 0): { amount: Q; carry: number } {
  checkQty(dtMs, 'dt ms');
  const r = scaleWithCarry(dtMs, rational(checkQty(ratePerDay, 'rate per day'), MS_PER_DAY), carry);
  return { amount: r.value as Q, carry: r.carry };
}

// ------------------------------------------------------------------------------------------------ ledger
/**
 * One currency's books. `pools` hold quantities (a larva's gut, a worker's crop, a source's standing crop…);
 * `sources` record everything created (only from a named source: an ecological production event ID, a conversion
 * record ID…), `sinks` everything destroyed (respired, egested, decayed…). Invariant, exact in integers:
 *     Σ sources − Σ sinks = Σ pools        and every pool ≥ 0.
 * Operations change the ledger in place, after validating everything (all or nothing).
 */
export interface Ledger<Q extends number> {
  readonly kind: KindOf<Q>;
  readonly contract: typeof MASS_ENERGY_CONTRACT_VERSION;
  pools: Record<string, number>;
  sources: Record<string, number>;
  sinks: Record<string, number>;
  /** the brand lives only in the type (the stored numbers are plain integers, JSON-serialisable) */
  readonly __q?: Q;
}
export type SugarLedger = Ledger<SugarMass>;
export type ProteinLedger = Ledger<ProteinMass>;
export type EnergyLedger = Ledger<Energy>;

export function createLedger<K extends QuantityKind>(kind: K): Ledger<K extends 'sugar' ? SugarMass : K extends 'protein' ? ProteinMass : K extends 'energy' ? Energy : K extends 'volume' ? Volume : MicroPortions> {
  // the conditional return type cannot be checked against the object literal: the kind is the only runtime field it fixes
  return { kind, contract: MASS_ENERGY_CONTRACT_VERSION, pools: {}, sources: {}, sinks: {} } as never;
}
const id = (s: string, what: string) => { if (typeof s !== 'string' || s.length === 0) throw new MassEnergyError('MISSING_ID', `${what} must be a non-empty id`); return s; };
const get = (o: Record<string, number>, k: string) => o[k] ?? 0;

/** create `amount` in `pool` from the named `source` (an ecological production / conversion id; never anonymous) */
export function inflow<Q extends number>(L: Ledger<Q>, source: string, pool: string, amount: NoInfer<Q>): void {
  id(source, 'source'); id(pool, 'pool'); checkQty(amount, 'inflow');
  const s = toSafe(big(get(L.sources, source)) + big(amount), 'source total'), p = toSafe(big(get(L.pools, pool)) + big(amount), 'pool');
  L.sources[source] = s; L.pools[pool] = p;
}
/** move `amount` from one pool to another; refuses to take more than the pool holds (no mass is ever created) */
export function transfer<Q extends number>(L: Ledger<Q>, from: string, to: string, amount: NoInfer<Q>): void {
  id(from, 'from'); id(to, 'to'); checkQty(amount, 'transfer');
  const have = get(L.pools, from);
  if (amount > have) throw new MassEnergyError('INSUFFICIENT', `${L.kind}: transfer of ${amount} from ${from} which holds ${have}`);
  if (from === to) return;
  const t = toSafe(big(get(L.pools, to)) + big(amount), 'pool');
  L.pools[from] = have - amount; L.pools[to] = t;
}
/** destroy `amount` from `pool` into the named `sink` (respired, egested, decayed…) */
export function outflow<Q extends number>(L: Ledger<Q>, pool: string, sink: string, amount: NoInfer<Q>): void {
  id(pool, 'pool'); id(sink, 'sink'); checkQty(amount, 'outflow');
  const have = get(L.pools, pool);
  if (amount > have) throw new MassEnergyError('INSUFFICIENT', `${L.kind}: outflow of ${amount} from ${pool} which holds ${have}`);
  const k = toSafe(big(get(L.sinks, sink)) + big(amount), 'sink total');
  L.pools[pool] = have - amount; L.sinks[sink] = k;
}
export const poolOf = <Q extends number>(L: Ledger<Q>, pool: string): Q => get(L.pools, pool) as Q;
const total = (o: Record<string, number>) => Object.values(o).reduce((t, v) => t + big(v), 0n);
/** Σ sources − Σ sinks − Σ pools (exact, BigInt); 0 when the books close */
export const conservationResidual = <Q extends number>(L: Ledger<Q>): bigint => total(L.sources) - total(L.sinks) - total(L.pools);
export function assertConserved<Q extends number>(L: Ledger<Q>): void {
  for (const [k, v] of [...Object.entries(L.pools), ...Object.entries(L.sources), ...Object.entries(L.sinks)]) checkQty(v, `${L.kind} entry ${k}`);
  const r = conservationResidual(L);
  if (r !== 0n) throw new MassEnergyError('NOT_CONSERVED', `${L.kind} ledger residual ${r} base units (sources − sinks − pools)`);
}

// ------------------------------------------------------------------------------------------------ conversion records
export type Basis = '文獻支持' | '一般生理學' | '遊戲假設';
/** A versioned mass → energy conversion: `factor` µJ per ng of `food`, exact rational. */
export interface EnergyDensityRecord<F extends Food> {
  readonly id: string;
  readonly version: string;
  readonly food: F;
  readonly from_unit: 'ng';
  readonly to_unit: 'µJ';
  readonly factor: Rational;
  /** the same factor as people read it (J per mg) */
  readonly display: string;
  readonly assumption: true;
  readonly basis: Basis;
  readonly evidence_class: 'this_species' | 'other_species_extrapolated' | 'general_physiology' | 'game_assumption';
  /** IDs from docs/references.md; empty for general-physiology values with no cited source */
  readonly sources: readonly string[];
  readonly read_level: string;
  readonly extrapolation_limit: string;
  /** candidate sensitivity range (J per mg) for reports; not used by the conversion */
  readonly sensitivity_j_per_mg: readonly [string, string] | null;
}
export interface Provenance {
  readonly contract: typeof MASS_ENERGY_CONTRACT_VERSION;
  readonly record_id: string;
  readonly record_version: string;
  readonly input: { readonly kind: QuantityKind; readonly unit: string; readonly value: number };
  readonly factor: Rational;
  readonly factor_display: string;
  readonly carry_in: number;
  readonly carry_out: number;
  readonly assumption: true;
  readonly basis: Basis;
  readonly sources: readonly string[];
}
export interface Converted<Q extends Quantity> { readonly value: Q; readonly carry: number; readonly provenance: Provenance }

function freezeRecord<T extends object>(r: T): Readonly<T> { return Object.freeze(r); }

/**
 * Sucrose / sugar energy density, 16.5 J/mg = 16.5 µJ/ng (33/2). General physiology (heat of combustion of sucrose
 * ≈ 16.5 kJ/g); the SAME value as data/garden-supply-demand-anchors.json `sugar_energy_j_per_mg` (tests check that they
 * stay equal: there is one sugar energy density in the repo).
 */
export const SUGAR_ENERGY_V1: EnergyDensityRecord<'sugar'> = freezeRecord({
  id: 'sugar_energy_density', version: 'v1', food: 'sugar', from_unit: 'ng', to_unit: 'µJ', factor: rational(33, 2), display: '16.5 J/mg',
  assumption: true, basis: '一般生理學', evidence_class: 'general_physiology', sources: [],
  read_level: '一般生理學：蔗糖燃燒熱約 16.5 kJ/g（可代謝能約 16～17 J/mg）；與 data/garden-supply-demand-anchors.json 的 sugar_energy_j_per_mg 同值',
  extrapolation_limit: '只換算化學能；不含消化／同化效率（那是另一個參數）。蜜露與花蜜中的糖不全是蔗糖（己糖約 15.6 J/mg），差異約 6%。',
  sensitivity_j_per_mg: ['15.6', '16.7'],
} as const);
/**
 * Protein energy density, 17 J/mg = 17 µJ/ng. General physiology (Atwater-type value). Insects excrete nitrogen mostly
 * as uric acid, so the net yield of protein oxidation differs; WHETHER protein is ever burned for energy is an open
 * Owner decision (#222 `protein_catabolism`): this record only makes the conversion explicit when a mechanism needs it.
 */
export const PROTEIN_ENERGY_V1: EnergyDensityRecord<'protein'> = freezeRecord({
  id: 'protein_energy_density', version: 'v1', food: 'protein', from_unit: 'ng', to_unit: 'µJ', factor: rational(17, 1), display: '17 J/mg',
  assumption: true, basis: '一般生理學', evidence_class: 'general_physiology', sources: [],
  read_level: '一般生理學：蛋白質可代謝能約 17 kJ/g（Atwater 型一般值）；未引用特定文獻，非本種量測',
  extrapolation_limit: '含氮終產物（昆蟲多為尿酸）會改變淨能量；是否以蛋白補能量是 Owner 待決事項（#222 protein_catabolism），本紀錄不代表引擎會這樣做。',
  sensitivity_j_per_mg: ['15.5', '19.4'],
} as const);
/** every built-in conversion record (id@version must be unique; tests check) */
export const CONVERSION_RECORDS: readonly EnergyDensityRecord<Food>[] = [SUGAR_ENERGY_V1, PROTEIN_ENERGY_V1];

/** mass → energy with an explicit record; returns the value, the new carry and the provenance (never just a number) */
export function massToEnergy<F extends Food>(rec: EnergyDensityRecord<F>, m: Mass<NoInfer<F>>, carry = 0): Converted<Energy> {
  const r = scaleWithCarry(m, rec.factor, carry);
  return { value: r.value as Energy, carry: r.carry, provenance: Object.freeze({ contract: MASS_ENERGY_CONTRACT_VERSION, record_id: rec.id, record_version: rec.version, input: { kind: rec.food, unit: 'ng', value: m }, factor: rec.factor, factor_display: rec.display, carry_in: carry, carry_out: r.carry, assumption: true as const, basis: rec.basis, sources: rec.sources }) };
}

/**
 * Oxidise `amount` of food in `pool`: the mass leaves its ledger into sink `oxidised:<record>`, the energy enters the
 * energy ledger from source `oxidation:<record>`. Mass and energy are separate books; the record ties them. Atomic: if
 * the pool does not hold the amount, nothing changes. Returns the conversion (value, carry, provenance).
 */
export function oxidise<F extends Food>(mass: Ledger<Mass<F>>, pool: string, amount: Mass<NoInfer<F>>, energy: EnergyLedger, energyPool: string, rec: EnergyDensityRecord<NoInfer<F>>, carry = 0): Converted<Energy> {
  if ((mass.kind as string) !== rec.food) throw new MassEnergyError('KIND_MISMATCH', `record ${rec.id} converts ${rec.food}, ledger holds ${mass.kind}`);
  const c = massToEnergy(rec, amount, carry); // validates before any change
  if (amount > get(mass.pools, pool)) throw new MassEnergyError('INSUFFICIENT', `${mass.kind}: oxidising ${amount} from ${pool} which holds ${get(mass.pools, pool)}`);
  outflow(mass, pool, `oxidised:${rec.id}@${rec.version}`, amount);
  inflow(energy, `oxidation:${rec.id}@${rec.version}`, energyPool, c.value);
  return c;
}

// ------------------------------------------------------------------------------------------------ liquids
/** concentration of a solute in a liquid: mg per µL (= ng per pL = g/mL), exact rational (10% w/v sucrose = 0.1) */
export interface Concentration<F extends Food> { readonly food: F; readonly mg_per_ul: Rational; readonly assumption: true; readonly basis: Basis; readonly note: string }
export function soluteMass<F extends Food>(c: Concentration<F>, v: Volume, carry = 0): { value: Mass<F>; carry: number } {
  const r = scaleWithCarry(v, c.mg_per_ul, carry);
  return { value: r.value as Mass<F>, carry: r.carry };
}

// ------------------------------------------------------------------------------------------------ legacy portion bridge
export const PORTION_BRIDGE_VERSION = 'antempire.portion-bridge.v1';
export type BridgeTarget = 'sugar' | 'protein' | 'volume';
type TargetQ<T extends BridgeTarget> = T extends 'sugar' ? SugarMass : T extends 'protein' ? ProteinMass : Volume;
/**
 * Candidate range of "mg sugar per legacy portion" from the garden supply-demand audit (#202 item 8, §4.3):
 * load-based (R132) and resting-metabolism-based (R951, other species) conversions. Reference metadata ONLY: used to
 * flag whether a chosen bridge factor lies in that range; never used as a factor. Must equal
 * reports/garden-supply-demand-audit/audit.json anchored.conversion_candidates_mg_sugar_per_gp.union (tested).
 */
export const AUDIT_SUGAR_MG_PER_PORTION_CANDIDATE = Object.freeze({ min: '0.0162', max: '0.08812', status: 'candidate (audit §4.3); not an established unit', source: 'reports/garden-supply-demand-audit/audit.json#anchored.conversion_candidates_mg_sugar_per_gp.union' });

/**
 * A legacy game-portion bridge: the ONLY sanctioned place for a 份 ↔ mass / volume factor (Owner #219 Q1). It is a
 * comparison / migration layer, never physics: assumption:true, basis 遊戲假設, versioned, factor given explicitly by
 * whoever builds it (with its evidence), never a hidden constant.
 */
export interface PortionBridge<T extends BridgeTarget> {
  readonly id: string;
  readonly version: typeof PORTION_BRIDGE_VERSION;
  readonly target: T;
  /** base units of the target (ng or pL) per ONE portion, exact rational */
  readonly per_portion: Rational;
  readonly per_portion_display: string;
  readonly assumption: true;
  readonly basis: '遊戲假設';
  readonly evidence: string;
  readonly sources: readonly string[];
}
export function makePortionBridge<T extends BridgeTarget>(o: { id: string; target: T; per_portion: Rational | string; evidence: string; sources?: readonly string[] }): PortionBridge<T> {
  id(o.id, 'bridge id');
  if (!o.evidence || o.evidence.trim().length === 0) throw new MassEnergyError('NO_EVIDENCE', `bridge ${o.id}: state where the factor comes from (it is an assumption, not a measurement)`);
  const per = typeof o.per_portion === 'string' ? rationalFromDecimal(o.per_portion, 9) : rational(o.per_portion.num, o.per_portion.den);
  if (per.num === 0) throw new MassEnergyError('BAD_RATIONAL', `bridge ${o.id}: a zero factor maps every portion to nothing`);
  const unit = o.target === 'volume' ? 'pL' : 'ng';
  return Object.freeze({ id: o.id, version: PORTION_BRIDGE_VERSION, target: o.target, per_portion: per, per_portion_display: `${rationalToDecimal(per, 6)} ${unit}/份`, assumption: true as const, basis: '遊戲假設' as const, evidence: o.evidence, sources: Object.freeze([...(o.sources ?? [])]) });
}
export interface BridgeProvenance {
  readonly contract: typeof MASS_ENERGY_CONTRACT_VERSION;
  readonly bridge_id: string;
  readonly bridge_version: typeof PORTION_BRIDGE_VERSION;
  readonly raw: { readonly micro_portions: number; readonly portions: string };
  readonly per_portion: Rational;
  readonly per_portion_display: string;
  readonly carry_in: number;
  readonly carry_out: number;
  readonly assumption: true;
  readonly basis: '遊戲假設';
  /** sugar bridges only: whether the factor lies in the audit's candidate range (null for protein / volume) */
  readonly within_audit_sugar_candidate_range: boolean | null;
}
const inRange = (per: Rational): boolean => {
  // per is ng per portion; the candidate range is mg per portion (exact comparison in integers)
  const lo = parseDecimal(AUDIT_SUGAR_MG_PER_PORTION_CANDIDATE.min, 9), hi = parseDecimal(AUDIT_SUGAR_MG_PER_PORTION_CANDIDATE.max, 9); // 1e-9 mg = 1e-3 ng
  const x = big(per.num) * 1000n; // compare per.num/per.den ng (×1000 → 1e-9 mg units) with lo, hi
  return x >= big(lo) * big(per.den) && x <= big(hi) * big(per.den);
};
/** legacy µP → target quantity, keeping the raw portion value and the bridge in the provenance */
export function bridgeFromPortions<T extends BridgeTarget>(b: PortionBridge<T>, p: MicroPortions, carry = 0): { value: TargetQ<T>; carry: number; provenance: BridgeProvenance } {
  // µP · (per_portion.num / per_portion.den) / 1e6, as one exact rational with its own carry
  const den = big(b.per_portion.den) * big(MICRO_PORTIONS_PER_PORTION);
  if (den > BigInt(MAX_QUANTITY)) throw new MassEnergyError('OVERFLOW', `bridge ${b.id}: denominator too large`);
  const c = scaleWithCarry(p, rational(b.per_portion.num, Number(den)), carry);
  return { value: c.value as TargetQ<T>, carry: c.carry, provenance: Object.freeze({ contract: MASS_ENERGY_CONTRACT_VERSION, bridge_id: b.id, bridge_version: b.version, raw: { micro_portions: p, portions: decimalString(p, 6, 6) }, per_portion: b.per_portion, per_portion_display: b.per_portion_display, carry_in: carry, carry_out: c.carry, assumption: true as const, basis: b.basis, within_audit_sugar_candidate_range: b.target === 'sugar' ? inRange(b.per_portion) : null }) };
}
/** target quantity → legacy µP (the inverse comparison direction), same bridge, own carry */
export function bridgeToPortions<T extends BridgeTarget>(b: PortionBridge<T>, q: TargetQ<T>, carry = 0): { value: MicroPortions; carry: number; provenance: BridgeProvenance } {
  const num = big(b.per_portion.den) * big(MICRO_PORTIONS_PER_PORTION);
  if (num > BigInt(MAX_QUANTITY)) throw new MassEnergyError('OVERFLOW', `bridge ${b.id}: numerator too large`);
  const c = scaleWithCarry(q, rational(Number(num), b.per_portion.num), carry);
  return { value: c.value as MicroPortions, carry: c.carry, provenance: Object.freeze({ contract: MASS_ENERGY_CONTRACT_VERSION, bridge_id: b.id, bridge_version: b.version, raw: { micro_portions: c.value, portions: decimalString(c.value, 6, 6) }, per_portion: b.per_portion, per_portion_display: b.per_portion_display, carry_in: carry, carry_out: c.carry, assumption: true as const, basis: b.basis, within_audit_sugar_candidate_range: b.target === 'sugar' ? inRange(b.per_portion) : null }) };
}

// ------------------------------------------------------------------------------------------------ display
/** exact mg string (ng resolution), rounded half away from zero to `decimals` (default 6 = exact) */
export const formatMg = (m: SugarMass | ProteinMass, decimals = 6): string => `${decimalString(m, 6, decimals)} mg`;
export const formatUg = (m: SugarMass | ProteinMass, decimals = 3): string => `${decimalString(m, 3, decimals)} µg`;
export const formatJ = (e: Energy, decimals = 6): string => `${decimalString(e, 6, decimals)} J`;
export const formatUL = (v: Volume, decimals = 6): string => `${decimalString(v, 6, decimals)} µL`;
export const formatPortions = (p: MicroPortions, decimals = 6): string => `${decimalString(p, 6, decimals)} 份（遊戲單位）`;
/** mass with a readable unit: ≥ 1 mg → mg (3 decimals), ≥ 1 µg → µg (3 decimals), else ng */
export function formatMass(m: SugarMass | ProteinMass): string {
  if (m >= NG_PER_MG) return formatMg(m, 3);
  if (m >= NG_PER_UG) return formatUg(m, 3);
  return `${m} ng`;
}
/** energy with a readable unit: ≥ 1 J → J (3 decimals), ≥ 1 mJ → mJ (3 decimals), else µJ */
export function formatEnergy(e: Energy): string {
  if (e >= UJ_PER_J) return formatJ(e, 3);
  if (e >= UJ_PER_MJ) return `${decimalString(e, 3, 3)} mJ`;
  return `${e} µJ`;
}

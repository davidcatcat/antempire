/**
 * CHEM-1 (#132) — event-driven chemical signal core (docs/chemical-ecology-engine.md §14).
 *
 * Status: ISOLATED (tests/chemistry-isolation.test.ts). Deterministic state machine without DOM / Node API,
 * randomness or wall clock; the store instance is its only mutable state, and replayChem() is a pure function of
 * (config, ops). No behaviour: the core stores deposits, applies analytic decay and answers bounded local samples.
 *
 * Model (all numbers are synthetic candidates supplied by the caller's ChannelSpec, never species concentrations):
 *  - backends surface_edge (per edge, bins of bin_mm along its length) and sparse_2d (sparse square cells of cell_mm);
 *    no diffusion, no advection, no wash-off in CHEM-1 (isotropic diffusion is never assumed).
 *  - analytic decay C(t) = C(t_ref)·exp(-λ (t - t_ref)) per cell; a cell's reference time moves only when a deposit
 *    enters it, so how advance() is partitioned never changes any value (bitwise).
 *  - deposits wait in `pending` until advance(to) closes the horizon past them; they are then integrated in the
 *    canonical order (t_s, round, layer, where, amount, deposit_id) — input order and agent ids do not matter.
 *  - sampleLocal only at the closed horizon (no future, no stale read), only on the sensor's own layer, only cells that
 *    intersect a radius bounded by the channel (edge: the interval on the same edge; plane: the disc).
 *  - layered phases of one instant (contract CHEM_PHASES): deposit() submits phase-1 source events; advance(to) is
 *    phases 2+3 of `to` (commit every due deposit together, canonically; update the state); sampleLocal() is phase 4
 *    and must declare phase 'local_sensing' at exactly the committed instant. A committed instant is closed: later
 *    deposits into it are LATE_DEPOSIT, a reused deposit_id / origin event is a duplicate, and no API exposes or edits
 *    a stored event (accepted events are copied).
 */
import {
  compareChemTime, validateChannel, validateDeposit, validateSampleQuery,
  type ChannelSpec, type ChemClock, type ChemTime, type DepositEvent, type Domain, type SampleQuery, type Where,
} from './contract.ts';

export class ChemRefused extends Error {
  readonly codes: string[];
  constructor(codes: string[]) { super(`CHEM_REFUSED: ${codes.join(', ')}`); this.name = 'ChemRefused'; this.codes = codes; }
}

export interface ChannelConfig { spec: ChannelSpec; domain: Domain }
export interface StoreConfig { clock: ChemClock; channels: ChannelConfig[] }

export type RejectReason = 'OUT_OF_BOUNDS' | 'LATE_DEPOSIT' | 'DUPLICATE_DEPOSIT_ID' | 'DUPLICATE_ORIGIN_EVENT';
export interface DepositResult { deposit_id: string; accepted: boolean; reason: RejectReason | null }

interface Cell { key: string; layer: string; cx: number; cy: number; a: number; t_ref: number; decayed: number; contributors: string[] }
interface Channel {
  spec: ChannelSpec; domain: Domain; lambda: number; size: number;
  edges: Map<string, { length_mm: number; layer: string; bins: number }>; nx: number; ny: number;
  cells: Map<string, Cell>;
  pending: DepositEvent[];
  stats: { accepted_count: number; accepted_amount: number; integrated_count: number; integrated_amount: number; rejected: Record<RejectReason, { count: number; amount: number }> };
}

export interface CellView { key: string; layer: string; center_mm: [number, number] | number; value: number }
export interface SampleResult {
  view: 'agent_local'; signal_id: string; agent_id: string; time: ChemTime; layer: string;
  /** sum of the values of the cells that intersect the sensor (cell resolution; no area weighting — assumption D) */
  exposure: number; cells: CellView[];
  /** null while the channel's threshold is null (no dose-response data) */
  detectable: boolean | null;
}
export interface ChannelLedger {
  signal_id: string; quantity: string; horizon: ChemTime | null;
  accepted_count: number; accepted_amount: number; pending_count: number; pending_amount: number;
  integrated_count: number; integrated_amount: number;
  /** Σ cell values at the horizon */
  present_amount: number;
  /** recorded at each cell update plus the decay since each cell's last update, up to the horizon */
  decayed_amount: number;
  /** integrated − present − decayed (bookkeeping residual, float only) */
  residual: number;
  rejected: Record<RejectReason, { count: number; amount: number }>;
  cells: number;
  /** normalized activity: this is an activity audit, not a chemical mass balance */
  balance_kind: 'activity_audit' | 'mass_balance';
}
export interface Snapshot { view: 'observer_only'; time: ChemTime | null; channels: { signal_id: string; cells: CellView[] }[] }

const lt = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const whereKey = (w: Where): string => w.kind === 'edge_point' ? `p|${w.edge_id}|${w.s_mm}` : w.kind === 'edge_segment' ? `s|${w.edge_id}|${w.s0_mm}|${w.s1_mm}` : w.kind === 'point2d' ? `P|${w.x_mm}|${w.y_mm}` : `S|${w.x0_mm}|${w.y0_mm}|${w.x1_mm}|${w.y1_mm}`;
/** canonical integration order: nothing here depends on input order or (except for exact ties) on ids */
export const canonicalCompare = (a: DepositEvent, b: DepositEvent): number =>
  compareChemTime(a.time, b.time) || lt(a.layer, b.layer) || lt(whereKey(a.where), whereKey(b.where)) || a.amount - b.amount || lt(a.deposit_id, b.deposit_id);

/** split a deposit over the cells it covers: [cellIndex..., fraction] (fractions of the path length; a point = 1) */
function edgeShares(w: Where, size: number, bins: number): [number, number][] {
  const bin = (s: number) => Math.min(bins - 1, Math.floor(s / size));
  if (w.kind === 'edge_point') return [[bin(w.s_mm), 1]];
  if (w.kind !== 'edge_segment') return [];
  const a = Math.min(w.s0_mm, w.s1_mm), b = Math.max(w.s0_mm, w.s1_mm), len = b - a, out: [number, number][] = [];
  for (let k = bin(a); k <= bin(b); k++) {
    const lo = Math.max(a, k * size), hi = k === bins - 1 ? b : Math.min(b, (k + 1) * size);
    if (hi > lo) out.push([k, (hi - lo) / len]);
  }
  return out;
}
function planeShares(w: Where, ox: number, oy: number, size: number, nx: number, ny: number): [number, number, number][] {
  const cell = (x: number, y: number): [number, number] => [Math.min(nx - 1, Math.floor((x - ox) / size)), Math.min(ny - 1, Math.floor((y - oy) / size))];
  if (w.kind === 'point2d') { const [i, j] = cell(w.x_mm, w.y_mm); return [[i, j, 1]]; }
  if (w.kind !== 'segment2d') return [];
  const { x0_mm: x0, y0_mm: y0, x1_mm: x1, y1_mm: y1 } = w, dx = x1 - x0, dy = y1 - y0, ts = [0, 1];
  // parameters where the segment crosses a grid line
  for (const [p0, d, o] of [[x0, dx, ox], [y0, dy, oy]] as const) {
    if (d === 0) continue;
    const g0 = (p0 - o) / size, g1 = (p0 + d - o) / size;
    for (let g = Math.ceil(Math.min(g0, g1)); g <= Math.floor(Math.max(g0, g1)); g++) { const t = (o + g * size - p0) / d; if (t > 0 && t < 1) ts.push(t); }
  }
  ts.sort((a, b) => a - b);
  const out: [number, number, number][] = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const f = ts[k + 1] - ts[k]; if (!(f > 0)) continue;
    const tm = (ts[k] + ts[k + 1]) / 2, [i, j] = cell(x0 + dx * tm, y0 + dy * tm), last = out.at(-1);
    if (last && last[0] === i && last[1] === j) last[2] += f; else out.push([i, j, f]);
  }
  return out;
}

export class ChemStore {
  readonly clock: ChemClock;
  private readonly ch = new Map<string, Channel>();
  private readonly seenId = new Set<string>();
  private readonly seenOrigin = new Set<string>();
  private h: ChemTime | null = null;

  constructor(cfg: StoreConfig) {
    this.clock = cfg.clock;
    const errs: string[] = [];
    if (!cfg.clock || !(typeof cfg.clock.name === 'string' && cfg.clock.name)) errs.push('MISSING:clock');
    for (const { spec, domain } of cfg.channels) {
      const e = validateChannel(spec).map((x) => `${spec.signal_id}:${x}`);
      if (this.ch.has(spec.signal_id)) e.push(`${spec.signal_id}:DUPLICATE_CHANNEL`);
      if (spec.backend !== 'surface_edge' && spec.backend !== 'sparse_2d') e.push(`${spec.signal_id}:NOT_A_FIELD_CHANNEL`);
      if (domain.backend !== spec.backend) e.push(`${spec.signal_id}:DOMAIN_BACKEND_MISMATCH`);
      errs.push(...e); if (e.length) continue;
      const size = spec.spatial_support.kind === 'surface_edge' ? spec.spatial_support.bin_mm : spec.spatial_support.kind === 'sparse_2d' ? spec.spatial_support.cell_mm : NaN;
      const edges = new Map<string, { length_mm: number; layer: string; bins: number }>();
      let nx = 0, ny = 0;
      if (domain.backend === 'surface_edge') {
        for (const ed of domain.edges) {
          if (edges.has(ed.id) || !(ed.length_mm > 0 && Number.isFinite(ed.length_mm)) || !ed.layer) { errs.push(`${spec.signal_id}:BAD_EDGE:${ed.id}`); continue; }
          edges.set(ed.id, { length_mm: ed.length_mm, layer: ed.layer, bins: Math.max(1, Math.ceil(ed.length_mm / size)) });
        }
      } else {
        const b = domain.bounds_mm;
        if (!(b.x1 > b.x0 && b.y1 > b.y0) || !domain.layers.length) errs.push(`${spec.signal_id}:BAD_BOUNDS`);
        nx = Math.max(1, Math.ceil((b.x1 - b.x0) / size)); ny = Math.max(1, Math.ceil((b.y1 - b.y0) / size));
      }
      const lambda = spec.time_rule.lambda_per_s!.value as number;
      const zero = () => ({ count: 0, amount: 0 });
      this.ch.set(spec.signal_id, { spec, domain, lambda, size, edges, nx, ny, cells: new Map(), pending: [], stats: { accepted_count: 0, accepted_amount: 0, integrated_count: 0, integrated_amount: 0, rejected: { OUT_OF_BOUNDS: zero(), LATE_DEPOSIT: zero(), DUPLICATE_DEPOSIT_ID: zero(), DUPLICATE_ORIGIN_EVENT: zero() } } });
    }
    if (errs.length) throw new ChemRefused(errs);
  }

  get horizon(): ChemTime | null { return this.h ? { ...this.h } : null; }
  channels(): string[] { return [...this.ch.keys()].sort(lt); }

  private channel(id: string): Channel { const c = this.ch.get(id); if (!c) throw new ChemRefused([`UNKNOWN_CHANNEL:${id}`]); return c; }

  /** Record deposits (atomic: a structurally invalid event refuses the whole batch and changes nothing). Out-of-bounds,
   *  late (at or before the closed horizon) and duplicate deposits are not added; they are counted in the ledger. */
  deposit(events: readonly DepositEvent[]): DepositResult[] {
    const plan: { ev: DepositEvent; c: Channel; reason: RejectReason | null }[] = [], errs: string[] = [];
    const ids = new Set<string>(), origins = new Set<string>();
    for (const ev of events) {
      const c = this.ch.get(ev?.signal_id);
      if (!c) { errs.push(`UNKNOWN_CHANNEL:${ev?.signal_id}`); continue; }
      const e = validateDeposit(ev, c.spec, this.clock, c.domain), hard = e.filter((x) => !x.startsWith('OUT_OF_BOUNDS'));
      if (hard.length) { errs.push(...hard.map((x) => `${ev.deposit_id}:${x}`)); continue; }
      const okey = `${ev.signal_id}\u0000${ev.origin_agent}\u0000${ev.origin_event_id}`;
      const reason: RejectReason | null = e.length ? 'OUT_OF_BOUNDS'
        : this.h && compareChemTime(ev.time, this.h) <= 0 ? 'LATE_DEPOSIT'
          : this.seenId.has(ev.deposit_id) || ids.has(ev.deposit_id) ? 'DUPLICATE_DEPOSIT_ID'
            : this.seenOrigin.has(okey) || origins.has(okey) ? 'DUPLICATE_ORIGIN_EVENT' : null;
      if (!reason) { ids.add(ev.deposit_id); origins.add(okey); }
      plan.push({ ev, c, reason });
    }
    if (errs.length) throw new ChemRefused(errs);
    return plan.map(({ ev, c, reason }) => {
      if (reason) { const r = c.stats.rejected[reason]; r.count++; r.amount += ev.amount; }
      else {
        this.seenId.add(ev.deposit_id); this.seenOrigin.add(`${ev.signal_id}\u0000${ev.origin_agent}\u0000${ev.origin_event_id}`);
        c.pending.push(copyEvent(ev)); c.stats.accepted_count++; c.stats.accepted_amount += ev.amount;
      }
      return { deposit_id: ev.deposit_id, accepted: !reason, reason };
    });
  }

  /** Close the horizon at `to` (never backwards) and integrate every pending deposit with time <= to, canonically. */
  advance(to: ChemTime): void {
    const e = validateTimeOnly(to, this.clock);
    if (this.h && compareChemTime(to, this.h) < 0) e.push('HORIZON_BACKWARDS');
    if (e.length) throw new ChemRefused(e);
    for (const c of [...this.ch.values()]) {
      const due = c.pending.filter((d) => compareChemTime(d.time, to) <= 0).sort(canonicalCompare);
      if (!due.length) continue;
      c.pending = c.pending.filter((d) => compareChemTime(d.time, to) > 0);
      for (const d of due) this.integrate(c, d);
    }
    this.h = { ...to };
  }

  private integrate(c: Channel, d: DepositEvent): void {
    const t = d.time.t_s;
    const put = (key: string, layer: string, cx: number, cy: number, q: number) => {
      let cell = c.cells.get(key);
      if (!cell) { cell = { key, layer, cx, cy, a: 0, t_ref: t, decayed: 0, contributors: [] }; c.cells.set(key, cell); }
      const kept = cell.a * Math.exp(-c.lambda * (t - cell.t_ref));
      cell.decayed += cell.a - kept; cell.a = kept + q; cell.t_ref = t;
      cell.contributors.push(d.deposit_id);
    };
    if (c.domain.backend === 'surface_edge') {
      const w = d.where as Extract<Where, { edge_id: string }>, ed = c.edges.get(w.edge_id)!;
      for (const [k, f] of edgeShares(w, c.size, ed.bins)) put(`${w.edge_id}#${k}`, ed.layer, (k + 0.5) * c.size, 0, d.amount * f);
    } else {
      const b = c.domain.bounds_mm;
      for (const [i, j, f] of planeShares(d.where, b.x0, b.y0, c.size, c.nx, c.ny)) put(`${d.layer}|${i},${j}`, d.layer, b.x0 + (i + 0.5) * c.size, b.y0 + (j + 0.5) * c.size, d.amount * f);
    }
    c.stats.integrated_count++; c.stats.integrated_amount += d.amount;
  }

  private valueAt(c: Channel, cell: Cell, t: number): number { return cell.a * Math.exp(-c.lambda * (t - cell.t_ref)); }

  /** An individual's local reading: only at the closed horizon, only its own layer, only cells within a bounded radius. */
  sampleLocal(q: SampleQuery): SampleResult {
    const c = this.channel(q?.signal_id), e = validateSampleQuery(q, c.spec, this.clock);
    if (!e.length) {
      if (!this.h || compareChemTime(q.time, this.h) > 0) e.push('FUTURE_SAMPLE');
      else if (compareChemTime(q.time, this.h) < 0) e.push('STALE_SAMPLE');
    }
    const cells: Cell[] = [];
    if (!e.length && q.sensor.kind === 'edge' && c.domain.backend === 'surface_edge') {
      const s = q.sensor, ed = c.edges.get(s.edge_id);
      if (!ed || !(s.s_mm >= 0 && s.s_mm <= ed.length_mm)) e.push('OUT_OF_BOUNDS:sensor');
      else if (ed.layer !== q.layer) e.push('CROSS_LAYER_SAMPLE');
      else {
        const lo = Math.max(0, Math.floor((s.s_mm - s.radius_mm) / c.size)), hi = Math.min(ed.bins - 1, Math.floor((s.s_mm + s.radius_mm) / c.size));
        for (let k = lo; k <= hi; k++) { const cell = c.cells.get(`${s.edge_id}#${k}`); if (cell) cells.push(cell); }
      }
    } else if (!e.length && q.sensor.kind === 'disc' && c.domain.backend === 'sparse_2d') {
      const s = q.sensor, b = c.domain.bounds_mm;
      if (!c.domain.layers.includes(q.layer)) e.push('CROSS_LAYER_SAMPLE');
      else if (s.x_mm < b.x0 || s.x_mm > b.x1 || s.y_mm < b.y0 || s.y_mm > b.y1) e.push('OUT_OF_BOUNDS:sensor');
      else {
        const i0 = Math.max(0, Math.floor((s.x_mm - s.radius_mm - b.x0) / c.size)), i1 = Math.min(c.nx - 1, Math.floor((s.x_mm + s.radius_mm - b.x0) / c.size));
        const j0 = Math.max(0, Math.floor((s.y_mm - s.radius_mm - b.y0) / c.size)), j1 = Math.min(c.ny - 1, Math.floor((s.y_mm + s.radius_mm - b.y0) / c.size));
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const cell = c.cells.get(`${q.layer}|${i},${j}`); if (!cell) continue;
          // the square [i, i+1)×[j, j+1) intersects the disc
          const ex = Math.max(b.x0 + i * c.size - s.x_mm, 0, s.x_mm - (b.x0 + (i + 1) * c.size)), ey = Math.max(b.y0 + j * c.size - s.y_mm, 0, s.y_mm - (b.y0 + (j + 1) * c.size));
          if (ex * ex + ey * ey <= s.radius_mm * s.radius_mm) cells.push(cell);
        }
      }
    }
    if (e.length) throw new ChemRefused(e);
    const t = this.h!.t_s;
    const views = cells.map((cell) => this.view(c, cell, t)).sort((a, b) => lt(a.key, b.key));
    const exposure = views.reduce((x, v) => x + v.value, 0), th = c.spec.perception_rule.threshold.value;
    return { view: 'agent_local', signal_id: q.signal_id, agent_id: q.agent_id, time: { ...this.h! }, layer: q.layer, exposure, cells: views, detectable: th === null ? null : exposure >= th };
  }

  private view(c: Channel, cell: Cell, t: number): CellView {
    return { key: cell.key, layer: cell.layer, center_mm: c.domain.backend === 'surface_edge' ? cell.cx : [cell.cx, cell.cy], value: this.valueAt(c, cell, t) };
  }

  /** Observer view of every field at the horizon. NEVER an input to an individual (CLAUDE.md §2.4). */
  snapshot(): Snapshot {
    const t = this.h?.t_s ?? 0;
    return { view: 'observer_only', time: this.horizon, channels: this.channels().map((id) => { const c = this.ch.get(id)!; return { signal_id: id, cells: [...c.cells.values()].map((cell) => this.view(c, cell, t)).sort((a, b) => lt(a.key, b.key)) }; }) };
  }

  /** Observer: which deposits reached a cell (provenance). */
  provenance(signal_id: string, key: string): string[] { return [...(this.channel(signal_id).cells.get(key)?.contributors ?? [])]; }

  ledger(signal_id: string): ChannelLedger {
    const c = this.channel(signal_id), t = this.h?.t_s ?? 0;
    let present = 0, decayed = 0;
    for (const key of [...c.cells.keys()].sort(lt)) { const cell = c.cells.get(key)!, v = this.valueAt(c, cell, t); present += v; decayed += cell.decayed + (cell.a - v); }
    const pend = c.pending.reduce((x, d) => x + d.amount, 0);
    return {
      signal_id, quantity: c.spec.units.quantity, horizon: this.horizon,
      accepted_count: c.stats.accepted_count, accepted_amount: c.stats.accepted_amount, pending_count: c.pending.length, pending_amount: pend,
      integrated_count: c.stats.integrated_count, integrated_amount: c.stats.integrated_amount, present_amount: present, decayed_amount: decayed,
      residual: c.stats.integrated_amount - present - decayed,
      rejected: JSON.parse(JSON.stringify(c.stats.rejected)) as ChannelLedger['rejected'], cells: c.cells.size,
      balance_kind: c.spec.units.quantity === 'normalized_activity' ? 'activity_audit' : 'mass_balance',
    };
  }
}

/** own copy of an accepted event (the caller may reuse its objects) */
const copyEvent = (d: DepositEvent): DepositEvent => ({ ...d, time: { ...d.time }, where: { ...d.where }, units: { ...d.units } });
function validateTimeOnly(t: ChemTime, clock: ChemClock): string[] {
  const e: string[] = [];
  if (!t || t.unit !== 's') e.push('BAD_UNITS:time');
  if (t && t.clock !== clock.name) e.push('WRONG_CLOCK');
  if (!t || !(Number.isFinite(t.t_s) && t.t_s >= 0)) e.push('BAD:t_s');
  if (!t || !(Number.isSafeInteger(t.round) && t.round >= 0)) e.push('BAD:round');
  return e;
}

export type ChemOp = { op: 'deposit'; events: DepositEvent[] } | { op: 'advance'; to: ChemTime } | { op: 'sample'; query: SampleQuery };
export interface ReplayResult { outputs: (DepositResult[] | SampleResult | { horizon: ChemTime } | { refused: string[] })[]; ledgers: ChannelLedger[]; snapshot: Snapshot }
/** Pure replay: the same config and ops always give the same result. A refused op is recorded, not thrown. */
export function replayChem(cfg: StoreConfig, ops: readonly ChemOp[]): ReplayResult {
  const s = new ChemStore(cfg), outputs: ReplayResult['outputs'] = [];
  for (const o of ops) {
    try {
      if (o.op === 'deposit') outputs.push(s.deposit(o.events));
      else if (o.op === 'advance') { s.advance(o.to); outputs.push({ horizon: s.horizon! }); }
      else outputs.push(s.sampleLocal(o.query));
    } catch (err) { if (err instanceof ChemRefused) outputs.push({ refused: err.codes }); else throw err; }
  }
  return { outputs, ledgers: s.channels().map((id) => s.ledger(id)), snapshot: s.snapshot() };
}

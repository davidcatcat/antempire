/**
 * CHEM-1 synthetic examples (#132). NOT a species experiment: synthetic agents, synthetic amounts, synthetic decay
 * rates and sizes, all labelled assumption (遊戲假設, evidence D). Deterministic (seeded generator, no clock).
 * Used by tests/chem1-core.test.ts and printed by prototypes/chem1/examples.ts.
 */
import { ChemStore, type StoreConfig } from '../../engine/chemistry/core.ts';
import type { ChannelSpec, ChemClock, ChemTime, DepositEvent, Domain, ParamProvenance, Where } from '../../engine/chemistry/contract.ts';

export const CLOCK: ChemClock = { name: 'chem1.synthetic', anchor: { day: 0, minute: 600 } };
export const T = (t_s: number, round = 0): ChemTime => ({ clock: CLOCK.name, unit: 's', t_s, round });
export const synth = (value: number | null, note: string): ParamProvenance => ({ value, assumption: true, basis: '遊戲假設', evidence_level: 'D', sources: [], note: `synthetic candidate, not a species value: ${note}` });

/** a synthetic trail channel: M1 candidate mechanism (C), every number D */
export function synthChannel(signal_id: string, backend: 'surface_edge' | 'sparse_2d', o: { lambda_per_s?: number; size_mm?: number; max_radius_mm?: number; threshold?: number | null; variant?: 'M1' | 'M2'; role?: 'E' | 'F' | null } = {}): ChannelSpec {
  const size = o.size_mm ?? (backend === 'surface_edge' ? 5 : 2);
  return {
    signal_id, mechanism: 'trail_recruitment', model_variant: o.variant ?? 'M1', variant_role: o.role ?? null, chemical_identity: null,
    units: { quantity: 'normalized_activity', length: 'mm', time: 's' }, backend,
    spatial_support: backend === 'surface_edge' ? { kind: 'surface_edge', bin_mm: size } : { kind: 'sparse_2d', cell_mm: size, isotropic_diffusion: false },
    perception_rule: { mode: backend === 'surface_edge' ? 'on_support' : 'bounded_radius', max_radius_mm: o.max_radius_mm ?? 3, near_contact_mm: null, same_layer_only: true, threshold: synth(o.threshold ?? null, 'sensor threshold') },
    time_rule: { kind: 'analytic_exponential', unit: 's', lambda_per_s: synth(o.lambda_per_s ?? 0, (o.lambda_per_s ?? 0) === 0 ? 'lambda = 0 baseline' : 'decay rate'), same_instant: 'visible_if_round_not_later' },
    evidence_level: 'C', assumption: true, sources: ['R21', 'R102'], note: 'CHEM-1 synthetic channel: mechanism C (M1/M2 candidates), numbers D',
  };
}

export function dep(id: string, signal_id: string, agent: string, t: ChemTime, where: Where, amount = 1, layer = 'surface', origin = `ev:${id}`): DepositEvent {
  return { deposit_id: id, signal_id, origin_agent: agent, source_worker_id: null, origin_event_id: origin, time: t, layer, substrate: null, where, amount, cause: 'synthetic', units: { quantity: 'normalized_activity', length: 'mm', time: 's' } };
}

/** seeded generator (mulberry32), test/prototype only */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffle<T>(xs: readonly T[], g: () => number): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(g() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export const Y_EDGES: Domain = { backend: 'surface_edge', edges: [{ id: 'stem', length_mm: 60, layer: 'surface' }, { id: 'left', length_mm: 60, layer: 'surface' }, { id: 'right', length_mm: 60, layer: 'surface' }] };
export const PLANE = (w = 200, layers = ['surface']): Domain => ({ backend: 'sparse_2d', bounds_mm: { x0: 0, y0: 0, x1: w, y1: w }, layers });

/** Y-maze (geometry like a 60 mm Y bridge, used only as a shape): n synthetic ants each walk stem then left, depositing
 *  once per edge on completion. Readout at the junction on each branch at time `readAt`. */
export function yMaze(lambda_per_s: number, n = 10, readAt = 600) {
  const s = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('trail', 'surface_edge', { lambda_per_s }), domain: Y_EDGES }] });
  const evs: DepositEvent[] = [];
  for (let k = 0; k < n; k++) {
    const t0 = k * 30; // one ant every 30 s (synthetic)
    evs.push(dep(`a${k}-stem`, 'trail', `ant${k}`, T(t0 + 4), { kind: 'edge_segment', edge_id: 'stem', s0_mm: 0, s1_mm: 60 }));
    evs.push(dep(`a${k}-left`, 'trail', `ant${k}`, T(t0 + 8), { kind: 'edge_segment', edge_id: 'left', s0_mm: 0, s1_mm: 60 }));
  }
  s.deposit(evs); s.advance(T(readAt));
  const read = (edge_id: string) => s.sampleLocal({ signal_id: 'trail', agent_id: 'reader', layer: 'surface', time: T(readAt), phase: 'local_sensing', sensor: { kind: 'edge', edge_id, s_mm: 1, radius_mm: 3 } }).exposure;
  return { lambda_per_s, n, read_at_s: readAt, left: read('left'), right: read('right'), stem: read('stem'), ledger: s.ledger('trail') };
}

/** two ants on a plane: overlapping paths (same corridor) or far apart (50 mm). Each deposits a 10 mm segment per second. */
export function twoAnts(gap_mm: number, lambda_per_s = 0, seconds = 10) {
  const s = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('trail2d', 'sparse_2d', { lambda_per_s }), domain: PLANE() }] });
  const out: { t: number; a: number; b: number }[] = [];
  for (let t = 1; t <= seconds; t++) {
    s.deposit([
      dep(`A${t}`, 'trail2d', 'A', T(t), { kind: 'segment2d', x0_mm: 10 * (t - 1), y0_mm: 50, x1_mm: 10 * t, y1_mm: 50 }),
      dep(`B${t}`, 'trail2d', 'B', T(t), { kind: 'segment2d', x0_mm: 10 * (t - 1), y0_mm: 50 + gap_mm, x1_mm: 10 * t, y1_mm: 50 + gap_mm }),
    ]);
    s.advance(T(t));
    const read = (y: number, who: string) => s.sampleLocal({ signal_id: 'trail2d', agent_id: who, layer: 'surface', time: T(t), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: 10 * t, y_mm: y, radius_mm: 3 } }).exposure;
    out.push({ t, a: read(50, 'A'), b: read(50 + gap_mm, 'B') });
  }
  return { gap_mm, readings: out, ledger: s.ledger('trail2d') };
}

/** sparse space: agents scattered in a 1000×1000 mm plane, 2 mm cells (250 000 possible); only touched cells exist */
export function sparseSpace(agents = 14, seconds = 30, seed = 7) {
  const g = rng(seed), s = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('trail2d', 'sparse_2d'), domain: PLANE(1000) }] });
  const pos = Array.from({ length: agents }, () => [g() * 1000, g() * 1000]);
  for (let t = 1; t <= seconds; t++) {
    const evs: DepositEvent[] = [];
    pos.forEach((p, i) => {
      const a = g() * 2 * Math.PI, x1 = Math.min(1000, Math.max(0, p[0] + 10 * Math.cos(a))), y1 = Math.min(1000, Math.max(0, p[1] + 10 * Math.sin(a)));
      if (x1 !== p[0] || y1 !== p[1]) evs.push(dep(`w${i}-${t}`, 'trail2d', `w${i}`, T(t), { kind: 'segment2d', x0_mm: p[0], y0_mm: p[1], x1_mm: x1, y1_mm: y1 }));
      p[0] = x1; p[1] = y1;
    });
    s.deposit(evs); s.advance(T(t));
  }
  const L = s.ledger('trail2d');
  return { agents, seconds, cells_stored: L.cells, cells_possible: 500 * 500, ledger: L };
}

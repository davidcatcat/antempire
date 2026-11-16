/**
 * Demo 2 — the REPLAY side of the D2E reconciliation (tests/web-demo2-events.test.ts, tests/browser/demo2-events.check.cjs):
 * engine-event counts by class, taken straight from the canonical log lines of the P0-A2 core (prototypes/p0a2-24h/world.ts).
 * Deliberately independent of the page's classifier (web/src/demo2/events.ts): it shares no code with it, so the two can
 * only agree if both read the engine's events the same way. Read only; NON-OFFICIAL experiment world.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runTo } from '../../prototypes/p0a2-24h/world.ts';

export type Counts = Record<string, number>;
const sorted = (o: Counts): Counts => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/** counts of the log lines with position (= base seq) in [fromSeq, toSeq) */
export function replayCounts(lines: readonly string[], fromSeq = 0, toSeq = Infinity): { classes: Counts; kinds: Counts; total: number } {
  const c: Counts = {}, k: Counts = {}; let total = 0;
  const up = (o: Counts, key: string, n = 1) => { if (n) o[key] = (o[key] ?? 0) + n; };
  lines.forEach((line, seq) => {
    if (seq < fromSeq || seq >= toSeq) return;
    const e = JSON.parse(line) as { k: string; p: Record<string, any> }, p = e.p; total++; up(k, e.k);
    if (e.k === 'at_entrance') up(c, p.choice === 'exit' ? 'exit' : 'exit_refused');
    if (e.k === 'back_in') up(c, 'back_in');
    if (e.k === 'search_end') up(c, p.found ? 'search_found' : 'search_failed');
    if (e.k === 'arrive_source' || (e.k === 'search_end' && p.found)) up(c, p.heat ? 'source_heat' : p.take > 0 ? 'source_take' : 'source_empty');
    if (e.k === 'feed_end') up(c, 'feed_end');
    if (e.k === 'arrive_nest') {
      up(c, 'arrive_nest'); if (p.loaded) up(c, 'arrive_loaded');
      for (const x of p.touched) { up(c, x.amount > 0 ? 'contact_transfer' : 'contact_only'); if (x.woke) up(c, 'woke'); }
    }
    if (e.k === 'wake') up(c, 'wake');
    if (Array.isArray(p.larvae)) for (const x of p.larvae) { up(c, 'brood_touch'); if (x.fed > 0) up(c, 'larva_fed'); }
    if (Array.isArray(p.idle_larvae)) up(c, 'idle_larva_touch', p.idle_larvae.length);
    if (['bout_end', 'wake', 'arrive_nest'].includes(e.k)) up(c, `choice_${p.choice}`);
    if (['produce', 'env_light', 'env_sample', 'env_day'].includes(e.k)) up(c, e.k);
  });
  return { classes: sorted(c), kinds: sorted(k), total };
}


/** the canonical log lines of the reference world (scenario of the Worker adapter) for `seed`, run to tMs */
export function replayLines(seed: number, tMs: number, scenario = 'taichung-march-ref'): string[] {
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../prototypes/p0a2-24h/params.json'), 'utf8'));
  return runTo(raw, scenario, seed, tMs, { captureLog: true }).lines!;
}

/** per-individual totals from the log lines (D2E-2 reconciliation; independent of web/src/demo2/record.ts): what each
 *  worker did / received and what each larva received, over the lines with position in [fromSeq, toSeq) */
export interface ReplayOwn { exits: number; takes: number; empties: number; taken_up: number; gave: number; gave_up: number; got: number; got_up: number; fed_larvae: number; fed_up: number; woken: number; contacts_made: number; contacted_by: number }
export function replayOwn(lines: readonly string[], fromSeq = 0, toSeq = Infinity): { workers: Record<string, ReplayOwn>; larvae: Record<string, { touched: number; touched_idle: number; fed: number; fed_up: number }> } {
  const W: Record<string, ReplayOwn> = {}, L: Record<string, { touched: number; touched_idle: number; fed: number; fed_up: number }> = {};
  const w = (id: string) => (W[id] ??= { exits: 0, takes: 0, empties: 0, taken_up: 0, gave: 0, gave_up: 0, got: 0, got_up: 0, fed_larvae: 0, fed_up: 0, woken: 0, contacts_made: 0, contacted_by: 0 });
  const l = (id: string) => (L[id] ??= { touched: 0, touched_idle: 0, fed: 0, fed_up: 0 });
  lines.forEach((line, seq) => {
    if (seq < fromSeq || seq >= toSeq) return;
    const e = JSON.parse(line) as { k: string; a: string; p: Record<string, any> }, p = e.p;
    if (e.k === 'at_entrance' && p.choice === 'exit') w(e.a).exits++;
    if ((e.k === 'arrive_source' || (e.k === 'search_end' && p.found)) && !p.heat) { if (p.take > 0) { w(e.a).takes++; w(e.a).taken_up += p.take; } else w(e.a).empties++; }
    if (e.k === 'arrive_nest') for (const x of p.touched) {
      w(e.a).contacts_made++; w(x.worker).contacted_by++;
      if (x.amount > 0) { w(e.a).gave++; w(e.a).gave_up += x.amount; w(x.worker).got++; w(x.worker).got_up += x.amount; }
      if (x.woke) w(x.worker).woken++;
    }
    for (const x of p.larvae ?? []) { l(x.larva).touched++; if (x.fed > 0) { l(x.larva).fed++; l(x.larva).fed_up += x.fed; w(e.a).fed_larvae++; w(e.a).fed_up += x.fed; } }
    for (const x of p.idle_larvae ?? []) l(x.larva).touched_idle++;
  });
  return { workers: W, larvae: L };
}

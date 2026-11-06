/**
 * v2-review.26 (Issue #80): independent READER of the world food-source flows. It does not import the engine: every flow
 * the ecology step should have written is recomputed here from the source state before the day, the day's rain, the
 * host/hemipteran state after the day and the world parameters (a second implementation of engine/ecology.ts), then
 *   1. matched one-to-one with the day's `source_flow` events (a missing event = a change without an event; an extra or
 *      repeated event = food counted twice; a different value = a wrong amount),
 *   2. each source is rebuilt from the events ALONE:
 *        end = start + Σ flows in − Σ flows out + new remains (new_food_source) + kills (C2) − collected (C2)
 *      (capacity_withheld never existed and is not part of the stock), and
 *   3. compared with the ME-1 source ledger (cli/lib/source-ledger.ts): with the switch on, every quantity the ledger
 *      finds deleted by the clamp or the expiry must be covered by a flow event; with the switch off the ledger shows them
 *      as deleted without an event (the defect of Issue #80).
 * All amounts are game portions (no mg or energy claim). Engineering/mathematical correctness only, not scientific validation.
 */
import { sourceLedgerDay } from './source-ledger.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface SourceFlowReplay { ok: boolean; errors: string[]; flows: number; by_cause: Record<string, number>; unevented: { overflow: number; expired: number; washoff: number; decay: number } }

const TOL = 1e-5;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const r6 = (x: number) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
const CAUSES: Record<string, string[]> = {
  honeydew: ['secretion', 'rival_harvest', 'rain_washoff', 'capacity_runoff', 'capacity_withheld'],
  nectar: ['secretion', 'rain_washoff', 'capacity_resorbed', 'capacity_withheld'],
  carcass: ['decomposition', 'expired_remains'],
};

interface Expected { site: string; cause: string; batch: string; portions: number; from: string | null; to: string | null }

/** startWorld: the world before simulateWorldDay; endWorld / result: its output; wp: resolved world parameters. */
export function replaySourceFlows(startWorld: Any, endWorld: Any, result: Any, wp: Any): SourceFlowReplay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  const on = wp?.source_flows?.record_source_flows_v26 === true, day = Number(startWorld?.sim_day) + 1, rain = Number(result?.weather?.rain_mm);
  const flows: Any[] = (result?.world_events ?? []).filter((e: Any) => e?.type === 'source_flow');
  const by_cause: Record<string, number> = {};
  if (!on && flows.length) err(`${flows.length} source_flow events while source_flows.record_source_flows_v26 is off`);

  // ---- 1. recompute what the ecology step did to every source (independently of the engine)
  const expected: Expected[] = [];
  const add = (site: string, cause: string, portions: number, from: string | null, to: string | null, batch = '') => { if (r6(portions) > 0) expected.push({ site, cause, batch, portions: r6(portions), from, to }); };
  for (const id of Object.keys(startWorld?.sources ?? {}).sort()) {
    const s0 = startWorld.sources[id], s1 = endWorld?.sources?.[id], src = 'source:' + id;
    if (!s1) { err(`source ${id} is missing after the day`); continue; }
    if (s0.type === 'carcass') {
      const c = wp.carcasses, frac = clamp(c.carcass_daily_decay_fraction + rain * c.carcass_rain_decay_bonus, 0, c.carcass_decay_max_daily_fraction);
      for (const b of s0.batches ?? []) {
        const p = Number(b.protein);
        if (day - Number(b.original_day) > c.carcass_max_lifetime_days) add(id, 'expired_remains', p, src, 'loss:decomposition', String(b.event_id));
        else add(id, 'decomposition', p - r6(p * (1 - frac)), src, 'loss:decomposition', String(b.event_id));
      }
      continue;
    }
    const start = Number(s0.sugar), cap = Number(s1.capacity);
    let gross: number, rivalFrac = 0, rivalId = '', withheld: boolean, wash: number;
    if (s0.type === 'honeydew') {
      const h = wp.hemipterans, rate = Number(h.honeydew_per_colony_per_day[s1.hemipteran_kind ?? '']);
      const rainFactor = clamp(1 - rain * h.rain_honeydew_secretion_suppression_per_mm, h.honeydew_rain_secretion_min_multiplier, 1);
      gross = s1.host_alive ? Number(s1.hemipteran_colonies) * rate * h.honeydew_productivity_multiplier * rainFactor : 0;
      const rival = (wp.background_rivals ?? []).find((r: Any) => r.site === id);
      if (rival) { rivalFrac = Number(rival.honeydew_harvest_fraction); rivalId = String(rival.id); }
      wash = clamp(rain * wp.honeydew.honeydew_washoff_per_rain_mm, 0, wp.honeydew.honeydew_washoff_max_fraction);
      withheld = wp.source_flows.honeydew_capacity_limits_secretion === true;
    } else {
      gross = Number(s0.bloom_days_left) > 0 && s1.host_alive !== false ? Number(s0.production_per_day) : 0;
      wash = clamp(rain * wp.nectar.nectar_washoff_per_rain_mm, 0, wp.nectar.nectar_washoff_max_fraction);
      withheld = wp.source_flows.nectar_capacity_limits_secretion === true;
    }
    const netProduction = gross * (1 - rivalFrac), excess = Math.max(0, start * (1 - wash) + netProduction - cap);
    // withheld (alternative assumption): at most today's net production was never secreted; the rest of the excess existed
    const notSecreted = withheld ? Math.min(excess, netProduction) : 0, lost = excess - notSecreted;
    add(id, 'secretion', gross - notSecreted, `producer:${s0.type === 'honeydew' ? 'hemipterans' : 'flowers'}:${id}`, src);
    if (rivalId) add(id, 'rival_harvest', gross * rivalFrac, src, `consumer:background_rival:${rivalId}`);
    add(id, 'rain_washoff', start * wash, src, 'loss:rain_washoff');
    add(id, 'capacity_withheld', notSecreted, null, null);
    if (s0.type === 'honeydew') add(id, 'capacity_runoff', lost, src, 'loss:capacity_runoff'); else add(id, 'capacity_resorbed', lost, src, `plant:flowers:${id}`);
  }

  // ---- 2. match the events one-to-one with the recomputed flows (only when the switch is on)
  const key = (site: string, cause: string, batch: string) => `${site}|${cause}|${batch}`;
  const want = new Map(expected.map((x) => [key(x.site, x.cause, x.batch), x]));
  const got = new Map<string, Any>(), ids = new Set<string>();
  for (const f of flows) {
    const s0 = startWorld?.sources?.[f.site], batch = f.batch_event_id === undefined ? '' : String(f.batch_event_id), k = key(String(f.site), String(f.cause), batch);
    if (!s0) { err(`flow ${f.id}: unknown source ${f.site}`); continue; }
    if (typeof f.id !== 'string' || !f.id.startsWith(`SF-${day}-${f.site}-`) || ids.has(f.id) || f.day !== day) err(`flow ${f.id}: id/day not unique for day ${day}`);
    ids.add(String(f.id));
    if (!CAUSES[s0.type]?.includes(f.cause)) err(`flow ${f.id}: cause ${f.cause} is not possible at a ${s0.type} source`);
    if (f.food !== (s0.type === 'carcass' ? 'protein' : 'sugar')) err(`flow ${f.id}: food ${f.food} at a ${s0.type} source`);
    if (!(typeof f.portions === 'number' && Number.isFinite(f.portions) && f.portions > 0)) err(`flow ${f.id}: portions ${f.portions}`);
    if ((f.never_existed === true) !== (f.cause === 'capacity_withheld')) err(`flow ${f.id}: never_existed must mark exactly capacity_withheld`);
    if (f.assumption !== true) err(`flow ${f.id}: not tagged assumption: true`);
    if (got.has(k)) { err(`flow ${f.id}: ${k} appears twice (counted twice)`); continue; }
    got.set(k, f);
    const w = want.get(k);
    if (!w) { err(`flow ${f.id}: ${k} ${f.portions} — no such change happened (recomputed from the parameters)`); continue; }
    if (f.from !== w.from || f.to !== w.to) err(`flow ${f.id}: ${f.from} -> ${f.to}, expected ${w.from} -> ${w.to}`);
    if (!(Math.abs(Number(f.portions) - w.portions) <= TOL)) err(`flow ${f.id}: ${k} ${f.portions}, recomputed ${w.portions}`);
  }
  if (on) for (const [k, w] of want) if (!got.has(k)) err(`${k}: ${w.portions} portions changed with no source_flow event`);
  if (on) for (const f of flows) if (f.site && f.batch_event_id !== undefined && got.get(key(f.site, f.cause === 'decomposition' ? 'expired_remains' : 'decomposition', String(f.batch_event_id)))) err(`flow ${f.id}: batch ${f.batch_event_id} both decayed and expired`);
  for (const f of flows) by_cause[f.cause] = r6((by_cause[f.cause] ?? 0) + Number(f.portions));

  // ---- 3. rebuild every source from the events alone
  const transfers = (result?.colonies ?? []).flatMap((c: Any) => c.events ?? []).filter((e: Any) => e?.type === 'food_transfer');
  if (on) for (const id of Object.keys(startWorld?.sources ?? {}).sort()) {
    const s0 = startWorld.sources[id], s1 = endWorld.sources[id], food = s0.type === 'carcass' ? 'protein' : 'sugar', src = 'source:' + id;
    const stock = (s: Any) => s.type === 'carcass' ? (s.batches ?? []).reduce((t: number, b: Any) => t + Number(b.protein), 0) : Number(s.sugar);
    let x = stock(s0);
    for (const f of flows) if (f.site === id && f.cause !== 'capacity_withheld') x += f.to === src ? Number(f.portions) : f.from === src ? -Number(f.portions) : 0;
    for (const e of result?.world_events ?? []) if (e?.type === 'new_food_source' && e.site === id) x += Number(e.protein_portions);
    for (const t of transfers) if (t.food_type === food) { if (t.recipient?.kind === 'source' && t.recipient.id === id) x += Number(t.portions); if (t.source?.kind === 'source' && t.source.id === id) x -= Number(t.portions); }
    if (!(Math.abs(x - stock(s1)) <= TOL)) err(`${id}: rebuilt from events ${r6(x)} ≠ end stock ${r6(stock(s1))}`);
  }

  // ---- 3b. carcass batches one by one (Codex review of 290c440): moving protein between batches or changing a birth day
  //      keeps every total but changes the next days' supply. Each batch: start − its ecology flows (the events when the
  //      switch is on, else the recomputed ones) + its new remains − what ants took from it (source_batch_consumed) = end.
  const consumed = (result?.colonies ?? []).flatMap((c: Any) => c.events ?? []).filter((e: Any) => e?.type === 'source_batch_consumed');
  const newRemains = [...(result?.world_events ?? []), ...(result?.colonies ?? []).flatMap((c: Any) => c.events ?? [])].filter((e: Any) => e?.type === 'new_food_source');
  for (const id of Object.keys(startWorld?.sources ?? {}).sort()) {
    const s0 = startWorld.sources[id], s1 = endWorld?.sources?.[id];
    if (s0.type !== 'carcass' || !s1) continue;
    const want = new Map<string, { protein: number; day: number }>();
    for (const b of s0.batches ?? []) {
      const out = on ? flows.filter((f) => f.site === id && String(f.batch_event_id) === String(b.event_id)).reduce((t, f) => t + Number(f.portions), 0)
        : expected.filter((x) => x.site === id && x.batch === String(b.event_id)).reduce((t, x) => t + x.portions, 0);
      if (want.has(String(b.event_id))) err(`${id}: batch ${b.event_id} appears twice before the day`);
      want.set(String(b.event_id), { protein: Number(b.protein) - out, day: Number(b.original_day) });
    }
    for (const e of newRemains) if (e.site === id) {
      if (want.has(String(e.id))) err(`${id}: new remains ${e.id} reuse an existing batch id`);
      want.set(String(e.id), { protein: Number(e.protein_portions), day });
    }
    for (const e of consumed) if (e.location === id) {
      const w = want.get(String(e.source_event_id));
      if (!w) { err(`${id}: ants took from batch ${e.source_event_id}, which is not there`); continue; }
      w.protein -= Number(e.quantity_portions);
    }
    const seen = new Set<string>();
    for (const b of s1.batches ?? []) {
      const k = String(b.event_id), w = want.get(k);
      if (seen.has(k)) err(`${id}: batch ${k} appears twice after the day`);
      seen.add(k);
      if (!w) { err(`${id}: batch ${k} appeared with no new_food_source event`); continue; }
      if (Number(b.original_day) !== w.day) err(`${id}: batch ${k} birth day ${b.original_day}, expected ${w.day}`);
      if (!(Math.abs(Number(b.protein) - w.protein) <= TOL)) err(`${id}: batch ${k} holds ${b.protein}, rebuilt ${r6(w.protein)} (protein moved between batches or changed without an event)`);
      if (Number(b.protein) < -TOL) err(`${id}: batch ${k} is negative`);
    }
    for (const [k, w] of want) if (!seen.has(k) && Math.abs(w.protein) > TOL) err(`${id}: batch ${k} (${r6(w.protein)}) disappeared without an event`);
  }

  // ---- 4. the ME-1 ledger: what it finds removed must be named by a flow
  const ledger = sourceLedgerDay(startWorld, endWorld, result, wp);
  for (const e of ledger.errors) err('ME-1 ledger: ' + e);
  const sum = (cause: string, site?: string) => flows.filter((f) => f.cause === cause && (!site || f.site === site)).reduce((t, f) => t + Number(f.portions), 0);
  const unevented = { overflow: 0, expired: 0, washoff: 0, decay: 0 };
  for (const [id, l] of Object.entries(ledger.sources)) {
    unevented.overflow += Math.max(0, l.overflow_deleted - sum('capacity_runoff', id) - sum('capacity_resorbed', id) - sum('capacity_withheld', id));
    unevented.expired += Math.max(0, l.expired_deleted - sum('expired_remains', id));
    unevented.washoff += Math.max(0, l.washoff - sum('rain_washoff', id));
    unevented.decay += Math.max(0, l.decay - sum('decomposition', id));
  }
  for (const k of Object.keys(unevented) as (keyof typeof unevented)[]) { unevented[k] = r6(unevented[k]); if (unevented[k] <= TOL) unevented[k] = 0; }
  if (on && Object.values(unevented).some((v) => v > 0)) err(`changes without an event: ${JSON.stringify(unevented)}`);
  return { ok: errors.length === 0, errors, flows: flows.length, by_cause, unevented };
}

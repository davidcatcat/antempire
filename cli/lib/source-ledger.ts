/**
 * ME-1 (Issue #66; math-ecology architecture §9 item 1): world-side food-source ledger — an independent READER, not an engine
 * check. It makes visible the source food that the ecology step removes without any event:
 *   - honeydew / nectar production above the source capacity (engine/ecology.ts growHoneydew / growNectar clamp), and
 *   - edible carcass protein deleted when a batch passes carcass_max_lifetime_days (engine/ecology.ts decayCarcasses).
 * Both are known P1 conservation findings of old code; CLAUDE.md says they are not fixed here (a rules update decides).
 *
 * Per source and day, all in game portions (game_portions_NOT_mg; no mg or energy claim):
 *   end = start + production + new_remains + killed_in − washoff − decay − overflow_deleted − expired_deleted − collected
 * where production/washoff/decay are recomputed from the saved ecological record, the day's rain and the world parameters,
 * new_remains from new_food_source events, killed_in / collected from the C2 food_transfer events, and the two deletions are
 * what is left of the ecology step's clamp and expiry. Every term is ≥ 0; the residual must be within rounding.
 * The post-forage half (post-growth → end) is the C2 engine check checkSources; this reader closes the ecology half from the
 * start state, which C2 does not see. Engineering/mathematical correctness only, not scientific validation.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SourceFlows { type: string; start: number; production: number; new_remains: number; killed_in: number; washoff: number; decay: number; overflow_deleted: number; expired_deleted: number; collected: number; end: number; residual: number }
export interface SourceLedgerDay { ok: boolean; errors: string[]; sources: Record<string, SourceFlows>; deleted_without_event: { overflow: number; expired: number } }

const TOL = 1e-5; // engine rounds stocks to 1e-6 (engine/math.ts round); a few roundings per source and day
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const r6 = (x: number) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;

/** startWorld: the world before simulateWorldDay; endWorld / result: its output; wp: resolved world parameters. */
export function sourceLedgerDay(startWorld: Any, endWorld: Any, result: Any, wp: Any): SourceLedgerDay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  const rain = Number(result?.weather?.rain_mm), day = Number(startWorld?.sim_day) + 1;
  if (!Number.isFinite(rain) || rain < 0) err(`rain ${result?.weather?.rain_mm} is not a non-negative number`);
  const transfers = (result?.colonies ?? []).flatMap((c: Any) => c.events ?? []).filter((e: Any) => e?.type === 'food_transfer');
  const remains = new Map<string, number>();
  for (const e of result?.world_events ?? []) if (e?.type === 'new_food_source') remains.set(e.site, (remains.get(e.site) ?? 0) + Number(e.protein_portions));
  const sources: Record<string, SourceFlows> = {};
  const ids = new Set([...Object.keys(startWorld?.sources ?? {}), ...Object.keys(endWorld?.sources ?? {})]);
  for (const id of [...ids].sort()) {
    const s0 = startWorld.sources[id], s1 = endWorld.sources[id];
    if (!s0 || !s1) { err(`source ${id} exists only ${s0 ? 'before' : 'after'} the day`); continue; }
    if (s0.type !== s1.type) { err(`source ${id} changed type ${s0.type} -> ${s1.type}`); continue; }
    const food = s0.type === 'carcass' ? 'protein' : 'sugar';
    let collected = 0, killedIn = 0;
    for (const t of transfers) {
      if (t.food_type !== food) continue;
      if (t.source?.kind === 'source' && t.source.id === id) collected += Number(t.portions);
      if (t.recipient?.kind === 'source' && t.recipient.id === id) killedIn += Number(t.portions);
    }
    const f: SourceFlows = { type: s0.type, start: 0, production: 0, new_remains: 0, killed_in: r6(killedIn), washoff: 0, decay: 0, overflow_deleted: 0, expired_deleted: 0, collected: r6(collected), end: 0, residual: 0 };
    let afterGrowth: number;
    if (s0.type === 'carcass') {
      const c = wp.carcasses, frac = clamp(c.carcass_daily_decay_fraction + rain * c.carcass_rain_decay_bonus, 0, c.carcass_decay_max_daily_fraction);
      f.start = r6((s0.batches ?? []).reduce((t: number, b: Any) => t + Number(b.protein), 0));
      let kept = 0;
      for (const b of s0.batches ?? []) {
        const p = Number(b.protein);
        if (day - Number(b.original_day) > c.carcass_max_lifetime_days) { f.expired_deleted += p; continue; }
        const left = r6(p * (1 - frac)); kept += left; f.decay += p - left;
      }
      f.new_remains = r6(remains.get(id) ?? 0);
      afterGrowth = r6(kept + f.new_remains);
      f.end = r6((s1.batches ?? []).reduce((t: number, b: Any) => t + Number(b.protein), 0));
      if (Math.abs(f.end - Number(s1.protein)) > TOL) err(`carcass ${id}: protein ${s1.protein} is not the sum of its batches ${f.end}`);
    } else {
      const rec = s1.ecological_record ?? {};
      f.start = Number(s0.sugar);
      if (Math.abs(Number(rec.stock_before) - f.start) > TOL) err(`${s0.type} ${id}: ecological record starts at ${rec.stock_before}, the source held ${f.start}`);
      const wash = s0.type === 'honeydew' ? clamp(rain * wp.honeydew.honeydew_washoff_per_rain_mm, 0, wp.honeydew.honeydew_washoff_max_fraction) : clamp(rain * wp.nectar.nectar_washoff_per_rain_mm, 0, wp.nectar.nectar_washoff_max_fraction);
      f.production = Number(s0.type === 'honeydew' ? rec.net_portions : rec.production_portions);
      f.washoff = f.start * wash;
      afterGrowth = Number(rec.stock_after);
      const uncapped = f.start - f.washoff + f.production;
      f.overflow_deleted = uncapped - afterGrowth; // a positive clamp loss; a negative one would be food from nowhere
      if (afterGrowth > Number(s1.capacity) + TOL) err(`${s0.type} ${id}: ${afterGrowth} after growth exceeds capacity ${s1.capacity}`);
      if (f.overflow_deleted > TOL && Math.abs(afterGrowth - Number(s1.capacity)) > TOL) err(`${s0.type} ${id}: ${r6(f.overflow_deleted)} removed by the growth step while below capacity`);
      f.end = Number(s1.sugar);
    }
    for (const k of ['production', 'new_remains', 'killed_in', 'washoff', 'decay', 'expired_deleted', 'collected'] as const) if (!(Number.isFinite(f[k]) && f[k] >= -TOL)) err(`${id}: ${k} = ${f[k]}`);
    if (f.overflow_deleted < -TOL) err(`${id}: the growth step added ${r6(-f.overflow_deleted)} that no production explains`);
    f.residual = f.end - (afterGrowth + f.killed_in - f.collected);
    if (!(Math.abs(f.residual) <= TOL)) err(`${id}: end ${f.end} ≠ after growth ${afterGrowth} + kills ${f.killed_in} − collected ${f.collected} (residual ${f.residual})`);
    for (const k of Object.keys(f) as (keyof SourceFlows)[]) if (typeof f[k] === 'number') (f as Any)[k] = r6(f[k] as number);
    if (Math.abs(f.overflow_deleted) <= TOL) f.overflow_deleted = 0;
    sources[id] = f;
  }
  const sum = (k: 'overflow_deleted' | 'expired_deleted') => r6(Object.values(sources).reduce((t, f) => t + f[k], 0));
  return { ok: errors.length === 0, errors, sources, deleted_without_event: { overflow: sum('overflow_deleted'), expired: sum('expired_deleted') } };
}

/**
 * v2-review.26 (Issue #80): independent READER of the world food-source flows. It does not import the engine: every flow
 * the ecology step should have written is recomputed here from the source state before the day, the day's rain, the
 * host/hemipteran state after the day and the world parameters (a second implementation of engine/ecology.ts) — the state
 * fields it reads must be unchanged within the day or changed exactly as the ecology events say (§3c) — then
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
import { createHash } from 'node:crypto';
import { sourceLedgerDay } from './source-ledger.ts';

/** The named random stream of a day, re-implemented here with Node's sha256 (not the engine's code): the first 4 bytes
 *  of sha256(`${seed}|${day}|${tag}`) as little-endian uint32 seed a mulberry32 generator (engine/rng.ts documents it). */
const stream = (seed: number, day: number, tag: string) => {
  let x = createHash('sha256').update(`${seed}|${day}|${tag}`, 'utf8').digest().readUInt32LE(0) >>> 0;
  return () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

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

  // ---- 3b. carcass batches one by one, replayed in event order (Codex reviews of 290c440 and ece3bc2). Moving protein
  //      between batches, changing a birth day, or forging the per-batch take records (+0.1 on one batch, −0.1 on another)
  //      keeps every total but changes the next days' supply. So each batch is rebuilt from:
  //        start − its ecology flows (the events when the switch is on, else the recomputed ones),
  //        + new remains (natural deaths after the ecology step, then kills, in event order),
  //        − each ant's take, where a take is the run of source_batch_consumed records closed by the SAME worker's C2
  //          `collect` transfer from that site: the records must add up to the transfer, every amount must be positive, and
  //          the split over batches must follow the engine's rule (engine/foraging.ts takeProtein: batches emptied in their
  //          stored order) — so a take record cannot be moved from one batch to another.
  type Pile = { id: string; protein: number; day: number }[];
  const piles = new Map<string, Pile>();
  for (const id of Object.keys(startWorld?.sources ?? {}).sort()) {
    const s0 = startWorld.sources[id];
    if (s0.type !== 'carcass') continue;
    const pile: Pile = [];
    for (const b of s0.batches ?? []) {
      const bid = String(b.event_id);
      const out = on ? flows.filter((f) => f.site === id && String(f.batch_event_id) === bid).reduce((t, f) => t + Number(f.portions), 0)
        : expected.filter((x) => x.site === id && x.batch === bid).reduce((t, x) => t + x.portions, 0);
      if (pile.some((x) => x.id === bid)) err(`${id}: batch ${bid} appears twice before the day`);
      pile.push({ id: bid, protein: r6(Number(b.protein) - out), day: Number(b.original_day) });
    }
    piles.set(id, pile);
  }
  const append = (e: Any) => {
    const pile = piles.get(e.site);
    if (!pile) return; // new remains at a non-carcass site are checked elsewhere
    if (pile.some((x) => x.id === String(e.id))) err(`${e.site}: new remains ${e.id} reuse an existing batch id`);
    pile.push({ id: String(e.id), protein: Number(e.protein_portions), day });
  };
  for (const e of result?.world_events ?? []) if (e?.type === 'new_food_source') append(e);
  for (const c of result?.colonies ?? []) {
    let pending: { worker: string; site: string; takes: [string, number][] } | null = null;
    for (const e of c.events ?? []) {
      if (e?.type === 'new_food_source') append(e);
      else if (e?.type === 'source_batch_consumed') {
        const q = Number(e.quantity_portions);
        if (!piles.has(e.location)) { err(`${c.colony_id}: batch take at ${e.location}, not a carcass source`); continue; }
        if (!(Number.isFinite(q) && q > 0)) err(`${c.colony_id}: batch take ${e.source_event_id} of ${e.quantity_portions} portions (must be positive)`);
        if (pending && (pending.worker !== e.worker || pending.site !== e.location)) { err(`${c.colony_id}: batch takes by ${pending.worker} at ${pending.site} not closed by a collect transfer`); pending = null; }
        pending ??= { worker: String(e.worker), site: String(e.location), takes: [] };
        pending.takes.push([String(e.source_event_id), q]);
      } else if (e?.type === 'food_transfer' && e.cause === 'collect' && e.food_type === 'protein' && e.source?.kind === 'source' && piles.has(e.source.id)) {
        const site = String(e.source.id), pile = piles.get(site) as Pile, load = Number(e.portions);
        if (!pending || pending.worker !== e.recipient?.id || pending.site !== site) { err(`${c.colony_id}: ${e.recipient?.id} collected ${load} at ${site} with no matching batch take records`); pending = null; continue; }
        // the engine's own split (stored order); recomputed here, then compared with the records
        let needed = load; const want: [string, number][] = [];
        for (const b of pile) {
          const take = Math.min(b.protein, needed);
          b.protein = r6(b.protein - take); needed = r6(needed - take);
          if (take > 0) want.push([b.id, r6(take)]);
          if (needed <= 1e-6) break;
        }
        if (needed > TOL) err(`${c.colony_id}: ${pending.worker} collected ${load} at ${site}, the batches held only ${r6(load - needed)}`);
        const same = want.length === pending.takes.length && want.every(([b, q], k) => pending!.takes[k][0] === b && Math.abs(pending!.takes[k][1] - q) <= TOL);
        if (!same) err(`${c.colony_id}: ${pending.worker}'s take at ${site} recorded as ${JSON.stringify(pending.takes)}, the stored-order rule gives ${JSON.stringify(want)}`);
        pending = null;
      }
    }
    if (pending) err(`${c.colony_id}: batch takes by ${pending.worker} at ${pending.site} with no collect transfer`);
  }
  for (const [id, pile] of piles) {
    const end = endWorld?.sources?.[id]?.batches ?? [];
    if (end.length !== pile.length || end.some((b: Any, k: number) => String(b.event_id) !== pile[k].id)) { err(`${id}: batches after the day ${JSON.stringify(end.map((b: Any) => b.event_id))} ≠ rebuilt ${JSON.stringify(pile.map((b) => b.id))}`); continue; }
    end.forEach((b: Any, k: number) => {
      if (Number(b.original_day) !== pile[k].day) err(`${id}: batch ${b.event_id} birth day ${b.original_day}, expected ${pile[k].day}`);
      if (!(Math.abs(Number(b.protein) - pile[k].protein) <= TOL)) err(`${id}: batch ${b.event_id} holds ${b.protein}, rebuilt ${pile[k].protein} (protein moved between batches or changed without an event)`);
    });
  }

  // ---- 3c. records the recomputation depends on (independent review of 2d25ee8, P1/P2): the flows above are recomputed from
  //      SOURCE STATE FIELDS (capacity, production, bloom days, hosts, hemipteran colonies) and from the EVENTS of new remains
  //      and collects. A forged end state or event could otherwise carry its own justification. So:
  //      (a) a source's parameters do not change within a day except as the ecology events say;
  //      (b) every transfer touching a source carries that source's food type (sugar at honeydew/nectar, protein at carcasses);
  //      (c) every collect from a source is matched one-to-one by a food_collected of the same worker, site, food and amount;
  //      (d) new remains: a natural death's remains lie in [carcass_new_protein_min, max] and pair with one insect_natural_death;
  //          a kill's remains equal the prey size's protein and pair with one insect_predation and one prey_kill transfer;
  //      (e) each site's living insects = start − natural deaths − kills + births + immigrants (the remains have a body count);
  //      (f) a carcass batch's age_days is its day minus its birth day.
  //      Limit (stated): records that are forged CONSISTENTLY with all of these, and with the C2 colony replay, still pass —
  //      no reader can recover an event the engine never wrote; the RNG draws themselves are not re-run here.
  const evAll = [...(result?.world_events ?? []), ...(result?.colonies ?? []).flatMap((c: Any) => c.events ?? [])];
  for (const id of Object.keys(startWorld?.sources ?? {}).sort()) {
    const s0 = startWorld.sources[id], s1 = endWorld?.sources?.[id];
    if (!s1 || s0.type === 'carcass') continue;
    if (Number(s1.capacity) !== Number(s0.capacity)) err(`${id}: capacity ${s0.capacity} -> ${s1.capacity} within the day (a parameter, no event changes it)`);
    if (Number(s1.production_per_day) !== Number(s0.production_per_day) && s0.type === 'nectar') err(`${id}: production_per_day ${s0.production_per_day} -> ${s1.production_per_day} within the day`);
    if (s0.type === 'nectar') { const want = Math.max(0, Number(s0.bloom_days_left) - 1); if (Number(s1.bloom_days_left) !== want) err(`${id}: bloom_days_left ${s0.bloom_days_left} -> ${s1.bloom_days_left}, expected ${want}`); }
    if (s0.type === 'honeydew') {
      if ((s1.hemipteran_kind ?? '') !== (s0.hemipteran_kind ?? '')) err(`${id}: hemipteran_kind changed within the day`);
      const hostDeaths = evAll.filter((e: Any) => e?.type === 'host_plant_death' && e.site === id).length;
      const hosts = Number(s0.host_plants ?? 0) - hostDeaths;
      if (Number(s1.host_plants ?? 0) !== hosts) err(`${id}: host_plants ${s0.host_plants} -> ${s1.host_plants} with ${hostDeaths} host_plant_death event(s)`);
      const alive = hosts > 0 && s0.host_alive !== false;
      if ((s1.host_alive !== false) !== alive) err(`${id}: host_alive ${s1.host_alive}, the host events give ${alive}`);
      const delta = evAll.filter((e: Any) => e?.type === 'hemipteran_colony_change' && e.site === id).reduce((t: number, e: Any) => t + Number(e.delta), 0);
      const colonies = alive ? Number(s0.hemipteran_colonies ?? 0) + delta : 0;
      if (Number(s1.hemipteran_colonies ?? 0) !== colonies) err(`${id}: hemipteran_colonies ${s0.hemipteran_colonies} -> ${s1.hemipteran_colonies}, the colony-change events give ${colonies}`);
    }
  }
  const foodOf = (id: string) => (startWorld?.sources?.[id]?.type === 'carcass' ? 'protein' : 'sugar');
  for (const c of result?.colonies ?? []) {
    const collected: Any[] = (c.events ?? []).filter((e: Any) => e?.type === 'food_collected');
    const used = new Set<number>();
    for (const t of (c.events ?? []).filter((e: Any) => e?.type === 'food_transfer')) {
      for (const side of [t.source, t.recipient]) if (side?.kind === 'source' && startWorld?.sources?.[side.id] && t.food_type !== foodOf(side.id)) err(`${c.colony_id}: ${t.transfer_id ?? t.cause} moves ${t.food_type} at ${side.id}, a ${startWorld.sources[side.id].type} source`);
      if (t.cause !== 'collect' || t.source?.kind !== 'source') continue;
      const k = collected.findIndex((f: Any, i: number) => !used.has(i) && f.worker === t.recipient?.id && f.site === t.source.id && f.macro === t.food_type && Math.abs(Number(f.portions) - Number(t.portions)) <= TOL);
      if (k < 0) err(`${c.colony_id}: collect of ${t.portions} ${t.food_type} by ${t.recipient?.id} at ${t.source.id} has no matching food_collected`); else used.add(k);
    }
    collected.forEach((f: Any, i: number) => { if (!used.has(i)) err(`${c.colony_id}: food_collected by ${f.worker} at ${f.site} (${f.portions}) has no collect transfer`); });
  }
  const c = wp.carcasses, pr = wp.prey;
  const deaths = (result?.world_events ?? []).filter((e: Any) => e?.type === 'insect_natural_death');
  const preds = (result?.colonies ?? []).flatMap((x: Any) => x.events ?? []).filter((e: Any) => e?.type === 'insect_predation');
  // natural deaths re-drawn from the day's named stream (death draw, then the remains' size): the event's site, id and amount
  // must be exactly what the start state, the seed and the parameters give — an in-range forged amount is caught too
  const ins = wp.insects;
  for (const site of Object.keys(startWorld?.ecology?.insects_by_site ?? {}).sort()) {
    const pop = startWorld.ecology.insects_by_site[site], g = stream(Number(startWorld.seed), day, 'insect_demography:' + site);
    const mortality = 1 - Math.pow(1 - ins.insect_local_daily_mortality_probability, Number(pop.living) / Math.max(1, ins.insect_local_death_reference_population));
    const died = Number(pop.living) > 0 && g() < mortality;
    const got = (result?.world_events ?? []).filter((x: Any) => x?.type === 'new_food_source' && x.site === site);
    if (!died) { if (got.length) err(`${site}: natural remains ${got[0].id} although the day's draw gives no death`); continue; }
    const q = r6(c.carcass_new_protein_min + g() * (c.carcass_new_protein_max - c.carcass_new_protein_min)), id = `NAT-D${day}-${site}-${Number(pop.cumulative_deaths) + 1}`;
    if (got.length !== 1 || got[0].id !== id || Math.abs(Number(got[0].protein_portions) - q) > TOL) err(`${site}: natural remains ${JSON.stringify(got.map((x: Any) => [x.id, x.protein_portions]))}, the day's draws give [${id}, ${q}]`);
  }
  for (const e of (result?.world_events ?? []).filter((x: Any) => x?.type === 'new_food_source')) {
    const d = deaths.filter((x: Any) => x.event_id === e.id && x.site === e.site);
    if (d.length !== 1) err(`${e.site}: natural remains ${e.id} pair with ${d.length} insect_natural_death event(s)`);
    const q = Number(e.protein_portions);
    if (!(q >= c.carcass_new_protein_min - TOL && q <= c.carcass_new_protein_max + TOL)) err(`${e.site}: natural remains ${e.id} of ${q} portions, outside [${c.carcass_new_protein_min}, ${c.carcass_new_protein_max}]`);
  }
  for (const x of result?.colonies ?? []) for (const e of (x.events ?? []).filter((y: Any) => y?.type === 'new_food_source')) {
    const k = preds.filter((y: Any) => y.event_id === e.id && y.site === e.site);
    if (k.length !== 1) { err(`${e.site}: kill remains ${e.id} pair with ${k.length} insect_predation event(s)`); continue; }
    const want = k[0].size === 'large' ? pr.large_prey_protein : pr.small_prey_protein;
    if (Math.abs(Number(e.protein_portions) - want) > TOL) err(`${e.site}: kill remains ${e.id} of ${e.protein_portions} portions, a ${k[0].size} prey gives ${want}`);
    const kt = (x.events ?? []).filter((y: Any) => y?.type === 'food_transfer' && y.cause === 'prey_kill' && y.source?.id === e.id);
    if (kt.length !== 1 || Math.abs(Number(kt[0].portions) - want) > TOL) err(`${e.site}: kill ${e.id} has ${kt.length} prey_kill transfer(s) of ${kt[0]?.portions}, expected one of ${want}`);
  }
  const pops0 = startWorld?.ecology?.insects_by_site ?? {}, pops1 = endWorld?.ecology?.insects_by_site ?? {};
  for (const site of Object.keys(pops0).sort()) {
    const n = (t: string, f: (e: Any) => number) => evAll.filter((e: Any) => e?.type === t && e.site === site).reduce((a: number, e: Any) => a + f(e), 0);
    const want = Number(pops0[site].living) - n('insect_natural_death', () => 1) - n('insect_predation', () => 1) + n('insect_population_birth', (e) => Number(e.individuals)) + n('insect_immigration', (e) => Number(e.individuals));
    if (Number(pops1[site]?.living) !== want) err(`${site}: ${pops1[site]?.living} living insects after the day, the events give ${want} (remains need a body)`);
  }
  for (const [id, s1] of Object.entries(endWorld?.sources ?? {}) as [string, Any][]) if (s1.type === 'carcass') for (const b of s1.batches ?? []) {
    if (b.age_days !== undefined && b.age_days !== null && Number(b.age_days) !== day - Number(b.original_day)) err(`${id}: batch ${b.event_id} age_days ${b.age_days}, its birth day gives ${day - Number(b.original_day)}`);
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

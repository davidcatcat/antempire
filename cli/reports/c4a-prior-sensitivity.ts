/**
 * v29 first-seen begging prior: sensitivity (Owner decision D6, 2026-11-07). Report only — no parameter change, the switch
 * stays off as shipped. The prior 0.3 is a CANDIDATE (game assumption), equal to the feed threshold 0.3.
 * Same worlds for every prior: Day0 experiment colonies A1/A3/A5 × seeds 1–10, spring, C3a on for 45 days (so larvae exist
 * without C4a records), then C4a switched on with v29 off (baseline) or on with prior p ∈ PRIORS, for 30 days.
 * Reported per prior: day-1 contacts / contacts below the threshold / feedings / larval protein intake; feedings on days
 * 1–7 and 8–30; pupations by day 30; the day-14 fate of EVERY first-seen larva (still larva / pupa / eclosed / died as
 * a larva, partitioning the first-seen count) and the mean progress of the still-larva subset with its n disclosed.
 * Also re-checks D6 item 6: with v29 on, changing only the colony protein store on the switch day leaves every
 * first-seen larva's initial signal and the day-1 feeding events identical (no colony total re-enters).
 *   node cli/reports/c4a-prior-sensitivity.ts   -> reports/c4a-prior-sensitivity.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../lib/load.ts';
import { buildDay0 } from '../lib/day0.ts';
import { simulateWorldDay } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const PRIORS = [0.1, 0.2, 0.29, 0.3, 0.31, 0.4, 0.6, 0.9];
const bundle = (c4a: boolean, v29: boolean, prior: number | null): Any => {
  const b: Any = structuredClone(loadBundle()), s: Any = Object.values(b.species)[0];
  s.queen_feeding.individual_queen_body_c3a = true; s.larval_feeding.individual_larva_body_c4a = c4a; s.larval_feeding.first_seen_begging_prior_v29 = v29;
  if (prior !== null) { const p = s.local_signals.default_larva_begging_prior; if (typeof p === 'object' && p) p.value = prior; else s.local_signals.default_larva_begging_prior = prior; }
  return b;
};

export function sensitivity() {
  const pre = bundle(false, false, null), starts: { id: string; s: Any }[] = [];
  for (const f of ['A1', 'A3', 'A5']) for (let seed = 1; seed <= 10; seed++) {
    let s: Any = buildDay0(f as Any, seed, '2027-03-21', pre).state;
    for (let k = 0; k < 45; k++) s = simulateWorldDay(s, pre).state;
    if (s.colonies[0].population.brood.some((b: Any) => b.stage === 'larva')) starts.push({ id: `${f}-${seed}`, s });
  }
  const run = (b: Any) => {
    const r = { worlds: starts.length, first_seen: 0, day1_contacts: 0, day1_below_threshold: 0, day1_feedings: 0, day1_protein: 0, feedings_d1_7: 0, feedings_d8_30: 0, pupations_by_d30: 0, d14_first_seen_still_larva: 0, d14_first_seen_pupa: 0, d14_first_seen_eclosed: 0, d14_first_seen_died_as_larva: 0, d14_first_seen_pupated_share: 0, mean_progress_d14_first_seen_still_larva: 0 };
    let progSum = 0, progN = 0;
    for (const { s } of starts) {
      const first = new Set<string>(s.colonies[0].population.brood.filter((x: Any) => x.stage === 'larva').map((x: Any) => x.id)); r.first_seen += first.size;
      let w = s; const pupated = new Set<string>();
      for (let d = 1; d <= 30; d++) {
        const o: Any = simulateWorldDay(w, b), ev = o.result.colonies[0].events, feeds = ev.filter((e: Any) => e.cause === 'feed_larva');
        if (d === 1) { const c = ev.filter((e: Any) => e.type === 'larva_contact'); r.day1_contacts += c.length; r.day1_below_threshold += c.filter((e: Any) => e.begging_signal < e.feed_threshold_assumption).length; r.day1_feedings += feeds.length; r.day1_protein += feeds.filter((e: Any) => e.food_type === 'protein').reduce((q: number, e: Any) => q + e.portions, 0); }
        if (d <= 7) r.feedings_d1_7 += feeds.length; else r.feedings_d8_30 += feeds.length;
        for (const e of ev) if (e.type === 'pupation' && first.has(e.id)) pupated.add(e.id);
        r.pupations_by_d30 += ev.filter((e: Any) => e.type === 'pupation').length;
        w = o.state;
        if (d === 14) {
          // fate of EVERY first-seen larva at day 14 (the mean below is over the still-larva subset only; its n is reported)
          const now = new Map(w.colonies[0].population.brood.map((x: Any) => [x.id, x]));
          for (const id of first) {
            const x: Any = now.get(id);
            if (x?.stage === 'larva') { progSum += x.progress; progN++; r.d14_first_seen_still_larva++; }
            else if (x?.stage === 'pupa') r.d14_first_seen_pupa++;
            else if (pupated.has(id)) r.d14_first_seen_eclosed++;
            else r.d14_first_seen_died_as_larva++;
          }
        }
      }
    }
    r.day1_protein = Math.round(r.day1_protein * 1e6) / 1e6; r.mean_progress_d14_first_seen_still_larva = progN ? Math.round((progSum / progN) * 1e6) / 1e6 : (null as Any);
    if (r.d14_first_seen_still_larva + r.d14_first_seen_pupa + r.d14_first_seen_eclosed + r.d14_first_seen_died_as_larva !== r.first_seen) throw new Error('day-14 fates do not partition the first-seen larvae');
    r.d14_first_seen_pupated_share = r.first_seen ? Math.round(((r.d14_first_seen_pupa + r.d14_first_seen_eclosed) / r.first_seen) * 1e6) / 1e6 : (null as Any);
    return r;
  };
  const rows: Any[] = [{ prior: 'v29 off (legacy signal)', ...run(bundle(true, false, null)) }];
  for (const p of PRIORS) rows.push({ prior: p, ...run(bundle(true, true, p)) });
  // D6 item 6: colony protein store on the switch day must not change any first-seen larva's signal or day-1 feeding
  const on = bundle(true, true, null); let colonyLeak = 0, compared = 0;
  for (const { s } of starts) {
    const rich = structuredClone(s), poor = structuredClone(s); rich.colonies[0].stores.protein = 5; poor.colonies[0].stores.protein = 0;
    const a: Any = simulateWorldDay(rich, on), b: Any = simulateWorldDay(poor, on);
    const pick = (o: Any) => JSON.stringify(o.result.colonies[0].events.filter((e: Any) => e.type === 'brood_nutrition_record_initialized' || e.type === 'larva_contact').map((e: Any) => [e.type, e.id ?? e.larva, e.begging_signal_set ?? e.begging_signal]));
    compared++; if (pick(a) !== pick(b)) colonyLeak++;
  }
  return { schema: 'antempire.c4a-prior-sensitivity.v2', note: 'Report only (Owner D6): the prior is a candidate game assumption, not a species measurement; the feed threshold is 0.3 (game assumption). Not tuned.', threshold: 0.3, rows, colony_store_counterfactual: { worlds: compared, worlds_where_initial_signal_or_day1_contact_changed: colonyLeak } };
}

if (import.meta.main) {
  const out = sensitivity();
  fs.writeFileSync(path.join(REPO_ROOT, 'reports', 'c4a-prior-sensitivity.json'), JSON.stringify(out, null, 1) + '\n');
  console.table(out.rows); console.log(out.colony_store_counterfactual);
}

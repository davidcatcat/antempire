/**
 * v2-review.31 (Owner D5 items 6–7) diagnostic, REPORT ONLY: nurse numbers, nurse–larva contacts and protein reaching larvae
 * on Day0 experiment worlds (NOT the official world), with C3a + C4a on and the nurse-cue locality switch off and on.
 * Foundings A1, A3, A5 × spring / autumn × seeds 1–5 × 60 days, both arms on the same seeds (no seed selection). Every number
 * is a model output under game assumptions; none is a target and no parameter is chosen from it (CLAUDE.md §7).
 * Usage: node cli/reports/nurse-cue-v31-diagnostics.ts [outDir]   (default reports/nurse-cue-v31-diagnostics)
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDay0 } from '../lib/day0.ts';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { ENGINE_VERSION, simulateWorldDay } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const FOUNDINGS = ['A1', 'A3', 'A5'], SEASONS = { spring: '2027-03-21', autumn: '2027-09-23' } as Record<string, string>, SEEDS = [1, 2, 3, 4, 5], DAYS = 60;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6, ratio = (a: number, b: number) => (b > 0 ? r6(a / b) : null);
const PROTEIN_FLOWS = ['collect', 'prey_kill', 'unload', 'take_from_cache', 'feed_queen', 'return_to_cache', 'feed_larva', 'storage_overflow'];

function run(founding: string, season: string, seed: number, on: boolean): Any {
  const b: Any = structuredClone(loadBundle()), sp = b.species[Object.keys(b.species)[0]];
  sp.queen_feeding.individual_queen_body_c3a = true; sp.larval_feeding.individual_larva_body_c4a = true; sp.local_signals.nurse_cue_same_place_v31 = on;
  const threshold = sp.larval_feeding.feed_begging_threshold.value;
  let s: Any = buildDay0(founding as Any, seed, SEASONS[season], b).state;
  const t = { days: 0, days_with_no_nurse: 0, days_with_larvae: 0, days_with_larvae_and_no_nurse_in_nest: 0, nurse_task_days: 0, nurse_days_in_nest: 0, nurse_days_outside_nest: 0, nurse_days_not_alive_at_day_end: 0, larva_days: 0, cue_contacts: 0, feeding_contacts: 0, feeding_contacts_eligible: 0, larva_days_no_feeding_contact: 0, larva_days_no_cue_contact: 0, larva_days_no_contact_at_all: 0, larva_days_protein_fed: 0, larva_protein_need: 0, larva_protein_intake: 0, feed_larva_protein_events: 0, protein: Object.fromEntries(PROTEIN_FLOWS.map((k) => [k, 0])) as Record<string, number>, workers_end: 0, larvae_end: 0 };
  for (let d = 0; d < DAYS; d++) {
    const o: Any = simulateWorldDay(s, b), c = o.result.colonies[0], ev: Any[] = c.events, nest = s.colonies[0].nest_node;
    const before = new Map(s.colonies[0].population.workers.map((w: Any) => [w.id, w.last_location]));
    const nurses = o.state.colonies[0].population.workers.filter((w: Any) => w.task === 'nurse' && before.has(w.id));
    const inNest = nurses.filter((w: Any) => before.get(w.id) === nest).length;
    t.days++; t.nurse_task_days += c.summary.tasks?.nurse ?? 0; t.nurse_days_in_nest += inNest; t.nurse_days_outside_nest += nurses.length - inNest; t.nurse_days_not_alive_at_day_end += (c.summary.tasks?.nurse ?? 0) - nurses.length;
    if (!(c.summary.tasks?.nurse > 0)) t.days_with_no_nurse++;
    const lar = ev.filter((e) => e.type === 'larva_nutrition'), fedIds = new Set(ev.filter((e) => e.type === 'larva_contact').map((e) => e.larva)), cueIds = new Set(ev.filter((e) => e.type === 'local_brood_begging_contact').map((e) => e.larva));
    if (lar.length) { t.days_with_larvae++; if (inNest === 0) t.days_with_larvae_and_no_nurse_in_nest++; }
    t.larva_days += lar.length;
    for (const e of lar) {
      t.larva_protein_need += e.need_portions.protein; t.larva_protein_intake += e.intake_portions.protein;
      if (e.intake_portions.protein > 0) t.larva_days_protein_fed++;
      if (!fedIds.has(e.larva)) t.larva_days_no_feeding_contact++;
      if (!cueIds.has(e.larva)) t.larva_days_no_cue_contact++;
      if (!fedIds.has(e.larva) && !cueIds.has(e.larva)) t.larva_days_no_contact_at_all++;
    }
    for (const e of ev) {
      if (e.type === 'local_brood_begging_contact') t.cue_contacts++;
      if (e.type === 'larva_contact') { t.feeding_contacts++; if (e.begging_signal >= threshold) t.feeding_contacts_eligible++; }
      if (e.type === 'food_transfer' && e.food_type === 'protein' && e.cause in t.protein) { t.protein[e.cause] += e.portions; if (e.cause === 'feed_larva') t.feed_larva_protein_events++; }
    }
    s = o.state;
  }
  t.workers_end = s.colonies[0].population.workers.length; t.larvae_end = s.colonies[0].population.brood.filter((x: Any) => x.stage === 'larva').length;
  for (const k of Object.keys(t.protein)) t.protein[k] = r6(t.protein[k]);
  t.larva_protein_need = r6(t.larva_protein_need); t.larva_protein_intake = r6(t.larva_protein_intake);
  return t;
}

function derived(t: Any): Any {
  return {
    mean_nurses_per_day: ratio(t.nurse_task_days, t.days), mean_nurses_in_nest_per_day: ratio(t.nurse_days_in_nest, t.days), share_of_nurse_days_outside_nest: ratio(t.nurse_days_outside_nest, t.nurse_task_days),
    cue_contacts_per_larva_day: ratio(t.cue_contacts, t.larva_days), feeding_contacts_per_larva_day: ratio(t.feeding_contacts, t.larva_days),
    share_larva_days_no_feeding_contact: ratio(t.larva_days_no_feeding_contact, t.larva_days), share_larva_days_no_cue_contact: ratio(t.larva_days_no_cue_contact, t.larva_days), share_larva_days_no_contact_at_all: ratio(t.larva_days_no_contact_at_all, t.larva_days),
    share_larva_days_with_protein: ratio(t.larva_days_protein_fed, t.larva_days), larval_protein_intake_over_need: ratio(t.larva_protein_intake, t.larva_protein_need),
    share_feeding_contacts_with_protein: ratio(t.feed_larva_protein_events, t.feeding_contacts), share_feeding_contacts_eligible: ratio(t.feeding_contacts_eligible, t.feeding_contacts),
    protein_to_larvae_over_protein_collected: ratio(t.protein.feed_larva, t.protein.collect + t.protein.prey_kill),
    share_days_with_larvae_but_no_nurse_in_nest: ratio(t.days_with_larvae_and_no_nurse_in_nest, t.days_with_larvae),
  };
}

export function generateNurseCueDiagnostics(outDir: string): Any {
  const rows: Any[] = [];
  for (const founding of FOUNDINGS) for (const season of Object.keys(SEASONS)) for (const seed of SEEDS) for (const on of [false, true]) {
    const t = run(founding, season, seed, on); rows.push({ founding, season, seed, switch_on: on, totals: t, derived: derived(t) });
  }
  const pool = (pred: (r: Any) => boolean) => {
    const sel = rows.filter(pred), sum: Any = {};
    for (const r of sel) for (const [k, v] of Object.entries(r.totals)) { if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v; else { sum[k] ??= {}; for (const [k2, v2] of Object.entries(v as Any)) sum[k][k2] = r6((sum[k][k2] ?? 0) + (v2 as number)); } }
    return { runs: sel.length, totals: sum, derived: derived(sum) };
  };
  const pooled: Any = {};
  for (const on of [false, true]) { pooled[on ? 'on' : 'off'] = pool((r) => r.switch_on === on); for (const f of FOUNDINGS) pooled[`${on ? 'on' : 'off'}_${f}`] = pool((r) => r.switch_on === on && r.founding === f); }
  const pairsDiffering = FOUNDINGS.flatMap((f) => Object.keys(SEASONS).flatMap((se) => SEEDS.map((sd) => { const a = rows.find((r) => r.founding === f && r.season === se && r.seed === sd && !r.switch_on), b = rows.find((r) => r.founding === f && r.season === se && r.seed === sd && r.switch_on); return JSON.stringify(a.totals) !== JSON.stringify(b.totals); }))).filter(Boolean).length;
  const doc = { schema: 'antempire.nurse-cue-v31-diagnostics.v1', engine_version: ENGINE_VERSION, official: false, design: { foundings: FOUNDINGS, seasons: SEASONS, seeds: SEEDS, days: DAYS, switches: 'queen_feeding.individual_queen_body_c3a = true, larval_feeding.individual_larva_body_c4a = true, local_signals.nurse_cue_same_place_v31 = off / on', note: 'Day0 experiment worlds, report only; model outputs under game assumptions, not field values, not targets (CLAUDE.md §7)' }, definitions: { larva_day: 'one larva_nutrition record (a larva with a C4a account on one day)', cue_contact: 'local_brood_begging_contact (task-allocation begging cue, workers.ts nurseContact)', feeding_contact: 'larva_contact (C4a nest round, the only route by which food reaches a larva)', nurse_in_nest: "worker with task 'nurse' (alive at the end of the day) whose last_location at the start of the day is the nest node" }, runs_whose_totals_differ_off_vs_on: pairsDiffering, pooled, rows };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'diagnostics.json'), JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

if (import.meta.main) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, 'reports/nurse-cue-v31-diagnostics');
  const doc = generateNurseCueDiagnostics(outDir);
  console.log(JSON.stringify({ runs_whose_totals_differ_off_vs_on: doc.runs_whose_totals_differ_off_vs_on, off: doc.pooled.off, on: doc.pooled.on }, null, 2));
}

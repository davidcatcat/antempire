/**
 * Conservation checks on the two authoritative save documents (saves/main.json, saves/world-state.json).
 * Used by `npm run check:saves` (CI) and by `npm run advance` before anything is written.
 *
 * level 'error'   -> the advance command refuses to write; CI fails.
 * level 'warning' -> reported, not blocking (documented known limitations, see PR notes).
 */
export interface Check { name: string; ok: boolean; level: 'error' | 'warning'; detail?: unknown }
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const EPS = 2e-5;
const r6 = (x: number) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;

export function checkSaves(main: Any, world: Any): Check[] {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail?: unknown, level: Check['level'] = 'error') => out.push({ name, ok: !!ok, level, ...(detail === undefined ? {} : { detail }) });
  const day = main.simulation?.latest_completed_day, clock = world.time?.scientific_clock;
  add('clock: main and world on the same completed day', day === clock?.day, { main: day, world: clock?.day });
  add('clock: elapsed hours = 24 × day (main and world)', main.simulation?.elapsed_sim_hours === 24 * day && clock?.elapsed_sim_hours === 24 * day, { main: main.simulation?.elapsed_sim_hours, world: clock?.elapsed_sim_hours });

  // Workers
  const individuals: Any[] = main.colony.workers.individuals, alive = individuals.filter((w) => w.status === 'alive');
  const ids = individuals.map((w) => w.id);
  add('workers: individual IDs unique', new Set(ids).size === ids.length);
  add('workers: current_alive = alive individuals', main.colony.workers.current_alive === alive.length, { current_alive: main.colony.workers.current_alive, alive_individuals: alive.length });
  add('workers: world ant_population.workers_alive = main', world.ant_population?.workers_alive === alive.length, { world: world.ant_population?.workers_alive, main: alive.length });
  const demo = main.colony.population_demography;
  add('workers: demography explicit IDs = alive individuals', JSON.stringify([...(demo?.explicit_worker_ids ?? [])].sort()) === JSON.stringify(alive.map((w) => w.id).sort()));
  const sl = demo?.stage_ledger;
  if (sl) add('workers: stage ledger workers_after = before + eclosions − deaths', sl.workers_after === sl.workers_before + sl.worker_eclosions - sl.worker_deaths + (sl.worker_immigrants ?? 0) - (sl.worker_emigrants ?? 0), sl);
  add('workers: confirmed_born − cumulative_deaths = current_alive', main.colony.workers.confirmed_born - main.colony.workers.cumulative_deaths === main.colony.workers.current_alive, { confirmed_born: main.colony.workers.confirmed_born, cumulative_deaths: main.colony.workers.cumulative_deaths, current_alive: main.colony.workers.current_alive });
  if (typeof main.colony.worker_deaths_cumulative === 'number') add('workers: colony.worker_deaths_cumulative = workers.cumulative_deaths', main.colony.worker_deaths_cumulative === main.colony.workers.cumulative_deaths, { worker_deaths_cumulative: main.colony.worker_deaths_cumulative, cumulative_deaths: main.colony.workers.cumulative_deaths });

  // Brood
  const brood: Any[] = main.colony.brood.individuals.filter((b: Any) => b.living), count = (st: string) => brood.filter((b) => b.stage === st).length;
  const b = main.colony.brood;
  add('brood: stage counts = living individuals', b.eggs === count('egg') && b.larvae === count('larva') && b.pupae === count('pupa'), { eggs: [b.eggs, count('egg')], larvae: [b.larvae, count('larva')], pupae: [b.pupae, count('pupa')] });
  add('brood: total = eggs + larvae + pupae', b.total === b.eggs + b.larvae + b.pupae, { total: b.total });
  const wb = world.ant_population?.brood;
  add('brood: world ant_population.brood = main', wb?.eggs === b.eggs && wb?.larvae === b.larvae && wb?.pupae === b.pupae, { world: wb });
  const bids = main.colony.brood.individuals.map((x: Any) => x.id);
  add('brood: IDs unique and distinct from workers', new Set(bids).size === bids.length && !bids.some((id: string) => ids.includes(id)));
  if (sl?.brood_before && sl?.brood_after && sl?.flux) {
    // Day≤14 ledgers store per-stage objects; the v6 save mapping (Day15+) stores brood_before as a total.
    const total = (x: Any) => typeof x === 'number' ? x : (x.eggs ?? 0) + (x.larvae ?? 0) + (x.prepupae ?? 0) + (x.pupae ?? 0);
    const before = total(sl.brood_before), after = total(sl.brood_after);
    add('brood: stage ledger after = before + laid − eclosed − deaths', after === before + sl.flux.eggs_laid - sl.flux.pupae_eclosed - sl.flux.brood_deaths, { before, after, flux: sl.flux });
  }

  // Engine state (exists from Day15 on)
  const s = world.sim_engine_v2;
  if (!s) {
    add('engine: no sim_engine_v2 yet (Day ≤ 14); sugar/protein portion ledger starts at the Day15 migration', day <= 14, { day });
    return out;
  }
  add('engine: engine day = completed day', s.sim_day === day, { engine: s.sim_day, main: day });
  add('engine: workers = main alive workers (same IDs)', JSON.stringify(s.population.workers.map((w: Any) => w.id).sort()) === JSON.stringify(alive.map((w) => w.id).sort()));
  add('engine: brood = main living brood (same IDs and stages)', JSON.stringify(s.population.brood.map((x: Any) => x.id + ':' + x.stage).sort()) === JSON.stringify(brood.map((x) => x.id + ':' + x.stage).sort()));
  add('engine: queen alive = main queen count', (s.population.queen_alive ? 1 : 0) === main.colony.queen.count, { engine: s.population.queen_alive, main: main.colony.queen.count });
  for (const k of ['sugar', 'protein']) add(`food: ${k} store finite and ≥ 0`, Number.isFinite(s.colony[k]) && s.colony[k] >= 0, s.colony[k]);
  const crops = s.population.workers.reduce((a: number, w: Any) => a + (w.crop_cargo_sugar || 0), 0);
  add('food: sugar held in crops ⊆ sugar ledger (not extra mass)', crops <= s.colony.sugar + 1e-4, { crops: r6(crops), ledger: s.colony.sugar });
  const ledger = world.day_log_latest?.food;
  if (ledger?.start) {
    for (const k of ['sugar', 'protein']) {
      const rhs = r6(ledger.start[k] + ledger.foraged[k] - ledger.metabolized[k] - ledger.egg_laying[k] - ledger.storage_overflow_not_retained[k]);
      add(`food: ${k} start + foraged − metabolized − eggs − overflow = end stock`, Math.abs(rhs - s.colony[k]) <= EPS, { start: ledger.start[k], foraged: ledger.foraged[k], metabolized: ledger.metabolized[k], eggs: ledger.egg_laying[k], overflow: ledger.storage_overflow_not_retained[k], expected_end: rhs, end_stock: s.colony[k] });
    }
  } else add('food: latest day ledger present', false, 'world.day_log_latest.food missing');
  add('food: main and world copies of the latest ledger identical', JSON.stringify(main.colony.food?.v2_latest_ledger) === JSON.stringify(world.resources?.v2_latest_ledger));
  for (const src of Object.values<Any>(s.sources)) {
    if (src.type === 'carcass') add(`source ${src.id}: carcass protein = Σ batches`, Math.abs(src.protein - src.batches.reduce((a: number, x: Any) => a + x.protein, 0)) <= 1e-4);
    add(`source ${src.id}: non-negative`, (src.sugar || 0) >= 0 && (src.protein || 0) >= 0);
  }
  return out;
}

/**
 * Day-over-day checks for one advance. `expectedStart` is the nest ledger the day must start from:
 * yesterday's engine stores, or the Day15 migration starting stores.
 */
export function checkTransition(before: { main: Any; world: Any }, after: { main: Any; world: Any }, report: Any, expectedStart: { sugar: number; protein: number }): Check[] {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail?: unknown) => out.push({ name, ok: !!ok, level: 'error', ...(detail === undefined ? {} : { detail }) });
  const d0 = before.main.simulation.latest_completed_day, d1 = after.main.simulation.latest_completed_day, r = report.summary;
  add('transition: exactly one day advanced', d1 === d0 + 1 && report.day === d1 && after.world.time.scientific_clock.day === d1, { before: d0, after: d1 });
  const aliveBefore = before.main.colony.workers.individuals.filter((w: Any) => w.status === 'alive').length;
  add('transition: workers after = before + eclosions − deaths', r.workers_before === aliveBefore && r.population.workers === aliveBefore + r.eclosions - r.worker_deaths, { before: aliveBefore, eclosions: r.eclosions, deaths: r.worker_deaths, after: r.population.workers });
  const broodBefore = before.main.colony.brood.individuals.filter((b: Any) => b.living).length, broodAfter = r.population.eggs + r.population.larvae + r.population.pupae;
  add('transition: brood after = before + laid − eclosed − deaths', r.brood_before === broodBefore && broodAfter === broodBefore + r.eggs_laid - r.eclosions - r.brood_deaths, { before: broodBefore, laid: r.eggs_laid, eclosed: r.eclosions, deaths: r.brood_deaths, after: broodAfter });
  for (const k of ['sugar', 'protein'] as const) add(`transition: ${k} ledger starts from the previous stock`, Math.abs(r.mass_ledger.start[k] - expectedStart[k]) <= EPS, { expected: expectedStart[k], start: r.mass_ledger.start[k] });
  const cw0 = before.main.colony, cw1 = after.main.colony;
  add('transition: confirmed_born += eclosions, cumulative_deaths += worker deaths', cw1.workers.confirmed_born === cw0.workers.confirmed_born + r.eclosions && cw1.workers.cumulative_deaths === cw0.workers.cumulative_deaths + r.worker_deaths, { born: [cw0.workers.confirmed_born, cw1.workers.confirmed_born], deaths: [cw0.workers.cumulative_deaths, cw1.workers.cumulative_deaths], eclosions: r.eclosions, worker_deaths: r.worker_deaths });
  if (typeof cw0.brood_deaths_cumulative === 'number') add('transition: brood_deaths_cumulative += brood deaths', cw1.brood_deaths_cumulative === cw0.brood_deaths_cumulative + r.brood_deaths, { before: cw0.brood_deaths_cumulative, after: cw1.brood_deaths_cumulative, brood_deaths: r.brood_deaths });
  const deadBefore = new Set(before.main.colony.workers.individuals.filter((w: Any) => w.status !== 'alive').map((w: Any) => w.id));
  add('transition: no dead worker revived', after.main.colony.workers.individuals.every((w: Any) => !(deadBefore.has(w.id) && w.status === 'alive')));
  const keptBefore = before.main.colony.workers.individuals.map((w: Any) => w.id), keptAfter = new Set(after.main.colony.workers.individuals.map((w: Any) => w.id));
  add('transition: no worker record removed from history', keptBefore.every((id: string) => keptAfter.has(id)));
  return out;
}

/** The journal prepared for a day must describe exactly the saved day (written together, never apart). */
export function checkJournal(after: { main: Any }, report: Any, journalRel: string, journalText: string): Check[] {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail?: unknown) => out.push({ name, ok: !!ok, level: 'error', ...(detail === undefined ? {} : { detail }) });
  const day = report.day, r = report.summary, expectedRel = `journal/v2-day-${String(day).padStart(4, '0')}.md`;
  add('journal: path is journal/v2-day-NNNN.md of the new day', journalRel === expectedRel && after.main.simulation.latest_journal === expectedRel, { journal: journalRel, latest_journal: after.main.simulation.latest_journal, expected: expectedRel });
  add('journal: headed with the same day and date', journalText.startsWith(`# 🐜《螞蟻帝國》Day ${day}｜${r.date}`), journalText.split('\n')[0]);
  const pop = r.population;
  add('journal: population table matches the saved day', [`| 蟻后 | ${pop.queen} |`, `| 工蟻 | ${pop.workers}（`, `| 卵 | ${pop.eggs} |`, `| 幼蟲 | ${pop.larvae} |`, `| 蛹 | ${pop.pupae} |`].every((x) => journalText.includes(x)));
  add('journal: food table matches the saved ledger', journalText.includes(`| 糖 | ${r.income.sugar} | ${r.consumed.sugar} | ${r.stock.sugar} |`) && journalText.includes(`| 蛋白 | ${r.income.protein} | ${r.consumed.protein} | ${r.stock.protein} |`));
  const listed = journalText.split('\n').filter((l) => l.startsWith('- {"type":')).length;
  add('journal: every engine event recorded (one line each)', listed === report.events.length, { journal_lines: listed, events: report.events.length });
  return out;
}

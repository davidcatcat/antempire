/**
 * Demo 2 — D2E-2 (docs/demo2-engine-gap.md): the individual card built from ONE worker's own engine record.
 * BLOCKING. NON-OFFICIAL experiment world; nothing here changes one.
 *  1. reconciliation: the page's per-individual event history (web/src/demo2/record.ts OwnHistory) equals an independent
 *     replay of the core's log (tests/lib/demo2-replay.ts replayOwn) for every worker and larva, 3 seeds × 12 h, any
 *     chunking; food given by foragers = food received by nestmates (µP, exact);
 *  2. the card shows the Worker's record of that worker as it is (contacts, begging signals, crop, hunger diagnostics,
 *     traits) at the same instant — value by value against antView;
 *  3. LOCALITY (CLAUDE.md §2.1, §2.4): the card of worker X is a function of X's frame entry, X's own record and the
 *     events X took part in — removing every event X is not part of, or changing any other worker, changes nothing;
 *     the "why" text names only the worker's own inputs; the card states what the ant does not know; the module reads
 *     no source stock, no colony total and no other worker;
 *  4. every worker state gets an explanation; an empty-handed return is said plainly (not hidden);
 *  5. no record (the idle tour selected the worker) → the card says so and still shows the page-received events;
 *     a record of another worker / kind is refused;
 *  6. observation cannot change the world (#144): asking for records at every step leaves the payload hash and the
 *     event chain identical; main.ts asks only through the existing `follow` command, never from the tour;
 *  7. hunger diagnostics are labelled as diagnostics, with no death wording.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import type { EventMsg, P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { clockOf } from '../web/src/v62-model.ts';
import { NOT_KNOWN, OWN_MAX, OwnHistory, asWorkerRecord, larvaRecordView, recordHtml, workerRecordView } from '../web/src/demo2/record.ts';
import { replayLines, replayOwn } from './lib/demo2-replay.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const frameOf = (w: P0a2ExperimentWorld) => w.frame() as unknown as P0a2FrameMsg;
const run = (seed: number, T: number, chunk: number) => { const { world, events } = P0a2ExperimentWorld.create('exp-demo2-record', seed), H = new OwnHistory(), all: EventMsg[] = [...(events as unknown as EventMsg[])]; H.onEvents(all); for (let t = 0; t < T;) { t = Math.min(T, t + chunk); const ev = world.advanceTo(t).events as unknown as EventMsg[]; H.onEvents(ev); all.push(...ev); } return { world, H, all }; };
const summary: Record<string, unknown> = {};

// 1. reconciliation per individual
for (const seed of [20261113, 1, 7]) {
  const T = 12 * 3600, a = run(seed, T, 47), b = run(seed, T, T), rep = replayOwn(replayLines(seed, T * 1000));
  let gave = 0, got = 0, fed = 0, larvaFed = 0;
  for (const id of a.world.antIds()) {
    assert.deepEqual(a.H.totalsOf(id), rep.workers[id] ?? a.H.totalsOf('none'), `seed ${seed} ${id}: own totals == replay`); assert.deepEqual(b.H.totalsOf(id), a.H.totalsOf(id)); checks += 2;
    const x = a.H.totalsOf(id); gave += x.gave_up; got += x.got_up; fed += x.fed_up;
    ok(a.H.lastOf(id).length <= OWN_MAX && a.H.lastOf(id).every((e, i, arr) => i === 0 || e.seq >= arr[i - 1].seq), `${id}: the listed own events are the latest, in order`);
  }
  for (const [id, r] of Object.entries(rep.larvae)) { const L = a.H.larvaOf(id)!; ok(L.touched === r.touched && L.touched_idle === r.touched_idle && L.fed === r.fed && L.fed_up === r.fed_up, `seed ${seed} ${id}: larva totals == replay`); larvaFed += L.fed_up; }
  ok(gave === got && gave > 0 && fed === larvaFed && fed > 0, `seed ${seed}: food given by foragers = food received by nestmates (${gave} µP); food fed = food larvae received (${fed} µP)`);
  ok(Object.keys(rep.workers).every((id) => a.world.antIds().includes(id)), 'the replay names no worker the world does not have');
  const t = [...a.H.totals.values()].reduce((s, x) => ({ exits: s.exits + x.exits, empties: s.empties + x.empties, takes: s.takes + x.takes }), { exits: 0, empties: 0, takes: 0 });
  summary[`seed_${seed}`] = { hours: 12, workers: a.world.antIds().length, ...t, given_uP: gave, fed_uP: fed };
}

// 2–5. the card
{
  const seed = 1, { world, H, all } = run(seed, 10 * 3600, 60), seen = new Set<string>();
  let emptySaid = 0, withContacts = 0;
  for (let step = 0; step < 240; step++) {
    const ev = world.advanceTo(world.tSim() + 30).events as unknown as EventMsg[]; H.onEvents(ev); all.push(...ev);
    const f = frameOf(world);
    for (const w of f.workers) {
      const raw = world.antView(w.id), rec = asWorkerRecord(raw, w.id)!; if (!rec) ok(false, `${w.id}: the Worker's record is a worker record`);
      const v = workerRecordView(w, rec, H, clockOf), html = recordHtml(v, 'MISSING');
      seen.add(w.state);
      if (!(v.available && v.why.length > 0 && !v.why.some((x) => x.includes('沒有這個狀態')))) ok(false, `${w.id} in ${w.state}: has an explanation`);
      // value by value against the Worker's record at the same instant
      const flat = v.sections.flatMap((s) => s.rows.map((r) => `${r.label}=${r.value}`)).join('|');
      if (!(flat.includes(`紀錄中的接觸=${rec.contacts.length} 筆（其中來自滿載回巢者 ${rec.contacts.filter((c) => c.loaded).length} 筆）`) && flat.includes(`紀錄中的幼蟲接觸=${rec.begging.length} 筆`) && flat.includes(`嗉囊=${(w.crop_fill * 100).toFixed(0)}%`) && flat.includes(`覓食門檻=${rec.theta_forage.toFixed(2)}`) && flat.includes(`連續到場是空的=${rec.empty_streak} 次`) && flat.includes(`路線記憶=${rec.route ? '有' : '沒有'}`))) ok(false, `${w.id}: the card repeats the Worker's record (${flat.slice(0, 200)})`);
      if (rec.contacts.length) { withContacts++; const c = rec.contacts[rec.contacts.length - 1], line = v.sections[0].list![0]; if (!(line.includes(c.from) && line.startsWith(clockOf(c.t / 1000)))) ok(false, `${w.id}: the newest contact is listed first with its partner and instant`); }
      if (rec.begging.length) { const b = rec.begging[rec.begging.length - 1], line = v.sections[1].list![0]; if (!(line.includes(b.larva) && line.includes(b.signal.toFixed(2)))) ok(false, `${w.id}: the newest larva contact is listed with the signal the worker perceived`); }
      if (Math.abs(rec.physiology_at_s - f.t_sim) > 1e-9) ok(false, 'the record is projected to the frame instant');
      if (w.state === 'returning' && H.lastOf(w.id).slice().reverse().find((e) => ['take', 'empty', 'heat', 'search_failed'].includes(e.kind))?.kind === 'empty') { emptySaid++; if (!v.why.join('').includes('空手回巢')) ok(false, `${w.id}: an empty-handed return is said plainly`); }
      // LOCALITY: only events this worker is part of matter; other workers' frame entries are not even an input
      if (step % 40 === 0) {
        const mine = new OwnHistory(); mine.onEvents(all.filter((e) => e.entity === w.id || JSON.stringify(e.data).includes(`"${w.id}"`)));
        if (JSON.stringify(workerRecordView(w, rec, mine, clockOf)) !== JSON.stringify(v)) ok(false, `${w.id}: the card depends only on events this worker took part in`);
        if (/全巢(存糧|庫存|缺口)|其他工蟻的嗉囊|colony/.test(v.why.join('')) || !html.includes(NOT_KNOWN)) ok(false, `${w.id}: the explanation uses no colony-level quantity and states what the ant does not know`);
        if (/死亡|餓死|死了/.test(html.replace('引擎沒有死亡模型：沒有個體會因此死亡', '').replace('也不是死亡', ''))) ok(false, 'no death wording beyond the statement that no death is modelled');
      }
    }
    checks += f.workers.length;
  }
  ok(['resting', 'idle', 'brood_care', 'to_entrance', 'outbound', 'feeding', 'returning'].every((s) => seen.has(s)), `the states met over 2 h all have their own explanation (${[...seen].join(', ')})`);
  ok(emptySaid > 50 && withContacts > 100, `empty-handed returns were explained ${emptySaid} times; ${withContacts} cards listed contacts`);
  // 5. no record
  const f = frameOf(world), w = f.workers[0], none = workerRecordView(w, null, H, clockOf), html = recordHtml(none, '沒有讀取牠的個體紀錄');
  ok(!none.available && html.includes('沒有讀取牠的個體紀錄') && none.sections.length === 1 && none.sections[0].title.includes('本頁開啟後') && none.why.length > 0 && !html.includes('覓食門檻'), 'without the Worker record the card says so and shows only the page-received events (no invented values)');
  ok(asWorkerRecord(world.antView(f.workers[1].id), w.id) === null && asWorkerRecord({ kind: 'queen', id: w.id }, w.id) === null && asWorkerRecord(null, w.id) === null && asWorkerRecord({ ...(world.antView(w.id) as object), crop: 'x' }, w.id) === null, 'a record of another worker, another kind, or a malformed one is refused');
  // larva card
  const lv = f.larvae[0], L = larvaRecordView(lv.id, lv.gut_fill, H, clockOf), lh = recordHtml(L, '');
  ok(lh.includes(`${(lv.gut_fill * 100).toFixed(0)}%`) && lh.includes((1 - lv.gut_fill).toFixed(2)) && lh.includes('只有碰到牠的工蟻感知得到') && !/發育|化蛹|羽化/.test(lh), 'larva card: its gut, its signal, carers\' contacts; nothing about development');
  ok(recordHtml({ available: true, why: ['<b>x</b>'], not_known: '', sections: [] }, '').includes('&lt;b&gt;x&lt;/b&gt;'), 'record text is escaped');
}

// 6. observation cannot change the world (#144)
{
  const a = P0a2ExperimentWorld.create('exp-demo2-record', 7).world, b = P0a2ExperimentWorld.create('exp-demo2-record', 7).world, ids = a.antIds();
  for (let s = 120, i = 0; s <= 3 * 3600; s += 120, i++) { a.advanceTo(s); b.advanceTo(s); a.antView(ids[i % ids.length]); a.antView(ids[(i * 7) % ids.length]); a.frame(); }
  ok(a.snapshot().payload_sha256 === b.snapshot().payload_sha256 && JSON.stringify(a.chainState()) === JSON.stringify(b.chainState()), 'a world whose workers\' records were read at every step is identical to one never observed (payload hash, event chain)');
  const src = read('web/src/demo2/record.ts'), imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  ok(imports.length === 1 && imports[0] === '../experimental/worker-protocol.ts' && !/^import \{/m.test(src), 'record.ts imports only the protocol TYPES');
  ok(!/stock_portions|\.source\b|frame\.workers|colony\.|Math\.random|Date\.now|performance\.|postMessage|localStorage|indexedDB|p0a2-24h/.test(src), 'record.ts reads no source stock, no colony roster, no other worker, no clock, no storage');
  const main = read('web/src/demo2/main.ts'), follows = [...main.matchAll(/client\.follow\(/g)].length;
  ok(follows === 1 && /function observe\(id: string \| null\) \{ if \(observed === id\) return; observed = id; void client\.follow\(id\)/.test(main), 'main.ts asks for a record in ONE place (observe), through the existing follow command, only when the target changes');
  ok(/if \(!byTour\) observe\(/.test(main) && !/byTour\) \{[^}]*observe\(/.test(main.replace(/if \(!byTour\) observe\(/g, '')), 'the idle camera tour never asks the Worker for a record');
  ok(/ownHist\.onEvents\(evs\)/.test(main) && /ownHist\.reset\(\)/.test(main), 'main.ts feeds every event batch to the per-individual history and resets it with the world');
}

console.log(JSON.stringify({ test: 'web-demo2-record', checks, ...summary }));

/**
 * R2 acceptance matrix (docs/r2-acceptance-matrix.json) — validator and generator. Documentation tooling only: it
 * reads repository files, never imports engine/ or web/, never runs a simulation and never writes saves/ or journal/.
 *
 *   node cli/r2-matrix.ts            validate; print a JSON summary (exit 1 on any error)
 *   node cli/r2-matrix.ts --write    validate, then regenerate the generated blocks in docs/r2-go-no-go.md and
 *                                    docs/r2-day0-official-spec.md (between the r2-matrix:* markers)
 *   node cli/r2-matrix.ts --check    validate and fail if those generated blocks are out of date
 *
 * What the validator enforces (Owner #201 condition 5; the matrix must be honest, not decorative):
 *  - every row has an id, a module, a status in {已接入, 簡化代理, 未接入}, a boolean blocks_r2 and a non-empty reason;
 *  - every required module appears exactly once; every R2 condition 1–6 is covered by at least one row;
 *  - every evidence reference ID exists in docs/references.md; every referenced test / asset path exists;
 *    every *.test.ts is registered in tests/run-all.ts BLOCKING; every browser check is run by .github/workflows/ci.yml;
 *  - a row that claims 已接入 lists at least one test (all of which exist) and its wiring probe is FOUND in the
 *    candidate-world sources; a 簡化代理 row's probe is found too and its limits state the approximation range
 *    (「近似範圍」, condition 3); a 未接入 row's probe, if given, is ABSENT from the candidate-world sources (so wiring a
 *    mechanism without updating the matrix fails);
 *  - a 未接入 probe may list extra texts (probe.any); a hit of ANY of them in the candidate world fails the row;
 *  - assumption flags: a row whose basis includes a non-measured class is flagged assumption:true;
 *  - owner decision codes exist; the verdict is NO-GO iff some row blocks R2.
 * Owner ruling #212 Q2 a (2026-11-13): completeness may be relaxed (an unwired mechanism need not block), but
 *  - every 未接入 row (except the documentation / verification modules in disclosure_exempt_modules) declares in
 *    player_view that the viewer shows 「尚未模擬」, and the generated 「尚未模擬／簡化代理」 list (block not-simulated)
 *    is quoted verbatim in docs/r2-go-no-go.md and docs/r2-day0-official-spec.md;
 *  - conservation, determinism, save recovery, life-state correctness and observation honesty are NOT relaxed: a row
 *    of a module in non_relaxable_modules (which must contain NON_RELAXABLE_MIN) blocks R2 unless it is 已接入;
 *  - the disclosure row (module not_simulated_disclosure: the list in viewer + save metadata) can be 已接入 only with
 *    probe_all entries found in a web/ viewer file AND in a Worker save-metadata file, and only while the generated
 *    list module (NOT_SIMULATED_MODULE) equals what this matrix generates;
 *  - every listed row (未接入 except exempt / disclosure rows, and every 簡化代理) carries a player-facing disclosure_zh
 *    (「尚未模擬」 / 「簡化代理」); other rows carry none. The generated module is a candidate-world source, so the 未接入
 *    probes scan the disclosures too: a disclosure text can never pass for wiring.
 *
 *   --write also regenerates NOT_SIMULATED_MODULE (prototypes/continuous-world/worker/not-simulated.ts): the ONE
 *   versioned 「尚未模擬／簡化代理」 list of the P0-A2 world, written into payload.save_meta.not_simulated by the Worker
 *   and shown by the viewer from that save metadata only (Owner #212 Q2 a; matrix row M43).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/load.ts';

export const MATRIX_FILE = 'docs/r2-acceptance-matrix.json';
export const GO_NO_GO_FILE = 'docs/r2-go-no-go.md';
export const SPEC_FILE = 'docs/r2-day0-official-spec.md';
export const STATUSES = ['已接入', '簡化代理', '未接入'] as const;
export type Status = (typeof STATUSES)[number];
export const BASES = ['文獻支持', '一般生理學', '遊戲假設', '實測統計', '一般方法', '不適用'] as const;
const UNMEASURED_BASES = new Set(['文獻支持', '一般生理學', '遊戲假設', '實測統計', '一般方法']);
/** Owner #212 Q2 a: modules whose requirement is never relaxed (conservation, determinism, save recovery, life-state
 *  correctness, observation honesty). The matrix may list more, never fewer. */
export const NON_RELAXABLE_MIN = ['energy_mass_ledger', 'death_consumption', 'brood_stages', 'queen_oviposition', 'determinism', 'save_lifecycle', 'view_invariance', 'viewer', 'not_simulated_disclosure', 'candidate_label', 'no_god_mode', 'local_sensing', 'verifier'] as const;
export const DISCLOSURE_MODULE = 'not_simulated_disclosure';
/** the generated list module (Worker directory: p0a2-world.ts puts it into save_meta; part of the P0-A2 code hash) */
export const NOT_SIMULATED_MODULE = 'prototypes/continuous-world/worker/not-simulated.ts';
export const NOT_SIMULATED_FORMAT = 'antempire.not-simulated.v1';

export interface Row {
  id: string; module: string; name_zh: string; status: Status;
  /** listed rows only: the one-line player-facing disclosure that the viewer and save_meta.not_simulated show */
  disclosure_zh?: string;
  candidate_world_now: string; existing_assets: string[];
  probe?: { file?: string; text: string; any?: string[] };
  /** disclosure row only: every entry must be found in its file (viewer and save metadata) */
  probe_all?: { file: string; text: string }[];
  evidence_refs: string[];
  assumption: { flagged: boolean; basis: string[]; note: string };
  tests: string[]; known_defects: number[]; limits: string; player_view: string;
  r2_conditions: number[]; blocks_r2: boolean; blocker_reason: string; owner_decision?: string;
}
export interface Matrix {
  schema: string; as_of: string; base_commit: string;
  statuses: Record<string, string>;
  candidate_world: { description: string; sources: string[] };
  r2_conditions: Record<string, string>;
  required_modules: string[];
  owner_decisions: Record<string, string>;
  non_relaxable_modules: string[];
  disclosure_exempt_modules: string[];
  verdict: 'GO' | 'NO-GO';
  rows: Row[];
}

const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

export const loadMatrix = (root = REPO_ROOT): Matrix => JSON.parse(read(root, MATRIX_FILE)) as Matrix;

/** reference IDs defined in docs/references.md: the first cell of a table row, e.g. `| R94 |` or `| R102 Saund … |` */
export function referenceIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split('\n')) { const m = /^\|\s*\**\s*(R\d+[a-z]?)\b/.exec(line); if (m) ids.add(m[1]); }
  return ids;
}

/** names in the BLOCKING array of tests/run-all.ts (read as text: cli/ does not import tests/) */
export function blockingTests(text: string): Set<string> {
  const m = /export const BLOCKING = \[([^\]]*)\]/.exec(text);
  if (!m) throw new Error('tests/run-all.ts: BLOCKING array not found');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

function listFiles(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((d) => (d.isDirectory() ? listFiles(root, `${rel}/${d.name}`) : /\.(ts|html|json)$/.test(d.name) ? [`${rel}/${d.name}`] : []));
}
const within = (file: string, sources: string[]) => sources.some((s) => file === s || file.startsWith(`${s}/`));

export function validateMatrix(m: Matrix, root = REPO_ROOT): string[] {
  const e: string[] = [];
  const err = (where: string, msg: string) => e.push(`${where}: ${msg}`);
  if (m.schema !== 'antempire.r2-acceptance-matrix.v1') err('matrix', `unexpected schema ${m.schema}`);
  if (JSON.stringify(Object.keys(m.statuses ?? {})) !== JSON.stringify(STATUSES)) err('matrix', 'statuses must be exactly 已接入, 簡化代理, 未接入');
  if (!Array.isArray(m.rows) || m.rows.length === 0) { err('matrix', 'no rows'); return e; }
  const refs = referenceIds(read(root, 'docs/references.md'));
  const blocking = blockingTests(read(root, 'tests/run-all.ts'));
  const ci = read(root, '.github/workflows/ci.yml');
  const sources = m.candidate_world?.sources ?? [];
  if (sources.length === 0) err('candidate_world', 'no sources');
  for (const s of sources) if (!exists(root, s)) err('candidate_world', `source ${s} does not exist`);
  const corpus = sources.flatMap((s) => listFiles(root, s)).map((f) => ({ f, text: read(root, f) }));

  const nonRelaxable = new Set(m.non_relaxable_modules ?? []), exempt = new Set(m.disclosure_exempt_modules ?? []);
  const ids = new Set<string>(), modules = new Map<string, number>();
  for (const r of m.rows) {
    const w = r.id ?? '(no id)';
    if (!/^M\d{2}$/.test(r.id ?? '')) err(w, 'id must look like M01');
    if (ids.has(r.id)) err(w, 'duplicate id'); ids.add(r.id);
    if (!r.module) err(w, 'module missing'); else modules.set(r.module, (modules.get(r.module) ?? 0) + 1);
    if (!r.name_zh) err(w, 'name_zh missing');
    if (!(STATUSES as readonly string[]).includes(r.status)) err(w, `status "${r.status}" not in ${STATUSES.join('/')}`);
    if (typeof r.blocks_r2 !== 'boolean') err(w, 'blocks_r2 must be a boolean');
    if (typeof r.blocker_reason !== 'string' || r.blocker_reason.trim() === '') err(w, 'blocker_reason must explain why the row does or does not block R2');
    for (const k of ['candidate_world_now', 'limits', 'player_view'] as const) if (typeof r[k] !== 'string' || r[k].trim() === '') err(w, `${k} missing`);
    // conditions
    if (!Array.isArray(r.r2_conditions) || r.r2_conditions.length === 0) err(w, 'r2_conditions empty');
    for (const c of r.r2_conditions ?? []) if (!(String(c) in (m.r2_conditions ?? {}))) err(w, `unknown R2 condition ${c}`);
    // evidence
    for (const id of r.evidence_refs ?? []) if (!refs.has(id)) err(w, `reference ${id} is not defined in docs/references.md`);
    // assumption flags
    const a = r.assumption;
    if (!a || typeof a.flagged !== 'boolean' || !Array.isArray(a.basis) || a.basis.length === 0) err(w, 'assumption must have flagged (boolean) and a non-empty basis');
    else {
      for (const b of a.basis) if (!(BASES as readonly string[]).includes(b)) err(w, `assumption basis "${b}" not in ${BASES.join('/')}`);
      if (a.basis.some((b) => UNMEASURED_BASES.has(b)) && a.flagged !== true) err(w, 'basis includes a non-measured class, so assumption.flagged must be true');
      if (a.basis.includes('不適用') && a.basis.length > 1) err(w, '不適用 cannot be combined with another basis');
    }
    // tests
    for (const t of r.tests ?? []) {
      if (!exists(root, t)) { err(w, `test ${t} does not exist`); continue; }
      const tm = /^tests\/([^/]+)\.test\.ts$/.exec(t), bm = /^tests\/browser\/[^/]+\.check\.cjs$/.test(t);
      if (tm) { if (!blocking.has(tm[1])) err(w, `test ${t} is not in tests/run-all.ts BLOCKING`); }
      else if (bm) { if (!ci.includes(t)) err(w, `browser check ${t} is not run by .github/workflows/ci.yml`); }
      else err(w, `test ${t} must be tests/<name>.test.ts or tests/browser/<name>.check.cjs`);
    }
    for (const p of r.existing_assets ?? []) if (!exists(root, p)) err(w, `asset ${p} does not exist`);
    for (const d of r.known_defects ?? []) if (!Number.isInteger(d) || d <= 0) err(w, `known defect ${d} must be an issue number`);
    if (r.owner_decision !== undefined && !(r.owner_decision in (m.owner_decisions ?? {}))) err(w, `owner decision ${r.owner_decision} is not defined`);
    // honesty: wiring
    if (r.status === '已接入' || r.status === '簡化代理') {
      if (!r.probe?.text) err(w, `${r.status} needs a wiring probe`);
      else {
        if (r.probe.file !== undefined && (!within(r.probe.file, sources) || !exists(root, r.probe.file))) err(w, `probe file ${r.probe.file} is not a candidate-world source`);
        const pool = r.probe.file ? corpus.filter((x) => x.f === r.probe!.file) : corpus;
        if (!pool.some((x) => x.text.includes(r.probe!.text))) err(w, `${r.status} but "${r.probe.text}" is not found in the candidate world${r.probe.file ? ` (${r.probe.file})` : ''}`);
      }
    }
    if (r.status === '已接入' && (r.tests ?? []).length === 0) err(w, '已接入 needs at least one test');
    if (r.status === '簡化代理' && !/近似範圍/.test(r.limits ?? '')) err(w, '簡化代理 must state its approximation range (近似範圍) in limits (#201 condition 3)');
    if (r.status === '未接入' && r.probe?.text) {
      for (const t of [r.probe.text, ...(r.probe.any ?? [])]) {
        const hit = corpus.find((x) => x.text.includes(t));
        if (hit) err(w, `marked 未接入 but "${t}" appears in candidate-world source ${hit.f}: update the matrix`);
        // the generated list is a candidate-world source: no disclosure may contain an unwired mechanism's probe
        const said = m.rows.find((y) => (y.disclosure_zh ?? '').includes(t));
        if (said) err(w, `the disclosure_zh of ${said.id} contains this 未接入 probe "${t}" (it would read as wiring): reword it`);
      }
    }
    // Owner #212 Q2 a: an unwired mechanism is shown as 「尚未模擬」; the non-relaxable requirements still block
    if (r.status === '未接入' && !exempt.has(r.module) && !(r.player_view ?? '').includes('尚未模擬')) err(w, '未接入 must declare in player_view that the viewer shows 「尚未模擬」 (Owner #212 Q2 a)');
    if (nonRelaxable.has(r.module) && r.status !== '已接入' && r.blocks_r2 !== true) err(w, `${r.module} is non-relaxable (Owner #212 Q2 a: conservation, determinism, save recovery, life-state correctness, observation honesty): it blocks R2 unless 已接入`);
    // Owner #212 Q2 a: every listed row carries the disclosure the viewer / save metadata show; other rows none
    if (listed(m, r)) {
      const d = r.disclosure_zh;
      if (typeof d !== 'string' || d.trim() === '') err(w, 'a listed row (未接入 or 簡化代理) needs disclosure_zh (its 「尚未模擬」 list entry)');
      else if (/[\n|'\\]/.test(d)) err(w, 'disclosure_zh must be one line without |, \' or \\');
      else if (r.status === '未接入' && !d.includes('尚未模擬')) err(w, 'disclosure_zh of a 未接入 row must say 尚未模擬');
      else if (r.status === '簡化代理' && !d.includes('簡化代理')) err(w, 'disclosure_zh of a 簡化代理 row must say 簡化代理');
    } else if (r.disclosure_zh !== undefined) err(w, 'disclosure_zh is only for rows of the 「尚未模擬／簡化代理」 list');
    if (r.module === DISCLOSURE_MODULE && r.status === '已接入') {
      if (!exists(root, NOT_SIMULATED_MODULE) || read(root, NOT_SIMULATED_MODULE) !== renderNotSimulatedModule(m)) err(w, `${NOT_SIMULATED_MODULE} is missing or is not the list this matrix generates (node cli/r2-matrix.ts --write)`);
      const pa = r.probe_all ?? [];
      if (!pa.some((p) => p.file.startsWith('web/')) || !pa.some((p) => p.file.startsWith('prototypes/continuous-world/worker/'))) err(w, 'the disclosure row needs probe_all entries in a web/ viewer file and in a Worker save-metadata file');
      for (const p of pa) {
        if (!within(p.file, sources) || !exists(root, p.file)) err(w, `probe_all file ${p.file} is not a candidate-world source`);
        else if (!read(root, p.file).includes(p.text)) err(w, `probe_all "${p.text}" is not found in ${p.file}`);
      }
    }
  }
  for (const mod of NON_RELAXABLE_MIN) if (!nonRelaxable.has(mod)) err('non_relaxable_modules', `must contain ${mod} (Owner #212 Q2 a)`);
  for (const mod of [...nonRelaxable, ...exempt]) if (!(m.required_modules ?? []).includes(mod)) err('matrix', `module ${mod} (non_relaxable / disclosure_exempt) is not a required module`);
  for (const mod of exempt) if (nonRelaxable.has(mod) || mod === DISCLOSURE_MODULE) err('disclosure_exempt_modules', `${mod} cannot be exempt`);
  if (!(m.required_modules ?? []).includes(DISCLOSURE_MODULE)) err('required_modules', `${DISCLOSURE_MODULE} must be a required module (Owner #212 Q2 a)`);
  for (const req of m.required_modules ?? []) { const n = modules.get(req) ?? 0; if (n !== 1) err('required_modules', `${req} appears ${n} times (expected 1)`); }
  for (const mod of modules.keys()) if (!(m.required_modules ?? []).includes(mod)) err('required_modules', `row module ${mod} is not listed`);
  for (const c of Object.keys(m.r2_conditions ?? {})) if (!m.rows.some((r) => (r.r2_conditions ?? []).map(String).includes(c))) err('r2_conditions', `condition ${c} is covered by no row`);
  if (JSON.stringify(Object.keys(m.r2_conditions ?? {})) !== JSON.stringify(['1', '2', '3', '4', '5', '6'])) err('r2_conditions', 'must list conditions 1–6');
  const derived = m.rows.some((r) => r.blocks_r2) ? 'NO-GO' : 'GO';
  if (m.verdict !== derived) err('verdict', `verdict ${m.verdict} but the rows give ${derived}`);
  return e;
}

export function summarize(m: Matrix) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, m.rows.filter((r) => r.status === s).length])) as Record<Status, number>;
  const blockers = m.rows.filter((r) => r.blocks_r2).map((r) => ({ id: r.id, module: r.module, status: r.status, owner_decision: r.owner_decision ?? null }));
  return { verdict: m.verdict, rows: m.rows.length, counts, blockers: blockers.length, blocker_ids: blockers.map((b) => b.id), owner_decisions: Object.keys(m.owner_decisions) };
}

const cell = (s: string) => s.replace(/\|/g, '｜').replace(/\n/g, ' ');
const defects = (r: Row) => (r.known_defects.length ? r.known_defects.map((d) => `#${d}`).join(' ') : '—');

/** the blocker list of the go/no-go report (generated; tests compare it with the document) */
export function renderBlockers(m: Matrix): string {
  const b = m.rows.filter((r) => r.blocks_r2);
  const s = summarize(m);
  const out = [
    `判定：**${m.verdict}**（矩陣 ${m.rows.length} 列：已接入 ${s.counts['已接入']}、簡化代理 ${s.counts['簡化代理']}、未接入 ${s.counts['未接入']}；阻擋 ${b.length} 列）。`,
    '',
    '| 列 | 模組 | 狀態 | 條件 | 阻擋原因 | 缺陷 | Owner 決策 |',
    '|---|---|---|---|---|---|---|',
    ...b.map((r) => `| ${r.id} | ${cell(r.name_zh)} | ${r.status} | ${r.r2_conditions.join('、')} | ${cell(r.blocker_reason)} | ${defects(r)} | ${r.owner_decision ?? '—'} |`),
  ];
  return out.join('\n');
}

/** the full matrix table quoted in the spec (generated) */
export function renderTable(m: Matrix): string {
  return [
    '| 列 | 模組 | 狀態 | 阻擋 R2 | 測試 | 文獻 | 缺陷 |',
    '|---|---|---|---|---|---|---|',
    ...m.rows.map((r) => `| ${r.id} | ${cell(r.name_zh)} | ${r.status} | ${r.blocks_r2 ? '是' : '否'} | ${r.tests.length} | ${r.evidence_refs.length ? r.evidence_refs.join(' ') : '—'} | ${defects(r)} |`),
  ].join('\n');
}

/** is the row on the 「尚未模擬／簡化代理」 list (未接入 except exempt / disclosure rows; every 簡化代理) */
export function listed(m: Pick<Matrix, 'disclosure_exempt_modules'>, r: Row): boolean {
  if (r.status === '簡化代理') return true;
  return r.status === '未接入' && !(m.disclosure_exempt_modules ?? []).includes(r.module) && r.module !== DISCLOSURE_MODULE;
}

/** the 「尚未模擬／簡化代理」 list (generated; Owner #212 Q2 a: docs and the acceptance report must show it) */
export function renderNotSimulated(m: Matrix): string {
  const no = m.rows.filter((r) => r.status === '未接入' && listed(m, r));
  const proxy = m.rows.filter((r) => r.status === '簡化代理');
  return [
    `**尚未模擬**（${no.length} 列；候選世界中沒有這些機制，畫面、存檔中繼資料、文件與本報告都必須標「尚未模擬」，不得以隱藏補給或代用演出冒充）：`,
    '',
    ...no.map((r) => `- ${r.id} ${cell(r.name_zh)}${r.blocks_r2 ? '（阻擋 R2）' : '（不阻擋 R2）'}`),
    '',
    `**簡化代理**（${proxy.length} 列；近似範圍見矩陣 limits）：`,
    '',
    ...proxy.map((r) => `- ${r.id} ${cell(r.name_zh)}：${cell(r.limits)}`),
  ].join('\n');
}

/** the list items of the P0-A2 world: 未接入 first, then 簡化代理, matrix order within each group */
export function notSimulatedItems(m: Matrix): { row: string; status: '未接入' | '簡化代理'; label_zh: string }[] {
  const item = (r: Row) => ({ row: r.id, status: r.status as '未接入' | '簡化代理', label_zh: r.disclosure_zh ?? '' });
  return [...m.rows.filter((r) => r.status === '未接入' && listed(m, r)).map(item), ...m.rows.filter((r) => r.status === '簡化代理').map(item)];
}

/** the generated Worker module that holds the list (pure data, imports nothing; part of the P0-A2 code hash) */
export function renderNotSimulatedModule(m: Matrix): string {
  return [
    '/**',
    ` * GENERATED by node cli/r2-matrix.ts --write from ${MATRIX_FILE}: do not edit by hand`,
    ' * (tests/r2-acceptance-matrix.test.ts fails when this file is stale).',
    ' *',
    ' * The ONE 「尚未模擬／簡化代理」 list of the P0-A2 candidate / experiment world (Owner #212 Q2 a; matrix row M43): every',
    ' * matrix row marked 未接入 (except the documentation / verification rows and the disclosure row itself) and every 簡化代理',
    ' * row, each with its player-facing disclosure (disclosure_zh). p0a2-world.ts writes it into',
    ' * payload.save_meta.not_simulated; the viewer shows only the list a Worker snapshot carries (it keeps no copy).',
    ' * This module is in the P0-A2 code hash, so any change of the list changes the rules fingerprint. Pure data.',
    ' */',
    `export const NOT_SIMULATED_FORMAT = '${NOT_SIMULATED_FORMAT}';`,
    "export interface NotSimulatedItem { row: string; status: '未接入' | '簡化代理'; label_zh: string }",
    'export interface NotSimulatedList { format: typeof NOT_SIMULATED_FORMAT; world_kind: string; source: string; note_zh: string; items: readonly NotSimulatedItem[] }',
    'export const P0A2_NOT_SIMULATED: NotSimulatedList = {',
    '  format: NOT_SIMULATED_FORMAT,',
    "  world_kind: 'p0a2-24h-v1',",
    `  source: '${MATRIX_FILE}',`,
    "  note_zh: '候選／實驗世界中沒有標「尚未模擬」的機制，「簡化代理」只是近似；不得以隱藏補給或代用演出冒充（Owner #212 Q2 a）',",
    '  items: [',
    ...notSimulatedItems(m).map((x) => `    { row: '${x.row}', status: '${x.status}', label_zh: '${x.label_zh}' },`),
    '  ],',
    '};',
    '',
  ].join('\n');
}

const BLOCKS: { file: string; name: string; render: (m: Matrix) => string }[] = [
  { file: GO_NO_GO_FILE, name: 'blockers', render: renderBlockers },
  { file: GO_NO_GO_FILE, name: 'not-simulated', render: renderNotSimulated },
  { file: SPEC_FILE, name: 'table', render: renderTable },
  { file: SPEC_FILE, name: 'not-simulated', render: renderNotSimulated },
];
const markers = (name: string) => [`<!-- r2-matrix:${name}:begin (node cli/r2-matrix.ts --write) -->`, `<!-- r2-matrix:${name}:end -->`] as const;

/** replace the generated block in `text`; throws if the markers are missing */
export function withBlock(text: string, name: string, body: string): string {
  const [b, e] = markers(name); const i = text.indexOf(b), j = text.indexOf(e);
  if (i < 0 || j < i) throw new Error(`markers for ${name} not found`);
  return `${text.slice(0, i + b.length)}\n${body}\n${text.slice(j)}`;
}
/** generated-block problems (empty = the documents quote the current matrix verbatim) */
export function staleBlocks(m: Matrix, root = REPO_ROOT): string[] {
  const mod = exists(root, NOT_SIMULATED_MODULE) && read(root, NOT_SIMULATED_MODULE) === renderNotSimulatedModule(m) ? [] : [`${NOT_SIMULATED_MODULE}: generated list is missing or out of date (node cli/r2-matrix.ts --write)`];
  return [...mod, ...BLOCKS.flatMap(({ file, name, render }) => {
    const text = read(root, file);
    try { return withBlock(text, name, render(m)) === text ? [] : [`${file}: block ${name} is out of date (node cli/r2-matrix.ts --write)`]; }
    catch (x) { return [`${file}: ${(x as Error).message}`]; }
  })];
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(REPO_ROOT, 'cli', 'r2-matrix.ts');
if (isMain) {
  const m = loadMatrix();
  const errors = validateMatrix(m);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  if (process.argv.includes('--write')) {
    for (const { file, name, render } of BLOCKS) fs.writeFileSync(path.join(REPO_ROOT, file), withBlock(read(REPO_ROOT, file), name, render(m)));
    fs.writeFileSync(path.join(REPO_ROOT, NOT_SIMULATED_MODULE), renderNotSimulatedModule(m));
  }
  if (process.argv.includes('--check')) { const s = staleBlocks(m); if (s.length) { console.error(s.join('\n')); process.exit(1); } }
  console.log(JSON.stringify(summarize(m), null, 1));
}

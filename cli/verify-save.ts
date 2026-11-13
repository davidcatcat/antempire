/**
 * Node verifier of experiment-world saves (Owner ruling #200, option C; docs/save-format-v2.md §7).
 *
 *   npm run verify:save -- <file.json> [--no-recompute]
 *
 * Input: an export file (antempire.experiment-world-export.v1, as the save menu downloads it) or a bare snapshot
 * envelope (antempire.experiment-world-snapshot.v1). Output: one JSON report on stdout. The input file is only read;
 * this tool writes nothing (no report file, no save, nothing under saves/ or journal/; tests/worker-boundary checks it).
 *
 * Steps: (1) integrity — container fields, labels, export_sha256 and payload_sha256 recomputed; (2) compatibility — the
 * save's world kind, payload schema, engine version and rules fingerprint must be ones this build implements
 * (prototypes/continuous-world/worker/world-kinds.ts); (3) validity — the SAME core restores the snapshot (structural
 * checks); (4) recomputation — a fresh world from the TRUSTED initial conditions (world kind + world id + seed, with this
 * build's own parameters, never the file's) is advanced to the save's exact instant with the same core, and the event
 * chain (head, count) and the full state hash are compared.
 *
 * Every hash in the file is only a CLAIM: a file whose hashes were all recomputed after an edit passes (1) but fails
 * (4). The report is not signed; anyone can rerun this tool to reproduce it.
 *
 * status: 'node_verified' (1-4 passed) | 'integrity_ok' (1-3 passed, recomputation not run) | 'mismatch' (1-3 passed,
 * recomputation differs) | 'invalid' (1, 2 or 3 failed). Exit code 0 / 3 / 1 / 2 respectively.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORLD_KINDS, type VerifiableWorld } from '../prototypes/continuous-world/worker/world-kinds.ts';
import { canonicalJson, hashJson } from '../prototypes/continuous-world/worker/sha256.ts';
import { chainShapeProblem } from '../prototypes/continuous-world/worker/chain.ts';

export const REPORT_SCHEMA = 'antempire.save-verify-report.v1';
export const LABEL = '非正式實驗世界／不屬於正式遊戲歷史';
const SNAPSHOT_SCHEMA = 'antempire.experiment-world-snapshot.v1';
const EXPORT_SCHEMA = 'antempire.experiment-world-export.v1';
const ENVELOPE_FIELDS = ['engine_version', 'label', 'official', 'payload', 'payload_sha256', 'rules_fingerprint', 'schema', 'schema_version', 'seed', 'seq', 't_sim', 'world_id'];
const EXPORT_FIELDS = ['export_sha256', 'exported_at', 'label', 'official', 'schema', 'snapshot', 'world'];
/** largest input accepted (bounded resource use; same as the viewer's import limit) */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export type Status = 'node_verified' | 'integrity_ok' | 'mismatch' | 'invalid';
export interface Check { id: string; ok: boolean; detail: string }
export interface Report {
  schema: typeof REPORT_SCHEMA; label: string; official: false; status: Status;
  note: string;
  verifier: { tool: 'cli/verify-save.ts'; node: string; platform: string; arch: string; world_kinds: { id: string; engine_version: string; schema_version: number; rules_fingerprint: string }[] };
  input: { sha256: string; bytes: number; container: 'export' | 'snapshot' | null };
  save: { world_kind: string | null; world_id: string | null; seed: number | null; t_sim: number | null; seq: number | null; rules_fingerprint: string | null; engine_version: string | null; schema_version: number | null; payload_sha256: string | null; chain_head: string | null; chain_count: number | null;
    /** save_meta.not_simulated as the file states it (Owner #212 Q2 a; null when the save has none, e.g. the synthetic world). The
     *  same core's restore refuses a P0-A2 save whose list differs from this build's (META_MISMATCH). */
    not_simulated: { format: string; items: { row: string; status: string; label_zh: string }[] } | null };
  recomputed: { from: string; events: number; now: unknown; chain_head: string; chain_count: number; payload_sha256: string; differing_fields: string[] } | null;
  checks: Check[];
  diagnostics: { code: string; message: string }[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** the 「尚未模擬」 list a save states (a copy of well-formed data only; anything else is reported as null) */
function notSimulatedClaim(x: unknown): Report['save']['not_simulated'] {
  if (!isObj(x) || typeof x.format !== 'string' || !Array.isArray(x.items)) return null;
  const items = x.items.filter((i): i is Record<string, unknown> => isObj(i) && typeof i.row === 'string' && typeof i.status === 'string' && typeof i.label_zh === 'string');
  return items.length === x.items.length ? { format: x.format, items: items.map((i) => ({ row: i.row as string, status: i.status as string, label_zh: i.label_zh as string })) } : null;
}
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort().join();

/** an empty report (status invalid until the checks pass) */
export function baseReport(sha256: string, bytes: number): Report {
  return {
    schema: REPORT_SCHEMA, label: LABEL, official: false, status: 'invalid',
    note: '本報告未簽章：任何人可用同一版本的 cli/verify-save.ts 重跑重現。檔案中的雜湊只是聲明；只有 status = node_verified 表示 Node 由受信任的初始條件以同一核心重算並一致。',
    verifier: { tool: 'cli/verify-save.ts', node: process.version, platform: process.platform, arch: process.arch, world_kinds: Object.values(WORLD_KINDS).map((k) => ({ id: k.id, engine_version: k.engine_version, schema_version: k.schema_version, rules_fingerprint: k.rules_fingerprint })) },
    input: { sha256, bytes, container: null },
    save: { world_kind: null, world_id: null, seed: null, t_sim: null, seq: null, rules_fingerprint: null, engine_version: null, schema_version: null, payload_sha256: null, chain_head: null, chain_count: null, not_simulated: null },
    recomputed: null, checks: [], diagnostics: [],
  };
}

/** Verify a save given as text (reads and writes nothing; the caller supplies the bytes). */
export function verifySaveText(text: string, opts: { recompute?: boolean } = {}): Report {
  const recompute = opts.recompute ?? true;
  const r = baseReport(crypto.createHash('sha256').update(text, 'utf8').digest('hex'), Buffer.byteLength(text, 'utf8'));
  const check = (id: string, ok: boolean, detail: string) => { r.checks.push({ id, ok, detail }); return ok; };
  const fail = (code: string, message: string, status: Status = 'invalid'): Report => { r.diagnostics.push({ code, message }); r.status = status; return r; };

  // ---------------------------------------------------------------- 1. integrity
  if (r.input.bytes > MAX_INPUT_BYTES) return fail('TOO_LARGE', `input larger than ${MAX_INPUT_BYTES} bytes`);
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) { return fail('NOT_JSON', (e as Error).message); }
  if (!isObj(doc)) return fail('NOT_OBJECT', 'the file is not a JSON object');
  let env: Record<string, unknown>;
  if (doc.schema === EXPORT_SCHEMA) {
    r.input.container = 'export';
    if (!check('export.fields', keysOf(doc) === EXPORT_FIELDS.join(), `export fields: ${keysOf(doc)}`)) return fail('BAD_EXPORT', `unexpected or missing export fields (${keysOf(doc)}); fields such as a self-declared verification status are not accepted`);
    if (!check('export.label', doc.label === LABEL && doc.official === false, 'export is labelled non-official')) return fail('NOT_EXPERIMENT', 'export is not marked non-official');
    const { export_sha256, ...body } = doc;
    let sum = ''; try { sum = hashJson(body); } catch (e) { return fail('NOT_CANONICAL', (e as Error).message); }
    if (!check('export.sha256', sum === export_sha256, 'export_sha256 recomputed')) return fail('EXPORT_HASH_MISMATCH', 'export_sha256 does not match the file (altered or truncated)');
    if (!isObj(doc.snapshot) || !isObj(doc.world)) return fail('BAD_EXPORT', 'world / snapshot missing');
    env = doc.snapshot;
    if (!check('export.world', doc.world.world_id === env.world_id && doc.world.seed === env.seed, 'export world metadata matches the snapshot')) return fail('BAD_EXPORT', 'the snapshot does not belong to the exported world');
  } else if (doc.schema === SNAPSHOT_SCHEMA) { r.input.container = 'snapshot'; env = doc; }
  else return fail('UNKNOWN_SCHEMA', `schema ${String(doc.schema)} is neither ${EXPORT_SCHEMA} nor ${SNAPSHOT_SCHEMA}`);

  if (!check('envelope.fields', keysOf(env) === ENVELOPE_FIELDS.join(), `envelope fields: ${keysOf(env)}`)) return fail('BAD_SNAPSHOT', `unexpected or missing envelope fields (${keysOf(env)})`);
  if (!check('envelope.label', env.label === LABEL && env.official === false, 'snapshot is labelled non-official')) return fail('NOT_EXPERIMENT', 'snapshot is not marked non-official');
  const payload = env.payload;
  if (!isObj(payload)) return fail('BAD_SNAPSHOT', 'payload is not an object');
  let ph = ''; try { ph = hashJson(payload); } catch (e) { return fail('NOT_CANONICAL', `payload: ${(e as Error).message}`); }
  if (!check('envelope.payload_sha256', ph === env.payload_sha256, 'payload_sha256 recomputed')) return fail('HASH_MISMATCH', 'payload_sha256 does not match the payload');
  const meta = isObj(payload.save_meta) ? payload.save_meta : null, chain = isObj(payload.chain) ? payload.chain : null;
  r.save = {
    world_kind: meta && typeof meta.world_kind === 'string' ? meta.world_kind : null,
    world_id: typeof env.world_id === 'string' ? env.world_id : null, seed: typeof env.seed === 'number' ? env.seed : null,
    t_sim: typeof env.t_sim === 'number' ? env.t_sim : null, seq: typeof env.seq === 'number' ? env.seq : null,
    rules_fingerprint: typeof env.rules_fingerprint === 'string' ? env.rules_fingerprint : null, engine_version: typeof env.engine_version === 'string' ? env.engine_version : null,
    schema_version: typeof env.schema_version === 'number' ? env.schema_version : null, payload_sha256: ph,
    chain_head: chain && typeof chain.head === 'string' ? chain.head : null, chain_count: chain && typeof chain.count === 'number' ? chain.count : null,
    not_simulated: notSimulatedClaim(meta?.not_simulated),
  };
  for (const k of ['world_id', 'seed', 'rules_fingerprint', 'engine_version', 'schema_version', 't_sim', 'seq'] as const)
    if (!check(`header.${k}`, payload[k] === env[k], `${k}: header = payload`)) return fail('HEADER_MISMATCH', `${k} of the header and the payload differ`);

  // ---------------------------------------------------------------- 2. compatibility
  if (env.schema_version === 1) return fail('NO_CHAIN', 'payload schema v1 has no event-chain commitment; it cannot be verified (the file is not changed)');
  if (!meta || !chain) return fail('NO_CHAIN', 'payload.save_meta / payload.chain missing');
  const cp = chainShapeProblem(chain);
  if (!check('chain.shape', cp === null, cp ?? 'chain fields well formed')) return fail('BAD_CHAIN', cp!);
  const kind = WORLD_KINDS[String(meta.world_kind)];
  if (!check('compat.world_kind', !!kind, `world kind ${String(meta.world_kind)}`)) return fail('UNSUPPORTED_WORLD_KIND', `this verifier has no world kind ${String(meta.world_kind)} (known: ${Object.keys(WORLD_KINDS).join(', ')})`);
  if (!check('compat.schema_version', env.schema_version === kind.schema_version, `payload schema v${String(env.schema_version)} (verifier v${kind.schema_version})`)) return fail('UNSUPPORTED_SCHEMA', `payload schema v${String(env.schema_version)} is not v${kind.schema_version}`);
  if (!check('compat.engine_version', env.engine_version === kind.engine_version, `engine ${String(env.engine_version)}`)) return fail('UNSUPPORTED_ENGINE', `engine ${String(env.engine_version)} is not ${kind.engine_version}`);
  if (!check('compat.rules_fingerprint', env.rules_fingerprint === kind.rules_fingerprint, `rules ${String(env.rules_fingerprint)}`)) return fail('UNSUPPORTED_RULES', `rules fingerprint ${String(env.rules_fingerprint)} is not one this verifier implements (${kind.rules_fingerprint}); it cannot be recomputed and is NOT verified`);
  const ini = isObj(meta.initial) ? meta.initial : null;
  if (!check('initial.conditions', !!ini && ini.world_id === env.world_id && ini.seed === env.seed && ini.t_sim === 0, 'initial conditions name this world and seed at t = 0')) return fail('BAD_INITIAL', 'save_meta.initial does not name this world id and seed at t = 0');
  if (!check('initial.params', ini!.params_sha256 === kind.params_sha256, 'initial parameters are this build\'s parameters')) return fail('UNSUPPORTED_PARAMS', 'the initial parameters differ from this verifier\'s; recomputation would use other rules');

  // ---------------------------------------------------------------- 3. validity (the same core's structural checks)
  let restored: VerifiableWorld;
  try { restored = kind.restore(structuredClone(env)); } catch (e) { return fail('RESTORE_REFUSED', (e as Error).message); }
  check('restore', true, 'the same core accepts the snapshot (structure, queue, streams, ledgers, chain shape)');
  if (!recompute) { r.status = 'integrity_ok'; r.diagnostics.push({ code: 'NOT_RECOMPUTED', message: '--no-recompute: integrity, compatibility and validity only; NOT verified by recomputation' }); return r; }

  // ---------------------------------------------------------------- 4. recomputation from the trusted initial conditions
  let fresh: VerifiableWorld, events = 0;
  try {
    const c = kind.create(String(ini!.world_id), Number(ini!.seed)); fresh = c.world; events += c.events.length;
    events += fresh.advanceToExact(restored.nowExact()).events.length;
  } catch (e) { return fail('RECOMPUTE_FAILED', (e as Error).message, 'mismatch'); }
  const ch = fresh.chainState(), snap = fresh.snapshot();
  const savedPayload = payload as Record<string, unknown>, freshPayload = snap.payload as Record<string, unknown>;
  const differing = [...new Set([...Object.keys(savedPayload), ...Object.keys(freshPayload)])].sort().filter((k) => canonicalJson(savedPayload[k] ?? null) !== canonicalJson(freshPayload[k] ?? null));
  r.recomputed = { from: `${kind.id}: create(${String(ini!.world_id)}, ${String(ini!.seed)}) then advance to the save's exact instant`, events, now: fresh.nowExact(), chain_head: ch.head, chain_count: ch.count, payload_sha256: snap.payload_sha256, differing_fields: differing };
  const okCount = check('recompute.chain_count', ch.count === chain.count, `chain count ${ch.count} (saved ${String(chain.count)})`);
  const okHead = check('recompute.chain_head', ch.head === chain.head, `chain head ${ch.head.slice(0, 16)}… (saved ${String(chain.head).slice(0, 16)}…)`);
  const okState = check('recompute.state', snap.payload_sha256 === ph, `state hash ${snap.payload_sha256.slice(0, 16)}… (saved ${ph.slice(0, 16)}…)`);
  if (!(okCount && okHead && okState)) {
    if (!okCount || !okHead) r.diagnostics.push({ code: 'CHAIN_MISMATCH', message: 'the recomputed event chain differs from the saved commitment (events were altered, invented or produced by other rules / inputs)' });
    if (!okState) r.diagnostics.push({ code: 'STATE_MISMATCH', message: `the recomputed state differs in: ${differing.join(', ') || '(only in field order or numbers)'}` });
    r.status = 'mismatch'; return r;
  }
  r.status = 'node_verified';
  return r;
}

const EXIT: Record<Status, number> = { node_verified: 0, mismatch: 1, invalid: 2, integrity_ok: 3 };

function main(argv: string[]): number {
  const args = argv.filter((a) => !a.startsWith('--')), recompute = !argv.includes('--no-recompute');
  if (args.length !== 1 || argv.some((a) => a.startsWith('--') && a !== '--no-recompute')) { process.stderr.write('usage: npm run verify:save -- <save.json> [--no-recompute]\n'); return 64; }
  let text: string;
  try {
    const st = fs.statSync(args[0]);
    if (st.size > MAX_INPUT_BYTES) {
      const rep = baseReport('', st.size); rep.diagnostics.push({ code: 'TOO_LARGE', message: `${st.size} bytes > ${MAX_INPUT_BYTES}; not read` });
      process.stdout.write(`${JSON.stringify(rep, null, 2)}\n`); return EXIT.invalid;
    }
    text = fs.readFileSync(args[0], 'utf8');
  } catch (e) { process.stderr.write(`cannot read ${args[0]}: ${(e as Error).message}\n`); return 66; }
  const rep = verifySaveText(text, { recompute });
  process.stdout.write(`${JSON.stringify(rep, null, 2)}\n`);
  return EXIT[rep.status];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));

/**
 * Demo 2 performance tests — a Markdown table from result files (reports/demo2-bench/*.json, or JSON pasted from
 * web/demo2-bench.html on a device). Read-only: it prints to stdout and writes nothing.
 *   node cli/demo2-bench-table.ts <result.json> [more.json …]
 * Accepts the page's own record (schema antempire.demo2-bench.v1) or the headless runner's wrapper around it.
 * REFUSES (exit 2) to put results of different measurement classes (software / real_gpu / unknown) or different
 * rendering APIs into one table, and refuses a record whose class does not match its own GPU strings
 * (web/src/demo2/bench-report.ts). Run it once per class to get separate tables.
 */
import fs from 'node:fs';
import { BENCH_SCHEMA, MixedMeasurementError, benchTable, type BenchResult } from '../web/src/demo2/bench-report.ts';

/** the page record inside a file: the record itself, or the `result` of a runner file. Throws when there is none. */
export function readBenchFile(text: string, name = 'input'): BenchResult {
  const j = JSON.parse(text) as { schema?: string; result?: BenchResult | null; crashed?: string | null };
  if (j.schema === BENCH_SCHEMA) return j as unknown as BenchResult;
  if (j.result && j.result.schema === BENCH_SCHEMA) return j.result;
  throw new Error(`${name}: no ${BENCH_SCHEMA} record${j.crashed ? `（執行失敗：${j.crashed}）` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node cli/demo2-bench-table.ts <result.json> [more.json …]'); process.exit(64); }
  try { console.log(benchTable(files.map((f) => readBenchFile(fs.readFileSync(f, 'utf8'), f)))); }
  catch (e) { console.error((e as Error).message); process.exit(e instanceof MixedMeasurementError ? 2 : 1); }
}

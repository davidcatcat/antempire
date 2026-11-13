/**
 * LANE-FLOW compatibility digests: SHA-256 of laneFlow outputs for fixed configurations WITHOUT the decision layer
 * (with and without entry control). The decision layer (#189 ruling 7) is opt-in: these outputs must not change when it
 * is added (tests/k189-entry-decision.test.ts pins the digests computed before the decision layer existed).
 *   node prototypes/lane-flow/compat.ts   → prints the digests
 */
import crypto from 'node:crypto';
import { laneFlow, type LaneFlowInput, type FlowAgentSpec } from '../../engine/physics/lane-flow.ts';
import { normalBenchmark, benchmarkInput, benchmarkSite } from './lib.ts';

const BODY = { length_mm: 2.5, width_mm: 0.8 };
const ag = (id: string, s: number, v: number, over: Partial<FlowAgentSpec> = {}): FlowAgentSpec => ({ id, dir: 1, s_mm: s, u_mm: 0, goal_s_mm: 50, start_t_s: 0, free_speed_mm_s: v, body: BODY, site: 'nest', ...over });
const noEntry = (mode: 'slow' | 'stop'): LaneFlowInput => ({ lane: { length_mm: 60, width_mm: 2 }, agents: [ag('L', 30, 5), ag('F', 20, 10), ag('G', 12, 9, { u_mm: 0.3, start_t_s: 0.25 }), ag('W', 10, 10, { dir: -1, u_mm: -0.6 })], horizon_s: 8, contact_response: mode, arrival: 'leave_to_ledger', sites: [benchmarkSite()] });
export const COMPAT_CONFIGS: Record<string, () => LaneFlowInput> = {
  'normal seed 1 slow entry H12': () => benchmarkInput(normalBenchmark(1), { horizon_s: 12, contact_response: 'slow' }),
  'normal seed 2 stop entry H12': () => benchmarkInput(normalBenchmark(2), { horizon_s: 12, contact_response: 'stop' }),
  'two-way seed 1 slow entry H8': () => benchmarkInput(normalBenchmark(1, { directions: [1, -1] }), { horizon_s: 8, contact_response: 'slow' }),
  'no-entry slow H8': () => noEntry('slow'),
  'no-entry stop H8': () => noEntry('stop'),
};
export const digestOf = (x: unknown) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const compatDigests = (): Record<string, string> => Object.fromEntries(Object.entries(COMPAT_CONFIGS).map(([k, f]) => [k, digestOf(laneFlow(f()))]));
if (process.argv[1]?.endsWith('compat.ts')) console.log(JSON.stringify(compatDigests(), null, 2));

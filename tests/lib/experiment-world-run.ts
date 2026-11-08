/**
 * Node reference run of the non-official experiment world, for the Node <-> browser Worker cross-check
 * (tests/browser/worker-runtime.check.cjs). Prints JSON on stdout; reads and writes no file.
 *   node tests/lib/experiment-world-run.ts <world_id> <seed> <hours>
 */
import { ExperimentWorld } from '../../prototypes/continuous-world/worker/core.ts';

const [worldId = 'exp-xcheck', seedArg = '11', hoursArg = '48'] = process.argv.slice(2);
const { world, events } = ExperimentWorld.create(worldId, Number(seedArg));
const r = world.advanceTo(Number(hoursArg) * 3600);
const snap = world.snapshot();
process.stdout.write(JSON.stringify({ events: [...events, ...r.events], payload_sha256: snap.payload_sha256, payload: snap.payload, t_sim: snap.t_sim, seq: snap.seq, platform: `node ${process.version}` }));

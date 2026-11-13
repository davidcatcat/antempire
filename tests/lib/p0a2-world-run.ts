/**
 * Node reference run of the P0-A2 24 h world through the experiment Worker adapter, for the Node <-> browser Worker
 * cross-check (tests/browser/worker-runtime.check.cjs). Prints JSON on stdout; reads and writes no file.
 *   node tests/lib/p0a2-world-run.ts <world_id> <seed> <hours>
 */
import { P0a2ExperimentWorld } from '../../prototypes/continuous-world/worker/p0a2-world.ts';

const [worldId = 'exp-p0-xcheck', seedArg = '11', hoursArg = '48'] = process.argv.slice(2);
const { world, events } = P0a2ExperimentWorld.create(worldId, Number(seedArg));
const r = world.advanceTo(Number(hoursArg) * 3600);
const snap = world.snapshot();
process.stdout.write(JSON.stringify({ events: [...events, ...r.events].map((e) => JSON.stringify(e)), payload_sha256: snap.payload_sha256, payload: snap.payload, t_sim: snap.t_sim, seq: snap.seq, platform: `node ${process.version}` }));

/**
 * Read-only witness experiment. Native AntEmpire computes ALL trajectories/encounters.
 * Rapier 2D only checks overlaps with capsules and the ORIGINAL synthetic walls.
 * PixiJS plays native intervals. No official game day, save, or params are changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier2d-deterministic-compat';
import { runOne } from '../../physics/two-ant-corridor.ts';
import { checkExclusion } from '../../../engine/physics/collision.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../public/replays/compare.json');
const STEP_S = 1 / 120; // numerical observation resolution, not ant behavioral parameter
const HORIZON_S = 11;  // visual replay window, not a changed engine horizon
await RAPIER.init();

function at(ivs, t) {
  if (!ivs.length) throw Error('missing engine motion records');
  const segment = ivs.find(i => t >= i.t_start_s - 1e-10 && t < i.t_end_s - 1e-10)
    ?? (t < ivs[0].t_start_s ? ivs[0] : ivs.at(-1));
  const dt = segment.t_end_s - segment.t_start_s;
  const f = dt > 0 ? Math.max(0, Math.min(1, (t - segment.t_start_s) / dt)) : 1;
  return segment.s_start_mm + (segment.s_end_mm - segment.s_start_mm) * f;
}
function bounds(o) {
  if (o.shape.type !== 'polygon') throw Error('prototype accepts rectangular walls only');
  const pts = o.shape.points_mm, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (new Set(xs).size !== 2 || new Set(ys).size !== 2 || pts.length !== 4)
    throw Error('not an axis-aligned rectangle; refuse approximation');
  return { x0, x1, y0, y1 };
}
function capsule(r, spec, extra = 0) {
  const radius = spec.body.width_mm / 2 + extra;
  const half = Math.max(0, (spec.body.length_mm - spec.body.width_mm) / 2);
  return r.ColliderDesc.capsule(half, radius).setRotation(Math.PI / 2).setSensor(true)
    .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
}
function checkSensorsEnabled() {
  // Distinct kinematic bodies at exactly the same location MUST intersect.
  // The earlier fixed/fixed default silently returned false for every sample.
  const test = new RAPIER.World({x:0,y:0});
  const probe = {body:{length_mm:2.5,width_mm:0.8}};
  const c=[];
  for(let i=0;i<2;i++){
    const b=test.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0,0));
    c.push(test.createCollider(capsule(RAPIER,probe),b));
  }
  test.step();
  assert.equal(test.intersectionPair(c[0],c[1]),true,'Rapier two-kinematic-body sensor positive control');
  test.free();
}
checkSensorsEnabled();
function witness(cfg, res) {
  // Native exact event timestamps; Rapier is a sampled, 2D, centreline-only
  // witness, NOT a substitute for native 2.5D geometric constraints.
  const world = new RAPIER.World({ x: 0, y: 0 });
  world.timestep = STEP_S;
  const ants = [...cfg.agents].sort((a,b)=>a.id.localeCompare(b.id));
  const colliders = ants.map(a => {
    // Position-driven kinematic bodies represent prescribed NATIVE trajectories.
    // Each ant's body and antenna belong to one rigid body; self-overlap is deliberately filtered.
    const rigid = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(a.s_mm,0));
    const body = world.createCollider(capsule(RAPIER,a),rigid);
    const antenna = world.createCollider(capsule(RAPIER,a,a.body.contact_reach_mm/2),rigid);
    return { id:a.id, rigid, body, antenna };
  });
  const walls = cfg.geometry.obstacles.map(o => {
    const b = bounds(o);
    const c = world.createCollider(RAPIER.ColliderDesc.cuboid((b.x1-b.x0)/2,(b.y1-b.y0)/2)
      .setTranslation((b.x0+b.x1)/2,(b.y0+b.y1)/2)
      .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL));
    return { id:o.id, collider:c };
  });
  let bodyOverlapFrames = 0, wallOverlapFrames = 0, antennaFrames = 0;
  let firstAntennaSampleS = null, maxPairBodyPenetrationMm = 0;
  let steps = 0;
  const started = performance.now();
  for (let n=0;n<=Math.round(HORIZON_S/STEP_S);n++) {
    const t=n*STEP_S;
    for (const a of colliders) {
      const x=at(res.intervals[a.id],t);
      a.rigid.setNextKinematicTranslation({x,y:0});
    }
    world.step();
    steps++;
    if (colliders.length === 2) {
      const a=colliders[0],b=colliders[1];
      if (world.intersectionPair(a.body,b.body)) bodyOverlapFrames++;
      if (world.intersectionPair(a.antenna,b.antenna)) {
        antennaFrames++;
        if(firstAntennaSampleS===null) firstAntennaSampleS=Number(t.toFixed(6));
      }
      const x1=at(res.intervals[a.id],t),x2=at(res.intervals[b.id],t);
      const touchDist=(cfg.agents[0].body.length_mm+cfg.agents[1].body.length_mm)/2;
      maxPairBodyPenetrationMm=Math.max(maxPairBodyPenetrationMm,touchDist-Math.abs(x1-x2));
    }
    for(const a of colliders)for(const w of walls) if(world.intersectionPair(a.body,w.collider))wallOverlapFrames++;
  }
  const wallMS=Number((performance.now()-started).toFixed(2));
  world.free();
  return { sample_dt_s:STEP_S, sampled_horizon_s:HORIZON_S, samples:steps,
    body_overlap_frames:bodyOverlapFrames, wall_overlap_pairs:wallOverlapFrames,
    antenna_proximity_frames:antennaFrames,first_antenna_sample_s:firstAntennaSampleS,
    centreline_body_penetration_upper_mm:Number(maxPairBodyPenetrationMm.toFixed(8)),
    rapier_wall_ms:wallMS,
    limits:'Rapier capsules are 2D centreline sensor witnesses. It does NOT resolve ant motion, infer biology, or replace native 2.5D physics.' };
}
const cases=[
  { id:'entry',label:'窄道迎面相遇｜入口讓路',kind:'entry',opts:{seed:1,enc:{contact_pause_s:0.18,inside_turn_back_probability:0.5}} },
  { id:'inside',label:'兩隻都在窄道內｜候選回頭機率',kind:'inside',opts:{seed:3,enc:{contact_pause_s:0.18,inside_turn_back_probability:0.5}} },
  { id:'control',label:'無牆對照｜中心線假設有侷限',kind:'entry',opts:{seed:1,walls:false,enc:{contact_pause_s:0.18,inside_turn_back_probability:0.5}} },
];
const scenarios=[];
for(const item of cases) {
  const started=performance.now();
  const {summary,res,cfg}=runOne(item.label,item.kind,{...item.opts,light:true});
  const nativeMs=Number((performance.now()-started).toFixed(2));
  const replay=runOne(item.label,item.kind,{...item.opts,light:true});
  assert.deepEqual(res,replay.res,'native fixed seed must replay identically');
  const nativeViolations=checkExclusion(cfg,res,0.025);
  const rapier=witness(cfg,res);
  scenarios.push({
    id:item.id,label:item.label,synthetic:true,seed:cfg.seed,horizon_s:HORIZON_S,
    geometry:cfg.geometry,agents:cfg.agents,intervals:res.intervals,
    events:res.events.filter(e=>e.t_s<=HORIZON_S),summary,
    comparison:{
      native_run_ms:nativeMs,native_events:res.events.length,
      native_exclusion_violations:nativeViolations.length,
      native_violation_examples:nativeViolations.slice(0,3),
      native_arrivals_s:Object.fromEntries(Object.entries(summary.ants).map(([id,a])=>[id,a.arrive_s])),
      rapier,
      interpretation:'Rapier samples native positions with sensor colliders; discrepancies diagnose geometry/temporal assumptions. These are NOT two independent behavior simulators.',
    }
  });
}
const output={
  schema:'antempire.experimental.rapier-pixi-witness.v1',official:false,
  note:'獨立物理實驗／非正式生態世界。Native AntEmpire 計算軌跡、接觸與讓路；Rapier 2D 僅依同一條軌跡獨立偵測碰撞；PixiJS 僅播放。接觸不等於餵食。',
  provenance:{native:'engine/physics/collision.ts via prototypes/physics/two-ant-corridor.ts',
    geometry:'scenarios/physics/narrow-corridor.geometry.json',
    dimensions:'scenarios/physics/pheidole-megacephala.body-candidates.json',
    motion:'scenarios/physics/pheidole-megacephala.motion-candidates.json',
    encounter:'scenarios/physics/pheidole-megacephala.interaction-candidates.json',
    rapier:'@dimforge/rapier2d-deterministic-compat 0.21.0',
    renderer:'pixi.js 8.22.0',
    warning:'Ant size/width, entry yield probability, contact duration are species-specific measurement / non-species literature / explicit sensitivity assumptions respectively; do not blend.'},
  scenarios
};
fs.mkdirSync(path.dirname(OUT),{recursive:true});
fs.writeFileSync(OUT,JSON.stringify(output,null,2)+'\n');
for(const s of scenarios){
  console.log(JSON.stringify({scenario:s.id, native_contacts:s.summary.contacts,
    native_violations:s.comparison.native_exclusion_violations,
    native_arrivals:s.comparison.native_arrivals_s,
    rapier_antenna_frames:s.comparison.rapier.antenna_proximity_frames,
    rapier_body_overlap_frames:s.comparison.rapier.body_overlap_frames,
    rapier_wall_overlap_pairs:s.comparison.rapier.wall_overlap_pairs,
    rapier_ms:s.comparison.rapier.rapier_wall_ms}));
}
console.log('Wrote '+OUT+' (experimental replay, official saves unchanged)');

'use strict';
const fs=require('node:fs');const {performance}=require('node:perf_hooks');const {simulateDay}=require('./day_engine.cjs');
const original=JSON.parse(fs.readFileSync(__dirname+'/day14-projection.json')),p=JSON.parse(fs.readFileSync(__dirname+'/params.json'));
const rows=[];for(const size of [14,100,1000]){const s=structuredClone(original);s.population.workers=[];for(let i=0;i<size;i++){
 const w=structuredClone(original.population.workers[i%14]);w.id='W'+String(i+4).padStart(3,'0');w.known_sources=i%14===1?['F01']:i%14===2?['F11']:i%14===7?['F07']:[];s.population.workers.push(w);
 }s.next_worker_number=size+4;for(const src of Object.values(s.sources)){src.known_by=s.population.workers.filter(w=>w.known_sources.includes(src.id)).map(w=>w.id);}
 s.colony.sugar+=Math.max(0,size-14)*.5;s.colony.protein+=Math.max(0,size-14)*.05;
 const t=performance.now();const out=simulateDay(s,p);const elapsed=performance.now()-t;
 if(out.summary.population.workers+out.summary.worker_deaths!==size+out.summary.eclosions)throw Error('Conservation not met at '+size);
 rows.push({workers_before:size,workers_after:out.summary.population.workers,ms:Math.round(elapsed),all_workers_tasked:Object.values(out.summary.tasks).reduce((a,b)=>a+b,0)===size,events:out.events.length});}
console.log(JSON.stringify(rows,null,2));fs.writeFileSync(__dirname+'/../reports/scaling-smoke.json',JSON.stringify(rows,null,2)+'\n');

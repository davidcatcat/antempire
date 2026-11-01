'use strict';
/** Repair the prior review fixture to match Day15 one-time ecological host-census migration; no official saves touched. */
const fs=require('fs'),path=require('path');
const fn=path.join(__dirname,'day14-projection.json'),s=JSON.parse(fs.readFileSync(fn));
const census={F01:{host_plants:2,hemipteran_kind:'aphid',hemipteran_colonies:4},F04:{host_plants:2,hemipteran_kind:'scale',hemipteran_colonies:3},F05:{host_plants:1,hemipteran_kind:'aphid',hemipteran_colonies:2},F10:{host_plants:1,hemipteran_kind:'scale',hemipteran_colonies:1}};
for(const [id,attrs] of Object.entries(census)){
  const site=s.sources[id];if(!site)throw Error('Missing original source '+id);
  Object.assign(site,site.host_alive?attrs:{host_plants:0,hemipteran_kind:attrs.hemipteran_kind,hemipteran_colonies:0});
  site.production_per_day=0;site.ecology_origin='Day15 habitat census game assumption; independent of ant appetite';
}
for(const w of s.population.workers)w.local_sensory={own_crop_sugar_fill:.55,peer_sugar_hunger:.4,peer_protein_request:.25,direct_brood_begging:0,unload_feedback:{sugar:.5,protein:.5},origin:'unknown prior individual encounter; neutral assumed'};
for(const b of s.population.brood)if(b.stage==='larva')b.begging_signal=.25;
s.migration_log.push({type:'day15_ecological_census_fixture',day14_unmodified:true,host_counts:census,stock_unchanged:true,provenance:'explicit one-time garden population assumptions independent of colony consumption'});
fs.writeFileSync(fn,JSON.stringify(s,null,2)+'\n');
console.log('Host-census review projection prepared (no main save writes)');

"use strict";
/* Run: node sim/day_engine.cjs < sim/results/day9-input.json
   Pure deterministic scenario sampler. Field kinetics and thresholds UNCALIBRATED. */
const V = "antempire-day-engine-v1";
function fnv(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)}return h>>>0}
function rng(a){return ()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296}}
const round=(x,n=4)=>Number(x.toFixed(n));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function norm(g){return Math.sqrt(-2*Math.log(Math.max(1e-9,g())))*Math.cos(2*Math.PI*g())}
function gamma(shape,scale,g){let d=shape-1/3,c=1/Math.sqrt(9*d);for(let i=0;i<2000;i++){let z=norm(g),v=1+c*z;if(v<=0)continue;v=v*v*v;let u=g();if(u<1-0.0331*z**4||Math.log(u)<0.5*z*z+d*(1-v+Math.log(v)))return d*v*scale}throw Error("gamma failed")}
function ndays(year,month){return new Date(Date.UTC(year,month,0)).getUTCDate()}
function monthlyPrior(rows,annualRainDays){let wt=rows.map(r=>Math.pow(r.mean_monthly_precipitation_mm/ndays(2025,r.month),0.6)),lo=0,hi=100;for(let j=0;j<65;j++){let k=(lo+hi)/2,n=wt.reduce((acc,w,i)=>acc+ndays(2025,i+1)*Math.min(.85,k*w),0);if(n<annualRainDays)lo=k;else hi=k}return wt.map(w=>Math.min(.85,(lo+hi)/2*w))}
function interpolated(arr,year,month,day){let left,right,frac;if(day>=15){left=(month+11)%12;right=month%12;frac=(day-15)/ndays(year,month)}else{let prev=month===1?12:month-1;left=prev-1;right=month-1;frac=(ndays(year,prev)-15+day)/ndays(year,prev)}return arr[left]+(arr[right]-arr[left])*frac}
function simulateDay(input){
 const {day,date,prevDay,previousHead,monthly,annualRainDays,priorState,context}=input;
 if(day!==prevDay+1||monthly.length!==12||context.location!=="臺中市西屯區")throw Error("input invalid");
 const [y,mo,dd]=date.split("-").map(Number),dt=new Date(Date.UTC(y,mo-1,dd));if(dt.toISOString().slice(0,10)!==date)throw Error("date invalid");
 const material="antempire-garden-v3|Day"+prevDay+"->Day"+day+"|"+previousHead+"|"+date;
 const streams={},seeds={};for(const key of ["weather_climate","plants","sap_hemipterans","insects_and_detritus","rivals","predators","terrain","worker_W005","worker_W011","worker_W017","worker_W016","worker_W013","queen_and_brood"]){seeds[key]=fnv(material+"|"+key);const g=rng(seeds[key]);streams[key]=Array.from({length:12},()=>round(g(),8))}
 const pByMonth=monthlyPrior(monthly,annualRainDays),p=interpolated(pByMonth,y,mo,dd);
 const prevWet=priorState.weather_kind==="synthetic_climatology"?priorState.wet:null;
 const wetProb=prevWet===null?p:prevWet?p+0.45*(1-p):p*(1-0.45);
 const wet=streams.weather_climate[0]<wetProb;
 const meanTemp=interpolated(monthly.map(x=>x.mean_air_temperature_c),y,mo,dd);
 const meanHum=interpolated(monthly.map(x=>x.mean_relative_humidity_percent),y,mo,dd);
 const meanRain=interpolated(monthly.map(x=>x.mean_monthly_precipitation_mm),y,mo,dd);
 const tempG=rng(fnv(material+"|temp_anomaly_normal"));const anomaly=round(0.65*(priorState.temp_anomaly_c||0)+1.8*norm(tempG));
 const rainG=rng(fnv(material+"|rain_gamma"));const rain=wet?round(gamma(1.6,meanRain/ndays(y,mo)/Math.max(p,1e-9)/1.6,rainG),2):0;
 const temp=round(meanTemp+anomaly-0.8*(Number(wet)-p),2),rh=round(clamp(meanHum+(wet?5:-2)+0.45*anomaly,0,100),1);
 const soilBefore=priorState.soil_index===null?(context.priorDay8FictionalWatering?0.35:0.20):priorState.soil_index;
 const shadeBefore=priorState.shade_index===null?(context.priorDay8FictionalWatering?0.42:0.28):priorState.shade_index;
 const soil=round(clamp(0.75*soilBefore+(wet?Math.min(0.55,rain/20):0)-0.1,0,1));
 const shade=round(clamp(0.82*shadeBefore+(wet?Math.min(0.35,rain/35):0)-0.04,0,1));
 const weather={date,weekday:["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dt.getUTCDay()],timezone:"Asia/Taipei",season:"autumn",weather_kind:"synthetic_climatology",data_kind:"synthetic_climatology",climatology_period:"1991-2020",coverage:"1991-2020臺中歷史氣候生成西屯虛構花園天氣；非特定日期觀測/預報",source_urls:["https://climate.cwa.gov.tw/MeasuringObservation","data/taichung-climatology-1991-2020.json"],forecast_issue_time:null,previous_day_weather_ref:"saves/world-state.json#/day_log_latest/weather Day"+prevDay,synthetic_weather:{wet,precipitation_mm:rain,daily_mean_air_temperature_c:temp,relative_humidity_percent:rh,model_surface_wetness_index:soil,model_shaded_soil_memory_index:shade,climate_prior_rain_probability:round(p,6),rainfall_probability_model:round(wetProb,6),temperature_anomaly_c:anomaly,day_min_temperature_c:null,day_max_temperature_c:null},actual_observations:{rainfall_mm:null,air_temperature_c:null,relative_humidity_percent:null},microclimate:{actual_nest_temperature_c:null,actual_nest_humidity_percent:null,soil_moisture_percent:null},model_assumptions:"uncalibrated seasonal stochastic scenario; NOT actual future weather",seed_and_draws:{root_seed:fnv(material),named_weather_seed:seeds.weather_climate,weather_draws:streams.weather_climate}};
 const s=streams;
 const aphidsAccessible=s.sap_hemipterans[0]<.68&&s.sap_hemipterans[1]<.47;
 const W005Visit=s.worker_W005[0]<.75,W005Delivery=aphidsAccessible&&W005Visit&&s.worker_W005[1]<.92;
 const newDetritus=s.insects_and_detritus[0]<.28,newDetritusSite=s.insects_and_detritus[1]<.5?"F07":"F11";
 const W011Visit=s.worker_W011[0]<.77,W011Delivery=W011Visit&&newDetritus&&newDetritusSite==="F07"&&s.worker_W011[1]<.56;
 const flowerNectar=s.plants[0]<.42,W017Visit=s.worker_W017[0]<.53,W017Delivery=W017Visit&&flowerNectar&&s.worker_W017[1]<.80;
 const W016Visited=s.worker_W016[0]<.60&&s.terrain[0]>=.18,W013Repair=soil>=.12&&s.worker_W013[0]<.70;
 const rivalsAtF04=s.rivals[0]<.76,predatorSeen=s.predators[0]<.62,newEggs=s.queen_and_brood[0]<.16?1:0;
 const decisions={aphidsAccessible,W005Visit,W005Delivery,newDetritus,newDetritusSite,W011Visit,W011Delivery,flowerNectar,W017Visit,W017Delivery,W016Visited,W013Repair,rivalsAtF04,predatorSeen,newEggs};
 const deliveries=[];
 if(W005Delivery)deliveries.push({event_id:"V2D9-E03",worker_id:"W005",source_node:"F01",nutrient:"carbohydrate",confirmed_delivery_events:1,delivered_mass_mg:null,qualitative_amount:"少量蜜露"});
 if(W011Delivery)deliveries.push({event_id:"V2D9-E05",worker_id:"W011",source_node:"F07",nutrient:"protein",confirmed_delivery_events:1,delivered_mass_mg:null,qualitative_amount:"獨立新事件的昆蟲殘片"});
 if(W017Delivery)deliveries.push({event_id:"V2D9-E06",worker_id:"W017",source_node:"F08",nutrient:"carbohydrate",confirmed_delivery_events:1,delivered_mass_mg:null,qualitative_amount:"短時花蜜"});
 return {model:V,day,date,rootSeed:fnv(material),seedMaterial:material,named_stream_seeds:seeds,draws_first_twelve_by_stream:streams,weather,decisions,deliveries,confirmed_delivery_count:deliveries.length,model_assumption_warning:"All daily causal event probabilities and nutrient flux magnitudes are uncalibrated/unknown"};
}
module.exports={simulateDay};
if(typeof require!=="undefined"&&require.main===module){const fs=require("fs");process.stdout.write(JSON.stringify(simulateDay(JSON.parse(fs.readFileSync(0,"utf8"))),null,2)+"\n")}

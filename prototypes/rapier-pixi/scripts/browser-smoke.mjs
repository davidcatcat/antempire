import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.argv[2]??'http://localhost:8784/';
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader']});
const results=[];
for(const [name,options] of [
  ['desktop',{viewport:{width:1280,height:850},deviceScaleFactor:1}],
  ['android-touch',{viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}]
]){
  const ctx=await browser.newContext(options);
  const page=await ctx.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.locator('#stats').getByText('AntEmpire vs Rapier 2D').waitFor({timeout:15000}).catch(async()=>{
    const text=await page.locator('#stats').textContent();
    assert.ok(text.includes('AntEmpire vs Rapier 2D'),'bench stats must render');
  });
  const canvas=page.locator('#stage canvas');
  await canvas.waitFor();
  assert.equal(await canvas.count(),1);
  assert.equal(await page.locator('#scenario option').count(),3);
  await page.selectOption('#scenario','inside');
  assert.match(await page.locator('#status').textContent(),/synthetic/);
  await page.locator('#time').evaluate(el=>{el.value='5';el.dispatchEvent(new Event('input',{bubbles:true}))});
  assert.match(await page.locator('#clock').textContent(),/5\.00/);
  assert.deepEqual(errors,[],'uncaught viewer errors');
  fs.mkdirSync('screenshots',{recursive:true});
  await page.screenshot({path:'screenshots/'+name+'.png',fullPage:true});
  results.push({name,canvas:true,scenario:'inside',time_s:5,errors:errors.length});
  await ctx.close();
}
await browser.close();console.log(JSON.stringify({browser_smoke:results}));

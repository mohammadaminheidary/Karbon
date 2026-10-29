// The source fixture and production fixture use the same data and procedure.
const {chromium} = require(process.env.KARBON_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs');
const dir = process.env.KARBON_PERF_DIR, phase = process.argv[2];
const base = process.env.KARBON_TEST_URL || 'http://127.0.0.1:5529';
(async()=>{
 const browser = await chromium.launch({headless:true,...(process.env.KARBON_CHROME_PATH ? {executablePath:process.env.KARBON_CHROME_PATH} : {})});
 const rows=[];
 for(let i=0;i<5;i++) {
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  const login=await context.request.post(base+'/api/login',{data:{username:'customers-test',password:'test-password'}});
  const {token}=await login.json();
  await context.addInitScript(token=>localStorage.setItem('karbon_auth',JSON.stringify({token})),token);
  const page=await context.newPage(), failed=[];
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText}));
  try {
  await page.goto(base+'/page/finance-page.html');
  await page.waitForFunction(()=>document.documentElement.dataset.pageState==='ready',null,{timeout:10000});
  const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Performance.enable');
  let bytes=0,requests=0;cdp.on('Network.loadingFinished',e=>bytes+=e.encodedDataLength);
  page.on('request',r=>{if(r.url().includes('/api/customers'))requests++});
  const start=await page.evaluate(()=>performance.now());
  await page.locator('#recordIncome').click();
  await page.waitForFunction(()=>!document.getElementById('submitTransaction').disabled && document.getElementById('transactionSource').options.length>1,null,{timeout:10000});
  rows.push({ms:await page.evaluate(()=>performance.now())-start,requests,bytes,
    options:await page.locator('#transactionSource option').count(),
    task_ms:(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='TaskDuration').value*1000,failed});
  } catch(error) {rows.push({error:error.message,failed});}
  finally {await context.close();}
 }
 fs.writeFileSync(dir+'/'+phase+'-picker.json',JSON.stringify(rows,null,2));console.log(phase,rows);
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

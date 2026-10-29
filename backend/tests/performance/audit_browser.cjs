// Production-build browser measurements. Only use the isolated performance fixture.
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const phase = process.argv[2];
const dir = path.resolve(process.env.KARBON_PERF_DIR);
const base = process.env.KARBON_TEST_URL || 'http://127.0.0.1:5529';
const routes = {
  dashboard: '/index.html', customers: '/page/customers-page.html',
  orders: '/page/orders-page.html', finance: '/page/finance-page.html',
  banks: '/page/banks-page.html', bank_ledger: '/page/bank-transactions-page.html?bank=1',
  inventory: '/page/warehouse-page.html', tasks: '/page/daily-tasks-page.html',
  settings: '/page/settings-page.html', documents: '/page/documents-page.html',
  attendance: '/page/attendance-page.html', login: '/page/login-page.html',
  settings_products: '/page/settings-page.html#products', settings_invoices: '/page/settings-page.html#invoices',
  settings_members: '/page/settings-page.html#members', settings_banks: '/page/settings-page.html#banks',
  settings_inventory: '/page/settings-page.html#inventory', settings_expenses: '/page/settings-page.html#expenses',
  settings_document_accounts: '/page/settings-page.html#document-accounts',
  settings_appearance: '/page/settings-page.html#appearance', settings_security: '/page/settings-page.html#security',
  settings_backup: '/page/settings-page.html#backup', purchase: '/page/warehouse-page.html#purchase',
};
const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
async function initialize(context, token) {
  await context.addInitScript(token => {
    localStorage.setItem('karbon_auth', JSON.stringify({ token }));
    window.audit = { long: [], errors: [] };
    new PerformanceObserver(list => window.audit.long.push(...list.getEntries().map(e => ({start: e.startTime, duration: e.duration}))))
      .observe({type: 'longtask', buffered: true});
    window.addEventListener('karbon:page-ready', () => {
      window.audit.ready_ms = performance.now();
      document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        window.audit.visible_ms = performance.now();
      })));
    });
    document.addEventListener('focusin', event => {
      if (event.target.id === 'purchaseItemName') window.audit.purchase_focus_ms = performance.now();
    });
    const observer = new MutationObserver(() => {
      const summary = document.getElementById('revenueValue');
      if (summary && /[۰-۹0-9]/.test(summary.textContent) && !window.audit.content_scheduled) {
        window.audit.content_scheduled = true;
        requestAnimationFrame(() => requestAnimationFrame(() => { window.audit.content_ms = performance.now(); }));
      }
    });
    observer.observe(document, {subtree:true, childList:true, characterData:true});
  }, token);
}
async function scrollAll(page) {
  return page.evaluate(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * .8) {
      scrollTo(0, y); await frame();
    }
    await frame();
    return { all_widgets_ms: performance.now(), charts: document.querySelectorAll('[data-chart]').length,
      widgets: document.querySelectorAll('.dash-widget').length, dom_nodes: document.querySelectorAll('*').length };
  });
}
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.KARBON_CHROME_PATH ? {executablePath:process.env.KARBON_CHROME_PATH} : {})});
  const login = await browser.newContext();
  const response = await login.request.post(base + '/api/login', {data:{username:'customers-test',password:'test-password'}});
  if (!response.ok()) throw new Error('Fixture login failed: ' + response.status());
  const {token} = await response.json();
  fs.writeFileSync(path.join(dir, phase + '-token'), token);
  await login.close();
  const results = [], rounds = Number(process.env.KARBON_PERF_ROUNDS || 5);
  for (const [name, route] of Object.entries(routes)) {
    if (process.env.KARBON_PERF_ROUTES && !process.env.KARBON_PERF_ROUTES.split(',').includes(name)) continue;
    for (const mode of ['cold','warm']) {
      let context;
      for (let i = 0; i < rounds + (mode === 'warm' ? 1 : 0); i++) {
        if (mode === 'cold' || !context) {
          await context?.close();
          context = await browser.newContext({viewport:{width:1440,height:1100}});
          await initialize(context, token);
        }
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', {cacheDisabled:mode === 'cold'});
        await cdp.send('Performance.enable');
        const row = {name,mode,iteration:i,network:0,network_bytes:0,api:[],errors:[],failed:[]};
        page.on('request', () => row.network++);
        page.on('pageerror', e => row.errors.push(e.message));
        page.on('requestfailed', r => row.failed.push({url:r.url(),error:r.failure()?.errorText}));
        page.on('response', r => {
          if (r.status() >= 400) row.failed.push({url:r.url(),status:r.status()});
          if (r.url().includes('/api/')) row.api.push({url:new URL(r.url()).pathname,
            count:Number(r.headers()['x-perf-count'] || 0),sql_ms:Number(r.headers()['x-perf-sql-ms'] || 0)});
        });
        cdp.on('Network.loadingFinished', e => row.network_bytes += e.encodedDataLength);
        try {
          await page.goto(base + route, {waitUntil:'domcontentloaded'});
          await page.waitForFunction(() => window.audit?.visible_ms, {timeout:20000});
          if (name === 'purchase') {
            await page.waitForFunction(() => window.audit.purchase_focus_ms && document.getElementById('purchaseEntryPage').getAttribute('aria-busy') === 'false');
            await page.evaluate(frames);
            await page.evaluate(() => { window.audit.visible_ms = performance.now(); });
          }
          // Evaluate at the same paint boundary in each phase; include currently visible widgets.
          Object.assign(row, await page.evaluate(() => ({...window.audit,
            fcp_ms:performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
            resources:performance.getEntriesByType('resource').map(e => ({name:new URL(e.name).pathname,
              start:e.startTime,end:e.responseEnd,duration:e.duration,bytes:e.encodedBodySize,transfer:e.transferSize})),
            overflow:document.documentElement.scrollWidth > innerWidth,
            visible_charts: [...document.querySelectorAll('[data-chart]')].filter(e => e.getBoundingClientRect().top < innerHeight).length,
            initial_dom_nodes:document.querySelectorAll('*').length,
          })));
          const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name,x.value]));
          for (const key of ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration']) row[key + '_ms'] = metrics[key]*1000;
          row.heap_mb = metrics.JSHeapUsedSize/1048576;
          row.initial_network = row.network; row.initial_bytes = row.network_bytes;
          row.initial_api = row.api.map(request => ({...request}));
          if (name === 'dashboard') {
            Object.assign(row, await scrollAll(page));
            await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-state], [data-detail-state]')]
              .every(e => (!e.dataset.chartState || e.dataset.chartState === 'ready') && (!e.dataset.detailState || e.dataset.detailState === 'ready')), null, {timeout:5000});
            row.all_widgets_ms = await page.evaluate(() => performance.now());
            row.dom_nodes = await page.evaluate(() => document.querySelectorAll('*').length);
            const all = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
            row.all_task_ms = all.TaskDuration * 1000;
            row.all_layout_ms = all.LayoutDuration * 1000;
            row.all_script_ms = all.ScriptDuration * 1000;
          }
          row.longtask_ms = row.long.reduce((sum,e)=>sum+e.duration,0);
          row.blocking_ms = row.long.reduce((sum,e)=>sum+Math.max(0,e.duration-50),0);
        } catch(e) {
          row.error = e.message;
          row.state = await page.evaluate(() => ({ready:document.readyState,state:document.documentElement.dataset.pageState,
            notice:document.getElementById('pageStartupError')?.textContent})).catch(()=>null);
        }
        if (!(mode === 'warm' && i === 0)) results.push(row);
        row.valid = !row.error && !row.errors.length && !row.failed.length;
        if (row.error) console.log('FAILED TRIAL', JSON.stringify(row));
        await page.close();
      }
      await context?.close();
    }
    const rows = results.filter(r=>r.name===name);
    console.log(name, JSON.stringify(rows.map(r=>({mode:r.mode,ready:r.ready_ms,visible:r.visible_ms,error:r.error,failed:r.failed}))));
    fs.writeFileSync(path.join(dir, phase + '-pages.json'), JSON.stringify({browser:browser.version(),results}, null,2));
  }
  // A separate traced trial avoids profiler overhead in the timing trials.
  const context = await browser.newContext({viewport:{width:1440,height:1100}});
  await initialize(context, token);
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  await cdp.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing,loading,v8.execute,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'});
  await page.goto(base + '/index.html');
  await page.waitForFunction(()=>window.audit?.visible_ms);
  await page.evaluate(frames);
  const {profile} = await cdp.send('Profiler.stop');
  fs.writeFileSync(path.join(dir,phase + '-cpu-profile.json'),JSON.stringify(profile));
  const completed = new Promise(resolve => cdp.once('Tracing.tracingComplete',resolve));
  await cdp.send('Tracing.end'); const {stream} = await completed;
  let trace=''; for (;;) {const chunk=await cdp.send('IO.read',{handle:stream});trace+=chunk.data;if(chunk.eof) break;}
  await cdp.send('IO.close',{handle:stream});
  fs.writeFileSync(path.join(dir,phase+'-trace.json'),trace);
  await context.close(); await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

/*
 * Run against serve_customers_fixture.py --invoice-designer --orders --finance
 * --customers 2. Set KARBON_FRONTEND_URL, KARBON_CHROME_PATH and KARBON_TEST_PDF
 * to use a different fixture, browser executable or PDF output path.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const base = process.env.KARBON_FRONTEND_URL || "http://127.0.0.1:5501";
const executable = process.env.KARBON_CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "chromium");
const profile = await mkdtemp(join(tmpdir(), "karbon-invoice-chrome-"));
const chrome = spawn(executable, ["--headless", "--remote-debugging-pipe", "--no-first-run",
  "--disable-background-networking", "--user-data-dir=" + profile],
{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let failure;
chrome.on("error", (error) => { failure = error; });
const pending = new Map();
const exceptions = [];
let buffer = "";
let sequence = 0;
chrome.stdio[4].on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\0")) >= 0) {
    const reply = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (reply.method === "Runtime.exceptionThrown") exceptions.push(reply.params.exceptionDetails);
    pending.get(reply.id)?.(reply);
  }
});
function send(method, params = {}, sessionId) {
  if (failure) throw failure;
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      pending.delete(id);
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result);
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}

const headers = { "Content-Type": "application/json" };
async function api(method, path, body, expected = 200) {
  const response = await fetch(base + "/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}

try {
  const login = await api("POST", "/login", { username: "admin", password: "test-password" });
  headers.Authorization = `Bearer ${login.token}`;
  const original = await api("GET", "/settings/invoice-design");
  const standard = await api("GET", "/settings/invoice-design/templates/standard/sale");
  const defaults = original.templates.find((template) => template.kind === "sale" && template.default);
  await api("PUT", `/settings/invoice-design/templates/${defaults.id}`,
    { name: defaults.name, revision: defaults.revision, layout: standard });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let tries = 0; tries < 100; tries++) {
      const result = await evaluate(expression);
      if (result) return result;
      await pause(100);
    }
    throw new Error(`Timed out: ${expression}\n${await evaluate("document.body.innerText.slice(-2500)")}`);
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const source = "http://127.0.0.1";
  assert.equal(new URL(base).hostname, new URL(source).hostname, "Use the loopback fixture");
  await cdp("Page.navigate", { url: base + "/page/login-page.html" });
  await wait("location.href.includes('/page/login-page.html')");
  await evaluate(`localStorage.setItem('karbon_auth', JSON.stringify({token:${JSON.stringify(login.token)}}))`);
  await cdp("Page.navigate", { url: base + "/page/settings-page.html#invoice-settings" });
  await wait("document.querySelector('#invoice-config-store')");
  await evaluate(`(() => {
    const name = document.querySelector('.invoice-settings-section input');
    name.value = 'فروشگاه آزمایش 123';
    name.dispatchEvent(new Event('change', {bubbles:true}));
    const picker = document.querySelector('input[type=file]');
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAADwAAAAUCAIAAABeYcl+AAAAPklEQVR4nNXOQREAIAzAsFIrSEEX3vGwD9coyNrnUiNBEiRBEiRBEiRBEiRBEiRBEiRBEiRBEiRBEuTvwMQDsYMBC4T/cAAAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'logo.png', {type:'image/png'}));
    picker.files = transfer.files;
    picker.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await wait("document.querySelector('.invoice-asset-preview')?.src.startsWith('data:image/png')");
  await evaluate("document.querySelector('.invoice-settings-header button').click()");
  await wait("document.querySelector('.invoice-settings-header [role=status]').textContent === 'تنظیمات ذخیره شد.'");
  const config = await api("GET", "/settings/invoice-design");
  assert.equal(config.store.name, "فروشگاه آزمایش 123");
  assert.ok(config.store.logo);
  await click("#invoice-config-designer");
  await evaluate("document.querySelector('#invoiceConfigurationPanel button').click()");
  await wait("document.querySelector('.invoice-designer[open]')");
  await evaluate("Array.from(document.querySelectorAll('.designer-toolbar button')).find(b => b.textContent === '+ متن').click()");
  const newId = await wait("document.querySelector('.designer-paper .invoice-element--text')?.dataset.element");
  const coordinates = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  async function drag(selector, dx, dy) {
    const { x, y } = await coordinates(selector);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx, y: y + dy, button: "left", buttons: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "left", buttons: 0, clickCount: 1 });
  }
  const block = `[data-element="${newId}"]`;
  const left = await evaluate(`document.querySelector('${block}').style.left`);
  await drag(block, 28, -24);
  assert.notEqual(await evaluate(`document.querySelector('${block}').style.left`), left);
  const width = await evaluate(`document.querySelector('${block}').style.width`);
  await drag(".designer-handle-se", 32, 18);
  assert.notEqual(await evaluate(`document.querySelector('${block}').style.width`), width);
  await click(".designer-floating > button");
  await wait("!document.querySelector('.designer-element-menu').hidden");
  await evaluate("Array.from(document.querySelectorAll('.designer-element-menu button')).find(b => b.textContent === 'قفل').click()");
  await wait("document.querySelector('.designer-paper .invoice-element--text').classList.contains('designer-locked')");
  await click(".designer-layer-active button:last-child");
  await wait("!document.querySelector('.designer-paper .invoice-element--text').classList.contains('designer-locked')");
  await click(".designer-layer-active button:nth-child(2)");
  await wait("!document.querySelector('.designer-paper .invoice-element--text')");
  await click(".designer-layer-active button:nth-child(2)");
  await wait("document.querySelector('.designer-paper .invoice-element--text')");
  const keyboard = (key, modifiers) => evaluate(`document.querySelector('.designer-viewport').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)}, bubbles:true,${modifiers}}))`);
  await keyboard("d", "ctrlKey:true");
  assert.equal(await evaluate("document.querySelectorAll('.designer-paper .invoice-element--text').length"), 2);
  await keyboard("z", "metaKey:true");
  assert.equal(await evaluate("document.querySelectorAll('.designer-paper .invoice-element--text').length"), 1);
  await keyboard("z", "ctrlKey:true,shiftKey:true");
  assert.equal(await evaluate("document.querySelectorAll('.designer-paper .invoice-element--text').length"), 2);
  await keyboard("Delete", "");
  assert.equal(await evaluate("document.querySelectorAll('.designer-paper .invoice-element--text').length"), 1);
  await wait("document.querySelector('.designer-heading [role=status]').textContent === 'ذخیره شده'");
  const templateId = config.templates.find((row) => row.kind === "sale").id;
  const changed = await api("GET", `/settings/invoice-design/templates/${templateId}`);
  assert.ok(changed.layout.elements.some((element) => element.id === newId));
  await evaluate("Array.from(document.querySelectorAll('.designer-heading button')).find(b => b.textContent === 'خروج').click()");
  await wait("!document.querySelector('.invoice-designer')");
  const timeOrigin = await evaluate("performance.timeOrigin");
  await cdp("Page.reload");
  await wait(`performance.timeOrigin !== ${timeOrigin} && document.querySelector('#invoice-config-designer')`);
  await click("#invoice-config-designer");
  await evaluate("document.querySelector('#invoiceConfigurationPanel button').click()");
  await wait(`document.querySelector('${block}')`);
  await evaluate("Array.from(document.querySelectorAll('.designer-heading button')).find(b => b.textContent === 'خروج').click()");
  await wait("!document.querySelector('.invoice-designer')");

  const references = await api("GET", "/orders/next-number");
  const products = await api("GET", "/products");
  const parties = await api("GET", "/customers/options");
  const name = ("بسته کاغذ تحریر سفید مخصوص چاپ دورو ").repeat(4).trim();
  const service = await api("POST", "/products", { name, unit: "عدد", price: 1000 }, 201).catch(async () => {
    return (await api("GET", "/products")).find((product) => product.name === name);
  });
  const tracked = products.find((product) => product.stock != null);
  const day = references.business_jalali;
  const order = await api("POST", "/orders", {
    request_id: randomUUID(), customer_id: parties.items[0].id, invoice_date: day, payment_date: day,
    items: Array.from({ length: 65 }, () => ({ product_id: service.id, quantity: 1, unit_price: 1000 })),
    description: "توضیحات فاکتور واقعی و شماره مرجع 123",
  }, 201);
  const purchase = await api("POST", "/purchases", {
    request_id: randomUUID(), purchase_date: day, supplier_id: parties.items[1].id,
    rows: [{ category_id: tracked.category_id, product_id: tracked.id, quantity: 3, purchase_price: 700 }],
  }, 201);
  const purchaseInvoice = await api("GET", `/purchases/${purchase.id}/invoice`);
  assert.equal(purchaseInvoice.presentation.kind, "purchase");
  assert.equal(purchaseInvoice.total, 2100);
  assert.ok(purchaseInvoice.supplier.name);
  await click("#settings-tab-invoices");
  await evaluate(`(() => {
    const kind = document.querySelector('#settingsInvoicesKind');
    kind.value = 'purchase';
    kind.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  const purchaseButton = await wait(`Array.from(document.querySelectorAll('#settingsInvoicesList article')).find(row =>
    row.querySelector('bdi')?.textContent === ${JSON.stringify(purchase.invoice_number)})?.querySelector('button') !== undefined`);
  assert.ok(purchaseButton);
  await evaluate(`Array.from(document.querySelectorAll('#settingsInvoicesList article')).find(row =>
    row.querySelector('bdi')?.textContent === ${JSON.stringify(purchase.invoice_number)}).querySelector('button').click()`);
  await wait("document.querySelector('#finalInvoicePages .invoice-product-table tbody tr')");

  const openSale = `import('/src/js/orders/invoice-export.js').then(m => m.showFinalInvoice(${order.id}))`;
  await evaluate(openSale);
  const invoice = await api("GET", `/orders/${order.id}/invoice`);
  assert.equal(invoice.total, 65000);
  const count = await wait("document.querySelectorAll('#finalInvoicePages .invoice-paper').length");
  assert.ok(count > 2);
  assert.equal(await evaluate("document.querySelectorAll('#finalInvoicePages tbody tr').length"), 65);
  assert.equal(await evaluate("document.querySelectorAll('#finalInvoicePages thead').length"),
    await evaluate("document.querySelectorAll('#finalInvoicePages table').length"));
  assert.ok(await evaluate("document.querySelector('#finalInvoicePages td').getBoundingClientRect().height / new DOMMatrix(getComputedStyle(document.querySelector('#finalInvoicePages .invoice-paper')).transform).a > 40"));
  assert.equal(await evaluate("document.querySelector('#finalInvoicePages .invoice-element--number bdi').textContent"), invoice.invoice_code);
  assert.ok(await evaluate("document.querySelector('#finalInvoicePages .invoice-element--logo img').naturalWidth"));
  const safety = await evaluate(`import('/src/js/invoices/invoice-paper.js').then(async m => {
    const [canvas] = await m.rasterizeInvoicePages([document.querySelector('#finalInvoicePages .invoice-paper')]);
    return canvas.getContext('2d').getImageData(25,25,1,1).data[3] === 255;
  })`);
  assert.ok(safety, "Optional PNG export renders actual content");

  await evaluate("window.print = () => {}; document.querySelector('#pdfFinalInvoice').click()");
  await wait("document.querySelector('#invoiceDesignerPrint .invoice-paper')");
  const { data } = await cdp("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
  const pdf = Buffer.from(data, "base64");
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  if (process.env.KARBON_TEST_PDF) await writeFile(process.env.KARBON_TEST_PDF, pdf);
  const issuedMarkup = await evaluate("Array.from(document.querySelectorAll('#finalInvoicePages .invoice-paper-content'), page => page.innerHTML)");
  await evaluate("window.dispatchEvent(new Event('afterprint'))");
  await api("PUT", `/settings/invoice-design/templates/${templateId}`, {
    name: changed.name, revision: changed.revision, layout: { ...changed.layout, elements: [] },
  });
  const update = Object.fromEntries(["store", "signatures", "purchase_finance", "purchase_numbering",
    "sale_finance", "sale_numbering", "revision"].map((key) => [key, config[key]]));
  update.store = { ...update.store, logo: null, name: "نام تغییر کرده" };
  await api("PUT", "/settings/invoice-design", update);
  await evaluate(openSale);
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#finalInvoicePages .invoice-paper-content'), page => page.innerHTML)"), issuedMarkup);
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log(`Invoice browser workflow passed; printed ${count} pages from 65 issued sales rows and verified purchase preview.`);
} finally {
  chrome.kill();
  await new Promise((resolve) => { if (chrome.exitCode !== null || failure) resolve(); else chrome.once("exit", resolve); });
  await rm(profile, { recursive: true, force: true });
}

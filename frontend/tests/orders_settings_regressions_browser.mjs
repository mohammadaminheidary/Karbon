// Disposable fixture: serve_customers_fixture.py --customers 25 --orders --finance --members 2 --invoice-designer.
// Pass --baseline to record the same scenarios on 7c0e0e2, including known regressions.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fillPurchaseRow } from "./purchase-browser-helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5527";
const baseline = process.argv.includes("--baseline");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH ? { executablePath: process.env.KARBON_CHROME_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const date = "1405/08/09";
const editForm = "#createOrderModal[open]";
const body = `${editForm} .orders-dialog-body`;
const details = page.locator("#orderDetailsModal");
const rows = page.locator("#orderItems .orders-item-row");
const money = (value) => `${new Intl.NumberFormat("fa-IR").format(value)} تومان`;
const go = (path) => page.goto(`${base}/page/${path}`);
const card = (id) => page.locator(`.orders-panel:not([hidden]) [data-order-id="${id}"] .orders-card-open`);
let token, customer, saleProduct, purchaseProduct, restoreFinance;

async function api(method, path, data, auth = token) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method,
    data,
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

function sale(count, fields) {
  return api("POST", "/orders", {
    request_id: crypto.randomUUID(), customer_id: customer.id, invoice_date: date, payment_date: date,
    items: Array.from({ length: count }, () => ({ product_id: saleProduct.id, quantity: 1, unit_price: 105 })),
    payments: [], ...fields,
  });
}

function refreshOrders() {
  return page.evaluate(async () => {
    const { publishDataChange, publishLocalDataChange } = await import("/src/js/components/data-events.js");
    publishDataChange();
    publishLocalDataChange();
  });
}

async function openOrder(id) {
  await card(id).click();
  await details.locator("#editOrderDetails").waitFor();
  await page.waitForFunction(() => document.querySelector("#orderDetailsModal").contains(document.activeElement));
}

async function readyForm() {
  await page.waitForFunction((selector) => {
    const form = document.querySelector(selector);
    return form && !form.dataset.morph && !form.querySelector("#orderFields").disabled;
  }, editForm);
}

async function measureOutputs(action) {
  await page.locator("#orderFields").evaluate((fields) => {
    window.outputObserver = new MutationObserver((records) => window.outputRecords.push(...records));
    window.outputRecords = [];
    window.outputObserver.observe(fields, { childList: true, subtree: true });
  });
  await action();
  return page.evaluate(() => {
    const records = window.outputRecords.concat(window.outputObserver.takeRecords());
    window.outputObserver.disconnect();
    return records.filter(({ target }) => target.matches?.("output"))
      .map(({ target }) => target.id || [...document.querySelectorAll(".item-total")].indexOf(target));
  });
}

async function measureForms() {
  for (const kind of ["sale", "purchase"]) {
    for (const count of [1, 20, 50]) {
      if (kind === "sale") {
        const order = await sale(count);
        await go("orders-page.html");
        await openOrder(order.id);
        await details.locator("#editOrderDetails").click();
      } else {
        const purchase = await api("POST", "/purchases", {
          request_id: crypto.randomUUID(), catalog_only: true, purchase_date: date,
          rows: Array.from({ length: count }, () => ({
            product_id: purchaseProduct.id, category_id: purchaseProduct.warehouse_category_id, quantity: 1, purchase_price: 105,
          })),
        });
        await go(`warehouse-page.html#purchase-edit-${purchase.id}`);
      }
      await readyForm();
      assert.equal(await rows.count(), count);
      const index = Math.floor(count / 2);
      const quantity = rows.nth(index).locator(".item-quantity");
      await quantity.focus();
      const qty = await measureOutputs(() => quantity.fill("2"));
      const discount = page.locator("#orderDiscount");
      await discount.focus();
      const disc = await measureOutputs(() => discount.fill("1"));
      const counts = (records) => `${records.filter(Number.isInteger).length} row + ${records.filter((key) => typeof key === "string").length} totals`;
      console.log(`${kind} ${count} rows: quantity ${counts(qty)}, discount ${counts(disc)}`);
      if (!baseline) {
        assert.deepEqual(qty.sort(), [index, "orderQuantityTotal", "orderSubtotal", "orderTotal"].sort());
        assert.deepEqual(disc.sort(), ["orderDiscountAmount", "orderTotal"]);
      }
      assert.equal(await page.locator("#orderTotal").textContent(), money((count + 1) * 105 - 1));
      await page.locator(`${editForm} header [data-dialog-close]`).click();
      await page.locator(editForm).waitFor({ state: "hidden" });
    }
  }
}

async function checkFocus() {
  const order = await sale(1);
  await go("orders-page.html");
  const closeMethods = {
    header: () => details.locator("header [data-dialog-close]").click(),
    Escape: () => page.keyboard.press("Escape"),
    backdrop: () => details.locator(".orders-backdrop").click({ position: { x: 5, y: 5 } }),
  };
  for (const [method, close] of Object.entries(closeMethods)) {
    for (const removed of [false, true]) {
      const target = removed ? await sale(1) : order;
      if (removed) {
        await refreshOrders();
        await card(target.id).waitFor();
      }
      await openOrder(target.id);
      const before = await card(target.id).elementHandle();
      if (removed) await api("POST", `/orders/${target.id}/complete`);
      else await sale(1);
      await refreshOrders();
      await page.waitForFunction((button) => !button.isConnected, before);
      if (!removed) await card(target.id).waitFor();
      await close();
      await details.waitFor({ state: "hidden" });
      const focused = await page.evaluate(() => ({
        order: document.activeElement.matches(".orders-card-open")
          ? document.activeElement.closest("[data-order-id]").dataset.orderId : null,
        id: document.activeElement.id,
      }));
      const restored = removed ? focused.id === "orderSearchInput" : focused.order === String(target.id);
      console.log(`focus ${method}, ${removed ? "missing" : "rebuilt"} card: ${restored}`);
      if (!baseline) assert.equal(restored, true);
      await before.dispose();
    }
  }
}

async function checkPickerAndDirection() {
  const order = await sale(20);
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    storageState: await page.context().storageState(),
  });
  mobile.on("pageerror", (error) => errors.push(error.message));
  const anchor = mobile.locator(".item-product").first();
  const menu = mobile.locator(`${editForm} .orders-picker-dropdown:has(#orderProductOptions)`);
  try {
    await mobile.goto(`${base}/page/orders-page.html`);
    await mobile.locator(`[data-order-id="${order.id}"] .orders-card-open`).click();
    await mobile.locator("#editOrderDetails").click();
    await mobile.locator(`${editForm}:not([data-morph]) #orderPay:enabled`).waitFor();
    const directions = await mobile.locator("#orderDescription").evaluate((field) => {
      const cases = [[null, "فارسی ABC"], ["rtl", "ABC فارسی"], ["ltr", "فارسی ABC"],
        ["auto", "فارسی ABC"], ["auto", "ABC فارسی"]];
      const directions = cases.map(([dir, value]) => {
        if (dir) field.dir = dir;
        else field.removeAttribute("dir");
        field.value = value;
        return getComputedStyle(field).direction;
      });
      field.removeAttribute("dir");
      return directions;
    });
    console.log(`textarea default/rtl/ltr/auto-RTL/auto-LTR: ${directions.join(", ")}`);
    if (!baseline) assert.deepEqual(directions, ["ltr", "rtl", "ltr", "rtl", "ltr"]);

    await anchor.click();
    await menu.waitFor();
    const reads = await anchor.evaluate(async (field) => {
      const scroller = field.closest(".orders-dialog-body");
      const table = field.closest(".orders-table-scroll");
      // Let the browser finish any scroll caused by the click before counting.
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
      const rect = field.getBoundingClientRect;
      let reads = 0;
      field.getBoundingClientRect = () => { reads++; return rect.call(field); };
      try {
        for (let frame = 0; frame < 3; frame++) {
          await new Promise(requestAnimationFrame);
          for (let burst = 0; burst < 3; burst++) {
            scroller.dispatchEvent(new Event("scroll"));
            table.dispatchEvent(new Event("scroll"));
            window.dispatchEvent(new Event("resize"));
            visualViewport.dispatchEvent(new Event("resize"));
          }
        }
        await new Promise(requestAnimationFrame);
        return reads;
      } finally {
        delete field.getBoundingClientRect;
      }
    });
    console.log(`product picker: ${reads} position calls for 36 events over 3 frames`);
    if (!baseline) assert.equal(reads, 3);

    // Read native popover state in the opening click's own event handler.
    await anchor.press("Escape");
    const immediate = await anchor.evaluate((field) => {
      field.click();
      return field.closest("dialog").querySelector(".orders-picker-dropdown:has(#orderProductOptions)").matches(":popover-open");
    });
    assert.equal(immediate, true);
    await mobile.locator(`${editForm} .orders-table-scroll`).evaluate((table) => { table.scrollLeft = -table.scrollWidth; });
    await menu.waitFor({ state: "hidden" });

    await anchor.click();
    await menu.waitFor();
    const before = await menu.boundingBox();
    await mobile.setViewportSize({ width: 360, height: 740 });
    await mobile.waitForFunction(([selector, from]) => {
      const menu = document.querySelector(selector);
      if (!menu.matches(":popover-open")) return false;
      const rect = menu.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= visualViewport.width && rect.bottom <= visualViewport.height &&
        [rect.x, rect.y, rect.width, rect.height].some((value, index) => Math.abs(value - from[index]) > 1);
    }, [`${editForm} .orders-picker-dropdown:has(#orderProductOptions)`, [before.x, before.y, before.width, before.height]]);
    await mobile.locator(body).evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
    await menu.waitFor({ state: "hidden" });
    console.log("PASS picker immediate open, horizontal clipping, mobile viewport resize and vertical clipping");
  } finally {
    await mobile.close();
  }
}

async function checkSettings() {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await go("settings-page.html#general");
  await page.locator('#settings-tab-general[aria-current="true"]').waitFor();
  const navigation = page.locator("#settingsNavigation");
  const reads = await navigation.evaluate(async (nav) => {
    const frames = async () => {
      for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    };
    await frames();
    const rect = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function () {
      if (this === nav || (nav.contains(this) && this.matches("[data-settings-target], .settings-nav-indicator"))) reads++;
      return rect.call(this);
    };
    const select = (id) => nav.querySelector(`[data-settings-target="${id}"]`).click();
    try {
      select("members");
      select("security");
      await frames();
      select("banks");
      await frames();
      const group = nav.querySelector('[data-settings-target="banks"]').closest("details");
      const summary = group.querySelector("summary");
      const indicator = nav.querySelector(".settings-nav-indicator");
      summary.click();
      await frames();
      if (!indicator.hidden) throw new Error("Closed settings group still shows indicator");
      summary.click();
      await frames();
      if (indicator.hidden) throw new Error("Reopened settings group lost indicator");
      if (indicator.getAnimations().length) throw new Error("Indicator animated with reduced motion");
      return reads;
    } finally {
      Element.prototype.getBoundingClientRect = rect;
    }
  });
  console.log(`settings: ${reads} geometry reads for rapid selection and two group toggles`);
  if (!baseline) assert.ok(reads <= 16, `settings read geometry ${reads} times`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await go("orders-page.html");
  await go("settings-page.html#security");
  await navigation.locator('[data-settings-target="security"][aria-current="true"]:visible').waitFor();
  await page.evaluate(() => { location.hash = "banks"; });
  await navigation.locator('[data-settings-target="banks"][aria-current="true"]:visible').waitFor();
  await page.goBack();
  const selected = navigation.locator('[data-settings-target="security"][aria-current="true"]:visible');
  await selected.waitFor();
  await page.waitForFunction(() => {
    const nav = document.querySelector("#settingsNavigation");
    const indicator = nav.querySelector(".settings-nav-indicator").getBoundingClientRect();
    const button = nav.querySelector('[aria-current="true"]').getBoundingClientRect();
    return ["x", "y", "width", "height"].every((key) => Math.abs(indicator[key] - button[key]) < 1);
  });
  console.log("PASS settings direct link and browser back");
}

async function checkFinance() {
  const { token: admin } = await api("POST", "/login", { username: "admin", password: "test-password" }, null);
  const path = "/settings/invoice-design";
  const config = await api("GET", path, null, admin);
  const keys = ["revision", "store", "signatures", "sale_finance", "purchase_finance", "sale_numbering", "purchase_numbering"];
  const original = Object.fromEntries(keys.map((key) => [key, config[key]]));
  for (const kind of ["sale_finance", "purchase_finance"]) {
    config[kind] = { ...config[kind], tax_enabled: true, tax_rate: 2500 };
  }
  const settings = await api("PUT", path, Object.fromEntries(keys.map((key) => [key, config[key]])), admin);
  restoreFinance = () => api("PUT", path, { ...original, revision: settings.revision }, admin);

  const address = "خیابان اصلی، واحد ۱۲ ABC";
  const old = await sale(1, { delivery_address: address, discount: 11 });
  await go("orders-page.html");
  await openOrder(old.id);
  await details.getByText(address, { exact: true }).waitFor();
  await details.locator("#editOrderDetails").click();
  await readyForm();
  assert.equal(await page.locator("#orderDeliveryAddress").count(), 0);
  assert.equal(await page.locator("#orderTotal").textContent(), money(old.total));
  await page.locator("#orderDescription").fill("ویرایش سفارش قدیمی");
  const submit = async (endpoint, method) => {
    await page.locator("#orderPay").click();
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api${endpoint}`) && response.request().method() === method);
    await page.locator("#finalizeOrder").click();
    const response = await saved;
    assert.ok(response.ok(), await response.text());
    return { payload: response.request().postDataJSON(), result: await response.json() };
  };
  const { payload, result } = await submit(`/orders/${old.id}`, "PUT");
  assert.equal(payload.delivery_address, address);
  assert.deepEqual(payload.items, [{ product_id: saleProduct.id, quantity: 1, unit_price: 105 }]);
  const refetched = await api("GET", `/orders/${old.id}`);
  const invoice = await api("GET", `/orders/${old.id}/invoice`);
  for (const order of [old, result, refetched, invoice]) {
    assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [105, 11, 24, 118]);
  }
  assert.equal(refetched.delivery_address, address);
  assert.equal(invoice.delivery_address, address);

  await go("warehouse-page.html#purchase");
  await readyForm();
  await page.locator("#orderPay").click();
  await page.locator(`${editForm} .orders-error`).getByText(/برای تمام ردیف‌ها کالا انتخاب کنید/).waitFor();
  assert.equal(await rows.first().locator(".item-product").getAttribute("aria-invalid"), "true");
  await fillPurchaseRow(page, purchaseProduct, 1, 105);
  await page.locator('#orderDiscountKind input[value="percent"]').check();
  await page.locator("#orderDiscountPercent").fill("۱۰");
  for (const [id, amount] of [["orderDiscountAmount", 11], ["orderTax", 24], ["orderTotal", 118]]) {
    assert.equal(await page.locator(`#${id}`).textContent(), money(amount));
  }
  const purchase = await submit("/purchases", "POST");
  assert.deepEqual(purchase.payload.rows, [{
    product_id: purchaseProduct.id, category_id: purchaseProduct.warehouse_category_id, quantity: 1, purchase_price: 105,
  }]);
  assert.equal(purchase.payload.discount, 11);
  for (const order of [purchase.result, await api("GET", `/purchases/${purchase.result.id}`)]) {
    assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [105, 11, 24, 118]);
  }
  console.log("PASS legacy delivery address and total after editing and refetch; rounding, validation and purchase payload");
}

try {
  ({ token } = await api("POST", "/login", { username: "customers-test", password: "test-password" }));
  await page.addInitScript((value) => {
    if (!localStorage.getItem("karbon_auth")) localStorage.setItem("karbon_auth", JSON.stringify({ token: value }));
    // Records seeded through the request client do not notify this browser tab.
    sessionStorage.removeItem("karbon-api-cache-v1");
  }, token);
  customer = (await api("GET", "/customers?limit=1")).items[0];
  saleProduct = (await api("GET", "/products")).find((item) => item.stock === null);
  [purchaseProduct] = await api("GET", "/inventory/products");
  await measureForms();
  await checkFocus();
  await checkPickerAndDirection();
  await checkSettings();
  await checkFinance();
  assert.deepEqual(errors, []);
} finally {
  try {
    await restoreFinance?.();
  } finally {
    await browser.close();
  }
}

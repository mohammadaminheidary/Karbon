// Compare the normal Create Order and warehouse workflows in the same browser.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { advancePurchasePayment, fillPurchaseRow, waitForPurchaseForm } from "./purchase-browser-helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5519";
const browser = await chromium.launch({ headless: true, executablePath: process.env.KARBON_CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.panelMotion = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, timing) {
    if (this.id === "createOrderModal") window.panelMotion.push({ frames, timing });
    return animate.call(this, frames, timing);
  };
});
const ready = () => page.locator('html[data-page-state="ready"]').waitFor();
const settled = () => page.locator("#createOrderModal[open]:not([data-morph])").waitFor();
const motions = () => page.evaluate(() => window.panelMotion);
const shape = () => page.evaluate(() => {
  const panel = document.querySelector("#createOrderModal");
  const grid = panel.querySelector(".orders-items-table");
  const rect = panel.getBoundingClientRect();
  return {
    classes: panel.className,
    width: Math.round(rect.width),
    tableClasses: grid.className,
    headers: [...grid.querySelectorAll("th")].map((item) => item.textContent),
    fits: rect.left >= 0 && rect.right <= innerWidth && panel.scrollWidth <= panel.clientWidth + 1,
  };
});
const paymentShape = () => page.evaluate(() => {
  const panel = document.querySelector("#orderPaymentModal .orders-glass");
  return {
    classes: panel.className.replace(/scale-\d+|opacity-\d+/g, "").trim(),
    width: Math.round(panel.getBoundingClientRect().width),
    methods: [...panel.querySelectorAll(".orders-method-choice")].map((item) => item.textContent),
  };
});

try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator("button[type=submit]").click();
  await page.waitForURL("**/index.html");

  await page.goto(`${base}/page/orders-page.html`);
  await ready();
  await page.locator(".orders-create").click();
  await settled();
  await waitForPurchaseForm(page);
  const saleMotion = await motions();
  assert.ok(saleMotion.length > 0);
  const saleForm = await shape();
  await page.locator("#orderCustomerSearch").click();
  await page.locator("#orderCustomerOptions button").first().click();
  await page.locator("#orderCustomerDetails").waitFor();
  await page.locator(".item-product").first().fill("چاپ کارت");
  await page.locator("#orderProductOptions .orders-product-option").first().click();
  await advancePurchasePayment(page);
  const salePayment = await paymentShape();

  await page.goto(`${base}/page/warehouse-page.html`);
  await ready();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/settings/inventory-options", async (route) => {
    await hold;
    await route.continue();
  });
  await page.locator("#buyItemsButton").click();
  await settled();
  assert.equal(await page.locator("#orderPay").isDisabled(), true);
  assert.deepEqual(await motions(), saleMotion);
  assert.deepEqual(await shape(), saleForm);
  release();
  await waitForPurchaseForm(page);
  await page.unroute("**/api/settings/inventory-options");
  const item = await page.evaluate(async () => {
    const { financeRequest } = await import("/src/js/finance/finance-api.js");
    return (await financeRequest("/inventory/products?catalog_only=true")).find((item) => item.name === "چاپ کارت");
  });
  await fillPurchaseRow(page, item, 2, 725);
  await advancePurchasePayment(page);
  assert.deepEqual(await paymentShape(), salePayment);
  await page.locator("#editOrderInvoice").click();
  await settled();
  await waitForPurchaseForm(page);
  assert.equal(await page.locator(".item-quantity").first().inputValue(), "2");

  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 870 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await shape()).fits, true, `form at ${width}px`);
  }

  await page.goBack();
  await page.locator("#createOrderModal").waitFor({ state: "hidden" });
  await page.goForward();
  await settled();
  await page.locator("#createOrderModal header [data-dialog-close]").click();
  await page.locator("#createOrderModal").waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = (await motions()).length;
  await page.locator("#buyItemsButton").click();
  await settled();
  assert.equal((await motions()).length, before);
  assert.deepEqual(errors, []);
  console.log("PASS: identical registration keyframes, shared form and payment layout, mobile, history and reduced motion");
} finally {
  await browser.close();
}

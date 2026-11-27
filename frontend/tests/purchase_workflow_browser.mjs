// Run against serve_customers_fixture.py. All records belong to its temporary DB.
import { fillDate, readDate } from "./date-input-helpers.mjs";
import { advancePurchasePayment, closePurchaseInvoice, fillPurchaseRow, purchaseRow, waitForPurchaseForm } from "./purchase-browser-helpers.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5519";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const suffix = Date.now();
const categoryName = `مواد خرید ${suffix}`;
const otherCategoryName = `ملزومات خرید ${suffix}`;
const productName = `کالای خرید ${suffix}`;
const otherProductName = `کالای دیگر ${suffix}`;

async function api(path, method = "GET", body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const { financeRequest } = await import("/src/js/finance/finance-api.js");
      return financeRequest(path, { method, body, cache: "no-store" });
    },
    { path, method, body },
  );
}

async function category(name) {
  await page.goto(`${base}/page/settings-page.html#warehouse-categories`);
  await ready();
  await page.locator("#inventory-categories-name").fill(name);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings/inventory-options/warehouse-categories") &&
      response.request().method() === "POST",
  );
  await page.locator("#inventory-categories-form button[type=submit]").click();
  const response = await saved;
  assert.equal(response.status(), 201);
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("#inventory-categories-list li")].some(
        (row) => row.textContent.includes(name),
      ),
    name,
  );
  return response.json();
}

async function product(name, categoryId, unit) {
  await page.goto(`${base}/page/settings-page.html#warehouse-products`);
  await ready();
  await page.locator("#openCreateProductButton").click();
  await page.waitForFunction(
    () =>
      !document.getElementById("settingsProductUnit").disabled &&
      !document.getElementById("settingsProductCategory").disabled,
  );
  await page.locator("#settingsProductName").fill(name);
  await page
    .locator("#settingsProductWarehouseCategory")
    .selectOption(String(categoryId));
  await page.locator("#settingsProductUnit").selectOption(unit);
  await page.locator("#settingsProductPrice").fill("1000");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/inventory/products") &&
      response.request().method() === "POST",
  );
  await page.locator("#saveSettingsProduct").click();
  const response = await saved;
  assert.equal(response.status(), 201, await response.text());
  const result = await response.json();
  await page.locator(`[data-product-id="${result.id}"]`).waitFor();
  return result;
}

try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator("button[type=submit]").click();
  await page.waitForURL("**/index.html");
  const firstCategory = await category(categoryName);
  const secondCategory = await category(otherCategoryName);
  const firstProduct = await product(productName, firstCategory.id, "عدد");
  const secondProduct = await product(
    otherProductName,
    secondCategory.id,
    "متر",
  );

  await page.goto(`${base}/page/warehouse-page.html#purchase`);
  await ready();
  await waitForPurchaseForm(page);
  const row = (i) => purchaseRow(page, i);
  const nf = (value) => new Intl.NumberFormat("fa-IR").format(value);
  await fillDate(page, "orderDate", "۱۴۰۵/۰۸/۰۹");
  await fillPurchaseRow(page, firstProduct, 3, 700);
  assert.equal(await row(0).locator(".item-unit").textContent(), "عدد");
  assert.equal(await row(0).locator(".item-total").textContent(), `${nf(2100)} تومان`);
  await page.locator(".orders-add-row").first().click();
  await page.locator("#orderPay").click();
  await page.locator("#createOrderModal .orders-error").getByText(/برای تمام ردیف‌ها کالا انتخاب کنید/).waitFor();
  assert.equal(await row(1).locator(".item-product").getAttribute("aria-invalid"), "true");
  await fillPurchaseRow(page, secondProduct, 2, 900, 1);
  await page.locator(".orders-add-row").nth(1).click();
  await fillPurchaseRow(page, firstProduct, 4, 500, 2);
  assert.equal(await page.locator("#orderSubtotal").textContent(), `${nf(5900)} تومان`);
  await page.locator('#orderDiscountKind input[value="percent"]').check();
  await page.locator("#orderDiscountPercent").fill("10");
  assert.equal(await page.locator("#orderTotal").textContent(), `${nf(5310)} تومان`);
  await page.locator("#orderDescription").fill("تحویل آزمایشی");
  await advancePurchasePayment(page);
  assert.equal(await page.locator("#paymentRemaining").textContent(), `${nf(5310)} تومان`);
  assert.equal(await page.locator("#paymentState").textContent(), "پرداخت‌نشده");
  await page.locator("#editOrderInvoice").click();
  await waitForPurchaseForm(page);
  assert.equal(await readDate(page, "orderDate"), "1405/08/09");
  assert.equal(await row(2).locator(".item-product").getAttribute("data-product-id"), String(firstProduct.id));
  await row(2).locator(".item-remove").click();
  assert.equal(await page.locator("#orderItems .orders-item-row").count(), 2);
  await page.locator(".orders-add-row").nth(1).click();
  await fillPurchaseRow(page, firstProduct, 4, 500, 2);
  await advancePurchasePayment(page);
  const beforeBank = await api("/banks");
  let initiallySaved;
  await page.route("**/api/purchases", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const result = await route.fetch();
    assert.equal(result.status(), 201, await result.text());
    initiallySaved = await result.json();
    await route.abort();
  });
  await page.locator("#finalizeOrder").click();
  await page.locator("#finalizeOrder").getByText("تلاش مجدد").waitFor();
  await page.unroute("**/api/purchases");
  await page.reload();
  await ready();
  await page.locator("#orderPaymentModal[aria-hidden=false]").waitFor();
  assert.equal(await page.locator("#finalizeOrder").textContent(), "تلاش مجدد");
  const savedResponse = page.waitForResponse((r) => r.url().endsWith("/api/purchases") && r.request().method() === "POST");
  await page.locator("#finalizeOrder").click();
  const saved = await savedResponse;
  assert.equal(saved.status(), 201, await saved.text());
  assert.deepEqual(await saved.json(), initiallySaved);
  assert.equal(initiallySaved.rows.length, 3);
  assert.equal(initiallySaved.discount, 590);
  assert.equal(initiallySaved.total, 5310);
  assert.equal(initiallySaved.description, "تحویل آزمایشی");
  assert.equal(initiallySaved.payment_status, "unpaid");
  await closePurchaseInvoice(page);
  const inventory = await api("/inventory/products");
  assert.equal(inventory.find((item) => item.id === firstProduct.id).stock, 7);
  assert.equal(inventory.find((item) => item.id === secondProduct.id).stock, 2);
  assert.deepEqual(await api("/banks"), beforeBank);
  assert.deepEqual(errors, []);
  console.log("PASS: shared invoice rows, percentage discount, payment back navigation, and unpaid retry with no bank deduction");
} finally {
  await browser.close();
}

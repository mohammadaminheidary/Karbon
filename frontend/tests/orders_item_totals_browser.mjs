// Disposable fixture: serve_customers_fixture.py --backend-port 8027
// --frontend-port 5527 --customers 25 --orders --finance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5527";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const page = await browser.newPage();
const orders = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let token;
const money = (value) =>
  `${new Intl.NumberFormat("fa-IR").format(value)} تومان`;
const rows = () => page.locator("#orderItems .orders-item-row");
const row = (index) => rows().nth(index);
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method,
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok(), `${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function check(totals, subtotal, discount = 0) {
  assert.deepEqual(
    await page.locator("#orderItems .item-total").allTextContents(),
    totals.map(money),
  );
  assert.equal(
    await page.locator("#orderSubtotal").textContent(),
    money(subtotal),
  );
  assert.equal(
    await page.locator("#orderTotal").textContent(),
    money(subtotal - discount),
  );
}
try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.ok(login.ok());
  ({ token } = await login.json());
  await page.addInitScript((token) => {
    localStorage.setItem("karbon_auth", JSON.stringify({ token }));
    sessionStorage.removeItem("karbon-api-cache-v1");
  }, token);
  const products = await api("GET", "/products");
  const tracked = products.find((p) => p.stock !== null),
    service = products.find((p) => p.stock === null);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/page/orders-page.html`);
    await page.locator(".orders-create").click();
    await page.waitForFunction(() => {
      const root = document.getElementById("createOrderModal");
      return (
        root.open &&
        !root.dataset.morph &&
        !document.getElementById("orderFields").disabled
      );
    });
    const headings = await page
      .locator("#createOrderModal .orders-items-table th")
      .allTextContents();
    assert.deepEqual(headings.slice(4), [
      "مبلغ واحد (تومان)",
      "مبلغ کل (تومان)",
      "حذف ردیف",
    ]);
    assert.equal(await row(0).locator("td").count(), 7);
    assert.equal(
      await page
        .locator(".orders-row-action td")
        .first()
        .getAttribute("colspan"),
      "7",
    );
    await page.locator("#orderCustomerSearch").click();
    await page.locator(".orders-customer-option").first().click();
    await page.locator("#orderCustomerDetails").waitFor({ state: "visible" });
    await row(0).locator(".item-product").selectOption(String(tracked.id));
    await row(0).locator(".item-quantity").fill("3");
    await check([300000], 300000);
    await page.locator(".orders-add-row").last().click();
    await row(1).locator(".item-product").selectOption(String(service.id));
    await row(1).locator(".item-quantity").fill("2");
    await check([300000, 100000], 400000);
    await row(0).locator(".item-price").fill("۱۲۵٬۰۰۰");
    await check([375000, 100000], 475000);
    await row(1).locator(".item-quantity").fill("۴");
    await check([375000, 200000], 575000);
    // Read-only totals have their own cell and Persian digits/group separators.
    assert.equal(
      await row(0)
        .locator(".item-price")
        .evaluate(
          (input) =>
            input.closest("td").nextElementSibling.querySelector("output")
              ?.className,
        ),
      "item-total",
    );
    assert.equal(await row(0).locator(".item-total input").count(), 0);
    assert.equal(
      await row(0).locator(".item-total").textContent(),
      "۳۷۵٬۰۰۰ تومان",
    );
    for (const discount of [75000, 0, 575000]) {
      await page.locator("#orderDiscount").fill(String(discount));
      await check([375000, 200000], 575000, discount);
    }
    await page.locator("#orderDiscount").fill("575001");
    assert.equal(await page.locator("#orderTotal").textContent(), "—");
    await page.locator("#orderPay").click();
    assert.ok(
      (
        await page.locator("#createOrderModal .orders-error").textContent()
      ).includes("معتبر نیست"),
    );
    await page.locator("#orderDiscount").fill("۷۵٬۰۰۰");
    await row(1).locator(".item-price").fill("0");
    await check([375000, 0], 375000, 75000);
    await row(1).locator(".item-price").fill("12x");
    assert.equal(await row(1).locator(".item-total").textContent(), "—");
    assert.equal(await page.locator("#orderSubtotal").textContent(), "—");
    await row(1).locator(".item-price").fill("۵۰٬۰۰۰");
    await row(0).locator(".item-quantity").fill("0");
    assert.equal(await row(0).locator(".item-quantity").inputValue(), "3");
    assert.equal(
      await row(0).locator(".item-total").textContent(),
      money(375000),
    );
    await row(0).locator(".item-quantity").fill("۳");
    await check([375000, 200000], 575000, 75000);
    // Adding and removing rows cannot count a displayed total twice.
    await page.locator(".orders-add-row").last().click();
    await row(2).locator(".item-product").selectOption(String(service.id));
    await row(2).locator(".item-quantity").fill("5");
    await row(2).locator(".item-price").fill("25000");
    await check([375000, 200000, 125000], 700000, 75000);
    await row(2).locator(".item-remove").click();
    await check([375000, 200000], 575000, 75000);
    await row(0).locator(".item-total").scrollIntoViewIfNeeded();
    assert.equal(
      await page
        .locator("#createOrderModal")
        .evaluate((root) => root.scrollWidth <= root.clientWidth),
      true,
      "table scroll stays within the existing responsive wrapper",
    );
    await page.locator("#orderPay").click();
    await page.locator("#orderPaymentModal").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#paymentInvoiceTotal").textContent(),
      money(500000),
    );
    await page.locator("#pay-pos").uncheck();
    await page.locator("#pay-cash").check();
    await page.locator("#pay-cash-amount").fill("500000");
    assert.equal(
      await page.locator("#paymentPaid").textContent(),
      money(500000),
    );
    assert.equal(
      await page.locator("#paymentRemaining").textContent(),
      money(0),
    );
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/orders") &&
        response.request().method() === "POST",
    );
    await page.locator("#finalizeOrder").click();
    const response = await responsePromise;
    assert.ok(response.ok(), await response.text());
    const payload = response.request().postDataJSON(),
      saved = await response.json();
    orders.push(saved.id);
    assert.deepEqual(payload.items, [
      { product_id: tracked.id, quantity: 3, unit_price: 125000 },
      { product_id: service.id, quantity: 4, unit_price: 50000 },
    ]);
    assert.equal(payload.discount, 75000);
    for (const data of [
      saved,
      await api("GET", `/orders/${saved.id}`),
      await api("GET", `/orders/${saved.id}/invoice`),
    ]) {
      assert.deepEqual(
        data.items.map((item) => item.total),
        [375000, 200000],
      );
      assert.deepEqual(
        [data.subtotal, data.discount, data.total, data.paid, data.remaining],
        [575000, 75000, 500000, 500000, 0],
      );
    }
    await page.reload();
    await page.locator(`[data-order-id="${saved.id}"]`).waitFor();
    const cardTotals = await page
      .locator(`[data-order-id="${saved.id}"] .orders-record-totals dd`)
      .allTextContents();
    assert.deepEqual(cardTotals, [575000, 75000, 500000, 500000, 0].map(money));
    console.log(
      `PASS ${width}px: dedicated total column, Persian formatting, quantity/price changes, multiple rows, discounts/zero/invalid inputs, row removal, payment and persisted invoice totals`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  try {
    for (const id of orders)
      await api("DELETE", `/orders/${id}/invoice`, {
        password: "test-password",
        confirmed: true,
      });
  } finally {
    await browser.close();
  }
}

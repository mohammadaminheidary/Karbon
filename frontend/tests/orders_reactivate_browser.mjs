// Use serve_customers_fixture.py --backend-port 8027 --frontend-port 5527
// --customers 25 --orders --finance. Never run this against live data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const errors = [],
  orders = [];
page.on("pageerror", (error) => errors.push(error.message));
let token, release;
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method,
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok(), `${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function tab(status) {
  await page.locator(`#${status}OrdersTab`).click();
  await page.waitForFunction(
    (status) =>
      document
        .getElementById(`${status}OrdersPanel`)
        .getAttribute("aria-busy") === "false",
    status,
  );
}
const card = (status, id) =>
  page.locator(`#${status}OrdersPanel [data-order-id="${id}"]`);
try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.ok(login.ok());
  ({ token } = await login.json());
  await page.addInitScript(
    (token) => {
      localStorage.setItem("karbon_auth", JSON.stringify({ token }));
      // API-side fixture seeding bypasses the app's normal cache invalidation.
      // Reload assertions should also verify a fresh database-backed response.
      sessionStorage.removeItem("karbon-api-cache-v1");
    },
    token,
  );
  const customer = (await api("GET", "/customers")).items[0];
  const product = (await api("GET", "/products")).find(
    (item) => item.stock === null,
  );
  for (const width of [1440, 390]) {
    const order = await api("POST", "/orders", {
      request_id: randomUUID(),
      customer_id: customer.id,
      invoice_date: "1405/08/08",
      payment_date: "1405/08/08",
      items: [{ product_id: product.id, quantity: 2, unit_price: 50000 }],
      discount: 1000,
      description: "آزمون بازگشت سفارش",
      payments: [{ method: "cash", amount: 10000 }],
    });
    orders.push(order.id);
    const path = `/orders/${order.id}`;
    await api("POST", `${path}/complete`);
    const before = {
      invoice: await api("GET", `${path}/invoice`),
      details: await api("GET", path),
      customer: await api("GET", `/customers/${customer.id}`),
      banks: await api("GET", "/banks"),
      products: await api("GET", "/products"),
    };
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/page/orders-page.html`);
    await tab("completed");
    const button = () =>
      card("completed", order.id).locator("[data-reactivate-order]");
    assert.equal(await button().textContent(), "بازگشت به سفارشات فعال");
    assert.equal(await button().getAttribute("class"), "orders-primary");
    // A failed request keeps the card and allows a retry through navbar alerts.
    await page.route(
      `**/api${path}/reactivate`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "خطای آزمایشی بازگشت سفارش" }),
        }),
      { times: 1 },
    );
    await button().click();
    await page.waitForFunction(() =>
      document
        .querySelector('.navbar-notification[role="alert"]')
        ?.textContent.includes("خطای آزمایشی"),
    );
    assert.equal(await button().isEnabled(), true);
    assert.equal((await api("GET", path)).status, "completed");
    // Hold the real request while double-clicking and navigating between tabs.
    let count = 0,
      started;
    const requested = new Promise((resolve) => {
      started = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(`**/api${path}/reactivate`, async (route) => {
      count++;
      started();
      await gate;
      await route.continue();
    });
    await button().evaluate((button) => {
      button.click();
      button.click();
    });
    await requested;
    assert.equal(await button().isDisabled(), true);
    await tab("active");
    assert.equal(await card("active", order.id).count(), 0);
    await tab("completed");
    assert.equal(
      await button().isDisabled(),
      true,
      "pending state survives tab changes",
    );
    await button().evaluate((button) => button.click());
    release();
    await card("completed", order.id).waitFor({ state: "detached" });
    assert.equal(count, 1, "only one status-change POST is sent");
    assert.equal(
      await page.locator('#orderDetailsModal[aria-hidden="false"]').count(),
      0,
      "action does not open card details",
    );
    assert.ok(
      await page.locator('.navbar-notification[role="status"]').textContent(),
      "success notification",
    );
    await page.unroute(`**/api${path}/reactivate`);
    await tab("active");
    await card("active", order.id).waitFor();
    assert.equal(
      await card("active", order.id).locator("[data-reactivate-order]").count(),
      0,
    );
    const after = await api("GET", path);
    assert.deepEqual(after, { ...before.details, status: "active" });
    assert.deepEqual(await api("GET", `${path}/invoice`), before.invoice);
    assert.deepEqual(
      await api("GET", `/customers/${customer.id}`),
      before.customer,
    );
    assert.deepEqual(await api("GET", "/banks"), before.banks);
    assert.deepEqual(await api("GET", "/products"), before.products);
    await page.reload();
    await card("active", order.id).waitFor();
    assert.equal((await api("GET", path)).status, "active");
    await tab("completed");
    assert.equal(await card("completed", order.id).count(), 0);
    await tab("active");
    // The returned order can still be completed and returned again.
    await card("active", order.id).locator("[data-complete-order]").click();
    await card("active", order.id).waitFor({ state: "detached" });
    await tab("completed");
    await button().waitFor({ state: "visible" });
    await page.waitForFunction(
      (id) =>
        !document.querySelector(`[data-reactivate-order="${id}"]`).disabled,
      order.id,
    );
    await button().click();
    await card("completed", order.id).waitFor({ state: "detached" });
    await page.reload();
    await card("active", order.id).waitFor();
    await tab("completed");
    assert.equal(await card("completed", order.id).count(), 0);
    console.log(
      `PASS ${width}px: error/retry, pending guard across tabs, immediate removal, preserved data, refresh persistence and complete/return round trip`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  release?.();
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

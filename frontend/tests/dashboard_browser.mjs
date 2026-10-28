// Run with frontend/tests/serve_customers_fixture.py --customers 25 --bank-ledger 25
// --orders --members 3. All writes go to that disposable database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5526";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let dashboardRequests = 0;
page.on("request", (r) => {
  if (new URL(r.url()).pathname === "/api/dashboard") dashboardRequests++;
});
const settled = async () => {
  await page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
  await page.locator('#dashboardWorkspace[aria-busy="false"]').waitFor();
};
const exact = (v) => new Intl.NumberFormat("fa-IR").format(BigInt(v));
try {
  const response = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(response.ok(), true);
  const { token } = await response.json();
  const headers = { Authorization: `Bearer ${token}` };
  const post = async (path, payload) => {
    const response = await page.request.post(`${base}/api${path}`, {
      headers,
      data: payload,
    });
    assert.equal(response.ok(), true, await response.text());
    return response.json();
  };
  const get = async (path) =>
    (await page.request.get(`${base}/api${path}`, { headers })).json();
  const now = new Date();
  const todayISO = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
  }).format(now);
  const jalaliParts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const jalali = ["year", "month", "day"]
    .map((type) => jalaliParts.find((part) => part.type === type).value)
    .join("/");
  const bank = (await get("/banks")).find((row) => !row.is_cash && row.active);
  const customer = (await get("/customers?limit=1")).items[0];
  const product = (await get("/products")).find((row) => row.stock >= 2);
  await post("/orders", {
    request_id: crypto.randomUUID(),
    customer_id: customer.id,
    invoice_date: jalali,
    payment_date: jalali,
    items: [{ product_id: product.id, quantity: 2, unit_price: product.price }],
    discount: 1000,
    payments: [{ method: "pos", bank_id: bank.id, amount: product.price }],
  });
  const task = await post("/tasks", {
    date: todayISO,
    title: "بررسی گزارش روزانه",
  });
  const taskUpdate = await page.request.put(
    `${base}/api/tasks/${task.id}/status`,
    { headers, data: { status: "completed" } },
  );
  assert.equal(taskUpdate.ok(), true);
  const members = await get("/members");
  await post("/attendance", { member_id: members[0].id, status: "present" });
  const expenseAccount = await post("/settings/document-accounts", {
    title: `هزینه عملیاتی ${crypto.randomUUID().slice(0, 5)}`,
    kind: "expense",
  });
  await post("/documents", {
    request_id: crypto.randomUUID(),
    date: todayISO,
    rows: [
      {
        kind: "expense",
        bank_id: bank.id,
        amount: 10000,
        document_account_id: expenseAccount.id,
      },
    ],
  });
  await page.addInitScript(
    (token) => localStorage.setItem("karbon_auth", JSON.stringify({ token })),
    token,
  );
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.route("**/api/dashboard?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "خطای دریافت اولیه" }),
    }),
  );
  await page.goto(`${base}/index.html`);
  await settled();
  assert.equal(await page.locator("#dashboardError").isVisible(), true);
  assert.equal(await page.locator("#dashboardContent").isVisible(), false);
  assert.equal(await page.locator("#dashboardLoading").isVisible(), false);
  await page.unroute("**/api/dashboard?**");
  await page.locator("#retryDashboard").click();
  await settled();
  assert.equal(await page.locator(".dash-plot svg").count(), 12);
  const api = await (
    await page.request.get(`${base}/api/dashboard`, { headers })
  ).json();
  assert.equal(
    await page.locator("#revenueValue").textContent(),
    exact(api.finance.income),
  );
  assert.equal(
    await page.locator("#inventoryValue").textContent(),
    exact(api.inventory.value),
  );
  const plot = page.locator("#revenueChart .dash-plot");
  await plot.hover({ position: { x: 150, y: 90 } });
  await page
    .locator("#revenueChart .dash-tooltip")
    .waitFor({ state: "visible" });
  assert.match(
    await page.locator("#revenueChart .dash-tooltip").textContent(),
    /درآمد/,
  );
  await plot.click({ position: { x: 150, y: 90 } });
  await page.mouse.move(0, 0);
  assert.equal(
    await page.locator("#revenueChart .dash-tooltip").isVisible(),
    true,
  );
  await page.locator('#revenueChart button[aria-label="بزرگ‌نمایی"]').click();
  assert.equal(
    await page.locator("#revenueChart").getAttribute("data-visible-points"),
    "15",
  );
  await page.locator('#revenueChart input[aria-label="آغاز نمایش"]').fill("10");
  assert.equal(
    await page
      .locator('#revenueChart input[aria-label="آغاز نمایش"]')
      .inputValue(),
    "10",
  );
  await plot.focus();
  await page.keyboard.press("ArrowRight");
  assert.match(
    await page.locator("#revenueChart .dash-sr").first().textContent(),
    /درآمد/,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#revenueChart").getAttribute("data-visible-points"),
    "30",
  );
  await plot.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  assert.ok(
    Number(
      await page.locator("#revenueChart").getAttribute("data-visible-points"),
    ) < 30,
  );
  const beforePan = await page
    .locator('#revenueChart input[aria-label="آغاز نمایش"]')
    .inputValue();
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + 100, { steps: 8 });
  await page.mouse.up();
  assert.notEqual(
    await page
      .locator('#revenueChart input[aria-label="آغاز نمایش"]')
      .inputValue(),
    beforePan,
  );
  await page
    .locator('#revenueChart button[aria-label="بازنشانی نمودار"]')
    .click();
  await page.locator("#revenueChart summary").click();
  assert.equal(await page.locator("#revenueChart tbody tr").count(), 30);
  const sum = await page
    .locator("#revenueChart tbody tr td:last-child")
    .allTextContents();
  assert.equal(sum.length, api.daily.length);
  await page.locator("#revenueChart summary").click();
  await page.locator('[data-period="7"]').click();
  await settled();
  assert.equal(
    await page.locator("#revenueChart").getAttribute("data-visible-points"),
    "7",
  );
  await page.locator('[data-period="custom"]').click();
  await page.locator("#dashboardStart").fill("2020-01-01");
  await page.locator("#dashboardEnd").fill("2020-01-02");
  await page.locator('#dashboardDates button[type="submit"]').click();
  await settled();
  assert.equal(await page.locator("#revenueValue").textContent(), "۰");
  assert.equal(
    await page.locator("#inventoryValue").textContent(),
    exact(api.inventory.value),
  );
  assert.equal(
    await page.locator("#revenueChart").getAttribute("data-visible-points"),
    "2",
  );
  await page.locator('[data-period="30"]').click();
  await settled();
  // Actual API mutation in another tab publishes Karbon's existing storage event.
  const second = await page.context().newPage();
  await second.goto(`${base}/index.html`);
  await second.evaluate(async () => {
    const { financeRequest } = await import("/src/js/finance/finance-api.js");
    await financeRequest("/products", {
      method: "POST",
      body: {
        name: `کالای داشبورد ${crypto.randomUUID().slice(0, 5)}`,
        unit: "عدد",
        price: 12345,
        stock: 2,
      },
    });
  });
  await page.bringToFront();
  await page.waitForFunction(
    (expected) =>
      document.getElementById("inventoryValue").textContent === expected,
    exact(BigInt(api.inventory.value) + 24690n),
  );
  await second.close();
  // Automatic periodic refresh reaches the API without an app event.
  const beforePoll = dashboardRequests;
  await post("/products", {
    name: `موجودی جدید ${crypto.randomUUID().slice(0, 5)}`,
    unit: "عدد",
    price: 321,
    stock: 3,
  });
  const polled = page.waitForRequest(
    (r) => new URL(r.url()).pathname === "/api/dashboard",
  );
  await page.clock.runFor(31000);
  await polled;
  await settled();
  assert.ok(dashboardRequests > beforePoll);
  await page.waitForFunction(
    (expected) =>
      document.getElementById("inventoryValue").textContent === expected,
    exact(BigInt(api.inventory.value) + 24690n + 963n),
  );
  const preserved = await page.locator("#revenueValue").textContent();
  await page.route("**/api/dashboard?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "قطع آزمایشی سرور" }),
    }),
  );
  await page.locator("#refreshDashboard").click();
  await settled();
  assert.equal(await page.locator("#dashboardError").isVisible(), true);
  assert.equal(await page.locator("#revenueValue").textContent(), preserved);
  await page.unroute("**/api/dashboard?**");
  await page.locator("#retryDashboard").click();
  await settled();
  assert.equal(await page.locator("#dashboardError").isVisible(), false);
  // Rapid date changes must settle on the last requested period.
  await page.locator('[data-period="365"]').click();
  await page.locator('[data-period="7"]').click();
  await settled();
  assert.equal(
    await page.locator("#revenueChart").getAttribute("data-visible-points"),
    "7",
  );
  await page.locator('[data-period="30"]').click();
  await settled();
  await page.screenshot({
    path: "/tmp/karbon-dashboard-desktop.png",
    fullPage: true,
  });
  for (const width of [390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/karbon-dashboard-mobile.png",
    fullPage: true,
  });
  await page
    .locator("#inventoryChart .dash-plot")
    .tap({ position: { x: 130, y: 70 } })
    .catch(async () =>
      page
        .locator("#inventoryChart .dash-plot")
        .click({ position: { x: 130, y: 70 } }),
    );
  assert.equal(
    await page.locator("#inventoryChart .dash-tooltip").isVisible(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      charts: 12,
      dashboardRequests,
      checked:
        "real totals, zoom, pan, wheel, selection, keyboard, tables, period filters, cross-tab mutations, polling, failure/retry, race cancellation, responsive widths",
    }),
  );
} finally {
  await browser.close();
}

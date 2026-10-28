// Run against frontend/tests/serve_customers_fixture.py with --customers 25 --finance
// --orders --bank-ledger 25. Uses only the fixture's disposable database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5502";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  requests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (
    new URL(request.url()).pathname.startsWith("/api/") &&
    request.method() === "GET"
  )
    requests.push(request.url());
});
const settled = async () => {
  await page.locator("#mainNavbar").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]'),
  );
};
const navigate = async (name) => {
  await page.locator(`a[href="/page/${name}-page.html"]`).click();
  await page.waitForURL(`**/page/${name}-page.html`);
  await settled();
};
const visitLedger = async () => {
  await page
    .locator("a.bank-account")
    .filter({ hasText: "بانک ملت" })
    .first()
    .click();
  await page.waitForURL(
    (url) => url.pathname === "/page/bank-transactions-page.html",
  );
  await settled();
};
try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(login.ok(), true);
  const { token } = await login.json();
  await page.addInitScript((token) => {
    localStorage.setItem("karbon_auth", JSON.stringify({ token }));
    new PerformanceObserver((list) => {
      if (
        list
          .getEntries()
          .some((entry) => entry.name === "first-contentful-paint")
      ) {
        const loading = document.getElementById("customersLoading");
        if (loading)
          window.customerLoadingAtPaint =
            getComputedStyle(loading).display !== "none";
      }
    }).observe({ type: "paint", buffered: true });
  }, token);
  // Make the cost of an unnecessary round trip visible and measurable.
  await page.route("**/api/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.goto(`${base}/page/customers-page.html`);
  await settled();
  for (const name of [
    "orders",
    "finance",
    "attendance",
    "daily-tasks",
    "documents",
    "banks",
    "settings",
  ]) {
    await navigate(name);
    if (name === "banks") await visitLedger();
  }
  const sections = [
    "members",
    "expenses",
    "document-accounts",
    "banks",
    "products",
    "invoices",
  ];
  for (const section of sections) {
    await page.locator(`[data-settings-target="${section}"]`).click();
    await settled();
  }
  assert.equal(
    requests.filter((url) => new URL(url).pathname === "/api/auth/me").length,
    1,
    "navigation must reuse a fresh authentication check",
  );
  const coldRequests = requests.length;
  for (const name of [
    "customers",
    "orders",
    "finance",
    "attendance",
    "daily-tasks",
    "documents",
    "banks",
    "settings",
  ]) {
    await navigate(name);
    if (name === "banks") await visitLedger();
    if (name === "customers") {
      assert.equal(await page.locator("#customersList > *").count(), 12);
      assert.equal(
        await page.evaluate(() => window.customerLoadingAtPaint),
        false,
        "a cached visit must render customer data without showing the initial spinner",
      );
    }
  }
  for (const section of sections) {
    await page.locator(`[data-settings-target="${section}"]`).click();
    await settled();
  }
  const warmRequests = requests.length - coldRequests;
  assert.equal(
    warmRequests,
    0,
    "fresh repeat visits should reuse data across all pages",
  );

  const beforeConcurrent = requests.length;
  await page.evaluate(async () => {
    const { invalidateApiCache } =
      await import("/src/js/components/api-cache.js");
    const customers = await import("/src/js/customers/customer-api.js");
    const members = await import("/src/js/members/members-api.js");
    const attendance = await import("/src/js/attendance/attendance-api.js");
    invalidateApiCache();
    await Promise.all([
      ...Array.from({ length: 8 }, () => customers.getCustomers()),
      members.getMembers(),
      attendance.getMembers(),
    ]);
  });
  assert.equal(
    requests.length - beforeConcurrent,
    2,
    "ten consumers across three API modules should use two distinct GETs",
  );

  await page.evaluate(async () => {
    const api = await import("/src/js/customers/customer-api.js");
    const before = await api.getCustomers();
    const created = await api.createCustomer({
      first_name: "کش",
      last_name: "آزمایش",
      gender: "male",
    });
    try {
      const after = await api.getCustomers();
      if (
        after.total !== before.total + 1 ||
        !after.items.some((item) => item.id === created.id)
      )
        throw new Error("a successful write must invalidate cached list data");
    } finally {
      await api.deleteCustomer(created.id);
    }
  });
  await navigate("banks");
  const beforeRefresh = requests.length;
  await page.locator("#refreshBanks").click();
  await settled();
  assert.equal(
    requests.length - beforeRefresh,
    1,
    "manual refresh must reach the server",
  );
  await navigate("customers");
  await page
    .locator("#customerSearchInput")
    .fill("no-such-cache-fixture-customer");
  await page.locator("#customersSearchEmpty").waitFor({ state: "visible" });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("karbon-data-change")),
  );
  await page.waitForFunction(
    () =>
      document
        .getElementById("customersWorkspace")
        .getAttribute("aria-busy") === "true",
  );
  assert.equal(await page.locator("#customersSearchEmpty").isVisible(), true);
  assert.equal(
    await page.locator("#customersLoading").isVisible(),
    false,
    "a successful empty result is existing data and must not return to the initial spinner",
  );
  await settled();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      coldRequests,
      warmRequests,
      sharedRequests: 2,
      result:
        "PASS: all pages and settings, cached first paint, request sharing, mutation invalidation, manual refresh",
    }),
  );
} finally {
  await browser.close();
}

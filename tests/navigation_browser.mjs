// Run beside the disposable fixture in serve_customers_fixture.py.
// KARBON_PLAYWRIGHT_PATH can point to an existing Playwright installation.
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
const errors = [];
await page.addInitScript(() => {
  new PerformanceObserver((list) => {
    if (
      list.getEntries().some((entry) => entry.name === "first-contentful-paint")
    )
      window.firstPaintHasNavbar = Boolean(
        document.getElementById("mainNavbar"),
      );
  }).observe({ type: "paint", buffered: true });
});
page.on("pageerror", (error) => errors.push(error.message));
let customerRequests = 0,
  documentRequests = 0;
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/customers") customerRequests++;
  if (request.resourceType() === "document") documentRequests++;
});
const idleCustomers = () =>
  page.waitForFunction(
    () =>
      document
        .getElementById("customersWorkspace")
        ?.getAttribute("aria-busy") === "false",
  );
const externalChange = () =>
  page.evaluate(() => window.dispatchEvent(new Event("karbon-data-change")));
try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/index.html");
  await page.locator('a[href="/page/customers-page.html"]').click();
  await idleCustomers();
  assert.equal(await page.locator("#customersList > *").count(), 12);
  await page.locator("#loadMoreCustomersButton").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#customersList > *").length === 24,
  );
  const beforeActive = documentRequests;
  await page.evaluate(() => {
    window.customerNode = document.querySelector("#customersList > *");
  });
  await page.locator('a[aria-current="page"]').click();
  await page.waitForTimeout(250);
  assert.equal(documentRequests, beforeActive);
  assert.equal(
    await page.evaluate(
      () =>
        window.customerNode === document.querySelector("#customersList > *"),
    ),
    true,
  );

  // Slow background requests keep existing cards visible, then retain DOM for
  // unchanged data and preserve the number of expanded results.
  await page.route("**/api/customers?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await externalChange();
  await page.waitForFunction(
    () =>
      document
        .getElementById("customersWorkspace")
        .getAttribute("aria-busy") === "true",
  );
  assert.equal(await page.locator("#customersList").isVisible(), true);
  assert.equal(await page.locator("#customersLoading").isVisible(), false);
  assert.equal(await page.locator("#customersList > *").count(), 24);
  await idleCustomers();
  assert.equal(
    await page.evaluate(
      () =>
        window.customerNode === document.querySelector("#customersList > *"),
    ),
    true,
  );
  await page.unroute("**/api/customers?*");

  await page.locator("#customerSearchInput").fill("آزمایشی");
  await idleCustomers();
  const search = await page.locator("#customerSearchInput").inputValue();
  await page.locator('a[href="/page/orders-page.html"]').click();
  await page.waitForFunction(
    () =>
      document
        .getElementById("activeOrdersPanel")
        ?.getAttribute("aria-busy") === "false",
  );
  const beforeBack = customerRequests;
  await page.goBack({ waitUntil: "commit" });
  await idleCustomers();
  assert.equal(await page.locator("#customerSearchInput").inputValue(), search);
  assert.equal(
    customerRequests,
    beforeBack,
    "fresh history restoration must not refetch customers",
  );

  // A failed refresh leaves the previous content usable with a visible retry.
  await page.route("**/api/customers?*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"detail":"fixture failure"}',
    }),
  );
  const count = await page.locator("#customersList > *").count();
  await externalChange();
  await page.locator("#customersError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#customersList").isVisible(), true);
  assert.equal(await page.locator("#customersList > *").count(), count);
  await page.unroute("**/api/customers?*");
  await page.locator("#retryCustomersButton").click();
  await idleCustomers();

  for (const name of [
    "finance",
    "attendance",
    "daily-tasks",
    "documents",
    "banks",
    "settings",
    "orders",
    "customers",
  ]) {
    await page.locator(`a[href="/page/${name}-page.html"]`).click();
    await page.waitForURL(`**/page/${name}-page.html`);
    await page.locator("#mainNavbar").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.documentElement.dataset.pageState === "ready",
    );
    await page.waitForFunction(
      () => !document.querySelector('[aria-busy="true"]'),
    );
    assert.equal(await page.locator("#mainNavbar").count(), 1);
    assert.equal(await page.locator("main").isVisible(), true);
    await page.waitForFunction(
      () => typeof window.firstPaintHasNavbar === "boolean",
    );
    assert.equal(
      await page.evaluate(() => window.firstPaintHasNavbar),
      true,
      "the first visible page frame must include the navbar",
    );
    assert.equal(
      await page
        .locator(".navbar-dock")
        .evaluate((node) => getComputedStyle(node).animationName),
      "none",
    );
    if (name === "settings") {
      for (const section of [
        "members",
        "expenses",
        "document-accounts",
        "banks",
        "products",
        "invoices",
      ]) {
        await page.locator(`[data-settings-target="${section}"]`).click();
        await page
          .locator(`[data-settings-panel="${section}"]`)
          .waitFor({ state: "visible" });
        await page.waitForFunction(
          () => !document.querySelector('[aria-busy="true"]'),
        );
      }
    }
  }
  await page.locator('a[href="/page/banks-page.html"]').click();
  await page
    .locator("a.bank-account")
    .filter({ hasText: "بانک ملت" })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      document.getElementById("ledgerRows")?.children.length > 0 &&
      document.getElementById("ledgerRows").getAttribute("aria-busy") ===
        "false",
  );
  const ledgerCount = await page.locator("#ledgerRows > *").count();
  await page.route("**/api/banks/*/transactions?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await externalChange();
  await page.waitForFunction(
    () =>
      document.getElementById("ledgerRows").getAttribute("aria-busy") ===
      "true",
  );
  assert.equal(await page.locator("#ledgerTable").isVisible(), true);
  assert.equal(await page.locator("#ledgerRows > *").count(), ledgerCount);
  await page.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]'),
  );
  assert.equal(await page.locator("#chartSummary > *").count(), 2);
  await page.unroute("**/api/banks/*/transactions?*");
  await page.locator('a[href="/page/customers-page.html"]').click();
  await idleCustomers();
  assert.deepEqual(errors, []);
  if (process.env.KARBON_SCREENSHOT)
    await page.screenshot({ path: process.env.KARBON_SCREENSHOT });
  console.log(
    "PASS: page links, same-route state, slow/error refresh, unchanged DOM, pagination, Back/Forward, and all navigation destinations",
  );
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), errors }));
  throw error;
} finally {
  await browser.close();
}

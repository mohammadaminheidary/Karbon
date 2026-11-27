import { clickSettingsSection } from "./settings_navigation.mjs";
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
const navbar = page.locator("#mainNavbar");
const navbarLink = (path) => navbar.locator(`a[href="${path}"]`);
const upcomingSections = { vision: "چشم‌انداز", production: "تولید" };
const pageReady = () => page.waitForFunction(
  () => document.documentElement.dataset.pageState === "ready",
);
const waitForIndicator = () => page.waitForFunction(() => {
  const indicator = document.querySelector(".navbar-indicator[data-positioned]");
  const active = document.querySelector('#mainNavbar [aria-current="page"]');
  if (!indicator || !active || indicator.getAnimations().length) return false;
  const dot = indicator.getBoundingClientRect();
  const item = active.getBoundingClientRect();
  return Math.abs(dot.left + dot.width / 2 - item.left - item.width / 2) < 1 &&
    dot.top >= item.bottom;
});

function assertSameBounds(before, after) {
  for (const property of ["x", "y", "width", "height"]) {
    assert.ok(
      Math.abs(before[property] - after[property]) < 1,
      `navbar ${property} changed from ${before[property]} to ${after[property]}`,
    );
  }
}

try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/index.html");
  await pageReady();
  const restBounds = await navbar.boundingBox();
  const customers = navbarLink("/page/customers-page.html");
  await customers.hover();
  await page.waitForFunction(
    (width) => {
      const dock = document.getElementById("mainNavbar");
      return dock.getBoundingClientRect().width > width &&
        !dock.getAnimations({ subtree: true }).some(
          (animation) => animation.transitionProperty === "--dock-item-zoom",
        );
    },
    restBounds.width,
  );
  const hoveredBounds = await navbar.boundingBox();
  await customers.evaluate((link) => link.click());
  await page.waitForURL("**/customers-page.html");
  await idleCustomers();
  assertSameBounds(hoveredBounds, await navbar.boundingBox());
  await waitForIndicator();
  await page.mouse.move(30, 30);
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
  await page.locator('#mainNavbar a[href="/page/orders-page.html"]').click();
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
    "reports",
    "banks",
    ...Object.keys(upcomingSections),
    "settings",
    "warehouse",
    "orders",
    "customers",
  ]) {
    await navbarLink(`/page/${name}-page.html`).evaluate((link) => link.click());
    await page.waitForURL(`**/page/${name}-page.html`);
    await page.locator("#mainNavbar").waitFor({ state: "visible" });
    await pageReady();
    await page.waitForFunction(
      () => !document.querySelector('[aria-busy="true"]'),
    );
    assert.equal(await page.locator("#mainNavbar").count(), 1);
    assertSameBounds(restBounds, await navbar.boundingBox());
    assert.equal(await navbar.locator(".navbar-indicator").count(), 1);
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
    if (upcomingSections[name]) {
      const heading = page.getByRole("heading", {
        name: `${upcomingSections[name]} در حال ساخت است`,
      });
      assert.equal(await heading.isVisible(), true);
      assert.equal(
        await page.getByText("این بخش در به‌روزرسانی‌های بعدی اضافه می‌شود.").isVisible(),
        true,
      );
      assert.equal(
        await navbarLink(`/page/${name}-page.html`).getAttribute("aria-current"),
        "page",
      );
      await waitForIndicator();
      await page.getByRole("link", { name: "بازگشت به داشبورد" }).click();
      await page.waitForURL("**/index.html");
      await pageReady();
    }
    if (name === "settings") {
      for (const section of [
        "members",
        "expenses",
        "document-accounts",
        "banks",
        "products",
        "invoices",
      ]) {
        await clickSettingsSection(page, section);
        await page
          .locator(`[data-settings-panel="${section}"]`)
          .waitFor({ state: "visible" });
        await page.waitForFunction(
          () => !document.querySelector('[aria-busy="true"]'),
        );
      }
    }
  }
  await page.locator('#mainNavbar a[href="/page/banks-page.html"]').click();
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
  await page.locator('#mainNavbar a[href="/page/customers-page.html"]').click();
  await idleCustomers();

  // Hold the first document response so we can retarget midway through a slide.
  await page.mouse.move(30, 30);
  await waitForIndicator();
  await page.route("**/page/orders-page.html", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue().catch(() => {});
  });
  const retarget = await page.evaluate(async () => {
    const dot = document.querySelector(".navbar-indicator");
    document.querySelector('#mainNavbar a[href="/page/orders-page.html"]').click();
    const [slide] = document.querySelector(".navbar-indicator").getAnimations();
    await new Promise((resolve) => setTimeout(resolve, 65));
    const elapsed = slide?.currentTime;
    const before = dot.getBoundingClientRect();
    document.querySelector('#mainNavbar a[href="/page/reports-page.html"]').click();
    return {
      elapsed,
      sameNode: dot === document.querySelector(".navbar-indicator"),
      distance: Math.abs(dot.getBoundingClientRect().x - before.x),
    };
  });
  assert.ok(retarget.elapsed > 0 && retarget.elapsed < 240, "first slide must be in progress");
  assert.equal(retarget.sameNode, true);
  assert.ok(retarget.distance < 1, "retargeting must continue from the visible point");
  await page.waitForURL("**/reports-page.html");
  await pageReady();
  await waitForIndicator();
  await page.unroute("**/page/orders-page.html");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await navbarLink("/page/settings-page.html").evaluate((link) => link.click());
  await page.waitForURL("**/settings-page.html");
  await pageReady();
  assert.equal(
    await navbar.locator(".navbar-indicator").evaluate((dot) => dot.getAnimations().length),
    0,
  );
  await waitForIndicator();

  assert.deepEqual(errors, []);
  if (process.env.KARBON_SCREENSHOT)
    await page.screenshot({ path: process.env.KARBON_SCREENSHOT });
  console.log(
    "PASS: navigation destinations, state and history, stable dock geometry, one sliding indicator, rapid retargeting, and reduced motion",
  );
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), errors }));
  throw error;
} finally {
  await browser.close();
}

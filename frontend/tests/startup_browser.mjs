// Exercise the loading stage itself, including the failed-import layout from
// the reported screenshot. Run only against the disposable browser fixture.
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
const routes = [
  "/index.html",
  ...[
    "customers",
    "orders",
    "finance",
    "attendance",
    "daily-tasks",
    "documents",
    "banks",
    "settings",
  ].map((name) => `/page/${name}-page.html`),
  "/page/bank-transactions-page.html?bank=2",
  "/page/login-page.html",
];
const ready = (page) =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const shell = async (page, login = false) => {
  if (login) return;
  assert.equal(await page.locator("#mainNavbar").count(), 1);
  assert.equal(await page.locator("#mainNavbar").isVisible(), true);
  assert.equal(
    await page.locator('#mainNavbar [aria-current="page"]').count(),
    1,
  );
  assert.equal(
    await page
      .locator(".orders-create")
      .evaluateAll((buttons) =>
        buttons.every((button) => button.closest(".navbar-title-island")),
      ),
    true,
  );
};
let token;
let currentPage;
const errors = [];
async function makePage(viewport = { width: 1751, height: 957 }) {
  const page = await browser.newPage({ viewport });
  currentPage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.addInitScript((token) => {
    if (!sessionStorage.getItem("fixture-auth-installed")) {
      localStorage.setItem("karbon_auth", JSON.stringify({ token }));
      sessionStorage.setItem("fixture-auth-installed", "true");
    }
    window.startupPaints = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.startupPaints.push({
          name: entry.name,
          time: entry.startTime,
          navbar: Boolean(document.getElementById("mainNavbar")),
          actionsInNavbar: [
            ...document.querySelectorAll(".orders-create"),
          ].every((button) => button.closest(".navbar-title-island")),
        });
    }).observe({ type: "paint", buffered: true });
  }, token);
  return page;
}

try {
  const loginPage = await browser.newPage();
  const login = await loginPage.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(login.ok(), true);
  ({ token } = await login.json());
  await loginPage.close();

  // A slow shared dependency must not blank the document or move buttons.
  const slow = await makePage();
  await slow.route("**/src/js/components/api-cache.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await slow.goto(`${base}/page/customers-page.html`, { waitUntil: "commit" });
  await slow.waitForFunction(() =>
    window.startupPaints?.some(
      (entry) => entry.name === "first-contentful-paint",
    ),
  );
  const first = await slow.evaluate(() =>
    window.startupPaints.find(
      (entry) => entry.name === "first-contentful-paint",
    ),
  );
  assert.equal(first.navbar && first.actionsInNavbar, true);
  assert.ok(
    first.time < 2500,
    `slow imports blocked the complete document for ${first.time} ms`,
  );
  await shell(slow);
  const before = await slow.locator(".navbar-dock").boundingBox();
  await ready(slow);
  const after = await slow.locator(".navbar-dock").boundingBox();
  assert.ok(
    Math.abs(before.y - after.y) < 1 &&
      Math.abs(before.width - after.width) < 1,
  );
  assert.equal(await slow.locator("#pageStartupError").count(), 0);
  await slow.close();

  // Exercise the startup watchdog deterministically, then a late success.
  const late = await makePage();
  await late.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) =>
      schedule(callback, delay === 20000 ? 400 : delay, ...args);
  });
  let releaseImport;
  const importGate = new Promise((resolve) => { releaseImport = resolve; });
  await late.route("**/src/js/components/api-cache.js", async (route) => {
    await importGate;
    await route.continue();
  });
  await late.goto(`${base}/page/customers-page.html`, { waitUntil: "commit" });
  await late.locator('#pageStartupError[data-failure-kind="timeout"]').waitFor({ state: "visible" });
  await shell(late);
  assert.equal(await late.locator("#customersLoading").isVisible(), false);
  releaseImport();
  await ready(late);
  assert.equal(await late.locator("#pageStartupError").count(), 0);
  assert.equal(await late.locator("#customersList > *").count(), 12);
  await late.close();

  for (const route of routes) {
    const page = await makePage();
    await page.route("**/src/js/components/api-cache.js", (request) =>
      request.abort("failed"),
    );
    await page.goto(`${base}${route}`);
    await page.locator("#pageStartupError").waitFor({ state: "visible" });
    await shell(page, route.includes("login-page"));
    assert.equal(
      await page.locator("[data-initial-loading]:visible").count(),
      0,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.pageState),
      "error",
    );
    if (route.includes("customers") && process.env.KARBON_FAILURE_SCREENSHOT)
      await page.screenshot({ path: process.env.KARBON_FAILURE_SCREENSHOT });
    await page.unroute("**/src/js/components/api-cache.js");
    await page.locator("#retryPageStartup").click();
    await ready(page);
    assert.equal(await page.locator("#pageStartupError").count(), 0);
    await shell(page, route.includes("login-page"));
    await page.close();
  }

  // Network/5xx failure during session validation must not delete credentials.
  for (const status of [0, 503]) {
    const page = await makePage();
    await page.route("**/api/auth/me", (route) =>
      status
        ? route.fulfill({
            status,
            contentType: "application/json",
            body: '{"detail":"unavailable"}',
          })
        : route.abort("failed"),
    );
    await page.goto(`${base}/page/customers-page.html`);
    await page.locator("#pageStartupError").waitFor({ state: "visible" });
    assert.ok(page.url().endsWith("/page/customers-page.html"));
    assert.equal(
      await page.evaluate(() => Boolean(localStorage.getItem("karbon_auth"))),
      true,
    );
    assert.equal(await page.locator("#customersLoading").isVisible(), false);
    await shell(page);
    await page.unroute("**/api/auth/me");
    await page.locator("#retryPageStartup").click();
    await ready(page);
    assert.equal(await page.locator("#customersList > *").count(), 12);
    await page.locator("#logoutButton").click();
    await page.waitForURL("**/page/login-page.html");
    await ready(page);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("karbon_auth")),
      null,
    );
    await page.close();
  }

  // Small screens and reduced motion use the same stable shell and controls.
  const mobile = await makePage({ width: 390, height: 844 });
  await mobile.emulateMedia({ reducedMotion: "reduce" });
  await mobile.goto(`${base}/page/customers-page.html`);
  await ready(mobile);
  await shell(mobile);
  await mobile.locator("#openCreateCustomerButton").click();
  await mobile.locator("#customerFormModal").waitFor({ state: "visible" });
  await mobile.locator("#closeCustomerFormButton").click();
  await mobile.locator("#customerFormModal").waitFor({ state: "hidden" });
  await mobile.locator('a[href="/page/orders-page.html"]').click();
  await mobile.waitForURL("**/page/orders-page.html");
  await ready(mobile);
  await mobile.goBack({ waitUntil: "commit" });
  await ready(mobile);
  await shell(mobile);
  assert.equal(await mobile.locator("#customerFormModal").isVisible(), false);
  if (process.env.KARBON_MOBILE_SCREENSHOT)
    await mobile.screenshot({ path: process.env.KARBON_MOBILE_SCREENSHOT });
  await mobile.close();

  // Rapid native document changes also exercise cached modules and transitions.
  const rapid = await makePage();
  for (let round = 0; round < 2; round++) {
    for (const route of routes.filter((route) => !route.includes("login-page"))) {
      await rapid.goto(`${base}${route}`);
      await ready(rapid);
      await shell(rapid);
      assert.equal(await rapid.locator("#pageStartupError").count(), 0);
      await rapid.waitForFunction(() => window.startupPaints.some((entry) => entry.name === "first-contentful-paint"));
      assert.equal(await rapid.evaluate(() => window.startupPaints.every((entry) => entry.navbar && entry.actionsInNavbar)), true);
    }
  }
  await rapid.close();
  console.log(
    JSON.stringify({
      pages: routes.length,
      result:
        "PASS: slow imports, timeout and late recovery, failed imports and retry on every page, offline/5xx auth recovery, logout, mobile dialogs, reduced motion, history and 20 rapid document changes",
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ url: currentPage?.url(), errors,
    state: currentPage && !currentPage.isClosed() ? await currentPage.evaluate(() => ({ ready: document.readyState, pageState: document.documentElement.dataset.pageState, notice: document.getElementById("pageStartupError")?.textContent })) : null }));
  throw error;
} finally {
  await browser.close();
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Only run against tests/performance/run.py with its disposable synthetic DB.
const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5529";
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    ...(process.env.KARBON_CHROME_PATH
      ? { executablePath: process.env.KARBON_CHROME_PATH }
      : {}),
  });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    }),
    page = await context.newPage();
  const errors = [],
    assetErrors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && !new URL(r.url()).pathname.startsWith("/api/"))
      assetErrors.push([r.status(), r.url()]);
  });
  const login = await context.request.post(base + "/api/login", {
    data: { username: "customers-test", password: "test-password" },
  });
  const { token } = await login.json(),
    headers = { Authorization: "Bearer " + token };
  await context.addInitScript((token) => {
    localStorage.setItem("karbon_auth", JSON.stringify({ token }));
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) window.bfcacheRestored = true;
    });
  }, token);
  const ready = async () => {
    await page.waitForFunction(
      () => document.documentElement.dataset.pageState === "ready",
    );
    await page.locator('#dashboardWorkspace[aria-busy="false"]').waitFor();
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  };
  let tools = 0;
  page.on("request", (r) => {
    if (/layout-tools[.]/.test(r.url())) tools++;
  });
  await page.goto(base + "/index.html");
  await ready();
  await page.waitForFunction(
    () => document.querySelector("#revenueChart svg")?.children.length > 0,
  );
  assert.equal(tools, 0, "layout tools must stay deferred");
  assert.equal(await page.locator(".dash-plot svg").count(), 12);
  assert.ok(
    await page
      .locator("#documentsChart svg")
      .evaluate((e) => !e.children.length),
    "offscreen charts should defer drawing",
  );
  const api = await (
    await context.request.get(base + "/api/dashboard", { headers })
  ).json();
  const exact = (value) => new Intl.NumberFormat("fa-IR").format(BigInt(value));
  assert.equal(
    await page.locator("#inventoryValue").textContent(),
    exact(api.inventory.value),
  );
  // A cached history restore must allow a previously offscreen widget to load.
  await page.goto(base + "/page/finance-page.html");
  await page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
  await page.goBack({ waitUntil: "commit" });
  await ready();
  assert.equal(
    await page.evaluate(() => window.bfcacheRestored),
    true,
    "exercise an actual cached-history restore",
  );
  // SVG colors still resolve the CSS design tokens, including live changes.
  const color = await page.evaluate(() => {
    const host = document.querySelector(".dashboard");
    host.style.setProperty("--dash-blue-mid", "rgb(1, 2, 3)");
    const stop = document.querySelector(
      '#revenueChart linearGradient[id$="bar-0"] stop',
    );
    const value = getComputedStyle(stop).stopColor;
    host.style.removeProperty("--dash-blue-mid");
    return value;
  });
  assert.equal(color, "rgb(1, 2, 3)");
  await page.route("**/api/dashboard?**", (route) =>
    new URL(route.request().url()).searchParams.get("view") === "debtors"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"detail":"synthetic detail failure"}',
        })
      : route.continue(),
  );
  await page.locator("#debtorsTable").scrollIntoViewIfNeeded();
  const retry = page
    .locator("#debtorsTable")
    .locator("..")
    .getByRole("button", { name: "تلاش مجدد", exact: true });
  await retry.waitFor();
  assert.equal(
    await page.locator("#inventoryValue").textContent(),
    exact(api.inventory.value),
  );
  await page.unroute("**/api/dashboard?**");
  await retry.click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("#debtorsTable tbody tr").length === count,
    api.customers.debtors.length,
  );
  await page.waitForTimeout(100);
  let refreshRequests = 0;
  const countRefresh = (request) => {
    if (new URL(request.url()).pathname === "/api/dashboard") refreshRequests++;
  };
  page.on("request", countRefresh);
  const visibleRefresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/dashboard" &&
      new URL(response.url()).searchParams.get("view") === "summary",
  );
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("focus"));
  });
  const snapshot = await visibleRefresh;
  assert.equal(
    new URL(snapshot.url()).searchParams.get("include_debtors"),
    "true",
  );
  assert.equal(
    (await snapshot.json()).customers.debtors.length,
    api.customers.debtors.length,
  );
  await ready();
  await page.waitForTimeout(100);
  page.off("request", countRefresh);
  assert.equal(
    refreshRequests,
    1,
    "focus events must refresh visible details in the summary snapshot without duplicate reads",
  );
  await page.locator("#productsChart").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (count) =>
      Number(document.getElementById("productsChart").dataset.visiblePoints) ===
      count,
    api.product_sales.length,
  );
  // Unrelated task updates preserve a chart's selected window and actual SVG nodes.
  await page.locator('#revenueChart button[aria-label="بزرگ‌نمایی"]').click();
  await page.evaluate(() => {
    window.retainedChartNode =
      document.querySelector("#revenueChart svg").firstChild;
    window.retainedKpiNode = document.querySelector(
      '[data-widget-id="net"] .dash-kpi-content',
    ).firstChild;
  });
  const task = await context.request.post(base + "/api/tasks", {
    headers,
    data: {
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tehran",
      }).format(new Date()),
      title: "isolated widget refresh check",
    },
  });
  assert.equal(task.ok(), true);
  const refreshed = page.waitForResponse(
    (r) =>
      r.url().includes("/api/dashboard?") &&
      new URL(r.url()).searchParams.get("view") === "summary",
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("karbon-data-change")),
  );
  await refreshed;
  await ready();
  assert.equal(
    await page.locator("#revenueChart").getAttribute("data-visible-points"),
    "15",
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.retainedChartNode ===
        document.querySelector("#revenueChart svg").firstChild,
    ),
    true,
    "unrelated updates must not redraw a chart",
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.retainedKpiNode ===
        document.querySelector('[data-widget-id="net"] .dash-kpi-content')
          .firstChild,
    ),
    true,
    "unrelated updates must not reconstruct a summary widget",
  );
  await page.locator("#editDashboardLayout").click();
  await page.waitForFunction(
    () => document.getElementById("dashboardGrid").dataset.editing === "true",
  );
  assert.equal(tools, 1);
  const widget = page.locator('[data-widget="revenue"]');
  await widget.locator(".dash-resize-handle").focus();
  await page.keyboard.press("ArrowLeft");
  const width = await widget.getAttribute("data-w");
  await page.locator("#saveDashboardLayout").click();
  await page.reload();
  await ready();
  assert.equal(await widget.getAttribute("data-w"), width);
  for (const w of [390, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 1000 });
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Finance selectors fetch one page and keep a selected identity outside it.
  await page.goto(base + "/page/finance-page.html");
  await page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
  await page.locator("#recordIncome").click();
  await page.waitForFunction(
    () => !document.getElementById("submitTransaction").disabled,
  );
  assert.equal(await page.locator("#transactionSource option").count(), 101);
  const search = page.getByRole("searchbox", {
    name: "جستجوی نام، کد یا تلفن مشتری",
  });
  await search.fill("1001");
  await page.waitForFunction(
    () =>
      !!document.querySelector('#transactionSource option[value="1"]') &&
      !document.getElementById("submitTransaction").disabled,
  );
  await page.locator("#transactionSource").selectOption("1");
  assert.equal(
    await page.locator("#transactionAccountCode").inputValue(),
    "1001",
  );
  await search.fill("");
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#transactionSource option").length === 102 &&
      !document.getElementById("submitTransaction").disabled,
  );
  assert.equal(await page.locator("#transactionSource").inputValue(), "1");
  const more = page
    .locator("#transactionSource")
    .locator("..")
    .getByRole("button", { name: "نمایش بیشتر", exact: true });
  await more.click();
  await page.waitForFunction(
    () => document.querySelectorAll("#transactionSource option").length === 202,
  );
  assert.equal(await page.locator("#transactionSource").inputValue(), "1");
  for (let i = 0; i < 8; i++) {
    await more.click();
    await page.waitForFunction(
      () => !document.getElementById("submitTransaction").disabled,
    );
  }
  assert.equal(
    await page.locator("#transactionSource option").count(),
    1001,
    "the selected off-page customer must not be duplicated on the last page",
  );
  await page.route("**/api/customers/options?**", (route) =>
    new URL(route.request().url()).searchParams.get("search") === "broken"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"detail":"synthetic search failure"}',
        })
      : route.continue(),
  );
  await search.fill("broken");
  const searchRetry = page
    .locator("#transactionSource")
    .locator("..")
    .getByRole("button", { name: "تلاش مجدد", exact: true });
  await searchRetry.waitFor();
  await page.unroute("**/api/customers/options?**");
  await search.fill("1001");
  await page.waitForFunction(
    () =>
      !!document.querySelector('#transactionSource option[value="1"]') &&
      !document.getElementById("submitTransaction").disabled,
  );
  assert.equal(await page.locator("#transactionSource").inputValue(), "1");
  await page.locator("#transactionModal [data-dialog-close]").first().click();
  await page.locator("#transactionModal").waitFor({ state: "hidden" });
  // The selected customer on an existing receipt can be outside the first page.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
  }).format(new Date());
  const day = await (
    await context.request.get(base + "/api/finance/day?date=" + today, {
      headers,
    })
  ).json();
  const receipt = day.transactions.find(
    (row) =>
      row.kind === "income" &&
      !row.invoice &&
      !row.document_id &&
      row.customer_id === 1,
  );
  assert.ok(receipt, "run audit_api.py after --writes before this test");
  const menu = page.locator(
    `summary[aria-label="تنظیمات تراکنش ${receipt.transaction_number || receipt.id}"]`,
  );
  await menu.click();
  await menu
    .locator("..")
    .getByRole("button", { name: "ویرایش", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.getElementById("editSave") &&
      !document.getElementById("editSave").disabled,
  );
  assert.equal(await page.locator("#editSource").inputValue(), "1");
  assert.equal(await page.locator("#editCode").inputValue(), "1001");
  assert.deepEqual(errors, []);
  assert.deepEqual(assetErrors, []);
  console.log(
    "PASS: progressive detail failure/retry, complete data, CSS tokens, isolated widget updates, zoom, lazy layout tools, saved layouts, responsive widths, finance search/pagination/selection/error recovery and off-page receipt customer",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

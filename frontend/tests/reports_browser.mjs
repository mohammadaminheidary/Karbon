import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const settled = async () => {
  await page.waitForFunction(
    () =>
      document
        .querySelector("#reportsDialog form")
        ?.getAttribute("aria-busy") === "false",
  );
  assert.equal(
    await page.locator("#reportError").isVisible(),
    false,
    await page.locator("#reportError").textContent(),
  );
};
const preview = async (action) => {
  const response = page.waitForResponse((r) => r.url().endsWith("/preview"));
  await action();
  const r = await response;
  assert.equal(r.status(), 200, await r.text());
  await settled();
  return r.json();
};
try {
  await page.goto(base + "/page/login-page.html");
  await page.evaluate(
    (token) => localStorage.setItem("karbon_auth", JSON.stringify({ token })),
    process.env.KARBON_REPORT_TOKEN,
  );
  for (const [path, expected] of [
    ["customers", "customers"],
    ["orders", "orders"],
    ["finance", "financial_transactions"],
    ["warehouse", "products"],
    ["documents", "documents"],
    ["attendance", "attendance"],
    ["daily-tasks", "tasks"],
    ["banks", "bank_accounts"],
    ["bank-transactions", "financial_transactions"],
  ]) {
    await page.goto(
      base +
        `/page/${path}-page.html${path === "bank-transactions" ? "?bank_id=1" : ""}`,
    );
    await ready();
    await preview(() => page.locator("#openReportsButton").click());
    assert.equal(await page.locator("#reportModule").inputValue(), expected);
    assert.equal(await page.locator("#reportTable tbody tr").count(), 50);
    assert.equal(
      await page.locator("#reportsDialog").evaluate((e) => e.open),
      true,
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector("#reportsDialog").open,
    );
    assert.equal(
      await page
        .locator("#openReportsButton")
        .evaluate((e) => e === document.activeElement),
      true,
    );
  }
  await page.goto(base + "/page/customers-page.html");
  await ready();
  await preview(() => page.locator("#openReportsButton").click());
  // Every supported dataset can be inspected independently in the report surface.
  const modules = await page
    .locator("#reportModule option")
    .evaluateAll((els) => els.map((e) => e.value));
  assert.equal(modules.length, 15);
  for (const name of modules) {
    const result = await preview(() =>
      page.locator("#reportModule").selectOption(name),
    );
    assert.equal(result.total, name === "customers" ? 999 : 1000);
    assert.equal(result.items.length, 50);
  }
  await preview(() => page.locator("#reportModule").selectOption("customers"));
  await page.locator("#reportTable tbody input").first().check();
  assert.equal(await page.locator("#reportXlsx").isEnabled(), true);
  await preview(() => page.locator("#reportNext").click());
  assert.match(await page.locator("#reportSelectionCount").textContent(), /۱/);
  await page.locator("#reportTable tbody input").first().check();
  let download = page.waitForEvent("download");
  const xResponse = page.waitForResponse((r) =>
    r.url().endsWith("/export/xlsx"),
  );
  await page.locator("#reportXlsx").click();
  const xr = await xResponse;
  assert.equal(xr.status(), 200);
  assert.equal(xr.request().postDataJSON().ids.length, 2);
  await (await download).saveAs("/tmp/karbon-reports-browser-selected.xlsx");
  await settled();
  await page.locator("#reportSelectAll").check();
  await page.locator("#reportTable tbody input").first().uncheck();
  assert.match(
    await page.locator("#reportSelectionCount").textContent(),
    /۹۹۸/,
  );
  download = page.waitForEvent("download");
  const pResponse = page.waitForResponse((r) =>
    r.url().endsWith("/export/pdf"),
  );
  await page.locator("#reportPdf").click();
  const pr = await pResponse;
  assert.equal(pr.status(), 200);
  assert.equal(pr.request().postDataJSON().excluded_ids.length, 1);
  assert.equal(pr.request().postDataJSON().ids, undefined);
  await (await download).saveAs("/tmp/karbon-reports-browser-selected.pdf");
  await settled();
  // A column hidden by the user never enters either file.
  await page.locator("#reportColumns summary").click();
  await preview(() =>
    page.locator('#reportColumnList input[value="notes"]').uncheck(),
  );
  assert.equal(
    await page
      .locator("#reportTable th small")
      .allTextContents()
      .then((a) => a.includes("notes")),
    false,
  );
  await page.locator("#reportAllColumns").click();
  await settled();
  await page.locator("#reportColumns summary").click();
  // Filter dates use the app's Persian calendar while preserving stored dates.
  await preview(() => page.locator("#reportModule").selectOption("orders"));
  await page.locator("details").first().locator("summary").click();
  await page.locator("#reportFrom").fill("۱۴۰۵/۰۸/۰۹");
  await page.locator("#reportTo").fill("۱۴۰۵/۰۸/۰۹");
  await page.locator("#reportAddFilter").click();
  const filter = page.locator(".reports-filter-row");
  await filter.locator("select").first().selectOption("status");
  await filter.locator("input").fill("active");
  const filtered = await preview(() =>
    page.getByRole("button", { name: "اعمال فیلترها", exact: true }).click(),
  );
  assert.equal(filtered.total, 500);
  assert.match(await page.locator("#reportSelectionCount").textContent(), /۰/);
  await page.locator("#reportFrom").fill("۱۴۰۵/۰۸/۱۰");
  const bad = page.waitForResponse((r) => r.url().endsWith("/preview"));
  await page
    .getByRole("button", { name: "اعمال فیلترها", exact: true })
    .click();
  assert.equal((await bad).status(), 422);
  await page.locator("#reportError").waitFor();
  assert.equal(await page.locator("#reportXlsx").isEnabled(), false);
  await preview(() => page.locator("#reportReset").click());
  // Close, reopen and recover from API failures without stale rows.
  await page.route("**/api/reports/orders/preview", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "خطای آزمایشی" }),
    }),
  );
  await page
    .getByRole("button", { name: "اعمال فیلترها", exact: true })
    .click();
  await page.locator("#reportError").waitFor();
  assert.equal(await page.locator("#reportTable tbody tr").count(), 0);
  await page.unroute("**/api/reports/orders/preview");
  await preview(() => page.locator("#reportRetry").click());
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("#reportsDialog").open,
  );
  // Responsive layout and reduced motion retain usable controls and focus.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await preview(() => page.locator("#openReportsButton").click());
  const bounds = await page.locator("#reportsDialog").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  assert.equal(
    await page
      .locator("#reportsDialog")
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    true,
  );
  await page.screenshot({ path: "/tmp/karbon-reports-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.locator("#reportModule").focus();
  await page.screenshot({ path: "/tmp/karbon-reports-desktop.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 9 module entry points, all 15 datasets, pagination, cross-page selection, select-all exclusions, real XLSX/PDF downloads, fields, Persian dates, filters, error recovery, focus, mobile and reduced motion.",
  );
} finally {
  await browser.close();
}

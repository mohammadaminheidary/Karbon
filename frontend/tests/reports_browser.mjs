import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
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
    const originalNavbar = await page.evaluate(() => ({
      width: document
        .querySelector(".navbar-title-island")
        .getBoundingClientRect().width,
      whitespace: getComputedStyle(document.querySelector(".navbar-page-title"))
        .whiteSpace,
    }));
    assert.deepEqual(
      originalNavbar,
      { width: 185, whitespace: "nowrap" },
      `original navbar on ${path}`,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page
        .locator(".navbar-dock")
        .evaluate((e) => e.getBoundingClientRect().width),
      310,
      `original mobile navbar on ${path}`,
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.locator('#mainNavbar a[href="/page/reports-page.html"]').click();
    await page.waitForURL("**/page/reports-page.html");
    await ready();
    assert.equal(
      await page.locator('a[aria-current="page"]').getAttribute("href"),
      "/page/reports-page.html",
    );
    await preview(() => page.locator("#openReportsButton").click());
    if ((await page.locator("#reportModule").inputValue()) !== expected)
      await preview(() => page.locator("#reportModule").selectOption(expected));
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
  await page.goto(base + "/page/reports-page.html");
  await ready();
  await preview(() => page.locator("#openReportsButton").click());
  assert.equal(await page.locator("#reportHistoryList > li").count(), 0);
  assert.equal(
    await page.locator("#reportHistoryTitle").textContent(),
    "۰ گزارش",
  );
  await page.locator("#reportName").fill("گزارش مشتریان <ذخیره>");
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
  // Saved history refreshes after generation, survives reload, and downloads
  // the original bytes without creating a new report.
  await page.waitForFunction(
    () => document.querySelectorAll("#reportHistoryList > li").length === 2,
  );
  assert.equal(
    await page.locator("#reportHistoryTitle").textContent(),
    "۲ گزارش",
  );
  assert.equal(
    await page.locator("#refreshReports").getAttribute("title"),
    "بروزرسانی گزارش‌ها",
  );
  assert.equal(await page.locator("#refreshReports svg").count(), 1);
  assert.deepEqual(await page.locator(".report-format").allTextContents(), [
    "PDF",
    "Excel",
  ]);
  assert.equal(
    await page.locator("#reportHistoryList h2").first().textContent(),
    "گزارش مشتریان <ذخیره>",
  );
  await page.reload();
  await ready();
  assert.equal(await page.locator("#reportHistoryList > li").count(), 2);
  assert.match(
    await page.locator(".report-history-metadata").first().textContent(),
    /شناسه: ۲/,
  );
  download = page.waitForEvent("download");
  await page.locator(".report-download").first().click();
  await (await download).saveAs("/tmp/karbon-reports-history.pdf");
  assert.deepEqual(
    readFileSync("/tmp/karbon-reports-history.pdf"),
    readFileSync("/tmp/karbon-reports-browser-selected.pdf"),
  );
  assert.equal(await page.locator("#reportHistoryList > li").count(), 2);
  await page.route("**/api/reports/history?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "خطای آزمایشی" }),
    }),
  );
  await page.locator("#refreshReports").click();
  await page.locator("#reportHistoryError").waitFor();
  assert.equal(await page.locator("#reportHistoryList > li").count(), 2);
  await page.unroute("**/api/reports/history?*");
  await page.locator("#refreshReports").click();
  await page.waitForFunction(
    () => document.querySelector("#reportHistoryError").hidden,
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#reportHistoryList").getAttribute("aria-busy") ===
      "false",
  );
  // Right-island names and action labels fit at desktop, tablet, mobile, and 125% type.
  for (const width of [1440, 1100, 1024, 1023, 768, 640, 639, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.evaluate(() =>
      window.KarbonAppearance.updatePreferences({ fontSize: 125 }),
    );
    const layout = await page.evaluate(() => {
      const dock = document
        .querySelector(".navbar-dock")
        .getBoundingClientRect();
      const title = document.querySelector(".navbar-page-title");
      const button = document.querySelector("#openReportsButton");
      const label = button.querySelector("span");
      return {
        fits:
          document.documentElement.scrollWidth <= innerWidth &&
          dock.left >= 0 &&
          dock.right <= innerWidth + 1,
        titleFits: title.scrollWidth <= title.clientWidth + 1,
        buttonFits: button.scrollWidth <= button.clientWidth + 1,
        labelVisible: getComputedStyle(label).display !== "none",
      };
    });
    assert.deepEqual(
      layout,
      { fits: true, titleFits: true, buttonFits: true, labelVisible: true },
      `navbar at ${width}px`,
    );
  }
  await page.evaluate(() =>
    window.KarbonAppearance.updatePreferences({ fontSize: 100 }),
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: "/tmp/karbon-report-history-desktop.png" });
  // Responsive layout and reduced motion retain usable controls and focus.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() =>
    window.KarbonAppearance.updatePreferences({ theme: "green" }),
  );
  await page.screenshot({ path: "/tmp/karbon-report-history-mobile.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
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
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("#reportsDialog").open,
  );
  // Whole cards are native links; the download button remains independent.
  const observer = await context.newPage();
  await observer.goto(base + "/page/reports-page.html");
  await observer.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
  let deletions = 0;
  page.on("request", (r) => {
    if (r.method() === "DELETE") deletions++;
  });
  const cardBounds = await page
    .locator(".report-history-entry")
    .first()
    .boundingBox();
  await page.mouse.click(cardBounds.x + 10, cardBounds.y + 10);
  await page.waitForURL("**/report-details-page.html?id=*");
  await ready();
  const detailsURL = page.url();
  assert.equal(
    await page
      .locator(".navbar-title-island")
      .evaluate((e) => e.getBoundingClientRect().width),
    185,
    "details page keeps the original navbar",
  );
  assert.match(
    await page.locator("#reportDetailsMetadata").textContent(),
    /شناسه گزارش/,
  );
  assert.equal(
    await page.locator("#reportDetailsTitle").textContent(),
    "گزارش مشتریان <ذخیره>",
  );
  assert.equal(await page.locator("#reportDetailsMetadata > div").count(), 7);
  assert.equal(
    await page.locator('a[aria-current="page"]').getAttribute("href"),
    "/page/reports-page.html",
  );
  download = page.waitForEvent("download");
  await page.locator(".report-download").click();
  await (await download).saveAs("/tmp/karbon-report-details.pdf");
  assert.deepEqual(
    readFileSync("/tmp/karbon-report-details.pdf"),
    readFileSync("/tmp/karbon-reports-browser-selected.pdf"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: "/tmp/karbon-report-details-mobile.png" });
  await page.locator("#deleteReport").click();
  await page.locator("#reportDeleteDialog[open]").waitFor();
  assert.equal(
    await page
      .locator("#cancelDeleteReport")
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("#reportDeleteDialog").open,
  );
  assert.equal(deletions, 0);
  assert.equal(
    await page
      .locator("#deleteReport")
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.route("**/api/reports/history/*", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "خطای آزمایشی حذف" }),
        })
      : route.continue(),
  );
  await page.locator("#deleteReport").click();
  await page.locator("#confirmDeleteReport").click();
  await page.locator("#reportDeleteError").waitFor();
  assert.equal(
    await page.locator("#reportDeleteDialog").evaluate((e) => e.open),
    true,
  );
  await page.unroute("**/api/reports/history/*");
  await page.screenshot({ path: "/tmp/karbon-report-details-delete.png" });
  await page.locator("#confirmDeleteReport").evaluate((e) => {
    e.click();
    e.click();
  });
  await page.waitForURL("**/reports-page.html");
  await ready();
  assert.equal(
    deletions,
    2,
    "one failed attempt and one successful confirmed deletion",
  );
  assert.equal(
    await page.locator("#reportHistoryTitle").textContent(),
    "۱ گزارش",
  );
  await observer.waitForFunction(
    () =>
      document.querySelector("#reportHistoryTitle").textContent === "۱ گزارش",
  );
  await page.locator(".report-card-link").click();
  await ready();
  await page.locator("#deleteReport").click();
  await page.locator("#confirmDeleteReport").click();
  await page.waitForURL("**/reports-page.html");
  await ready();
  assert.equal(
    await page.locator("#reportHistoryTitle").textContent(),
    "۰ گزارش",
  );
  assert.equal(await page.locator("#reportHistoryList > li").count(), 0);
  await observer.waitForFunction(
    () =>
      document.querySelector("#reportHistoryTitle").textContent === "۰ گزارش",
  );
  await observer.close();
  await page.goto(detailsURL);
  await ready();
  await page.locator("#reportDetailsError").waitFor();
  assert.equal(await page.locator("#reportDetails").isVisible(), false);
  await page.goto(base + "/page/report-details-page.html?id=invalid");
  await ready();
  assert.equal(await page.locator("#reportDetailsError").isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Reports-only navbar width (other module navbars unchanged), visible IDs, report cards/details, confirmed deletion/cancel/error/retry, automatic counts across tabs, responsive navbar labels at 125%, icon refresh, standalone history from 9 module entry points, saved metadata and original downloads after reload, refresh error recovery, all 15 datasets, pagination, cross-page selection, select-all exclusions, real XLSX/PDF downloads, fields, Persian dates, filters, error recovery, focus, mobile and reduced motion.",
  );
} finally {
  await browser.close();
}

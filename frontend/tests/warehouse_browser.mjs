// Run beside serve_customers_fixture.py with an empty disposable database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5519";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const panelReady = () =>
  page.waitForFunction(
    () =>
      document.getElementById("purchaseEntryPage").getAttribute("aria-busy") ===
        "false" && !document.getElementById("purchaseEntryPage").hidden,
  );
const open = async () => {
  await page.locator("#buyItemsButton").click();
  await panelReady();
  await page.locator("#purchaseItemName").waitFor({ state: "visible" });
};
try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/index.html");
  // Exercise the empty-selection case, including the seeded central catalog.
  const token = await page.evaluate(
    () => JSON.parse(localStorage.getItem("karbon_auth")).token,
  );
  const headers = { Authorization: `Bearer ${token}` };
  const options = await (
    await page.request.get(`${base}/api/settings/inventory-options`, {
      headers,
    })
  ).json();
  for (const unit of options.units) {
    const response = await page.request.put(
      `${base}/api/settings/inventory-options/units/${unit.id}`,
      {
        headers,
        data: { name: unit.name, active: false },
      },
    );
    assert.ok(response.ok());
  }
  await page.locator('a[href="/page/warehouse-page.html"]').click();
  await ready();
  assert.equal(await page.locator("#buyItemsButton svg").count(), 0);
  await open();
  assert.equal(
    await page.locator("dialog[open], [aria-modal=true]").count(),
    0,
  );
  assert.equal(await page.locator("#purchaseItemName").isDisabled(), true);
  assert.equal(
    await page.locator("#purchaseUnit").evaluate((el) => el.readOnly),
    true,
  );
  assert.match(
    await page.locator("#purchaseOptionsStatus").textContent(),
    /تعریف نشده/,
  );
  await page.locator('.purchase-guidance a[href$="#inventory"]').click();
  await page.waitForURL("**/settings-page.html#inventory");
  await ready();
  await page.locator("#inventory-categories-name").fill("مواد اولیه آزمایش");
  await page.locator("#inventory-categories-form button").click();
  await page
    .locator("#inventory-categories-list")
    .getByText("مواد اولیه آزمایش", { exact: true })
    .waitFor();
  await page.locator('[data-settings-target="units"]').click();
  await page.locator("#inventory-units-name").fill("متر آزمایش");
  await page.locator("#inventory-units-form button").click();
  await page
    .locator("#inventory-units-list")
    .getByText("متر آزمایش", { exact: true })
    .waitFor();
  await page.reload();
  await ready();
  await page
    .locator("#inventory-units-list")
    .getByText("متر آزمایش", { exact: true })
    .waitFor();
  await page.locator('[data-settings-target="products"]').click();
  await page.locator("#settingsProductCategory:enabled").waitFor();
  await page
    .locator("#settingsProductCategory")
    .selectOption({ label: "مواد اولیه آزمایش" });
  await page.locator("#settingsProductName").fill("کالای آزمایش");
  await page.locator("#settingsProductUnit").selectOption("متر آزمایش");
  await page.locator("#settingsProductStock").fill("0");
  await page.locator("#settingsProductPrice").fill("1000");
  const savedProduct = page.waitForResponse(
    (r) => r.url().endsWith("/api/products") && r.request().method() === "POST",
  );
  await page.locator("#saveSettingsProduct").click();
  const product = await (await savedProduct).json();
  await page.locator(`[data-product-id="${product.id}"]`).waitFor();
  await page.locator('a[href="/page/warehouse-page.html"]').click();
  await ready();
  await open();
  assert.equal(
    await page
      .locator("#purchaseCategory option")
      .allTextContents()
      .then((a) => a.join("|")),
    "انتخاب دسته‌بندی|عمومی|مواد اولیه آزمایش",
  );
  assert.equal(await page.locator("#purchaseUnit").inputValue(), "");
  await page.waitForFunction(() =>
    /^PUR-/.test(document.getElementById("purchaseInvoiceNumber").value),
  );
  const invoice = await page.locator("#purchaseInvoiceNumber").inputValue();
  assert.match(invoice, /^PUR-\d{6,}$/);
  const today = await page.evaluate(() => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tehran",
        calendar: "persian",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(new Date())
        .map(({ type, value }) => [type, value]),
    );
    return `${p.year}/${p.month}/${p.day}`;
  });
  assert.equal(await page.locator("#purchaseDate").inputValue(), today);
  await page
    .locator("#purchaseCategory")
    .selectOption({ label: "مواد اولیه آزمایش" });
  await page.locator("#purchaseItemName").selectOption(String(product.id));
  assert.equal(await page.locator("#purchaseUnit").inputValue(), "متر آزمایش");
  await page.locator("#purchaseQuantity").fill("۲");
  await page.locator("#purchasePrice").fill("12000");
  await page.locator("#reloadPurchaseOptions").click();
  await panelReady();
  assert.notEqual(await page.locator("#purchaseCategory").inputValue(), "");
  await page.locator("#closePurchaseEntry").click();
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  await open();
  assert.equal(
    await page.locator("#purchaseItemName").inputValue(),
    String(product.id),
  );
  assert.equal(
    await page.locator("#purchaseInvoiceNumber").inputValue(),
    invoice,
  );
  await page.goBack();
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  await page.goForward();
  await panelReady();
  await page.locator("#newPurchaseEntry").click();
  assert.equal(await page.locator("#purchaseItemName").inputValue(), "");
  // Unsaved previews may be reused; final numbers are allocated atomically.
  assert.equal(await page.locator("#purchaseDate").inputValue(), today);
  // Check the actual panel and navbar geometry at desktop, tablet and mobile.
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const panel = document.getElementById("purchaseEntryPage"),
        r = panel.getBoundingClientRect();
      const buy = document
        .getElementById("buyItemsButton")
        .getBoundingClientRect();
      const island = document
        .querySelector(".navbar-title-island")
        .getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= innerWidth,
        panelFits:
          r.left >= 0 &&
          r.right <= innerWidth &&
          r.top >= 0 &&
          r.bottom <= innerHeight,
        contentFits: panel.scrollWidth <= panel.clientWidth,
        buttonFits: buy.left >= island.left && buy.right <= island.right,
      };
    });
    assert.deepEqual(
      layout,
      { pageFits: true, panelFits: true, contentFits: true, buttonFits: true },
      `${width}px`,
    );
    if (process.env.KARBON_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.KARBON_SCREENSHOT_DIR}/karbon-purchase-${width}.png`,
      });
  }
  // Server errors leave a retry action; succeeding again restores the selects.
  await page.route("**/api/settings/inventory-options", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"detail":"خطای آزمایشی"}',
    }),
  );
  await page.locator("#reloadPurchaseOptions").click();
  await page.locator('#purchaseOptionsStatus[role="alert"]').waitFor();
  assert.equal(await page.locator("#purchaseItemName").isDisabled(), true);
  await page.unroute("**/api/settings/inventory-options");
  await page.locator("#reloadPurchaseOptions").click();
  await panelReady();
  assert.equal(await page.locator("#purchaseCategory").isDisabled(), false);
  // Closing quickly during animation must not leave a hidden warehouse.
  await page.locator("#purchaseDate").focus();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  await page.evaluate(() => {
    document.getElementById("buyItemsButton").click();
  });
  await page.waitForFunction(() => location.hash === "#purchase");
  await page.evaluate(() =>
    document.getElementById("closePurchaseEntry").click(),
  );
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  assert.equal(await page.locator(".warehouse").isVisible(), true);
  assert.equal(await page.locator("#mainNavbar").isVisible(), true);
  // Deactivated settings never appear as purchase options.
  await page.goto(`${base}/page/settings-page.html#units`);
  await ready();
  await page
    .getByRole("checkbox", { name: "متر آزمایش", exact: true })
    .uncheck();
  await page.waitForFunction(
    () => !document.querySelector("#inventory-units-list input:disabled"),
  );
  await page.goto(`${base}/page/warehouse-page.html#purchase`);
  await ready();
  await panelReady();
  assert.equal(await page.locator("#purchaseItemName").isDisabled(), true);
  assert.equal(await page.locator("#purchaseUnit").inputValue(), "");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Settings persistence, active-only options, date/invoice IDs, form entry, error/retry, non-modal panel, Back/Forward, rapid close, responsive navbar and layout",
  );
} finally {
  await browser.close();
}

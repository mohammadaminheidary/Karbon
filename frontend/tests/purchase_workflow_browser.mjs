// Run against serve_customers_fixture.py. All records belong to its temporary DB.
import { fillDate, readDate, dateParts } from "./date-input-helpers.mjs";
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
const optionsReady = () =>
  page.waitForFunction(
    () =>
      document.getElementById("purchaseEntryPage").getAttribute("aria-busy") ===
        "false" && !document.getElementById("purchaseEntryPage").dataset.morph,
  );
const status = page.locator("#purchaseOptionsStatus");
const suffix = Date.now();
const categoryName = `مواد خرید ${suffix}`;
const otherCategoryName = `ملزومات خرید ${suffix}`;
const productName = `کالای خرید ${suffix}`;
const otherProductName = `کالای دیگر ${suffix}`;

async function api(path, method = "GET", body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const { financeRequest } = await import("/src/js/finance/finance-api.js");
      return financeRequest(path, { method, body, cache: "no-store" });
    },
    { path, method, body },
  );
}

async function category(name) {
  await page.goto(`${base}/page/settings-page.html#inventory`);
  await ready();
  await page.locator("#inventory-categories-name").fill(name);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings/inventory-options/categories") &&
      response.request().method() === "POST",
  );
  await page.locator("#inventory-categories-form button[type=submit]").click();
  const response = await saved;
  assert.equal(response.status(), 201);
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("#inventory-categories-list li")].some(
        (row) => row.textContent.includes(name),
      ),
    name,
  );
  return response.json();
}

async function product(name, categoryId, unit, stock) {
  await page.goto(`${base}/page/settings-page.html#products`);
  await ready();
  await page.locator("#openCreateProductButton").click();
  await page.waitForFunction(
    () =>
      !document.getElementById("settingsProductUnit").disabled &&
      !document.getElementById("settingsProductCategory").disabled,
  );
  await page.locator("#settingsProductName").fill(name);
  await page
    .locator("#settingsProductCategory")
    .selectOption(String(categoryId));
  await page.locator("#settingsProductUnit").selectOption(unit);
  await page.locator("#settingsProductPrice").fill("1000");
  await page.locator("#settingsProductStock").fill(String(stock));
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/products") &&
      response.request().method() === "POST",
  );
  await page.locator("#saveSettingsProduct").click();
  const response = await saved;
  assert.equal(response.status(), 201, await response.text());
  const result = await response.json();
  await page.locator(`[data-product-id="${result.id}"]`).waitFor();
  return result;
}

try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator("button[type=submit]").click();
  await page.waitForURL("**/index.html");
  const firstCategory = await category(categoryName);
  const secondCategory = await category(otherCategoryName);
  const firstProduct = await product(productName, firstCategory.id, "عدد", 10);
  const secondProduct = await product(
    otherProductName,
    secondCategory.id,
    "متر",
    5,
  );

  await page.goto(`${base}/page/warehouse-page.html#purchase`);
  await ready();
  await optionsReady();
  const row = (index) => page.locator("#purchaseRows tr").nth(index);
  const fillRow = async (index, categoryId, productId, quantity, price) => {
    await row(index)
      .locator(".purchase-category")
      .selectOption(String(categoryId));
    await row(index)
      .locator(".purchase-product")
      .selectOption(String(productId));
    await row(index).locator(".purchase-quantity").fill(String(quantity));
    await row(index).locator(".purchase-price").fill(String(price));
  };
  const summary = async () =>
    page.evaluate(() => ({
      quantity: document.getElementById("purchaseQuantityTotal").textContent,
      rows: document.getElementById("purchaseRowCount").textContent,
      total: document.getElementById("purchaseInvoiceTotal").textContent,
    }));
  const nf = (value) => new Intl.NumberFormat("fa-IR").format(value);
  const expectSummary = async (quantity, rows, total) =>
    assert.deepEqual(await summary(), {
      quantity: nf(quantity),
      rows: nf(rows),
      total: `${nf(total)} تومان`,
    });
  assert.equal(
    await row(0)
      .locator(".purchase-product")
      .evaluate((el) => el.tagName),
    "SELECT",
  );
  assert.equal(
    await dateParts(page, "purchaseDate").evaluateAll((fields) =>
      fields.length === 3 && fields.every((field) => field.readOnly),
    ),
    false,
  );
  assert.equal(
    await row(0)
      .locator(".purchase-unit")
      .evaluate((el) => el.readOnly),
    true,
  );
  assert.equal(
    await row(0)
      .locator(".purchase-total")
      .evaluate((el) => el.readOnly),
    true,
  );
  assert.equal(await row(0).locator(".document-remove-row").isDisabled(), true);
  assert.equal(await page.locator("#savePurchaseEntry").isDisabled(), true);
  assert.equal(await page.locator(".purchase-options-help").count(), 0);
  assert.deepEqual(
    await page
      .locator(".purchase-guidance a")
      .evaluateAll((links) => links.map((el) => el.getAttribute("href"))),
    ["/page/settings-page.html#inventory", "/page/settings-page.html#products"],
  );
  await expectSummary(0, 1, 0);
  await fillDate(page, "purchaseDate", "۱۴۰۵/۰۸/۰۹");
  await fillRow(0, firstCategory.id, firstProduct.id, "۳", "700");
  assert.equal(await row(0).locator(".purchase-unit").inputValue(), "عدد");
  assert.equal(await row(0).locator(".purchase-total").inputValue(), nf(2100));
  assert.deepEqual(
    await row(0)
      .locator(".purchase-product option")
      .evaluateAll((options) => options.map((el) => el.value)),
    ["", String(firstProduct.id)],
  );
  await row(0)
    .locator(".purchase-category")
    .selectOption(String(secondCategory.id));
  assert.equal(await row(0).locator(".purchase-product").inputValue(), "");
  assert.equal(await row(0).locator(".purchase-unit").inputValue(), "");
  await row(0)
    .locator(".purchase-product")
    .selectOption(String(secondProduct.id));
  assert.equal(await row(0).locator(".purchase-unit").inputValue(), "متر");
  await fillRow(0, firstCategory.id, firstProduct.id, "۳", "700");
  await page.locator("#reloadPurchaseOptions").click();
  await optionsReady();
  assert.equal(await readDate(page, "purchaseDate"), "1405/08/09");
  assert.equal(
    await row(0).locator(".purchase-product").inputValue(),
    String(firstProduct.id),
  );

  await page.locator("#addPurchaseRow").click();
  assert.equal(
    await row(1)
      .locator(".purchase-category")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await expectSummary(3, 2, 2100);
  await page.locator("#savePurchaseEntry").click();
  assert.match(await status.textContent(), /ردیف 2/);
  assert.equal(
    await row(1).locator(".purchase-category").getAttribute("aria-invalid"),
    "true",
  );
  await fillRow(1, secondCategory.id, secondProduct.id, 2, 900);
  await expectSummary(5, 2, 3900);
  await page.locator("#addPurchaseRow").click();
  await fillRow(2, firstCategory.id, firstProduct.id, 4, 500);
  await expectSummary(9, 3, 5900);
  await row(1).locator(".document-remove-row").click();
  await expectSummary(7, 2, 4100);
  assert.equal(
    await row(1)
      .locator(".purchase-category")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await row(1).locator(".purchase-category").getAttribute("aria-label"),
    "دسته‌بندی ردیف 2",
  );
  await page.locator("#addPurchaseRow").click();
  await fillRow(2, secondCategory.id, secondProduct.id, 2, 900);
  await expectSummary(9, 3, 5900);
  await row(2).locator(".purchase-price").fill("bad");
  await expectSummary(9, 3, 4100);
  assert.equal(await row(2).locator(".purchase-total").inputValue(), "—");
  await page.locator("#savePurchaseEntry").click();
  assert.match(await status.textContent(), /ردیف 3/);
  await row(2).locator(".purchase-price").fill("900");
  await row(0).locator(".purchase-quantity").fill("0");
  await page.locator("#savePurchaseEntry").click();
  assert.match(await status.textContent(), /مقدار خرید/);
  await row(0).locator(".purchase-quantity").fill("1.5");
  await page.locator("#savePurchaseEntry").click();
  assert.match(await status.textContent(), /عدد صحیح/);
  await row(0).locator(".purchase-quantity").fill("۳");
  await expectSummary(9, 3, 5900);
  await page.locator("#reloadPurchaseOptions").click();
  await optionsReady();
  await expectSummary(9, 3, 5900);
  assert.equal(
    await row(2).locator(".purchase-product").inputValue(),
    String(secondProduct.id),
  );

  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById("purchaseEntryPage"),
        sheet = document.querySelector(".purchase-sheet");
      const controls = [
        ...document.querySelectorAll(
          "#purchaseRows tr:first-child input, #purchaseRows tr:first-child select",
        ),
      ];
      return {
        fields: controls.map((el) => el.className),
        tops: controls.map((el) => el.getBoundingClientRect().top),
        lefts: controls.map((el) => el.getBoundingClientRect().left),
        scrolls: sheet.scrollWidth > sheet.clientWidth,
        fits:
          panel.scrollWidth <= panel.clientWidth &&
          document.documentElement.scrollWidth <= innerWidth,
      };
    });
    assert.equal(geometry.fits, true, `${width}px must not overflow`);
    assert.deepEqual(geometry.fields, [
      "purchase-category",
      "purchase-product",
      "purchase-quantity",
      "purchase-unit",
      "purchase-price",
      "purchase-total",
    ]);
    assert.ok(
      Math.max(...geometry.tops) - Math.min(...geometry.tops) < 1,
      `${width}px single horizontal row`,
    );
    assert.ok(
      geometry.lefts.every(
        (left, index) => index === 0 || left < geometry.lefts[index - 1],
      ),
      "RTL field order",
    );
    if (width <= 768)
      assert.equal(
        geometry.scrolls,
        true,
        "Table scrolls inside its sheet, like document entry",
      );
    if (width === 1440 || width === 390)
      await page.screenshot({
        path: `/tmp/karbon-purchase-rows-${width}.png`,
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fillDate(page, "purchaseDate", "1405/12/30");
  const invalid = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/purchases") && response.status() === 422,
  );
  await page.locator("#savePurchaseEntry").click();
  await invalid;
  await page.waitForFunction(
    () =>
      document.getElementById("purchaseOptionsStatus").getAttribute("role") ===
      "alert",
  );
  assert.equal(
    (await api("/products")).find((product) => product.id === firstProduct.id)
      .stock,
    10,
  );

  // Commit every row, then lose the response. Reload and retry the same invoice.
  await fillDate(page, "purchaseDate", "۱۴۰۵/۰۸/۰۹");
  let committed;
  await page.route("**/api/purchases", async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    committed = await response.json();
    await route.abort("failed");
  });
  await page.locator("#savePurchaseEntry").click();
  await page.waitForFunction(() =>
    document
      .getElementById("savePurchaseEntry")
      .textContent.includes("تلاش مجدد"),
  );
  assert.equal(committed.row_count, 3);
  assert.equal(committed.total, 5900);
  assert.equal(committed.total_quantity, 9);
  assert.equal(
    (await api("/products")).find((product) => product.id === firstProduct.id)
      .stock,
    17,
  );
  assert.equal(
    (await api("/products")).find((product) => product.id === secondProduct.id)
      .stock,
    7,
  );
  assert.equal(await page.locator("#newPurchaseEntry").isDisabled(), true);
  assert.equal(await page.locator("#addPurchaseRow").isDisabled(), true);
  await page.unroute("**/api/purchases");
  await page.reload();
  await ready();
  await optionsReady();
  assert.equal(await page.locator("#purchaseRows tr").count(), 3);
  assert.equal(await readDate(page, "purchaseDate"), "1405/08/09");
  await expectSummary(9, 3, 5900);
  const retried = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/purchases") &&
      response.request().method() === "POST",
  );
  await page.locator("#savePurchaseEntry").click();
  const receipt = await (await retried).json();
  assert.equal(receipt.id, committed.id);
  await page.waitForFunction(
    () =>
      document.getElementById("savePurchaseEntry").textContent ===
      "خرید ثبت شد",
  );
  assert.deepEqual((await api(`/purchases/${receipt.id}`)).rows, receipt.rows);
  assert.equal(
    await page.locator("#purchaseInvoiceNumber").inputValue(),
    committed.invoice_number,
  );
  assert.match(committed.invoice_number, /^PUR-\d{6,}$/);
  await page.evaluate(() =>
    document.getElementById("purchaseEntryForm").requestSubmit(),
  );
  assert.equal(
    (await api("/products")).find((product) => product.id === firstProduct.id)
      .stock,
    17,
  );

  // Removing the first row keeps the next row usable and protects the final row.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#newPurchaseEntry").click();
  await optionsReady();
  await expectSummary(0, 1, 0);
  await page.locator("#addPurchaseRow").click();
  await row(0).locator(".document-remove-row").click();
  assert.equal(await page.locator("#purchaseRows tr").count(), 1);
  assert.equal(await row(0).locator(".document-remove-row").isDisabled(), true);
  assert.equal(
    await row(0)
      .locator(".purchase-category")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await fillRow(0, secondCategory.id, secondProduct.id, 2, 500);
  await expectSummary(2, 1, 1000);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/purchases") &&
      response.request().method() === "POST",
  );
  await page.locator("#savePurchaseEntry").click();
  const secondReceipt = await (await saved).json();
  assert.notEqual(secondReceipt.invoice_number, receipt.invoice_number);
  assert.equal(
    (await api("/products")).find((product) => product.id === secondProduct.id)
      .stock,
    9,
  );
  await page.waitForFunction(
    () =>
      document.getElementById("savePurchaseEntry").textContent ===
      "خرید ثبت شد",
  );
  await page.locator("#newPurchaseEntry").click();
  await optionsReady();
  await page.evaluate(() => {
    const add = document.getElementById("addPurchaseRow");
    for (let index = 1; index < 101; index++) add.click();
  });
  assert.equal(await page.locator("#purchaseRows tr").count(), 100);
  assert.equal(await page.locator("#addPurchaseRow").isDisabled(), true);
  assert.equal(
    await page
      .locator("#purchaseRows [id]")
      .evaluateAll(
        (nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length,
      ),
    true,
  );
  await page.evaluate(() => {
    for (let index = 0; index < 100; index++)
      document
        .querySelector("#purchaseRows tr:last-child .document-remove-row")
        .click();
  });
  assert.equal(await page.locator("#purchaseRows tr").count(), 1);
  await expectSummary(0, 1, 0);
  await page.goto(`${base}/page/settings-page.html#products`);
  await ready();
  await page.locator(`[data-product-id="${firstProduct.id}"]`).waitFor();
  assert.match(
    await page.locator(`[data-product-id="${firstProduct.id}"]`).textContent(),
    /۱۷/,
  );
  assert.equal(
    await page
      .locator(`[data-product-id="${secondProduct.id}"] button`)
      .last()
      .isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: document-style add/remove/focus, independent category filters and units, immediate row and invoice totals, invalid/empty row rejection, six-field horizontal rows at 320–1440px, multi-row persistence, aggregated inventory, lost-response reload/retry without duplication, mobile submission and legacy product protection",
  );
} finally {
  await browser.close();
}

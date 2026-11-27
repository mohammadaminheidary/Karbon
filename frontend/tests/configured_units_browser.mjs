import { choosePurchaseCategory, selectPurchaseItem, purchaseRow, waitForPurchaseForm } from "./purchase-browser-helpers.mjs";
// Run with serve_customers_fixture.py --customers 3 --orders --finance.
import assert from "node:assert/strict";
import { selectOrderProduct } from "./order_product_picker.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5564";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
page.on("pageerror", (e) => errors.push(e.message));
const login = await context.request.post(base + "/api/login", {
  data: { username: "customers-test", password: "test-password" },
});
assert.ok(login.ok());
const { token } = await login.json();
const headers = { Authorization: `Bearer ${token}` };
await context.addInitScript(
  ({ token, origin }) => {
    if (location.origin === origin)
      localStorage.setItem("karbon_auth", JSON.stringify({ token }));
  },
  { token, origin: new URL(base).origin },
);
async function api(method, path, data, expected = 200) {
  const r = await context.request.fetch(base + "/api" + path, {
    method,
    headers,
    data,
  });
  assert.equal(r.status(), expected, await r.text());
  return r.json();
}
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const optionsReady = () =>
  page.waitForFunction(
    () =>
      document.querySelector('#unitOptionsLists[aria-busy="false"]') &&
      !document.querySelector("#inventory-units-list input:disabled"),
  );
const name = `متر آزمون مرکزی ${Date.now()}`;
const choice = () => page.getByRole("checkbox", { name, exact: true });
try {
  const initial = await api("GET", "/settings/inventory-options");
  assert.ok(initial.units.some((u) => u.name === "عدد"));
  await page.goto(base + "/page/settings-page.html#units");
  await ready();
  await optionsReady();
  const unitsNav = page.locator('[data-settings-target="units"]');
  assert.equal(await unitsNav.textContent().then((t) => t.trim()), "واحد");
  assert.equal(
    await unitsNav.getAttribute("aria-controls"),
    "settings-panel-units",
  );
  assert.equal(
    await page.evaluate(() => {
      const units = document.getElementById("settings-tab-units");
      return ["inventory", "products"].every(
        (section) =>
          document.getElementById(`settings-tab-${section}`).parentElement ===
          units.parentElement,
      );
    }),
    true,
  );
  assert.equal(
    await page
      .locator("#settings-panel-inventory #inventory-units-form")
      .count(),
    0,
  );
  assert.equal(
    await page.locator("#settings-panel-units #inventory-units-form").count(),
    1,
  );
  await page.goto(base + "/page/settings-page.html#inventory");
  await page.locator("#settings-panel-inventory:not(.hidden)").waitFor();
  await page.goBack();
  await page.locator("#settings-panel-units:not(.hidden)").waitFor();
  await page.goForward();
  await page.locator("#settings-panel-inventory:not(.hidden)").waitFor();
  await unitsNav.focus();
  await unitsNav.press("Enter");
  await page.locator("#settings-panel-units:not(.hidden)").waitFor();
  assert.equal(await unitsNav.getAttribute("aria-current"), "true");
  await page.locator('[data-settings-target="general"]').click();
  await page.locator('[data-open-settings-section="units"]').click();
  await optionsReady();
  assert.equal(new URL(page.url()).hash, "#units");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await page.locator("#inventory-units-name").fill(name);
  await page.locator("#inventory-units-form button").click();
  await choice().waitFor();
  await optionsReady();
  assert.equal(await choice().isChecked(), true);
  await page.locator("#inventory-units-search").fill(name);
  assert.equal(await page.locator("#inventory-units-list input").count(), 1);
  await page.locator("#inventory-units-search").fill("هیچ نتیجه");
  assert.match(
    await page.locator("#inventory-units-list").textContent(),
    /پیدا نشد/,
  );
  await page.locator("#inventory-units-search").fill(name);
  // Failed persistence restores the checked state and exposes a retryable error.
  await page.route("**/api/settings/inventory-options/units/*", (route) =>
    route.abort(),
  );
  await choice().click();
  await optionsReady();
  assert.equal(await choice().isChecked(), true);
  assert.equal(
    await page.locator("#unitOptionsStatus").getAttribute("role"),
    "alert",
  );
  await page.unrouteAll({ behavior: "wait" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "/tmp/karbon-units-desktop.png",
    fullPage: true,
  });
  // Create through the actual product form, using the central dropdown.
  await page.locator('[data-settings-target="products"]').click();
  await page.locator("#openCreateProductButton").click();
  await page.locator("#settingsProductUnit:enabled").waitFor();
  assert.equal(
    await page.locator("#settingsProductUnit").evaluate((e) => e.tagName),
    "SELECT",
  );
  assert.equal(
    await page.locator("#settingsProductUnitHint a").getAttribute("href"),
    "#units",
  );
  await page.locator("#settingsProductName").fill(`کالای ${name}`);
  await page
    .locator("#settingsProductCategory")
    .selectOption(String(initial.categories.find((item) => item.active).id));
  await page.locator("#settingsProductUnit").selectOption(name);
  await page.locator("#settingsProductStock").fill("10");
  await page.locator("#settingsProductPrice").fill("1000");
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/products") && r.request().method() === "POST",
  );
  await page.locator("#saveSettingsProduct").click();
  const response = await saved;
  assert.equal(response.status(), 201, await response.text());
  const product = await response.json();
  const category = await api("POST", "/settings/inventory-options/warehouse-categories", { name: `دسته ${name}` }, 201);
  const stored = await api("POST", "/inventory/products", {
    name: product.name, unit: product.unit, price: product.price, warehouse_category_id: category.id,
  }, 201);
  await page.waitForFunction(
    () => !document.getElementById("settingsProductFields").disabled,
  );
  const customer = (await api("GET", "/customers?limit=1")).items[0];
  const body = {
    request_id: crypto.randomUUID(),
    customer_id: customer.id,
    invoice_date: "1405/08/09",
    payment_date: "1405/08/09",
    items: [{ product_id: product.id, quantity: 1, unit_price: 1000 }],
    payments: [],
  };
  const order = await api("POST", "/orders", body, 201);
  const invoice = await api("GET", `/orders/${order.id}/invoice`);
  // An open order in another tab refreshes when settings change.
  const orderPage = await context.newPage();
  await orderPage.goto(base + "/page/orders-page.html");
  await orderPage.locator(".orders-create").click();
  const productSelect = orderPage.locator("#orderItems .item-product").first();
  await selectOrderProduct(productSelect, product);
  assert.equal(
    await orderPage.locator("#orderItems .item-unit").first().textContent(),
    name,
  );
  await page.bringToFront();
  await page.locator('[data-settings-target="units"]').click();
  await optionsReady();
  await choice().uncheck();
  await optionsReady();
  assert.equal(await choice().isChecked(), false);
  await page.reload();
  await ready();
  await optionsReady();
  assert.equal(await choice().isChecked(), false);
  await orderPage.bringToFront();
  await orderPage.waitForFunction(
    () => !document.querySelector("#orderItems .item-product").dataset.productId,
  );
  await productSelect.fill(product.name);
  await orderPage.getByText("کالایی پیدا نشد.", { exact: true }).waitFor();
  assert.equal(
    await orderPage.locator("#orderItems .item-unit").first().textContent(),
    "—",
  );
  assert.equal(
    await orderPage.locator("#orderItems .item-price").first().inputValue(),
    "",
  );
  await orderPage.close();
  await api(
    "POST",
    "/orders",
    { ...body, request_id: crypto.randomUUID() },
    422,
  );
  assert.deepEqual(await api("GET", `/orders/${order.id}/invoice`), invoice);
  await api("POST", "/orders", body, 201);
  await api(
    "POST",
    "/products",
    { name: "واحد ممنوع", unit: name, price: 0 },
    422,
  );
  // New products exclude the unit; editing its owner keeps it explicitly labelled.
  await page.locator('[data-settings-target="products"]').click();
  await page.locator("#openCreateProductButton").click();
  await page.waitForFunction(
    () =>
      document.getElementById("settingsProductUnit").options.length > 1 &&
      !document.getElementById("settingsProductUnit").disabled,
  );
  assert.equal(
    await page
      .locator("#settingsProductUnit option")
      .allTextContents()
      .then((a) => a.some((t) => t.includes(name))),
    false,
  );
  await page.locator("#cancelSettingsProductEdit").click();
  await page
    .locator(`[data-product-id="${product.id}"]`)
    .getByRole("button", { name: "ویرایش", exact: true })
    .click();
  await page.locator("#settingsProductUnit:enabled").waitFor();
  assert.equal(await page.locator("#settingsProductUnit").inputValue(), name);
  assert.match(
    await page.locator("#settingsProductUnit option:checked").textContent(),
    /غیرفعال/,
  );
  await page.locator("#settingsProductPrice").fill("2000");
  const edited = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/products/${product.id}`) &&
      r.request().method() === "PUT",
  );
  await page.locator("#saveSettingsProduct").click();
  assert.equal((await edited).status(), 200);
  // An inactive unit blocks both selectors while their product records remain independent.
  await page.goto(base + "/page/warehouse-page.html#purchase");
  await ready();
  await waitForPurchaseForm(page);
  await choosePurchaseCategory(page, category.id);
  assert.equal(await page.locator(`[data-product-option="${stored.id}"]`).count(), 0);
  assert.equal(await purchaseRow(page).locator(".item-unit").textContent(), "—");
  const options = await api("GET", "/settings/inventory-options");
  for (const u of options.units.filter((u) => u.active))
    await api("PUT", `/settings/inventory-options/units/${u.id}`, {
      name: u.name,
      active: false,
    });
  await page.reload();
  await ready();
  await waitForPurchaseForm(page);
  await choosePurchaseCategory(page, category.id);
  await page.getByText("در این دسته‌بندی کالای قابل خرید وجود ندارد.").waitFor();
  await page.goto(base + "/page/settings-page.html#products");
  await ready();
  await page.locator("#openCreateProductButton").click();
  await page.locator('#settingsProductForm[aria-busy="false"]').waitFor();
  assert.equal(await page.locator("#settingsProductUnit").isDisabled(), true);
  // Re-enable and verify purchase availability and an order's derived unit.
  const unit = options.units.find((u) => u.name === name);
  await api("PUT", `/settings/inventory-options/units/${unit.id}`, {
    name,
    active: true,
  });
  await page.goto(base + "/page/warehouse-page.html#purchase");
  await ready();
  await waitForPurchaseForm(page);
  await selectPurchaseItem(page, category.id, stored.id);
  assert.equal(await purchaseRow(page).locator(".item-unit").textContent(), name);
  await page.goto(base + "/page/settings-page.html#units");
  await ready();
  await optionsReady();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/karbon-units-mobile.png",
    fullPage: true,
  });
  for (const u of initial.units)
    await api("PUT", `/settings/inventory-options/units/${u.id}`, {
      name: u.name,
      active: u.active,
    });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: responsive searchable units, selection/reload, failed-save rollback, product create/edit/legacy units, cross-tab order refresh, API rejection/history/retries, purchase enabled/empty states.",
  );
} catch (error) {
  await page.screenshot({
    path: "/tmp/karbon-units-failure.png",
    fullPage: true,
  });
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
}

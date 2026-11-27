import { clickSettingsSection } from "./settings_navigation.mjs";
// Run beside serve_customers_fixture.py with an empty disposable database.
import { advancePurchasePayment, choosePurchaseCategory, closePurchaseInvoice, fillPurchaseRow, purchaseRow, waitForPurchaseForm } from "./purchase-browser-helpers.mjs";
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
  assert.equal(await page.locator("#openCreateProductButton, #productFormModal").count(), 0);
  assert.equal(await page.locator("#buyItemsButton svg").count(), 0);
  const category = options["warehouse-categories"][0];
  await page.locator("#buyItemsButton").click();
  await waitForPurchaseForm(page);
  await choosePurchaseCategory(page, category.id);
  await page.getByText("در این دسته‌بندی کالای قابل خرید وجود ندارد.").waitFor();
  await page.getByRole("button", { name: "بازگشت به دسته‌بندی‌ها" }).click();
  await page.locator(`[data-category-option="${category.id}"]`).getByText(/عمومی.*۰ کالا/).waitFor();
  await page.goto(`${base}/page/settings-page.html#warehouse-categories`);
  await ready();
  const sections = page.locator("#settingsNavigation details");
  assert.deepEqual(await sections.locator("summary span").allTextContents(),
    ["حساب و مجموعه", "مالی و اسناد", "کالا", "انبار", "برنامه"]);
  const productsGroup = sections.filter({ has: page.locator("#settings-tab-products") });
  const warehouseGroup = sections.filter({ has: page.locator("#settings-tab-warehouse-products") });
  assert.deepEqual(await productsGroup.locator("button span").allTextContents(),
    ["کالاها", "دسته‌بندی کالا", "واحد", "برندها"]);
  assert.deepEqual(await warehouseGroup.locator("button span").allTextContents(),
    ["دسته‌بندی انبار کالا", "کالا (انبار)"]);
  assert.equal(await productsGroup.getAttribute("open"), null);
  await productsGroup.locator("summary").click();
  assert.notEqual(await productsGroup.getAttribute("open"), null);
  await productsGroup.locator("summary").click();
  assert.equal(await productsGroup.getAttribute("open"), null);
  await productsGroup.locator("summary").click();
  await page.locator("#inventory-categories-name").fill("مواد اولیه آزمایش");
  await page.locator("#inventory-categories-submit").click();
  await page
    .locator("#inventory-categories-list")
    .getByText("مواد اولیه آزمایش", { exact: true })
    .waitFor();
  let newCategory = page.locator("#inventory-categories-list [data-category-id]").filter({ hasText: "مواد اولیه آزمایش" });
  await newCategory.getByText("بدون کالا").waitFor();
  await page.locator("#inventory-categories-search").fill("وجود ندارد");
  await page.locator("#inventory-categories-list").getByText("دسته‌بندی پیدا نشد.").waitFor();
  await page.locator("#inventory-categories-search").fill("مواد اولیه");
  await newCategory.getByRole("button", { name: /ویرایش/ }).click();
  await page.locator("#inventory-categories-name").fill("مواد اولیه تولید");
  await page.locator("#inventory-categories-submit").click();
  await page.locator("#inventory-categories-list").getByText("مواد اولیه تولید", { exact: true }).waitFor();
  await clickSettingsSection(page, "inventory");
  await page.locator("#inventory-categories-list").getByText("عمومی", { exact: true }).waitFor();
  assert.equal(await page.locator("#inventory-categories-list").getByText("مواد اولیه تولید").count(), 0);
  await clickSettingsSection(page, "units");
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
  const brandResponse = await page.request.post(`${base}/api/settings/brands`, { headers, data: { name: "هافمن" } });
  assert.equal(brandResponse.status(), 201);
  const brand = await brandResponse.json();
  async function fillFrame() {
    await page.locator("#settingsProductName").fill("فریم");
    await page.locator("#settingsProductUnit").selectOption("متر آزمایش");
    await page.locator("#settingsProductPrice").fill("1000");
    await page.locator("#settingsProductRequiresBrand").check();
    await page.locator("#settingsProductBrand").selectOption(String(brand.id));
  }
  await clickSettingsSection(page, "products");
  await page.locator("#openCreateProductButton").click();
  await fillFrame();
  await page.locator("#settingsProductCategory").selectOption({ label: "عمومی" });
  await page.locator("#settingsProductStock").fill("0");
  const storedSale = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/products" && r.request().method() === "POST");
  await page.locator("#saveSettingsProduct").click();
  const saleResult = await storedSale;
  assert.equal(saleResult.status(), 201, await saleResult.text());
  const salesFrame = await saleResult.json();
  await page.locator(`[data-product-id="${salesFrame.id}"]`).waitFor();
  await clickSettingsSection(page, "warehouse-products");
  await page.locator("#openCreateProductButton").click();
  await fillFrame();
  await page.locator("#settingsProductWarehouseCategory").selectOption({ label: "مواد اولیه تولید" });
  const savedProduct = page.waitForResponse(
    (r) => r.url().endsWith("/api/inventory/products") && r.request().method() === "POST",
  );
  await page.locator("#saveSettingsProduct").click();
  const warehouseResult = await savedProduct;
  assert.equal(warehouseResult.status(), 201, await warehouseResult.text());
  const product = await warehouseResult.json();
  assert.notEqual(product.id, salesFrame.id);
  for (const key of ["name", "brand_id", "unit", "price"]) assert.equal(product[key], salesFrame[key]);
  assert.equal(await page.locator(`[data-product-id="${salesFrame.id}"]`).count(), 0);
  await page.locator(`[data-product-id="${product.id}"]`).waitFor();
  await page.locator('a[href="/page/warehouse-page.html"]').click();
  await ready();
  await page.route("**/api/settings/inventory-options", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"خطای آزمایشی"}' }));
  await page.locator("#buyItemsButton").click();
  await page.locator("#orderRetryLoad").waitFor();
  assert.equal(await page.locator("#orderPay").isDisabled(), true);
  await page.unroute("**/api/settings/inventory-options");
  await page.locator("#orderRetryLoad").click();
  await waitForPurchaseForm(page);
  const field = await choosePurchaseCategory(page, product.warehouse_category_id);
  await field.fill("نتیجه ندارد");
  await page.getByText("کالایی پیدا نشد.", { exact: true }).waitFor();
  await field.fill(product.product_code);
  await page.locator('[data-product-option]').filter({ hasText: /فریم.*هافمن/ }).click();
  assert.equal(await field.getAttribute("data-product-id"), String(product.id));
  assert.equal(await purchaseRow(page).locator(".item-unit").textContent(), "متر آزمایش");
  await page.locator("#createOrderModal header [data-dialog-close]").click();
  await page.locator("#createOrderModal").waitFor({ state: "hidden" });
  const otherResponse = await page.request.post(`${base}/api/inventory/products`, {
    headers,
    data: { name: "کالای دستهٔ عمومی", unit: product.unit,
      warehouse_category_id: options["warehouse-categories"][0].id },
  });
  assert.equal(otherResponse.status(), 201);
  const other = await otherResponse.json();
  await page.locator("#buyItemsButton").click();
  await waitForPurchaseForm(page);
  await fillPurchaseRow(page, product, 2, 12000);
  await page.locator(".orders-add-row").first().click();
  await fillPurchaseRow(page, other, 1, 1000, 1);
  await page.locator("#orderDiscount").fill("500");
  await page.locator("#orderDescription").fill("تحویل آزمایشی به انبار");
  await advancePurchasePayment(page);
  const purchaseResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/purchases");
  await page.locator("#finalizeOrder").click();
  const purchase = await purchaseResponse;
  assert.equal(purchase.status(), 201, await purchase.text());
  const receipt = await purchase.json();
  assert.equal(receipt.rows[0].category_name, "مواد اولیه تولید");
  assert.equal(receipt.rows.length, 2);
  assert.equal(receipt.total, 24500);
  assert.equal(receipt.description, "تحویل آزمایشی به انبار");
  const saved = await (await page.request.get(`${base}/api/inventory/products`, { headers })).json();
  assert.equal(saved.find((item) => item.id === product.id).stock, 2);
  assert.equal(saved.find((item) => item.id === other.id).stock, 1);
  const catalog = await (await page.request.get(`${base}/api/products`, { headers })).json();
  assert.equal(catalog.find((item) => item.id === salesFrame.id).stock, 0);
  assert.ok(!catalog.some((item) => [product.id, other.id].includes(item.id)));
  await closePurchaseInvoice(page);
  await page.getByRole("link", { name: "فاکتورهای خرید" }).click();
  await page.locator("#settingsInvoicesList").getByText(receipt.invoice_number, { exact: true }).waitFor();
  const salesOnlyResponse = await page.request.post(`${base}/api/products`, {
    headers,
    data: { name: "کالای فقط فروخته‌شده", category_id: salesFrame.category_id, unit: product.unit, stock: 12 },
  });
  assert.equal(salesOnlyResponse.status(), 201);
  const salesOnly = await salesOnlyResponse.json();
  const warehouseTwin = await (await page.request.post(`${base}/api/inventory/products`, {
    headers, data: { name: salesOnly.name, unit: salesOnly.unit, warehouse_category_id: other.warehouse_category_id },
  })).json();
  const removableResponse = await page.request.post(`${base}/api/inventory/products`, {
    headers,
    data: { name: "کالای دوم برای حذف گروهی", unit: product.unit,
      warehouse_category_id: other.warehouse_category_id },
  });
  assert.equal(removableResponse.status(), 201);
  const removable = await removableResponse.json();
  const customers = await (await page.request.get(`${base}/api/customers/options`, { headers })).json();
  const sale = await page.request.post(`${base}/api/orders`, {
    headers,
    data: { request_id: crypto.randomUUID(), customer_id: customers.items[0].id,
      invoice_date: "1405/08/09", payment_date: "1405/08/09",
      items: [{ product_id: salesOnly.id, quantity: 2, unit_price: 1000 }] },
  });
  assert.equal(sale.status(), 201, await sale.text());
  const order = await sale.json();
  await clickSettingsSection(page, "warehouse-products");
  const warehouseCard = page.locator(`[data-product-id="${warehouseTwin.id}"]`);
  const secondWarehouseCard = page.locator(`[data-product-id="${removable.id}"]`);
  await warehouseCard.getByText(/موجودی انبار ۰/).waitFor();
  await warehouseCard.getByRole("checkbox").check();
  assert.equal(await page.locator("#selectAllWarehouseProducts").evaluate((input) => input.indeterminate), true);
  await page.locator("#selectAllWarehouseProducts").check();
  assert.equal(await secondWarehouseCard.getByRole("checkbox").isChecked(), true);
  assert.equal(await page.locator(`[data-product-id="${other.id}"]`).getByRole("checkbox").count(), 0);
  await page.getByRole("button", { name: "حذف انتخاب‌شده‌ها" }).click();
  await page.locator("#deleteDescription").getByText(/۲ کالای انتخاب‌شده/).waitFor();
  await page.locator("#financeDeletePassword").fill("test-password");
  await page.locator("#financeDeleteSubmit").click();
  await warehouseCard.waitFor({ state: "detached" });
  await secondWarehouseCard.waitFor({ state: "detached" });
  await clickSettingsSection(page, "products");
  const salesCard = page.locator(`[data-product-id="${salesOnly.id}"]`);
  await salesCard.getByText(/موجودی فروش ۱۰/).waitFor();
  assert.equal(await salesCard.getByRole("button", { name: /^حذف کالا/ }).isDisabled(), true);
  assert.equal((await page.request.get(`${base}/api/orders/${order.id}/invoice`, { headers })).status(), 200);
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
  await waitForPurchaseForm(page);
  await choosePurchaseCategory(page, product.warehouse_category_id);
  await page.getByText("در این دسته‌بندی کالای قابل خرید وجود ندارد.").waitFor();
  await page.goto(`${base}/page/settings-page.html#warehouse-categories`);
  await ready();
  newCategory = page.locator("#inventory-categories-list [data-category-id]").filter({ hasText: "مواد اولیه تولید" });
  await newCategory.getByText("۱ کالا", { exact: true }).waitFor();
  await newCategory.getByRole("button", { name: /حذف/ }).click();
  await page.locator("#inventory-category-delete-description").getByText(/۱ کالا بدون دسته‌بندی انبار می‌مانند/).waitFor();
  await page.locator("#inventory-category-delete-confirm").click();
  await newCategory.waitFor({ state: "detached" });
  await clickSettingsSection(page, "warehouse-products");
  await page.locator(`[data-product-id="${product.id}"]`).getByText(/بدون دسته‌بندی انبار/).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: split Settings, category management and assignment, purchase picker and search, stock update, error/retry and shared invoice form",
  );
} finally {
  await browser.close();
}

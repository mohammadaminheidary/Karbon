// Run against serve_customers_fixture.py with a disposable database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5501";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.KARBON_CHROME_PATH,
});

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const login = await context.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(login.status(), 200);
  const { token } = await login.json();
  await context.addInitScript(
    ({ origin, token }) => {
      if (location.origin === origin)
        localStorage.setItem("karbon_auth", JSON.stringify({ token }));
    },
    { origin: new URL(base).origin, token },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const $ = (selector) => page.locator(selector);
  const trigger = $("#openCreateProductButton");
  const modal = $("#productFormModal");
  const brandChoice = $("#settingsProductBrand");
  const requiresBrand = $("#settingsProductRequiresBrand");
  const ready = () => $("html[data-page-state=ready]").waitFor();
  const formReady = () =>
    $(
      "#productFormModal[open]:not([data-morph]) #settingsProductFields:enabled",
    ).waitFor();
  const result = (method, path) =>
    page.waitForResponse(
      (response) =>
        response.request().method() === method &&
        new URL(response.url()).pathname === `/api${path}`,
    );
  const openProduct = async () => {
    const url = page.url();
    await trigger.click();
    await formReady();
    assert.equal(page.url(), url);
    assert.equal(
      await modal.evaluate((element) =>
        element.matches(":modal.navbar-registration-panel"),
      ),
      true,
    );
    assert.equal(
      await $(".navbar-dock").evaluate((element) =>
        element.classList.contains("document-dock-open"),
      ),
      true,
    );
  };

  await page.goto(`${base}/page/settings-page.html#brands`);
  await ready();
  assert.equal(await trigger.isVisible(), false);
  const brandList = $("#brandSettingsList");
  const createBrand = result("POST", "/settings/brands");
  await $("#brandSettingsName").fill("Acme");
  await $("#saveBrand").click();
  const created = await createBrand;
  assert.equal(created.status(), 201);
  const brand = await created.json();
  await brandList.getByText("Acme", { exact: true }).waitFor();
  await $("#settings-tab-products").click();
  assert.equal(
    await trigger.evaluate((element) =>
      element.parentElement.classList.contains("orders-title-island"),
    ),
    true,
  );
  await openProduct();
  assert.equal(await brandChoice.isVisible(), false);
  await $("#settingsProductName").fill("Fixture panel");
  await $("#settingsProductCategory").selectOption({ index: 1 });
  await $("#settingsProductUnit").selectOption("عدد");
  await $("#settingsProductStock").fill("5");
  await $("#settingsProductPrice").fill("1000");
  await requiresBrand.check();
  assert.equal(await brandChoice.getAttribute("required"), "");
  await $("#saveSettingsProduct").click();
  await $("#productFormError")
    .filter({ hasText: "برند کالا را از تنظیمات انتخاب کنید." })
    .waitFor();
  await brandChoice.selectOption({ label: "Acme" });
  const save = result("POST", "/products");
  await $("#saveSettingsProduct").click();
  const saved = await save;
  assert.equal(saved.status(), 201, await saved.text());
  const product = await saved.json();
  assert.equal(product.brand_id, brand.id);
  const productRow = $(`[data-product-id="${product.id}"]`);
  await productRow.getByText(/Fixture panel · Acme/).waitFor();

  await $("#settings-tab-brands").click();
  await brandList.getByRole("button", { name: "ویرایش برند Acme" }).click();
  await $("#brandSettingsName").fill("Acme Tools");
  await $("#saveBrand").click();
  await brandList.getByText("Acme Tools", { exact: true }).waitFor();
  const deleteButton = brandList.getByRole("button", {
    name: "حذف برند Acme Tools",
  });
  await deleteButton.click();
  const blocked = result("DELETE", `/settings/brands/${brand.id}`);
  await $("#confirmBrandDelete").click();
  assert.equal((await blocked).status(), 409);
  await $("#brandDeleteError")
    .filter({ hasText: /به کالا اختصاص دارد/ })
    .waitFor();
  await $("#cancelBrandDelete").click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/page/warehouse-page.html`);
  await ready();
  await $("#warehouseInventory").getByText("Acme Tools").waitFor();
  await page.goto(`${base}/page/settings-page.html#products`);
  await ready();
  assert.equal(await trigger.locator("span").isVisible(), false);
  await openProduct();
  const bounds = await modal.boundingBox();
  assert.ok(
    bounds.x >= 0 &&
      bounds.x + bounds.width <= 390 &&
      bounds.y >= 0 &&
      bounds.y + bounds.height <= 844,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.id === "openCreateProductButton",
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await openProduct();
  await $("#settingsProductName").fill("Unbranded stock");
  await $("#settingsProductCategory").selectOption(String(product.category_id));
  await $("#settingsProductUnit").selectOption("عدد");
  await $("#settingsProductStock").fill("0");
  const unbranded = result("POST", "/products");
  await $("#saveSettingsProduct").click();
  const unbrandedProduct = await unbranded;
  assert.equal(unbrandedProduct.status(), 201, await unbrandedProduct.text());
  const unbrandedData = await unbrandedProduct.json();
  assert.deepEqual([unbrandedData.brand_id, unbrandedData.price], [null, 0]);
  await page.goto(`${base}/page/warehouse-page.html`);
  await ready();
  await $("#warehouseInventory").getByText("Unbranded stock").waitFor();
  await $("#buyItemsButton").click();
  await $("#purchaseCategory:enabled").selectOption(
    String(product.category_id),
  );
  await $("#purchaseItemName option")
    .filter({ hasText: "Fixture panel · Acme Tools" })
    .waitFor({ state: "attached" });

  await page.goto(`${base}/page/orders-page.html`);
  await ready();
  await $(".orders-create").click();
  await $(".item-product option")
    .filter({ hasText: "Fixture panel · Acme Tools" })
    .waitFor({ state: "attached" });

  await page.goto(`${base}/page/settings-page.html#products`);
  await productRow.getByRole("button", { name: "ویرایش", exact: true }).click();
  await formReady();
  assert.equal(await requiresBrand.isChecked(), true);
  assert.equal(await brandChoice.inputValue(), String(brand.id));
  assert.equal(await $("#settingsProductStock").inputValue(), "5");
  await requiresBrand.uncheck();
  await $("#settingsProductPrice").clear();
  assert.equal(await brandChoice.isVisible(), false);
  const edit = result("PUT", `/products/${product.id}`);
  await $("#saveSettingsProduct").click();
  const edited = await edit;
  assert.equal(edited.status(), 200, await edited.text());
  const data = await edited.json();
  assert.deepEqual(
    [data.brand_id, data.requires_brand, data.stock, data.price],
    [null, false, 5, 0],
  );
  await modal.waitFor({ state: "hidden" });
  await $("#settings-tab-brands").click();
  await deleteButton.click();
  const deleteBrand = result("DELETE", `/settings/brands/${brand.id}`);
  await $("#confirmBrandDelete").click();
  assert.equal((await deleteBrand).status(), 200);
  await deleteButton.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    "Brand settings, desktop and mobile navbar registration, validation, editing, inventory, purchase and sales passed.",
  );
} finally {
  await browser.close();
}

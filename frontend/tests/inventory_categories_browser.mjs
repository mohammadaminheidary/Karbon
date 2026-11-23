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
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const errors = [];
context.on("page", (page) =>
  page.on("pageerror", (error) => errors.push(error.message)),
);

const login = await context.request.post(base + "/api/login", {
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

const waitForLabel = (page, selector, label) =>
  page.waitForFunction(
    ([selector, label]) =>
      [...document.querySelectorAll(selector)].some(
        (item) => item.label === label,
      ),
    [selector, label],
  );
const readySettings = (page) =>
  page.locator("#inventoryOptionsLists[aria-busy=false]").waitFor();
const response = (page, method, path) =>
  page.waitForResponse(
    (r) => r.request().method() === method && r.url().endsWith(path),
  );

try {
  const settings = await context.newPage();
  await settings.goto(base + "/page/settings-page.html#inventory");
  await readySettings(settings);
  const path = "/api/settings/inventory-options/categories";
  const name = settings.locator("#inventory-categories-name");
  const parent = settings.locator("#inventory-categories-parent");
  const tree = settings.locator("#inventory-categories-list");
  async function save(title, method = "POST", id = null) {
    await name.fill(title);
    const saved = response(
      settings,
      method,
      id === null ? path : path + "/" + id,
    );
    await settings.locator("#inventory-categories-submit").click();
    const result = await saved;
    assert.equal(
      result.status(),
      method === "POST" ? 201 : 200,
      await result.text(),
    );
    await readySettings(settings);
    return result.json();
  }
  const main = await save("UPVC");
  await tree
    .getByRole("button", { name: "افزودن زیردسته UPVC", exact: true })
    .click();
  assert.equal(await parent.inputValue(), String(main.id));
  const door = await save("Door");
  await parent.selectOption(String(main.id));
  const window = await save("Window");
  const branch = tree.locator(`[data-category-id="${main.id}"] > ul`);
  assert.deepEqual(
    await branch
      .locator("[data-category-id]")
      .evaluateAll((items) =>
        items.map((item) => Number(item.dataset.categoryId)),
      ),
    [door.id, window.id],
  );

  const dialog = settings.locator("#inventory-category-delete");
  await branch
    .getByRole("button", { name: "حذف UPVC / Window", exact: true })
    .click();
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /UPVC \/ Window/);
  await settings.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await branch.getByText("Window", { exact: true }).count(), 1);
  await branch
    .getByRole("button", { name: "حذف UPVC / Window", exact: true })
    .click();
  const deleted = response(settings, "DELETE", path + "/" + window.id);
  await settings.locator("#inventory-category-delete-confirm").click();
  assert.equal((await deleted).status(), 200);
  await branch
    .getByText("Window", { exact: true })
    .waitFor({ state: "detached" });
  await readySettings(settings);

  for (const width of [320, 768, 1440]) {
    await settings.setViewportSize({ width, height: 1000 });
    assert.ok(
      await settings.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await settings.locator('[data-settings-target="products"]').click();
  await settings.locator("#openCreateProductButton").click();
  await waitForLabel(
    settings,
    "#settingsProductCategory option",
    "UPVC / Door",
  );
  await settings
    .locator("#settingsProductCategory")
    .selectOption(String(door.id));
  await settings.locator("#settingsProductName").fill("UPVC panel");
  await settings.locator("#settingsProductUnit").selectOption("عدد");
  await settings.locator("#settingsProductStock").fill("10");
  await settings.locator("#settingsProductPrice").fill("1000");
  const created = response(settings, "POST", "/api/products");
  await settings.locator("#saveSettingsProduct").click();
  const result = await created;
  assert.equal(result.status(), 201, await result.text());
  const product = await result.json();
  await settings
    .locator(`[data-product-id="${product.id}"]`)
    .getByRole("button", { name: "ویرایش" })
    .click();
  await settings.locator("#settingsProductCategory:enabled").waitFor();
  assert.equal(
    await settings.locator("#settingsProductCategory").inputValue(),
    String(door.id),
  );
  await settings.locator("#cancelSettingsProductEdit").click();

  const warehouse = await context.newPage();
  await warehouse.goto(base + "/page/warehouse-page.html#purchase");
  await waitForLabel(warehouse, "#purchaseCategory option", "UPVC / Door");
  await warehouse.locator("#purchaseCategory").selectOption(String(door.id));
  await warehouse.locator("#purchaseItemName").selectOption(String(product.id));

  await settings.bringToFront();
  await settings.locator('[data-settings-target="inventory"]').click();
  await readySettings(settings);
  await tree.getByRole("button", { name: "ویرایش UPVC", exact: true }).click();
  await save("UPVC frames", "PUT", main.id);
  await tree
    .getByRole("button", { name: "حذف UPVC frames / Door", exact: true })
    .click();
  const blocked = response(settings, "DELETE", path + "/" + door.id);
  await settings.locator("#inventory-category-delete-confirm").click();
  assert.equal((await blocked).status(), 409);
  await settings
    .getByRole("alert")
    .filter({ hasText: "استفاده شده است" })
    .waitFor();
  await settings.locator("#inventory-category-delete-cancel").click();

  await warehouse.bringToFront();
  await waitForLabel(
    warehouse,
    "#purchaseCategory option",
    "UPVC frames / Door",
  );
  assert.equal(
    await warehouse.locator("#purchaseCategory").inputValue(),
    String(door.id),
  );
  assert.equal(
    await warehouse.locator("#purchaseItemName").inputValue(),
    String(product.id),
  );
  await warehouse.locator("#purchaseQuantity").fill("2");
  await warehouse.locator("#purchasePrice").fill("700");
  const purchased = response(warehouse, "POST", "/api/purchases");
  await warehouse.locator('#purchaseEntryForm button[type="submit"]').click();
  const receipt = await purchased;
  assert.equal(receipt.status(), 201, await receipt.text());
  assert.equal(
    (await receipt.json()).rows[0].category_path,
    "UPVC frames / Door",
  );

  const orders = await context.newPage();
  await orders.goto(base + "/page/orders-page.html");
  await orders.locator(".orders-create").click();
  await waitForLabel(orders, ".item-product optgroup", "UPVC frames / Door");
  const salesSelect = orders.locator(".item-product").first();
  await salesSelect.selectOption(String(product.id));
  assert.equal(await orders.locator(".item-unit").first().textContent(), "عدد");

  const reports = await context.newPage();
  await reports.goto(base + "/page/reports-page.html");
  await reports.locator("#openReportsButton").click();
  await reports.locator("#reportModule").selectOption("products");
  await reports
    .locator("#reportTable tbody tr")
    .filter({ hasText: "UPVC frames" })
    .getByText("Door", { exact: true })
    .waitFor();
  await settings.bringToFront();
  await tree
    .getByRole("button", { name: "ویرایش UPVC frames / Door", exact: true })
    .click();
  assert.equal(await parent.inputValue(), String(main.id));
  await save("Door panel", "PUT", door.id);
  await reports.bringToFront();
  await reports
    .locator("#reportTable tbody tr")
    .filter({ hasText: "UPVC frames" })
    .getByText("Door panel", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Category settings, product selection, purchase, sales grouping, and reports passed.",
  );
} finally {
  await browser.close();
}

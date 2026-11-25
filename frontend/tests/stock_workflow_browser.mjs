// Run against serve_customers_fixture.py with an isolated SQLite database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5501";
const browser = await chromium.launch({ headless: true, executablePath: process.env.KARBON_CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  const login = await context.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(login.status(), 200);
  const { token } = await login.json();
  await context.addInitScript(({ origin, token }) => {
    if (location.origin === origin) localStorage.setItem("karbon_auth", JSON.stringify({ token }));
  }, { origin: new URL(base).origin, token });
  async function api(path, method = "GET", data) {
    const response = await context.request.fetch(`${base}/api${path}`, {
      method, data, headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok(response.ok(), await response.text());
    return response.json();
  }
  const suffix = String(Date.now());
  const category = await api("/settings/inventory-options/categories", "POST", { name: `گردش ${suffix}` });
  const brand = await api("/settings/brands", "POST", { name: `برند ${suffix}` });
  const raw = await api("/products", "POST", { name: `ماده ${suffix}`, category_id: category.id, unit: "عدد", stock: 10 });
  const other = await api("/products", "POST", { name: raw.name, category_id: category.id, unit: "بسته", stock: 0,
    requires_brand: true, brand_id: brand.id });
  const day = (await api("/settings/fiscal-years/current")).business_jalali;
  const stock = async () => {
    const products = await api("/products");
    return [raw, other].map((item) => products.find((product) => product.id === item.id).stock);
  };
  const ready = () => page.locator('html[data-page-state="ready"]').waitFor();
  const dialog = page.locator("#financeDeleteModal");
  const waitForWrite = (path, method) => page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api${path}` && response.request().method() === method);

  const purchase = await api("/purchases", "POST", { request_id: crypto.randomUUID(), purchase_date: day,
    rows: [{ category_id: category.id, product_id: raw.id, unit: raw.unit, quantity: 5, purchase_price: 200 }] });
  assert.deepEqual(await stock(), [15, 0]);
  await page.goto(`${base}/page/settings-page.html#invoices`);
  await ready();
  await page.locator("#settingsInvoicesKind").selectOption("purchase");
  const card = page.locator("#settingsInvoicesList article").filter({ hasText: purchase.invoice_number });
  await card.getByRole("link", { name: "ویرایش خرید" }).click();
  await page.waitForURL(`**/warehouse-page.html#purchase-edit-${purchase.id}`);
  await ready();
  await page.locator("#savePurchaseEntry:enabled").waitFor();
  assert.equal(await page.locator("#purchaseItemName").inputValue(), String(raw.id));
  assert.equal(await page.locator(`#purchaseItemName option[value="${other.id}"]`).textContent(), `${raw.name} · ${brand.name}`);
  assert.equal(await page.locator("#purchaseUnit").inputValue(), raw.unit);
  assert.equal(await page.locator("#purchaseInvoiceNumber").inputValue(), purchase.invoice_number);
  await page.locator("#purchaseQuantity").fill("7");
  const edit = waitForWrite(`/purchases/${purchase.id}`, "PUT");
  await page.locator("#savePurchaseEntry").click();
  assert.equal((await edit).status(), 200);
  await page.locator("#viewPurchaseInvoice").waitFor();
  assert.deepEqual(await stock(), [17, 0]);
  await page.locator("#closePurchaseEntry").click();

  await page.locator("#warehouseInventory tr").filter({ hasText: raw.product_code })
    .getByRole("button", { name: `گردش موجودی ${raw.name}` }).click();
  const movements = page.locator("#warehouseMovementItems");
  await movements.getByText(`purchase:${purchase.id}:2:reverse`, { exact: true }).waitFor();
  await movements.getByText(`purchase:${purchase.id}:2:apply`, { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  await page.goto(`${base}/page/production-page.html`);
  await ready();
  await page.getByRole("heading", { name: "تولید در حال ساخت است" }).waitFor();
  assert.equal(await page.locator("#productionForm").count(), 0);

  await page.goto(`${base}/page/settings-page.html#invoices`);
  await ready();
  await page.locator("#settingsInvoicesKind").selectOption("purchase");
  await card.getByRole("button", { name: "لغو خرید" }).click();
  await dialog.locator("input").fill("test-password");
  const cancelPurchase = waitForWrite(`/purchases/${purchase.id}`, "DELETE");
  await dialog.locator('button[type="submit"]').click();
  assert.equal((await cancelPurchase).status(), 200);
  await card.waitFor({ state: "detached" });
  assert.deepEqual(await stock(), [10, 0]);

  const customer = await api("/customers", "POST", { first_name: "خریدار", last_name: suffix });
  const order = await api("/orders", "POST", { request_id: crypto.randomUUID(), customer_id: customer.id,
    invoice_date: day, payment_date: day, items: [{ product_id: raw.id, quantity: 13, unit_price: 200 }] });
  assert.deepEqual(await stock(), [-3, 0]);
  await page.goto(`${base}/page/warehouse-page.html`);
  await ready();
  await page.locator("#warehouseStatusFilter").selectOption("empty");
  const negative = page.locator("#warehouseInventory tr").filter({ hasText: raw.product_code });
  await negative.getByText("ناموجود", { exact: true }).waitFor();
  assert.match(await negative.locator(".warehouse-quantity").textContent(), /[−-]۳/);
  await page.goto(`${base}/page/orders-page.html`);
  await ready();
  const completed = waitForWrite(`/orders/${order.id}/complete`, "POST");
  await page.locator(`[data-complete-order="${order.id}"]`).click();
  assert.equal((await completed).status(), 200);
  assert.deepEqual(await stock(), [-3, 0]);
  await page.locator("#completedOrdersTab").click();
  const saleCard = page.locator(`[data-order-id="${order.id}"]`);
  await saleCard.locator(".orders-card-open").click();
  await page.getByRole("button", { name: "لغو سفارش", exact: true }).click();
  await dialog.locator("input").fill("test-password");
  const cancelOrder = waitForWrite(`/orders/${order.id}`, "DELETE");
  await dialog.locator('button[type="submit"]').click();
  assert.equal((await cancelOrder).status(), 200);
  await saleCard.waitFor({ state: "detached" });
  assert.deepEqual(await stock(), [10, 0]);
  assert.deepEqual(errors, []);
  console.log("PASS: purchase editing and cancellation, warehouse movement history, production placeholder, negative stock and sale cancellation");
} finally {
  await browser.close();
}

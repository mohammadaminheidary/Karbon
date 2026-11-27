// Run against serve_customers_fixture.py with --orders --finance on disposable ports.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { selectOrderProduct } from "./order_product_picker.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5531";
const browser = await chromium.launch({ headless: true, executablePath: process.env.KARBON_CHROME_PATH });
const page = await browser.newPage({ reducedMotion: "reduce" });
const label = "مشتری پیش‌فرض سیستمی";

try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.ok(login.ok());
  const { token } = await login.json();
  await page.addInitScript((token) => localStorage.setItem("karbon_auth", JSON.stringify({ token })), token);

  await page.goto(`${base}/page/customers-page.html`);
  await page.locator("#customerSearchInput").fill("مشتری حضوری");
  const card = page.locator("#customersList [data-customer-id]").filter({ hasText: label });
  await card.click();
  const details = page.locator("#customerDetailsBody");
  await details.getByText(label, { exact: true }).waitFor();
  assert.ok(await page.locator("#deleteCustomerButton").isDisabled());
  await page.locator("#editCustomerButton").click();
  await page.locator("#customerFormModal[open]").waitFor();
  for (const id of ["customerCode", "customerFirstName", "customerLastName"])
    assert.equal(await page.locator(`#${id}`).evaluate((field) => field.readOnly), true);
  assert.ok(await page.locator("#customerAddress").isEditable());

  const products = await page.request.get(`${base}/api/products`, { headers: { Authorization: `Bearer ${token}` } });
  assert.ok(products.ok());
  const product = (await products.json()).find((entry) => entry.stock === null);
  assert.ok(product);
  await page.goto(`${base}/page/orders-page.html`);
  await page.locator(".orders-create").click();
  await page.locator("#orderCustomerSearch").fill("۱۰۰۰");
  const option = page.getByRole("option", { name: new RegExp(`1000.*مشتری حضوری.*${label}`) });
  await option.click();
  await page.locator("#orderCustomerDetails").getByText(label, { exact: true }).waitFor();
  assert.equal(await page.locator("#orderCustomerDetails").getByText("شماره‌های تماس", { exact: true }).count(), 0);
  await selectOrderProduct(page.locator("#orderItems .item-product").first(), product);
  await page.locator("#orderPay").click();
  await page.locator("#orderPaymentModal").waitFor({ state: "visible" });
  await page.locator("#pay-pos").uncheck();
  await page.locator("#pay-cash").check();
  await page.locator("#pay-cash-amount").fill(String(product.price));
  const submitted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/orders" && response.request().method() === "POST");
  await page.locator("#finalizeOrder").click();
  const response = await submitted;
  assert.equal(response.status(), 201, await response.text());
  const order = await response.json();
  assert.equal(order.customer_name, "مشتری حضوری");
  assert.equal(order.paid, order.total);
  assert.equal(order.remaining, 0);
  console.log("PASS: Masters protection and walk-in order registration");
} finally {
  await browser.close();
}

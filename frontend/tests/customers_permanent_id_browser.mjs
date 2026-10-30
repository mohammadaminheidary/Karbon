// Run only against serve_customers_fixture.py on disposable ports/databases.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5531";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH ? { executablePath: process.env.KARBON_CHROME_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], customers = [];
page.on("pageerror", (error) => errors.push(error.message));
let token;
const card = (customer) => page.locator(`[data-customer-id="${customer.id}"]`);
const code = (customer) => card(customer).locator("[data-customer-permanent-id]");
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method, data, headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok(), `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function settled() {
  await page.waitForFunction(() => document.documentElement.dataset.pageState === "ready");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
}
async function createCustomer(index) {
  await page.locator("#openCreateCustomerButton").click();
  await page.locator("#customerFirstName").fill(`شناسه ${index}`);
  await page.locator("#customerLastName").fill("آزمون مرورگر");
  const response = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/customers" && response.request().method() === "POST");
  await page.locator("#saveCustomerButton").click();
  const saved = await response;
  assert.equal(saved.status(), 201);
  const customer = await saved.json();
  customers.push(customer);
  assert.match(customer.permanent_id, /^\d{6}-\d{6}-[A-Z0-9]{4}$/);
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(customer.created_at));
  const part = (type) => parts.find((value) => value.type === type).value;
  assert.equal(customer.permanent_id.slice(0, 13),
    `${part("day")}${part("month")}${part("year").slice(-2)}-${part("hour")}${part("minute")}${part("second")}`);
  await page.waitForFunction(() => !document.getElementById("customerFormModal").open);
  await settled();
  assert.equal(await code(customer).textContent(), customer.permanent_id);
  assert.ok((await card(customer).textContent()).includes("کد مشتری:"));
  assert.ok((await card(customer).textContent()).includes("شناسه یکتای دائمی:"));
  return customer;
}
async function assertDetails(customer) {
  await card(customer).click();
  await page.locator("#editCustomerButton").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("editCustomerButton").disabled);
  const field = page.locator("#customerDetailsBody dl > div").filter({ has: page.locator("dt", { hasText: "شناسه یکتای دائمی مشتری" }) });
  assert.equal(await field.locator("dd").textContent(), customer.permanent_id);
  assert.equal(await field.locator("dd").getAttribute("dir"), "ltr");
}
try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.ok(login.ok());
  ({ token } = await login.json());
  await page.addInitScript((token) => localStorage.setItem("karbon_auth", JSON.stringify({ token })), token);
  await page.goto(`${base}/page/customers-page.html`);
  await settled();
  const first = await createCustomer(1);
  const second = await createCustomer(2);
  assert.notEqual(first.permanent_id, second.permanent_id);
  await assertDetails(second);
  await page.locator("#editCustomerButton").click();
  await page.locator("#customerLastName").fill("ویرایش آزمون مرورگر");
  const editResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/customers/${second.id}`) && response.request().method() === "PUT");
  await page.locator("#saveCustomerButton").click();
  assert.equal((await (await editResponse).json()).permanent_id, second.permanent_id);
  await page.waitForFunction(() => !document.getElementById("customerFormModal").open);
  await settled();
  await page.reload();
  await settled();
  assert.equal(await code(second).textContent(), second.permanent_id);
  await assertDetails(first);
  await page.locator("#deleteCustomerButton").click();
  const deleteResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/customers/${first.id}`) && response.request().method() === "DELETE");
  await page.locator("#confirmDeleteCustomerButton").click();
  assert.equal((await deleteResponse).status(), 204);
  await card(first).waitFor({ state: "detached" });
  await settled();
  const surviving = await api("GET", `/customers/${second.id}`);
  assert.equal(surviving.customer_code, first.customer_code);
  assert.equal(surviving.permanent_id, second.permanent_id);
  const third = await createCustomer(3);
  assert.notEqual(third.permanent_id, second.permanent_id);
  await page.reload();
  await settled();
  for (const customer of [second, third]) assert.equal(await code(customer).textContent(), customer.permanent_id);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`);
  }
  await page.locator("#customerSearchInput").fill(second.permanent_id.toLowerCase());
  await page.waitForFunction(() => document.querySelectorAll("[data-customer-id]").length === 1);
  assert.equal(await code(second).textContent(), second.permanent_id);
  const saved = await api("GET", "/customers?limit=100");
  assert.equal(new Set(saved.items.map((customer) => customer.permanent_id)).size, saved.items.length);
  assert.deepEqual(errors, []);
  console.log("PASS: registration, distinct sequential/permanent codes, details, edits, refresh, deletion, renumbering, new registration, search and responsive layout");
} finally {
  for (const customer of customers.slice(1)) await api("DELETE", `/customers/${customer.id}`);
  await browser.close();
}

// Verify populated content, not just a settled empty shell. Use only the
// disposable fixture from serve_customers_fixture.py; all seeded rows are removed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5502";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const cleanup = [], errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let token, activeCase;
const settled = async () => {
  await page.waitForFunction(() => document.documentElement.dataset.pageState === "ready");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
};
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method, data, headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function seed(path, data, remove = path) {
  const row = await api("POST", path, data);
  cleanup.unshift(`${remove}/${row.id}${path === "/orders" ? "/invoice" : ""}`);
  return row;
}
async function refresh(selectors, fail) {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { started = resolve; });
  await page.evaluate((selectors) => {
    window.retainedNodes = selectors.map((selector) => document.querySelector(selector));
  }, selectors);
  for (const selector of selectors) assert.equal(await page.locator(selector).first().isVisible(), true, selector);
  const handler = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    started();
    await gate;
    if (fail) return route.fulfill({
      status: 503, contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": new URL(base).origin },
      body: '{"detail":"خطای آزمایشی بروزرسانی"}',
    });
    return route.continue();
  };
  await page.route("**/api/**", handler);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event("karbon-data-change")));
    await Promise.race([requested, new Promise((_, reject) => setTimeout(() => reject(new Error("no refresh request")), 5000))]);
    for (const selector of selectors) assert.equal(await page.locator(selector).first().isVisible(), true, `pending: ${selector}`);
    release();
    await settled();
    const retained = await page.evaluate((selectors) => selectors.every((selector, index) =>
      window.retainedNodes[index] === document.querySelector(selector)), selectors);
    assert.equal(retained, true, `${activeCase}: ${fail ? "failed" : "unchanged"} refresh replaced content`);
    for (const selector of selectors) assert.equal(await page.locator(selector).first().isVisible(), true, `settled: ${selector}`);
  } finally {
    release();
    await page.unroute("**/api/**", handler);
  }
}
try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(login.ok(), true);
  ({ token } = await login.json());
  await page.addInitScript((token) => {
    localStorage.setItem("karbon_auth", JSON.stringify({ token }));
    window.startupErrors = [];
    window.addEventListener("error", (event) => window.startupErrors.push({
      type: "error", message: event.message, source: event.target?.src,
    }), true);
    window.addEventListener("unhandledrejection", (event) => window.startupErrors.push({
      type: "rejection", message: String(event.reason),
    }));
  }, token);
  const customers = await api("GET", "/customers");
  const products = await api("GET", "/products");
  const banks = await api("GET", "/banks");
  const bank = banks.find((item) => item.bank === "mellat");
  assert.ok(bank);
  const today = new Intl.DateTimeFormat("en-CA-u-ca-persian", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const datePart = (type) => today.find((part) => part.type === type).value;
  const date = `${datePart("year")}/${datePart("month")}/${datePart("day")}`;
  await seed("/members", { first_name: "عضو", last_name: "آزمون ناوبری" });
  await seed("/tasks", { title: "آزمون بروزرسانی", date });
  await seed("/orders", {
    request_id: randomUUID(), customer_id: customers.items[0].id,
    invoice_date: date, payment_date: date,
    items: [{ product_id: products.find((item) => item.stock === null).id, quantity: 1, unit_price: 100 }],
    payments: [], discount: 0,
  });
  const account = await seed("/settings/document-accounts", { title: "حساب آزمون ناوبری", kind: "income" });
  await seed("/documents", {
    request_id: randomUUID(), date, description: "آزمون حفظ محتوا",
    rows: [{ kind: "income", bank_id: bank.id, document_account_id: account.id, amount: 100 }],
  });
  const cases = [
    ["customers", ["#customersList > *"]],
    ["orders", ["#activeOrdersPanel .orders-record"]],
    ["finance", ["#transactionRows > *", "#financeChart > *"]],
    ["attendance", ["#attendanceMembers > article"]],
    ["daily-tasks", ["#todoTasks > article"]],
    ["documents", ["#documentCards > *"]],
    ["banks", ["a.bank-account"]],
    ["bank-transactions", ["#ledgerRows > *", "#bankChart > *"], `?bank=${bank.id}`],
    ["settings", ["#settingsMembersTableBody > *"], "#members"],
    ["settings", ["#expenseCategoriesList > *"], "#expenses"],
    ["settings", ["#documentAccountsList > *"], "#document-accounts"],
    ["settings", [".bank-settings-row"], "#banks"],
    ["settings", ["#settingsProductsList > *"], "#products"],
    ["settings", ["#settingsInvoicesList > *"], "#invoices"],
  ];
  for (const [name, selectors, suffix = ""] of cases) {
    activeCase = name + suffix;
    await page.goto(`${base}/page/${name}-page.html${suffix}`);
    await settled();
    if (name === "bank-transactions") {
      // The expanded ledger must remain expanded after both failure and retry.
      await page.locator("#moreLedger").click();
      await settled();
      assert.ok(await page.locator("#ledgerRows > *").count() > 20);
    }
    const before = await page.locator(selectors[0]).count();
    await refresh(selectors, false);
    await refresh(selectors, true);
    await refresh(selectors, false);
    assert.equal(await page.locator(selectors[0]).count(), before, activeCase);
    assert.equal(await page.locator("#pageStartupError").count(), 0);
    if (name === "orders") assert.equal(await page.locator("[data-orders-load-error]").count(), 0);
    if (name === "orders") {
      await page.evaluate(async () => {
        const { invalidateApiCache } = await import("/src/js/components/api-cache.js");
        invalidateApiCache();
      });
      const delayedOrders = async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.continue();
      };
      await page.route("**/api/orders?*", delayedOrders);
      const responses = ["completed", "active"].map((status) =>
        page.waitForResponse((response) => response.url().includes(`/api/orders?status=${status}`)));
      const completed = page.waitForRequest((request) => request.url().includes("status=completed"));
      await page.locator("#completedOrdersTab").click();
      await completed;
      await page.locator("#activeOrdersTab").click();
      await Promise.all(responses);
      await page.waitForFunction(() => document.getElementById("activeOrdersPanel").getAttribute("aria-busy") === "false");
      assert.equal(await page.locator('[aria-busy="true"]').count(), 0, "rapid tab changes left an outdated panel loading");
      await page.unroute("**/api/orders?*", delayedOrders);
      assert.equal(await page.locator("#activeOrdersPanel .orders-record").count(), before);
    }
    // A cold data failure must settle into an error, never an endless loader.
    await page.evaluate(() => sessionStorage.removeItem("karbon-api-cache-v1"));
    const initialFailure = (route) => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).pathname === "/api/auth/me")
        return route.continue();
      return route.fulfill({ status: 503, contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": new URL(base).origin },
        body: '{"detail":"خطای آزمایشی دریافت اولیه"}' });
    };
    await page.route("**/api/**", initialFailure);
    await page.reload();
    await settled();
    assert.equal(await page.locator("#mainNavbar").isVisible(), true);
    assert.doesNotMatch(await page.locator("main").innerText(), /در حال دریافت|Loading data/);
    await page.unroute("**/api/**", initialFailure);
    await page.reload();
    await settled();
    for (const selector of selectors) assert.equal(await page.locator(selector).first().isVisible(), true, `recovery: ${activeCase}`);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: cases.length, result: "PASS: populated content and DOM retained during slow, unchanged and failed refresh; cold failures and recovery; expanded ledger preserved" }));
} catch (error) {
  console.error(JSON.stringify({ activeCase, url: page.url(), errors,
    state: await page.evaluate(() => ({ ready: document.readyState, pageState: document.documentElement.dataset.pageState,
      notice: document.getElementById("pageStartupError")?.textContent,
      startupErrors: window.startupErrors,
      busy: [...document.querySelectorAll('[aria-busy="true"]')].map((element) => element.id) })) }));
  throw error;
} finally {
  for (const path of cleanup) {
    await api("DELETE", path, { password: "test-password", confirmed: true });
  }
  await browser.close();
}

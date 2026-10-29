// Start the disposable fixture with:
// python3 frontend/tests/serve_customers_fixture.py --backend-port 8027 --frontend-port 5527 --customers 25 --orders --finance
// Then run this file with Node; set KARBON_PLAYWRIGHT_PATH and KARBON_CHROME_PATH
// when Playwright and Chromium are installed outside frontend/node_modules.
// This test submits real orders only in that disposable database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5527";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let token;
const customers = [],
  orders = [];
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method,
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok(), `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
const settled = () =>
  page.waitForFunction(() => {
    const root = document.getElementById("createOrderModal");
    return (
      root.open &&
      !root.dataset.morph &&
      document
        .querySelector(".navbar-dock")
        .classList.contains("document-dock-open")
    );
  });
async function selectCustomer(customer) {
  await page
    .locator("#orderCustomerSearch")
    .fill(String(customer.customer_code));
  await page
    .locator(".orders-customer-option")
    .filter({ hasText: String(customer.customer_code) })
    .click();
  await page.waitForFunction((name) => {
    const details = document.getElementById("orderCustomerDetails");
    return !details.hidden && details.textContent.includes(name);
  }, customer.first_name);
  assert.equal(await page.locator("#orderCustomerDetails > div").count(), 14);
}
async function wheelToEnd(target) {
  await page.locator(target).hover();
  await page.mouse.wheel(0, 20000);
  await page.waitForFunction(() => {
    const root = document.getElementById("createOrderModal");
    return (
      root.scrollTop > 0 &&
      root.scrollTop + root.clientHeight >= root.scrollHeight - 2
    );
  });
  assert.ok(
    await page.locator("#orderPay").evaluate((button) => {
      const r = button.getBoundingClientRect(),
        p = button.closest("dialog").getBoundingClientRect();
      return r.top >= p.top && r.bottom <= p.bottom;
    }),
    "payment button is reachable by wheel scrolling",
  );
}
async function wheelToTop() {
  // Keep the pointer within the form body so containment regressions are caught.
  await page.locator("#orderDiscount").hover();
  await page.mouse.wheel(0, -20000);
  await page.waitForFunction(
    () => document.getElementById("createOrderModal").scrollTop === 0,
  );
}
try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator("button[type=submit]").click();
  await page.waitForURL("**/index.html");
  token = await page.evaluate(
    () => JSON.parse(localStorage.getItem("karbon_auth")).token,
  );
  for (const long of [false, true]) {
    customers.push(
      await api("POST", "/customers", {
        first_name: long ? "بلند" : "کوتاه",
        last_name: `آزمون اسکرول ${Date.now()}`,
        phone_numbers: [long ? "09129990002" : "09129990001"],
        address: long
          ? "نشانی طولانی مشتری برای بررسی دسترسی فرم. ".repeat(40)
          : "آدرس کوتاه",
        notes: long ? "توضیحات مشتری با چندین خط\n".repeat(100) : null,
      }),
    );
  }
  const products = await api("GET", "/products");
  const product = products.find((item) => item.stock === null);
  assert.ok(product, "fixture needs an unlimited-stock product");
  const sizes = [
    [1440, 1000],
    [1024, 768],
    [768, 1024],
    [640, 480],
    [390, 844],
    [320, 568],
    [844, 390],
  ];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/page/orders-page.html`);
    await page.locator(".orders-create").click();
    await settled();
    await page.waitForFunction(
      () => !document.getElementById("orderFields").disabled,
    );
    await selectCustomer(customers[0]);
    await wheelToEnd("#orderCustomerDetails");
    await wheelToTop();
    await selectCustomer(customers[1]);
    assert.equal(
      await page
        .locator("#orderCustomerDetails")
        .evaluate((details) => details.scrollHeight === details.clientHeight),
      true,
      "details have no nested vertical scrolling",
    );
    const geometry = await page
      .locator("#createOrderModal")
      .evaluate((root) => {
        const r = root.getBoundingClientRect(),
          nav = document.getElementById("mainNavbar").getBoundingClientRect();
        return {
          fits:
            r.top >= 14 &&
            r.right <= innerWidth &&
            root.scrollWidth <= root.clientWidth,
          dimensions: [r.top, r.right, root.scrollWidth, root.clientWidth],
          centered: Math.abs(r.left - (innerWidth - r.width) / 2) < 1,
          anchored: Math.abs(r.bottom - nav.bottom) < 1,
        };
      });
    assert.ok(
      geometry.fits && geometry.centered && geometry.anchored,
      `${width}x${height}: ${JSON.stringify(geometry)}`,
    );
    await wheelToEnd("#orderCustomerDetails");
    await wheelToTop();
    // Switching back clears the large details and preserves normal form scrolling.
    await selectCustomer(customers[0]);
    await wheelToEnd("#orderCustomerDetails");
    await page.locator(".item-product").selectOption(String(product.id));
    await page
      .locator("#orderDescription")
      .fill(`Scroll test ${width}x${height}`);
    await page.locator("#orderDiscount").fill("1000");
    // Add content dynamically, then resize an already-scrolled open form.
    await page.locator(".orders-add-row").last().click();
    await page.locator(".item-product").last().selectOption(String(product.id));
    await page.setViewportSize({ width, height: height - 60 });
    await settled();
    await wheelToEnd("#orderDescription");
    await wheelToTop();
    await wheelToEnd("#orderCustomerDetails");
    // Enter payment, return to the invoice, then submit through the actual API.
    await page.locator("#orderPay").click();
    await page.locator("#orderPaymentModal").waitFor({ state: "visible" });
    await page.locator("#editOrderInvoice").click();
    await settled();
    assert.equal(
      await page.locator("#orderDescription").inputValue(),
      `Scroll test ${width}x${height}`,
    );
    await wheelToEnd("#orderCustomerDetails");
    await page.locator("#orderPay").click();
    await page.locator("#pay-pos").uncheck();
    await page.locator("#pay-cash").check();
    await page.locator("#pay-cash-amount").fill("99000");
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/orders") &&
        response.request().method() === "POST",
    );
    await page.locator("#finalizeOrder").click();
    const response = await responsePromise;
    assert.ok(response.ok(), await response.text());
    const saved = await response.json();
    orders.push(saved.id);
    const invoice = await api("GET", `/orders/${saved.id}/invoice`);
    assert.equal(invoice.customer.code, customers[0].customer_code);
    assert.equal(saved.paid, 99000);
    await page.waitForFunction(
      () => !document.getElementById("createOrderModal").open,
    );
    await page.locator("#finalInvoiceModal").waitFor({ state: "visible" });
    await page
      .locator("#finalInvoiceModal .orders-dialog-header [data-dialog-close]")
      .click();
    await page.waitForFunction(
      () => !document.body.classList.contains("overflow-hidden"),
    );
    assert.equal(
      await page.locator(".navbar-dock").getAttribute("class"),
      "navbar-dock",
    );
    assert.equal(await page.locator("#mainNavbar").isVisible(), true);
    console.log(
      `PASS ${width}x${height}: selection, long details, wheel down/up, switching, dynamic rows, resize, payment edit and real submission`,
    );
  }
  // Real touch input in Chromium's mobile emulation; swipe over the details.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/page/orders-page.html`);
  await page.locator(".orders-create").click();
  await settled();
  await selectCustomer(customers[1]);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  async function swipe(from, to) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 195, y: from }],
    });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 195, y: from + ((to - from) * step) / 12 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await swipe(680, 250);
  await page.waitForFunction(
    () => document.getElementById("createOrderModal").scrollTop > 100,
  );
  // Wait for inertia to stop before reversing the gesture.
  await page.waitForTimeout(700);
  const down = await page
    .locator("#createOrderModal")
    .evaluate((root) => root.scrollTop);
  await swipe(250, 680);
  await page.waitForFunction(
    (down) =>
      document.getElementById("createOrderModal").scrollTop < down - 100,
    down,
  );
  await cdp.detach();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.getElementById("createOrderModal").open,
  );
  assert.equal(await page.locator("#mainNavbar").isVisible(), true);
  console.log(
    "PASS mobile touch swipes down/up over long customer details and Escape restores navbar",
  );
  assert.deepEqual(errors, []);
} finally {
  try {
    for (const id of orders)
      await api("DELETE", `/orders/${id}/invoice`, {
        password: "test-password",
        confirmed: true,
      });
    for (const customer of customers)
      await api("DELETE", `/customers/${customer.id}`);
  } finally {
    await browser.close();
  }
}

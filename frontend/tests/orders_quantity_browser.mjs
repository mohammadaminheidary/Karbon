// Disposable fixture: serve_customers_fixture.py --backend-port 8027
// --frontend-port 5527 --customers 25 --orders --finance.
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
const orders = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let token;
const money = (value) =>
  `${new Intl.NumberFormat("fa-IR").format(value)} تومان`;
const row = (index = 0) =>
  page.locator("#orderItems .orders-item-row").nth(index);
const input = () => row().locator(".item-quantity");
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method,
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok(), `${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function check(quantity, second = 0, discount = 0) {
  assert.equal(Number(await input().getAttribute("aria-valuenow")), quantity);
  assert.equal(
    await row().locator(".item-total").textContent(),
    money(quantity * 125000),
  );
  assert.equal(
    await page.locator("#orderSubtotal").textContent(),
    money(quantity * 125000 + second),
  );
  assert.equal(
    await page.locator("#orderTotal").textContent(),
    money(quantity * 125000 + second - discount),
  );
}
async function scrollPositions() {
  return page.evaluate(() => [
    document.getElementById("createOrderModal").scrollTop,
    window.scrollY,
    document.querySelector("#createOrderModal .orders-table-scroll").scrollLeft,
  ]);
}
async function wheel(
  delta,
  quantity,
  second = 0,
  discount = 0,
  target = input(),
) {
  await target.hover();
  await input().evaluate((input) => {
    window.quantityWheelPrevented = false;
    input.closest(".orders-quantity-control").addEventListener(
      "wheel",
      (event) => {
        window.quantityWheelPrevented = event.defaultPrevented;
      },
      { once: true },
    );
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const before = await scrollPositions();
  await page.mouse.wheel(0, delta);
  await page.waitForFunction(
    (quantity) =>
      document.querySelector(".item-quantity").getAttribute("aria-valuenow") ===
      String(quantity),
    quantity,
  );
  await page.waitForTimeout(120);
  assert.equal(
    await page.evaluate(() => window.quantityWheelPrevented),
    true,
    "quantity wheel cancels browser scrolling",
  );
  const after = await scrollPositions();
  assert.equal(after[1], before[1], "document must not scroll");
  assert.equal(after[2], before[2], "table must not scroll");
  // Fractional layout rounding can adjust the panel anchor by one CSS pixel.
  assert.ok(
    Math.abs(after[0] - before[0]) <= 1,
    "wheel must not scroll the panel",
  );
  await check(quantity, second, discount);
}
try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.ok(login.ok());
  ({ token } = await login.json());
  await page.addInitScript((token) => {
    localStorage.setItem("karbon_auth", JSON.stringify({ token }));
    sessionStorage.removeItem("karbon-api-cache-v1");
  }, token);
  const service = (await api("GET", "/products")).find((p) => p.stock === null);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${base}/page/orders-page.html`);
    await page.locator(".orders-create").click();
    await page.waitForFunction(() => {
      const root = document.getElementById("createOrderModal");
      return (
        root.open &&
        !root.dataset.morph &&
        !document.getElementById("orderFields").disabled
      );
    });
    await page.locator("#orderCustomerSearch").click();
    await page.locator(".orders-customer-option").first().click();
    await page.locator("#orderCustomerDetails").waitFor({ state: "visible" });
    await row().locator(".item-product").selectOption(String(service.id));
    await row().locator(".item-price").fill("125000");
    await check(1);
    assert.equal(
      await row().locator(".item-quantity-decrease").isDisabled(),
      true,
    );
    await row().locator(".item-quantity-increase").click();
    await check(2);
    await row().locator(".item-quantity-decrease").click();
    await check(1);
    // Manual Persian entry and keyboard stepping remain available.
    await input().fill("۳");
    await check(3);
    await input().press("ArrowUp");
    await check(4);
    await input().press("ArrowDown");
    await check(3);
    for (const invalid of ["-2", "0", "1.5", "abc", "1000001", "۲٫۵"]) {
      await input().fill(invalid);
      assert.equal(await input().inputValue(), "3", `reject ${invalid}`);
      await check(3);
    }
    await input().fill("");
    await input().press("7");
    await check(7);
    await input().fill("");
    await row().locator(".item-price").focus();
    assert.equal(
      await input().inputValue(),
      "7",
      "empty edit restores the last valid quantity on blur",
    );
    await check(7);
    await input().fill("1000000");
    await check(1000000);
    assert.equal(
      await row().locator(".item-quantity-increase").isDisabled(),
      true,
    );
    await wheel(-100, 1000000);
    await wheel(-100, 1000000, 0, 0, row().locator(".item-quantity-increase"));
    await input().fill("1");
    await wheel(100, 1);
    await wheel(100, 1, 0, 0, row().locator(".item-quantity-decrease"));
    // Wheel stepping works while hovered even when the input has no focus.
    await input().fill("3");
    await row().locator(".item-price").focus();
    await wheel(-100, 4);
    await wheel(100, 3);
    // Button hit areas stay inside the field without covering its editable text.
    assert.equal(
      await row()
        .locator(".orders-quantity-control")
        .evaluate((control) => {
          const input = control.querySelector("input").getBoundingClientRect();
          const buttons = [...control.querySelectorAll("button")].map(
            (button) => button.getBoundingClientRect(),
          );
          return (
            buttons.every(
              (b) =>
                b.top >= input.top &&
                b.bottom <= input.bottom &&
                b.left >= input.left &&
                b.right <= input.right,
            ) && buttons[0].right < buttons[1].left
          );
        }),
      true,
    );
    await page.locator(".orders-add-row").last().click();
    await row(1).locator(".item-product").selectOption(String(service.id));
    await row(1).locator(".item-quantity-increase").click();
    await check(3, 100000);
    await page.locator("#orderDiscount").fill("25000");
    await wheel(-100, 4, 100000, 25000);
    await row().locator(".item-quantity-decrease").click();
    await check(3, 100000, 25000);
    assert.equal(
      await page
        .locator("#createOrderModal")
        .evaluate((root) => root.scrollWidth <= root.clientWidth),
      true,
    );
    await page.locator("#orderPay").click();
    await page.locator("#orderPaymentModal").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#paymentInvoiceTotal").textContent(),
      money(450000),
    );
    await page.locator("#pay-pos").uncheck();
    await page.locator("#pay-cash").check();
    await page.locator("#pay-cash-amount").fill("450000");
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
    for (const data of [
      saved,
      await api("GET", `/orders/${saved.id}/invoice`),
    ]) {
      assert.deepEqual(
        data.items.map((item) => item.quantity),
        [3, 2],
      );
      assert.deepEqual(
        data.items.map((item) => item.total),
        [375000, 100000],
      );
      assert.deepEqual(
        [data.subtotal, data.discount, data.total, data.paid],
        [475000, 25000, 450000, 450000],
      );
    }
    console.log(
      `PASS ${width}px: +/- buttons, manual/Persian input, arrows, wheel/no page scroll, min/max/invalid values, responsive hit areas, multi-item totals, discount and saved invoice`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  try {
    for (const id of orders)
      await api("DELETE", `/orders/${id}/invoice`, {
        password: "test-password",
        confirmed: true,
      });
  } finally {
    await browser.close();
  }
}

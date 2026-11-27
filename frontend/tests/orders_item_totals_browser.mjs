// Disposable fixture: serve_customers_fixture.py --backend-port 8027
// --frontend-port 5527 --customers 25 --orders --finance.
import assert from "node:assert/strict";
import { selectOrderProduct } from "./order_product_picker.mjs";
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
  searchProducts = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let token;
const money = (value) =>
  `${new Intl.NumberFormat("fa-IR").format(value)} تومان`;
const rows = () => page.locator("#orderItems .orders-item-row");
const row = (index) => rows().nth(index);
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method,
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok(), `${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function check(totals, subtotal, discount = 0) {
  assert.deepEqual(
    await page.locator("#orderItems .item-total").allTextContents(),
    totals.map(money),
  );
  assert.equal(
    await page.locator("#orderSubtotal").textContent(),
    money(subtotal),
  );
  assert.equal(
    await page.locator("#orderTotal").textContent(),
    money(subtotal - discount),
  );
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
  const products = await api("GET", "/products");
  const tracked = products.find((p) => p.stock !== null),
    service = products.find((p) => p.stock === null);
  const shop = await api("POST", "/products", { name: "دُکان", unit: "عدد", price: 100 });
  searchProducts.push(shop.id);
  const notebook = await api("POST", "/products", { name: "دفتر", unit: "عدد", price: 100 });
  searchProducts.push(notebook.id);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
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
    const headings = await page
      .locator("#createOrderModal .orders-items-table th")
      .allTextContents();
    assert.deepEqual(headings.slice(4), [
      "مبلغ واحد (تومان)",
      "مبلغ کل (تومان)",
      "حذف ردیف",
    ]);
    assert.equal(await row(0).locator("td").count(), 7);
    assert.equal(await page.locator("#orderDeliveryAddress").count(), 0);
    const columns = () => row(0).locator("td").evaluateAll((cells) =>
      cells.map((cell) => [cell.offsetLeft, cell.offsetWidth]),
    );
    const blankColumns = await columns();
    const unitPrice = row(0).locator(".item-price");
    await unitPrice.fill("999999999999");
    assert.equal(await row(0).locator(".item-total").textContent(), money(999999999999));
    assert.deepEqual(await columns(), blankColumns);
    await unitPrice.fill("");
    await page.locator(".orders-table-scroll").first().evaluate((table) => { table.scrollLeft = 0; });
    await page.locator("#createOrderModal .orders-dialog-body").evaluate((body) => { body.scrollTop = 0; });
    if (width === 1440) {
      const colors = await page.evaluate(() => {
        const root = document.documentElement;
        const previous = root.dataset.theme;
        const results = ["blue", "green", "red", "black"].map((theme) => {
          root.dataset.theme = theme;
          return ["orderTotal", "orderSubtotal"].map((id) => getComputedStyle(document.getElementById(id)).color);
        });
        root.dataset.theme = previous;
        return results;
      });
      assert.equal(new Set(colors.map(([total]) => total)).size, 4);
      assert.ok(colors.every(([total, subtotal]) => total !== subtotal));
    }
    assert.equal(
      await page
        .locator(".orders-row-action td")
        .first()
        .getAttribute("colspan"),
      "7",
    );
    const tableTop = () => page.locator(".orders-table-scroll").first()
      .evaluate((table) => table.getBoundingClientRect().top);
    const beforeOpen = await tableTop();
    await page.locator("#orderCustomerSearch").click();
    await page.locator(".orders-customer-option").first().waitFor();
    assert.equal(await tableTop(), beforeOpen, "opening and loading customers preserves table position");
    const customerDetailsReveal = page.waitForFunction(() => {
      const details = document.querySelector(".orders-customer-reveal:not([inert])");
      if (!details) return false;
      const opacity = Number(getComputedStyle(details).opacity);
      return opacity > 0 && opacity < 1;
    });
    await Promise.all([customerDetailsReveal, page.locator(".orders-customer-option").first().click()]);
    await page.locator("#orderCustomerDetails").waitFor({ state: "visible" });
    const productInput = row(0).locator(".item-product");
    await productInput.fill("د");
    assert.deepEqual((await page.locator("[data-product-option]:visible")
      .evaluateAll((options) => options.map((option) => Number(option.dataset.productOption)))).sort(),
    [shop.id, notebook.id].sort());
    await productInput.fill("دك");
    assert.equal(await page.locator("[data-product-option]:visible").count(), 1);
    assert.ok(await page.locator(`[data-product-option="${shop.id}"]`).isVisible());
    await productInput.fill("رّاح");
    assert.equal(await page.locator("[data-product-option]:visible").count(), 0);
    await productInput.fill("ط");
    assert.ok(await page.locator(`[data-product-option="${service.id}"]`).isVisible());
    await productInput.fill("طرا");
    await productInput.press("ArrowDown");
    await productInput.press("Enter");
    assert.equal(await productInput.getAttribute("data-product-id"), String(service.id));
    await productInput.hover();
    await page.mouse.wheel(0, 120);
    assert.equal(await productInput.getAttribute("data-product-id"), String(service.id));
    assert.equal(await row(0).locator(".item-quantity").inputValue(), "1");
    await selectOrderProduct(productInput, tracked);
    await row(0).locator(".item-quantity").fill("3");
    await check([300000], 300000);
    await page.locator(".orders-add-row").last().click();
    await selectOrderProduct(row(1).locator(".item-product"), service);
    await row(1).locator(".item-quantity").fill("2");
    await check([300000, 100000], 400000);
    await row(0).locator(".item-price").fill("۱۲۵٬۰۰۰");
    await check([375000, 100000], 475000);
    await row(1).locator(".item-quantity").fill("۴");
    await check([375000, 200000], 575000);
    assert.equal(await page.locator("#orderQuantityTotal").textContent(), "۷");
    assert.equal(await page.locator("#orderUnitPriceTotal").textContent(), money(175000));
    await page.locator('#orderDiscountKind input[value="percent"]').check();
    for (const [value, discount] of [["۱۲٫۵", 71875], ["۱۰۰", 575000], ["۰٫۰۱", 58]]) {
      await page.locator("#orderDiscountPercent").fill(value);
      assert.equal(await page.locator("#orderDiscountAmount").textContent(), money(discount));
      await check([375000, 200000], 575000, discount);
    }
    for (const value of ["-1", "۱۰۰٫۰۱", "abc"]) {
      await page.locator("#orderDiscountPercent").fill(value);
      assert.equal(await page.locator("#orderTotal").textContent(), "—");
    }
    await page.locator('#orderDiscountKind input[value="fixed"]').check();
    // Read-only totals have their own cell and Persian digits/group separators.
    assert.equal(
      await row(0)
        .locator(".item-price")
        .evaluate(
          (input) =>
            input.closest("td").nextElementSibling.querySelector("output")
              ?.className,
        ),
      "item-total",
    );
    assert.equal(await row(0).locator(".item-total input").count(), 0);
    assert.equal(
      await row(0).locator(".item-total").textContent(),
      "۳۷۵٬۰۰۰ تومان",
    );
    for (const discount of [75000, 0, 575000]) {
      await page.locator("#orderDiscount").fill(String(discount));
      await check([375000, 200000], 575000, discount);
    }
    await page.locator("#orderDiscount").fill("575001");
    assert.equal(await page.locator("#orderTotal").textContent(), "—");
    await page.locator("#orderPay").click();
    assert.ok(
      (
        await page.locator("#createOrderModal .orders-error").textContent()
      ).includes("معتبر نیست"),
    );
    await page.locator("#orderDiscount").fill("۷۵٬۰۰۰");
    await row(1).locator(".item-price").fill("0");
    await check([375000, 0], 375000, 75000);
    await row(1).locator(".item-price").fill("12x");
    assert.equal(await row(1).locator(".item-total").textContent(), "—");
    assert.equal(await page.locator("#orderSubtotal").textContent(), "—");
    await row(1).locator(".item-price").fill("۵۰٬۰۰۰");
    await row(0).locator(".item-quantity").fill("0");
    assert.equal(await row(0).locator(".item-quantity").inputValue(), "3");
    assert.equal(
      await row(0).locator(".item-total").textContent(),
      money(375000),
    );
    await row(0).locator(".item-quantity").fill("۳");
    await check([375000, 200000], 575000, 75000);
    // Adding and removing rows cannot count a displayed total twice.
    await page.locator(".orders-add-row").last().click();
    await selectOrderProduct(row(2).locator(".item-product"), service);
    await row(2).locator(".item-quantity").fill("5");
    await row(2).locator(".item-price").fill("25000");
    await check([375000, 200000, 125000], 700000, 75000);
    const remove = row(2).locator(".item-remove");
    if (width === 1440) {
      await remove.hover();
      const tooltip = page.locator(".dialog-close-tooltip:popover-open");
      await tooltip.waitFor();
      assert.equal(await tooltip.textContent(), "حذف ردیف");
      await page.waitForFunction(() => {
        const button = document.querySelector(".item-remove:hover");
        return button && getComputedStyle(button).color === "rgb(220, 38, 38)";
      });
      const before = await tooltip.boundingBox();
      const bounds = await remove.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2 + 6, bounds.y + bounds.height / 2);
      await page.waitForFunction((x) => document.querySelector(".dialog-close-tooltip").getBoundingClientRect().x !== x, before.x);
    }
    await remove.click();
    await check([375000, 200000], 575000, 75000);
    await row(0).locator(".item-total").scrollIntoViewIfNeeded();
    assert.equal(
      await page
        .locator("#createOrderModal")
        .evaluate((root) => root.scrollWidth <= root.clientWidth),
      true,
      "table scroll stays within the existing responsive wrapper",
    );
    const finalDiscount = width === 1440 ? 71875 : 75000;
    const finalTotal = 575000 - finalDiscount;
    if (width === 1440) {
      await page.locator('#orderDiscountKind input[value="percent"]').check();
      await page.locator("#orderDiscountPercent").fill("۱۲٫۵");
    }
    await page.locator("#orderPay").click();
    await page.locator("#orderPaymentModal").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#paymentInvoiceTotal").textContent(),
      money(finalTotal),
    );
    await page.locator("#pay-cash").check();
    await page.locator("#pay-transfer").check();
    await page.locator("#pay-pos-amount").fill("250000");
    await page.locator("#pay-transfer-amount").fill("100000");
    const cash = page.locator("#pay-cash-amount");
    await cash.fill("12000");
    const paymentScroll = () => page.locator("#orderPaymentModal .orders-dialog-body")
      .evaluate((body) => body.scrollTop);
    const beforeSpace = await paymentScroll();
    await cash.press("Space");
    assert.equal(await paymentScroll(), beforeSpace);
    assert.equal(await cash.inputValue(), (finalTotal - 350000).toLocaleString("en-US"));
    await page.locator("#pay-pos-amount").fill("600000");
    await cash.press("Space");
    assert.equal(await cash.inputValue(), "0");
    await page.locator("#pay-pos").uncheck();
    await page.locator("#pay-transfer").uncheck();
    await cash.press("Space");
    assert.equal(await cash.inputValue(), finalTotal.toLocaleString("en-US"));
    assert.equal(
      await page.locator("#paymentPaid").textContent(),
      money(finalTotal),
    );
    assert.equal(
      await page.locator("#paymentRemaining").textContent(),
      money(0),
    );
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/orders") &&
        response.request().method() === "POST",
    );
    await page.locator("#finalizeOrder").click();
    const response = await responsePromise;
    assert.ok(response.ok(), await response.text());
    const payload = response.request().postDataJSON(),
      saved = await response.json();
    orders.push(saved.id);
    assert.equal(Object.hasOwn(payload, "delivery_address"), false);
    assert.deepEqual(payload.items, [
      { product_id: tracked.id, quantity: 3, unit_price: 125000 },
      { product_id: service.id, quantity: 4, unit_price: 50000 },
    ]);
    assert.equal(payload.discount, finalDiscount);
    for (const data of [
      saved,
      await api("GET", `/orders/${saved.id}`),
      await api("GET", `/orders/${saved.id}/invoice`),
    ]) {
      assert.deepEqual(
        data.items.map((item) => item.total),
        [375000, 200000],
      );
      assert.deepEqual(
        [data.subtotal, data.discount, data.total, data.paid, data.remaining],
        [575000, finalDiscount, finalTotal, finalTotal, 0],
      );
    }
    await page.reload();
    await page.locator(`[data-order-id="${saved.id}"]`).waitFor();
    const cardTotals = await page
      .locator(`[data-order-id="${saved.id}"] .orders-record-totals dd`)
      .allTextContents();
    assert.deepEqual(cardTotals, [575000, finalDiscount, finalTotal, finalTotal, 0].map(money));
    console.log(
      `PASS ${width}px: dedicated total column, Persian formatting, quantity/price changes, multiple rows, discounts/zero/invalid inputs, row removal, payment and persisted invoice totals`,
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
    for (const id of searchProducts)
      await api("DELETE", `/products/${id}`, { password: "test-password", confirmed: true });
  } finally {
    await browser.close();
  }
}

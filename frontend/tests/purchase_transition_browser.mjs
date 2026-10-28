// Compare the actual Create Order and purchase animations in the disposable fixture.
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
await page.addInitScript(() => {
  window.motionCalls = [];
  window.layoutShifts = [];
  new PerformanceObserver((list) =>
    window.layoutShifts.push(
      ...list
        .getEntries()
        .map((e) => ({
          value: e.value,
          sources: e.sources.map((s) => s.node?.className),
        })),
    ),
  ).observe({ type: "layout-shift", buffered: true });
  const original = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const islands = [...document.querySelectorAll(".navbar-info")];
    let target =
      this.id === "purchaseEntryPage" || this.id === "createOrderModal"
        ? "panel"
        : this.tagName === "FORM"
          ? "form"
          : this.classList.contains("navbar-glass")
            ? "glass"
            : this.classList.contains("navbar-items")
              ? "items"
              : islands.includes(this)
                ? `island-${islands.indexOf(this)}`
                : null;
    if (target)
      window.motionCalls.push({
        target,
        frames,
        options,
        at: performance.now(),
      });
    return original.call(this, frames, options);
  };
});
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const settled = (id) =>
  page.waitForFunction((id) => {
    const p = document.getElementById(id);
    return (
      p &&
      !p.hidden &&
      !p.dataset.morph &&
      document
        .querySelector(".navbar-dock")
        .classList.contains("document-dock-open")
    );
  }, id);
const snapshot = () =>
  page.evaluate(() => ({
    calls: window.motionCalls.map(({ at, ...call }) => call),
    shifts: window.layoutShifts,
    width: document.getElementById("mainNavbar").offsetWidth,
    dock: document
      .querySelector(".navbar-dock")
      .getBoundingClientRect()
      .toJSON(),
  }));
try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator("button[type=submit]").click();
  await page.waitForURL("**/index.html");
  await page.goto(`${base}/page/orders-page.html`);
  await ready();
  await page.evaluate(() => {
    window.motionCalls = [];
    window.layoutShifts = [];
    document.querySelector(".orders-create").click();
  });
  await settled("createOrderModal");
  const order = await snapshot();
  await page.goto(`${base}/page/warehouse-page.html`);
  await ready();
  await page.route("**/api/settings/inventory-options", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.evaluate(() => {
    window.motionCalls = [];
    window.layoutShifts = [];
    window.clickAt = performance.now();
    window.navGeometry = [];
    const nav = document.getElementById("mainNavbar");
    const sample = () => {
      window.navGeometry.push([
        nav.offsetLeft,
        nav.offsetTop,
        nav.offsetWidth,
        nav.offsetHeight,
      ]);
      if (
        document
          .getElementById("buyItemsButton")
          .getAttribute("aria-expanded") === "true"
      )
        requestAnimationFrame(sample);
    };
    document.getElementById("buyItemsButton").click();
    requestAnimationFrame(sample);
  });
  await settled("purchaseEntryPage");
  const purchase = await snapshot();
  assert.deepEqual(
    purchase.calls,
    order.calls,
    "keyframes, timing, easing and navbar geometry must match Create Order exactly",
  );
  assert.equal(purchase.width, order.width);
  assert.deepEqual(purchase.dock, order.dock);
  assert.equal(
    await page.locator("#purchaseEntryPage").getAttribute("aria-busy"),
    "true",
    "opening must finish before slow Settings data arrives",
  );
  assert.equal(
    await page.locator("dialog[open], [aria-modal=true]").count(),
    0,
  );
  const performance = await page.evaluate(() => ({
    start: window.motionCalls[0].at - window.clickAt,
    shifts: window.layoutShifts,
    geometries: [...new Set(window.navGeometry.map(JSON.stringify))],
  }));
  assert.ok(
    performance.start < 150,
    `animation started after ${performance.start}ms`,
  );
  assert.deepEqual(
    performance.shifts.filter((e) =>
      e.sources.some((cls) => !String(cls).includes("navbar-glass")),
    ),
    [],
    "content and navbar hit areas must not shift",
  );
  assert.equal(
    performance.geometries.length,
    1,
    "navbar hit areas must keep their layout throughout animation",
  );
  await page.waitForFunction(
    () =>
      document.getElementById("purchaseEntryPage").getAttribute("aria-busy") ===
      "false",
  );
  await page.unroute("**/api/settings/inventory-options");
  await page.locator("#purchaseItemName").fill("خرید آزمایش");
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const geometry = await page.evaluate(() => {
      const p = document.getElementById("purchaseEntryPage"),
        r = p.getBoundingClientRect(),
        nav = document.getElementById("mainNavbar").getBoundingClientRect();
      return {
        centered: Math.abs(r.left - (innerWidth - r.width) / 2) < 1,
        width: Math.abs(r.width - Math.min(1100, innerWidth - 32)) < 1,
        bottom: Math.abs(r.bottom - nav.bottom) < 1,
        fits:
          r.top >= 14 &&
          r.right <= innerWidth &&
          p.scrollWidth <= p.clientWidth,
      };
    });
    assert.deepEqual(
      geometry,
      { centered: true, width: true, bottom: true, fits: true },
      `${width}px geometry`,
    );
  }
  await page.locator("#closePurchaseEntry").click();
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  assert.equal(await page.locator("#mainNavbar").isVisible(), true);
  assert.equal(
    await page.locator(".navbar-dock").getAttribute("class"),
    "navbar-dock",
  );
  assert.equal(
    await page
      .locator("#buyItemsButton")
      .evaluate((n) => n === document.activeElement),
    true,
  );
  await page.locator("#buyItemsButton").click();
  await settled("purchaseEntryPage");
  assert.equal(
    await page.locator("#purchaseItemName").inputValue(),
    "خرید آزمایش",
  );
  await page.locator("#closePurchaseEntry").click();
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  await page.evaluate(() => document.getElementById("buyItemsButton").click());
  await page.waitForFunction(
    () =>
      document.getElementById("purchaseEntryPage").dataset.morph ===
      "preparing",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  assert.equal(await page.locator("#mainNavbar").isVisible(), true);
  await page.locator("#buyItemsButton").click();
  await settled("purchaseEntryPage");
  // Changing motion preferences and viewport while opening must settle cleanly.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#closePurchaseEntry").click();
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  await page.evaluate(() => {
    window.motionCalls = [];
    document.getElementById("buyItemsButton").click();
  });
  await settled("purchaseEntryPage");
  assert.equal(await page.evaluate(() => window.motionCalls.length), 0);
  await page.goBack();
  await page.waitForFunction(
    () => document.getElementById("purchaseEntryPage").hidden,
  );
  await page.goForward();
  await settled("purchaseEntryPage");
  assert.deepEqual(errors, []);
  console.log(
    `PASS: exact Create Order keyframes/timings, ${performance.start.toFixed(1)}ms response, no content layout shifts, stable navbar, shared responsive geometry, slow Settings independence, reduced motion, form retention and history`,
  );
} finally {
  await browser.close();
}

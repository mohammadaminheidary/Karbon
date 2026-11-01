// Start serve_customers_fixture.py on ports 8019/5519 (disposable data only).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const assert = require("node:assert/strict");
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
let context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
let page = await context.newPage();
const errors = [];
const track = (p) => p.on("pageerror", (e) => errors.push(e.message));
track(page);
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const settings = async () => {
  await page.goto(base + "/page/settings-page.html#appearance");
  await ready();
};
const range = async (selector, value) => {
  await page.locator(selector).evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
};
const menu = async () => {
  if (await page.locator("#appearancePageMenu").isHidden())
    await page.locator("#appearancePageMenuButton").click();
};
const rootSize = () =>
  page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
try {
  const response = await context.request.post(base + "/api/login", {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(response.status(), 200);
  const token = (await response.json()).token;
  await page.goto(base + "/page/login-page.html");
  await page.evaluate(
    (token) => localStorage.setItem("karbon_auth", JSON.stringify({ token })),
    token,
  );
  await settings();
  assert.equal(await rootSize(), 16);
  assert.equal(
    await page
      .locator('[data-appearance-theme="blue"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  const themes = {
    blue: "#1e40af",
    red: "#b91c1c",
    green: "#15803d",
    black: "#18181b",
  };
  for (const [theme, color] of Object.entries(themes)) {
    await page.locator(`[data-appearance-theme="${theme}"]`).click();
    assert.equal(
      await page
        .locator('[data-appearance-theme][aria-pressed="true"]')
        .count(),
      1,
    );
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--color-persian-blue")
          .trim(),
      ),
      color,
    );
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--color-alizarin-crimson")
          .trim(),
      ),
      "#dc2626",
    );
    await page.reload();
    await ready();
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
  }
  await range("#appearanceFontSize", 110);
  assert.equal(await rootSize(), 17.6);
  await menu();
  await page.locator("#appearance-size-customers").focus();
  await page.keyboard.press("End"); // Native range keyboard support, creates an override.
  assert.equal(
    await page.locator("#appearance-size-customers").inputValue(),
    "125",
  );
  await range("#appearance-size-settings", 90);
  assert.equal(await rootSize(), 14.4);
  await range("#appearanceFontSize", 115);
  assert.equal(await rootSize(), 14.4);
  assert.equal(
    await page.locator("#appearance-size-orders").inputValue(),
    "115",
  );
  await page.locator('[data-appearance-page="settings"] button').click();
  assert.equal(await rootSize(), 18.4);
  assert.equal(
    await page.locator("#appearance-size-settings").inputValue(),
    "115",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#appearancePageMenu").isHidden(), true);
  assert.equal(
    await page
      .locator("#appearancePageMenuButton")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await menu();
  await page.locator(".appearance-preview").click();
  assert.equal(await page.locator("#appearancePageMenu").isHidden(), true);

  // Slider layout, disclosure, every page row and live settings scaling at phone/tablet/desktop widths.
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const size of [85, 125]) {
      await range("#appearanceFontSize", size);
      await menu();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `overflow ${width}/${size}`,
      );
      const outside = await page
        .locator("#settings-panel-appearance :is(input,button)")
        .evaluateAll((elements) =>
          elements
            .filter((e) => e.getClientRects().length)
            .some((e) => {
              const r = e.getBoundingClientRect();
              return r.left < 0 || r.right > innerWidth + 1;
            }),
        );
      assert.equal(outside, false, `controls overflow ${width}/${size}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await range("#appearanceFontSize", 110);
  const pages = await page.evaluate(() => window.KarbonAppearance.pages);
  // Assign each page independently through its actual slider; leave orders inheriting.
  const overrides = {};
  for (const [index, entry] of pages.entries()) {
    if (entry.id === "orders") continue;
    overrides[entry.id] = 85 + (index % 9) * 5;
    await range(`#appearance-size-${entry.id}`, overrides[entry.id]);
  }
  const savedState = await context.storageState();
  await context.close();
  context = await browser.newContext({
    storageState: savedState,
    viewport: { width: 1440, height: 1050 },
  });
  page = await context.newPage();
  track(page);

  // A new browser session restores storage. Every route and theme resolves the correct font size,
  // including dashboard SVGs, modal styles, finance forms, dynamic lists and login.
  for (const [theme, color] of Object.entries(themes)) {
    await settings();
    await page.locator(`[data-appearance-theme="${theme}"]`).click();
    for (const entry of pages) {
      await page.goto(base + entry.path);
      if (entry.id !== "login") await ready();
      else await page.locator("#loginForm").waitFor();
      const expected = overrides[entry.id] ?? 110;
      assert.ok(
        Math.abs((await rootSize()) - (16 * expected) / 100) < 0.01,
        `${theme}/${entry.id}`,
      );
      const measured = await page.evaluate(() => {
        const el =
          document.querySelector("main h1, main h2, #loginForm h1") ||
          document.querySelector(".navbar-page-title");
        const scaled = parseFloat(getComputedStyle(el).fontSize);
        const original = document.documentElement.style.fontSize;
        const originalScale =
          document.documentElement.style.getPropertyValue("--app-font-scale");
        document.documentElement.style.fontSize = "100%";
        document.documentElement.style.setProperty("--app-font-scale", "1");
        const baseline = parseFloat(getComputedStyle(el).fontSize);
        document.documentElement.style.fontSize = original;
        document.documentElement.style.setProperty(
          "--app-font-scale",
          originalScale,
        );
        return { scaled, baseline };
      });
      assert.ok(
        Math.abs(measured.scaled - (measured.baseline * expected) / 100) < 0.05,
        `typography ${theme}/${entry.id}`,
      );
      assert.equal(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--color-persian-blue")
            .trim(),
        ),
        color,
      );
      if (entry.id === "dashboard") {
        assert.equal(
          await page
            .locator(".dashboard")
            .evaluate((e) =>
              getComputedStyle(e).getPropertyValue("--dash-blue").trim(),
            ),
          color,
        );
      }
    }
  }
  await settings();
  await menu();
  await page.locator('[data-appearance-page="customers"] button').click();
  await range("#appearanceFontSize", 120);
  await page.goto(base + "/page/customers-page.html");
  await ready();
  assert.equal(await rootSize(), 19.2);

  // A simultaneous tab propagates live settings and updates the visible controls.
  await settings();
  const other = await context.newPage();
  await other.goto(base + "/page/settings-page.html#appearance");
  await other.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
  await other.locator('[data-appearance-theme="red"]').click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "red",
  );
  assert.equal(
    await page
      .locator('[data-appearance-theme="red"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  // Cancelling leaves preferences intact; confirmation resets only appearance.
  const beforeReset = await page.evaluate(() => ({
    appearance: localStorage.getItem("karbon_appearance"),
    auth: localStorage.getItem("karbon_auth"),
  }));
  await page.evaluate(() =>
    localStorage.setItem("unrelated-setting-test", "keep"),
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#appearanceResetDefaults").click();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("karbon_appearance")),
    beforeReset.appearance,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#appearanceResetDefaults").click();
  const defaults = { theme: "blue", fontSize: 100, pageFontSizes: {} };
  assert.deepEqual(
    await page.evaluate(() => window.KarbonAppearance.getPreferences()),
    defaults,
  );
  assert.equal(await rootSize(), 16);
  assert.equal(await page.locator("#appearanceFontSize").inputValue(), "100");
  await page
    .locator(".navbar-notification")
    .filter({ hasText: "تنظیمات ظاهر به پیش‌فرض بازنشانی شد." })
    .waitFor({ state: "visible" });
  await other.waitForFunction(
    () =>
      document.documentElement.dataset.theme === "blue" &&
      document.documentElement.style.fontSize === "100%",
  );
  assert.deepEqual(
    await other.evaluate(() => window.KarbonAppearance.getPreferences()),
    defaults,
  );
  await page.reload();
  await ready();
  assert.deepEqual(
    await page.evaluate(() => window.KarbonAppearance.getPreferences()),
    defaults,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("karbon_auth")),
    beforeReset.auth,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("unrelated-setting-test")),
    "keep",
  );
  await menu();
  assert.equal(
    await page.locator('.appearance-reset[aria-disabled="true"]').count(),
    pages.length,
  );
  await other.close();
  await page.screenshot({
    path: "/tmp/karbon-appearance-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await menu();
  await page.screenshot({
    path: "/tmp/karbon-appearance-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: four themes across all 12 pages; global scaling; page overrides/reset; keyboard/disclosure; five viewport widths; reload/new-session persistence; live cross-tab sync.",
  );
} catch (error) {
  await page.screenshot({
    path: "/tmp/karbon-appearance-failure.png",
    fullPage: true,
  });
  console.error("Page errors:", errors);
  throw error;
} finally {
  await browser.close();
}

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
const dockButtons = "#mainNavbar .navbar-item";
const dockToggle = "#appearanceDockAnimation";
const dockSlider = "#appearanceDockMagnification";
const dockValue = "#appearanceDockMagnificationValue";
const dockIconSize = 20;
const dockWidth = () => page.locator("#mainNavbar").evaluate((navbar) => navbar.getBoundingClientRect().width);
const dockSlots = () => page.locator(dockButtons).evaluateAll((buttons) =>
  buttons.map((button) => button.getBoundingClientRect().toJSON()),
);
const dockFramesOverlap = () => page.locator(dockButtons).evaluateAll((buttons) => {
  const frames = buttons.map((button) => {
    const slot = button.getBoundingClientRect();
    const frame = getComputedStyle(button, "::before");
    const scale = frame.scale === "none" ? 1 : parseFloat(frame.scale);
    const lift = parseFloat(frame.translate.split(" ")[1]) || 0;
    return {
      x: slot.left + slot.width / 2,
      y: slot.top + slot.height / 2 + lift,
      width: parseFloat(frame.width) * scale,
      height: parseFloat(frame.height) * scale,
    };
  });
  return frames.some((a, i) => frames.slice(i + 1).some((b) =>
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 - 0.1 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 - 0.1,
  ));
});
const waitForDockScale = (index, expected) => page.waitForFunction(
  ({ dockButtons, dockIconSize, index, expected }) => {
    const button = document.querySelectorAll(dockButtons)[index];
    const frame = getComputedStyle(button, "::before");
    const { width, height, transform, translate } = getComputedStyle(button.querySelector(".navbar-icon"));
    const frameScale = frame.scale === "none" ? 1 : parseFloat(frame.scale);
    return transform === "none"
      && Math.abs(frameScale - expected) < 0.003
      && frame.translate === translate
      && Math.abs(parseFloat(width) / dockIconSize - expected) < 0.003
      && Math.abs(parseFloat(height) / dockIconSize - expected) < 0.003;
  },
  { dockButtons, dockIconSize, index, expected },
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
  assert.equal(await page.locator(dockToggle).isChecked(), true);
  assert.equal(await page.locator(dockSlider).inputValue(), "160");
  assert.equal(await page.locator(dockValue).textContent(), "۱۶۰٪");
  const slots = await dockSlots();
  const restWidth = await dockWidth();
  const pointer = (index) => ({
    x: slots[index].left + slots[index].width / 2,
    y: slots[index].top + slots[index].height / 2,
  });
  const hoverDock = async (index) => {
    const { x, y, width, height } = await page.locator(dockButtons).nth(index).boundingBox();
    await page.mouse.move(x + width / 2, y + height / 2);
  };
  const center = 6;
  await hoverDock(center);
  await waitForDockScale(center, 1.6);
  assert.ok(await dockWidth() > restWidth);
  assert.equal(await dockFramesOverlap(), false);
  for (const amount of [110, 135, 180]) {
    await range(dockSlider, amount);
    await waitForDockScale(center, amount / 100);
  }
  const scales = await page.locator(`${dockButtons} .navbar-icon`).evaluateAll(
    (icons, base) => icons.map((icon) => parseFloat(getComputedStyle(icon).width) / base),
    dockIconSize,
  );
  assert.ok(scales[center] > scales[center - 1]);
  assert.ok(scales[center - 1] > scales[center - 2]);
  assert.ok(scales[center - 2] > 1);
  assert.equal(scales[center - 3], 1);
  assert.ok(Math.abs(scales[center - 1] - scales[center + 1]) < 0.005);
  const expanded = await dockSlots();
  assert.ok(expanded[center].width > slots[center].width);
  const neighbor = expanded[center + 1];
  const midpoint = (expanded[center].left + expanded[center].width / 2 + neighbor.left + neighbor.width / 2) / 2;
  await page.mouse.move(midpoint, pointer(center).y, { steps: 8 });
  assert.equal(await dockFramesOverlap(), false);
  await page.mouse.move(0, 0);
  await waitForDockScale(center, 1);
  await page.waitForFunction((width) => Math.abs(document.querySelector("#mainNavbar").getBoundingClientRect().width - width) < 0.1, restWidth);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelectorAll("#mainNavbar .navbar-row").length > 1);
  const wrappedSlots = await dockSlots();
  const wrappedWidth = await dockWidth();
  const lastIndex = wrappedSlots.length - 1;
  const lastSlot = wrappedSlots[lastIndex];
  assert.ok(lastSlot.top > wrappedSlots[0].top);
  await page.mouse.move(lastSlot.left + lastSlot.width / 2, lastSlot.top + lastSlot.height / 2);
  await waitForDockScale(lastIndex, 1.8);
  assert.equal(await dockFramesOverlap(), false);
  await page.mouse.move(0, 0);
  await waitForDockScale(lastIndex, 1);
  const firstRowCenter = wrappedSlots[2];
  await page.mouse.move(firstRowCenter.left + firstRowCenter.width / 2, firstRowCenter.top + firstRowCenter.height / 2);
  await page.waitForFunction((width) => document.querySelector("#mainNavbar").getBoundingClientRect().width > width + 4, wrappedWidth);
  assert.ok(await dockWidth() <= 390 - 32 + 0.1);
  assert.equal(await dockFramesOverlap(), false);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1440, height: 1050 });

  const currentDockButton = page.locator(`${dockButtons}[aria-current="page"]`);
  const currentDockFrame = () => currentDockButton.evaluate((button) => getComputedStyle(button, "::before").backgroundImage);
  const driftStart = await currentDockFrame();
  assert.match(driftStart, /radial-gradient/);
  await page.waitForFunction((background) =>
    getComputedStyle(document.querySelector("#mainNavbar [aria-current='page']"), "::before").backgroundImage !== background,
  driftStart);
  const transparency = "#appearanceDockHighlightTransparency";
  const darkness = "#appearanceDockHighlightDarkness";
  assert.equal(await page.locator(transparency).inputValue(), "45");
  assert.equal(await page.locator(darkness).inputValue(), "0");
  await range(transparency, 77);
  await range(darkness, 64);
  assert.equal(await page.locator(`${transparency}Value`).textContent(), "۷۷٪");
  assert.equal(await page.locator(`${darkness}Value`).textContent(), "۶۴٪");
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--dock-highlight-transparency")), "77%");
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--dock-highlight-darkness")), "64%");
  const currentBounds = await currentDockButton.boundingBox();
  const currentY = currentBounds.y + currentBounds.height / 2;
  await page.mouse.move(currentBounds.x + currentBounds.width / 2, currentY);
  await page.waitForFunction(() => {
    const button = document.querySelector("#mainNavbar [aria-current='page']");
    return getComputedStyle(button, "::before").getPropertyValue("--dock-highlight-follow") === "1";
  });
  const highlighted = await currentDockButton.boundingBox();
  await page.mouse.move(highlighted.x + highlighted.width * 0.3, currentY);
  await page.waitForFunction(() => parseFloat(document.querySelector("[data-dock-highlight]")?.style.getPropertyValue("--dock-pointer-x")) < 45);
  await page.mouse.move(highlighted.x + highlighted.width * 0.7, currentY);
  await page.waitForFunction(() => parseFloat(document.querySelector("[data-dock-highlight]")?.style.getPropertyValue("--dock-pointer-x")) > 55);
  await page.mouse.move(0, 0);
  await page.locator("[data-dock-highlight]").waitFor({ state: "detached" });
  await page.waitForFunction((width) => Math.abs(document.querySelector("#mainNavbar").getBoundingClientRect().width - width) < 0.1, restWidth);

  await hoverDock(center);
  await waitForDockScale(center, 1.8);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await waitForDockScale(center, 1);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(dockToggle).focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator(dockToggle).isChecked(), false);
  assert.equal(await page.locator(dockSlider).isDisabled(), true);
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(await page.locator(`${dockToggle} + .appearance-switch`).evaluate((track) =>
    getComputedStyle(track).backgroundColor !== getComputedStyle(track, "::before").backgroundColor,
  ), true);
  await page.emulateMedia({ forcedColors: "none" });
  await hoverDock(center);
  await waitForDockScale(center, 1);
  assert.equal(await page.locator("#mainNavbar[data-dock-animation]").count(), 0);
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
  await settings();
  assert.equal(await page.locator(dockToggle).isChecked(), false);
  assert.equal(await page.locator(dockSlider).inputValue(), "180");

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
  await other.locator(dockToggle).focus();
  await other.keyboard.press("Space");
  await other.locator(dockSlider).focus();
  await other.keyboard.press("Home");
  await page.waitForFunction(() => {
    const { dockAnimation, dockMagnification } = window.KarbonAppearance.getPreferences();
    return dockAnimation && dockMagnification === 110;
  });
  assert.equal(await page.locator(dockValue).textContent(), "۱۱۰٪");
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
  const defaults = {
    theme: "blue",
    fontSize: 100,
    pageFontSizes: {},
    cardTiltBySection: {},
    dockAnimation: true,
    dockMagnification: 160,
    dockHighlightTransparency: 45,
    dockHighlightDarkness: 0,
  };
  assert.deepEqual(
    await page.evaluate(() => window.KarbonAppearance.getPreferences()),
    defaults,
  );
  assert.equal(await rootSize(), 16);
  assert.equal(await page.locator("#appearanceFontSize").inputValue(), "100");
  await page
    .locator('.notification-popup[data-type="success"]')
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
    "PASS: themes and typography across routes; dock zoom, falloff, expansion without overlap, reduced motion and toggle; keyboard, responsive controls, reset, persistence and cross-tab sync.",
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

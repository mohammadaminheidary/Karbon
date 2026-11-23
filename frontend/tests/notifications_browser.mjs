// Run beside serve_customers_fixture.py with --bank-ledger 1.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5502";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.KARBON_CHROME_PATH,
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const popup = page.locator(".notification-popup");
const stack = page.locator(".notification-stack");
const logout = page.locator("#logoutButton");
const submit = page.locator('#loginForm button[type="submit"]');

try {
  await page.goto(base + "/page/login-page.html");
  await submit.click();
  await popup.filter({ hasText: "نام کاربری را وارد کنید" }).waitFor();
  assert.equal(await popup.getAttribute("data-type"), "warning");
  assert.equal(await submit.isEnabled(), true);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await submit.click();
  await page.waitForURL("**/index.html");
  assert.equal(await popup.count(), 0);

  // Every protected document uses the same real notification trigger.
  const pages = await readdir(new URL("../page/", import.meta.url));
  const routes = [
    "/index.html",
    ...pages
      .filter((file) => file.endsWith(".html") && file !== "login-page.html")
      .map((file) => "/page/" + file),
  ];
  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({ status: 503 }),
  );
  for (const path of routes) {
    await page.goto(
      base + path + (path.includes("bank-transactions") ? "?bank=1" : ""),
    );
    await page.locator('html[data-page-state="ready"]').waitFor();
    const dockTitle = page.locator(
      ".navbar-title-island :is(.navbar-page-title, .orders-create):visible",
    );
    await dockTitle.first().waitFor();
    const labels = await dockTitle.allTextContents();
    await logout.click();
    await popup.filter({ hasText: "خروج امن انجام نشد" }).waitFor();
    assert.equal(await popup.getAttribute("data-type"), "error", path);
    assert.equal(
      await stack.evaluate((element) => element.matches(":popover-open")),
      true,
      path,
    );
    assert.equal(
      await page.locator("#navbarHost .notification-stack").count(),
      0,
      path,
    );
    assert.deepEqual(await dockTitle.allTextContents(), labels, path);
    assert.equal(await logout.isEnabled(), true, path);
  }
  console.log(
    `Shared popup triggered on login and all ${routes.length} protected pages.`,
  );

  await page.goto(base + "/page/orders-page.html");
  await page.locator('html[data-page-state="ready"]').waitFor();
  await page.setViewportSize({ width: 320, height: 640 });
  const initial = await page.evaluate(async () => {
    const { notify } = await import("/src/js/components/notifications.js");
    window.dismissNotices = [
      notify("سفارش با موفقیت ثبت شد", { type: "success", duration: 1000 }),
      notify(
        "دریافت اطلاعات انجام نشد. دوباره تلاش کنید. " + "شناسه".repeat(16),
        {
          type: "error",
          duration: 10000,
        },
      ),
      notify("زمان ذخیره اطلاعات به پایان می‌رسد", {
        type: "warning",
        duration: 10000,
      }),
      notify("اطلاعات فاکتور به‌روز شد", { duration: 750 }),
    ];
    return [...document.querySelectorAll(".notification-popup")].map(
      (item) => item.getAnimations()[0]?.animationName,
    );
  });
  assert.deepEqual(initial, Array(3).fill("notification-enter"));
  assert.equal(await page.locator(".orders-create").isEnabled(), true);
  await stack
    .locator('[role="status"]')
    .filter({ hasText: "سفارش با موفقیت ثبت شد" })
    .waitFor();
  await stack
    .locator('[role="alert"]')
    .filter({ hasText: "دریافت اطلاعات انجام نشد" })
    .waitFor();
  const bounds = await popup.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().toJSON()),
  );
  assert.equal(bounds.length, 3);
  for (const [index, box] of bounds.entries()) {
    assert.ok(box.left >= 0 && box.right <= 320, "popup fits narrow viewport");
    assert.ok(
      index === 0 || box.top >= bounds[index - 1].bottom,
      "popups never overlap",
    );
  }

  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "notificationTestDialog";
    dialog.innerHTML = "<button autofocus>ادامه</button>";
    dialog.querySelector("button").onclick = () => dialog.close();
    document.body.append(dialog);
    dialog.showModal();
  });
  const dialog = page.locator("#notificationTestDialog");
  await dialog.locator(".notification-stack:popover-open").waitFor();
  assert.equal(
    await dialog
      .locator("button")
      .evaluate((button) => document.activeElement === button),
    true,
  );
  assert.ok((await popup.first().boundingBox()).y < 30);
  await dialog.locator("button").click();
  await page.locator("body > .notification-stack:popover-open").waitFor();
  await popup
    .filter({ hasText: "سفارش با موفقیت ثبت شد" })
    .waitFor({ state: "detached" });
  const information = popup.filter({ hasText: "اطلاعات فاکتور به‌روز شد" });
  await information.waitFor();
  assert.equal(await information.getAttribute("data-type"), "info");
  const exit = await information.evaluate(
    (item) =>
      new Promise((resolve) => {
        item.addEventListener("animationstart", (event) => {
          if (event.animationName === "notification-exit")
            resolve(event.animationName);
        });
      }),
  );
  assert.equal(exit, "notification-exit");
  await information.waitFor({ state: "detached" });
  assert.equal(await popup.count(), 2);
  await page.evaluate(() =>
    window.dismissNotices.forEach((dismiss) => dismiss()),
  );
  await stack.waitFor({ state: "detached" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page.evaluate(async () => {
      const { notify } = await import("/src/js/components/notifications.js");
      notify("<strong>Text</strong>");
      return document.querySelector(".notification-popup").getAnimations()
        .length;
    }),
    0,
  );
  assert.equal(
    await popup.locator("bdi").textContent(),
    "<strong>Text</strong>",
  );
  await page.goto(base + "/page/customers-page.html");
  await page.goBack({ waitUntil: "commit" });
  await page.locator('html[data-page-state="ready"]').waitFor();
  assert.equal(await popup.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Verified stacking, queueing, varied lifetimes, animation, reduced motion, modal focus and navigation cleanup.",
  );
} finally {
  await browser.close();
}

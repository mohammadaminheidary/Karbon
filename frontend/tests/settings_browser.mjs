import { clickSettingsSection } from "./settings_navigation.mjs";
// Fixture: python3 frontend/tests/serve_customers_fixture.py --backend-port 8017 --frontend-port 5517 --members 2 --orders --finance --customers 2
// Run only against the disposable fixture; this test changes its login credentials.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5517";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH
    ? { executablePath: process.env.KARBON_CHROME_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const login = await context.request.post(base + "/api/login", {
  data: { username: "customers-test", password: "test-password" },
});
assert.equal(login.status(), 200);
const original = (await login.json()).token;
const headers = { Authorization: "Bearer " + original };
const customer = (
  await (
    await context.request.get(base + "/api/customers?limit=1", { headers })
  ).json()
).items[0];
const product = (
  await (await context.request.get(base + "/api/products", { headers })).json()
)[0];
const orderResponse = await context.request.post(base + "/api/orders", {
  headers,
  data: {
    request_id: crypto.randomUUID(),
    customer_id: customer.id,
    invoice_date: "1405/08/09",
    payment_date: "1405/08/09",
    items: [{ product_id: product.id, quantity: 1, unit_price: 1000 }],
    discount: 0,
    payments: [],
  },
});
assert.equal(orderResponse.status(), 201, await orderResponse.text());
const invoice = await orderResponse.json();
await page.goto(base + "/page/login-page.html");
await page.evaluate(
  (token) => localStorage.setItem("karbon_auth", JSON.stringify({ token })),
  original,
);
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
await page.goto(base + "/page/settings-page.html");
await ready();
const open = async (section) => {
  await clickSettingsSection(page, section);
  await page
    .locator(
      `[data-settings-panel="${section}"]:not(.hidden)[aria-busy="false"]`,
    )
    .waitFor();
  assert.equal(
    await page.locator("[data-settings-panel]:not(.hidden)").count(),
    1,
  );
  assert.equal(
    await page
      .locator(`[data-settings-target="${section}"]`)
      .getAttribute("aria-current"),
    "true",
  );
};
const contains = async (selector, text) =>
  page.waitForFunction(
    ([selector, text]) =>
      document.querySelector(selector)?.textContent.includes(text),
    [selector, text],
  );
const submit = async (id, match) => {
  const response = page.waitForResponse(
    (r) =>
      r.url().includes(match) &&
      ["POST", "PUT", "DELETE"].includes(r.request().method()),
  );
  await page.locator(id).click();
  const r = await response;
  assert.ok(r.ok(), `${match}: ${r.status()} ${await r.text()}`);
};
try {
  const navigation = page.locator("#settingsNavigation");
  assert.equal(await page.locator(".settings-welcome").count(), 0);
  const cards = page.locator(".settings-category-card");
  assert.ok(await cards.count() > 0);
  assert.equal(await cards.locator(".settings-card-arrow path").evaluateAll((paths) =>
    paths.every((path) => {
      const length = path.getTotalLength();
      const tip = path.getPointAtLength(length / 2);
      return tip.x < path.getPointAtLength(0).x && tip.x < path.getPointAtLength(length).x;
    }),
  ), true);

  const groups = navigation.locator("details");
  assert.deepEqual(await groups.locator("summary span").allTextContents(),
    ["حساب و مجموعه", "مالی و اسناد", "کالا", "انبار", "برنامه"]);
  assert.equal(await navigation.locator("details[open]").count(), 0);

  const account = groups.filter({ has: page.locator("#settings-tab-members") });
  const accountSummary = account.locator("summary");
  await account.evaluate((group) => {
    group.addEventListener("transitionend", (event) => {
      if (event.propertyName !== "grid-template-rows") return;
      group.dataset.testTransitionEnded = String(group.open);
    });
  });
  await accountSummary.focus();
  for (const expanded of [true, false]) {
    await accountSummary.press("Enter");
    assert.equal(await account.evaluate((group) => group.open), expanded);
    await page.locator(`details[data-test-transition-ended="${expanded}"]`).waitFor({ timeout: 3000 });
  }

  await accountSummary.click();
  await page.locator('details[data-test-transition-ended="true"]').waitFor();
  const highlight = navigation.locator(".settings-nav-indicator");
  const checkHighlight = async (section, animated) => {
    const button = navigation.locator(`[data-settings-target="${section}"]`);
    const movement = await button.evaluate(async (target) => {
      const indicator = target.closest("nav").querySelector(".settings-nav-indicator");
      const before = indicator.getBoundingClientRect();
      target.click();
      const animations = indicator.getAnimations();
      const start = indicator.getBoundingClientRect();
      await Promise.all(animations.map((animation) => animation.finished));
      const end = indicator.getBoundingClientRect();
      const button = target.getBoundingClientRect();
      return {
        animated: animations.length > 0,
        startedAtPrevious: Math.abs(before.y - start.y) < 1,
        endsAtButton: ["x", "y", "width", "height"].every((key) => Math.abs(end[key] - button[key]) < 1),
      };
    });
    assert.equal(movement.animated, animated);
    if (animated) assert.equal(movement.startedAtPrevious, true);
    assert.equal(movement.endsAtButton, true);
  };
  await checkHighlight("members", true);
  await checkHighlight("security", true);
  await accountSummary.click();
  await highlight.waitFor({ state: "hidden" });
  await accountSummary.click();
  await highlight.waitFor({ state: "visible" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await checkHighlight("general", false);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Every original tool remains reachable at phone, tablet, laptop and desktop widths.
  const sections = [
    "general",
    "members",
    "banks",
    "expenses",
    "document-accounts",
    "products",
    "inventory",
    "units",
    "brands",
    "invoices",
    "appearance",
    "security",
    "backup",
  ];
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const section of sections) {
      await open(section);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${section} overflows at ${width}`,
      );
      const bounds = await page
        .locator(`[data-settings-panel="${section}"]`)
        .boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
        `${section} bounds at ${width}`,
      );
      // Form controls must fit their panel (tables have their own scroll area).
      const overflow = await page
        .locator(`[data-settings-panel="${section}"] :is(input,select)`)
        .evaluateAll((inputs) =>
          inputs
            .filter((e) => e.getClientRects().length)
            .some((e) => {
              const r = e.getBoundingClientRect();
              return r.left < 0 || r.right > innerWidth + 1;
            }),
        );
      assert.equal(
        overflow,
        false,
        `form controls overflow: ${section} ${width}`,
      );
    }
  }
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 620 });
    await open("general");
    await page.evaluate(() => window.scrollTo({ top: 200, behavior: "instant" }));
    const sidebar = page.locator(".settings-sidebar");
    const before = await sidebar.boundingBox();
    const pageScroll = await page.evaluate(() => window.scrollY);
    assert.ok(pageScroll > 0);
    const navBounds = await navigation.boundingBox();
    await page.mouse.move(navBounds.x + navBounds.width / 2, navBounds.y + navBounds.height / 2);
    await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => {
      const nav = document.getElementById("settingsNavigation");
      return nav.scrollTop > 0 && nav.scrollHeight - nav.clientHeight - nav.scrollTop < 2;
    });
    assert.equal(await page.evaluate(() => window.scrollY), pageScroll);
    const lastButton = page.locator("#settings-tab-factory-reset");
    assert.equal(await lastButton.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const nav = button.closest("nav").getBoundingClientRect();
      return bounds.bottom <= nav.bottom && bounds.top >= nav.top;
    }), true);
    await page.evaluate(() => window.scrollBy({ top: 60, behavior: "instant" }));
    assert.ok(await page.evaluate(() => window.scrollY) > pageScroll);
    assert.ok(Math.abs((await sidebar.boundingBox()).y - before.y) < 1);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await open("general");
  await page.screenshot({
    path: "/tmp/karbon-settings-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  // Overview shortcuts and deep links.
  await accountSummary.click();
  assert.equal(await account.evaluate((group) => group.open), false);
  await page.locator('[data-open-settings-section="members"]').click();
  assert.equal(await account.evaluate((group) => group.open), true);
  await page.locator("#settingsMembersTable").waitFor({ state: "visible" });
  await page.locator("#addMemberButton").click();
  await page.locator("#memberFirstName").fill("آزمون");
  await page.locator("#memberLastName").fill("تنظیمات");
  await submit("#saveMemberButton", "/members");
  await contains("#settingsMembersTableBody", "آزمون");
  const member = page
    .locator("#settingsMembersTableBody tr")
    .filter({ hasText: "آزمون" });
  await member.getByRole("button", { name: "ویرایش", exact: true }).click();
  await page.locator("#memberFirstName").fill("ویرایش آزمون");
  await submit("#saveMemberButton", "/members/");
  await contains("#settingsMembersTableBody", "ویرایش آزمون");
  // Face-registration entry point remains available; don't request a camera.
  assert.ok(await member.getByRole("button", { name: /چهره/ }).count());
  await member.getByRole("button", { name: "حذف", exact: true }).click();
  await page.locator("#confirmDeleteMemberButton").click();
  const deleted = await page.waitForResponse(
    (r) => r.url().includes("/members/") && r.request().method() === "DELETE",
  );
  assert.ok(deleted.ok());
  await page.waitForFunction(
    () =>
      !document
        .querySelector("#settingsMembersTableBody")
        .textContent.includes("ویرایش آزمون"),
  );
  // Inventory reference lists, and disabling/reactivating a unit.
  await open("inventory");
  for (const [kind, name] of [
    ["categories", "دسته آزمون"],
    ["units", "واحد آزمون"],
  ]) {
    await open(kind === "units" ? "units" : "inventory");
    await page.locator(`#inventory-${kind}-name`).fill(name);
    await submit(
      `#inventory-${kind}-form button[type="submit"]`,
      "/settings/inventory-options/",
    );
    await contains(`#inventory-${kind}-list`, name);
  }
  const unitChoice = page.getByRole("checkbox", { name: "واحد آزمون", exact: true });
  await unitChoice.uncheck();
  await page.waitForFunction(() => !document.querySelector('#inventory-units-list input:disabled'));
  assert.equal(await unitChoice.isChecked(), false);
  await unitChoice.check();
  await page.waitForFunction(() => !document.querySelector('#inventory-units-list input:disabled'));
  assert.equal(await unitChoice.isChecked(), true);
  // Existing expense, document and product creation/editing/deletion.
  for (const cfg of [
    {
      section: "expenses",
      name: "#expenseCategoryTitle",
      save: "#saveExpenseCategory",
      list: "#expenseCategoriesList",
      path: "/settings/expense-categories",
      title: "هزینه آزمون",
    },
    {
      section: "document-accounts",
      name: "#documentAccountTitle",
      save: "#saveDocumentAccount",
      list: "#documentAccountsList",
      path: "/settings/document-accounts",
      title: "سند آزمون",
    },
    {
      section: "products",
      name: "#settingsProductName",
      save: "#saveSettingsProduct",
      list: "#settingsProductsList",
      path: "/products",
      title: "کالای آزمون",
    },
  ]) {
    await open(cfg.section);
    if (cfg.section === "products") await page.locator("#openCreateProductButton").click();
    await page.locator(cfg.name).fill(cfg.title);
    if (cfg.section === "products") {
      await page.locator("#settingsProductCategory").selectOption({ index: 1 });
      await page.locator("#settingsProductUnit").selectOption("عدد");
      await page.locator("#settingsProductPrice").fill("1200");
      await page.locator("#settingsProductStock").fill("5");
    }
    await submit(cfg.save, cfg.path);
    await contains(cfg.list, cfg.title);
    const row = page
      .locator(cfg.list)
      .locator(":scope > *")
      .filter({ hasText: cfg.title });
    await row.getByRole("button", { name: "ویرایش", exact: true }).click();
    await page.locator(cfg.name).fill(cfg.title + " جدید");
    await submit(cfg.save, cfg.path + "/");
    await contains(cfg.list, cfg.title + " جدید");
    await row.getByRole("button", { name: /حذف/ }).click();
    await page.locator("#financeDeletePassword").fill("test-password");
    await submit("#financeDeleteSubmit", cfg.path + "/");
    await page.waitForFunction(
      ([selector, text]) =>
        !document.querySelector(selector)?.textContent.includes(text),
      [cfg.list, cfg.title],
    );
    await page.locator("#financeDeleteModal").waitFor({ state: "hidden" });
  }
  // Bank form and list remain functional, including validation and edit.
  await open("banks");
  await page.locator("#addBankAccount").click();
  await page.locator("#saveBank").click();
  await page.locator("#bankFormError:not(.hidden)").waitFor();
  await page.locator("#bankFirstName").fill("علی");
  await page.locator("#bankLastName").fill("آزمون");
  await page.locator("#bankSelect").selectOption("mellat");
  await page.locator("#bankCardNumber").fill("6037990000000014");
  await submit("#saveBank", "/banks");
  await contains("#bankCards", "آزمون");
  const bank = page.locator("#bankCards > *").filter({ hasText: "آزمون" });
  await bank.getByRole("button", { name: "ویرایش", exact: true }).click();
  await page.locator("#bankLastName").fill("آزمون جدید");
  await submit("#saveBank", "/banks/");
  await contains("#bankCards", "آزمون جدید");
  await bank.getByRole("button", { name: "حذف", exact: true }).click();
  await page.locator("#financeDeletePassword").fill("test-password");
  await submit("#financeDeleteSubmit", "/banks/");
  await page.locator("#financeDeleteModal").waitFor({ state: "hidden" });
  // Invoice search, details and password-confirmed deletion.
  await open("invoices");
  await contains("#settingsInvoicesList", invoice.invoice_code);
  await page.locator("#settingsInvoicesSearch").fill("no-such-invoice");
  await contains("#settingsInvoicesStatus", "پیدا نشد");
  await page.locator("#settingsInvoicesSearch").fill(invoice.invoice_code);
  await contains("#settingsInvoicesList", invoice.invoice_code);
  await page
    .getByRole("button", {
      name: "جزئیات فاکتور " + invoice.invoice_code,
      exact: true,
    })
    .click();
  await page.waitForFunction(
    () => !document.querySelector("#exportOrderDetails").disabled,
  );
  await page.locator('#orderDetailsModal button[aria-label="بستن"]').click();
  await page.locator("#orderDetailsModal").waitFor({ state: "hidden" });
  await page
    .getByRole("button", {
      name: "حذف فاکتور " + invoice.invoice_code,
      exact: true,
    })
    .click();
  await page.locator("#financeDeletePassword").fill("test-password");
  await submit("#financeDeleteSubmit", "/invoice");
  await page.locator("#financeDeleteModal").waitFor({ state: "hidden" });
  await page.locator("#refreshInvoices").click();
  await contains("#settingsInvoicesStatus", "پیدا نشد");
  // Security: client/server errors, visibility toggles, retry, pending and persisted changes.
  await page.setViewportSize({ width: 390, height: 844 });
  await open("security");
  assert.equal(
    await page.locator("#usernameForm, #securityUsername").count(),
    0,
  );
  await page.locator("#passwordForm button[type=submit]").click();
  await contains("#passwordMessage", "فعلی");
  await page.locator("#passwordCurrentPassword").fill("incorrect");
  const firstPassword = "first browser passphrase";
  await page.locator("#securityNewPassword").fill(firstPassword);
  await page.locator("#securityConfirmPassword").fill(firstPassword);
  await page.locator("#passwordForm button[type=submit]").click();
  await contains("#passwordMessage", "صحیح نیست");
  assert.equal(
    await page.locator("#passwordCurrentPassword").getAttribute("aria-invalid"),
    "true",
  );
  await page
    .locator('[data-password-toggle="passwordCurrentPassword"]')
    .click();
  assert.equal(
    await page.locator("#passwordCurrentPassword").getAttribute("type"),
    "text",
  );
  await page.locator("#passwordCurrentPassword").fill("test-password");
  await submit("#passwordForm button[type=submit]", "/auth/password");
  await contains("#passwordMessage", "موفقیت");
  assert.equal(await page.locator("#passwordCurrentPassword").inputValue(), "");
  assert.equal(
    await page.locator("#passwordCurrentPassword").getAttribute("type"),
    "password",
  );
  const firstLogin = await context.request.post(base + "/api/login", {
    data: { username: "customers-test", password: firstPassword },
  });
  assert.equal(firstLogin.status(), 200);
  const old = await context.request.get(base + "/api/auth/me", {
    headers: { Authorization: "Bearer " + original },
  });
  assert.equal(old.status(), 401);
  await page.locator("#passwordCurrentPassword").fill(firstPassword);
  await page.locator("#securityNewPassword").fill("secure browser passphrase");
  await page.locator("#securityConfirmPassword").fill("different passphrase");
  await page.locator("#passwordForm button[type=submit]").click();
  await contains("#passwordMessage", "یکسان نیست");
  await page
    .locator("#securityConfirmPassword")
    .fill("secure browser passphrase");
  // Delay only this test's response to inspect the pending state.
  await page.route("**/api/auth/password", async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 250));
    await route.fulfill({ response });
  });
  await page.locator("#passwordForm button[type=submit]").click();
  assert.equal(
    await page.locator("#passwordForm fieldset").evaluate((e) => e.disabled),
    true,
  );
  await contains("#passwordMessage", "موفقیت");
  await page.unroute("**/api/auth/password");
  for (const id of [
    "passwordCurrentPassword",
    "securityNewPassword",
    "securityConfirmPassword",
  ])
    assert.equal(await page.locator("#" + id).inputValue(), "");
  // Subsequent settings requests and reload use the renewed token.
  await open("members");
  await page.locator("#settingsMembersTable").waitFor({ state: "visible" });
  await page.reload();
  await ready();
  await open("security");
  const newLogin = await context.request.post(base + "/api/login", {
    data: {
      username: "customers-test",
      password: "secure browser passphrase",
    },
  });
  assert.equal(newLogin.status(), 200);
  // Exercise the Security section's retry after the page-level session check.
  await page.goto(base + "/page/settings-page.html#general");
  await page.reload();
  await ready();
  await page.route("**/api/auth/me", (route) => route.abort());
  await open("security");
  await page.locator("#securityRetry").waitFor({ state: "visible" });
  await page.unroute("**/api/auth/me");
  await page.locator("#securityRetry").click();
  await page.waitForFunction(
    () => !document.querySelector("#passwordForm fieldset").disabled,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/karbon-settings-security-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  // Actual logout and login through the existing login UI.
  await page.locator("#logoutButton").click();
  await page.waitForURL("**/login-page.html");
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("secure browser passphrase");
  await page.locator("button[type=submit]").click();
  await page.waitForURL("**/index.html");
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${sections.length} sections at 5 widths; existing settings CRUD; security validation, session rotation, reload, retry and subsequent login.`,
  );
} catch (error) {
  await page.screenshot({
    path: "/tmp/karbon-settings-failure.png",
    fullPage: true,
    animations: "disabled",
  });
  console.error(error);
  console.error(
    "Browser errors:",
    errors,
    "Alerts:",
    await page.locator("[role=alert]:visible").allTextContents(),
  );
  throw error;
} finally {
  await page.unrouteAll({ behavior: "wait" });
  await browser.close();
}

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
  await page.locator(`[data-settings-target="${section}"]`).click();
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
  // Every original tool remains reachable at phone, tablet, laptop and desktop widths.
  const sections = [
    "general",
    "members",
    "banks",
    "expenses",
    "document-accounts",
    "products",
    "inventory",
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
  await page.setViewportSize({ width: 1440, height: 1050 });
  await open("general");
  await page.screenshot({
    path: "/tmp/karbon-settings-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  // Overview shortcuts and deep links.
  await page.locator('[data-open-settings-section="members"]').click();
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
    await page.locator(`#inventory-${kind}-name`).fill(name);
    await submit(
      `#inventory-${kind}-form button`,
      "/settings/inventory-options/",
    );
    await contains(`#inventory-${kind}-list`, name);
  }
  await page.locator("#inventory-units-list button").click();
  await page.locator("#inventory-units-list button").getByText("فعال کردن", { exact: true }).waitFor();
  await page.locator("#inventory-units-list button").click();
  await page.locator("#inventory-units-list button").getByText("غیرفعال کردن", { exact: true }).waitFor();
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
    await page.locator(cfg.name).fill(cfg.title);
    if (cfg.section === "products") {
      await page.locator("#settingsProductUnit").fill("عدد");
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
  await page.locator("#securityNewPassword").fill("short7!");
  await page.locator("#securityConfirmPassword").fill("short7!");
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
  const shortLogin = await context.request.post(base + "/api/login", {
    data: { username: "customers-test", password: "short7!" },
  });
  assert.equal(shortLogin.status(), 200);
  const old = await context.request.get(base + "/api/auth/me", {
    headers: { Authorization: "Bearer " + original },
  });
  assert.equal(old.status(), 401);
  await page.locator("#passwordCurrentPassword").fill("short7!");
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
  // Offline feedback retains credentials and retry recovers.
  await page.route("**/api/auth/me", (route) => route.abort());
  await page.reload();
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
    "PASS: 12 sections at 5 widths; existing settings CRUD; security validation, session rotation, reload, retry and subsequent login.",
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

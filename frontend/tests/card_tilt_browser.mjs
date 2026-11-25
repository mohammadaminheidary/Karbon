// Run against the disposable fixture with --customers 8 --orders --members 3 --bank-ledger 6.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5539";
const options = {
  headless: true,
  executablePath: process.env.KARBON_CHROME_PATH,
  viewport: { width: 1440, height: 1050 },
};
const profile = await mkdtemp(join(tmpdir(), "karbon-card-tilt-"));
let context;
let page;

async function open(path) {
  await page.goto(base + path);
  await page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
}

async function authenticate(token) {
  await open("/page/login-page.html");
  await page.evaluate((token) => {
    localStorage.setItem("karbon_auth", JSON.stringify({ token }));
  }, token);
}

const nextPaint = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );

async function point(selector, x = 0.3, y = 0.4) {
  const card = page.locator(selector).first();
  await card.scrollIntoViewIfNeeded();
  await nextPaint();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  return card;
}

async function tilted(selector) {
  const card = await point(selector);
  await page.waitForFunction(
    (selector) => {
      const card = document.querySelector(selector);
      const surface = card.querySelector(":scope > .card-tilt-surface") || card;
      return (
        card.hasAttribute("data-tilted") &&
        getComputedStyle(surface).transform.startsWith("matrix3d(") &&
        Number(getComputedStyle(surface, "::after").opacity) > 0
      );
    },
    selector,
    { timeout: 5000 },
  );
  return card;
}

async function flat(selector) {
  const card = await point(selector);
  await nextPaint();
  assert.equal(await card.getAttribute("data-tilted"), null, selector);
  assert.equal(
    await card.evaluate((card) => {
      const surface = card.querySelector(":scope > .card-tilt-surface") || card;
      return getComputedStyle(surface).transform;
    }),
    "none",
    selector,
  );
}

const appearancePath = "/page/settings-page.html#appearance";
const toggle = (id) => page.locator(`label:has(#appearance-card-tilt-${id})`);
const checked = (id) => page.locator(`#appearance-card-tilt-${id}`).isChecked();
async function revealCardTiltSections() {
  const more = page.locator("#appearanceCardTiltMore");
  if (!(await more.evaluate((summary) => summary.parentElement.open))) await more.click();
}

try {
  context = await chromium.launchPersistentContext(profile, options);
  page = context.pages()[0];
  const response = await context.request.post(base + "/api/login", {
    data: { username: "customers-test", password: "test-password" },
  });
  assert.equal(response.status(), 200);
  const { token } = await response.json();
  const headers = { Authorization: `Bearer ${token}` };
  async function api(path, data) {
    const response = await context.request.fetch(base + "/api" + path, {
      method: data ? "POST" : "GET",
      headers,
      data,
    });
    if (!response.ok()) assert.fail(`${path}: ${await response.text()}`);
    return response;
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
  }).format(new Date());
  const jalali = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const customers = await (await api("/customers?limit=1")).json();
  const [product] = await (await api("/products")).json();
  const [bank] = await (await api("/banks")).json();
  const documentAccount = await (
    await api("/settings/document-accounts", {
      title: `آزمون سه‌بعدی ${crypto.randomUUID()}`,
      kind: "income",
    })
  ).json();
  await api("/orders", {
    request_id: crypto.randomUUID(),
    customer_id: customers.items[0].id,
    invoice_date: jalali,
    payment_date: jalali,
    discount: 0,
    payments: [],
    items: [{ product_id: product.id, quantity: 1, unit_price: 1000 }],
  });
  await api("/documents", {
    request_id: crypto.randomUUID(),
    date: today,
    description: "آزمون سه‌بعدی",
    rows: [
      {
        kind: "income",
        bank_id: bank.id,
        document_account_id: documentAccount.id,
        amount: 1000,
      },
    ],
  });
  const task = await (
    await api("/tasks", { date: today, title: "آزمون سه‌بعدی" })
  ).json();
  await api("/reports/customers/export/xlsx", { report_name: "آزمون سه‌بعدی" });
  const {
    items: [report],
  } = await (await api("/reports/history?limit=1")).json();

  await authenticate(token);
  const customerCard = ".card-tilt:has(> [data-customer-id])";
  const documentCard = ".card-tilt:has(> [data-document-id])";
  const settingsCard = '[data-open-settings-section="appearance"]';
  const productCard = "#settingsProductsList [data-product-id]";
  const sections = [
    ["dashboard", "/index.html", '[data-widget="net"]'],
    ["customers", "/page/customers-page.html", customerCard],
    ["warehouse", "/page/warehouse-page.html", ".warehouse-stat"],
    ["products", "/page/settings-page.html#products", productCard],
    ["orders", "/page/orders-page.html", ".orders-record"],
    ["finance", "/page/finance-page.html", "#financeSummary article"],
    ["attendance", "/page/attendance-page.html", "[data-member-id]"],
    ["daily-tasks", "/page/daily-tasks-page.html", `#task-card-${task.id}`],
    ["documents", "/page/documents-page.html", documentCard],
    ["banks", "/page/banks-page.html", ".bank-account"],
    [
      "bank-transactions",
      `/page/bank-transactions-page.html?bank=${bank.id}`,
      "section:has(#bankChart)",
    ],
    ["reports", "/page/reports-page.html", ".report-history-entry"],
    [
      "report-details",
      `/page/report-details-page.html?id=${report.id}`,
      "#reportDetails",
    ],
    ["settings", "/page/settings-page.html#general", settingsCard],
    ["login", "/page/login-page.html", "#loginForm"],
  ];
  await open(appearancePath);
  const bulkToggle = page.locator("#appearanceCardTiltAll");
  const sectionList = page.locator("#appearanceCardTiltList");
  assert.equal(await sectionList.isVisible(), false);
  await bulkToggle.click();
  assert.equal(await bulkToggle.textContent(), "روشن کردن همه");
  await open("/page/customers-page.html");
  await flat(customerCard);
  await open(appearancePath);
  await revealCardTiltSections();
  assert.equal(await sectionList.isVisible(), true);
  assert.equal(await sectionList.locator("[role=switch]:checked").count(), 0);
  await bulkToggle.click();
  assert.equal(await bulkToggle.textContent(), "خاموش کردن همه");
  assert.equal(await sectionList.locator("[role=switch]:checked").count(), sections.length);
  assert.equal(
    await page.locator("#appearanceCardTiltList [role=switch]").count(),
    sections.length,
  );

  for (const [id, path, selector] of sections) {
    await open(path);
    await tilted(selector);
    console.log(`Tilt and reflection: ${id}`);
  }

  await open("/page/customers-page.html");
  const card = await tilted(customerCard);
  const readPose = () =>
    card.evaluate((card) => {
      const face = card.querySelector(".card-tilt-surface");
      return [
        face.style.getPropertyValue("--card-tilt-y"),
        face.style.getPropertyValue("--card-light-x"),
      ].map(parseFloat);
    });
  const [leftAngle, leftLight] = await readPose();
  await point(customerCard, 0.7);
  await page.waitForFunction(
    (selector) =>
      parseFloat(
        document
          .querySelector(`${selector} > .card-tilt-surface`)
          .style.getPropertyValue("--card-light-x"),
      ) > 60,
    customerCard,
  );
  const [rightAngle, rightLight] = await readPose();
  assert.ok(leftAngle > rightAngle);
  assert.ok(leftLight < rightLight);
  await page.mouse.move(0, 0);
  await page.waitForFunction((selector) => {
    const face = document.querySelector(`${selector} > .card-tilt-surface`);
    return (
      getComputedStyle(face).transform === "none" &&
      getComputedStyle(face, "::after").opacity === "0"
    );
  }, customerCard);

  await tilted(customerCard);
  await card.locator("button").click();
  await page.locator("#customerDetailsModal[aria-hidden=false]").waitFor();

  await open("/page/documents-page.html");
  await (await tilted(documentCard)).locator("button").press("Enter");
  await page.locator("#documentDetailsModal[aria-hidden=false]").waitFor();

  await open("/page/orders-page.html");
  await (await tilted(".orders-record")).locator(".orders-card-open").click();
  await page.locator("#orderDetailsModal[aria-hidden=false]").waitFor();

  await open("/page/daily-tasks-page.html");
  const taskCard = await tilted(`#task-card-${task.id}`);
  await taskCard.dragTo(
    page.locator('.tasks-column[data-status="in_progress"]'),
    {
      targetPosition: { x: 30, y: 70 },
    },
  );
  await page
    .locator(`#in_progressTasks #task-card-${task.id}[aria-busy="false"]`)
    .waitFor();
  assert.equal(await taskCard.getAttribute("data-tilted"), null);
  await taskCard.press("Enter");
  await page.locator("#taskDetails[aria-hidden=false]").waitFor();

  await open("/page/settings-page.html#products");
  await (
    await tilted(productCard)
  )
    .getByRole("button", { name: "ویرایش", exact: true })
    .click();
  await page.locator("#productFormModal[aria-hidden=false]").waitFor();

  await open("/page/banks-page.html");
  const bankCard = await tilted(".bank-account");
  await bankCard.click();
  await page.waitForURL("**/bank-transactions-page.html?bank=*");

  await open("/page/reports-page.html");
  const historyCard = await tilted(".report-history-entry");
  await historyCard.locator(".report-card-link").click();
  await page.waitForURL("**/report-details-page.html?id=*");

  await open("/index.html");
  await page.locator("#editDashboardLayout").click();
  await page.locator('#dashboardGrid[data-editing="true"]').waitFor();
  await flat('[data-widget="net"]');

  for (const [id, path, selector] of sections) {
    await open(appearancePath);
    await revealCardTiltSections();
    await toggle(id).click();
    assert.equal(await checked(id), false);
    await open(path);
    await flat(selector);
    await open(appearancePath);
    await revealCardTiltSections();
    await toggle(id).click();
    assert.equal(await checked(id), true);
  }

  await open(appearancePath);
  await revealCardTiltSections();
  await page.locator("#appearance-card-tilt-customers").focus();
  await page.keyboard.press("Space");
  assert.equal(await checked("customers"), false);
  assert.equal(await checked("warehouse"), true);
  assert.equal(await checked("products"), true);
  await toggle("settings").click();
  await flat(".appearance-preview");
  await open("/page/settings-page.html#products");
  await tilted(productCard);
  await open(appearancePath);
  await revealCardTiltSections();
  await toggle("settings").click();
  await toggle("products").click();
  await open("/page/settings-page.html#products");
  await flat(productCard);
  await open("/page/settings-page.html#general");
  await tilted(settingsCard);

  await open("/page/customers-page.html");
  await flat(customerCard);
  await open("/page/warehouse-page.html");
  await tilted(".warehouse-stat");
  await context.close();

  context = await chromium.launchPersistentContext(profile, options);
  page = context.pages()[0];
  await open(appearancePath);
  assert.equal(await checked("customers"), false);
  assert.equal(await checked("products"), false);
  assert.equal(await checked("settings"), true);
  await open("/page/customers-page.html");
  await flat(customerCard);
  await open("/page/warehouse-page.html");
  await tilted(".warehouse-stat");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await flat(".warehouse-stat");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const browser = await chromium.launch({
    headless: options.headless,
    executablePath: options.executablePath,
  });
  try {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    page = await mobile.newPage();
    await authenticate(token);
    await open(appearancePath);
    await revealCardTiltSections();
    await toggle("banks").tap();
    assert.equal(await checked("banks"), false);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await open("/page/customers-page.html");
    const button = page.locator("[data-customer-id]").first();
    await button.tap();
    await page.locator("#customerDetailsModal[aria-hidden=false]").waitFor();
    assert.equal(await page.locator("[data-tilted]").count(), 0);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  } finally {
    await browser.close();
  }
  console.log(
    "Card interactions, independent preferences, browser restart, reduced motion, and touch passed.",
  );
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}

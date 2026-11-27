import { clickSettingsSection } from "./settings_navigation.mjs";
// Run with run_fiscal_year_browser.py against a disposable database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { readDate } from "./date-input-helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL;
const year = Number(process.env.KARBON_FISCAL_TEST_YEAR);
const next = year + 1;
const customer = Number(process.env.KARBON_FISCAL_TEST_CUSTOMER);
const order = Number(process.env.KARBON_FISCAL_TEST_ORDER);
const bank = process.env.KARBON_FISCAL_TEST_BANK;
const token = process.env.KARBON_FISCAL_TEST_TOKEN;
const fmt = new Intl.NumberFormat("fa-IR");
const label = (value) => fmt.format(value).replace("٬", "");
const settings = "/page/settings-page.html";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH ? { executablePath: process.env.KARBON_CHROME_PATH } : {}),
});

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.addInitScript((value) => localStorage.setItem("karbon_auth", JSON.stringify({ token: value })), token);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const go = (path) => page.goto(base + path);
  const ready = () => page.waitForFunction(() => document.documentElement.dataset.pageState === "ready");
  const text = (selector, value) => page.locator(selector).getByText(value, { exact: false }).first().waitFor();
  const digest = async (name, host = page) => {
    const [download] = await Promise.all([page.waitForEvent("download"), host.getByRole("button", { name, exact: true }).click()]);
    assert.match(download.suggestedFilename(), new RegExp(`^karbon-${year}-`));
    return readFile(await download.path());
  };
  const api = async (path) => {
    const response = await context.request.get(base + "/api" + path, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  await go(settings);
  await ready();
  await clickSettingsSection(page, "fiscal-year");
  async function closeYear() {
    await text("#fiscalActive", `سال مالی فعال ${label(year)}`);
    await page.getByRole("button", { name: "بستن سال مالی", exact: true }).click();
    await text("#fiscalPreviewData", fmt.format(3_000_000));
    await page.locator("#fiscalPassphrase").fill(process.env.KARBON_FISCAL_TEST_PASSPHRASE);
    await page.locator("#fiscalConfirmation").check();
    await page.getByRole("button", { name: "تأیید و بستن سال", exact: true }).click();
    await text("#fiscalActive", `سال مالی فعال ${label(next)}`);
    await page.getByRole("button", { name: "گزارش جامع PDF", exact: true }).waitFor({ timeout: 60000 });
  }
  await closeYear();
  const names = ["گزارش جامع PDF", "مانده‌های انتقالی PDF", "داده‌های سال ZIP"];
  const originalZip = await digest(names[2]);
  const reopen = page.getByRole("button", { name: "بازگشایی سال مالی", exact: true });
  page.once("dialog", (dialog) => dialog.dismiss());
  await reopen.click();
  await text("#fiscalActive", `سال مالی فعال ${label(next)}`);
  page.once("dialog", (dialog) => dialog.accept());
  await reopen.click();
  await text("#fiscalActive", `سال مالی فعال ${label(year)}`);
  assert.equal((await api("/orders")).items[0].id, order);
  assert.deepEqual(await digest(names[2]), originalZip);
  await closeYear();
  const older = page.locator("#fiscalYearsList details").filter({ hasText: "نسخه‌های پیشین بستن سال" });
  await older.locator("summary").click();
  assert.deepEqual(await digest(names[2], older), originalZip);
  await older.locator("summary").click();
  const outputs = [];
  for (const name of names) outputs.push(await digest(name));
  assert.equal(outputs[0].subarray(0, 4).toString(), "%PDF");
  assert.equal(outputs[1].subarray(0, 4).toString(), "%PDF");
  assert.equal(outputs[2].subarray(0, 2).toString(), "PK");
  await page.getByRole("link", { name: "مشاهدهٔ سال", exact: true }).click();
  await text("#fiscalArchiveTitle", "فقط خواندنی");
  await page.locator("#fiscalSearch").fill("BROWSER-ORDER");
  await page.locator("#fiscalSearchForm button").click();
  await text("#fiscalRecords", "BROWSER-ORDER");
  await page.locator("#fiscalRecords").getByRole("button", { name: "مشاهده", exact: true }).click();
  await text("#orderDetailsContent", "کالای آزمایشی کاربن");
  await text("#orderDetailsContent", fmt.format(3_000_000));
  await page.locator("#orderDetailsModal header [data-dialog-close]").click();
  await page.locator("#fiscalRecordKind").selectOption("invoices");
  await text("#fiscalRecords", "BROWSER-ORDER");
  await page.locator("#fiscalRecords").getByRole("button", { name: "مشاهده", exact: true }).click();
  await text("#orderDetailsContent", fmt.format(3_000_000));
  await page.locator("#orderDetailsModal header [data-dialog-close]").click();
  await page.locator("#fiscalSearch").clear();
  await page.locator("#fiscalRecordKind").selectOption("customers");
  await text("#fiscalRecords", "مانده مرورگر");
  await page.locator("#fiscalRecords").getByRole("button", { name: "مشاهده", exact: true }).click();
  await text("#fiscalRecordDetails", "صورتحساب");
  await text("#fiscalRecordDetails", fmt.format(3_000_000));
  await page.locator("#fiscalRecordKind").selectOption("transactions");
  await text("#fiscalRecords", "مانده مرورگر");
  await page.locator("#fiscalRecords").getByRole("button", { name: "مشاهده", exact: true }).click();
  await text("#fiscalRecordDetails", fmt.format(7_000_000));
  await page.getByRole("link", { name: "بازگشت به سال جاری" }).click();
  await text("#fiscalActive", `سال مالی فعال ${label(next)}`);
  await go("/index.html");
  await text(".dash-sync", `سال مالی ${label(next)}`);
  assert.equal(await page.locator("#revenueValue").textContent(), fmt.format(0));
  await text("#dashboardBankNote", fmt.format(12_000_000));

  async function openCustomer() {
    await go("/page/customers-page.html");
    await ready();
    await page.locator(`[data-customer-id="${customer}"]`).click();
    const carryover = page.locator("#customerDetailsBody section", { hasText: "فاکتورهای انتقالی" });
    const invoice = carryover.locator("details");
    await invoice.locator("summary").click();
    return invoice;
  }

  let invoice = await openCustomer();
  const href = await invoice.getByRole("link", { name: "مشاهدهٔ سفارش اصلی" }).getAttribute("href");
  assert.match(href, new RegExp(`fiscal_year=${year}.*record=${order}`));
  await invoice.getByRole("link", { name: "مشاهدهٔ سفارش اصلی" }).click();
  await text("#orderDetailsContent", "کالای آزمایشی کاربن");
  invoice = await openCustomer();
  await invoice.getByRole("link", { name: "مشاهدهٔ فاکتور اصلی" }).click();
  await text("#orderDetailsContent", "کالای آزمایشی کاربن");
  await text("#orderDetailsContent", fmt.format(3_000_000));
  invoice = await openCustomer();
  await invoice.getByRole("button", { name: "ثبت دریافت", exact: true }).click();
  await invoice.getByLabel("مبلغ دریافتی (تومان)").fill("1000000");
  await invoice.getByLabel("روش دریافت").selectOption("transfer");
  await invoice.getByLabel("حساب مقصد").selectOption(bank);
  await invoice.getByLabel("شماره پیگیری").fill("12345678");
  const receiptDateId = await invoice.locator("[data-date-input]").getAttribute("data-date-input");
  assert.equal(await readDate(invoice, receiptDateId), `${next}/01/01`);
  const [payment] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/orders/${order}/payments`)),
    invoice.getByRole("button", { name: "ثبت دریافت", exact: true }).click(),
  ]);
  assert.equal(payment.status(), 201, await payment.text());
  assert.equal((await payment.json()).outstanding, 2_000_000);
  await text("#customerFiscalCarryovers summary", fmt.format(2_000_000));
  await go("/page/finance-page.html");
  await text("#financeFiscalOpening", fmt.format(12_000_000));
  await text("#totalIncome", fmt.format(1_000_000));
  const old = await api(`/settings/fiscal-years/${year}/records/invoices/${order}`);
  assert.equal(old.remaining, 3_000_000);
  const fresh = await api("/dashboard");
  assert.equal(fresh.finance.income, "1000000");
  assert.equal(fresh.orders.sales, "0");
  await go(settings + "#fiscal-year");
  await text("#fiscalActive", `سال مالی فعال ${label(next)}`);
  assert.equal(await reopen.isDisabled(), true);
  await text("#fiscalYearsList", "سال بعد شروع شده و بازگشایی ممکن نیست");
  for (const [i, name] of names.entries()) assert.deepEqual(await digest(name), outputs[i]);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(errors, []);
  console.log("Fiscal-year UI reopened an unused year, closed it again, retained both archives, and blocked reopening after a receipt.");
} finally {
  await browser.close();
}

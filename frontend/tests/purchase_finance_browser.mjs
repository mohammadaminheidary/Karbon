// Run against a disposable fixture with --orders --finance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { advancePurchasePayment, closePurchaseInvoice, fillPurchaseRow, waitForPurchaseForm } from "./purchase-browser-helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5547";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.KARBON_CHROME_PATH ? { executablePath: process.env.KARBON_CHROME_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const ready = () => page.waitForFunction(() => document.documentElement.dataset.pageState === "ready");
const get = (path) => page.evaluate(async (url) => {
  const { financeRequest } = await import("/src/js/finance/finance-api.js");
  return financeRequest(url, { cache: "no-store" });
}, path);
const waitText = (selector, value) => page.waitForFunction(
  ({ selector, value }) => document.querySelector(selector)?.textContent.includes(value), { selector, value });
const change = (method, path) => page.waitForResponse((response) =>
  response.url().endsWith(`/api${path}`) && response.request().method() === method);
const amount = (scope, value) => scope.locator("[data-payment-amount]").fill(String(value));

try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator("button[type=submit]").click();
  await page.waitForURL("**/index.html");
  await ready();
  const availableBanks = (await get("/banks")).filter((bank) => bank.active && !bank.is_cash);
  const [initialBank, secondBank = initialBank] = availableBanks;
  const supplier = (await get("/customers/options")).items.find((entry) => !entry.is_system);
  const item = (await get("/inventory/products")).find((product) => product.name === "چاپ کارت");

  await page.goto(`${base}/page/warehouse-page.html`);
  await ready();
  await page.locator("#buyItemsButton").click();
  await waitForPurchaseForm(page);
  if (supplier) {
    await page.locator("#orderCustomerSearch").fill(String(supplier.customer_code));
    await page.locator("#orderCustomerOptions").getByRole("option").filter({ hasText: String(supplier.customer_code) }).click();
    await page.locator("#orderCustomerDetails").waitFor();
  }
  await fillPurchaseRow(page, item, 3, 1000);
  await page.locator("#orderDiscount").fill("200");
  await advancePurchasePayment(page);
  await waitText("#paymentState", "پرداخت‌نشده");
  await page.locator("#pay-pos-bank").selectOption(String(initialBank.id));
  await page.locator("#pay-pos-amount").fill("600");
  await waitText("#paymentState", "پرداخت جزئی");
  await page.locator("#addPaymentAccount").click();
  await page.locator("#pay-transfer-1-bank").selectOption(String(secondBank.id));
  await page.locator("#pay-transfer-1-amount").fill("200");
  await page.locator("#addPaymentAccount").click();
  await page.locator("#pay-transfer-2-fields").locator("..").getByRole("button", { name: "حذف این حساب" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#paymentMethods").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const firstSave = change("POST", "/purchases");
  await page.locator("#finalizeOrder").click();
  const response = await firstSave;
  assert.equal(response.status(), 201, await response.text());
  const receipt = await response.json();
  assert.deepEqual([receipt.subtotal, receipt.discount, receipt.total, receipt.paid, receipt.remaining],
    [3000, 200, 2800, 800, 2000]);
  assert.equal(receipt.supplier_id, supplier?.id ?? null);
  assert.deepEqual(receipt.payments.map((entry) => entry.bank_id), [initialBank.id, secondBank.id]);
  assert.equal((await get("/inventory/products")).find((product) => product.id === item.id).stock, item.stock + 3);
  const balances = new Map((await get("/banks")).map((bank) => [bank.id, bank.balance]));
  for (const bank of [initialBank, secondBank]) {
    const deduction = receipt.payments.filter((entry) => entry.bank_id === bank.id).reduce((sum, entry) => sum + entry.amount, 0);
    assert.equal(balances.get(bank.id), bank.balance - deduction);
  }

  await closePurchaseInvoice(page);
  await page.getByRole("link", { name: "فاکتورهای خرید" }).click();
  await page.locator("#settingsInvoicesList article").filter({ hasText: receipt.invoice_number })
    .getByRole("button", { name: "نمایش فاکتور خرید" }).click();
  await waitText("#purchaseDetailContent", receipt.invoice_number);
  await page.locator("#purchaseDetailAddPayment").click();
  const editor = page.locator("#purchaseDetailEditor");
  await editor.locator("[data-payment-bank]").selectOption("cash");
  await amount(editor, 2000);
  const laterSave = change("POST", `/purchases/${receipt.id}/payments`);
  await page.locator("#savePurchasePayment").click();
  const laterResponse = await laterSave;
  assert.equal(laterResponse.status(), 201, await laterResponse.text());
  const later = await laterResponse.json();
  await waitText("#purchaseDetailContent", "تسویه‌شده");
  const payment = page.locator(`[data-purchase-payment-id="${later.id}"]`);
  await payment.getByRole("button", { name: "ویرایش پرداخت" }).click();
  await amount(editor, 1900);
  await page.locator("#savePurchasePayment").click();
  await waitText("#purchaseDetailContent", "پرداخت جزئی");
  await payment.getByRole("button", { name: "حذف پرداخت" }).click();
  await page.locator("#financeDeletePassword").fill("test-password");
  await page.locator("#financeDeleteSubmit").click();
  await payment.waitFor({ state: "detached" });
  assert.equal((await get(`/purchases/${receipt.id}`)).remaining, 2000);

  await page.goto(`${base}/page/finance-page.html`);
  await ready();
  await page.getByRole("button", { name: `فاکتور خرید ${receipt.invoice_number}` }).first().click();
  await waitText("#purchaseDetailContent", receipt.invoice_number);
  assert.ok(await page.locator("#purchaseDetailContent").getByText(initialBank.name, { exact: false }).count());
  await page.goto(`${base}/page/bank-transactions-page.html?bank=${initialBank.id}`);
  await ready();
  await page.getByRole("button", { name: `فاکتور خرید ${receipt.invoice_number}` }).first().click();
  await waitText("#purchaseDetailContent", receipt.invoice_number);
  await page.goto(`${base}/index.html`);
  await ready();
  await page.locator("#dashboardPurchaseExpenses").click();
  await page.locator("#purchaseExpensesList").getByRole("button", { name: `فاکتور ${receipt.invoice_number}` }).first().click();
  await waitText("#purchaseDetailContent", receipt.invoice_number);
  await page.locator("#purchaseDetailsModal [data-dialog-close]").click();
  await page.locator("#purchaseExpensesModal [data-dialog-close]").click();
  await page.locator("#dashboardPurchaseObligations").click();
  await page.locator("#purchaseObligationsList").getByRole("button", { name: `فاکتور ${receipt.invoice_number}` }).click();
  await waitText("#purchaseDetailContent", receipt.invoice_number);
  assert.deepEqual(errors, []);
  console.log("Purchase payment form, bank and expense links, partial settlement, edit, deletion and dashboard obligations verified");
} finally {
  await browser.close();
}

// Run against serve_customers_fixture.py --invoice-designer on a disposable database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5501";
const settings = "/page/settings-page.html#backup";
const api = "/api/settings/backup";
const passphrase = "disposable backup passphrase";
const browser = await chromium.launch({ headless: true, executablePath: process.env.KARBON_CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await context.newPage();
const reminder = page.locator("#backupReminderDialog");
const ready = () => page.locator('html[data-page-state="ready"]').waitFor();

async function login() {
  await page.locator("#username").fill("admin");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator('#loginForm button[type="submit"]').click();
  await page.waitForURL("**/index.html");
  await ready();
}

async function changeReminder(enabled, hours) {
  await page.locator("#backupReminderEnabled").setChecked(enabled);
  await page.locator("#backupReminderHours").fill(hours);
  await page.locator('#backupReminderForm button[type="submit"]').click();
  await page.locator('#backupReminderStatus[data-type="success"]').waitFor();
}

function nextConfirmation(accept, pattern) {
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), pattern);
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
}

try {
  const forceDue = async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, reminder_due: true, last_backup_at: "2024-01-01T00:00:00Z" } });
  };
  await page.route(`**${api}/status`, forceDue);
  await page.goto(`${base}/page/login-page.html`);
  await login();
  await reminder.waitFor();
  assert.match(await reminder.textContent(), /یک روز از آخرین پشتیبان‌گیری شما گذشته است/);
  const { x, y, width, height } = await reminder.boundingBox();
  assert.ok(Math.abs(x + width / 2 - 195) < 2 && Math.abs(y + height / 2 - 400) < 2);
  await reminder.getByRole("button", { name: "بعداً" }).click();
  await reminder.waitFor({ state: "detached" });
  await page.getByRole("link", { name: "مشتریان", exact: true }).click();
  await ready();
  assert.equal(await reminder.count(), 0);
  await page.reload();
  await ready();
  assert.equal(await reminder.count(), 0);

  await page.goto(`${base}/page/login-page.html`);
  await login();
  await reminder.getByRole("button", { name: "تهیه بکاپ" }).click();
  await page.waitForURL(`**${settings}`);
  await page.unroute(`**${api}/status`, forceDue);
  await ready();
  await changeReminder(false, "۴۸");
  await page.evaluate(() => window.KarbonAppearance.updatePreferences({ theme: "red" }));
  await page.locator("#backupCreatePassphrase").fill(passphrase);
  await page.getByRole("button", { name: "تهیه بکاپ جدید" }).click();
  await page.locator('#backupCreateStatus[data-type="success"]').waitFor();
  const row = page.locator("#backupList li").first();
  const name = await row.locator("bdi").textContent();
  const createdAt = await page.locator("#backupLastSuccess").getAttribute("datetime");
  assert.ok(createdAt);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem("karbon_auth")).token);
  const download = await context.request.get(`${base}${api}/download/${name}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(download.status(), 200);

  await changeReminder(true, "12");
  await page.evaluate(() => window.KarbonAppearance.updatePreferences({ theme: "green" }));
  await row.getByRole("button", { name: /انتخاب/ }).click();
  await page.locator("#backupUploadPassphrase").fill(passphrase);
  await page.getByRole("button", { name: "بررسی فایل پشتیبان" }).click();
  const restore = page.getByRole("button", { name: "بازیابی بکاپ", exact: true });
  await restore.waitFor();
  nextConfirmation(false, /اطلاعات و تنظیمات فعلی/);
  await restore.click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "green");

  await page.locator("#backupUploadFile").setInputFiles({ name, mimeType: "application/zip", buffer: await download.body() });
  await page.locator("#backupUploadPassphrase").fill(passphrase);
  await page.getByRole("button", { name: "بررسی فایل پشتیبان" }).click();
  await restore.waitFor();
  nextConfirmation(true, /اطلاعات و تنظیمات فعلی/);
  await restore.click();
  await page.waitForURL((url) => url.pathname === "/page/login-page.html");
  await page.getByText(/بازیابی تکمیل شد/).first().waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "red");
  await login();
  await page.goto(`${base}${settings}`);
  await ready();
  assert.equal(await page.locator("#backupReminderEnabled").isChecked(), false);
  assert.equal(await page.locator("#backupReminderHours").inputValue(), "48");
  assert.equal(await page.locator("#backupLastSuccess").getAttribute("datetime"), createdAt);

  const original = page.locator("#backupList li").filter({ hasText: name });
  const remove = original.getByRole("button", { name: /حذف/ });
  nextConfirmation(false, /برای همیشه حذف شود/);
  await remove.click();
  assert.equal(await original.count(), 1);
  nextConfirmation(true, /برای همیشه حذف شود/);
  await remove.click();
  await original.waitFor({ state: "detached" });
  assert.equal(await page.locator("#backupLastSuccess").getAttribute("datetime"), createdAt);
  console.log("PASS: reminder visits, local and imported archive validation, restore and confirmed deletion");
} finally {
  await browser.close();
}

// Run against the disposable browser fixture with --factory-reset --customers 2.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5501";
const browser = await chromium.launch({ headless: true, executablePath: process.env.KARBON_CHROME_PATH });
const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
const page = await context.newPage();

async function login(password) {
  await page.locator("#username").fill("admin");
  await page.locator("#passwordInput").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/index.html");
}

try {
  await page.goto(`${base}/page/login-page.html`);
  await login("test-password");
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem("karbon_auth")).token);
  const before = await context.request.get(`${base}/api/customers`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await before.json()).total_customers, 2);
  await page.evaluate(() => localStorage.setItem("karbon_appearance", "{}"));
  const secondTab = await context.newPage();
  await secondTab.goto(`${base}/page/customers-page.html`);
  await secondTab.locator('html[data-auth-state="authenticated"]').waitFor();
  await secondTab.evaluate(() => sessionStorage.setItem("karbon-pending-reset-test", "old data"));

  await page.goto(`${base}/page/settings-page.html`);
  await page.getByRole("button", { name: "ریست کردن نرم‌افزار و داده‌ها" }).click();
  await page.locator("#factoryResetRequest").click();
  await page.locator('img#factoryResetImage[src^="data:image/png"]').waitFor();
  await page.locator("#factoryResetCurrent").fill("test-password");
  assert.equal(await page.locator("#factoryResetNew, #factoryResetRepeated").count(), 0);
  await page.locator("#factoryResetCaptcha").fill("AAAAAA");
  await page.locator("#factoryResetConfirmation").fill("ریست داده‌های کاری");
  await page.locator("#factoryResetAcknowledge").check();
  const reset = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/factory-reset");
  await page.locator("#factoryResetSubmit").click();
  assert.equal((await reset).status(), 200);
  await Promise.all([page.waitForURL("**/page/login-page.html"), secondTab.waitForURL("**/page/login-page.html")]);
  assert.equal(await page.evaluate(() => localStorage.getItem("karbon_appearance")), "{}");
  assert.equal(await secondTab.evaluate(() => sessionStorage.getItem("karbon-pending-reset-test")), null);
  const revoked = await context.request.get(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(revoked.status(), 401);
  await login("test-password");
  const newToken = await page.evaluate(() => JSON.parse(localStorage.getItem("karbon_auth")).token);
  const after = await context.request.get(`${base}/api/customers`, { headers: { Authorization: `Bearer ${newToken}` } });
  assert.equal((await after.json()).total_customers, 0);
  console.log("PASS: reset retains preferences and password, clears customers and invalidates old sessions");
} finally {
  await browser.close();
}

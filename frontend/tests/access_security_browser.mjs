// Run only against serve_customers_fixture.py (never the live database).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright-core");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5540";
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.KARBON_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const paths = ["/index.html", ...fs.readdirSync(new URL("../page/", import.meta.url))
  .filter(name => name.endsWith(".html") && name !== "login-page.html").map(name => "/page/" + name)];
const ready = page => page.waitForFunction(() => document.documentElement.dataset.pageState === "ready");
try {
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const shell = await noScript.newPage();
  for (const path of paths) {
    await shell.goto(base + path);
    assert.equal(await shell.locator("#mainNavbar").isVisible(), false, path);
  }
  await noScript.close();
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of paths) {
    await page.goto(base + path);
    await page.waitForURL("**/page/login-page.html");
    await ready(page);
  }
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/index.html");
  await ready(page);
  assert.equal(await page.locator("#dashboardContent").isVisible(), true);
  const valid = await page.evaluate(() => JSON.parse(localStorage.getItem("karbon_auth")).token);
  for (const path of paths) {
    await page.goto(base + path);
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.authState), "authenticated", path);
    assert.equal(await page.locator("#mainNavbar").isVisible(), true, path);
  }
  await page.reload();
  await ready(page);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.authState), "authenticated");
  const recovery = await context.newPage();
  await recovery.route("**/api/auth/me", route => route.fulfill({ status: 503, contentType: "application/json", body: '{}' }));
  await recovery.goto(base + "/index.html");
  await recovery.locator("#pageStartupError").waitFor({ state: "visible" });
  assert.equal(await recovery.locator("#dashboardContent").isVisible(), false);
  assert.equal(await recovery.evaluate(() => Boolean(localStorage.getItem("karbon_auth"))), true);
  await recovery.unroute("**/api/auth/me");
  await recovery.locator("#retryPageStartup").click();
  await ready(recovery);
  assert.equal(await recovery.locator("#dashboardContent").isVisible(), true);
  await recovery.close();
  const other = await context.newPage();
  await other.goto(base + "/index.html");
  await ready(other);
  await page.locator("#logoutButton").click();
  await page.waitForURL("**/page/login-page.html");
  await other.waitForURL("**/page/login-page.html");
  await page.goBack();
  await page.waitForURL("**/page/login-page.html");
  for (const path of paths) {
    // A copied pre-logout token must fail server validation on every page.
    await page.evaluate(token => localStorage.setItem("karbon_auth", JSON.stringify({token})), valid);
    await page.goto(base + path);
    await page.waitForURL("**/page/login-page.html");
    await ready(page);
  }
  const expired = valid.split(".");
  const claims = JSON.parse(Buffer.from(expired[1], "base64url").toString());
  claims.exp = 1;
  expired[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
  await page.evaluate(token => localStorage.setItem("karbon_auth", JSON.stringify({token})), expired.join("."));
  await page.goto(base + "/index.html");
  await page.waitForURL("**/page/login-page.html");
  console.log(`PASS: ${paths.length} pages: unauthenticated direct URLs, valid navigation, refresh, logout, cross-tab logout, history, revoked and invalid expired tokens`);
} finally {
  await browser.close();
}

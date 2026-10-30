// Only use the disposable serve_customers_fixture.py environment.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KARBON_PLAYWRIGHT_PATH || "playwright");
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5532";
const browser = await chromium.launch({ headless: true,
  ...(process.env.KARBON_CHROME_PATH ? { executablePath: process.env.KARBON_CHROME_PATH } : {}) });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
let customer, token;
async function api(method, path, data) {
  const response = await page.request.fetch(`${base}/api${path}`, {
    method, data, headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok(), await response.text());
  return response.status() === 204 ? null : response.json();
}
async function assertCentered() {
  // Wait until the preserved scale animation has finished.
  await page.locator('#customerDeleteModal section').evaluate(async panel => {
    await Promise.all(panel.getAnimations().map(animation => animation.finished));
  });
  const geometry = await page.locator('#customerDeleteModal section').evaluate(panel => {
    const rect = panel.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      width: innerWidth, height: innerHeight };
  });
  assert.ok(Math.abs(geometry.x - geometry.width / 2) <= 1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.y - geometry.height / 2) <= 1, JSON.stringify(geometry));
}
try {
  const login = await page.request.post(`${base}/api/login`, {
    data: { username: "customers-test", password: "test-password" },
  });
  ({ token } = await login.json());
  customer = await api("POST", "/customers", { first_name: "آزمون", last_name: "جایگاه حذف" });
  await page.addInitScript(token => localStorage.setItem("karbon_auth", JSON.stringify({ token })), token);
  await page.goto(`${base}/page/customers-page.html`);
  await page.locator(`[data-customer-id="${customer.id}"]`).click();
  await page.waitForFunction(() => !document.getElementById("deleteCustomerButton").disabled);
  for (const [width, height] of [[1440, 1000], [1920, 1080], [768, 1024], [390, 844], [844, 390], [320, 568]]) {
    await page.setViewportSize({ width, height });
    await page.locator("#deleteCustomerButton").click();
    await page.locator("#customerDeleteModal.scale-100, #customerDeleteModal .scale-100").waitFor();
    await assertCentered();
    await page.locator("#confirmDeleteCustomerButton").click();
    await page.locator("#customerDeleteCountdownBox").waitFor({ state: "visible" });
    await assertCentered();
    assert.equal(await page.locator("#customerDeleteCountdown").count(), 0);
    const samples = await page.evaluate(async () => {
      const fill = document.getElementById("customerDeleteProgressFill");
      const track = document.getElementById("customerDeleteProgress");
      const values = [];
      const start = performance.now();
      while (performance.now() - start < 350) {
        await new Promise(requestAnimationFrame);
        const scale = Number(fill.style.transform.match(/scaleX\(([^)]+)\)/)[1]);
        values.push(scale);
        if (Math.abs(Number(track.getAttribute("aria-valuenow")) - scale * 100) > 1)
          throw new Error("Accessible progress disagrees with visual progress");
      }
      return values;
    });
    assert.ok(new Set(samples).size > 5, "bar must update continuously");
    assert.ok(samples.every((value, index) => value >= 0 && value <= 1 && (!index || value <= samples[index-1])));
    assert.ok(samples[0] - samples.at(-1) > 0.06, "bar must track elapsed time");
    const bar = await page.locator("#customerDeleteProgress").boundingBox();
    assert.ok(bar.width > 0 && bar.x >= 0 && bar.x + bar.width <= width);
    await page.locator("#cancelDeleteCustomerButton").click();
    await page.waitForFunction(() => !document.getElementById("customerDeleteModal").open);
  }
  assert.equal((await api("GET", `/customers/${customer.id}`)).id, customer.id);
  await page.locator("#deleteCustomerButton").click();
  const deletion = page.waitForResponse(response => response.request().method() === "DELETE");
  const start = await page.evaluate(() => {
    const now = performance.now();
    document.getElementById("confirmDeleteCustomerButton").click();
    return now;
  });
  // Check the actual remaining fraction after one second, independently of
  // the animation's frame count and of request/response delays.
  await page.waitForTimeout(1000);
  const timing = await page.evaluate(() => ({ now: performance.now(),
    scale: Number(document.getElementById("customerDeleteProgressFill").style.transform.match(/scaleX\(([^)]+)\)/)[1]) }));
  assert.ok(Math.abs(timing.scale - Math.max(0, 1 - (timing.now-start)/4000)) < 0.03);
  assert.equal((await deletion).status(), 204);
  const requestedAt = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter(entry => entry.name.includes("/api/customers/")).at(-1).startTime);
  assert.ok(requestedAt - start >= 4000, "deletion must wait the full four seconds");
  assert.equal(await page.locator("#customerDeleteProgress").getAttribute("aria-valuenow"), "0");
  customer = null;
  assert.deepEqual(errors, []);
  console.log("PASS: smooth shrinking progress, elapsed-time accuracy, four-second deletion, cancellation, centering and responsive layout at six viewport sizes");
} finally {
  if (customer) await api("DELETE", `/customers/${customer.id}`);
  await browser.close();
}

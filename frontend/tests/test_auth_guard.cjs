const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function fixture(validateToken, token = "valid-session") {
  const redirects = [],
    events = [];
  let logouts = 0;
  const context = vm.createContext({
    validateToken,
    getToken: () => token,
    logout: () => {
      logouts++;
    },
    CustomEvent,
    console: { error() {} },
    window: {
      location: { replace: (url) => redirects.push(url) },
      dispatchEvent: (event) => events.push(event),
    },
  });
  const source = fs
    .readFileSync(
      path.join(__dirname, "../src/js/guards/auth-guard.js"),
      "utf8",
    )
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  vm.runInContext(source, context);
  return {
    protect: context.protectPage,
    redirects,
    events,
    logouts: () => logouts,
  };
}

test("missing and invalid sessions redirect, while a valid session proceeds", async () => {
  const missing = fixture(() => {
    throw new Error("must not validate");
  }, null);
  assert.equal(await missing.protect(), false);
  assert.deepEqual(missing.redirects, ["/page/login-page.html"]);
  const invalid = fixture(async () => null);
  assert.equal(await invalid.protect(), false);
  assert.equal(invalid.logouts(), 1);
  assert.deepEqual(invalid.redirects, ["/page/login-page.html"]);
  const valid = fixture(async () => ({ success: true }));
  assert.equal(await valid.protect(), true);
  assert.equal(valid.events.length, 0);
  assert.equal(valid.redirects.length, 0);
});

test("server or network failure preserves the session and provides a recoverable error", async () => {
  const f = fixture(async () => {
    throw new Error("server unavailable");
  });
  assert.equal(await f.protect(), false);
  assert.equal(f.logouts(), 0);
  assert.equal(f.redirects.length, 0);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, "karbon:startup-error");
  assert.match(f.events[0].detail, /سرور/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function fixture(validateToken, token = "valid-session") {
  const listeners = {};
  const document = { documentElement: { dataset: {} }, addEventListener(name, fn) { listeners[name] = fn; } };
  const redirects = [],
    events = [];
  let logouts = 0;
  const context = vm.createContext({
    validateToken,
    document,
    clearTimeout, setTimeout,
    getToken: () => token,
    logout: () => {
      logouts++;
    },
    CustomEvent,
    console: { error() {} },
    window: {
      addEventListener(name, fn) { listeners[name] = fn; },
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
    listeners,
    document,
    setToken(value) { token = value; },
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


test("history restoration validates again and an outstanding check cannot reveal a changed session", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { success: true }; });
  await f.protect();
  f.listeners.pageshow({ persisted: true });
  await f.protect();
  assert.equal(calls, 2);
  let resolve;
  const stale = fixture(() => new Promise(done => { resolve = done; }));
  const pending = stale.protect();
  stale.setToken(null);
  resolve({ success: true });
  assert.equal(await pending, false);
  assert.equal(stale.document.documentElement.dataset.authState, "pending");
  assert.equal(stale.redirects.length, 1);
});

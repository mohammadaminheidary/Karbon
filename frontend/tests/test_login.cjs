const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ response = { success: true, token: "session" }, saveError } = {}) {
  let resolveLogin, submit;
  const requests = [], saved = [], alerts = [], events = {}, attributes = {};
  const button = { disabled: false, innerHTML: "<span>ورود به حساب</span>" };
  const originalContent = button.innerHTML;
  const form = {
    querySelector: () => button,
    addEventListener: (_, callback) => { submit = callback; },
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: (name) => { delete attributes[name]; },
  };
  const location = { href: "login-page.html" };
  const context = vm.createContext({
    loginUser: (...args) => {
      requests.push(args);
      return new Promise((resolve, reject) => {
        resolveLogin = () => response instanceof Error ? reject(response) : resolve(response);
      });
    },
    saveAuth: (data) => {
      if (saveError) throw saveError;
      saved.push(data);
    },
    validateLogin: () => ({ success: true }),
    alert: (message) => alerts.push(message),
    console: { error() {} },
    document: { getElementById: (id) => ({
      loginForm: form, username: { value: " user " }, passwordInput: { value: "password" },
    })[id] },
    window: { location, addEventListener: (name, callback) => { events[name] = callback; } },
    // A successful login must navigate without scheduling any artificial wait.
    setTimeout() { assert.fail("Login must not wait on a timer"); },
  });
  const source = fs.readFileSync(path.join(__dirname, "../src/js/auth/login.js"), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(source, context);
  context.initLogin();
  return {
    submit: () => submit({ preventDefault() {} }),
    finish: () => resolveLogin(),
    button, originalContent, location, requests, saved, alerts, attributes, events,
  };
}

test("login waits for authentication, saves the session and navigates immediately without a loader", async () => {
  const f = fixture();
  const pending = f.submit();
  assert.equal(f.button.disabled, true);
  assert.equal(f.attributes["aria-busy"], "true");
  assert.equal(f.location.href, "login-page.html");
  assert.equal(f.saved.length, 0);
  await f.submit();
  assert.deepEqual(f.requests, [["user", "password"]]);
  f.finish();
  await pending;
  assert.equal(f.saved.length, 1);
  assert.equal(f.location.href, "../index.html");
  assert.equal(f.button.disabled, true);
  assert.equal(f.attributes["aria-busy"], "true");
  await f.submit();
  assert.equal(f.requests.length, 1);
  f.events.pageshow({ persisted: true });
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.innerHTML, f.originalContent);
  assert.equal(f.attributes["aria-busy"], undefined);
});

for (const [name, options] of [
  ["invalid credentials", { response: { success: false, message: "Invalid credentials" } }],
  ["rate limiting", { response: { success: false, message: "Too many attempts" } }],
  ["network failure", { response: new Error("offline") }],
  ["session storage failure", { saveError: new Error("storage unavailable") }],
]) {
  test(`${name} does not navigate and restores the login form for retry`, async () => {
    const f = fixture(options);
    const pending = f.submit();
    f.finish();
    await pending;
    assert.equal(f.location.href, "login-page.html");
    assert.equal(f.saved.length, 0);
    assert.equal(f.alerts.length, 1);
    assert.equal(f.button.disabled, false);
    assert.equal(f.button.innerHTML, f.originalContent);
    assert.equal(f.attributes["aria-busy"], undefined);
    const retry = f.submit();
    assert.equal(f.requests.length, 2);
    f.finish();
    await retry;
  });
}

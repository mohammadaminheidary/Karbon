const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ response = { success: true, token: "session" }, saveError,
  preferenceError, storage = new Map(), username = " user ", password = "password" } = {}) {
  let resolveLogin, submit;
  const requests = [], saved = [], notifications = [], events = {}, attributes = {};
  const button = { disabled: false, innerHTML: "<span>ورود به حساب</span>" };
  const originalContent = button.innerHTML;
  const form = {
    querySelector: () => button,
    addEventListener: (_, callback) => { submit = callback; },
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: (name) => { delete attributes[name]; },
  };
  function control(properties) {
    const listeners = {};
    return {
      ...properties,
      addEventListener: (name, callback) => { listeners[name] = callback; },
      dispatch: (name) => listeners[name](),
    };
  }
  const usernameInput = control({ value: username });
  const rememberUsername = control({ checked: false });
  const location = { href: "login-page.html" };
  const context = vm.createContext({
    loginUser: (...args) => {
      requests.push(args);
      return new Promise((resolve, reject) => {
        resolveLogin = () => response instanceof Error ? reject(response) : resolve(response);
      });
    },
    localStorage: {
      getItem(key) {
        if (preferenceError) throw preferenceError;
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (preferenceError) throw preferenceError;
        storage.set(key, String(value));
      },
      removeItem(key) {
        if (preferenceError) throw preferenceError;
        storage.delete(key);
      },
    },
    validateLogin: () => ({ success: true }),
    notify: (message, options) => notifications.push({ message, ...options }),
    console: { error() {} },
    document: { getElementById: (id) => ({
      loginForm: form, username: usernameInput, rememberUsername, passwordInput: { value: password },
    })[id] },
    window: { location, addEventListener: (name, callback) => { events[name] = callback; } },
    // A successful login must navigate without scheduling any artificial wait.
    setTimeout() { assert.fail("Login must not wait on a timer"); },
  });
  const source = (file) => fs.readFileSync(path.join(__dirname, "../src/js/auth", file), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(source("auth-storage.js"), context);
  context.saveAuth = (data) => {
    if (saveError) throw saveError;
    saved.push(data);
  };
  vm.runInContext(source("login.js"), context);
  context.initLogin();
  return {
    submit: () => submit({ preventDefault() {} }),
    finish: () => resolveLogin(),
    button, originalContent, location, requests, saved, notifications, attributes, events,
    usernameInput, rememberUsername, storage,
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

test("remembering the username survives a fresh login page and opting out clears it", async () => {
  const f = fixture({ username: "" });
  assert.equal(f.rememberUsername.checked, false);
  f.rememberUsername.checked = true;
  f.rememberUsername.dispatch("change");

  const empty = fixture({ storage: f.storage, username: "" });
  assert.equal(empty.rememberUsername.checked, true);
  assert.equal(empty.usernameInput.value, "");
  empty.usernameInput.value = " customer ";
  empty.usernameInput.dispatch("input");

  const next = fixture({ storage: f.storage, username: "" });
  assert.equal(next.rememberUsername.checked, true);
  assert.equal(next.usernameInput.value, "customer");
  const pending = next.submit();
  next.finish();
  await pending;
  assert.deepEqual([...f.storage.values()], ["customer"]);

  next.rememberUsername.checked = false;
  next.rememberUsername.dispatch("change");
  next.usernameInput.value = "another user";
  next.usernameInput.dispatch("input");
  const cleared = fixture({ storage: f.storage, username: "" });
  assert.equal(cleared.rememberUsername.checked, false);
  assert.equal(cleared.usernameInput.value, "");
  assert.equal(f.storage.size, 0);
});

test("a preference storage error does not interrupt login", async () => {
  const f = fixture({ preferenceError: new Error("preferences unavailable") });
  f.rememberUsername.checked = true;
  f.rememberUsername.dispatch("change");
  const pending = f.submit();
  f.finish();
  await pending;
  assert.deepEqual(f.requests, [["user", "password"]]);
  assert.equal(f.location.href, "../index.html");
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
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notifications[0].type, "error");
    assert.equal(f.button.disabled, false);
    assert.equal(f.button.innerHTML, f.originalContent);
    assert.equal(f.attributes["aria-busy"], undefined);
    const retry = f.submit();
    assert.equal(f.requests.length, 2);
    f.finish();
    await retry;
  });
}

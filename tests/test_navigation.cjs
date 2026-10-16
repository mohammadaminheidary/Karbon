const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function surface() {
  const listeners = new Map();
  return {
    hidden: false,
    querySelector: () => null,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    emit(name, event = {}) {
      for (const callback of listeners.get(name) || []) callback(event);
    },
  };
}

function source(name) {
  return fs
    .readFileSync(path.join(__dirname, "../src/js/components", name), "utf8")
    .replaceAll("export function", "function");
}

test("active-route links preserve page state; other routes and native link gestures work", () => {
  const window = surface();
  window.location = new URL("http://localhost/");
  const navbar = surface();
  const context = vm.createContext({
    window,
    URL,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  vm.runInContext(source("navigation.js"), context);
  context.initializeNavigation(navbar);
  function click(href, options = {}) {
    const link = {
      href: new URL(href, window.location).href,
      target: "",
      hasAttribute: () => false,
    };
    const event = {
      button: 0,
      target: { closest: () => link },
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...options,
    };
    navbar.emit("click", event);
    return Boolean(event.defaultPrevented);
  }
  assert.equal(click("/index.html"), true);
  assert.equal(click("/index.html", { ctrlKey: true }), false);
  assert.equal(click("/index.html", { button: 1 }), false);
  assert.equal(click("/page/customers-page.html"), false);
  assert.equal(click("/page/customers-page.html"), true);
  window.emit("pageshow", { persisted: true });
  assert.equal(click("/page/customers-page.html"), false);
  assert.equal(click("/index.html#section"), false);
  assert.equal(click("/index.html?different=1"), false);
});

function refreshFixture(callback, options) {
  const window = surface(),
    document = surface();
  let revision = null,
    now = 0;
  const context = vm.createContext({
    window,
    document,
    Event,
    crypto,
    Date: { now: () => now },
    localStorage: { getItem: () => revision },
  });
  vm.runInContext(source("data-events.js"), context);
  context.onPageRefresh(callback, options);
  return {
    window,
    document,
    advance(ms) {
      now += ms;
    },
    change() {
      revision = String(Number(revision) + 1);
      window.emit("storage", { key: "karbon-data-change" });
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("fresh history restores and quick focus changes do not refetch", async () => {
  let calls = 0;
  const f = refreshFixture(async () => {
    calls++;
  });
  f.window.emit("pageshow", { persisted: true });
  f.document.emit("visibilitychange");
  await flush();
  assert.equal(calls, 0);
  f.advance(30001);
  f.window.emit("pageshow", { persisted: true });
  f.document.emit("visibilitychange");
  await flush();
  assert.equal(calls, 1);
});

test("hidden changes refresh once on return; changes during a request are not lost", async () => {
  let calls = 0,
    finish;
  const f = refreshFixture(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.document.hidden = true;
  f.change();
  f.change();
  assert.equal(calls, 0);
  f.document.hidden = false;
  f.document.emit("visibilitychange");
  f.window.emit("pageshow", { persisted: true });
  assert.equal(calls, 1);
  f.change();
  assert.equal(calls, 1);
  finish();
  await flush();
  assert.equal(calls, 2);
  finish();
  await flush();
  assert.equal(calls, 2);
});

test("a history restore resumes a request interrupted by pagehide", async () => {
  let calls = 0;
  const f = refreshFixture(async () => {
    calls++;
  });
  f.document.querySelector = () => ({});
  f.window.emit("pagehide", { persisted: true });
  f.document.querySelector = () => null;
  f.window.emit("pageshow", { persisted: true });
  await flush();
  assert.equal(calls, 1);
});

test("hidden settings sections defer refresh until they are visible", async () => {
  let calls = 0,
    visible = false;
  const f = refreshFixture(
    async () => {
      calls++;
    },
    { isVisible: () => visible },
  );
  f.change();
  assert.equal(calls, 0);
  visible = true;
  f.document.emit("visibilitychange");
  await flush();
  assert.equal(calls, 1);
});

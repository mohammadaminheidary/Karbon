const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

function fixture() {
  const classes = new Set(), timers = new Map(), listeners = {};
  const children = [];
  let nextTimer = 0;
  const island = {
    querySelector: () => ({}),
    append: (child) => children.push(child),
    contains: () => false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const context = {
    document: {
      querySelector: () => island,
      createElement: () => ({
        textContent: "",
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = value; },
      }),
    },
    window: {
      matchMedia: () => ({ matches: true }),
      addEventListener: (name, callback) => (listeners[name] = callback),
      setTimeout: (callback, duration) => {
        timers.set(++nextTimer, { callback, duration });
        return nextTimer;
      },
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(context);
  vm.runInContext(
    readFileSync(require("node:path").join(__dirname, "../src/js/components/navbar-notification.js"), "utf8")
      .replace(/^export /gm, ""),
    context,
  );
  return { context, island, children, timers, listeners, classes };
}

test("page and feature notifications share one navbar surface and replace stale timers", () => {
  const f = fixture();
  const pageNotify = f.context.createNavbarNotification(f.island);
  pageNotify("customer created");
  f.context.notifyNavbar("customer edited");
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].textContent, "customer edited");
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].duration, 4000);
  assert.equal(f.context.createNavbarNotification(f.island), pageNotify);
});

test("settings timing, error announcements, clearing and pagehide use the shared lifecycle", async () => {
  const f = fixture();
  f.context.notifyNavbar("save failed", { duration: 3000, role: "alert" });
  assert.equal(f.children[0].attrs.role, "alert");
  const timer = [...f.timers.values()][0];
  assert.equal(timer.duration, 3000);
  await timer.callback();
  assert.equal(f.children[0].textContent, "");
  assert.equal(f.classes.has("navbar-notifying"), false);
  f.context.notifyNavbar("saved");
  assert.equal(f.children[0].attrs.role, "status");
  f.context.notifyNavbar("");
  assert.equal(f.children[0].textContent, "");
  assert.equal(f.timers.size, 0);
  f.context.notifyNavbar("saved again");
  f.listeners.pagehide();
  assert.equal(f.timers.size, 0);
  assert.equal(f.classes.has("navbar-notifying"), false);
});

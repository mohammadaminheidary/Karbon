const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(reduced = false, adapted = false) {
  const calls = [],
    listeners = new Map();
  const classes = () => {
    const values = new Set();
    return {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      contains: (name) => values.has(name),
    };
  };
  function element(rect = {}) {
    const target = {
      classList: classes(),
      dataset: {},
      rect,
      getBoundingClientRect() {
        return this.rect;
      },
      removeAttribute(name) {
        if (name === "data-morph") delete this.dataset.morph;
      },
    };
    target.animate = (frames, options) => {
      let resolve, reject;
      const animation = {
        target,
        frames,
        options,
        cancelled: false,
        finished: new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
        finish: () => resolve(),
        cancel() {
          this.cancelled = true;
          reject(new Error("cancelled"));
        },
      };
      calls.push(animation);
      return animation;
    };
    return target;
  }
  const glass = element(),
    items = element(),
    content = element();
  const nav = element({
    left: 367,
    right: 913,
    top: 636,
    bottom: 702,
    width: 546,
    height: 66,
  });
  nav.querySelector = (selector) =>
    selector === ".navbar-glass" ? glass : items;
  const islands = [
    element({ left: 925, right: 1110, top: 636, width: 185, height: 66 }),
    element({ left: 170, right: 355, top: 636, width: 185, height: 66 }),
  ];
  const dock = element();
  dock.querySelectorAll = () => islands;
  const panel = element({
    left: 90,
    right: 1190,
    top: 100,
    bottom: 702,
    width: 1100,
    height: 602,
  });
  panel.querySelector = () => content;
  panel.showModal = () => (panel.open = true);
  panel.close = () => (panel.open = false);
  const body = element();
  body.classList.add("task-form-open");
  const media = {
    matches: reduced,
    addEventListener: (name, handler) =>
      listeners.set("motion-" + name, handler),
    removeEventListener: (name) => listeners.delete("motion-" + name),
  };
  const window = {
    matchMedia: () => media,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    visualViewport: {
      addEventListener: (name, handler) =>
        listeners.set("viewport-" + name, handler),
      removeEventListener: (name) => listeners.delete("viewport-" + name),
    },
  };
  const document = {
    body,
    querySelector: () => dock,
    getElementById: () => nav,
  };
  const source = fs
    .readFileSync(
      path.join(__dirname, "../src/js/documents/navbar-panel-transition.js"),
      "utf8",
    )
    .replace(
      "export function createNavbarPanelTransition",
      "function createNavbarPanelTransition",
    );
  const context = vm.createContext({ window, document, console });
  vm.runInContext(
    source + "\nthis.createTransition = createNavbarPanelTransition;",
    context,
  );
  let shown = 0,
    hidden = 0;
  const transition = context.createTransition(panel, {
    position: () => {},
    ...(adapted
      ? {
          show: () => {
            shown++;
            panel.open = true;
          },
          hide: () => {
            hidden++;
            panel.open = false;
          },
        }
      : {}),
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const finish = async () => {
    calls.filter((call) => !call.cancelled).forEach((call) => call.finish());
    await tick();
  };
  return {
    transition,
    panel,
    dock,
    body,
    calls,
    listeners,
    finish,
    tick,
    shown: () => shown,
    hidden: () => hidden,
  };
}

test("measures panel width, sequences material before content, and restores the dock on close", async () => {
  const f = fixture();
  const opening = f.transition.open();
  assert.equal(f.panel.dataset.morph, "preparing");
  assert.equal(f.calls[0].frames.at(-1).width, "1100px");
  assert.equal(f.calls[0].frames.at(-1).left, "-277px");
  assert.equal(
    f.calls.some((call) => call.target === f.panel),
    false,
  );
  await f.finish();
  assert.equal(f.panel.dataset.morph, "revealing");
  const reveal = f.calls.find((call) => call.target === f.panel);
  assert.equal(reveal.options.delay || 0, 0);
  assert.equal(reveal.frames[0].opacity, 1);
  assert.equal(f.calls[0].options.easing, "linear");
  await f.finish();
  await opening;
  assert.equal(f.dock.classList.contains("document-dock-open"), true);
  assert.equal(f.dock.classList.contains("document-dock-morphing"), false);
  const closing = f.transition.close();
  await f.finish();
  await closing;
  assert.equal(f.panel.open, false);
  assert.equal(f.transition.active, false);
  assert.equal(f.dock.classList.contains("document-dock-open"), false);
  assert.equal(f.dock.classList.contains("document-dock-morphing"), false);
  assert.ok(f.calls.every((call) => call.cancelled));
  assert.equal(f.body.classList.contains("task-form-open"), false);
});

test("Escape-style close during absorption cannot reopen the panel later", async () => {
  const f = fixture();
  const opening = f.transition.open();
  await f.transition.close();
  await opening;
  assert.equal(f.panel.open, false);
  assert.equal(f.transition.active, false);
  assert.equal(f.panel.dataset.morph, undefined);
  assert.ok(f.calls.every((call) => call.cancelled));
});

test("viewport changes discard stale frames while preserving an open modal, then clean closing state", async () => {
  const f = fixture();
  const opening = f.transition.open();
  f.panel.rect = { left: 16, width: 358 };
  f.listeners.get("viewport-resize")();
  await opening;
  assert.equal(f.panel.open, true);
  assert.equal(f.transition.animating, false);
  assert.equal(f.dock.classList.contains("document-dock-open"), true);
  const closing = f.transition.close();
  f.listeners.get("resize")();
  await closing;
  assert.equal(f.panel.open, false);
  assert.equal(f.transition.active, false);
  assert.ok(f.calls.every((call) => call.cancelled));
});

test("reduced motion skips all animation and pagehide always clears modal state", async () => {
  const f = fixture(true);
  await f.transition.open();
  assert.equal(f.calls.length, 0);
  assert.equal(f.panel.open, true);
  f.listeners.get("pagehide")();
  assert.equal(f.panel.open, false);
  assert.equal(f.transition.active, false);
  assert.equal(f.dock.classList.contains("document-dock-open"), false);
  assert.equal(f.body.classList.contains("task-form-open"), false);
});

test("existing dialogs reuse identical staged motion through lifecycle adapters", async () => {
  const f = fixture(false, true);
  const opening = f.transition.open();
  assert.equal(f.shown(), 1);
  assert.equal(f.calls[0].options.duration, 520);
  assert.equal(f.calls[0].options.easing, "linear");
  assert.equal(f.calls[1].options.duration, 160);
  assert.equal(f.calls[2].options.duration, 360);
  await f.finish();
  const reveal = f.calls.find((call) => call.target === f.panel);
  assert.equal(reveal.options.duration, 400);
  assert.equal(reveal.options.easing, "cubic-bezier(.22, 1, .36, 1)");
  assert.equal(f.calls.at(-1).options.duration, 300);
  await f.finish();
  await opening;
  const closing = f.transition.close();
  await f.finish();
  await closing;
  assert.equal(f.hidden(), 1);
  assert.equal(f.transition.active, false);
});

test("unmount cancels transitions and detaches shared window listeners", async () => {
  const f = fixture();
  const opening = f.transition.open();
  assert.ok(f.listeners.size > 0);
  f.transition.destroy();
  await opening;
  assert.equal(f.listeners.size, 0);
  assert.equal(f.transition.active, false);
  assert.equal(f.panel.open, false);
  assert.equal(f.dock.classList.contains("document-dock-open"), false);
  assert.equal(f.dock.classList.contains("document-dock-morphing"), false);
});

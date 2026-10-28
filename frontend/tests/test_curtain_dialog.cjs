const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture() {
  function element() {
    const classes = new Set(),
      events = new Map(),
      attributes = new Map();
    return {
      isConnected: true,
      scrollHeight: 600,
      style: {
        setProperty(k, v) {
          this[k] = v;
        },
      },
      classList: {
        add: (...v) => v.forEach((x) => classes.add(x)),
        remove: (...v) => v.forEach((x) => classes.delete(x)),
        contains: (x) => classes.has(x),
        toggle(k, on) {
          on ? classes.add(k) : classes.delete(k);
        },
      },
      addEventListener(k, fn) {
        if (!events.has(k)) events.set(k, new Set());
        events.get(k).add(fn);
      },
      removeEventListener(k, fn) {
        events.get(k)?.delete(fn);
      },
      emit(k, event = {}) {
        [...(events.get(k) || [])].forEach((fn) =>
          fn({ target: this, ...event }),
        );
      },
      getAttribute: (k) => attributes.get(k),
      setAttribute: (k, v) => attributes.set(k, v),
      removeAttribute: (k) => attributes.delete(k),
      focus() {
        this.focused = true;
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
    };
  }
  const root = element(),
    content = element(),
    button = element(),
    body = element(),
    trigger = element();
  const nav = {
    append() {},
    getBoundingClientRect: () => ({
      left: 200,
      width: 500,
      height: 66,
      bottom: 780,
    }),
  };
  content.setAttribute("role", "alertdialog");
  content.setAttribute("aria-labelledby", "title");
  root.querySelector = () => content;
  root.querySelectorAll = () => [button];
  const timers = new Map();
  let timerId = 0,
    resize;
  const context = vm.createContext({
    document: {
      body,
      activeElement: trigger,
      getElementById: (id) => (id === "mainNavbar" ? nav : root),
    },
    window: { innerHeight: 800, addEventListener() {} },
    ResizeObserver: class {
      constructor(fn) {
        resize = fn;
      }
      observe() {}
    },
    setTimeout(fn) {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext(
    fs
      .readFileSync(require("node:path").join(__dirname, "../src/js/components/curtain-dialog.js"), "utf8")
      .replace("export class", "class") +
      "\nthis.CurtainDialog = CurtainDialog;",
    context,
  );
  return {
    root,
    content,
    button,
    body,
    trigger,
    timers,
    resize: () => resize(),
    create: (options) => new context.CurtainDialog("modal", options),
  };
}

test("uses native modality, shared navbar geometry, dynamic height, and accessible alert name", () => {
  const f = fixture(),
    dialog = f.create();
  dialog.open();
  assert.equal(f.root.open, true);
  assert.equal(f.root.getAttribute("role"), "alertdialog");
  assert.equal(f.root.getAttribute("aria-labelledby"), "title");
  assert.equal(f.root.style["--task-curtain-width"], "500px");
  assert.equal(f.root.style["--task-form-height"], "600px");
  f.content.scrollHeight = 1000;
  f.resize();
  assert.equal(f.root.style["--task-form-height"], "764px");
  assert.ok(f.body.classList.contains("bottom-curtain-open"));
});

test("blocks dismissal while saving and finishes one animated close with restored focus", () => {
  const f = fixture();
  let saving = true,
    cancelled = 0,
    closed = 0;
  const dialog = f.create({
    canClose: () => !saving,
    onCancel: () => cancelled++,
    onClosed: () => closed++,
  });
  dialog.open();
  f.button.emit("click");
  assert.equal(cancelled, 0);
  assert.equal(f.root.open, true);
  saving = false;
  f.root.emit("cancel", { preventDefault() {} });
  assert.equal(cancelled, 1);
  assert.equal(dialog.closing, true);
  f.button.emit("click");
  dialog.open();
  assert.equal(cancelled, 1);
  f.root.emit("animationend", { target: f.content });
  assert.equal(f.root.open, true);
  f.root.emit("animationend");
  assert.equal(f.root.open, false);
  assert.equal(closed, 1);
  assert.equal(f.trigger.focused, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.body.classList.contains("bottom-curtain-open"), false);
  dialog.open();
  assert.equal(f.root.open, true);
});

test("fallback completes close if animation events are unavailable", () => {
  const f = fixture(),
    dialog = f.create();
  dialog.open();
  dialog.close();
  [...f.timers.values()][0]();
  assert.equal(f.root.open, false);
  assert.equal(dialog.closing, false);
});

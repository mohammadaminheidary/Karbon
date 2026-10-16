const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture() {
  function element(tagName = "DIV") {
    const classes = new Set();
    return {
      tagName,
      inert: false,
      open: false,
      isConnected: true,
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n),
      },
      querySelectorAll: () => [],
      addEventListener() {},
      setAttribute() {},
      focus() {
        document.activeElement = this;
      },
      closest: () => null,
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
    };
  }
  const body = element(),
    trigger = element(),
    background = element();
  const form = element("DIALOG");
  form.open = true;
  const duplicate = element("DIALOG"),
    details = element();
  for (const root of [duplicate, details]) {
    root.panel = element();
    root.querySelector = () => root.panel;
  }
  body.children = [background, form, duplicate, details];
  const document = {
    body,
    activeElement: trigger,
    getElementById: (id) => (id === "duplicate" ? duplicate : details),
    querySelector: () =>
      body.children.find((el) => el.tagName === "DIALOG" && el.open),
  };
  const context = vm.createContext({
    document,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 1,
    clearTimeout() {},
  });
  vm.runInContext(
    fs
      .readFileSync("src/js/components/dialog.js", "utf8")
      .replace("export class Dialog", "class Dialog") +
      "\nthis.Dialog = Dialog;",
    context,
  );
  return {
    body,
    form,
    duplicate,
    details,
    create: (id) => new context.Dialog(id),
  };
}

test("native duplicate confirmation can reopen and preserves the parent panel scroll lock", () => {
  const f = fixture(),
    duplicate = f.create("duplicate");
  duplicate.open();
  assert.equal(f.duplicate.open, true);
  duplicate.close();
  assert.equal(f.duplicate.open, false);
  assert.equal(f.form.inert, false);
  assert.equal(f.body.classList.contains("overflow-hidden"), true);
  duplicate.open();
  assert.equal(f.duplicate.open, true);
  assert.equal(f.duplicate.inert, false);
  duplicate.close();
  f.form.close();
  duplicate.open();
  duplicate.close();
  assert.equal(f.body.classList.contains("overflow-hidden"), false);
});

test("closing a native confirmation above a legacy details dialog keeps the open panel interactive", () => {
  const f = fixture(),
    details = f.create("details"),
    duplicate = f.create("duplicate");
  f.form.close();
  details.open();
  f.form.inert = false;
  f.form.showModal();
  duplicate.open();
  duplicate.close();
  assert.equal(f.form.inert, false);
  assert.equal(f.form.open, true);
  assert.equal(f.body.classList.contains("overflow-hidden"), true);
  f.form.close();
  details.close();
  assert.equal(f.body.classList.contains("overflow-hidden"), false);
});

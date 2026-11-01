const fs = require("fs"),
  vm = require("vm"),
  assert = require("node:assert/strict");
class Element {
  constructor(tag = "div", classes = "", text = "") {
    this.tag = tag;
    this.className = classes;
    this.textContent = text;
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.style = {};
    this.classList = { toggle() {} };
    this.hidden = false;
  }
  append(...children) {
    children.forEach((child) => (child.parent = this));
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  remove() {
    this.parent.children = this.parent.children.filter(
      (child) => child !== this,
    );
  }
  setAttribute(key, value) {
    this.attrs[key] = value;
  }
  addEventListener(event, cb) {
    this.listeners[event] = cb;
  }
  reset() {
    this.resetCalled = true;
  }
  focus() {}
}
async function scenario(metadata) {
  const ids = [
    "settingsProductsStatus",
    "settingsProductsList",
    "refreshProducts",
    "settingsProductForm",
    "settingsProductCode",
    "saveSettingsProduct",
    "cancelSettingsProductEdit",
    "settingsProductPrice",
    "settingsProductUnit",
  ];
  const els = Object.fromEntries(ids.map((id) => [id, new Element()]));
  let notification;
  let fail = false,
    confirmation;
  const product = {
    id: 1,
    product_code: "P-000001",
    name: "Fixture",
    unit: "unit",
    price: 100,
    stock: 1,
    active: true,
    ...metadata,
  };
  let products = [product];
  const context = {
    document: {
      getElementById: (id) => els[id],
      addEventListener() {},
      querySelector: (selector) =>
        els.settingsProductsList.children.find((el) =>
          selector.includes(`"${el.dataset.productId}"`),
        ),
    },
    Intl,
    console,
    notifyNavbar: (message, options) => (notification = { message, ...options }),
    node: (...args) => new Element(...args),
    money: String,
    formatNumber: String,
    bindStrictAmount() {},
    onPageRefresh() {},
    refreshData: (callback) => callback,
    getInventoryOptions: async () => ({ units: [] }),
    populateUnitSelect() {},
    financeRequest: async () => {
      if (fail) throw new Error("fixture refresh failure");
      return products;
    },
    confirmFinanceDelete: (options) => (confirmation = options),
  };
  const source = fs
    .readFileSync(
      require("path").join(__dirname, "../src/js/orders/product-settings.js"),
      "utf8",
    )
    .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*/gm, "")
    .replace(/^export /gm, "");
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.initializeProductSettings();
  return {
    els,
    get notification() {
      return notification;
    },
    remove: els.settingsProductsList.children[0].children[1].children[1],
    get confirmation() {
      return confirmation;
    },
    failRefresh() {
      fail = true;
    },
    completeDeletion() {
      products = [];
    },
    recoverRefresh() {
      fail = false;
    },
  };
}
(async () => {
  let failures = 0;
  try {
    const test = await scenario({});
    assert.equal(test.remove.disabled, false);
    test.remove.listeners.click();
    assert.ok(test.confirmation);
    console.log(
      "PASS: missing optional can_delete metadata does not silently disable deletion",
    );
  } catch (e) {
    failures++;
    console.log(
      "FAIL: missing can_delete metadata silently blocks the delete button",
    );
  }
  try {
    const test = await scenario({ can_delete: true });
    test.remove.listeners.click();
    test.completeDeletion();
    test.failRefresh();
    await test.confirmation.onDeleted();
    assert.equal(test.els.settingsProductsList.children.length, 0);
    assert.match(test.notification.message, /حذف شد/);
    assert.match(test.notification.message, /بروزرسانی/);
    assert.equal(test.els.refreshProducts.disabled, false);
    assert.equal(test.notification.role, "alert");
    assert.equal(test.els.settingsProductsStatus.textContent, "");
    test.recoverRefresh();
    await test.els.refreshProducts.listeners.click();
    assert.equal(test.els.settingsProductsList.children.length, 0);
    assert.equal(test.notification.message, "");
    assert.equal(test.els.settingsProductsList.attrs["aria-busy"], "false");
    console.log(
      "PASS: successful deletion removes the product even if refresh fails, with visible retry error",
    );
  } catch (e) {
    failures++;
    console.log(
      "FAIL: deleted product remains visible after refresh fails",
      e.message,
      e.stack,
    );
  }
  const protectedProduct = await scenario({ can_delete: false });
  assert.equal(protectedProduct.remove.disabled, true);
  protectedProduct.remove.listeners.click();
  assert.equal(protectedProduct.confirmation, undefined);
  console.log("PASS: explicit reference protection still blocks deletion");
  if (failures) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

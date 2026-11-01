const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs
  .readFileSync(
    path.join(__dirname, "../src/js/warehouse/inventory-options.js"),
    "utf8",
  )
  .replace(/^import .*;\s*/m, "")
  .replace(/^export /gm, "");
const context = vm.createContext({
  financeRequest() {},
  Option: function (text, value) {
    this.text = text;
    this.value = value;
  },
});
vm.runInContext(source, context);
const units = [
  { name: "عدد", active: true },
  { name: "متر", active: false },
];
function field(value = "") {
  return {
    value,
    replaceChildren(...options) {
      this.options = options;
    },
  };
}

test("new records offer enabled units and clear stale selections", () => {
  const select = field("متر");
  context.populateUnitSelect(select, units);
  assert.deepEqual(
    select.options.map((o) => o.value),
    ["", "عدد"],
  );
  assert.equal(select.value, "");
  assert.equal(select.disabled, false);
});
test("only the edited record can retain its disabled or missing original unit", () => {
  for (const current of ["متر", "قدیمی"]) {
    const select = field(current);
    context.populateUnitSelect(select, units, { current });
    assert.equal(select.value, current);
    assert.match(select.options.at(-1).text, /غیرفعال/);
    assert.equal(select.options.at(-1).value, current);
  }
});
test("empty configuration disables creation while retaining an edited legacy unit", () => {
  const select = field();
  context.populateUnitSelect(select, []);
  assert.equal(select.disabled, true);
  assert.equal(select.options.length, 1);
  context.populateUnitSelect(select, [], {
    current: "قدیمی",
    selected: "قدیمی",
  });
  assert.equal(select.disabled, false);
  assert.equal(select.value, "قدیمی");
});

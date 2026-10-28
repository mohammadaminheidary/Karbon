const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const source = readFileSync(require("node:path").join(__dirname, "../src/js/dashboard/layout-model.js"), "utf8");
const modelPromise = import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);
const defs = [
  ...["revenue", "expense", "inventory"].map((id) => ({
    id,
    kind: "chart",
    w: 4,
    h: 12,
  })),
  ...["net", "sales", "active", "debt"].map((id) => ({
    id,
    kind: "kpi",
    w: 3,
    h: 5,
  })),
  ...["cashflow", "customers", "orders"].map((id) => ({
    id,
    kind: "chart",
    w: 8,
    h: 12,
  })),
  { id: "receivables", kind: "report", w: 12, h: 7 },
  ...["tasks", "attendance", "documents"].map((id) => ({
    id,
    kind: "chart",
    w: 4,
    h: 12,
  })),
];
function valid(items, cols, model) {
  assert.equal(items.length, defs.length);
  for (const a of items) {
    assert.ok([a.x, a.y, a.w, a.h].every(Number.isSafeInteger));
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= cols && a.h > 0);
    for (const b of items)
      if (a.id !== b.id)
        assert.equal(model.overlaps(a, b), false, `${a.id} overlaps ${b.id}`);
  }
}
test("default desktop, tablet and mobile layouts fit every widget without overlap", async () => {
  const m = await modelPromise;
  for (const cols of [12, 8, 4]) valid(m.defaultLayout(defs, cols), cols, m);
});
test("moving a widget onto occupied cells preserves its destination and pushes neighbours", async () => {
  const m = await modelPromise,
    items = m.defaultLayout(defs, 12);
  const moved = items.map((item) =>
    item.id === "revenue" ? { ...item, x: 4 } : item,
  );
  const result = m.resolveLayout(moved, defs, 12, "revenue");
  valid(result, 12, m);
  assert.equal(result.find((i) => i.id === "revenue").x, 4);
  assert.ok(result.find((i) => i.id === "expense").y >= 12);
});
test("resize, move and boundary clamping stay collision-free over 1200 edits per breakpoint", async () => {
  const m = await modelPromise;
  let seed = 319;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (const cols of [12, 8, 4]) {
    let items = m.defaultLayout(defs, cols);
    for (let i = 0; i < 1200; i++) {
      const id = defs[Math.floor(random() * defs.length)].id;
      const changed = items.map((item) =>
        item.id === id
          ? {
              ...item,
              x: Math.round(random() * cols * 2 - cols / 2),
              y: Math.round(random() * 50),
              w: Math.round(random() * cols * 2),
              h: Math.round(random() * 40),
            }
          : item,
      );
      items = m.resolveLayout(changed, defs, cols, id);
      valid(items, cols, m);
    }
  }
});
test("saved layouts round-trip and corrupt or duplicate storage safely falls back", async () => {
  const m = await modelPromise;
  const initial = m.defaultLayout(defs, 12),
    saved = JSON.parse(JSON.stringify(initial));
  assert.deepEqual(m.restoreLayout(saved, defs, 12), initial);
  for (const bad of [
    null,
    {},
    "bad",
    [],
    [...saved.slice(1), saved[1]],
    saved.map((i) => ({ ...i, w: NaN })),
  ])
    assert.deepEqual(m.restoreLayout(bad, defs, 12), initial);
  const hostile = saved.map((i) => ({
    ...i,
    x: -9999,
    y: 9999999,
    w: 999999,
    h: -1,
  }));
  valid(m.restoreLayout(hostile, defs, 12), 12, m);
});

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const source = readFileSync(
  path.join(root, "src/js/components/appearance.js"),
  "utf8",
);
function app({ value = null, pathname = "/index.html", blocked = false } = {}) {
  const listeners = {};
  const storage = new Map(value === null ? [] : [["karbon_appearance", value]]);
  const document = {
    documentElement: {
      dataset: {},
      style: {
        setProperty(name, value) {
          this[name] = value;
        },
      },
    },
  };
  const window = {
    location: { pathname },
    addEventListener(name, callback) {
      (listeners[name] ??= []).push(callback);
    },
    dispatchEvent(event) {
      for (const callback of listeners[event.type] || []) callback(event);
    },
  };
  const localStorage = {
    getItem(key) {
      if (blocked) throw Error("disabled");
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (blocked) throw Error("quota");
      storage.set(key, value);
    },
  };
  vm.runInNewContext(source, {
    window,
    document,
    localStorage,
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
  });
  return { api: window.KarbonAppearance, window, document, storage };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
test("first paint defaults and corrupt or unsupported preferences remain usable", () => {
  for (const value of [
    null,
    "{broken",
    "null",
    "[]",
    JSON.stringify({
      theme: "purple",
      fontSize: -1,
      pageFontSizes: { dashboard: "125", settings: 200 },
      dockAnimation: "false",
      dockMagnification: 181,
    }),
  ]) {
    const { api, document } = app({ value });
    assert.deepEqual(plain(api.getPreferences()), {
      theme: "blue",
      fontSize: 100,
      pageFontSizes: {},
      cardTiltBySection: {},
      dockAnimation: true,
      dockMagnification: 160,
      dockHighlightTransparency: 45,
      dockHighlightDarkness: 0,
      navbarTransparency: 30,
      navbarBlur: 24,
    });
    assert.equal(document.documentElement.dataset.theme, "blue");
    assert.equal(document.documentElement.style.fontSize, "100%");
  }
});
test("navbar glass settings restore independently and validate their ranges", () => {
  const first = app();
  first.api.updatePreferences({ navbarTransparency: 100, navbarBlur: 240 });
  assert.equal(first.document.documentElement.style["--navbar-blur"], "240px");
  first.api.updatePreferences({ navbarBlur: 0 });
  const restored = app({ value: first.storage.get(first.api.STORAGE_KEY) });
  assert.equal(restored.document.documentElement.style["--navbar-transparency"], "100%");
  assert.equal(restored.document.documentElement.style["--navbar-blur"], "0px");
  restored.api.updatePreferences({ navbarTransparency: -1, navbarBlur: 241 });
  assert.equal(restored.api.getPreferences().navbarTransparency, 30);
  assert.equal(restored.api.getPreferences().navbarBlur, 24);
});
test("card tilt defaults on for each section and persists independent overrides", () => {
  const first = app({ pathname: "/page/settings-page.html" });
  assert.deepEqual(
    plain(first.api.cardTiltSections.map(({ id }) => id)).sort(),
    [...plain(first.api.pages.map(({ id }) => id)), "products"].sort(),
  );
  for (const { id } of first.api.cardTiltSections) {
    assert.equal(first.api.cardTiltEnabled(id), true, id);
  }
  first.api.updatePreferences({
    cardTiltBySection: { customers: false, products: false, banks: "off" },
  });
  const value = first.storage.get(first.api.STORAGE_KEY);
  const restored = app({ value, pathname: "/page/customers-page.html" });
  assert.equal(restored.api.cardTiltEnabled(), false);
  assert.equal(restored.api.cardTiltEnabled("products"), false);
  assert.equal(restored.api.cardTiltEnabled("banks"), true);
  assert.equal(restored.api.cardTiltEnabled("settings"), true);
  assert.equal(app({ value, pathname: "/new-section" }).api.cardTiltEnabled(), true);
  const snapshot = restored.api.getPreferences();
  snapshot.cardTiltBySection.customers = true;
  assert.equal(restored.api.cardTiltEnabled(), false);
  restored.api.resetPreferences();
  assert.equal(restored.api.cardTiltEnabled(), true);
  assert.equal(restored.api.cardTiltEnabled("products"), true);
});
test("dock highlight settings validate and persist independently", () => {
  const first = app();
  first.api.updatePreferences({ dockHighlightTransparency: 100, dockHighlightDarkness: 72 });
  first.api.updatePreferences({ dockHighlightTransparency: 0 });
  const restored = app({ value: first.storage.get(first.api.STORAGE_KEY) });
  assert.equal(restored.api.getPreferences().dockHighlightTransparency, 0);
  assert.equal(restored.api.getPreferences().dockHighlightDarkness, 72);
  assert.equal(restored.document.documentElement.style["--dock-highlight-transparency"], "0%");
  assert.equal(restored.document.documentElement.style["--dock-highlight-darkness"], "72%");
  restored.api.updatePreferences({ dockHighlightTransparency: "25", dockHighlightDarkness: 101 });
  assert.equal(restored.api.getPreferences().dockHighlightTransparency, 45);
  assert.equal(restored.api.getPreferences().dockHighlightDarkness, 0);
});
test("dock preferences preserve a disabled effect and validate magnification steps", () => {
  const first = app();
  for (const dockMagnification of [110, 135, 180]) {
    assert.equal(first.api.updatePreferences({ dockAnimation: false, dockMagnification }), true);
    const restored = app({ value: first.storage.get(first.api.STORAGE_KEY) });
    assert.equal(restored.api.getPreferences().dockAnimation, false);
    assert.equal(restored.api.getPreferences().dockMagnification, dockMagnification);
  }
  for (const dockMagnification of [105, 112, 185, "160", null]) {
    first.api.updatePreferences({ dockMagnification });
    assert.equal(first.api.getPreferences().dockMagnification, 160);
  }
});
test("preferences survive new documents and apply page overrides only to the matching page", () => {
  const first = app();
  assert.equal(
    first.api.updatePreferences({
      theme: "green",
      fontSize: 110,
      pageFontSizes: { customers: 125, "bank-transactions": 90, unknown: 120 },
    }),
    true,
  );
  const value = first.storage.get(first.api.STORAGE_KEY);
  for (const [pathname, expected] of [
    ["/", 110],
    ["/index.html", 110],
    ["/page/customers-page.html", 125],
    ["/page/bank-transactions-page.html", 90],
    ["/page/banks-page.html", 110],
  ]) {
    const { document } = app({ value, pathname });
    assert.equal(document.documentElement.dataset.theme, "green");
    assert.equal(document.documentElement.style.fontSize, `${expected}%`);
  }
  assert.equal(first.api.getPreferences().pageFontSizes.unknown, undefined);
});
test("global edits preserve explicit overrides, and resetting resumes inheritance", () => {
  const { api, document } = app({ pathname: "/page/settings-page.html" });
  api.updatePreferences({ pageFontSizes: { settings: 100 } });
  api.updatePreferences({ fontSize: 125 });
  assert.equal(document.documentElement.style.fontSize, "100%");
  api.updatePreferences({ pageFontSizes: {} });
  assert.equal(document.documentElement.style.fontSize, "125%");
  const snapshot = api.getPreferences();
  snapshot.pageFontSizes.settings = 85;
  assert.equal(api.getPreferences().pageFontSizes.settings, undefined);
});
test("open tabs, cleared storage and restored history follow the latest preferences", () => {
  const { api, window, storage, document } = app();
  storage.set(api.STORAGE_KEY, JSON.stringify({ theme: "red", fontSize: 120 }));
  window.dispatchEvent({ type: "storage", key: api.STORAGE_KEY });
  assert.equal(document.documentElement.dataset.theme, "red");
  storage.set(
    api.STORAGE_KEY,
    JSON.stringify({ theme: "black", fontSize: 85 }),
  );
  window.dispatchEvent({ type: "pageshow", persisted: true });
  assert.equal(document.documentElement.dataset.theme, "black");
  assert.equal(document.documentElement.style.fontSize, "85%");
  storage.clear();
  window.dispatchEvent({ type: "storage", key: null });
  assert.equal(document.documentElement.dataset.theme, "blue");
  assert.equal(document.documentElement.style.fontSize, "100%");
});
test("blocked storage still allows live controls and reports that persistence failed", () => {
  const { api, document } = app({ blocked: true });
  assert.equal(api.updatePreferences({ theme: "black", fontSize: 115 }), false);
  assert.equal(document.documentElement.dataset.theme, "black");
  assert.equal(document.documentElement.style.fontSize, "115%");
});
test("every application document initializes appearance before styles and page modules", () => {
  const { api } = app();
  const paths = [
    "/index.html",
    ...readdirSync(path.join(root, "page"))
      .filter((p) => p.endsWith(".html"))
      .map((p) => `/page/${p}`),
  ];
  assert.deepEqual(plain(api.pages.map((p) => p.path)).sort(), paths.sort());
  for (const pathname of paths) {
    const html = readFileSync(path.join(root, pathname), "utf8");
    const bootstrap = html.indexOf("src/js/components/appearance.js");
    assert.ok(
      bootstrap > 0 && bootstrap < html.indexOf('rel="stylesheet"'),
      pathname,
    );
  }
});

test("reset restores initial appearance, persists and preserves unrelated storage", () => {
  const { api, document, storage } = app({
    pathname: "/page/settings-page.html",
  });
  storage.set("karbon_auth", "session");
  storage.set("security-settings", "unchanged");
  api.updatePreferences({
    theme: "red",
    fontSize: 125,
    pageFontSizes: { settings: 85, customers: 120 },
    cardTiltBySection: { settings: false },
    dockAnimation: false,
    dockMagnification: 180,
    dockHighlightTransparency: 8,
    dockHighlightDarkness: 80,
    navbarTransparency: 76,
    navbarBlur: 3,
  });
  assert.equal(api.resetPreferences(), true);
  assert.deepEqual(plain(api.getPreferences()), {
    theme: "blue",
    fontSize: 100,
    pageFontSizes: {},
    cardTiltBySection: {},
    dockAnimation: true,
    dockMagnification: 160,
    dockHighlightTransparency: 45,
    dockHighlightDarkness: 0,
    navbarTransparency: 30,
    navbarBlur: 24,
  });
  assert.equal(document.documentElement.dataset.theme, "blue");
  assert.equal(document.documentElement.style.fontSize, "100%");
  assert.equal(storage.get("karbon_auth"), "session");
  assert.equal(storage.get("security-settings"), "unchanged");
  const restored = app({
    value: storage.get(api.STORAGE_KEY),
    pathname: "/page/customers-page.html",
  });
  assert.deepEqual(
    plain(restored.api.getPreferences()),
    plain(api.getPreferences()),
  );
});

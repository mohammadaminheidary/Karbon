// Runs synchronously in <head> on every page, before styles and first paint.
(() => {
  const STORAGE_KEY = "karbon_appearance";
  const MIN_SIZE = 85;
  const MAX_SIZE = 125;
  const pages = Object.freeze(
    [
      { id: "dashboard", path: "/index.html", label: "داشبورد" },
      { id: "customers", path: "/page/customers-page.html", label: "مشتریان" },
      { id: "orders", path: "/page/orders-page.html", label: "سفارشات" },
      { id: "finance", path: "/page/finance-page.html", label: "مالی" },
      {
        id: "attendance",
        path: "/page/attendance-page.html",
        label: "ورودی اعضا",
      },
      {
        id: "daily-tasks",
        path: "/page/daily-tasks-page.html",
        label: "کارهای روزانه",
      },
      { id: "documents", path: "/page/documents-page.html", label: "ثبت سند" },
      { id: "banks", path: "/page/banks-page.html", label: "بانک‌ها" },
      {
        id: "bank-transactions",
        path: "/page/bank-transactions-page.html",
        label: "تراکنش‌های حساب",
      },
      { id: "warehouse", path: "/page/warehouse-page.html", label: "انبار" },
      { id: "settings", path: "/page/settings-page.html", label: "تنظیمات" },
      { id: "login", path: "/page/login-page.html", label: "ورود" },
    ].map(Object.freeze),
  );
  const validSize = (value) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SIZE &&
    value <= MAX_SIZE &&
    value % 5 === 0;

  function normalize(value) {
    const source = value && typeof value === "object" ? value : {};
    const pageFontSizes = {};
    for (const { id } of pages) {
      if (validSize(source.pageFontSizes?.[id]))
        pageFontSizes[id] = source.pageFontSizes[id];
    }
    return {
      theme: ["blue", "red", "green", "black"].includes(source.theme)
        ? source.theme
        : "blue",
      fontSize: validSize(source.fontSize) ? source.fontSize : 100,
      pageFontSizes,
    };
  }

  function read() {
    try {
      return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch {
      return normalize();
    }
  }

  let preferences = read();
  function apply() {
    const path =
      window.location.pathname === "/"
        ? "/index.html"
        : window.location.pathname;
    const page = pages.find((entry) => entry.path === path);
    const size = preferences.pageFontSizes[page?.id] ?? preferences.fontSize;
    document.documentElement.dataset.theme = preferences.theme;
    // rem typography follows this value, including components loaded later.
    document.documentElement.style.fontSize = `${size}%`;
    document.documentElement.style.setProperty(
      "--app-font-scale",
      String(size / 100),
    );
    window.dispatchEvent(new CustomEvent("karbon:appearance-change"));
  }

  window.KarbonAppearance = Object.freeze({
    STORAGE_KEY,
    MIN_SIZE,
    MAX_SIZE,
    pages,
    getPreferences: () => ({
      ...preferences,
      pageFontSizes: { ...preferences.pageFontSizes },
    }),
    resetPreferences() {
      return window.KarbonAppearance.updatePreferences(normalize());
    },
    updatePreferences(patch) {
      preferences = normalize({ ...preferences, ...patch });
      let saved = true;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
      } catch {
        saved = false;
      }
      apply();
      return saved;
    },
  });

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      preferences = read();
      apply();
    }
  });
  // A restored document may have missed changes made in another tab/page.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      preferences = read();
      apply();
    }
  });
  apply();
})();

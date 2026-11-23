// Runs synchronously in <head> on every page, before styles and first paint.
(() => {
  const STORAGE_KEY = "karbon_appearance";
  const MIN_SIZE = 85;
  const MAX_SIZE = 125;
  const MIN_DOCK_MAGNIFICATION = 110;
  const MAX_DOCK_MAGNIFICATION = 180;
  const DEFAULT_DOCK_MAGNIFICATION = 160;
  const percentage = (value, fallback) =>
    Number.isInteger(value) && value >= 0 && value <= 100 ? value : fallback;
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
      {
        id: "reports",
        path: "/page/reports-page.html",
        label: "گزارش و خروجی",
      },
      {
        id: "report-details",
        path: "/page/report-details-page.html",
        label: "جزئیات گزارش",
      },
      { id: "settings", path: "/page/settings-page.html", label: "تنظیمات" },
      { id: "login", path: "/page/login-page.html", label: "ورود" },
    ].map(Object.freeze),
  );
  const cardTiltSections = Object.freeze([
    ...pages,
    Object.freeze({ id: "products", label: "کالاها" }),
  ]);
  const validSize = (value) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SIZE &&
    value <= MAX_SIZE &&
    value % 5 === 0;

  function normalize(value) {
    const source = value && typeof value === "object" ? value : {};
    const { dockAnimation, dockMagnification } = source;
    const pageFontSizes = {};
    const cardTiltBySection = {};
    for (const { id } of pages) {
      if (validSize(source.pageFontSizes?.[id]))
        pageFontSizes[id] = source.pageFontSizes[id];
    }
    for (const { id } of cardTiltSections) {
      const enabled = source.cardTiltBySection?.[id];
      if (typeof enabled === "boolean") cardTiltBySection[id] = enabled;
    }
    return {
      theme: ["blue", "red", "green", "black"].includes(source.theme)
        ? source.theme
        : "blue",
      fontSize: validSize(source.fontSize) ? source.fontSize : 100,
      pageFontSizes,
      cardTiltBySection,
      dockAnimation: typeof dockAnimation === "boolean" ? dockAnimation : true,
      dockMagnification:
        Number.isInteger(dockMagnification) &&
        dockMagnification >= MIN_DOCK_MAGNIFICATION &&
        dockMagnification <= MAX_DOCK_MAGNIFICATION &&
        dockMagnification % 5 === 0
          ? dockMagnification
          : DEFAULT_DOCK_MAGNIFICATION,
      dockHighlightTransparency: percentage(source.dockHighlightTransparency, 45),
      dockHighlightDarkness: percentage(source.dockHighlightDarkness, 0),
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
  function currentPage() {
    const path =
      window.location.pathname === "/"
        ? "/index.html"
        : window.location.pathname;
    return pages.find((entry) => entry.path === path)?.id;
  }

  function cardTiltEnabled(section = currentPage()) {
    return preferences.cardTiltBySection[section] !== false;
  }

  function apply() {
    const page = currentPage();
    const size = preferences.pageFontSizes[page] ?? preferences.fontSize;
    document.documentElement.dataset.theme = preferences.theme;
    // rem typography follows this value, including components loaded later.
    document.documentElement.style.fontSize = `${size}%`;
    document.documentElement.style.setProperty(
      "--app-font-scale",
      String(size / 100),
    );
    document.documentElement.style.setProperty(
      "--dock-highlight-transparency",
      `${preferences.dockHighlightTransparency}%`,
    );
    document.documentElement.style.setProperty(
      "--dock-highlight-darkness",
      `${preferences.dockHighlightDarkness}%`,
    );
    window.dispatchEvent(new CustomEvent("karbon:appearance-change"));
  }

  window.KarbonAppearance = Object.freeze({
    STORAGE_KEY,
    MIN_SIZE,
    MAX_SIZE,
    pages,
    cardTiltSections,
    cardTiltEnabled,
    getPreferences: () => ({
      ...preferences,
      pageFontSizes: { ...preferences.pageFontSizes },
      cardTiltBySection: { ...preferences.cardTiltBySection },
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

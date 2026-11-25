import { initializeNavigation } from "./navigation.js";
import { initializeDockMagnification } from "./dock-magnification.js";
import { initializeNavbarActiveHighlight } from "./navbar-active-highlight.js";
import { initializeNavbarIndicator } from "./navbar-indicator.js";
import { notify } from "./notifications.js";

const handoffKey = "karbon-navbar-handoff";

function initializeNavbar() {
  const host = document.getElementById("navbarHost");
  const navbar = host?.querySelector("#mainNavbar");
  if (!navbar) return;
  const controller = new AbortController();
  const { signal } = controller;
  const { captureZoom, restoreZoom } = initializeDockMagnification(navbar, { signal });
  initializeNavbarActiveHighlight(navbar, { signal });
  const { moveTo, captureIndicator, restoreIndicator } =
    initializeNavbarIndicator(navbar, { signal });

  window.addEventListener("pageswap", ({ activation, viewTransition }) => {
    const destination = activation?.entry?.url;
    if (!viewTransition || !destination) return;
    try {
      sessionStorage.setItem(handoffKey, JSON.stringify({
        destination,
        zoom: captureZoom(),
        indicator: captureIndicator(),
      }));
    } catch {
      // The destination can render the dock even when storage is unavailable.
    }
  }, { signal });
  window.addEventListener("pagereveal", ({ viewTransition }) => {
    if (!viewTransition) return;
    let handoff;
    try {
      handoff = JSON.parse(sessionStorage.getItem(handoffKey));
      sessionStorage.removeItem(handoffKey);
    } catch {
      return;
    }
    if (handoff?.destination !== window.location.href) return;
    restoreZoom(handoff.zoom);
    restoreIndicator(handoff.indicator);
  }, { signal });
  host.querySelector("#logoutButton").addEventListener(
    "click",
    async () => {
      const button = host.querySelector("#logoutButton");
      if (button.disabled) return;
      button.disabled = true;
      try {
        const [{ revokeSession }, { getToken, logout }] = await Promise.all([
          import("../auth/auth-api.js"),
          import("../auth/auth-storage.js"),
        ]);
        await revokeSession(getToken());
        logout();
        window.location.replace("/page/login-page.html");
      } catch (error) {
        notify(
          error.message || "ارتباط با سرور برقرار نشد. دوباره تلاش کنید.",
          { type: "error" },
        );
      } finally {
        button.disabled = false;
      }
    },
    { signal },
  );
  const reportsButton = host.querySelector("#openReportsButton");
  let openingReports = false;
  reportsButton?.addEventListener(
    "click",
    async () => {
      if (openingReports) return;
      openingReports = true;
      reportsButton.setAttribute("aria-busy", "true");
      try {
        const { openReports } = await import("../reports/reports.js");
        await openReports();
      } catch (error) {
        notify(
          error.message || "بارگذاری گزارش انجام نشد. دوباره تلاش کنید.",
          { type: "error" },
        );
      } finally {
        openingReports = false;
        reportsButton.removeAttribute("aria-busy");
      }
    },
    { signal },
  );
  const resetNavigation = initializeNavigation(navbar, {
    signal,
    onNavigate: moveTo,
    onReset: () => moveTo(navbar.querySelector('[aria-current="page"]')),
  });
  const links = [...navbar.querySelectorAll("a")];
  const title = host.querySelector(".navbar-page-title");
  const clock = host.querySelector(".navbar-clock");
  const formatter = new Intl.DateTimeFormat("en-US", {
    calendar: "persian",
    numberingSystem: "latn",
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let timer;
  let currentPath;

  function updateRoute() {
    const path = window.location.pathname;
    if (path === currentPath) return;
    currentPath = path;
    const activePath =
      path === "/"
        ? "/index.html"
        : path === "/page/bank-transactions-page.html"
          ? "/page/banks-page.html"
          : path === "/page/report-details-page.html"
            ? "/page/reports-page.html"
            : path;
    let activeLink;
    links.forEach((link) => {
      if (link.getAttribute("href") === activePath) {
        if (!link.hasAttribute("aria-current")) link.setAttribute("aria-current", "page");
        activeLink = link;
      } else link.removeAttribute("aria-current");
    });
    moveTo(activeLink);
    const label =
      path === "/page/bank-transactions-page.html"
        ? "تراکنش‌های حساب"
        : path === "/page/report-details-page.html"
          ? "جزئیات گزارش"
          : activeLink?.getAttribute("aria-label") ||
            document.title.split("|").pop().trim();
    if (title.textContent !== label) title.textContent = label;
    if (title.title !== label) title.title = label;
  }

  function updateClock() {
    if (!navbar.isConnected) {
      cleanup();
      return;
    }
    const now = new Date();
    const parts = Object.fromEntries(
      formatter.formatToParts(now).map(({ type, value }) => [type, value]),
    );
    const value = `${parts.year.padStart(4, "0")}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    if (clock.textContent !== value) {
      clock.textContent = value;
      clock.dateTime = now.toISOString();
      clock.setAttribute("aria-label", `تاریخ و ساعت تهران: ${value}`);
    }
  }

  function stopClock() {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  }

  function startClock() {
    updateRoute();
    updateClock();
    if (!document.hidden && timer === undefined)
      timer = window.setInterval(updateClock, 1000);
  }

  function cleanup() {
    stopClock();
    resetNavigation();
    controller.abort();
  }

  window.addEventListener("popstate", updateRoute, { signal });
  window.addEventListener("pagehide", stopClock, { signal });
  window.addEventListener("pageshow", startClock, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) stopClock();
      else startClock();
    },
    { signal },
  );
  startClock();
}

initializeNavbar();

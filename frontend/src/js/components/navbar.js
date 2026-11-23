import { initializeNavigation } from "./navigation.js";
import { initializeDockMagnification } from "./dock-magnification.js";
import { initializeNavbarActiveHighlight } from "./navbar-active-highlight.js";
import { notify } from "./notifications.js";
import { getToken, logout } from "../auth/auth-storage.js";

import { revokeSession } from "../auth/auth-api.js";

let cleanupNavbar;

export function initializeNavbar() {
  const host = document.getElementById("navbarHost");
  if (!host) return;
  if (host.querySelector("#mainNavbar") && cleanupNavbar) return cleanupNavbar;
  cleanupNavbar?.();
  if (!host.querySelector("#mainNavbar")) return;
  const navbar = host.querySelector("nav");
  const controller = new AbortController();
  const { signal } = controller;
  initializeDockMagnification(navbar, { signal });
  initializeNavbarActiveHighlight(navbar, { signal });
  host.querySelector("#logoutButton").addEventListener(
    "click",
    async () => {
      const button = host.querySelector("#logoutButton");
      if (button.disabled) return;
      button.disabled = true;
      try {
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
  const resetNavigation = initializeNavigation(navbar, { signal });
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
        link.setAttribute("aria-current", "page");
        activeLink = link;
      } else link.removeAttribute("aria-current");
    });
    const label =
      path === "/page/bank-transactions-page.html"
        ? "تراکنش‌های حساب"
        : path === "/page/report-details-page.html"
          ? "جزئیات گزارش"
          : activeLink?.getAttribute("aria-label") ||
            document.title.split("|").pop().trim();
    title.textContent = label;
    title.title = label;
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
    // A history snapshot may outlive logout or a login in another tab.
    if (!getToken()) {
      window.location.replace("/page/login-page.html");
      return;
    }
    updateRoute();
    updateClock();
    if (!document.hidden && timer === undefined)
      timer = window.setInterval(updateClock, 1000);
  }

  function cleanup() {
    stopClock();
    resetNavigation();
    controller.abort();
    if (cleanupNavbar === cleanup) cleanupNavbar = undefined;
  }
  cleanupNavbar = cleanup;

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
  return cleanup;
}

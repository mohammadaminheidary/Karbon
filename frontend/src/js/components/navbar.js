import { initializeNavigation } from "./navigation.js";
import { getToken, logout } from "../auth/auth-storage.js";

let cleanupNavbar;

export function initializeNavbar() {
  const host = document.getElementById("navbarHost");
  if (!host) return;
  if (host.querySelector("#mainNavbar") && cleanupNavbar) return cleanupNavbar;
  cleanupNavbar?.();
  if (!host.querySelector("#mainNavbar")) return;
  const navbar = host.querySelector("nav");
  const pageToken = getToken();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let pulse;
  const glass = navbar.querySelector(".navbar-glass");
  const controller = new AbortController();
  const { signal } = controller;
  host.querySelector("#logoutButton").addEventListener(
    "click",
    () => {
      logout();
      window.location.replace("/page/login-page.html");
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
    if (getToken() !== pageToken) {
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
    pulse?.cancel();
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

  function animateGlass(event) {
    if (
      reducedMotion.matches ||
      !glass.animate ||
      !event.target.closest(".navbar-item") ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    // Let an existing spring settle rather than snapping it back on rapid clicks.
    if (pulse?.playState === "running") return;
    pulse = glass.animate(
      [
        // Quick expansion, then a damped return with no oscillation past rest.
        {
          transform: "scaleX(1)",
          offset: 0,
          easing: "cubic-bezier(.2,.75,.25,1)",
        },
        {
          transform: "scaleX(1.022)",
          offset: 0.24,
          easing: "cubic-bezier(.25,0,.2,1)",
        },
        { transform: "scaleX(1)", offset: 1 },
      ],
      { duration: 300, easing: "linear" },
    );
  }

  // Feedback starts on press. Native links and logout handlers run immediately.
  navbar.addEventListener("pointerdown", animateGlass, {
    passive: true,
    signal,
  });
  navbar.addEventListener(
    "click",
    (event) => {
      if (event.detail === 0) animateGlass(event); // Keyboard activation.
    },
    { passive: true, signal },
  );
  reducedMotion.addEventListener(
    "change",
    () => {
      if (reducedMotion.matches) pulse?.cancel();
    },
    { signal },
  );
  return cleanup;
}

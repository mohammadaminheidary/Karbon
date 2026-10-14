const template = `
  <div class="navbar-dock">
  <section class="navbar-info navbar-title-island" aria-label="صفحه فعلی">
    <span class="navbar-glass" aria-hidden="true"></span>
    <span class="navbar-page-title" aria-live="polite"></span>
  </section>
  <nav id="mainNavbar" class="glass-navbar" aria-label="ناوبری اصلی">
    <span class="navbar-glass" aria-hidden="true"></span>
    <div class="navbar-items">
    <a href="/index.html" class="navbar-item" aria-label="داشبورد">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">داشبورد</span>
    </a>
    <a href="/page/customers-page.html" class="navbar-item" aria-label="مشتریان">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"
            />
            <circle cx="9" cy="7" r="4" />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">مشتریان</span>
    </a>
    <a href="#" class="navbar-item" aria-label="سفارشات">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 2h12l2 4v16H4V6l2-4Z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M4 6h16M9 10h6"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">سفارشات</span>
    </a>
    <a href="/page/finance-page.html" class="navbar-item" aria-label="مالی">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path stroke-linecap="round" d="M3 10h18M7 15h3" />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">مالی</span>
    </a>
    <a href="/page/attendance-page.html" class="navbar-item" aria-label="ورودی اعضا">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m10 17 5-5-5-5M15 12H3"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">ورودی اعضا</span>
    </a>
    <a href="#" class="navbar-item" aria-label="کارهای روزانه">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path stroke-linecap="round" d="M8 2v4M16 2v4M3 10h18" />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m8 15 2 2 5-5"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">کارهای روزانه</span>
    </a>
    <a href="#" class="navbar-item" aria-label="ثبت سند">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M14 2v6h6M8 13h8M8 17h5"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">ثبت سند</span>
    </a>
    <a href="#" class="navbar-item" aria-label="گزارشات">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M4 19V5M4 19h16"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m7 15 4-5 3 3 5-7"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">گزارشات</span>
    </a>
    <a href="/page/banks-page.html" class="navbar-item" aria-label="بانک ها">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m3 10 9-7 9 7"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M5 10h14M5 21h14M7 10v8M12 10v8M17 10v8M3 21h18"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">بانک ها</span>
    </a>
    <a href="/page/settings-page.html" class="navbar-item" aria-label="تنظیمات">
      <svg
            class="navbar-icon" aria-hidden="true"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.9 1.9-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-2.7v-.1a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.9-1.9.06-.06A1.7 1.7 0 0 0 7.76 15a1.7 1.7 0 0 0-1.56-1.03H6v-2.7h.2a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.9-1.9.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 12.23 5.2V5h2.7v.2a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.9 1.9-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.96 11H21v2.7h-.2A1.7 1.7 0 0 0 19.4 15Z"
            />
          </svg>
      <span class="navbar-tooltip" aria-hidden="true">تنظیمات</span>
    </a>
    <button type="button" id="logoutButton" class="navbar-item navbar-logout" aria-label="خروج از حساب">
      <svg
              class="navbar-icon" aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m10 17 5-5-5-5M15 12H3"
              />
            </svg>
      <span class="navbar-tooltip" aria-hidden="true">خروج از حساب</span>
    </button>
    </div>
  </nav>
  <section class="navbar-info navbar-clock-island" aria-label="تاریخ و ساعت">
    <span class="navbar-glass" aria-hidden="true"></span>
    <time class="navbar-clock" dir="ltr" aria-live="off" aria-label="تاریخ و ساعت تهران"></time>
  </section>
  </div>
`;

let cleanupNavbar;

export function initializeNavbar() {
  const host = document.getElementById("navbarHost");
  if (!host) return;
  if (host.querySelector("#mainNavbar")) return cleanupNavbar;
  cleanupNavbar?.();
  if (host.children.length) return;
  host.innerHTML = template;
  const dock = host.querySelector(".navbar-dock");
  const navbar = host.querySelector("nav");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let pulse;
  const glass = navbar.querySelector(".navbar-glass");
  const controller = new AbortController();
  const { signal } = controller;
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
    updateRoute();
    updateClock();
    if (!document.hidden && timer === undefined)
      timer = window.setInterval(updateClock, 1000);
  }

  function cleanup() {
    stopClock();
    pulse?.cancel();
    controller.abort();
    dock.remove();
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

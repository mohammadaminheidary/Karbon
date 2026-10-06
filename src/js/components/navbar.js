const template = `
    <aside
      id="mainNavbar"
      class="fixed top-0 right-0 z-50 flex h-screen w-72 overflow-y-auto transition-transform duration-200 translate-x-full lg:translate-x-0 shrink-0 flex-col border-l border-french-gray/40 bg-white px-5 py-6"
    >
      <!-- Logo -->
      <div class="mb-6 flex items-center justify-center gap-3 px-3">
        <!-- Brand Name -->
        <h1 class="text-2xl font-bold tracking-[0.7rem] text-mirage">Karbon</h1>
      </div>

      <!-- Navigation -->
      <nav class="flex flex-1 flex-col gap-2">
        <!-- Dashboard -->
        <a
          href="/index.html"
          class="flex items-center gap-3 rounded-xl bg-persian-blue/10 px-4 py-3 text-sm font-semibold text-persian-blue transition-colors duration-300"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>داشبورد</span>
        </a>

        <!-- Customers -->
        <a
          href="/page/customers-page.html"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>مشتریان</span>
        </a>

        <!-- Orders -->
        <a
          href="#"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>سفارشات</span>
        </a>

        <!-- Finance -->
        <a
          href="/page/finance-page.html"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path stroke-linecap="round" d="M3 10h18M7 15h3" />
          </svg>

          <span>مالی</span>
        </a>

        <!-- Member Entry -->
        <!-- Member Entry -->
        <a
          href="/page/attendance-page.html"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>ورودی اعضا</span>
        </a>

        <!-- Daily Tasks -->
        <a
          href="#"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>کارهای روزانه</span>
        </a>

        <!-- Documents -->
        <a
          href="#"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>ثبت سند</span>
        </a>

        <!-- Reports -->
        <a
          href="#"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>گزارشات</span>
        </a>

        <!-- Banks -->
        <a
          href="/page/banks-page.html"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>بانک ها</span>
        </a>

        <!-- Settings -->
        <a
          href="/page/settings-page.html"
          class="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
        >
          <svg
            class="h-5 w-5 shrink-0"
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

          <span>تنظیمات</span>
        </a>
      </nav>

      <!-- User Profile -->
      <div class="mt-5 border-t border-french-gray/40 pt-4">
        <div
          class="flex flex-col items-center gap-3 rounded-2xl bg-alabaster px-4 py-3"
        >
          <!-- User Image Placeholder -->
          <div
            class="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-french-gray/40 text-2xl font-bold text-mirage"
          >
            <span>م</span>
          </div>

          <!-- User Information -->
          <div class="text-center">
            <h2 class="text-sm font-bold text-mirage">حساب کاربری</h2>

            <p class="mt-1 text-xs text-mirage/50">Karbon</p>
          </div>

          <!-- User Action -->
          <button
            type="button"
            id="logoutButton"
            class="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-french-gray/50 bg-white px-3 py-2 text-xs font-medium text-mirage/70 transition-colors duration-300 hover:bg-persian-blue/10 hover:text-persian-blue"
          >
            <svg
              class="h-4 w-4"
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

            <span>خروج از حساب</span>
          </button>
        </div>
      </div>
    </aside>
`;

export function initializeNavbar() {
  const host = document.getElementById("navbarHost");
  if (!host || host.children.length) return;
  host.innerHTML =
    template +
    `
    <button id="navbarBackdrop" class="fixed inset-0 z-40 hidden bg-mirage/50 lg:hidden" aria-label="بستن فهرست"></button>
    <button id="navbarToggle" type="button" class="fixed right-4 top-4 z-40 rounded-xl bg-mirage px-4 py-2 text-white lg:hidden" aria-label="باز کردن فهرست" aria-controls="mainNavbar" aria-expanded="false">☰</button>`;
  const sidebar = host.querySelector("aside");
  const toggle = host.querySelector("#navbarToggle");
  const backdrop = host.querySelector("#navbarBackdrop");
  const mobile = window.matchMedia("(max-width: 1023px)");
  function setOpen(open) {
    sidebar.classList.toggle("translate-x-full", !open);
    backdrop.classList.toggle("hidden", !open || !mobile.matches);
    toggle.setAttribute("aria-expanded", String(open));
    sidebar.inert = mobile.matches && !open;
    if (open) sidebar.querySelector("a")?.focus();
  }
  host.querySelectorAll("nav a").forEach((link) => {
    const active = link.getAttribute("href") === window.location.pathname;
    link.className = active
      ? "flex items-center gap-3 rounded-xl bg-persian-blue/10 px-4 py-3 text-sm font-semibold text-persian-blue transition-colors"
      : "flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-mirage/70 transition-colors hover:bg-persian-blue/10 hover:text-persian-blue";
    if (active) link.setAttribute("aria-current", "page");
  });
  toggle.addEventListener("click", () => setOpen(true));
  backdrop.addEventListener("click", () => {
    setOpen(false);
    toggle.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      mobile.matches &&
      toggle.getAttribute("aria-expanded") === "true"
    ) {
      setOpen(false);
      toggle.focus();
    }
  });
  mobile.addEventListener("change", () => setOpen(false));
  setOpen(false);
}

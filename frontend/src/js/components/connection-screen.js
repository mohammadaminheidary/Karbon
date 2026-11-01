// A native top-layer modal keeps existing dialogs, drafts and page state intact.
let screen;
let previousFocus;

export function showConnectionScreen(retry, checking = false) {
  if (!screen) {
    screen = document.createElement("dialog");
    screen.id = "connectionLost";
    screen.className = "connection-screen";
    screen.setAttribute("closedby", "none");
    screen.dir = "rtl";
    screen.setAttribute("aria-labelledby", "connectionTitle");
    screen.setAttribute("aria-describedby", "connectionDescription");
    screen.innerHTML = `
      <div class="connection-atmosphere" aria-hidden="true">
        <span class="connection-orb connection-orb-one"></span>
        <span class="connection-orb connection-orb-two"></span>
        <span class="connection-orb connection-orb-three"></span>
        <span class="connection-orb connection-orb-four"></span>
        <span class="connection-glitch" dir="ltr">404</span>
      </div>
      <header class="connection-header">
        <span class="connection-brand" lang="en" dir="ltr"><span class="connection-brand-mark" aria-hidden="true">k</span>karbon<span class="connection-brand-dot">.</span></span>
        <span class="connection-label">فضای کار شما، محفوظ است</span>
      </header>
      <div class="connection-content">
        <div class="connection-illustration" aria-hidden="true">
          <span class="connection-orbit connection-orbit-outer"></span>
          <span class="connection-orbit connection-orbit-inner"></span>
          <span class="connection-satellite connection-satellite-one"></span>
          <span class="connection-satellite connection-satellite-two"></span>
          <span class="connection-icon">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <rect x="10" y="8" width="28" height="13" rx="4" />
              <path d="M16 14.5h.01M22 14.5h10M17 27h-3a4 4 0 0 0-4 4v5a4 4 0 0 0 4 4h20a4 4 0 0 0 4-4v-5a4 4 0 0 0-4-4h-3M16 33.5h.01M29 33.5h3M26 24l-5 6m1-8 5 2-1 5" />
            </svg>
          </span>
        </div>
        <span class="connection-eyebrow" lang="en" dir="ltr">LET’S RECONNECT</span>
        <h1 id="connectionTitle">ارتباط با سرور قطع شد</h1>
        <p id="connectionDescription">کمی مکث، تا دوباره به هم وصل شویم.<br />به‌محض برقراری ارتباط، به همین‌جا برمی‌گردید.</p>
        <button id="retryConnection" class="connection-retry" type="button">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" /></svg>
          <span>تلاش مجدد برای اتصال</span>
        </button>
        <p id="connectionStatus" class="connection-status" role="status" aria-live="polite" aria-atomic="true"></p>
      </div>
      <footer class="connection-footer">
        <span class="connection-preserved"><svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5 16 5v4c0 4-6 7.5-6 7.5S4 13 4 9V5l6-2.5Z"/><path d="m7.5 9.5 1.7 1.7 3.3-3.4"/></svg>اطلاعات واردشده در این صفحه حفظ می‌شود</span>
        <span class="connection-footer-note">اتصال خودکار، بدون بارگذاری دوباره</span>
      </footer>`;
    screen.addEventListener("cancel", (event) => event.preventDefault());
    screen.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    screen.querySelector("button").addEventListener("click", () => {
      if (screen.dataset.checking !== "true") void retry();
    });
    document.body.append(screen);
  }
  screen.dataset.checking = String(checking);
  screen
    .querySelector("button")
    .setAttribute("aria-disabled", String(checking));
  screen.querySelector("button span").textContent = checking
    ? "در حال بررسی اتصال…"
    : "تلاش مجدد برای اتصال";
  screen.querySelector("#connectionStatus").textContent = checking
    ? "در حال برقراری ارتباط با سرور"
    : "اتصال به‌صورت خودکار بررسی می‌شود";
  if (!screen.open) {
    previousFocus = document.activeElement;
    screen.showModal();
    screen.querySelector("button").focus({ preventScroll: true });
  }
}

export function hideConnectionScreen() {
  if (!screen?.open) return;
  screen.close();
  if (previousFocus?.isConnected && !previousFocus.disabled)
    previousFocus.focus({ preventScroll: true });
  previousFocus = undefined;
}

import { createNavbarPanelTransition } from "../documents/navbar-panel-transition.js";
import { getInventoryOptions } from "./inventory-options.js";
import { onPageRefresh } from "../components/data-events.js";
import { bindStrictAmount } from "../finance/finance-utils.js";

const $ = (id) => document.getElementById(id);

// Keep one timestamp per entry, including when options are refreshed or the
// panel is reopened. All date/time components use Karbon's Tehran timezone.
export function purchaseIdentity(
  now = new Date(),
  unique = crypto.randomUUID(),
) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tehran",
      calendar: "persian",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}/${parts.month}/${parts.day}`,
    number: `PUR-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${unique}`,
  };
}

export function initializePurchaseEntry() {
  const panel = $("purchaseEntryPage");
  const warehouse = document.querySelector(".warehouse");
  const trigger = $("buyItemsButton");
  const form = $("purchaseEntryForm");
  const navbar = $("mainNavbar");
  let opened = false,
    identity,
    closing,
    sequence = 0,
    requestVersion = 0;

  function newEntry() {
    form.reset();
    identity = purchaseIdentity();
    $("purchaseDate").value = identity.date;
    $("purchaseInvoiceNumber").value = identity.number;
  }

  async function refreshOptions() {
    if (!opened) return;
    const version = ++requestVersion;
    panel.setAttribute("aria-busy", "true");
    const status = $("purchaseOptionsStatus");
    status.textContent = "در حال دریافت گزینه‌های تنظیمات…";
    status.setAttribute("role", "status");
    $("reloadPurchaseOptions").disabled = true;
    const fields = [$("purchaseCategory"), $("purchaseUnit")];
    fields.forEach((field) => (field.disabled = true));
    try {
      const options = await getInventoryOptions();
      if (version !== requestVersion || !opened) return;
      const missing = [];
      for (const [index, kind, label] of [
        [0, "categories", "دسته‌بندی"],
        [1, "units", "واحد"],
      ]) {
        const field = fields[index],
          selected = field.value;
        const active = options[kind].filter((item) => item.active);
        field.replaceChildren(
          new Option(
            active.length
              ? `انتخاب ${label}`
              : `ابتدا ${label} را در تنظیمات تعریف کنید`,
            "",
          ),
          ...active.map((item) => new Option(item.name, String(item.id))),
        );
        if (active.some((item) => String(item.id) === selected))
          field.value = selected;
        field.disabled = active.length === 0;
        if (!active.length) missing.push(label);
      }
      status.textContent = missing.length
        ? `${missing.join(" و ")} فعالی تعریف نشده است. از بخش تنظیمات اضافه کنید.`
        : "";
    } catch (error) {
      if (version !== requestVersion || !opened) return;
      status.textContent = error.message;
      status.setAttribute("role", "alert");
    } finally {
      if (version === requestVersion) {
        panel.setAttribute("aria-busy", "false");
        $("reloadPurchaseOptions").disabled = false;
      }
    }
  }

  // Match NavbarPanelDialog.position() and its shared registration-panel CSS.
  // The purchase surface remains a section, with no dialog or modal backdrop.
  function position() {
    const rect = navbar.getBoundingClientRect();
    panel.style.setProperty("--task-curtain-width", `${rect.width}px`);
    const width = panel.getBoundingClientRect().width || window.innerWidth - 32;
    const bottom = Math.max(12, window.innerHeight - rect.bottom);
    panel.style.setProperty(
      "--task-curtain-left",
      `${(window.innerWidth - width) / 2}px`,
    );
    panel.style.setProperty("--task-navbar-height", `${rect.height}px`);
    panel.style.setProperty("--task-curtain-bottom", `${bottom}px`);
    panel.style.setProperty(
      "--task-form-height",
      `${Math.min(form.scrollHeight, window.innerHeight - bottom - 16)}px`,
    );
  }

  const transition = createNavbarPanelTransition(panel, {
    position,
    show: () => {
      panel.hidden = false;
      panel.inert = false;
      panel.setAttribute("aria-hidden", "false");
      warehouse.inert = true;
      document.body.classList.add("overflow-hidden");
    },
    hide: () => {
      panel.hidden = true;
      panel.inert = true;
      panel.setAttribute("aria-hidden", "true");
      warehouse.inert = false;
      document.body.classList.remove("overflow-hidden");
      trigger.focus({ preventScroll: true });
    },
  });
  const observer = new ResizeObserver(() => {
    if (transition.active && !closing) position();
  });
  observer.observe(form);

  async function reveal(show) {
    const current = ++sequence;
    if (show) {
      // Finish a pending collapse before reopening. Reference data never gates
      // the shared transition, so the navbar responds on the next frame.
      await closing;
      if (current !== sequence || !opened) return;
      if (!identity) newEntry();
      const revealing = transition.open();
      void refreshOptions();
      await revealing;
      if (current === sequence && opened && transition.active)
        $("purchaseItemName").focus({ preventScroll: true });
    } else {
      requestVersion++;
      panel.setAttribute("aria-busy", "false");
      closing = transition.close();
      await closing;
      closing = undefined;
    }
  }

  function syncRoute() {
    const next = location.hash === "#purchase";
    if (next === opened) return;
    opened = next;
    trigger.setAttribute("aria-expanded", String(opened));
    void reveal(opened);
  }

  function close() {
    if (!opened) return;
    history.replaceState(null, "", location.pathname + location.search);
    syncRoute();
  }
  trigger.addEventListener("click", () => {
    if (opened) return;
    location.hash = "purchase";
  });
  $("closePurchaseEntry").addEventListener("click", close);
  $("newPurchaseEntry").addEventListener("click", () => {
    newEntry();
    $("purchaseItemName").focus();
  });
  $("reloadPurchaseOptions").addEventListener("click", refreshOptions);
  form.addEventListener("submit", (event) => event.preventDefault());
  bindStrictAmount($("purchasePrice"));
  window.addEventListener("hashchange", syncRoute);
  window.addEventListener("popstate", syncRoute);
  document.addEventListener("keydown", (event) => {
    if (opened && event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  // The shared transition settles on pagehide; restore a hash entry when the
  // browser revives this document from its Back/Forward cache.
  window.addEventListener("pagehide", () => {
    opened = false;
    sequence++;
    requestVersion++;
    panel.setAttribute("aria-busy", "false");
    trigger.setAttribute("aria-expanded", "false");
  });
  window.addEventListener("pageshow", syncRoute);
  onPageRefresh(refreshOptions, { isVisible: () => opened });
  syncRoute();
}

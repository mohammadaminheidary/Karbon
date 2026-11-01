import { startPage } from "../components/page-ready.js";
import { initializeNavbar } from "../components/navbar.js";
import { createNavbarNotification } from "../components/navbar-notification.js";
import { onPageRefresh } from "../components/data-events.js";
import { protectPage } from "../guards/auth-guard.js";
import { financeRequest } from "../finance/finance-api.js";
import { node, fullDate } from "../finance/finance-utils.js";
import { initializeDocumentDialogs } from "../documents/document-dialogs.js";

initializeNavbar();
const $ = (id) => document.getElementById(id);
const titleIsland = document.querySelector(".navbar-title-island");
const notify = createNavbarNotification(titleIsland);
const number = new Intl.NumberFormat("fa-IR");
const pageSize = 15;
let items = [],
  dates = [],
  filteredTotal = 0,
  total = 0,
  nextOffset = 0,
  filters = {},
  controller,
  debounce;
let loading = false,
  documentsLoaded = false,
  failed = false,
  ready = false,
  pendingRefresh = false;
const dialogs = initializeDocumentDialogs({
  notify,
  onIdle: () => {
    if (pendingRefresh) void refresh();
  },
  onChanged: async ({ reset }) => {
    if (reset) {
      $("documentFilters").reset();
    } else
      await loadDocuments({
        reset: true,
        visibleCount: Math.max(pageSize, items.length),
      });
  },
});

function renderCard(item) {
  const wrapper = node("div");
  wrapper.setAttribute("role", "listitem");
  const card = node(
    "button",
    "group w-full cursor-pointer rounded-xl border border-french-gray/30 bg-white px-4 py-3 text-right transition duration-200 hover:border-persian-blue/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-persian-blue/20",
  );
  card.type = "button";
  card.dataset.documentId = item.id;
  card.setAttribute("aria-label", `مشاهده جزئیات سند ${item.number}`);
  card.setAttribute("aria-haspopup", "dialog");
  const heading = node(
    "div",
    "flex flex-wrap items-start justify-between gap-3",
  );
  heading.append(
    node(
      "h3",
      "min-w-0 max-w-full break-words text-sm font-bold text-mirage",
      `سند ${item.number}`,
    ),
    node(
      "span",
      "max-w-full break-words rounded-full bg-persian-blue/5 px-2.5 py-1 text-[0.625rem] font-bold text-persian-blue",
      item.document_type,
    ),
  );
  const content = node(
    "div",
    "my-2.5 grid gap-x-4 gap-y-1.5 text-xs text-mirage/60 sm:grid-cols-2",
  );
  const date = node("time", "", fullDate(item.date));
  date.dateTime = item.date;
  content.append(date, node("p", "truncate", item.description || "بدون شرح"));
  card.append(
    heading,
    content,
    node(
      "p",
      "mt-2 border-t border-french-gray/25 pt-2 text-[0.625rem] text-mirage/35 group-hover:text-persian-blue",
      "برای مشاهده جزئیات روی کارت کلیک کنید!",
    ),
  );
  card.addEventListener("click", () => dialogs.openDetails(item.id));
  wrapper.append(card);
  return wrapper;
}

function setMetadata(data) {
  const selectedType = $("documentTypeFilter").value;
  $("documentTypeFilter").replaceChildren(
    new Option("همه انواع", ""),
    ...data.document_types.map((type) => new Option(type, type)),
  );
  if (selectedType && !data.document_types.includes(selectedType))
    $("documentTypeFilter").add(new Option(selectedType, selectedType));
  $("documentTypeFilter").value = selectedType;
  dates = data.available_dates;
  for (const [id, label] of [
    ["documentStartDate", "ابتدای بازه"],
    ["documentEndDate", "انتهای بازه"],
  ]) {
    const selected = $(id).value;
    $(id).replaceChildren(
      new Option(label, ""),
      ...dates.map((date) => new Option(fullDate(date), date)),
    );
    // Retain an active boundary after the last document on that date is deleted.
    if (selected && !dates.includes(selected))
      $(id).add(new Option(fullDate(selected), selected));
    $(id).value = selected;
    $(id).disabled = dates.length === 0 && !selected;
  }
  updateRange();
}
function updateRange() {
  const max = Math.max(0, dates.length - 1);
  const start = $("documentStartDate").value,
    end = $("documentEndDate").value;
  const from = start
    ? Math.max(
        0,
        dates.findIndex((date) => date >= start),
      )
    : 0;
  const to = end
    ? Math.max(
        0,
        dates.findLastIndex((date) => date <= end),
      )
    : max;
  for (const [id, value] of [
    ["documentRangeFrom", from],
    ["documentRangeTo", to],
  ]) {
    $(id).max = max;
    $(id).value = value;
    $(id).disabled = dates.length < 2;
    $(id).setAttribute(
      "aria-valuetext",
      dates[value] ? fullDate(dates[value]) : "تاریخی ثبت نشده است",
    );
  }
  $("documentRangeFill").style.left = `${max ? (from / max) * 100 : 0}%`;
  $("documentRangeFill").style.right = `${max ? 100 - (to / max) * 100 : 0}%`;
  // Keep the first thumb reachable when both are at the upper boundary.
  $("documentRangeFrom").style.zIndex = from === max ? "2" : "0";
}

async function loadDocuments({ reset = false, visibleCount = pageSize } = {}) {
  if (!ready) return;
  if (!reset && (loading || failed || nextOffset >= filteredTotal)) return;
  if (reset) controller?.abort();
  const current = new AbortController();
  controller = current;
  loading = true;
  failed = false;
  pendingRefresh = false;
  $("documentCards").setAttribute("aria-busy", "true");
  $("documentsError").classList.add("hidden");
  if (reset && !documentsLoaded) {
    $("documentsStatus").classList.remove("hidden");
    $("documentsStatus").textContent = "در حال دریافت اسناد...";
  }
  if (!documentsLoaded) $("documentPage").textContent = "در حال دریافت اسناد...";
  const nextItems = reset ? [] : [...items];
  let offset = reset ? 0 : nextOffset;
  let data;
  try {
    do {
      const params = new URLSearchParams({
        ...filters,
        skip: offset,
        limit: pageSize,
      });
      data = await financeRequest(`/documents?${params}`, {
        signal: current.signal,
      });
      if (current.signal.aborted) return;
      offset += data.items.length;
      const seen = new Set(nextItems.map((item) => item.id));
      const batch = data.items.filter((item) => !seen.has(item.id));
      nextItems.push(...batch);
      if (!data.items.length) {
        offset = data.filtered_total;
        break;
      }
    } while (
      reset &&
      nextItems.length < visibleCount &&
      offset < data.filtered_total
    );
    const unchanged = JSON.stringify(items) === JSON.stringify(nextItems);
    items = nextItems;
    documentsLoaded = true;
    nextOffset = offset;
    filteredTotal = data.filtered_total;
    total = data.total;
    $("documentTotal").textContent = number.format(total);
    setMetadata(data);
    if (!unchanged) $("documentCards").replaceChildren(...items.map(renderCard));
    $("documentsStatus").classList.toggle("hidden", items.length > 0);
    $("documentsStatus").textContent =
      total === 0 ? "هنوز سندی ثبت نشده است." : "سندی با این فیلترها پیدا نشد.";
    $("documentPage").textContent =
      `${number.format(items.length)} از ${number.format(filteredTotal)} سند${items.length >= filteredTotal && items.length ? " · همه اسناد نمایش داده شد" : ""}`;
  } catch (error) {
    if (current.signal.aborted) return;
    failed = true;
    $("documentsStatus").classList.add("hidden");
    $("documentsErrorMessage").textContent = error.message;
    $("documentsError").classList.remove("hidden");
    $("documentPage").textContent = "";
  } finally {
    if (controller === current) {
      loading = false;
      $("documentCards").setAttribute("aria-busy", "false");
      if (pendingRefresh) void refresh();
      else if (!failed && !current.signal.aborted)
        requestAnimationFrame(maybeLoadMore);
    }
  }
}
function maybeLoadMore() {
  if (
    !document.hidden &&
    !dialogs.busy &&
    !$("documentCurtain").open &&
    $("documentSentinel").getBoundingClientRect().top < window.innerHeight + 240
  )
    void loadDocuments();
}
function refresh() {
  if (dialogs.busy || $("documentCurtain").open || loading) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  return loadDocuments({
    reset: true,
    visibleCount: Math.max(pageSize, items.length),
  });
}
function applyFilters() {
  clearTimeout(debounce);
  const start = $("documentStartDate").value,
    end = $("documentEndDate").value;
  updateRange();
  if (start && end && start > end) {
    $("documentFilterError").textContent =
      "تاریخ شروع نباید بعد از تاریخ پایان باشد.";
    $("documentFilterError").classList.remove("hidden");
    return;
  }
  filters = {};
  if ($("documentSearch").value.trim())
    filters.search = $("documentSearch").value.trim();
  if (start) filters.start_date = start;
  if (end) filters.end_date = end;
  if ($("documentTypeFilter").value)
    filters.document_type = $("documentTypeFilter").value;
  $("documentFilterError").classList.add("hidden");
  void loadDocuments({ reset: true });
}

async function initialize() {
  if (!(await protectPage())) return;
  ready = true;
  $("registerDocument").disabled = false;
  $("registerDocument").setAttribute("aria-haspopup", "dialog");
  $("registerDocument").setAttribute("aria-controls", "documentCurtain");
  $("documentFilterToggle").addEventListener("click", () => {
    const open =
      $("documentFilterToggle").getAttribute("aria-checked") !== "true";
    $("documentFilterToggle").setAttribute("aria-checked", String(open));
    $("documentFilterPanel").inert = !open;
    $("documentFilterPanel").classList.toggle("is-open", open);
  });
  $("documentFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    applyFilters();
  });
  $("documentSearch").addEventListener("input", () => {
    clearTimeout(debounce);
    controller?.abort();
    debounce = setTimeout(applyFilters, 300);
  });
  ["documentTypeFilter", "documentStartDate", "documentEndDate"].forEach((id) =>
    $(id).addEventListener("change", applyFilters),
  );
  for (const [id, select, other, isFrom] of [
    ["documentRangeFrom", "documentStartDate", "documentRangeTo", true],
    ["documentRangeTo", "documentEndDate", "documentRangeFrom", false],
  ]) {
    $(id).addEventListener("input", () => {
      const index = Number($(id).value),
        bound = Number($(other).value);
      $(select).value = dates[index] || "";
      if (isFrom ? index > bound : index < bound)
        $(isFrom ? "documentEndDate" : "documentStartDate").value =
          dates[index];
      updateRange();
    });
    $(id).addEventListener("change", applyFilters);
  }
  $("documentFilters").addEventListener("reset", () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyFilters, 0);
  });
  $("retryDocuments").addEventListener("click", () => {
    failed = false;
    void loadDocuments({ reset: items.length === 0 });
  });
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) maybeLoadMore();
    },
    { rootMargin: "240px" },
  );
  observer.observe($("documentSentinel"));
  // A deferred external refresh can resume when an editor or confirmation closes.
  $("documentCurtain").addEventListener("close", () => {
    if (pendingRefresh) void refresh();
    else maybeLoadMore();
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(debounce);
    controller?.abort();
    observer.disconnect();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      observer.observe($("documentSentinel"));
    }
  });
  const requestedDocument = new URLSearchParams(window.location.search).get(
    "document",
  );
  if (/^[1-9]\d*$/.test(requestedDocument || ""))
    void dialogs.openDetails(Number(requestedDocument));
  onPageRefresh(() => {
    dialogs.refreshOptions();
    return refresh();
  });
  await loadDocuments({ reset: true });
}
startPage(initialize);

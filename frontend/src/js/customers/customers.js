import { onPageRefresh } from "../components/data-events.js";
import { Dialog } from "../components/dialog.js";
import { notify } from "../components/notifications.js";
import { createSpinner } from "../components/loader.js";
import { getCustomers, getCustomer, deleteCustomer } from "./customer-api.js";
import { mountCustomerPaymentHistory } from "./customer-payments.js";
import { mountCustomerInvoices } from "./customer-invoices.js";
import { disintegrateCustomerCard } from "./customer-card-animation.js";
import {
  initializeCustomerModal,
  openCreateCustomerModal,
  openEditCustomerModal,
} from "./customer-modal.js";
import {
  element,
  fullName,
  genderLabel,
  formatDate,
  formatJalaliInput,
  formatNumber,
  statusMeta,
  createSummary,
  systemCustomerLabel,
} from "./customer-utils.js";

const get = (id) => document.getElementById(id);
const PAGE_SIZE = 12;
const DELETE_DELAY_MS = 4000;
let search = "",
  nextOffset = 0,
  total = 0,
  loadedCustomers = [],
  customersLoaded = false,
  loading = false,
  loadingMore = false,
  requestId = 0,
  listAbort,
  searchTimer;
let detailsDialog,
  deleteDialog,
  paymentHistory,
  invoiceHistory,
  detailsCustomerId,
  selectedCustomer = null,
  detailsRequest = 0;
let deleteTimer,
  deleteFrame,
  deleteDeadline = 0,
  deleteInFlight = false,
  deletingCustomer = null;

function listState(state) {
  if (state === "error" && customersLoaded) {
    get("customersError").classList.remove("hidden");
    return;
  }
  for (const [id, active] of [
    ["customersLoading", state === "loading"],
    ["customersError", state === "error"],
    ["customersEmpty", state === "empty"],
    ["customersSearchEmpty", state === "search-empty"],
    ["customersList", state === "ready"],
  ]) {
    get(id).classList.toggle("hidden", !active);
  }
  get("customersWorkspace").setAttribute(
    "aria-busy",
    String(state === "loading"),
  );
  get("customersLoadMore").classList.toggle("hidden", state !== "ready");
  get("customersLoadMore").classList.toggle("flex", state === "ready");
}

function createCustomerCard(customer) {
  const wrapper = element("div", "card-tilt");
  wrapper.setAttribute("role", "listitem");
  const card = element(
    "button",
    "card-tilt-surface group w-full cursor-pointer rounded-xl border border-french-gray/30 bg-white px-4 py-3 text-right transition duration-200 hover:border-french-gray/70 hover:shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-persian-blue/20",
  );
  card.type = "button";
  card.dataset.customerId = customer.id;
  card.setAttribute("aria-haspopup", "dialog");
  card.setAttribute("aria-controls", "customerDetailsModal");
  card.setAttribute("aria-expanded", String(detailsCustomerId === customer.id));
  card.setAttribute(
    "aria-label",
    `مشاهده جزئیات ${fullName(customer)}، کد ${customer.customer_code}${customer.is_system ? `، ${systemCustomerLabel}` : ""}`,
  );
  const header = element(
    "div",
    "flex flex-wrap items-start justify-between gap-3",
  );
  const identity = element(
    "div",
    "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1",
  );
  identity.append(
    element(
      "p",
      "min-w-0 max-w-full break-words text-sm font-bold text-mirage",
      `${customer.gender && !customer.is_system ? genderLabel(customer.gender) + " " : ""}${fullName(customer)}`,
    ),
    element(
      "p",
      "text-[0.625rem] text-mirage/45",
      `کد مشتری: ${formatNumber(customer.customer_code)}`,
    ),
  );
  if (customer.is_system) identity.append(element(
    "span", "rounded-full bg-persian-blue/10 px-2.5 py-1 text-[0.625rem] font-bold text-persian-blue", systemCustomerLabel,
  ));
  const status = statusMeta(customer.summary.status);
  const permanentID = element("p", "text-[0.625rem] text-persian-blue");
  const permanentCode = element("bdi", "font-mono", customer.permanent_id);
  permanentCode.dir = "ltr";
  permanentCode.dataset.customerPermanentId = customer.permanent_id;
  permanentID.append(document.createTextNode("شناسه یکتای دائمی: "), permanentCode);
  identity.append(permanentID);
  header.append(
    identity,
    element(
      "span",
      `rounded-full px-2.5 py-1 text-[0.625rem] font-bold ${status.classes}`,
      status.label,
    ),
  );
  const contact = element(
    "div",
    "my-2.5 grid gap-x-4 gap-y-1.5 text-xs text-mirage/60 sm:grid-cols-2 xl:grid-cols-3",
  );
  contact.append(
    element(
      "p",
      "break-words",
      `شماره تماس: ${customer.phone_numbers[0] || "بدون شماره تماس"}`,
    ),
    element(
      "p",
      "break-words",
      `آخرین تماس: ${formatDate(customer.last_contact_date)}`,
    ),
    element("p", "truncate", customer.address || "آدرس ثبت نشده"),
  );
  contact.lastElementChild.title = customer.address || "آدرس ثبت نشده";
  card.append(
    header,
    contact,
    createSummary(customer.summary, { compact: true }),
    element(
      "p",
      "mt-2 text-[0.625rem] text-mirage/35 group-hover:text-persian-blue",
      "برای مشاهده جزئیات روی کارت کلیک کنید!",
    ),
  );
  card.addEventListener("click", () => {
    card.focus({ preventScroll: true });
    void openDetails(customer.id);
  });
  wrapper.append(card);
  return wrapper;
}

function updateLoadMore() {
  const button = get("loadMoreCustomersButton");
  const hasMore = nextOffset < total;
  button.classList.toggle("hidden", !hasMore);
  button.disabled = loadingMore;
  button.setAttribute("aria-busy", String(loadingMore));
  button.replaceChildren();
  if (loadingMore) button.append(createSpinner());
  button.append(
    document.createTextNode(loadingMore ? "در حال دریافت..." : "نمایش بیشتر"),
  );
  get("customersLoadedCount").textContent =
    `${formatNumber(loadedCustomers.length)} از ${formatNumber(total)} مشتری نمایش داده شده`;
  get("customersCount").textContent =
    `${formatNumber(total)} مشتری${search ? " در نتایج جستجو" : ""}`;
}

function updateCustomerSummary(data) {
  for (const [id, value] of [
    ["totalCustomersCount", data.total_customers],
    ["unsettledCustomersCount", data.unsettled_customers],
    ["settledCustomersCount", data.settled_customers],
  ]) {
    get(id).textContent = formatNumber(value);
  }
}

async function loadCustomers({ visibleCount = PAGE_SIZE } = {}) {
  const current = ++requestId;
  listAbort?.abort();
  listAbort = new AbortController();
  loading = true;
  loadingMore = false;
  get("customersLoadMoreError").classList.add("hidden");
  if (!customersLoaded) listState("loading");
  get("customersWorkspace").setAttribute("aria-busy", "true");
  try {
    const items = [];
    const seenIds = new Set();
    let offset = 0;
    do {
      const data = await getCustomers({
        search,
        skip: offset,
        limit: PAGE_SIZE,
        signal: listAbort.signal,
      });
      if (current !== requestId) return;
      total = data.total;
      updateCustomerSummary(data);
      for (const customer of data.items) {
        if (seenIds.has(customer.id)) continue;
        seenIds.add(customer.id);
        items.push(customer);
      }
      offset += data.items.length;
      if (!data.items.length) break;
    } while (offset < Math.min(visibleCount, total));
    const unchanged = JSON.stringify(loadedCustomers) === JSON.stringify(items);
    loadedCustomers = items;
    customersLoaded = true;
    nextOffset = offset;
    if (!unchanged)
      get("customersList").replaceChildren(...items.map(createCustomerCard));
    listState(items.length ? "ready" : search ? "search-empty" : "empty");
    updateLoadMore();
  } catch (error) {
    if (error.name === "AbortError" || current !== requestId) return;
    get("customersCount").textContent = "دریافت اطلاعات ناموفق بود";
    listState("error");
  } finally {
    if (current === requestId) {
      loading = false;
      get("customersWorkspace").setAttribute("aria-busy", "false");
    }
  }
}

async function loadMoreCustomers() {
  if (loading || loadingMore || nextOffset >= total) return;
  const current = ++requestId;
  loadingMore = true;
  get("customersLoadMoreError").classList.add("hidden");
  updateLoadMore();
  try {
    const data = await getCustomers({
      search,
      skip: nextOffset,
      limit: PAGE_SIZE,
      signal: listAbort.signal,
    });
    if (current !== requestId) return;
    total = data.total;
    updateCustomerSummary(data);
    nextOffset = data.items.length ? nextOffset + data.items.length : total;
    const existingIds = new Set(loadedCustomers.map((customer) => customer.id));
    const items = data.items.filter(
      (customer) => !existingIds.has(customer.id),
    );
    loadedCustomers.push(...items);
    get("customersList").append(...items.map(createCustomerCard));
    if (nextOffset >= total) get("customersLoadedCount").focus();
  } catch (error) {
    if (error.name === "AbortError" || current !== requestId) return;
    get("customersLoadMoreError").classList.remove("hidden");
  } finally {
    if (current === requestId) {
      loadingMore = false;
      updateLoadMore();
    }
  }
}

function detailField(label, value, ltr = false) {
  const cell = element("div", "min-w-0");
  const content = element(
    "dd",
    "mt-2 whitespace-pre-wrap break-words text-sm leading-7",
    value || "ثبت نشده",
  );
  if (ltr) {
    content.dir = "ltr";
    content.classList.add("text-right");
  }
  cell.append(element("dt", "text-xs text-mirage/50", label), content);
  return cell;
}

function renderDetails(customer) {
  const body = get("customerDetailsBody");
  paymentHistory?.cancel();
  invoiceHistory?.cancel();
  body.replaceChildren();
  const profile = element("section", "customer-details-panel");
  const financial = element("section", "customer-details-panel customer-financial-panel");
  profile.setAttribute("aria-labelledby", "customerPersonalTitle");
  financial.setAttribute("aria-labelledby", "customerFinancialTitle");
  const personalTitle = element("h3", "customer-details-heading", "مشخصات فردی");
  const financialTitle = element("h3", "customer-details-heading", "اطلاعات مالی");
  personalTitle.id = "customerPersonalTitle";
  financialTitle.id = "customerFinancialTitle";
  const info = element("dl", "grid gap-5 sm:grid-cols-2");
  const timestampDate = (value) => value
    ? formatJalaliInput(new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`))
    : null;
  for (const [label, value, ltr] of [
    ["نام و نام خانوادگی", fullName(customer)],
    ["کد مشتری", formatNumber(customer.customer_code)],
    ["شناسه یکتای دائمی مشتری", customer.permanent_id, true],
    ["جنسیت", genderLabel(customer.gender)],
    [
      "شماره‌های تماس (شماره اول، اصلی)",
      customer.phone_numbers.join("\n") || "بدون شماره تماس",
      true,
    ],
    ["آخرین تماس", formatDate(customer.last_contact_date)],
    ["آدرس", customer.address],
    ["ایمیل", customer.email, true],
    ["نوع مشتری", customer.is_system ? systemCustomerLabel : customer.customer_type],
    ["تاریخ ثبت", timestampDate(customer.created_at)],
    ["آخرین ویرایش", timestampDate(customer.updated_at)],
    ["توضیحات مشتری", customer.notes],
  ])
    info.append(detailField(label, value, ltr));
  const badge = element("p");
  function renderStatus(summary) {
    const status = statusMeta(summary.status);
    badge.className = `justify-self-start rounded-full px-3 py-1 text-xs font-bold ${status.classes}`;
    badge.textContent = status.label;
  }
  renderStatus(customer.summary);
  const summary = element("div", "customer-financial-summary grid gap-3");
  const invoices = element("details", "customer-invoice-history");
  const payments = element("section", "orders-detail-section grid gap-3");
  payments.id = "customerPaymentHistory";
  profile.append(personalTitle, info);
  financial.append(financialTitle, badge, summary, invoices, payments);
  body.append(profile, financial);
  const history = paymentHistory = mountCustomerPaymentHistory(summary, payments, customer.id);
  const invoiceList = invoiceHistory = mountCustomerInvoices(invoices, customer.id);
  const carryovers = element("section", "orders-detail-section mt-5 grid gap-3");
  carryovers.id = "customerFiscalCarryovers";
  carryovers.hidden = true;
  financial.append(carryovers);
  void import("../fiscal-years/customer-carryovers.js").then(({ loadCustomerCarryovers }) =>
    loadCustomerCarryovers(carryovers, customer.id, async () => {
      if (!carryovers.isConnected || paymentHistory !== history) return;
      void history.refresh();
      invoiceList.refresh();
      try {
        const updated = await getCustomer(customer.id);
        if (paymentHistory === history) renderStatus(updated.summary);
        await loadCustomers({ visibleCount: Math.max(PAGE_SIZE, loadedCustomers.length) });
      } catch { /* The next customer refresh can retrieve updated totals. */ }
    }),
  ).catch(() => {
    if (!carryovers.isConnected) return;
    carryovers.hidden = false;
    carryovers.append(element("p", "orders-error", "دریافت فاکتورهای انتقالی انجام نشد."));
  });
}

function customerCard(id) {
  return get("customersList").querySelector(`[data-customer-id="${id}"]`);
}

function resetDetails() {
  customerCard(detailsCustomerId)?.setAttribute("aria-expanded", "false");
  detailsCustomerId = null;
  selectedCustomer = null;
  detailsRequest++;
  paymentHistory?.cancel();
  paymentHistory = null;
  invoiceHistory?.cancel();
  invoiceHistory = null;
}

async function openDetails(id) {
  const current = ++detailsRequest;
  detailsCustomerId = id;
  customerCard(id)?.setAttribute("aria-expanded", "true");
  paymentHistory?.cancel();
  paymentHistory = null;
  selectedCustomer = null;
  get("editCustomerButton").disabled = true;
  get("deleteCustomerButton").disabled = true;
  const loading = element(
    "p",
    "flex items-center gap-3 text-sm text-mirage/60",
    "در حال دریافت جزئیات...",
  );
  loading.prepend(createSpinner());
  get("customerDetailsBody").replaceChildren(loading);
  if (!get("customerDetailsModal").open)
    detailsDialog.open(get("closeCustomerDetailsButton"));
  try {
    const customer = await getCustomer(id);
    if (current !== detailsRequest) return;
    selectedCustomer = customer;
    renderDetails(customer);
    get("editCustomerButton").disabled = false;
    get("deleteCustomerButton").disabled = Boolean(customer.is_system);
  } catch (error) {
    if (current !== detailsRequest) return;
    const message = element(
      "p",
      "text-sm text-alizarin-crimson",
      error.message,
    );
    const retry = element(
      "button",
      "mt-4 rounded-xl bg-persian-blue px-4 py-2 text-sm text-white",
      "تلاش مجدد",
    );
    retry.type = "button";
    retry.addEventListener("click", () => openDetails(id));
    get("customerDetailsBody").replaceChildren(message, retry);
  }
}

function cancelDelete() {
  clearTimeout(deleteTimer);
  cancelAnimationFrame(deleteFrame);
  deleteDeadline = 0;
  if (deletingCustomer) notify("حذف لغو شد.");
  deletingCustomer = null;
}

function openDelete() {
  if (!selectedCustomer || selectedCustomer.is_system) return;
  deletingCustomer = selectedCustomer;
  get("customerDeleteDescription").textContent =
    `آیا مطمئن هستید که می‌خواهید «${fullName(deletingCustomer)}» با کد مشتری «${formatNumber(deletingCustomer.customer_code)}» را حذف کنید؟ پس از تأیید، ۴ ثانیه برای لغو حذف فرصت دارید.`;
  get("customerDeleteError").classList.add("hidden");
  get("customerDeleteCountdownBox").classList.add("hidden");
  get("confirmDeleteCustomerButton").disabled = false;
  get("confirmDeleteCustomerButton").textContent = "بله، حذف شود";
  get("cancelDeleteCustomerButton").disabled = false;
  get("cancelDeleteCustomerButton").textContent = "انصراف";
  deleteDialog.open(get("cancelDeleteCustomerButton"));
}

async function finalDelete() {
  if (!deletingCustomer || deleteInFlight) return;
  deleteInFlight = true;
  cancelAnimationFrame(deleteFrame);
  updateDeleteProgress(0);
  deleteDeadline = 0;
  get("cancelDeleteCustomerButton").disabled = true;
  const button = get("confirmDeleteCustomerButton");
  button.replaceChildren(
    createSpinner(),
    document.createTextNode("در حال حذف..."),
  );
  try {
    const deletedCustomer = deletingCustomer;
    await deleteCustomer(deletedCustomer.id);
    deletingCustomer = null;
    deleteDialog.close();
    resetDetails();
    detailsDialog.close();
    notify("مشتری حذف شد", { type: "success" });
    await disintegrateCustomerCard(
      get("customersList").querySelector(`[data-customer-id="${deletedCustomer.id}"]`),
    );
    await loadCustomers({
      visibleCount: Math.max(PAGE_SIZE, loadedCustomers.length),
    });
  } catch (error) {
    get("customerDeleteError").textContent = error.message;
    get("customerDeleteError").classList.remove("hidden");
    get("customerDeleteCountdownBox").classList.add("hidden");
    button.textContent = "تلاش مجدد با مهلت ۴ ثانیه";
    button.disabled = false;
  } finally {
    deleteInFlight = false;
    get("cancelDeleteCustomerButton").disabled = false;
    get("cancelDeleteCustomerButton").textContent = "انصراف";
  }
}

function updateDeleteProgress(remaining) {
  const fraction = Math.max(0, Math.min(1, remaining / DELETE_DELAY_MS));
  get("customerDeleteProgressFill").style.transform = `scaleX(${fraction})`;
  get("customerDeleteProgress").setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
}

function animateDeleteProgress() {
  if (!deleteDeadline || !deletingCustomer) return;
  updateDeleteProgress(deleteDeadline - performance.now());
  deleteFrame = requestAnimationFrame(animateDeleteProgress);
}

function countdownTick() {
  if (!deleteDeadline || !deletingCustomer) return;
  // Use elapsed time instead of interval counts. Background tab throttling can
  // delay deletion, but must never cause DELETE before the full four seconds.
  const remaining = Math.max(0, deleteDeadline - performance.now());
  if (remaining === 0) {
    finalDelete();
    return;
  }
  deleteTimer = setTimeout(
    countdownTick,
    Math.min(200, deleteDeadline - performance.now()),
  );
}

function startDelete() {
  if (deleteInFlight || deleteDeadline || !deletingCustomer) return;
  get("confirmDeleteCustomerButton").disabled = true;
  get("cancelDeleteCustomerButton").textContent = "لغو حذف";
  get("cancelDeleteCustomerButton").focus();
  get("customerDeleteCountdownBox").classList.remove("hidden");
  get("customerDeleteError").classList.add("hidden");
  deleteDeadline = performance.now() + DELETE_DELAY_MS;
  animateDeleteProgress();
  countdownTick();
}

export async function initializeCustomers() {
  detailsDialog = new Dialog("customerDetailsModal", {
    animateNativeClose: true,
    onCancel: resetDetails,
    restoreFocus: (opener) => customerCard(opener?.dataset.customerId) || get("customerSearchInput"),
  });
  deleteDialog = new Dialog("customerDeleteModal", {
    canClose: () => !deleteInFlight,
    onCancel: cancelDelete,
  });
  let openCreateOrder;
  initializeCustomerModal({
    prepareCreateOrder: async () => {
      if (!openCreateOrder) {
        try {
          const { initializeOrderDialogs } = await import("../orders/order-dialogs.js");
          openCreateOrder = initializeOrderDialogs(refreshCodes);
        } catch {
          throw new Error("پنل سفارش آماده نشد. دوباره تلاش کنید یا مشتری را جداگانه ذخیره کنید.");
        }
      }
      return openCreateOrder;
    },
    onSaved: async (customer, edited) => {
      notify(
        edited ? "اطلاعات مشتری با موفقیت ویرایش شد." : "مشتری اضافه شد",
        { type: "success" },
      );
      if (selectedCustomer?.id === customer.id) {
        selectedCustomer = customer;
        renderDetails(customer);
      }
      if (!edited) {
        get("customerSearchInput").value = "";
        search = "";
        nextOffset = 0;
        get("clearCustomerSearchButton").classList.add("hidden");
      }
      clearTimeout(searchTimer);
      await loadCustomers({
        visibleCount: edited
          ? Math.max(PAGE_SIZE, loadedCustomers.length)
          : PAGE_SIZE,
      });
    },
  });
  for (const id of ["openCreateCustomerButton", "emptyCreateCustomerButton"])
    get(id).addEventListener("click", () => openCreateCustomerModal());
  get("editCustomerButton").addEventListener("click", () => {
    if (selectedCustomer) openEditCustomerModal(selectedCustomer);
  });
  get("deleteCustomerButton").addEventListener("click", openDelete);
  get("confirmDeleteCustomerButton").addEventListener("click", startDelete);
  get("retryCustomersButton").addEventListener("click", loadCustomers);
  function applySearch() {
    clearTimeout(searchTimer);
    listAbort?.abort();
    requestId++;
    search = get("customerSearchInput").value.trim().slice(0, 200);
    nextOffset = 0;
    loading = true;
    loadingMore = false;
    get("clearCustomerSearchButton").classList.toggle("hidden", !search);
    if (!customersLoaded) listState("loading");
    get("customersWorkspace").setAttribute("aria-busy", "true");
    searchTimer = setTimeout(loadCustomers, 250);
  }
  get("customerSearchInput").maxLength = 200;
  get("customerSearchInput").addEventListener("input", applySearch);
  get("clearCustomerSearchButton").addEventListener("click", () => {
    get("customerSearchInput").value = "";
    applySearch();
    get("customerSearchInput").focus();
  });
  get("loadMoreCustomersButton").addEventListener("click", loadMoreCustomers);
  window.addEventListener("pagehide", () => {
    clearTimeout(deleteTimer);
    cancelAnimationFrame(deleteFrame);
    deleteDeadline = 0;
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !deleteInFlight) {
      cancelDelete();
      deleteDialog.close();
    }
  });
  async function refreshCodes() {
    const listing = loadCustomers({ visibleCount: Math.max(PAGE_SIZE, loadedCustomers.length) });
    if (selectedCustomer && !deleteInFlight && !deletingCustomer) {
      const id = selectedCustomer.id, current = detailsRequest;
      try {
        const customer = await getCustomer(id);
        if (current === detailsRequest && selectedCustomer?.id === id) {
          selectedCustomer = customer;
          renderDetails(customer);
          get("deleteCustomerButton").disabled = Boolean(customer.is_system);
        }
      } catch { /* The details dialog retains its own retry flow. */ }
    }
    await listing;
  }
  await loadCustomers();
  onPageRefresh(refreshCodes);
}

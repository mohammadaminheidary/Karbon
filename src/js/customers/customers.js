import { Dialog } from "../components/dialog.js";
import { createSpinner } from "../components/loader.js";
import { getCustomers, getCustomer, deleteCustomer } from "./customer-api.js";
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
  formatNumber,
  statusMeta,
  createSummary,
} from "./customer-utils.js";

const get = (id) => document.getElementById(id);
const PAGE_SIZE = 12;
const DELETE_DELAY_MS = 10000;
let search = "",
  nextOffset = 0,
  total = 0,
  loadedCustomers = [],
  loading = false,
  loadingMore = false,
  requestId = 0,
  listAbort,
  searchTimer;
let detailsDialog,
  deleteDialog,
  selectedCustomer = null,
  detailsRequest = 0;
let deleteTimer,
  deleteDeadline = 0,
  deleteInFlight = false,
  deletingCustomer = null,
  toastTimer;

function toast(message, success = true) {
  clearTimeout(toastTimer);
  const output = get("customersToast");
  output.textContent = message;
  output.classList.remove("hidden", "bg-eucalyptus", "bg-alizarin-crimson");
  output.classList.add(success ? "bg-eucalyptus" : "bg-alizarin-crimson");
  toastTimer = setTimeout(() => output.classList.add("hidden"), 4000);
}

function listState(state) {
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
  const wrapper = element("div");
  wrapper.setAttribute("role", "listitem");
  const card = element(
    "button",
    "group w-full cursor-pointer rounded-xl border border-french-gray/30 bg-white px-4 py-3 text-right transition duration-200 hover:border-persian-blue/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-persian-blue/20",
  );
  card.type = "button";
  card.dataset.customerId = customer.id;
  card.setAttribute(
    "aria-label",
    `مشاهده جزئیات ${fullName(customer)}، کد ${customer.customer_code}`,
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
      `${customer.gender ? genderLabel(customer.gender) + " " : ""}${fullName(customer)}`,
    ),
    element(
      "p",
      "text-[10px] text-mirage/45",
      `کد مشتری: ${formatNumber(customer.customer_code)}`,
    ),
  );
  const status = statusMeta(customer.summary.status);
  header.append(
    identity,
    element(
      "span",
      `rounded-full px-2.5 py-1 text-[10px] font-bold ${status.classes}`,
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
      "mt-2 text-[10px] text-mirage/35 group-hover:text-persian-blue",
      "برای مشاهده جزئیات روی کارت کلیک کنید!",
    ),
  );
  card.addEventListener("click", () => openDetails(customer.id));
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

async function loadCustomers({ visibleCount = PAGE_SIZE } = {}) {
  const current = ++requestId;
  listAbort?.abort();
  listAbort = new AbortController();
  loading = true;
  loadingMore = false;
  get("customersLoadMoreError").classList.add("hidden");
  listState("loading");
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
      for (const customer of data.items) {
        if (seenIds.has(customer.id)) continue;
        seenIds.add(customer.id);
        items.push(customer);
      }
      offset += data.items.length;
      if (!data.items.length) break;
    } while (offset < Math.min(visibleCount, total));
    loadedCustomers = items;
    nextOffset = offset;
    get("customersList").replaceChildren(...items.map(createCustomerCard));
    listState(items.length ? "ready" : search ? "search-empty" : "empty");
    updateLoadMore();
  } catch (error) {
    if (error.name === "AbortError" || current !== requestId) return;
    get("customersCount").textContent = "دریافت اطلاعات ناموفق بود";
    listState("error");
  } finally {
    if (current === requestId) loading = false;
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
  body.replaceChildren();
  const info = element("dl", "grid gap-5 sm:grid-cols-2");
  for (const [label, value, ltr] of [
    ["کد مشتری", formatNumber(customer.customer_code)],
    ["جنسیت", genderLabel(customer.gender)],
    ["نام", customer.first_name],
    ["نام خانوادگی", customer.last_name],
    [
      "شماره‌های تماس (شماره اول، اصلی)",
      customer.phone_numbers.join("\n") || "بدون شماره تماس",
      true,
    ],
    ["آخرین تماس", formatDate(customer.last_contact_date)],
    ["آدرس", customer.address],
    ["توضیحات مشتری", customer.notes],
  ])
    info.append(detailField(label, value, ltr));
  const status = statusMeta(customer.summary.status);
  body.append(
    info,
    element(
      "p",
      `my-5 inline-block rounded-full px-3 py-1 text-xs font-bold ${status.classes}`,
      status.label,
    ),
    createSummary(customer.summary),
  );
  if (!customer.summary.available)
    body.append(
      element(
        "p",
        "mt-4 text-xs leading-6 text-mirage/50",
        "اطلاعات مالی پس از راه‌اندازی بخش سفارش‌ها و پرداخت‌ها در دسترس خواهد بود.",
      ),
    );
}

async function openDetails(id) {
  const current = ++detailsRequest;
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
  detailsDialog.open();
  try {
    const customer = await getCustomer(id);
    if (current !== detailsRequest) return;
    selectedCustomer = customer;
    renderDetails(customer);
    get("editCustomerButton").disabled = false;
    get("deleteCustomerButton").disabled = false;
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
  deleteDeadline = 0;
  if (deletingCustomer) toast("حذف لغو شد.");
  deletingCustomer = null;
}

function openDelete() {
  if (!selectedCustomer) return;
  deletingCustomer = selectedCustomer;
  get("customerDeleteDescription").textContent =
    `آیا مطمئن هستید که می‌خواهید «${fullName(deletingCustomer)}» با کد مشتری «${formatNumber(deletingCustomer.customer_code)}» را حذف کنید؟ پس از تأیید، ۱۰ ثانیه برای لغو حذف فرصت دارید.`;
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
  deleteDeadline = 0;
  get("cancelDeleteCustomerButton").disabled = true;
  const button = get("confirmDeleteCustomerButton");
  button.replaceChildren(
    createSpinner(),
    document.createTextNode("در حال حذف..."),
  );
  try {
    await deleteCustomer(deletingCustomer.id);
    deletingCustomer = null;
    selectedCustomer = null;
    deleteDialog.close();
    detailsDialog.close();
    detailsRequest++;
    toast("مشتری با موفقیت حذف شد.");
    await loadCustomers({
      visibleCount: Math.max(PAGE_SIZE, loadedCustomers.length),
    });
  } catch (error) {
    get("customerDeleteError").textContent = error.message;
    get("customerDeleteError").classList.remove("hidden");
    get("customerDeleteCountdownBox").classList.add("hidden");
    button.textContent = "تلاش مجدد با مهلت ۱۰ ثانیه";
    button.disabled = false;
  } finally {
    deleteInFlight = false;
    get("cancelDeleteCustomerButton").disabled = false;
    get("cancelDeleteCustomerButton").textContent = "انصراف";
  }
}

function countdownTick() {
  if (!deleteDeadline || !deletingCustomer) return;
  // Use elapsed time instead of interval counts. Background tab throttling can
  // delay deletion, but must never cause DELETE before the full ten seconds.
  const remaining = Math.max(
    0,
    Math.ceil((deleteDeadline - performance.now()) / 1000),
  );
  get("customerDeleteCountdown").textContent = formatNumber(remaining);
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
  countdownTick();
}

export async function initializeCustomers() {
  detailsDialog = new Dialog("customerDetailsModal", {
    onCancel: () => {
      detailsRequest++;
      selectedCustomer = null;
    },
  });
  deleteDialog = new Dialog("customerDeleteModal", {
    canClose: () => !deleteInFlight,
    onCancel: cancelDelete,
  });
  initializeCustomerModal({
    onSaved: async (customer, edited) => {
      toast(
        edited
          ? "اطلاعات مشتری با موفقیت ویرایش شد."
          : "مشتری با موفقیت ثبت شد.",
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
    listState("loading");
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
  const dateFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Tehran",
  });
  const updateDate = () => {
    get("customersPersianDate").textContent = dateFormatter.format(new Date());
  };
  updateDate();
  setInterval(updateDate, 60000);
  window.addEventListener("pagehide", () => {
    clearTimeout(deleteTimer);
    deleteDeadline = 0;
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !deleteInFlight) {
      cancelDelete();
      deleteDialog.close();
    }
  });
  await loadCustomers();
}

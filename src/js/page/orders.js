import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";
import { initializeNavbar } from "../components/navbar.js";
import { initializeOrderDialogs } from "../orders/order-dialogs.js";
import { financeRequest } from "../finance/finance-api.js";
import { node, money } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { onExternalDataChange } from "../components/data-events.js";
import { showFinalInvoice } from "../orders/invoice-export.js";
import { showOrderDetails } from "../orders/order-details.js";

initializeNavbar();

const createOrderButton = document.querySelector(".orders-create");
const titleIsland = document.querySelector(".navbar-title-island");
titleIsland.classList.add("orders-title-island");
titleIsland.append(createOrderButton);

function initializeTabs() {
  const tablist = document.querySelector('[role="tablist"]');
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];

  function selectTab(selectedTab) {
    tabs.forEach((tab) => {
      const selected = tab === selectedTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden =
        !selected;
    });
    loadOrders();
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      let nextIndex;
      // Arrow navigation follows the page's right-to-left visual order.
      if (event.key === "ArrowLeft") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowRight")
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[nextIndex]);
      tabs[nextIndex].focus();
    });
  });
}

let listVersion = 0;
let currentStatus = "active";
let records = [];
const completingOrders = new Set();

async function loadOrders(more = false) {
  const status =
    document
      .getElementById("completedOrdersTab")
      .getAttribute("aria-selected") === "true"
      ? "completed"
      : "active";
  if (status !== currentStatus) more = false;
  currentStatus = status;
  const panel = document.getElementById(
    status === "active" ? "activeOrdersPanel" : "completedOrdersPanel",
  );
  const version = ++listVersion;
  panel.setAttribute("aria-busy", "true");
  const loading = node("p", "orders-list-status", "در حال دریافت سفارش‌ها…");
  if (!more) {
    records = [];
    panel.replaceChildren(loading);
  } else panel.append(loading);
  try {
    const data = await financeRequest(
      `/orders?${new URLSearchParams({ status, skip: more ? records.length : 0, limit: 20 })}`,
    );
    if (version !== listVersion) return;
    records.push(...data.items);
    document.querySelectorAll(".orders-stat dd").forEach((dd, index) => {
      dd.textContent = formatNumber(
        index ? data.active_orders : data.total_orders,
      );
      dd.removeAttribute("aria-label");
    });
    panel.replaceChildren(
      ...records.map((order) => {
        const card = node("article", "orders-record");
        card.dataset.orderId = order.id;
        card.append(
          node(
            "h3",
            "",
            `سفارش ${order.order_number} · ${order.customer_name}`,
          ),
          node(
            "p",
            "orders-hint",
            `${order.invoice_code} · ${order.jalali_date}`,
          ),
        );
        const totals = node("dl", "orders-record-totals");
        for (const [label, value] of [
          ["جمع اقلام", order.subtotal],
          ["تخفیف", order.discount],
          ["مبلغ نهایی", order.total],
          ["پرداختی", order.paid],
          ["مانده", order.remaining],
        ]) {
          const cell = node("div");
          cell.append(node("dt", "", label), node("dd", "", money(value)));
          totals.append(cell);
        }
        card.append(
          totals,
          node(
            "p",
            "orders-hint",
            order.payment_status === "settled"
              ? "تسویه‌شده"
              : order.payment_status === "partial"
                ? "پرداخت ناقص"
                : "بدون پرداخت",
          ),
        );
        const open = node("button", "orders-card-open");
        open.type = "button";
        open.setAttribute("aria-label", `جزئیات سفارش ${order.order_number}`);
        open.setAttribute("aria-haspopup", "dialog");
        open.addEventListener("click", () => showOrderDetails(order.id));
        card.append(open);
        if (order.status === "active") {
          const actions = node("div", "orders-card-actions");
          const complete = node(
            "button",
            "orders-primary",
            completingOrders.has(order.id) ? "در حال تکمیل…" : "تکمیل سفارش",
          );
          complete.type = "button";
          complete.dataset.completeOrder = order.id;
          complete.disabled = completingOrders.has(order.id);
          complete.setAttribute(
            "aria-label",
            `تکمیل سفارش ${order.order_number}`,
          );
          const error = node("p", "orders-error");
          error.hidden = true;
          error.setAttribute("role", "alert");
          complete.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (completingOrders.has(order.id)) return;
            completingOrders.add(order.id);
            complete.disabled = true;
            complete.textContent = "در حال تکمیل…";
            error.hidden = true;
            try {
              await financeRequest(`/orders/${order.id}/complete`, {
                method: "POST",
              });
              const notice = document.getElementById("ordersNotice");
              notice.textContent = `سفارش ${order.order_number} به سفارشات تکمیل‌شده منتقل شد.`;
              notice.hidden = false;
              await loadOrders();
            } catch (failure) {
              const visibleError =
                document.querySelector(
                  `.orders-record[data-order-id="${order.id}"] .orders-error`,
                ) || error;
              visibleError.textContent = failure.message;
              visibleError.hidden = false;
            } finally {
              completingOrders.delete(order.id);
              complete.disabled = false;
              complete.textContent = "تکمیل سفارش";
              document
                .querySelectorAll(`[data-complete-order="${order.id}"]`)
                .forEach((button) => {
                  button.disabled = false;
                  button.textContent = "تکمیل سفارش";
                });
            }
          });
          actions.append(error, complete);
          card.append(actions);
        }
        return card;
      }),
    );
    if (!records.length)
      panel.append(node("p", "orders-list-status", "سفارشی ثبت نشده است."));
    if (records.length < data.total) {
      const moreButton = node("button", "orders-secondary", "نمایش بیشتر");
      moreButton.type = "button";
      moreButton.addEventListener("click", () => loadOrders(true));
      panel.append(moreButton);
    }
  } catch (error) {
    if (version !== listVersion) return;
    loading.remove();
    panel.append(node("p", "orders-error", error.message));
    const retry = node("button", "orders-secondary", "تلاش مجدد");
    retry.type = "button";
    retry.addEventListener("click", () => loadOrders());
    panel.append(retry);
  } finally {
    if (version === listVersion) panel.setAttribute("aria-busy", "false");
  }
}

async function initializeOrdersPage() {
  if (!(await protectPage())) return;
  document.getElementById("logoutButton").addEventListener("click", () => {
    logout();
    window.location.replace("/page/login-page.html");
  });
  initializeTabs();
  const openCreateOrder = initializeOrderDialogs((saved) => {
    const notice = document.getElementById("ordersNotice");
    notice.textContent = `سفارش ${saved.order_number} ثبت شد؛ پرداختی ${money(saved.paid)} و مانده ${money(saved.remaining)}.`;
    notice.hidden = false;
    loadOrders();
    showFinalInvoice(saved.id);
  });
  createOrderButton.disabled = false;
  createOrderButton.addEventListener("click", openCreateOrder);
  onExternalDataChange(() => loadOrders());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) loadOrders();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadOrders();
  });
  await loadOrders();
}

initializeOrdersPage();

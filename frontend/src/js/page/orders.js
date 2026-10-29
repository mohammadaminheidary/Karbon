import { notifyNavbar } from "../components/navbar-notification.js";
import { startPage } from "../components/page-ready.js";
import { protectPage } from "../guards/auth-guard.js";
import { initializeNavbar } from "../components/navbar.js";
import { initializeOrderDialogs } from "../orders/order-dialogs.js";
import { financeRequest } from "../finance/finance-api.js";
import { node, money } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { onPageRefresh } from "../components/data-events.js";
import { showFinalInvoice } from "../orders/invoice-export.js";
import { showOrderDetails } from "../orders/order-details.js";

initializeNavbar();

const createOrderButton = document.querySelector(".orders-create");

function initializeTabs() {
  const tablist = document.querySelector('[role="tablist"]');
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];

  function selectTab(selectedTab) {
    if (selectedTab.getAttribute("aria-selected") === "true") return;
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
const panelRequests = new WeakMap();
let currentStatus = "active";
let records = [];
let recordTotal = 0;
const changingOrderStatuses = new Set();

function finishOrderStatusChange(id) {
  changingOrderStatuses.delete(id);
  for (const [attribute, label] of [
    ["data-complete-order", "تکمیل سفارش"],
    ["data-reactivate-order", "بازگشت به سفارشات فعال"],
  ]) {
    document.querySelectorAll(`[${attribute}="${id}"]`).forEach((button) => {
      button.disabled = false;
      button.textContent = label;
    });
  }
}

async function loadOrders(more = false) {
  const status =
    document
      .getElementById("completedOrdersTab")
      .getAttribute("aria-selected") === "true"
      ? "completed"
      : "active";
  const statusChanged = status !== currentStatus;
  if (statusChanged) more = false;
  currentStatus = status;
  const panel = document.getElementById(
    status === "active" ? "activeOrdersPanel" : "completedOrdersPanel",
  );
  const version = ++listVersion;
  panelRequests.set(panel, version);
  panel.setAttribute("aria-busy", "true");
  panel.querySelectorAll("[data-orders-load-error]").forEach((node) => node.remove());
  const loading = node("p", "orders-list-status", "در حال دریافت سفارش‌ها…");
  if (statusChanged || !panel.children.length) {
    panel.replaceChildren(loading);
  } else if (more) panel.append(loading);
  try {
    const nextRecords = more ? [...records] : [];
    const visibleCount = more || statusChanged ? 20 : Math.max(20, records.length);
    let data;
    do {
      data = await financeRequest(
        `/orders?${new URLSearchParams({ status, skip: nextRecords.length, limit: 20 })}`,
      );
      if (version !== listVersion) return;
      nextRecords.push(...data.items);
      if (more || !data.items.length) break;
    } while (nextRecords.length < Math.min(visibleCount, data.total));
    const unchanged =
      !statusChanged && recordTotal === data.total &&
      JSON.stringify(records) === JSON.stringify(nextRecords);
    records = nextRecords;
    recordTotal = data.total;
    document.querySelectorAll(".orders-stat dd").forEach((dd, index) => {
      dd.textContent = formatNumber(
        index ? data.active_orders : data.total_orders,
      );
      dd.removeAttribute("aria-label");
    });
    if (unchanged && panel.querySelector(".orders-record")) {
      loading.remove();
      return;
    }
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
            changingOrderStatuses.has(order.id) ? "در حال تکمیل…" : "تکمیل سفارش",
          );
          complete.type = "button";
          complete.dataset.completeOrder = order.id;
          complete.disabled = changingOrderStatuses.has(order.id);
          complete.setAttribute(
            "aria-label",
            `تکمیل سفارش ${order.order_number}`,
          );
          complete.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (changingOrderStatuses.has(order.id)) return;
            changingOrderStatuses.add(order.id);
            complete.disabled = true;
            complete.textContent = "در حال تکمیل…";
            try {
              await financeRequest(`/orders/${order.id}/complete`, {
                method: "POST",
              });
              notifyNavbar(`سفارش ${order.order_number} به سفارشات تکمیل‌شده منتقل شد.`);
              await loadOrders();
            } catch (failure) {
              notifyNavbar(failure.message, { role: "alert" });
            } finally {
              finishOrderStatusChange(order.id);
            }
          });
          actions.append(complete);
          card.append(actions);
        } else if (order.status === "completed") {
          const actions = node("div", "orders-card-actions");
          const label = "بازگشت به سفارشات فعال";
          const pendingLabel = "Returning…";
          const reactivate = node(
            "button",
            "orders-primary",
            changingOrderStatuses.has(order.id) ? pendingLabel : label,
          );
          reactivate.type = "button";
          reactivate.dataset.reactivateOrder = order.id;
          reactivate.disabled = changingOrderStatuses.has(order.id);
          reactivate.setAttribute("aria-label", `${label} · ${order.order_number}`);
          reactivate.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (changingOrderStatuses.has(order.id)) return;
            changingOrderStatuses.add(order.id);
            reactivate.disabled = true;
            reactivate.textContent = pendingLabel;
            try {
              await financeRequest(`/orders/${order.id}/reactivate`, {
                method: "POST",
              });
              notifyNavbar(`سفارش ${order.order_number} به سفارشات فعال بازگردانده شد.`);
              await loadOrders();
            } catch (failure) {
              notifyNavbar(failure.message, { role: "alert" });
            } finally {
              finishOrderStatusChange(order.id);
            }
          });
          actions.append(reactivate);
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
    const failure = node("p", "orders-error", error.message);
    failure.dataset.ordersLoadError = "";
    panel.append(failure);
    const retry = node("button", "orders-secondary", "تلاش مجدد");
    retry.type = "button";
    retry.dataset.ordersLoadError = "";
    retry.addEventListener("click", () => loadOrders());
    panel.append(retry);
  } finally {
    if (panelRequests.get(panel) === version) {
      panel.setAttribute("aria-busy", "false");
      panelRequests.delete(panel);
    }
  }
}

async function initializeOrdersPage() {
  if (!(await protectPage())) return;
  initializeTabs();
  const openCreateOrder = initializeOrderDialogs((saved) => {
    notifyNavbar(`سفارش ${saved.order_number} ثبت شد؛ پرداختی ${money(saved.paid)} و مانده ${money(saved.remaining)}.`);
    loadOrders();
    showFinalInvoice(saved.id);
  });
  createOrderButton.disabled = false;
  createOrderButton.addEventListener("click", openCreateOrder);
  await loadOrders();
  onPageRefresh(() => loadOrders());
}

startPage(initializeOrdersPage);

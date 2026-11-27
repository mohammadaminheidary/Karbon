import { notify } from "../components/notifications.js";
import { refreshData } from "../components/api-cache.js";
import { financeRequest } from "../finance/finance-api.js";
import { confirmFinanceDelete } from "../finance/delete-dialog.js";
import { node, money } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import {
  onPageRefresh,
  publishLocalDataChange,
} from "../components/data-events.js";
import { showOrderDetails } from "./order-details.js";

const $ = (id) => document.getElementById(id);
let initialized = false,
  version = 0,
  records = [],
  loadedSearch = null,
  loadedKind = "sale",
  total = 0,
  loading = false,
  purchaseHistory = false,
  searchTimer;

function renderPurchases() {
  $("settingsInvoicesList").replaceChildren(...records.map((invoice) => {
    const row = node("article", "flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-french-gray/30 bg-white p-5");
    const summary = node("div");
    const heading = node("h3", "font-bold");
    heading.append(document.createTextNode("فاکتور خرید "), node("bdi", "", invoice.invoice_number));
    summary.append(heading, node("p", "mt-2 text-xs text-mirage/60",
      [invoice.supplier_name, invoice.jalali_date, money(invoice.total),
        invoice.remaining == null ? "" : `مانده ${money(invoice.remaining)}`].filter(Boolean).join(" · ")));
    const details = node("button", "finance-button border border-french-gray/40", "نمایش فاکتور خرید");
    details.type = "button";
    details.addEventListener("click", async () => {
      const { showPurchaseDetails } = await import("../warehouse/purchase-details.js");
      await showPurchaseDetails(invoice.id, () => load());
    });
    const actions = node("div", "flex flex-wrap gap-2");
    const edit = node("a", "finance-button border border-french-gray/40", "ویرایش خرید");
    edit.href = `/page/warehouse-page.html#purchase-edit-${invoice.id}`;
    const cancel = node("button", "finance-button bg-alizarin-crimson/10 text-alizarin-crimson", "لغو خرید");
    cancel.type = "button";
    cancel.addEventListener("click", () => confirmFinanceDelete({
      path: `/purchases/${invoice.id}`,
      description: `خرید ${invoice.invoice_number} لغو شود؟ موجودی کالا و ماندهٔ حساب‌های مرتبط بروزرسانی می‌شوند.`,
      onDeleted: () => {
        notify("خرید لغو و موجودی بروزرسانی شد.", { type: "success" });
        publishLocalDataChange();
      },
    }));
    actions.append(details);
    if (invoice.editable !== false) actions.append(edit, cancel);
    row.append(summary, actions);
    return row;
  }));
}

function render() {
  if (loadedKind === "purchase") { renderPurchases(); return; }
  const groups = new Map();
  for (const invoice of records) {
    const id = invoice.customer.id;
    if (!groups.has(id))
      groups.set(id, { customer: invoice.customer, invoices: [] });
    groups.get(id).invoices.push(invoice);
  }
  $("settingsInvoicesList").replaceChildren(
    ...[...groups.values()].map(({ customer, invoices }) => {
      const group = node(
        "section",
        "rounded-2xl border border-french-gray/30 bg-white p-5",
      );
      group.append(
        node(
          "h3",
          "font-bold break-words",
          `${customer.name} · کد ${formatNumber(customer.code)}`,
        ),
      );
      for (const invoice of invoices) {
        const row = node(
          "article",
          "mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-french-gray/25 pt-4",
        );
        const identity = node("div", "min-w-0");
        const heading = node("h4", "font-bold break-words");
        const code = node("bdi", "", invoice.invoice_code);
        code.dir = "ltr";
        heading.append(document.createTextNode("فاکتور "), code);
        identity.append(
          heading,
          node(
            "p",
            "mt-2 text-xs text-mirage/60",
            `سفارش ${invoice.order_number} · ${invoice.jalali_date} · ${invoice.status === "completed" ? "تکمیل‌شده" : "فعال"}`,
          ),
          node(
            "p",
            "mt-2 text-xs text-mirage/60",
            `مبلغ ${money(invoice.total)} · پرداختی ${money(invoice.paid)} · مانده ${money(invoice.remaining)}`,
          ),
        );
        const actions = node("div", "flex flex-wrap gap-2");
        const details = node(
          "button",
          "finance-button border border-french-gray/40",
          "جزئیات",
        );
        details.type = "button";
        details.setAttribute(
          "aria-label",
          `جزئیات فاکتور ${invoice.invoice_code}`,
        );
        details.addEventListener("click", () => showOrderDetails(invoice.id));
        const remove = node(
          "button",
          "finance-button bg-alizarin-crimson/10 text-alizarin-crimson",
          "حذف فاکتور",
        );
        remove.type = "button";
        remove.setAttribute("aria-label", `حذف فاکتور ${invoice.invoice_code}`);
        remove.addEventListener("click", () =>
          confirmFinanceDelete({
            path: `/orders/${invoice.id}/invoice`,
            description: `فاکتور ${invoice.invoice_code} متعلق به ${customer.name} حذف شود؟ پرداخت‌ها و رسیدهای مرتبط از دفتر مالی حذف می‌شوند و موجودی کالاها بازگردانده می‌شود. این عملیات قابل بازگشت نیست.`,
            onDeleted: () => {
              notify(
                "فاکتور و پرداخت‌های مرتبط حذف شدند؛ مانده‌ها و موجودی کالاها بروزرسانی شدند.",
                { type: "success" },
              );
              publishLocalDataChange();
            },
          }),
        );
        actions.append(details, remove);
        row.append(identity, actions);
        group.append(row);
      }
      return group;
    }),
  );
  $("settingsInvoicesMore").hidden = records.length >= total;
}

async function load(more = false) {
  if (more && loading) return;
  const current = ++version;
  loading = true;
  $("settingsInvoicesList").setAttribute("aria-busy", "true");
  $("settingsInvoicesMore").disabled = true;
  $("refreshInvoices").disabled = true;
  if (loadedSearch === null) $("settingsInvoicesStatus").textContent = "در حال دریافت فاکتورها…";
  try {
    const search = $("settingsInvoicesSearch").value.trim().slice(0, 200);
    const kind = $("settingsInvoicesKind").value;
    const endpoint = kind === "purchase" ? "/purchases" : "/settings/invoices";
    const visibleCount =
      search === loadedSearch && kind === loadedKind ? Math.max(20, records.length) : 20;
    const nextRecords = more ? [...records] : [];
    let data;
    do {
      data = await financeRequest(
        `${endpoint}?${new URLSearchParams({ search, skip: nextRecords.length, limit: 20,
          ...(kind === "purchase" && purchaseHistory ? { history: "true" } : {}) })}`,
      );
      if (current !== version) return;
      const existing = new Set(nextRecords.map((record) => record.id));
      nextRecords.push(...data.items.filter((record) => !existing.has(record.id)));
      if (more || !data.items.length) break;
    } while (nextRecords.length < Math.min(visibleCount, data.total));
    total = data.total;
    loadedSearch = search;
    const unchanged = loadedKind === kind && JSON.stringify(records) === JSON.stringify(nextRecords);
    loadedKind = kind;
    records = nextRecords;
    if (!unchanged) render();
    $("settingsInvoicesMore").hidden = records.length >= total;
    $("settingsInvoicesStatus").textContent = total
      ? `${formatNumber(records.length)} از ${formatNumber(total)} فاکتور`
      : "فاکتوری پیدا نشد.";
  } catch (error) {
    if (current === version)
      $("settingsInvoicesStatus").textContent = error.message;
  } finally {
    if (current === version) {
      loading = false;
      $("settingsInvoicesList").setAttribute("aria-busy", "false");
      $("settingsInvoicesMore").disabled = false;
      $("refreshInvoices").disabled = false;
    }
  }
}

export async function initializeInvoiceSettings(panel, section) {
  purchaseHistory = section === "purchase-invoices";
  if (!initialized) {
    initialized = true;
    $("refreshInvoices").addEventListener("click", refreshData(() => load()));
    $("settingsInvoicesKind").addEventListener("change", () => {
      const search = $("settingsInvoicesSearch");
      search.placeholder = $("settingsInvoicesKind").value === "purchase"
        ? "نام یا کد تأمین‌کننده یا شماره فاکتور…" : "نام یا کد مشتری، کد فاکتور یا شماره سفارش…";
      clearTimeout(searchTimer);
      records = [];
      total = 0;
      loadedSearch = null;
      $("settingsInvoicesList").replaceChildren();
      $("settingsInvoicesMore").hidden = true;
      load();
    });
    $("settingsInvoicesMore").addEventListener("click", () => load(true));
    $("settingsInvoicesSearch").addEventListener("input", () => {
      // Invalidate an older response before the debounce expires.
      version++;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(), 250);
    });
    onPageRefresh(() => load(), {
      isVisible: () => $("settingsInvoicesList").getClientRects().length > 0,
    });
  }
  if (purchaseHistory) {
    $("settingsInvoicesKind").value = "purchase";
    $("settingsInvoicesSearch").placeholder = "نام یا کد تأمین‌کننده یا شماره فاکتور…";
  }
  await load();
}

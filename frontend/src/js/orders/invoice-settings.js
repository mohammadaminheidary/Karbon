import { notifyNavbar } from "../components/navbar-notification.js";
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
  total = 0,
  loading = false,
  searchTimer;

function render() {
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
              notifyNavbar(
                "فاکتور و پرداخت‌های مرتبط حذف شدند؛ مانده‌ها و موجودی کالاها بروزرسانی شدند.",
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
    const visibleCount =
      search === loadedSearch ? Math.max(20, records.length) : 20;
    const nextRecords = more ? [...records] : [];
    let data;
    do {
      data = await financeRequest(
        `/settings/invoices?${new URLSearchParams({ search, skip: nextRecords.length, limit: 20 })}`,
      );
      if (current !== version) return;
      const existing = new Set(nextRecords.map((record) => record.id));
      nextRecords.push(...data.items.filter((record) => !existing.has(record.id)));
      if (more || !data.items.length) break;
    } while (nextRecords.length < Math.min(visibleCount, data.total));
    total = data.total;
    loadedSearch = search;
    const unchanged = JSON.stringify(records) === JSON.stringify(nextRecords);
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

export async function initializeInvoiceSettings() {
  if (!initialized) {
    initialized = true;
    $("refreshInvoices").addEventListener("click", refreshData(() => load()));
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
  await load();
}

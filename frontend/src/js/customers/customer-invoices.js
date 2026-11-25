import { money } from "../finance/finance-utils.js";
import { getCustomerInvoices } from "./customer-api.js";
import { element, formatDate } from "./customer-utils.js";

function invoiceRow(invoice) {
  const row = element("li", "customer-invoice-row");
  row.append(element("strong", "", invoice.invoice_code),
    element("span", "orders-hint", formatDate(invoice.invoice_date)));
  const amounts = element("dl", "orders-record-totals");
  for (const [label, amount] of [["مبلغ فاکتور", invoice.total], ["پرداختی", invoice.paid], ["مانده فاکتور", invoice.remaining]]) {
    const item = element("div");
    item.append(element("dt", "", label), element("dd", "", money(amount)));
    amounts.append(item);
  }
  row.append(amounts);
  return row;
}

export function mountCustomerInvoices(host, customerId) {
  const list = element("ol", "grid gap-2");
  const status = element("p", "orders-hint");
  status.setAttribute("role", "status");
  const next = element("button", "orders-secondary", "نمایش فاکتورهای بیشتر");
  next.type = "button";
  next.hidden = true;
  host.append(element("summary", "cursor-pointer font-bold", "سوابق فاکتورها"), list, status, next);
  let skip = 0;
  let request;
  let loaded = false;

  async function load() {
    if (request || skip === null) return;
    const current = request = new AbortController();
    status.textContent = "در حال دریافت فاکتورها…";
    next.disabled = true;
    try {
      const data = await getCustomerInvoices(customerId, skip, current.signal);
      if (current.signal.aborted) return;
      if (skip === 0) list.replaceChildren();
      list.append(...data.items.map(invoiceRow));
      skip = data.next_skip;
      loaded = true;
      status.textContent = list.childElementCount ? "" : "فاکتوری برای این مشتری ثبت نشده است.";
      next.textContent = "نمایش فاکتورهای بیشتر";
      next.hidden = skip === null;
    } catch (error) {
      if (!current.signal.aborted) {
        status.textContent = error.message;
        next.textContent = "تلاش مجدد";
        next.hidden = false;
      }
    } finally {
      if (request === current) {
        request = null;
        next.disabled = false;
      }
    }
  }

  host.addEventListener("toggle", () => {
    if (host.open && !loaded) void load();
  });
  next.addEventListener("click", () => void load());
  function cancel() {
    request?.abort();
    request = null;
  }
  return {
    cancel,
    refresh() {
      cancel();
      skip = 0;
      loaded = false;
      if (host.open) void load();
    },
  };
}

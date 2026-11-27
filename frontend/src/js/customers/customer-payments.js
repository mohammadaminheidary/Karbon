import { fullDate, money } from "../finance/finance-utils.js";
import { paymentMethodLabels } from "../finance/payment-methods.js";
import { getCustomerPayments } from "./customer-api.js";
import { element, formatNumber } from "./customer-utils.js";

const statuses = {
  posted: ["ثبت‌شده", "bg-eucalyptus/10 text-eucalyptus"],
  partially_allocated: ["بخشی تخصیص‌یافته", "bg-persian-blue/10 text-persian-blue"],
  unallocated: ["اعتبار تخصیص‌نیافته", "bg-persian-blue/10 text-persian-blue"],
  outside_period: ["پس از پایان سال مالی فعال", "bg-french-gray/30 text-mirage/70"],
};

function fact(label, value, color = "") {
  const field = element("div", "min-w-0");
  field.append(element("dt", "", label), element("dd", color, value));
  return field;
}

function renderTotals(summary, year) {
  const totals = element("dl", "orders-record-totals");
  totals.append(
    fact("مجموع مبالغ فاکتورها", money(BigInt(summary.invoiced))),
    fact("مجموع پرداختی", money(BigInt(summary.paid)), "text-eucalyptus"),
    fact("بدهی باقی‌مانده", money(BigInt(summary.outstanding)), "text-alizarin-crimson"),
    fact("اعتبار تخصیص‌نیافته", money(BigInt(summary.credit)), "text-persian-blue"),
  );
  return year ? [element("p", "orders-hint", `تا پایان سال مالی ${formatNumber(year)}`), totals] : [totals];
}

function paymentRow(payment) {
  const [label, color] = statuses[payment.status];
  const receiptNumber = formatNumber(payment.transaction_number ?? payment.id);
  const method = paymentMethodLabels[payment.method] || "بانکی";
  const amount = money(payment.amount);
  const details = element("details", "rounded-xl border border-french-gray/30 px-3 py-2");
  details.dataset.paymentId = payment.id;
  const summary = element("summary", "cursor-pointer text-sm");
  summary.append(
    element("strong", "font-bold tabular-nums", amount),
    element("span", "text-xs text-mirage/70", ` · ${fullDate(payment.transaction_date)} · ${method} `),
    element("span", `inline-block rounded-full px-2.5 py-1 text-xs font-bold ${color}`, label),
    element("span", "block break-words text-xs leading-6 text-mirage/70",
      `${payment.tracking_number ? `پیگیری ${payment.tracking_number}` : `رسید ${receiptNumber}`} · ${
        payment.invoices.map((invoice) => invoice.invoice_code).join("، ") || "بدون فاکتور مرتبط"
      }`),
  );
  const facts = element("dl", "orders-customer-details");
  facts.append(
    fact("شماره رسید", receiptNumber),
    fact("شماره پیگیری", payment.tracking_number || "ثبت نشده"),
    fact("ساعت ثبت", formatNumberTime(payment.transaction_time)),
    fact("حساب", payment.account_name),
  );
  for (const invoice of payment.invoices) {
    facts.append(fact(`فاکتور ${invoice.invoice_code}`,
      `${money(invoice.amount)} تخصیص‌یافته · ${money(invoice.remaining)} مانده فاکتور`));
  }
  if (payment.unallocated) facts.append(fact("اعتبار تخصیص‌نیافته", money(payment.unallocated)));
  if (payment.description) facts.append(fact("شرح", payment.description));
  const scroll = element("div", "orders-customer-details-scroll scrollbar-right");
  scroll.append(facts);
  details.append(summary, scroll);
  const row = element("li", "min-w-0");
  row.append(details);
  return row;
}

function formatNumberTime(time) {
  return time.slice(0, 5).split(":").map((part) => formatNumber(Number(part)).padStart(2, "۰")).join(":");
}

export function mountCustomerPaymentHistory(summary, host, customerId) {
  const totals = element("div", "grid gap-2");
  summary.append(element("h3", "font-bold", "خلاصه مالی"), totals);
  const list = element("ol", "grid gap-2");
  const status = element("p", "orders-hint");
  status.setAttribute("role", "status");
  const next = element("button", "orders-secondary justify-self-start", "نمایش بیشتر");
  next.type = "button";
  next.hidden = true;
  host.append(element("h3", "font-bold", "سوابق پرداخت"), list, status, next);
  let cursor, request, advance = true;

  async function load(more = false) {
    request?.abort();
    const current = new AbortController();
    request = current;
    host.setAttribute("aria-busy", "true");
    next.disabled = true;
    status.textContent = "در حال دریافت سوابق پرداخت…";
    if (!totals.childElementCount) totals.textContent = "در حال دریافت خلاصه مالی…";
    try {
      const data = await getCustomerPayments(customerId, { cursor: more ? cursor : undefined, signal: current.signal });
      if (current.signal.aborted) return;
      if (!more) {
        totals.replaceChildren(...renderTotals(data.summary, data.fiscal_year));
        list.replaceChildren();
      }
      list.append(...data.items.map(paymentRow));
      cursor = data.next_cursor;
      advance = true;
      next.textContent = "نمایش بیشتر";
      next.hidden = !cursor;
      status.textContent = list.childElementCount ? "" : "پرداختی برای این مشتری ثبت نشده است.";
    } catch (error) {
      if (current.signal.aborted) return;
      if (!totals.childElementCount) totals.textContent = "خلاصه مالی در دسترس نیست.";
      status.textContent = error.message;
      advance = more;
      next.textContent = "تلاش مجدد";
      next.hidden = false;
    } finally {
      if (!current.signal.aborted) {
        host.setAttribute("aria-busy", "false");
        next.disabled = false;
      }
    }
  }

  next.addEventListener("click", () => void load(advance));
  void load();
  return {
    refresh: () => load(),
    cancel: () => {
      request?.abort();
      host.setAttribute("aria-busy", "false");
    },
  };
}

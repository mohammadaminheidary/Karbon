import { mountDateInput } from "../components/date-input.js";
import { financeRequest, getBanks } from "../finance/finance-api.js";
import { amountValue, bindStrictAmount, money, node, normalizeJalaliDate } from "../finance/finance-utils.js";
import { archiveLink, fiscalLabel, fiscalRequest } from "./fiscal-api.js";

function field(label, control) {
  const container = node("label", "grid gap-1.5 text-sm");
  control.className = "rounded-lg border border-french-gray/50 bg-white px-3 py-2";
  container.append(node("span", "", label), control);
  return container;
}

function archiveAction(label, invoice, kind) {
  const link = node("a", "orders-secondary", label);
  link.href = archiveLink(invoice.source_year, kind, invoice.order_id);
  return link;
}

function invoiceFacts(invoice) {
  const facts = node("dl", "orders-customer-details");
  for (const [label, value] of [
    ["سال مبدأ", fiscalLabel(invoice.source_year)],
    ["شماره سفارش", invoice.order_number],
    ["شماره فاکتور", invoice.invoice_code],
    ["تاریخ صدور", fiscalLabel(invoice.issue_date)],
    ["سررسید اصلی", fiscalLabel(invoice.due_date)],
    ["مبلغ فاکتور", money(invoice.total)],
    ["پرداخت تا قطع حساب", money(invoice.paid)],
    ["مبلغ انتقالی", money(invoice.amount)],
    ["مانده فعلی", money(invoice.outstanding)],
  ]) {
    const item = node("div");
    item.append(node("dt", "", label), node("dd", "", value));
    facts.append(item);
  }
  return facts;
}

function retryKey(invoice, year) {
  return `karbon-settlement-${year}-${invoice.order_id}-${invoice.invoice_code}`;
}

function readPending(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
}

function writePending(key, payload) {
  try {
    if (payload) sessionStorage.setItem(key, JSON.stringify(payload));
    else sessionStorage.removeItem(key);
  } catch { /* The request ID still survives in the open form. */ }
}

async function receiptForm(host, invoice, data, refresh) {
  const form = node("form", "mt-3 grid gap-3");
  const fields = node("fieldset", "grid gap-3 sm:grid-cols-2");
  const date = node("input");
  date.required = true;
  date.maxLength = 10;
  date.value = data.receipt_date;
  const amount = node("input");
  amount.required = true;
  amount.inputMode = "numeric";
  bindStrictAmount(amount);
  const method = node("select");
  method.append(new Option("نقدی", "cash"), new Option("کارت‌خوان", "pos"), new Option("کارت‌به‌کارت", "transfer"));
  const bank = node("select");
  bank.append(new Option("انتخاب حساب", ""));
  const tracking = node("input");
  tracking.maxLength = 100;
  tracking.inputMode = "numeric";
  const accountField = field("حساب مقصد", bank);
  const key = retryKey(invoice, data.year);
  let pending = readPending(key);
  if (pending) {
    date.value = pending.transaction_date;
    amount.value = pending.amount;
    method.value = pending.method;
    tracking.value = pending.tracking_number || "";
  }
  const syncMethod = () => {
    accountField.hidden = method.value === "cash";
    bank.required = !accountField.hidden;
  };
  method.addEventListener("change", syncMethod);
  syncMethod();
  fields.append(field("تاریخ دریافت", date), field("مبلغ دریافتی (تومان)", amount), field("روش دریافت", method),
                accountField, field("شماره پیگیری", tracking));
  const receiptDate = mountDateInput(date);
  const status = node("p", "orders-hint");
  status.setAttribute("role", "status");
  const submit = node("button", "orders-primary justify-self-start", pending ? "تلاش مجدد ثبت دریافت" : "ثبت دریافت");
  submit.type = "submit";
  fields.disabled = Boolean(pending);
  form.append(fields, submit, status);
  host.append(form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    try {
      if (!pending) {
        const value = amountValue(amount.value);
        if (value > invoice.outstanding) throw new Error("مبلغ دریافتی از مانده فاکتور بیشتر است.");
        pending = {
          request_id: crypto.randomUUID(), transaction_date: normalizeJalaliDate(receiptDate.value), amount: value,
          method: method.value, bank_id: method.value === "cash" ? null : Number(bank.value),
          tracking_number: tracking.value.trim() || null,
        };
        writePending(key, pending);
      }
      submit.disabled = fields.disabled = true;
      status.textContent = "در حال ثبت دریافت…";
      await financeRequest(`/orders/${invoice.order_id}/payments`, { method: "POST", body: pending });
      pending = null;
      writePending(key, null);
      await refresh();
    } catch (error) {
      if (error.status) {
        pending = null;
        writePending(key, null);
      }
      fields.disabled = Boolean(pending);
      submit.disabled = false;
      submit.textContent = pending ? "تلاش مجدد ثبت دریافت" : "ثبت دریافت";
      status.textContent = error.message;
    }
  });
  try {
    const accounts = await getBanks();
    bank.append(...accounts.filter((item) => item.active && !item.is_cash).map((item) =>
      new Option(`${item.name} · ${item.account_number}`, item.id)));
    if (pending?.bank_id) bank.value = pending.bank_id;
  } catch (error) {
    status.textContent = error.message;
  }
}

export async function loadCustomerCarryovers(host, customerId, onSaved) {
  async function render(saved = false) {
    const data = await fiscalRequest(`/customers/${customerId}/carryovers`);
    if (!host.isConnected || !data.year) return;
    host.hidden = false;
    const headline = node("h3", "font-bold", "فاکتورهای انتقالی");
    const opening = node("p", "orders-hint",
      `افتتاحیه سال ${fiscalLabel(data.year)} · مطالبات ${money(data.receivable)} · بستانکاری ${money(data.credit)}`);
    host.replaceChildren(headline, opening);
    if (saved) {
      const notice = node("p", "orders-hint", "دریافت ثبت شد و مانده فاکتور به‌روز شد.");
      notice.setAttribute("role", "status");
      host.append(notice);
    }
    if (!data.invoices.length) {
      host.append(node("p", "orders-hint", "فاکتور انتقالی وجود ندارد."));
      return;
    }
    for (const invoice of data.invoices) {
      const row = node("details", "rounded-xl border border-french-gray/30 p-3");
      row.append(node("summary", "cursor-pointer font-bold",
        `${invoice.invoice_code} · ${money(invoice.outstanding)} مانده`), invoiceFacts(invoice));
      const actions = node("div", "mt-3 flex flex-wrap items-center gap-2");
      actions.append(archiveAction("مشاهدهٔ سفارش اصلی", invoice, "orders"),
                     archiveAction("مشاهدهٔ فاکتور اصلی", invoice, "invoices"));
      if (invoice.outstanding > 0 || readPending(retryKey(invoice, data.year))) {
        const start = node("button", "orders-primary", "ثبت دریافت");
        start.type = "button";
        start.addEventListener("click", () => {
          start.remove();
          void receiptForm(row, invoice, data, async () => {
            await render(true);
            onSaved();
          });
        });
        actions.append(start);
      }
      row.append(actions);
      host.append(row);
    }
  }
  try {
    await render();
  } catch (error) {
    if (host.isConnected) {
      host.hidden = false;
      host.replaceChildren(node("p", "orders-error", error.message));
    }
  }
}

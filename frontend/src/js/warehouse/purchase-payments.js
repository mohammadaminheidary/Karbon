import { mountDateInput } from "../components/date-input.js";
import { amountValue, bindStrictAmount, node, normalizeJalaliDate } from "../finance/finance-utils.js";

export const purchasePaymentStatus = { unpaid: "پرداخت‌نشده", partial: "پرداخت جزئی", settled: "تسویه‌شده" };

export function purchasePaymentFields(value = {}, date = "", changed = () => {}) {
  const root = node("fieldset", "grid gap-3 rounded-xl border border-french-gray/30 p-3 sm:grid-cols-2");
  root.innerHTML = `
    <label>حساب مبدأ<select class="finance-field" data-payment-bank></select></label>
    <label>مبلغ پرداخت (تومان)<input class="finance-field" inputmode="numeric" maxlength="21" dir="ltr" data-payment-amount /></label>
    <label>تاریخ پرداخت (شمسی)<input class="finance-field" dir="ltr" maxlength="10" data-payment-date /></label>
    <label>شماره پیگیری (اختیاری)<input class="finance-field" maxlength="100" data-payment-tracking /></label>`;
  const bank = root.querySelector("[data-payment-bank]");
  const input = root.querySelector("[data-payment-amount]");
  const tracking = root.querySelector("[data-payment-tracking]");
  const paymentDate = mountDateInput(root.querySelector("[data-payment-date]"));
  const requestId = value.request_id ?? crypto.randomUUID();
  input.value = value.amount == null ? "" : new Intl.NumberFormat("en-US").format(value.amount);
  paymentDate.value = value.jalali_date ?? value.transaction_date ?? date;
  tracking.value = value.tracking_number ?? "";
  const original = value.method === "cash" ? "cash" : String(value.bank_id ?? "");

  function setAccounts(accounts) {
    const selected = bank.options.length ? bank.value : original;
    const options = accounts.filter((item) => !item.is_cash && (item.active || String(item.id) === original));
    bank.replaceChildren(new Option("انتخاب حساب", ""), new Option("پرداخت نقدی · صندوق نقدی", "cash"),
      ...options.map((item) => new Option(`${item.name} · ${item.card_number || item.account_number}`, String(item.id))));
    if (original && original !== "cash" && !options.some((item) => String(item.id) === original))
      bank.add(new Option(value.account_name || original, original));
    bank.value = [...bank.options].some((option) => option.value === selected) ? selected : "";
  }

  setAccounts([]);
  bindStrictAmount(input, changed);
  return {
    root, setAccounts, setDate: (value) => { paymentDate.value = value; },
    amount: () => input.value.trim() ? amountValue(input.value) : 0,
    read() {
      if (!bank.value) throw new Error("حساب مبدأ پرداخت را انتخاب کنید.");
      const transactionDate = normalizeJalaliDate(paymentDate.value);
      if (!transactionDate) throw new Error("تاریخ پرداخت را وارد کنید.");
      const cash = bank.value === "cash";
      return { request_id: requestId, method: cash ? "cash" : (bank.value === original && value.method === "pos" ? "pos" : "transfer"),
        bank_id: cash ? null : Number(bank.value), transaction_date: transactionDate,
        tracking_number: tracking.value.trim() || null, amount: amountValue(input.value) };
    },
  };
}

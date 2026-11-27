import { CurtainDialog } from "../components/curtain-dialog.js";
import { publishLocalDataChange } from "../components/data-events.js";
import { formatNumber } from "../customers/customer-utils.js";
import { confirmFinanceDelete } from "../finance/delete-dialog.js";
import { financeRequest, getBanks } from "../finance/finance-api.js";
import { money, node } from "../finance/finance-utils.js";
import { purchasePaymentFields, purchasePaymentStatus } from "./purchase-payments.js";

const secondary = "finance-button border border-french-gray/40";
const $ = (id) => document.getElementById(id);
let details, obligationsReport, expensesReport;

function curtain(id, title, contents, canClose, onCancel) {
  const root = node("dialog", "bottom-curtain finance-surface");
  root.id = id;
  root.innerHTML = `<section class="curtain-content" aria-labelledby="${id}Title">
    <header class="mb-4 flex items-center justify-between gap-3">
      <h2 id="${id}Title" class="text-lg font-black">${title}</h2>
      <button type="button" class="dialog-close-button" data-dialog-close aria-label="بستن"></button>
    </header>${contents}</section>`;
  document.body.append(root);
  return new CurtainDialog(root.id, { canClose, onCancel });
}

function button(text, action, style = secondary) {
  const control = node("button", style, text);
  control.type = "button";
  control.addEventListener("click", action);
  return control;
}

function createDetails() {
  let id, receipt, changed, editing, fields, pending, busy = false, version = 0;
  const dialog = curtain("purchaseDetailsModal", "جزئیات فاکتور خرید", `
    <p id="purchaseDetailMessage" role="status" class="mb-3 text-sm"></p>
    <div id="purchaseDetailContent" class="space-y-3"></div>
    <div class="my-4 flex flex-wrap gap-2">
      <button type="button" id="purchaseDetailAddPayment" class="finance-button bg-persian-blue text-white" hidden>ثبت پرداخت جدید</button>
      <button type="button" id="purchaseDetailPrint" class="${secondary}" hidden>نمایش و چاپ فاکتور</button>
      <button type="button" id="purchaseDetailReload" class="${secondary}" hidden>بروزرسانی</button>
    </div>
    <form id="purchaseDetailPaymentForm" class="space-y-3" hidden novalidate>
      <div id="purchaseDetailEditor"></div>
      <p id="purchaseDetailPaymentError" role="alert" class="text-sm text-alizarin-crimson"></p>
      <div class="flex flex-wrap gap-2">
        <button type="submit" id="savePurchasePayment" class="finance-button bg-persian-blue text-white">ذخیره پرداخت</button>
        <button type="button" id="cancelPurchasePayment" class="${secondary}">انصراف</button>
      </div>
    </form>`, () => !busy, () => { version++; });
  const content = $("purchaseDetailContent");
  const message = $("purchaseDetailMessage");
  const add = $("purchaseDetailAddPayment");
  const print = $("purchaseDetailPrint");
  const reload = $("purchaseDetailReload");
  const form = $("purchaseDetailPaymentForm");
  const error = $("purchaseDetailPaymentError");
  const submit = $("savePurchasePayment");

  function clearEditor() {
    form.hidden = true;
    pending = null;
    fields = null;
    editing = null;
    $("purchaseDetailEditor").replaceChildren();
    error.textContent = "";
    submit.textContent = "ذخیره پرداخت";
  }

  function render() {
    const total = node("dl", "grid gap-3 rounded-xl border border-french-gray/40 p-3 text-sm sm:grid-cols-3");
    for (const [label, value] of [
      ["جمع اقلام", money(receipt.subtotal)], ["تخفیف", money(receipt.discount)],
      ...(receipt.tax ? [["مالیات", money(receipt.tax)]] : []),
      ...(receipt.shipping ? [["هزینه ارسال", money(receipt.shipping)]] : []),
      ["مبلغ قابل پرداخت", money(receipt.total)], ["پرداخت‌شده", money(receipt.paid)],
      ["باقی‌مانده", money(receipt.remaining)], ["وضعیت", purchasePaymentStatus[receipt.payment_status]],
    ]) {
      const cell = node("div");
      cell.append(node("dt", "text-mirage/70", label), node("dd", "font-bold", value));
      total.append(cell);
    }
    const items = node("details", "rounded-xl border border-french-gray/40 p-3 text-sm");
    const lines = node("ul", "mt-2 grid gap-2");
    for (const line of receipt.rows)
      lines.append(node("li", "", `${line.product_name} · ${formatNumber(line.quantity)} ${line.unit} · ${money(line.total)}`));
    items.append(node("summary", "cursor-pointer font-bold", "اقلام فاکتور"), lines);
    if (receipt.description)
      items.append(node("p", "mt-2 whitespace-pre-wrap", receipt.description));
    const history = node("ul", "grid gap-2");
    for (const payment of receipt.payments) {
      const row = node("li", "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-french-gray/30 p-3");
      row.dataset.purchasePaymentId = payment.id;
      const metadata = node("div", "text-sm");
      metadata.append(node("strong", "block", money(payment.amount)),
        node("span", "text-mirage/70", [payment.account_name, payment.account_number, payment.jalali_date, payment.tracking_number].filter(Boolean).join(" · ")));
      row.append(metadata);
      if (payment.editable) {
        const actions = node("div", "flex flex-wrap gap-2");
        actions.append(button("ویرایش پرداخت", () => edit(payment)), button("حذف پرداخت", () => {
          confirmFinanceDelete({
            path: `/purchases/${id}/payments/${payment.id}`,
            description: `پرداخت ${money(payment.amount)} از «${payment.account_name}» حذف شود؟ مانده حساب و فاکتور بروزرسانی می‌شوند.`,
            onDeleted: afterChange,
          });
        }));
        row.append(actions);
      }
      history.append(row);
    }
    content.replaceChildren(node("p", "font-bold", `فاکتور ${receipt.invoice_number} · ${receipt.jalali_date}`),
      total, items, node("h3", "font-bold", "سوابق پرداخت"),
      history.children.length ? history : node("p", "text-sm text-mirage/70", "پرداختی ثبت نشده است."));
    add.hidden = receipt.remaining <= 0;
    print.hidden = false;
  }

  async function load(success = "") {
    const current = ++version;
    message.textContent = success || "در حال دریافت فاکتور…";
    reload.hidden = true;
    try {
      const result = await financeRequest(`/purchases/${id}`, { cache: "no-store" });
      if (current !== version) return;
      receipt = result;
      render();
      message.textContent = success;
    } catch (err) {
      if (current !== version) return;
      message.textContent = [success, err.message].filter(Boolean).join(" ");
      add.hidden = true;
      reload.hidden = false;
    }
  }

  async function afterChange() {
    clearEditor();
    await load("پرداخت‌ها و مانده فاکتور بروزرسانی شدند.");
    publishLocalDataChange();
    await changed?.();
  }

  async function edit(payment = null) {
    if (busy || pending) return;
    clearEditor();
    editing = payment;
    const row = purchasePaymentFields(payment ?? {}, receipt.jalali_date);
    fields = row;
    $("purchaseDetailEditor").replaceChildren(row.root);
    form.hidden = false;
    try {
      const [accounts, workflow] = await Promise.all([getBanks(), financeRequest("/purchases/next-number")]);
      if (row !== fields) return;
      row.setAccounts(accounts);
      if (!payment && workflow.business_jalali)
        row.setDate(workflow.business_jalali < receipt.jalali_date ? receipt.jalali_date : workflow.business_jalali);
    } catch (err) {
      if (row === fields) error.textContent = err.message;
    }
  }

  add.addEventListener("click", () => edit());
  reload.addEventListener("click", () => load());
  print.addEventListener("click", async () => {
    const { showFinalInvoice } = await import("../orders/invoice-export.js");
    dialog.close();
    showFinalInvoice(id, { kind: "purchase" });
  });
  $("cancelPurchasePayment").addEventListener("click", clearEditor);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!fields || busy) return;
    error.textContent = "";
    try {
      if (!pending) {
        const value = fields.read();
        if (value.amount > receipt.remaining + (editing?.amount ?? 0))
          throw new Error("مبلغ پرداخت از ماندهٔ فاکتور بیشتر است.");
        pending = { ...value, ...(editing ? { revision: editing.revision } : {}) };
      }
      busy = true;
      fields.root.disabled = submit.disabled = true;
      await financeRequest(`/purchases/${id}/payments${editing ? `/${editing.id}` : ""}`, {
        method: editing ? "PUT" : "POST", body: pending,
      });
      await afterChange();
    } catch (err) {
      if (err.status >= 400 && err.status < 500) pending = null;
      error.textContent = pending ? `${err.message} برای بررسی نتیجه، همان پرداخت را دوباره ارسال کنید.` : err.message;
    } finally {
      busy = false;
      if (fields) fields.root.disabled = Boolean(pending);
      submit.disabled = false;
    }
  });
  return {
    open(purchaseId, onChanged) {
      id = purchaseId;
      changed = onChanged;
      receipt = null;
      clearEditor();
      content.replaceChildren();
      add.hidden = print.hidden = true;
      dialog.open();
      return load();
    },
  };
}

export function showPurchaseDetails(purchaseId, changed) {
  details ??= createDetails();
  return details.open(purchaseId, changed);
}

function purchaseReport(id, title) {
  let generation = 0;
  const dialog = curtain(`${id}Modal`, title, `
    <p id="${id}Status" role="status" class="mb-3 text-sm"></p>
    <ul id="${id}List" class="grid gap-2"></ul>
    <button type="button" id="${id}More" class="${secondary} mt-3" hidden>نمایش بیشتر</button>`);
  const list = $(`${id}List`);
  const status = $(`${id}Status`);
  const more = $(`${id}More`);
  return function open(fetchPage, describe, summary) {
    let position = null;
    let current;
    async function load() {
      const request = current;
      more.disabled = true;
      try {
        const result = await fetchPage(position);
        if (request !== generation) return;
        status.textContent = summary(result);
        list.append(...result.items.map((item) => {
          const row = node("li", "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-french-gray/30 p-3");
          row.append(node("span", "text-sm", describe(item).filter(Boolean).join(" · ")),
            button(`فاکتور ${item.invoice_number}`, () => showPurchaseDetails(item.id, reset)));
          return row;
        }));
        position = result.next;
        more.hidden = position === null;
      } catch (err) {
        if (request !== generation) return;
        status.textContent = err.message;
        more.hidden = false;
      } finally {
        if (request === generation) more.disabled = false;
      }
    }
    function reset() {
      position = null;
      current = ++generation;
      list.replaceChildren();
      more.hidden = true;
      status.textContent = "در حال دریافت گزارش…";
      return load();
    }
    more.onclick = load;
    dialog.open();
    return reset();
  };
}

export function showPurchaseObligations(endDate) {
  obligationsReport ??= purchaseReport("purchaseObligations", "تعهدات تأمین‌کنندگان");
  return obligationsReport(async (skip) => {
    const params = new URLSearchParams({ skip: skip ?? 0 });
    if (endDate) params.set("end_date", endDate);
    const result = await financeRequest(`/purchases/obligations?${params}`, { cache: "no-store" });
    const next = (skip ?? 0) + result.items.length;
    return { ...result, next: next < result.count && result.items.length ? next : null };
  }, (item) => [item.supplier_name || "تأمین‌کننده ثبت نشده", item.jalali_date, money(item.remaining)],
  (result) => result.count ? `مانده ${formatNumber(result.count)} فاکتور · ${money(result.amount)}` : "بدهی پرداخت‌نشده‌ای ثبت نشده است.");
}

export function showPurchaseExpenses(startDate, endDate) {
  expensesReport ??= purchaseReport("purchaseExpenses", "هزینه‌های خرید");
  return expensesReport(async (cursor) => {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    if (cursor) params.set("cursor", cursor);
    const result = await financeRequest(`/purchases/expenses?${params}`, { cache: "no-store" });
    return { ...result, next: result.next_cursor };
  }, (item) => [item.account_name, item.account_number, item.jalali_date, money(item.amount)],
  (result) => result.count ? `${formatNumber(result.count)} پرداخت در بازه انتخابی` : "پرداخت خریدی در این بازه ثبت نشده است.");
}

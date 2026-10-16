import { Dialog } from "../components/dialog.js";
import { financeRequest } from "../finance/finance-api.js";
import { node, money } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { showFinalInvoice } from "./invoice-export.js";
import { onExternalDataChange } from "../components/data-events.js";

let root,
  dialog,
  currentOrderId,
  version = 0;
const methodNames = {
  pos: "کارت‌خوان",
  cash: "نقدی",
  transfer: "کارت‌به‌کارت",
};
const paymentNames = {
  settled: "تسویه‌شده",
  partial: "پرداخت ناقص",
  unpaid: "بدون پرداخت",
};
const $ = (id) => root.querySelector(`#${id}`);

function setup() {
  if (root) return;
  root = node("div", "orders-modal hidden");
  root.id = "orderDetailsModal";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `<button type="button" class="orders-backdrop" data-dialog-close aria-label="بستن جزئیات"></button><section role="dialog" aria-modal="true" aria-labelledby="orderDetailsTitle" class="orders-glass scale-95 opacity-0"><header class="orders-dialog-header"><h2 id="orderDetailsTitle">جزئیات سفارش</h2><button type="button" class="orders-icon-button" data-dialog-close aria-label="بستن">×</button></header><div class="orders-dialog-body"><p id="orderDetailsStatus" role="status"></p><div id="orderDetailsContent"></div><p id="orderDetailsError" class="orders-error" role="alert" hidden></p></div><footer class="orders-dialog-footer"><button type="button" class="orders-secondary" data-dialog-close>بستن</button><button type="button" id="retryOrderDetails" class="orders-secondary" hidden>تلاش مجدد</button><button type="button" id="exportOrderDetails" class="orders-primary" disabled>چاپ و خروجی فاکتور</button></footer></section>`;
  document.body.append(root);
  dialog = new Dialog(root.id, {
    onCancel: () => {
      version++;
    },
  });
  const refresh = () => {
    if (!document.hidden && root.getAttribute("aria-hidden") === "false")
      showOrderDetails(currentOrderId);
  };
  onExternalDataChange(refresh);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pageshow", (event) => { if (event.persisted) refresh(); });
}
function section(title) {
  const block = node("section", "orders-detail-section");
  block.append(node("h3", "", title));
  return block;
}
function values(entries, classes = "orders-customer-details") {
  const list = node("dl", classes);
  entries.forEach(([label, value]) => {
    const cell = node("div");
    cell.append(
      node("dt", "", label),
      node("dd", "", String(value ?? "ثبت نشده")),
    );
    list.append(cell);
  });
  return list;
}
function render(order) {
  const content = $("orderDetailsContent");
  const meta = section("اطلاعات سفارش");
  meta.append(
    values([
      ["کد فاکتور", order.invoice_code],
      ["شماره سفارش", order.order_number],
      ["تاریخ شمسی", order.jalali_date],
      ["وضعیت سفارش", order.status === "completed" ? "تکمیل‌شده" : "فعال"],
      ["وضعیت پرداخت", paymentNames[order.payment_status]],
      ["تاریخ پرداخت", order.jalali_payment_date],
    ]),
  );
  const customer = section("اطلاعات مشتری");
  customer.append(
    values([
      ["نام مشتری", order.customer.name],
      ["کد مشتری", formatNumber(order.customer.code)],
      ["شماره‌های تماس", order.customer.phone_numbers.join("، ") || "ثبت نشده"],
      ["آدرس", order.customer.address || "ثبت نشده"],
    ]),
  );
  const items = section("اقلام فاکتور");
  const scroll = node("div", "orders-table-scroll");
  const table = node("table", "orders-items-table");
  const head = node("thead"),
    heading = node("tr");
  for (const label of [
    "ردیف",
    "کالا",
    "تعداد",
    "واحد",
    "مبلغ واحد (تومان)",
    "جمع ردیف (تومان)",
  ]) {
    const cell = node("th", "", label);
    cell.scope = "col";
    heading.append(cell);
  }
  head.append(heading);
  const body = node("tbody");
  order.items.forEach((item) => {
    const row = node("tr");
    for (const text of [
      formatNumber(item.position),
      `${item.product_name}${item.product_code ? ` · ${item.product_code}` : ""}`,
      formatNumber(item.quantity),
      item.unit,
      money(item.unit_price),
      money(item.total),
    ])
      row.append(node("td", "", text));
    body.append(row);
  });
  table.append(head, body);
  scroll.append(table);
  items.append(scroll);
  items.append(
    values(
      [
        ["جمع اقلام", money(order.subtotal)],
        ["تخفیف", money(order.discount)],
        ["جمع کل نهایی", money(order.total)],
        ["مبلغ پرداخت‌شده", money(order.paid)],
        ["مانده فاکتور", money(order.remaining)],
      ],
      "orders-record-totals",
    ),
  );
  const payments = section("جزئیات پرداخت");
  if (!order.payments.length)
    payments.append(node("p", "orders-hint", "پرداختی ثبت نشده است."));
  order.payments.forEach((payment) =>
    payments.append(
      values([
        ["روش پرداخت", methodNames[payment.method]],
        ["مبلغ", money(payment.amount)],
        ["حساب مقصد", payment.account_name],
        ["شناسه تراکنش", formatNumber(payment.transaction_id)],
      ]),
    ),
  );
  content.replaceChildren(meta, customer, items, payments);
  if (order.description) {
    const description = section("توضیحات فاکتور");
    description.append(
      node("p", "orders-detail-description", order.description),
    );
    content.append(description);
  }
}
export async function showOrderDetails(orderId) {
  setup();
  currentOrderId = orderId;
  const current = ++version;
  $("orderDetailsTitle").textContent = "جزئیات سفارش";
  $("orderDetailsStatus").textContent = "در حال دریافت جزئیات سفارش…";
  $("orderDetailsContent").replaceChildren();
  $("orderDetailsError").hidden = true;
  $("retryOrderDetails").hidden = true;
  $("exportOrderDetails").disabled = true;
  root.inert = false;
  dialog.open();
  try {
    const order = await financeRequest(`/orders/${orderId}`);
    if (current !== version) return;
    $("orderDetailsTitle").textContent = `جزئیات سفارش ${order.order_number}`;
    render(order);
    $("orderDetailsStatus").textContent = "";
    $("exportOrderDetails").disabled = false;
    $("exportOrderDetails").onclick = () => showFinalInvoice(order.id);
  } catch (error) {
    if (current !== version) return;
    $("orderDetailsStatus").textContent = "";
    $("orderDetailsError").textContent = error.message;
    $("orderDetailsError").hidden = false;
    $("retryOrderDetails").hidden = false;
    $("retryOrderDetails").onclick = () => showOrderDetails(orderId);
  }
}

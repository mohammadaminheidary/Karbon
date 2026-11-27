import { estimateInvoice } from "../invoices/issuance-preview.js";
import { mountDateInput } from "../components/date-input.js";
import { Dialog } from "../components/dialog.js";
import { NavbarPanelDialog } from "../components/navbar-panel-dialog.js";
import { onExternalDataChange, publishLocalDataChange } from "../components/data-events.js";
import { notify } from "../components/notifications.js";
import { showFinalInvoice } from "./invoice-export.js";
import { createProductPicker, positionOrderDropdown } from "./order-picker.js";
import { financeRequest, getBanks } from "../finance/finance-api.js";
import { paymentMethodCard, paymentMethods } from "../finance/payment-methods.js";
import { getCustomerOptions as getCustomers, getCustomer } from "../customers/customer-api.js";
import {
  fullName,
  genderLabel,
  formatDate,
  formatNumber,
  normalizeText,
  systemCustomerLabel,
} from "../customers/customer-utils.js";
import {
  node,
  money,
  amountValue,
  bindStrictAmount as amountInput,
  normalizeDigits,
  normalizeJalaliDate,
  formatJalaliInput,
  todayKey,
} from "../finance/finance-utils.js";

const today = () => normalizeDigits(formatJalaliInput(todayKey()));
const amountFormatter = new Intl.NumberFormat("en-US");
const formatted = (value) => amountFormatter.format(value);
const moneyLimit = 999999999999;

function modal(id, title, content, footer) {
  const registration = id === "createOrderModal";
  const root = node(
    registration ? "dialog" : "div",
    registration
      ? "orders-modal bottom-curtain orders-registration-panel"
      : "orders-modal hidden",
  );
  root.id = id;
  root.setAttribute("aria-hidden", "true");
  const body = `${content}<p class="orders-error" role="alert" hidden></p>`;
  root.innerHTML = `${registration ? "" : '<button type="button" class="orders-backdrop" data-dialog-close aria-label="انصراف"></button>'}
    <section role="dialog" aria-modal="true" aria-labelledby="${id}Title" class="orders-glass scale-95 opacity-0">
      <header class="orders-dialog-header"><h2 id="${id}Title">${title}</h2><button type="button" class="dialog-close-button" data-dialog-close aria-label="بستن"></button></header>
      <form novalidate><div class="orders-dialog-body">${registration ? `<div dir="rtl">${body}</div>` : body}</div><footer class="orders-dialog-footer">${footer}</footer></form>
    </section>`;
  document.body.append(root);
  return root;
}

export function initializeOrderDialogs(onSaved, { purchaseFlow, onClose = () => {} } = {}) {
  const purchase = Boolean(purchaseFlow);
  const title = purchase ? "ثبت خرید کالا" : "ثبت سفارش";
  const party = purchase ? "تأمین‌کننده" : "مشتری";
  const account = purchase ? "حساب مبدأ" : "حساب مقصد";
  const endpoint = purchase ? "/purchases" : "/orders";
  let banks = [],
    customer = null,
    editing = null,
    editPurchaseId,
    draftId,
    defaultBusinessDate,
    saving = false,
    loading = false,
    referencesReady = false;
  let invoiceWorkflow, invoiceTotal, discountEdited = false;
  let manualNumber = false,
    paymentStarted = false,
    paymentSources = [],
    submitted = null,
    loadVersion = 0;
  let searchVersion = 0,
    searchController,
    searchTimer,
    searchSkip = 0,
    renderedCustomerSearch;
  const create = modal(
    "createOrderModal",
    title,
    `
    <fieldset id="orderFields">
      <div class="orders-customer-picker">
        <label for="orderCustomerSearch">انتخاب ${party}${purchase ? " (اختیاری)" : ""}</label>
        <input id="orderCustomerSearch" type="search" autocomplete="off" maxlength="200" placeholder="کد ${party}، نام یا شماره تماس" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="orderCustomerOptions" />
        <div id="orderCustomerDropdown" class="orders-picker-dropdown" popover="manual"><div id="orderCustomerOptions" role="listbox" aria-label="${purchase ? "تأمین‌کنندگان" : "مشتریان"}"></div><p id="orderSearchStatus" class="orders-hint" role="status"></p><button id="orderCustomerMore" type="button" class="orders-secondary" hidden>نمایش بیشتر</button></div>
      </div>
      <div class="orders-customer-reveal" inert><div><dl id="orderCustomerDetails" class="orders-customer-details"></dl></div></div>
      <div class="orders-form-grid">
        <label>کد فاکتور<input id="orderInvoiceCode" readonly dir="ltr" /></label>
        <label>تاریخ شمسی<input id="orderDate" dir="ltr" maxlength="10" placeholder="۱۴۰۵/۰۷/۲۲" /></label>
        <label${purchase ? " hidden" : ""}>شماره سفارش<input id="orderNumber" maxlength="50" dir="ltr" /></label>
      </div>
      <div class="orders-items-heading"><h3>اقلام فاکتور</h3></div>
      <div class="orders-table-scroll"><table class="orders-items-table"><thead><tr><th>ردیف</th><th>کالا</th><th>تعداد</th><th>واحد</th><th>مبلغ واحد (تومان)</th><th>مبلغ کل (تومان)</th><th><span class="sr-only">حذف ردیف</span></th></tr></thead><tbody id="orderItems"></tbody></table></div>
      <label>توضیحات فاکتور<textarea id="orderDescription" rows="3" maxlength="${purchase ? 1000 : 5000}"></textarea></label>
      <section class="orders-discount" aria-labelledby="orderDiscountTitle">
        <h3 id="orderDiscountTitle">تخفیف</h3>
        <div class="orders-discount-fields">
          <fieldset id="orderDiscountKind" class="orders-discount-kind">
            <legend>نوع تخفیف</legend>
            <label><input type="radio" name="orderDiscountType" value="fixed" checked /> مبلغ ثابت</label>
            <label><input type="radio" name="orderDiscountType" value="percent" /> درصدی (%)</label>
          </fieldset>
          <label>مبلغ تخفیف (تومان)<input id="orderDiscount" inputmode="numeric" dir="ltr" maxlength="21" value="0" /></label>
          <label hidden>درصد تخفیف (%)<input id="orderDiscountPercent" inputmode="decimal" dir="ltr" maxlength="6" value="0" /></label>
          <div class="orders-discount-amount"><span>تخفیف اعمال‌شده</span><output id="orderDiscountAmount"></output></div>
        </div>
      </section>
      <div class="orders-totals"><div><span>جمع تعداد</span><output id="orderQuantityTotal"></output></div><div><span>جمع مبالغ واحد</span><output id="orderUnitPriceTotal"></output></div><div><span>جمع اقلام</span><output id="orderSubtotal"></output></div><div id="orderTaxes" hidden><span>مالیات</span><output id="orderTax"></output></div><div id="orderShippingRow" hidden><span>ارسال</span><output id="orderShipping"></output></div><div><span>جمع کل نهایی</span><output id="orderTotal"></output></div></div>
    </fieldset>
    <p id="orderLoadStatus" role="status"></p><button id="orderRetryLoad" class="orders-secondary" type="button" hidden>تلاش مجدد</button>`,
    `
    <button type="button" class="orders-secondary" data-dialog-close>انصراف</button><button id="orderPay" class="orders-primary" type="submit">پرداخت <span aria-hidden="true">←</span></button>`,
  );
  const payment = modal(
    "orderPaymentModal",
    "پرداخت فاکتور",
    `
    <fieldset id="paymentFields">
      <div class="orders-payment-top"><div><span>مبلغ کل فاکتور</span><output id="paymentInvoiceTotal"></output></div><label>تاریخ پرداخت (شمسی)<input id="paymentDate" dir="ltr" maxlength="10" /></label></div>
      <h3 id="paymentMethodsTitle">روش‌های پرداخت</h3><p class="orders-hint" id="paymentMethodsHint">${purchase ? "مبالغ پرداختی از حساب‌های مبدأ کسر می‌شوند. ثبت بدون پرداخت یا با پرداخت جزئی امکان‌پذیر است." : "یک یا چند روش را انتخاب کنید. پرداخت ناقص نیز قابل ثبت است."}</p>
      <div id="paymentMethods" class="orders-payment-methods"></div>
      ${purchase ? '<button id="addPaymentAccount" type="button" class="orders-secondary">+ افزودن حساب مبدأ</button>' : ""}
      <p class="orders-hint" id="paymentRemainingHint">با فشردن کلید <bdi>Space</bdi> در ورودی هر روش پرداخت، مبلغ باقی‌مانده فاکتور به‌صورت خودکار وارد می‌شود.</p>
      <div class="orders-totals"><div><span>مبلغ پرداختی</span><output id="paymentPaid"></output></div><div><span>مانده فاکتور</span><output id="paymentRemaining"></output></div>${purchase ? '<div><span>وضعیت پرداخت</span><output id="paymentState"></output></div>' : ""}</div>
    </fieldset><p id="paymentStatus" role="status"></p>`,
    `
    <button type="button" class="orders-secondary" data-dialog-close>انصراف</button><button id="editOrderInvoice" type="button" class="orders-secondary">ویرایش فاکتور</button><button id="finalizeOrder" type="submit" class="orders-primary">پرداخت نهایی</button>`,
  );
  const $ = (id) => document.getElementById(id);
  const customerSearch = $("orderCustomerSearch");
  const customerMenu = $("orderCustomerDropdown");
  const customerDetails = $("orderCustomerDetails");
  const customerReveal = customerDetails.closest(".orders-customer-reveal");
  const scrollBody = create.querySelector(".orders-dialog-body");
  const productPicker = createProductPicker(create, (input, product, changed) => {
    const row = input.closest(".orders-item-row");
    row.querySelector(".item-unit").textContent = product.unit;
    if (changed) row.querySelector(".item-price").value = purchase ? "" : formatted(product.price);
    calculate();
  }, { chooseCategory: purchase });
  const orderDate = mountDateInput($("orderDate"));
  const paymentDate = mountDateInput($("paymentDate"));
  const error = (root, message = "") => {
    const p = root.querySelector(".orders-error");
    p.textContent = message;
    p.hidden = !message;
  };
  const clearInvalid = (root) =>
    root
      .querySelectorAll('[aria-invalid="true"]')
      .forEach((input) => input.removeAttribute("aria-invalid"));
  const field = (input, validator) => {
    try {
      return validator(input.value);
    } catch (err) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      throw err;
    }
  };
  const date = (control) =>
    field(control.first, () => {
      const date = normalizeJalaliDate(control.value);
      if (!date) throw new Error("تاریخ شمسی الزامی است.");
      return date;
    });
  const amount = (input, zero = false) =>
    field(input, (value) => amountValue(value, { allowZero: zero }));
  const createDialog = new NavbarPanelDialog(create.id, {
    canClose: () => !saving,
    onCancel: () => {
      discard();
      onClose();
    },
  });
  const paymentDialog = new Dialog(payment.id, {
    canClose: () => !saving,
    onCancel: () => {
      // Keep an uncertain submission for the same idempotent retry on reopening.
      if (!submitted) discard();
      onClose();
    },
  });
  function openDialog(dialog, focus) {
    dialog.root.inert = false;
    dialog.open(focus);
  }
  function discard() {
    ++loadVersion;
    ++searchVersion;
    searchController?.abort();
    clearTimeout(searchTimer);
    searchTimer = undefined;
    renderedCustomerSearch = undefined;
    customerDropdown(false);
    productPicker.close();
    customer = null;
    editing = null;
    editPurchaseId = undefined;
    submitted = null;
    paymentStarted = false;
  }
  function busy() {
    $("orderFields").disabled = loading || saving;
    $("orderPay").disabled = loading || saving || !referencesReady;
    $("paymentFields").disabled = saving || Boolean(submitted);
    $("editOrderInvoice").disabled = saving || Boolean(submitted);
    $("finalizeOrder").disabled = loading || saving || (!submitted && !referencesReady);
    $("finalizeOrder").textContent = saving
      ? editing ? "در حال ذخیره…" : "در حال ثبت…"
      : submitted
        ? "تلاش مجدد"
        : editing ? "ذخیره تغییرات" : "پرداخت نهایی";
    for (const root of [create, payment]) {
      root
        .querySelector("form")
        .setAttribute("aria-busy", String(saving || loading));
      root.querySelectorAll("[data-dialog-close]").forEach((button) => {
        button.disabled = saving;
      });
    }
  }
  function customerDropdown(show) {
    show = show && positionOrderDropdown(customerMenu, customerSearch, create);
    customerSearch.setAttribute("aria-expanded", String(show));
    if (show === customerMenu.matches(":popover-open")) return;
    if (show) customerMenu.showPopover();
    else customerMenu.hidePopover();
  }
  async function searchCustomers(more = false) {
    const search = normalizeText(customerSearch.value);
    const version = ++searchVersion;
    searchController?.abort();
    searchController = new AbortController();
    if (!more) {
      searchSkip = 0;
      $("orderCustomerOptions").replaceChildren();
      renderedCustomerSearch = undefined;
    }
    $("orderSearchStatus").textContent = "در حال جستجو…";
    if (more && document.activeElement === $("orderCustomerMore"))
      customerSearch.focus({ preventScroll: true });
    $("orderCustomerMore").hidden = true;
    try {
      const data = await getCustomers({
        search,
        skip: searchSkip,
        limit: 20,
        signal: searchController.signal,
      });
      if (version !== searchVersion) return;
      renderedCustomerSearch = search;
      searchSkip += data.items.length;
      $("orderCustomerOptions").append(
        ...data.items.map((item) => {
          const description = [item.customer_code, fullName(item), item.phone_numbers.join("، ")];
          if (item.is_system) description.push(systemCustomerLabel);
          const option = node(
            "button",
            "orders-customer-option",
            description.filter(Boolean).join(" · "),
          );
          option.type = "button";
          option.setAttribute("role", "option");
          option.setAttribute(
            "aria-selected",
            String(customer?.id === item.id),
          );
          option.addEventListener("click", async () => {
            const selectedVersion = ++searchVersion;
            customerSearch.focus({ preventScroll: true });
            customerDropdown(false);
            customerSearch.value = `${item.customer_code} · ${fullName(item)}`;
            customer = null;
            renderCustomer();
            try {
              const selected = await getCustomer(item.id);
              if (selectedVersion !== searchVersion) return;
              customer = selected;
              renderCustomer();
              error(create);
            } catch (err) {
              if (selectedVersion === searchVersion) error(create, err.message);
            }
          });
          option.addEventListener("keydown", (event) => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              const options = [...$("orderCustomerOptions").children];
              options[
                (options.indexOf(option) +
                  (event.key === "ArrowDown" ? 1 : options.length - 1)) %
                  options.length
              ]?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              customerSearch.focus({ preventScroll: true });
              customerDropdown(false);
            }
          });
          return option;
        }),
      );
      $("orderSearchStatus").textContent = data.total
        ? `${formatNumber(data.total)} ${party}`
        : `${party} پیدا نشد.`;
      $("orderCustomerMore").hidden = searchSkip >= data.total;
    } catch (err) {
      if (version === searchVersion)
        $("orderSearchStatus").textContent = err.message;
    }
  }
  function renderCustomer() {
    customerReveal.inert = !customer;
    if (!customer) return;
    const name = [["نام", customer.first_name], ["نام خانوادگی", customer.last_name]];
    const phone = ["شماره‌های تماس", customer.phone_numbers.join("، ") || "ثبت نشده"];
    const address = ["آدرس", customer.address || "ثبت نشده"];
    const notes = [`توضیحات ${party}`, customer.notes || "ثبت نشده"];
    const fields = purchase ? [
      ...(customer.is_system
        ? [[party, fullName(customer)], [`نوع ${party}`, systemCustomerLabel]]
        : [...name, ["جنسیت", genderLabel(customer.gender)]]),
      ...(!customer.is_system || customer.phone_numbers.length ? [phone] : []),
      address, ["آخرین تماس", formatDate(customer.last_contact_date)], notes,
      ["تاریخ ثبت", formatDate(customer.created_at?.slice(0, 10))],
      ["آخرین ویرایش", formatDate(customer.updated_at?.slice(0, 10))],
    ] : [
      ...name, phone, address, notes,
      ["تعداد سفارش‌ها", formatNumber(customer.summary.order_count)],
      ["جمع سفارش‌ها", money(customer.summary.total_orders)],
      ["پرداختی", money(customer.summary.paid)], ["مانده", money(customer.summary.debt)],
    ];
    const content = document.createDocumentFragment();
    for (const [label, value] of [
      [`کد ${party}`, customer.customer_code],
      ...fields,
    ]) {
      const cell = node("div");
      cell.append(node("dt", "", label), node("dd", "", String(value)));
      content.append(cell);
    }
    customerDetails.replaceChildren(content);
  }
  customerSearch.addEventListener("input", () => {
    customer = null;
    renderCustomer();
    ++searchVersion;
    searchController?.abort();
    clearTimeout(searchTimer);
    $("orderCustomerOptions").replaceChildren();
    $("orderCustomerMore").hidden = true;
    $("orderSearchStatus").textContent = "در حال جستجو…";
    customerDropdown(true);
    renderedCustomerSearch = undefined;
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      if (customerMenu.matches(":popover-open")) searchCustomers();
    }, 160);
  });
  function openCustomerSearch() {
    if (customer || customerMenu.matches(":popover-open")) return;
    customerDropdown(true);
    if (!searchTimer && renderedCustomerSearch !== normalizeText(customerSearch.value))
      searchCustomers();
  }
  customerSearch.addEventListener("focus", openCustomerSearch);
  customerSearch.addEventListener("click", openCustomerSearch);
  customerSearch.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!customerMenu.matches(":popover-open")) openCustomerSearch();
      else $("orderCustomerOptions").firstElementChild?.focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (customerMenu.matches(":popover-open")) customerDropdown(false);
      else createDialog.cancel();
    }
  });
  const repositionCustomerMenu = () => {
    if (customerMenu.matches(":popover-open")) customerDropdown(true);
  };
  create.addEventListener("scroll", (event) => {
    if (!customerMenu.contains(event.target)) repositionCustomerMenu();
  }, true);
  window.addEventListener("resize", repositionCustomerMenu);
  window.visualViewport?.addEventListener("resize", repositionCustomerMenu);
  create.addEventListener("focusout", (event) => {
    const picker = customerSearch.closest(".orders-customer-picker");
    if (picker.contains(event.target) && !picker.contains(event.relatedTarget))
      customerDropdown(false);
  });
  create.addEventListener("click", (event) => {
    if (!event.target.closest(".orders-customer-picker"))
      customerDropdown(false);
  });
  for (const textarea of create.querySelectorAll("textarea")) {
    textarea.addEventListener("wheel", (event) => {
      // A textarea with no overflow can still consume wheel events in the
      // native dialog after a viewport resize.
      const { deltaMode, deltaY, ctrlKey, shiftKey } = event;
      if (ctrlKey || shiftKey || !deltaY ||
          textarea.scrollHeight > textarea.clientHeight) return;
      event.preventDefault();
      const unit = deltaMode === WheelEvent.DOM_DELTA_PAGE ? scrollBody.clientHeight
        : deltaMode === WheelEvent.DOM_DELTA_LINE ? parseFloat(getComputedStyle(textarea).lineHeight) || 16 : 1;
      scrollBody.scrollTop += deltaY * unit;
    }, { passive: false });
  }
  $("orderCustomerMore").addEventListener("click", () => searchCustomers(true));

  function renumber() {
    $("orderItems").querySelectorAll(".orders-item-row").forEach(
      (row, index, rows) => {
        row.querySelector(".item-number").textContent = formatNumber(index + 1);
        row.querySelector(".item-remove").disabled = rows.length <= 1;
      },
    );
  }
  function addRow(after = null, item = null) {
    if ($("orderItems").querySelectorAll(".orders-item-row").length >= 100) {
      error(create, "حداکثر ۱۰۰ ردیف قابل ثبت است.");
      return null;
    }
    const row = node("tr", "orders-item-row");
    row.innerHTML = `<td class="item-number"></td><td><div class="orders-product-field"><input class="item-product" autocomplete="off" maxlength="200" placeholder="انتخاب یا جستجوی کالا" aria-label="کالا" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="orderProductOptions" /></div></td><td><div class="orders-quantity-control" dir="ltr"><button class="orders-quantity-button item-quantity-decrease" type="button" aria-label="کاهش تعداد">−</button><input class="item-quantity" value="1" inputmode="numeric" dir="ltr" maxlength="7" role="spinbutton" aria-label="تعداد" aria-valuemin="1" aria-valuemax="1000000" aria-valuenow="1" /><button class="orders-quantity-button item-quantity-increase" type="button" aria-label="افزایش تعداد">+</button></div></td><td class="item-unit">—</td><td><input class="item-price" inputmode="numeric" dir="ltr" maxlength="21" aria-label="مبلغ واحد (تومان)" /></td><td><output class="item-total" aria-label="مبلغ کل ردیف (تومان)"></output></td><td><button class="orders-icon-button item-remove" type="button" aria-label="حذف ردیف" data-pointer-tooltip="حذف ردیف">×</button></td>`;
    const action = node("tr", "orders-row-action");
    const cell = node("td");
    cell.colSpan = 7;
    const add = node("button", "orders-add-row", "+ افزودن ردیف");
    add.type = "button";
    cell.append(add);
    action.append(cell);
    if (after) after.nextElementSibling.after(row, action);
    else $("orderItems").append(row, action);
    const productField = row.querySelector(".item-product"),
      price = row.querySelector(".item-price"),
      quantity = row.querySelector(".item-quantity");
    productPicker.bind(productField);
    if (item) {
      productField.dataset.productId = item.product_id;
      if (purchase) productField.dataset.categoryId = item.category_id;
      productPicker.restore(productField);
      quantity.value = String(item.quantity);
      price.value = formatted(item.unit_price);
      row.querySelector(".item-unit").textContent = item.unit;
    }
    amountInput(price, calculate);
    bindQuantity(row, quantity);
    price.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        addRow(row)?.querySelector(".item-product").focus();
      }
    });
    add.addEventListener("click", () =>
      addRow(row)?.querySelector(".item-product").focus(),
    );
    row.querySelector(".item-remove").addEventListener("click", () => {
      if ($("orderItems").querySelectorAll(".orders-item-row").length <= 1)
        return;
      action.remove();
      row.remove();
      renumber();
      calculate();
    });
    renumber();
    if (!item) calculate();
    return row;
  }
  function bindQuantity(row, input) {
    const control = row.querySelector(".orders-quantity-control");
    const decrease = row.querySelector(".item-quantity-decrease");
    const increase = row.querySelector(".item-quantity-increase");
    const maximum = 1000000;
    let lastValid = Number(input.value);
    function sync(updateTotals = true) {
      const value = input.value.trim() ? lastValid : null;
      if (value === null) input.removeAttribute("aria-valuenow");
      else input.setAttribute("aria-valuenow", String(value));
      decrease.disabled = lastValid <= 1;
      increase.disabled = lastValid >= maximum;
      if (updateTotals) calculate();
    }
    function step(delta) {
      if (input.matches(":disabled")) return;
      lastValid = Math.max(1, Math.min(maximum, lastValid + delta));
      input.value = String(lastValid);
      input.removeAttribute("aria-invalid");
      sync();
    }
    input.addEventListener("input", () => {
      const raw = normalizeDigits(input.value).trim();
      // A temporary empty value permits replacing the whole quantity by hand.
      if (raw) {
        const value = Number(raw);
        if (
          !/^\d+$/.test(raw) ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > maximum
        ) input.value = String(lastValid);
        else lastValid = value;
      }
      input.removeAttribute("aria-invalid");
      sync();
    });
    input.addEventListener("blur", () => {
      if (!input.value.trim()) {
        input.value = String(lastValid);
        input.removeAttribute("aria-invalid");
        sync();
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      step(event.key === "ArrowUp" ? 1 : -1);
    });
    decrease.addEventListener("click", () => step(-1));
    increase.addEventListener("click", () => step(1));
    control.addEventListener("wheel", (event) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY) step(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    sync(false);
  }
  function numeric(value, maximum = 1000000) {
    const raw = normalizeDigits(value).trim();
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) <= 0 ||
      Number(raw) > maximum
    )
      throw new Error("تعداد باید عدد صحیح مثبت و حداکثر ۱٬۰۰۰٬۰۰۰ باشد.");
    return Number(raw);
  }
  function invoiceItem(row, validate = false) {
    const input = row.querySelector(".item-product");
    const product = productPicker.get(input);
    const price = row.querySelector(".item-price");
    if (validate && !product) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      throw new Error("برای تمام ردیف‌ها کالا انتخاب کنید.");
    }
    if (!product && !price.value.trim()) return null;
    const quantityInput = row.querySelector(".item-quantity");
    const quantity = validate ? field(quantityInput, numeric) : numeric(quantityInput.value);
    const unit_price = validate ? amount(price, true) : amountValue(price.value, { allowZero: true });
    const lineTotal = quantity * unit_price;
    if (lineTotal > moneyLimit) throw new Error("جمع اقلام فاکتور معتبر نیست.");
    return { product_id: product?.id, quantity, unit_price, lineTotal,
      ...(purchase && product ? { category_id: Number(input.dataset.categoryId) } : {}) };
  }
  const discountKind = create.querySelector("form").elements.namedItem("orderDiscountType");
  const fixedDiscount = $("orderDiscount");
  const percentDiscount = $("orderDiscountPercent");

  function showDiscountKind(kind) {
    discountKind.value = kind;
    fixedDiscount.closest("label").hidden = kind !== "fixed";
    percentDiscount.closest("label").hidden = kind !== "percent";
  }
  function discountRate(value) {
    const raw = normalizeDigits(value).trim().replace("٫", ".");
    if (!/^\d{1,3}(?:\.\d{0,2})?$/.test(raw) || Number(raw) > 100)
      throw new Error("درصد تخفیف باید بین صفر و ۱۰۰ و حداکثر دو رقم اعشار باشد.");
    return Math.round(Number(raw) * 100);
  }
  function invoiceItemTotals(items) {
    let quantity = 0, unitPrices = 0, subtotal = 0;
    for (const item of items) {
      quantity += item.quantity;
      unitPrices += item.unit_price;
      subtotal += item.lineTotal;
    }
    if (subtotal > moneyLimit)
      throw new Error("جمع اقلام فاکتور معتبر نیست.");
    return { quantity, unitPrices, subtotal };
  }
  function invoiceValues(subtotal, validate = false) {
    let rules = editing?.edit_finance ?? invoiceWorkflow?.finance;
    let override = purchase ? editing?.discount_override ?? undefined : undefined;
    if (discountEdited) {
      if (discountKind.value === "percent") {
        const rate = validate ? field(percentDiscount, discountRate) : discountRate(percentDiscount.value);
        rules = { ...rules, discount_kind: "percent", discount_value: rate };
        override = undefined;
      } else {
        const fixedValue = (value) => {
          const discount = amountValue(value, { allowZero: true });
          if (discount > subtotal) throw new Error("مبلغ تخفیف از جمع اقلام بیشتر است و معتبر نیست.");
          return discount;
        };
        override = validate ? field(fixedDiscount, fixedValue) : fixedValue(fixedDiscount.value);
      }
    }
    const totals = estimateInvoice(subtotal, rules, override);
    if (editing && subtotal === editing.subtotal && totals.discount === editing.discount) {
      totals.tax = editing.tax;
      totals.total = editing.total;
    }
    if (totals.total > moneyLimit)
      throw new Error("جمع اقلام یا تخفیف فاکتور معتبر نیست.");
    return totals;
  }
  function calculate() {
    const items = [];
    let validItems = true;
    for (const row of $("orderItems").querySelectorAll(".orders-item-row")) {
      const output = row.querySelector(".item-total");
      try {
        const item = invoiceItem(row);
        if (item) items.push(item);
        output.textContent = item ? money(item.lineTotal) : "—";
      } catch {
        validItems = false;
        output.textContent = "—";
      }
    }
    let itemTotals, totals;
    try {
      if (validItems) {
        itemTotals = invoiceItemTotals(items);
        totals = invoiceValues(itemTotals.subtotal);
      }
    } catch { /* Keep the row outputs visible while a value is being corrected. */ }
    if (!discountEdited && discountKind.value === "fixed" && totals)
      fixedDiscount.value = formatted(totals.discount);
    invoiceTotal = totals?.total;
    $("orderQuantityTotal").textContent = itemTotals ? formatNumber(itemTotals.quantity) : "—";
    $("orderUnitPriceTotal").textContent = itemTotals ? money(itemTotals.unitPrices) : "—";
    $("orderSubtotal").textContent = itemTotals ? money(itemTotals.subtotal) : "—";
    $("orderTaxes").hidden = !totals?.tax;
    $("orderShippingRow").hidden = !totals?.shipping;
    for (const [id, value] of [
      ["orderDiscountAmount", totals?.discount],
      ["orderTax", totals?.tax],
      ["orderShipping", totals?.shipping],
      ["orderTotal", invoiceTotal],
    ]) $(id).textContent = value === undefined ? "—" : money(value);
  }
  function changeDiscount(input) {
    discountEdited = true;
    input.removeAttribute("aria-invalid");
    calculate();
  }
  amountInput(fixedDiscount, () => changeDiscount(fixedDiscount));
  percentDiscount.addEventListener("input", () => changeDiscount(percentDiscount));
  $("orderDiscountKind").addEventListener("change", (event) => {
    showDiscountKind(discountKind.value);
    changeDiscount(event.target);
  });
  $("orderNumber").addEventListener("input", () => {
    manualNumber = true;
  });

  function addPaymentMethod(key, method, label, icon, extra = false) {
    const prior = !purchase && editing?.edit_payments.find((payment) => payment.method === method);
    const checked = extra || (editing ? Boolean(prior) : method === "pos");
    const card = paymentMethodCard(`pay-${key}`, label, icon, { checked });
    card.insertAdjacentHTML("beforeend", `<div id="pay-${key}-fields" class="orders-method-fields" ${checked ? "" : "hidden"}><label>مبلغ (تومان)<input id="pay-${key}-amount" inputmode="numeric" dir="ltr" maxlength="21" value="0" /></label>${method === "cash" ? `<p class="orders-hint">${account} پرداخت: صندوق نقدی</p>` : `<label>${account}<select id="pay-${key}-bank"></select></label>`}${purchase ? `<label>شماره پیگیری (اختیاری)<input id="pay-${key}-tracking" maxlength="100" /></label>` : ""}</div>`);
    const toggle = card.querySelector("input[type=checkbox]");
    const input = card.querySelector("input[inputmode]");
    const bank = card.querySelector("select");
    if (prior) input.value = formatted(prior.amount);
    if (bank) {
      const available = banks.filter((b) => !b.is_cash && (b.active || b.id === prior?.bank_id));
      bank.replaceChildren(new Option("انتخاب حساب بانکی", ""), ...available.map((b) =>
        new Option(`${b.name} · ${[b.first_name, b.last_name].filter(Boolean).join(" ")} · ${b.card_number ? `…${b.card_number.slice(-4)}` : b.account_number}`, b.id)));
      if (prior) bank.value = String(prior.bank_id);
      if (!available.length)
        bank.after(node("p", "orders-hint", "حساب بانکی را در تنظیمات ← بانک تعریف کنید."));
    }
    toggle.addEventListener("change", () => {
      $(`pay-${key}-fields`).hidden = !toggle.checked;
      calculatePayments();
    });
    input.setAttribute("aria-describedby", "paymentRemainingHint");
    amountInput(input, calculatePayments);
    input.addEventListener("keydown", (event) => {
      if (event.key !== " " || event.isComposing || event.ctrlKey || event.altKey || event.metaKey ||
          input.matches(":disabled") || !toggle.checked) return;
      event.preventDefault();
      if (event.repeat || invoiceTotal === undefined) return;
      try {
        const otherPayments = paymentValues(false, key);
        input.value = formatted(Math.max(0, invoiceTotal - paidAmount(otherPayments)));
        input.removeAttribute("aria-invalid");
        error(payment);
        calculatePayments();
      } catch (err) {
        error(payment, err.message);
      }
    });
    if (extra) {
      const remove = node("button", "orders-secondary", "حذف این حساب");
      remove.type = "button";
      remove.addEventListener("click", () => {
        paymentSources = paymentSources.filter((source) => source.key !== key);
        card.remove();
        $("addPaymentAccount").disabled = false;
        $("addPaymentAccount").focus();
        calculatePayments();
      });
      card.append(remove);
    }
    paymentSources.push({ key, method, toggle, input, bank });
    $("paymentMethods").append(card);
    if (extra) bank.focus();
  }
  let extraAccount = 0;
  function renderPaymentMethods() {
    paymentSources = [];
    extraAccount = 0;
    $("paymentMethods").replaceChildren();
    const viewOnly = purchase && Boolean(editing);
    for (const id of ["paymentMethodsTitle", "paymentMethodsHint", "paymentRemainingHint"])
      $(id).hidden = viewOnly;
    if (purchase) {
      $("addPaymentAccount").hidden = viewOnly;
      $("addPaymentAccount").disabled = false;
      $("paymentDate").closest(".segmented-date-label").hidden = viewOnly;
    }
    if (!viewOnly)
      for (const [method, label, icon] of paymentMethods) addPaymentMethod(method, method, label, icon);
  }
  if (purchase) $("addPaymentAccount").addEventListener("click", () => {
    addPaymentMethod(`transfer-${++extraAccount}`, "transfer", "پرداخت از حساب دیگر", "⇄", true);
    $("addPaymentAccount").disabled = paymentSources.length >= 100;
  });
  function paymentValues(validate = false, excludedMethod) {
    const payments = [];
    for (const { key, method, toggle, input, bank } of paymentSources) {
      if (key === excludedMethod || !toggle.checked) continue;
      const value = validate ? amount(input, true) : amountValue(input.value, { allowZero: true });
      if (!value) continue;
      const bank_id = bank ? Number(bank.value) : null;
      if (validate && bank &&
          !banks.some((b) => b.id === bank_id && !b.is_cash &&
            (b.active || editing?.edit_payments?.some((p) => p.method === method && p.bank_id === bank_id)))) {
        bank.focus();
        throw new Error(`${account} پرداخت را انتخاب کنید.`);
      }
      payments.push({ method, amount: value, bank_id,
        ...(validate && purchase ? { tracking_number: $(`pay-${key}-tracking`).value.trim() || null } : {}) });
    }
    return payments;
  }
  const paidAmount = (payments) => payments.reduce((sum, entry) => sum + entry.amount, 0);
  function calculatePayments() {
    let paid;
    try {
      if (invoiceTotal !== undefined)
        paid = (purchase ? editing?.paid ?? 0 : 0) + paidAmount(submitted?.payments ?? paymentValues());
    } catch { /* Keep the totals pending until all enabled amounts are valid. */ }
    const remaining = paid === undefined ? undefined : invoiceTotal - paid;
    $("paymentPaid").textContent = paid === undefined ? "—" : money(paid);
    $("paymentRemaining").textContent = remaining === undefined ? "—" : money(remaining);
    $("paymentRemaining").classList.toggle("orders-negative", remaining < 0);
    if (purchase) $("paymentState").textContent = remaining === undefined || remaining < 0 ? "—"
      : remaining === 0 ? "تسویه‌شده" : paid ? "پرداخت جزئی" : "پرداخت‌نشده";
  }
  function validateInvoice() {
    clearInvalid(create);
    if (!purchase && !customer) {
      $("orderCustomerSearch").focus();
      throw new Error("مشتری را انتخاب کنید.");
    }
    const items = [...$("orderItems").querySelectorAll(".orders-item-row")].map((row) => invoiceItem(row, true));
    const { discount, total } = invoiceValues(invoiceItemTotals(items).subtotal, true);
    const invoiceNumber = !editing && invoiceWorkflow?.numbering?.manual ? $("orderInvoiceCode").value.trim() : "";
    if (!editing && invoiceWorkflow?.numbering?.required && !invoiceNumber) {
      $("orderInvoiceCode").focus();
      throw new Error("شماره فاکتور را وارد کنید.");
    }
    if (purchase) return { total, details: {
      catalog_only: true,
      supplier_id: customer?.id ?? null,
      rows: items.map(({ product_id, category_id, quantity, unit_price }) => ({
        product_id, category_id, quantity, purchase_price: unit_price,
      })),
      ...(discountEdited ? { discount } : {}),
      ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
      ...(!editing && invoiceWorkflow?.revision ? { invoice_settings_revision: invoiceWorkflow.revision } : {}),
      purchase_date: date(orderDate),
      description: $("orderDescription").value.trim() || null,
    } };
    return { total, details: {
      customer_id: customer.id,
      items: items.map(({ product_id, quantity, unit_price }) => ({ product_id, quantity, unit_price })),
      ...(discountEdited ? { discount } : {}),
      ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
      ...(!editing && invoiceWorkflow?.revision ? { invoice_settings_revision: invoiceWorkflow.revision } : {}),
      invoice_date: date(orderDate),
      order_number: manualNumber ? $("orderNumber").value.trim() || null : null,
      ...(editing?.delivery_address ? { delivery_address: editing.delivery_address } : {}),
      description: $("orderDescription").value.trim() || null,
    } };
  }
  create.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loading || saving || !referencesReady || createDialog.closing) return;
    error(create);
    try {
      const { total, details } = validateInvoice();
      customerDropdown(false);
      productPicker.close();
      invoiceTotal = total;
      $("paymentInvoiceTotal").textContent = money(total);
      if (!paymentStarted) {
        renderPaymentMethods();
        paymentDate.value = editing?.jalali_payment_date ??
          (purchase && details.purchase_date > defaultBusinessDate ? details.purchase_date : defaultBusinessDate);
        if (!editing && !purchase) $("pay-pos-amount").value = formatted(total);
        paymentStarted = true;
      }
      calculatePayments();
      error(payment);
      await createDialog.close();
      openDialog(paymentDialog, $("paymentDate"));
    } catch (err) {
      error(create, err.message);
    }
  });
  $("editOrderInvoice").addEventListener("click", () => {
    if (saving || submitted) return;
    paymentDialog.close();
    openDialog(createDialog, orderDate.first);
  });
  payment.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loading || saving || (!submitted && !referencesReady)) return;
    error(payment);
    clearInvalid(payment);
    try {
      if (!submitted) {
        const { total, details } = validateInvoice();
        const payments = paymentValues(true);
        if (paidAmount(payments) + (purchase ? editing?.paid ?? 0 : 0) > total)
          throw new Error("مجموع پرداخت‌ها نباید از مبلغ فاکتور بیشتر باشد.");
        const payload = {
          ...details,
          request_id: draftId,
          ...(!purchase ? { payment_date: date(paymentDate), payments } : {}),
          ...(editing ? { revision: editing.revision } : {}),
        };
        if (purchase && payments.length) {
          const transactionDate = date(paymentDate);
          if (transactionDate < details.purchase_date) {
            paymentDate.first.focus();
            throw new Error("تاریخ پرداخت نباید پیش از تاریخ فاکتور خرید باشد.");
          }
          payload.payments = payments.map((entry) => ({
            ...entry, request_id: crypto.randomUUID(), transaction_date: transactionDate,
          }));
        }
        submitted = payload;
        purchaseFlow?.store({ body: payload, id: editing?.id, total, paid: editing?.paid });
      }
      saving = true;
      busy();
      const order = editing;
      const record = purchase ? "خرید" : "سفارش";
      $("paymentStatus").textContent = order ? `در حال ذخیره تغییرات ${record}…` : `در حال ثبت ${record} و پرداخت‌ها…`;
      const saved = await financeRequest(order ? `${endpoint}/${order.id}` : endpoint, {
        method: order ? "PUT" : "POST",
        body: submitted,
      });
      paymentDialog.close();
      createDialog.close();
      discard();
      purchaseFlow?.store(null);
      onClose();
      if (purchase) {
        notify(`فاکتور خرید ${saved.invoice_number} ذخیره شد؛ پرداختی ${money(saved.paid)} و مانده ${money(saved.remaining)}.`, { type: "success" });
        onSaved(saved);
        showFinalInvoice(saved.id, { kind: "purchase" });
        return;
      }
      if (order) {
        notify(`تغییرات سفارش ${saved.order_number} ذخیره شد.`, { type: "success" });
        publishLocalDataChange();
        return;
      }
      notify(
        `سفارش ${saved.order_number} ثبت شد؛ پرداختی ${money(saved.paid)} و مانده ${money(saved.remaining)}.`,
        { type: "success" },
      );
      onSaved(saved);
      showFinalInvoice(saved.id);
    } catch (err) {
      if (err.status && err.status < 500) {
        if (purchase && !referencesReady) {
          // A restored retry has no editable fields yet. Reload its form.
          const retryId = editing?.id;
          discard();
          purchaseFlow.store(null);
          paymentDialog.close();
          saving = false;
          void openCreateOrder({ purchaseId: retryId, failure: err.message });
          return;
        }
        submitted = null;
        purchaseFlow?.store(null);
      }
      if (err.code === "INVOICE_SETTINGS_CHANGED") {
        await loadReferences();
        $("paymentInvoiceTotal").textContent = $("orderTotal").textContent;
        calculatePayments();
      }
      error(payment, err.message);
      $("paymentStatus").textContent = submitted
        ? "نتیجه درخواست مشخص نیست. تلاش مجدد همان اطلاعات را ارسال می‌کند."
        : "اطلاعات را اصلاح کنید و دوباره تلاش کنید.";
    } finally {
      saving = false;
      busy();
    }
  });

  async function loadReferences() {
    const version = ++loadVersion;
    loading = true;
    referencesReady = false;
    busy();
    $("orderLoadStatus").textContent = "در حال دریافت کالاها و حساب‌ها…";
    $("orderRetryLoad").hidden = true;
    try {
      const [catalog, accounts, next, selectedCustomer, purchaseEdit] = await Promise.all([
        purchase ? purchaseFlow.loadCatalog() : financeRequest("/products?for_order=true"),
        getBanks(),
        editing || editPurchaseId ? null : financeRequest(`${endpoint}/next-number`),
        !purchase && editing && !customer && !$("orderCustomerSearch").value ? getCustomer(editing.customer_id) : null,
        editPurchaseId && !editing ? purchaseFlow.loadEdit(editPurchaseId) : null,
      ]);
      if (version !== loadVersion) return;
      if (purchaseEdit) {
        editing = purchaseEdit.receipt;
        customer = purchaseEdit.supplier;
        if (customer) customerSearch.value = `${customer.customer_code} · ${fullName(customer)}`;
        renderCustomer();
        $("createOrderModalTitle").textContent = `ویرایش خرید ${editing.invoice_number}`;
        $("orderInvoiceCode").value = editing.invoice_number;
        $("orderDescription").value = editing.description ?? "";
        orderDate.value = editing.jalali_date;
      }
      const products = [...(purchase ? catalog.products : catalog)];
      if (editing && !purchase) {
        const available = new Set(catalog.map((item) => item.id));
        for (const item of editing.items) {
          if (available.has(item.product_id)) continue;
          available.add(item.product_id);
          products.push({ ...item, id: item.product_id, name: item.product_name, price: item.unit_price });
        }
        if (selectedCustomer) {
          customer = selectedCustomer;
          $("orderCustomerSearch").value = `${customer.customer_code} · ${fullName(customer)}`;
          renderCustomer();
        }
      }
      productPicker.setCatalog(products, catalog.categories);
      if (editing && !$("orderItems").children.length)
        editing.items.forEach((item) => addRow(null, item));
      banks = accounts;
      referencesReady = true;
      invoiceWorkflow = next;
      if (!discountEdited) {
        const finance = next?.finance ?? (purchase ? editing?.edit_finance : undefined);
        const override = purchase ? editing?.discount_override : null;
        showDiscountKind(override == null ? finance?.discount_kind ?? "fixed" : "fixed");
        fixedDiscount.value = formatted(override ?? (finance?.discount_kind === "fixed" ? finance.discount_value : 0));
        percentDiscount.value = finance?.discount_kind === "percent" ? String(finance.discount_value / 100) : "0";
      }
      const invoiceNumber = $("orderInvoiceCode");
      if (next) {
        const readOnly = !next.numbering?.manual;
        if (readOnly || invoiceNumber.readOnly) invoiceNumber.value = readOnly ? "هنگام ثبت نهایی تولید می‌شود" : "";
        invoiceNumber.readOnly = readOnly;
        invoiceNumber.maxLength = 32;
        invoiceNumber.placeholder = next.numbering?.required ? "شماره فاکتور" : "اختیاری؛ شماره خودکار در صورت خالی بودن";
        if (!purchase && !manualNumber) $("orderNumber").value = next.order_number;
      }
      if (next?.business_jalali) {
        if (orderDate.value === defaultBusinessDate) orderDate.value = next.business_jalali;
        defaultBusinessDate = normalizeDigits(next.business_jalali);
      }
      create.querySelectorAll(".item-product").forEach((input) => {
        productPicker.restore(input);
        const row = input.closest(".orders-item-row");
        const product = productPicker.get(input);
        const savedItem = editing?.items.find((item) => item.product_id === product?.id);
        row.querySelector(".item-unit").textContent = savedItem?.unit || product?.unit || "—";
        if (!product) row.querySelector(".item-price").value = "";
      });
      calculate();
      if (!submitted && payment.getAttribute("aria-hidden") === "false") {
        $("paymentInvoiceTotal").textContent = $("orderTotal").textContent;
        calculatePayments();
      }
      $("orderLoadStatus").textContent = purchase
        ? (catalog.hasSelectableProducts ? "" : "کالای قابل خریدی نیست. در تنظیمات انبار، کالا را به یک دسته‌بندی فعال اختصاص دهید و واحد آن را فعال کنید.")
        : (products.length ? "" : "کالایی با واحد فعال موجود نیست؛ کالا و واحد آن را در بخش‌های «کالاها» و «واحد» تنظیمات فعال کنید.");
      error(create);
    } catch (err) {
      if (version === loadVersion) {
        error(create, err.message);
        $("orderRetryLoad").hidden = false;
        $("orderLoadStatus").textContent = "";
      }
    } finally {
      if (version === loadVersion) {
        loading = false;
        busy();
      }
    }
  }
  $("orderRetryLoad").addEventListener("click", loadReferences);
  const refreshReferences = () => {
    if (
      !saving &&
      (!purchase || !submitted) &&
      !document.hidden &&
      [create, payment].some(
        (root) => root.getAttribute("aria-hidden") === "false",
      )
    )
      loadReferences();
  };
  onExternalDataChange(refreshReferences);
  document.addEventListener("visibilitychange", refreshReferences);
  async function openCreateOrder({ customer: initialCustomer = null, order = null, purchaseId, failure } = {}) {
    if (saving || createDialog.active || createDialog.closing || payment.getAttribute("aria-hidden") === "false") return;
    const pending = purchaseFlow?.restore();
    if (!submitted && pending) {
      submitted = pending.body;
      editing = pending.id ? { id: pending.id, paid: pending.paid } : null;
      invoiceTotal = pending.total;
      referencesReady = false;
      renderPaymentMethods();
      $("paymentInvoiceTotal").textContent = invoiceTotal == null ? "—" : money(invoiceTotal);
      $("orderPaymentModalTitle").textContent = "پرداخت فاکتور";
      error(payment);
      $("paymentStatus").textContent = "نتیجه ثبت قبلی مشخص نیست. برای ارسال دوباره همان اطلاعات، «تلاش مجدد» را انتخاب کنید.";
      calculatePayments();
      busy();
    }
    if (submitted) {
      openDialog(paymentDialog);
      if (initialCustomer && submitted.customer_id !== initialCustomer.id) {
        error(payment, "مشتری جدید ذخیره شد. ابتدا ثبت سفارش قبلی را که نتیجه‌اش مشخص نیست، پیگیری کنید.");
      }
      return;
    }
    draftId = crypto.randomUUID();
    submitted = null;
    editing = order;
    editPurchaseId = purchaseId;
    customer = initialCustomer;
    paymentStarted = false;
    manualNumber = Boolean(order);
    invoiceWorkflow = undefined;
    invoiceTotal = undefined;
    discountEdited = Boolean(order);
    $("orderInvoiceCode").readOnly = true;
    create.querySelector("form").reset();
    payment.querySelector("form").reset();
    error(create);
    error(payment);
    clearInvalid(create);
    clearInvalid(payment);
    $("paymentStatus").textContent = "";
    if (customer) $("orderCustomerSearch").value = `${customer.customer_code} · ${fullName(customer)}`;
    renderCustomer();
    customerDropdown(false);
    $("createOrderModalTitle").textContent = purchaseId ? "ویرایش خرید" : order ? `ویرایش سفارش ${order.order_number}` : title;
    $("orderPaymentModalTitle").textContent = order || purchaseId ? "بررسی پرداخت‌ها و ذخیره تغییرات" : "پرداخت فاکتور";
    $("orderPay").textContent = order || purchaseId ? "ادامه و بررسی پرداخت‌ها" : "پرداخت ←";
    $("orderInvoiceCode").value = order?.invoice_code ?? "هنگام ثبت نهایی تولید می‌شود";
    $("orderNumber").value = order?.order_number ?? "";
    $("orderDescription").value = order?.description ?? "";
    defaultBusinessDate = today();
    orderDate.value = order?.jalali_date ?? defaultBusinessDate;
    showDiscountKind("fixed");
    fixedDiscount.value = formatted(order?.discount ?? 0);
    $("orderItems").replaceChildren();
    if (!order && !purchaseId) addRow();
    openDialog(createDialog);
    scrollBody.scrollTop = 0;
    await loadReferences();
    if (failure && createDialog.active && referencesReady) error(create, failure);
  }
  openCreateOrder.cancel = () => {
    if (createDialog.active) createDialog.cancel();
    else if (payment.getAttribute("aria-hidden") === "false") paymentDialog.cancel();
  };
  return openCreateOrder;
}

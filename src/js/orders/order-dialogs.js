import { Dialog } from "../components/dialog.js";
import { NavbarPanelDialog } from "../components/navbar-panel-dialog.js";
import { onExternalDataChange } from "../components/data-events.js";
import { financeRequest, getBanks } from "../finance/finance-api.js";
import { getCustomers, getCustomer } from "../customers/customer-api.js";
import {
  fullName,
  genderLabel,
  formatDate,
  formatNumber,
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

const methods = [
  ["pos", "کارت‌خوان", "▣"],
  ["cash", "نقدی", "◈"],
  ["transfer", "کارت‌به‌کارت", "⇄"],
];
const today = () => formatJalaliInput(todayKey());
const formatted = (value) => new Intl.NumberFormat("en-US").format(value);

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
  root.innerHTML = `${registration ? "" : '<button type="button" class="orders-backdrop" data-dialog-close aria-label="انصراف"></button>'}
    <section role="dialog" aria-modal="true" aria-labelledby="${id}Title" class="orders-glass scale-95 opacity-0">
      <header class="orders-dialog-header"><h2 id="${id}Title">${title}</h2><button type="button" class="orders-icon-button" data-dialog-close aria-label="بستن">×</button></header>
      <form novalidate><div class="orders-dialog-body">${content}<p class="orders-error" role="alert" hidden></p></div><footer class="orders-dialog-footer">${footer}</footer></form>
    </section>`;
  document.body.append(root);
  return root;
}

export function initializeOrderDialogs(onSaved) {
  let products = [],
    banks = [],
    customer = null,
    draftId,
    saving = false,
    loading = false,
    referencesReady = false;
  let manualNumber = false,
    paymentStarted = false,
    submitted = null,
    loadVersion = 0;
  let searchVersion = 0,
    searchController,
    searchTimer,
    searchSkip = 0,
    searchTotal = 0;
  let customerResults = [];
  const create = modal(
    "createOrderModal",
    "ثبت سفارش",
    `
    <fieldset id="orderFields">
      <div class="orders-customer-picker">
        <label for="orderCustomerSearch">انتخاب مشتری</label>
        <input id="orderCustomerSearch" type="search" autocomplete="off" maxlength="200" placeholder="کد مشتری، نام یا شماره تماس" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="orderCustomerOptions" />
        <div id="orderCustomerDropdown" class="orders-customer-dropdown" hidden><div id="orderCustomerOptions" role="listbox" aria-label="مشتریان"></div><p id="orderSearchStatus" role="status"></p><button id="orderCustomerMore" type="button" class="orders-secondary" hidden>نمایش بیشتر</button></div>
      </div>
      <dl id="orderCustomerDetails" class="orders-customer-details" hidden></dl>
      <div class="orders-form-grid">
        <label>کد فاکتور<input id="orderInvoiceCode" readonly dir="ltr" /></label>
        <label>تاریخ شمسی<input id="orderDate" dir="ltr" maxlength="10" placeholder="۱۴۰۵/۰۷/۲۲" /></label>
        <label>شماره سفارش<input id="orderNumber" maxlength="50" dir="ltr" /></label>
      </div>
      <div class="orders-items-heading"><h3>اقلام فاکتور</h3></div>
      <div class="orders-table-scroll"><table class="orders-items-table"><thead><tr><th>ردیف</th><th>کالا</th><th>تعداد</th><th>واحد</th><th>مبلغ واحد (تومان)</th><th><span class="sr-only">حذف ردیف</span></th></tr></thead><tbody id="orderItems"></tbody></table></div>
      <label>توضیحات فاکتور<textarea id="orderDescription" rows="3" maxlength="5000"></textarea></label>
      <div class="orders-totals"><label>تخفیف (تومان)<input id="orderDiscount" inputmode="numeric" dir="ltr" maxlength="21" value="0" /></label><div><span>جمع اقلام</span><output id="orderSubtotal"></output></div><div><span>جمع کل نهایی</span><output id="orderTotal"></output></div></div>
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
      <h3>روش‌های پرداخت</h3><p class="orders-hint">یک یا چند روش را انتخاب کنید. پرداخت ناقص نیز قابل ثبت است.</p>
      <div id="paymentMethods" class="orders-payment-methods"></div>
      <div class="orders-totals"><div><span>مبلغ پرداختی</span><output id="paymentPaid"></output></div><div><span>مانده فاکتور</span><output id="paymentRemaining"></output></div></div>
    </fieldset><p id="paymentStatus" role="status"></p>`,
    `
    <button type="button" class="orders-secondary" data-dialog-close>انصراف</button><button id="editOrderInvoice" type="button" class="orders-secondary">ویرایش فاکتور</button><button id="finalizeOrder" type="submit" class="orders-primary">پرداخت نهایی</button>`,
  );
  const $ = (id) => document.getElementById(id);
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
  const date = (input) =>
    field(input, (value) => {
      const date = normalizeJalaliDate(value);
      if (!date) throw new Error("تاریخ شمسی الزامی است.");
      return date;
    });
  const amount = (input, zero = false) =>
    field(input, (value) => amountValue(value, { allowZero: zero }));
  const createDialog = new NavbarPanelDialog(create.id, {
    canClose: () => !saving,
    onCancel: discard,
  });
  const paymentDialog = new Dialog(payment.id, {
    canClose: () => !saving,
    onCancel: () => {
      // Keep an uncertain submission for the same idempotent retry on reopening.
      if (!submitted) discard();
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
    customer = null;
    submitted = null;
    paymentStarted = false;
  }
  function busy() {
    $("orderFields").disabled = loading || saving;
    $("orderPay").disabled = loading || saving || !referencesReady;
    $("paymentFields").disabled = saving || Boolean(submitted);
    $("editOrderInvoice").disabled = saving || Boolean(submitted);
    $("finalizeOrder").disabled = saving;
    $("finalizeOrder").textContent = saving
      ? "در حال ثبت…"
      : submitted
        ? "تلاش مجدد ثبت"
        : "پرداخت نهایی";
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
    $("orderCustomerDropdown").hidden = !show;
    $("orderCustomerSearch").setAttribute("aria-expanded", String(show));
  }
  async function searchCustomers(more = false) {
    const version = ++searchVersion;
    searchController?.abort();
    searchController = new AbortController();
    if (!more) {
      searchSkip = 0;
      customerResults = [];
      $("orderCustomerOptions").replaceChildren();
    }
    customerDropdown(true);
    $("orderSearchStatus").textContent = "در حال جستجو…";
    $("orderCustomerMore").hidden = true;
    try {
      const data = await getCustomers({
        search: $("orderCustomerSearch").value,
        skip: searchSkip,
        limit: 20,
        signal: searchController.signal,
      });
      if (version !== searchVersion) return;
      searchTotal = data.total;
      customerResults.push(...data.items);
      searchSkip += data.items.length;
      $("orderCustomerOptions").replaceChildren(
        ...customerResults.map((item) => {
          const option = node(
            "button",
            "orders-customer-option",
            `${item.customer_code} · ${fullName(item)} · ${item.phone_numbers.join("، ")}`,
          );
          option.type = "button";
          option.setAttribute("role", "option");
          option.setAttribute(
            "aria-selected",
            String(customer?.id === item.id),
          );
          option.addEventListener("click", async () => {
            const selectedVersion = ++searchVersion;
            customerDropdown(false);
            $("orderCustomerSearch").value =
              `${item.customer_code} · ${fullName(item)}`;
            customer = null;
            $("orderCustomerDetails").hidden = true;
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
              event.stopPropagation();
              customerDropdown(false);
              $("orderCustomerSearch").focus();
            }
          });
          return option;
        }),
      );
      $("orderSearchStatus").textContent = data.total
        ? `${formatNumber(data.total)} مشتری`
        : "مشتری پیدا نشد.";
      $("orderCustomerMore").hidden = searchSkip >= searchTotal;
    } catch (err) {
      if (version === searchVersion)
        $("orderSearchStatus").textContent = err.message;
    }
  }
  function renderCustomer() {
    const details = $("orderCustomerDetails");
    details.replaceChildren();
    details.hidden = !customer;
    if (!customer) return;
    for (const [label, value] of [
      ["کد مشتری", customer.customer_code],
      ["نام", customer.first_name],
      ["نام خانوادگی", customer.last_name],
      ["جنسیت", genderLabel(customer.gender)],
      ["شماره‌های تماس", customer.phone_numbers.join("، ") || "ثبت نشده"],
      ["آدرس", customer.address || "ثبت نشده"],
      ["آخرین تماس", formatDate(customer.last_contact_date)],
      ["توضیحات مشتری", customer.notes || "ثبت نشده"],
      ["تاریخ ثبت", formatDate(customer.created_at.slice(0, 10))],
      ["آخرین ویرایش", formatDate(customer.updated_at.slice(0, 10))],
      ["تعداد سفارش", formatNumber(customer.summary.order_count)],
      ["جمع سفارش‌ها", money(customer.summary.total_orders)],
      ["پرداختی", money(customer.summary.paid)],
      ["مانده", money(customer.summary.debt)],
    ]) {
      const cell = node("div");
      cell.append(node("dt", "", label), node("dd", "", String(value)));
      details.append(cell);
    }
  }
  $("orderCustomerSearch").addEventListener("input", () => {
    customer = null;
    renderCustomer();
    ++searchVersion;
    searchController?.abort();
    clearTimeout(searchTimer);
    $("orderCustomerOptions").replaceChildren();
    $("orderCustomerMore").hidden = true;
    $("orderSearchStatus").textContent = "در حال جستجو…";
    customerDropdown(true);
    searchTimer = setTimeout(() => searchCustomers(), 200);
  });
  $("orderCustomerSearch").addEventListener("focus", () => {
    if (!customer) searchCustomers();
  });
  $("orderCustomerSearch").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      $("orderCustomerOptions").firstElementChild?.focus();
    }
    if (event.key === "Escape" && !$("orderCustomerDropdown").hidden) {
      event.preventDefault();
      event.stopPropagation();
      customerDropdown(false);
    }
  });
  create.addEventListener("click", (event) => {
    if (!event.target.closest(".orders-customer-picker"))
      customerDropdown(false);
  });
  $("orderCustomerMore").addEventListener("click", () => searchCustomers(true));

  function productOptions(select) {
    const value = select.value;
    select.replaceChildren(
      new Option("انتخاب کالا", ""),
      ...products.map(
        (p) =>
          new Option(
            `${p.name}${p.stock == null ? "" : ` · موجودی ${formatNumber(p.stock)}`}`,
            p.id,
          ),
      ),
    );
    select.value = value;
  }
  function renumber() {
    [...$("orderItems").querySelectorAll(".orders-item-row")].forEach(
      (row, index) => {
        row.querySelector(".item-number").textContent = formatNumber(index + 1);
        row.querySelector(".item-remove").disabled =
          $("orderItems").querySelectorAll(".orders-item-row").length <= 1;
      },
    );
  }
  function addRow(after = null) {
    if ($("orderItems").querySelectorAll(".orders-item-row").length >= 100) {
      error(create, "حداکثر ۱۰۰ ردیف قابل ثبت است.");
      return null;
    }
    const row = node("tr", "orders-item-row");
    row.innerHTML = `<td class="item-number"></td><td><select class="item-product" aria-label="کالا"></select></td><td><input class="item-quantity" value="1" inputmode="numeric" dir="ltr" maxlength="7" aria-label="تعداد" /></td><td class="item-unit">—</td><td><input class="item-price" inputmode="numeric" dir="ltr" maxlength="21" aria-label="مبلغ واحد (تومان)" /><output class="item-total"></output></td><td><button class="orders-icon-button item-remove" type="button" aria-label="حذف ردیف">×</button></td>`;
    const action = node("tr", "orders-row-action");
    const cell = node("td");
    cell.colSpan = 6;
    const add = node("button", "orders-add-row", "+ افزودن ردیف");
    add.type = "button";
    cell.append(add);
    action.append(cell);
    if (after) after.nextElementSibling.after(row, action);
    else $("orderItems").append(row, action);
    const select = row.querySelector("select"),
      price = row.querySelector(".item-price"),
      quantity = row.querySelector(".item-quantity");
    productOptions(select);
    select.addEventListener("change", () => {
      const product = products.find((p) => p.id === Number(select.value));
      row.querySelector(".item-unit").textContent = product?.unit || "—";
      price.value = product ? formatted(product.price) : "";
      calculate();
    });
    amountInput(price, calculate);
    quantity.addEventListener("input", calculate);
    price.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        addRow(row)?.querySelector("select").focus();
      }
    });
    add.addEventListener("click", () =>
      addRow(row)?.querySelector("select").focus(),
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
    calculate();
    return row;
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
  function invoiceValues(validate = false) {
    const items = [...$("orderItems").querySelectorAll(".orders-item-row")].map(
      (row) => {
        const select = row.querySelector("select");
        const product = products.find((p) => p.id === Number(select.value));
        if (validate && !product) {
          select.setAttribute("aria-invalid", "true");
          select.focus();
          throw new Error("برای تمام ردیف‌ها کالا انتخاب کنید.");
        }
        const quantity = validate
          ? field(row.querySelector(".item-quantity"), numeric)
          : numeric(row.querySelector(".item-quantity").value);
        const unit_price = validate
          ? amount(row.querySelector(".item-price"), true)
          : amountValue(row.querySelector(".item-price").value, {
              allowZero: true,
            });
        const total = quantity * unit_price;
        row.querySelector(".item-total").textContent =
          `جمع ردیف: ${money(total)}`;
        return { product_id: product?.id, quantity, unit_price };
      },
    );
    const subtotal = items.reduce(
      (total, item) => total + item.quantity * item.unit_price,
      0,
    );
    const discount = validate
      ? amount($("orderDiscount"), true)
      : amountValue($("orderDiscount").value, { allowZero: true });
    if (subtotal > 999999999999 || discount > subtotal)
      throw new Error("جمع اقلام یا تخفیف فاکتور معتبر نیست.");
    return { items, subtotal, discount, total: subtotal - discount };
  }
  function calculate() {
    create.querySelectorAll(".orders-item-row").forEach((row) => {
      try {
        const quantity = numeric(row.querySelector(".item-quantity").value);
        const price = amountValue(row.querySelector(".item-price").value, {
          allowZero: true,
        });
        row.querySelector(".item-total").textContent =
          `جمع ردیف: ${money(quantity * price)}`;
      } catch {
        row.querySelector(".item-total").textContent = "جمع ردیف: —";
      }
    });
    try {
      const values = invoiceValues();
      $("orderSubtotal").textContent = money(values.subtotal);
      $("orderTotal").textContent = money(values.total);
    } catch {
      $("orderSubtotal").textContent = "—";
      $("orderTotal").textContent = "—";
    }
  }
  amountInput($("orderDiscount"), calculate);
  $("orderNumber").addEventListener("input", () => {
    manualNumber = true;
  });

  function renderPaymentMethods() {
    $("paymentMethods").replaceChildren(
      ...methods.map(([key, label, icon]) => {
        const card = node("div", "orders-method");
        card.innerHTML = `<label class="orders-method-choice"><input type="checkbox" id="pay-${key}" ${key === "pos" ? "checked" : ""} /><span class="orders-method-icon" aria-hidden="true">${icon}</span><span>${label}</span></label><div id="pay-${key}-fields" class="orders-method-fields" ${key === "pos" ? "" : "hidden"}><label>مبلغ (تومان)<input id="pay-${key}-amount" inputmode="numeric" dir="ltr" maxlength="21" value="0" /></label>${key === "cash" ? `<p class="orders-hint">حساب مقصد: صندوق نقدی</p>` : `<label>حساب مقصد<select id="pay-${key}-bank"></select></label>`}</div>`;
        if (key !== "cash") {
          const available = banks.filter((b) => b.active && !b.is_cash);
          card
            .querySelector("select")
            .replaceChildren(
              new Option("انتخاب حساب بانکی", ""),
              ...available.map(
                (b) =>
                  new Option(
                    `${b.name} · ${[b.first_name, b.last_name].filter(Boolean).join(" ")} · ${b.card_number ? `…${b.card_number.slice(-4)}` : b.account_number}`,
                    b.id,
                  ),
              ),
            );
          if (!available.length)
            card
              .querySelector("select")
              .after(
                node(
                  "p",
                  "orders-hint",
                  "حساب بانکی را در تنظیمات ← بانک تعریف کنید.",
                ),
              );
        }
        card
          .querySelector("input[type=checkbox]")
          .addEventListener("change", () => {
            $(`pay-${key}-fields`).hidden = !$(`pay-${key}`).checked;
            calculatePayments();
          });
        amountInput(card.querySelector("input[inputmode]"), calculatePayments);
        return card;
      }),
    );
  }
  function paymentValues(validate = false) {
    const payments = [];
    for (const [key] of methods) {
      if (!$(`pay-${key}`).checked) continue;
      const value = validate
        ? amount($(`pay-${key}-amount`), true)
        : amountValue($(`pay-${key}-amount`).value, { allowZero: true });
      if (!value) continue;
      let bank_id = null;
      if (key !== "cash") {
        bank_id = Number($(`pay-${key}-bank`).value);
        if (
          validate &&
          !banks.some((b) => b.id === bank_id && b.active && !b.is_cash)
        ) {
          $(`pay-${key}-bank`).focus();
          throw new Error("حساب مقصد پرداخت را انتخاب کنید.");
        }
      }
      payments.push({ method: key, amount: value, bank_id });
    }
    return payments;
  }
  function calculatePayments() {
    try {
      const total = invoiceValues().total;
      const paid = paymentValues().reduce((sum, p) => sum + p.amount, 0);
      $("paymentPaid").textContent = money(paid);
      $("paymentRemaining").textContent = money(total - paid);
      $("paymentRemaining").classList.toggle("orders-negative", paid > total);
    } catch {
      $("paymentPaid").textContent = "—";
      $("paymentRemaining").textContent = "—";
    }
  }
  function validateInvoice() {
    clearInvalid(create);
    if (!customer) {
      $("orderCustomerSearch").focus();
      throw new Error("مشتری را انتخاب کنید.");
    }
    const values = invoiceValues(true);
    return {
      customer_id: customer.id,
      items: values.items,
      discount: values.discount,
      invoice_date: date($("orderDate")),
      order_number: manualNumber ? $("orderNumber").value.trim() || null : null,
      description: $("orderDescription").value.trim() || null,
    };
  }
  create.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loading || saving || createDialog.closing) return;
    error(create);
    try {
      validateInvoice();
      customerDropdown(false);
      $("paymentInvoiceTotal").textContent = money(invoiceValues().total);
      if (!paymentStarted) {
        renderPaymentMethods();
        $("paymentDate").value = today();
        $("pay-pos-amount").value = formatted(invoiceValues().total);
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
    openDialog(createDialog, $("orderDate"));
  });
  payment.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    error(payment);
    clearInvalid(payment);
    try {
      if (!submitted) {
        const payload = {
          ...validateInvoice(),
          request_id: draftId,
          payment_date: date($("paymentDate")),
          payments: paymentValues(true),
        };
        const paid = payload.payments.reduce((sum, p) => sum + p.amount, 0);
        if (paid > invoiceValues().total)
          throw new Error("مجموع پرداخت‌ها نباید از مبلغ فاکتور بیشتر باشد.");
        submitted = payload;
      }
      saving = true;
      busy();
      $("paymentStatus").textContent = "در حال ثبت سفارش و پرداخت‌ها…";
      const saved = await financeRequest("/orders", {
        method: "POST",
        body: submitted,
      });
      paymentDialog.close();
      createDialog.close();
      discard();
      onSaved(saved);
    } catch (err) {
      if (err.status && err.status < 500) submitted = null;
      error(payment, err.message);
      $("paymentStatus").textContent = submitted
        ? "نتیجه ثبت مشخص نیست. برای جلوگیری از ثبت تکراری، تلاش مجدد همان فاکتور و همان پرداخت‌ها را ارسال می‌کند."
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
      const [catalog, accounts, next] = await Promise.all([
        financeRequest("/products"),
        getBanks(),
        financeRequest("/orders/next-number"),
      ]);
      if (version !== loadVersion) return;
      products = catalog;
      banks = accounts;
      referencesReady = true;
      if (!manualNumber) $("orderNumber").value = next.order_number;
      create.querySelectorAll(".item-product").forEach(productOptions);
      $("orderLoadStatus").textContent = products.length
        ? ""
        : "کالایی ثبت نشده است؛ ابتدا در «تنظیمات ← کالاها» کالا تعریف کنید.";
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
      !document.hidden &&
      [create, payment].some(
        (root) => root.getAttribute("aria-hidden") === "false",
      )
    )
      loadReferences();
  };
  onExternalDataChange(refreshReferences);
  document.addEventListener("visibilitychange", refreshReferences);
  return async function openCreateOrder() {
    if (saving || createDialog.active) return;
    if (submitted) {
      openDialog(paymentDialog);
      return;
    }
    draftId = crypto.randomUUID();
    submitted = null;
    customer = null;
    paymentStarted = false;
    manualNumber = false;
    create.querySelector("form").reset();
    payment.querySelector("form").reset();
    error(create);
    error(payment);
    clearInvalid(create);
    clearInvalid(payment);
    $("paymentStatus").textContent = "";
    renderCustomer();
    customerDropdown(false);
    $("orderInvoiceCode").value = "هنگام ثبت نهایی تولید می‌شود";
    $("orderDate").value = today();
    $("orderDiscount").value = "0";
    $("orderItems").replaceChildren();
    addRow();
    openDialog(createDialog);
    await loadReferences();
  };
}

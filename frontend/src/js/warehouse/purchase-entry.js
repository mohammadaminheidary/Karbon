import { estimateInvoice } from "../invoices/issuance-preview.js";
import { mountDateInput } from "../components/date-input.js";
import { createNavbarPanelTransition } from "../documents/navbar-panel-transition.js";
import { categoryIsSelectable, getInventoryOptions, populateCategorySelect } from "./inventory-options.js";
import { onPageRefresh } from "../components/data-events.js";
import { formatNumber, normalizeText } from "../customers/customer-utils.js";
import {
  node,
  money,
  bindStrictAmount,
  amountValue,
  normalizeDigits,
  normalizeJalaliDate,
} from "../finance/finance-utils.js";
import { financeRequest } from "../finance/finance-api.js";
import { getToken } from "../auth/auth-storage.js";

const $ = (id) => document.getElementById(id);
const priceFormat = new Intl.NumberFormat("en-US");

// The editable default uses Tehran time; the server allocates the final number.
function purchaseIdentity(
  now = new Date(),
  unique = crypto.randomUUID(),
) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tehran",
      calendar: "persian",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}/${parts.month}/${parts.day}`,
    requestId: unique,
    number: "تولید خودکار هنگام ثبت",
  };
}

export function initializePurchaseEntry({ onSaved }) {
  const panel = $("purchaseEntryPage");
  const warehouse = document.querySelector(".warehouse");
  const trigger = $("buyItemsButton");
  const form = $("purchaseEntryForm");
  const purchaseDate = mountDateInput($("purchaseDate"));
  const navbar = $("mainNavbar");
  let workflow, editing, entryKey, loadingEdit = false, editFailed = false;
  let numberEdited = false, supplierVersion = 0, supplierTimer;
  const productsById = new Map();
  const productsByCategory = new Map();
  let opened = false,
    identity,
    closing,
    sequence = 0,
    requestVersion = 0,
    categories = [],
    rows = [],
    nextRowId = 0,
    saving = false,
    loading = false,
    savedPurchase = null,
    pendingPayload = null;
  const pendingKey = "karbon-pending-purchase";

  function message(text, failed = false) {
    $("purchaseOptionsStatus").textContent = text;
    $("purchaseOptionsStatus").setAttribute(
      "role",
      failed ? "alert" : "status",
    );
  }

  const locked = () =>
    saving || Boolean(pendingPayload) || Boolean(savedPurchase);

  function syncControls() {
    const frozen = locked() || loadingEdit || editFailed;
    purchaseDate.readOnly = frozen;
    const numberInput = $("purchaseInvoiceNumber");
    numberInput.readOnly = frozen || Boolean(editing) || !workflow?.numbering?.manual;
    numberInput.setAttribute("aria-readonly", String(numberInput.readOnly));
    $("purchaseSupplierSearch").disabled = $("purchaseSupplier").disabled = frozen;
    $("viewPurchaseInvoice").hidden = !savedPurchase;
    for (const row of rows) {
      row.quantity.readOnly = row.price.readOnly = frozen;
      row.category.disabled =
        frozen || loading || row.category.options.length <= 1;
      row.product.disabled =
        frozen || loading || row.product.options.length <= 1;
      row.remove.disabled = frozen || loading || rows.length === 1;
    }
    $("addPurchaseRow").disabled = frozen || loading || rows.length >= 100;
    $("savePurchaseEntry").disabled =
      saving ||
      loadingEdit || editFailed ||
      Boolean(savedPurchase) ||
      (!pendingPayload && (loading || !rows.some((row) => row.product.value)));
    $("savePurchaseEntry").textContent = savedPurchase
      ? "خرید ثبت شد"
      : pendingPayload && !saving
        ? "تلاش مجدد ثبت خرید"
        : saving
          ? "در حال ثبت…"
          : editing ? "ذخیره ویرایش خرید" : "ثبت خرید";
    $("newPurchaseEntry").disabled = saving || Boolean(pendingPayload);
    $("reloadPurchaseOptions").disabled = saving || loading || loadingEdit;
  }

  function renderCategory(row, selected = row.category.value) {
    populateCategorySelect(row.category, categories, {
      current: pendingPayload ? Number(selected) : null,
      selected,
    });
  }

  function selectProducts(row, selected = "") {
    const products = productsByCategory.get(row.category.value) ?? [];
    row.product.replaceChildren(
      new Option(
        !row.category.value
          ? "ابتدا دسته‌بندی را انتخاب کنید"
          : products.length
            ? "انتخاب کالا"
            : "کالای فعالی وجود ندارد",
        "",
      ),
      ...products.map((item) => new Option([item.name, item.brand_name].filter(Boolean).join(" · "), String(item.id))),
    );
    row.product.value = selected;
    if (row.product.selectedIndex < 0) row.product.selectedIndex = 0;
    selectUnit(row);
  }

  function selectUnit(row) {
    row.unit.value = selectedProduct(row)?.unit || "";
  }

  function selectedProduct(row) {
    const product = productsById.get(row.product.value);
    if (product && String(product.category_id) === row.category.value) return product;
  }

  function quantityValue(value) {
    const raw = normalizeDigits(value).trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000000)
      throw new Error("مقدار خرید باید عدد صحیح بین ۱ و ۱٬۰۰۰٬۰۰۰ باشد.");
    return Number(raw);
  }

  function totals() {
    let quantity = 0,
      total = 0n;
    for (const row of rows) {
      let displayed = "—";
      try {
        const count = quantityValue(row.quantity.value);
        quantity += count;
        try {
          const price = amountValue(row.price.value, { allowZero: true });
          const value = BigInt(count) * BigInt(price);
          displayed = formatNumber(value);
          total += value;
        } catch {
          /* An incomplete price contributes after it becomes valid. */
        }
      } catch {
        /* Invalid quantities do not enter totals. */
      }
      if (row.total.value !== displayed) row.total.value = displayed;
    }
    $("purchaseQuantityTotal").textContent = formatNumber(quantity);
    $("purchaseRowCount").textContent = formatNumber(rows.length);
    const amount = total <= 999999999999n ? estimateInvoice(Number(total), workflow?.finance).total : null;
    $("purchaseInvoiceTotal").textContent = savedPurchase ? money(savedPurchase.total) : amount == null ? "—" : money(amount);
  }

  function labels() {
    rows.forEach((row, index) => {
      for (const [field, label] of [
        ["category", "دسته‌بندی"],
        ["product", "نام کالا"],
        ["quantity", "مقدار"],
        ["unit", "واحد"],
        ["price", "قیمت خرید"],
        ["total", "قیمت کل"],
        ["remove", "حذف"],
      ])
        row[field].setAttribute("aria-label", `${label} ردیف ${index + 1}`);
    });
  }

  function addRow(item = null) {
    if (rows.length >= 100) return;
    const suffix = nextRowId++;
    const row = {
      root: node("tr"),
      category: node("select", "purchase-category"),
      product: node("select", "purchase-product"),
      quantity: node("input", "purchase-quantity"),
      unit: node("input", "purchase-unit"),
      price: node("input", "purchase-price"),
      total: node("input", "purchase-total"),
      remove: node("button", "document-remove-row", "×"),
    };
    row.root.dataset.purchaseRow = String(suffix);
    for (const [field, id] of [
      ["category", "purchaseCategory"],
      ["product", "purchaseItemName"],
      ["quantity", "purchaseQuantity"],
      ["unit", "purchaseUnit"],
      ["price", "purchasePrice"],
      ["total", "purchaseTotalPrice"],
    ])
      row[field].id = suffix ? `${id}-${suffix}` : id;
    row.category.required =
      row.product.required =
      row.quantity.required =
      row.price.required =
        true;
    row.quantity.inputMode = row.price.inputMode = "numeric";
    row.quantity.dir = row.price.dir = row.total.dir = "ltr";
    row.quantity.maxLength = 7;
    row.price.maxLength = 21;
    row.quantity.autocomplete = row.price.autocomplete = "off";
    row.unit.readOnly = row.total.readOnly = true;
    row.unit.setAttribute("aria-readonly", "true");
    row.total.setAttribute("aria-readonly", "true");
    row.unit.placeholder = "—";
    row.remove.type = "button";
    for (const field of [
      "category",
      "product",
      "quantity",
      "unit",
      "price",
      "total",
      "remove",
    ]) {
      const cell = node("td");
      cell.append(row[field]);
      row.root.append(cell);
    }
    rows.push(row);
    $("purchaseRows").append(row.root);
    renderCategory(row, item ? String(item.category_id) : "");
    selectProducts(row, item ? String(item.product_id) : "");
    row.quantity.value = item?.quantity ?? "";
    row.price.value = item
      ? priceFormat.format(item.purchase_price)
      : "";
    row.category.addEventListener("change", () => {
      selectProducts(row);
      syncControls();
      totals();
    });
    row.product.addEventListener("change", () => {
      selectUnit(row);
      syncControls();
      totals();
    });
    row.quantity.addEventListener("input", totals);
    bindStrictAmount(row.price, totals);
    for (const field of [row.category, row.product, row.quantity, row.price])
      field.addEventListener("input", () =>
        field.removeAttribute("aria-invalid"),
      );
    row.remove.addEventListener("click", () => {
      if (locked() || loading || rows.length === 1) return;
      const index = rows.indexOf(row);
      rows.splice(index, 1);
      row.root.remove();
      labels();
      totals();
      syncControls();
      position();
      rows[Math.min(index, rows.length - 1)].category.focus();
    });
    return row;
  }

  function resetRows(items = [null]) {
    rows = [];
    nextRowId = 0;
    $("purchaseRows").replaceChildren();
    for (const item of items) addRow(item);
    labels();
    totals();
    syncControls();
  }

  function newEntry() {
    form.reset();
    editing = undefined;
    editFailed = false;
    identity = purchaseIdentity();
    purchaseDate.value = identity.date;
    $("purchaseInvoiceNumber").value = identity.number;
    $("purchaseSupplier").replaceChildren(new Option("انتخاب نشده", ""));
    $("purchaseSupplierStatus").textContent = "";
    supplierVersion++;
    workflow = undefined;
    numberEdited = false;
    savedPurchase = null;
    $("purchaseEntryTitle").textContent = "خرید کالا";
    $("purchaseStockHint").textContent = "پس از ثبت خرید، مقدار هر ردیف به موجودی کالای آن افزوده می‌شود.";
    resetRows();
    message("");
    void refreshNumber();
  }

  async function refreshNumber() {
    const current = identity;
    try {
      const result = await financeRequest("/purchases/next-number", {
        cache: "no-store",
      });
      if (identity === current && !editing && !loadingEdit && !savedPurchase && !pendingPayload) {
        workflow = result;
        const input = $("purchaseInvoiceNumber");
        if (!numberEdited || !result.numbering?.manual)
          input.value = result.numbering?.manual ? "" : result.invoice_number || identity.number;
        input.placeholder = result.numbering?.required ? "شماره فاکتور" : "اختیاری";
        syncControls();
        totals();
        if (result.business_jalali && purchaseDate.value === identity.date)
          purchaseDate.value = identity.date = normalizeDigits(result.business_jalali);
      }
    } catch {
      // Saving still works when the optional preview is unavailable.
    }
  }

  async function refreshOptions() {
    if (!opened || saving) return;
    const version = ++requestVersion;
    panel.setAttribute("aria-busy", "true");
    loading = true;
    if (!savedPurchase && !pendingPayload)
      message("در حال دریافت گزینه‌های تنظیمات…");
    syncControls();
    try {
      const [options, products] = await Promise.all([
        getInventoryOptions(),
        financeRequest("/products", { cache: "no-store" }),
      ]);
      if (version !== requestVersion || !opened) return;
      const selectable = new Set(options.categories.filter(categoryIsSelectable).map((category) => category.id));
      const units = new Set(options.units.filter((unit) => unit.active).map((unit) => normalizeText(unit.name)));
      productsById.clear();
      productsByCategory.clear();
      for (const product of products) {
        if (product.stock == null || !product.active || !units.has(normalizeText(product.unit)) ||
            !selectable.has(product.category_id)) continue;
        productsById.set(String(product.id), product);
        const key = String(product.category_id);
        if (!productsByCategory.has(key)) productsByCategory.set(key, []);
        productsByCategory.get(key).push(product);
      }
      categories = options.categories;
      if (!savedPurchase && !pendingPayload) {
        for (const row of rows) {
          const selected = row.product.value;
          renderCategory(row);
          selectProducts(row, selected);
        }
      } else if (pendingPayload) {
        const items = pendingPayload.rows || [pendingPayload];
        rows.forEach((row, index) => {
          const item = items[index];
          renderCategory(row, String(item.category_id));
          selectProducts(row, String(item.product_id));
        });
      }
      if (!savedPurchase && !pendingPayload)
        message(
          productsById.size
            ? ""
            : "کالای فعال دارای دسته‌بندی، واحد فعال و کنترل موجودی تعریف نشده است.",
        );
    } catch (error) {
      if (version !== requestVersion || !opened) return;
      productsById.clear();
      productsByCategory.clear();
      if (!savedPurchase && !pendingPayload) {
        categories = [];
        for (const row of rows) {
          renderCategory(row);
          selectProducts(row);
        }
        message(error.message, true);
      }
      return false;
    } finally {
      if (version === requestVersion) {
        panel.setAttribute("aria-busy", "false");
        loading = false;
        syncControls();
      }
    }
    return true;
  }

  async function loadEdit(id, current) {
    loadingEdit = true;
    editFailed = false;
    savedPurchase = null;
    editing = { id };
    identity = purchaseIdentity();
    supplierVersion++;
    form.reset();
    $("purchaseEntryTitle").textContent = "ویرایش خرید";
    $("purchaseStockHint").textContent = "پس از ذخیره، موجودی بر اساس تفاوت ردیف‌های قبلی و جدید بروزرسانی می‌شود.";
    $("purchaseInvoiceNumber").value = "";
    $("purchaseSupplier").replaceChildren(new Option("انتخاب نشده", ""));
    $("purchaseSupplierStatus").textContent = "";
    resetRows();
    syncControls();
    try {
      const [receipt, loaded] = await Promise.all([
        financeRequest(`/purchases/${id}?for_edit=true`, { cache: "no-store" }),
        refreshOptions(),
      ]);
      if (current !== sequence || !opened) return;
      editing = { id, revision: receipt.revision };
      workflow = { finance: receipt.finance };
      purchaseDate.value = receipt.jalali_date;
      $("purchaseInvoiceNumber").value = receipt.invoice_number;
      if (receipt.supplier_id) {
        $("purchaseSupplier").add(new Option(receipt.supplier?.name || String(receipt.supplier_id), String(receipt.supplier_id), true, true));
        $("purchaseSupplier").closest("details").open = true;
      }
      resetRows(receipt.rows);
      if (loaded && rows.some((row) => !selectedProduct(row)))
        message("برخی کالاهای این خرید تغییر کرده‌اند. دسته‌بندی و کالای فعال هر ردیف را دوباره انتخاب کنید.", true);
    } catch (error) {
      if (current !== sequence || !opened) return;
      editFailed = true;
      message(error.message, true);
    } finally {
      if (current === sequence) {
        loadingEdit = false;
        syncControls();
      }
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || savedPurchase || loadingEdit || editFailed) return;
    try {
      if (!pendingPayload) {
        if (loading) throw new Error("منتظر دریافت تنظیمات بمانید.");
        const date = normalizeJalaliDate(purchaseDate.value);
        if (!date) throw new Error("تاریخ خرید را وارد کنید.");
        if (!rows.length) throw new Error("حداقل یک ردیف خرید لازم است.");
        const items = rows.map((row, index) => {
          function invalid(field, text) {
            field.setAttribute("aria-invalid", "true");
            field.focus();
            throw new Error(`ردیف ${index + 1}: ${text}`);
          }
          if (!row.category.value)
            invalid(row.category, "دسته‌بندی را انتخاب کنید.");
          const product = selectedProduct(row);
          if (!product) invalid(row.product, "کالا را از فهرست انتخاب کنید.");
          if (!product.unit || row.unit.value !== product.unit) {
            selectUnit(row);
            invalid(row.product, "واحد کالا تغییر کرده است؛ ردیف را بررسی کنید.");
          }
          let quantity, price;
          try {
            quantity = quantityValue(row.quantity.value);
          } catch (error) {
            invalid(row.quantity, error.message);
          }
          try {
            price = amountValue(row.price.value, { allowZero: true });
          } catch (error) {
            invalid(row.price, error.message);
          }
          if (BigInt(quantity) * BigInt(price) > 999999999999n)
            invalid(row.price, "جمع مبلغ ردیف خرید بیش از حد مجاز است.");
          return {
            category_id: product.category_id,
            product_id: product.id,
            unit: product.unit,
            quantity,
            purchase_price: price,
          };
        });
        if (
          items.reduce(
            (sum, item) =>
              sum + BigInt(item.quantity) * BigInt(item.purchase_price),
            0n,
          ) > 999999999999n
        )
          throw new Error("جمع مبلغ خرید بیش از حد مجاز است.");
        const invoiceNumber = workflow?.numbering?.manual ? $("purchaseInvoiceNumber").value.trim() : "";
        if (workflow?.numbering?.required && !invoiceNumber) {
          $("purchaseInvoiceNumber").focus();
          throw new Error("شماره فاکتور را وارد کنید.");
        }
        const supplier = $("purchaseSupplier").value;
        pendingPayload = {
          request_id: identity.requestId,
          ...(editing ? { revision: editing.revision } : {}),
          ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
          ...(workflow?.revision ? { invoice_settings_revision: workflow.revision } : {}),
          ...(supplier ? { supplier_id: Number(supplier) } : {}),
          purchase_date: date,
          rows: items,
        };
        // Keep the exact request through timeouts, navigation and page reloads.
        try {
          sessionStorage.setItem(
            pendingKey,
            JSON.stringify({ owner: getToken(), body: pendingPayload, editing }),
          );
        } catch {
          /* Memory retry remains available. */
        }
      }
      saving = true;
      syncControls();
      message("در حال ثبت خرید…");
      savedPurchase = await financeRequest(editing ? `/purchases/${editing.id}` : "/purchases", {
        method: editing ? "PUT" : "POST",
        body: pendingPayload,
      });
      pendingPayload = null;
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* No stored retry. */
      }
      $("purchaseInvoiceNumber").value = savedPurchase.invoice_number;
      purchaseDate.value = savedPurchase.jalali_date;
      savedPurchase.rows.forEach((item, index) => {
        const row = rows[index];
        row.category.replaceChildren(
          new Option(item.category_path ?? item.category_name, String(item.category_id)),
        );
        row.product.replaceChildren(
          new Option([item.product_name, item.brand_name].filter(Boolean).join(" · "), String(item.product_id)),
        );
        row.unit.value = item.unit;
      });
      totals();
      message(
        `خرید ${savedPurchase.invoice_number} با ${formatNumber(savedPurchase.row_count)} ردیف ${editing ? "ویرایش" : "ثبت"} و موجودی کالاها بروزرسانی شد.`,
      );
      void onSaved();
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        pendingPayload = null;
        try {
          sessionStorage.removeItem(pendingKey);
        } catch {
          /* No stored retry. */
        }
      }
      if (editing && (error.code === "PURCHASE_CHANGED" || error.status === 404)) editFailed = true;
      if (error.code === "INVOICE_SETTINGS_CHANGED") void refreshNumber();
      message(
        pendingPayload
          ? `${error.message} برای بررسی و تکمیل همین خرید، «تلاش مجدد ثبت خرید» را انتخاب کنید.`
          : error.message,
        true,
      );
    } finally {
      saving = false;
      syncControls();
    }
  }

  // Match NavbarPanelDialog.position() and its shared registration-panel CSS.
  // The purchase surface remains a section, with no dialog or modal backdrop.
  function position() {
    const rect = navbar.getBoundingClientRect();
    panel.style.setProperty("--task-curtain-width", `${rect.width}px`);
    const width = panel.getBoundingClientRect().width || window.innerWidth - 32;
    const bottom = Math.max(12, window.innerHeight - rect.bottom);
    panel.style.setProperty(
      "--task-curtain-left",
      `${(window.innerWidth - width) / 2}px`,
    );
    panel.style.setProperty("--task-navbar-height", `${rect.height}px`);
    panel.style.setProperty("--task-curtain-bottom", `${bottom}px`);
    panel.style.setProperty(
      "--task-form-height",
      `${Math.min(form.scrollHeight, window.innerHeight - bottom - 16)}px`,
    );
  }

  const transition = createNavbarPanelTransition(panel, {
    position,
    show: () => {
      panel.hidden = false;
      panel.inert = false;
      panel.setAttribute("aria-hidden", "false");
      warehouse.inert = true;
      document.body.classList.add("overflow-hidden");
    },
    hide: () => {
      panel.hidden = true;
      panel.inert = true;
      panel.setAttribute("aria-hidden", "true");
      warehouse.inert = false;
      document.body.classList.remove("overflow-hidden");
      trigger.focus({ preventScroll: true });
    },
  });
  const observer = new ResizeObserver(() => {
    if (transition.active && !closing) position();
  });
  observer.observe(form);

  async function reveal(show, nextKey) {
    const current = ++sequence;
    if (show) {
      // Finish a pending collapse before reopening. Reference data never gates
      // the shared transition, so the navbar responds on the next frame.
      await closing;
      if (current !== sequence || !opened) return;
      const changed = entryKey !== nextKey;
      entryKey = nextKey;
      if (!pendingPayload && nextKey === "purchase" && (changed || !identity)) newEntry();
      const revealing = transition.open();
      if (!pendingPayload && nextKey !== "purchase" && (changed || !editing?.revision))
        void loadEdit(nextKey.slice("purchase-edit-".length), current);
      else void refreshOptions();
      await revealing;
      if (current === sequence && opened && transition.active)
        $("purchaseDate").focus({ preventScroll: true });
    } else {
      requestVersion++;
      loadingEdit = false;
      panel.setAttribute("aria-busy", "false");
      closing = transition.close();
      await closing;
      closing = undefined;
    }
  }

  function syncRoute() {
    const hash = location.hash.slice(1);
    const next = hash === "purchase" || /^purchase-edit-[1-9]\d*$/.test(hash);
    if (next === opened && (!next || entryKey === hash || saving || pendingPayload)) return;
    opened = next;
    trigger.setAttribute("aria-expanded", String(opened));
    void reveal(opened, hash);
  }

  function close() {
    if (!opened) return;
    history.replaceState(null, "", location.pathname + location.search);
    syncRoute();
  }
  trigger.addEventListener("click", () => {
    if (opened) return;
    location.hash = "purchase";
  });
  $("closePurchaseEntry").addEventListener("click", close);
  $("newPurchaseEntry").addEventListener("click", () => {
    if (saving || pendingPayload) return;
    if (entryKey !== "purchase") {
      location.hash = "purchase";
      return;
    }
    newEntry();
    void refreshOptions();
    $("purchaseDate").focus();
  });
  $("reloadPurchaseOptions").addEventListener("click", () => {
    if (editing && editFailed) {
      void loadEdit(editing.id, sequence);
      return;
    }
    void refreshNumber();
    void refreshOptions();
  });
  $("addPurchaseRow").addEventListener("click", () => {
    if (locked() || loading) return;
    const row = addRow();
    if (!row) return;
    labels();
    totals();
    syncControls();
    position();
    row.category.focus();
  });
  form.addEventListener("submit", submit);
  $("purchaseInvoiceNumber").addEventListener("input", () => { numberEdited = true; });
  $("viewPurchaseInvoice").addEventListener("click", async () => {
    if (!savedPurchase) return;
    const { showFinalInvoice } = await import("../orders/invoice-export.js");
    showFinalInvoice(savedPurchase.id, { kind: "purchase" });
  });
  $("purchaseSupplierSearch").addEventListener("input", () => {
    clearTimeout(supplierTimer);
    const version = ++supplierVersion;
    supplierTimer = setTimeout(async () => {
      const search = $("purchaseSupplierSearch").value.trim();
      const select = $("purchaseSupplier");
      const chosen = select.value ? select.selectedOptions[0].cloneNode(true) : null;
      try {
        const result = await financeRequest(`/customers/options?${new URLSearchParams({ search, limit: 25 })}`);
        if (version !== supplierVersion) return;
        const options = result.items.filter((item) => String(item.id) !== chosen?.value)
          .map((item) => new Option(`${item.customer_code} · ${item.first_name} ${item.last_name}`, String(item.id)));
        select.replaceChildren(new Option("انتخاب نشده", ""), ...[chosen].filter(Boolean), ...options);
        if (chosen) select.value = chosen.value;
        $("purchaseSupplierStatus").textContent = result.total > 25 ? "برای نتایج دقیق‌تر، نام یا کد را وارد کنید."
          : options.length || chosen ? "" : "طرف حساب پیدا نشد.";
      } catch (error) {
        if (version === supplierVersion) $("purchaseSupplierStatus").textContent = error.message;
      }
    }, 250);
  });

  try {
    const stored = JSON.parse(sessionStorage.getItem(pendingKey));
    const pending = stored?.owner === getToken() ? stored.body : null;
    if (pending?.request_id && (pending.rows?.length || pending.product_id)) {
      pendingPayload = pending;
      editing = stored.editing;
      if (editing) $("purchaseEntryTitle").textContent = "ویرایش خرید";
      identity = { requestId: pending.request_id };
      purchaseDate.value = pending.purchase_date;
      resetRows(pending.rows || [pending]);
      $("purchaseInvoiceNumber").value = "در انتظار تأیید ثبت";
      message(
        "نتیجه خرید قبلی تأیید نشده است. برای بررسی و تکمیل همان خرید، «تلاش مجدد ثبت خرید» را انتخاب کنید.",
      );
      syncControls();
    }
  } catch {
    /* An unavailable browser store does not block purchase entry. */
  }
  window.addEventListener("hashchange", syncRoute);
  window.addEventListener("popstate", syncRoute);
  document.addEventListener("keydown", (event) => {
    if (opened && event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  // The shared transition settles on pagehide; restore a hash entry when the
  // browser revives this document from its Back/Forward cache.
  window.addEventListener("pagehide", () => {
    opened = false;
    sequence++;
    requestVersion++;
    panel.setAttribute("aria-busy", "false");
    trigger.setAttribute("aria-expanded", "false");
  });
  window.addEventListener("pageshow", syncRoute);
  onPageRefresh(refreshOptions, { isVisible: () => opened });
  syncRoute();
}

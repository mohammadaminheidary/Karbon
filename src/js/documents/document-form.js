import { createNavbarPanelTransition } from "./navbar-panel-transition.js";
import { financeRequest, getBanks } from "../finance/finance-api.js";
import {
  node,
  money,
  todayKey,
  formatJalaliInput,
  normalizeJalaliDate,
  amountValue,
  bindStrictAmount,
} from "../finance/finance-utils.js";

export function initializeDocumentForm({ notify, onSaved, onIdle }) {
  const $ = (id) => document.getElementById(id);
  const curtain = $("documentCurtain"),
    navbar = $("mainNavbar");
  document.body.append(curtain);
  curtain.classList.add(
    "document-registration-panel",
    "navbar-transition-panel",
  );
  let editing = null,
    saving = false,
    closing = false,
    optionsReady = false,
    optionsVersion = 0;
  let banks = [],
    accounts = [],
    rows = [],
    requestId,
    requestFingerprint;

  function position() {
    const rect = navbar.getBoundingClientRect(),
      width = curtain.getBoundingClientRect().width || window.innerWidth - 32;
    const bottom = Math.max(12, window.innerHeight - rect.bottom);
    curtain.style.setProperty(
      "--task-curtain-left",
      `${(window.innerWidth - width) / 2}px`,
    );

    curtain.style.setProperty("--task-navbar-height", `${rect.height}px`);
    curtain.style.setProperty("--task-curtain-bottom", `${bottom}px`);
    curtain.style.setProperty(
      "--task-form-height",
      `${Math.min($("documentForm").scrollHeight, window.innerHeight - bottom - 16)}px`,
    );
  }
  const transition = createNavbarPanelTransition(curtain, { position });
  function busy() {
    $("documentForm").setAttribute(
      "aria-busy",
      String(saving || !optionsReady),
    );
    $("documentForm")
      .querySelectorAll("input, select, textarea, button")
      .forEach((control) => {
        control.disabled =
          saving ||
          (!optionsReady &&
            control.id !== "cancelDocument" &&
            control.id !== "retryDocumentOptions");
      });
    $("addDocumentRow").disabled =
      saving || !optionsReady || rows.length >= 100;
    $("saveDocument").textContent = saving
      ? "در حال ثبت..."
      : editing
        ? "ذخیره تغییرات"
        : "ثبت سند";
    rows.forEach(
      (row) =>
        (row.remove.disabled = saving || !optionsReady || rows.length === 1),
    );
  }
  async function loadOptions() {
    const version = ++optionsVersion;
    optionsReady = false;
    busy();
    $("retryDocumentOptions").hidden = true;
    $("documentOptionsStatus").textContent =
      "در حال دریافت حساب‌ها و بانک‌ها...";
    try {
      const [bankAccounts, documentAccounts, preview] = await Promise.all([
        getBanks(),
        financeRequest("/settings/document-accounts"),
        editing
          ? Promise.resolve({ number: editing.number })
          : financeRequest("/documents/next-number"),
      ]);
      if (version !== optionsVersion || !curtain.open) return;
      banks = bankAccounts;
      accounts = documentAccounts;
      $("documentNumber").textContent = preview.number;
      rows.forEach((row) => {
        renderSources(row);
        renderBanks(row);
      });
      optionsReady = true;
      $("documentOptionsStatus").textContent = !banks.some(
        (bank) => bank.active,
      )
        ? "برای ثبت ردیف جدید، ابتدا حساب فعال در بخش بانک تعریف کنید."
        : !accounts.some((account) => account.active)
          ? "ابتدا حساب‌های مستقل سند را در تنظیمات تعریف کنید."
          : "";
    } catch (error) {
      if (version !== optionsVersion) return;
      $("documentOptionsStatus").textContent = error.message;
      $("retryDocumentOptions").hidden = false;
    } finally {
      if (version === optionsVersion) {
        busy();
        position();
      }
    }
  }
  function choices(select, options, placeholder, label, selected) {
    select.replaceChildren(
      new Option(placeholder, ""),
      ...options.map((item) => new Option(label(item), String(item.id))),
    );
    select.value = selected || "";
  }
  function renderSources(row) {
    const kind = row.kind.value,
      original = row.original?.kind === kind;
    const originalId = original ? row.original.document_account_id : null;
    const selected = row.source.value || originalId;
    const records = accounts.filter(
      (item) => item.kind === kind && (item.active || item.id === originalId),
    );
    if (originalId && !records.some((item) => item.id === originalId))
      records.push({
        id: originalId,
        title: `${row.original.title} (بایگانی‌شده)`,
        code: row.original.account_code,
      });
    choices(
      row.source,
      records,
      "انتخاب حساب سند",
      (item) => `${item.code} · ${item.title}`,
      selected,
    );
    row.source.title = "حساب مستقل سند";
  }
  function renderBanks(row) {
    const selected = row.bank.value || row.original?.bank_id;
    const records = banks.filter(
      (bank) => bank.active || bank.id === row.original?.bank_id,
    );
    choices(row.bank, records, "انتخاب بانک", (bank) => bank.name, selected);
  }
  function addRow(item = null) {
    if (rows.length >= 100) return;
    const row = {
      original: item,
      root: node("tr"),
      source: node("select"),
      kind: node("select"),
      bank: node("select"),
      description: node("input"),
      amount: node("input"),
      remove: node("button", "document-remove-row", "×"),
    };
    row.kind.append(
      new Option("هزینه", "expense"),
      new Option("درآمد", "income"),
    );
    row.kind.value = item?.kind || "expense";
    row.source.required = row.bank.required = row.amount.required = true;
    row.description.type = "text";
    row.description.maxLength = 5000;
    row.description.value = item?.description || "";
    row.description.placeholder = "شرح تراکنش";
    row.amount.inputMode = "numeric";
    row.amount.dir = "ltr";
    row.amount.maxLength = 20;
    row.amount.placeholder = "مثلاً 1,250,000 تومان";
    row.amount.autocomplete = "off";
    row.amount.value = item
      ? new Intl.NumberFormat("en-US").format(item.amount)
      : "";
    row.remove.type = "button";
    for (const control of [
      row.source,
      row.kind,
      row.bank,
      row.description,
      row.amount,
      row.remove,
    ]) {
      const cell = node("td");
      cell.append(control);
      row.root.append(cell);
    }
    rows.push(row);
    $("documentRows").append(row.root);
    renderSources(row);
    renderBanks(row);
    row.kind.addEventListener("change", () => {
      row.source.value = "";
      renderSources(row);
      totals();
    });
    row.remove.addEventListener("click", () => {
      if (saving || rows.length === 1) return;
      const index = rows.indexOf(row);
      rows.splice(index, 1);
      row.root.remove();
      labels();
      totals();
      busy();
      position();
      rows[Math.min(index, rows.length - 1)].source.focus();
    });
    bindStrictAmount(row.amount, totals);
    labels();
    totals();
    busy();
    position();
    return row;
  }
  function labels() {
    rows.forEach((row, index) => {
      for (const [field, label] of [
        ["source", "کد حساب"],
        ["kind", "نوع"],
        ["bank", "بانک"],
        ["description", "شرح"],
        ["amount", "مبلغ"],
        ["remove", "حذف"],
      ])
        row[field].setAttribute("aria-label", `${label} ردیف ${index + 1}`);
    });
  }
  function totals() {
    let income = 0,
      expense = 0;
    for (const row of rows) {
      try {
        const value = amountValue(row.amount.value);
        if (row.kind.value === "income") income += value;
        else expense += value;
      } catch {
        /* Incomplete cells contribute after they become valid. */
      }
    }
    $("documentIncomeTotal").textContent = money(income);
    $("documentExpenseTotal").textContent = money(expense);
  }
  function openForm(item = null) {
    if (transition.active || closing || saving) return;
    editing = item;
    rows = [];
    optionsReady = false;
    requestId = requestFingerprint = null;
    $("documentForm").reset();
    $("documentRows").replaceChildren();
    $("documentDate").value = formatJalaliInput(item?.date || todayKey());
    $("documentDescription").value = item?.description || "";
    $("documentModalTitle").textContent = item ? "ویرایش سند" : "ثبت سند";
    $("documentNumber").textContent = item?.number || "در حال دریافت...";
    $("documentFormError").hidden = true;
    document.body.classList.add("task-form-open");
    position();

    for (const record of item?.rows?.length ? item.rows : [null])
      addRow(record);
    position();
    void transition.open();
    void loadOptions();
  }
  async function closeForm() {
    if (saving || closing || !curtain.open) return;
    optionsVersion++;
    closing = true;
    await transition.close();
    closing = false;
    (
      document.querySelector(`[data-document-id="${editing?.id}"]`) ||
      $("registerDocument")
    ).focus({ preventScroll: true });
    editing = null;
    onIdle?.();
  }
  function formError(error) {
    $("documentFormError").textContent = error.message;
    $("documentFormError").hidden = false;
    position();
  }
  $("documentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || closing || !optionsReady) return;
    $("documentFormError").hidden = true;
    let body;
    try {
      const date = normalizeJalaliDate($("documentDate").value);
      if (!date) throw new Error("تاریخ سند الزامی است.");
      body = {
        date,
        description: $("documentDescription").value.trim(),
        rows: rows.map((row, index) => {
          const kind = row.kind.value;
          if (!row.source.value || !row.bank.value)
            throw new Error(`حساب و بانک ردیف ${index + 1} را انتخاب کنید.`);
          return {
            id: row.original?.id || null,
            kind,
            document_account_id: Number(row.source.value),
            bank_id: Number(row.bank.value),
            description: row.description.value.trim() || null,
            amount: amountValue(row.amount.value),
            tracking_number:
              kind === "income" ? row.original?.tracking_number || null : null,
          };
        }),
        ...(editing ? { revision: editing.revision } : {}),
      };
      const fingerprint = JSON.stringify(body);
      if (fingerprint !== requestFingerprint) {
        requestId = crypto.randomUUID();
        requestFingerprint = fingerprint;
      }
      body.request_id = requestId;
    } catch (error) {
      formError(error);
      return;
    }
    saving = true;
    busy();
    let result;
    const edited = !!editing;
    try {
      result = await financeRequest(
        edited ? `/documents/${editing.id}` : "/documents",
        { method: edited ? "PUT" : "POST", body },
      );
    } catch (error) {
      formError(error);
    } finally {
      saving = false;
      busy();
    }
    if (result) {
      closeForm();
      notify(edited ? "سند و تراکنش‌ها ویرایش شدند." : "سند ثبت شد");
      await onSaved({ reset: !edited });
    }
  });
  $("addDocumentRow").addEventListener("click", () => {
    const row = addRow();
    row?.source.focus();
  });
  $("retryDocumentOptions").addEventListener("click", loadOptions);
  $("cancelDocument").addEventListener("click", closeForm);
  $("registerDocument").addEventListener("click", () => openForm());
  curtain.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeForm();
  });
  $("documentDescription").addEventListener("pointerup", () => {
    if (curtain.open) position();
  });
  return {
    openForm,
    refreshOptions: () => {
      if (curtain.open && !saving) void loadOptions();
    },
    get busy() {
      return saving;
    },
  };
}

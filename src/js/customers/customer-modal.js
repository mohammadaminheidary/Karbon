import { onExternalDataChange } from "../components/data-events.js";
import { Dialog } from "../components/dialog.js";
import { createSpinner } from "../components/loader.js";
import {
  createCustomer,
  updateCustomer,
  getNextCustomerCode,
  getCustomer,
} from "./customer-api.js";
import {
  element,
  normalizeText,
  normalizePhone,
  fullName,
  formatNumber,
  formatJalaliInput,
  normalizeJalaliDate,
} from "./customer-utils.js";

const get = (id) => document.getElementById(id);
let formDialog,
  duplicateDialog,
  editingCustomer = null,
  submitting = false;
let onSaved,
  duplicateResolver,
  generation = 0;

function showError(field, message) {
  const output = document.querySelector(`[data-customer-error="${field}"]`);
  if (output) {
    output.textContent = message;
    output.classList.remove("hidden");
  }
  const input = {
    first_name: "customerFirstName",
    last_name: "customerLastName",
    address: "customerAddress",
    notes: "customerNotes",
    last_contact_date: "customerLastContact",
  }[field];
  if (input) get(input).setAttribute("aria-invalid", "true");
}

function clearErrors() {
  document.querySelectorAll("[data-customer-error]").forEach((output) => {
    output.textContent = "";
    output.classList.add("hidden");
  });
  get("customerForm")
    .querySelectorAll("[aria-invalid]")
    .forEach((input) => input.removeAttribute("aria-invalid"));
  get("customerFormError").classList.add("hidden");
}

function updatePhoneRows() {
  const rows = [...get("customerPhonesContainer").children];
  get("customerPhonesEmpty").classList.toggle("hidden", rows.length > 0);
  rows.forEach((row, index) => {
    const label =
      index === 0 ? "شماره اصلی" : `شماره تماس ${formatNumber(index + 1)}`;
    row.querySelector("input").setAttribute("aria-label", label);
    row.querySelector("input").placeholder = label;
    row.querySelector("button").setAttribute("aria-label", `حذف ${label}`);
  });
  get("addCustomerPhoneButton").disabled = submitting || rows.length >= 20;
}

function addPhone(value = "", focus = false) {
  if (get("customerPhonesContainer").children.length >= 20) return;
  const row = element("div", "flex items-start gap-2");
  const input = element(
    "input",
    "h-11 min-w-0 flex-1 rounded-xl border border-french-gray/40 bg-white px-3 text-sm outline-none transition focus:border-persian-blue focus:ring-4 focus:ring-persian-blue/10",
  );
  input.type = "tel";
  input.dir = "ltr";
  input.inputMode = "tel";
  input.maxLength = 30;
  input.autocomplete = "tel";
  input.value = value;
  input.dataset.phoneInput = "true";
  input.setAttribute("aria-describedby", "customerPhonesError");
  const remove = element(
    "button",
    "h-11 shrink-0 rounded-xl bg-alizarin-crimson/10 px-4 text-xs font-bold text-alizarin-crimson hover:bg-alizarin-crimson hover:text-white",
    "حذف",
  );
  remove.type = "button";
  remove.addEventListener("click", () => {
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    updatePhoneRows();
    (next?.querySelector("input") || get("addCustomerPhoneButton")).focus();
  });
  row.append(input, remove);
  get("customerPhonesContainer").append(row);
  updatePhoneRows();
  if (focus) input.focus();
}

function collectData() {
  clearErrors();
  const data = {
    first_name: normalizeText(get("customerFirstName").value),
    last_name: normalizeText(get("customerLastName").value),
    gender:
      document.querySelector('input[name="customerGender"]:checked')?.value ||
      null,
    address: get("customerAddress").value.trim() || null,
    notes: get("customerNotes").value.trim() || null,
    last_contact_date: get("customerLastContact").value || null,
    phone_numbers: [
      ...new Set(
        [...document.querySelectorAll("[data-phone-input]")]
          .map((input) => normalizePhone(input.value))
          .filter(Boolean),
      ),
    ],
  };
  let valid = true;
  try {
    data.last_contact_date = normalizeJalaliDate(
      get("customerLastContact").value,
    );
  } catch (error) {
    showError("last_contact_date", error.message);
    valid = false;
  }
  for (const [key, label] of [
    ["first_name", "نام"],
    ["last_name", "نام خانوادگی"],
  ]) {
    if (!data[key] || data[key].length > 100) {
      showError(key, `${label} الزامی است و باید حداکثر ۱۰۰ کاراکتر باشد.`);
      valid = false;
    }
  }
  const invalid = data.phone_numbers.some(
    (phone) => !/^\+?[0-9]{7,15}$/.test(phone),
  );
  if (invalid) {
    showError("phone_numbers", "شماره تلفن باید بین ۷ تا ۱۵ رقم باشد.");
    valid = false;
  }
  if (!valid) {
    const first = get("customerForm").querySelector('[aria-invalid="true"]');
    (first || get("customerPhonesContainer").querySelector("input"))?.focus();
  }
  return valid ? data : null;
}

function setBusy(busy) {
  submitting = busy;
  get("customerForm").setAttribute("aria-busy", String(busy));
  get("customerForm")
    .querySelectorAll("input, textarea, button")
    .forEach((input) => {
      input.disabled = busy;
    });
  get("closeCustomerFormButton").disabled = busy;
  const button = get("saveCustomerButton");
  button.replaceChildren();
  if (busy) button.append(createSpinner());
  button.append(
    document.createTextNode(
      busy
        ? " در حال ذخیره..."
        : editingCustomer
          ? "ذخیره تغییرات"
          : "ذخیره مشتری",
    ),
  );
  updatePhoneRows();
}

function confirmDuplicate(matches) {
  get("customerDuplicateMatches").replaceChildren();
  for (const match of matches) {
    const card = element("div", "rounded-xl bg-alabaster p-4 text-sm");
    card.append(
      element(
        "p",
        "font-bold break-words",
        `${fullName(match)} — کد ${formatNumber(match.customer_code)}`,
      ),
    );
    if (match.name_match)
      card.append(
        element("p", "mt-2 text-mirage/60", "نام و نام خانوادگی مشابه است."),
      );
    if (match.matching_phones.length)
      card.append(
        element(
          "p",
          "mt-2 break-words text-mirage/60",
          `شماره مشترک: ${match.matching_phones.join("، ")}`,
        ),
      );
    get("customerDuplicateMatches").append(card);
  }
  get("confirmDuplicateCustomerButton").textContent = editingCustomer
    ? "ذخیره تغییرات با این مشخصات"
    : "ثبت مشتری جدید";
  duplicateDialog.open(get("cancelDuplicateCustomerButton"));
  return new Promise((resolve) => {
    duplicateResolver = resolve;
  });
}

async function submit(event) {
  event.preventDefault();
  if (submitting) return;
  const data = collectData();
  if (!data) return;
  setBusy(true);
  const editing = editingCustomer;
  let result;
  try {
    const save = () =>
      editing ? updateCustomer(editing.id, data) : createCustomer(data);
    try {
      result = await save();
    } catch (error) {
      if (error.status !== 409 || error.detail?.code !== "DUPLICATE_CUSTOMER")
        throw error;
      if (!(await confirmDuplicate(error.detail.matches))) return;
      data.confirm_duplicate = true;
      result = await save();
    }
    formDialog.close();
  } catch (error) {
    if (error.status === 422 && Array.isArray(error.detail)) {
      for (const issue of error.detail)
        showError(
          issue.loc?.[1],
          issue.loc?.[1] === "last_contact_date"
            ? "تاریخ شمسی واردشده معتبر نیست؛ روز، ماه و سال را بررسی کنید."
            : "مقدار واردشده معتبر نیست؛ قالب و طول فیلد را بررسی کنید.",
        );
    }
    get("customerFormError").textContent = error.message;
    get("customerFormError").classList.remove("hidden");
  } finally {
    setBusy(false);
  }
  if (result) await onSaved(result, Boolean(editing));
}

export async function openCreateCustomerModal() {
  if (submitting) return;
  const current = ++generation;
  editingCustomer = null;
  get("customerForm").reset();
  clearErrors();
  get("customerFormTitle").textContent = "مشتری جدید";
  get("customerCode").value = "در حال دریافت...";
  get("customerPhonesContainer").replaceChildren();
  addPhone();
  setBusy(false);
  formDialog.open(get("customerFirstName"));
  try {
    const data = await getNextCustomerCode();
    if (generation === current && !editingCustomer)
      get("customerCode").value = data.customer_code;
  } catch (error) {
    if (generation !== current) return;
    get("customerCode").value = "دریافت نشد";
    get("customerFormError").textContent = error.message;
    get("customerFormError").classList.remove("hidden");
  }
}

export function openEditCustomerModal(customer) {
  if (submitting) return;
  generation++;
  editingCustomer = customer;
  get("customerForm").reset();
  clearErrors();
  get("customerFormTitle").textContent = "ویرایش مشتری";
  get("customerCode").value = customer.customer_code;
  for (const [id, key] of [
    ["customerFirstName", "first_name"],
    ["customerLastName", "last_name"],
    ["customerAddress", "address"],
    ["customerNotes", "notes"],
  ])
    get(id).value = customer[key] || "";
  get("customerLastContact").value = formatJalaliInput(
    customer.last_contact_date,
  );
  if (customer.gender)
    document.querySelector(
      `input[name="customerGender"][value="${customer.gender}"]`,
    ).checked = true;
  get("customerPhonesContainer").replaceChildren();
  customer.phone_numbers.forEach((phone) => addPhone(phone));
  setBusy(false);
  formDialog.open(get("customerFirstName"));
}

export function initializeCustomerModal({ onSaved: callback }) {
  onSaved = callback;
  onExternalDataChange(async () => {
    if (submitting || get("customerFormModal").getAttribute("aria-hidden") !== "false") return;
    const current = generation;
    try {
      const data = editingCustomer ? await getCustomer(editingCustomer.id) : await getNextCustomerCode();
      if (current === generation) {
        get("customerCode").value = data.customer_code;
        if (editingCustomer) editingCustomer.customer_code = data.customer_code;
      }
    } catch { /* Submission always gets its code from the server. */ }
  });
  formDialog = new Dialog("customerFormModal", {
    canClose: () => !submitting,
    onCancel: () => {
      generation++;
    },
  });
  duplicateDialog = new Dialog("customerDuplicateModal", {
    onCancel: () => {
      duplicateResolver?.(false);
      duplicateResolver = null;
    },
  });
  get("customerForm").addEventListener("submit", submit);
  get("customerLastContact").addEventListener("blur", () => {
    const input = get("customerLastContact");
    try {
      const date = normalizeJalaliDate(input.value);
      if (date)
        input.value = date.replace(
          /[0-9]/g,
          (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)],
        );
    } catch {
      // Preserve incomplete input; submit validation explains the field error.
    }
  });
  get("addCustomerPhoneButton").addEventListener("click", () =>
    addPhone("", true),
  );
  get("confirmDuplicateCustomerButton").addEventListener("click", () => {
    duplicateDialog.close();
    duplicateResolver?.(true);
    duplicateResolver = null;
  });
}

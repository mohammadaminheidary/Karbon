import { Dialog } from "../components/dialog.js";
import { getCustomers } from "../customers/customer-api.js";
import {
  financeRequest,
  getBanks,
  getExpenseCategories,
} from "./finance-api.js";
import {
  node,
  money,
  normalizeDigits,
  normalizeJalaliDate,
  amountValue,
  bindAmount,
} from "./finance-utils.js";
import { confirmFinanceDelete } from "./delete-dialog.js";

let root,
  dialog,
  item,
  onChanged,
  saving = false,
  version = 0,
  sources = [],
  customers = [],
  categories = [];
const $ = (id) => root.querySelector(`#edit${id}`);

export function transactionActions(record, changed) {
  const cell = node("td", "p-4");
  const menu = node("details", "transaction-menu");
  const summary = node(
    "summary",
    "finance-button border border-french-gray/40",
    "تنظیمات",
  );
  summary.setAttribute(
    "aria-label",
    `تنظیمات تراکنش ${record.transaction_number || record.id}`,
  );
  const buttons = node("div", "transaction-menu-options");
  for (const [label, callback] of [
    ["ویرایش", () => editTransaction(record, changed)],
    [
      "حذف",
      () =>
        confirmFinanceDelete({
          path: `/finance/transactions/${record.id}`,
          description: `تراکنش ${record.transaction_number || record.id}، ${record.title} به مبلغ ${money(record.amount)} حذف شود؟`,
          onDeleted: changed,
        }),
    ],
  ]) {
    const button = node("button", "finance-button", label);
    button.type = "button";
    button.addEventListener("click", () => {
      menu.open = false;
      callback();
    });
    buttons.append(button);
  }
  menu.append(summary, buttons);
  cell.append(menu);
  return cell;
}

function createEditor() {
  root = node(
    "div",
    "finance-surface fixed inset-0 z-[90] hidden items-center justify-center overflow-y-auto bg-mirage/50 p-4",
  );
  root.id = "financeEditModal";
  root.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="editTitle" class="my-auto w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl transition duration-200 scale-95 opacity-0">
    <h2 id="editTitle" class="text-lg font-black">ویرایش تراکنش</h2>
    <form id="editForm" class="mt-5" novalidate>
      <fieldset id="editFields" class="grid gap-4 sm:grid-cols-2">
        <label>نوع تراکنش<select id="editKind" class="finance-field"><option value="income">درآمد</option><option value="expense">هزینه</option></select></label>
        <label>مشتری / عنوان هزینه<select id="editSource" class="finance-field"></select></label>
        <label>کد حساب<input id="editCode" readonly class="finance-field" dir="ltr" /></label>
        <label>حساب بانکی<select id="editBank" class="finance-field"></select></label>
        <label>مبلغ (تومان)<input id="editAmount" class="finance-field" dir="ltr" inputmode="numeric" maxlength="21" /></label>
        <label>تاریخ شمسی<input id="editDate" class="finance-field" dir="ltr" placeholder="۱۴۰۵/۰۷/۱۴" maxlength="10" /></label>
        <label>ساعت ثبت<select id="editTimeMode" class="finance-field"><option value="auto">حفظ ساعت ثبت قبلی</option><option value="manual">انتخاب ساعت</option></select></label>
        <div id="editManual" class="grid grid-cols-2 gap-3"><label>ساعت<input id="editHour" class="finance-field" inputmode="numeric" dir="ltr" maxlength="2" /></label><label>دقیقه<input id="editMinute" class="finance-field" inputmode="numeric" dir="ltr" maxlength="2" /></label></div>
        <label id="editTrackingLabel">شماره پیگیری<input id="editTracking" class="finance-field" maxlength="100" /></label>
        <label class="sm:col-span-2">شرح<textarea id="editDescription" class="finance-field" maxlength="5000" rows="3"></textarea></label>
      </fieldset>
      <p id="editError" role="alert" class="mt-3 text-sm text-alizarin-crimson"></p>
      <div class="mt-5 flex gap-3"><button id="editSave" type="submit" class="finance-button bg-persian-blue text-white">ذخیره تغییرات</button><button data-dialog-close type="button" class="finance-button border border-french-gray/40">انصراف</button></div>
    </form></section>`;
  document.body.append(root);
  dialog = new Dialog(root.id, {
    canClose: () => !saving,
    onCancel: () => {
      version++;
      item = null;
    },
  });
  bindAmount($("Amount"));
  $("Kind").addEventListener("change", renderSources);
  $("Source").addEventListener("change", renderCode);
  $("TimeMode").addEventListener("change", syncTime);
  $("Form").addEventListener("submit", save);
}
function options(select, rows, label) {
  select.replaceChildren(
    ...rows.map((row) => {
      const el = node("option", "", label(row));
      el.value = row.id;
      return el;
    }),
  );
}
function renderSources() {
  const kind = $("Kind").value;
  const original = item.kind === kind;
  const id = kind === "income" ? item.customer_id : item.expense_category_id;
  sources = [
    ...(kind === "income"
      ? customers
      : categories.filter((row) => row.active || (original && row.id === id))),
  ];
  if (original && !sources.some((row) => row.id === id))
    sources.push({
      id,
      title: item.title,
      account_code: item.account_code,
      archived: true,
    });
  options(
    $("Source"),
    sources,
    (row) =>
      (row.title || `${row.first_name} ${row.last_name}`) +
      (row.archived ? " (حذف‌شده)" : ""),
  );
  if (original) $("Source").value = id;
  $("TrackingLabel").classList.toggle("hidden", kind !== "income");
  renderCode();
}
function renderCode() {
  const row = sources.find((row) => row.id === Number($("Source").value));
  $("Code").value = row?.customer_code || row?.account_code || "";
}
function syncTime() {
  $("Manual").classList.toggle("hidden", $("TimeMode").value !== "manual");
}
async function allCustomers() {
  const rows = [];
  let skip = 0;
  while (true) {
    const page = await getCustomers({ skip, limit: 100 });
    rows.push(...page.items);
    skip += page.items.length;
    if (skip >= page.total || !page.items.length) return rows;
  }
}
async function editTransaction(record, changed) {
  if (saving) return;
  if (!root) createEditor();
  item = record;
  onChanged = changed;
  const current = ++version;
  $("Form").reset();
  $("Kind").value = record.kind;
  $("Amount").value = new Intl.NumberFormat("fa-IR").format(record.amount);
  $("Date").value = record.jalali_date;
  $("TimeMode").value = record.time_mode;
  $("Hour").value = record.transaction_time.slice(0, 2);
  $("Minute").value = record.transaction_time.slice(3, 5);
  $("Tracking").value = record.tracking_number || "";
  $("Description").value = record.description || "";
  $("Error").textContent = "در حال دریافت اطلاعات...";
  $("Source").replaceChildren();
  $("Bank").replaceChildren();
  $("Code").value = "";
  $("Fields").disabled = true;
  $("Save").disabled = true;
  syncTime();
  root.inert = false;
  dialog.open();
  try {
    const [banks, clients, titles] = await Promise.all([
      getBanks(),
      allCustomers(),
      getExpenseCategories(),
    ]);
    if (current !== version) return;
    customers = clients;
    categories = titles;
    options(
      $("Bank"),
      banks.filter((row) => row.active || row.id === record.bank_id),
      (row) =>
        `${row.name} · ${[row.first_name, row.last_name].filter(Boolean).join(" ")} · ${row.card_number || row.account_number}`,
    );
    $("Bank").value = record.bank_id;
    renderSources();
    $("Fields").disabled = false;
    $("Save").disabled = false;
    $("Error").textContent = "";
    $("Amount").focus();
  } catch (error) {
    if (current === version) $("Error").textContent = error.message;
  }
}
async function save(event) {
  event.preventDefault();
  if (saving) return;
  let result;
  saving = true;
  $("Fields").disabled = true;
  $("Save").disabled = true;
  $("Save").textContent = "در حال ذخیره...";
  root.querySelector("[data-dialog-close]").disabled = true;
  try {
    const kind = $("Kind").value,
      manual = $("TimeMode").value === "manual";
    const body = {
      kind,
      bank_id: Number($("Bank").value),
      amount: amountValue($("Amount").value),
      customer_id: kind === "income" ? Number($("Source").value) : null,
      expense_category_id:
        kind === "expense" ? Number($("Source").value) : null,
      description: $("Description").value.trim() || null,
      tracking_number:
        kind === "income"
          ? normalizeDigits($("Tracking").value.trim()) || null
          : null,
      transaction_date: normalizeJalaliDate($("Date").value),
      time_mode: manual ? "manual" : "auto",
    };
    if (manual) {
      const hour = normalizeDigits($("Hour").value.trim()),
        minute = normalizeDigits($("Minute").value.trim());
      if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute))
        throw new Error("ساعت و دقیقه معتبر وارد کنید.");
      body.hour = Number(hour);
      body.minute = Number(minute);
    }
    result = await financeRequest(`/finance/transactions/${item.id}`, {
      method: "PUT",
      body,
    });
  } catch (error) {
    $("Error").textContent = error.message;
  } finally {
    saving = false;
    $("Fields").disabled = false;
    $("Save").disabled = false;
    $("Save").textContent = "ذخیره تغییرات";
    root.querySelector("[data-dialog-close]").disabled = false;
  }
  if (result) {
    const changed = onChanged;
    version++;
    item = null;
    dialog.close();
    await changed?.();
  }
}

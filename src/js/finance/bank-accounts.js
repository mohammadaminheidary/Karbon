import { confirmFinanceDelete } from "./delete-dialog.js";
import { onExternalDataChange } from "../components/data-events.js";
import { Dialog } from "../components/dialog.js";
import { getBanks, getBankCatalog, financeRequest } from "./finance-api.js";
import {
  money,
  node,
  bindAmount,
  amountValue,
  normalizeDigits,
} from "./finance-utils.js";

const modalTemplate = `
  <button type="button" data-dialog-close class="absolute inset-0" aria-label="بستن فرم حساب"></button>
  <section role="dialog" aria-modal="true" aria-labelledby="bankModalTitle" class="relative max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl transition-all duration-200 scale-95 opacity-0 sm:p-7">
    <div class="flex items-center justify-between gap-3"><div><p class="mb-1 text-xs text-mirage/45">مدیریت حساب‌های بانکی</p><h2 id="bankModalTitle" class="text-xl font-black">افزودن حساب</h2></div><button type="button" data-dialog-close class="finance-button" aria-label="بستن">×</button></div>
    <p id="bankCatalogStatus" class="mt-4 text-sm text-mirage/50" role="status"></p>
    <p id="bankFormError" class="mt-4 hidden rounded-xl bg-alizarin-crimson/10 p-3 text-sm text-alizarin-crimson" role="alert"></p>
    <button id="retryBankCatalog" type="button" class="finance-button mt-2 hidden border border-french-gray/40">دریافت مجدد بانک‌ها</button>
    <form id="bankForm" class="mt-5" novalidate>
      <fieldset id="bankFields" class="grid gap-4 sm:grid-cols-2">
        <label for="bankFirstName">نام <input id="bankFirstName" class="finance-field" required maxlength="100" autocomplete="given-name" aria-describedby="bankFormError" /></label>
        <label for="bankLastName">نام خانوادگی <input id="bankLastName" class="finance-field" required maxlength="100" autocomplete="family-name" aria-describedby="bankFormError" /></label>
        <label for="bankSelect" class="sm:col-span-2">بانک <select id="bankSelect" class="finance-field" required aria-describedby="bankFormError"><option value="">انتخاب بانک</option></select></label>
        <div id="bankLogoPreview" class="hidden items-center gap-3 rounded-xl bg-alabaster p-3 sm:col-span-2"></div>
        <label for="bankCardNumber" class="sm:col-span-2">شماره کارت <input id="bankCardNumber" class="finance-field bank-number" required inputmode="numeric" maxlength="19" dir="ltr" placeholder="0000 0000 0000 0000" autocomplete="off" aria-describedby="bankFormError" /></label>
        <label for="bankShebaNumber" class="sm:col-span-2">شماره شبا (اختیاری) <input id="bankShebaNumber" class="finance-field bank-number" inputmode="text" maxlength="40" dir="ltr" placeholder="IR + 24 رقم" autocomplete="off" spellcheck="false" aria-describedby="bankFormError" /><span class="mt-2 block text-xs font-normal text-mirage/45">در صورت ورود: IR به همراه ۲۴ رقم؛ ارقام فارسی و انگلیسی پذیرفته می‌شوند.</span></label>
        <details class="rounded-xl border border-french-gray/30 p-3 sm:col-span-2"><summary class="cursor-pointer text-sm font-bold text-mirage/60">تنظیمات مالی حساب</summary><div class="mt-4 grid gap-4 sm:grid-cols-2">
          <label for="bankAccount">شماره حساب (اختیاری) <input id="bankAccount" class="finance-field" maxlength="50" dir="ltr" autocomplete="off" /></label>
          <label for="bankOpening">مانده اولیه (تومان) <input id="bankOpening" class="finance-field" inputmode="text" value="0" dir="ltr" maxlength="21" /></label>
          <label for="bankActive">وضعیت حساب <select id="bankActive" class="finance-field"><option value="true">فعال</option><option value="false">غیرفعال</option></select></label>
        </div></details>
      </fieldset>
      <div class="mt-6 flex justify-end gap-3"><button type="button" data-dialog-close class="finance-button border border-french-gray/40">انصراف</button><button id="saveBank" type="submit" class="finance-button bg-persian-blue text-white">افزودن حساب</button></div>
    </form>
  </section>`;

export function bankLogo(bank, className = "bank-logo") {
  const holder = node("span", className);
  if (bank.logo_url?.startsWith("/assets/image/banks/")) {
    const image = document.createElement("img");
    image.src = bank.logo_url;
    image.alt = `لوگوی ${bank.name}`;
    image.width = image.height = 44;
    image.addEventListener(
      "error",
      () => {
        image.remove();
        holder.textContent = "🏦";
      },
      { once: true },
    );
    holder.append(image);
  } else {
    holder.textContent = "🏦";
    holder.setAttribute("aria-label", bank.name);
  }
  return holder;
}

export const formatCardNumber = (value) =>
  (value || "").replace(/(.{4})(?=.)/g, "$1 ");

export function validateCardNumber(raw) {
  const value = normalizeDigits(raw).replace(/\s/g, "");
  if (!/^\d{16}$/.test(value) || new Set(value).size === 1)
    throw new Error("شماره کارت باید ۱۶ رقم معتبر باشد.");
  const checksum = [...value].reduce((sum, char, index) => {
    let digit = Number(char) * (index % 2 === 0 ? 2 : 1);
    return sum + (digit > 9 ? digit - 9 : digit);
  }, 0);
  if (checksum % 10)
    throw new Error("شماره کارت معتبر نیست؛ ارقام آن را بررسی کنید.");
  return value;
}

export function validateSheba(raw) {
  const value = normalizeDigits(raw).replace(/\s/g, "").toUpperCase();
  if (!value) return null;
  if (!/^IR\d{24}$/.test(value))
    throw new Error("شماره شبا باید شامل IR و ۲۴ رقم باشد.");
  let remainder = 0;
  for (const digit of `${value.slice(4)}1827${value.slice(2, 4)}`)
    remainder = (remainder * 10 + Number(digit)) % 97;
  if (remainder !== 1)
    throw new Error("شماره شبا معتبر نیست؛ ارقام آن را بررسی کنید.");
  return value;
}

function ownerName(raw, label) {
  const value = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک");
  if (!value) throw new Error(`${label} صاحب حساب را وارد کنید.`);
  if (!/[\p{L}]/u.test(value) || !/^[\p{L}\p{M} '\-\u200c]+$/u.test(value))
    throw new Error(
      "نام و نام خانوادگی باید فقط شامل حروف باشند و عدد نداشته باشند.",
    );
  return value;
}

function renderAccount(bank, onEdit, mode, onDelete) {
  if (mode === "rows") {
    const row = node("div", "bank-settings-row");
    row.dataset.bankId = bank.id;
    const identity = node("div", "flex items-center gap-3");
    identity.append(bankLogo(bank), node("p", "font-bold", bank.name));
    const owner = node("div", "min-w-0");
    owner.append(
      node(
        "p",
        "font-bold",
        [bank.first_name, bank.last_name].filter(Boolean).join(" ") ||
          "صاحب حساب ثبت نشده",
      ),
      node(
        "p",
        "mt-1 text-xs text-mirage/45",
        bank.active ? "فعال" : "غیرفعال",
      ),
    );
    const numbers = node("div", "bank-row-numbers min-w-0 text-sm");
    const card = node(
      "p",
      "bank-number",
      bank.card_number
        ? formatCardNumber(bank.card_number)
        : "شماره کارت ثبت نشده",
    );
    card.dir = bank.card_number ? "ltr" : "rtl";
    const sheba = node(
      "p",
      "mt-2 break-all text-xs text-mirage/45",
      bank.sheba_number || "شبا ثبت نشده",
    );
    sheba.dir = bank.sheba_number ? "ltr" : "rtl";
    numbers.append(card, sheba);
    const edit = node(
      "button",
      "finance-button border border-french-gray/40 text-mirage/70",
      "ویرایش",
    );
    edit.type = "button";
    edit.addEventListener("click", () => onEdit(bank));
    const actions = node("div", "flex gap-2");
    const remove = node(
      "button",
      "finance-button text-alizarin-crimson",
      "حذف",
    );
    remove.type = "button";
    remove.disabled = !bank.can_delete;
    remove.classList.toggle("finance-delete-blocked", !bank.can_delete);
    remove.title = bank.can_delete
      ? "حذف حساب بدون تراکنش"
      : "حساب دارای تراکنش قابل حذف نیست";
    remove.addEventListener("click", () => onDelete(bank));
    actions.append(edit, remove);
    row.append(identity, owner, numbers, actions);
    return row;
  }
  const article = node(
    "a",
    "bank-account rounded-2xl border border-french-gray/30 bg-white shadow-sm",
  );
  article.dataset.bankId = bank.id;
  article.href = `/page/bank-transactions-page.html?bank=${bank.id}`;
  article.setAttribute(
    "aria-label",
    `تراکنش‌های ${bank.name}، ${[bank.first_name, bank.last_name].filter(Boolean).join(" ")}`,
  );
  const face = node("div", "bank-card-face");
  const top = node("div", "relative flex items-center justify-between gap-3");
  const identity = node("div", "min-w-0");
  identity.append(
    node("h3", "text-base font-black", bank.name),
    node(
      "p",
      "mt-1 text-xs text-white/65",
      bank.active ? "حساب فعال" : "حساب غیرفعال",
    ),
  );
  top.append(identity, bankLogo(bank));
  const chip = node("span", "bank-chip");
  chip.setAttribute("aria-hidden", "true");
  face.append(top, chip);
  const number = node(
    "p",
    "bank-card-number",
    bank.card_number
      ? formatCardNumber(bank.card_number)
      : "شماره کارت ثبت نشده",
  );
  number.dir = bank.card_number ? "ltr" : "rtl";
  number.setAttribute(
    "aria-label",
    bank.card_number
      ? `شماره کارت ${formatCardNumber(bank.card_number)}`
      : "شماره کارت ثبت نشده",
  );
  const sheba = node(
    "p",
    "bank-sheba",
    bank.sheba_number || "شماره شبا ثبت نشده",
  );
  sheba.dir = bank.sheba_number ? "ltr" : "rtl";
  sheba.setAttribute(
    "aria-label",
    bank.sheba_number ? `شماره شبا ${bank.sheba_number}` : "شماره شبا ثبت نشده",
  );
  const owner = [bank.first_name, bank.last_name].filter(Boolean).join(" ");
  face.append(
    number,
    sheba,
    node("p", "relative mt-5 text-sm font-bold", owner || "صاحب حساب ثبت نشده"),
  );
  article.append(face);
  return article;
}

let currentController;
export async function initializeBankAccounts() {
  if (currentController) {
    await currentController.load();
    return;
  }
  const $ = (id) => document.getElementById(id);
  const mode = $("bankCards").dataset.display || "cards";
  const root = node(
    "div",
    "finance-surface fixed inset-0 z-[90] hidden items-center justify-center overflow-y-auto bg-mirage/50 p-4",
  );
  root.id = "bankModal";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = modalTemplate;
  document.body.append(root);
  let saving = false,
    catalogReady = false,
    editing = null,
    banks = [],
    catalogVersion = 0,
    listVersion = 0;
  const dialog = new Dialog("bankModal", {
    canClose: () => !saving,
    onCancel: () => {
      catalogVersion++;
    },
  });

  function busy() {
    $("bankFields").disabled = saving || !catalogReady;
    $("saveBank").disabled = saving || !catalogReady;
    $("saveBank").textContent = saving
      ? "در حال ذخیره..."
      : editing
        ? "ذخیره تغییرات"
        : "افزودن حساب";
    $("bankForm").setAttribute("aria-busy", String(saving));
    root
      .querySelectorAll("[data-dialog-close]")
      .forEach((button) => (button.disabled = saving));
  }

  async function load() {
    const version = ++listVersion;
    $("banksStatus").textContent = "در حال دریافت حساب‌ها...";
    $("banksStatus").classList.remove("hidden");
    $("banksError").classList.add("hidden");
    $("bankCards").setAttribute("aria-busy", "true");
    $("refreshBanks").disabled = true;
    try {
      const accounts = await getBanks();
      if (version !== listVersion) return;
      $("banksStatus").textContent = $("addBankAccount")
        ? "هنوز حسابی ثبت نشده است. برای شروع «افزودن حساب» را انتخاب کنید."
        : "هنوز حسابی ثبت نشده است. حساب جدید را در «تنظیمات ← بانک» اضافه کنید.";
      $("banksStatus").classList.toggle("hidden", accounts.length > 0);
      $("bankCards").replaceChildren(
        ...accounts.map((account) =>
          renderAccount(account, open, mode, (bank) =>
            confirmFinanceDelete({
              path: `/banks/${bank.id}`,
              description: `حساب ${bank.name} با شماره کارت ${bank.card_number || bank.account_number} حذف شود؟`,
              onDeleted: load,
            }),
          ),
        ),
      );
      if ($("bankBalances")) {
        $("bankBalances").replaceChildren(
          ...accounts.map((account) => {
            const summary = node(
              "a",
              "bank-balance-summary rounded-2xl border border-french-gray/30 bg-white p-4",
            );
            summary.href = `/page/bank-transactions-page.html?bank=${account.id}`;
            const identity = node("div", "flex items-center gap-3");
            const label = node("div", "min-w-0");
            label.append(
              node("p", "font-bold", account.name),
              node(
                "p",
                "mt-1 text-xs text-mirage/45",
                account.card_number
                  ? `کارت …${account.card_number.slice(-4)}`
                  : account.account_number,
              ),
            );
            identity.append(bankLogo(account), label);
            summary.append(
              identity,
              node("p", "mt-4 text-xs text-mirage/45", "موجودی حساب"),
              node(
                "p",
                "mt-1 break-words text-lg font-black text-persian-blue",
                money(account.balance),
              ),
            );
            return summary;
          }),
        );
      }
      $("bankAccountCount").textContent = new Intl.NumberFormat("fa-IR").format(
        accounts.length,
      );
    } catch (error) {
      if (version !== listVersion) return;
      $("bankCards").replaceChildren();
      $("bankBalances")?.replaceChildren();
      $("bankAccountCount").textContent = "—";
      $("banksStatus").classList.add("hidden");
      $("banksError").textContent = error.message;
      $("banksError").classList.remove("hidden");
    } finally {
      if (version === listVersion) {
        $("bankCards").setAttribute("aria-busy", "false");
        $("refreshBanks").disabled = false;
      }
    }
  }

  function preview() {
    const bank = banks.find((item) => item.code === $("bankSelect").value);
    $("bankLogoPreview").replaceChildren();
    $("bankLogoPreview").classList.toggle("hidden", !bank);
    $("bankLogoPreview").classList.toggle("flex", Boolean(bank));
    if (bank)
      $("bankLogoPreview").append(
        bankLogo(bank),
        node("span", "text-sm font-bold", bank.name),
      );
  }

  async function loadCatalog() {
    const version = ++catalogVersion;
    const selected = $("bankSelect").value || editing?.bank;
    catalogReady = false;
    busy();
    $("bankFormError").classList.add("hidden");
    $("retryBankCatalog").classList.add("hidden");
    $("bankCatalogStatus").textContent = "در حال دریافت فهرست بانک‌ها...";
    try {
      const catalog = await getBankCatalog();
      if (version !== catalogVersion) return;
      banks = catalog;
      const available = banks.filter(
        (bank) => bank.active || bank.code === editing?.bank,
      );
      $("bankSelect").replaceChildren(
        new Option("انتخاب بانک", ""),
        ...available.map(
          (bank) =>
            new Option(
              bank.name + (bank.active ? "" : " (غیرفعال)"),
              bank.code,
            ),
        ),
      );
      $("bankSelect").value = selected || "";
      catalogReady = available.length > 0;
      $("bankCatalogStatus").textContent = catalogReady
        ? ""
        : "بانک فعالی برای انتخاب وجود ندارد.";
      $("retryBankCatalog").classList.toggle("hidden", catalogReady);
      preview();
    } catch (error) {
      if (version !== catalogVersion) return;
      $("bankCatalogStatus").textContent = "";
      $("bankFormError").textContent = error.message;
      $("bankFormError").classList.remove("hidden");
      $("retryBankCatalog").classList.remove("hidden");
    } finally {
      if (version === catalogVersion) busy();
    }
  }

  async function open(account = null) {
    if (saving) return;
    editing = account;
    $("bankForm").reset();
    $("bankForm")
      .querySelectorAll("[aria-invalid]")
      .forEach((input) => input.removeAttribute("aria-invalid"));
    $("bankForm").querySelector("details").open = false;
    $("bankModalTitle").textContent = editing ? "ویرایش حساب" : "افزودن حساب";
    $("bankFirstName").value = editing?.first_name || "";
    $("bankLastName").value = editing?.last_name || "";
    $("bankCardNumber").value = formatCardNumber(editing?.card_number);
    $("bankShebaNumber").value = editing?.sheba_number || "";
    $("bankAccount").value = editing?.account_number || "";
    $("bankOpening").value = new Intl.NumberFormat("en-US").format(
      editing?.opening_balance || 0,
    );
    $("bankActive").value = String(editing?.active ?? true);
    $("bankLogoPreview").classList.add("hidden");
    $("bankSelect").replaceChildren(new Option("انتخاب بانک", ""));
    root.inert = false;
    dialog.open();
    await loadCatalog();
    if (root.getAttribute("aria-hidden") === "false" && catalogReady)
      $("bankFirstName").focus();
  }

  function field(id, validator) {
    try {
      return validator($(id).value);
    } catch (error) {
      $(id).setAttribute("aria-invalid", "true");
      if ($(id).closest("details")) $(id).closest("details").open = true;
      $(id).focus();
      throw error;
    }
  }

  $("bankForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || !catalogReady) return;
    $("bankFormError").classList.add("hidden");
    $("bankForm")
      .querySelectorAll("[aria-invalid]")
      .forEach((input) => input.removeAttribute("aria-invalid"));
    let saved;
    try {
      const payload = {
        first_name: field("bankFirstName", (value) => ownerName(value, "نام")),
        last_name: field("bankLastName", (value) =>
          ownerName(value, "نام خانوادگی"),
        ),
        bank: field("bankSelect", (value) => {
          if (!value) throw new Error("بانک را انتخاب کنید.");
          return value;
        }),
        card_number: field("bankCardNumber", validateCardNumber),
        sheba_number: field("bankShebaNumber", validateSheba),
        account_number: normalizeDigits($("bankAccount").value.trim()) || null,
        opening_balance: field("bankOpening", (value) =>
          amountValue(value || "0", { signed: true, allowZero: true }),
        ),
        active: $("bankActive").value === "true",
      };
      saving = true;
      busy();
      saved = await financeRequest(`/banks${editing ? `/${editing.id}` : ""}`, {
        method: editing ? "PUT" : "POST",
        body: payload,
      });
    } catch (error) {
      $("bankFormError").textContent = error.message;
      $("bankFormError").classList.remove("hidden");
    } finally {
      saving = false;
      busy();
    }
    if (!saved) return;
    dialog.close();
    $("bankNotice").textContent = editing
      ? "تغییرات حساب ذخیره شد."
      : "حساب بانکی با موفقیت اضافه شد.";
    $("bankNotice").classList.remove("hidden");
    await load();
  });
  // Group four digits while preserving the caret when editing in the middle.
  $("bankCardNumber").addEventListener("input", (event) => {
    const input = event.target;
    const before = normalizeDigits(
      input.value.slice(0, input.selectionStart ?? input.value.length),
    ).replace(/\s/g, "").length;
    const value = normalizeDigits(input.value).replace(/\s/g, "");
    input.value = formatCardNumber(value);
    const caret = Math.min(
      input.value.length,
      before + Math.floor(Math.max(0, before - 1) / 4),
    );
    input.setSelectionRange(caret, caret);
  });
  $("bankShebaNumber").addEventListener("blur", () => {
    $("bankShebaNumber").value = normalizeDigits($("bankShebaNumber").value)
      .replace(/\s/g, "")
      .toUpperCase();
  });
  bindAmount($("bankOpening"), true);
  $("bankSelect").addEventListener("change", preview);
  $("retryBankCatalog").addEventListener("click", loadCatalog);
  $("addBankAccount")?.addEventListener("click", () => open());
  $("refreshBanks").addEventListener("click", load);
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      $("bankCards").getClientRects().length
    )
      load();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) load();
  });
  onExternalDataChange(load);
  currentController = { load };
  await load();
}

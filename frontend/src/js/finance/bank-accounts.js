import { notify } from "../components/notifications.js";
import { refreshData } from "../components/api-cache.js";
import { confirmFinanceDelete } from "./delete-dialog.js";
import { onPageRefresh } from "../components/data-events.js";
import { CurtainDialog } from "../components/curtain-dialog.js";
import { getBanks, getBankCatalog, financeRequest } from "./finance-api.js";
import {
  money,
  node,
  bindAmount,
  amountValue,
  normalizeDigits,
} from "./finance-utils.js";

const modalTemplate = `
  <section role="dialog" aria-modal="true" aria-labelledby="bankModalTitle" class="curtain-content">
    <div class="flex items-center justify-between gap-3"><div><p class="mb-1 text-xs text-mirage/45">مدیریت حساب‌های بانکی</p><h2 id="bankModalTitle" class="text-xl font-black">افزودن حساب</h2></div><button type="button" data-dialog-close class="dialog-close-button" aria-label="بستن"></button></div>
    <p id="bankCatalogStatus" class="mt-4 text-sm text-mirage/50" role="status"></p>
    <p id="bankFormError" class="mt-4 hidden rounded-xl bg-alizarin-crimson/10 p-3 text-sm text-alizarin-crimson" role="alert"></p>
    <button id="retryBankCatalog" type="button" class="finance-button mt-2 hidden border border-french-gray/40">دریافت مجدد بانک‌ها</button>
    <form id="bankForm" class="mt-5" novalidate>
      <fieldset id="bankFields" class="grid gap-4 sm:grid-cols-2">
        <label for="bankFirstName">نام <input id="bankFirstName" class="finance-field" required maxlength="100" autocomplete="given-name" aria-describedby="bankFormError" /></label>
        <label for="bankLastName">نام خانوادگی <input id="bankLastName" class="finance-field" required maxlength="100" autocomplete="family-name" aria-describedby="bankFormError" /></label>
        <label for="bankSelect" class="sm:col-span-2">بانک <select id="bankSelect" class="finance-field" required aria-describedby="bankFormError"><option value="">انتخاب بانک</option></select></label>
        <label for="bankCardNumber" class="sm:col-span-2">شماره کارت <input id="bankCardNumber" class="finance-field bank-number" required inputmode="numeric" maxlength="19" dir="ltr" placeholder="0000 0000 0000 0000" autocomplete="off" aria-describedby="bankFormError" /></label>
        <div id="bankCardPreview" class="bank-card-preview sm:col-span-2" hidden></div>
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

function cardholder(bank) {
  return [bank.first_name, bank.last_name].filter(Boolean).join(" ");
}

function renderCardFace(bank, { preview = false } = {}) {
  const face = node("div", "bank-card-face");
  face.dataset.bank = bank.is_cash ? "cash" : bank.bank || bank.code || "";

  const header = node("div", "bank-card-brand");
  const logo = bankLogo(bank, "bank-logo bank-card-logo");
  logo.setAttribute("aria-hidden", "true");
  header.append(logo, node(preview ? "p" : "h3", "bank-card-name", bank.name));
  face.append(header);

  if (!bank.is_cash) {
    const chip = node("span", "bank-chip");
    chip.setAttribute("aria-hidden", "true");
    (preview ? face : header).append(chip);
  }

  const number = node(
    "p",
    "bank-card-number",
    bank.card_number
      ? formatCardNumber(bank.card_number)
      : bank.is_cash
        ? "صندوق نقدی"
        : "شماره کارت ثبت نشده",
  );
  number.dir = bank.card_number ? "ltr" : "rtl";
  if (bank.card_number)
    number.setAttribute("aria-label", `شماره کارت ${number.textContent}`);

  const owner = node(
    "p",
    "bank-card-owner",
    cardholder(bank) ||
      (bank.is_cash ? "دریافت و پرداخت نقدی" : "صاحب حساب ثبت نشده"),
  );
  owner.dir = "auto";
  face.append(number, owner);
  return face;
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
        cardholder(bank) ||
          (bank.is_cash ? "دریافت و پرداخت نقدی" : "صاحب حساب ثبت نشده"),
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
        : bank.is_cash
          ? "صندوق نقدی"
          : "شماره کارت ثبت نشده",
    );
    card.dir = bank.card_number ? "ltr" : "rtl";
    const sheba = node(
      "p",
      "mt-2 break-all text-xs text-mirage/45",
      bank.sheba_number || (bank.is_cash ? "" : "شبا ثبت نشده"),
    );
    sheba.dir = bank.sheba_number ? "ltr" : "rtl";
    numbers.append(card, sheba);
    const edit = node(
      "button",
      "finance-button border border-french-gray/40 text-mirage/70",
      "ویرایش",
    );
    edit.type = "button";
    edit.disabled = bank.can_edit === false;
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
  const article = node("a", "bank-account card-tilt rounded-2xl");
  article.dataset.bankId = bank.id;
  article.href = `/page/bank-transactions-page.html?bank=${bank.id}`;
  article.setAttribute(
    "aria-label",
    `تراکنش‌های ${[bank.name, cardholder(bank)].filter(Boolean).join("، ")}`,
  );
  const surface = node("div", "bank-account-surface card-tilt-surface");
  const face = renderCardFace(bank);
  if (!bank.is_cash || bank.sheba_number) {
    const sheba = node(
      "p",
      "bank-card-sheba",
      bank.sheba_number || "شماره شبا ثبت نشده",
    );
    sheba.dir = bank.sheba_number ? "ltr" : "rtl";
    if (bank.sheba_number)
      sheba.setAttribute("aria-label", `شماره شبا ${bank.sheba_number}`);
    face.append(sheba);
  }
  const balance = node("div", "bank-card-balance");
  const balanceHeader = node("div", "bank-card-balance-header");
  balanceHeader.append(
    node("p", "", "موجودی حساب"),
    node("p", "", bank.active ? "حساب فعال" : "حساب غیرفعال"),
  );
  balance.append(
    balanceHeader,
    node("p", "bank-card-balance-amount", money(bank.balance)),
  );
  if (bank.opening_balance_locked)
    balance.append(node("p", "bank-card-opening", `افتتاحیه ${money(bank.opening_balance)}`));
  face.append(balance);
  surface.append(face);
  article.append(surface);
  return article;
}

let currentController;
export async function initializeBankAccounts() {
  if (currentController) {
    await currentController.load();
    return;
  }
  const $ = (id) => document.getElementById(id);
  const cards = $("bankCards");
  const mode = cards.dataset.display || "cards";
  const root = node("dialog", "bottom-curtain finance-surface");
  root.id = "bankModal";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = modalTemplate;
  document.body.append(root);
  let saving = false,
    catalogReady = false,
    editing = null,
    banks = [],
    renderedAccounts,
    catalogVersion = 0,
    listVersion = 0;
  const dialog = new CurtainDialog("bankModal", {
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
    if (renderedAccounts === undefined) {
      $("banksStatus").textContent = "در حال دریافت حساب‌ها...";
      $("banksStatus").classList.remove("hidden");
    }
    $("banksError").classList.add("hidden");
    $("bankCards").setAttribute("aria-busy", "true");
    $("bankTotalBalance")?.setAttribute("aria-busy", "true");
    $("refreshBanks").disabled = true;
    try {
      const accounts = await getBanks();
      if (version !== listVersion) return;
      $("banksStatus").textContent = $("addBankAccount")
        ? "هنوز حسابی ثبت نشده است. برای شروع «افزودن حساب» را انتخاب کنید."
        : "هنوز حسابی ثبت نشده است. حساب جدید را در «تنظیمات ← بانک» اضافه کنید.";
      $("banksStatus").classList.toggle("hidden", accounts.length > 0);
      const signature = JSON.stringify(accounts);
      if (signature !== renderedAccounts) $("bankCards").replaceChildren(
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
      renderedAccounts = signature;
      if ($("bankTotalBalance")) {
        const totalBalance = accounts.reduce(
          (total, account) => total + BigInt(account.balance),
          0n,
        );
        $("bankTotalBalance").textContent = money(totalBalance);
      }
      $("bankAccountCount").textContent = new Intl.NumberFormat("fa-IR").format(
        accounts.length,
      );
    } catch (error) {
      if (version !== listVersion) return;
      $("banksStatus").classList.add("hidden");
      $("banksError").textContent = error.message;
      $("banksError").classList.remove("hidden");
    } finally {
      if (version === listVersion) {
        $("bankCards").setAttribute("aria-busy", "false");
        $("bankTotalBalance")?.setAttribute("aria-busy", "false");
        $("refreshBanks").disabled = false;
      }
    }
  }

  function updatePreviewFields() {
    const preview = $("bankCardPreview");
    if (preview.hidden) return;
    const digits = normalizeDigits($("bankCardNumber").value).replace(/\D/g, "");
    preview.querySelector(".bank-card-number").textContent = formatCardNumber(
      digits.slice(0, 16).padEnd(16, "•"),
    );
    preview.querySelector(".bank-card-owner").textContent =
      [$("bankFirstName").value.trim(), $("bankLastName").value.trim()]
        .filter(Boolean)
        .join(" ") || "نام دارنده کارت";
  }

  function preview() {
    const bank = banks.find((item) => item.code === $("bankSelect").value);
    const container = $("bankCardPreview");
    container.replaceChildren();
    container.hidden = !bank;
    if (!bank) return;
    const face = renderCardFace(bank, { preview: true });
    // The same values are available to assistive technology in the form fields.
    face.setAttribute("aria-hidden", "true");
    face.querySelector(".bank-card-number").dir = "ltr";
    container.append(node("p", "bank-card-preview-label", "پیش‌نمایش کارت"), face);
    updatePreviewFields();
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
    $("bankOpening").readOnly = Boolean(editing?.opening_balance_locked);
    $("bankActive").value = String(editing?.active ?? true);
    $("bankSelect").replaceChildren(new Option("انتخاب بانک", ""));
    preview();
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
        active: $("bankActive").value === "true",
      };
      if (!editing?.opening_balance_locked) {
        payload.opening_balance = field("bankOpening", (value) =>
          amountValue(value || "0", { signed: true, allowZero: true }));
      }
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
    notify(
      editing ? "تغییرات حساب ذخیره شد." : "حساب بانکی با موفقیت اضافه شد.",
      { type: "success" },
    );
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
    updatePreviewFields();
  });
  $("bankFirstName").addEventListener("input", updatePreviewFields);
  $("bankLastName").addEventListener("input", updatePreviewFields);
  $("bankShebaNumber").addEventListener("blur", () => {
    $("bankShebaNumber").value = normalizeDigits($("bankShebaNumber").value)
      .replace(/\s/g, "")
      .toUpperCase();
  });
  bindAmount($("bankOpening"), true);
  $("bankSelect").addEventListener("change", preview);
  $("retryBankCatalog").addEventListener("click", loadCatalog);
  $("addBankAccount")?.addEventListener("click", () => open());
  $("refreshBanks").addEventListener("click", refreshData(load));
  currentController = { load };
  await load();
  onPageRefresh(load, { isVisible: () => $("bankCards").getClientRects().length > 0 });
}

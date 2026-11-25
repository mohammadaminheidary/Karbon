import { NavbarPanelDialog } from "../components/navbar-panel-dialog.js";
import { notify } from "../components/notifications.js";
import { onPageRefresh } from "../components/data-events.js";
import { financeRequest } from "../finance/finance-api.js";
import {
  amountValue,
  bindStrictAmount,
  normalizeDigits,
} from "../finance/finance-utils.js";
import {
  getBrands,
  getInventoryOptions,
  populateCategorySelect,
  populateUnitSelect,
} from "../warehouse/inventory-options.js";

const formatPrice = new Intl.NumberFormat("en-US");

export function initializeProductForm({ onSaved }) {
  const trigger = document.getElementById("openCreateProductButton");
  const root = document.createElement("dialog");
  root.id = "productFormModal";
  root.className = "bottom-curtain";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="navbar-panel-content flex w-full flex-col" aria-labelledby="productFormTitle">
      <header class="flex shrink-0 items-center justify-between border-b border-french-gray/30 px-5 py-4 sm:px-6">
        <h2 id="productFormTitle">کالای جدید</h2>
        <button data-dialog-close type="button" class="dialog-close-button" aria-label="بستن"></button>
      </header>
      <form id="settingsProductForm" class="flex min-h-0 flex-1 flex-col" novalidate>
        <div class="orders-dialog-body flex-1">
          <p id="productFormError" role="alert" class="mb-4 rounded-xl bg-alizarin-crimson/10 p-3 text-sm text-alizarin-crimson" hidden></p>
          <button id="retryProductOptions" type="button" class="orders-secondary mb-4" hidden>دریافت دوباره فهرست‌ها</button>
          <fieldset id="settingsProductFields" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" disabled>
            <label>کد کالا<input id="settingsProductCode" readonly value="تولید خودکار هنگام ثبت" /></label>
            <label>نام کالا<input id="settingsProductName" maxlength="150" required /></label>
            <label>دسته‌بندی<select id="settingsProductCategory" required></select>
              <a class="mt-1 block underline" href="#inventory">تنظیمات دسته‌بندی کالا و انبار</a>
            </label>
            <label>واحد<select id="settingsProductUnit" aria-describedby="settingsProductUnitHint" required></select>
              <span id="settingsProductUnitHint"><a class="mt-1 inline-block underline" href="#units">تنظیمات واحدها</a></span>
            </label>
            <label>قیمت (تومان، اختیاری)<input id="settingsProductPrice" inputmode="numeric" maxlength="21" dir="ltr" /></label>
            <label>موجودی فعلی<input id="settingsProductStock" inputmode="text" maxlength="11" dir="ltr" placeholder="خالی: بدون کنترل موجودی" /></label>
            <label>وضعیت<select id="settingsProductActive"><option value="true">فعال</option><option value="false">غیرفعال</option></select></label>
            <label class="self-end"><span class="flex min-h-11 items-center gap-2"><input id="settingsProductRequiresBrand" type="checkbox" />نیاز به برند</span></label>
            <div id="productBrandField" hidden>
              <label>برند<select id="settingsProductBrand" aria-describedby="productBrandHint" disabled></select></label>
              <a id="productBrandHint" class="mt-1 inline-block text-xs underline" href="#brands">تنظیمات برندها</a>
            </div>
          </fieldset>
          <p class="mt-3 text-xs leading-6 text-mirage/50">موجودی خالی برای کالاهای بدون کنترل موجودی است. مقدار صفر یعنی ناموجود.</p>
        </div>
        <footer class="flex shrink-0 flex-wrap justify-end gap-3 border-t border-french-gray/30 bg-white px-5 py-4 sm:px-6">
          <button id="cancelSettingsProductEdit" data-dialog-close type="button" class="orders-secondary">انصراف</button>
          <button id="saveSettingsProduct" type="submit" class="orders-primary" disabled>ثبت کالا</button>
        </footer>
      </form>
    </div>`;
  document.body.append(root);

  const $ = (id) => root.querySelector(`#${id}`);
  const form = $("settingsProductForm");
  const fields = $("settingsProductFields");
  const name = $("settingsProductName");
  const unit = $("settingsProductUnit");
  const category = $("settingsProductCategory");
  const requiresBrand = $("settingsProductRequiresBrand");
  const brand = $("settingsProductBrand");
  const price = $("settingsProductPrice");
  const stock = $("settingsProductStock");
  const submit = $("saveSettingsProduct");
  const retry = $("retryProductOptions");
  let editing, loading, saving, optionsReady;
  let brands = [];
  const dialog = new NavbarPanelDialog(root.id, { canClose: () => !saving });

  function showError(message = "") {
    const error = $("productFormError");
    error.textContent = message;
    error.hidden = !message;
  }

  function syncBrandField() {
    $("productBrandField").hidden = !requiresBrand.checked;
    brand.required = requiresBrand.checked;
    brand.disabled = !requiresBrand.checked;
    brand.removeAttribute("aria-invalid");
  }

  function updatePending() {
    form.setAttribute("aria-busy", String(Boolean(loading || saving)));
    fields.disabled = saving || !optionsReady;
    submit.disabled = saving || !optionsReady;
    root.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.disabled = Boolean(saving);
    });
  }

  async function loadOptions() {
    if (loading) return;
    loading = true;
    retry.hidden = true;
    updatePending();
    try {
      const [options, catalog] = await Promise.all([
        getInventoryOptions(),
        getBrands(),
      ]);
      const selectedCategory = optionsReady
        ? category.value
        : editing?.category_id;
      const selectedUnit = optionsReady ? unit.value : editing?.unit;
      const selectedBrand = optionsReady ? brand.value : editing?.brand_id;
      populateCategorySelect(category, options.categories, {
        current: editing?.category_id,
        selected: selectedCategory,
      });
      populateUnitSelect(unit, options.units, {
        current: editing?.unit,
        selected: selectedUnit,
      });
      brands = catalog;
      brand.replaceChildren(
        new Option(
          brands.length ? "انتخاب برند" : "ابتدا برندی در تنظیمات تعریف کنید",
          "",
        ),
        ...brands.map((item) => new Option(item.name, String(item.id))),
      );
      brand.value = brands.some((item) => item.id === Number(selectedBrand))
        ? String(selectedBrand)
        : "";
      optionsReady = true;
    } catch (error) {
      showError(error.message);
      retry.hidden = false;
    } finally {
      loading = false;
      updatePending();
      if (
        dialog.active &&
        !dialog.closing &&
        optionsReady &&
        document.activeElement === root
      )
        name.focus({ preventScroll: true });
    }
  }

  async function open(product = null) {
    if (saving || dialog.active || dialog.closing) return;
    editing = product;
    optionsReady = false;
    form.reset();
    $("productFormTitle").textContent = product ? "ویرایش کالا" : "کالای جدید";
    $("settingsProductCode").value =
      product?.product_code ?? "تولید خودکار هنگام ثبت";
    name.value = product?.name ?? "";
    price.value = product ? formatPrice.format(product.price) : "";
    stock.value = product?.stock ?? "";
    $("settingsProductActive").value = String(product?.active ?? true);
    requiresBrand.checked = Boolean(product?.requires_brand);
    submit.textContent = product ? "ذخیره تغییرات" : "ثبت کالا";
    category.replaceChildren(new Option("در حال دریافت دسته‌بندی‌ها…", ""));
    unit.replaceChildren(new Option("در حال دریافت واحدها…", ""));
    brand.replaceChildren(new Option("در حال دریافت برندها…", ""));
    syncBrandField();
    showError();
    updatePending();
    const opening = dialog.open();
    await Promise.all([opening, loadOptions()]);
    if (
      dialog.active &&
      !dialog.closing &&
      optionsReady &&
      document.activeElement === root
    )
      name.focus({ preventScroll: true });
  }

  bindStrictAmount(price);
  trigger.addEventListener("click", () => void open());
  trigger.disabled = false;
  requiresBrand.addEventListener("change", syncBrandField);
  brand.addEventListener("change", () => brand.removeAttribute("aria-invalid"));
  retry.addEventListener("click", () => {
    showError();
    void loadOptions();
  });
  root.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", () => dialog.cancel());
  });
  onPageRefresh(loadOptions, {
    isVisible: () => dialog.active && !dialog.closing && !saving,
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || !optionsReady) return;
    showError();
    try {
      if (!name.value.trim() || !unit.value || !category.value)
        throw new Error("نام، دسته‌بندی و واحد کالا الزامی است.");
      if (
        requiresBrand.checked &&
        !brands.some((item) => item.id === Number(brand.value))
      ) {
        brand.setAttribute("aria-invalid", "true");
        brand.focus();
        throw new Error("برند کالا را از تنظیمات انتخاب کنید.");
      }
      const quantity = normalizeDigits(stock.value).trim().replace(/^−/, "-");
      if (
        quantity &&
        (!/^-?\d+$/.test(quantity) || Math.abs(Number(quantity)) > 1000000000)
      )
        throw new Error("موجودی باید عدد صحیح بین منفی یک میلیارد و یک میلیارد باشد.");
      const body = {
        name: name.value.trim(),
        unit: unit.value,
        category_id: Number(category.value),
        requires_brand: requiresBrand.checked,
        brand_id: requiresBrand.checked ? Number(brand.value) : null,
        price: price.value.trim() ? amountValue(price.value, { allowZero: true }) : 0,
        stock: quantity ? Number(quantity) : null,
        active: $("settingsProductActive").value === "true",
        ...(editing ? { revision: editing.revision } : {}),
      };
      saving = true;
      updatePending();
      await financeRequest(`/products${editing ? `/${editing.id}` : ""}`, {
        method: editing ? "PUT" : "POST",
        body,
      });
      await dialog.close();
      notify("کالا و موجودی با موفقیت ذخیره شدند.", { type: "success" });
      await onSaved();
    } catch (error) {
      showError(error.message);
    } finally {
      saving = false;
      updatePending();
    }
  });

  return { open };
}

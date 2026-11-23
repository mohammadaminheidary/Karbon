import { onPageRefresh } from "../components/data-events.js";
import { financeRequest } from "../finance/finance-api.js";
import { node } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { getBrands } from "./inventory-options.js";

let loadBrands;

export function initializeBrandSettings() {
  loadBrands ||= bindBrandSettings();
  return loadBrands();
}

function bindBrandSettings() {
  const $ = (id) => document.getElementById(id);
  const form = $("brandSettingsForm");
  const name = $("brandSettingsName");
  const status = $("brandSettingsStatus");
  const list = $("brandSettingsList");
  const error = $("brandSettingsError");
  const dialog = $("brandDeleteDialog");
  const deleteError = $("brandDeleteError");
  const refresh = $("refreshBrands");
  const cancelEdit = $("cancelBrandEdit");
  const cancelDelete = $("cancelBrandDelete");
  const confirmDelete = $("confirmBrandDelete");
  const path = "/settings/brands";
  let editing,
    deleting,
    saving = false,
    version = 0;

  function edit(brand = null) {
    editing = brand;
    name.value = brand?.name ?? "";
    $("brandFormTitle").textContent = brand ? "ویرایش برند" : "افزودن برند";
    $("saveBrand").textContent = brand ? "ذخیره تغییرات" : "افزودن";
    cancelEdit.hidden = !brand;
    error.hidden = true;
    if (brand) name.focus();
  }

  function openDelete(brand) {
    deleting = brand;
    $("brandDeleteDescription").textContent = `برند «${brand.name}» حذف شود؟`;
    deleteError.textContent = "";
    dialog.showModal();
  }

  function row(brand) {
    const element = node("li", "inventory-option-row flex-wrap");
    const actions = node("div", "flex flex-wrap gap-2");
    const editButton = node(
      "button",
      "finance-button border border-french-gray/40",
      "ویرایش",
    );
    const deleteButton = node(
      "button",
      "finance-button text-alizarin-crimson",
      "حذف",
    );
    editButton.type = deleteButton.type = "button";
    editButton.setAttribute("aria-label", `ویرایش برند ${brand.name}`);
    deleteButton.setAttribute("aria-label", `حذف برند ${brand.name}`);
    editButton.addEventListener("click", () => {
      if (!saving) edit(brand);
    });
    deleteButton.addEventListener("click", () => {
      if (!saving) openDelete(brand);
    });
    actions.append(editButton, deleteButton);
    element.append(node("span", "font-bold", brand.name), actions);
    return element;
  }

  async function load() {
    const current = ++version;
    list.setAttribute("aria-busy", "true");
    refresh.disabled = true;
    try {
      const brands = await getBrands();
      if (current !== version) return;
      list.replaceChildren(...brands.map(row));
      status.setAttribute("role", "status");
      status.textContent = brands.length
        ? `${formatNumber(brands.length)} برند`
        : "هنوز برندی ثبت نشده است.";
    } catch (error) {
      if (current !== version) return;
      status.setAttribute("role", "alert");
      status.textContent = error.message;
    } finally {
      if (current === version) {
        list.setAttribute("aria-busy", "false");
        refresh.disabled = false;
      }
    }
  }

  function setSaving(pending) {
    saving = pending;
    $("brandSettingsFields").disabled = pending;
    cancelDelete.disabled = confirmDelete.disabled = pending;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    error.hidden = true;
    setSaving(true);
    try {
      await financeRequest(editing ? `${path}/${editing.id}` : path, {
        method: editing ? "PUT" : "POST",
        body: { name: name.value.trim() },
      });
      edit();
      await load();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      setSaving(false);
    }
  });

  $("brandDeleteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    deleteError.textContent = "";
    try {
      await financeRequest(`${path}/${deleting.id}`, { method: "DELETE" });
      if (editing?.id === deleting.id) edit();
      dialog.close();
      await load();
    } catch (err) {
      deleteError.textContent = err.message;
    } finally {
      setSaving(false);
    }
  });

  cancelEdit.addEventListener("click", () => {
    edit();
    name.focus();
  });
  cancelDelete.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  refresh.addEventListener("click", load);
  onPageRefresh(load, { isVisible: () => list.getClientRects().length > 0 });
  return load;
}

import {
  categoryGroups,
  categoryIsSelectable,
  categoryLabel,
  deleteInventoryCategory,
  getInventoryOptions,
  saveInventoryOption,
  WAREHOUSE_CATEGORIES,
} from "./inventory-options.js";
import { onPageRefresh } from "../components/data-events.js";
import { node } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";

const $ = (id) => document.getElementById(id);
let initialized = false;
let pending = false;
let version = 0;
let units = [];
let categories = [];
let categoryKind = "categories";
let categoryReady = false;
let editingCategory = null;
let deletingCategory = null;

const actionStyle = "finance-button border border-french-gray/40";

const searchText = (value) =>
  value.trim().replace(/ي/g, "ی").replace(/ك/g, "ک").toLocaleLowerCase("fa");

function renderUnits() {
  const query = searchText($("inventory-units-search").value);
  const visible = units.filter((item) => searchText(item.name).includes(query));
  $("inventory-units-count").textContent =
    `${units.filter((item) => item.active).length} واحد انتخاب‌شده از ${units.length} · ${visible.length} نتیجه`;
  const list = $("inventory-units-list");
  const previous = [...list.children];
  const rows = visible.map((item) => {
    // Keep checkbox identity and keyboard focus through saves and refreshes.
    const row =
      previous.find((row) => row.dataset.unitId === String(item.id)) ||
      node("li", "inventory-option-row");
    if (!row.dataset.unitId) {
      row.dataset.unitId = String(item.id);
      const label = node("label", "inventory-unit-choice");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.dataset.unitId = item.id;
      checkbox.addEventListener("change", () => {
        void saveUnit(
          {
            name: row.querySelector("span").textContent,
            active: checkbox.checked,
          },
          item.id,
        );
      });
      label.append(checkbox, node("span"));
      row.append(label);
    }
    const checkbox = row.querySelector("input");
    checkbox.checked = item.active;
    checkbox.disabled = pending;
    row.querySelector("span").textContent = item.name;
    return row;
  });
  if (
    rows.length !== previous.length ||
    rows.some((row, index) => row !== previous[index])
  )
    list.replaceChildren(...rows);
  if (!visible.length)
    list.replaceChildren(
      node(
        "li",
        "text-sm text-mirage/60",
        query ? "واحدی با این نام پیدا نشد." : "هنوز واحدی تعریف نشده است.",
      ),
    );
}

function renderParentSelect(selected = $("inventory-categories-parent").value) {
  const parent = $("inventory-categories-parent");
  const groups = categoryGroups(categories);
  const hasChildren = groups.some(
    ({ main, children }) => main.id === editingCategory && children.length,
  );
  parent.replaceChildren(
    new Option("دستهٔ اصلی", ""),
    ...groups
      .filter(({ main }) => main.id !== editingCategory)
      .map(({ main }) => new Option(main.name, String(main.id))),
  );
  parent.value = String(selected ?? "");
  if (parent.selectedIndex === -1) parent.value = "";
  parent.disabled = hasChildren;
  $("inventory-categories-parent-help").textContent = hasChildren
    ? "برای تغییر سطح این دسته، ابتدا زیردسته‌های آن را جابه‌جا کنید."
    : "برای ایجاد زیردسته، دستهٔ اصلی آن را انتخاب کنید.";
}

function setCategoryForm(item = null, parentId = item?.parent_id) {
  editingCategory = item?.id ?? null;
  $("inventory-categories-title").textContent = item
    ? "ویرایش دسته‌بندی"
    : "افزودن دسته‌بندی";
  $("inventory-categories-submit").textContent = item
    ? "ذخیره تغییرات"
    : "افزودن";
  $("inventory-categories-cancel").hidden = !item && parentId == null;
  $("inventory-categories-name").value = item?.name ?? "";
  $("inventory-categories-active").checked = item?.active ?? true;
  renderParentSelect(parentId ?? "");
}

function openCategoryForm(item, parentId) {
  setCategoryForm(item, parentId);
  $("inventory-categories-name").focus();
}

function confirmCategoryDelete(item) {
  deletingCategory = { id: item.id, kind: categoryKind, confirmUnassignment: item.product_count > 0 };
  const question = `آیا می‌خواهید «${categoryLabel(item)}» را حذف کنید؟`;
  $("inventory-category-delete-description").textContent = deletingCategory.confirmUnassignment
    ? `${question} ${formatNumber(item.product_count)} کالا بدون دسته‌بندی انبار می‌مانند. کالاها، موجودی و سوابق خرید آن‌ها حفظ می‌شوند.`
    : question;
  $("inventory-category-delete-error").textContent = "";
  $("inventory-category-delete").showModal();
}

function categoryRow(item) {
  const row = node("div", "inventory-option-row");
  const identity = node("div", "grid min-w-0 gap-1");
  identity.append(node("span", "text-sm font-bold", item.name));
  if (categoryKind === WAREHOUSE_CATEGORIES)
    identity.append(node("span", "text-xs text-mirage/65",
      item.product_count ? `${formatNumber(item.product_count)} کالا` : "بدون کالا"));
  if (!categoryIsSelectable(item)) {
    identity.append(
      node(
        "span",
        "text-xs text-mirage/65",
        item.active ? "دستهٔ اصلی غیرفعال است" : "غیرفعال",
      ),
    );
  }
  const actions = node("div", "flex flex-wrap gap-1");
  const action = (label, callback) => {
    const button = node("button", actionStyle, label);
    button.type = "button";
    button.disabled = pending;
    button.setAttribute("aria-label", `${label} ${categoryLabel(item)}`);
    button.addEventListener("click", callback);
    actions.append(button);
  };
  if (item.parent_id == null)
    action("افزودن زیردسته", () => openCategoryForm(null, item.id));
  action("ویرایش", () => openCategoryForm(item));
  action("حذف", () => confirmCategoryDelete(item));
  row.append(identity, actions);
  return row;
}

function renderCategories() {
  const list = $("inventory-categories-list");
  const query = categoryKind === WAREHOUSE_CATEGORIES ? searchText($("inventory-categories-search").value) : "";
  const matches = (item) => searchText(categoryLabel(item)).includes(query);
  const branches = [];
  for (const { main, children } of categoryGroups(categories)) {
    const visibleChildren = children.filter(matches);
    if (!matches(main) && !visibleChildren.length) continue;
    const branch = node("li", "inventory-category-branch");
    branch.dataset.categoryId = main.id;
    branch.append(categoryRow(main));
    if (visibleChildren.length) {
      const sublist = node("ul", "inventory-category-children");
      for (const child of visibleChildren) {
        const leaf = node("li");
        leaf.dataset.categoryId = child.id;
        leaf.append(categoryRow(child));
        sublist.append(leaf);
      }
      branch.append(sublist);
    }
    branches.push(branch);
  }
  list.replaceChildren(...branches);
  if (!branches.length)
    list.append(
      node("li", "text-sm text-mirage/60", query ? "دسته‌بندی پیدا نشد." : "هنوز دسته‌بندی تعریف نشده است."),
    );
  if (
    editingCategory !== null &&
    !categories.some((item) => item.id === editingCategory)
  )
    setCategoryForm();
  else renderParentSelect();
}

function message(id, text, failed = false) {
  const status = $(id);
  status.textContent = text;
  status.setAttribute("role", failed ? "alert" : "status");
}

function busy(value) {
  for (const id of ["inventoryOptionsLists", "unitOptionsLists"])
    $(id).setAttribute("aria-busy", String(value));
}

async function load() {
  const current = ++version;
  busy(true);
  const statuses = ["inventoryOptionsStatus", "unitOptionsStatus"];
  for (const id of statuses) message(id, "در حال دریافت تنظیمات…");
  try {
    const options = await getInventoryOptions();
    if (version !== current) return;
    units = options.units;
    categories = options[categoryKind];
    categoryReady = true;
    renderCategories();
    for (const id of statuses) message(id, "");
    return true;
  } catch (error) {
    if (version === current)
      for (const id of statuses) message(id, error.message, true);
  } finally {
    if (version === current) {
      busy(false);
      syncControls();
    }
  }
}

function syncControls() {
  renderUnits();
  for (const id of ["refreshInventoryOptions", "refreshUnitOptions"])
    $(id).disabled = pending;
  document
    .querySelectorAll(
      "#inventory-units-form fieldset, #inventory-categories-list button, #inventory-category-delete-form button",
    )
    .forEach((control) => (control.disabled = pending));
  $("inventory-categories-fields").disabled = pending || !categoryReady;
}

async function mutate(status, request, update, success = "", isCurrent = () => true) {
  if (pending) return;
  pending = true;
  busy(true);
  syncControls();
  try {
    const result = await request();
    if (isCurrent()) update(result);
  } catch (error) {
    if (isCurrent()) message(status, error.message, true);
    busy(false);
    return false;
  } finally {
    pending = false;
    syncControls();
  }
  if ((await load()) && success && isCurrent()) message(status, success);
  return true;
}

async function saveUnit(data, id) {
  if (pending) return;
  const previous = units;
  if (id)
    units = units.map((item) =>
      item.id === id ? { ...item, active: data.active } : item,
    );
  const saved = await mutate(
    "unitOptionsStatus",
    () => saveInventoryOption("units", data, id),
    (item) => {
      units = id
        ? units.map((unit) => (unit.id === id ? item : unit))
        : [...units, item];
      if (!id) $("inventory-units-form").reset();
    },
  );
  if (!saved) {
    units = previous;
    renderUnits();
  }
}

export async function initializeInventorySettings(panel, section) {
  if (section !== "units") {
    const kind = section === WAREHOUSE_CATEGORIES ? WAREHOUSE_CATEGORIES : "categories";
    if (categoryKind !== kind) {
      $("inventory-category-delete").close();
      categoryKind = kind;
      categoryReady = false;
      categories = [];
      $("inventory-categories-list").replaceChildren();
      $("inventory-categories-search").value = "";
      setCategoryForm();
      syncControls();
    }
    const warehouse = kind === WAREHOUSE_CATEGORIES;
    $("inventoryCategoriesHeading").textContent = warehouse ? "دسته‌بندی انبار کالا" : "دسته‌بندی کالا";
    $("inventory-category-search-field").hidden = !warehouse;
  }
  if (!initialized) {
    initialized = true;
    $("inventory-categories-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("inventory-categories-name").value.trim();
      if (!name)
        return message("inventoryOptionsStatus", "عنوان را وارد کنید.", true);
      const id = editingCategory;
      const kind = categoryKind;
      const data = {
        name,
        parent_id: Number($("inventory-categories-parent").value) || null,
        active: $("inventory-categories-active").checked,
      };
      void mutate(
        "inventoryOptionsStatus",
        () => saveInventoryOption(kind, data, id),
        (saved) => {
          categories = id
            ? categories.map((item) => (item.id === id ? saved : item))
            : [...categories, saved];
          setCategoryForm();
          renderCategories();
        },
        "دسته‌بندی ذخیره شد.",
        () => categoryKind === kind,
      );
    });
    $("inventory-categories-cancel").addEventListener("click", () =>
      openCategoryForm(null),
    );
    const dialog = $("inventory-category-delete");
    dialog.addEventListener("cancel", (event) => {
      if (pending) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      deletingCategory = null;
    });
    $("inventory-category-delete-cancel").addEventListener("click", () =>
      dialog.close(),
    );
    $("inventory-category-delete-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (pending || !deletingCategory) return;
      const { id, kind, confirmUnassignment } = deletingCategory;
      $("inventory-category-delete-error").textContent = "";
      void mutate(
        "inventory-category-delete-error",
        () => deleteInventoryCategory(kind, id, confirmUnassignment),
        () => {
          dialog.close();
          categories = categories.filter((item) => item.id !== id);
          renderCategories();
          $("inventory-categories-name").focus();
        },
        "",
        () => categoryKind === kind,
      );
    });
    $("inventory-units-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("inventory-units-name").value.trim();
      if (!name)
        return message("unitOptionsStatus", "عنوان را وارد کنید.", true);
      void saveUnit({ name, active: true });
    });
    $("refreshInventoryOptions").addEventListener("click", load);
    $("refreshUnitOptions").addEventListener("click", load);
    $("inventory-units-search").addEventListener("input", renderUnits);
    $("inventory-categories-search").addEventListener("input", renderCategories);
    onPageRefresh(load, {
      isVisible: () =>
        ["inventory", "units"].some(
          (section) =>
            document
              .querySelector(`[data-settings-panel="${section}"]`)
              .getClientRects().length > 0,
        ),
    });
  }
  await load();
}

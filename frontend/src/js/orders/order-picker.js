import { formatNumber, normalizeText } from "../customers/customer-utils.js";
import { node } from "../finance/finance-utils.js";

export function positionOrderDropdown(menu, input, dialog) {
  const anchor = input.getBoundingClientRect();
  const panel = dialog.getBoundingClientRect();
  const form = input.closest(".orders-dialog-body")?.getBoundingClientRect() ?? panel;
  const clip = input.closest(".orders-table-scroll")?.getBoundingClientRect() ?? panel;
  if (anchor.bottom <= Math.max(panel.top, form.top, clip.top) ||
      anchor.top >= Math.min(panel.bottom, form.bottom, clip.bottom) ||
      anchor.right <= clip.left || anchor.left >= clip.right) return false;

  const gutter = 6;
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const width = Math.min(Math.max(anchor.width, 220), panel.width - 2 * gutter);
  const left = Math.max(panel.left + gutter, Math.min(anchor.right - width, panel.right - gutter - width));
  const below = viewportBottom - anchor.bottom - 2 * gutter;
  const above = anchor.top - viewportTop - 2 * gutter;
  const openAbove = below < 180 && above > below;
  Object.assign(menu.style, {
    width: `${width}px`,
    left: `${left}px`,
    top: openAbove ? "auto" : `${anchor.bottom + gutter}px`,
    bottom: openAbove ? `${window.innerHeight - anchor.top + gutter}px` : "auto",
    maxHeight: `${Math.min(264, Math.max(gutter, openAbove ? above : below))}px`,
  });
  return true;
}

const searchName = (value) => normalizeText(value.normalize("NFKC"))
  .replace(/[\u0640\u200c\u200d\p{M}\s]/gu, "")
  .replace(/ى/g, "ی")
  .toLowerCase();
const pageSize = 40;

export function createProductPicker(dialog, onSelect, { chooseCategory = false } = {}) {
  const menu = node("div", "orders-picker-dropdown");
  menu.setAttribute("popover", "manual");
  const list = node("div");
  list.id = "orderProductOptions";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "کالاها");
  const empty = node("p", "orders-hint", "کالایی پیدا نشد.");
  empty.setAttribute("role", "status");
  const more = node("button", "orders-secondary", "نمایش کالاهای بیشتر");
  more.type = "button";
  const back = node("button", "orders-secondary", "بازگشت به دسته‌بندی‌ها");
  back.type = "button";
  back.hidden = true;
  menu.append(back, list, empty, more);
  dialog.append(menu);

  let input, catalog = [], byId = new Map();
  let matches, query, options, active, group, categoryId, categories = [];
  let categoryProducts = new Map();
  let positionFrame = null;

  function restore(field) {
    const product = byId.get(Number(field.dataset.productId));
    if (!product) {
      delete field.dataset.productId;
      delete field.dataset.categoryId;
    }
    field.value = product?.label ?? "";
  }
  function close() {
    if (!input) return;
    if (positionFrame !== null) {
      cancelAnimationFrame(positionFrame);
      positionFrame = null;
    }
    menu.hidePopover();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    restore(input);
    input = null;
  }
  function schedulePosition() {
    if (!input || positionFrame !== null) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      if (!positionOrderDropdown(menu, input, dialog)) close();
    });
  }
  function appendOptions() {
    const fragment = document.createDocumentFragment();
    const start = options.length;
    for (const item of matches.slice(start, start + pageSize)) {
      const pickingCategory = chooseCategory && categoryId == null;
      if (!pickingCategory && group !== item.category) {
        group = item.category;
        const heading = node("p", "orders-product-category", item.category);
        heading.setAttribute("aria-hidden", "true");
        fragment.append(heading);
      }
      const option = node("button", "orders-product-option", item.label);
      option.type = "button";
      option.tabIndex = -1;
      option.id = `order-${pickingCategory ? "category" : "product"}-${item.id}`;
      option.dataset[pickingCategory ? "categoryOption" : "productOption"] = item.id;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(!pickingCategory && item.id === Number(input.dataset.productId)));
      options.push(option);
      fragment.append(option);
    }
    list.append(fragment);
    more.hidden = options.length >= matches.length;
  }
  function filter(value) {
    const term = searchName(value);
    if (term === query) return;
    const source = chooseCategory ? (categoryId == null ? categories : categoryProducts.get(categoryId) ?? []) : catalog;
    matches = term ? (query && term.startsWith(query) ? matches : source)
      .filter((item) => chooseCategory ? item.search.includes(term) : item.search.startsWith(term)) : source;
    query = term;
    active = -1;
    group = null;
    options = [];
    input.removeAttribute("aria-activedescendant");
    list.replaceChildren();
    empty.hidden = !!matches.length;
    empty.textContent = chooseCategory && !term
      ? (categoryId == null ? "دسته‌بندی فعالی برای انبار تعریف نشده است." : "در این دسته‌بندی کالای قابل خرید وجود ندارد.")
      : "کالایی پیدا نشد.";
    back.hidden = categoryId == null;
    appendOptions();
    menu.scrollTop = 0;
  }
  function open(field, value) {
    if (field.matches(":disabled")) return;
    if (input !== field) {
      close();
      if (!positionOrderDropdown(menu, field, dialog)) return;
      input = field;
      query = undefined;
      categoryId = undefined;
      field.setAttribute("aria-expanded", "true");
      filter(value);
      menu.showPopover();
    } else filter(value);
  }
  function changeCategory(id) {
    if (!input) return;
    categoryId = id;
    query = undefined;
    input.value = "";
    input.focus({ preventScroll: true });
    filter("");
  }
  function select(id) {
    const field = input;
    const product = byId.get(id);
    if (!field || !product) return;
    const changed = String(id) !== field.dataset.productId;
    field.dataset.productId = id;
    if (chooseCategory) field.dataset.categoryId = product.warehouse_category_id;
    close();
    field.focus({ preventScroll: true });
    field.removeAttribute("aria-invalid");
    if (changed || chooseCategory) onSelect(field, product, changed);
  }

  // Options keep focus in the editable combobox so arrow keys continue to work.
  menu.addEventListener("mousedown", (event) => {
    if (event.target.closest("[data-product-option], [data-category-option]")) event.preventDefault();
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-product-option]");
    if (option) select(Number(option.dataset.productOption));
    const category = event.target.closest("[data-category-option]");
    if (category) changeCategory(Number(category.dataset.categoryOption));
  });
  back.addEventListener("click", () => changeCategory(undefined));
  more.addEventListener("click", () => {
    input.focus({ preventScroll: true });
    appendOptions();
  });
  dialog.addEventListener("focusout", (event) => {
    if (input && event.relatedTarget !== input && !menu.contains(event.relatedTarget))
      close();
  });
  dialog.addEventListener("click", (event) => {
    if (input && event.target !== input && !event.composedPath().includes(menu)) close();
  });
  dialog.addEventListener("scroll", (event) => {
    if (!menu.contains(event.target)) schedulePosition();
  }, true);
  window.addEventListener("resize", schedulePosition);
  window.visualViewport?.addEventListener("resize", schedulePosition);

  return {
    close,
    restore,
    get: (field) => byId.get(Number(field.dataset.productId)),
    setCatalog(products, warehouseCategories = []) {
      close();
      const groups = new Map();
      byId = new Map();
      categoryProducts = new Map(warehouseCategories.map(({ id }) => [id, []]));
      for (const product of products) {
        const category = product.category_path || "بدون دسته‌بندی";
        const option = {
          ...product, category,
          search: searchName(chooseCategory ? [product.name, product.brand_name, product.product_code].filter(Boolean).join(" ") : product.name),
          label: [product.name, product.brand_name, product.stock == null ? null : `موجودی ${formatNumber(product.stock)}`]
            .filter(Boolean).join(" · "),
        };
        byId.set(option.id, option);
        categoryProducts.get(product.warehouse_category_id)?.push(option);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(option);
      }
      catalog = [...groups.values()].flat();
      categories = warehouseCategories.map(({ id, name }) => ({
        id, label: `${name} · ${formatNumber(categoryProducts.get(id).length)} کالا`, search: searchName(name),
      }));
    },
    bind(field) {
      field.addEventListener("focus", () => {
        if (input !== field && field.dataset.productId) field.select();
      });
      field.addEventListener("click", () => {
        if (input !== field) {
          open(field, "");
          field.select();
        }
      });
      field.addEventListener("input", (event) => {
        if (!event.isComposing) open(field, field.value);
      });
      field.addEventListener("compositionend", () => open(field, field.value));
      field.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (input !== field) open(field, "");
          if (input !== field || !options.length) return;
          const next = active + (event.key === "ArrowDown" ? 1 : -1);
          if (next === options.length && next < matches.length) appendOptions();
          if (active >= 0) options[active].classList.remove("is-highlighted");
          active = Math.max(0, Math.min(options.length - 1, next));
          const option = options[active];
          option.classList.add("is-highlighted");
          field.setAttribute("aria-activedescendant", option.id);
          option.scrollIntoView({ block: "nearest" });
        } else if (input === field && (event.key === "Escape" || event.key === "Enter")) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") close();
          else if (matches.length) {
            const id = matches[active < 0 ? 0 : active].id;
            if (chooseCategory && categoryId == null) changeCategory(id);
            else select(id);
          }
        }
      });
    },
  };
}

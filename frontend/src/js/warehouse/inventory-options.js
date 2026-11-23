import { financeRequest } from "../finance/finance-api.js";

export const getInventoryOptions = () =>
  financeRequest("/settings/inventory-options", { cache: "no-store" });

export const getBrands = () =>
  financeRequest("/settings/brands", { cache: "no-store" });

export const saveInventoryOption = (kind, data, id) =>
  financeRequest(`/settings/inventory-options/${kind}${id ? `/${id}` : ""}`, {
    method: id ? "PUT" : "POST",
    body: data,
  });

export const deleteInventoryCategory = (id) =>
  financeRequest(`/settings/inventory-options/categories/${id}`, {
    method: "DELETE",
  });

export const categoryIsSelectable = (item) => item.selectable ?? item.active;
export const categoryLabel = (item) => item.path ?? item.name;

export function categoryGroups(categories) {
  const children = new Map();
  for (const item of categories) {
    if (item.parent_id == null) continue;
    if (!children.has(item.parent_id)) children.set(item.parent_id, []);
    children.get(item.parent_id).push(item);
  }
  return categories
    .filter((item) => item.parent_id == null)
    .map((main) => ({ main, children: children.get(main.id) ?? [] }));
}

export function populateCategorySelect(
  field,
  categories,
  { current = null, selected = field.value } = {},
) {
  const available = categoryGroups(categories)
    .flatMap(({ main, children }) => [main, ...children])
    .filter((item) => categoryIsSelectable(item) || item.id === current);
  field.replaceChildren(
    new Option(
      available.length
        ? "انتخاب دسته‌بندی"
        : "ابتدا دسته‌بندی را در تنظیمات تعریف کنید",
      "",
    ),
    ...available.map(
      (item) =>
        new Option(
          `${categoryLabel(item)}${categoryIsSelectable(item) ? "" : " (غیرفعال؛ دسته‌بندی فعلی کالا)"}`,
          String(item.id),
        ),
    ),
  );
  field.value = available.some((item) => String(item.id) === String(selected))
    ? String(selected)
    : "";
  field.disabled = available.length === 0;
}

// The original unit is offered only while editing its owning record. It stays
// visible when disabled, but is never offered to a new record.
export function populateUnitSelect(
  field,
  units,
  { current = null, selected = field.value } = {},
) {
  const active = units.filter((item) => item.active);
  const legacy = current && !active.some((item) => item.name === current);
  field.replaceChildren(
    new Option(
      active.length ? "انتخاب واحد" : "ابتدا واحدی را در تنظیمات فعال کنید",
      "",
    ),
    ...active.map((item) => new Option(item.name, item.name)),
    ...(legacy
      ? [new Option(`${current} (غیرفعال؛ واحد فعلی کالا)`, current)]
      : []),
  );
  field.value =
    active.some((item) => item.name === selected) ||
    (legacy && selected === current)
      ? selected
      : "";
  field.disabled = !active.length && !legacy;
}

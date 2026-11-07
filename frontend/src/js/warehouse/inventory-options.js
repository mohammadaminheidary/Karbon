import { financeRequest } from "../finance/finance-api.js";

export const getInventoryOptions = () =>
  financeRequest("/settings/inventory-options", { cache: "no-store" });

export const saveInventoryOption = (kind, data, id) =>
  financeRequest(`/settings/inventory-options/${kind}${id ? `/${id}` : ""}`, {
    method: id ? "PUT" : "POST",
    body: data,
  });

export function populateCategorySelect(
  field,
  categories,
  { current = null, selected = field.value } = {},
) {
  const available = categories.filter(
    (item) => item.active || item.id === current,
  );
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
          `${item.name}${item.active ? "" : " (غیرفعال؛ دسته‌بندی فعلی کالا)"}`,
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

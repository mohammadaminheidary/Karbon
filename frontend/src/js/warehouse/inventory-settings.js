import {
  getInventoryOptions,
  saveInventoryOption,
} from "./inventory-options.js";
import { onPageRefresh } from "../components/data-events.js";
import { node } from "../finance/finance-utils.js";

const $ = (id) => document.getElementById(id);
let initialized = false;
let pending = false;
let version = 0;
let units = [];

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
        void mutate(
          "units",
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

function message(text, failed = false) {
  for (const id of ["inventoryOptionsStatus", "unitOptionsStatus"]) {
    const status = $(id);
    status.textContent = text;
    status.setAttribute("role", failed ? "alert" : "status");
  }
}

function busy(value) {
  for (const id of ["inventoryOptionsLists", "unitOptionsLists"])
    $(id).setAttribute("aria-busy", String(value));
}

async function load() {
  const current = ++version;
  busy(true);
  message("در حال دریافت تنظیمات…");
  try {
    const options = await getInventoryOptions();
    if (version !== current) return;
    units = options.units;
    renderUnits();
    for (const kind of ["categories"]) {
      const list = $(`inventory-${kind}-list`);
      list.replaceChildren(
        ...options[kind].map((item) => {
          const row = node("li", "inventory-option-row");
          row.append(node("span", "", item.name));
          const toggle = node(
            "button",
            "finance-button border border-french-gray/40",
            item.active ? "غیرفعال کردن" : "فعال کردن",
          );
          toggle.type = "button";
          toggle.setAttribute(
            "aria-label",
            `${item.active ? "غیرفعال کردن" : "فعال کردن"} ${item.name}`,
          );
          toggle.addEventListener("click", () =>
            mutate(kind, { name: item.name, active: !item.active }, item.id),
          );
          row.append(toggle);
          return row;
        }),
      );
      if (!options[kind].length)
        list.append(
          node("li", "text-sm text-mirage/60", "هنوز گزینه‌ای تعریف نشده است."),
        );
    }
    message("");
  } catch (error) {
    if (version === current) message(error.message, true);
  } finally {
    if (version === current) busy(false);
  }
}

async function mutate(kind, data, id) {
  if (pending) return;
  pending = true;
  const previousUnits = units;
  let saved = false;
  if (kind === "units" && id)
    units = units.map((item) =>
      item.id === id ? { ...item, active: data.active } : item,
    );
  renderUnits();
  $("refreshInventoryOptions").disabled = true;
  $("refreshUnitOptions").disabled = true;
  document
    .querySelectorAll(
      '[data-settings-panel="inventory"] fieldset, [data-settings-panel="units"] fieldset',
    )
    .forEach((n) => (n.disabled = true));
  try {
    await saveInventoryOption(kind, data, id);
    saved = true;
    if (!id) $(`inventory-${kind}-form`).reset();
    await load();
  } catch (error) {
    if (!saved) units = previousUnits;
    message(error.message, true);
  } finally {
    pending = false;
    renderUnits();
    $("refreshInventoryOptions").disabled = false;
    $("refreshUnitOptions").disabled = false;
    document
      .querySelectorAll(
        '[data-settings-panel="inventory"] fieldset, [data-settings-panel="units"] fieldset',
      )
      .forEach((n) => (n.disabled = false));
  }
}

export async function initializeInventorySettings() {
  if (!initialized) {
    initialized = true;
    for (const kind of ["categories", "units"]) {
      $(`inventory-${kind}-form`).addEventListener("submit", (event) => {
        event.preventDefault();
        const name = $(`inventory-${kind}-name`).value.trim();
        if (!name) return message("عنوان را وارد کنید.", true);
        void mutate(kind, { name, active: true });
      });
    }
    $("refreshInventoryOptions").addEventListener("click", load);
    $("refreshUnitOptions").addEventListener("click", load);
    $("inventory-units-search").addEventListener("input", renderUnits);
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

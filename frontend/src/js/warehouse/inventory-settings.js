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

function message(text, failed = false) {
  const status = $("inventoryOptionsStatus");
  status.textContent = text;
  status.setAttribute("role", failed ? "alert" : "status");
}

async function load() {
  const current = ++version;
  $("inventoryOptionsLists").setAttribute("aria-busy", "true");
  message("در حال دریافت دسته‌بندی‌ها و واحدها…");
  try {
    const options = await getInventoryOptions();
    if (version !== current) return;
    for (const kind of ["categories", "units"]) {
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
    if (version === current)
      $("inventoryOptionsLists").setAttribute("aria-busy", "false");
  }
}

async function mutate(kind, data, id) {
  if (pending) return;
  pending = true;
  document
    .querySelectorAll('[data-settings-panel="inventory"] fieldset')
    .forEach((n) => (n.disabled = true));
  try {
    await saveInventoryOption(kind, data, id);
    if (!id) $(`inventory-${kind}-form`).reset();
    await load();
  } catch (error) {
    message(error.message, true);
  } finally {
    pending = false;
    document
      .querySelectorAll('[data-settings-panel="inventory"] fieldset')
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
    onPageRefresh(load, {
      isVisible: () =>
        document
          .querySelector('[data-settings-panel="inventory"]')
          .getClientRects().length > 0,
    });
  }
  await load();
}

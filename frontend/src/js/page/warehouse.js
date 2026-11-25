import { startPage } from "../components/page-ready.js";
import { initializePurchaseEntry } from "../warehouse/purchase-entry.js";
import { onPageRefresh } from "../components/data-events.js";
import { financeRequest } from "../finance/finance-api.js";
import { node } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { protectPage } from "../guards/auth-guard.js";

function inventoryRow(product) {
  const row = node("tr");
  const identity = node("td");
  const item = node("div", "warehouse-item");
  const name = node("div");
  name.append(
    node("strong", "", product.name),
    node("small", "", product.product_code ?? "—"),
  );
  item.append(name);
  identity.append(item);
  const status = node("td");
  const availability = product.stock > 0 ? "موجود" : "ناموجود";
  const availabilityClass =
    product.stock > 0 ? "warehouse-status-available" : "warehouse-status-out";
  status.append(
    node(
      "span",
      product.active
        ? `warehouse-status ${availabilityClass}`
        : "warehouse-status",
      product.active ? availability : "غیرفعال",
    ),
  );
  row.append(
    identity,
    node("td", "", product.brand_name ?? "—"),
    node("td", "", product.category_path ?? "—"),
    node("td", "", product.unit),
    node("td", "warehouse-quantity", formatNumber(product.stock)),
    status,
    node("td"),
  );
  return row;
}

function inventoryMessage(message) {
  const row = node("tr");
  const cell = node("td", "warehouse-empty", message);
  cell.colSpan = 8;
  row.append(cell);
  return row;
}

startPage(async () => {
  if (!(await protectPage())) return false;
  const inventory = document.getElementById("warehouseInventory");
  let version = 0;
  async function loadInventory() {
    const current = ++version;
    inventory.setAttribute("aria-busy", "true");
    try {
      const catalog = await financeRequest("/products?include_inactive=true");
      if (current !== version) return;
      const rows = catalog
        .filter((item) => item.stock != null)
        .map(inventoryRow);
      inventory.replaceChildren(
        ...(rows.length
          ? rows
          : [inventoryMessage("داده‌ای برای نمایش وجود ندارد.")]),
      );
    } catch (error) {
      if (current === version)
        inventory.replaceChildren(inventoryMessage(error.message));
    } finally {
      if (current === version) inventory.setAttribute("aria-busy", "false");
    }
  }
  initializePurchaseEntry({ onSaved: loadInventory });
  onPageRefresh(loadInventory);
  void loadInventory();
});

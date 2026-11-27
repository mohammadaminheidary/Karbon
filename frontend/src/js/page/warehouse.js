import { startPage } from "../components/page-ready.js";
import { initializePurchaseEntry } from "../warehouse/purchase-entry.js";
import { onPageRefresh } from "../components/data-events.js";
import { financeRequest } from "../finance/finance-api.js";
import { node } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { protectPage } from "../guards/auth-guard.js";
import { Dialog } from "../components/dialog.js";

/** @param {"available" | "empty" | "inactive"} availability */
function inventoryRow(product, availability, showMovements) {
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
  const available = availability === "available";
  status.append(
    node(
      "span",
      product.active
        ? `warehouse-status warehouse-status-${available ? "available" : "out"}`
        : "warehouse-status",
      product.active ? (available ? "موجود" : "ناموجود") : "غیرفعال",
    ),
  );
  const history = node("button", "orders-secondary", "گردش موجودی");
  history.type = "button";
  history.setAttribute("aria-label", `گردش موجودی ${product.name}`);
  history.addEventListener("click", () => showMovements(product));
  const actions = node("td");
  actions.append(history);
  row.append(
    identity,
    node("td", "", product.brand_name ?? "—"),
    node("td", "", product.warehouse_category_path ?? "بدون دسته‌بندی انبار"),
    node("td", "", product.unit),
    node("td", "warehouse-quantity", formatNumber(product.stock)),
    status,
    actions,
  );
  return row;
}

function inventoryMessage(message) {
  const row = node("tr");
  const cell = node("td", "warehouse-empty", message);
  cell.colSpan = 7;
  row.append(cell);
  return row;
}

startPage(async () => {
  if (!(await protectPage())) return false;
  const inventory = document.getElementById("warehouseInventory");
  const search = document.getElementById("warehouseSearch");
  const category = document.getElementById("warehouseCategoryFilter");
  const status = document.getElementById("warehouseStatusFilter");
  let version = 0, catalog = [], movements;
  let visibleRows = new Map();

  function showMovements(product) {
    movements ??= initializeMovements();
    movements.showMovements(product);
  }

  function render() {
    const query = search.value.trim().toLocaleLowerCase("fa-IR");
    const selectedCategory = category.value;
    const selectedStatus = status.value;
    const rows = new Map();
    let reused = 0;
    for (const entry of catalog) {
      if (selectedCategory && entry.category !== selectedCategory) continue;
      if (selectedStatus && entry.status !== selectedStatus) continue;
      if (query && !entry.searchText.includes(query)) continue;
      const previous = visibleRows.get(entry);
      if (previous) reused++;
      rows.set(entry, previous ?? inventoryRow(entry.product, entry.status, showMovements));
    }
    // Catalog order is fixed between loads, so equal membership means equal rows.
    if (reused && reused === rows.size && rows.size === visibleRows.size) return;
    visibleRows = rows;
    const content = document.createDocumentFragment();
    for (const row of rows.values()) content.append(row);
    if (!rows.size) content.append(inventoryMessage("کالایی پیدا نشد."));
    inventory.replaceChildren(content);
  }

  function summary(values) {
    for (const [key, value] of Object.entries(values))
      document.querySelector(`[data-warehouse-stat="${key}"]`).textContent = formatNumber(value);
  }

  async function loadInventory() {
    const current = ++version;
    inventory.setAttribute("aria-busy", "true");
    try {
      const products = await financeRequest("/inventory/products?catalog_only=true", { cache: "no-store" });
      if (current !== version) return;
      const selection = category.value;
      const categories = new Map();
      const stats = { total: 0, inactive: 0, empty: 0, available: 0, value: 0n };
      catalog = [];
      for (const product of products) {
        const categoryId = String(product.warehouse_category_id ?? "");
        const inStock = product.stock > 0;
        const availability = product.active ? (inStock ? "available" : "empty") : "inactive";
        if (product.warehouse_category_path) categories.set(categoryId, product.warehouse_category_path);
        stats.total++;
        if (!product.active) stats.inactive++;
        if (availability === "empty") stats.empty++;
        if (inStock) stats.available++;
        stats.value += BigInt(product.stock) * BigInt(product.price);
        catalog.push({
          product, category: categoryId, status: availability,
          searchText: `${product.name} ${product.product_code ?? ""}`.toLocaleLowerCase("fa-IR"),
        });
      }
      category.replaceChildren(new Option("همه دسته‌بندی‌ها", ""),
        ...[...categories].sort((a, b) => a[1].localeCompare(b[1], "fa"))
          .map(([id, name]) => new Option(name, id)));
      category.value = categories.has(selection) ? selection : "";
      summary(stats);
      render();
      const flows = await financeRequest("/inventory/today", { cache: "no-store" });
      if (current === version) summary(flows);
    } catch (error) {
      if (current === version && !catalog.length)
        inventory.replaceChildren(inventoryMessage(error.message));
    } finally {
      if (current === version) inventory.setAttribute("aria-busy", "false");
    }
  }
  search.addEventListener("input", render);
  category.addEventListener("change", render);
  status.addEventListener("change", render);
  initializePurchaseEntry({ onSaved: loadInventory });
  onPageRefresh(() => Promise.all([loadInventory(), movements?.refreshMovements()]));
  void loadInventory();
});

function initializeMovements() {
  const root = node("div", "orders-modal hidden");
  root.id = "warehouseMovementModal";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `<button type="button" class="orders-backdrop" data-dialog-close aria-label="بستن"></button>
    <section role="dialog" aria-modal="true" aria-labelledby="warehouseMovementTitle" class="orders-glass scale-95 opacity-0">
      <header class="orders-dialog-header"><h2 id="warehouseMovementTitle"></h2><button type="button" class="dialog-close-button" data-dialog-close aria-label="بستن"></button></header>
      <div class="orders-dialog-body"><p id="warehouseMovementStatus" role="status"></p><ul id="warehouseMovementItems" class="space-y-2"></ul></div>
      <footer class="orders-dialog-footer"><button type="button" class="orders-secondary" data-dialog-close>بستن</button><button type="button" class="orders-primary" id="warehouseMovementMore" hidden>نمایش بیشتر</button></footer>
    </section>`;
  document.body.append(root);
  let version = 0, skip = 0, productId;
  const dialog = new Dialog(root.id, { onCancel: () => { version++; productId = undefined; } });
  const header = root.querySelector("h2");
  const status = root.querySelector("p");
  const items = root.querySelector("ul");
  const more = root.querySelector("#warehouseMovementMore");
  const date = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "UTC" });

  async function load(append = false) {
    if (productId == null) return;
    const current = ++version;
    if (!append) skip = 0;
    more.disabled = true;
    status.textContent = "در حال دریافت گردش موجودی…";
    try {
      const result = await financeRequest(`/inventory/movements?product_id=${productId}&skip=${skip}`, { cache: "no-store" });
      if (current !== version) return;
      const rows = result.items.map((movement) => {
        const row = node("li", "orders-record");
        const direction = movement.delta > 0 ? "+" : "";
        row.append(node("span", "font-bold", `${direction}${formatNumber(movement.delta)} ${movement.unit} · ${date.format(new Date(movement.business_date))}`),
          node("bdi", "block orders-hint", movement.reference === "opening" ? "ماندهٔ آغازین انبار" : movement.reference));
        return row;
      });
      if (!append) items.replaceChildren();
      items.append(...rows);
      skip += rows.length;
      more.hidden = !result.has_more;
      status.textContent = skip ? "" : "گردش موجودی ثبت نشده است.";
    } catch (error) {
      if (current === version) status.textContent = error.message;
    } finally {
      if (current === version) more.disabled = false;
    }
  }

  more.addEventListener("click", () => void load(true));
  return {
    showMovements(product) {
      productId = product.id;
      header.textContent = `گردش موجودی ${product.name}`;
      items.replaceChildren();
      more.hidden = true;
      dialog.open();
      void load();
    },
    refreshMovements: () => load(),
  };
}

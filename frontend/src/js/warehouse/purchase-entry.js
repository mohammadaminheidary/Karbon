import { getToken } from "../auth/auth-storage.js";
import { getCustomer } from "../customers/customer-api.js";
import { normalizeText } from "../customers/customer-utils.js";
import { financeRequest } from "../finance/finance-api.js";
import { initializeOrderDialogs } from "../orders/order-dialogs.js";
import { categoryIsSelectable, categoryLabel, getInventoryOptions, WAREHOUSE_CATEGORIES } from "./inventory-options.js";

const pendingKey = "karbon-pending-purchase";
const purchaseRoute = /^#purchase(?:-edit-([1-9]\d*))?$/;

const purchaseFlow = {
  async loadCatalog() {
    const [options, products] = await Promise.all([
      getInventoryOptions(),
      financeRequest("/inventory/products?catalog_only=true", { cache: "no-store" }),
    ]);
    const categories = options[WAREHOUSE_CATEGORIES].filter(categoryIsSelectable)
      .map((category) => ({ id: category.id, name: categoryLabel(category) }));
    const categoryIds = new Set(categories.map(({ id }) => id));
    const units = new Set(options.units.filter((unit) => unit.active).map((unit) => normalizeText(unit.name)));
    const activeProducts = products.filter((product) => product.active && units.has(normalizeText(product.unit)))
      .map((product) => ({ ...product, category_path: product.warehouse_category_path }));
    return {
      categories, products: activeProducts,
      hasSelectableProducts: activeProducts.some((product) => categoryIds.has(product.warehouse_category_id)),
    };
  },
  async loadEdit(id) {
    const receipt = await financeRequest(`/purchases/${id}?for_edit=true`, { cache: "no-store" });
    let supplier = null;
    if (receipt.supplier_id) {
      try {
        supplier = await getCustomer(receipt.supplier_id);
      } catch (error) {
        if (error.status !== 404) throw error;
        supplier = {
          id: receipt.supplier_id, customer_code: receipt.supplier?.code ?? receipt.supplier_id,
          first_name: receipt.supplier?.name ?? "تأمین‌کننده بایگانی‌شده", last_name: "",
          phone_numbers: receipt.supplier?.phone_numbers ?? [], address: receipt.supplier?.address,
        };
      }
    }
    return {
      supplier,
      receipt: { ...receipt, edit_finance: receipt.finance,
        items: receipt.rows.map((row) => ({ ...row, unit_price: row.purchase_price })),
      },
    };
  },
  store(pending) {
    try {
      if (pending) sessionStorage.setItem(pendingKey, JSON.stringify({ ...pending, owner: getToken() }));
      else sessionStorage.removeItem(pendingKey);
    } catch {
      // Retry remains available in the open page.
    }
  },
  restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey));
      if (saved?.owner === getToken() && saved.body?.request_id)
        return { ...saved, id: saved.id ?? saved.editing?.id };
    } catch {
      // Storage is optional for purchase entry.
    }
    return null;
  },
};

export function initializePurchaseEntry({ onSaved }) {
  const trigger = document.getElementById("buyItemsButton");
  let lastRoute;
  const open = initializeOrderDialogs(onSaved, {
    purchaseFlow,
    onClose() {
      if (purchaseRoute.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
      lastRoute = location.hash;
      trigger.setAttribute("aria-expanded", "false");
    },
  });
  function syncRoute() {
    const hash = location.hash;
    if (lastRoute === hash) return;
    const route = purchaseRoute.exec(hash);
    lastRoute = hash;
    trigger.setAttribute("aria-expanded", String(Boolean(route)));
    if (route) void open({ purchaseId: route[1] });
    else open.cancel();
  }
  trigger.addEventListener("click", () => {
    location.hash = "purchase";
    syncRoute();
  });
  window.addEventListener("hashchange", syncRoute);
  window.addEventListener("pageshow", () => {
    lastRoute = undefined;
    syncRoute();
  });
  syncRoute();
}

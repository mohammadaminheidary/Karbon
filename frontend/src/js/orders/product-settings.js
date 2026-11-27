import { notify } from "../components/notifications.js";
import { refreshData } from "../components/api-cache.js";
import { confirmFinanceDelete } from "../finance/delete-dialog.js";
import { financeRequest } from "../finance/finance-api.js";
import { node, money } from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { onPageRefresh } from "../components/data-events.js";
import { initializeProductForm } from "./product-form.js";

const $ = (id) => document.getElementById(id);
let form, listLoaded, renderedProducts, version = 0;
let warehouseView = false;
const selected = new Set();
const warehouseChoices = new Map();

let dismissMessage;
let messageFailed = false;
function message(text, failed = false) {
  dismissMessage?.();
  messageFailed = failed;
  dismissMessage = notify(text, { type: failed ? "error" : "success" });
}
function syncWarehouseSelection() {
  if (!warehouseView) return;
  for (const id of selected) {
    if (!warehouseChoices.has(id)) selected.delete(id);
  }
  for (const [id, checkbox] of warehouseChoices) checkbox.checked = selected.has(id);
  const all = $("selectAllWarehouseProducts");
  all.disabled = !warehouseChoices.size;
  all.checked = selected.size > 0 && selected.size === warehouseChoices.size;
  all.indeterminate = selected.size > 0 && !all.checked;
  $("warehouseProductSelectionCount").textContent = `${formatNumber(selected.size)} کالا انتخاب شده`;
  $("removeSelectedWarehouseProducts").disabled = !selected.size;
}

async function refreshAfterRemoval(text) {
  message(text);
  if ((await load()) === false)
    message(`${text} دریافت فهرست انجام نشد. برای تلاش مجدد «بروزرسانی» را انتخاب کنید.`, true);
}

async function load() {
  const current = ++version;
  const inWarehouse = warehouseView;
  if (!listLoaded)
    $("settingsProductsStatus").textContent = "در حال دریافت کالاها…";
  $("settingsProductsList").setAttribute("aria-busy", "true");
  $("refreshProducts").disabled = true;
  try {
    const products = await financeRequest(inWarehouse ? "/inventory/products?catalog_only=true" : "/products?include_inactive=true");
    if (current !== version) return;
    listLoaded = true;
    $("settingsProductsStatus").textContent = products.length
      ? `${formatNumber(products.length)} کالا`
      : inWarehouse ? "هیچ کالایی در فهرست انبار نیست." : "هنوز کالایی ثبت نشده است.";
    if (messageFailed) message("");
    const signature = JSON.stringify(products);
    if (signature === renderedProducts) return true;
    warehouseChoices.clear();
    $("settingsProductsList").replaceChildren(
      ...products.map((product) => {
        const card = node(
          "article",
          "card-tilt flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-french-gray/30 bg-white p-5",
        );
        card.dataset.productId = product.id;
        const identity = node("div", "min-w-0");
        identity.append(
          node(
            "h3",
            "font-bold break-words",
            [product.product_code, product.name, product.brand_name].filter(Boolean).join(" · "),
          ),
          node(
            "p",
            "mt-2 text-xs text-mirage/60",
            `${inWarehouse ? product.warehouse_category_path || "بدون دسته‌بندی انبار" : product.category_path || "بدون دسته‌بندی"} · ${product.unit} · ${money(product.price)} · ${inWarehouse
              ? `موجودی انبار ${formatNumber(product.stock)}`
              : `موجودی فروش ${product.stock == null ? "بدون کنترل" : formatNumber(product.stock)}`} · ${product.active ? "فعال" : "غیرفعال"}`,
          ),
        );
        const edit = node(
          "button",
          "finance-button border border-french-gray/40",
          "ویرایش",
        );
        edit.type = "button";
        edit.addEventListener("click", () => void form.open(product));
        const removeLabel = inWarehouse ? "حذف از انبار" : "حذف کالا";
        const blockedReason = inWarehouse ? product.removal_blocked_reason
          : product.can_delete === false ? "این کالا موجودی انبار یا سابقهٔ عملیات دارد؛ برای خارج کردن از فهرست، آن را غیرفعال کنید." : null;
        const remove = node(
          "button",
          "finance-button text-alizarin-crimson",
          removeLabel,
        );
        remove.type = "button";
        remove.setAttribute("aria-label", `${removeLabel} ${product.name}`);
        remove.disabled = Boolean(blockedReason);
        remove.classList.toggle("finance-delete-blocked", remove.disabled);
        remove.title = blockedReason || removeLabel;
        remove.addEventListener("click", () => {
          if (remove.disabled) return;
          confirmFinanceDelete({
            path: `${inWarehouse ? "/inventory/products" : "/products"}/${product.id}`,
            description: inWarehouse
              ? `کالا «${product.product_code} · ${product.name}» از انبار حذف شود؟ اطلاعات کالا و فاکتورهای فروش آن حفظ می‌شوند.`
              : `کالا «${product.product_code} · ${product.name}» حذف شود؟ این عملیات قابل بازگشت نیست. کالاهای استفاده‌شده در خرید یا سفارش حذف‌نشده قابل حذف نیستند.`,
            onDeleted: async () => {
              card.remove();
              if (inWarehouse) {
                warehouseChoices.delete(product.id);
                syncWarehouseSelection();
              }
              await refreshAfterRemoval(inWarehouse ? "کالا از انبار حذف شد." : "کالا با موفقیت حذف شد.");
            },
          });
        });
        if (remove.disabled) {
          identity.append(
            node(
              "p",
              "mt-2 text-xs text-mirage/60",
              blockedReason,
            ),
          );
        }
        const actions = node("div", "flex flex-wrap gap-2");
        if (inWarehouse && !blockedReason) {
          const checkbox = node("input", "size-4 self-center");
          checkbox.type = "checkbox";
          checkbox.setAttribute("aria-label", `انتخاب ${product.name}`);
          warehouseChoices.set(product.id, checkbox);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(product.id);
            else selected.delete(product.id);
            syncWarehouseSelection();
          });
          actions.append(checkbox);
        }
        actions.append(edit, remove);
        card.append(identity, actions);
        return card;
      }),
    );
    syncWarehouseSelection();
    renderedProducts = signature;
    return true;
  } catch (error) {
    if (current === version) {
      $("settingsProductsStatus").textContent = "";
      message(error.message, true);
    }
    return false;
  } finally {
    if (current === version) {
      $("refreshProducts").disabled = false;
      $("settingsProductsList").setAttribute("aria-busy", "false");
    }
  }
}
export async function initializeProductSettings(panel, section) {
  const showWarehouse = section === "warehouse-products";
  if (warehouseView !== showWarehouse) {
    warehouseView = showWarehouse;
    selected.clear();
    warehouseChoices.clear();
    listLoaded = false;
    renderedProducts = undefined;
    $("settingsProductsList").replaceChildren();
    $("settingsProductsHeading").textContent = showWarehouse ? "کالا (انبار)" : "مدیریت کالاها";
    $("warehouseProductSelection").hidden = !showWarehouse;
    syncWarehouseSelection();
  }
  if (!form) {
    form = initializeProductForm({ onSaved: load, isWarehouseView: () => warehouseView });
    $("refreshProducts").addEventListener("click", refreshData(load));
    $("selectAllWarehouseProducts")?.addEventListener("change", (event) => {
      selected.clear();
      if (event.target.checked) {
        for (const id of warehouseChoices.keys()) selected.add(id);
      }
      syncWarehouseSelection();
    });
    $("removeSelectedWarehouseProducts")?.addEventListener("click", () => {
      const ids = [...selected];
      if (!ids.length) return;
      confirmFinanceDelete({
        path: "/inventory/products",
        fields: { product_ids: ids },
        description: `${formatNumber(ids.length)} کالای انتخاب‌شده از انبار حذف شوند؟ موجودی فروش و فاکتورهای فروش حفظ می‌شوند.`,
        onDeleted: async () => {
          if (warehouseView) {
            for (const id of ids) {
              document.querySelector(`[data-product-id="${id}"]`)?.remove();
              warehouseChoices.delete(id);
            }
            syncWarehouseSelection();
          }
          await refreshAfterRemoval(`${formatNumber(ids.length)} کالا از انبار حذف شدند.`);
        },
      });
    });
    onPageRefresh(load, {
      isVisible: () => $("settingsProductsList").getClientRects().length > 0,
    });
  }
  await load();
}

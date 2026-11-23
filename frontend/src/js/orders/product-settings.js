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

let dismissMessage;
let messageFailed = false;
function message(text, failed = false) {
  dismissMessage?.();
  messageFailed = failed;
  dismissMessage = notify(text, { type: failed ? "error" : "success" });
}
async function load() {
  const current = ++version;
  if (!listLoaded)
    $("settingsProductsStatus").textContent = "در حال دریافت کالاها…";
  $("settingsProductsList").setAttribute("aria-busy", "true");
  $("refreshProducts").disabled = true;
  try {
    const products = await financeRequest("/products?include_inactive=true");
    if (current !== version) return;
    listLoaded = true;
    $("settingsProductsStatus").textContent = products.length
      ? `${formatNumber(products.length)} کالا`
      : "هنوز کالایی ثبت نشده است.";
    if (messageFailed) message("");
    const signature = JSON.stringify(products);
    if (signature === renderedProducts) return true;
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
            `${product.category_path || "بدون دسته‌بندی"} · ${product.unit} · ${money(product.price)} · موجودی ${product.stock == null ? "بدون کنترل" : formatNumber(product.stock)} · ${product.active ? "فعال" : "غیرفعال"}`,
          ),
        );
        const edit = node(
          "button",
          "finance-button border border-french-gray/40",
          "ویرایش",
        );
        edit.type = "button";
        edit.addEventListener("click", () => void form.open(product));
        const remove = node(
          "button",
          "finance-button text-alizarin-crimson",
          "حذف کالا",
        );
        remove.type = "button";
        remove.setAttribute("aria-label", `حذف کالا ${product.name}`);
        remove.disabled = product.can_delete === false;
        remove.classList.toggle("finance-delete-blocked", remove.disabled);
        remove.title = remove.disabled
          ? "کالای استفاده‌شده در خرید یا سفارش حذف‌نشده قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید."
          : "حذف کالا بدون سابقه سفارش";
        remove.addEventListener("click", () => {
          if (remove.disabled) return;
          confirmFinanceDelete({
            path: `/products/${product.id}`,
            description: `کالا «${product.product_code} · ${product.name}» حذف شود؟ این عملیات قابل بازگشت نیست. کالاهای استفاده‌شده در خرید یا سفارش حذف‌نشده قابل حذف نیستند.`,
            onDeleted: async () => {
              document
                .querySelector(`[data-product-id="${product.id}"]`)
                ?.remove();
              message("کالا با موفقیت حذف شد.");
              if ((await load()) === false) {
                message(
                  "کالا حذف شد، اما دریافت فهرست انجام نشد. برای تلاش مجدد «بروزرسانی» را انتخاب کنید.",
                  true,
                );
              }
            },
          });
        });
        if (remove.disabled) {
          identity.append(
            node(
              "p",
              "mt-2 text-xs text-mirage/60",
              "این کالا در خرید یا سفارش حذف‌نشده استفاده شده؛ برای خارج کردن از فهرست، آن را غیرفعال کنید.",
            ),
          );
        }
        const actions = node("div", "flex flex-wrap gap-2");
        actions.append(edit, remove);
        card.append(identity, actions);
        return card;
      }),
    );
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
export async function initializeProductSettings() {
  if (!form) {
    form = initializeProductForm({ onSaved: load });
    $("refreshProducts").addEventListener("click", refreshData(load));
    onPageRefresh(load, {
      isVisible: () => $("settingsProductsList").getClientRects().length > 0,
    });
  }
  await load();
}

import { notifyNavbar } from "../components/navbar-notification.js";
import { refreshData } from "../components/api-cache.js";
import { confirmFinanceDelete } from "../finance/delete-dialog.js";
import { financeRequest } from "../finance/finance-api.js";
import {
  node,
  money,
  amountValue,
  normalizeDigits,
  bindStrictAmount,
} from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { onPageRefresh } from "../components/data-events.js";
import {
  getInventoryOptions,
  populateUnitSelect,
} from "../warehouse/inventory-options.js";

const $ = (id) => document.getElementById(id);
let initialized = false,
  listLoaded = false,
  renderedProducts,
  editing = null,
  saving = false,
  version = 0;
let units = [];
const format = (value) => new Intl.NumberFormat("en-US").format(value);

function renderUnits(selected = $("settingsProductUnit").value) {
  populateUnitSelect($("settingsProductUnit"), units, {
    current: editing?.unit,
    selected,
  });
}

function reset() {
  editing = null;
  $("settingsProductForm").reset();
  $("settingsProductCode").value = "تولید خودکار هنگام ثبت";
  $("saveSettingsProduct").textContent = "ثبت کالا";
  $("cancelSettingsProductEdit").hidden = true;
  renderUnits("");
}
let messageFailed = false;
function message(text, failed = false) {
  messageFailed = failed;
  notifyNavbar(text, { role: failed ? "alert" : "status" });
}
async function load() {
  const current = ++version;
  if (!listLoaded)
    $("settingsProductsStatus").textContent = "در حال دریافت کالاها…";
  $("settingsProductsList").setAttribute("aria-busy", "true");
  $("refreshProducts").disabled = true;
  $("settingsProductUnit").disabled = true;
  try {
    const [products, options] = await Promise.all([
      financeRequest("/products?include_inactive=true"),
      getInventoryOptions(),
    ]);
    if (current !== version) return;
    units = options.units;
    renderUnits();
    listLoaded = true;
    $("settingsProductsStatus").textContent = products.length
      ? `${formatNumber(products.length)} کالا`
      : "هنوز کالایی ثبت نشده است.";
    if (editing && !products.some((product) => product.id === editing.id))
      reset();
    if (messageFailed) message("");
    const signature = JSON.stringify(products);
    if (signature === renderedProducts) return true;
    $("settingsProductsList").replaceChildren(
      ...products.map((product) => {
        const card = node(
          "article",
          "flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-french-gray/30 bg-white p-5",
        );
        card.dataset.productId = product.id;
        const identity = node("div", "min-w-0");
        identity.append(
          node(
            "h3",
            "font-bold break-words",
            `${product.product_code} · ${product.name}`,
          ),
          node(
            "p",
            "mt-2 text-xs text-mirage/60",
            `${product.unit} · ${money(product.price)} · موجودی ${product.stock == null ? "بدون کنترل" : formatNumber(product.stock)} · ${product.active ? "فعال" : "غیرفعال"}`,
          ),
        );
        const edit = node(
          "button",
          "finance-button border border-french-gray/40",
          "ویرایش",
        );
        edit.type = "button";
        edit.addEventListener("click", () => {
          if (saving) return;
          editing = product;
          $("settingsProductCode").value = product.product_code;
          $("settingsProductName").value = product.name;
          renderUnits(product.unit);
          $("settingsProductPrice").value = format(product.price);
          $("settingsProductStock").value = product.stock ?? "";
          $("settingsProductActive").value = String(product.active);
          $("saveSettingsProduct").textContent = "ذخیره تغییرات";
          $("cancelSettingsProductEdit").hidden = false;
          message("");
          $("settingsProductName").focus();
        });
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
          ? "کالای استفاده‌شده در سفارش حذف‌نشده قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید."
          : "حذف کالا بدون سابقه سفارش";
        remove.addEventListener("click", () => {
          if (saving || remove.disabled) return;
          confirmFinanceDelete({
            path: `/products/${product.id}`,
            description: `کالا «${product.product_code} · ${product.name}» حذف شود؟ این عملیات قابل بازگشت نیست. کالاهای استفاده‌شده در سفارش حذف‌نشده قابل حذف نیستند.`,
            onDeleted: async () => {
              if (editing?.id === product.id) reset();
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
              "این کالا در سفارش حذف‌نشده استفاده شده؛ برای خارج کردن از فهرست سفارش، آن را غیرفعال کنید.",
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
  if (!initialized) {
    initialized = true;
    bindStrictAmount($("settingsProductPrice"));
    $("refreshProducts").addEventListener("click", refreshData(load));
    $("cancelSettingsProductEdit").addEventListener("click", () => {
      if (!saving) {
        reset();
        message("");
      }
    });
    onPageRefresh(load, {
      isVisible: () => $("settingsProductsList").getClientRects().length > 0,
    });
    $("settingsProductForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      message("");
      try {
        const name = $("settingsProductName").value.trim(),
          unit = $("settingsProductUnit").value;
        if (!name || !unit) throw new Error("نام و واحد کالا الزامی است.");
        if (
          unit !== editing?.unit &&
          !units.some((item) => item.active && item.name === unit)
        )
          throw new Error(
            "واحد را از فهرست واحدهای فعال در تنظیمات انتخاب کنید.",
          );
        const stock = normalizeDigits($("settingsProductStock").value).trim();
        if (stock && (!/^\d+$/.test(stock) || Number(stock) > 1000000000))
          throw new Error("موجودی باید عدد صحیح نامنفی باشد.");
        const body = {
          name,
          unit,
          price: amountValue($("settingsProductPrice").value, {
            allowZero: true,
          }),
          stock: stock ? Number(stock) : null,
          active: $("settingsProductActive").value === "true",
          ...(editing ? { revision: editing.revision } : {}),
        };
        saving = true;
        $("settingsProductFields").disabled = true;
        $("saveSettingsProduct").disabled = true;
        $("cancelSettingsProductEdit").disabled = true;
        await financeRequest(`/products${editing ? `/${editing.id}` : ""}`, {
          method: editing ? "PUT" : "POST",
          body,
        });
        reset();
        message("کالا و موجودی با موفقیت ذخیره شدند.");
        await load();
      } catch (error) {
        message(error.message, true);
      } finally {
        saving = false;
        $("settingsProductFields").disabled = false;
        $("saveSettingsProduct").disabled = false;
        $("cancelSettingsProductEdit").disabled = false;
      }
    });
  }
  await load();
}

import { financeRequest } from "../finance/finance-api.js";
import {
  node,
  money,
  amountValue,
  normalizeDigits,
  bindStrictAmount,
} from "../finance/finance-utils.js";
import { formatNumber } from "../customers/customer-utils.js";
import { onExternalDataChange } from "../components/data-events.js";

const $ = (id) => document.getElementById(id);
let initialized = false,
  editing = null,
  saving = false,
  version = 0;
const format = (value) => new Intl.NumberFormat("en-US").format(value);

function reset() {
  editing = null;
  $("settingsProductForm").reset();
  $("settingsProductCode").value = "تولید خودکار هنگام ثبت";
  $("saveSettingsProduct").textContent = "ثبت کالا";
  $("cancelSettingsProductEdit").hidden = true;
}
function message(text, failed = false) {
  $("settingsProductMessage").textContent = text;
  $("settingsProductMessage").hidden = !text;
  $("settingsProductMessage").style.color = failed
    ? "var(--color-alizarin-crimson)"
    : "var(--color-eucalyptus)";
}
async function load() {
  const current = ++version;
  $("settingsProductsStatus").textContent = "در حال دریافت کالاها…";
  $("settingsProductsList").setAttribute("aria-busy", "true");
  $("refreshProducts").disabled = true;
  try {
    const products = await financeRequest("/products?include_inactive=true");
    if (current !== version) return;
    $("settingsProductsStatus").textContent = products.length
      ? `${formatNumber(products.length)} کالا`
      : "هنوز کالایی ثبت نشده است.";
    $("settingsProductsList").replaceChildren(
      ...products.map((product) => {
        const card = node(
          "article",
          "flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-french-gray/30 bg-white p-5",
        );
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
          $("settingsProductUnit").value = product.unit;
          $("settingsProductPrice").value = format(product.price);
          $("settingsProductStock").value = product.stock ?? "";
          $("settingsProductActive").value = String(product.active);
          $("saveSettingsProduct").textContent = "ذخیره تغییرات";
          $("cancelSettingsProductEdit").hidden = false;
          message("");
          $("settingsProductName").focus();
        });
        card.append(identity, edit);
        return card;
      }),
    );
  } catch (error) {
    if (current === version)
      $("settingsProductsStatus").textContent = error.message;
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
    $("refreshProducts").addEventListener("click", load);
    $("cancelSettingsProductEdit").addEventListener("click", () => {
      if (!saving) {
        reset();
        message("");
      }
    });
    onExternalDataChange(load);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && $("settingsProductsList").getClientRects().length)
        load();
    });
    $("settingsProductForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      message("");
      try {
        const name = $("settingsProductName").value.trim(),
          unit = $("settingsProductUnit").value.trim();
        if (!name || !unit) throw new Error("نام و واحد کالا الزامی است.");
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

import { confirmFinanceDelete } from "./delete-dialog.js";
import { onExternalDataChange } from "../components/data-events.js";
import { getExpenseCategories, financeRequest } from "./finance-api.js";
import { node } from "./finance-utils.js";

const $ = (id) => document.getElementById(id);
let initialized = false,
  editing = null,
  saving = false,
  loading = false;

function resetForm() {
  editing = null;
  $("expenseCategoryForm").reset();
  $("saveExpenseCategory").textContent = "ثبت عنوان";
  $("expenseCategoryCode").textContent =
    "کد حساب هنگام ثبت به‌صورت خودکار ساخته می‌شود.";
  $("cancelExpenseCategoryEdit").classList.add("hidden");
}

async function loadCategories() {
  if (loading) return;
  loading = true;
  $("expenseCategoriesStatus").textContent = "در حال دریافت عناوین...";
  $("expenseCategoriesStatus").classList.remove("hidden");
  $("expenseCategoriesList").setAttribute("aria-busy", "true");
  try {
    const items = await getExpenseCategories();
    if (editing) {
      const current = items.find((row) => row.id === editing);
      if (current)
        $("expenseCategoryCode").textContent =
          `کد حساب: ${current.account_code}`;
      else resetForm();
    }
    $("expenseCategoriesStatus").classList.toggle("hidden", items.length > 0);
    $("expenseCategoriesStatus").textContent =
      "هنوز عنوان هزینه‌ای تعریف نشده است.";
    $("expenseCategoriesList").replaceChildren(
      ...items.map((item) => {
        const row = node(
          "div",
          "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-french-gray/30 p-4",
        );
        const identity = node("div");
        identity.append(
          node("p", "font-bold", item.title),
          node(
            "p",
            "mt-1 text-xs text-mirage/50",
            `${item.account_code} · ${item.active ? "فعال" : "غیرفعال"}`,
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
          editing = item.id;
          $("expenseCategoryTitle").value = item.title;
          $("expenseCategoryActive").value = String(item.active);
          $("expenseCategoryCode").textContent =
            `کد حساب: ${item.account_code}`;
          $("saveExpenseCategory").textContent = "ذخیره تغییرات";
          $("cancelExpenseCategoryEdit").classList.remove("hidden");
          $("expenseCategoryMessage").classList.add("hidden");
          $("expenseCategoryTitle").focus();
        });
        const actions = node("div", "flex gap-2");
        const remove = node(
          "button",
          "finance-button text-alizarin-crimson",
          "حذف",
        );
        remove.type = "button";
        remove.addEventListener("click", () =>
          confirmFinanceDelete({
            path: `/settings/expense-categories/${item.id}`,
            description: `عنوان هزینه «${item.title}» حذف شود؟`,
            onDeleted: async () => {
              if (editing === item.id) resetForm();
              await loadCategories();
            },
          }),
        );
        actions.append(edit, remove);
        row.append(identity, actions);
        return row;
      }),
    );
  } catch (error) {
    $("expenseCategoriesList").replaceChildren();
    $("expenseCategoriesStatus").textContent = error.message;
    $("expenseCategoriesStatus").classList.remove("hidden");
  } finally {
    loading = false;
    $("expenseCategoriesList").setAttribute("aria-busy", "false");
  }
}

export async function initializeExpenseSettings() {
  if (!initialized) {
    initialized = true;
    onExternalDataChange(loadCategories);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") loadCategories();
    });
    $("reloadExpenseCategories").addEventListener("click", loadCategories);
    $("cancelExpenseCategoryEdit").addEventListener("click", resetForm);
    $("expenseCategoryForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      let saved = false;
      $("expenseCategoryFields").disabled = true;
      $("saveExpenseCategory").disabled = true;
      $("cancelExpenseCategoryEdit").disabled = true;
      $("saveExpenseCategory").textContent = "در حال ذخیره...";
      try {
        await financeRequest(
          `/settings/expense-categories${editing ? `/${editing}` : ""}`,
          {
            method: editing ? "PUT" : "POST",
            body: {
              title: $("expenseCategoryTitle").value.trim(),
              active: $("expenseCategoryActive").value === "true",
            },
          },
        );
        saved = true;
        resetForm();
        $("expenseCategoryMessage").className = "mt-4 text-sm text-eucalyptus";
        $("expenseCategoryMessage").textContent = "عنوان هزینه ذخیره شد.";
      } catch (error) {
        $("expenseCategoryMessage").className =
          "mt-4 text-sm text-alizarin-crimson";
        $("expenseCategoryMessage").textContent = error.message;
      } finally {
        saving = false;
        $("expenseCategoryFields").disabled = false;
        $("saveExpenseCategory").disabled = false;
        $("cancelExpenseCategoryEdit").disabled = false;
        $("saveExpenseCategory").textContent = editing
          ? "ذخیره تغییرات"
          : "ثبت عنوان";
      }
      if (saved) await loadCategories();
    });
  }
  await loadCategories();
}

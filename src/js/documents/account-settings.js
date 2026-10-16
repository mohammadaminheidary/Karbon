import { confirmFinanceDelete } from "../finance/delete-dialog.js";
import { onExternalDataChange } from "../components/data-events.js";
import { financeRequest } from "../finance/finance-api.js";
import { node } from "../finance/finance-utils.js";

const $ = (id) => document.getElementById(id);
const path = "/settings/document-accounts";
let initialized = false,
  editing = null,
  saving = false,
  loading = false;
function reset() {
  editing = null;
  $("documentAccountForm").reset();
  $("saveDocumentAccount").textContent = "ثبت حساب";
  $("cancelDocumentAccountEdit").classList.add("hidden");
}
async function load() {
  if (loading) return;
  loading = true;
  $("documentAccountsStatus").textContent = "در حال دریافت حساب‌ها...";
  $("documentAccountsStatus").classList.remove("hidden");
  $("documentAccountsList").setAttribute("aria-busy", "true");
  try {
    const items = await financeRequest(path);
    if (editing && !items.some((item) => item.id === editing)) reset();
    $("documentAccountsStatus").classList.toggle("hidden", items.length > 0);
    $("documentAccountsStatus").textContent =
      "هنوز حسابی برای اسناد تعریف نشده است.";
    $("documentAccountsList").replaceChildren(
      ...items.map((item) => {
        const row = node(
          "div",
          "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-french-gray/30 p-4",
        );
        const identity = node("div", "min-w-0");
        identity.append(
          node("p", "break-words font-bold", `${item.code} · ${item.title}`),
          node(
            "p",
            "mt-1 text-xs text-mirage/50",
            `${item.kind === "income" ? "درآمد" : "هزینه"} · ${item.active ? "فعال" : "غیرفعال"}`,
          ),
        );
        const actions = node("div", "flex gap-2");
        const edit = node(
          "button",
          "finance-button border border-french-gray/40",
          "ویرایش",
        );
        edit.type = "button";
        edit.addEventListener("click", () => {
          if (saving) return;
          editing = item.id;
          $("documentAccountCode").value = item.code;
          $("documentAccountTitle").value = item.title;
          $("documentAccountKind").value = item.kind;
          $("documentAccountActive").value = String(item.active);
          $("saveDocumentAccount").textContent = "ذخیره تغییرات";
          $("cancelDocumentAccountEdit").classList.remove("hidden");
          $("documentAccountMessage").classList.add("hidden");
          $("documentAccountTitle").focus();
        });
        const remove = node(
          "button",
          "finance-button text-alizarin-crimson",
          "حذف",
        );
        remove.type = "button";
        remove.disabled = !item.can_delete;
        if (!item.can_delete)
          remove.title =
            "این حساب در سند استفاده شده است؛ برای توقف استفاده، آن را غیرفعال کنید.";
        remove.addEventListener("click", () =>
          confirmFinanceDelete({
            path: `${path}/${item.id}`,
            description: `حساب سند «${item.code} · ${item.title}» حذف شود؟`,
            onDeleted: async () => {
              if (editing === item.id) reset();
              await load();
            },
          }),
        );
        actions.append(edit, remove);
        row.append(identity, actions);
        return row;
      }),
    );
  } catch (error) {
    $("documentAccountsStatus").textContent = error.message;
    $("documentAccountsStatus").classList.remove("hidden");
  } finally {
    loading = false;
    $("documentAccountsList").setAttribute("aria-busy", "false");
  }
}
export async function initializeDocumentAccounts() {
  if (!initialized) {
    initialized = true;
    const refreshVisible = () => {
      if (!document.hidden && $("documentAccountForm").getClientRects().length)
        void load();
    };
    onExternalDataChange(refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    $("reloadDocumentAccounts").addEventListener("click", load);
    $("cancelDocumentAccountEdit").addEventListener("click", reset);
    $("documentAccountForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      $("documentAccountFields").disabled =
        $("saveDocumentAccount").disabled =
        $("cancelDocumentAccountEdit").disabled =
          true;
      try {
        await financeRequest(editing ? `${path}/${editing}` : path, {
          method: editing ? "PUT" : "POST",
          body: {
            title: $("documentAccountTitle").value.trim(),
            kind: $("documentAccountKind").value,
            active: $("documentAccountActive").value === "true",
          },
        });
        reset();
        $("documentAccountMessage").className = "mt-4 text-sm text-eucalyptus";
        $("documentAccountMessage").textContent = "حساب سند ذخیره شد.";
        await load();
      } catch (error) {
        $("documentAccountMessage").className =
          "mt-4 text-sm text-alizarin-crimson";
        $("documentAccountMessage").textContent = error.message;
      } finally {
        saving = false;
        $("documentAccountFields").disabled =
          $("saveDocumentAccount").disabled =
          $("cancelDocumentAccountEdit").disabled =
            false;
      }
    });
  }
  await load();
}

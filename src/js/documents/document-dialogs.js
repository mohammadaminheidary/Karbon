import { Dialog } from "../components/dialog.js";
import { financeRequest } from "../finance/finance-api.js";
import { node, fullDate, money } from "../finance/finance-utils.js";
import { confirmFinanceDelete } from "../finance/delete-dialog.js";
import { disintegrateCustomerCard } from "../customers/customer-card-animation.js";
import { initializeDocumentForm } from "./document-form.js";

export function initializeDocumentDialogs({ notify, onChanged, onIdle }) {
  const $ = (id) => document.getElementById(id);
  let selected,
    detailsVersion = 0;
  const form = initializeDocumentForm({ notify, onSaved: onChanged, onIdle });
  const details = new Dialog("documentDetailsModal", {
    onCancel: () => {
      detailsVersion++;
      selected = null;
    },
  });
  async function openDetails(id) {
    const version = ++detailsVersion;
    selected = null;
    $("editDocument").disabled = $("deleteDocument").disabled = true;
    $("documentDetailsBody").replaceChildren(
      node("p", "text-sm text-mirage/60", "در حال دریافت جزئیات..."),
    );
    $("documentDetailsModal").inert = false;
    details.open();
    try {
      const item = await financeRequest(`/documents/${id}`);
      if (version !== detailsVersion) return;
      selected = item;
      const metadata = node(
        "dl",
        "grid gap-4 rounded-xl bg-alabaster p-4 sm:grid-cols-2",
      );
      for (const [label, value] of [
        ["شماره سند", item.number],
        ["تاریخ سند", fullDate(item.date)],
        ["جمع درآمد", money(item.total_income)],
        ["جمع هزینه", money(item.total_expense)],
      ]) {
        const row = node("div", "min-w-0");
        row.append(
          node("dt", "text-xs text-mirage/50", label),
          node("dd", "mt-2 break-words text-sm font-bold", value),
        );
        metadata.append(row);
      }
      const sheet = node("div", "document-sheet mt-5");
      sheet.tabIndex = 0;
      const table = node(
        "table",
        "document-entry-table document-details-table",
      );
      const head = node("thead"),
        header = node("tr");
      for (const label of ["کد حساب", "نوع", "بانک", "شرح", "مبلغ (تومان)"]) {
        const th = node("th", "", label);
        th.scope = "col";
        header.append(th);
      }
      head.append(header);
      const body = node("tbody");
      for (const entry of item.rows) {
        const row = node("tr");
        for (const value of [
          entry.account_code,
          entry.kind === "income" ? "درآمد" : "هزینه",
          entry.bank.name,
          entry.description || "—",
          money(entry.amount),
        ])
          row.append(node("td", "", value));
        body.append(row);
      }
      table.append(head, body);
      sheet.append(table);
      $("documentDetailsBody").replaceChildren(
        metadata,
        sheet,
        node("h3", "mt-5 font-bold", "توضیحات کلی سند"),
        node(
          "p",
          "mt-3 whitespace-pre-wrap break-words text-sm leading-7",
          item.description || "بدون شرح",
        ),
      );
      $("editDocument").disabled = $("deleteDocument").disabled = false;
    } catch (error) {
      if (version !== detailsVersion) return;
      const retry = node(
        "button",
        "finance-button mt-4 border border-french-gray/40",
        "تلاش مجدد",
      );
      retry.type = "button";
      retry.addEventListener("click", () => openDetails(id));
      $("documentDetailsBody").replaceChildren(
        node("p", "text-sm text-alizarin-crimson", error.message),
        retry,
      );
    }
  }
  $("editDocument").addEventListener("click", () => {
    if (!selected) return;
    const item = selected;
    details.close();
    detailsVersion++;
    form.openForm(item);
  });
  $("deleteDocument").addEventListener("click", () => {
    if (!selected) return;
    const item = selected;
    confirmFinanceDelete({
      path: `/documents/${item.id}`,
      description: `سند «${item.number}» و تمام تراکنش‌های آن حذف شوند؟ موجودی بانک‌ها و جمع درآمد و هزینه نیز اصلاح می‌شوند.`,
      onDeleted: async () => {
        details.close();
        selected = null;
        detailsVersion++;
        await disintegrateCustomerCard(
          document.querySelector(`[data-document-id="${item.id}"]`),
        );
        await onChanged({ reset: false });
        notify("سند حذف شد");
        $("registerDocument").focus({ preventScroll: true });
      },
    });
  });
  return {
    openDetails,
    refreshOptions: form.refreshOptions,
    get busy() {
      return form.busy;
    },
  };
}

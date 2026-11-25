import { CurtainDialog } from "../components/curtain-dialog.js";
import { financeRequest } from "./finance-api.js";
import { node } from "./finance-utils.js";

let dialog,
  root,
  pending = false,
  action;
export function confirmFinanceDelete({ path, description, onDeleted, orderCancellation = false }) {
  if (pending) return;
  if (!root) {
    root = node("dialog", "bottom-curtain finance-surface");
    root.id = "financeDeleteModal";
    root.innerHTML = `<section role="alertdialog" aria-modal="true" aria-labelledby="deleteTitle" aria-describedby="deleteDescription" class="curtain-content">
      <h2 id="deleteTitle" class="text-lg font-black">آیا مطمئن هستید؟</h2>
      <p id="deleteDescription" class="mt-3 text-sm text-mirage/60"></p>
      <form id="financeDeleteForm" class="mt-5">
        <label>رمز حساب کاربری<input id="financeDeletePassword" type="password" autocomplete="current-password" required maxlength="1024" class="finance-field" /></label>
        <p id="financeDeleteError" role="alert" class="mt-3 text-sm text-alizarin-crimson"></p>
        <div class="mt-5 flex gap-3" data-confirm-actions><button id="financeDeleteSubmit" class="finance-button bg-alizarin-crimson text-white" type="submit">بله، حذف شود</button><button type="button" data-dialog-close class="finance-button border border-french-gray/40">انصراف</button></div>
      </form></section>`;
    document.body.append(root);
    dialog = new CurtainDialog(root.id, {
      canClose: () => !pending,
      onCancel: clear,
    });
    root.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending) return;
      const current = action;
      pending = true;
      busy();
      root.querySelector("#financeDeleteError").textContent = "";
      try {
        await financeRequest(current.path, {
          method: "DELETE",
          body: {
            password: root.querySelector("input").value,
            confirmed: true,
          },
        });
      } catch (error) {
        root.querySelector("#financeDeleteError").textContent = error.message;
        pending = false;
        busy();
        return;
      }
      pending = false;
      busy();
      clear();
      dialog.close();
      await current.onDeleted?.();
    });
  }
  action = { path, onDeleted, orderCancellation };
  root.toggleAttribute("data-order-cancellation", orderCancellation);
  root.querySelector("form").reset();
  root.querySelector("#deleteTitle").textContent = orderCancellation ? "لغو سفارش" : "آیا مطمئن هستید؟";
  root.querySelector("#deleteDescription").textContent = description;
  root.querySelector("#financeDeleteError").textContent = "";
  const keep = root.querySelector("[data-dialog-close]");
  keep.textContent = orderCancellation ? "حفظ سفارش" : "انصراف";
  const confirm = root.querySelector("#financeDeleteSubmit");
  if (orderCancellation) confirm.before(keep);
  else confirm.after(keep);
  busy();
  root.inert = false;
  dialog.open(orderCancellation ? keep : root.querySelector("input"));
}
function clear() {
  root.querySelector("form").reset();
  action = null;
}
function busy() {
  root
    .querySelectorAll("button, input")
    .forEach((el) => (el.disabled = pending));
  root.querySelector("#financeDeleteSubmit").textContent = action?.orderCancellation
    ? (pending ? "در حال لغو سفارش…" : "تأیید لغو سفارش")
    : (pending ? "در حال حذف..." : "بله، حذف شود");
}

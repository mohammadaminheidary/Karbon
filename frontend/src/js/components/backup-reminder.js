import { getToken } from "../auth/auth-storage.js";
import { backupRequest } from "./backup-api.js";

const checkedKey = "karbon-backup-reminder-checked";
let checking = false;

const navigation = performance.getEntriesByType("navigation")[0];
if (navigation?.type === "navigate" && !document.referrer.startsWith(`${window.location.origin}/`)) {
  resetBackupReminderVisit();
}

export function resetBackupReminderVisit() {
  try { sessionStorage.removeItem(checkedKey); } catch { /* Storage is optional. */ }
}

function checkedThisVisit() {
  try { return sessionStorage.getItem(checkedKey) === "1"; } catch { return false; }
}

function markChecked() {
  try { sessionStorage.setItem(checkedKey, "1"); } catch { /* Keep the document guard. */ }
}

export async function checkBackupReminder(token) {
  if (checking || checkedThisVisit()) return;
  checking = true;
  try {
    const status = await (await backupRequest("/status", { timeout: 15000 })).json();
    if (getToken() !== token) return;
    if (!status.reminder_due) {
      markChecked();
      return;
    }
    const show = () => {
      if (getToken() !== token) return;
      openReminder(status);
      markChecked();
    };
    if (document.documentElement.dataset.pageState === "ready") show();
    else window.addEventListener("karbon:page-ready", show, { once: true });
  } catch {
    checking = false;
  }
}

function openReminder({ last_backup_at, reminder_hours }) {
  const dialog = document.createElement("dialog");
  dialog.id = "backupReminderDialog";
  dialog.dir = "rtl";
  dialog.className = "fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-auto rounded-3xl border border-french-gray/30 bg-white p-6 text-mirage shadow-2xl backdrop:bg-mirage/45";
  dialog.setAttribute("aria-labelledby", "backupReminderTitle");
  dialog.setAttribute("aria-describedby", "backupReminderDescription");
  dialog.innerHTML = `
    <h2 id="backupReminderTitle" class="text-lg font-black">یادآوری پشتیبان‌گیری</h2>
    <p id="backupReminderDescription" class="mt-3 text-sm leading-7 text-mirage/75"></p>
    <div class="mt-6 flex flex-wrap gap-3">
      <button type="button" data-create-backup class="rounded-xl bg-persian-blue px-5 py-3 text-sm font-bold text-white">تهیه بکاپ</button>
      <form method="dialog"><button autofocus class="rounded-xl border border-french-gray/60 px-5 py-3 text-sm font-bold">بعداً</button></form>
    </div>`;
  const description = dialog.querySelector("p");
  if (!last_backup_at) {
    description.textContent = "هنوز نسخه پشتیبان تهیه نکرده‌اید. برای حفظ امنیت اطلاعات، اولین بکاپ را تهیه کنید.";
  } else {
    const interval = reminder_hours === 24 ? "یک روز" : `${new Intl.NumberFormat("fa-IR").format(reminder_hours)} ساعت`;
    description.textContent = `${interval} از آخرین پشتیبان‌گیری شما گذشته است. برای حفظ امنیت اطلاعات، بکاپ جدید تهیه کنید.`;
  }
  dialog.querySelector("[data-create-backup]").addEventListener("click", () => {
    dialog.close();
    if (window.location.pathname === "/page/settings-page.html" && window.location.hash === "#backup") {
      document.getElementById("backupCreatePassphrase")?.focus();
    } else {
      window.location.assign("/page/settings-page.html#backup");
    }
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  window.addEventListener("pagehide", () => { if (dialog.open) dialog.close(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

import { returnToLoginAfterDatabaseReplacement } from "../auth/auth-storage.js";
import { normalizeDigits } from "../customers/customer-utils.js";
import { downloadBlob } from "../reports/report-api.js";
import { backupRequest as request } from "./backup-api.js";
import { applyBackupPreferences, readBackupPreferences } from "./backup-preferences.js";
import { notify } from "./notifications.js";

const MAX_UPLOAD_BYTES = 513 * 1024 * 1024;
const sizeFormat = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });

function message(element, text, type) {
  element.textContent = text;
  element.hidden = !text;
  if (type) element.dataset.type = type;
  else delete element.dataset.type;
}

function sizeLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${sizeFormat.format(bytes / (1024 * 1024))} مگابایت`;
  return `${sizeFormat.format(bytes / 1024)} کیلوبایت`;
}

const panels = new WeakMap();

export async function initializeBackupSettings(panel) {
  if (!panels.has(panel)) panels.set(panel, mount(panel));
  await panels.get(panel)();
}

function mount(panel) {
  const $ = (id) => panel.querySelector(`#backup${id}`);
  const controls = $("Controls");
  const createForm = $("CreateForm");
  const uploadForm = $("UploadForm");
  const reminderForm = $("ReminderForm");
  const createFields = $("CreateFields");
  const uploadFields = $("UploadFields");
  const reminderFields = $("ReminderFields");
  const reminderEnabled = $("ReminderEnabled");
  const reminderHours = $("ReminderHours");
  const reminderStatus = $("ReminderStatus");
  const createStatus = $("CreateStatus");
  const listStatus = $("ListStatus");
  const uploadStatus = $("UploadStatus");
  const folderButton = $("OpenFolder");
  const restoreButton = $("Restore");
  const uploadFile = $("UploadFile");
  const uploadPassphrase = $("UploadPassphrase");
  let folderAvailable = false;
  let creating = false;
  let savingReminder = false;
  let validating = false;
  let restoring = false;
  let restored = false;
  let selectedArchive;
  let validated;
  let refresh;
  let dateFormat;

  function syncControls() {
    createFields.disabled = creating || restoring || restored;
    uploadFields.disabled = validating || restoring || restored;
    reminderFields.disabled = savingReminder || restoring || restored;
    restoreButton.disabled = creating || validating || savingReminder || restoring || restored;
    folderButton.disabled = !folderAvailable || restoring || restored;
    $("List").inert = restoring || restored;
  }

  function clearValidation() {
    validated = undefined;
    $("Validated").hidden = true;
  }

  function showTime(element, timestamp) {
    element.dateTime = timestamp;
    element.textContent = dateFormat.format(new Date(timestamp));
  }

  function showBackupStatus({ last_backup_at, timezone }) {
    dateFormat = new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short", timeZone: timezone });
    $("LastSuccess").hidden = !last_backup_at;
    $("NoSuccess").hidden = Boolean(last_backup_at);
    if (last_backup_at) showTime($("LastSuccess"), last_backup_at);
  }

  function selectArchive(filename) {
    selectedArchive = filename;
    if (filename) uploadForm.reset();
    uploadFile.required = !filename;
    message($("SelectedArchive"), filename ? `فایل انتخاب‌شده: ${filename}` : "");
    clearValidation();
    message(uploadStatus, "");
  }

  function addBackup(archive) {
    const row = document.createElement("li");
    const data = document.createElement("div");
    const filename = document.createElement("bdi");
    filename.textContent = archive.filename;
    const details = document.createElement("p");
    const time = document.createElement("time");
    showTime(time, archive.created_at);
    details.append(time, ` · ${sizeLabel(archive.size_bytes)}`);
    data.append(filename, details);

    const actions = document.createElement("div");
    actions.className = "flex flex-wrap gap-2";
    const encodedFilename = encodeURIComponent(archive.filename);
    const download = document.createElement("button");
    download.type = "button";
    download.className = "settings-secondary-button";
    download.textContent = "دانلود";
    download.setAttribute("aria-label", `دانلود ${archive.filename}`);
    download.addEventListener("click", async () => {
      download.disabled = true;
      try {
        message(listStatus, "");
        const response = await request(`/download/${encodedFilename}`);
        downloadBlob(await response.blob(), archive.filename);
      } catch (error) {
        message(listStatus, error.message, "error");
      } finally {
        download.disabled = false;
      }
    });

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "settings-secondary-button";
    restore.textContent = "انتخاب برای بازیابی";
    restore.setAttribute("aria-label", `انتخاب ${archive.filename} برای بازیابی`);
    restore.addEventListener("click", () => {
      if (validating || restoring) return;
      selectArchive(archive.filename);
      uploadPassphrase.focus();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "settings-secondary-button text-alizarin-crimson";
    remove.textContent = "حذف";
    remove.setAttribute("aria-label", `حذف ${archive.filename}`);
    remove.addEventListener("click", async () => {
      if (!window.confirm(`فایل پشتیبان «${archive.filename}» برای همیشه حذف شود؟`)) return;
      remove.disabled = true;
      try {
        await request(`/archives/${encodedFilename}`, { method: "DELETE" });
        if (selectedArchive === archive.filename && !validating) selectArchive();
        await refresh;
        await refreshList();
        notify("فایل پشتیبان حذف شد.", { type: "success" });
      } catch (error) {
        message(listStatus, error.message, "error");
      } finally {
        remove.disabled = false;
      }
    });
    actions.append(download, restore, remove);
    row.append(data, actions);
    return row;
  }

  async function load() {
    try {
      const data = await (await request()).json();
      const { items, folder } = data;
      if (controls.hidden) {
        reminderEnabled.checked = data.reminder_enabled;
        reminderHours.value = data.reminder_hours;
      }
      showBackupStatus(data);
      controls.hidden = false;
      message($("AccessStatus"), "");
      folderAvailable = folder.available;
      syncControls();
      message($("FolderReason"), folder.reason || "");
      $("List").replaceChildren(...items.map(addBackup));
      message(listStatus, items.length ? "" : "هنوز نسخه پشتیبانی ساخته نشده است.");
    } catch (error) {
      message(controls.hidden ? $("AccessStatus") : listStatus, error.message, "error");
    }
  }

  function refreshList() {
    if (restored || restoring) return;
    refresh ||= load().finally(() => { refresh = undefined; });
    return refresh;
  }

  reminderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = normalizeDigits(reminderHours.value.trim());
    const hours = Number(value);
    if (!/^\d+$/.test(value) || hours < 1 || hours > 8760) {
      message(reminderStatus, "فاصله یادآوری باید عددی بین ۱ و ۸۷۶۰ ساعت باشد.", "error");
      return;
    }
    savingReminder = true;
    syncControls();
    message(reminderStatus, "در حال ذخیره…");
    try {
      const response = await request("/reminder", { method: "PUT", payload: {
        reminder_enabled: reminderEnabled.checked, reminder_hours: hours,
      } });
      showBackupStatus(await response.json());
      reminderHours.value = hours;
      message(reminderStatus, "تنظیمات یادآوری ذخیره شد.", "success");
    } catch (error) {
      message(reminderStatus, error.message, "error");
    } finally {
      savingReminder = false;
      syncControls();
    }
  });

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("CreatePassphrase");
    const passphrase = input.value;
    input.value = "";
    creating = true;
    syncControls();
    message(createStatus, "در حال تهیه پشتیبان…");
    try {
      await request("", { method: "POST", payload: { passphrase, browser_preferences: readBackupPreferences() } });
      message(createStatus, "تهیه پشتیبان تکمیل شد.", "success");
      await refresh;
      await refreshList();
    } catch (error) {
      message(createStatus, `تهیه پشتیبان ناموفق بود. ${error.message}`, "error");
    } finally {
      creating = false;
      syncControls();
    }
  });

  folderButton.addEventListener("click", async () => {
    folderButton.disabled = true;
    try {
      await request("/open-folder", { method: "POST" });
    } catch (error) {
      message(listStatus, error.message, "error");
      if (error.status === 403) {
        folderAvailable = false;
        message($("FolderReason"), error.message);
      }
    } finally {
      syncControls();
    }
  });

  uploadFile.addEventListener("change", () => {
    selectArchive();
  });

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearValidation();
    const file = uploadFile.files[0];
    if (!file && !selectedArchive) return;
    if (file?.size > MAX_UPLOAD_BYTES) {
      message(uploadStatus, "حجم فایل از ۵۱۳ مگابایت بیشتر است.", "error");
      return;
    }
    const passphrase = uploadPassphrase.value;
    uploadPassphrase.value = "";
    validating = true;
    syncControls();
    message(uploadStatus, "در حال بررسی فایل…");
    try {
      const path = selectedArchive ? `/validate/${encodeURIComponent(selectedArchive)}` : "/validate";
      const response = await request(path, { method: "POST", file, payload: { passphrase } });
      const data = await response.json();
      validated = { id: data.validation_id, passphrase };
      showTime($("ValidatedDate"), data.created_at);
      $("ValidatedVersion").textContent = data.karbon_version;
      $("Validated").hidden = false;
      message(uploadStatus, "فایل برای بازیابی تأیید شد.", "success");
    } catch (error) {
      message(uploadStatus, error.message, "error");
    } finally {
      validating = false;
      syncControls();
    }
  });

  restoreButton.addEventListener("click", async () => {
    if (!validated || !window.confirm("تمام اطلاعات و تنظیمات فعلی کاربن با محتوای این پشتیبان جایگزین می‌شوند. بازیابی انجام شود؟")) return;
    restoring = true;
    syncControls();
    message(uploadStatus, "در حال تهیه پشتیبان ایمنی و بازیابی داده‌ها…");
    try {
      const response = await request("/restore", {
        method: "POST",
        payload: { validation_id: validated.id, passphrase: validated.passphrase, confirm: true,
          browser_preferences: readBackupPreferences() },
      });
      restored = true;
      clearValidation();
      uploadForm.reset();
      let preferencesSaved = true;
      try {
        const { browser_preferences } = await response.json();
        if (browser_preferences) applyBackupPreferences(browser_preferences);
      } catch {
        preferencesSaved = false;
      }
      returnToLoginAfterDatabaseReplacement(`/page/login-page.html?restore=${preferencesSaved ? "completed" : "preferences-unavailable"}`);
    } catch (error) {
      message(uploadStatus, error.message, "error");
      if (error.status === 409) clearValidation();
    } finally {
      restoring = false;
      syncControls();
    }
  });

  return refreshList;
}

import { getToken, logout } from "../auth/auth-storage.js";
import { connectionFetch } from "./connection.js";
import { downloadBlob } from "../reports/report-api.js";

const API = "http://127.0.0.1:8000/api/settings/backup";
const MAX_UPLOAD_BYTES = 513 * 1024 * 1024;
const dateFormat = new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" });
const sizeFormat = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });

class BackupRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path = "", { method = "GET", payload, file } = {}) {
  const token = getToken();
  if (!token) throw new BackupRequestError(401, "برای مدیریت پشتیبان‌ها دوباره وارد شوید.");
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (file) {
    const passphrase = new TextEncoder().encode(payload.passphrase);
    headers["Content-Type"] = "application/zip";
    headers["X-Karbon-Backup-Passphrase"] = btoa(String.fromCharCode(...passphrase));
    body = file;
  } else if (payload) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  const response = await connectionFetch(API + path, { method, headers, body, cache: "no-store" }, 600000);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const message = response.status === 401
      ? "نشست شما پایان یافته است. دوباره وارد شوید."
      : data?.detail;
    throw new BackupRequestError(response.status, message || "ارتباط با پشتیبان‌گیری کاربن برقرار نشد.");
  }
  return response;
}

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

function showTime(element, timestamp) {
  element.dateTime = timestamp;
  element.textContent = dateFormat.format(new Date(timestamp));
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
  const createFields = $("CreateFields");
  const uploadFields = $("UploadFields");
  const createStatus = $("CreateStatus");
  const listStatus = $("ListStatus");
  const uploadStatus = $("UploadStatus");
  const folderButton = $("OpenFolder");
  const restoreButton = $("Restore");
  const uploadFile = $("UploadFile");
  const uploadPassphrase = $("UploadPassphrase");
  let folderAvailable = false;
  let creating = false;
  let validating = false;
  let restoring = false;
  let restored = false;
  let validated;
  let refresh;

  function syncControls() {
    createFields.disabled = creating || restoring || restored;
    uploadFields.disabled = validating || restoring || restored;
    restoreButton.disabled = creating || restoring || restored;
    folderButton.disabled = !folderAvailable || restoring || restored;
  }

  function clearValidation() {
    validated = undefined;
    $("Validated").hidden = true;
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

    const download = document.createElement("button");
    download.type = "button";
    download.className = "settings-secondary-button";
    download.textContent = "دانلود";
    download.setAttribute("aria-label", `دانلود ${archive.filename}`);
    download.addEventListener("click", async () => {
      download.disabled = true;
      try {
        message(listStatus, "");
        const response = await request(`/download/${encodeURIComponent(archive.filename)}`);
        downloadBlob(await response.blob(), archive.filename);
      } catch (error) {
        message(listStatus, error.message, "error");
      } finally {
        download.disabled = false;
      }
    });
    row.append(data, download);
    return row;
  }

  async function load() {
    try {
      const { items, folder } = await (await request()).json();
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

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("CreatePassphrase");
    const passphrase = input.value;
    input.value = "";
    creating = true;
    syncControls();
    message(createStatus, "در حال تهیه پشتیبان…");
    try {
      await request("", { method: "POST", payload: { passphrase } });
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
    clearValidation();
    message(uploadStatus, "");
  });

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearValidation();
    const file = uploadFile.files[0];
    if (file.size > MAX_UPLOAD_BYTES) {
      message(uploadStatus, "حجم فایل از ۵۱۳ مگابایت بیشتر است.", "error");
      return;
    }
    const passphrase = uploadPassphrase.value;
    uploadPassphrase.value = "";
    validating = true;
    syncControls();
    message(uploadStatus, "در حال بارگذاری و بررسی فایل…");
    try {
      const response = await request("/validate", { method: "POST", file, payload: { passphrase } });
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
    if (!validated || !window.confirm("داده‌های فعلی کاربن با داده‌های این نسخه پشتیبان جایگزین شود؟")) return;
    restoring = true;
    syncControls();
    message(uploadStatus, "در حال تهیه پشتیبان ایمنی و بازیابی داده‌ها…");
    try {
      await request("/restore", {
        method: "POST",
        payload: { validation_id: validated.id, passphrase: validated.passphrase, confirm: true },
      });
      restored = true;
      clearValidation();
      uploadForm.reset();
      logout();
      message(uploadStatus, "بازیابی تکمیل شد. برای ادامه دوباره وارد کاربن شوید.", "success");
      $("Login").hidden = false;
      $("Login").focus();
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

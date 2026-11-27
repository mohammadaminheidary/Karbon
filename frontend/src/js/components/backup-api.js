import { getToken } from "../auth/auth-storage.js";
import { connectionFetch } from "./connection.js";

const API = "http://127.0.0.1:8000/api/settings/backup";

class BackupRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function backupRequest(path = "", { method = "GET", payload, file, timeout = 600000 } = {}) {
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
  const response = await connectionFetch(API + path, { method, headers, body, cache: "no-store" }, timeout);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const message = response.status === 401
      ? "نشست شما پایان یافته است. دوباره وارد شوید."
      : data?.detail;
    throw new BackupRequestError(response.status, message || "ارتباط با پشتیبان‌گیری کاربن برقرار نشد.");
  }
  return response;
}

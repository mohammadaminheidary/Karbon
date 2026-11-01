import { getToken, logout } from "../auth/auth-storage.js";
import { publishDataChange } from "../components/data-events.js";

const API = "http://127.0.0.1:8000/api/reports";
export async function request(
  path,
  body,
  signal,
  binary = false,
  method = body === undefined ? "GET" : "POST",
) {
  const token = getToken();
  if (!token) throw new Error("برای دریافت گزارش وارد حساب شوید.");
  const response = await fetch(API + path, {
    method,
    signal,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    logout();
    window.location.replace("/page/login-page.html");
    throw new Error("نشست شما پایان یافته است.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "دریافت گزارش انجام نشد؛ فیلترها را بررسی و دوباره تلاش کنید.",
    );
  }
  if (method === "DELETE" || path.includes("/export/")) publishDataChange();
  if (response.status === 204) return null;
  return binary ? response.blob() : response.json();
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

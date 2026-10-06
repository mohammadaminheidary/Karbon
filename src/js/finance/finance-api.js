import { publishDataChange } from "../components/data-events.js";
import { getToken, logout } from "../auth/auth-storage.js";

const API_URL = "http://127.0.0.1:8000/api";

export async function financeRequest(
  path,
  { method = "GET", body, signal } = {},
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 15000);
  try {
    const token = getToken();
    if (!token) {
      logout();
      window.location.replace("/page/login-page.html");
      throw new Error("نشست کاربری معتبر نیست.");
    }
    let response;
    let data;
    try {
      response = await fetch(`${API_URL}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      data = await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    }
    if (!response.ok) {
      if (response.status === 401) {
        logout();
        window.location.replace("/page/login-page.html");
      }
      const detail = data?.detail;
      throw new Error(
        typeof detail === "string"
          ? detail
          : Array.isArray(detail)
            ? detail
                .map((item) => item.msg.replace(/^Value error, /, ""))
                .join(" — ")
            : "خطایی در دریافت یا ذخیره اطلاعات رخ داد.",
      );
    }
    if (method !== "GET") publishDataChange();
    return data;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export const getBanks = () => financeRequest("/banks");
export const getBankCatalog = () => financeRequest("/banks/catalog");
export const getExpenseCategories = () =>
  financeRequest("/settings/expense-categories");
export const getFinanceDay = (date, signal) =>
  financeRequest(`/finance/day?${new URLSearchParams({ date })}`, { signal });
export const getFinanceCalendar = (start_date, end_date) =>
  financeRequest(
    `/finance/calendar?${new URLSearchParams({ start_date, end_date })}`,
  );
export const createTransaction = (body) =>
  financeRequest("/finance/transactions", { method: "POST", body });

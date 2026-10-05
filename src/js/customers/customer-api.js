import { getToken, logout } from "../auth/auth-storage.js";

const API_URL = "http://127.0.0.1:8000/api/customers";

export class CustomerApiError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request(path = "", { method = "GET", body, signal } = {}) {
  const token = getToken();
  if (!token) {
    logout();
    window.location.replace("/page/login-page.html");
    throw new CustomerApiError("نشست کاربری معتبر نیست.", 401);
  }
  let response;
  let data;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 15000);
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
    data = response.status === 204 ? null : await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error("Customers request failed", error);
    throw new CustomerApiError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
  if (!response.ok) {
    if (response.status === 401) {
      logout();
      window.location.replace("/page/login-page.html");
    }
    const message =
      response.status === 422
        ? "اطلاعات واردشده معتبر نیست. فیلدهای فرم را بررسی کنید."
        : response.status === 404
          ? "مشتری موردنظر پیدا نشد."
          : response.status === 409 &&
              data?.detail?.code === "DUPLICATE_CUSTOMER"
            ? data.detail.message
            : "خطایی در دریافت یا ذخیره اطلاعات مشتریان رخ داد. دوباره تلاش کنید.";
    if (response.status === 409 || response.status === 422) {
      console.warn("Customers API validation", response.status, data);
    } else {
      console.error("Customers API error", response.status, data);
    }
    throw new CustomerApiError(message, response.status, data?.detail);
  }
  return data;
}

export const getCustomers = ({
  search = "",
  skip = 0,
  limit = 12,
  signal,
} = {}) =>
  request(`?${new URLSearchParams({ search, skip, limit })}`, { signal });
export const getCustomer = (id) => request(`/${Number(id)}`);
export const getNextCustomerCode = () => request("/next-code");
export const createCustomer = (data) =>
  request("", { method: "POST", body: data });
export const updateCustomer = (id, data) =>
  request(`/${Number(id)}`, { method: "PUT", body: data });
export const deleteCustomer = (id) =>
  request(`/${Number(id)}`, { method: "DELETE" });

import { getToken } from "../auth/auth-storage.js";
import { publishDataChange } from "../components/data-events.js";

async function request(path = "", { method = "GET", body } = {}) {
  const token = getToken();
  if (!token) throw new Error("نشست کاربری معتبر نیست.");
  let response;
  try {
    response = await fetch(`http://127.0.0.1:8000/api/tasks${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
  }
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const validationMessage = Array.isArray(data?.detail)
      ? data.detail[0]?.msg?.replace(/^Value error, /, "")
      : null;
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : validationMessage ||
            (response.status === 401
              ? "نشست کاربری منقضی شده است. دوباره وارد شوید."
              : "ذخیره یا دریافت کارها انجام نشد. اطلاعات را بررسی و دوباره تلاش کنید."),
    );
  }
  if (method !== "GET") publishDataChange();
  return data;
}

export const getTasks = () => request();
export const createTask = (data) => request("", { method: "POST", body: data });
export const updateTaskStatus = (id, status) =>
  request(`/${id}/status`, { method: "PUT", body: { status } });
export const updateTask = (id, data) =>
  request(`/${id}`, { method: "PUT", body: data });
export const deleteTask = (id) => request(`/${id}`, { method: "DELETE" });

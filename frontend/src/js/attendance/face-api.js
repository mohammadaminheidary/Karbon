import { getToken, logout } from "../auth/auth-storage.js";
import { connectionFetch as fetch } from "../components/connection.js";
import { invalidateApiCache } from "../components/api-cache.js";
import { publishDataChange } from "../components/data-events.js";

const API_URL = "http://127.0.0.1:8000/api";

export class FaceApiError extends Error {
  constructor(message, status = 0, code = "NETWORK") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function faceRequest(
  path,
  { method = "GET", body, signal, timeout = 20000 } = {},
) {
  const token = getToken();
  if (!token) throw new FaceApiError("نشست کاربری معتبر نیست.", 401);
  let response, data;
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }, timeout);
    data =
      response.status === 204
        ? null
        : await response.json().catch((error) => {
            if (controller.signal.aborted) throw error;
            return null;
          });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut)
      throw new FaceApiError(
        "پاسخ سرور دریافت نشد. وضعیت ورود را بررسی کنید و دوباره تلاش کنید.",
        0,
        "TIMEOUT",
      );
    throw new FaceApiError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  if (response.status === 401) {
    logout();
    window.location.replace("/page/login-page.html");
    throw new FaceApiError("نشست کاربری منقضی شده است.", 401);
  }
  if (!response.ok) {
    const error = new FaceApiError(
      data?.detail?.message ||
        (typeof data?.detail === "string"
          ? data.detail
          : "عملیات انجام نشد. دوباره تلاش کنید."),
      response.status,
      data?.detail?.code,
    );
    error.retryAfter = Math.min(
      60,
      Math.max(0, Number(response.headers.get("Retry-After")) || 0),
    );
    error.sampleIndex = data?.detail?.sample_index;
    throw error;
  }
  if (method !== "GET" && !["/faces/validate", "/faces/guide"].includes(path)) {
    invalidateApiCache();
    publishDataChange();
  }
  return data;
}

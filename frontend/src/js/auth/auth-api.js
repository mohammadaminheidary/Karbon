import { apiFetch } from "../components/api-cache.js";
import { connectionFetch as fetch } from "../components/connection.js";
const API_URL = "http://127.0.0.1:8000/api";

export class SecurityApiError extends Error {
  constructor(message, status, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export async function securityRequest(token, kind, payload) {
  const response = await fetch(`${API_URL}/auth/${kind}`, {
    method: payload ? "PUT" : "GET",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = Array.isArray(data?.detail) ? data.detail[0] : data?.detail;
    const fallback =
      response.status === 429
        ? "تعداد تلاش‌ها بیش از حد مجاز است. یک دقیقه بعد دوباره تلاش کنید."
        : "ذخیره اطلاعات انجام نشد. لطفاً دوباره تلاش کنید.";
    const message = typeof detail === "string" ? detail : detail?.message;
    throw new SecurityApiError(
      message && !/[A-Za-z]/.test(message) ? message : fallback,
      response.status,
      detail?.field,
    );
  }
  return data;
}

export async function loginUser(username, password) {
  const response = await apiFetch(`${API_URL}/login`, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      username,
      password,
    }),
  });

  let data = null;

  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  if (response.status === 401) {
    return {
      success: false,

      message: data?.detail || "نام کاربری یا رمز عبور اشتباه است",
    };
  }

  if (response.status === 429) {
    return {
      success: false,

      message:
        data?.detail ||
        "تعداد تلاش‌های ورود بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.",
    };
  }

  if (!response.ok) {
    throw new Error(`Login request failed: ${response.status}`);
  }

  return data;
}

export async function validateToken(token) {
  const response = await apiFetch(`${API_URL}/auth/me`, {
    method: "GET",
    cache: "no-store",

    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Server error");
  }

  return await response.json();
}


export async function revokeSession(token) {
  const response = await fetch(`${API_URL}/auth/logout`, {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok && response.status !== 401)
    throw new Error("خروج امن انجام نشد. دوباره تلاش کنید.");
}

import { apiFetch } from "../components/api-cache.js";
const API_URL = "http://127.0.0.1:8000/api";

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

import { validateToken } from "../auth/auth-api.js";
import { getToken, logout } from "../auth/auth-storage.js";

let installed = false;
let pending;
let expiryTimer;
let validationFailed = false;
function state(value) {
  document.documentElement.dataset.authState = value;
}
function redirectToLogin() {
  state("pending");
  window.location.replace("/page/login-page.html");
}

export function protectPage() {
  if (!installed) {
    installed = true;
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) void protectPage();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void protectPage();
    });
    window.addEventListener("focus", () => { void protectPage(); });
  }
  if (pending) return pending;
  pending = validateSession().finally(() => { pending = undefined; });
  return pending;
}

async function validateSession() {
  const token = getToken();
  if (!token) {
    redirectToLogin();
    return false;
  }
  try {
    const auth = await validateToken(token);
    // Never apply the result of an earlier account or revoked local session.
    if (getToken() !== token) {
      redirectToLogin();
      return false;
    }
    if (!auth?.success) {
      logout();
      redirectToLogin();
      return false;
    }
    // Initializers stop on validation failure; resume them through a clean retry.
    if (validationFailed) {
      window.location.reload();
      return false;
    }
    clearTimeout(expiryTimer);
    try {
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const expires = JSON.parse(atob(payload)).exp * 1000;
      if (Number.isFinite(expires)) {
        expiryTimer = setTimeout(() => {
          if (getToken() !== token) { void protectPage(); return; }
          logout();
          redirectToLogin();
        }, Math.max(0, Math.min(expires - Date.now(), 2147483647)));
      }
    } catch { /* Server validation remains authoritative. */ }
    state("authenticated");
    return true;
  } catch (error) {
    if (getToken() !== token) { redirectToLogin(); return false; }
    console.error("Authentication validation failed:", error);
    validationFailed = true;
    state("error");
    window.dispatchEvent(new CustomEvent("karbon:startup-error", {
      detail: "ارتباط با سرور برقرار نشد. پس از برقراری ارتباط دوباره تلاش کنید.",
    }));
    return false;
  }
}

import { validateToken } from "../auth/auth-api.js";
import { getToken, logout } from "../auth/auth-storage.js";

function redirectToLogin() {
  window.location.replace("/page/login-page.html");
}

export async function protectPage() {
  const token = getToken();
  if (!token) {
    redirectToLogin();
    return false;
  }
  try {
    const auth = await validateToken(token);
    if (!auth?.success) {
      logout();
      redirectToLogin();
      return false;
    }
    return true;
  } catch (error) {
    console.error("Authentication validation failed:", error);
    // A server/network failure is not an expired session. Retain credentials
    // and the shell so retry does not require an unnecessary login.
    window.dispatchEvent(
      new CustomEvent("karbon:startup-error", {
        detail:
          "ارتباط با سرور برقرار نشد. پس از برقراری ارتباط دوباره تلاش کنید.",
      }),
    );
    return false;
  }
}

import { invalidateApiCache } from "../components/api-cache.js";

const AUTH_KEY = "karbon_auth";
const REMEMBERED_USERNAME_KEY = "karbon_remembered_username";

export function getRememberedUsername() {
  try {
    return localStorage.getItem(REMEMBERED_USERNAME_KEY);
  } catch {
    return null;
  }
}

export function setRememberedUsername(username) {
  try {
    if (username === null) localStorage.removeItem(REMEMBERED_USERNAME_KEY);
    else localStorage.setItem(REMEMBERED_USERNAME_KEY, username);
  } catch {
    // Browsers can block local preferences independently of form interaction.
  }
}

export function saveAuth(data) {
  if (
    !data ||
    typeof data.token !== "string" ||
    !data.token.trim()
  ) {
    throw new Error(
      "Invalid authentication data"
    );
  }


  invalidateApiCache({ auth: true });
  localStorage.setItem(
    AUTH_KEY,
    JSON.stringify({
      token: data.token,
    })
  );
}

export function getToken() {
  let auth;
  try { auth = localStorage.getItem(AUTH_KEY); } catch { return null; }


  if (!auth) {
    return null;
  }


  try {
    const parsedAuth = JSON.parse(auth);


    if (
      !parsedAuth ||
      typeof parsedAuth.token !== "string" ||
      !parsedAuth.token.trim()
    ) {
      localStorage.removeItem(AUTH_KEY);

      return null;
    }


    return parsedAuth.token;

  } catch (error) {
    localStorage.removeItem(AUTH_KEY);

    return null;
  }
}

export function logout() {
  invalidateApiCache({ auth: true });
  localStorage.removeItem("karbon_auth");
}

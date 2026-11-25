import { loginUser } from "./auth-api.js";
import { getRememberedUsername, saveAuth, setRememberedUsername } from "./auth-storage.js";
import { validateLogin } from "../utils/validator.js";
import { notify } from "../components/notifications.js";

export function initLogin() {
  const form = document.getElementById("loginForm");

  if (!form) {
    console.error("Login form not found");
    return;
  }

  const loginButton = form.querySelector("button[type='submit']");
  const usernameInput = document.getElementById("username");
  const rememberUsername = document.getElementById("rememberUsername");
  const buttonContent = loginButton.innerHTML;
  let submitting = false;

  function restoreUsernamePreference() {
    const remembered = getRememberedUsername();
    rememberUsername.checked = remembered !== null;
    if (remembered) usernameInput.value = remembered;
  }
  function saveUsernamePreference() {
    setRememberedUsername(rememberUsername.checked ? usernameInput.value.trim() : null);
  }
  restoreUsernamePreference();
  rememberUsername.addEventListener("change", saveUsernamePreference);
  usernameInput.addEventListener("input", () => {
    if (rememberUsername.checked) saveUsernamePreference();
  });

  function resetForm() {
    submitting = false;
    loginButton.disabled = false;
    loginButton.innerHTML = buttonContent;
    form.removeAttribute("aria-busy");
  }
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      resetForm();
      restoreUsernamePreference();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;

    const username = usernameInput.value.trim();
    saveUsernamePreference();

    const password = document.getElementById("passwordInput").value;

    // بررسی ورودی‌ها
    const validation = validateLogin(username, password);

    if (!validation.success) {
      notify(validation.message, { type: "warning" });
      return;
    }

    let navigating = false;

    try {
      // جلوگیری از چند بار کلیک
      submitting = true;
      loginButton.disabled = true;
      form.setAttribute("aria-busy", "true");

      loginButton.innerHTML = `
                <span>
                    در حال ورود...
                </span>
            `;

      // ارسال اطلاعات به Backend
      const response = await loginUser(username, password);

      if (response.success) {
        // ذخیره اطلاعات ورود
        saveAuth(response);

        // انتقال به صفحه اصلی
        window.location.href = "../index.html";
        navigating = true;
      } else {
        notify(response.message, { type: "error" });
      }
    } catch (error) {
      console.error("Login Error:", error);

      notify("خطا در اتصال به سرور", { type: "error" });
    } finally {
      // Keep the current surface stable until the dashboard document takes over.
      if (!navigating) resetForm();
    }
  });
}

// نمایش و مخفی کردن رمز عبور
export function initPasswordToggle() {
  const toggleEye = document.getElementById("toggleEye");

  const passwordInput = document.getElementById("passwordInput");

  const eyeSlash = document.getElementById("eyeSlash");

  if (!toggleEye || !passwordInput) {
    return;
  }

  toggleEye.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";

    passwordInput.type = isPassword ? "text" : "password";

    if (eyeSlash) {
      eyeSlash.style.display = isPassword ? "none" : "block";
    }

    toggleEye.setAttribute(
      "aria-label",

      isPassword ? "مخفی کردن رمز عبور" : "نمایش رمز عبور",
    );
  });
}

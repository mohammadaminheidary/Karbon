import { loginUser } from "./auth-api.js";
import { saveAuth } from "./auth-storage.js";
import { validateLogin } from "../utils/validator.js";

export function initLogin() {
  const form = document.getElementById("loginForm");

  if (!form) {
    console.error("Login form not found");
    return;
  }

  const loginButton = form.querySelector("button[type='submit']");
  const buttonContent = loginButton.innerHTML;
  let submitting = false;
  function resetForm() {
    submitting = false;
    loginButton.disabled = false;
    loginButton.innerHTML = buttonContent;
    form.removeAttribute("aria-busy");
  }
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resetForm();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;

    const username = document.getElementById("username").value.trim();

    const password = document.getElementById("passwordInput").value;

    // بررسی ورودی‌ها
    const validation = validateLogin(username, password);

    if (!validation.success) {
      alert(validation.message);
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
        alert(response.message);
      }
    } catch (error) {
      console.error("Login Error:", error);

      alert("خطا در اتصال به سرور");
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

import { loginUser } from "./auth-api.js";
import { saveAuth } from "./auth-storage.js";
import { showLoader } from "../components/loader.js";
import { validateLogin } from "../utils/validator.js";

// شروع Login
console.log("login.js loaded");
export function initLogin() {
  const form = document.getElementById("loginForm");

  if (!form) {
    console.error("Login form not found");
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = document.getElementById("username").value.trim();

    const password = document.getElementById("passwordInput").value;

    // بررسی ورودی‌ها
    const validation = validateLogin(username, password);

    if (!validation.success) {
      alert(validation.message);
      return;
    }

    const loginButton = form.querySelector("button[type='submit']");

    try {
      // جلوگیری از چند بار کلیک
      loginButton.disabled = true;

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

        // نمایش Loading
        await showLoader();

        // انتقال به صفحه اصلی
        window.location.href = "../index.html";
      } else {
        alert(response.message);
      }
    } catch (error) {
      console.error("Login Error:", error);

      alert("خطا در اتصال به سرور");
    } finally {
      loginButton.disabled = false;

      loginButton.innerHTML = `
                <span>
                    ورود به حساب
                </span>
            `;
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

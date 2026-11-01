import { securityRequest } from "./auth-api.js";
import { getToken, saveAuth, logout } from "./auth-storage.js";
import { notifyNavbar } from "../components/navbar-notification.js";

let initialized = false;
let loaded = false;
let loading = null;
let pending = false;
const byId = (id) => document.getElementById(id);
const forms = () => [byId("passwordForm")];

function message(element, text, type = "error") {
  element.textContent = text;
  element.dataset.type = type;
  element.hidden = !text;
  element.setAttribute("role", type === "error" ? "alert" : "status");
}

function unauthorized(error) {
  if (error.status !== 401) return false;
  logout();
  window.location.replace("/page/login-page.html");
  return true;
}

function setPending(value) {
  pending = value;
  for (const form of forms()) {
    form.querySelector("fieldset").disabled = value || !loaded;
    form.setAttribute("aria-busy", String(value));
  }
}

function clearSecrets() {
  for (const form of forms()) {
    form
      .querySelectorAll('input[autocomplete$="password"]')
      .forEach((input) => {
        input.value = "";
        input.type = "password";
      });
  }
  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.textContent = "نمایش";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute(
      "aria-label",
      `نمایش ${byId(button.dataset.passwordToggle).labels[0].textContent}`,
    );
  });
}

function invalid(field, text) {
  const error = new Error(text);
  error.field = field;
  throw error;
}

function payloadFor() {
  const current = byId("passwordCurrentPassword").value;
  if (!current) invalid("current_password", "رمز عبور فعلی را وارد کنید.");
  const password = byId("securityNewPassword").value;
  if (!password.trim())
    invalid("new_password", "رمز عبور جدید نمی‌تواند خالی یا فقط فاصله باشد.");
  if (new TextEncoder().encode(password).length > 72)
    invalid(
      "new_password",
      "رمز عبور باید حداکثر ۷۲ بایت باشد؛ حروف فارسی چند بایت هستند.",
    );
  if (password === current)
    invalid("new_password", "رمز عبور جدید باید با رمز فعلی متفاوت باشد.");
  const confirm = byId("securityConfirmPassword").value;
  if (password !== confirm)
    invalid("confirm_password", "تکرار رمز عبور با رمز جدید یکسان نیست.");
  return {
    current_password: current,
    new_password: password,
    confirm_password: confirm,
  };
}

async function submit(event) {
  event.preventDefault();
  if (pending || !loaded) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;
  const status = byId("passwordMessage");
  forms().forEach((f) => {
    f.querySelectorAll("[aria-invalid]").forEach((input) =>
      input.removeAttribute("aria-invalid"),
    );
    message(byId("passwordMessage"), "");
  });
  let payload;
  try {
    payload = payloadFor();
    setPending(true);
    button.textContent = "در حال ذخیره…";
    const data = await securityRequest(getToken(), "password", payload);
    // Replace the revoked token before another settings tool can make a request.
    saveAuth(data);
    clearSecrets();
    const text =
      "رمز عبور با موفقیت تغییر کرد. برای ورود بعدی از رمز جدید استفاده کنید.";
    message(status, text, "success");
    notifyNavbar("رمز عبور تغییر کرد.", { role: "status", duration: 5000 });
  } catch (error) {
    if (unauthorized(error)) return;
    const fields = {
      current_password: "passwordCurrentPassword",
      new_password: "securityNewPassword",
      confirm_password: "securityConfirmPassword",
    };
    const input = byId(fields[error.field]);
    if (input) input.setAttribute("aria-invalid", "true");
    message(
      status,
      error instanceof TypeError
        ? "ارتباط با سرور برقرار نشد. دوباره تلاش کنید."
        : error.message,
    );
    // Re-enable before focusing a field after a server-side error.
    setPending(false);
    (input || status).focus();
  } finally {
    setPending(false);
    button.textContent = label;
    form.removeAttribute("aria-busy");
  }
}

async function loadAccount() {
  const status = byId("securityLoadStatus");
  byId("securityRetry").hidden = true;
  message(status, "در حال دریافت اطلاعات حساب…", "loading");
  try {
    await securityRequest(getToken(), "me");
    loaded = true;
    message(status, "");
    setPending(false);
  } catch (error) {
    if (!unauthorized(error)) {
      message(status, "دریافت اطلاعات حساب انجام نشد. دوباره تلاش کنید.");
      byId("securityRetry").hidden = false;
    }
  }
}

export async function initializeSecuritySettings() {
  if (!initialized) {
    initialized = true;
    for (const form of forms()) {
      const statusId = "passwordMessage";
      form.querySelectorAll("input").forEach((input) => {
        input.setAttribute(
          "aria-describedby",
          [input.getAttribute("aria-describedby"), statusId]
            .filter(Boolean)
            .join(" "),
        );
      });
    }
    byId("passwordForm").addEventListener("submit", submit);
    byId("securityRetry").addEventListener("click", initializeSecuritySettings);
    document.querySelectorAll("[data-password-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = byId(button.dataset.passwordToggle);
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        button.textContent = visible ? "پنهان" : "نمایش";
        button.setAttribute("aria-pressed", String(visible));
        button.setAttribute(
          "aria-label",
          `${visible ? "پنهان کردن" : "نمایش"} ${input.labels[0].textContent}`,
        );
      });
    });
  }
  if (loaded) return;
  if (!loading)
    loading = loadAccount().finally(() => {
      loading = null;
    });
  await loading;
}

import { financeRequest } from "../finance/finance-api.js";
import { normalizeDigits } from "../finance/finance-utils.js";
import { logout } from "./auth-storage.js";

const path = "/settings/factory-reset";
const confirmation = "ریست داده‌های کاری";
const panels = new WeakSet();

function returnToLogin() {
  const key = "karbon-reset-generation";
  try {
    logout();
    const generation = crypto.randomUUID();
    localStorage.setItem(key, generation);
  } finally {
    window.location.replace("/page/login-page.html");
  }
}

export function initializeFactoryReset(panel) {
  if (panels.has(panel)) return;
  panels.add(panel);
  const $ = (name) => panel.querySelector(`#factoryReset${name}`);
  const form = $("Form");
  const fields = $("Fields");
  const request = $("Request");
  const status = $("Status");
  let challenge, busy = false, timer;

  function message(text, failed = false) {
    status.textContent = text;
    status.hidden = !text;
    status.dataset.type = failed ? "error" : "info";
    status.setAttribute("role", failed ? "alert" : "status");
  }

  function sync() {
    request.disabled = busy;
    fields.disabled = busy || !challenge;
    $("Submit").textContent = busy ? "در حال بازنشانی…" : "ریست داده‌های کاری";
  }

  function discardChallenge() {
    clearTimeout(timer);
    challenge = undefined;
    $("Captcha").value = "";
    $("Image").removeAttribute("src");
  }

  request.addEventListener("click", async () => {
    busy = true;
    sync();
    message("در حال دریافت کپچا…");
    try {
      const result = await financeRequest(`${path}/challenge`, { method: "POST" });
      discardChallenge();
      challenge = result.challenge_id;
      $("Image").src = result.image;
      fields.hidden = false;
      request.textContent = "دریافت کپچای تازه";
      timer = setTimeout(() => {
        discardChallenge();
        sync();
        if (!busy) message("اعتبار کپچا پایان یافته است. کپچای تازه بگیرید.", true);
      }, result.expires_in * 1000);
      message("");
    } catch (error) {
      message(error.message, true);
    } finally {
      busy = false;
      sync();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !challenge) return;
    const phrase = $("Confirmation").value;
    const captcha = normalizeDigits($("Captcha").value).trim().toUpperCase();
    if (phrase !== confirmation || !$("Acknowledge").checked || !/^[A-Z2-9]{6}$/.test(captcha)) {
      message("کپچا، عبارت تأیید و تأیید حذف دائمی را بررسی کنید.", true);
      return;
    }
    busy = true;
    sync();
    message("در حال بازنشانی پایگاه داده…");
    try {
      await financeRequest(path, { method: "POST", timeoutMs: 240000, body: {
        challenge_id: challenge, captcha, confirmation: phrase, acknowledge: true,
        current_password: $("Current").value,
      } });
      form.reset();
      returnToLogin();
    } catch (error) {
      message(error.message, true);
    } finally {
      discardChallenge();
      form.reset();
      busy = false;
      sync();
    }
  });
}

import { initializeNavbar } from "../components/navbar.js";
import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";
import { initializeBankAccounts } from "../finance/bank-accounts.js";
import { fullDate, todayKey } from "../finance/finance-utils.js";

initializeNavbar();

async function initialize() {
  if (!(await protectPage())) return;
  document.getElementById("logoutButton").addEventListener("click", () => {
    logout();
    window.location.replace("/page/login-page.html");
  });
  const timeFormat = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  function tick() {
    document.getElementById("banksToday").textContent = fullDate(todayKey());
    document.getElementById("banksClock").textContent = timeFormat.format(
      new Date(),
    );
  }
  tick();
  let clock = setInterval(tick, 1000);
  window.addEventListener("pagehide", () => clearInterval(clock));
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    clearInterval(clock);
    clock = setInterval(tick, 1000);
    tick();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
  await initializeBankAccounts();
}
initialize();

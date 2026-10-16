import { initializeNavbar } from "../components/navbar.js";
import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";
import { initializeBankAccounts } from "../finance/bank-accounts.js";

initializeNavbar();

async function initialize() {
  if (!(await protectPage())) return;
  document.getElementById("logoutButton").addEventListener("click", () => {
    logout();
    window.location.replace("/page/login-page.html");
  });
  await initializeBankAccounts();
}
initialize();

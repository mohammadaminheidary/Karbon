import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";
import { initializeNavbar } from "../components/navbar.js";
import { initializeCustomers } from "../customers/customers.js";

initializeNavbar();

async function initializeCustomersPage() {
  if (!(await protectPage())) return;
  document.getElementById("logoutButton").addEventListener("click", () => {
    logout();
    window.location.replace("/page/login-page.html");
  });
  await initializeCustomers();
}

initializeCustomersPage();

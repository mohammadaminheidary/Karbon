import { startPage } from "../components/page-ready.js";
import { protectPage } from "../guards/auth-guard.js";
import { initializeNavbar } from "../components/navbar.js";
import { createNavbarNotification } from "../components/navbar-notification.js";
import { initializeCustomers } from "../customers/customers.js";

initializeNavbar();

const createCustomerButton = document.getElementById("openCreateCustomerButton");
const titleIsland = document.querySelector(".navbar-title-island");
const notifyCustomerChange = createNavbarNotification(titleIsland);

async function initializeCustomersPage() {
  if (!(await protectPage())) return;
  await initializeCustomers({
    onCreated: () => notifyCustomerChange("مشتری اضافه شد"),
    onDeleted: () => notifyCustomerChange("مشتری حذف شد"),
  });
  createCustomerButton.disabled = false;
}

startPage(initializeCustomersPage);

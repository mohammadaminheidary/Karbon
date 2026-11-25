import { startPage } from "../components/page-ready.js";
import { protectPage } from "../guards/auth-guard.js";
import { initializeCustomers } from "../customers/customers.js";

const createCustomerButton = document.getElementById("openCreateCustomerButton");

async function initializeCustomersPage() {
  if (!(await protectPage())) return;
  await initializeCustomers();
  createCustomerButton.disabled = false;
}

startPage(initializeCustomersPage);

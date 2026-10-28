import { startPage } from "../components/page-ready.js";
import { initializeNavbar } from "../components/navbar.js";
import { protectPage } from "../guards/auth-guard.js";
import { initializeBankAccounts } from "../finance/bank-accounts.js";

initializeNavbar();

async function initialize() {
  if (!(await protectPage())) return;
  await initializeBankAccounts();
}
startPage(initialize);

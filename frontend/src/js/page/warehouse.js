import { startPage } from "../components/page-ready.js";
import { initializeNavbar } from "../components/navbar.js";
import { initializePurchaseEntry } from "../warehouse/purchase-entry.js";
import { protectPage } from "../guards/auth-guard.js";

startPage(async () => {
  if (!(await protectPage())) return false;
  initializeNavbar();
  initializePurchaseEntry();
});

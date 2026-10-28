import { startPage } from "../components/page-ready.js";
import { initializeNavbar } from "../components/navbar.js";
import { initializePurchaseEntry } from "../warehouse/purchase-entry.js";

startPage(() => {
  initializeNavbar();
  initializePurchaseEntry();
});

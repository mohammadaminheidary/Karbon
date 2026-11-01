import { startPage } from "../components/page-ready.js";
import { initializeNavbar } from "../components/navbar.js";
import { protectPage } from "../guards/auth-guard.js";
import { initializeReportDetails } from "../reports/report-details.js";

initializeNavbar();
startPage(async () => {
  if (!(await protectPage())) return false;
  await initializeReportDetails();
});

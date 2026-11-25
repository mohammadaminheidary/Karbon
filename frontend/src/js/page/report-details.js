import { startPage } from "../components/page-ready.js";
import { protectPage } from "../guards/auth-guard.js";
import { initializeReportDetails } from "../reports/report-details.js";

startPage(async () => {
  if (!(await protectPage())) return false;
  await initializeReportDetails();
});

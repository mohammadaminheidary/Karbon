import { startPage } from "../components/page-ready.js";
import { initializeNavbar } from "../components/navbar.js";
import { protectPage } from "../guards/auth-guard.js";

initializeNavbar();
startPage(protectPage);

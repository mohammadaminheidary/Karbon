import { startPage } from "../components/page-ready.js";
import { protectPage } from "../guards/auth-guard.js";

startPage(protectPage);

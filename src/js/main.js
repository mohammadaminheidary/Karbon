import { startPage } from "./components/page-ready.js";
import { initLogin } from "./auth/login.js";
import { initPasswordToggle } from "./auth/login.js";

startPage(() => {
  initLogin();

  initPasswordToggle();
});

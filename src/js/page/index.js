import { initializeNavbar } from "../components/navbar.js";

initializeNavbar();

import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";

protectPage();


const logoutButton = document.getElementById(
  "logoutButton"
);


if (logoutButton) {
  logoutButton.addEventListener(
    "click",
    () => {
      logout();

      window.location.replace(
        "/page/login-page.html"
      );
    }
  );
}

function setupLogout() {
  const logoutButton =
    document.getElementById("logoutButton");

  if (!logoutButton) {
    console.error(
      "Logout button not found"
    );

    return;
  }

  logoutButton.addEventListener(
    "click",
    () => {
      logout();

      window.location.replace(
        "/page/login-page.html"
      );
    }
  );
}


if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    setupLogout
  );
} else {
  setupLogout();
}
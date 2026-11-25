const dashboardPath = "/index.html";

function goBack() {
  // The Navigation API can distinguish earlier same-origin entries from forward entries.
  const canGoBack = window.navigation?.canGoBack ?? (
    window.history.length > 1 &&
    document.referrer.startsWith(`${window.location.origin}/`)
  );
  if (canGoBack) {
    window.history.back();
    return;
  }

  const { pathname } = window.location;
  if (pathname !== "/" && pathname !== dashboardPath) {
    window.location.replace(dashboardPath);
  }
}

export function mountFloatingBackButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "floating-back-button";
  button.setAttribute("aria-label", "بازگشت");
  button.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M19 12H5m7 7-7-7 7-7" />
    </svg>`;
  button.addEventListener("click", goBack);
  document.body.prepend(button);
}

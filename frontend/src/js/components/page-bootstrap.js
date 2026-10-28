// This small, dependency-free boundary runs before the page's module graph.
// The HTML owns the shell; a failed import must never leave an endless spinner.
(() => {
  let loaded = false;
  let leaving = false;
  let failure;
  let timeout;
  document.documentElement.dataset.pageState = "loading";
  const message = "بارگذاری صفحه انجام نشد. لطفاً دوباره تلاش کنید.";

  function showFailure(text, kind = "error") {
    if (leaving) return;
    failure = { text, kind };
    document.documentElement.dataset.pageState = "error";
    if (kind !== "timeout") clearTimeout(timeout);
    if (document.readyState === "loading") return;
    let notice = document.getElementById("pageStartupError");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "pageStartupError";
      notice.className =
        "mx-7 my-5 rounded-2xl border border-alizarin-crimson/20 bg-white p-5 text-sm text-mirage";
      notice.setAttribute("role", "alert");
      const description = document.createElement("p");
      const retry = document.createElement("button");
      retry.id = "retryPageStartup";
      retry.type = "button";
      retry.className =
        "mt-3 rounded-xl bg-persian-blue px-5 py-2 font-bold text-white";
      retry.textContent = "تلاش مجدد";
      retry.addEventListener("click", () => window.location.reload());
      notice.append(description, retry);
      const main = document.querySelector("main");
      if (!main) notice.classList.add("fixed", "top-0", "z-50");
      (main || document.body).prepend(notice);
    }
    notice.dataset.failureKind = kind;
    notice.querySelector("p").textContent = text;
    document.querySelectorAll("[data-initial-loading]").forEach((element) => {
      element.classList.add("hidden");
    });
    document
      .querySelectorAll('main [aria-busy="true"]')
      .forEach((element) => element.setAttribute("aria-busy", "false"));
  }

  window.addEventListener(
    "error",
    (event) => {
      const entryFailed =
        event.target instanceof HTMLScriptElement &&
        event.target.hasAttribute("data-page-entry");
      if (entryFailed || (!loaded && event.error)) showFailure(message);
    },
    true,
  );
  window.addEventListener("unhandledrejection", () => {
    if (!loaded) showFailure(message);
  });
  window.addEventListener("karbon:startup-error", (event) =>
    showFailure(event.detail || message),
  );
  document.addEventListener("DOMContentLoaded", () => {
    if (failure) showFailure(failure.text, failure.kind);
  });
  // Cancellation of an outgoing document's imports is normal navigation.
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target.closest("a[href]");
    if (!link || link.download || (link.target && link.target !== "_self"))
      return;
    const destination = new URL(link.href, window.location.href);
    if (
      destination.pathname !== window.location.pathname ||
      destination.search !== window.location.search
    )
      leaving = true;
  });
  window.addEventListener("pagehide", () => {
    leaving = true;
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });

  // Bound whole-document blocking while retaining the fast cached first paint.
  const paintBudget = setTimeout(() => {
    document
      .querySelectorAll("script[data-page-entry]")
      .forEach((script) => script.removeAttribute("blocking"));
  }, 150);
  timeout = setTimeout(() => showFailure(message, "timeout"), 20000);
  window.addEventListener("karbon:page-ready", () => {
    document.documentElement.dataset.pageState = "ready";
    clearTimeout(timeout);
    if (failure?.kind === "timeout") {
      document.getElementById("pageStartupError")?.remove();
      failure = undefined;
    }
  });
  window.addEventListener(
    "load",
    () => {
      loaded = true;
      clearTimeout(paintBudget);
    },
    { once: true },
  );
})();

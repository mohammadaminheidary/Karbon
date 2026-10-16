// Keep native history, downloads, modified clicks and page-specific module
// lifetimes. A click on the current route must not destroy its DOM and state.
export function initializeNavigation(navbar, { signal } = {}) {
  let pendingURL;
  let pendingTimer;
  const reset = () => {
    pendingURL = undefined;
    clearTimeout(pendingTimer);
  };
  window.addEventListener("pageshow", reset, { signal });
  window.addEventListener("pagehide", reset, { signal });
  navbar.addEventListener(
    "click",
    (event) => {
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
      if (
        !link ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self")
      )
        return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const current = new URL(window.location.href);
      const route = (value) =>
        `${value.pathname === "/" ? "/index.html" : value.pathname}${value.search}`;
      if (
        (route(url) === route(current) &&
          (!url.hash || url.hash === current.hash)) ||
        url.href === pendingURL
      ) {
        event.preventDefault();
        return;
      }
      if (url.pathname !== current.pathname || url.search !== current.search) {
        pendingURL = url.href;
        clearTimeout(pendingTimer);
        // Permit retry if the browser cancels or cannot complete navigation.
        pendingTimer = setTimeout(reset, 1500);
      }
    },
    { signal },
  );
  return reset;
}

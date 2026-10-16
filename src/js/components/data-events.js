const key = "karbon-data-change";
export function publishDataChange() {
  try {
    localStorage.setItem(key, crypto.randomUUID());
  } catch {
    /* Reload on visibility remains available. */
  }
}
export function publishLocalDataChange() {
  window.dispatchEvent(new Event(key));
}
export function onExternalDataChange(callback) {
  window.addEventListener(key, callback);
  window.addEventListener("storage", (event) => {
    if (event.key === key) callback();
  });
}

// A restored document already owns its DOM and data. Only refresh on a real
// change or after being away for a while, and merge pageshow/visibility events.
export function onPageRefresh(
  callback,
  { maxAge = 30000, isVisible = () => true } = {},
) {
  let lastRefresh = Date.now();
  let revision = readRevision();
  let dirty = false;
  let running = false;

  function readRevision() {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  async function refresh() {
    const nextRevision = readRevision();
    dirty ||= nextRevision !== revision;
    if (
      document.hidden ||
      !isVisible() ||
      running ||
      (!dirty && Date.now() - lastRefresh < maxAge)
    )
      return;
    dirty = false;
    revision = nextRevision;
    running = true;
    try {
      await callback();
    } finally {
      running = false;
      lastRefresh = Date.now();
      if (dirty) void refresh();
    }
  }

  onExternalDataChange(() => {
    dirty = true;
    void refresh();
  });
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pagehide", () => {
    // Page-specific cleanup may abort an unfinished request. Resume it on
    // restoration even if the last successful refresh would still be fresh.
    dirty ||= Boolean(document.querySelector('[aria-busy="true"]'));
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void refresh();
  });
}

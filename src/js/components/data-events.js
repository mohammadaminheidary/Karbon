const key = "karbon-data-change";
export function publishDataChange() {
  try {
    localStorage.setItem(key, crypto.randomUUID());
  } catch {
    /* Reload on visibility remains available. */
  }
}
export function onExternalDataChange(callback) {
  window.addEventListener("storage", (event) => {
    if (event.key === key) callback();
  });
}

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

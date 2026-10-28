// Page setup may await auth and data after the document's load event. Track
// that work explicitly so failures and tests cannot mistake HTML for readiness.
export async function startPage(initialize) {
  try {
    if (document.readyState === "loading") {
      await new Promise((resolve) =>
        document.addEventListener("DOMContentLoaded", resolve, { once: true }),
      );
    }
    const result = await initialize();
    const failure = document.getElementById("pageStartupError");
    if (
      result !== false &&
      (!failure || failure.dataset.failureKind === "timeout")
    ) {
      document.documentElement.dataset.pageState = "ready";
      window.dispatchEvent(new Event("karbon:page-ready"));
    }
  } catch (error) {
    console.error("Page initialization failed:", error);
    window.dispatchEvent(new CustomEvent("karbon:startup-error"));
  }
}

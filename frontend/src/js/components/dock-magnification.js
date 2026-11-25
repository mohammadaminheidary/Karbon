import { createFrameUpdate, hoverMotionQuery } from "./pointer-motion.js";

const zoomProperty = "--dock-item-zoom";

export function initializeDockMagnification(navbar, { signal }) {
  const strip = navbar.querySelector(".navbar-items");
  const items = [...strip.querySelectorAll(".navbar-item")];
  const motion = window.matchMedia(hoverMotionQuery);
  const frame = createFrameUpdate(update);
  let rows = [];
  let rowCapacity;
  let rowBudget;
  let itemSize;
  let gap;
  let pointer;
  let amount;
  let restoredZoom = false;

  function clearZoom() {
    frame.cancel();
    for (const item of items) item.style.removeProperty(zoomProperty);
  }

  function reset() {
    pointer = undefined;
    restoredZoom = false;
    clearZoom();
  }

  function update() {
    // Use the row under the pointer, including the gaps between buttons.
    const row = rows.findLast(({ element }) => element.getBoundingClientRect().top - gap / 2 <= pointer.clientY) ?? rows[0];
    const zooms = row.items.map((item) => {
      const { left, width } = item.getBoundingClientRect();
      const distance = Math.min(Math.abs(pointer.clientX - (left + width / 2)) / (itemSize * 2.75), 1);
      return (amount * (1 + Math.cos(distance * Math.PI))) / 2;
    });
    const restWidth = row.items.length * itemSize + (row.items.length - 1) * gap;
    const growth = zooms.reduce((sum, zoom) => sum + zoom * itemSize, 0);
    const limit = growth ? Math.min(1, Math.max(0, rowBudget - restWidth) / growth) : 1;

    for (const other of rows) {
      other.items.forEach((item, index) => {
        // Round down so the row still fits when it uses the entire budget.
        const zoom = other === row ? Math.floor(zooms[index] * limit * 1000) / 1000 : 0;
        if (zoom) item.style.setProperty(zoomProperty, zoom);
        else item.style.removeProperty(zoomProperty);
      });
    }
  }

  function layoutRows() {
    const style = getComputedStyle(navbar);
    itemSize = parseFloat(style.getPropertyValue("--dock-item-size"));
    if (!itemSize) {
      document.querySelector('link[rel="stylesheet"]')
        ?.addEventListener("load", layoutRows, { once: true, signal });
      return;
    }
    gap = parseFloat(style.getPropertyValue("--dock-item-gap"));
    const inset = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
      .reduce((sum, length) => sum + parseFloat(length), 0);
    rowBudget = parseFloat(style.maxWidth) - inset;
    const restWidth = parseFloat(style.minWidth) - inset;
    const capacity = restWidth > 0 ? Math.max(1, Math.floor((restWidth + gap) / (itemSize + gap))) : items.length;
    if (capacity === rowCapacity) return;

    // Keep the same items in each row throughout an expansion.
    const focused = document.activeElement;
    rowCapacity = capacity;
    rows = [];
    for (let start = 0; start < items.length; start += capacity) {
      const rowItems = items.slice(start, start + capacity);
      const element = document.createElement("div");
      element.className = "navbar-row";
      element.append(...rowItems);
      rows.push({ element, items: rowItems });
    }
    strip.replaceChildren(...rows.map(({ element }) => element));
    if (items.includes(focused)) focused.focus({ preventScroll: true });
  }

  function refresh() {
    if (pointer && amount && motion.matches) frame.schedule();
  }

  function syncPreferences() {
    const { dockAnimation, dockMagnification } =
      window.KarbonAppearance.getPreferences();
    amount = dockAnimation ? (dockMagnification - 100) / 100 : 0;
    navbar.toggleAttribute("data-dock-animation", Boolean(amount));
    if (amount) refresh();
    else clearZoom();
  }

  function move(event) {
    if (!motion.matches || event.pointerType === "touch") return;
    restoredZoom = false;
    pointer = event;
    refresh();
  }

  function captureZoom() {
    if ((!pointer && !restoredZoom) || !amount || !motion.matches) return;
    return items.map((item) => getComputedStyle(item).getPropertyValue(zoomProperty));
  }

  function restoreZoom(zooms) {
    if (!zooms || zooms.length !== items.length || !amount || !motion.matches) return;
    navbar.setAttribute("data-dock-handoff", "");
    items.forEach((item, index) => item.style.setProperty(zoomProperty, zooms[index]));
    navbar.getBoundingClientRect();
    navbar.removeAttribute("data-dock-handoff");
    restoredZoom = true;
  }

  const pointerOptions = { passive: true, signal };
  navbar.addEventListener("pointerenter", move, pointerOptions);
  navbar.addEventListener("pointermove", move, pointerOptions);
  navbar.addEventListener("pointerleave", reset, pointerOptions);
  navbar.addEventListener("pointercancel", reset, pointerOptions);
  document.addEventListener("pointermove", (event) => {
    if (restoredZoom && !navbar.contains(event.target)) reset();
  }, pointerOptions);
  motion.addEventListener(
    "change",
    () => {
      if (!motion.matches) reset();
    },
    { signal },
  );
  window.addEventListener("resize", () => {
    reset();
    layoutRows();
  }, { signal });
  window.addEventListener("blur", reset, { signal });
  window.addEventListener("pagehide", reset, { signal });
  window.addEventListener("karbon:appearance-change", syncPreferences, { signal });
  signal.addEventListener("abort", reset, { once: true });
  layoutRows();
  syncPreferences();
  return { captureZoom, restoreZoom };
}

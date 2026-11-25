import { createFrameUpdate } from "./pointer-motion.js";

export function initializeDialogCloseTooltip() {
  const tooltip = document.createElement("span");
  tooltip.className = "navbar-tooltip dialog-close-tooltip";
  tooltip.textContent = "خروج";
  tooltip.setAttribute("aria-hidden", "true");
  if (tooltip.showPopover) tooltip.setAttribute("popover", "manual");

  let button, x, y, width, height;
  function position() {
    const left = Math.max(4, Math.min(x + 12, window.innerWidth - width - 4));
    const top = y + 16 + height <= window.innerHeight - 4
      ? y + 16
      : Math.max(4, y - height - 8);
    tooltip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }
  const move = createFrameUpdate(position);

  function hide() {
    if (!button) return;
    button = null;
    move.cancel();
    tooltip.hidePopover?.();
    tooltip.remove();
  }

  // Delegate so popups built on demand share the same tooltip as static ones.
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType !== "mouse") return;
    const target = event.target.closest(".dialog-close-button");
    if (!target || target === button || target.disabled) return;
    hide();
    button = target;
    x = event.clientX;
    y = event.clientY;
    const host = button.closest("dialog[open]") || document.body;
    host.append(tooltip);
    tooltip.showPopover?.();
    width = tooltip.offsetWidth;
    height = tooltip.offsetHeight;
    position();
  }, { passive: true });
  document.addEventListener("pointermove", (event) => {
    if (!button || event.pointerType !== "mouse") return;
    if (button.disabled || !button.contains(event.target)) return hide();
    x = event.clientX;
    y = event.clientY;
    move.schedule();
  }, { passive: true });
  document.addEventListener("pointerout", (event) => {
    if (button?.contains(event.target) && !button.contains(event.relatedTarget)) hide();
  }, { passive: true });
  for (const event of ["pointercancel", "click", "close"])
    document.addEventListener(event, hide, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  }, true);
  window.addEventListener("blur", hide);
  window.addEventListener("pagehide", hide);
}

import { createFrameUpdate, hoverMotionQuery } from "./pointer-motion.js";

const cardSelector = ".card-tilt";
const clamp = (value) => Math.max(0, Math.min(1, value));

function within(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function initializeCardTilt() {
  const canTilt = window.matchMedia(hoverMotionQuery);
  const appearance = window.KarbonAppearance;
  const frame = createFrameUpdate(update);
  let active;
  let pointerX;
  let pointerY;

  function reset() {
    frame.cancel();
    if (!active) return;
    delete active.card.dataset.tilted;
    active = undefined;
  }

  function isEnabled(card) {
    const section = card.closest("[data-card-tilt-section]")?.dataset
      .cardTiltSection;
    return (
      appearance.cardTiltEnabled(section) &&
      !card.matches(":disabled") &&
      !card.closest('[data-editing="true"], .is-dragging')
    );
  }

  function update() {
    if (!active.card.isConnected || !isEnabled(active.card)) {
      reset();
      return;
    }
    const { card, surface, rect, maxAngle } = active;
    const x = clamp((pointerX - rect.left) / rect.width);
    const y = clamp((pointerY - rect.top) / rect.height);
    // Ease off at the edges so the moving surface keeps its pointer targets.
    const inset = Math.min(x, 1 - x) * rect.width;
    const blockInset = Math.min(y, 1 - y) * rect.height;
    const strength = clamp(Math.min(inset, blockInset) / 22);
    surface.style.setProperty(
      "--card-tilt-x",
      `${((2 * y - 1) * maxAngle * strength).toFixed(2)}deg`,
    );
    surface.style.setProperty(
      "--card-tilt-y",
      `${((1 - 2 * x) * maxAngle * strength).toFixed(2)}deg`,
    );
    surface.style.setProperty("--card-lift", `${(strength * 2).toFixed(1)}px`);
    surface.style.setProperty("--card-light-x", `${(x * 100).toFixed(1)}%`);
    surface.style.setProperty("--card-light-y", `${(y * 100).toFixed(1)}%`);
    card.toggleAttribute("data-tilted", true);
  }

  function move(event) {
    if (!canTilt.matches) return;
    if (event.pointerType === "touch" || event.buttons) {
      reset();
      return;
    }
    const { clientX, clientY } = event;
    const target = event.target.closest?.(cardSelector);
    // Keep the stationary bounds when a tilted edge moves out from under the pointer.
    const card = target || active?.card;
    if (card !== active?.card) {
      reset();
      if (!isEnabled(card)) return;
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height || !within(rect, clientX, clientY))
        return;
      const side = Math.max(rect.width, rect.height);
      const surface = card.querySelector(":scope > .card-tilt-surface") || card;
      surface.style.setProperty(
        "--card-perspective",
        `${Math.max(750, side * 1.65)}px`,
      );
      active = { card, surface, rect, maxAngle: Math.min(4, 1400 / side) };
    }
    if (!active) return;
    pointerX = clientX;
    pointerY = clientY;
    if (within(active.rect, pointerX, pointerY)) frame.schedule();
    else reset();
  }

  document.addEventListener("pointerover", move, { passive: true });
  document.addEventListener("pointermove", move, { passive: true });
  document.addEventListener(
    "pointerout",
    (event) => {
      if (
        active &&
        event.pointerType !== "touch" &&
        (!event.relatedTarget ||
          !within(active.rect, event.clientX, event.clientY))
      ) {
        reset();
      }
    },
    { passive: true },
  );
  document.addEventListener("pointercancel", reset, { passive: true });
  document.addEventListener("scroll", reset, { capture: true, passive: true });
  document.addEventListener("dragstart", reset, { capture: true });
  canTilt.addEventListener("change", reset);
  window.addEventListener("karbon:appearance-change", () => {
    if (active && !isEnabled(active.card)) reset();
  });
  window.addEventListener("resize", reset);
  window.addEventListener("blur", reset);
  window.addEventListener("pagehide", reset);
}

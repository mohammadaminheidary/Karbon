import { createFrameUpdate } from "./pointer-motion.js";

export function initializeNavbarActiveHighlight(navbar, { signal }) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const center = { "--dock-idle-x": "50%", "--dock-idle-y": "50%" };
  let idlePosition = center;
  let idleAnimation;
  let activeItem;
  let pointer;
  const frame = createFrameUpdate(update);

  function syncIdleMotion() {
    if (reducedMotion.matches || signal.aborted) {
      idleAnimation?.cancel();
      idleAnimation = undefined;
      idlePosition = center;
    } else if (document.hidden) {
      if (idleAnimation?.playState === "running") idleAnimation.pause();
    } else if (idleAnimation?.playState === "paused") {
      idleAnimation.play();
    } else if (!idleAnimation || idleAnimation.playState === "finished") {
      const next = {
        "--dock-idle-x": `${12 + Math.random() * 76}%`,
        "--dock-idle-y": `${12 + Math.random() * 76}%`,
      };
      const previous = idleAnimation;
      idleAnimation = navbar.animate([idlePosition, next], {
        duration: 1400 + Math.random() * 1400,
        easing: "ease-in-out",
        fill: "forwards",
      });
      idlePosition = next;
      previous?.cancel();
      idleAnimation.finished.then(syncIdleMotion, () => {});
    }
  }

  function reset() {
    frame.cancel();
    activeItem?.removeAttribute("data-dock-highlight");
    activeItem = undefined;
  }

  function update() {
    if (!activeItem.matches('[aria-current="page"]')) {
      reset();
      return;
    }

    // Use the visible frame, which can move and grow while the pointer holds still.
    const { left, top, width, height } = activeItem.getBoundingClientRect();
    const frameStyle = getComputedStyle(activeItem, "::before");
    const scale = parseFloat(frameStyle.scale) || 1;
    const lift = parseFloat(frameStyle.translate.split(" ")[1]) || 0;
    const x = position(pointer.clientX - left - width / 2, parseFloat(frameStyle.width) * scale);
    const y = position(pointer.clientY - top - height / 2 - lift, parseFloat(frameStyle.height) * scale);
    const { style } = activeItem;
    if (style.getPropertyValue("--dock-pointer-x") !== x) style.setProperty("--dock-pointer-x", x);
    if (style.getPropertyValue("--dock-pointer-y") !== y) style.setProperty("--dock-pointer-y", y);
    activeItem.toggleAttribute("data-dock-highlight", true);
    frame.schedule();
  }

  function move(event) {
    if (event.pointerType === "touch") return;
    const item = event.target.closest('.navbar-item[aria-current="page"]');
    if (item !== activeItem) reset();
    if (!item) return;
    activeItem = item;
    pointer = event;
    frame.schedule();
  }

  const pointerOptions = { passive: true, signal };
  navbar.addEventListener("pointerover", move, pointerOptions);
  navbar.addEventListener("pointermove", move, pointerOptions);
  navbar.addEventListener("pointerout", (event) => {
    if (activeItem && !activeItem.contains(event.relatedTarget)) reset();
  }, pointerOptions);
  navbar.addEventListener("pointercancel", reset, pointerOptions);
  window.addEventListener("blur", reset, { signal });
  window.addEventListener("pagehide", reset, { signal });
  signal.addEventListener("abort", reset, { once: true });
  reducedMotion.addEventListener("change", syncIdleMotion, { signal });
  document.addEventListener("visibilitychange", syncIdleMotion, { signal });
  signal.addEventListener("abort", syncIdleMotion, { once: true });
  syncIdleMotion();
}

function position(offset, size) {
  const percent = 50 + (100 * offset) / size;
  return `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`;
}

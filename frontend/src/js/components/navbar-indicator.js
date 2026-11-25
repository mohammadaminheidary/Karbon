const slide = {
  duration: 240,
  easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
};

export function initializeNavbarIndicator(navbar, { signal }) {
  const indicator = navbar.querySelector(".navbar-indicator");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let activeItem;
  let animation;

  function position() {
    if (!activeItem) return;
    const navbarRect = navbar.getBoundingClientRect();
    const itemRect = activeItem.getBoundingClientRect();
    const square = getComputedStyle(activeItem, "::before");
    const height = parseFloat(square.height);
    if (!height) return;
    const scale = parseFloat(square.scale) || 1;
    const lift = parseFloat(square.translate?.split(" ")[1]) || 0;
    const x = itemRect.left + itemRect.width / 2 - navbarRect.left - navbar.clientLeft;
    const y = itemRect.top + itemRect.height / 2 + lift +
      height * scale / 2 + 5 - navbarRect.top - navbar.clientTop;
    indicator.style.setProperty("--indicator-x", `${x}px`);
    indicator.style.setProperty("--indicator-y", `${y}px`);
    indicator.toggleAttribute("data-positioned", true);
  }

  function slideFrom(previous, elapsed = 0, progress = 0) {
    if (!previous || !activeItem || motion.matches || progress >= 1) return;
    const next = indicator.getBoundingClientRect();
    // Reconstruct the original offset to resume the same eased movement.
    const x = (previous.x - next.x) / (1 - progress);
    const y = (previous.y - next.y) / (1 - progress);
    if (Math.abs(x) < 0.25 && Math.abs(y) < 0.25) return;
    animation = indicator.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }],
      slide,
    );
    animation.currentTime = elapsed;
  }

  function moveTo(item) {
    if (item === activeItem) return;
    const previous = activeItem && indicator.getBoundingClientRect();
    animation?.cancel();
    activeItem = item;
    if (!item) {
      indicator.removeAttribute("data-positioned");
      return;
    }
    position();
    slideFrom(previous);
  }

  function captureIndicator() {
    if (!activeItem) return;
    const { x, y } = indicator.getBoundingClientRect();
    const elapsed = animation?.currentTime || 0;
    const progress = animation?.effect.getComputedTiming().progress || 0;
    return { x, y, href: activeItem.href, elapsed, progress };
  }

  function restoreIndicator(previous) {
    if (!previous) return;
    animation?.cancel();
    position();
    if (previous.href === activeItem?.href)
      slideFrom(previous, previous.elapsed, previous.progress);
    else slideFrom(previous);
  }

  // The links' slots can grow and shift as the existing hover effect runs.
  const layout = new ResizeObserver(position);
  for (const item of navbar.querySelectorAll(".navbar-item")) {
    layout.observe(item, { box: "border-box" });
  }
  layout.observe(navbar, { box: "border-box" });
  window.addEventListener("resize", position, { signal });
  motion.addEventListener("change", () => animation?.cancel(), { signal });
  signal.addEventListener("abort", () => {
    animation?.cancel();
    layout.disconnect();
  }, { once: true });
  return { moveTo, captureIndicator, restoreIndicator };
}

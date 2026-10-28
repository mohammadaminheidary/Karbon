// Animate the glass independently so the notification text stays crisp.
const notifications = new WeakMap();

export function notifyNavbar(message, options) {
  return createNavbarNotification(
    document.querySelector(".navbar-title-island"),
  )(message, options);
}

export function createNavbarNotification(island) {
  if (notifications.has(island)) return notifications.get(island);
  const glass = island.querySelector(".navbar-glass");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const notification = document.createElement("span");
  notification.className = "navbar-notification";
  notification.setAttribute("role", "status");
  notification.setAttribute("aria-atomic", "true");
  island.append(notification);
  let timer;
  let animations = [];
  let version = 0;
  let previousFocus;

  function cancelAnimations() {
    animations.forEach((animation) => animation.cancel());
    animations = [];
  }

  function reset() {
    version++;
    clearTimeout(timer);
    cancelAnimations();
    island.classList.remove("navbar-notifying");
    notification.textContent = "";
    if (previousFocus?.isConnected && document.activeElement === document.body)
      previousFocus.focus({ preventScroll: true });
    previousFocus = undefined;
  }

  async function restore(current) {
    if (current !== version) return;
    cancelAnimations();
    island.classList.remove("navbar-notifying");
    if (!reducedMotion.matches && glass.animate) {
      animations = [
        glass.animate(
          [
            { transform: "scale(1.08, 1.12)" },
            { transform: "scale(.995, .99)", offset: 0.72 },
            { transform: "scale(1)", offset: 1 },
          ],
          { duration: 420, easing: "cubic-bezier(.22,.8,.25,1)", fill: "both" },
        ),
        notification.animate(
          [
            { opacity: 1, transform: "translateY(0)" },
            { opacity: 0, transform: "translateY(-4px)" },
          ],
          { duration: 160, easing: "ease-out" },
        ),
      ];
      await Promise.allSettled(
        animations.map((animation) => animation.finished),
      );
    }
    if (current === version) reset();
  }

  window.addEventListener("pagehide", reset);
  const notify = (message, { duration = 4000, role = "status" } = {}) => {
    reset();
    if (!message) return;
    if (island.contains(document.activeElement))
      previousFocus = document.activeElement;
    const current = version;
    notification.textContent = message;
    notification.setAttribute("role", role);
    island.classList.add("navbar-notifying");
    if (!reducedMotion.matches && glass.animate) {
      animations = [
        glass.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.095, 1.15)", offset: 0.65 },
            { transform: "scale(1.08, 1.12)", offset: 1 },
          ],
          { duration: 480, easing: "cubic-bezier(.22,.8,.25,1)", fill: "both" },
        ),
        notification.animate(
          [
            { opacity: 0, transform: "translateY(6px) scale(.96)" },
            { opacity: 1, transform: "translateY(0) scale(1)" },
          ],
          {
            duration: 280,
            delay: 70,
            easing: "cubic-bezier(.2,.8,.25,1)",
            fill: "both",
          },
        ),
      ];
    }
    timer = window.setTimeout(() => restore(current), duration);
  };
  notifications.set(island, notify);
  return notify;
}

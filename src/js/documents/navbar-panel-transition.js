// Animate only the existing dock's material and opacity. Its grid and hit areas
// retain their layout; the native modal owns focus until everything is restored.
export function createNavbarPanelTransition(
  panel,
  {
    position,
    show = () => panel.showModal(),
    hide = () => {
      if (panel.open) panel.close();
    },
  },
) {
  const dock = document.querySelector(".navbar-dock");
  const navbar = document.getElementById("mainNavbar");
  const glass = navbar.querySelector(".navbar-glass");
  const items = navbar.querySelector(".navbar-items");
  const islands = [...dock.querySelectorAll(".navbar-info")];
  const content = panel.querySelector("form");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = "closed",
    version = 0,
    animations = [];
  const ease = "cubic-bezier(.22, 1, .36, 1)";

  function cancelAnimations() {
    animations.forEach((animation) => animation.cancel());
    animations = [];
  }
  function animate(element, frames, options) {
    const animation = element.animate(frames, {
      fill: "both",
      easing: ease,
      ...options,
    });
    animations.push(animation);
    return animation.finished.catch(() => {});
  }
  function geometry() {
    position();
    const nav = navbar.getBoundingClientRect();
    // Read the rendered panel rather than duplicating its responsive CSS width.
    const target = panel.getBoundingClientRect();
    const bounds = islands.map((island) => island.getBoundingClientRect());
    const left = Math.min(nav.left, ...bounds.map((rect) => rect.left));
    const right = Math.max(nav.right, ...bounds.map((rect) => rect.right));
    const top = Math.min(nav.top, ...bounds.map((rect) => rect.top));
    return {
      nav,
      target,
      bounds,
      union: { left, width: right - left, top, height: nav.bottom - top },
    };
  }
  function shellFrames({ nav, target, union }) {
    return [
      {
        left: "0px",
        top: "0px",
        width: `${nav.width}px`,
        height: `${nav.height}px`,
        offset: 0,
        easing: "cubic-bezier(.22, 0, .6, .85)",
      },
      {
        left: `${union.left - nav.left}px`,
        top: `${union.top - nav.top}px`,
        width: `${union.width}px`,
        height: `${union.height}px`,
        offset: 0.48,
        // Carry the absorption's exit velocity into the remaining expansion.
        easing: "linear",
      },
      {
        left: `${target.left - nav.left}px`,
        top: "0px",
        width: `${target.width}px`,
        height: `${nav.height}px`,
        offset: 1,
      },
    ];
  }
  function islandFrames(rect, nav) {
    return [
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      {
        transform: `translate(${nav.left + nav.width / 2 - rect.left - rect.width / 2}px, ${nav.top + nav.height / 2 - rect.top - rect.height / 2}px) scale(.35)`,
        opacity: 0,
      },
    ];
  }
  function clearState() {
    cancelAnimations();
    dock.classList.remove("document-dock-open", "document-dock-morphing");
    panel.removeAttribute("data-morph");
  }
  function settleOpen() {
    version++;
    // Hide the restored dock before cancelling its temporary material geometry.
    dock.classList.add("document-dock-open");
    cancelAnimations();
    dock.classList.remove("document-dock-morphing");
    panel.removeAttribute("data-morph");
    position();
    state = "open";
  }
  function settleClosed() {
    version++;
    clearState();
    hide();
    document.body.classList.remove("task-form-open");
    state = "closed";
  }
  async function open() {
    if (state !== "closed") return;
    const current = ++version;
    state = "opening";
    panel.dataset.morph = "preparing";
    dock.classList.add("document-dock-morphing");
    show();
    const sizes = geometry();
    if (motion.matches || !glass.animate) {
      settleOpen();
      return;
    }
    try {
      await Promise.all([
        animate(glass, shellFrames(sizes), { duration: 520, easing: "linear" }),
        animate(items, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 }),
        ...islands.map((island, index) =>
          animate(island, islandFrames(sizes.bounds[index], sizes.nav), {
            duration: 360,
          }),
        ),
      ]);
      if (current !== version) return;
      panel.dataset.morph = "revealing";
      // Percent-based clipping tracks content height as reference data arrives.
      await Promise.all([
        animate(
          panel,
          [
            {
              clipPath: `inset(calc(100% - ${sizes.nav.height}px) 0 0 round 30px)`,
              transform: "translateY(0)",
              opacity: 1,
            },
            {
              clipPath: "inset(0 0 0 round 30px)",
              transform: "translateY(0)",
              opacity: 1,
            },
          ],
          { duration: 400 },
        ),
        animate(
          content,
          [
            { opacity: 0, transform: "translateY(12px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 300 },
        ),
      ]);
      if (current === version) settleOpen();
    } catch {
      if (current === version) settleOpen();
    }
  }
  async function close() {
    if (state === "closed" || state === "closing") return;
    // A close during the first phase cancels immediately without replaying stale
    // keyframes or leaving an expanded dock behind.
    if (state === "opening" || motion.matches || !glass.animate) {
      settleClosed();
      return;
    }
    const current = ++version;
    state = "closing";
    const sizes = geometry();
    panel.dataset.morph = "closing";
    dock.classList.add("document-dock-morphing");
    // Establish the expanded material while the dock is still invisible.
    const frames = shellFrames(sizes);
    const shell = animate(
      glass,
      [...frames].reverse().map(({ offset, easing, ...frame }, index) => ({
        ...frame,
        offset: [0, 0.52, 1][index],
      })),
      { duration: 460, delay: 220 },
    );
    const icons = animate(items, [{ opacity: 0 }, { opacity: 1 }], {
      duration: 220,
      delay: 450,
    });
    const splits = islands.map((island, index) =>
      animate(island, islandFrames(sizes.bounds[index], sizes.nav).reverse(), {
        duration: 360,
        delay: 300,
      }),
    );
    dock.classList.remove("document-dock-open");
    try {
      await Promise.all([
        shell,
        icons,
        ...splits,
        animate(
          panel,
          [
            { clipPath: "inset(0 0 0 round 30px)", opacity: 1 },
            {
              clipPath: `inset(calc(100% - ${sizes.nav.height}px) 0 0 round 30px)`,
              opacity: 0,
            },
          ],
          { duration: 260 },
        ),
        animate(content, [{ opacity: 1 }, { opacity: 0 }], { duration: 140 }),
      ]);
    } finally {
      if (current === version) settleClosed();
    }
  }
  function resize() {
    if (state === "closed") return;
    // New viewport geometry wins over an in-flight animation. Modal focus and
    // scroll position are retained, and subsequent close uses fresh dock bounds.
    if (state === "closing") settleClosed();
    else settleOpen();
  }
  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
  motion.addEventListener("change", resize);
  window.addEventListener("pagehide", settleClosed);
  return {
    open,
    close,
    destroy() {
      window.removeEventListener?.("resize", resize);
      window.visualViewport?.removeEventListener?.("resize", resize);
      motion.removeEventListener?.("change", resize);
      window.removeEventListener?.("pagehide", settleClosed);
      settleClosed();
    },
    get active() {
      return state !== "closed";
    },
    get animating() {
      return state === "opening" || state === "closing";
    },
  };
}

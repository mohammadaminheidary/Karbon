// A bounded set of transform/opacity particles; no snapshots or cloned cards.
export async function disintegrateCustomerCard(card) {
  const wrapper = card?.parentElement;
  if (!wrapper?.isConnected) return;
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    !card.animate
  ) {
    wrapper.remove();
    return;
  }
  const { width, height } = card.getBoundingClientRect();
  if (!width || !height) {
    wrapper.remove();
    return;
  }
  const dust = document.createElement("span");
  dust.setAttribute("aria-hidden", "true");
  Object.assign(dust.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
  });
  wrapper.style.position = "relative";
  wrapper.inert = true;
  wrapper.append(dust);
  const animations = [];
  const palette = ["#b6c0c6", "#94a3b8", "var(--color-persian-blue)"];
  try {
    // Let the existing dialogs finish closing before the card dissolves.
    animations.push(
      card.animate(
        [
          { clipPath: "inset(0 0 0 0)", opacity: 1 },
          { clipPath: "inset(0 0 0 100%)", opacity: 0 },
        ],
        { duration: 650, delay: 200, easing: "ease-in-out", fill: "both" },
      ),
    );
    for (let column = 0; column < 10; column++) {
      for (let row = 0; row < 5; row++) {
        const particle = document.createElement("span");
        const size = 2 + Math.random() * 4;
        Object.assign(particle.style, {
          position: "absolute",
          borderRadius: "50%",
          opacity: "0",
          width: `${size}px`,
          height: `${size}px`,
          left: `${((column + Math.random()) / 10) * width}px`,
          top: `${((row + Math.random()) / 5) * height}px`,
          background: palette[(column + row) % palette.length],
        });
        dust.append(particle);
        animations.push(
          particle.animate(
            [
              { transform: "translate(0, 0) scale(1)", opacity: 0 },
              {
                transform: "translate(4px, -2px) scale(1)",
                opacity: 0.65,
                offset: 0.15,
              },
              {
                transform: `translate(${20 + Math.random() * 45}px, ${-30 + Math.random() * 60}px) scale(.2)`,
                opacity: 0,
              },
            ],
            {
              duration: 420,
              delay: 200 + column * 45,
              easing: "ease-out",
              fill: "both",
            },
          ),
        );
      }
    }
    await Promise.allSettled(animations.map((animation) => animation.finished));
    if (wrapper.isConnected) {
      const collapse = wrapper.animate(
        [{ height: `${height}px` }, { height: "0px" }],
        { duration: 180, easing: "cubic-bezier(.2,.8,.25,1)", fill: "both" },
      );
      animations.push(collapse);
      await Promise.allSettled([collapse.finished]);
    }
  } catch {
    // A visual effect must not turn a successful deletion into a retry.
  } finally {
    animations.forEach((animation) => animation.cancel());
    wrapper.remove();
  }
}

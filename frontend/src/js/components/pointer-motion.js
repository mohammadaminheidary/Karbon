export const hoverMotionQuery =
  "(any-hover: hover) and (any-pointer: fine) and (prefers-reduced-motion: no-preference)";

export function createFrameUpdate(update) {
  let frame;
  return {
    schedule() {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    },
    cancel() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    },
  };
}

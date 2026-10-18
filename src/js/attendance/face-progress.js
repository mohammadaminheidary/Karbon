// Capture milestones are measurable; server inference is indeterminate until
// its response arrives. Never suggest a successful match before that response.
export class FaceProgress {
  constructor(root) {
    this.root = root;
    this.fill = root.querySelector(".face-progress-fill");
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.onMotionChange = () => {
      if (this.motion.matches && this.job) {
        const { target, finish } = this.job;
        this.render(target);
        finish(true);
      }
    };
    this.motion.addEventListener("change", this.onMotionChange);
    this.reset();
  }

  render(value) {
    this.value = Math.max(0, Math.min(100, value));
    this.fill.style.strokeDashoffset = String(100 - this.value);
    this.root.setAttribute("aria-valuenow", String(Math.round(this.value)));
  }

  cancel() {
    this.job?.finish(false);
  }

  destroy() {
    this.cancel();
    this.motion.removeEventListener("change", this.onMotionChange);
  }

  reset() {
    this.cancel();
    this.root.dataset.phase = "idle";
    this.root.setAttribute("aria-valuetext", "آماده شروع دوربین");
    this.render(0);
  }

  processing(label) {
    this.cancel();
    this.root.dataset.phase = "processing";
    this.root.removeAttribute("aria-valuenow");
    this.root.setAttribute("aria-valuetext", label);
  }

  advance(target, { signal, duration = 280, phase = "capturing", label } = {}) {
    this.cancel();
    if (signal?.aborted) return Promise.resolve(false);
    this.root.dataset.phase = phase;
    this.root.setAttribute("aria-valuetext", label);
    if (this.motion.matches || duration <= 0) {
      this.render(target);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const from = this.value;
      const start = performance.now();
      let frame;
      const abort = () => finish(false);
      const finish = (completed) => {
        cancelAnimationFrame(frame);
        signal?.removeEventListener("abort", abort);
        if (this.job?.finish === finish) this.job = null;
        resolve(completed);
      };
      const tick = (now) => {
        const fraction = Math.min(1, Math.max(0, (now - start) / duration));
        this.render(from + (target - from) * (1 - (1 - fraction) ** 3));
        if (fraction === 1) finish(true);
        else frame = requestAnimationFrame(tick);
      };
      this.job = { finish, target };
      signal?.addEventListener("abort", abort, { once: true });
      frame = requestAnimationFrame(tick);
    });
  }
}

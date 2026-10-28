import { faceRequest } from "./face-api.js";
import { delay } from "./face-camera.js";

const STEPS = [
  {
    angle: "front",
    title: "روبه‌رو",
    instruction:
      "مستقیم به دوربین نگاه کنید و صورت را در مرکز بیضی ثابت نگه دارید.",
    arrow: "",
  },
  {
    angle: "left",
    title: "چپ خودتان",
    instruction:
      "سر را کمی به چپ خود بچرخانید؛ هر دو چشم و تمام صورت داخل بیضی بمانند.",
    arrow: "M40 50h22m-8-8 8 8-8 8",
  },
  {
    angle: "right",
    title: "راست خودتان",
    instruction:
      "سر را کمی به راست خود بچرخانید؛ هر دو چشم و تمام صورت داخل بیضی بمانند.",
    arrow: "M60 50H38m8-8-8 8 8 8",
  },
];
const digit = (value) => new Intl.NumberFormat("fa-IR").format(value);
const captureProgress = (count) => 10 + (60 * count) / STEPS.length;
const abortError = () => new DOMException("Cancelled", "AbortError");
const INTERVAL = 450;
const MAX_AGE = 1400;
const STEADY_TIME = 400;
const BOX_JITTER = 0.05;
const POSE_JITTER = 0.1;

// Stability is measured across independent, fresh server observations, never
// by a countdown alone. Small natural movements are fine; larger movement,
// a missing face, or an old response resets it.
export class FaceStability {
  reset() {
    this.previous = null;
    this.anchor = null;
    this.count = 0;
    this.since = 0;
  }
  constructor() {
    this.reset();
  }
  observe(feedback, capturedAt, now) {
    if (
      !feedback.ready ||
      feedback.box?.length !== 4 ||
      feedback.pose?.length !== 2 ||
      ![...feedback.box, ...feedback.pose].every(Number.isFinite) ||
      now - capturedAt > MAX_AGE
    ) {
      this.reset();
      return false;
    }
    // Reusing an observation cannot satisfy the independent-frame hold.
    if (this.previous && capturedAt <= this.lastAt) return false;
    const current = [...feedback.box, ...feedback.pose];
    const steady =
      this.previous &&
      current.every(
        (value, index) =>
          Number.isFinite(value) &&
          Math.abs(value - this.previous[index]) <=
            (index < 4 ? BOX_JITTER : POSE_JITTER) &&
          Math.abs(value - this.anchor[index]) <=
            (index < 4 ? BOX_JITTER : POSE_JITTER),
      );
    if (!steady || capturedAt - this.lastAt > MAX_AGE) {
      this.count = 0;
      this.since = capturedAt;
      this.anchor = current;
    }
    this.previous = current;
    this.lastAt = capturedAt;
    this.count++;
    return this.count >= 2 && capturedAt - this.since >= STEADY_TIME;
  }
}

// Fixed in the video viewport. Detection never changes these coordinates.
export const FACE_GUIDE = Object.freeze({ cx: 50, cy: 49, rx: 27, ry: 36 });

export const faceGuideMarkup = `<div id="faceGuide" class="face-guide" data-state="waiting" hidden aria-hidden="true">
  <svg viewBox="0 0 100 100" focusable="false">
    <defs><mask id="faceGuideMask"><rect width="100" height="100" fill="white"/><ellipse id="faceGuideCutout" cx="${FACE_GUIDE.cx}" cy="${FACE_GUIDE.cy}" rx="${FACE_GUIDE.rx}" ry="${FACE_GUIDE.ry}" fill="black"/></mask></defs>
    <rect width="100" height="100" fill="#0f172a" opacity=".28" mask="url(#faceGuideMask)"/>
    <ellipse id="faceGuideOval" class="face-guide-oval" cx="${FACE_GUIDE.cx}" cy="${FACE_GUIDE.cy}" rx="${FACE_GUIDE.rx}" ry="${FACE_GUIDE.ry}"/>
    <g id="faceGuideDetails"><path class="face-guide-eyes" d="M31 40h10m18 0h10M47 74h6"/><path id="faceDirectionArrow" class="face-guide-arrow"/></g>
    <path class="face-guide-center" d="M47 49h6m-3-3v6"/>
  </svg>
</div>`;

export const faceRegistrationMarkup = `<section id="faceRegistration" class="face-registration" hidden aria-label="مراحل ثبت خودکار چهره">
  <ol id="faceSteps" class="face-steps">${STEPS.map(
    (step, index) => `<li><div class="face-step" data-face-step="${index}">
    <span class="face-step-picture"><span class="face-step-number">${digit(index + 1)}</span><img alt="تصویر ${step.title}" hidden/><span class="face-step-check" aria-hidden="true">✓</span></span>
    <span>${step.title}</span><small class="face-step-state">در انتظار</small></div></li>`,
  ).join("")}</ol>
  <div class="face-instruction"><strong id="faceAngle" tabindex="-1" aria-describedby="faceStepInstruction"></strong><p id="faceStepInstruction"></p><small id="faceCaptureCount">۰ از ${digit(STEPS.length)} تصویر ثبت شده</small></div>
  <p id="facePositionStatus" class="face-position-status" role="status" aria-live="polite" aria-atomic="true"></p>
  <p class="face-auto-hint">صورت را داخل بیضی ثابت جا دهید؛ ثبت سه زاویه و ذخیره نهایی خودکار است.</p>
</section>`;

const QUALITY_ERRORS = new Set([
  "NO_FACE",
  "MULTIPLE_FACES",
  "POSITION",
  "TOO_CLOSE",
  "TOO_FAR",
  "OFF_CENTER",
  "INCOMPLETE",
  "QUALITY",
  "INCONSISTENT",
  "ANGLE",
]);
const TEMPORARY_ERRORS = new Set(["NETWORK", "TIMEOUT", "BUSY", "RATE_LIMIT"]);

export class FaceRegistration {
  constructor(root, { camera, progress, status }) {
    this.root = root;
    this.camera = camera;
    this.progress = progress;
    this.status = status;
    this.$ = (id) => root.querySelector(`#${id}`);
    this.stability = new FaceStability();
    this.events = new AbortController();
    document.addEventListener(
      "visibilitychange",
      () => {
        if (!this.active || this.phase !== "position") return;
        this.invalidate();
        this.feedback(
          "waiting",
          "صورت را در مرکز بیضی ثابت نگه دارید؛ در حال بررسی…",
        );
      },
      { signal: this.events.signal },
    );
  }

  run({ signal, onSave }) {
    this.stop();
    this.signal = signal;
    this.onSave = onSave;
    this.active = true;
    this.samples = Array(STEPS.length).fill(null);
    this.$("faceRegistration").hidden = false;
    this.root.classList.add("face-enrolling");
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.onAbort = () => this.stop();
      if (signal.aborted) {
        this.stop();
        return;
      }
      signal.addEventListener("abort", this.onAbort, { once: true });
      this.position(0);
      void this.poll().catch((error) => {
        if (this.signal === signal) this.fail(error);
      });
    });
  }

  invalidate() {
    this.version = (this.version || 0) + 1;
    this.request?.abort();
    this.request = null;
    this.stability.reset();
    this.updateGuide();
  }

  stop() {
    this.active = false;
    this.invalidate();
    this.signal?.removeEventListener("abort", this.onAbort);
    this.reject?.(abortError());
    this.reject = this.resolve = null;
    this.samples = [];
    this.$("faceRegistration").hidden = true;
    this.root.classList.remove("face-enrolling");
    this.$("faceCapturePreview").hidden = true;
    this.$("faceCapturePreview").removeAttribute("src");
    this.$("faceSteps")
      .querySelectorAll("img")
      .forEach((image) => {
        image.hidden = true;
        image.removeAttribute("src");
      });
  }

  destroy() {
    this.stop();
    this.events.abort();
  }

  fail(error) {
    if (!this.active || this.signal.aborted || error.name === "AbortError")
      return;
    const reject = this.reject;
    this.reject = null;
    this.stop();
    reject?.(error);
  }

  updateGuide() {
    // Stay visible even with no face or stale feedback so the target is clear.
    this.$("faceGuide").hidden = !this.active;
  }

  feedback(state, message) {
    this.$("faceGuide").dataset.state = state;
    this.$("facePositionStatus").dataset.state = state;
    if (this.$("facePositionStatus").textContent !== message)
      this.$("facePositionStatus").textContent = message;
  }

  render() {
    const count = this.samples.filter(Boolean).length;
    this.$("faceCaptureCount").textContent =
      `${digit(count)} از ${digit(STEPS.length)} تصویر ثبت شده · ذخیره نهایی خودکار`;
    this.$("faceSteps")
      .querySelectorAll("[data-face-step]")
      .forEach((item, index) => {
        const sample = this.samples[index];
        item.dataset.state = sample
          ? "captured"
          : index === this.index
            ? "current"
            : "pending";
        item.setAttribute(
          "aria-label",
          `${STEPS[index].title}، ${sample ? "ثبت شده" : "هنوز ثبت نشده"}`,
        );
        if (index === this.index && this.phase !== "saving")
          item.setAttribute("aria-current", "step");
        else item.removeAttribute("aria-current");
        item.querySelector(".face-step-state").textContent = sample
          ? "ثبت شد ✓"
          : index === this.index
            ? "مرحله فعلی"
            : "در انتظار";
        const image = item.querySelector("img");
        image.hidden = !sample;
        if (sample) image.src = sample.image;
        else image.removeAttribute("src");
      });
    this.$("faceRegistration").dataset.phase = this.phase;
    this.$("faceRegistration").dataset.step = String(this.index);
  }

  position(index) {
    this.invalidate();
    this.index = index;
    this.phase = "position";
    this.status("");
    this.$("faceAngle").textContent =
      `تصویر ${digit(index + 1)} از ${digit(STEPS.length)} · ${STEPS[index].title}`;
    this.$("faceStepInstruction").textContent = STEPS[index].instruction;
    this.$("faceDirectionArrow").setAttribute("d", STEPS[index].arrow);
    this.$("faceGuide").dataset.angle = STEPS[index].angle;
    this.feedback(
      "waiting",
      "صورت را در مرکز بیضی ثابت نگه دارید؛ تصویر مناسب خودکار ثبت می‌شود.",
    );
    this.progress.root.dataset.phase = "capturing";
    this.render();
    this.$("faceAngle").focus({ preventScroll: true });
  }

  async poll() {
    const signal = this.signal;
    while (this.active && this.signal === signal && !signal.aborted) {
      if (this.phase !== "position" || document.hidden) {
        await delay(250, signal);
        continue;
      }
      const version = this.version;
      const capturedAt = performance.now();
      const image = this.camera.snapshot();
      const request = new AbortController();
      this.request = request;
      let pause = INTERVAL;
      let candidate;
      try {
        const result = await faceRequest("/faces/guide", {
          method: "POST",
          body: {
            image,
            angle: STEPS[this.index].angle,
            reference: this.samples[0]?.pose || null,
            consent: true,
          },
          signal: request.signal,
          timeout: 5000,
        });
        if (!this.active || signal.aborted || version !== this.version)
          continue;
        const fresh = performance.now() - capturedAt <= MAX_AGE;
        this.updateGuide();
        const ready = this.stability.observe(
          result,
          capturedAt,
          performance.now(),
        );
        this.feedback(
          !fresh
            ? "waiting"
            : !result.ready
              ? "adjust"
              : ready
                ? "ready"
                : "steady",
          !fresh
            ? "در انتظار تصویر تازه از دوربین…"
            : !result.ready
              ? result.message
              : ready
                ? "تصویر مناسب است؛ در حال ثبت خودکار…"
                : "جای صورت درست است؛ یک لحظه بی‌حرکت بمانید…",
        );
        if (ready) candidate = { image, pose: result.pose, capturedAt };
      } catch (error) {
        if (!this.active || signal.aborted || version !== this.version)
          continue;
        this.stability.reset();
        this.updateGuide();
        if (!TEMPORARY_ERRORS.has(error.code)) throw error;
        this.feedback("waiting", error.message);
        pause = Math.max(1500, (error.retryAfter || 0) * 1000);
      } finally {
        if (this.request === request) this.request = null;
      }
      if (candidate) await this.capture(candidate);
      await delay(
        Math.max(0, pause - (performance.now() - capturedAt)),
        signal,
      );
    }
  }

  async capture(candidate) {
    if (
      this.phase !== "position" ||
      document.hidden ||
      performance.now() - candidate.capturedAt > MAX_AGE
    )
      return;
    this.invalidate();
    const version = this.version;
    this.phase = "validating";
    this.render();
    this.feedback(
      "waiting",
      "در حال بررسی خودکار وضوح، زاویه و یکسان بودن چهره…",
    );
    this.progress.processing("در حال بررسی تصویر ثبت‌شده");
    try {
      await faceRequest("/faces/validate", {
        method: "POST",
        body: {
          images: [
            ...this.samples.slice(0, this.index).map((sample) => sample.image),
            candidate.image,
          ],
          consent: true,
        },
        signal: this.signal,
      });
    } catch (error) {
      if (!this.active || this.signal.aborted || version !== this.version)
        return;
      if (QUALITY_ERRORS.has(error.code)) await this.recover(error, this.index);
      else if (TEMPORARY_ERRORS.has(error.code)) {
        this.feedback("waiting", error.message);
        await delay(
          Math.max(1500, (error.retryAfter || 0) * 1000),
          this.signal,
        );
        if (this.active && !this.signal.aborted) this.position(this.index);
      } else throw error;
      return;
    }
    if (!this.active || this.signal.aborted || version !== this.version) return;
    this.samples[this.index] = candidate;
    this.phase = "transition";
    this.render();
    this.feedback("ready", `تصویر ${digit(this.index + 1)} ثبت شد ✓`);
    await this.progress.advance(
      captureProgress(this.samples.filter(Boolean).length),
      {
        signal: this.signal,
        label: `تصویر ${digit(this.index + 1)} از ${digit(STEPS.length)} خودکار ثبت شد`,
      },
    );
    if (!this.active || this.signal.aborted) return;
    const next = this.samples.findIndex((sample) => !sample);
    if (next !== -1) this.position(next);
    else await this.save();
  }

  async recover(error, fallback) {
    const index =
      Number.isInteger(error.sampleIndex) &&
      error.sampleIndex >= 0 &&
      error.sampleIndex < STEPS.length
        ? error.sampleIndex
        : fallback;
    // If the entire identity set is suspect, start fresh rather than mix people.
    if (error.code === "INCONSISTENT" && !Number.isInteger(error.sampleIndex))
      this.samples.fill(null);
    else this.samples[index] = null;
    await this.progress.advance(
      captureProgress(this.samples.filter(Boolean).length),
      {
        signal: this.signal,
        label: "در انتظار تصویر جایگزین مناسب",
      },
    );
    if (!this.active || this.signal.aborted) return;
    this.position(this.samples.findIndex((sample) => !sample));
    this.feedback("adjust", error.message);
  }

  async save() {
    if (this.samples.filter(Boolean).length !== STEPS.length) return;
    this.invalidate();
    this.phase = "saving";
    this.render();
    this.$("faceAngle").textContent =
      `${digit(STEPS.length)} از ${digit(STEPS.length)} تصویر ثبت شد`;
    this.$("faceStepInstruction").textContent =
      "ثبت تصاویر کامل شد؛ در حال ذخیره نهایی خودکار…";
    this.progress.processing("در حال ذخیره سه تصویر و الگوی چهره");
    while (this.active && !this.signal.aborted) {
      try {
        const result = await this.onSave(
          this.samples.map((sample) => sample.image),
        );
        if (!this.active || this.signal.aborted) return;
        const resolve = this.resolve;
        this.reject = this.resolve = null;
        this.stop();
        resolve(result);
        return;
      } catch (error) {
        if (!this.active || this.signal.aborted) return;
        if (QUALITY_ERRORS.has(error.code)) {
          await this.recover(error, 0);
          return;
        }
        if (!TEMPORARY_ERRORS.has(error.code)) throw error;
        this.feedback(
          "waiting",
          "ذخیره موقتاً انجام نشد؛ تلاش خودکار ادامه دارد…",
        );
        await delay(
          Math.max(2500, (error.retryAfter || 0) * 1000),
          this.signal,
        );
      }
    }
  }
}

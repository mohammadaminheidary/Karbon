const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(reduced = false) {
  let time = 0,
    next = 0;
  const frames = new Map(),
    attributes = new Map();
  const fill = { style: {} };
  const root = {
    dataset: {},
    querySelector: () => fill,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  const motion = {
    matches: reduced,
    addEventListener: (_, callback) => {
      motion.change = callback;
    },
  };
  const context = vm.createContext({
    window: { matchMedia: () => motion },
    performance: { now: () => time },
    requestAnimationFrame: (callback) => {
      const id = ++next;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  vm.runInContext(
    fs
      .readFileSync(
        path.join(__dirname, "../src/js/attendance/face-progress.js"),
        "utf8",
      )
      .replace("export class FaceProgress", "class FaceProgress") +
      "\nthis.FaceProgress = FaceProgress;",
    context,
  );
  const progress = new context.FaceProgress(root);
  const step = (ms) => {
    time += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
  };
  return { progress, root, fill, attributes, frames, motion, step };
}

test("ring interpolates confirmed milestones and never invents inference progress", async () => {
  const f = fixture();
  const advancing = f.progress.advance(70, {
    duration: 300,
    label: "samples captured",
  });
  f.step(100);
  assert.ok(f.progress.value > 0 && f.progress.value < 70);
  const intermediate = f.progress.value;
  f.step(100);
  assert.ok(f.progress.value > intermediate && f.progress.value < 70);
  f.step(100);
  assert.equal(await advancing, true);
  assert.equal(f.progress.value, 70);
  assert.equal(f.fill.style.strokeDashoffset, "30");
  f.progress.processing("recognizing");
  assert.equal(f.root.dataset.phase, "processing");
  assert.equal(f.attributes.has("aria-valuenow"), false);
  f.step(100000);
  assert.equal(
    f.progress.value,
    70,
    "waiting for a response must not fill to 100%",
  );
  const complete = f.progress.advance(100, {
    phase: "complete",
    label: "confirmed",
  });
  f.step(280);
  assert.equal(await complete, true);
  assert.equal(f.attributes.get("aria-valuenow"), "100");
  assert.equal(f.root.dataset.phase, "complete");
});

test("cancel, retry, and reset discard pending frames without false completion", async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancelled = f.progress.advance(70, {
    signal: controller.signal,
    label: "capture",
  });
  f.step(50);
  controller.abort();
  assert.equal(await cancelled, false);
  assert.equal(f.frames.size, 0);
  f.progress.reset();
  assert.equal(f.progress.value, 0);
  assert.equal(f.root.dataset.phase, "idle");
  const stale = f.progress.advance(70, { label: "old scan" });
  const retry = f.progress.advance(10, { label: "new scan" });
  assert.equal(await stale, false);
  f.step(280);
  assert.equal(await retry, true);
  assert.equal(f.progress.value, 10);
  assert.equal(
    await f.progress.advance(100, { signal: controller.signal }),
    false,
  );
  assert.equal(f.progress.value, 10);
});

test("reduced motion settles milestones immediately, including a live preference change", async () => {
  const f = fixture(true);
  assert.equal(await f.progress.advance(30, { label: "first sample" }), true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.progress.value, 30);
  f.motion.matches = false;
  const pending = f.progress.advance(50, { label: "second sample" });
  f.step(40);
  f.motion.matches = true;
  f.motion.change();
  assert.equal(await pending, true);
  assert.equal(f.progress.value, 50);
  assert.equal(f.frames.size, 0);
});

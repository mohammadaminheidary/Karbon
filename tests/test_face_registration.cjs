const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs
  .readFileSync("src/js/attendance/face-registration.js", "utf8")
  .replace(/^import .*;\n/gm, "")
  .replaceAll("export ", "");
const context = vm.createContext({ DOMException, Intl, Number });
vm.runInContext(source + "\nthis.FaceStability = FaceStability;", context);
const ready = (changes = {}) => ({
  ready: true,
  box: [0.29, 0.2, 0.42, 0.58],
  pose: [0, 0.6],
  ...changes,
});

test("capture requires two fresh steady observations spanning at least 400 ms", () => {
  const stability = new context.FaceStability();
  assert.equal(stability.observe(ready(), 0, 50), false);
  assert.equal(stability.observe(ready(), 450, 500), true);
  stability.reset();
  assert.equal(stability.observe(ready(), 1000, 1050), false);
  assert.equal(stability.observe(ready(), 1000, 1060), false);
  assert.equal(stability.observe(ready(), 1200, 1250), false);
  assert.equal(stability.observe(ready(), 1400, 1450), true);
});

test("a wrong pose, blur, distance or missing face resets capture readiness", () => {
  for (const code of [
    "TOO_CLOSE",
    "TOO_FAR",
    "OFF_CENTER",
    "ANGLE",
    "QUALITY",
    "NO_FACE",
    "MULTIPLE_FACES",
  ]) {
    const stability = new context.FaceStability();
    stability.observe(ready(), 0, 50);
    stability.observe(ready(), 450, 500);
    assert.equal(stability.observe({ ready: false, code }, 900, 950), false);
    assert.equal(stability.observe(ready(), 1350, 1400), false);
    assert.equal(stability.observe(ready(), 1800, 1850), true);
  }
});

test("motion and stale responses cannot unlock capture", () => {
  const stability = new context.FaceStability();
  for (let index = 0; index < 10; index++) {
    assert.equal(
      stability.observe(
        ready({ box: [0.29 + (index % 2) * 0.1, 0.2, 0.42, 0.58] }),
        index * 450,
        index * 450 + 50,
      ),
      false,
    );
  }
  stability.reset();
  stability.observe(ready(), 0, 50);
  stability.observe(ready(), 450, 500);
  assert.equal(stability.observe(ready(), 900, 3000), false);
  assert.equal(stability.observe(ready(), 3450, 3500), false);
});

test("head movement and interrupted polling require a new stable sequence", () => {
  const stability = new context.FaceStability();
  stability.observe(ready(), 0, 50);
  stability.observe(ready(), 450, 500);
  assert.equal(
    stability.observe(ready({ pose: [0.18, 0.6] }), 900, 950),
    false,
  );
  assert.equal(
    stability.observe(ready({ pose: [0.18, 0.6] }), 1350, 1400),
    true,
  );
  assert.equal(
    stability.observe(ready({ pose: [0.18, 0.6] }), 4000, 4050),
    false,
  );
});

test("slow drift across the stable window does not count as holding still", () => {
  const stability = new context.FaceStability();
  for (let index = 0; index < 5; index++)
    assert.equal(
      stability.observe(
        ready({ box: [0.29 + index * 0.04, 0.2, 0.42, 0.58] }),
        index * 150,
        index * 150 + 50,
      ),
      false,
    );
});

test("natural box jitter and small head movements allow automatic capture", () => {
  const stability = new context.FaceStability();
  assert.equal(stability.observe(ready({ pose: [0.04, 0.54] }), 0, 50), false);
  assert.equal(
    stability.observe(
      ready({ box: [0.33, 0.23, 0.4, 0.56], pose: [0.12, 0.47] }),
      450,
      500,
    ),
    true,
  );
});

function automaticFixture({ response, save } = {}) {
  let time = 0,
    snapshots = 0;
  const calls = [],
    saves = [],
    feedback = [],
    milestones = [];
  let wizard;
  const controller = new AbortController();
  const ctx = vm.createContext({
    DOMException,
    Intl,
    Number,
    AbortController,
    document: { hidden: false },
    performance: { now: () => time },
    faceRequest: async (path, options) => {
      calls.push({ path, body: options.body });
      if (calls.length > 100) throw new Error("Unexpected retry loop");
      const custom = await response?.({
        path,
        body: options.body,
        wizard,
        calls,
        tick: (ms) => {
          time += ms;
        },
      });
      if (custom) return custom;
      if (path.endsWith("/guide")) return ready();
      return { valid: true };
    },
    delay: async (ms) => {
      if (controller.signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      time += ms;
    },
  });
  vm.runInContext(
    source +
      "\nthis.FaceRegistration = FaceRegistration; this.FaceStability = FaceStability; this.guide = FACE_GUIDE; this.markup = faceGuideMarkup;",
    ctx,
  );
  wizard = Object.create(ctx.FaceRegistration.prototype);
  const elements = new Map();
  Object.assign(wizard, {
    active: true,
    phase: "position",
    index: 0,
    version: 0,
    samples: Array(3).fill(null),
    signal: controller.signal,
    stability: new ctx.FaceStability(),
    camera: { snapshot: () => `frame-${++snapshots}` },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
    invalidate() {
      this.version++;
      this.stability.reset();
    },
    render() {},
    updateGuide() {},
    feedback: (state, message) => feedback.push({ state, message }),
    status() {},
    position(index) {
      this.invalidate();
      this.phase = "position";
      this.index = index;
    },
    progress: {
      processing() {},
      advance: async (value) => {
        milestones.push(value);
        return true;
      },
      root: { dataset: {} },
    },
    onSave: async (images) => {
      saves.push([...images]);
      return save ? save({ images, wizard, saves }) : { registered: true };
    },
    stop() {
      this.active = false;
    },
    resolve: () => {
      wizard.resolved = (wizard.resolved || 0) + 1;
    },
  });
  return { wizard, calls, saves, feedback, milestones, ctx, controller };
}

test("all three angles capture, advance and save automatically without confirmation", async () => {
  const f = automaticFixture();
  await f.wizard.poll();
  assert.deepEqual(
    f.calls
      .filter((c) => c.path.endsWith("/validate"))
      .map((c) => c.body.images.length),
    [1, 2, 3],
  );
  assert.equal(f.calls.filter((c) => c.path.endsWith("/guide")).length, 6);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].length, 3);
  assert.equal(new Set(f.saves[0]).size, 3);
  assert.equal(f.wizard.resolved, 1);
  assert.deepEqual(f.milestones, [30, 50, 70]);
  assert.deepEqual(
    f.calls.filter((c) => c.path.endsWith("/guide")).map((c) => c.body.angle),
    ["front", "front", "left", "left", "right", "right"],
  );
  assert.equal(f.wizard.$("faceAngle").textContent, "۳ از ۳ تصویر ثبت شد");
});

test("failed quality, lighting and angle checks keep waiting without accepting a frame", async () => {
  const codes = [
    "QUALITY",
    "INCOMPLETE",
    "TOO_CLOSE",
    "TOO_FAR",
    "OFF_CENTER",
    "ANGLE",
    "NO_FACE",
  ];
  const f = automaticFixture({
    response: ({ path, calls }) => {
      if (!path.endsWith("/guide")) return;
      const index = calls.filter((c) => c.path.endsWith("/guide")).length - 1;
      if (index < codes.length)
        return {
          ready: false,
          code: codes[index],
          box: [0.1, 0.1, 0.8, 0.8],
          message: "adjust",
        };
    },
  });
  await f.wizard.poll();
  assert.ok(
    f.saves[0].every((image) => Number(image.split("-")[1]) > codes.length),
  );
  assert.equal(f.saves.length, 1);
});

test("a rejected candidate is replaced automatically and does not advance the angle", async () => {
  let rejected;
  const f = automaticFixture({
    response: ({ path, body, wizard }) => {
      if (path.endsWith("/validate") && !rejected) {
        rejected = body.images[0];
        assert.equal(wizard.index, 0);
        throw Object.assign(new Error("blur"), {
          code: "QUALITY",
          sampleIndex: 0,
        });
      }
    },
  });
  await f.wizard.poll();
  assert.notEqual(f.saves[0][0], rejected);
  assert.deepEqual(
    f.calls
      .filter((c) => c.path.endsWith("/validate"))
      .map((c) => c.body.images.length),
    [1, 1, 2, 3],
  );
});

test("a final quality rejection automatically replaces only its affected angle", async () => {
  const f = automaticFixture({
    save: ({ saves }) => {
      if (saves.length === 1)
        throw Object.assign(new Error("angle"), {
          code: "ANGLE",
          sampleIndex: 2,
        });
      return { registered: true };
    },
  });
  await f.wizard.poll();
  assert.equal(f.saves.length, 2);
  for (const index of [0, 1])
    assert.equal(f.saves[0][index], f.saves[1][index]);
  assert.notEqual(f.saves[0][2], f.saves[1][2]);
  assert.equal(f.wizard.resolved, 1);
});

test("temporary save errors retry the same three valid images; fatal errors propagate", async () => {
  const f = automaticFixture({
    save: ({ saves }) => {
      if (saves.length === 1)
        throw Object.assign(new Error("busy"), { code: "BUSY" });
      return { registered: true };
    },
  });
  await f.wizard.poll();
  assert.deepEqual(f.saves[0], f.saves[1]);
  assert.equal(f.calls.filter((c) => c.path.endsWith("/guide")).length, 6);
  const unavailable = automaticFixture({
    save: () => {
      throw Object.assign(new Error("Storage unavailable"), {
        code: "UNAVAILABLE",
      });
    },
  });
  await assert.rejects(unavailable.wizard.poll(), /Storage unavailable/);
});

test("stale observations cannot trigger automatic capture", async () => {
  let staleImage;
  const f = automaticFixture({
    response: ({ path, body, tick }) => {
      if (path.endsWith("/guide") && !staleImage) {
        staleImage = body.image;
        tick(2000);
      }
    },
  });
  await f.wizard.poll();
  assert.ok(!f.saves[0].includes(staleImage));
});

test("the fixed guide remains visible and unchanged for every detected box", () => {
  const f = automaticFixture();
  const oval = f.wizard.$("faceGuideOval");
  Object.assign(oval, { cx: 50, cy: 49, rx: 27, ry: 36 });
  const details = f.wizard.$("faceGuideDetails");
  details.transform = "none";
  for (const box of [
    [0.4, 0.3, 0.2, 0.28],
    [0.1, 0.08, 0.8, 0.84],
    [0.01, 0.2, 0.42, 0.58],
    null,
  ]) {
    f.ctx.FaceRegistration.prototype.updateGuide.call(f.wizard, box);
    assert.equal(f.wizard.$("faceGuide").hidden, false);
    assert.deepEqual(oval, { cx: 50, cy: 49, rx: 27, ry: 36 });
    assert.equal(details.transform, "none");
  }
  assert.match(
    f.ctx.markup,
    /id="faceGuideOval"[^>]*cx="50" cy="49" rx="27" ry="36"/,
  );
  f.wizard.active = false;
  f.ctx.FaceRegistration.prototype.updateGuide.call(f.wizard);
  assert.equal(f.wizard.$("faceGuide").hidden, true);
});

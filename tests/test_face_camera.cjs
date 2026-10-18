const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture({
  getUserMedia,
  enumerateDevices,
  play,
  supported = {},
  dimensions = [1280, 720],
} = {}) {
  const calls = [],
    streams = [],
    events = new EventTarget();
  const devices = Object.assign(events, {
    getSupportedConstraints: () => supported,
    enumerateDevices: enumerateDevices || (async () => []),
    getUserMedia: async (constraints) => {
      calls.push(constraints);
      if (getUserMedia) return getUserMedia(constraints, makeStream);
      return makeStream();
    },
  });
  function makeStream(id = "default") {
    const track = Object.assign(new EventTarget(), {
      readyState: "live",
      getSettings: () => ({ deviceId: id }),
      stop() {
        this.readyState = "ended";
      },
    });
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    streams.push(stream);
    return stream;
  }
  const video = {
    srcObject: null,
    videoWidth: dimensions[0],
    videoHeight: dimensions[1],
    readyState: 2,
    play: play || (async () => {}),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (...args) => {
        canvas.drawn = args;
      },
    }),
    toDataURL: () => "data:image/jpeg;base64,fixture",
  };
  const context = vm.createContext({
    window: { isSecureContext: true },
    navigator: { mediaDevices: devices },
    document: { createElement: () => canvas },
    setTimeout,
    clearTimeout,
    DOMException,
    AbortController,
  });
  vm.runInContext(
    fs
      .readFileSync("src/js/attendance/face-camera.js", "utf8")
      .replaceAll("export ", "") + "\nthis.FaceCamera = FaceCamera;",
    context,
  );
  const updates = [];
  let ended = 0;
  const camera = new context.FaceCamera(video, {
    onDevices: (list) => updates.push(list),
    onEnded: () => ended++,
  });
  return {
    camera,
    video,
    calls,
    streams,
    devices,
    updates,
    canvas,
    context,
    ended: () => ended,
  };
}

test("relaxes unsupported resolution and never requests audio or a hardcoded device", async () => {
  const f = fixture({
    getUserMedia: (c, make) => {
      if (c.video !== true)
        throw new DOMException("Unsupported", "OverconstrainedError");
      return make();
    },
  });
  await f.camera.start();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.audio === false && !c.video.deviceId));
  f.camera.snapshot();
  assert.equal(f.canvas.width, 640);
  assert.equal(f.canvas.height, 360);
  assert.equal(
    f.canvas.drawn.length,
    5,
    "raw image orientation uses no transforms",
  );
  f.camera.stop();
  assert.equal(f.video.srcObject, null);
  assert.equal(f.streams[0].getTracks()[0].readyState, "ended");
});

test("tries other dynamically enumerated devices after busy/default/removed selection", async () => {
  const f = fixture({
    supported: { frameRate: true },
    enumerateDevices: async () => [
      { kind: "videoinput", deviceId: "busy" },
      { kind: "videoinput", deviceId: "usb" },
      { kind: "audioinput", deviceId: "mic" },
    ],
    getUserMedia: (c, make) => {
      if (c.video.deviceId?.exact === "usb") return make("usb");
      throw new DOMException("Busy", "NotReadableError");
    },
  });
  await f.camera.start({ deviceId: "removed" });
  assert.equal(
    f.camera.stream.getVideoTracks()[0].getSettings().deviceId,
    "usb",
  );
  assert.ok(f.calls.length <= 6);
  assert.equal(f.calls[0].video.frameRate.ideal, 15);
  assert.ok(f.calls.every((c) => c.video.deviceId?.exact !== "mic"));
  f.camera.stream.getVideoTracks()[0].dispatchEvent(new Event("ended"));
  assert.equal(f.ended(), 1);
  f.devices.dispatchEvent(new Event("devicechange"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.updates.length, 2);
  f.camera.stop();
  f.devices.dispatchEvent(new Event("devicechange"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.updates.length, 2, "device listeners are removed on stop");
});

test("permission rejection never cycles through devices or reprompts", async () => {
  const f = fixture({
    getUserMedia: () => {
      throw new DOMException("Denied", "NotAllowedError");
    },
  });
  await assert.rejects(f.camera.start(), { name: "NotAllowedError" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.video.srcObject, null);
});

test("close aborts pending permission immediately and releases a late grant", async () => {
  let grant;
  const f = fixture({
    getUserMedia: (_, make) =>
      new Promise((resolve) => {
        grant = () => resolve(make());
      }),
  });
  const controller = new AbortController();
  const starting = f.camera.start({ signal: controller.signal });
  controller.abort();
  await assert.rejects(starting, { name: "AbortError" });
  grant();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(f.streams.every((s) => s.getTracks()[0].readyState === "ended"));
});

test("a stale start cannot detach the new session", async () => {
  let grant;
  let count = 0;
  const f = fixture({
    getUserMedia: (_, make) =>
      ++count === 1
        ? new Promise((resolve) => {
            grant = () => resolve(make("old"));
          })
        : make("new"),
  });
  const old = f.camera.start();
  const rejected = assert.rejects(old, { name: "AbortError" });
  await f.camera.start();
  grant();
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    f.camera.stream.getVideoTracks()[0].getSettings().deviceId,
    "new",
  );
  assert.equal(f.streams[0].getTracks()[0].readyState, "live");
  assert.equal(f.streams[1].getTracks()[0].readyState, "ended");
  f.camera.stop();
});

test("failed playback releases every attempted stream", async () => {
  const f = fixture({
    play: async () => {
      throw new Error("Playback failure");
    },
  });
  await assert.rejects(f.camera.start(), /Playback failure/);
  assert.ok(f.streams.length >= 1);
  assert.ok(f.streams.every((s) => s.getTracks()[0].readyState === "ended"));
  assert.equal(f.video.srcObject, null);
});

test("empty device inventories and unsupported secure context fail cleanly", async () => {
  const f = fixture({
    getUserMedia: () => {
      throw new DOMException("Missing", "NotFoundError");
    },
  });
  await assert.rejects(f.camera.start(), { name: "NotFoundError" });
  f.context.window.isSecureContext = false;
  await assert.rejects(f.camera.start(), /HTTPS/);
});

test("unanswered permission has no automatic timeout and remains cancellable", async () => {
  const f = fixture({ getUserMedia: () => new Promise(() => {}) });
  let timers = 0;
  f.context.setTimeout = (...args) => {
    timers++;
    return setTimeout(...args);
  };
  const starting = f.camera.start();
  assert.equal(timers, 0, "permission prompts must wait for the user's choice");
  f.camera.stop();
  await assert.rejects(starting, { name: "AbortError" });
});

test("cancellation during video readiness stops the stream and polling", async () => {
  const f = fixture({ dimensions: [0, 0] });
  const controller = new AbortController();
  const starting = f.camera.start({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(starting, { name: "AbortError" });
  assert.ok(f.streams.every((s) => s.getTracks()[0].readyState === "ended"));
  assert.equal(f.camera.stream, null);
});

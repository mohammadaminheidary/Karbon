const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs
  .readFileSync(
    path.join(__dirname, "../src/js/components/connection.js"),
    "utf8",
  )
  .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*/gm, "")
  .replace(/^export /gm, "");
const health = () => new Response('{"status":"ok"}');
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function fixture(fetch) {
  const window = new EventTarget();
  const document = new EventTarget();
  document.documentElement = { dataset: {} };
  document.hidden = false;
  const timers = new Map();
  const deadlines = [];
  const calls = [];
  let now = 50000,
    timerID = 0,
    visible = false;
  const context = vm.createContext({
    window,
    document,
    Event,
    DOMException,
    AbortController,
    AbortSignal: {
      any: AbortSignal.any,
      timeout(delay) {
        const controller = new AbortController();
        deadlines.push({
          at: now + delay,
          callback: () =>
            controller.abort(new DOMException("Timed out", "TimeoutError")),
        });
        return controller.signal;
      },
    },
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++timerID;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch: (url, options) => {
      calls.push({ url, options });
      return fetch(url, options);
    },
    showConnectionScreen() {
      visible = true;
    },
    hideConnectionScreen() {
      visible = false;
    },
  });
  vm.runInContext(source, context);
  return {
    api: context.connectionFetch,
    check: context.checkConnection,
    start: context.startConnectionMonitor,
    window,
    document,
    calls,
    timers,
    visible: () => visible,
    async advance(ms) {
      now += ms;
      for (const deadline of deadlines.splice(0)) {
        if (deadline.at <= now) deadline.callback();
        else deadlines.push(deadline);
      }
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
      await flush();
    },
  };
}

test("HTTP errors stay with their API callers; gateway errors only confirm health", async () => {
  for (const status of [
    400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504,
  ]) {
    const f = fixture(async (url) =>
      url.endsWith("/health") ? health() : new Response("error", { status }),
    );
    assert.equal((await f.api("/api/example")).status, status);
    assert.equal(f.visible(), false);
    assert.equal(
      f.calls.filter(({ url }) => url.endsWith("/health")).length,
      status >= 502 ? 1 : 0,
    );
  }
});

test("route-specific network failures do not mask a reachable server", async () => {
  const failure = new TypeError("route unavailable");
  const f = fixture(async (url) => {
    if (url.endsWith("/health")) return health();
    throw failure;
  });
  await assert.rejects(f.api("/api/example"), (error) => error === failure);
  assert.equal(f.visible(), false);
});

test("concurrent failures share one probe; reads resume and writes never replay", async () => {
  let online = false,
    releaseHealth;
  const f = fixture(async (url) => {
    if (url.endsWith("/health")) {
      if (online) return health();
      return new Promise((resolve, reject) => {
        releaseHealth = () => reject(new TypeError("offline"));
      });
    }
    if (!online) throw new TypeError("offline");
    return new Response("read restored");
  });
  const read = f.api("/api/read");
  const write = assert.rejects(
    f.api("/api/write", { method: "POST", body: "draft" }),
    /offline/,
  );
  await flush();
  assert.equal(f.calls.filter(({ url }) => url.endsWith("/health")).length, 1);
  releaseHealth();
  await write;
  assert.equal(f.visible(), true);
  await assert.rejects(f.api("/api/write", { method: "PUT" }), /unavailable/);
  online = true;
  await f.check();
  assert.equal(await (await read).text(), "read restored");
  assert.equal(f.visible(), false);
  assert.equal(f.calls.filter(({ url }) => url === "/api/write").length, 1);
  assert.equal(f.calls.filter(({ url }) => url === "/api/read").length, 2);
});

test("caller cancellation does not create an outage and suspended reads stay abortable", async () => {
  const controller = new AbortController();
  const f = fixture(
    (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(options.signal.reason),
        );
      }),
  );
  const request = f.api("/api/read", { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.visible(), false);

  const outage = fixture(async () => {
    throw new TypeError("offline");
  });
  await outage.check();
  const waiting = new AbortController();
  const suspended = outage.api("/api/read", { signal: waiting.signal });
  waiting.abort();
  await assert.rejects(suspended, { name: "AbortError" });
  assert.equal(
    outage.calls.length,
    1,
    "aborted suspended request never hits the server",
  );
});

test("idle checks are sparse, API traffic postpones them, hidden documents pause them", async () => {
  const f = fixture(async () => health());
  f.start();
  f.start();
  assert.equal(f.timers.size, 1);
  await f.api("/api/read");
  await f.advance(1000);
  assert.equal(f.calls.length, 1);
  await f.advance(29000);
  assert.equal(f.calls.length, 2);
  f.document.hidden = true;
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.timers.size, 0);
  await f.advance(90000);
  assert.equal(f.calls.length, 2);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(f.calls.length, 3);
  f.window.dispatchEvent(new Event("pagehide"));
  assert.equal(f.timers.size, 0);
});

test("outages back off and Retry shares the in-flight automatic check", async () => {
  const f = fixture(async () => {
    throw new TypeError("offline");
  });
  await f.check();
  assert.equal(f.visible(), true);
  const expected = [2000, 4000, 8000, 15000, 30000, 30000];
  for (const delay of expected) {
    assert.equal(f.timers.size, 1);
    const before = f.calls.length;
    await f.advance(delay - 1);
    assert.equal(f.calls.length, before);
    await f.advance(1);
    assert.equal(f.calls.length, before + 1);
  }
});

test("a hanging health request is bounded and successful recovery emits once", async () => {
  let online = false,
    restored = 0;
  const f = fixture((url, options) =>
    online
      ? Promise.resolve(health())
      : new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason),
          );
        }),
  );
  f.window.addEventListener("karbon:connection-restored", () => restored++);
  const first = f.check();
  assert.equal(f.check(), first);
  await f.advance(5000);
  assert.equal(await first, false);
  assert.equal(f.visible(), true);
  online = true;
  await f.check();
  await f.check();
  assert.equal(restored, 1);
  assert.equal(f.visible(), false);
});

test("the read timeout checks backend health instead of treating a slow route as an outage", async () => {
  const f = fixture((url, options) =>
    url.endsWith("/health")
      ? Promise.resolve(health())
      : new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason),
          );
        }),
  );
  const request = assert.rejects(f.api("/api/read"), { name: "TimeoutError" });
  await f.advance(15000);
  await request;
  assert.equal(f.visible(), false);
  assert.equal(f.calls.length, 2);
});

test("caller cancellation remains connected after response headers arrive", async () => {
  const f = fixture(async () => new Response("body"));
  const controller = new AbortController();
  await f.api("/api/download", { signal: controller.signal });
  controller.abort();
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.visible(), false);
});

test("clients can retain a longer operation deadline without delaying health checks", async () => {
  const f = fixture((url, options) =>
    url.endsWith("/health")
      ? Promise.resolve(health())
      : new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason),
          );
        }),
  );
  const request = assert.rejects(f.api("/api/face", {}, 20000), {
    name: "TimeoutError",
  });
  await f.advance(15000);
  assert.equal(f.calls[0].options.signal.aborted, false);
  await f.advance(5000);
  await request;
  assert.equal(f.visible(), false);
  assert.equal(f.calls.length, 2);
});

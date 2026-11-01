const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs
  .readFileSync(
    path.join(__dirname, "../src/js/components/api-cache.js"),
    "utf8",
  )
  .replace(/^import .*;\n/gm, "")
  .replace(/^export /gm, "");
const url = "http://localhost/api/customers?limit=12&skip=0";
const headers = { Authorization: "Bearer account-one" };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function fixture(fetch, session = storage(), local = storage()) {
  let now = 1000;
  const listeners = new Map();
  const context = vm.createContext({
    fetch,
    Response,
    Headers,
    URL,
    AbortController,
    DOMException,
    atob,
    setTimeout,
    clearTimeout,
    Date: { now: () => now },
    sessionStorage: session,
    localStorage: local,
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
  });
  vm.runInContext(source, context);
  return {
    api: context.apiFetch,
    invalidate: context.invalidateApiCache,
    refresh: context.refreshData,
    advance: (ms) => {
      now += ms;
    },
    setTime: (value) => {
      now = value;
    },
    emit: (name) => listeners.get(name)?.({}),
    session,
    local,
  };
}

test("identical concurrent GETs share one request and independent response bodies", async () => {
  let calls = 0,
    finish;
  const f = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = f.api(url, { headers });
  const second = f.api("http://localhost/api/customers?skip=0&limit=12", {
    headers,
  });
  assert.equal(calls, 1);
  finish(json({ items: [1, 2] }));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(await a.json(), { items: [1, 2] });
  assert.deepEqual(await b.json(), { items: [1, 2] });
  assert.deepEqual(await (await f.api(url, { headers })).json(), {
    items: [1, 2],
  });
  assert.equal(calls, 1);
});

test("fresh data survives a document change; expired data refetches", async () => {
  let calls = 0;
  const fetch = async () => json({ version: ++calls });
  const first = fixture(fetch);
  await first.api(url, { headers });
  const next = fixture(fetch, first.session, first.local);
  assert.deepEqual(await (await next.api(url, { headers })).json(), {
    version: 1,
  });
  assert.equal(calls, 1);
  next.advance(30001);
  assert.deepEqual(await (await next.api(url, { headers })).json(), {
    version: 2,
  });
});

test("writes invalidate data while retaining a fresh authentication check", async () => {
  const calls = [];
  const f = fixture(async (input, options) => {
    calls.push([input, options.method || "GET"]);
    return json({ success: true });
  });
  const auth = "http://localhost/api/auth/me";
  await f.api(auth, { headers });
  await f.api(url, { headers });
  await Promise.all([
    f.api(url, { headers, method: "POST" }),
    f.api(url, { headers, method: "POST" }),
  ]);
  f.local.setItem("karbon-data-change", "after-write");
  await f.api(auth, { headers });
  await f.api(url, { headers });
  assert.equal(calls.filter(([input]) => input === auth).length, 1);
  assert.equal(calls.filter(([, method]) => method === "POST").length, 2);
  assert.equal(
    calls.filter(([input, method]) => input === url && method === "GET").length,
    2,
  );
});

test("account changes, logout, and cross-tab revisions cannot reuse another snapshot", async () => {
  let calls = 0;
  const f = fixture(async () => json(++calls));
  await f.api(url, { headers });
  await f.api(url, { headers: { Authorization: "Bearer account-two" } });
  await f.api(url, { headers });
  assert.equal(calls, 3);
  f.local.setItem("karbon-data-change", "other-tab-edit");
  await f.api(url, { headers });
  assert.equal(calls, 4);
  f.invalidate({ auth: true });
  assert.equal(f.session.getItem("karbon-api-cache-v1"), null);
  await f.api(url, { headers });
  assert.equal(calls, 5);
});

test("cancelling one caller does not cancel another caller's shared GET", async () => {
  let signal,
    finish,
    calls = 0;
  const f = fixture((_input, options) => {
    calls++;
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const controller = new AbortController();
  const first = f
    .api(url, { headers, signal: controller.signal })
    .catch((error) => error);
  const second = f.api(url, { headers });
  controller.abort();
  assert.equal((await first).name, "AbortError");
  assert.equal(signal.aborted, false);
  finish(json({ items: [1] }));
  assert.deepEqual(await (await second).json(), { items: [1] });
  assert.equal(calls, 1);
});

test("cancelled or invalidated requests cannot repopulate the cache", async () => {
  let calls = 0,
    finish;
  const f = fixture(async () => {
    calls++;
    if (calls === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return json("fresh");
  });
  const stale = f.api(url, { headers });
  f.invalidate();
  await f.api(url, { headers });
  finish(json("old"));
  await stale;
  assert.equal(await (await f.api(url, { headers })).json(), "fresh");
  assert.equal(calls, 2);

  f.invalidate();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.api(url, { headers, signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(calls, 2);
});

test("errors, malformed JSON, and generated next numbers are not cached", async () => {
  for (const response of [
    () => json({ detail: "failed" }, 500),
    () => new Response("invalid json"),
  ]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return response();
    });
    await f.api(url, { headers });
    await f.api(url, { headers });
    assert.equal(calls, 2);
  }
  let calls = 0;
  const f = fixture(async () => json(++calls));
  await f.api("http://localhost/api/orders/next-number", { headers });
  await f.api("http://localhost/api/orders/next-number", { headers });
  assert.equal(calls, 2);
});

test("explicit refresh bypasses fresh data and cache validity stops at token expiry", async () => {
  let calls = 0;
  const f = fixture(async () => json(++calls));
  const token = `Bearer header.${Buffer.from(JSON.stringify({ exp: 2 })).toString("base64url")}.signature`;
  const options = { headers: { Authorization: token } };
  await f.api(url, options);
  await f.refresh(() => f.api(url, options))();
  assert.equal(calls, 2);
  f.advance(1001);
  await f.api(url, options);
  assert.equal(calls, 3);
});

test("storage restrictions still permit in-memory reuse and local invalidation", async () => {
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  let calls = 0;
  const f = fixture(async () => json(++calls), blocked, blocked);
  await f.api(url, { headers });
  await f.api(url, { headers });
  assert.equal(calls, 1);
  f.emit("karbon-data-change");
  await f.api(url, { headers });
  assert.equal(calls, 2);
});

test("cancelling the final subscriber aborts the network and permits a clean retry", async () => {
  let calls = 0,
    finish,
    signal;
  const f = fixture(async (_input, options) => {
    calls++;
    signal = options.signal;
    if (calls === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return json("fresh");
  });
  const controller = new AbortController();
  const cancelled = f
    .api(url, { headers, signal: controller.signal })
    .catch((error) => error);
  controller.abort();
  assert.equal((await cancelled).name, "AbortError");
  assert.equal(signal.aborted, true);
  finish(json("cancelled payload"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await (await f.api(url, { headers })).json(), "fresh");
  assert.equal(calls, 2);
});

test("relative-date data is invalidated at Tehran midnight even within its TTL", async () => {
  let calls = 0;
  const f = fixture(async () => json(++calls));
  f.setTime(Date.parse("2026-10-16T23:59:55+03:30"));
  await f.api(url, { headers });
  f.advance(10000);
  await f.api(url, { headers });
  assert.equal(calls, 2);
});

test("retained data has a bounded entry count", async () => {
  const f = fixture(async () => json({ items: [] }));
  for (let skip = 0; skip < 60; skip++)
    await f.api(`${url}&search=${skip}`, { headers });
  assert.equal(
    JSON.parse(f.session.getItem("karbon-api-cache-v1")).entries.length,
    50,
  );
});

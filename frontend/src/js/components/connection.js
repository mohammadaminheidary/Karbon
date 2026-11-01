import {
  showConnectionScreen,
  hideConnectionScreen,
} from "./connection-screen.js";

// The production builder rewrites this same API base throughout the application.
const API_BASE = "http://127.0.0.1:8000/api";
const heartbeatDelay = 30000;
const retryDelays = [2000, 4000, 8000, 15000, 30000];
let installed = false;
let disconnected = false;
let paused = false;
let timer;
let probe;
let failures = 0;
let lastContact = 0;

function schedule(delay) {
  clearTimeout(timer);
  if (paused || document.hidden) return;
  timer = setTimeout(() => {
    // API traffic supplies reachability evidence; idle pages use a cheap heartbeat.
    if (!disconnected && Date.now() - lastContact < heartbeatDelay) {
      schedule(heartbeatDelay - (Date.now() - lastContact));
    } else {
      void checkConnection();
    }
  }, delay);
}

function lost() {
  disconnected = true;
  document.documentElement.dataset.connectionState = "disconnected";
  showConnectionScreen(checkConnection);
}

function recovered() {
  const wasDisconnected = disconnected;
  disconnected = false;
  failures = 0;
  lastContact = Date.now();
  delete document.documentElement.dataset.connectionState;
  hideConnectionScreen();
  if (wasDisconnected)
    window.dispatchEvent(new Event("karbon:connection-restored"));
}

// One in-flight, unauthenticated probe for all callers. A route's HTTP error
// alone is never enough to replace the current page with an outage screen.
export function checkConnection() {
  if (probe) return probe;
  clearTimeout(timer);
  if (disconnected) showConnectionScreen(checkConnection, true);
  probe = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${API_BASE}/health`, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      // Reject proxy error documents and captive portals, even with HTTP 200.
      if (!response.ok || (await response.json()).status !== "ok")
        throw new Error("Backend health check failed");
      recovered();
      return true;
    } catch {
      if (!paused) lost();
      failures++;
      return false;
    } finally {
      clearTimeout(timeout);
      probe = undefined;
      schedule(
        disconnected
          ? retryDelays[Math.min(failures - 1, retryDelays.length - 1)]
          : heartbeatDelay,
      );
    }
  })();
  return probe;
}

function waitForConnection(signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!disconnected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    function cleanup() {
      window.removeEventListener("karbon:connection-restored", resume);
      signal?.removeEventListener("abort", abort);
    }
    function resume() {
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(signal.reason);
    }
    window.addEventListener("karbon:connection-restored", resume, {
      once: true,
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// Used by the existing API cache and the few uncached/binary API clients.
// Reads can safely resume after recovery. Writes are NEVER queued or replayed:
// a lost response may belong to a mutation the server already committed.
export async function connectionFetch(input, options = {}, timeout = 15000) {
  const read = ["GET", "HEAD"].includes(
    (options.method || "GET").toUpperCase(),
  );
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (disconnected) {
      if (!read) throw new TypeError("Server connection is unavailable");
      await waitForConnection(options.signal);
    }
    // Native signals cover the response body too, and keep caller cancellation
    // connected after fetch has resolved its headers (e.g. report downloads).
    const deadline = AbortSignal.timeout(timeout);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;
    let response;
    let failure;
    try {
      response = await fetch(input, { ...options, signal });
      lastContact = Date.now();
    } catch (error) {
      failure = error;
    }
    // Cancellation is intentional (dialogs, navigation, superseded searches).
    if (options.signal?.aborted) throw options.signal.reason;
    const suspect = failure || [502, 503, 504].includes(response.status);
    if (suspect) {
      const healthy = await checkConnection();
      if (!healthy && read && !paused) {
        await waitForConnection(options.signal);
        continue;
      }
    }
    if (failure) throw failure;
    return response;
  }
}

export function startConnectionMonitor() {
  if (installed) return;
  installed = true;
  const wake = () => {
    paused = false;
    if (!document.hidden) void checkConnection();
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) wake();
  });
  window.addEventListener("pagehide", () => {
    paused = true;
    clearTimeout(timer);
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden) wake();
  });
  // Auth/data requests normally establish contact first, avoiding a redundant
  // startup request. Login and otherwise idle pages still detect an outage.
  schedule(1000);
}

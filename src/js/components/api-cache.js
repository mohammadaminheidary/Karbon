const storageKey = "karbon-api-cache-v1";
const revisionKey = "karbon-data-change";
const maxAge = 30000;
const maxEntries = 50;
const maxBytes = 1000000;
const pending = new Map();
let generation = 0;
let state;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tehran",
});

const isAuthEntry = (entry) =>
  typeof entry?.key === "string" && entry.key.endsWith("/api/auth/me");

function revision() {
  try {
    return localStorage.getItem(revisionKey);
  } catch {
    return null;
  }
}

function persist() {
  try {
    let value = JSON.stringify(state);
    while (value.length > maxBytes && state.entries.length) {
      state.entries.shift();
      value = JSON.stringify(state);
    }
    sessionStorage.setItem(storageKey, value);
  } catch {
    /* A storage restriction must not prevent API access. */
  }
}

function cacheFor(owner) {
  const currentRevision = revision();
  const day = dateFormatter.format(Date.now());
  if (!state) {
    try {
      state = JSON.parse(sessionStorage.getItem(storageKey));
    } catch {
      /* Memory cache only. */
    }
  }
  if (
    !state ||
    state.owner !== owner ||
    state.revision !== currentRevision ||
    state.day !== day ||
    !Array.isArray(state.entries)
  ) {
    const entries =
      state?.owner === owner && Array.isArray(state.entries)
        ? state.entries.filter(isAuthEntry)
        : [];
    generation++;
    state = { owner, revision: currentRevision, day, entries };
    persist();
  }
  state.entries = state.entries.filter(
    (entry) =>
      entry &&
      typeof entry.body === "string" &&
      typeof entry.key === "string" &&
      Array.isArray(entry.headers) &&
      entry.status >= 200 &&
      entry.status < 300 &&
      entry.expires > Date.now(),
  );
  return state;
}

export function invalidateApiCache({ auth = false } = {}) {
  generation++;
  if (state && !auth) {
    state.entries = state.entries.filter(isAuthEntry);
    state.revision = revision();
    persist();
  } else {
    state = undefined;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Memory cache only. */
    }
  }
}

export function refreshData(callback) {
  return (...args) => {
    invalidateApiCache();
    return callback(...args);
  };
}

function tokenExpiry(owner) {
  try {
    const payload = owner.split(" ")[1].split(".")[1];
    const { exp } = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return Number.isFinite(exp) ? exp * 1000 : Infinity;
  } catch {
    return Infinity;
  }
}

function responseFor(snapshot) {
  return new Response(
    [204, 205, 304].includes(snapshot.status) ? null : snapshot.body,
    { status: snapshot.status, headers: snapshot.headers },
  );
}

function subscribe(request, signal) {
  return new Promise((resolve, reject) => {
    const consumer = {};
    let finished = false;
    request.consumers.add(consumer);
    function cleanup() {
      finished = true;
      request.consumers.delete(consumer);
      signal?.removeEventListener("abort", abort);
    }
    function abort() {
      if (finished) return;
      cleanup();
      reject(new DOMException("The request was aborted", "AbortError"));
      if (!request.consumers.size) {
        if (pending.get(request.key) === request) pending.delete(request.key);
        request.controller.abort();
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.promise.then(
      (snapshot) => {
        if (finished) return;
        cleanup();
        resolve(responseFor(snapshot));
      },
      (error) => {
        if (finished) return;
        cleanup();
        reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}

// Share GETs while they are running, and reuse successful JSON for a short
// period across documents in this tab. Each caller receives its own Response
// and cancellation never interrupts a request still needed by another caller.
export async function apiFetch(input, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET") {
    const response = await fetch(input, options);
    if (response.ok) invalidateApiCache();
    return response;
  }
  if (options.signal?.aborted)
    throw new DOMException("The request was aborted", "AbortError");
  const owner = new Headers(options.headers).get("Authorization");
  if (!owner) return fetch(input, options);
  const cache = cacheFor(owner);
  const url = new URL(input);
  url.hash = "";
  url.searchParams.sort();
  const cacheKey = url.href;
  const reusable =
    !/\/next-[^/]+$/.test(url.pathname) && options.cache !== "no-store";
  const entry =
    reusable &&
    options.cache !== "reload" &&
    cache.entries.find((item) => item.key === cacheKey);
  if (entry) return responseFor(entry);

  const version = generation;
  const key = JSON.stringify([owner, cacheKey, version]);
  let request = pending.get(key);
  if (!request) {
    const controller = new AbortController();
    request = { key, controller, consumers: new Set() };
    const current = request;
    const timeout = setTimeout(() => controller.abort(), 15000);
    request.promise = (async () => {
      try {
        const response = await fetch(input, {
          ...options,
          signal: controller.signal,
        });
        const body = await response.text();
        const snapshot = {
          key: cacheKey,
          body,
          status: response.status,
          headers: [...response.headers],
        };
        if (response.status === 401) invalidateApiCache({ auth: true });
        if (
          response.ok &&
          !controller.signal.aborted &&
          reusable &&
          version === generation &&
          cache.revision === revision()
        ) {
          try {
            JSON.parse(body);
            snapshot.expires = Math.min(
              Date.now() + maxAge,
              tokenExpiry(owner),
            );
            cache.entries = cache.entries.filter(
              (item) => item.key !== cacheKey,
            );
            if (body.length <= maxBytes) cache.entries.push(snapshot);
            cache.entries = cache.entries.slice(-maxEntries);
            persist();
          } catch {
            /* Malformed JSON must never become a cached success. */
          }
        }
        return snapshot;
      } finally {
        clearTimeout(timeout);
        if (pending.get(key) === current) pending.delete(key);
      }
    })();
    pending.set(key, request);
  }
  return subscribe(request, options.signal);
}

// Local notifications do not produce a storage event in their own document.
window.addEventListener(revisionKey, invalidateApiCache);

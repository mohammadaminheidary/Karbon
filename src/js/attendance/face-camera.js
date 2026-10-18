const cancelled = () => new DOMException("Cancelled", "AbortError");
const denied = (error) =>
  ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(
    error.name,
  );

export function cameraError(error) {
  if (denied(error))
    return "دسترسی دوربین مجاز نیست. اجازه دوربین را در مرورگر فعال کنید یا از ورود دستی استفاده کنید.";
  if (
    ["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(
      error.name,
    )
  )
    return "دوربینی پیدا نشد. اتصال دوربین را بررسی کنید.";
  if (["NotReadableError", "TrackStartError"].includes(error.name))
    return "دوربین در دسترس نیست یا در برنامه دیگری مشغول است. اتصال و برنامه‌های دیگر را بررسی کنید.";
  return error.message || "راه‌اندازی دوربین انجام نشد.";
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

// Bound hardware startup, never the lifetime of an active camera session.
function pending(promise, signal, timeout = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, cancelled());
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    if (timeout)
      timer = setTimeout(
        () => finish(reject, new Error("تصویر دوربین آماده نشد.")),
        timeout,
      );
  });
}

export class FaceCamera {
  constructor(video, { onDevices = () => {}, onEnded = () => {} } = {}) {
    this.video = video;
    this.onDevices = onDevices;
    this.onEnded = onEnded;
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
    this.detach?.();
    this.detach = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null;
  }

  async devices() {
    try {
      return (await navigator.mediaDevices.enumerateDevices?.()) || [];
    } catch {
      return [];
    }
  }

  async start({ deviceId, signal: external } = {}) {
    this.stop();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "دوربین فقط در localhost یا اتصال امن HTTPS در دسترس است.",
      );
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const abort = () => this.controller === controller && this.stop();
    if (external?.aborted) {
      this.stop();
      throw cancelled();
    }
    external?.addEventListener("abort", abort, { once: true });
    let release = () => external?.removeEventListener("abort", abort);
    this.detach = () => release();
    const media = navigator.mediaDevices;
    const supported = media.getSupportedConstraints?.() || {};
    const preferred = {
      width: { ideal: 640 },
      height: { ideal: 480 },
      ...(supported.frameRate ? { frameRate: { ideal: 15, max: 24 } } : {}),
    };
    const profiles = deviceId
      ? [
          { ...preferred, deviceId: { exact: deviceId } },
          { deviceId: { exact: deviceId } },
        ]
      : [
          {
            ...preferred,
            ...(supported.facingMode ? { facingMode: { ideal: "user" } } : {}),
          },
          true,
        ];
    let lastError;
    const tried = new Set(deviceId ? [deviceId] : []);
    try {
      for (let index = 0; index < profiles.length; index++) {
        if (signal.aborted) throw cancelled();
        let stream;
        // getUserMedia cannot be aborted. A late permission grant must release
        // its stream even after the panel has already closed or switched cameras.
        try {
          const acquisition = media
            .getUserMedia({ audio: false, video: profiles[index] })
            .then((value) => {
              if (signal.aborted) {
                value.getTracks().forEach((track) => track.stop());
                throw cancelled();
              }
              return value;
            });
          stream = await pending(acquisition, signal);
          this.stream = stream;
          this.video.muted = true;
          this.video.playsInline = true;
          this.video.srcObject = stream;
          await pending(this.video.play(), signal, 8000);
          // Cancelling the per-attempt controller also clears readiness polling.
          const readiness = new AbortController();
          const cancelReady = () => readiness.abort();
          signal.addEventListener("abort", cancelReady, { once: true });
          try {
            await pending(
              (async () => {
                while (
                  !this.video.videoWidth ||
                  !this.video.videoHeight ||
                  this.video.readyState < 2
                )
                  await delay(50, readiness.signal);
              })(),
              signal,
              8000,
            );
          } finally {
            readiness.abort();
            signal.removeEventListener("abort", cancelReady);
          }
          if (
            !stream
              .getVideoTracks()
              .some((track) => track.readyState === "live")
          )
            throw new DOMException("No live camera", "NotReadableError");
          const refresh = async () => {
            const devices = await this.devices();
            if (!signal.aborted) this.onDevices(devices);
          };
          const ended = () => {
            if (!signal.aborted) this.onEnded();
          };
          media.addEventListener?.("devicechange", refresh);
          stream
            .getVideoTracks()
            .forEach((track) => track.addEventListener("ended", ended));
          const previousRelease = release;
          release = () => {
            previousRelease();
            media.removeEventListener?.("devicechange", refresh);
            stream
              .getVideoTracks()
              .forEach((track) => track.removeEventListener("ended", ended));
          };
          const devices = await this.devices();
          if (signal.aborted) throw cancelled();
          this.onDevices(devices);
          return devices;
        } catch (error) {
          stream?.getTracks().forEach((track) => track.stop());
          if (signal.aborted) throw cancelled();
          this.stream = null;
          this.video.srcObject = null;
          if (denied(error)) throw error;
          lastError = error;
          // Once default/selected constraints fail, try each enumerated camera.
          if (index === profiles.length - 1) {
            for (const device of await this.devices()) {
              if (
                device.kind !== "videoinput" ||
                !device.deviceId ||
                tried.has(device.deviceId)
              )
                continue;
              tried.add(device.deviceId);
              profiles.push(
                { ...preferred, deviceId: { exact: device.deviceId } },
                { deviceId: { exact: device.deviceId } },
              );
            }
          }
        }
      }
      throw lastError || new DOMException("No camera", "NotFoundError");
    } catch (error) {
      if (this.controller === controller) this.stop();
      throw error;
    }
  }

  snapshot() {
    if (
      !this.stream
        ?.getVideoTracks()
        .some((track) => track.readyState === "live") ||
      !this.video.videoWidth ||
      this.video.readyState < 2
    )
      throw new Error("ارتباط دوربین قطع شد. دوباره تلاش کنید.");
    const canvas = (this.canvas ||= document.createElement("canvas"));
    const scale = Math.min(
      1,
      640 / this.video.videoWidth,
      640 / this.video.videoHeight,
    );
    const width = Math.round(this.video.videoWidth * scale);
    const height = Math.round(this.video.videoHeight * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas
      .getContext("2d")
      .drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  }
}

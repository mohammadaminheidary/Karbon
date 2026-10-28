// Run with frontend/tests/serve_customers_fixture.py --members 3. Synthetic cameras and
// controlled inference responses exercise the real UI and attendance backend.
// Pose/quality/matching/encryption are covered separately by Python tests.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require(
  process.env.KARBON_PLAYWRIGHT_PATH || "playwright",
);
const engine = process.env.KARBON_TEST_BROWSER || "chromium";
const browserType = { chromium, firefox, webkit }[engine];
const base = process.env.KARBON_TEST_URL || "http://127.0.0.1:5512";
const browser = await browserType.launch({
  headless: true,
  ...(engine === "chromium"
    ? {
        executablePath:
          process.env.KARBON_CHROME_PATH ||
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.addInitScript(() => {
  window.cameraMode = "normal";
  window.guideMode = "NO_FACE";
  window.cameraCalls = [];
  window.testStreams = [];
  window.cameraIds = ["fixture-one", "fixture-two"];
  const devices = navigator.mediaDevices;
  devices.enumerateDevices = async () =>
    window.cameraIds.map((deviceId, index) => ({
      kind: "videoinput",
      deviceId,
      label: `Test Camera ${index + 1}`,
    }));
  devices.getUserMedia = async (constraints) => {
    window.cameraCalls.push(constraints);
    if (constraints.audio !== false || !constraints.video)
      throw new Error("Audio requested");
    if (window.cameraMode === "denied")
      throw new DOMException("Denied", "NotAllowedError");
    if (window.cameraMode === "missing")
      throw new DOMException("Missing", "NotFoundError");
    if (window.cameraMode === "relaxed" && constraints.video.width)
      throw new DOMException("Resolution", "OverconstrainedError");
    const id = constraints.video.deviceId?.exact || window.cameraIds[0];
    if (window.cameraMode === "busy" && id !== "fixture-two")
      throw new DOMException("Busy", "NotReadableError");
    if (!window.cameraIds.includes(id))
      throw new DOMException("Removed", "NotFoundError");
    const canvas = document.createElement("canvas");
    canvas.width = window.cameraMode === "portrait" ? 480 : 640;
    canvas.height = window.cameraMode === "portrait" ? 640 : 360;
    const ctx = canvas.getContext("2d");
    const draw = () => {
      const index =
        Number(document.getElementById("faceRegistration")?.dataset.step || 0) +
        1;
      ctx.fillStyle = ["#777", "#879", "#789", "#987", "#798"][index];
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = window.retakeMarker ? "#456" : "#777";
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillStyle = "#0000ff";
      ctx.fillRect(
        canvas.width * 0.28,
        canvas.height * 0.39,
        canvas.width * 0.125,
        canvas.height * 0.22,
      );
      ctx.fillStyle = "#ff8000";
      ctx.fillRect(
        canvas.width * 0.59,
        canvas.height * 0.39,
        canvas.width * 0.125,
        canvas.height * 0.22,
      );
    };
    draw();
    // Canvas capture is a stand-in for a hardware video track, never the OS camera.
    const stream = canvas.captureStream(15);
    const timer = setInterval(draw, 60);
    const track = stream.getVideoTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => {
      clearInterval(timer);
      stop();
    };
    track.getSettings = () => ({
      deviceId: id,
      width: canvas.width,
      height: canvas.height,
    });
    window.testStreams.push(stream);
    if (window.cameraMode === "late")
      await new Promise((resolve) => setTimeout(resolve, 1800));
    return stream;
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let enrolled = false,
  validation = [],
  writes = 0,
  scanTimes = [],
  scenario = "success";
let validationFailure = true,
  qualityFailure = true,
  delayed = 0;
let saveFailure = true,
  transientSaveFailure = true,
  saveRequests = [],
  guideCalls = 0,
  memberReads = 0;
const json = (route, body, status = 200, headers = {}) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
await page.route("**/api/members?*", async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  memberReads++;
  const response = await route.fetch();
  const members = await response.json();
  return json(
    route,
    members.map((member) => ({
      ...member,
      face_registered: member.id === 1 && enrolled,
    })),
  );
});
await page.route("**/api/faces/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/status")) return json(route, { available: true });
  if (path.endsWith("/guide")) {
    const body = route.request().postDataJSON();
    assert.equal(body.consent, true);
    assert.ok(["front", "left", "right"].includes(body.angle));
    if (body.angle !== "front") assert.ok(body.reference);
    guideCalls++;
    const { mode, hold } = await page.evaluate(() => ({
      mode: window.guideMode || "NO_FACE",
      hold: window.guideHoldAngle,
    }));
    const messages = {
      TOO_CLOSE: "کمی از دوربین فاصله بگیرید",
      TOO_FAR: "کمی به دوربین نزدیک‌تر شوید",
      OFF_CENTER: "صورت را به مرکز کادر بیاورید",
      ANGLE: "سر را به زاویه درست بچرخانید",
      QUALITY: "تصویر تار است؛ ثابت بمانید",
      DARK: "نور کافی نیست",
      BRIGHT: "نور بیش از حد است",
      INCOMPLETE: "تمام صورت دیده شود",
      NO_FACE: "چهره‌ای پیدا نشد",
      MULTIPLE_FACES: "فقط یک نفر",
    };
    const code =
      scenario === "invalid" ? "NO_FACE" : hold === body.angle ? "ANGLE" : mode;
    const box = {
      TOO_CLOSE: [0.1, 0.08, 0.8, 0.84],
      TOO_FAR: [0.4, 0.3, 0.2, 0.28],
      OFF_CENTER: [0.01, 0.2, 0.42, 0.58],
      INCOMPLETE: [-0.12, 0.12, 0.5, 0.7],
      NO_FACE: null,
      MULTIPLE_FACES: null,
    };
    if (messages[code])
      return json(route, {
        ready: false,
        code: ["DARK", "BRIGHT"].includes(code) ? "QUALITY" : code,
        message: messages[code],
        box: Object.hasOwn(box, code) ? box[code] : [0.29, 0.2, 0.42, 0.58],
      });
    if (mode === "stale")
      await new Promise((resolve) => setTimeout(resolve, 1800));
    const reference = body.reference || [0.04, 0.6];
    const pose =
      mode === "relaxed"
        ? {
            front: [0.04, 0.6],
            left: [reference[0] + 0.14, reference[1]],
            right: [reference[0] - 0.14, reference[1]],
          }[body.angle]
        : {
            front: [0, 0.6],
            left: [0.25, 0.6],
            right: [-0.25, 0.6],
          }[body.angle];
    const jitter = mode === "relaxed" ? (guideCalls % 2) * 0.04 : 0;
    return json(route, {
      ready: true,
      code: "READY",
      message: "آماده",
      box: [
        0.29 + (mode === "jitter" ? (guideCalls % 2) * 0.1 : jitter),
        0.2,
        0.42,
        0.58,
      ],
      pose: [pose[0], pose[1] + jitter],
    });
  }
  if (path.endsWith("/validate")) {
    const body = route.request().postDataJSON();
    assert.equal(body.consent, true);
    validation.push(body.images.length);
    if (scenario === "invalid")
      return json(
        route,
        { detail: { code: "NO_FACE", message: "چهره‌ای پیدا نشد" } },
        422,
      );
    if (body.images.length === 2 && validationFailure) {
      validationFailure = false;
      return json(
        route,
        { detail: { code: "ANGLE", message: "زاویه تصویر دوم صحیح نیست" } },
        422,
      );
    }
    if (body.images.length === 3 && qualityFailure) {
      qualityFailure = false;
      return json(
        route,
        { detail: { code: "QUALITY", message: "تصویر سوم واضح نیست" } },
        422,
      );
    }
    return json(route, { valid: true, accepted: body.images.length });
  }
  if (path.endsWith("/members/1")) {
    if (route.request().method() === "DELETE") {
      enrolled = false;
      return route.fulfill({ status: 204 });
    }
    const body = route.request().postDataJSON();
    saveRequests.push(body);
    if (saveFailure) {
      saveFailure = false;
      return json(
        route,
        {
          detail: {
            code: "ANGLE",
            message: "تصویر سوم باید دوباره گرفته شود",
            sample_index: 2,
          },
        },
        422,
      );
    }
    if (transientSaveFailure) {
      transientSaveFailure = false;
      return json(
        route,
        { detail: { code: "BUSY", message: "کمی صبر کنید" } },
        429,
        { "Retry-After": "1" },
      );
    }
    assert.equal(body.images.length, 3);
    assert.equal(
      new Set(body.images).size,
      3,
      "all three angles must have separate captures",
    );
    assert.equal(body.consent, true);
    writes++;
    enrolled = true;
    return json(route, { member_id: 1, registered: true });
  }
  if (path.endsWith("/check-in")) {
    scanTimes.push(Date.now());
    assert.equal(route.request().postDataJSON().images.length, 2);
    if (scenario === "waiting" || scenario === "unknown")
      return json(
        route,
        {
          detail: {
            code: scenario === "waiting" ? "NO_FACE" : "NO_MATCH",
            message:
              scenario === "waiting"
                ? "چهره‌ای پیدا نشد"
                : "چهره با اطمینان شناسایی نشد",
          },
        },
        scenario === "waiting" ? 422 : 409,
      );
    if (scenario === "rate") {
      scenario = "success";
      return json(
        route,
        { detail: { code: "RATE_LIMIT", message: "کمی صبر کنید" } },
        429,
        { "Retry-After": "3" },
      );
    }
    if (scenario === "network") return route.abort();
    if (delayed) await new Promise((resolve) => setTimeout(resolve, delayed));
    const response = await context.request.post(
      `${base}/api/attendance/check-in`,
      {
        headers: { Authorization: route.request().headers().authorization },
        data: { member_id: 1 },
      },
    );
    assert.equal(response.status(), 200);
    const result = await response.json();
    return json(route, {
      ...result,
      member: { id: 1, first_name: "عضو 1", last_name: "آزمایشی" },
    });
  }
  return route.continue();
});
const settled = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.pageState === "ready",
  );
const panelOpen = () =>
  page.waitForFunction(
    () =>
      document.getElementById("memberFacePanel")?.open &&
      !document.getElementById("memberFacePanel").hasAttribute("data-morph"),
  );
const success = () =>
  page.locator("#faceSuccess").waitFor({ state: "visible", timeout: 30000 });
const manual = () =>
  page.locator("#faceManualSection").waitFor({ state: "visible" });
const live = () =>
  page.evaluate(
    () =>
      !!document
        .getElementById("memberFaceVideo")
        ?.srcObject?.getVideoTracks()
        .some((t) => t.readyState === "live"),
  );
const stopped = async () =>
  assert.equal(
    await page.evaluate(() =>
      window.testStreams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ),
    true,
  );
const close = async () => {
  await page.locator("#memberFacePanel [data-dialog-close]").first().click();
  await page.waitForFunction(
    () => !document.getElementById("memberFacePanel").open,
  );
  await stopped();
  assert.equal(
    await page.locator(".document-dock-open, .document-dock-morphing").count(),
    0,
  );
};
const start = async () => {
  await page.locator("#memberCheckInButton").click();
  await panelOpen();
};
const mode = (value) =>
  page.evaluate((value) => {
    window.cameraMode = value;
  }, value);
try {
  await page.goto(`${base}/page/login-page.html`);
  await page.locator("#username").fill("customers-test");
  await page.locator("#passwordInput").fill("test-password");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("**/index.html");
  await page.goto(`${base}/page/settings-page.html#members`);
  await settled();
  await page.locator('[data-member-face="1"]').click();
  await panelOpen();
  assert.equal(await page.locator("#faceStart").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.cameraCalls.length), 0);
  await page.locator("#faceConsent").check();
  await page.locator("#faceStart").click();
  await page.locator("#faceDeviceLabel").waitFor({ state: "visible" });
  const preview = await page.locator(".face-preview").boundingBox();
  const shell = await page.locator(".face-camera-shell").boundingBox();
  assert.ok(Math.abs(preview.width - preview.height) < 1);
  assert.ok(Math.abs(shell.width - shell.height) < 1);
  assert.equal(
    await page
      .locator("#memberFaceVideo")
      .evaluate((v) => getComputedStyle(v).transform),
    "none",
  );
  assert.equal(
    await page
      .locator(".face-preview")
      .evaluate((v) => getComputedStyle(v).borderRadius),
    "50%",
  );
  await page
    .locator(".face-preview")
    .screenshot({ path: "/tmp/karbon-face-orientation.png" });
  execFileSync("python3", [
    "-c",
    `from PIL import Image
im=Image.open('/tmp/karbon-face-orientation.png').convert('RGB')
w,h=im.size
left=im.getpixel((round(w*.28),h//2)); right=im.getpixel((round(w*.72),h//2))
assert left[2]>200 and left[0]<40, left
assert right[0]>200 and right[2]<40, right
`,
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.locator(".face-preview").boundingBox();
  assert.ok(Math.abs(mobile.width - mobile.height) < 1 && mobile.width < 390);
  await page.screenshot({ path: "/tmp/karbon-face-circle-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#faceConsent").uncheck();
  await stopped();
  assert.equal(writes, 0);
  assert.equal(
    await page.locator("#faceProgress").getAttribute("aria-valuenow"),
    "0",
  );
  validation = [];
  await page.evaluate(() => {
    window.ringFrames = [];
    const progress = document.getElementById("faceProgress");
    new MutationObserver(() =>
      window.ringFrames.push({
        phase: progress.dataset.phase,
        value:
          100 -
          Number(
            progress.querySelector(".face-progress-fill").style
              .strokeDashoffset,
          ),
      }),
    ).observe(progress, { attributes: true, subtree: true });
  });
  await page.locator("#faceConsent").check();
  await page.locator("#faceStart").click();
  await page.locator("#faceDeviceLabel").waitFor({ state: "visible" });
  await page.locator("#faceDevice").selectOption("fixture-two");
  const phase = (value) =>
    page.waitForFunction(
      (value) =>
        !document.getElementById("faceRegistration").hidden &&
        document.getElementById("faceRegistration").dataset.phase === value,
      value,
    );
  const guideMode = (value) =>
    page.evaluate((value) => {
      window.guideMode = value;
    }, value);
  await phase("position");
  assert.equal(await page.locator("[data-face-step]").count(), 3);
  assert.equal(await page.locator('[data-face-step="3"]').count(), 0);
  assert.match(await page.locator("#faceAngle").innerText(), /۱ از ۳/);
  const readsBeforeGuidance = memberReads;
  assert.equal(
    await page.locator("#faceCapture, #faceUsePhoto, #faceSavePhotos").count(),
    0,
    "registration requires no capture or approval buttons",
  );
  for (const [code, text] of [
    ["TOO_CLOSE", "فاصله"],
    ["TOO_FAR", "نزدیک"],
    ["OFF_CENTER", "مرکز"],
    ["ANGLE", "زاویه"],
    ["QUALITY", "تار"],
    ["DARK", "کافی"],
    ["BRIGHT", "بیش"],
    ["INCOMPLETE", "تمام"],
  ]) {
    await guideMode(code);
    await page.waitForFunction(
      (text) =>
        document
          .getElementById("facePositionStatus")
          .textContent.includes(text),
      text,
    );
    assert.equal(
      validation.length,
      0,
      `${code} cannot trigger automatic capture`,
    );
    assert.equal(
      await page.locator("#faceGuide").getAttribute("data-state"),
      "adjust",
    );
    assert.equal(await page.locator("#faceGuide").isVisible(), true);
    for (const selector of ["#faceGuideOval", "#faceGuideCutout"]) {
      const geometry = await page
        .locator(selector)
        .evaluate((el) =>
          Object.fromEntries(
            ["cx", "cy", "rx", "ry"].map((name) => [
              name,
              Number(el.getAttribute(name)),
            ]),
          ),
        );
      assert.deepEqual(
        geometry,
        { cx: 50, cy: 49, rx: 27, ry: 36 },
        "the guide must not follow face distance or position",
      );
    }
    assert.equal(
      await page
        .locator("#faceGuideDetails")
        .evaluate((el) => getComputedStyle(el).transform),
      "none",
    );
  }

  await guideMode("NO_FACE");
  await page.waitForFunction(() =>
    document
      .getElementById("facePositionStatus")
      .textContent.includes("چهره‌ای پیدا نشد"),
  );
  assert.equal(
    await page.locator("#faceGuide").isVisible(),
    true,
    "the positioning target stays visible without a face",
  );
  assert.equal(validation.length, 0);
  await guideMode("jitter");
  await page.waitForTimeout(1800);
  assert.equal(validation.length, 0, "moving faces cannot trigger capture");
  await guideMode("stale");
  await page.waitForTimeout(2200);
  assert.equal(
    validation.length,
    0,
    "stale guide observations cannot trigger capture",
  );
  assert.equal(
    memberReads,
    readsBeforeGuidance,
    "live guidance cannot cause data refreshes",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await guideMode("relaxed");
  await page.waitForTimeout(600);
  const backgroundGuides = guideCalls;
  await page.waitForTimeout(800);
  assert.equal(guideCalls, backgroundGuides);
  assert.equal(validation.length, 0);
  await page.screenshot({
    path: "/tmp/karbon-face-registration-automatic.png",
  });
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // From this point no clicks: capture, retry bad candidates, advance, repair a
  // rejected final angle, retry a busy save, and finish must all be automatic.
  await success();
  assert.equal(writes, 1);
  assert.deepEqual(validation, [1, 2, 2, 3, 3, 3]);
  assert.equal(saveRequests.length, 3);
  for (const index of [0, 1])
    assert.equal(
      saveRequests[0].images[index],
      saveRequests[1].images[index],
      "replacing a rejected angle preserves the other captures",
    );
  assert.deepEqual(
    saveRequests[1].images,
    saveRequests[2].images,
    "temporary save failure must not recapture valid photos",
  );
  console.log(
    "Automatic registration with a fixed guide, natural jitter, small turns, distance/alignment gates, three-angle progress, and save recovery passed.",
  );
  const ring = await page.evaluate(() => window.ringFrames);
  assert.ok(
    ring.some((f) => f.phase === "capturing" && f.value > 10 && f.value < 25),
  );
  assert.ok(ring.some((f) => f.phase === "processing" && f.value === 70));
  for (const milestone of [30, 50, 70])
    assert.ok(
      ring.some((f) => f.value === milestone),
      `missing three-step milestone ${milestone}`,
    );
  assert.ok(ring.some((f) => f.phase === "complete" && f.value === 100));
  await close();
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.memberFace),
    "1",
  );
  assert.match(
    await page.locator('[data-member-face="1"]').innerText(),
    /مدیریت/,
  );

  scenario = "invalid";
  await page.locator('[data-member-face="1"]').click();
  await panelOpen();
  await page.locator("#faceConsent").check();
  await page.locator("#faceStart").click();
  await page.waitForFunction(() =>
    document
      .getElementById("facePositionStatus")
      .textContent.includes("چهره‌ای پیدا نشد"),
  );
  assert.equal(await live(), true);
  assert.equal(writes, 1);
  await close();

  await page.goto(`${base}/page/attendance-page.html`);
  await settled();
  assert.equal(await page.locator("#attendanceMembers button").count(), 0);
  scenario = "waiting";
  scanTimes = [];
  await start();
  await page.waitForFunction(() =>
    document
      .getElementById("faceStatus")
      .textContent.includes("چهره‌ای پیدا نشد"),
  );
  // Remain idle beyond the former 25-second deadline, on the same live stream.
  const firstStreamCount = await page.evaluate(() => window.testStreams.length);
  await page.waitForTimeout(28000);
  assert.equal(await live(), true);
  assert.equal(
    await page.evaluate(() => window.testStreams.length),
    firstStreamCount,
  );
  assert.equal(await page.locator("#faceManualSection").isVisible(), false);
  assert.ok(
    scanTimes.length >= 9 && scanTimes.length <= 13,
    `bounded polling: ${scanTimes.length}`,
  );
  for (let i = 1; i < scanTimes.length; i++)
    assert.ok(scanTimes[i] - scanTimes[i - 1] > 2200);
  // Hidden tabs retain the camera but suspend inference until visible again.
  await page.evaluate(() =>
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    }),
  );
  await page.waitForTimeout(1000);
  const hiddenCount = scanTimes.length;
  await page.waitForTimeout(3000);
  assert.equal(scanTimes.length, hiddenCount);
  assert.equal(await live(), true);
  await page.evaluate(() => {
    delete document.hidden;
  });
  scenario = "success";
  console.log("Persistent idle session and background pacing passed.");
  await success();
  await stopped();
  assert.match(
    await page.locator("#faceSuccessTitle").innerText(),
    /موفقیت|قبلاً/,
  );
  await close();
  await start();
  await success();
  assert.match(await page.locator("#faceSuccessTitle").innerText(), /قبلاً/);
  scenario = "unknown";
  await page.locator("#faceNext").click();
  await page.waitForFunction(() =>
    document.getElementById("faceStatus").textContent.includes("اطمینان"),
  );
  assert.equal(await live(), true);
  await page.locator("#faceManual").click();
  await manual();
  await stopped();
  await page.locator("#faceMemberSearch").fill("۲");
  await page.locator("#faceMemberSelect").selectOption("2");
  await page.locator("#faceManualSubmit").click();
  await success();
  await close();

  scenario = "rate";
  scanTimes = [];
  await start();
  await success();
  assert.equal(scanTimes.length, 2);
  assert.ok(scanTimes[1] - scanTimes[0] >= 3000);
  await close();
  scenario = "network";
  await start();
  await page.waitForFunction(() =>
    document.getElementById("faceStatus").textContent.includes("ارتباط"),
  );
  assert.equal(await live(), true);
  scenario = "success";
  await success();
  await close();

  for (const value of ["denied", "missing"]) {
    await mode(value);
    await start();
    await manual();
    await stopped();
    assert.match(
      await page.locator("#faceStatus").innerText(),
      value === "denied" ? /دسترسی/ : /دوربینی/,
    );
    await close();
  }
  for (const value of ["relaxed", "busy", "portrait"]) {
    await mode(value);
    await start();
    await success();
    await stopped();
    await close();
  }
  await mode("late");
  const count = await page.evaluate(() => window.cameraCalls.length);
  await start();
  await page.waitForFunction(
    (count) => window.cameraCalls.length > count,
    count,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.getElementById("memberFacePanel").open,
  );
  await page.waitForTimeout(2100);
  await stopped();

  await mode("normal");
  scenario = "waiting";
  await start();
  await page.waitForFunction(
    () => document.getElementById("memberFaceVideo").srcObject !== null,
  );
  await page.evaluate(() => {
    window.cameraIds = ["fixture-two", "fixture-three"];
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await page.waitForFunction(() =>
    document.querySelector('#faceDevice option[value="fixture-three"]'),
  );
  await page.locator("#faceDevice").selectOption("fixture-three");
  await page.waitForFunction(
    () =>
      document
        .getElementById("memberFaceVideo")
        .srcObject?.getVideoTracks()[0]
        ?.getSettings().deviceId === "fixture-three",
  );
  await page.evaluate(() => {
    const track = document
      .getElementById("memberFaceVideo")
      .srcObject.getVideoTracks()[0];
    window.cameraIds = ["fixture-two"];
    track.stop();
    track.dispatchEvent(new Event("ended"));
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await page.waitForFunction(
    () =>
      document
        .getElementById("memberFaceVideo")
        .srcObject?.getVideoTracks()[0]
        ?.getSettings().deviceId === "fixture-two",
  );
  await close();

  scenario = "success";
  delayed = 1600;
  const request = page.waitForRequest((r) =>
    r.url().endsWith("/faces/check-in"),
  );
  await start();
  await request;
  assert.equal(
    await page.locator("#faceProgress").getAttribute("data-phase"),
    "processing",
  );
  assert.equal(
    await page.locator("#faceProgress").getAttribute("aria-valuenow"),
    null,
  );
  assert.equal(
    await page
      .locator(".face-progress-fill")
      .evaluate((c) => c.style.strokeDashoffset),
    "30",
  );
  await page.waitForTimeout(300);
  assert.equal(
    await page
      .locator(".face-progress-fill")
      .evaluate((c) => c.style.strokeDashoffset),
    "30",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#memberFacePanel").getAttribute("open"), "");
  await success();
  await close();
  delayed = 0;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mode("denied");
  await start();
  await manual();
  assert.equal(
    await page.evaluate(() =>
      document
        .getElementById("memberFacePanel")
        .contains(document.activeElement),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: "/tmp/karbon-face-check-in-mobile.png" });
  await close();
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "memberCheckInButton",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/page/settings-page.html#members`);
  await settled();
  await page.locator('[data-member-face="1"]').click();
  await panelOpen();
  await page.locator("#faceRemove").click();
  await page.locator("#faceCancelRemove").click();
  assert.equal(
    await page.locator("#faceDeleteConfirmation").isVisible(),
    false,
  );
  await page.locator("#faceRemove").click();
  await page.locator("#faceConfirmRemove").click();
  await success();
  await close();
  assert.match(
    await page.locator('[data-member-face="1"]').innerText(),
    /ثبت چهره/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await mode("portrait");
  await page.locator('[data-member-face="1"]').click();
  await panelOpen();
  await page.locator("#faceConsent").check();
  await page.locator("#faceStart").click();
  await page.evaluate(() => {
    window.guideHoldAngle = "left";
    window.guideMode = "relaxed";
  });
  await page.waitForFunction(
    () =>
      document.getElementById("faceRegistration").dataset.step === "1" &&
      document.getElementById("faceGuide").dataset.angle === "left",
  );
  await page.locator("#faceGuide").waitFor({ state: "visible" });
  assert.equal(
    await page
      .locator("#faceDirectionArrow")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.locator("#faceStepInstruction").scrollIntoViewIfNeeded();
  const cameraBox = await page.locator(".face-preview").boundingBox();
  assert.ok(Math.abs(cameraBox.width - cameraBox.height) < 1);
  const guideBounds = await page.locator("#faceGuideOval").evaluate((el) => ({
    rx: Number(el.getAttribute("rx")),
    ry: Number(el.getAttribute("ry")),
  }));
  assert.ok(
    Math.abs(guideBounds.rx - 27) < 0.001 &&
      Math.abs(guideBounds.ry - 36) < 0.001,
  );
  await page.screenshot({ path: "/tmp/karbon-face-registration-mobile.png" });
  await page.evaluate(() => {
    window.guideHoldAngle = null;
  });
  await success();
  await close();
  assert.equal(writes, 2);
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(
    "Automatic mobile portrait-camera registration and reduced motion passed.",
  );
  // Component removal is a lifecycle boundary even when the page stays loaded.
  await mode("normal");
  await page.locator('[data-member-face="1"]').click();
  await panelOpen();
  await page.locator("#faceConsent").check();
  await page.locator("#faceStart").click();
  await page.waitForFunction(
    () => document.getElementById("memberFaceVideo").srcObject !== null,
  );
  await page.locator("#memberFacePanel").evaluate((el) => el.remove());
  await page.waitForTimeout(100);
  await stopped();
  assert.equal(
    await page.evaluate(() =>
      document.body.classList.contains("overflow-hidden"),
    ),
    false,
  );
  assert.equal(
    await page.locator(".document-dock-open, .document-dock-morphing").count(),
    0,
  );
  await page.locator('[data-member-face="1"]').click();
  await panelOpen();
  await close();
  assert.deepEqual(errors, []);
  console.log(
    `Face browser checks passed (${engine}): three guided angles, invalid angle/quality retries, persistent idle session, hidden-tab pacing, matching retries, rate limits, permissions, constraint/device fallback, hotplug, cancellation/unmount cleanup, circular unmirrored preview, progress, manual attendance, deletion, focus, responsive layout.`,
  );
} finally {
  await browser.close();
}

import { NavbarPanelDialog } from "../components/navbar-panel-dialog.js";
import { FaceCamera, cameraError, delay } from "./face-camera.js";
import { FaceProgress } from "./face-progress.js";
import {
  FaceRegistration,
  faceGuideMarkup,
  faceRegistrationMarkup,
} from "./face-registration.js";
import { faceRequest } from "./face-api.js";
import { getTodayAttendance } from "./attendance-api.js";

const fullName = (member) =>
  [member.first_name, member.last_name].filter(Boolean).join(" ");
const normalize = (value) =>
  value
    .toLocaleLowerCase("fa")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
const RETRYABLE = new Set([
  "NO_FACE",
  "MULTIPLE_FACES",
  "POSITION",
  "QUALITY",
  "INCONSISTENT",
  "ANGLE",
  "NO_MATCH",
  "BUSY",
  "RATE_LIMIT",
  "NETWORK",
  "TIMEOUT",
]);
const SCAN_INTERVAL = 2500;
let panel;

class FacePanel {
  constructor() {
    this.root = document.createElement("dialog");
    this.root.id = "memberFacePanel";
    this.root.className = "bottom-curtain face-panel";
    this.root.setAttribute("aria-hidden", "true");
    this.root.innerHTML = `<form class="navbar-panel-content face-content" aria-labelledby="memberFaceTitle">
      <header class="face-header"><div><h2 id="memberFaceTitle"></h2><p id="memberFaceDescription"></p></div><button type="button" data-dialog-close class="face-close" aria-label="بستن">×</button></header>
      <section id="faceScanSection">
        <p class="face-privacy">سه تصویر ثبت چهره و الگوی آن به‌صورت رمزگذاری‌شده نگهداری می‌شوند و هر زمان قابل حذف‌اند. تصاویر شناسایی فقط برای پردازش محلی استفاده می‌شوند.</p>
        <label id="faceConsentLabel" class="face-consent"><input id="faceConsent" type="checkbox" />با رضایت عضو، چهره او برای ثبت ورود ذخیره شود.</label>
        <div class="face-camera-shell">
          <div id="faceProgress" class="face-progress" role="progressbar" aria-label="پیشرفت ثبت و شناسایی چهره" aria-valuemin="0" aria-valuemax="100">
            <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><circle class="face-progress-track" cx="50" cy="50" r="47" pathLength="100" /><circle class="face-progress-fill" cx="50" cy="50" r="47" pathLength="100" /><g class="face-processing-orbit"><circle class="face-progress-pending" cx="50" cy="50" r="47" pathLength="100" /></g></svg>
          </div>
          <div class="face-preview"><video id="memberFaceVideo" autoplay muted playsinline aria-label="پیش‌نمایش دوربین"></video><img id="faceCapturePreview" alt="پیش‌نمایش تصویر ثبت‌شده برای بازبینی" hidden />${faceGuideMarkup}</div>
        </div>
        <p class="face-preview-label">یک نفر · نور کافی · صورت کامل در کادر</p>${faceRegistrationMarkup}
        <label id="faceDeviceLabel" hidden>دوربین<select id="faceDevice" class="face-field"></select></label>
        <div class="face-actions"><button id="faceStart" type="button" class="face-primary">شروع دوربین</button><button id="faceManual" type="button" class="face-secondary">ورود دستی</button><button id="faceRemove" type="button" class="face-danger" hidden>حذف چهره ذخیره‌شده</button></div>
        <section id="faceDeleteConfirmation" hidden><p>چهره ذخیره‌شده این عضو حذف شود؟ پس از حذف، ورود دستی همچنان در دسترس است.</p><div class="face-actions"><button id="faceConfirmRemove" type="button" class="face-danger">بله، حذف چهره</button><button id="faceCancelRemove" type="button" class="face-secondary">انصراف</button></div></section>
      </section>
      <section id="faceManualSection" hidden>
        <label for="faceMemberSearch">جستجوی نام، شناسه یا شماره تماس</label><input id="faceMemberSearch" class="face-field" type="search" autocomplete="off" />
        <label for="faceMemberSelect">عضو</label><select id="faceMemberSelect" class="face-field"></select>
        <p id="faceMemberCount" class="face-hint"></p>
        <div class="face-actions"><button id="faceManualSubmit" type="submit" class="face-primary">ثبت ورود عضو</button><button id="faceManualReload" type="button" class="face-secondary">بروزرسانی اعضا</button><button id="faceRetry" type="button" class="face-secondary">تلاش با دوربین</button></div>
      </section>
      <section id="faceSuccess" class="face-success" hidden><span aria-hidden="true">✓</span><h3 id="faceSuccessTitle"></h3><p id="faceSuccessDescription"></p><div class="face-actions"><button id="faceNext" type="button" class="face-primary">عضو بعدی</button><button type="button" data-dialog-close class="face-secondary">بستن</button></div></section>
      <p id="faceStatus" class="face-status" role="status" aria-live="polite"></p>
    </form>`;
    document.body.append(this.root);
    this.$ = (id) => this.root.querySelector(`#${id}`);
    this.camera = new FaceCamera(this.$("memberFaceVideo"), {
      onDevices: (devices) => this.renderDevices(devices),
      onEnded: () => {
        this.cameraDisconnected = true;
        if (!this.busy || this.committing) return;
        this.$("faceDevice").value = "";
        this.status("اتصال دوربین قطع شد؛ در حال انتخاب دوربین در دسترس…");
        void this.scan();
      },
    });
    this.progress = new FaceProgress(this.$("faceProgress"));
    this.registration = new FaceRegistration(this.root, {
      camera: this.camera,
      progress: this.progress,
      status: (message) => this.status(message),
    });
    this.dialog = new NavbarPanelDialog(this.root.id, {
      canClose: () => !this.committing,
      onCancel: () => {
        this.openVersion = (this.openVersion || 0) + 1;
        this.stop();
      },
    });
    this.$("faceStart").addEventListener("click", () => void this.scan());
    this.$("faceConsent").addEventListener("change", () => {
      if (!this.$("faceConsent").checked) {
        this.stop();
        this.status("ثبت چهره متوقف شد. برای ادامه رضایت عضو لازم است.");
      }
      this.$("faceStart").disabled = !this.$("faceConsent").checked;
    });
    this.$("faceManual").addEventListener("click", () => void this.manual());
    this.$("faceRetry").addEventListener("click", () => {
      this.resetView();
      void this.scan();
    });
    this.$("faceNext").addEventListener("click", () => {
      this.resetView();
      void this.scan();
    });
    this.$("faceDevice").addEventListener("change", () => {
      if (!this.committing) void this.scan();
    });
    this.$("faceMemberSearch").addEventListener("input", () =>
      this.renderMembers(),
    );
    this.$("faceMemberSelect").addEventListener("change", () => {
      this.$("faceManualSubmit").disabled = !this.$("faceMemberSelect").value;
    });
    this.$("faceManualReload").addEventListener(
      "click",
      () => void this.manual(),
    );
    this.root.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitManual();
    });
    this.$("faceRemove").addEventListener("click", () => {
      this.stop();
      this.$("faceDeleteConfirmation").hidden = false;
    });
    this.$("faceCancelRemove").addEventListener("click", () => {
      this.$("faceDeleteConfirmation").hidden = true;
    });
    this.$("faceConfirmRemove").addEventListener(
      "click",
      () => void this.remove(),
    );
    this.onPageHide = () => this.stop();
    window.addEventListener("pagehide", this.onPageHide);
    this.root.addEventListener("close", () => this.stop());
    // A removed component must release hardware even without page navigation.
    this.unmountObserver = new MutationObserver(() => {
      if (this.root.isConnected) return;
      this.stop();
      window.removeEventListener("pagehide", this.onPageHide);
      this.dialog.observer.disconnect();
      this.dialog.transition.destroy();
      this.progress.destroy();
      this.registration.destroy();
      this.unmountObserver.disconnect();
      if (panel === this) panel = null;
    });
    this.unmountObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  renderDevices(devices) {
    const selected = this.camera.stream
      ?.getVideoTracks()[0]
      ?.getSettings?.().deviceId;
    const cameras = devices.filter(
      (device) => device.kind === "videoinput" && device.deviceId,
    );
    this.$("faceDevice").replaceChildren(
      ...cameras.map(
        (device, index) =>
          new Option(
            device.label || `دوربین ${index + 1}`,
            device.deviceId,
            false,
            device.deviceId === selected,
          ),
      ),
    );
    this.$("faceDeviceLabel").hidden = cameras.length < 2;
  }

  status(message = "") {
    this.$("faceStatus").textContent = message;
  }

  stop() {
    this.scanController?.abort();
    this.scanController = null;
    this.manualVersion = (this.manualVersion || 0) + 1;
    this.registration.stop();
    this.camera.stop();
    this.progress.reset();
    this.$("faceCapturePreview").hidden = true;
    this.$("faceCapturePreview").removeAttribute("src");
    this.root.classList.remove("is-scanning");
    this.busy = false;
    this.$("faceStart").disabled =
      (this.mode === "enroll" && !this.$("faceConsent").checked) || this.busy;
  }

  resetView() {
    this.stop();
    this.status();
    for (const id of [
      "faceManualSection",
      "faceSuccess",
      "faceDeleteConfirmation",
    ])
      this.$(id).hidden = true;
    this.$("faceScanSection").hidden = false;
    this.$("faceStart").textContent = "شروع دوربین";
  }

  async open({ mode, member, registered = false, onSaved = () => {} }) {
    if (this.dialog.active || this.dialog.closing) return;
    const version = (this.openVersion = (this.openVersion || 0) + 1);
    this.mode = mode;
    this.member = member;
    this.onSaved = onSaved;
    this.registered = registered;
    this.$("faceConsent").checked = false;
    this.$("faceDevice").replaceChildren();
    this.$("faceDeviceLabel").hidden = true;
    this.resetView();
    this.$("faceMemberCount").textContent = "";
    const enroll = mode === "enroll";
    this.$("memberFaceTitle").textContent = enroll
      ? "ثبت چهره عضو"
      : "ورود اعضا";
    this.$("memberFaceDescription").textContent = enroll
      ? fullName(member)
      : "شناسایی چهره و ثبت خودکار ورود امروز";
    this.$("faceConsentLabel").hidden = !enroll;
    this.$("faceManual").hidden = enroll;
    this.$("faceRemove").hidden = !enroll || !registered;
    this.$("faceNext").hidden = enroll;
    await this.dialog.open(
      enroll ? this.$("faceConsent") : this.$("faceStart"),
    );
    if (!enroll && this.dialog.active && version === this.openVersion)
      void this.scan();
  }

  async waitVisible(signal) {
    // Keep the session, but avoid inference while the tab is in the background.
    while (document.hidden) await delay(1000, signal);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  }

  async scan() {
    if (
      this.committing ||
      !this.dialog.active ||
      (this.mode === "enroll" && !this.$("faceConsent").checked)
    )
      return;
    const deviceId = this.$("faceDevice").value;
    this.stop();
    const controller = new AbortController();
    this.scanController = controller;
    const { signal } = controller;
    this.busy = true;
    this.$("faceStart").disabled = true;
    this.$("faceDeleteConfirmation").hidden = true;
    this.status("در حال آماده‌سازی دوربین و دریافت اجازه دسترسی…");
    const samples = [];
    try {
      let capability;
      do {
        capability = await faceRequest("/faces/status", { signal });
        if (capability.code === "BUSY") {
          this.status(capability.message);
          await delay(SCAN_INTERVAL, signal);
        }
      } while (capability.code === "BUSY");
      if (!capability.available) throw new Error(capability.message);
      await this.camera.start({ deviceId, signal });
      if (signal.aborted) return;
      this.cameraDisconnected = false;
      this.root.classList.add("is-scanning");
      await this.progress.advance(10, {
        signal,
        duration: 180,
        label: "دوربین آماده است",
      });
      if (signal.aborted) return;
      let result;
      if (this.mode === "enroll") {
        result = await this.registration.run({
          signal,
          onSave: async (images) => {
            this.setCommitting(true);
            const commitVersion = this.commitVersion;
            try {
              return await faceRequest(`/faces/members/${this.member.id}`, {
                method: "PUT",
                body: { images, consent: true },
                signal,
              });
            } finally {
              if (this.commitVersion === commitVersion)
                this.setCommitting(false);
            }
          },
        });
      } else {
        let failures = 0;
        while (!signal.aborted) {
          await this.waitVisible(signal);
          const started = performance.now();
          samples.length = 0;
          this.status("منتظر حضور یک نفر مقابل دوربین…");
          await this.progress.advance(10, {
            signal,
            duration: 0,
            label: "در انتظار چهره",
          });
          if (signal.aborted) return;
          samples.push(this.camera.snapshot());
          await this.progress.advance(40, {
            signal,
            duration: 180,
            label: "نمونه اول دریافت شد",
          });
          await delay(180, signal);
          await this.waitVisible(signal);
          samples.push(this.camera.snapshot());
          await this.progress.advance(70, {
            signal,
            duration: 180,
            label: "نمونه دوم دریافت شد",
          });
          if (signal.aborted) return;
          this.progress.processing("در حال شناسایی چهره و ثبت ورود");
          this.setCommitting(true);
          const commitVersion = this.commitVersion;
          let retry;
          try {
            result = await faceRequest("/faces/check-in", {
              method: "POST",
              body: { images: samples },
              signal,
            });
          } catch (error) {
            if (!RETRYABLE.has(error.code)) throw error;
            retry = error;
          } finally {
            samples.length = 0;
            if (this.commitVersion === commitVersion) this.setCommitting(false);
          }
          if (signal.aborted) return;
          if (result) break;
          if (this.cameraDisconnected) {
            this.$("faceDevice").value = "";
            void this.scan();
            return;
          }
          failures =
            retry.code === "NETWORK" || retry.code === "TIMEOUT"
              ? failures + 1
              : 0;
          this.status(retry.message);
          this.progress.root.dataset.phase = "capturing";
          await delay(
            Math.max(
              SCAN_INTERVAL - (performance.now() - started),
              (retry.retryAfter || 0) * 1000,
              failures ? Math.min(10000, SCAN_INTERVAL * failures) : 0,
            ),
            signal,
          );
        }
      }
      if (signal.aborted || !this.dialog.active || !this.root.isConnected)
        return;
      this.camera.stop();
      await this.progress.advance(100, {
        signal,
        phase: "complete",
        label: this.mode === "enroll" ? "چهره ذخیره شد" : "ورود تأیید شد",
      });
      await delay(180, signal);
      if (signal.aborted) return;
      this.success(
        this.mode === "enroll"
          ? "چهره ذخیره شد"
          : result.already_checked_in
            ? "ورود قبلاً ثبت شده است"
            : "ورود با موفقیت ثبت شد",
        fullName(this.mode === "enroll" ? this.member : result.member),
        result.attendance,
      );
      this.registered = true;
      await this.saved();
    } catch (error) {
      if (signal.aborted) return;
      const message = cameraError(error);
      if (this.mode === "check-in") await this.manual(message);
      else this.status(message);
    } finally {
      samples.length = 0;
      if (this.scanController === controller) this.stop();
    }
  }

  setCommitting(value) {
    this.commitVersion = (this.commitVersion || 0) + 1;
    this.committing = value;
    this.root
      .querySelectorAll(
        "[data-dialog-close], #faceManual, #faceRemove, #faceDevice, #faceConsent, #faceStart, #faceMemberSearch, #faceMemberSelect, #faceRetry, #faceManualReload, #faceNext, #faceCancelRemove",
      )
      .forEach((button) => {
        button.disabled = value;
      });
    if (!value)
      this.$("faceStart").disabled =
        (this.mode === "enroll" && !this.$("faceConsent").checked) || this.busy;
  }

  success(title, name, attendance) {
    this.stop();
    this.$("faceScanSection").hidden = this.$("faceManualSection").hidden =
      true;
    this.$("faceSuccess").hidden = false;
    this.$("faceSuccessTitle").textContent = title;
    this.$("faceSuccessDescription").textContent =
      name +
      (attendance
        ? ` · ${new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeZone: "Asia/Tehran" }).format(new Date(`${attendance.date}T12:00:00+03:30`))} · ${attendance.recorded_time.slice(0, 5)}`
        : "");
    this.status();
    this.$("faceSuccessTitle").tabIndex = -1;
    this.$("faceSuccessTitle").focus({ preventScroll: true });
  }

  async saved() {
    if (this.mode === "check-in")
      window.dispatchEvent(new CustomEvent("attendance:updated"));
    // A refresh failure must never turn a successful write into a retry prompt.
    try {
      await this.onSaved();
    } catch {
      this.status(
        "ذخیره انجام شد؛ برای مشاهده تغییرات صفحه را بروزرسانی کنید.",
      );
    }
    if (this.mode === "enroll")
      this.dialog.previousFocus =
        document.querySelector(`[data-member-face="${this.member.id}"]`) ||
        this.dialog.previousFocus;
  }

  async manual(message = "") {
    this.stop();
    this.$("faceScanSection").hidden = this.$("faceSuccess").hidden = true;
    this.$("faceManualSection").hidden = false;
    this.status(message);
    this.$("faceMemberSearch").value = "";
    this.$("faceMemberCount").textContent = "";
    this.$("faceMemberSelect").replaceChildren(
      new Option("در حال دریافت اعضا…", ""),
    );
    this.$("faceManualSubmit").disabled = true;
    const version = (this.manualVersion = (this.manualVersion || 0) + 1);
    try {
      const members = await getTodayAttendance();
      if (!this.dialog.active || version !== this.manualVersion) return;
      this.members = members;
      this.renderMembers();
      this.$("faceMemberSearch").focus({ preventScroll: true });
    } catch (error) {
      if (!this.dialog.active || version !== this.manualVersion) return;
      this.$("faceMemberSelect").replaceChildren(
        new Option("دریافت اعضا انجام نشد", ""),
      );
      this.status(`${message} ${error.message}`.trim());
    }
  }

  renderMembers() {
    const query = normalize(this.$("faceMemberSearch").value.trim());
    const matches = (this.members || []).filter((member) =>
      normalize(
        `${fullName(member)} ${member.phone || ""} ${member.id}`,
      ).includes(query),
    );
    const current = this.$("faceMemberSelect").value;
    this.$("faceMemberSelect").replaceChildren(
      new Option("عضو را انتخاب کنید", ""),
      ...matches.map(
        (member) =>
          new Option(
            `${fullName(member)} · #${member.id}${member.today_status === "present" ? " · ورود ثبت شده" : ""}`,
            member.id,
          ),
      ),
    );
    this.$("faceMemberSelect").value = matches.some(
      (member) => String(member.id) === current,
    )
      ? current
      : "";
    this.$("faceMemberCount").textContent = matches.length
      ? `${new Intl.NumberFormat("fa-IR").format(matches.length)} عضو`
      : "عضوی پیدا نشد. اعضا را در تنظیمات ثبت کنید.";
    this.$("faceManualSubmit").disabled = !this.$("faceMemberSelect").value;
  }

  async submitManual() {
    const memberId = Number(this.$("faceMemberSelect").value);
    if (this.committing || this.$("faceManualSection").hidden || !memberId)
      return;
    const member = this.members.find((item) => item.id === memberId);
    if (!member) return;
    this.setCommitting(true);
    this.$("faceManualSubmit").disabled = true;
    this.status("در حال ثبت ورود…");
    try {
      const result = await faceRequest("/attendance/check-in", {
        method: "POST",
        body: { member_id: memberId },
      });
      this.success(
        result.already_checked_in
          ? "ورود قبلاً ثبت شده است"
          : "ورود با موفقیت ثبت شد",
        fullName(member),
        result.attendance,
      );
      await this.saved();
    } catch (error) {
      this.status(error.message);
    } finally {
      this.setCommitting(false);
      this.$("faceManualSubmit").disabled = !this.$("faceMemberSelect").value;
    }
  }

  async remove() {
    if (this.committing) return;
    this.stop();
    this.setCommitting(true);
    this.$("faceConfirmRemove").disabled = true;
    try {
      await faceRequest(`/faces/members/${this.member.id}`, {
        method: "DELETE",
      });
      this.registered = false;
      this.success("چهره ذخیره‌شده حذف شد", fullName(this.member));
      await this.saved();
    } catch (error) {
      this.status(error.message);
    } finally {
      this.setCommitting(false);
      this.$("faceConfirmRemove").disabled = false;
    }
  }
}

export function openFaceRegistration(member, registered, onSaved) {
  panel ||= new FacePanel();
  return panel.open({ mode: "enroll", member, registered, onSaved });
}

export function initializeFaceCheckIn(onSaved) {
  panel ||= new FacePanel();
  document
    .getElementById("memberCheckInButton")
    ?.addEventListener("click", () => {
      panel ||= new FacePanel();
      void panel.open({ mode: "check-in", onSaved });
    });
}

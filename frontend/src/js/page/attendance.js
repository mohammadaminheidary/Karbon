import { startPage } from "../components/page-ready.js";
import { createNavbarNotification } from "../components/navbar-notification.js";
import { onPageRefresh } from "../components/data-events.js";
import { invalidateApiCache } from "../components/api-cache.js";
import {
  fullDate,
  todayKey,
  shiftDay,
  node,
} from "../finance/finance-utils.js";
import { initializeNavbar } from "../components/navbar.js";
import { initializeFaceCheckIn } from "../attendance/face-panel.js";

initializeNavbar();

const notifyAttendance = createNavbarNotification(
  document.querySelector(".navbar-title-island"),
);

import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";


import {
  initializeAttendanceMembers,
  reloadAttendanceMembers,
} from "../attendance/members-controller.js";

import {
  AttendanceApiError,
  getAttendanceByDate,
  getAttendanceCalendar,
} from "../attendance/attendance-api.js";

import {
  setDayDetailsData,
  setDayDetailsEmpty,
  setDayDetailsError,
  setDayDetailsLoading,
} from "../attendance/day-details-modal.js";

const calendarWeekdayFormatter = new Intl.DateTimeFormat("fa-IR", {
  weekday: "long",
  timeZone: "Asia/Tehran",
});

let calendarDates = [];
let selectedDay = todayKey();
let calendarCenter = selectedDay;
let calendarVersion = 0;

let syncIntervalId = null;

let currentDayKey = null;

let backgroundRefreshRunning = false;

/* ======================================================
   Auth
====================================================== */

function handleUnauthorized(error) {
  if (error instanceof AttendanceApiError && error.status === 401) {
    logout();

    window.location.replace("/page/login-page.html");

    return true;
  }

  return false;
}

/* ======================================================
   Calendar
====================================================== */

function updateCalendarSelection() {
  document.querySelectorAll("[data-calendar-date]").forEach((button) => {
    const selected = button.dataset.calendarDate === selectedDay;
    button.setAttribute("aria-pressed", String(selected));
    button.classList.toggle("border-persian-blue", selected);
    button.classList.toggle("bg-persian-blue/5", selected);
    button.classList.toggle("border-french-gray/30", !selected);
  });
}

function createCalendarDay(dateKey) {
  const button = node(
    "button",
    "w-[170px] shrink-0 rounded-2xl border p-3 text-right transition-colors hover:border-persian-blue/40",
  );
  button.type = "button";
  button.dataset.calendarDate = dateKey;
  const date = new Date(`${dateKey}T12:00:00+03:30`);
  button.append(
    node(
      "p",
      "text-xs text-mirage/45",
      calendarWeekdayFormatter.format(date) +
        (dateKey === todayKey() ? " · امروز" : ""),
    ),
    node("p", "mt-2 font-black", fullDate(dateKey)),
  );
  for (const [status, label, color] of [
    ["Present", "حاضر", "text-eucalyptus"],
    ["Absent", "غایب", "text-alizarin-crimson"],
  ]) {
    const count = node(
      "p",
      `mt-2 text-[0.6875rem] font-bold ${color}`,
      `${label}: —`,
    );
    count.dataset[`calendar${status}`] = "true";
    button.append(count);
  }
  return button;
}

function renderCalendar({ scroll = false } = {}) {
  const track = document.getElementById("attendanceCalendarTrack");
  if (!track) return;
  calendarDates = Array.from({ length: 14 }, (_, index) =>
    shiftDay(calendarCenter, index - 7),
  );
  track.replaceChildren(...calendarDates.map(createCalendarDay));
  updateCalendarSelection();
  if (scroll) {
    track
      .querySelector(`[data-calendar-date="${selectedDay}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

/* ======================================================
   Calendar Statistics
====================================================== */

function updateCalendarStatistics(statistics) {
  const safeStatistics = Array.isArray(statistics) ? statistics : [];

  safeStatistics.forEach((day) => {
    const button = document.querySelector(`[data-calendar-date="${day.date}"]`);

    if (!button) {
      return;
    }

    const present = button.querySelector("[data-calendar-present]");

    const absent = button.querySelector("[data-calendar-absent]");

    if (present) {
      present.textContent = `حاضر: ${new Intl.NumberFormat("fa-IR").format(
        day.present_count || 0,
      )}`;
    }

    if (absent) {
      absent.textContent = `غایب: ${new Intl.NumberFormat("fa-IR").format(
        day.absent_count || 0,
      )}`;
    }
  });
}

async function refreshCalendarStatistics() {
  if (calendarDates.length === 0) {
    return;
  }

  const version = ++calendarVersion;
  const track = document.getElementById("attendanceCalendarTrack");
  track.setAttribute("aria-busy", "true");
  const startDate = calendarDates[0];

  const endDate = calendarDates[calendarDates.length - 1];

  try {
    const statistics = await getAttendanceCalendar(startDate, endDate);

    if (version !== calendarVersion) return;
    updateCalendarStatistics(statistics);
  } catch (error) {
    if (handleUnauthorized(error)) {
      return;
    }

    if (version !== calendarVersion) return;
    console.error("Calendar statistics error:", error);
    notifyAttendance("دریافت تقویم انجام نشد. دوباره تلاش کنید.");
  } finally {
    if (version === calendarVersion) track.setAttribute("aria-busy", "false");
  }
}

/* ======================================================
   Day Details
====================================================== */

async function openDayDetails(dateKey) {
  setDayDetailsLoading(dateKey);

  try {
    const data = await getAttendanceByDate(dateKey);

    const present = Array.isArray(data?.present) ? data.present : [];

    const absent = Array.isArray(data?.absent) ? data.absent : [];

    if (present.length === 0 && absent.length === 0) {
      setDayDetailsEmpty(dateKey);

      return;
    }

    setDayDetailsData(data);
  } catch (error) {
    if (handleUnauthorized(error)) {
      return;
    }

    console.error("Day details error:", error);

    setDayDetailsError(dateKey);
    notifyAttendance("دریافت اطلاعات روز انجام نشد. دوباره تلاش کنید.");
  }
}

/* ======================================================
   Calendar Events
====================================================== */

function setupCalendarInteractions() {
  const track = document.getElementById("attendanceCalendarTrack");

  if (!track) {
    return;
  }

  track.addEventListener("click", (event) => {
    const button = event.target.closest("[data-calendar-date]");

    if (!button) {
      return;
    }

    selectedDay = button.dataset.calendarDate;
    updateCalendarSelection();
    openDayDetails(selectedDay);
  });

  document
    .getElementById("attendanceSelectToday")
    .addEventListener("click", () => {
      calendarCenter = selectedDay = todayKey();
      renderCalendar({ scroll: true });
      refreshCalendarStatistics();
      openDayDetails(selectedDay);
    });
  for (const [id, offset] of [
    ["attendancePreviousDays", -14],
    ["attendanceNextDays", 14],
  ]) {
    document.getElementById(id).addEventListener("click", () => {
      calendarCenter = shiftDay(calendarCenter, offset);
      renderCalendar();
      refreshCalendarStatistics();
    });
  }

  /*
   * بعد از ثبت حاضر/غایب
   * آمار Calendar امروز Refresh شود.
   */
  window.addEventListener("attendance:updated", () => {
    refreshCalendarStatistics();
  });
}

/* ======================================================
   Members
====================================================== */

async function initializeMembersSection() {
  await initializeAttendanceMembers();
}

/* ======================================================
   Screen Synchronization
====================================================== */

async function refreshAttendanceData({ rebuildCalendar = false } = {}) {
  if (backgroundRefreshRunning) {
    return;
  }

  backgroundRefreshRunning = true;

  try {
    if (rebuildCalendar) {
      invalidateApiCache();
      calendarCenter = selectedDay = todayKey();
      renderCalendar({ scroll: true });
    }

    await Promise.all([
      reloadAttendanceMembers({
        showLoading: false,
      }),

      refreshCalendarStatistics(),
    ]);
  } finally {
    backgroundRefreshRunning = false;
  }
}

/* ======================================================
   Day Change
====================================================== */

async function checkForDayChange() {
  const today = todayKey();

  if (currentDayKey === null) {
    currentDayKey = today;

    return;
  }

  if (today === currentDayKey) {
    return;
  }

  currentDayKey = today;

  /*
   * روز جدید شروع شده:
   *
   * Calendar
   * Member Status
   * Statistics
   *
   * همگی باید Refresh شوند.
   */
  await refreshAttendanceData({
    rebuildCalendar: true,
  });
}

/* ======================================================
   Visibility Sync
====================================================== */

async function handleVisibilityChange() {
  if (document.visibilityState !== "visible") {
    return;
  }

  const today = todayKey();

  /*
   * اگر هنگام مخفی بودن Tab
   * روز عوض شده باشد.
   */
  if (today !== currentDayKey) {
    currentDayKey = today;

    await refreshAttendanceData({
      rebuildCalendar: true,
    });

    return;
  }

  /*
   * اگر همان روز است،
   * فقط اطلاعات واقعی Server
   * را دوباره دریافت می‌کنیم.
   */
  await refreshAttendanceData();
}

/* ======================================================
   Automatic Sync
====================================================== */

function setupAutomaticSynchronization() {
  currentDayKey = todayKey();

  onPageRefresh(handleVisibilityChange);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void checkForDayChange();
  });

  if (syncIntervalId) {
    clearInterval(syncIntervalId);
  }

  /*
   * برای تشخیص عبور از نیمه شب.
   *
   * نیازی نیست Server را هر دقیقه
   * Query کنیم.
   *
   * فقط تغییر Date بررسی می‌شود.
   */
  syncIntervalId = window.setInterval(checkForDayChange, 60 * 1000);
}

/* ======================================================
   Init
====================================================== */

async function initializeAttendancePage() {
  const authenticated = await protectPage();

  if (!authenticated) {
    return;
  }


  renderCalendar({ scroll: true });

  setupCalendarInteractions();

  setupAutomaticSynchronization();

  initializeFaceCheckIn(() => refreshAttendanceData());

  await Promise.all([initializeMembersSection(), refreshCalendarStatistics()]);
}

startPage(initializeAttendancePage);

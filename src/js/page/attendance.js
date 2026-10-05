import { initializeNavbar } from "../components/navbar.js";

initializeNavbar();

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

const CALENDAR_DAYS_BEFORE = 6;

const CALENDAR_DAYS_AFTER = 6;

const persianFullDateFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  weekday: "long",

  year: "numeric",

  month: "long",

  day: "numeric",
});

const persianDayFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  day: "numeric",
});

const calendarWeekdayFormatter = new Intl.DateTimeFormat("fa-IR", {
  weekday: "short",
});

const calendarDayFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  day: "numeric",
});

const calendarMonthFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  month: "short",
});

const clockFormatter = new Intl.DateTimeFormat("fa-IR", {
  hour: "2-digit",

  minute: "2-digit",

  second: "2-digit",

  hour12: false,
});

let calendarDates = [];

let clockIntervalId = null;

let syncIntervalId = null;

let currentDayKey = null;

let backgroundRefreshRunning = false;

/* ======================================================
   Date Helpers
====================================================== */

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateToLocalKey(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
}

function parseLocalDateKey(value) {
  const [year, month, day] = value.split("-").map(Number);

  return new Date(year, month - 1, day);
}

function getTodayKey() {
  return dateToLocalKey(new Date());
}

/* ======================================================
   Auth
====================================================== */

function setupLogout() {
  const button = document.getElementById("logoutButton");

  button?.addEventListener("click", () => {
    logout();

    window.location.replace("/page/login-page.html");
  });
}

function handleUnauthorized(error) {
  if (error instanceof AttendanceApiError && error.status === 401) {
    logout();

    window.location.replace("/page/login-page.html");

    return true;
  }

  return false;
}

/* ======================================================
   Header Date / Clock
====================================================== */

function updateHeaderDate() {
  const now = new Date();

  const dateElement = document.getElementById("attendancePersianDate");

  const dayElement = document.getElementById("attendanceMonthDay");

  if (dateElement) {
    dateElement.textContent = persianFullDateFormatter.format(now);
  }

  if (dayElement) {
    dayElement.textContent = persianDayFormatter.format(now);
  }
}

function updateClock() {
  const clock = document.getElementById("attendanceClock");

  if (!clock) {
    return;
  }

  clock.textContent = clockFormatter.format(new Date());
}

function initializeClock() {
  updateClock();

  if (clockIntervalId) {
    clearInterval(clockIntervalId);
  }

  clockIntervalId = window.setInterval(updateClock, 1000);
}

/* ======================================================
   Calendar Dates
====================================================== */

function buildCalendarDates() {
  const today = new Date();

  today.setHours(0, 0, 0, 0);

  const dates = [];

  for (
    let offset = -CALENDAR_DAYS_BEFORE;
    offset <= CALENDAR_DAYS_AFTER;
    offset += 1
  ) {
    const date = new Date(today);

    date.setDate(today.getDate() + offset);

    dates.push(date);
  }

  return dates;
}

/* ======================================================
   Calendar Render
====================================================== */

function createCalendarDay(date) {
  const todayKey = getTodayKey();

  const dateKey = dateToLocalKey(date);

  const isToday = dateKey === todayKey;

  const button = document.createElement("button");

  button.type = "button";

  button.dataset.calendarDate = dateKey;

  button.className = [
    "relative",
    "w-[92px]",
    "shrink-0",
    "rounded-2xl",
    "border",
    "px-3",
    "py-3",
    "text-center",
    "transition-all",
    "duration-200",

    isToday
      ? "border-persian-blue bg-persian-blue text-white shadow-md"
      : "border-french-gray/30 bg-white text-mirage hover:border-persian-blue/30 hover:shadow-sm",
  ].join(" ");

  const weekday = document.createElement("p");

  weekday.className = isToday
    ? "text-[10px] font-bold text-white/65"
    : "text-[10px] font-bold text-mirage/35";

  weekday.textContent = calendarWeekdayFormatter.format(date);

  const day = document.createElement("p");

  day.className = "mt-1 text-xl font-black";

  day.textContent = calendarDayFormatter.format(date);

  const month = document.createElement("p");

  month.className = isToday
    ? "mt-0.5 text-[10px] text-white/65"
    : "mt-0.5 text-[10px] text-mirage/35";

  month.textContent = calendarMonthFormatter.format(date);

  const counts = document.createElement("div");

  counts.className = "mt-2 flex items-center justify-center gap-2";

  const present = document.createElement("span");

  present.dataset.calendarPresent = "true";

  present.className = isToday
    ? "text-[9px] font-black text-white/80"
    : "text-[9px] font-black text-eucalyptus";

  present.textContent = "ح ۰";

  const absent = document.createElement("span");

  absent.dataset.calendarAbsent = "true";

  absent.className = isToday
    ? "text-[9px] font-black text-white/80"
    : "text-[9px] font-black text-alizarin-crimson";

  absent.textContent = "غ ۰";

  counts.append(present, absent);

  button.append(weekday, day, month, counts);

  return button;
}

function renderCalendar() {
  const track = document.getElementById("attendanceCalendarTrack");

  if (!track) {
    return;
  }

  calendarDates = buildCalendarDates();

  track.innerHTML = "";

  calendarDates.forEach((date) => {
    track.appendChild(createCalendarDay(date));
  });

  window.requestAnimationFrame(() => {
    const today = track.querySelector(
      `[data-calendar-date="${getTodayKey()}"]`,
    );

    today?.scrollIntoView({
      behavior: "smooth",

      inline: "center",

      block: "nearest",
    });
  });
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
      present.textContent = `ح ${new Intl.NumberFormat("fa-IR").format(
        day.present_count || 0,
      )}`;
    }

    if (absent) {
      absent.textContent = `غ ${new Intl.NumberFormat("fa-IR").format(
        day.absent_count || 0,
      )}`;
    }
  });
}

async function refreshCalendarStatistics() {
  if (calendarDates.length === 0) {
    return;
  }

  const startDate = dateToLocalKey(calendarDates[0]);

  const endDate = dateToLocalKey(calendarDates[calendarDates.length - 1]);

  try {
    const statistics = await getAttendanceCalendar(startDate, endDate);

    updateCalendarStatistics(statistics);
  } catch (error) {
    if (handleUnauthorized(error)) {
      return;
    }

    console.error("Calendar statistics error:", error);
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

    openDayDetails(button.dataset.calendarDate);
  });

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
      updateHeaderDate();

      renderCalendar();
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
  const todayKey = getTodayKey();

  if (currentDayKey === null) {
    currentDayKey = todayKey;

    return;
  }

  if (todayKey === currentDayKey) {
    return;
  }

  currentDayKey = todayKey;

  /*
   * روز جدید شروع شده:
   *
   * Header
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

  const todayKey = getTodayKey();

  /*
   * اگر هنگام مخفی بودن Tab
   * روز عوض شده باشد.
   */
  if (todayKey !== currentDayKey) {
    currentDayKey = todayKey;

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
  currentDayKey = getTodayKey();

  document.addEventListener("visibilitychange", handleVisibilityChange);

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

  setupLogout();

  updateHeaderDate();

  initializeClock();

  renderCalendar();

  setupCalendarInteractions();

  setupAutomaticSynchronization();

  await Promise.all([initializeMembersSection(), refreshCalendarStatistics()]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAttendancePage);
} else {
  initializeAttendancePage();
}

import { protectPage } from "../guards/auth-guard.js";
import { logout } from "../auth/auth-storage.js";

import { renderMembers } from "../attendance/member-card.js";

import { setDayDetailsEmpty } from "../attendance/day-details-modal.js";

import { setMembersViewState } from "../attendance/view-state.js";

const CALENDAR_DAYS_BEFORE = 6;
const CALENDAR_DAYS_AFTER = 6;

let clockIntervalId = null;

/* ======================================================
   Authentication / Logout
====================================================== */

function setupLogout() {
  const logoutButton = document.getElementById("logoutButton");

  if (!logoutButton) {
    console.error("Logout button not found");

    return;
  }

  logoutButton.addEventListener("click", () => {
    logout();

    window.location.replace("/page/login-page.html");
  });
}

/* ======================================================
   Persian Date Utilities
====================================================== */

function getPersianDateParts(date) {
  const formatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const parts = formatter.formatToParts(date);

  const result = {
    weekday: "",
    year: "",
    month: "",
    day: "",
  };

  parts.forEach((part) => {
    if (Object.prototype.hasOwnProperty.call(result, part.type)) {
      result[part.type] = part.value;
    }
  });

  return result;
}

function formatFullPersianDate(date) {
  const { weekday, day, month, year } = getPersianDateParts(date);

  return `${weekday} ${day} ${month} ${year}`;
}

function formatPersianMonthDay(date) {
  const { day } = getPersianDateParts(date);

  return `روز ${day} ماه`;
}

function formatPersianWeekday(date) {
  return new Intl.DateTimeFormat("fa-IR", {
    weekday: "short",
  }).format(date);
}

/* ======================================================
   Clock
====================================================== */

function formatCurrentTime(date) {
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function updateHeaderDateTime() {
  const dateElement = document.getElementById("attendancePersianDate");

  const monthDayElement = document.getElementById("attendanceMonthDay");

  const clockElement = document.getElementById("attendanceClock");

  const now = new Date();

  if (dateElement) {
    dateElement.textContent = formatFullPersianDate(now);
  }

  if (monthDayElement) {
    monthDayElement.textContent = formatPersianMonthDay(now);
  }

  if (clockElement) {
    clockElement.textContent = formatCurrentTime(now);
  }
}

function startClock() {
  updateHeaderDateTime();

  if (clockIntervalId) {
    clearInterval(clockIntervalId);
  }

  clockIntervalId = window.setInterval(() => {
    updateHeaderDateTime();
  }, 1000);
}

/* ======================================================
   Calendar Utilities
====================================================== */

function createDateWithOffset(baseDate, offset) {
  const date = new Date(baseDate);

  date.setHours(12, 0, 0, 0);

  date.setDate(date.getDate() + offset);

  return date;
}

function getLocalDateKey(date) {
  const year = date.getFullYear();

  const month = String(date.getMonth() + 1).padStart(2, "0");

  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function isSameLocalDay(firstDate, secondDate) {
  return (
    firstDate.getFullYear() === secondDate.getFullYear() &&
    firstDate.getMonth() === secondDate.getMonth() &&
    firstDate.getDate() === secondDate.getDate()
  );
}

function parseLocalDateKey(dateKey) {
  if (!dateKey) {
    return null;
  }

  const parts = dateKey.split("-").map(Number);

  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  const [year, month, day] = parts;

  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/* ======================================================
   Calendar Day
====================================================== */

function createCalendarDay(date, today) {
  const { day, month } = getPersianDateParts(date);

  const isToday = isSameLocalDay(date, today);

  const dayElement = document.createElement("article");

  dayElement.dataset.date = getLocalDateKey(date);

  dayElement.setAttribute("role", "button");

  dayElement.setAttribute("tabindex", "0");

  dayElement.setAttribute(
    "aria-label",
    `مشاهده جزئیات ${formatFullPersianDate(date)}`,
  );

  dayElement.className = [
    "cursor-pointer",
    "attendance-calendar-day",
    "snap-center",
    "w-[150px]",
    "min-w-[150px]",
    "select-none",
    "rounded-2xl",
    "border",
    "p-4",
    "transition-all",
    "duration-300",

    isToday
      ? "border-persian-blue bg-persian-blue text-white shadow-md shadow-persian-blue/15"
      : "border-french-gray/30 bg-white text-mirage hover:border-persian-blue/25 hover:shadow-sm",
  ].join(" ");

  if (isToday) {
    dayElement.dataset.today = "true";
  }

  dayElement.innerHTML = `
    <div class="flex items-start justify-between gap-2">

      <span
        class="${
          isToday ? "text-white/60" : "text-mirage/40"
        } text-[11px] font-medium"
      >
        ${formatPersianWeekday(date)}
      </span>

      ${
        isToday
          ? `
            <span
              class="rounded-md bg-white/15 px-2 py-1 text-[10px] font-bold text-white"
            >
              امروز
            </span>
          `
          : ""
      }

    </div>


    <div class="mt-4">

      <div class="flex items-end gap-1.5">

        <span
          class="text-2xl font-black"
        >
          ${day}
        </span>

        <span
          class="${
            isToday ? "text-white/65" : "text-mirage/45"
          } mb-0.5 text-xs font-medium"
        >
          ${month}
        </span>

      </div>

    </div>


    <div
      class="${
        isToday ? "border-white/15" : "border-french-gray/25"
      } mt-4 border-t pt-3"
    >

      <div
        class="flex items-center justify-between gap-2 text-[11px]"
      >

        <div
          class="flex items-center gap-1.5"
        >
          <span
            class="${
              isToday ? "bg-white" : "bg-eucalyptus"
            } h-1.5 w-1.5 rounded-full"
          ></span>

          <span
            class="${isToday ? "text-white/75" : "text-mirage/50"}"
          >
            حاضر
          </span>
        </div>

        <span
          data-present-count
          class="${isToday ? "text-white" : "text-eucalyptus"} font-black"
        >
          —
        </span>

      </div>


      <div
        class="mt-2 flex items-center justify-between gap-2 text-[11px]"
      >

        <div
          class="flex items-center gap-1.5"
        >
          <span
            class="${
              isToday ? "bg-white/70" : "bg-alizarin-crimson"
            } h-1.5 w-1.5 rounded-full"
          ></span>

          <span
            class="${isToday ? "text-white/75" : "text-mirage/50"}"
          >
            غایب
          </span>
        </div>

        <span
          data-absent-count
          class="${isToday ? "text-white" : "text-alizarin-crimson"} font-black"
        >
          —
        </span>

      </div>

    </div>
  `;

  return dayElement;
}

/* ======================================================
   Render Calendar
====================================================== */

function renderAttendanceCalendar() {
  const track = document.getElementById("attendanceCalendarTrack");

  if (!track) {
    console.error("Attendance calendar track not found");

    return;
  }

  track.innerHTML = "";

  const today = new Date();

  today.setHours(12, 0, 0, 0);

  for (
    let offset = -CALENDAR_DAYS_BEFORE;
    offset <= CALENDAR_DAYS_AFTER;
    offset += 1
  ) {
    const date = createDateWithOffset(today, offset);

    const dayElement = createCalendarDay(date, today);

    track.appendChild(dayElement);
  }

  requestAnimationFrame(() => {
    scrollTodayIntoView();
  });
}

/* ======================================================
   Calendar Scroll
====================================================== */

function scrollTodayIntoView() {
  const todayElement = document.querySelector('[data-today="true"]');

  if (!todayElement) {
    return;
  }

  todayElement.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "center",
  });
}

/* ======================================================
   Calendar Interactions
====================================================== */

function openCalendarDayDetails(dayElement) {
  const dateKey = dayElement?.dataset?.date;

  const date = parseLocalDateKey(dateKey);

  if (!date) {
    return;
  }

  /*
   * Backend هنوز متصل نشده است.
   *
   * هیچ فرد حاضر یا غایب ساختگی
   * ایجاد نمی‌کنیم.
   *
   * در Phase اتصال API ابتدا Modal
   * وارد Loading State می‌شود و سپس
   * داده واقعی نمایش داده خواهد شد.
   */

  setDayDetailsEmpty({
    dateLabel: formatFullPersianDate(date),
  });
}

function setupCalendarInteractions() {
  const track = document.getElementById("attendanceCalendarTrack");

  if (!track) {
    return;
  }

  track.addEventListener("click", (event) => {
    const dayElement = event.target.closest(".attendance-calendar-day");

    if (!dayElement) {
      return;
    }

    openCalendarDayDetails(dayElement);
  });

  track.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const dayElement = event.target.closest(".attendance-calendar-day");

    if (!dayElement) {
      return;
    }

    event.preventDefault();

    openCalendarDayDetails(dayElement);
  });
}

/* ======================================================
   Members
====================================================== */

function initializeMembersSection() {
  /*
   * بعد از اتصال API ترتیب واقعی:
   *
   * loading
   *    ↓
   * request
   *    ↓
   * ready / empty / error
   *
   * در حال حاضر Backend وجود ندارد،
   * بنابراین هیچ Request یا Fake Data
   * ایجاد نمی‌شود.
   */

  setMembersViewState("empty");

  renderMembers([]);
}

/* ======================================================
   Page Initialization
====================================================== */

async function initAttendancePage() {
  const isAuthenticated = await protectPage();

  if (!isAuthenticated) {
    return;
  }

  setupLogout();

  startClock();

  renderAttendanceCalendar();

  setupCalendarInteractions();

  initializeMembersSection();
}

/* ======================================================
   Start
====================================================== */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAttendancePage);
} else {
  initAttendancePage();
}

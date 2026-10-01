import { logout } from "../auth/auth-storage.js";

import {
  AttendanceApiError,
  getTodayAttendance,
  recordAttendance,
} from "./attendance-api.js";

import {
  animateMemberCardStatus,
  renderMembers,
  replaceMemberCard,
  setMemberCardPending,
} from "./member-card.js";

import { setMembersViewState } from "./view-state.js";

let currentMembers = [];

/* ======================================================
   Helpers
====================================================== */

function getMemberFullName(member) {
  return (
    [member?.first_name, member?.last_name].filter(Boolean).join(" ").trim() ||
    "عضو"
  );
}

/* ======================================================
   Authentication
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
   Notification
====================================================== */

function getToastContainer() {
  let container = document.getElementById("attendanceToastContainer");

  if (container) {
    return container;
  }

  container = document.createElement("div");

  container.id = "attendanceToastContainer";

  /*
   * Style مستقیم:
   * مستقل از Tailwind.
   */
  Object.assign(container.style, {
    position: "fixed",

    top: "28px",

    left: "28px",

    zIndex: "99999",

    width: "min(470px, calc(100vw - 56px))",

    display: "flex",

    flexDirection: "column",

    gap: "12px",

    direction: "rtl",

    pointerEvents: "none",
  });

  document.body.appendChild(container);

  return container;
}

function showAttendanceToast({
  member = null,
  status = "present",
  error = false,
}) {
  const container = getToastContainer();

  const present = status === "present";

  const mainColor = error ? "#DC2626" : present ? "#16A34A" : "#DC2626";

  const lightColor = error
    ? "rgba(220,38,38,0.10)"
    : present
      ? "rgba(22,163,74,0.10)"
      : "rgba(220,38,38,0.10)";

  const toast = document.createElement("div");

  Object.assign(toast.style, {
    position: "relative",

    overflow: "hidden",

    width: "100%",

    boxSizing: "border-box",

    background: "#FFFFFF",

    border: `1px solid ${mainColor}33`,

    borderRadius: "24px",

    boxShadow: "0 24px 70px rgba(15,23,42,0.18)",

    padding: "20px",

    pointerEvents: "auto",

    opacity: "0",

    transform: "translateX(-50px) scale(0.96)",
  });

  /* Accent */

  const accent = document.createElement("div");

  Object.assign(accent.style, {
    position: "absolute",

    top: "0",

    right: "0",

    bottom: "0",

    width: "6px",

    background: mainColor,
  });

  /* Layout */

  const row = document.createElement("div");

  Object.assign(row.style, {
    display: "flex",

    alignItems: "flex-start",

    gap: "15px",
  });

  /* Icon */

  const icon = document.createElement("div");

  Object.assign(icon.style, {
    width: "56px",

    height: "56px",

    borderRadius: "18px",

    flex: "0 0 auto",

    display: "flex",

    alignItems: "center",

    justifyContent: "center",

    background: lightColor,

    color: mainColor,

    fontSize: "27px",

    fontWeight: "900",
  });

  icon.textContent = error ? "!" : present ? "✓" : "×";

  /* Content */

  const content = document.createElement("div");

  Object.assign(content.style, {
    flex: "1",

    minWidth: "0",
  });

  const eyebrow = document.createElement("div");

  Object.assign(eyebrow.style, {
    color: mainColor,

    fontSize: "12px",

    fontWeight: "800",

    marginBottom: "5px",
  });

  eyebrow.textContent = error ? "خطا در ثبت اطلاعات" : "حضور و غیاب امروز";

  const title = document.createElement("div");

  Object.assign(title.style, {
    color: "#0F172A",

    fontSize: "17px",

    fontWeight: "900",

    lineHeight: "1.6",
  });

  title.textContent = error
    ? "ثبت وضعیت انجام نشد"
    : present
      ? "حضور با موفقیت ثبت شد"
      : "غیبت با موفقیت ثبت شد";

  const description = document.createElement("div");

  Object.assign(description.style, {
    color: "rgba(15,23,42,0.58)",

    fontSize: "13px",

    lineHeight: "1.9",

    marginTop: "5px",
  });

  if (error) {
    description.textContent =
      "ارتباط با سرور یا ثبت اطلاعات با مشکل روبه‌رو شد. دوباره تلاش کنید.";
  } else {
    const fullName = getMemberFullName(member);

    description.textContent = present
      ? `وضعیت ${fullName} برای امروز روی «حاضر» ثبت شد.`
      : `وضعیت ${fullName} برای امروز روی «غایب» ثبت شد.`;
  }

  content.append(eyebrow, title, description);

  /* Close */

  const closeButton = document.createElement("button");

  closeButton.type = "button";

  Object.assign(closeButton.style, {
    width: "34px",

    height: "34px",

    border: "0",

    borderRadius: "11px",

    background: "#F8FAFC",

    color: "rgba(15,23,42,0.45)",

    cursor: "pointer",

    flex: "0 0 auto",

    fontSize: "21px",

    display: "flex",

    alignItems: "center",

    justifyContent: "center",
  });

  closeButton.textContent = "×";

  row.append(icon, content, closeButton);

  /* Progress */

  const progressTrack = document.createElement("div");

  Object.assign(progressTrack.style, {
    height: "4px",

    marginTop: "17px",

    overflow: "hidden",

    borderRadius: "999px",

    background: "rgba(15,23,42,0.06)",
  });

  const progress = document.createElement("div");

  Object.assign(progress.style, {
    width: "100%",

    height: "100%",

    borderRadius: "999px",

    background: mainColor,

    transformOrigin: "right center",
  });

  progressTrack.appendChild(progress);

  toast.append(accent, row, progressTrack);

  container.appendChild(toast);

  /*
   * ورود Notification
   */
  toast.animate(
    [
      {
        opacity: 0,

        transform: "translateX(-50px) scale(0.96)",
      },

      {
        opacity: 1,

        transform: "translateX(8px) scale(1.01)",

        offset: 0.72,
      },

      {
        opacity: 1,

        transform: "translateX(0) scale(1)",
      },
    ],
    {
      duration: 520,

      easing: "cubic-bezier(0.16, 1, 0.3, 1)",

      fill: "forwards",
    },
  );

  /*
   * Animation آیکن
   */
  icon.animate(
    [
      {
        transform: "scale(0.55) rotate(-10deg)",
      },

      {
        transform: "scale(1.14) rotate(4deg)",
        offset: 0.65,
      },

      {
        transform: "scale(1) rotate(0)",
      },
    ],
    {
      duration: 620,

      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    },
  );

  /*
   * Progress چهار ثانیه
   */
  progress.animate(
    [
      {
        transform: "scaleX(1)",
      },

      {
        transform: "scaleX(0)",
      },
    ],
    {
      duration: 4500,

      easing: "linear",

      fill: "forwards",
    },
  );

  let removed = false;

  function removeToast() {
    if (removed) {
      return;
    }

    removed = true;

    const animation = toast.animate(
      [
        {
          opacity: 1,

          transform: "translateX(0) scale(1)",
        },

        {
          opacity: 0,

          transform: "translateX(-55px) scale(0.96)",
        },
      ],
      {
        duration: 280,

        easing: "ease-in",

        fill: "forwards",
      },
    );

    animation.onfinish = () => {
      toast.remove();
    };
  }

  closeButton.addEventListener("click", removeToast);

  window.setTimeout(removeToast, 4500);
}

/* ======================================================
   Members
====================================================== */

async function fetchTodayMembers() {
  const data = await getTodayAttendance();

  return Array.isArray(data) ? data : [];
}

async function refreshMembers() {
  currentMembers = await fetchTodayMembers();

  return currentMembers;
}

/* ======================================================
   Attendance Action
====================================================== */

async function handleAttendanceAction({ memberId, status, card }) {
  if (!memberId || !card) {
    return;
  }

  setMemberCardPending(card, true);

  try {
    await recordAttendance(memberId, status);

    await refreshMembers();

    const updatedMember = currentMembers.find(
      (member) => Number(member.id) === Number(memberId),
    );

    if (!updatedMember) {
      throw new Error("Member not found after attendance update");
    }

    const updatedCard = replaceMemberCard(card, updatedMember, {
      onAttendanceAction: handleAttendanceAction,
    });

    /*
     * افکت رنگی بعد از Render
     */
    window.requestAnimationFrame(() => {
      animateMemberCardStatus(updatedCard, status);
    });

    showAttendanceToast({
      member: updatedMember,

      status,
    });

    /*
     * به Calendar اطلاع می‌دهیم
     * که آمار امروز عوض شده.
     */
    window.dispatchEvent(new CustomEvent("attendance:updated"));
  } catch (error) {
    if (handleUnauthorized(error)) {
      return;
    }

    console.error(error);

    setMemberCardPending(card, false);

    showAttendanceToast({
      status,
      error: true,
    });
  }
}

/* ======================================================
   Init
====================================================== */

export async function reloadAttendanceMembers({ showLoading = false } = {}) {
  if (showLoading) {
    setMembersViewState("loading");
  }

  try {
    await refreshMembers();

    renderMembers(currentMembers, {
      onAttendanceAction: handleAttendanceAction,
    });

    return true;
  } catch (error) {
    if (handleUnauthorized(error)) {
      return false;
    }

    console.error(error);

    /*
     * اگر Refresh پس‌زمینه‌ای شکست خورد،
     * Cardهای فعلی را نابود نمی‌کنیم.
     */
    if (showLoading) {
      setMembersViewState("error");
    }

    return false;
  }
}

export async function initializeAttendanceMembers() {
  return reloadAttendanceMembers({
    showLoading: true,
  });
}

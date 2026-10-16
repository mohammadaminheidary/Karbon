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
let renderedMembers;
let notifyAttendance = () => {};

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

function showAttendanceNotification({
  member = null,
  status = "present",
  error = false,
}) {
  if (error) {
    notifyAttendance("ثبت وضعیت انجام نشد. دوباره تلاش کنید.");
    return;
  }
  const label = status === "present" ? "حضور" : "غیبت";
  notifyAttendance(`${label} ${getMemberFullName(member)} ثبت شد`);
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

    showAttendanceNotification({
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

    showAttendanceNotification({
      status,
      error: true,
    });
  }
}

/* ======================================================
   Init
====================================================== */

export async function reloadAttendanceMembers({ showLoading = false } = {}) {
  const initial = showLoading && renderedMembers === undefined;
  if (initial) {
    setMembersViewState("loading");
  }

  try {
    await refreshMembers();

    const signature = JSON.stringify(currentMembers);
    if (signature !== renderedMembers) {
      renderMembers(currentMembers, {
        onAttendanceAction: handleAttendanceAction,
      });
      renderedMembers = signature;
    }

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
    if (initial) {
      setMembersViewState("error");
    }

    return false;
  }
}

export async function initializeAttendanceMembers({
  onNotification = () => {},
} = {}) {
  notifyAttendance = onNotification;
  return reloadAttendanceMembers({
    showLoading: true,
  });
}

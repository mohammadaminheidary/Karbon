import { logout } from "../auth/auth-storage.js";
import { AttendanceApiError, getTodayAttendance } from "./attendance-api.js";
import { renderMembers } from "./member-card.js";
import { setMembersViewState } from "./view-state.js";

let renderedMembers;

export async function reloadAttendanceMembers({ showLoading = false } = {}) {
  const initial = showLoading && renderedMembers === undefined;
  if (initial) setMembersViewState("loading");
  try {
    const data = await getTodayAttendance();
    const members = Array.isArray(data) ? data : [];
    const signature = JSON.stringify(members);
    if (signature !== renderedMembers) {
      renderMembers(members);
      renderedMembers = signature;
    }
    return true;
  } catch (error) {
    if (error instanceof AttendanceApiError && error.status === 401) {
      logout();
      window.location.replace("/page/login-page.html");
      return false;
    }
    if (initial) setMembersViewState("error");
    return false;
  }
}

export function initializeAttendanceMembers() {
  return reloadAttendanceMembers({ showLoading: true });
}

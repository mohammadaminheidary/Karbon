import { getToken } from "../auth/auth-storage.js";

const API_URL = "http://127.0.0.1:8000/api";

const VALID_ATTENDANCE_STATUSES = new Set(["present", "absent"]);

/* ======================================================
   API Error
====================================================== */

export class AttendanceApiError extends Error {
  constructor(message, { status = 0, code = "UNKNOWN_ERROR" } = {}) {
    super(message);

    this.name = "AttendanceApiError";

    this.status = status;

    this.code = code;
  }
}

/* ======================================================
   Response Helpers
====================================================== */

async function parseResponse(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function getSafeErrorMessage(status, data) {
  const detail = typeof data?.detail === "string" ? data.detail.trim() : "";

  switch (status) {
    case 400:
      return detail || "اطلاعات ارسال‌شده صحیح نیست.";

    case 401:
      return "نشست کاربری منقضی شده است.";

    case 403:
      return "اجازه انجام این عملیات را ندارید.";

    case 404:
      return detail || "اطلاعات موردنظر پیدا نشد.";

    case 409:
      return detail || "امکان انجام این عملیات وجود ندارد.";

    case 422:
      return "اطلاعات ارسال‌شده معتبر نیست.";

    default:
      return "خطایی در ارتباط با سرور رخ داد.";
  }
}

/* ======================================================
   Request
====================================================== */

async function apiRequest(path, { method = "GET", body } = {}) {
  const token = getToken();

  if (!token) {
    throw new AttendanceApiError("نشست کاربری معتبر نیست.", {
      status: 401,
      code: "AUTH_REQUIRED",
    });
  }

  const headers = {
    Accept: "application/json",

    Authorization: `Bearer ${token}`,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;

  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,

      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new AttendanceApiError("ارتباط با سرور برقرار نشد.", {
      status: 0,
      code: "NETWORK_ERROR",
    });
  }

  const data = await parseResponse(response);

  if (!response.ok) {
    throw new AttendanceApiError(getSafeErrorMessage(response.status, data), {
      status: response.status,

      code: `HTTP_${response.status}`,
    });
  }

  return data;
}

/* ======================================================
   Validators
====================================================== */

function validatePositiveInteger(value, fieldName) {
  const normalized = Number(value);

  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }

  return normalized;
}

function validateStatus(status) {
  if (!VALID_ATTENDANCE_STATUSES.has(status)) {
    throw new TypeError("Invalid attendance status");
  }

  return status;
}

function validateDateKey(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError("Date must use YYYY-MM-DD format");
  }

  return date;
}

/* ======================================================
   Members
====================================================== */

export async function getMembers() {
  return apiRequest("/members");
}

/* ======================================================
   Attendance
====================================================== */

export async function getAttendanceHistory() {
  return apiRequest("/attendance");
}

export async function getTodayAttendance() {
  return apiRequest("/attendance/today");
}

export async function getAttendanceByDate(date) {
  const safeDate = validateDateKey(date);

  return apiRequest(`/attendance/date/${encodeURIComponent(safeDate)}`);
}

/* ======================================================
   Record Attendance
====================================================== */

export async function recordAttendance(memberId, status) {
  const safeMemberId = validatePositiveInteger(memberId, "memberId");

  const safeStatus = validateStatus(status);

  /*
   * عمداً تاریخ و ساعت ارسال نمی‌شوند.
   *
   * Backend مسئول تعیین:
   * - current date
   * - recorded time
   * - create / update
   *
   * خواهد بود.
   */

  return apiRequest("/attendance", {
    method: "POST",

    body: {
      member_id: safeMemberId,

      status: safeStatus,
    },
  });
}

/* ======================================================
   Update Attendance
====================================================== */

export async function updateAttendance(attendanceId, status) {
  const safeAttendanceId = validatePositiveInteger(
    attendanceId,
    "attendanceId",
  );

  const safeStatus = validateStatus(status);

  return apiRequest(`/attendance/${safeAttendanceId}`, {
    method: "PUT",

    body: {
      status: safeStatus,
    },
  });
}

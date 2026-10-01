import { getToken } from "../auth/auth-storage.js";

const API_URL = "http://127.0.0.1:8000/api";

const VALID_STATUSES = new Set(["present", "absent"]);

/* ======================================================
   Error
====================================================== */

export class AttendanceApiError extends Error {
  constructor(
    message,
    { status = 0, code = "UNKNOWN_ERROR", data = null } = {},
  ) {
    super(message);

    this.name = "AttendanceApiError";

    this.status = status;

    this.code = code;

    this.data = data;
  }
}

/* ======================================================
   Helpers
====================================================== */

function validatePositiveId(value, name = "id") {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(`Invalid ${name}`);
  }

  return id;
}

function validateStatus(status) {
  if (!VALID_STATUSES.has(status)) {
    throw new TypeError("Invalid attendance status");
  }

  return status;
}

function validateDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("Invalid date");
  }

  return value;
}

async function parseResponse(response) {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getErrorMessage(response, data) {
  if (typeof data?.detail === "string") {
    return data.detail;
  }

  switch (response.status) {
    case 401:
      return "نشست کاربری منقضی شده است.";

    case 404:
      return "اطلاعات موردنظر پیدا نشد.";

    case 422:
      return "اطلاعات ارسال‌شده معتبر نیست.";

    case 500:
      return "خطایی در سرور رخ داد.";

    default:
      return "ارتباط با سرور انجام نشد.";
  }
}

async function request(path, { method = "GET", body } = {}) {
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
  } catch {
    throw new AttendanceApiError("ارتباط با سرور برقرار نشد.", {
      code: "NETWORK_ERROR",
    });
  }

  const data = await parseResponse(response);

  if (!response.ok) {
    throw new AttendanceApiError(getErrorMessage(response, data), {
      status: response.status,

      code: `HTTP_${response.status}`,

      data,
    });
  }

  return data;
}

/* ======================================================
   Members
====================================================== */

export function getMembers() {
  return request("/members?skip=0&limit=500");
}

/* ======================================================
   Attendance
====================================================== */

export function getAttendanceHistory({
  memberId = null,
  skip = 0,
  limit = 100,
} = {}) {
  const params = new URLSearchParams();

  params.set("skip", String(skip));

  params.set("limit", String(limit));

  if (memberId !== null) {
    params.set("member_id", String(validatePositiveId(memberId, "member id")));
  }

  return request(`/attendance?${params.toString()}`);
}

export function getTodayAttendance() {
  return request("/attendance/today");
}

export function getAttendanceByDate(date) {
  const safeDate = validateDate(date);

  return request(`/attendance/date/${encodeURIComponent(safeDate)}`);
}

export function getAttendanceCalendar(startDate, endDate) {
  const start = validateDate(startDate);

  const end = validateDate(endDate);

  const params = new URLSearchParams({
    start_date: start,

    end_date: end,
  });

  return request(`/attendance/calendar?${params.toString()}`);
}

export function recordAttendance(memberId, status) {
  const id = validatePositiveId(memberId, "member id");

  const safeStatus = validateStatus(status);

  /*
   * فقط member_id و status.
   * Date/Time توسط Backend.
   */
  return request("/attendance", {
    method: "POST",

    body: {
      member_id: id,

      status: safeStatus,
    },
  });
}

export function updateAttendance(attendanceId, status) {
  const id = validatePositiveId(attendanceId, "attendance id");

  const safeStatus = validateStatus(status);

  return request(`/attendance/${id}`, {
    method: "PUT",

    body: {
      status: safeStatus,
    },
  });
}

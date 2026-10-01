import { getToken } from "../auth/auth-storage.js";

const API_URL = "http://127.0.0.1:8000/api";

export class MembersApiError extends Error {
  constructor(message, { status = 0, code = "UNKNOWN_ERROR" } = {}) {
    super(message);

    this.name = "MembersApiError";

    this.status = status;

    this.code = code;
  }
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
  } catch (error) {
    return null;
  }
}

function getErrorMessage(status, data) {
  if (typeof data?.detail === "string") {
    return data.detail;
  }

  switch (status) {
    case 400:
      return "اطلاعات ارسال‌شده صحیح نیست.";

    case 401:
      return "نشست کاربری منقضی شده است.";

    case 403:
      return "اجازه انجام این عملیات را ندارید.";

    case 404:
      return "عضو موردنظر پیدا نشد.";

    case 422:
      return "اطلاعات واردشده معتبر نیست.";

    default:
      return "خطایی در ارتباط با سرور رخ داد.";
  }
}

async function request(path, { method = "GET", body } = {}) {
  const token = getToken();

  if (!token) {
    throw new MembersApiError("نشست کاربری معتبر نیست.", {
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
    throw new MembersApiError("ارتباط با سرور برقرار نشد.", {
      code: "NETWORK_ERROR",
    });
  }

  const data = await parseResponse(response);

  if (!response.ok) {
    throw new MembersApiError(getErrorMessage(response.status, data), {
      status: response.status,

      code: `HTTP_${response.status}`,
    });
  }

  return data;
}

function validateMemberId(memberId) {
  const id = Number(memberId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError("Invalid member id");
  }

  return id;
}

export function getMembers() {
  return request("/members?skip=0&limit=500");
}

export function createMember(data) {
  return request("/members", {
    method: "POST",

    body: data,
  });
}

export function updateMember(memberId, data) {
  const id = validateMemberId(memberId);

  return request(`/members/${id}`, {
    method: "PUT",

    body: data,
  });
}

export function deleteMember(memberId) {
  const id = validateMemberId(memberId);

  return request(`/members/${id}`, {
    method: "DELETE",
  });
}

import { setMembersViewState } from "./view-state.js";

const numberFormatter = new Intl.NumberFormat("fa-IR");

const STATUS_CONFIG = {
  present: {
    label: "حاضر",

    badgeClass: "bg-eucalyptus/10 text-eucalyptus",
  },

  absent: {
    label: "غایب",

    badgeClass: "bg-alizarin-crimson/10 text-alizarin-crimson",
  },

  unrecorded: {
    label: "ثبت نشده",

    badgeClass: "bg-french-gray/20 text-mirage/45",
  },
};

/* ======================================================
   Helpers
====================================================== */

function createElement(tagName, className = "") {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  return element;
}

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function toPersianDigits(value) {
  return String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

function formatRecordedTime(value) {
  if (!value) {
    return "—";
  }

  return toPersianDigits(String(value).slice(0, 5));
}

function getFullName(member) {
  return (
    [member?.first_name, member?.last_name].filter(Boolean).join(" ").trim() ||
    "بدون نام"
  );
}

function getMemberStatus(member) {
  if (member?.today_status === "present") {
    return "present";
  }

  if (member?.today_status === "absent") {
    return "absent";
  }

  return "unrecorded";
}

/* ======================================================
   Statistics
====================================================== */

function createStatItem(label, value, valueClass = "text-mirage") {
  const item = createElement("div", "rounded-xl bg-alabaster px-3 py-3");

  const title = createElement("p", "text-[11px] font-medium text-mirage/40");

  title.textContent = label;

  const count = createElement("p", `mt-1 text-base font-black ${valueClass}`);

  count.textContent = formatNumber(value);

  item.append(title, count);

  return item;
}

/* ======================================================
   Card
====================================================== */

export function createMemberCard(member) {
  const status = getMemberStatus(member);

  const statusConfig = STATUS_CONFIG[status];

  /*
   * Design اصلی کارت:
   * همیشه سفید و خنثی.
   */
  const card = createElement(
    "article",
    [
      "relative",
      "overflow-hidden",
      "rounded-2xl",
      "border",
      "border-french-gray/30",
      "bg-white",
      "p-5",
      "shadow-sm",
      "transition-shadow",
      "duration-300",
      "hover:shadow-md",
    ].join(" "),
  );

  card.dataset.memberId = String(member.id);

  /* Header */

  const header = createElement(
    "div",
    "relative z-10 flex items-start justify-between gap-4",
  );

  const identity = createElement("div", "min-w-0");

  const name = createElement("h3", "truncate text-base font-black text-mirage");

  name.textContent = getFullName(member);

  const phone = createElement("p", "mt-1.5 text-xs text-mirage/45");

  phone.dir = "ltr";

  phone.textContent = member.phone || "بدون شماره تماس";

  identity.append(name, phone);

  const badge = createElement(
    "span",
    [
      "shrink-0",
      "rounded-lg",
      "px-3",
      "py-1.5",
      "text-[11px]",
      "font-black",
      statusConfig.badgeClass,
    ].join(" "),
  );

  badge.textContent = statusConfig.label;

  header.append(identity, badge);

  card.appendChild(header);

  /* Today */

  const todayInfo = createElement(
    "div",
    [
      "relative",
      "z-10",
      "mt-4",
      "flex",
      "items-center",
      "justify-between",
      "rounded-xl",
      "border",
      "border-french-gray/20",
      "bg-white",
      "px-3.5",
      "py-3",
    ].join(" "),
  );

  const todayStatusBox = createElement("div");

  const todayTitle = createElement(
    "p",
    "text-[10px] font-medium text-mirage/40",
  );

  todayTitle.textContent = "وضعیت امروز";

  const todayValue = createElement(
    "p",
    "mt-1 text-xs font-black text-mirage/70",
  );

  todayValue.textContent = statusConfig.label;

  todayStatusBox.append(todayTitle, todayValue);

  const timeBox = createElement("div", "text-left");

  const timeTitle = createElement(
    "p",
    "text-[10px] font-medium text-mirage/40",
  );

  timeTitle.textContent = "ساعت ثبت";

  const timeValue = createElement(
    "p",
    "mt-1 text-xs font-black text-mirage/70",
  );

  timeValue.textContent = member.recorded_time
    ? formatRecordedTime(member.recorded_time)
    : "—";

  timeBox.append(timeTitle, timeValue);

  todayInfo.append(todayStatusBox, timeBox);

  card.appendChild(todayInfo);

  /* Statistics */

  const stats = createElement(
    "div",
    "relative z-10 mt-4 grid grid-cols-2 gap-2",
  );

  stats.append(
    createStatItem("کل حضور", member.total_present, "text-eucalyptus"),

    createStatItem("کل غیبت", member.total_absent, "text-alizarin-crimson"),

    createStatItem("حضور این ماه", member.monthly_present, "text-eucalyptus"),

    createStatItem(
      "غیبت این ماه",
      member.monthly_absent,
      "text-alizarin-crimson",
    ),
  );

  card.appendChild(stats);

  return card;
}

/* ======================================================
   Render
====================================================== */

export function renderMembers(members) {
  const container = document.getElementById("attendanceMembers");

  const count = document.getElementById("attendanceMembersCountValue");

  if (!container) {
    return;
  }

  const safeMembers = Array.isArray(members) ? members : [];

  if (count) {
    count.textContent = formatNumber(safeMembers.length);
  }

  container.innerHTML = "";

  if (safeMembers.length === 0) {
    setMembersViewState("empty");

    return;
  }

  safeMembers.forEach((member) => {
    container.appendChild(createMemberCard(member));
  });

  setMembersViewState("ready");
}

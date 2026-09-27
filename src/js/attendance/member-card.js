import { setMembersViewState } from "./view-state.js";

const numberFormatter = new Intl.NumberFormat("fa-IR");

const STATUS_CONFIG = {
  present: {
    label: "حاضر",
    dotClass: "bg-eucalyptus",
    badgeClass: "bg-eucalyptus/10 text-eucalyptus ring-eucalyptus/15",
  },

  absent: {
    label: "غایب",
    dotClass: "bg-alizarin-crimson",
    badgeClass:
      "bg-alizarin-crimson/10 text-alizarin-crimson ring-alizarin-crimson/15",
  },

  unrecorded: {
    label: "ثبت نشده",
    dotClass: "bg-french-gray",
    badgeClass: "bg-french-gray/15 text-mirage/55 ring-french-gray/20",
  },
};

function normalizeStatus(status) {
  if (status === "present" || status === "absent") {
    return status;
  }

  return "unrecorded";
}

function formatCount(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return "۰";
  }

  return numberFormatter.format(parsed);
}

function getMemberFullName(member) {
  return (
    [member?.first_name, member?.last_name].filter(Boolean).join(" ").trim() ||
    "بدون نام"
  );
}

function getMemberInitial(member) {
  const fullName = getMemberFullName(member);

  return fullName.charAt(0).toUpperCase();
}

function createElement(tagName, className = "") {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  return element;
}

function createStatusBadge(status) {
  const normalizedStatus = normalizeStatus(status);

  const config = STATUS_CONFIG[normalizedStatus];

  const badge = createElement(
    "div",
    [
      "inline-flex",
      "items-center",
      "gap-2",
      "rounded-lg",
      "px-2.5",
      "py-1.5",
      "text-[11px]",
      "font-bold",
      "ring-1",
      "ring-inset",
      config.badgeClass,
    ].join(" "),
  );

  const dot = createElement(
    "span",
    ["h-1.5", "w-1.5", "shrink-0", "rounded-full", config.dotClass].join(" "),
  );

  const text = createElement("span");

  text.textContent = config.label;

  badge.append(dot, text);

  return badge;
}

function createStatItem(label, value, type = "neutral") {
  const wrapper = createElement("div", "rounded-xl bg-alabaster px-3 py-3");

  const labelElement = createElement(
    "p",
    "text-[11px] font-medium text-mirage/40",
  );

  labelElement.textContent = label;

  const valueElement = createElement(
    "p",
    [
      "mt-1.5",
      "text-lg",
      "font-black",

      type === "present" ? "text-eucalyptus" : "",

      type === "absent" ? "text-alizarin-crimson" : "",

      type === "neutral" ? "text-mirage" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

  valueElement.textContent = formatCount(value);

  wrapper.append(labelElement, valueElement);

  return wrapper;
}

function createAttendanceButton({ status, currentStatus }) {
  const isPresent = status === "present";

  const isActive = currentStatus === status;

  const button = createElement(
    "button",
    [
      "group",
      "flex",
      "h-11",
      "flex-1",
      "items-center",
      "justify-center",
      "gap-2",
      "rounded-xl",
      "text-sm",
      "font-bold",
      "transition-all",
      "duration-200",
      "disabled:cursor-not-allowed",
      "disabled:opacity-60",

      isPresent && isActive ? "bg-eucalyptus text-white shadow-sm" : "",

      isPresent && !isActive
        ? "border border-eucalyptus/20 bg-eucalyptus/5 text-eucalyptus hover:bg-eucalyptus hover:text-white"
        : "",

      !isPresent && isActive ? "bg-alizarin-crimson text-white shadow-sm" : "",

      !isPresent && !isActive
        ? "border border-alizarin-crimson/20 bg-alizarin-crimson/5 text-alizarin-crimson hover:bg-alizarin-crimson hover:text-white"
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

  button.type = "button";

  button.dataset.attendanceStatus = status;

  const icon = createElement("span", "text-base leading-none");

  icon.textContent = isPresent ? "✓" : "×";

  const label = createElement("span");

  label.dataset.buttonLabel = "true";

  label.textContent = isPresent ? "ورود" : "غیبت";

  button.append(icon, label);

  return button;
}

function createFeedbackElement() {
  const feedback = createElement(
    "div",
    [
      "hidden",
      "items-center",
      "justify-between",
      "gap-3",
      "rounded-xl",
      "px-3",
      "py-2.5",
      "text-xs",
      "font-semibold",
    ].join(" "),
  );

  feedback.dataset.memberFeedback = "true";

  feedback.setAttribute("role", "status");

  feedback.setAttribute("aria-live", "polite");

  const message = createElement("span");

  message.dataset.feedbackMessage = "true";

  const time = createElement(
    "span",
    "shrink-0 font-mono text-[11px] opacity-70",
  );

  time.dataset.feedbackTime = "true";

  feedback.append(message, time);

  return feedback;
}

export function createMemberCard(member, { onAttendanceAction } = {}) {
  const currentStatus = normalizeStatus(member?.today_status);

  const card = createElement(
    "article",
    [
      "group",
      "relative",
      "overflow-hidden",
      "rounded-2xl",
      "border",
      "border-french-gray/30",
      "bg-white",
      "shadow-sm",
      "transition-all",
      "duration-300",
      "hover:-translate-y-0.5",
      "hover:shadow-md",
    ].join(" "),
  );

  card.dataset.memberId = String(member.id);

  /*
   * Header
   */
  const header = createElement(
    "div",
    "flex items-start justify-between gap-4 p-5 pb-4",
  );

  const person = createElement("div", "flex min-w-0 items-center gap-3.5");

  const avatar = createElement(
    "div",
    [
      "flex",
      "h-11",
      "w-11",
      "shrink-0",
      "items-center",
      "justify-center",
      "rounded-xl",
      "bg-mirage",
      "text-base",
      "font-black",
      "text-white",
    ].join(" "),
  );

  avatar.textContent = getMemberInitial(member);

  const identity = createElement("div", "min-w-0");

  const name = createElement("h3", "truncate text-sm font-black text-mirage");

  name.textContent = getMemberFullName(member);

  const phone = createElement("p", "mt-1 truncate text-xs text-mirage/40");

  phone.dir = "ltr";

  phone.textContent = member?.phone || "شماره تماس ثبت نشده";

  identity.append(name, phone);

  person.append(avatar, identity);

  header.append(person, createStatusBadge(currentStatus));

  /*
   * Today status
   */
  const todaySection = createElement(
    "div",
    "mx-5 rounded-xl border border-french-gray/25 bg-alabaster px-4 py-3",
  );

  const todayRow = createElement(
    "div",
    "flex items-center justify-between gap-3",
  );

  const todayLabel = createElement(
    "span",
    "text-xs font-medium text-mirage/45",
  );

  todayLabel.textContent = "وضعیت امروز";

  const todayValue = createElement("span", "text-xs font-bold text-mirage");

  todayValue.textContent = STATUS_CONFIG[currentStatus].label;

  todayRow.append(todayLabel, todayValue);

  todaySection.append(todayRow);

  if (member?.recorded_time && currentStatus !== "unrecorded") {
    const timeRow = createElement(
      "div",
      "mt-2 flex items-center justify-between border-t border-french-gray/20 pt-2",
    );

    const timeLabel = createElement("span", "text-[11px] text-mirage/35");

    timeLabel.textContent = "زمان ثبت";

    const recordedTime = createElement(
      "span",
      "font-mono text-[11px] font-semibold text-mirage/55",
    );

    recordedTime.dir = "ltr";

    recordedTime.textContent = member.recorded_time;

    timeRow.append(timeLabel, recordedTime);

    todaySection.append(timeRow);
  }

  /*
   * Actions
   */
  const actions = createElement("div", "flex gap-2 px-5 pt-4");

  const presentButton = createAttendanceButton({
    status: "present",
    currentStatus,
  });

  const absentButton = createAttendanceButton({
    status: "absent",
    currentStatus,
  });

  actions.append(presentButton, absentButton);

  /*
   * Feedback
   */
  const feedbackWrapper = createElement("div", "px-5 pt-3");

  feedbackWrapper.append(createFeedbackElement());

  /*
   * Statistics
   */
  const statistics = createElement("div", "grid grid-cols-2 gap-2 p-5 pt-4");

  statistics.append(
    createStatItem("کل حضور", member?.total_present, "present"),

    createStatItem("کل غیبت", member?.total_absent, "absent"),

    createStatItem("حضور این ماه", member?.monthly_present, "present"),

    createStatItem("غیبت این ماه", member?.monthly_absent, "absent"),
  );

  /*
   * Button events
   */
  [presentButton, absentButton].forEach((button) => {
    button.addEventListener("click", async () => {
      if (typeof onAttendanceAction !== "function") {
        return;
      }

      const status = button.dataset.attendanceStatus;

      await onAttendanceAction({
        memberId: member.id,

        status,

        card,
      });
    });
  });

  card.append(header, todaySection, actions, feedbackWrapper, statistics);

  return card;
}

export function renderMembers(members, { onAttendanceAction } = {}) {
  const container = document.getElementById("attendanceMembers");

  const countElement = document.getElementById("attendanceMembersCountValue");

  if (!container) {
    console.error("Attendance members container not found");

    return;
  }

  const normalizedMembers = Array.isArray(members) ? members : [];

  container.innerHTML = "";

  if (countElement) {
    countElement.textContent = formatCount(normalizedMembers.length);
  }

  if (normalizedMembers.length === 0) {
    setMembersViewState("empty");

    return;
  }

  setMembersViewState("ready");

  container.classList.remove("hidden");

  if (emptyState) {
    emptyState.classList.add("hidden");
  }

  normalizedMembers.forEach((member) => {
    container.appendChild(
      createMemberCard(member, {
        onAttendanceAction,
      }),
    );
  });
}

export function setMemberCardPending(memberId, status, isPending = true) {
  const card = document.querySelector(`[data-member-id="${memberId}"]`);

  if (!card) {
    return;
  }

  const buttons = card.querySelectorAll("[data-attendance-status]");

  buttons.forEach((button) => {
    button.disabled = isPending;

    const label = button.querySelector("[data-button-label]");

    if (!label) {
      return;
    }

    if (isPending && button.dataset.attendanceStatus === status) {
      label.textContent = "در حال ثبت...";
    } else {
      label.textContent =
        button.dataset.attendanceStatus === "present" ? "ورود" : "غیبت";
    }
  });

  card.classList.toggle("opacity-80", isPending);
}

export function showMemberCardFeedback(
  memberId,
  { type = "success", message = "", time = "" } = {},
) {
  const card = document.querySelector(`[data-member-id="${memberId}"]`);

  if (!card) {
    return;
  }

  const feedback = card.querySelector("[data-member-feedback]");

  const messageElement = card.querySelector("[data-feedback-message]");

  const timeElement = card.querySelector("[data-feedback-time]");

  if (!feedback || !messageElement || !timeElement) {
    return;
  }

  feedback.className = [
    "flex",
    "items-center",
    "justify-between",
    "gap-3",
    "rounded-xl",
    "px-3",
    "py-2.5",
    "text-xs",
    "font-semibold",

    type === "success"
      ? "bg-eucalyptus/10 text-eucalyptus"
      : "bg-alizarin-crimson/10 text-alizarin-crimson",
  ].join(" ");

  messageElement.textContent = message;

  timeElement.textContent = time || "";
}

export function replaceMemberCard(member, { onAttendanceAction } = {}) {
  const oldCard = document.querySelector(`[data-member-id="${member.id}"]`);

  if (!oldCard) {
    return;
  }

  const newCard = createMemberCard(member, {
    onAttendanceAction,
  });

  oldCard.replaceWith(newCard);
}

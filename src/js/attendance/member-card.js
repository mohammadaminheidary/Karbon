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

export function createMemberCard(member, { onAttendanceAction } = {}) {
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

  /* Actions */

  const actions = createElement(
    "div",
    "relative z-30 mt-4 grid grid-cols-2 gap-2",
  );

  const presentButton = createElement(
    "button",
    [
      "h-10",
      "rounded-xl",
      "text-xs",
      "font-black",
      "transition-all",
      "duration-200",
      "active:scale-[0.97]",

      status === "present"
        ? "bg-eucalyptus text-white"
        : "bg-eucalyptus/10 text-eucalyptus hover:bg-eucalyptus hover:text-white",
    ].join(" "),
  );

  presentButton.type = "button";

  presentButton.dataset.attendanceAction = "present";

  presentButton.textContent = "حاضر";

  const absentButton = createElement(
    "button",
    [
      "h-10",
      "rounded-xl",
      "text-xs",
      "font-black",
      "transition-all",
      "duration-200",
      "active:scale-[0.97]",

      status === "absent"
        ? "bg-alizarin-crimson text-white"
        : "bg-alizarin-crimson/10 text-alizarin-crimson hover:bg-alizarin-crimson hover:text-white",
    ].join(" "),
  );

  absentButton.type = "button";

  absentButton.dataset.attendanceAction = "absent";

  absentButton.textContent = "غایب";

  actions.append(presentButton, absentButton);

  card.appendChild(actions);

  /* Events */

  const handleAction = async (attendanceStatus) => {
    if (typeof onAttendanceAction !== "function") {
      return;
    }

    await onAttendanceAction({
      memberId: member.id,

      status: attendanceStatus,

      card,
    });
  };

  presentButton.addEventListener("click", () => {
    handleAction("present");
  });

  absentButton.addEventListener("click", () => {
    handleAction("absent");
  });

  return card;
}

/* ======================================================
   Render
====================================================== */

export function renderMembers(members, { onAttendanceAction } = {}) {
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
    container.appendChild(
      createMemberCard(member, {
        onAttendanceAction,
      }),
    );
  });

  setMembersViewState("ready");
}

/* ======================================================
   Pending
====================================================== */

export function setMemberCardPending(card, pending) {
  if (!card) {
    return;
  }

  card.querySelectorAll("[data-attendance-action]").forEach((button) => {
    button.disabled = pending;

    button.style.opacity = pending ? "0.55" : "1";

    button.style.cursor = pending ? "wait" : "";
  });
}

/* ======================================================
   Replace
====================================================== */

export function replaceMemberCard(
  oldCard,
  member,
  { onAttendanceAction } = {},
) {
  if (!oldCard) {
    return null;
  }

  const newCard = createMemberCard(member, {
    onAttendanceAction,
  });

  oldCard.replaceWith(newCard);

  return newCard;
}

/* ======================================================
   Guaranteed Button Reaction Animation
====================================================== */

export function animateMemberCardStatus(card, status) {
  if (!card || (status !== "present" && status !== "absent")) {
    return;
  }

  const button = card.querySelector(`[data-attendance-action="${status}"]`);

  if (!button) {
    return;
  }

  const cardRect = card.getBoundingClientRect();

  const buttonRect = button.getBoundingClientRect();

  const centerX = buttonRect.left - cardRect.left + buttonRect.width / 2;

  const centerY = buttonRect.top - cardRect.top + buttonRect.height / 2;

  const color = status === "present" ? "22, 163, 74" : "220, 38, 38";

  /*
   * Layer کاملاً مستقل از Tailwind.
   */
  const effectLayer = document.createElement("div");

  Object.assign(effectLayer.style, {
    position: "absolute",

    inset: "0",

    overflow: "hidden",

    pointerEvents: "none",

    zIndex: "20",
  });

  const size = Math.max(cardRect.width * 0.9, 300);

  const glow = document.createElement("div");

  Object.assign(glow.style, {
    position: "absolute",

    width: `${size}px`,

    height: `${size}px`,

    left: `${centerX - size / 2}px`,

    top: `${centerY - size / 2}px`,

    borderRadius: "9999px",

    opacity: "0",

    background: `radial-gradient(
          circle,
          rgba(${color}, 0.42) 0%,
          rgba(${color}, 0.22) 32%,
          rgba(${color}, 0.08) 52%,
          rgba(${color}, 0) 72%
        )`,

    transform: "scale(0.08)",
  });

  effectLayer.appendChild(glow);

  card.appendChild(effectLayer);

  /*
   * خود دکمه یک Punch کوچک دارد.
   */
  button.animate(
    [
      {
        transform: "scale(1)",
      },

      {
        transform: "scale(0.92)",
        offset: 0.18,
      },

      {
        transform: "scale(1.08)",
        offset: 0.45,
      },

      {
        transform: "scale(1)",
      },
    ],
    {
      duration: 520,

      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  );

  /*
   * موج از دقیقاً زیر همان دکمه
   * شروع می‌شود و بالا می‌آید.
   */
  const animation = glow.animate(
    [
      {
        opacity: 0,

        transform: "scale(0.08) translateY(25px)",
      },

      {
        opacity: 1,

        transform: "scale(0.55) translateY(5px)",

        offset: 0.22,
      },

      {
        opacity: 0.7,

        transform: "scale(1.2) translateY(-35px)",

        offset: 0.56,
      },

      {
        opacity: 0,

        transform: "scale(1.9) translateY(-100px)",
      },
    ],
    {
      duration: 1150,

      easing: "cubic-bezier(0.16, 1, 0.3, 1)",

      fill: "forwards",
    },
  );

  animation.onfinish = () => {
    effectLayer.remove();
  };
}

/*
 * برای Compatibility با Importهای قدیمی.
 * دیگر پیام موفقیت داخل Card نداریم.
 */
export function showMemberCardFeedback() {
  return;
}

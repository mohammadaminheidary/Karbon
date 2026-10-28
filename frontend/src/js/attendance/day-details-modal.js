const persianDateFormatter = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/* ======================================================
   Helpers
====================================================== */

function parseLocalDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);

  return new Date(year, month - 1, day);
}

function formatDate(dateKey) {
  try {
    return persianDateFormatter.format(parseLocalDateKey(dateKey));
  } catch {
    return dateKey;
  }
}

function formatTime(value) {
  if (!value) {
    return "—";
  }

  return String(value)
    .slice(0, 5)
    .replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

function createElement(tag, className = "") {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  return element;
}

/* ======================================================
   Modal Creation
====================================================== */

function ensureModal() {
  let modal = document.getElementById("attendanceDayDetailsModal");

  if (modal) {
    return modal;
  }

  /* Root */

  modal = createElement("div");

  modal.id = "attendanceDayDetailsModal";

  Object.assign(modal.style, {
    position: "fixed",
    inset: "0",
    zIndex: "99990",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    isolation: "isolate",
  });

  /* Backdrop */

  const backdrop = createElement("div");

  backdrop.dataset.dayModalBackdrop = "true";

  Object.assign(backdrop.style, {
    position: "absolute",
    inset: "0",
    zIndex: "99991",
    background: "rgba(15, 23, 42, 0.58)",
    backdropFilter: "blur(3px)",
    WebkitBackdropFilter: "blur(3px)",
  });

  /* Dialog */

  const dialog = createElement(
    "div",
    [
      "w-full",
      "max-w-2xl",
      "overflow-hidden",
      "rounded-3xl",
      "bg-white",
      "shadow-2xl",
    ].join(" "),
  );

  Object.assign(dialog.style, {
    position: "relative",
    zIndex: "99992",
    maxHeight: "calc(100vh - 48px)",
  });

  dialog.setAttribute("role", "dialog");

  dialog.setAttribute("aria-modal", "true");

  /* Header */

  const header = createElement(
    "div",
    "flex items-start justify-between border-b border-french-gray/25 px-6 py-5",
  );

  const headerText = createElement("div");

  const eyebrow = createElement("p", "text-[11px] font-bold text-mirage/35");

  eyebrow.textContent = "جزئیات حضور و غیاب";

  const title = createElement("h2", "mt-1 text-lg font-black text-mirage");

  title.id = "attendanceDayModalTitle";

  headerText.append(eyebrow, title);

  const closeButton = createElement(
    "button",
    "flex h-9 w-9 items-center justify-center rounded-xl bg-alabaster text-xl text-mirage/45 transition-colors hover:text-mirage",
  );

  closeButton.type = "button";

  closeButton.setAttribute("aria-label", "بستن");

  closeButton.textContent = "×";

  closeButton.addEventListener("click", closeDayDetailsModal);

  header.append(headerText, closeButton);

  /* Content */

  const content = createElement("div", "overflow-y-auto p-6");

  content.id = "attendanceDayModalContent";

  content.style.maxHeight = "calc(100vh - 150px)";

  dialog.append(header, content);

  modal.append(backdrop, dialog);

  /* Events */

  backdrop.addEventListener("click", closeDayDetailsModal);

  dialog.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  document.body.appendChild(modal);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.style.display !== "none") {
      closeDayDetailsModal();
    }
  });

  return modal;
}

/* ======================================================
   Open / Close
====================================================== */

export function openDayDetailsModal() {
  const modal = ensureModal();

  modal.style.display = "flex";

  document.body.classList.add("overflow-hidden");

  /* Entry animation */

  const dialog = modal.querySelector('[role="dialog"]');

  dialog?.animate(
    [
      {
        opacity: 0,
        transform: "translateY(18px) scale(0.97)",
      },
      {
        opacity: 1,
        transform: "translateY(0) scale(1)",
      },
    ],
    {
      duration: 260,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  );
}

export function closeDayDetailsModal() {
  const modal = document.getElementById("attendanceDayDetailsModal");

  if (!modal) {
    return;
  }

  modal.style.display = "none";

  document.body.classList.remove("overflow-hidden");
}

/* ======================================================
   State Preparation
====================================================== */

function prepare(dateKey) {
  ensureModal();

  const title = document.getElementById("attendanceDayModalTitle");

  const content = document.getElementById("attendanceDayModalContent");

  if (title) {
    title.textContent = formatDate(dateKey);
  }

  return content;
}

/* ======================================================
   Loading
====================================================== */

export function setDayDetailsLoading(dateKey) {
  const content = prepare(dateKey);

  if (!content) {
    return;
  }

  content.innerHTML = "";

  const wrapper = createElement(
    "div",
    "flex min-h-52 items-center justify-center",
  );

  const inner = createElement("div", "text-center");

  const spinner = createElement(
    "div",
    "mx-auto h-8 w-8 animate-spin rounded-full border-[3px] border-persian-blue/15 border-t-persian-blue",
  );

  const text = createElement("p", "mt-4 text-sm font-bold text-mirage");

  text.textContent = "در حال دریافت اطلاعات...";

  inner.append(spinner, text);

  wrapper.appendChild(inner);

  content.appendChild(wrapper);

  openDayDetailsModal();
}

/* ======================================================
   Empty
====================================================== */

export function setDayDetailsEmpty(dateKey) {
  const content = prepare(dateKey);

  if (!content) {
    return;
  }

  content.innerHTML = "";

  const wrapper = createElement(
    "div",
    "flex min-h-52 items-center justify-center text-center",
  );

  const inner = createElement("div");

  const icon = createElement(
    "div",
    "mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-alabaster text-xl text-mirage/35",
  );

  icon.textContent = "—";

  const title = createElement("p", "mt-4 text-sm font-black text-mirage");

  title.textContent = "رکوردی برای این روز وجود ندارد";

  const description = createElement("p", "mt-2 text-xs text-mirage/40");

  description.textContent = "برای این تاریخ حضور یا غیبتی ثبت نشده است.";

  inner.append(icon, title, description);

  wrapper.appendChild(inner);

  content.appendChild(wrapper);

  openDayDetailsModal();
}

/* ======================================================
   Error
====================================================== */

export function setDayDetailsError(dateKey) {
  const content = prepare(dateKey);

  if (!content) {
    return;
  }

  content.innerHTML = "";

  const wrapper = createElement(
    "div",
    "flex min-h-52 items-center justify-center text-center",
  );

  const inner = createElement("div");

  const icon = createElement(
    "div",
    "mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-alizarin-crimson/10 font-black text-alizarin-crimson",
  );

  icon.textContent = "!";

  const title = createElement("p", "mt-4 text-sm font-black text-mirage");

  title.textContent = "دریافت اطلاعات انجام نشد";

  const description = createElement("p", "mt-2 text-xs text-mirage/40");

  description.textContent = "لطفاً دوباره تلاش کنید.";

  inner.append(icon, title, description);

  wrapper.appendChild(inner);

  content.appendChild(wrapper);

  openDayDetailsModal();
}

/* ======================================================
   Member Row
====================================================== */

function createMemberRow(member, type) {
  const row = createElement(
    "div",
    "flex items-center justify-between gap-4 rounded-xl bg-alabaster px-4 py-3",
  );

  const info = createElement("div", "min-w-0");

  const name = createElement("p", "truncate text-sm font-black text-mirage");

  name.textContent = [member.first_name, member.last_name]
    .filter(Boolean)
    .join(" ");

  const phone = createElement("p", "mt-1 text-[11px] text-mirage/40");

  phone.textContent = member.phone || "بدون شماره تماس";

  info.append(name, phone);

  const statusBox = createElement("div", "shrink-0 text-left");

  const status = createElement(
    "span",
    [
      "rounded-lg",
      "px-2.5",
      "py-1.5",
      "text-[10px]",
      "font-black",

      type === "present"
        ? "bg-eucalyptus/10 text-eucalyptus"
        : "bg-alizarin-crimson/10 text-alizarin-crimson",
    ].join(" "),
  );

  status.textContent = type === "present" ? "حاضر" : "غایب";

  const time = createElement("p", "mt-2 text-[11px] font-bold text-mirage/45");

  time.textContent = formatTime(member.recorded_time);

  statusBox.append(status, time);

  row.append(info, statusBox);

  return row;
}

/* ======================================================
   Members Section
====================================================== */

function createMembersSection(title, members, type) {
  const section = createElement("section");

  const header = createElement("div", "mb-3 flex items-center justify-between");

  const heading = createElement("h3", "text-sm font-black text-mirage");

  heading.textContent = title;

  const count = createElement(
    "span",
    "rounded-lg bg-alabaster px-2.5 py-1 text-xs font-black text-mirage/50",
  );

  count.textContent = new Intl.NumberFormat("fa-IR").format(members.length);

  header.append(heading, count);

  section.appendChild(header);

  const list = createElement("div", "space-y-2");

  if (members.length === 0) {
    const empty = createElement(
      "div",
      "rounded-xl border border-dashed border-french-gray/35 px-4 py-5 text-center text-xs text-mirage/35",
    );

    empty.textContent =
      type === "present"
        ? "عضو حاضری ثبت نشده است."
        : "عضو غایبی ثبت نشده است.";

    list.appendChild(empty);
  } else {
    members.forEach((member) => {
      list.appendChild(createMemberRow(member, type));
    });
  }

  section.appendChild(list);

  return section;
}

/* ======================================================
   Data
====================================================== */

export function setDayDetailsData(data) {
  const dateKey = data?.date;

  const content = prepare(dateKey);

  if (!content) {
    return;
  }

  const present = Array.isArray(data?.present) ? data.present : [];

  const absent = Array.isArray(data?.absent) ? data.absent : [];

  content.innerHTML = "";

  const summary = createElement("div", "mb-6 grid grid-cols-2 gap-3");

  const presentSummary = createElement(
    "div",
    "rounded-2xl bg-eucalyptus/10 p-4",
  );

  const presentLabel = createElement("p", "text-xs font-bold text-eucalyptus");

  presentLabel.textContent = "تعداد حاضرها";

  const presentCount = createElement(
    "p",
    "mt-1 text-2xl font-black text-eucalyptus",
  );

  presentCount.textContent = new Intl.NumberFormat("fa-IR").format(
    present.length,
  );

  presentSummary.append(presentLabel, presentCount);

  const absentSummary = createElement(
    "div",
    "rounded-2xl bg-alizarin-crimson/10 p-4",
  );

  const absentLabel = createElement(
    "p",
    "text-xs font-bold text-alizarin-crimson",
  );

  absentLabel.textContent = "تعداد غایب‌ها";

  const absentCount = createElement(
    "p",
    "mt-1 text-2xl font-black text-alizarin-crimson",
  );

  absentCount.textContent = new Intl.NumberFormat("fa-IR").format(
    absent.length,
  );

  absentSummary.append(absentLabel, absentCount);

  summary.append(presentSummary, absentSummary);

  const grid = createElement("div", "grid grid-cols-1 gap-6 md:grid-cols-2");

  grid.append(
    createMembersSection("حاضرها", present, "present"),

    createMembersSection("غایب‌ها", absent, "absent"),
  );

  content.append(summary, grid);

  openDayDetailsModal();
}

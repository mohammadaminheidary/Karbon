let modalElements = null;

function createElement(tagName, className = "") {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  return element;
}

function getMemberName(member) {
  if (typeof member === "string") {
    return member;
  }

  return (
    [member?.first_name, member?.last_name].filter(Boolean).join(" ").trim() ||
    "بدون نام"
  );
}

function ensureModal() {
  if (modalElements) {
    return modalElements;
  }

  const root = createElement(
    "div",
    [
      "fixed",
      "inset-0",
      "z-[100]",
      "hidden",
      "items-center",
      "justify-center",
      "p-4",
      "sm:p-6",
    ].join(" "),
  );

  root.id = "attendanceDayModal";

  root.setAttribute("role", "dialog");

  root.setAttribute("aria-modal", "true");

  root.setAttribute("aria-labelledby", "attendanceDayModalTitle");

  const backdrop = createElement(
    "div",
    "absolute inset-0 bg-mirage/45 backdrop-blur-[2px]",
  );

  backdrop.dataset.modalBackdrop = "true";

  const panel = createElement(
    "div",
    [
      "relative",
      "z-10",
      "flex",
      "max-h-[85vh]",
      "w-full",
      "max-w-2xl",
      "flex-col",
      "overflow-hidden",
      "rounded-3xl",
      "border",
      "border-french-gray/30",
      "bg-white",
      "shadow-2xl",
    ].join(" "),
  );

  /*
   * Header
   */
  const header = createElement(
    "div",
    [
      "flex",
      "items-center",
      "justify-between",
      "gap-4",
      "border-b",
      "border-french-gray/25",
      "px-5",
      "py-4",
      "sm:px-6",
    ].join(" "),
  );

  const headerContent = createElement("div");

  const eyebrow = createElement("p", "text-[11px] font-medium text-mirage/40");

  eyebrow.textContent = "جزئیات حضور و غیاب";

  const title = createElement("h2", "mt-1 text-lg font-black text-mirage");

  title.id = "attendanceDayModalTitle";

  title.textContent = "—";

  headerContent.append(eyebrow, title);

  const closeButton = createElement(
    "button",
    [
      "flex",
      "h-9",
      "w-9",
      "shrink-0",
      "items-center",
      "justify-center",
      "rounded-xl",
      "border",
      "border-french-gray/30",
      "bg-white",
      "text-xl",
      "text-mirage/50",
      "transition-colors",
      "hover:bg-alabaster",
      "hover:text-mirage",
    ].join(" "),
  );

  closeButton.type = "button";

  closeButton.setAttribute("aria-label", "بستن");

  closeButton.textContent = "×";

  header.append(headerContent, closeButton);

  /*
   * Body
   */
  const body = createElement("div", "overflow-y-auto p-5 sm:p-6");

  body.dataset.modalBody = "true";

  panel.append(header, body);

  root.append(backdrop, panel);

  document.body.appendChild(root);

  closeButton.addEventListener("click", closeDayDetailsModal);

  backdrop.addEventListener("click", closeDayDetailsModal);

  modalElements = {
    root,
    panel,
    title,
    body,
  };

  return modalElements;
}

function clearBody() {
  const { body } = ensureModal();

  body.innerHTML = "";
}

function createCenteredState({ title, description, type = "neutral" }) {
  const wrapper = createElement(
    "div",
    "flex min-h-52 items-center justify-center text-center",
  );

  const content = createElement("div", "max-w-sm");

  const icon = createElement(
    "div",
    [
      "mx-auto",
      "flex",
      "h-12",
      "w-12",
      "items-center",
      "justify-center",
      "rounded-2xl",
      "text-lg",
      "font-black",

      type === "error" ? "bg-alizarin-crimson/10 text-alizarin-crimson" : "",

      type === "loading" ? "bg-persian-blue/10 text-persian-blue" : "",

      type === "neutral" ? "bg-alabaster text-mirage/45" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (type === "error") {
    icon.textContent = "!";
  } else if (type === "loading") {
    icon.innerHTML = `
      <span
        class="h-5 w-5 animate-spin rounded-full border-2 border-persian-blue/20 border-t-persian-blue"
      ></span>
    `;
  } else {
    icon.textContent = "—";
  }

  const titleElement = createElement(
    "h3",
    "mt-4 text-sm font-black text-mirage",
  );

  titleElement.textContent = title;

  const descriptionElement = createElement(
    "p",
    "mt-2 text-xs leading-6 text-mirage/45",
  );

  descriptionElement.textContent = description;

  content.append(icon, titleElement, descriptionElement);

  wrapper.appendChild(content);

  return wrapper;
}

function createMemberRow(member, status) {
  const row = createElement(
    "div",
    [
      "flex",
      "items-center",
      "justify-between",
      "gap-3",
      "rounded-xl",
      "border",
      "border-french-gray/25",
      "bg-white",
      "px-3",
      "py-3",
    ].join(" "),
  );

  const identity = createElement("div", "flex min-w-0 items-center gap-3");

  const indicator = createElement(
    "span",
    [
      "flex",
      "h-8",
      "w-8",
      "shrink-0",
      "items-center",
      "justify-center",
      "rounded-lg",
      "text-sm",
      "font-black",

      status === "present"
        ? "bg-eucalyptus/10 text-eucalyptus"
        : "bg-alizarin-crimson/10 text-alizarin-crimson",
    ].join(" "),
  );

  indicator.textContent = status === "present" ? "✓" : "×";

  const name = createElement("span", "truncate text-sm font-bold text-mirage");

  name.textContent = getMemberName(member);

  identity.append(indicator, name);

  row.appendChild(identity);

  return row;
}

function createMembersSection({ title, members, status }) {
  const section = createElement("div", "rounded-2xl bg-alabaster p-4");

  const header = createElement(
    "div",
    "mb-3 flex items-center justify-between gap-3",
  );

  const titleElement = createElement("h3", "text-sm font-black text-mirage");

  titleElement.textContent = title;

  const count = createElement(
    ["span"][0],
    [
      "rounded-lg",
      "px-2.5",
      "py-1",
      "text-xs",
      "font-black",

      status === "present"
        ? "bg-eucalyptus/10 text-eucalyptus"
        : "bg-alizarin-crimson/10 text-alizarin-crimson",
    ].join(" "),
  );

  count.textContent = new Intl.NumberFormat("fa-IR").format(members.length);

  header.append(titleElement, count);

  const list = createElement("div", "space-y-2");

  if (members.length === 0) {
    const empty = createElement(
      "div",
      "rounded-xl border border-dashed border-french-gray/40 px-4 py-5 text-center text-xs text-mirage/40",
    );

    empty.textContent =
      status === "present"
        ? "عضو حاضری ثبت نشده است."
        : "عضو غایبی ثبت نشده است.";

    list.appendChild(empty);
  } else {
    members.forEach((member) => {
      list.appendChild(createMemberRow(member, status));
    });
  }

  section.append(header, list);

  return section;
}

export function openDayDetailsModal({ dateLabel } = {}) {
  const { root, title } = ensureModal();

  title.textContent = dateLabel || "جزئیات روز";

  root.classList.remove("hidden");

  root.classList.add("flex");

  document.body.classList.add("overflow-hidden");
}

export function setDayDetailsLoading({ dateLabel } = {}) {
  openDayDetailsModal({
    dateLabel,
  });

  clearBody();

  const { body } = ensureModal();

  body.appendChild(
    createCenteredState({
      title: "در حال دریافت اطلاعات...",

      description: "اطلاعات حضور و غیبت این روز در حال دریافت است.",

      type: "loading",
    }),
  );
}

export function setDayDetailsEmpty({ dateLabel } = {}) {
  openDayDetailsModal({
    dateLabel,
  });

  clearBody();

  const { body } = ensureModal();

  body.appendChild(
    createCenteredState({
      title: "اطلاعاتی برای این روز وجود ندارد",

      description:
        "پس از اتصال Frontend به Backend، اطلاعات ثبت‌شده این روز در این قسمت نمایش داده می‌شود.",

      type: "neutral",
    }),
  );
}

export function setDayDetailsError({
  dateLabel,
  message = "خطایی در دریافت اطلاعات رخ داد.",
} = {}) {
  openDayDetailsModal({
    dateLabel,
  });

  clearBody();

  const { body } = ensureModal();

  body.appendChild(
    createCenteredState({
      title: "دریافت اطلاعات انجام نشد",

      description: message,

      type: "error",
    }),
  );
}

export function setDayDetailsData({
  dateLabel,
  present = [],
  absent = [],
} = {}) {
  openDayDetailsModal({
    dateLabel,
  });

  clearBody();

  const { body } = ensureModal();

  const grid = createElement("grid grid-cols-1 gap-4 md:grid-cols-2");

  grid.append(
    createMembersSection({
      title: "حاضر",

      members: Array.isArray(present) ? present : [],

      status: "present",
    }),

    createMembersSection({
      title: "غایب",

      members: Array.isArray(absent) ? absent : [],

      status: "absent",
    }),
  );

  body.appendChild(grid);
}

export function closeDayDetailsModal() {
  if (!modalElements) {
    return;
  }

  modalElements.root.classList.add("hidden");

  modalElements.root.classList.remove("flex");

  document.body.classList.remove("overflow-hidden");
}

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    modalElements &&
    !modalElements.root.classList.contains("hidden")
  ) {
    closeDayDetailsModal();
  }
});
